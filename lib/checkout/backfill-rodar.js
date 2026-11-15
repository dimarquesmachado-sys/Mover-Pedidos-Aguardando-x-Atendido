'use strict';
/* 15/11 — O BACKFILL DE UMA EMPRESA QUE TRAZ O CONTEXTO DELA (norte C: zero `require` cruzado entre pastas de empresa).

   O motor do histórico de vendas é a peça lib/checkout/backfill-motor. A Girassol o monta com as peças DELA (gbo-app.js:
   os padrões de quando quem chama não traz `ctx`). A AMB e a GOOD, que SEMPRE trazem o contexto completo, chamavam
   `require('../girassol-backup-offline/gbo-app').backfillVendas(...)` só pra chegar ao motor — e, no caminho, pegavam da
   Girassol o que o motor lê fora do ctx: a tarifa leve do ML, o canal pelo número, o escrow da Shopee, o estado do backfill.

   Aqui o motor é montado SEM empresa padrão: o que é da empresa tem que vir no `ctx` (senão recusa, com o nome do que
   faltou — nunca cai em silêncio na Girassol); o que é regra geral vem das peças (estado por empresa, situações de
   cancelamento por empresa, canal pelo número, tarifa leve do ML, contas do escrow, serviço do pedido). */
const ESTADO = require('./backfill-estado');
const SIT = require('./situacoes-cancelamento');

const EXIGIDOS = ['blingGet', 'readJson', 'CACHE_DIR', 'supaReq', 'supaCount', 'DEFAULT_ALIQ_BK', 'ehFlex', 'garantirTokenML', 'LOJA_MKT'];

const motor = require('./backfill-motor').criar({
  /* o que o ctx TEM que trazer — aqui fica null de propósito (sem padrão de empresa nenhuma) */
  CACHE_DIR: null, DEFAULT_ALIQ_BK: null, LOJA_MKT: null, blingGet: null, readJson: null, supaReq: null, supaCount: null,
  custoVigenteEm: null, escrowDoPedido: null, escrowEmLote: null, garantirTokenML: null, magaluFreteSkuLer: null, _mapasBilling: null,
  ehFlex: () => { throw new Error('lib/checkout/backfill-rodar: a empresa tem que trazer `ehFlex` no contexto'); },
  _cacaMgGir: { magaluLinhas: null }, _mlBilling: { aplicarCreditosFlexNaFila: null },
  /* travas da empresa padrão: não há empresa padrão — quem chama traz `canarioRodando`/`reparoAtivo` no ctx */
  _canario: { rodando: false, desde: null }, _reparoAtivo: false,
  /* regra geral — as peças */
  SHOPEE_TODOS: String(process.env.SHOPEE_ESCROW_TODOS || '') === '1',
  _estadoBackfill: ESTADO.estado, _reiniciarEstadoBackfill: ESTADO.reiniciar,
  garantirSitCancel: SIT.garantirSitCancel,
  _inferCanal: require('./inferir-canal').inferirCanal,
  _feeMLLeve: require('./ml-fee-leve').feeMLLeve,
  contasDoEscrow: require('../shopee-escrow').contasDoEscrow,
  servicoDoPedido: require('./comum').servicoDoPedido,
});

function conferirContexto(empresa, ctx) {
  if (!empresa || String(empresa) === 'girassol') throw new Error('lib/checkout/backfill-rodar: a Girassol roda pelo gbo-app (os padrões dela); aqui só empresa que traz o contexto');
  const falta = EXIGIDOS.filter((k) => !ctx || ctx[k] == null);
  if (falta.length) throw new Error('lib/checkout/backfill-rodar (' + empresa + '): o contexto não trouxe ' + falta.join(', ') + ' — sem isso o backfill não roda (não cai na Girassol)');
}

async function backfillVendas(de, ate, empresa, ctx) {
  conferirContexto(empresa, ctx);
  return motor(de, ate, empresa, ctx);
}

module.exports = { backfillVendas, conferirContexto, EXIGIDOS };
