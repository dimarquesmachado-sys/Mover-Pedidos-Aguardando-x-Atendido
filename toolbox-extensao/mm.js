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
    /* 07/11 (2.1.7): quantas etiquetas (ZPL) a extensão entregou ao checkout nesta rodada */
    if (s.etiquetas) linha += ', etiquetas entregues ' + s.etiquetas;
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
  /* Codex #264 (P1): com a tela abrindo em ABA própria, a aba ATIVA passou a ser a da
     extensão — o sync manual olhava pra ela e quebrava. Procura a aba do painel MM;
     se não achar, cai na aba ativa (comportamento antigo) e o erro segue explicando. */
  let tabs = await chrome.tabs.query({ url: 'https://painelmarketplace.madeiramadeira.com.br/*' });
  if (!tabs || !tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !/painelmarketplace\.madeiramadeira\.com\.br/.test(tab.url || '')) {
    $('status').textContent = 'Abra a aba do Madeira Madeira (painel), faça login e tente de novo.';
    return;
  }
  /* 07/11 (2.1.8): o relógio começa no CLIQUE — antes ele só começava depois da resposta da página, e uma rodada presa
     deixava "Sincronizando..." pra sempre (caso real do dono). O resultado esperado é o da sincronização MANUAL feita
     depois do clique (Codex #236 r2/r4); sem ele em 90 s, a telinha diz o que conferir. */
  const _t0 = Date.now();
  let _fb = null;
  const _ouvinte = function (mud, area) {
    if (area === 'local' && mud.ultimoStatus) {
      const nv = mud.ultimoStatus.newValue || {};
      if (nv.motivo !== 'manual' || !(nv.quando >= _t0)) return;   // nao e o meu: segue ouvindo
      chrome.storage.onChanged.removeListener(_ouvinte);
      clearTimeout(_fb);
      mostrarStatus(nv);
    }
  };
  chrome.storage.onChanged.addListener(_ouvinte);
  _fb = setTimeout(async function () {
    chrome.storage.onChanged.removeListener(_ouvinte);
    const c = await chrome.storage.local.get(['ultimoStatus']);
    const s = c.ultimoStatus || null;
    if (s && s.motivo === 'manual' && s.quando >= _t0) mostrarStatus(s);
    else $('status').textContent = '⚠️ A sincronização não terminou em 90s. Confira: a VPN está ligada? A página do Madeira abre e está logada? Recarregue a página do Madeira (F5) e tente de novo.';
  }, 90000);
  chrome.tabs.sendMessage(tab.id, { tipo: 'MM_SYNC_AGORA' }, function () {
    if (chrome.runtime.lastError) {
      chrome.storage.onChanged.removeListener(_ouvinte);
      clearTimeout(_fb);
      $('status').textContent = 'Recarregue a página do Madeira Madeira (F5) e tente de novo.';
      return;
    }
    $('status').textContent = 'Sincronizando... (lendo os lotes e baixando as etiquetas — pode levar até 1 minuto)';
  });
};

carregar();
