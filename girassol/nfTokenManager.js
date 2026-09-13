'use strict';

/* 13/09 — FACHADA (passo 2.6). A regra vive em lib/fiscal/nf-token-manager.js; as 39 linhas
   que diferiam eram rótulo e nome de env. Aqui ficam os valores DESTA empresa. */

module.exports = require('../lib/fiscal/nf-token-manager').criarNfTokenManager({
  rotulo: 'GIRASSOL',
  envTokenFile: 'NF_TOKEN_FILE',
  /* caminho RELATIVO ao módulo, como sempre foi nesta empresa — trocar faria perder o token */
  arquivoToken: require('path').join(__dirname, 'data', 'nf_tokens.json'),
  envId: 'NF_BLING_CLIENT_ID',
  envSecret: 'NF_BLING_CLIENT_SECRET',
  /* a rota de setup DESTA empresa — a mensagem de erro manda o operador pra cá */
  rotaSetup: '/setup-nf',
  envRedirect: 'NF_BLING_REDIRECT_URI',
});
