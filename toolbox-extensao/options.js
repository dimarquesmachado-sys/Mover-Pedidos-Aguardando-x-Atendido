/* =====================================================================
   options.js v2 — configurações da extensão (URL do servidor + status)
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const $servidor = $("servidor");
const $btnSalvar = $("btn-salvar");
const $btnSync = $("btn-sync");
const $btnAbrirPainel = $("btn-abrir-painel");
const $status = $("status");
const $resumo = $("resumo");

const KEY_CONFIG = "extension_config";
const KEY_DADOS = "fragile_data";

function status(txt, ok) {
  $status.textContent = txt;
  $status.className = ok ? "ok" : "erro";
  if (txt) setTimeout(() => { $status.textContent = ""; $status.className = ""; }, 3500);
}

function carregarConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_CONFIG, KEY_DADOS, "ultimaSync"], (data) => {
      const cfg = data[KEY_CONFIG] || { servidorUrl: "", intervaloMin: 5 };
      $servidor.value = cfg.servidorUrl || "";
      atualizarResumo(data[KEY_DADOS], data.ultimaSync, cfg.servidorUrl);
      resolve(cfg);
    });
  });
}

function atualizarResumo(dados, ultimaSync, servidorUrl) {
  const skus = (dados && dados.skus) ? Object.keys(dados.skus) : [];
  const cfg = (dados && dados.config) || {};
  const linhas = [];
  linhas.push(`<b>Servidor configurado:</b> ${servidorUrl ? servidorUrl : "<i>nenhum</i>"}`);
  linhas.push(`<b>Última sincronização:</b> ${ultimaSync ? new Date(ultimaSync).toLocaleString("pt-BR") : "<i>nunca</i>"}`);
  linhas.push(`<b>SKUs em cache:</b> ${skus.length}`);
  if (cfg.tempoMinimoSegundos != null) {
    linhas.push(`<b>Tempo mínimo do botão OK:</b> ${cfg.tempoMinimoSegundos}s`);
  }
  if (cfg.repetirVoz != null) {
    linhas.push(`<b>Repetir voz:</b> ${cfg.repetirVoz ? "Sim" : "Não"}`);
  }
  if (cfg.mensagemPadrao) {
    linhas.push(`<b>Mensagem padrão:</b> "${cfg.mensagemPadrao}"`);
  }
  $resumo.innerHTML = linhas.join("<br>");
}

function salvarUrl() {
  let url = ($servidor.value || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  $servidor.value = url;
  chrome.storage.local.get([KEY_CONFIG], (data) => {
    const cfg = data[KEY_CONFIG] || {};
    cfg.servidorUrl = url;
    cfg.intervaloMin = cfg.intervaloMin || 5;
    chrome.storage.local.set({ [KEY_CONFIG]: cfg }, () => {
      status("✓ URL salva", true);
      // Reconfigura alarm e sincroniza
      chrome.runtime.sendMessage({ type: "SYNC_AGORA" }, (resposta) => {
        if (resposta && resposta.ok) {
          status(`✓ Salvo e sincronizado (${resposta.skus} SKUs)`, true);
          carregarConfig();
        } else if (resposta && !resposta.ok) {
          status("URL salva, mas erro ao sincronizar: " + (resposta.erro || "?"), false);
          carregarConfig();
        }
      });
    });
  });
}

function sincronizar() {
  $btnSync.disabled = true;
  $btnSync.textContent = "Sincronizando...";
  chrome.runtime.sendMessage({ type: "SYNC_AGORA" }, (resposta) => {
    $btnSync.disabled = false;
    $btnSync.textContent = "🔄 Sincronizar agora";
    if (resposta && resposta.ok) {
      status(`✓ ${resposta.skus} SKUs sincronizados`, true);
      carregarConfig();
    } else {
      status("Erro: " + (resposta?.erro || "sem resposta"), false);
    }
  });
}

function abrirPainel() {
  let url = ($servidor.value || "").trim().replace(/\/+$/, "");
  if (!url) {
    status("Configure a URL do servidor primeiro", false);
    return;
  }
  /* Codex #241: mesma normalização do sync — raiz colada sem /fragil abria o JSON de status */
  if (!/\/fragil$/.test(url)) url += "/fragil";
  chrome.tabs ? chrome.tabs.create({ url }) : window.open(url, "_blank");
}

$btnSalvar.addEventListener("click", salvarUrl);
$btnSync.addEventListener("click", sincronizar);
$btnAbrirPainel.addEventListener("click", abrirPainel);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    salvarUrl();
  }
});

// Atualiza o resumo quando o background sincronizar
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[KEY_DADOS] || changes.ultimaSync)) {
    carregarConfig();
  }
});

carregarConfig();
