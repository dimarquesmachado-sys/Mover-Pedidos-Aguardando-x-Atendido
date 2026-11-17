'use strict';
/* 16/11 — NORTE C, `montarCheckout(empresa)`, passo 9: O BACKFILL DA EMPRESA (o CONTEXTO dela) É UMA PEÇA.

   O motor do histórico de vendas é um só (lib/checkout/backfill-motor), rodado por lib/checkout/backfill-rodar SEM empresa
   padrão: quem chama traz o contexto completo, e o que faltar é recusado com nome. A AMB e a GOOD montavam esse contexto à
   mão (`_ctxBackfillAmb`, `_ctxBackfillGood`: ~20 campos cada, quase os mesmos), e a AMB guardava o andamento num objeto
   próprio que só entrava no registro por empresa (lib/checkout/backfill-estado) na 1ª rodada.

   Agora `criar({ empresa, aliqReserva?, pecas })` monta o contexto com o que é da empresa e devolve
     · `ctx()`             — o contexto, montado a cada rodada (as peças lidas na hora);
     · `backfillVendas(de, ate)` — o motor único com esse contexto;
     · `estado`            — o andamento DESTA empresa no registro (o mesmo objeto que o motor e as rotas leem);
     · `resgatarHistorico(plano)` — o resgate do histórico da empresa (passo 11, mais abaixo).
   O que é igual pra todas sai daqui: o Supabase da empresa (lib/supabase), o token do ML do contrato (config-empresa), as
   situações de cancelamento da empresa (lib/checkout/situacoes-cancelamento) e o andamento (backfill-estado). O que é do
   arquivo da empresa chega por `pecas`, ACESSORES lidos na hora:
     blingGet, readJson, CACHE_DIR, DEFAULT_ALIQ_BK, ehFlex, LOJA_MKT, escrowEmLote, escrowDoPedido, magaluFreteSkuLer,
     custoEmpresa (custo vigente), mlBilling (mapas e créditos do Flex), cacaMagalu (linhas e "rodando"), canario (estado) e
     reparoAtivo (a trava do sku-repara, função).
   `aliqReserva` (opcional) é a alíquota de reserva DA EMPRESA quando o mês não tem a dela (a AMB declara 14,1; sem ela, o
   motor usa 15). */
const PECAS = ['blingGet', 'readJson', 'CACHE_DIR', 'DEFAULT_ALIQ_BK', 'ehFlex', 'LOJA_MKT', 'escrowEmLote', 'escrowDoPedido', 'magaluFreteSkuLer', 'custoEmpresa', 'mlBilling', 'cacaMagalu', 'canario', 'reparoAtivo'];

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/backfill-empresa: falta empresa');
  const P = o.pecas;
  if (!P || typeof P !== 'object') throw new Error('lib/checkout/backfill-empresa: falta pecas');
  for (const n of PECAS) if (!(n in P)) throw new Error('lib/checkout/backfill-empresa: falta ' + n);
  if (o.aliqReserva != null && !(Number(o.aliqReserva) > 0)) throw new Error('lib/checkout/backfill-empresa: aliqReserva inválida');
  const empresa = String(o.empresa);
  const cfg = require('./config-empresa').configCheckout(empresa);   /* empresa fora do contrato derruba no boot */
  const path = require('path');
  const RAIZ = path.join(__dirname, '..', '..');
  const estado = require('./backfill-estado').estado(empresa);

  function ctx() {
    const supa = require('../supabase').para(empresa);
    const c = {
      estadoBackfill: estado,
      garantirSitCancel: (bg) => require('./situacoes-cancelamento').garantirSitCancel(bg, empresa),
      ehFlex: P.ehFlex,
      blingGet: P.blingGet, readJson: P.readJson, CACHE_DIR: P.CACHE_DIR,
      supaReq: (empresa2, metodo, pq, body) => supa.req(empresa2, metodo, pq, body),
      supaCount: (empresa2, filtro) => supa.count(empresa2, filtro),
      DEFAULT_ALIQ_BK: P.DEFAULT_ALIQ_BK,
      custoVigenteEm: (sku, data) => P.custoEmpresa.custoVigenteEm(sku, data),
      mapasBilling: () => P.mlBilling.mapasBilling(),
      creditosFlex: (de, ate) => P.mlBilling.aplicarCreditosFlexNaFila(de, ate),
      garantirTokenML: () => require(path.join(RAIZ, cfg.mlTokenManager)).garantirTokenML(),
      escrowEmLote: (...a) => P.escrowEmLote(...a), escrowDoPedido: (...a) => P.escrowDoPedido(...a),
      LOJA_MKT: P.LOJA_MKT,
      magaluFreteSkuLer: (...a) => P.magaluFreteSkuLer(...a),
      magaluLinhas: (d1, d2, e2, j2) => P.cacaMagalu.magaluLinhas(d1, d2, e2, j2),
      cacaMagaluRodando: () => !!(P.cacaMagalu.estado() && P.cacaMagalu.estado().rodando),
      canarioRodando: () => !!(P.canario && P.canario.rodando),
      reparoAtivo: () => !!P.reparoAtivo(),
    };
    if (o.aliqReserva != null) c.aliqReserva = Number(o.aliqReserva);
    return c;
  }
  const backfillVendas = (de, ate) => require('./backfill-rodar').backfillVendas(de, ate, empresa, ctx());

  /* 16/11 (montarCheckout, passo 11): O RESGATE DO HISTÓRICO da empresa (lib/checkout/backfill-resgate — o pedido que nasce
     hoje com data de venda antiga: boleto/Pix tardio). A Girassol e a AMB montavam o contexto dele na noturna, à mão (as
     duas iguais, menos a caça), e a GOOD na rotina diária, com a vaga do registro mas SEM esperar o canário, o reparo de SKU
     nem a caça da Magalu. Agora um só, das peças da empresa:
       · a vaga é a do registro por empresa (backfill-estado) — e só abre com o canário, o reparo de SKU e a caça DA EMPRESA
         parados (o que a Girassol e a AMB já faziam; a GOOD passa a fazer);
       · as duas fontes de cancelado do backfill: as situações de cancelamento da empresa (com o getter do Bling) e o
         tombstone da Shopee no cache dela;
       · cada dia faltante roda pelo backfill da empresa (o motor único com o contexto dela). */
  const ESTADO = require('./backfill-estado');
  function resgatarHistorico(plano) {
    const c = ctx();
    return require('./backfill-resgate').resgatar({
      empresa, blingGet: c.blingGet, supaReq: c.supaReq, backfillVendas,
      backfillEstado: () => ESTADO.foto(empresa),
      situacoesCanceladas: async () => ((await c.garantirSitCancel(async (p2) => await c.blingGet(p2))) || {}).ids || [],
      canceladosMkt: () => new Set(Object.keys(c.readJson(path.join(c.CACHE_DIR, '_cancelados_shopee.json'), {}) || {})),
      reservar: (msg) => { if (c.canarioRodando() || c.reparoAtivo() || c.cacaMagaluRodando()) return false; return ESTADO.reservarVaga(msg, empresa); },
      liberar: () => ESTADO.liberarVaga(empresa),
      cacheDir: c.CACHE_DIR,
    }, plano);
  }
  return { ctx, backfillVendas, estado, resgatarHistorico };
}

module.exports = { criar, PECAS };
