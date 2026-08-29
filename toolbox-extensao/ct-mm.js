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

  async function sincronizar(motivo) {
    const res = await buscarLotes();
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
