'use strict';

/* 13/09 — FACHADA. As 324 linhas deste arquivo eram mantidas em TRIPLICATA nas três
   empresas, e a única diferença real entre elas era o nome da env do cooldown: 972 linhas
   de manutenção por causa de um prefixo. Foi o caso mais claro da Fase 2 da auditoria
   multiloja ("idêntico em três pastas é bloqueador para a quarta") — e a dívida é concreta,
   porque cada conserto aqui precisava ser lembrado três vezes.

   A regra agora vive em lib/fiscal/nf-fluxos.js. Este arquivo continua existindo pra os
   require() antigos não quebrarem — é o estado intermediário que a auditoria recomenda. */

const { criarFluxoNF } = require('../lib/fiscal/nf-fluxos');

module.exports = criarFluxoNF({
  nfTokenManager: require('./nfTokenManager'),
  nfBlingApi: require('./nfBlingApi'),
  envCooldown: 'GOOD_NF_COOLDOWN_MIN',
});
