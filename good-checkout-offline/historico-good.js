'use strict';

/* 14/09 — FACHADA do histórico da GOOD. Ela nunca teve histórico: por isso não tem dashboard
   de vendas, e por isso o painel chamava uma rota que não existia. A lógica é a MESMA da AMB
   e da Girassol (lib/checkout/historico.js) — o que faltava aqui era só a fiação.
   Sem fallback: dependência ausente derruba no boot em vez de a GOOD herdar em silêncio o
   cache, o admin ou o cliente Bling de outra empresa. */

const base = require('./base');

function rotasHistorico(ctx) {
  return require('../lib/checkout/historico').rotasHistorico(Object.assign({
    empresa: 'good',                      /* a fatia do Supabase: vendas_historico?empresa=eq.good */
    modulo: 'good-checkout-offline',      /* o prefixo das seis rotas */
    CACHE_DIR: base.CACHE_DIR,
    CONFERIDOS_FILE: base.CONFERIDOS_FILE,
    PAUSA_MS: base.PAUSA_MS,
    readJson: base.readJson,
    writeJson: base.writeJson,
    ehAdmin: base.ehAdmin,
    blingGet: base.blingGet,
    sleep: base.sleep,
    json: base.json,
    nfDoPedido: require('./nf').nfDoPedido,
    detalhePedido: require('./ciclo').detalhePedido,
  }, ctx || {}));
}

module.exports = { rotasHistorico };
