'use strict';
/* 16/11 — NORTE C, `montarCheckout(empresa)`, passo 9: O BACKFILL DA EMPRESA (o CONTEXTO dela) É UMA PEÇA.

   O motor do histórico de vendas é um só (lib/checkout/backfill-motor), rodado por lib/checkout/backfill-rodar SEM empresa
   padrão: quem chama traz o contexto completo, e o que faltar é recusado com nome. A AMB e a GOOD montavam esse contexto à
   mão (`_ctxBackfillAmb`, `_ctxBackfillGood`: ~20 campos cada, quase os mesmos), e a AMB guardava o andamento num objeto
   próprio que só entrava no registro por empresa (lib/checkout/backfill-estado) na 1ª rodada.

   Agora `criar({ empresa, aliqReserva?, pecas })` monta o contexto com o que é da empresa e devolve
     · `ctx()`             — o contexto, montado a cada rodada (as peças lidas na hora);
     · `backfillVendas(de, ate)` — o motor único com esse contexto;
     · `estado`            — o andamento DESTA empresa no registro (o mesmo objeto que o motor e as rotas leem).
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
  return { ctx, backfillVendas, estado };
}

module.exports = { criar, PECAS };
