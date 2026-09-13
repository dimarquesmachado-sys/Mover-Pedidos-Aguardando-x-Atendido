'use strict';

/* 13/09 — FACHADA (passo 2.8). A regra vive em lib/fiscal/token-manager.js. Depois do porte
   da renovação proativa, as três se comportam igual; o que fica aqui são os valores DESTA
   empresa — e o caminho do arquivo, que não se unifica. */

module.exports = require('../lib/fiscal/token-manager').criarTokenManager({
  rotulo: 'GOOD',
  envTokenFile: 'GOOD_TOKEN_FILE',
  /* disco persistente, como sempre foi aqui */
  arquivoToken: '/data/good/bling-tokens.json',
  envBlingClientId: 'GOOD_BLING_CLIENT_ID',
  envBlingClientSecret: 'GOOD_BLING_CLIENT_SECRET',
  envBlingRedirectUri: 'GOOD_BLING_REDIRECT_URI',
});
