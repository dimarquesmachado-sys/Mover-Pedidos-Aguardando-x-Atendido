'use strict';
// girassol-backup-offline -- o DIAGNÓSTICO (rotas de raio-X, sonda e manutenção): a PEÇA ÚNICA lib/checkout/diagnostico-empresa
// (31/10/2026; era este arquivo, 1.018 linhas). Aqui só o que é da Girassol: o prefixo, a chave dela no histórico/Supabase,
// os módulos dela e o token do ML. O contrato não muda: o gbo-app chama rotasDiagnostico(ctx) e recebe o handler.
module.exports = require('../lib/checkout/diagnostico-empresa').criarDiagnostico({
  prefixo: '/girassol-backup-offline', empresa: 'girassol',
  base: require('./base'), nf: require('./nf'), comum: require('./comum'), produtos: require('./produtos'),
  ciclo: require('./ciclo'), danfeSimplificado: require('./danfe-simplificado'),
  mlTokenManager: () => require('../girassol/mlTokenManager'),
});
