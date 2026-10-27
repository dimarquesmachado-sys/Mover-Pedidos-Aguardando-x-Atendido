'use strict';
// good-shopee.js -- Shopee da GOOD (repasse/escrow, devoluções, carteira, Ads, conciliação, resumo, tarifa por SKU): a PEÇA
// ÚNICA lib/checkout/shopee-empresa (27/10/2026 — a GOOD não tinha; a Girassol e a AMB usam a mesma). Aqui só o que é
// desta empresa: o base, o prefixo das rotas e as variáveis do serviço da Shopee (as mesmas da venda do dia dela).
module.exports = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({
  base: require('./base'),
  prefixo: '/good-checkout-offline',
  shopee: () => ({
    url: process.env.GOODBKP_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
    key: process.env.GOODBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
    loja: process.env.GOODBKP_SHOPEE_SYNC_LOJA || 'good',
  }),
  adsMaxDias: 180,
});
