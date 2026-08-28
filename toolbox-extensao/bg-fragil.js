/* =====================================================================
   Background service worker — sincroniza a lista de SKUs do servidor
   Render a cada 5 minutos (configurável). Salva no chrome.storage.local
   pra ficar disponível offline também.
   ===================================================================== */

const ALARM_NAME = "good-fragil-sync";
const STORAGE_KEY_DADOS = "fragile_data";        // { config, skus, atualizadoEm }
const STORAGE_KEY_CONFIG = "extension_config";   // { servidorUrl, intervaloMin }

// Configura intervalo de sincronização ao instalar/iniciar
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

async function setupAlarm() {
  const cfg = await getConfig();
  // Sync periódico
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: cfg.intervaloMin || 5 });
  });
  // Sync imediato no boot
  if (cfg.servidorUrl) sincronizar();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) sincronizar();
});

// Permite a página de opções pedir sync manual
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SYNC_AGORA") {
    sincronizar().then(sendResponse);
    return true; // resposta assíncrona
  }
});

// ---------------- HELPERS ----------------
function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_CONFIG], (data) => {
      resolve(data[STORAGE_KEY_CONFIG] || { servidorUrl: "", intervaloMin: 5 });
    });
  });
}

/* Codex #241: trocar a empresa da instância re-sincroniza NA HORA — sem isto o alerta
   do checkout ficava com a lista da empresa anterior até a próxima sync agendada. */
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === "local" && mudancas.tb_empresa) {
    sincronizar().catch(() => {});
  }
});

// 28/08: mapeia a empresa da instância (tb_empresa) pro id do servidor do Frágil
function empresaFragil() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["tb_empresa"], (d) => {
      const e = d.tb_empresa || "";
      resolve(e === "amb" ? "ambtotal" : e);   // girassol/good já batem
    });
  });
}

async function sincronizar() {
  const cfg = await getConfig();
  if (!cfg.servidorUrl) {
    return { ok: false, erro: "URL do servidor não configurada" };
  }
  try {
    /* 28/08 (a URL virou à prova de operador): aceita colada COM ou SEM o /fragil no fim —
       o 404 da primeira instalação veio exatamente da raiz colada sem o caminho. */
    const raiz = cfg.servidorUrl.replace(/\/+$/, "");
    let base = /\/fragil$/.test(raiz) ? raiz : raiz + "/fragil";
    /* multi-empresa: sincroniza a LISTA DA EMPRESA da instância; servidor antigo ignora
       a query e devolve a lista única — compatível nos dois sentidos. */
    const emp = await empresaFragil();
    const q = emp ? "?empresa=" + encodeURIComponent(emp) : "";
    let r = await fetch(base + "/api/skus" + q, { method: "GET", cache: "no-store" });
    /* Codex #241: um servidor Frágil STANDALONE serve /api/skus na RAIZ — se o /fragil
       anexado devolver 404 e a URL não o tinha, tenta a forma original antes de falhar. */
    if (r.status === 404 && base !== raiz) {
      base = raiz;
      r = await fetch(base + "/api/skus" + q, { method: "GET", cache: "no-store" });
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const dados = await r.json();
    await new Promise((resolve) =>
      chrome.storage.local.set({ [STORAGE_KEY_DADOS]: dados, ultimaSync: new Date().toISOString() }, resolve)
    );
    console.log("[SYNC OK]", Object.keys(dados.skus || {}).length, "SKUs");
    return { ok: true, skus: Object.keys(dados.skus || {}).length, atualizadoEm: dados.atualizadoEm };
  } catch (e) {
    console.warn("[SYNC ERRO]", e.message);
    return { ok: false, erro: e.message };
  }
}
