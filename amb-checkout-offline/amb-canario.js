'use strict';
// amb-canario.js -- o canário das integrações (o Bling e o ML ainda respondem o que usamos? o faturamento e a venda do dia
// estão frescos? o disco? o serviço da Shopee atende esta loja com esta chave?): a PEÇA ÚNICA lib/checkout/canario-integracoes
// (26/10/2026: era cópia na Girassol e na AMB — só a da AMB conferia o serviço da Shopee; a GOOD não tinha).
module.exports = require('../lib/checkout/canario-integracoes').criarCanarioIntegracoes({
  base: require('./base'),
  prefixo: '/amb-checkout-offline',
  mlTokenManager: () => require('../ambtotal/mlTokenManager'),
  empresa: 'amb',
});
