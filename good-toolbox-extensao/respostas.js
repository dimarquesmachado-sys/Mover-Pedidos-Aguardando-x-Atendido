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

chrome.storage.sync.get(['apiUrl', 'apiKey', 'loja', 'detectarAuto'], (cfg) => {
  if (cfg.apiUrl) els.apiUrl.value = cfg.apiUrl;
  if (cfg.apiKey) els.apiKey.value = cfg.apiKey;
  if (cfg.loja) els.loja.value = cfg.loja;
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
