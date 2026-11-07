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
  const MAX_ZPL_RODADA = 8, MAX_BYTES_RODADA = 3000000, MAX_ZPL_LOTE = 1500000;
  async function anexarZpls(lotes) {
    let entregues = {};
    try { entregues = ((await chrome.storage.local.get(['mm_zpl_entregues'])) || {}).mm_zpl_entregues || {}; } catch (e) { entregues = {}; }
    let n = 0, bytes = 0;
    for (const l of lotes) {
      if (!l || Number(l.status) !== 2) continue;
      const id = l.batch != null ? l.batch : l.lote;
      if (id == null || entregues[String(id)]) continue;
      if (n >= MAX_ZPL_RODADA || bytes >= MAX_BYTES_RODADA) break;
      try {
        const r = await fetch(ZPL_URL(id), { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/zpl, text/plain, */*' } });
        if (!r.ok) continue;
        const t = await r.text();
        if (t.indexOf('^XA') === -1 || t.indexOf('^XZ') === -1 || t.length > MAX_ZPL_LOTE) continue;
        l.zpl = t; n++; bytes += t.length;
      } catch (e) { /* esse lote fica pra próxima rodada */ }
    }
    return n;
  }

  async function sincronizar(motivo) {
    const res = await buscarLotes();
    if (res && res.ok && Array.isArray(res.lotes)) { try { res.zpls = await anexarZpls(res.lotes); } catch (e) { res.zpls = 0; } }
    try { chrome.runtime.sendMessage(Object.assign({ tipo: 'MM_LOTES', motivo }, res)); } catch (e) {}
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
