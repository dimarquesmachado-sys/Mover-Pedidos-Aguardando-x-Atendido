'use strict';

/* 13/09 — FACHADA (passo 2.8). A regra vive em lib/fiscal/token-manager.js. Depois do porte
   da renovação proativa, as três se comportam igual; o que fica aqui são os valores DESTA
   empresa — e o caminho do arquivo, que não se unifica. */

module.exports = require('../lib/fiscal/token-manager').criarTokenManager({
  rotulo: 'GIRASSOL',
  envTokenFile: 'TOKEN_FILE',
  /* RELATIVO ao módulo, como sempre foi aqui — trocar faz perder o token */
  arquivoToken: require('path').join(__dirname, 'data', 'tokens.json'),
  envBlingClientId: 'BLING_CLIENT_ID',
  envBlingClientSecret: 'BLING_CLIENT_SECRET',
  envBlingRedirectUri: 'BLING_REDIRECT_URI',
});
