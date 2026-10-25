'use strict';
// separacao.js -- lista de separação (picking): a PEÇA ÚNICA lib/checkout/separacao (25/10/2026: eram 87 linhas
// idênticas nas três empresas). Aqui só o base (manifesto, conferidos e localização) desta empresa.
module.exports = require('../lib/checkout/separacao').criarSeparacao(require('./base'));
