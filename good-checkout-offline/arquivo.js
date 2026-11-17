'use strict';

/* 17/11 — FACHADA (norte C, montarCheckout passo 14). Este arquivo era CÓPIA nas três pastas (a diferença era só a tag do
   log) e nem estava na lista dos espelhados do verificador. A regra (purgar o cache velho, arquivar o pedido finalizado,
   podar o arquivo e os conferidos) mora em lib/checkout/arquivo-empresa.js; aqui fica só a empresa (a tag do log sai do
   contrato) e o base DESTA pasta. O texto de antes está em scripts/fixtures/arquivo-antes-good.js.txt. */

module.exports = require('../lib/checkout/arquivo-empresa').criar({ empresa: 'good', base: require('./base') });
