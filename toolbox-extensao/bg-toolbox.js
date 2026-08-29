/* GOOD Toolbox — service worker raiz: os 3 backgrounds originais entram BYTE A BYTE
   (colisões de nomes verificadas: zero) e cada onMessage já filtra pelo seu tipo
   (SYNC_AGORA / MM_* / BLING_DEVOLUCAO_*), então coexistem sem se atrapalhar. */
importScripts('bg-fragil.js', 'bg-mm.js', 'bg-devolucoes.js');


/* 29/08 — HEARTBEAT da extensão: 1x/dia avisa que está instalada e viva, mesmo que o dono
   não visite site nenhum. É o que separa "extensão removida/desativada" de "não usei o
   módulo esses dias" quando um módulo fica sem sinal. */
async function tbHeartbeat() {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const cfg = await chrome.storage.local.get(['tb_hb_dia', 'tb_empresa', 'tb_servidor']);
    if (cfg.tb_hb_dia === hoje || !cfg.tb_empresa) return;
    const base = cfg.tb_servidor || 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
    const r = await fetch(base + '/diagnostico/modulos/vivo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa: cfg.tb_empresa, versao: (chrome.runtime.getManifest() || {}).version }),
    });
    if (r && r.ok) await chrome.storage.local.set({ tb_hb_dia: hoje });
  } catch (e) { /* offline: tenta no próximo alarme */ }
}
chrome.alarms.create('tb-heartbeat', { periodInMinutes: 240 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tb-heartbeat') tbHeartbeat(); });
tbHeartbeat();
