'use strict';

/* 14/09 — FACHADA DO MÓDULO FISCAL (auditoria do Codex, P1). As rotas, os helpers e a forma
   do módulo saíram daqui pra lib/fiscal/criar-modulo.js: eram o mesmo bloco nas três, com o
   prefixo e o rótulo trocados. O que sobra nesta pasta é FIAÇÃO — quais peças desta empresa
   entram na fábrica — e os CRONS, que continuam por empresa de propósito: o F3 roda em
   minutos escalonados pra as três não competirem pela cota do Bling. */

const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ } = require('./nfFluxos');
const { garantirToken, gerarTokenInicial } = require('./tokenManager');
const { gerarTokenInicialNF, garantirTokenNF } = require('./nfTokenManager');
const { garantirTokenML, trocarCodigoPorToken, gerarUrlAutorizacao } = require('./mlTokenManager');
const { getPedidoDetalhe } = require('./blingApi');
const { rotinaNFeML, enviarNFeUnica } = require('./nfeMlFluxo');

const crons = {
  expediente:  '*/3 * * * *',                                 // F1 a cada 3 min, 24h (28/07: antes 6-23; pedido da madrugada esperava até as 6h)
  virada:      '10 0 * * *',                                  // F2 às 00:10
  manha:       ['0 6 * * *', '30 6 * * *', '0 7 * * *',       // F2 às 06:00, 06:30, 07:00
                '*/15 * * * *'],                           // F2 a cada 15 min diurno
  corrigirNFs: '*/5 * * * *',                              // Corrigir-NFs a cada 5 min
  nfeMl:       '4,14,24,34,44,54 * * * *'                  // F3 NF-e→ML a cada 10 min (escalonado: Girassol :0, AMB :2, GOOD :4)
};

module.exports = criarModuloFiscal({
  id: 'good',
  nome: 'GOOD Import',
  prefixo: '/good',        /* '' na Girassol: ela foi a primeira do serviço e as rotas dela não têm prefixo */
  rotulo: 'GOOD',
  crons,
  pecas: {
    rotinaExpediente, rotinaVirada, rotinaManha,
    corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ,
    garantirToken, gerarTokenInicial,
    gerarTokenInicialNF, garantirTokenNF,
    garantirTokenML, trocarCodigoPorToken, gerarUrlAutorizacao,
    getPedidoDetalhe,
    rotinaNFeML, enviarNFeUnica,
  },
});
