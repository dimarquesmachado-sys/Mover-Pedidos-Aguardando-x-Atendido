'use strict';

/* 13/09 — FACHADA (passo 2.7). A regra vive em lib/fiscal/bling-api.js; depois dos portes de
   hoje, o que separava as cópias era rótulo de log e nome de env. As pausas continuam por
   empresa: existem pra não estourar a cota do Bling, que é da CONTA, não do código. */

module.exports = require('../lib/fiscal/bling-api').criarBlingApi({
  rotulo: 'GIRASSOL',
  envPausaMs: 'PAUSA_MS',
  envGetPausaMs: 'GET_PAUSA_MS',
  envMaxPaginas: 'MAX_PAGINAS',
  envMaxPaginasNfe: 'MAX_PAGINAS_NFE',
  envJanelaUltimosDias: 'JANELA_ULTIMOS_DIAS',
  envMeLojaIds: 'ME_LOJA_IDS',
  envSituacaoAguardando: 'SITUACAO_AGUARDANDO',
});
