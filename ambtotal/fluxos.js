'use strict';

/* 14/09 — FACHADA do F1/F2. Medido por conjunto de linhas, AMB e GOOD eram IDÊNTICAS (zero
   diferença depois de normalizar o nome da empresa), então a regra foi pra
   lib/fiscal/fluxos-pedidos.js. A Girassol NÃO entrou: ela usa outra estratégia de
   retentativa (marca o pedido como feito no sucesso e precisa de `destravado` pra reabrir
   quando o Bling desfaz; aqui não marcamos, então não há o que destravar) — está registrado
   em docs/fase2-diferencas-girassol.md.
   Os TETOS ficam aqui porque são ritmo de operação desta empresa. */

module.exports = require('../lib/fiscal/fluxos-pedidos').criarFluxosPedidos({
  rotulo: 'AMB',
  envMaxPedidosF1: 'AMB_MAX_PEDIDOS_F1',
  envMaxPedidosF2: 'AMB_MAX_PEDIDOS_F2',
  envF1RemoveMax: 'AMB_F1_REMOVE_MAX',
  envF1RemoveEsperaMin: 'AMB_F1_REMOVE_ESPERA_MIN',
  pecas: {
    blingApi: require('./blingApi'),
    mlApi: require('./mlApi'),
    mlTokenManager: require('./mlTokenManager'),
    tokenManager: require('./tokenManager'),
  },
});
