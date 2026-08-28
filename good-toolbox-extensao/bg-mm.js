'use strict';
// background.js — service worker. Recebe os lotes do content script e faz POST
// no Render (/good-mm-etiquetas/sync) com a chave GOOD_MM_SYNC_KEY guardada.

const DEFAULT_BASE = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';

async function getCfg() {
  const c = await chrome.storage.local.get(['renderBase', 'syncKey']);
  return { renderBase: (c.renderBase || DEFAULT_BASE).replace(/\/+$/, ''), syncKey: c.syncKey || '' };
}

async function enviarParaRender(lotes) {
  const cfg = await getCfg();
  if (!cfg.syncKey) return { ok: false, erro: 'Sem chave. Abra a extensão e cole a GOOD_MM_SYNC_KEY.' };
  try {
    const r = await fetch(cfg.renderBase + '/good-mm-etiquetas/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MM-Key': cfg.syncKey },
      body: JSON.stringify({ lotes: lotes })
    });
    const txt = await r.text();
    let js = null; try { js = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, resposta: js || txt };
  } catch (e) {
    return { ok: false, erro: String(e && e.message || e) };
  }
}

async function registrarStatus(s) {
  await chrome.storage.local.set({ ultimoStatus: Object.assign({ quando: Date.now() }, s) });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.tipo === 'MM_LOTES') {
    (async function () {
      if (!msg.ok) {
        await registrarStatus({ etapa: 'ler_mm', ok: false, status: msg.status || null, erro: msg.erro || 'falha ao ler lotes do MM' });
        sendResponse({ ok: false });
        return;
      }
      const lotes = msg.lotes || [];
      const prontos = lotes.filter(function (l) { return Number(l && l.status) === 2; });
      const env = await enviarParaRender(lotes);
      await registrarStatus(Object.assign({ etapa: 'sync', motivo: msg.motivo, lidos: lotes.length, prontos: prontos.length }, env));
      sendResponse(env);
    })();
    return true; // resposta assíncrona
  }
});
