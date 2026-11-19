/* Toolbox multiempresa — hub: a EMPRESA da instância decide quais cartões aparecem.
   Escolhida na 1ª configuração e guardada em tb_empresa; "trocar" pede confirmação
   porque os módulos passam a agir pela nova.
   2.1.20 (V-09): a lista de empresas vem da FICHA (tb-empresas.js) — este arquivo não tem mais
   mapa próprio; cada cartão/ajuda diz qual MÓDULO é, e a ficha diz quem tem o módulo. */
'use strict';
const HOST_MP = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const HOST_DEV = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';

const CARTOES = [
  /* 11/11 (2.1.14, pedido do dono): a CENTRAL — empresa, chaves e um botão que manda e valida todos os módulos de uma vez */
  { html: '<a class="mod" href="central.html">⚡ Central — atualizar tudo<small>empresa, chaves e um botão que valida todos os módulos</small></a>' },
  { modulo: 'mm', html: '<a class="mod" href="mm.html">📦 Etiquetas Madeira Madeira<small>sincronizar lotes do painel MM</small></a>' },
  /* 09/11 (2.1.10): o código de autorização da coleta do ML vai sozinho pro e-mail do estoque — nas três */
  { html: '<a class="mod" href="coleta.html">🔐 Código da coleta ML<small>manda o código do dia pro e-mail do estoque</small></a>' },
  { html: '<a class="mod" href="respostas.html">💬 Respostas Rápidas ML<small>configuração das respostas nas vendas</small></a>' },
  { html: '<a class="mod" href="shopee.html">🍪 Sessão Shopee<small>enviar cookies do Seller Center (sem DevTools)</small></a>' },
  { modulo: 'bling', html: '<a class="mod" href="bling.html">🔑 Cookie Bling<small>sessão do Bling pro importador NF Magalu Full</small></a>' },
  { html: '<a class="mod" href="options.html" target="_blank">⚠️ Alerta Frágil<small>configurações do alerta no checkout do Bling</small></a>' },
];
/* 28/08 (pedido do dono): links rápidos — clicar e cair na página certa da instância.
   href="#" + data-url porque popup usa CSP de extensão; abre via chrome.tabs.create.
   30/09 - A GIRASSOL entrou no Devolucoes em 28/09 (3a empresa). O `bg-devolucoes.js` ja
   tinha sido acertado; o popup ficou pra tras, entao o dono nao tinha por onde chegar la.
   ⚠️ A BARRA NO FIM e obrigatoria nos modulos por empresa: sem ela o modulo nao abre
   (ele testou na tela). Vale pra /girassol/ e /amb/; a GOOD e a raiz.
   2.1.20: montados da ficha — toda empresa ganha os seus, inclusive a próxima. */
function linksDa(emp) {
  const f = tbFicha(emp); if (!f) return [];
  return [
    ['⚠️ Painel Frágil', HOST_MP + '/fragil/'],
    ['💬 Respostas Rápidas (editar respostas)', HOST_MP + '/respostas-rapidas/' + f.respostas.instancia + '/painel'],
    ['🛒 Checkout offline ' + f.curto, HOST_MP + '/' + f.checkout + '/'],
    ['↩️ Devoluções ' + f.curto, HOST_DEV + f.devolucoes + '/'],
    ['🍪 Painel Shopee (multi-loja)', 'https://girassol-shopee-sync-organizar-envio.onrender.com/'],
    ['⏱️ Ponto (admin)', HOST_MP + '/ponto/admin.html'],
    ['⚙️ Render (envs e serviços)', 'https://dashboard.render.com/'],
  ];
}

/* o que roda sozinho nesta empresa — montado da ficha */
function autosDa(emp) {
  const partes = ['Alerta Frágil' + (tbTem(emp, 'esteira') ? ' (se configurado)' : '')];
  if (tbTem(emp, 'esteira')) partes.push('Esteira do Bling (botão flutuante em produtos.php)');
  if (tbTem(emp, 'mlfull')) partes.push('NF-e Fulfillment Magalu+Shopee (Bling)');
  partes.push('Devoluções Bridge');
  return 'Rodam sozinhos: ' + partes.join(' · ') + '.' + (tbTem(emp, 'mlfull') ? '' : ' NF-e Fulfillment é só de quem tem Magalu Full e fica dormente aqui.');
}

function mostrar(emp) {
  document.getElementById('selEmpresa').style.display = emp ? 'none' : 'block';
  document.getElementById('menu').style.display = emp ? 'block' : 'none';
  if (!emp) return;
  document.getElementById('empNome').textContent = (tbFicha(emp) || {}).curto || emp;
  /* 07/11 (2.1.9, pedido do dono): a VERSÃO no menu — pra saber na hora se a atualização pegou */
  try { const _v = document.getElementById('versao'); if (_v) _v.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  document.getElementById('cards').innerHTML = CARTOES.filter(c => !c.modulo || tbTem(emp, c.modulo)).map(c => c.html).join('');

  /* 29/08 (pedido do dono): "o que tem nesta extensão e como uso" — o popup mostrava só os
     cartões de configuração, então atalhos como Ctrl+Alt+M/S e o fato de vários módulos
     agirem SOZINHOS dentro do site não tinham onde ser descobertos. Recolhido por padrão. */
  const AJUDA = [
    { txt: '<b>⚠️ Frágil</b> — avisa no checkout do Bling quando o SKU é frágil. Agrega sozinho; lista editável no painel.' },
    { txt: '<b>💬 Respostas Rápidas</b> — botões de resposta dentro das vendas e perguntas do Mercado Livre.' },
    { modulo: 'mlfull', txt: '<b>🧾 NF-e Fulfillment</b> — importa no Bling os XMLs de NF-e que Magalu e Shopee emitem no fulfillment. Dentro do Bling: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> abre o cartão Magalu, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> o da Shopee.' },
    { modulo: 'mm', txt: '<b>📦 Etiquetas Madeira Madeira</b> — lê os lotes no painel MM e sincroniza com o checkout. Deixe a aba do painel MM aberta ao sincronizar.' },
    { modulo: 'esteira', txt: '<b>🏷️ Esteira de preços</b> — na listagem de produtos do Bling (produtos.php): grade de preços, margem e categoria por marketplace.' },
    { txt: '<b>↩️ Devoluções</b> — ponte que emite a NF de devolução a partir do painel; funciona sozinha, sem botão aqui.' },
    { txt: '<b>🍪 Sessão Shopee</b> — envia os cookies do Seller Center pro servidor (evita mexer no DevTools).' },
    { modulo: 'bling', txt: '<b>🔑 Cookie Bling</b> — manda o cookie do Bling pro importador de NF do Magalu Full.' },
  ];
  const itens = AJUDA.filter(a => !a.modulo || tbTem(emp, a.modulo)).map(a => '<div class="aj-item">' + a.txt + '</div>').join('');
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
    let baseResp = HOST_MP;
    try { if (cfgS.apiUrl) baseResp = new URL(cfgS.apiUrl).origin; } catch (e) { /* invalida: producao */ }
    const linksEmp = linksDa(emp).map(l => {
      const url = l[0].indexOf('Respostas') >= 0
        ? l[1].replace(HOST_MP, baseResp)
        : l[1];
      return '<a class="lnk" href="#" data-url="' + url + '">🔗 ' + l[0] + '</a>';
    }).join('');
    document.getElementById('links').innerHTML = linksEmp ? '<div class="lnk-titulo">Páginas dos serviços</div>' + linksEmp : '';
    for (const a of document.querySelectorAll('#links a.lnk')) {
      a.addEventListener('click', (ev) => { ev.preventDefault(); chrome.tabs.create({ url: a.dataset.url }); });
    }
  });
  document.getElementById('autos').textContent = autosDa(emp);
}

/* 2.1.20: os botões da primeira configuração nascem da ficha — empresa nova aparece sozinha */
document.getElementById('botoesEmpresa').innerHTML = tbEmpresas().map((k) => {
  const f = tbFicha(k);
  return '<button class="emp" data-emp="' + k + '">' + f.emoji + ' ' + f.nome + '</button>';
}).join('');
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
