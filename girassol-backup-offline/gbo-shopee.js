'use strict';
// gbo-shopee.js -- Shopee (repasse/escrow, devoluções, carteira, Ads, conciliação, resumo): a PEÇA ÚNICA
// lib/checkout/shopee-empresa (26/10/2026: era cópia na Girassol e na AMB). Aqui só o que é desta empresa: o base, o
// prefixo das rotas e as variáveis do serviço da Shopee que ela sempre leu.
module.exports = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({
  base: require('./base'),
  prefixo: '/girassol-backup-offline',
  shopee: () => ({
    url: process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
    key: process.env.SHOPEE_SYNC_KEY || '',
    loja: process.env.SHOPEE_SYNC_LOJA || 'girassol',
  }),
  adsMaxDias: 365,
});
