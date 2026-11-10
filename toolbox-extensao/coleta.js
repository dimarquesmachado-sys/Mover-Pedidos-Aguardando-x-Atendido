'use strict';
/* Toolbox — tela do Código da coleta ML (09/11): a chave, o "mandar agora" e o último resultado (com o motivo). */
const $ = (id) => document.getElementById(id);
function mostrar() {
  chrome.storage.local.get(['coleta_key', 'coleta_status', 'coleta_ok', 'tb_empresa'], (c) => {
    const okEmp = (c.coleta_ok && c.coleta_ok.empresa === c.tb_empresa) ? c.coleta_ok : null;   /* o "já foi" é desta empresa */
    $('key').value = c.coleta_key || '';
    const s = c.coleta_status;
    const linhas = [];
    linhas.push('Empresa desta instalação: ' + (c.tb_empresa || '— escolha no menu'));
    linhas.push('Último dia com o código entregue: ' + (okEmp ? okEmp.dia.split('-').reverse().join('/') : 'nenhum ainda'));
    if (s) linhas.push((s.ok ? '✅ ' : '⚠️ ') + new Date(s.quando).toLocaleString('pt-BR') + ' — ' + (s.msg || s.via) + (s.para ? ' (' + s.para + ')' : ''));
    $('status').textContent = linhas.join('\n');
  });
}
$('salvar').addEventListener('click', () => {
  chrome.storage.local.set({ coleta_key: $('key').value.trim() }, () => { $('status').textContent = 'Chave salva.'; setTimeout(mostrar, 800); });
});
$('agora').addEventListener('click', () => {
  $('status').textContent = 'Pedindo à página de Vendas do ML aberta pra reler o código…';
  chrome.runtime.sendMessage({ tipo: 'COLETA_AGORA' }, () => { void chrome.runtime.lastError; });
  let n = 0; const t = setInterval(() => { mostrar(); if (++n > 30) clearInterval(t); }, 3000);
});
mostrar();
