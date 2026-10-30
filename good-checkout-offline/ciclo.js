'use strict';
// good-checkout-offline -- o CICLO do checkout: a PEÇA ÚNICA lib/checkout/ciclo-empresa (30/10/2026; era este arquivo, 1.412
// linhas). Aqui só o que é da GOOD: os módulos dela, o prefixo das variáveis e do log, a chave fiscal, o token e a API do ML,
// e a Madeira Madeira (a GOOD vende lá). As unidades Full vêm só da env GOODBKP_UN_FULL, como sempre foi (sem unidade fixa
// nem emissão própria); o despacho do Full segue desligado enquanto GOODBKP_SIT_DESPACHADOS não estiver configurado.
module.exports = require('../lib/checkout/ciclo-empresa').criarCiclo({
  base: require('./base'), nf: require('./nf'), etiquetas: require('./etiquetas'), comum: require('./comum'),
  produtos: require('./produtos'), arquivo: require('./arquivo'), separacao: require('./separacao'),
  prefixoEnv: 'GOODBKP', prefixoLog: 'GOODBKP', empresaFiscal: 'good',
  unsFullCasa: [], unsEmissaoPropriaCasa: [],
  mlTokenManager: () => require('../good/mlTokenManager'), mlApi: () => require('../good/mlApi'),
  mmEtiquetas: () => require('../good-mm-etiquetas'),
});
