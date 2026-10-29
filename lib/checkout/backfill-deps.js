'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   DEPENDÊNCIAS FINANCEIRAS DO BACKFILL, POR EMPRESA (14/10/2026).

   Parecer do Codex de 13/10, item 6.1 (P1). O backfill da GOOD roda pela função da Girassol
   (girassol-backup-offline/gbo-app.js → backfillVendas), com um contexto que isolava Bling,
   cache, Supabase e alíquotas — mas NÃO o resto. A função seguia usando, do módulo da
   Girassol: a linha do tempo de custo, o mapa do faturamento do ML, o token do ML, o escrow
   da Shopee, o mapa loja→canal, o banco de frete do Magalu e o contador do Supabase.
   Medido pelo Codex: uma linha gravada como empresa='good' saía com o custo, a comissão e o
   frete da GIRASSOL. O carimbo da empresa estava certo; o dinheiro dentro, não.

   A regra daqui: cada dependência vem do CONTEXTO de quem chamou. Só a dona do módulo
   (a Girassol) cai nas próprias, quando não passa contexto. Qualquer outra empresa que não
   trouxer uma dependência fica SEM ela (null) — e o backfill usa o que o Bling daquela empresa
   trouxe. Número ausente é melhor que número da empresa errada.
   ──────────────────────────────────────────────────────────────────────────── */

const NOMES = ['custoVigenteEm', 'mapasBilling', 'garantirTokenML', 'escrowEmLote', 'escrowDoPedido',
  'LOJA_MKT', 'magaluFreteSkuLer', 'supaCount',
  /* 19/10 (Codex #720): redistribui os créditos do Flex no período depois da troca — a troca grava as linhas SEM
     credito_ml; sem isto, reconstruir um período velho apagava os créditos já distribuídos (a AMB já fazia) */
  'creditosFlex',
  /* 29/10: a caça de vendas da Magalu (lib/checkout/magalu-caca) — o backfill apaga e reconstrói o período; sem ela,
     apagaria o que a caça recuperou (as vendas que o Bling não tem). Cada empresa traz a DELA. */
  'magaluLinhas'];

function resolverDepsBackfill(empresa, ctx, locais, dono) {
  const daqui = String(empresa || '') === String(dono || 'girassol');
  const out = { daqui };
  for (const n of NOMES) {
    const doCtx = ctx && Object.prototype.hasOwnProperty.call(ctx, n) ? ctx[n] : undefined;
    if (doCtx !== undefined) out[n] = doCtx;                       /* contexto manda, inclusive null explícito */
    else out[n] = (daqui && locais && locais[n] !== undefined) ? locais[n] : null;
  }
  return out;
}

module.exports = { resolverDepsBackfill, NOMES };
