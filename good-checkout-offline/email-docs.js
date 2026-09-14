'use strict';

/* 14/09 — FACHADA (passo 1 da Fase 3). As seis linhas que diferiam entre as cópias eram o
   nome do módulo e o prefixo das envs citado nas MENSAGENS de erro — e essas mensagens dizem
   qual env criar no Render, então apontar a da empresa errada mandaria configurar o lugar
   errado. A regra vive em lib/checkout/email-docs.js. */

module.exports = require('../lib/checkout/email-docs').criar({
  tag: 'GOODBKP',
  base: require('./base'),
  pecas: {
    nf: require('./nf'),
    etiquetas: require('./etiquetas'),
    'danfe-simplificado': require('./danfe-simplificado'),
    'fusao-etiqueta': require('./fusao-etiqueta'),
  },
});
