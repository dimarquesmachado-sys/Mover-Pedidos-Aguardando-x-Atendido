/* Toolbox — CÓDIGO DA COLETA (09/11, pedido do dono). Roda nas páginas de vendas do Mercado Livre: procura o texto
   "Código de autorização para hoje: XXXXXXXX" e manda o código pro fundo da extensão (bg-coleta.js), que o envia ao
   servidor — e o servidor manda por e-mail pro estoque. A página monta aos poucos: tenta a cada 1 s por até 60 s.
   Sem o código no fim, diz POR QUÊ (não logado / página sem o código), pro fundo mostrar na telinha.
   A leitura do texto mora em coleta-ler.js (funções puras, testadas): código, horário, status, motorista, placa, depósito.

   2.1.13 (10/11) — MODO PASSIVO (cláusula 12 dos Termos do ML): o leitor NÃO clica em nada e não abre nada. Ele só lê o
   que está na tela da PESSOA que abriu a página. Motorista e placa: se a pessoa abrir "Detalhes das coletas" e o ML já
   os mostrar, o leitor percebe (olha o texto a cada 5 s, por até 30 min com a página aberta) e manda — sem clicar.
   O "Mandar agora" da Toolbox pede pra esta página reler e reenviar (COLETA_RELER). */
(function () {
  'use strict';
  if (window.__tbColeta) return;
  window.__tbColeta = true;
  var LER = window.tbColetaLer;
  var inicio = Date.now();
  /* 2.1.15 (12/11 — pergunta do dono: "se eu deixar a página aberta e amanhã a extensão ler o código, ela vai saber que é
     de ontem?"): a página que foi CARREGADA em outro dia (de Brasília) mostra o código velho — o leitor não manda mais
     nada dela (nem pelo "Mandar agora") e diz o que fazer: recarregar a página. Ele não recarrega sozinho. */
  function diaBR(ms) {
    try { var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)); var v = function (t) { for (var i = 0; i < p.length; i++) if (p[i].type === t) return p[i].value; return ''; }; return v('year') + '-' + v('month') + '-' + v('day'); } catch (e) { return ''; }
  }
  var diaDaCarga = diaBR(inicio);
  function paginaDeHoje() { return diaBR(Date.now()) === diaDaCarga; }
  var mandouComMotorista = false;
  var vigiando = false;   /* Codex #837: um vigia só, mesmo com a releitura do botão chamando de novo */
  function mandar(msg) { try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) { /* extensão recarregada: a próxima abertura manda */ } }
  function texto() { return (document.body && document.body.innerText) || ''; }
  function enviar(codigo) {
    if (!paginaDeHoje()) { mandar({ tipo: 'COLETA_SEM_CODIGO', motivo: 'pagina_de_outro_dia', url: location.href }); return false; }
    var det = LER.lerDetalhes(texto());
    if (det.motorista && det.placa) mandouComMotorista = true;
    mandar({ tipo: 'COLETA_CODIGO', codigo: codigo, detalhes: det, url: location.href });
    return true;
  }
  /* motorista e placa aparecem quando a PESSOA abre o painel "Detalhes das coletas" (e o ML já os definiu) */
  function vigiarMotorista(codigo) {
    if (vigiando || mandouComMotorista) return;
    vigiando = true;
    var t0 = Date.now();
    var iv = setInterval(function () {
      if (mandouComMotorista || Date.now() - t0 > 30 * 60000) { clearInterval(iv); vigiando = false; return; }
      var det = LER.lerDetalhes(texto());
      if (det.motorista && det.placa) { clearInterval(iv); vigiando = false; enviar(codigo); }
    }, 5000);
  }
  function procurar() {
    var codigo = LER && LER.lerCodigo(texto());
    if (codigo) { enviar(codigo); vigiarMotorista(codigo); return; }
    if (Date.now() - inicio > 60000) {
      var txt = texto();
      var motivo = /login|entrar|acesse sua conta/i.test(location.href + ' ' + txt.slice(0, 400)) ? 'nao_logado' : 'sem_codigo_na_pagina';
      mandar({ tipo: 'COLETA_SEM_CODIGO', motivo: motivo, url: location.href });
      return;
    }
    setTimeout(procurar, 1000);
  }
  /* o "Mandar agora" (o dono clicou na Toolbox): relê o que está na tela e reenvia */
  try {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.tipo !== 'COLETA_RELER') return;
      var codigo = LER && LER.lerCodigo(texto());
      /* Codex #837: o código pode ter aparecido depois dos 60 s da busca inicial — a releitura que o acha também passa a
         vigiar o motorista (sem duplicar o vigia) */
      var foi = false;
      if (codigo) { foi = enviar(codigo); if (foi) vigiarMotorista(codigo); }
      else mandar({ tipo: 'COLETA_SEM_CODIGO', motivo: 'sem_codigo_na_pagina', url: location.href });
      sendResponse({ ok: !!foi, motivo: codigo && !foi ? 'pagina_de_outro_dia' : (codigo ? '' : 'sem_codigo_na_pagina') });
    });
  } catch (e) { /* sem runtime: nada a ouvir */ }
  procurar();
})();
