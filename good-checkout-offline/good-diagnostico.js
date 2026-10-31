'use strict';
// good-checkout-offline -- o DIAGNÓSTICO (rotas de raio-X, sonda e manutenção: debug-*, sonda-*, diag-*, /backup,
// /restaurar): a PEÇA ÚNICA lib/checkout/diagnostico-empresa (31/10/2026; era só da Girassol). Aqui só o que é da GOOD:
// o prefixo, a chave dela no histórico/Supabase (e no token do Mercado Pago, MP_ACCESS_TOKEN_GOOD), os módulos e o token do ML.
// O index chama POR ÚLTIMO no handler — as rotas de diagnóstico que a GOOD já tinha no arquivo dela continuam valendo
// primeiro; daqui vêm as que faltavam (sondas do ML/Mercado Pago/Bling, raio-X da venda ML, custo, NF de emissão).
module.exports = require('../lib/checkout/diagnostico-empresa').criarDiagnostico({
  prefixo: '/good-checkout-offline', empresa: 'good',
  base: require('./base'), nf: require('./nf'), comum: require('./comum'), produtos: require('./produtos'),
  ciclo: require('./ciclo'), danfeSimplificado: require('./danfe-simplificado'),
  mlTokenManager: () => require('../good/mlTokenManager'),
});
