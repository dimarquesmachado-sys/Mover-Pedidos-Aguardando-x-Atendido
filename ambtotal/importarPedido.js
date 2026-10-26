'use strict';
// importarPedido.js -- recoloca no Bling a venda do ML que não chegou (o conserto do canário): a PEÇA ÚNICA
// lib/importar-pedido-ml (25/10/2026: só a Girassol tinha). Aqui só o que é desta empresa: os tokens dela, o
// intermediador da NF dela e a variável do canal do ML no Bling dela.
module.exports = require('../lib/importar-pedido-ml').criarImportadorMl({
  rotulo: 'AMB',
  tokenManager: require('./tokenManager'),
  mlTokenManager: require('./mlTokenManager'),
  nfBlingApi: require('./nfBlingApi'),
  envMeLojaIds: 'AMB_ME_LOJA_IDS',
  rotaDescobrir: '/amb-checkout-offline/descobrir-ids',
});
