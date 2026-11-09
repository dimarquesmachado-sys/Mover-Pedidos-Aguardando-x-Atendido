/* Toolbox — CÓDIGO DA COLETA (09/11, pedido do dono). Roda nas páginas de vendas do Mercado Livre: procura o texto
   "Código de autorização para hoje: XXXXXXXX" e manda o código pro fundo da extensão (bg-coleta.js), que o envia ao
   servidor — e o servidor manda por e-mail pro estoque. A página monta aos poucos: tenta a cada 1 s por até 60 s.
   Sem o código no fim, diz POR QUÊ (não logado / página sem o código), pro fundo mostrar na telinha.
   09/11 (2.1.11, pedido do dono): junto vão os DETALHES DA COLETA — horário, status, motorista, placa e depósito, do
   painel "Detalhes das coletas". Na aba que a TOOLBOX abriu, ela clica no botão e espera o painel (até 20 s); na aba
   que o dono abriu na mão, NÃO clica em nada (não mexe na tela dele) e lê só o que estiver visível. A leitura do texto
   mora em coleta-ler.js (funções puras, testadas). */
(function () {
  'use strict';
  if (window.__tbColeta) return;
  window.__tbColeta = true;
  var LER = window.tbColetaLer;
  var inicio = Date.now();
  function mandar(msg, cb) { try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; if (cb) cb(r); }); } catch (e) { if (cb) cb(null); } }
  function texto() { return (document.body && document.body.innerText) || ''; }
  function botaoDetalhes() {
    var b = document.querySelector('button[aria-label="Detalhes das coletas"]');
    if (b) return b;
    var todos = document.querySelectorAll('button, a');
    for (var i = 0; i < todos.length; i++) if (/Detalhes das coletas/i.test(todos[i].textContent || '')) return todos[i];
    return null;
  }
  function enviar(codigo) { mandar({ tipo: 'COLETA_CODIGO', codigo: codigo, detalhes: LER.lerDetalhes(texto()), url: location.href }); }
  function comDetalhes(codigo) {
    mandar({ tipo: 'COLETA_QUEM_ABRIU' }, function (r) {
      if (!r || !r.minha) { enviar(codigo); return; }   /* aba do dono: só lê o que está na tela */
      var b = botaoDetalhes();
      if (b) { try { b.click(); } catch (e) { /* segue sem o painel */ } }
      var t0 = Date.now();
      (function esperar() {
        if (/Motorista:/i.test(texto()) || !b || Date.now() - t0 > 20000) { enviar(codigo); return; }
        setTimeout(esperar, 1000);
      })();
    });
  }
  function procurar() {
    var codigo = LER && LER.lerCodigo(texto());
    if (codigo) { comDetalhes(codigo); return; }
    if (Date.now() - inicio > 60000) {
      var txt = texto();
      var motivo = /login|entrar|acesse sua conta/i.test(location.href + ' ' + txt.slice(0, 400)) ? 'nao_logado' : 'sem_codigo_na_pagina';
      mandar({ tipo: 'COLETA_SEM_CODIGO', motivo: motivo, url: location.href });
      return;
    }
    setTimeout(procurar, 1000);
  }
  procurar();
})();
