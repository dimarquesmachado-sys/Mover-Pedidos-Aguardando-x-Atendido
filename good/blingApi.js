'use strict';

/* 13/09 — FACHADA (passo 2.7). A regra vive em lib/fiscal/bling-api.js; depois dos portes de
   hoje, o que separava as cópias era rótulo de log e nome de env. As pausas continuam por
   empresa: existem pra não estourar a cota do Bling, que é da CONTA, não do código. */

module.exports = require('../lib/fiscal/bling-api').criarBlingApi({
  rotulo: 'GOOD',
  envPausaMs: 'GOOD_PAUSA_MS',
  envGetPausaMs: 'GOOD_GET_PAUSA_MS',
  envMaxPaginas: 'GOOD_MAX_PAGINAS',
  envMaxPaginasNfe: 'GOOD_MAX_PAGINAS_NFE',
  envJanelaUltimosDias: 'GOOD_JANELA_ULTIMOS_DIAS',
  envMeLojaIds: 'GOOD_ME_LOJA_IDS',
  envSituacaoAguardando: 'GOOD_SITUACAO_AGUARDANDO',
});
