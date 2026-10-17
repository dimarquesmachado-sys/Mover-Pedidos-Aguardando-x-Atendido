'use strict';

/* 14/09 — FACHADA do F3 (NF-e → Mercado Livre). A regra vive em lib/fiscal/nfe-ml-fluxo.js:
   AMB e GOOD eram idênticas e a Girassol diferia só em env e rótulo. Aqui ficam os TETOS
   desta empresa, que são operação e não regra — empresa que emite mais precisa de teto
   diferente, e igualar seria decidir o ritmo de uma pela outra. */

module.exports = require('../lib/fiscal/nfe-ml-fluxo').criarFluxoNFeML({
  /* 17/10 (Codex #707): as notas travadas do F3 vão pro cache DA EMPRESA — é de lá que o checkout lê (/nf-travadas) */
  dirTravadas: process.env.GIRABKP_CACHE_DIR || '/data/cache-offline/girassol',
  rotulo: 'GIRASSOL',
  envMaxNfeMl: 'MAX_NFE_ML',
  envNfJanelaDias: 'NF_JANELA_DIAS_F3',
  envF3MaxChecagens: 'F3_MAX_CHECAGENS',
  pecas: {
    blingApi: require('./blingApi'),
    mlApi: require('./mlApi'),
    mlTokenManager: require('./mlTokenManager'),
    tokenManager: require('./tokenManager'),
  },
});
