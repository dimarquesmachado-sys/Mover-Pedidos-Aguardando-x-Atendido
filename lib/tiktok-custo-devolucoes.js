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
  let freteLoja = 0, canceladas = 0, foraDoPeriodo = 0;
  for (const d of Object.values(devs)) {
    if (!d || !d.order_id) continue;
    /* a data que importa é a do EVENTO financeiro; sem ela, a criação da devolução */
    const t = Number((d.eventos && (d.eventos.revelia_em || d.eventos.reembolsado_em)) || d.criado_em) || 0;
    if (!(t >= ini && t <= fim)) { foraDoPeriodo++; continue; }
    if (CANCELADA.test(String(d.status || ''))) { canceladas++; continue; }
    /* frete é POR SOLICITAÇÃO: duas caixas = dois fretes, e ambos saíram do bolso */
    freteLoja = r2(freteLoja + (Number(d.frete_devolucao_vendedor) || 0));
    const oid = String(d.order_id);
    if (!porPedido[oid]) porPedido[oid] = true;
  }

  let debito = 0, credito = 0, pendentes = 0;
  const detalhe = [];
  for (const oid of Object.keys(porPedido)) {
    const reg = fin[oid];
    const desf = reg ? desfechoDoPedido(reg) : null;
    if (!desf) { pendentes++; detalhe.push({ order_id: oid, situacao: 'sem_lancamento', impacto: null }); continue; }
    const imp = Number(desf.impacto || 0);
    if (imp < 0) debito = r2(debito + imp);
    if (imp > 0) credito = r2(credito + imp);
    if (imp !== 0) detalhe.push({ order_id: oid, situacao: desf.desfecho, impacto: imp });
  }
  detalhe.sort((a, b) => (a.impacto == null ? 1 : b.impacto == null ? -1 : a.impacto - b.impacto));

  const custoTotal = r2(Math.abs(debito) + freteLoja - credito);
  return {
    periodo: { de: ini, ate: fim },
    pedidos_afetados: Object.keys(porPedido).length,
    solicitacoes_canceladas_ignoradas: canceladas,
    fora_do_periodo: foraDoPeriodo,
    debito_extrato: debito,            // negativo
    frete_devolucao_loja: freteLoja,   // positivo (custo)
    compensacao_recebida: credito,     // positivo (crédito)
    custo_total: custoTotal,           // o número que vai pro dashboard
    pedidos_sem_lancamento: pendentes, // ainda vai cair: nem zero, nem custo
    detalhe: detalhe.slice(0, 100),
  };
}

module.exports = { custoNoPeriodo };
