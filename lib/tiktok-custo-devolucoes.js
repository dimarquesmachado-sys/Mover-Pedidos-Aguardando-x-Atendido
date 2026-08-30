'use strict';

/**
 * lib/tiktok-custo-devolucoes.js — o CUSTO das devoluções do TikTok num período (29/08).
 *
 * É a peça que o dashboard consome. Junta as três partes que hoje ninguém soma:
 *   1. IMPACTO NO EXTRATO — reembolso parcial, débito de mediação, estorno. Vem do
 *      desfecho por pedido (nunca do valor da tela, que é o reembolso ao cliente e difere:
 *      no caso real, tela R$ 36,00 × extrato R$ 41,01).
 *   2. FRETE DE DEVOLUÇÃO PAGO PELA LOJA — a API sempre mandou e nós não líamos.
 *   3. COMPENSAÇÃO recebida do TikTok — entra como CRÉDITO, senão o custo fica inflado.
 *
 * Regras herdadas do que aprendemos hoje: agrupa por PEDIDO (solicitações repetidas não
 * contam duas vezes); solicitação cancelada não vira custo; pedido sem lançamento fica
 * PENDENTE e não é somado como zero.
 */

const { desfechoDoPedido } = require('./tiktok-desfecho');
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const CANCELADA = /CANCEL/i;

function custoNoPeriodo(cacheDevolucoes, cacheFinanceiro, deTs, ateTs) {
  const devs = (cacheDevolucoes && cacheDevolucoes.devolucoes) || {};
  const fin = (cacheFinanceiro && cacheFinanceiro.pedidos) || {};
  const ini = Number(deTs) || 0;
  const fim = Number(ateTs) || Math.floor(Date.now() / 1000);

  const porPedido = Object.create(null);
  let canceladas = 0, foraDoPeriodo = 0;
  for (const d of Object.values(devs)) {
    if (!d || !d.order_id) continue;
    /* a data que importa é a do EVENTO financeiro; sem ela, a criação da devolução */
    const t = Number((d.eventos && (d.eventos.revelia_em || d.eventos.reembolsado_em)) || d.criado_em) || 0;
    if (!(t >= ini && t <= fim)) { foraDoPeriodo++; continue; }
    if (CANCELADA.test(String(d.status || ''))) { canceladas++; continue; }
    const oid = String(d.order_id);
    /* frete é POR SOLICITAÇÃO (duas caixas = dois fretes), mas fica ACUMULADO POR PEDIDO
       porque a decisão de contá-lo depende do extrato daquele pedido — ver abaixo. */
    if (!porPedido[oid]) porPedido[oid] = { frete: 0 };
    porPedido[oid].frete = r2(porPedido[oid].frete + (Number(d.frete_devolucao_vendedor) || 0));
  }

  let debito = 0, credito = 0, pendentes = 0, freteLoja = 0, freteJaNoExtrato = 0;
  const detalhe = [];
  for (const oid of Object.keys(porPedido)) {
    const freteDoPedido = porPedido[oid].frete || 0;
    const reg = fin[oid];
    /* Codex #287 r2: o impacto vinha do extrato SEM olhar a data — um débito de outro mês
       entrava no total do período pedido. O registro tem `liquidado_em`; quando ele existe e
       cai fora da janela, o pedido conta como fora, não como custo deste período. */
    const liq = reg ? Number(reg.liquidado_em || 0) : 0;
    if (reg && liq && !(liq >= ini && liq <= fim)) { foraDoPeriodo++; continue; }
    const desf = reg ? desfechoDoPedido(reg) : null;
    if (!desf) {
      pendentes++;
      /* Codex #287: o LANÇAMENTO está pendente, mas o frete já é conhecido e já saiu do
         bolso — deixá-lo de fora subestima o custo do período. Entra; quando o extrato cair
         com débito, a regra acima passa a considerá-lo embutido e não haverá dobra. */
      if (freteDoPedido > 0) freteLoja = r2(freteLoja + freteDoPedido);
      detalhe.push({ order_id: oid, situacao: 'sem_lancamento', impacto: null, frete: freteDoPedido });
      continue;
    }
    const imp = Number(desf.impacto || 0);
    if (imp < 0) debito = r2(debito + imp);
    if (imp > 0) credito = r2(credito + imp);
    /* 29/08 — NÃO CONTAR O FRETE DUAS VEZES. O extrato do pedido 584628284730475569 mostrou
       o débito de R$ 276,70 composto por frete (R$ 226,70, dos quais R$ 153,70 de devolução)
       + taxa (R$ 50): ou seja, quando HÁ débito no extrato, o frete de devolução JÁ ESTÁ
       DENTRO dele. Somar o campo da API por cima dobraria o custo. O frete só entra quando
       o pedido NÃO teve débito — aí é custo que ninguém contou. */
    /* Codex #287 (P1): impacto negativo NÃO implica frete embutido. Em 'reversao_total' o
       impacto é a NEGAÇÃO do repasse da venda original — não vem da transação de estorno e
       portanto não contém o frete de devolução; ali o frete é custo à parte. Só o
       'debito_estorno'/'debito_ajuste' vem do lançamento negativo real, que é o caso do
       macaco (R$ 276,70 já com R$ 153,70 de frete dentro). */
    /* Codex #287 r2: quando o próprio registro traz o componente de frete de devolução
       (frete_devolucao), use-o pra decidir — é o dado, não a inferência pelo tipo. */
    const freteNoRegistro = Number((reg && reg.frete_devolucao) || 0);
    const debitoTemFrete = freteNoRegistro > 0
      || (desf.desfecho === 'debito_estorno' || desf.desfecho === 'debito_ajuste' || desf.desfecho === 'reembolso_parcial');
    if (freteDoPedido > 0) {
      if (imp < 0 && debitoTemFrete) freteJaNoExtrato = r2(freteJaNoExtrato + freteDoPedido);
      else freteLoja = r2(freteLoja + freteDoPedido);
    }
    if (imp !== 0 || freteDoPedido > 0) detalhe.push({ order_id: oid, situacao: desf.desfecho, impacto: imp, frete: freteDoPedido, frete_ja_no_debito: imp < 0 && freteDoPedido > 0 });
  }
  detalhe.sort((a, b) => (a.impacto == null ? 1 : b.impacto == null ? -1 : a.impacto - b.impacto));

  const custoTotal = r2(Math.abs(debito) + freteLoja - credito);
  return {
    periodo: { de: ini, ate: fim },
    pedidos_afetados: Object.keys(porPedido).length,
    solicitacoes_canceladas_ignoradas: canceladas,
    fora_do_periodo: foraDoPeriodo,
    debito_extrato: debito,                       // negativo — JÁ inclui o frete quando houve débito
    frete_devolucao_loja: freteLoja,              // positivo — só de pedidos SEM débito, pra não dobrar
    frete_ja_embutido_no_debito: freteJaNoExtrato, // informativo: quanto do débito é frete de devolução
    compensacao_recebida: credito,     // positivo (crédito)
    custo_total: custoTotal,           // o número que vai pro dashboard
    pedidos_sem_lancamento: pendentes, // ainda vai cair: nem zero, nem custo
    detalhe: detalhe.slice(0, 100),
  };
}

module.exports = { custoNoPeriodo };
