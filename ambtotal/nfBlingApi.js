'use strict';

/* 13/09 — FACHADA (passo 2.2 do plano multiloja). As 340 linhas deste arquivo eram cópia nas
   três empresas; a classificação mostrou que a diferença era rótulo de log, prefixo de env e
   dois valores de configuração — nenhuma regra de negócio. A regra vive em
   lib/fiscal/nf-bling-api.js; aqui ficam só os valores DESTA empresa. */

const { criarNfBlingApi } = require('../lib/fiscal/nf-bling-api');

module.exports = criarNfBlingApi({
  rotulo: 'AMB',
  nfTokenManager: require('./nfTokenManager'),
  envPausa: 'AMB_NF_PAUSA_MS',
  envIntermediadorCnpj: 'AMB_NF_INTERMEDIADOR_CNPJ',
  envIntermediadorNome: 'AMB_NF_INTERMEDIADOR_NOME',
  intermediadorCnpj: '03007331000141',
  intermediadorNome: 'AMBTOTAL',
  /* a pasta do cache de IE é SEPARADA por empresa de propósito: misturar Inscrição Estadual
     entre CNPJs diferentes seria erro fiscal, não desorganização. */
  pastaCacheIE: '/data/ambtotal',
});
