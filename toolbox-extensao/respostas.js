// popup.js - configuração da extensão
const els = {
  apiUrl: document.getElementById('apiUrl'),
  apiKey: document.getElementById('apiKey'),
  loja: document.getElementById('loja'),
  detectarAuto: document.getElementById('detectarAuto'),
  status: document.getElementById('status'),
  salvar: document.getElementById('salvar'),
  testar: document.getElementById('testar')
};

/* Toolbox 2.0 (Codex #237 r1): sem loja salva, o default segue a EMPRESA da instância —
   antes caía no primeiro option (AMBTOTAL) e uma instalação Girassol/GOOD nova pedia as
   respostas da AMB quando a detecção falhasse. */
const MAPA_LOJA = { girassol: 'GIRASSOL', good: 'GIMPO', amb: 'AMBTOTAL' };
chrome.storage.sync.get(['apiUrl', 'apiKey', 'loja', 'detectarAuto'], (cfg) => {
  if (cfg.apiUrl) els.apiUrl.value = cfg.apiUrl;
  if (cfg.apiKey) els.apiKey.value = cfg.apiKey;
  if (cfg.loja) els.loja.value = cfg.loja;
  else chrome.storage.local.get(['tb_empresa'], (v) => { if (v.tb_empresa && MAPA_LOJA[v.tb_empresa]) els.loja.value = MAPA_LOJA[v.tb_empresa]; });
  els.detectarAuto.checked = cfg.detectarAuto !== false;
});

els.salvar.addEventListener('click', () => {
  const apiUrl = els.apiUrl.value.trim().replace(/\/$/, '');
  const apiKey = els.apiKey.value.trim();
  const loja = els.loja.value;
  const detectarAuto = els.detectarAuto.checked;
  if (!apiUrl || !apiKey) {
    showStatus('Preencha URL e API Key', false);
    return;
  }
  chrome.storage.sync.set({ apiUrl, apiKey, loja, detectarAuto }, () => {
    showStatus('✅ Salvo! Recarregue a página do ML.', true);
  });
});

els.testar.addEventListener('click', async () => {
  const apiUrl = els.apiUrl.value.trim().replace(/\/$/, '');
  const apiKey = els.apiKey.value.trim();
  const loja = els.loja.value;
  if (!apiUrl || !apiKey) {
    showStatus('Preencha URL e API Key primeiro', false);
    return;
  }
  showStatus('Testando...', true);
  try {
    const r = await fetch(`${apiUrl}/respostas-rapidas/api/respostas?loja=${loja}`, {
      headers: { 'X-API-Key': apiKey }
    });
    if (!r.ok) {
      showStatus(`❌ Erro ${r.status}`, false);
      return;
    }
    const data = await r.json();
    const qtd = (data.respostas || []).length;
    showStatus(`✅ OK! ${qtd} respostas para ${loja}`, true);
  } catch (e) {
    showStatus('❌ Erro de conexão: ' + e.message, false);
  }
});

function showStatus(msg, ok) {
  els.status.textContent = msg;
  els.status.className = 'status ' + (ok ? 'ok' : 'err');
}

/* 28/08: botao 'Editar as respostas' — inline script nao roda em pagina de extensao MV3
   (CSP script-src 'self'), o listener vive aqui. */
const _btnPainelResp = document.getElementById('abrir-painel-respostas');
if (_btnPainelResp) _btnPainelResp.addEventListener('click', function (ev) {
  ev.preventDefault();
  /* Codex #243: o painel generico expoe TODAS as lojas — abre o painel DA LOJA da
     instancia (girassol→girassol, good→gimpo, amb→ambtotal), que trava o editor nela. */
  chrome.storage.local.get(['tb_empresa'], function (r) {
    const mapa = { girassol: 'girassol', good: 'gimpo', amb: 'ambtotal' };
    const loja = mapa[r.tb_empresa] || '';
    const url = 'https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/' + (loja ? loja + '/painel' : 'painel');
    chrome.tabs.create({ url });
  });
});
