'use strict';

/* 13/09 — FACHADA (passo 2.3 do plano multiloja). A regra vive em
   lib/fiscal/ml-token-manager.js; aqui ficam só os valores DESTA empresa.
   ⚠️ Estes valores mandam o serviço falar com UMA conta do Mercado Livre. Trocá-los entre
   empresas não gera erro — gera venda lida da conta errada, em silêncio. */

const { criarMlTokenManager } = require('../lib/fiscal/ml-token-manager');

module.exports = criarMlTokenManager({
  rotulo: 'GIRASSOL',
  envTokenFile: 'ML_TOKEN_FILE',
  arquivoToken: '/data/ml_tokens.json',
  envClientId: 'ML_CLIENT_ID',
  envClientSecret: 'ML_CLIENT_SECRET',
  envRedirect: 'ML_REDIRECT_URI',
});
