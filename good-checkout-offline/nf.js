'use strict';
// nf.js -- notas fiscais do pedido: a PEÇA ÚNICA lib/checkout/nf-pedido (25/10/2026: eram 344 linhas idênticas nas três
// empresas). Aqui fica só o que é desta empresa: o base (token, pastas) e o emitente de reserva impresso na DANFE.
module.exports = require('../lib/checkout/nf-pedido').criarNfDaEmpresa(require('./base'), {
  rotulo: 'GOODBKP',
  emitenteFallback: require('./emitente-fallback'),
});
