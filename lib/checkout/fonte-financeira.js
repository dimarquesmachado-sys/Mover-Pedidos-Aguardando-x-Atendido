'use strict';
/* 16/11 — DE ONDE VEIO A COMISSÃO E O FRETE DE CADA LINHA DO HISTÓRICO (docs/NORTE-2026-11.md, P1-4).

   O bug (auditoria do Codex, P1 nº 4): quando o financeiro da Magalu falhava, a caça gravava comissão e frete ZERO e a
   margem saía "completa" — inflada, com a mesma cara de uma margem fechada. O mesmo acontecia em silêncio nos outros
   caminhos (Bling sem taxa, ML sem fatura e sem envio): o número zero não dizia se era "a plataforma não cobrou" ou
   "ninguém sabe". Regra do dono: "número errado é pior que ausente".

   Agora cada linha gravada em `vendas_historico` leva `comissao_fonte` e `frete_fonte`, com TRÊS valores só:
     · 'real'     — veio da plataforma (fatura do ML, escrow da Shopee, financeiro da Magalu, taxa do Bling, TikTok) ou é
                    um zero CONFIRMADO (o ML disse que o vendedor não paga o envio; a fatura fechou sem frete);
     · 'estimado' — a gente completou com uma regra (taxa % da Magalu, frete previsto pelo banco de SKU, taxa/motoboy Olist);
     · 'ausente'  — não veio e não dá pra estimar: a parcela vai NULA e a margem desta linha fica FORA do total (que fica
                    PARCIAL — não inflada). Linha gravada antes de a coluna existir também conta como ausente, mas com valor.
   Os produtores (lib/checkout/backfill-motor nos caminhos do Bling e do ML, lib/checkout/magalu-caca) já rastreavam a
   fonte com nomes próprios (`comFonte`/`freFonte`) só pras estatísticas da rodada; este mapa traduz esses nomes pros
   três valores. Nome que o mapa não conhece vira 'ausente' — conservador: uma fonte real sem tradução aparece como
   buraco (e `scripts/teste-fonte-financeira.js` confere que todo nome em uso está traduzido), nunca como completa.

   Quem lê (lib/checkout/historico: agregado, lista, busca) soma por fonte e marca o pedido com a PIOR fonte das linhas
   dele (`ausente` > `estimado` > `real`): margem só é "completa" quando tudo é real. */

const REAL = 'real', ESTIMADO = 'estimado', AUSENTE = 'ausente';
const VALORES = [REAL, ESTIMADO, AUSENTE];

/* os nomes internos de cada produtor → o valor gravado */
const COMISSAO = {
  /* backfill-motor, caminho do Bling */
  bling: REAL, billing: REAL, sale_fee: REAL, tiktok: REAL, escrow: REAL, olist: ESTIMADO, zero: AUSENTE, sem_marketplace: REAL,
  /* backfill-motor, venda direta do ML (lib/checkout/venda-direta-ml.comissaoDaVenda) */
  fatura: REAL, venda: REAL, nao_sei: AUSENTE,
  /* magalu-caca */
  magalu_financeiro: REAL, magalu_taxa: ESTIMADO,
};
const FRETE = {
  /* backfill-motor, caminho do Bling */
  bling: REAL, billing: REAL, escrow: REAL, tiktok: REAL, previsto: ESTIMADO, olist: ESTIMADO, zero: AUSENTE, sem_marketplace: REAL,
  /* backfill-motor, venda direta do ML (lib/checkout/venda-direta-ml.fretesDoEnvio) — os zeros aqui são CONFIRMADOS */
  fatura: REAL, fatura_no_carrinho: REAL, fatura_sem_frete: REAL, envio: REAL, envio_sem_custo: REAL, envio_no_bling: REAL, sem_envio: REAL, nao_sei: AUSENTE,
  /* magalu-caca */
  magalu_financeiro: REAL, magalu_previsto: ESTIMADO,
};

function fonteComissao(nome) { return COMISSAO[String(nome || '')] || AUSENTE; }
function fonteFrete(nome) { return FRETE[String(nome || '')] || AUSENTE; }

/* a pior de duas (ausente > estimado > real); fonte desconhecida/nula conta como ausente */
function pior(a, b) {
  const r = (x) => (x === REAL ? 0 : x === ESTIMADO ? 1 : 2);
  return VALORES[Math.max(r(a), r(b))];
}

/* o financeiro de um conjunto de linhas (um pedido, um período): a pior fonte entre comissão e frete de todas */
function doConjunto(linhas) {
  let f = REAL;
  for (const l of linhas || []) f = pior(f, pior(l.comissao_fonte, l.frete_fonte));
  return f;
}

/* contador por fonte, pra agregados:
   { linhas, por_linha: { real, estimado, ausente } (a PIOR das duas fontes de cada linha), comissao: {…}, frete: {…}, completo }
   `completo` = toda linha é real nas duas — só então a margem do conjunto pode se chamar fechada. */
function contador() {
  const c = { linhas: 0, por_linha: { real: 0, estimado: 0, ausente: 0 }, comissao: { real: 0, estimado: 0, ausente: 0 }, frete: { real: 0, estimado: 0, ausente: 0 } };
  const v = (x) => (VALORES.includes(x) ? x : AUSENTE);
  return {
    somar(l) { c.linhas++; c.comissao[v(l.comissao_fonte)]++; c.frete[v(l.frete_fonte)]++; c.por_linha[pior(v(l.comissao_fonte), v(l.frete_fonte))]++; },
    resultado() { return Object.assign({}, c, { completo: c.linhas > 0 && c.por_linha.real === c.linhas }); },
  };
}

module.exports = { REAL, ESTIMADO, AUSENTE, VALORES, fonteComissao, fonteFrete, pior, doConjunto, contador, _mapas: { COMISSAO, FRETE } };
