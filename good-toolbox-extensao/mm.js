'use strict';
// popup.js — interface da extensão: salvar config, sincronizar agora, ver status.

const DEFAULT_BASE = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
function $(id) { return document.getElementById(id); }

async function carregar() {
  const c = await chrome.storage.local.get(['renderBase', 'syncKey', 'ultimoStatus']);
  $('base').value = c.renderBase || DEFAULT_BASE;
  $('key').value = c.syncKey || '';
  mostrarStatus(c.ultimoStatus);
}

function mostrarStatus(s) {
  if (!s) { $('status').textContent = 'Ainda sem sincronização.'; return; }
  const q = s.quando ? new Date(s.quando).toLocaleString('pt-BR') : '';
  let linha;
  if (s.etapa === 'sync' && s.ok) {
    const noMapa = (s.resposta && s.resposta.total_no_mapa != null) ? (', no mapa ' + s.resposta.total_no_mapa) : '';
    linha = '✅ Sincronizado!\nlidos ' + (s.lidos || 0) + ', prontos ' + (s.prontos || 0) + noMapa;
  } else if (s.etapa === 'ler_mm') {
    linha = '⚠️ Não consegui ler os lotes do Madeira Madeira (status ' + (s.status || '?') + ').\nVocê está logado no painel? Plano B pode ser necessário — avise o Diego.';
  } else if (!s.ok) {
    linha = '❌ Erro ao enviar pro Render: ' + (s.erro || ('status ' + s.status));
    if (s.resposta) linha += '\n' + (typeof s.resposta === 'string' ? s.resposta : JSON.stringify(s.resposta));
  } else {
    linha = JSON.stringify(s);
  }
  $('status').textContent = linha + (q ? '\n\n(' + q + ')' : '');
}

async function salvarCfg() {
  await chrome.storage.local.set({ renderBase: $('base').value.trim(), syncKey: $('key').value.trim() });
}

$('salvar').onclick = async function () {
  await salvarCfg();
  $('status').textContent = 'Configuração salva. ✅';
};

$('sync').onclick = async function () {
  await salvarCfg();
  $('status').textContent = 'Sincronizando...';
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !/painelmarketplace\.madeiramadeira\.com\.br/.test(tab.url || '')) {
    $('status').textContent = 'Abra a aba do Madeira Madeira (painel), faça login e tente de novo.';
    return;
  }
  chrome.tabs.sendMessage(tab.id, { tipo: 'MM_SYNC_AGORA' }, function () {
    if (chrome.runtime.lastError) {
      $('status').textContent = 'Recarregue a página do Madeira Madeira (F5) e tente de novo.';
      return;
    }
    /* Codex #236: o timer fixo de 1.6s lia o status ANTERIOR quando o Render demorava
       (cold start) — agora escuta a GRAVACAO do background e atualiza na hora certa;
       o timer vira so um fallback longo. */
    /* Codex #236 r2: o motivo ('manual'/'load'/'timer') JA viaja ate o ultimoStatus — o
       listener aceita SO a gravacao do sync MANUAL feita apos o clique, senao um sync
       automatico em voo mostraria um sucesso que nao e o desta acao. */
    const _t0 = Date.now();
    const _ouvinte = function (mud, area) {
      if (area === 'local' && mud.ultimoStatus) {
        const nv = mud.ultimoStatus.newValue || {};
        if (nv.motivo !== 'manual' || !(nv.quando >= _t0)) return;   // nao e o meu: segue ouvindo
        chrome.storage.onChanged.removeListener(_ouvinte);
        mostrarStatus(nv);
      }
    };
    chrome.storage.onChanged.addListener(_ouvinte);
    setTimeout(async function () {
      chrome.storage.onChanged.removeListener(_ouvinte);
      const c = await chrome.storage.local.get(['ultimoStatus']);
      mostrarStatus(c.ultimoStatus);
    }, 30000);
  });
};

carregar();
