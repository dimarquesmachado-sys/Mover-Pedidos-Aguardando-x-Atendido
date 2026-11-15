'use strict';

/* 14/09 — FACHADA. As ~970 linhas deste arquivo eram a MESMA lógica do histórico da Girassol,
   com tudo cravado onde lá já era parâmetro (rotas, filtro do Supabase, cache, admin, cliente
   Bling). Foram pra lib/checkout/historico.js.
   Aqui fica o contexto DESTA empresa. Sem fallback: dependência ausente derruba no boot em
   vez de a AMB herdar em silêncio o cache, o admin ou o cliente Bling da Girassol. */

const base = require('./base');

function rotasHistorico(ctx) {
  return require('../lib/checkout/historico').rotasHistorico(Object.assign({
    empresa: 'amb',                       /* o filtro do Supabase: vendas_historico?empresa=eq.amb */
    modulo: 'amb-checkout-offline',       /* o prefixo das seis rotas */
    CACHE_DIR: base.CACHE_DIR,
    CONFERIDOS_FILE: base.CONFERIDOS_FILE,
    /* 14/11 — pros "olhos" do chat de análise (lib/checkout/chat-olhos): a fila do galpão e a conta do ML DESTA empresa */
    MANIFEST_FILE: base.MANIFEST_FILE,
    garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
    /* 15/11 — a saúde da conta na Shopee (lib/checkout/saude-shopee): o pedido à Shopee DESTA empresa */
    pedirAoSync: (...a) => require('./amb-shopee').pedirAoSync(...a),
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
