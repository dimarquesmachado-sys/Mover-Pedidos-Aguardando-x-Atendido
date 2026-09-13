'use strict';

/* 13/09 — FACHADA (passo 2.8). A regra vive em lib/fiscal/token-manager.js. Depois do porte
   da renovação proativa, as três se comportam igual; o que fica aqui são os valores DESTA
   empresa — e o caminho do arquivo, que não se unifica. */

module.exports = require('../lib/fiscal/token-manager').criarTokenManager({
  rotulo: 'AMB',
  envTokenFile: 'AMB_TOKEN_FILE',
  /* disco persistente, como sempre foi aqui */
  arquivoToken: '/data/ambtotal/bling-tokens.json',
  envBlingClientId: 'AMB_BLING_CLIENT_ID',
  envBlingClientSecret: 'AMB_BLING_CLIENT_SECRET',
  envBlingRedirectUri: 'AMB_BLING_REDIRECT_URI',
});
