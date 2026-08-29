/* Barra de navegação comum dos painéis (28/08 — pedido do dono: pular de um painel pro
   outro sem decorar URL). PEÇA ÚNICA: cada painel carrega este script e a barra nasce
   igual em todos; painel novo = uma linha de <script>, não uma cópia de HTML.
   O item da página atual fica destacado e sem link. */
(function () {
  /* 29/08 — ORDEM PEDIDA PELO DONO: agrupada POR EMPRESA (checkout → dashboard → devoluções
     de cada uma, na ordem Girassol, GOOD, AMB) e, no fim, o que é comum às três: Respostas,
     Frágil, Estoque (celular) e Ponto. Devoluções da Girassol entra aqui quando existir. */
  var PAINEIS = [
    ['🛒 Checkout Girassol',  '/girassol-backup-offline/'],
    ['📊 Dashboard Girassol', '/girassol-backup-offline/dashboard'],
    ['🛒 Checkout GOOD',      '/good-checkout-offline/'],
    ['📊 Dashboard GOOD',     '/good-checkout-offline/dashboard'],
    ['🛒 Checkout AMB',       '/amb-checkout-offline/'],
    ['📊 Dashboard AMB',      '/amb-checkout-offline/dashboard'],
  ];

  /* comuns às três, sempre no fim */
  var COMUNS = [
    ['💬 Respostas', '/respostas-rapidas/painel'],
    ['⚠️ Frágil',    '/fragil/'],
    ['⏱️ Ponto (admin)', '/ponto/admin.html'],
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
    /* dentro do painel de uma empresa o nome dela é redundante (pedido do dono) — nos
       painéis neutros os dois continuam identificados, aí a distinção é necessária. */
    if (aqui.indexOf('/girassol-backup-offline') === 0) return [['📱 Estoque (celular)', '/estoque-girassol/celular']];
    if (aqui.indexOf('/good-checkout-offline') === 0 || aqui.indexOf('/amb-checkout-offline') === 0) return [['📱 Estoque (celular)', '/estoque/celular']];
    return [['📱 Estoque (celular)', '/estoque/celular'], ['📱 Estoque Girassol (celular)', '/estoque-girassol/celular']];
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

    /* Devoluções de cada empresa entra logo depois do bloco dela; Estoque e Ponto no fim. */
    var lista = [];
    var devs = itensDevolucoes();
    function devDe(emp) { return devs.filter(function (d) { return d[0].indexOf(emp) >= 0; }); }
    PAINEIS.forEach(function (p) {
      lista.push(p);
      if (p[0].indexOf('Dashboard GOOD') >= 0) lista = lista.concat(devDe('GOOD'));
      if (p[0].indexOf('Dashboard AMB') >= 0)  lista = lista.concat(devDe('AMB'));
    });
    lista = lista.concat(COMUNS.slice(0, 2)).concat(itensEstoque()).concat(COMUNS.slice(2));
    lista.forEach(function (p) {
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

    /* Aviso do canário de tokens: só um booleano vem do servidor (sem detalhes), e o item
       aparece apenas quando algum módulo está com o refresh do Bling quebrado. */
    fetch('/diagnostico/tokens/alerta').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.alerta) return;
      var al = document.createElement('span');
      al.textContent = '⚠️ Token do Bling vencido em um módulo';
      al.title = 'Um módulo com OAuth próprio (Estoque / Frágil) não conseguiu renovar. Reautorize em /<modulo>/auth/bling';
      al.style.cssText = 'font-size:12px;padding:5px 10px;border-radius:6px;background:#b91c1c;color:#fff;font-weight:bold;';
      bar.appendChild(al);
    }).catch(function () { /* silencioso: aviso é bônus, nunca atrapalha a barra */ });

    /* Canário dos módulos de extensão: amarelo (atenção), distinto do vermelho de token.
       Só acende pra módulo que TINHA rotina e ficou mudo — o padrão silencioso que fez o
       dono passar semanas sem saber que o Respostas tinha parado. */
    fetch('/diagnostico/modulos/alerta').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.alerta || !j.mudos || !j.mudos.length) return;
      /* quebra confirmada (a página abriu e o módulo não apareceu) pesa mais que silêncio. */
      var quebras = j.mudos.filter(function (m) { return m.tipo === 'quebra'; });
      var lista = quebras.length ? quebras : j.mudos;
      var nomes = lista.map(function (m) { return m.modulo + (m.empresa ? '/' + m.empresa : ''); }).join(', ');
      var el = document.createElement('span');
      el.textContent = (quebras.length ? '⚠️ Extensão QUEBRADA: ' : '⚠️ Extensão sem sinal: ') + nomes;
      el.title = 'Estes módulos apareciam todo dia e pararam. Provável: o site mudou de URL, a extensão foi desativada ou precisa ser recarregada.';
      el.style.cssText = 'font-size:12px;padding:5px 10px;border-radius:6px;color:#fff;font-weight:bold;background:' + (quebras.length ? '#c2410c' : '#b45309') + ';';
      bar.appendChild(el);
    }).catch(function () { /* silencioso */ });
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
