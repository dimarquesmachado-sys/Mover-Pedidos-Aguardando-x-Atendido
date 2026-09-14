'use strict';

/* 14/09 — FACHADA do histórico (Fase 3, passo 3). A regra vive em lib/checkout/historico.js.
   Medida sem comentários, a diferença real entre as duas cópias era de 17 e 39 linhas — e as
   39 eram a parametrização que a Girassol já tinha feito em 25/08, depois de um bug em que
   outra empresa lia o cache, o admin e o cliente Bling DA GIRASSOL.
   Dentro da lib NÃO há fallback pra módulo local: se faltar algo no ctx, ela falha alto. O
   fallback silencioso é que permitiria uma empresa herdar os dados da outra. */

const base = require('./base');
const { rotasHistorico: _rotas } = require('../lib/checkout/historico');

function rotasHistorico(ctx) {
  return _rotas(Object.assign({
    empresa: 'amb',
    modulo: 'amb-checkout-offline',
    CACHE_DIR: base.CACHE_DIR,
    CONFERIDOS_FILE: base.CONFERIDOS_FILE,
    readJson: base.readJson,
    writeJson: base.writeJson,
    ehAdmin: base.ehAdmin,
    blingGet: base.blingGet,
    json: base.json,
    sleep: base.sleep,
    PAUSA_MS: base.PAUSA_MS,
    pecas: { nf: require('./nf'), ciclo: require('./ciclo') },
  }, ctx || {}));
}

module.exports = { rotasHistorico };
