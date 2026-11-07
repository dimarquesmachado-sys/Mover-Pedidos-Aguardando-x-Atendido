'use strict';
/* 29/08 canário: CARREGOU — o script foi injetado nesta página-alvo. Se depois disso
   ele não conseguir MONTAR, o servidor sabe que é quebra e não inatividade. */
try { if (window.tbSinalDeVida) window.tbSinalDeVida('mm', 'carregou'); } catch (e) {}

// content.js — roda DENTRO das páginas do painel Madeira Madeira.
// Como roda na própria página (mesma origem), o fetch leva os cookies da sua
// sessão logada. Lê a lista de lotes e manda pro background, que envia ao Render.

(function () {
  const LOTES_URL = 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/api/mm-envios/lotes';

  /* 07/11 (2.1.8): a leitura dos lotes tem PRAZO (cabeçalho e corpo) — sem ele, um Madeira que não responde (VPN caindo,
     bloqueio de origem) prendia a rodada pra sempre, e com ela o botão "Sincronizar agora" (caso real do dono) */
  const PRAZO_LOTES_MS = 20000;
  async function buscarLotes() {
    const ac = new AbortController();
    const tm = setTimeout(function () { ac.abort(); }, PRAZO_LOTES_MS);
    try {
      const r = await fetch(LOTES_URL, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
        signal: ac.signal
      });
      let data = null;
      try { data = await r.json(); } catch (e) { /* veio HTML (provável tela de login) — ou o prazo estourou no corpo */ }
      if (ac.signal.aborted) return { ok: false, erro: 'o Madeira não respondeu em ' + (PRAZO_LOTES_MS / 1000) + 's (VPN ligada? a página do painel abre?)', lotes: [] };
      if (!r.ok) return { ok: false, status: r.status, lotes: [] };
      /* 29/08 canário de módulos: prova de vida deste módulo. */
      try { if (window.tbSinalDeVida) window.tbSinalDeVida('mm'); } catch (e) {}
      const lotes = Array.isArray(data) ? data : (data && (data.data || data.lotes)) || [];
      if (!Array.isArray(lotes)) return { ok: false, status: r.status, erro: 'resposta sem lista de lotes', lotes: [] };
      return { ok: true, status: r.status, lotes };
    } catch (e) {
      if (ac.signal.aborted) return { ok: false, erro: 'o Madeira não respondeu em ' + (PRAZO_LOTES_MS / 1000) + 's (VPN ligada? a página do painel abre?)', lotes: [] };
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
  const MAX_ZPL_RODADA = 8, MAX_CORPO = 4 * 1024 * 1024, MAX_ZPL_LOTE = 1500000, PRAZO_ZPL_MS = 60000, PRAZO_RODADA_MS = 100000;   /* 2.1.9: 20 s → 60 s por etiqueta — etiqueta de vários volumes, pela VPN, não chegava em 20 s (caso real: 3 de 6 lotes da GOOD ficando pra trás) */
  const BASE_PADRAO = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
  /* Codex #804 (r2): etiqueta que FALHOU (prazo, erro, inválida) espera 10 min antes de ser tentada de novo — senão as
     primeiras travadas comem o prazo da rodada toda vez e as de depois, saudáveis, nunca chegam a vez */
  const ESPERA_FALHA_MS = 10 * 60 * 1000;
  /* 2.1.9: a falha guarda o MOTIVO (vai pra telinha: "306783: o Madeira demorou mais de 60s") e a espera depende dele —
     prazo estourado tenta de novo em 3 min (é a VPN/o Madeira lento, não um erro); HTTP/conteúdo em 10 min. */
  const ESPERA_PRAZO_MS = 3 * 60 * 1000;
  const _falhou = new Map();
  const _marcarFalha = function (id, motivo, espera) { _falhou.set(String(id), { t: Date.now(), motivo: motivo, espera: espera || ESPERA_FALHA_MS }); };
  const _emEspera = function (id) { const f = _falhou.get(String(id)); return !!f && (Date.now() - f.t) < f.espera; };
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
    const falhas = [];   /* 2.1.9: o que ficou sem etiqueta nesta rodada, e por quê */
    const t0 = Date.now();
    for (const l of lotes) {
      if (!l || Number(l.status) !== 2) continue;
      const id = l.batch != null ? l.batch : l.lote;
      if (id == null || entregues[String(id)]) continue;
      if (_emEspera(id)) { const f = _falhou.get(String(id)); falhas.push({ batch: String(id), motivo: f.motivo, esperando: true }); continue; }
      if (n >= MAX_ZPL_RODADA || Date.now() - t0 > PRAZO_RODADA_MS) break;
      const ac = new AbortController();
      const tm = setTimeout(function () { ac.abort(); }, PRAZO_ZPL_MS);
      try {
        const r = await fetch(ZPL_URL(id), { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/zpl, text/plain, */*' }, signal: ac.signal });
        if (!r.ok) { const m = 'o Madeira respondeu HTTP ' + r.status; _marcarFalha(id, m); falhas.push({ batch: String(id), motivo: m }); continue; }
        const t = await r.text();
        if (t.indexOf('^XA') === -1 || t.indexOf('^XZ') === -1) { const m = 'o Madeira não devolveu uma etiqueta ZPL'; _marcarFalha(id, m); falhas.push({ batch: String(id), motivo: m }); continue; }
        const tam = _tamJson(t) + 16;   /* ,"zpl": no corpo */
        if (tam > MAX_ZPL_LOTE) { const m = 'etiqueta grande demais (' + Math.round(tam / 1024) + ' KB)'; _marcarFalha(id, m); falhas.push({ batch: String(id), motivo: m }); continue; }   /* grande demais: espera (não cabe nunca) */
        if (corpo + tam > MAX_CORPO) continue;   /* não cabe NESTA rodada: vai na próxima */
        l.zpl = t; n++; corpo += tam; _falhou.delete(String(id));
      } catch (e) {   /* prazo estourado ou rede: espera e fica pra depois */
        const m = ac.signal.aborted ? ('o Madeira demorou mais de ' + (PRAZO_ZPL_MS / 1000) + 's') : ('rede: ' + String(e && e.message || e));
        _marcarFalha(id, m, ac.signal.aborted ? ESPERA_PRAZO_MS : ESPERA_FALHA_MS); falhas.push({ batch: String(id), motivo: m });
      }
      finally { clearTimeout(tm); }
    }
    return { n: n, falhas: falhas };
  }

  /* Codex #804: uma rodada por vez — o timer não empilha rodadas atrás de uma travada.
     Codex #804 (r3): o pedido MANUAL (botão "Sincronizar agora") não é descartado: se uma rodada automática está em
     andamento, ele entra na fila e roda logo depois, como 'manual' — a telinha espera justamente o resultado 'manual'. */
  let _sincronizando = null;
  let _manualNaFila = null;
  /* Codex #805: cada clique do popup traz um id; a rodada MANUAL leva os ids que estavam esperando quando ela COMEÇOU
     e devolve no status (pedidos) — o popup só aceita o resultado da rodada que atende o clique dele, não o de uma
     rodada anterior que terminou depois do clique. */
  let _pendentes = [];
  async function _rodada(motivo) {
    const pedidos = motivo === 'manual' ? _pendentes.splice(0) : [];
    const res = await buscarLotes();
    if (res && res.ok && Array.isArray(res.lotes)) { try { const _z = await anexarZpls(res.lotes); res.zpls = _z.n; res.zpl_falhas = _z.falhas; } catch (e) { res.zpls = 0; res.zpl_falhas = []; } }
    try { chrome.runtime.sendMessage(Object.assign({ tipo: 'MM_LOTES', motivo, pedidos }, res)); } catch (e) {}
  }
  function sincronizar(motivo, pedido) {
    if (pedido != null) _pendentes.push(String(pedido));
    if (_sincronizando) {
      if (motivo !== 'manual') return _sincronizando;   /* timer/load: a rodada em andamento já dá conta */
      if (!_manualNaFila) _manualNaFila = _sincronizando.then(function () { _manualNaFila = null; return sincronizar('manual'); });
      return _manualNaFila;
    }
    /* 2.1.8: teto pra rodada inteira (90 s) — mesmo que algo lá dentro não volte, a fila anda */
    const _teto = new Promise(function (ok) { setTimeout(ok, 200000); });   /* 2.1.9: cabe a rodada com prazos de 60 s por etiqueta */
    _sincronizando = Promise.race([_rodada(motivo), _teto]).catch(function () {}).finally(function () { _sincronizando = null; });
    return _sincronizando;
  }


  // Sincroniza ao carregar a página e a cada 60s enquanto a aba estiver aberta.
  sincronizar('load');
  setInterval(function () { sincronizar('timer'); }, 60000);

  // Permite o popup pedir uma sincronização imediata.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.tipo === 'MM_SYNC_AGORA') {
      /* 2.1.8: responde NA HORA (pedido aceito) — a telinha passa a esperar o resultado 'manual' com o próprio relógio;
         antes ela só começava a contar depois desta resposta, e uma rodada presa a deixava em "Sincronizando..." pra sempre */
      sincronizar('manual', msg.pedido == null ? ('x' + Date.now()) : msg.pedido);
      sendResponse({ ok: true, aceito: true });
      return false;
    }
  });
})();
