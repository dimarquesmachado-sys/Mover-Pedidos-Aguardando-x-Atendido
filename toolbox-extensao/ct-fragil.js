/* =====================================================================
   GOOD - Alerta Produto Frágil — v2.0.0
   - Lê lista de SKUs e configurações de chrome.storage.local (sincronizado pelo background)
   - Voz corrigida: sem cancelar/reiniciar no meio, usa onend pra repetir se configurado
   - Texto sanitizado pra evitar engasgos do sintetizador
   - Tempo mínimo configurável antes do botão OK liberar
   ===================================================================== */

(() => {
  if (window.__GOOD_FRAGIL_LOADED__) return;
  window.__GOOD_FRAGIL_LOADED__ = true;

  const PATH_OK = ["/vendas.checkout.php", "/b/vendas.checkout.php"];
  if (!PATH_OK.includes(window.location.pathname)) return;

  // Estrutura padrão (caso storage esteja vazio)
  const DADOS_PADRAO = {
    config: {
      tempoMinimoSegundos: 2,
      mensagemPadrao: "Atenção. Produto frágil. Embalar com plástico bolha e reforçar a caixa.",
      repetirVoz: false,
      velocidadeVoz: 1.2,
      nomeVoz: ""
    },
    skus: {},
    atualizadoEm: null
  };

  // ---------------- ESTADO ----------------
  let dados = JSON.parse(JSON.stringify(DADOS_PADRAO));
  let alertaAtivo = false;
  let skusPendentes = [];
  let skusJaAlertados = new Set();
  let scanTimeout = null;
  let vozPtBr = null;

  // ---------------- CARREGAR DADOS DO STORAGE ----------------
  function carregar() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["fragile_data", "fragile_skus"], (data) => {
        if (data.fragile_data) {
          dados = mergePadrao(data.fragile_data);
        } else if (data.fragile_skus) {
          // Compat com extensão v1: converte formato antigo
          dados = mergePadrao({ skus: data.fragile_skus });
        }
        resolve();
      });
    });
  }

  function mergePadrao(d) {
    return {
      config: { ...DADOS_PADRAO.config, ...(d.config || {}) },
      skus: d.skus || {},
      atualizadoEm: d.atualizadoEm || null
    };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.fragile_data) {
      dados = mergePadrao(changes.fragile_data.newValue || {});
      skusJaAlertados.clear();
      carregarVozes(); // re-seleciona voz se admin trocou
      escanearAgora();
    }
  });

  // ---------------- VOZ (Web Speech API) ----------------
  function carregarVozes() {
    const vozes = window.speechSynthesis.getVoices();
    if (!vozes || !vozes.length) return;
    // Preferência 1: voz com nome exato configurado pelo admin
    const nomeConfig = (dados.config?.nomeVoz || "").trim();
    if (nomeConfig) {
      const exata = vozes.find(v => v.name === nomeConfig);
      if (exata) { vozPtBr = exata; return; }
    }
    // Preferência 2: melhor voz pt-BR disponível
    vozPtBr =
      vozes.find((v) => /pt[-_]br/i.test(v.lang) && /Maria|Daniel|Francisca|Antonio|Microsoft|Google/i.test(v.name)) ||
      vozes.find((v) => /pt[-_]br/i.test(v.lang)) ||
      vozes.find((v) => /^pt/i.test(v.lang)) ||
      null;
  }
  if ("speechSynthesis" in window) {
    carregarVozes();
    window.speechSynthesis.onvoiceschanged = carregarVozes;
  }

  // Sanitiza texto pra falar — remove caracteres que confundem o sintetizador
  function sanitizarParaFala(t) {
    if (!t) return "";
    return String(t)
      .replace(/["“”']/g, "")              // remove aspas (causam pausas/engasgos)
      .replace(/\s*[|]\s*/g, ". ")          // separadores | viram pausas
      .replace(/\s+/g, " ")                  // colapsa espaços
      .replace(/\.\s*\./g, ".")              // colapsa pontos duplos
      .trim();
  }

  function falarUmaVez(texto, onFim) {
    if (!("speechSynthesis" in window) || !texto) { onFim && onFim(); return null; }
    try {
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = "pt-BR";
      const rate = parseFloat(dados.config.velocidadeVoz);
      u.rate = (isNaN(rate) || rate < 0.5 || rate > 2.0) ? 1.2 : rate;
      u.pitch = 1;
      u.volume = 1;
      if (vozPtBr) u.voice = vozPtBr;
      u.onend = () => onFim && onFim();
      u.onerror = () => onFim && onFim();
      window.speechSynthesis.speak(u);
      return u;
    } catch (e) {
      console.warn("[FRAGIL] erro voz:", e);
      onFim && onFim();
      return null;
    }
  }

  // Toca a voz 1x. Se config.repetirVoz, repete uma vez DEPOIS QUE A PRIMEIRA TERMINOU
  // (não cancela no meio — esse era o bug da v1).
  function falar(texto) {
    const limpo = sanitizarParaFala(texto);
    try { window.speechSynthesis.cancel(); } catch (_) {}
    falarUmaVez(limpo, () => {
      if (dados.config.repetirVoz && alertaAtivo) {
        setTimeout(() => {
          if (alertaAtivo) falarUmaVez(limpo, null);
        }, 500);
      }
    });
  }

  // ---------------- DETECÇÃO DE SKU NA PÁGINA ----------------
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Encontra apenas SKUs que aparecem no formato "Sku: XXX" (com prefixo).
  // Esse padrão é exclusivo do painel central de detalhes do pedido aberto.
  // A lista lateral de separação mostra códigos sem o prefixo "Sku:",
  // então é automaticamente ignorada.

  function escanear() {
    if (alertaAtivo) return;
    const skus = Object.keys(dados.skus);
    if (skus.length === 0) return;

    const texto = (document.body && document.body.innerText) || "";
    if (!texto) return;

    const visiveis = new Set();

    for (const sku of skus) {
      const skuTrim = (sku || "").trim();
      if (!skuTrim) continue;

      // Só conta o SKU se vier precedido de "Sku:" (com variações: Sku, SKU, sku, Código)
      // e não tiver outro caractere alfanumérico colado depois (evita match parcial)
      const regex = new RegExp(
        `(?:Sku|SKU|sku|C[oó]digo)\\s*:\\s*${escapeRegex(skuTrim)}(?:[^A-Za-z0-9_\\-]|$)`,
        "i"
      );

      if (regex.test(texto)) {
        visiveis.add(skuTrim);
        if (!skusJaAlertados.has(skuTrim)) {
          if (!skusPendentes.includes(skuTrim)) skusPendentes.push(skuTrim);
        }
      }
    }

    // Limpar "já alertados" que saíram da tela
    for (const sku of Array.from(skusJaAlertados)) {
      if (!visiveis.has(sku)) skusJaAlertados.delete(sku);
    }

    if (skusPendentes.length > 0 && !alertaAtivo) {
      const proximo = skusPendentes.shift();
      mostrarAlerta(proximo, dados.skus[proximo]);
    }
  }

  function escanearAgora() { clearTimeout(scanTimeout); escanear(); }
  function escanearDebounced() { clearTimeout(scanTimeout); scanTimeout = setTimeout(escanear, 350); }

  // ---------------- POPUP ----------------
  function injetarEstilo() {
    if (document.getElementById("good-fragil-style")) return;
    const style = document.createElement("style");
    style.id = "good-fragil-style";
    style.textContent = `
      @keyframes goodFragilPulse {
        0%   { transform: scale(1);    box-shadow: 0 0 40px rgba(220,53,69,0.6); }
        100% { transform: scale(1.03); box-shadow: 0 0 80px rgba(220,53,69,1); }
      }
      @keyframes goodFragilPiscar {
        0%, 100% { background: #fff3cd; }
        50%      { background: #ffe066; }
      }
      @keyframes goodFragilFade { from { opacity: 0; } to { opacity: 1; } }
      #good-fragil-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.85);
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        animation: goodFragilFade 0.2s;
        font-family: Arial, Helvetica, sans-serif;
      }
      #good-fragil-modal {
        border: 10px solid #dc3545;
        border-radius: 18px;
        padding: 40px 50px;
        max-width: 640px; width: 92%;
        text-align: center;
        animation: goodFragilPulse 0.7s ease-in-out infinite alternate,
                   goodFragilPiscar 0.9s ease-in-out infinite;
      }
      #good-fragil-modal .ico    { font-size: 90px; line-height: 1; margin-bottom: 14px; }
      #good-fragil-modal .titulo { font-size: 38px; font-weight: 900; color: #dc3545; letter-spacing: 1px; margin-bottom: 18px; }
      #good-fragil-modal .sku    { font-size: 18px; color: #333; margin-bottom: 14px; font-weight: bold; }
      #good-fragil-modal .msg    { font-size: 22px; color: #212529; margin-bottom: 32px; line-height: 1.4; font-weight: 600; }
      #good-fragil-ok {
        background: #28a745; color: white;
        border: none; padding: 20px 70px;
        font-size: 24px; font-weight: bold;
        border-radius: 10px; cursor: pointer;
        box-shadow: 0 6px 12px rgba(0,0,0,0.25);
        letter-spacing: 1px;
        transition: opacity 0.2s, background 0.2s;
      }
      #good-fragil-ok:hover:not(:disabled) { background: #218838; }
      #good-fragil-ok:disabled {
        background: #6c757d; cursor: not-allowed; opacity: 0.85;
      }
    `;
    document.head.appendChild(style);
  }

  function mostrarAlerta(sku, mensagemCustom) {
    if (alertaAtivo) return;
    alertaAtivo = true;
    skusJaAlertados.add(sku);

    const mensagem =
      (mensagemCustom && mensagemCustom.trim()) ||
      dados.config.mensagemPadrao ||
      "Atenção. Produto frágil. Embalar com plástico bolha.";

    injetarEstilo();

    const tempoMin = Math.max(0, parseInt(dados.config.tempoMinimoSegundos, 10) || 0);

    const overlay = document.createElement("div");
    overlay.id = "good-fragil-overlay";
    overlay.innerHTML = `
      <div id="good-fragil-modal" role="alertdialog" aria-modal="true">
        <div class="ico">⚠️</div>
        <div class="titulo">PRODUTO FRÁGIL</div>
        <div class="sku">SKU: ${escapeHtml(sku)}</div>
        <div class="msg">${escapeHtml(mensagem)}</div>
        <button id="good-fragil-ok" disabled>${tempoMin > 0 ? `Aguarde ${tempoMin}...` : "OK, ENTENDI ✓"}</button>
      </div>
    `;
    document.body.appendChild(overlay);

    function bloquearEsc(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); }
    }
    document.addEventListener("keydown", bloquearEsc, true);

    // Toca a voz
    falar(mensagem);

    // Tempo mínimo até o botão liberar
    const $btn = document.getElementById("good-fragil-ok");
    let restante = tempoMin;
    let timerId = null;
    if (tempoMin > 0) {
      $btn.disabled = true;
      timerId = setInterval(() => {
        restante--;
        if (restante <= 0) {
          clearInterval(timerId); timerId = null;
          $btn.disabled = false;
          $btn.textContent = "OK, ENTENDI ✓";
        } else {
          $btn.textContent = `Aguarde ${restante}...`;
        }
      }, 1000);
    } else {
      $btn.disabled = false;
    }

    function fechar() {
      if (timerId) clearInterval(timerId);
      try { window.speechSynthesis.cancel(); } catch (_) {}
      document.removeEventListener("keydown", bloquearEsc, true);
      overlay.remove();
      alertaAtivo = false;
      // Próximo da fila
      setTimeout(() => {
        if (skusPendentes.length > 0) {
          const proximo = skusPendentes.shift();
          mostrarAlerta(proximo, dados.skus[proximo]);
        }
      }, 250);
    }

    $btn.addEventListener("click", () => {
      if (!$btn.disabled) fechar();
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------- OBSERVER ----------------
  const observer = new MutationObserver(escanearDebounced);
  function iniciarObserver() {
    if (!document.body) { setTimeout(iniciarObserver, 200); return; }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    escanear();
  }

  // ---------------- BOOT ----------------
  carregar().then(() => {
    iniciarObserver();
    console.log(
      "%c[GOOD - Alerta Frágil v2] ativo | " + Object.keys(dados.skus).length + " SKUs | " +
      "tempoMin=" + dados.config.tempoMinimoSegundos + "s | repetirVoz=" + dados.config.repetirVoz,
      "color:#dc3545;font-weight:bold;"
    );
  });
})();
