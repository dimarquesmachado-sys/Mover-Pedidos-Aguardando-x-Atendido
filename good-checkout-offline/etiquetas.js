'use strict';

/* 14/09 — FACHADA (passo 1 da Fase 3). Era espelhado nas três pastas com diferença ZERO; a
   regra vive em lib/checkout/etiquetas.js. Aqui fica a tag desta empresa, que é o que
   identifica a linha no log quando há problema de impressão. */

module.exports = require('../lib/checkout/etiquetas').criar({ tag: 'GOODBKP', base: require('./base'), mm: require('../good-mm-etiquetas') });
