'use strict';

/* 14/09 — FACHADA (passo 1 da Fase 3). Este arquivo era ESPELHADO nas três pastas, com
   diferença zero depois de normalizar a tag. O verificador segurava a divergência, mas
   segurar não é eliminar: as três cópias existiam e um conserto precisava ser lembrado três
   vezes. A regra agora vive em lib/checkout/comum.js; aqui fica só a tag DESTA empresa, que é o
   que identifica a linha no log do serviço. */

module.exports = require('../lib/checkout/comum').criar({ tag: 'GIRABKP', base: require('./base') });
