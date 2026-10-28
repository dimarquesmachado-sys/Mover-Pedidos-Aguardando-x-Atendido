'use strict';
// amb-pescaria.js -- pescaria retroativa de tarifas do ML e auditoria do ML no histórico: a PEÇA ÚNICA
// lib/checkout/pescaria-empresa (27/10/2026: era cópia na Girassol e na AMB; a GOOD não tinha). Aqui só o que é desta empresa.
module.exports = require('../lib/checkout/pescaria-empresa').criarPescaria({
  base: require('./base'),
  prefixo: '/amb-checkout-offline',
  empresa: 'amb',
  mlTokenManager: () => require('../ambtotal/mlTokenManager'),
});
