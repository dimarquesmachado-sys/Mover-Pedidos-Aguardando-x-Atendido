'use strict';

/* 13/09 — FACHADA (passo 2.6). A regra vive em lib/fiscal/nf-token-manager.js; as 39 linhas
   que diferiam eram rótulo e nome de env. Aqui ficam os valores DESTA empresa. */

module.exports = require('../lib/fiscal/nf-token-manager').criarNfTokenManager({
  rotulo: 'GOOD',
  envTokenFile: 'GOOD_NF_TOKEN_FILE',
  /* caminho absoluto no disco persistente, como sempre foi nesta empresa */
  arquivoToken: '/data/good/nf-tokens.json',
  envId: 'GOOD_NF_BLING_CLIENT_ID',
  envSecret: 'GOOD_NF_BLING_CLIENT_SECRET',
  /* a rota de setup DESTA empresa — a mensagem de erro manda o operador pra cá */
  rotaSetup: '/good/setup-nf',
  envRedirect: 'GOOD_NF_BLING_REDIRECT_URI',
});
