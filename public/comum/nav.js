/* Barra de navegação comum dos painéis (28/08 — pedido do dono: pular de um painel pro
   outro sem decorar URL). PEÇA ÚNICA: cada painel carrega este script e a barra nasce
   igual em todos; painel novo = uma linha de <script>, não uma cópia de HTML.
   O item da página atual fica destacado e sem link. */
(function () {
  var PAINEIS = [
    ['⚠️ Frágil',        '/fragil/'],
    ['💬 Respostas',     '/respostas-rapidas/painel'],
    ['🛒 Checkout Girassol', '/girassol-backup-offline/'],
    ['🛒 Checkout GOOD',     '/good-checkout-offline/'],
    ['🛒 Checkout AMB',      '/amb-checkout-offline/'],

    ['⏱️ Ponto (admin)', '/ponto/admin.html'],   /* o dono usa o painel de GESTOR; /ponto/ e a tela de registro do funcionario */

  ];

  function ehAtual(href) {
    if (href.indexOf('http') === 0) return false;   // painel de outro serviço
    var aqui = window.location.pathname;
    var base = href.replace(/\/$/, '');
    return aqui === href || aqui === base || aqui.indexOf(base + '/') === 0;
  }

  /* Devoluções é POR EMPRESA e vive em outro serviço: raiz = GOOD, /amb = AMBTotal.
     A Girassol não tem devoluções nesse app. Num painel de empresa, mostra só o dela
     (no da Girassol, nenhum); nos painéis neutros (Frágil, Respostas, Ponto), os dois. */
  var DEV_HOST = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';
  /* Estoque (localizacao no galpao) tambem e por empresa e a ROTA e /estoque/celular —
     sem .html (o .html e o nome do arquivo, nao da rota: por isso o botao abria nada). */
  function itensEstoque() {
    var aqui = window.location.pathname;
    if (aqui.indexOf('/girassol-backup-offline') === 0) return [['📍 Estoque Girassol', '/estoque-girassol/celular']];
    if (aqui.indexOf('/good-checkout-offline') === 0 || aqui.indexOf('/amb-checkout-offline') === 0) return [['📍 Estoque', '/estoque/celular']];
    return [['📍 Estoque', '/estoque/celular'], ['📍 Estoque Girassol', '/estoque-girassol/celular']];
  }

  function itensDevolucoes() {
    var aqui = window.location.pathname;
    if (aqui.indexOf('/girassol-backup-offline') === 0) return [];
    if (aqui.indexOf('/good-checkout-offline') === 0) return [['↩️ Devoluções GOOD', DEV_HOST + '/']];
    if (aqui.indexOf('/amb-checkout-offline') === 0) return [['↩️ Devoluções AMB', DEV_HOST + '/amb']];
    return [['↩️ Devoluções GOOD', DEV_HOST + '/'], ['↩️ Devoluções AMB', DEV_HOST + '/amb']];
  }

  function montar() {
    if (document.getElementById('nav-paineis')) return;
    var bar = document.createElement('div');
    bar.id = 'nav-paineis';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;' +
      'padding:8px 12px;background:#1f2430;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    var titulo = document.createElement('span');
    titulo.textContent = 'Painéis:';
    titulo.style.cssText = 'color:#9aa2b1;font-size:12px;margin-right:4px;';
    bar.appendChild(titulo);

    PAINEIS.concat(itensEstoque()).concat(itensDevolucoes()).forEach(function (p) {
      var atual = ehAtual(p[1]);
      var el = document.createElement(atual ? 'span' : 'a');
      el.textContent = p[0];
      el.style.cssText = 'font-size:12px;padding:5px 10px;border-radius:6px;text-decoration:none;' +
        (atual ? 'background:#3b82f6;color:#fff;font-weight:bold;' : 'background:#2c3140;color:#cfd6e4;');
      if (!atual) {
        el.href = p[1];
        if (p[1].indexOf('http') === 0) { el.target = '_blank'; el.rel = 'noopener'; }
        el.addEventListener('mouseover', function () { el.style.background = '#3a4152'; });
        el.addEventListener('mouseout',  function () { el.style.background = '#2c3140'; });
      }
      bar.appendChild(el);
    });
    document.body.insertBefore(bar, document.body.firstChild);
  }

  /* Painéis operados pelo GALPÃO (checkout offline) carregam com data-so-admin: a barra
     NÃO nasce sozinha — a página chama window.navPaineisMostrar() só quando o operador
     logado é admin (mesmo gancho souAdmin() que já esconde Dashboard e links MKTP↗).
     Estoquista nunca vê os atalhos administrativos. */
  var soAdmin = !!(document.currentScript && document.currentScript.dataset && document.currentScript.dataset.soAdmin !== undefined);
  window.navPaineisMostrar = montar;
  if (soAdmin) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();
})();
