/* Toolbox — CÓDIGO DA COLETA (09/11, pedido do dono). Roda nas páginas de vendas do Mercado Livre: procura o texto
   "Código de autorização para hoje: XXXXXXXX" e manda o código pro fundo da extensão (bg-coleta.js), que o envia ao
   servidor — e o servidor manda por e-mail pro estoque. A página monta aos poucos: tenta a cada 1 s por até 60 s.
   Sem o código no fim, diz POR QUÊ (não logado / página sem o código), pro fundo mostrar na telinha. */
(function () {
  'use strict';
  if (window.__tbColeta) return;
  window.__tbColeta = true;
  var RE = /C[óo]digo de autoriza[çc][ãa]o para hoje:?\s*([A-Za-z0-9]{6,12})\b/;
  var inicio = Date.now();
  function mandar(msg) { try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) { /* extensão recarregada: a próxima abertura manda */ } }
  function procurar() {
    var txt = (document.body && document.body.innerText) || '';
    var m = RE.exec(txt);
    if (m) { mandar({ tipo: 'COLETA_CODIGO', codigo: m[1].toUpperCase(), url: location.href }); return; }
    if (Date.now() - inicio > 60000) {
      var motivo = /login|entrar|acesse sua conta/i.test(location.href + ' ' + txt.slice(0, 400)) ? 'nao_logado' : 'sem_codigo_na_pagina';
      mandar({ tipo: 'COLETA_SEM_CODIGO', motivo: motivo, url: location.href });
      return;
    }
    setTimeout(procurar, 1000);
  }
  procurar();
})();
