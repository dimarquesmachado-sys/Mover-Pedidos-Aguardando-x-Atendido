'use strict';
// amb-checkout-offline -- o CICLO do checkout: a PEÇA ÚNICA lib/checkout/ciclo-empresa (30/10/2026; era este arquivo, 1.511
// linhas). Aqui só o que é da AMB: os módulos dela, o prefixo das variáveis e do log, a chave fiscal, as unidades Full da casa
// (2920348 Full Shopee · 2920232 Full Magalu · 2839148 FULL ML · 3456195 FULLFILMENT MLivre; emissão própria: as duas do
// MLivre — AMBBKP_UN_FULL / AMBBKP_UN_FULL_EMISSAO_PROPRIA acrescentam), o token e a API do ML. Sem Madeira Madeira.
module.exports = require('../lib/checkout/ciclo-empresa').criarCiclo({
  base: require('./base'), nf: require('./nf'), etiquetas: require('./etiquetas'), comum: require('./comum'),
  produtos: require('./produtos'), arquivo: require('./arquivo'), separacao: require('./separacao'),
  prefixoEnv: 'AMBBKP', prefixoLog: 'AMBBKP', empresaFiscal: 'amb',
  unsFullCasa: ['2920348', '2920232', '2839148', '3456195'], unsEmissaoPropriaCasa: ['2839148', '3456195'],
  mlTokenManager: () => require('../ambtotal/mlTokenManager'), mlApi: () => require('../ambtotal/mlApi'),
});
