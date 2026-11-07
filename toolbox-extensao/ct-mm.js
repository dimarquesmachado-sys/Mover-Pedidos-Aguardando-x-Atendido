'use strict';
/* 29/08 canário: CARREGOU — o script foi injetado nesta página-alvo. Se depois disso
   ele não conseguir MONTAR, o servidor sabe que é quebra e não inatividade. */
try { if (window.tbSinalDeVida) window.tbSinalDeVida('mm', 'carregou'); } catch (e) {}

// content.js — roda DENTRO das páginas do painel Madeira Madeira.
// Como roda na própria página (mesma origem), o fetch leva os cookies da sua
// sessão logada. Lê a lista de lotes e manda pro background, que envia ao Render.

(function () {
  const LOTES_URL = 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/api/mm-envios/lotes';

  async function buscarLotes() {
    try {
      const r = await fetch(LOTES_URL, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      let data = null;
      try { data = await r.json(); } catch (e) { /* veio HTML (provável tela de login) */ }
      if (!r.ok) return { ok: false, status: r.status, lotes: [] };
      /* 29/08 canário de módulos: prova de vida deste módulo. */
      try { if (window.tbSinalDeVida) window.tbSinalDeVida('mm'); } catch (e) {}
      const lotes = Array.isArray(data) ? data : (data && (data.data || data.lotes)) || [];
      if (!Array.isArray(lotes)) return { ok: false, status: r.status, erro: 'resposta sem lista de lotes', lotes: [] };
      return { ok: true, status: r.status, lotes };
    } catch (e) {
      return { ok: false, erro: String(e && e.message || e), lotes: [] };
    }
  }

  /* 07/11 (Toolbox 2.1.7) -- A ETIQUETA VAI JUNTO. O servidor baixava o ZPL de cada lote pelo endereço "público" do portal,
     e esse endereço passou a responder 403 conforme de onde vem o pedido -- o checkout ficava com "achei o lote, mas a
     etiqueta não baixou". Esta página está LOGADA no Madeira e alcança o portal: baixa aqui o ZPL de cada lote PRONTO que
     ainda não foi entregue e manda junto no sync. O que o servidor confirma ter guardado (zpl_guardados) não é baixado de
     novo. Teto por rodada pra não passar do limite do corpo do servidor (5 MB). */
  const ZPL_URL = function (id) { return 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/api/mm-envios/lotes/imprimir/etiquetas?lote_id=' + encodeURIComponent(id) + '&format=zpl'; };
  /* Codex #804: (1) o teto é sobre o CORPO SERIALIZADO (JSON em UTF-8, com escapes) — não o tamanho da string — e conta os
     dados dos lotes; o servidor corta acima de 5 MiB e aí NADA sincroniza; (2) cada download tem PRAZO (cabeçalho e corpo)
     e a rodada inteira também — uma etiqueta travada não segura o envio do resto; (3) uma rodada por vez; (4) o "já
     entregue" é POR DESTINO (servidor + empresa) — trocar o servidor nas configurações não deixa etiqueta sem entregar. */
  const MAX_ZPL_RODADA = 8, MAX_CORPO = 4 * 1024 * 1024, MAX_ZPL_LOTE = 1500000, PRAZO_ZPL_MS = 20000, PRAZO_RODADA_MS = 40000;
  const BASE_PADRAO = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
  /* Codex #804 (r2): etiqueta que FALHOU (prazo, erro, inválida) espera 10 min antes de ser tentada de novo — senão as
     primeiras travadas comem o prazo da rodada toda vez e as de depois, saudáveis, nunca chegam a vez */
  const ESPERA_FALHA_MS = 10 * 60 * 1000;
  const _falhou = new Map();
  const _emEspera = function (id) { const t = _falhou.get(String(id)); return !!t && (Date.now() - t) < ESPERA_FALHA_MS; };
  const _tamJson = function (v) { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (e) { return Infinity; } };
  async function destinoAtual() {
    const c = (await chrome.storage.local.get(['renderBase', 'tb_empresa'])) || {};
    return String(c.renderBase || BASE_PADRAO).replace(/\/+$/, '') + '|' + (c.tb_empresa || 'good');
  }
  async function anexarZpls(lotes) {
    let entregues = {};
    try {
      const dest = await destinoAtual();
      const todos = ((await chrome.storage.local.get(['mm_zpl_entregues'])) || {}).mm_zpl_entregues || {};
      entregues = (todos && typeof todos[dest] === 'object' && todos[dest]) || {};
    } catch (e) { entregues = {}; }
    let corpo = _tamJson({ lotes: lotes }) + 64;   /* o corpo sem as etiquetas, com folga */
    let n = 0;
    const t0 = Date.now();
    for (const l of lotes) {
      if (!l || Number(l.status) !== 2) continue;
      const id = l.batch != null ? l.batch : l.lote;
      if (id == null || entregues[String(id)] || _emEspera(id)) continue;
      if (n >= MAX_ZPL_RODADA || Date.now() - t0 > PRAZO_RODADA_MS) break;
      const ac = new AbortController();
      const tm = setTimeout(function () { ac.abort(); }, PRAZO_ZPL_MS);
      try {
        const r = await fetch(ZPL_URL(id), { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/zpl, text/plain, */*' }, signal: ac.signal });
        if (!r.ok) { _falhou.set(String(id), Date.now()); continue; }
        const t = await r.text();
        if (t.indexOf('^XA') === -1 || t.indexOf('^XZ') === -1) { _falhou.set(String(id), Date.now()); continue; }
        const tam = _tamJson(t) + 16;   /* ,"zpl": no corpo */
        if (tam > MAX_ZPL_LOTE) { _falhou.set(String(id), Date.now()); continue; }   /* grande demais: espera (não cabe nunca) */
        if (corpo + tam > MAX_CORPO) continue;   /* não cabe NESTA rodada: vai na próxima */
        l.zpl = t; n++; corpo += tam; _falhou.delete(String(id));
      } catch (e) { _falhou.set(String(id), Date.now()); /* prazo estourado ou rede: espera e fica pra depois */ }
      finally { clearTimeout(tm); }
    }
    return n;
  }

  /* Codex #804: uma rodada por vez — o timer não empilha rodadas atrás de uma travada.
     Codex #804 (r3): o pedido MANUAL (botão "Sincronizar agora") não é descartado: se uma rodada automática está em
     andamento, ele entra na fila e roda logo depois, como 'manual' — a telinha espera justamente o resultado 'manual'. */
  let _sincronizando = null;
  let _manualNaFila = null;
  async function _rodada(motivo) {
    const res = await buscarLotes();
    if (res && res.ok && Array.isArray(res.lotes)) { try { res.zpls = await anexarZpls(res.lotes); } catch (e) { res.zpls = 0; } }
    try { chrome.runtime.sendMessage(Object.assign({ tipo: 'MM_LOTES', motivo }, res)); } catch (e) {}
  }
  function sincronizar(motivo) {
    if (_sincronizando) {
      if (motivo !== 'manual') return _sincronizando;   /* timer/load: a rodada em andamento já dá conta */
      if (!_manualNaFila) _manualNaFila = _sincronizando.then(function () { _manualNaFila = null; return sincronizar('manual'); });
      return _manualNaFila;
    }
    _sincronizando = _rodada(motivo).catch(function () {}).finally(function () { _sincronizando = null; });
    return _sincronizando;
  }


  // Sincroniza ao carregar a página e a cada 60s enquanto a aba estiver aberta.
  sincronizar('load');
  setInterval(function () { sincronizar('timer'); }, 60000);

  // Permite o popup pedir uma sincronização imediata.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.tipo === 'MM_SYNC_AGORA') {
      sincronizar('manual').then(function () { sendResponse({ ok: true }); });
      return true; // resposta assíncrona
    }
  });
})();
