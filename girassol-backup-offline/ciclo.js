'use strict';
// girassol-backup-offline -- o CICLO do checkout: a PEÇA ÚNICA lib/checkout/ciclo-empresa (30/10/2026; era este arquivo, 990
// linhas). Aqui só o que é da Girassol: os módulos dela, o prefixo das variáveis e do log, a chave fiscal, o token e a API do
// ML, a Madeira Madeira. O tratamento do FULL fica DESLIGADO (fullAtivo: false) — o ciclo da Girassol nunca teve, e ligar é
// decisão do dono (docs/fase3-diferencas-ciclo.md). O conferido segue pro VERIFICADO, que é a fila da Expedição.
module.exports = require('../lib/checkout/ciclo-empresa').criarCiclo({
  base: require('./base'), nf: require('./nf'), etiquetas: require('./etiquetas'), comum: require('./comum'),
  produtos: require('./produtos'), arquivo: require('./arquivo'), separacao: require('./separacao'),
  prefixoEnv: 'GIRABKP', prefixoLog: 'GIRABKP', empresaFiscal: 'girassol',
  unsFullCasa: [], unsEmissaoPropriaCasa: [], fullAtivo: false,
  confirmarSempre: true,   /* a Girassol confere CADA pedido que sumiu da lista antes de apagar a pasta dele (sempre fez assim) */
  mlTokenManager: () => require('../girassol/mlTokenManager'), mlApi: () => require('../girassol/mlApi'),
  mmEtiquetas: () => require('../girassol-mm-etiquetas'),
});
