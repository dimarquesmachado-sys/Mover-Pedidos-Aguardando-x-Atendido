'use strict';
// limpeza.js -- poda do bucket da expedição: a PEÇA ÚNICA lib/checkout/limpeza-expedicao (25/10/2026: eram 204 linhas
// idênticas na Girassol e na AMB, a menos do prefixo da rota). Aqui só o base e o prefixo desta empresa.
module.exports = require('../lib/checkout/limpeza-expedicao').criarLimpeza({ base: require('./base'), prefixo: '/girassol-backup-offline' });
