/* Toolbox multiempresa — hub: a EMPRESA da instância decide quais cartões aparecem.
   Escolhida na 1ª configuração e guardada em tb_empresa; "trocar" pede confirmação
   porque os módulos passam a agir pela nova. */
'use strict';
const NOMES = { girassol: 'Girassol', good: 'GOOD', amb: 'AMBTotal' };

const CARTOES = [
  { emp: ['girassol', 'good'], html: '<a class="mod" href="mm.html">📦 Etiquetas Madeira Madeira<small>sincronizar lotes do painel MM</small></a>' },
  { emp: ['girassol', 'good', 'amb'], html: '<a class="mod" href="respostas.html">💬 Respostas Rápidas ML<small>configuração das respostas nas vendas</small></a>' },
  { emp: ['girassol', 'good', 'amb'], html: '<a class="mod" href="shopee.html">🍪 Sessão Shopee<small>enviar cookies do Seller Center (sem DevTools)</small></a>' },
  { emp: ['good', 'amb'], html: '<a class="mod" href="bling.html">🔑 Cookie Bling<small>sessão do Bling pro importador NF Magalu Full</small></a>' },
  { emp: ['girassol', 'good', 'amb'], html: '<a class="mod" href="options.html" target="_blank">⚠️ Alerta Frágil<small>configurações do alerta no checkout do Bling</small></a>' },
];
const AUTOS = {
  girassol: 'Rodam sozinhos: Alerta Frágil (se configurado) · Esteira do Bling (botão flutuante em produtos.php). NF-e Fulfillment é só GOOD/AMB e fica dormente aqui.',
  good: 'Rodam sozinhos: Alerta Frágil · NF-e Fulfillment Magalu+Shopee (Bling) · Devoluções Bridge.',
  amb: 'Rodam sozinhos: Alerta Frágil · NF-e Fulfillment Magalu+Shopee (Bling) · Devoluções Bridge.',
};

function mostrar(emp) {
  document.getElementById('selEmpresa').style.display = emp ? 'none' : 'block';
  document.getElementById('menu').style.display = emp ? 'block' : 'none';
  if (!emp) return;
  document.getElementById('empNome').textContent = NOMES[emp] || emp;
  document.getElementById('cards').innerHTML = CARTOES.filter(c => c.emp.includes(emp)).map(c => c.html).join('');
  document.getElementById('autos').textContent = AUTOS[emp] || '';
}

chrome.storage.local.get(['tb_empresa'], v => mostrar(v.tb_empresa || null));

for (const b of document.querySelectorAll('button.emp')) {
  b.addEventListener('click', () => {
    const emp = b.dataset.emp;
    chrome.storage.local.set({ tb_empresa: emp }, () => mostrar(emp));
  });
}
document.getElementById('trocar').addEventListener('click', () => {
  if (!confirm('Trocar a empresa desta instalação? Os módulos passam a agir pela nova empresa (as chaves configuradas continuam guardadas).')) return;
  chrome.storage.local.remove('tb_empresa', () => mostrar(null));
});
