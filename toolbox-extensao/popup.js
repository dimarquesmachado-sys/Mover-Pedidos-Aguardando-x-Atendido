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
/* 28/08 (pedido do dono): links rápidos — clicar e cair na página certa da instância.
   href="#" + data-url porque popup usa CSP de extensão; abre via chrome.tabs.create. */
const LINKS = {
  girassol: [
    ['⚠️ Painel Frágil', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/fragil/'],
    ['💬 Respostas Rápidas (editar respostas)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/girassol/painel'],
    ['🛒 Checkout offline Girassol', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/girassol-backup-offline/'],
    ['🍪 Painel Shopee (multi-loja)', 'https://girassol-shopee-sync-organizar-envio.onrender.com/'],
    ['⏱️ Ponto (admin)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ponto/admin.html'],
    ['⚙️ Render (envs e serviços)', 'https://dashboard.render.com/'],
  ],
  good: [
    ['⚠️ Painel Frágil', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/fragil/'],
    ['💬 Respostas Rápidas (editar respostas)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/gimpo/painel'],
    ['🛒 Checkout offline GOOD', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/good-checkout-offline/'],
    ['↩️ Devoluções GOOD', 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com/'],
    ['🍪 Painel Shopee (multi-loja)', 'https://girassol-shopee-sync-organizar-envio.onrender.com/'],
    ['⏱️ Ponto (admin)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ponto/admin.html'],
    ['⚙️ Render (envs e serviços)', 'https://dashboard.render.com/'],
  ],
  amb: [
    ['⚠️ Painel Frágil', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/fragil/'],
    ['💬 Respostas Rápidas (editar respostas)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/ambtotal/painel'],
    ['🛒 Checkout offline AMBTotal', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/amb-checkout-offline/'],
    ['↩️ Devoluções AMB', 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com/amb/'],
    ['🍪 Painel Shopee (multi-loja)', 'https://girassol-shopee-sync-organizar-envio.onrender.com/'],
    ['⏱️ Ponto (admin)', 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ponto/admin.html'],
    ['⚙️ Render (envs e serviços)', 'https://dashboard.render.com/'],
  ],
};

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

  /* 29/08 (pedido do dono): "o que tem nesta extensão e como uso" — o popup mostrava só os
     cartões de configuração, então atalhos como Ctrl+Alt+M/S e o fato de vários módulos
     agirem SOZINHOS dentro do site não tinham onde ser descobertos. Recolhido por padrão. */
  const AJUDA = [
    { emp: ['girassol', 'good', 'amb'], txt: '<b>⚠️ Frágil</b> — avisa no checkout do Bling quando o SKU é frágil. Agrega sozinho; lista editável no painel.' },
    { emp: ['girassol', 'good', 'amb'], txt: '<b>💬 Respostas Rápidas</b> — botões de resposta dentro das vendas e perguntas do Mercado Livre.' },
    { emp: ['good', 'amb'], txt: '<b>🧾 NF-e Fulfillment</b> — importa no Bling os XMLs de NF-e que Magalu e Shopee emitem no fulfillment. Dentro do Bling: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> abre o cartão Magalu, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> o da Shopee.' },
    { emp: ['girassol', 'good'], txt: '<b>📦 Etiquetas Madeira Madeira</b> — lê os lotes no painel MM e sincroniza com o checkout. Deixe a aba do painel MM aberta ao sincronizar.' },
    { emp: ['girassol'], txt: '<b>🏷️ Esteira de preços</b> — na listagem de produtos do Bling (produtos.php): grade de preços, margem e categoria por marketplace.' },
    { emp: ['good', 'amb'], txt: '<b>↩️ Devoluções</b> — ponte que emite a NF de devolução a partir do painel; funciona sozinha, sem botão aqui.' },
    { emp: ['girassol', 'good', 'amb'], txt: '<b>🍪 Sessão Shopee</b> — envia os cookies do Seller Center pro servidor (evita mexer no DevTools).' },
    { emp: ['good', 'amb'], txt: '<b>🔑 Cookie Bling</b> — manda o cookie do Bling pro importador de NF do Magalu Full.' },
  ];
  const itens = AJUDA.filter(a => a.emp.includes(emp)).map(a => '<div class="aj-item">' + a.txt + '</div>').join('');
  const box = document.getElementById('ajuda');
  box.innerHTML = '<div class="aj-tit">❔ O que tem nesta extensão (clique)</div><div class="aj-corpo">' + itens +
    '<div class="aj-item" style="color:#9aa2b1;margin-top:6px">Trocar de empresa, chaves e URLs: nos cartões acima.</div></div>';
  box.querySelector('.aj-tit').addEventListener('click', () => box.classList.toggle('aberto'));
  /* 29/08: as telas de configuração abrem em ABA, não dentro do popup. O popup FECHA ao
     perder o foco (regra do navegador, pior no Firefox) — e como as chaves são copiadas de
     outra janela (Render, Bling), era impossível colar sem perder tudo o que foi digitado. */
  for (const a of document.querySelectorAll('#cards a.mod')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const destino = a.getAttribute('href');
      if (!destino) return;
      chrome.tabs.create({ url: chrome.runtime.getURL(destino) });
      window.close();
    });
  }
  /* Codex #243 r3: o link do Respostas deriva do servidor CONFIGURADO (apiUrl do cartao),
     como o botao da tela de configuracao — edicao e leitura no mesmo servidor. Os demais
     atalhos sao paginas fixas dos servicos e ficam estaticos por desenho. */
  chrome.storage.sync.get(['apiUrl'], (cfgS) => {
    let baseResp = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
    try { if (cfgS.apiUrl) baseResp = new URL(cfgS.apiUrl).origin; } catch (e) { /* invalida: producao */ }
    const linksEmp = (LINKS[emp] || []).map(l => {
      const url = l[0].indexOf('Respostas') >= 0
        ? l[1].replace('https://mover-pedidos-aguardando-x-atendido.onrender.com', baseResp)
        : l[1];
      return '<a class="lnk" href="#" data-url="' + url + '">🔗 ' + l[0] + '</a>';
    }).join('');
    document.getElementById('links').innerHTML = linksEmp ? '<div class="lnk-titulo">Páginas dos serviços</div>' + linksEmp : '';
    for (const a of document.querySelectorAll('#links a.lnk')) {
      a.addEventListener('click', (ev) => { ev.preventDefault(); chrome.tabs.create({ url: a.dataset.url }); });
    }
  });
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
