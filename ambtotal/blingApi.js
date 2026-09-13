'use strict';

/* 13/09 — FACHADA (passo 2.7). A regra vive em lib/fiscal/bling-api.js; depois dos portes de
   hoje, o que separava as cópias era rótulo de log e nome de env. As pausas continuam por
   empresa: existem pra não estourar a cota do Bling, que é da CONTA, não do código. */

module.exports = require('../lib/fiscal/bling-api').criarBlingApi({
  rotulo: 'AMB',
  envPausaMs: 'AMB_PAUSA_MS',
  envGetPausaMs: 'AMB_GET_PAUSA_MS',
  envMaxPaginas: 'AMB_MAX_PAGINAS',
  envMaxPaginasNfe: 'AMB_MAX_PAGINAS_NFE',
  envJanelaUltimosDias: 'AMB_JANELA_ULTIMOS_DIAS',
  envMeLojaIds: 'AMB_ME_LOJA_IDS',
  envSituacaoAguardando: 'AMB_SITUACAO_AGUARDANDO',
});
