'use strict';

/**
 * lib/magalu-cancelados.js — cancelamentos e devoluções do Magalu (30/08).
 *
 * DESCOBERTO POR SONDA, com o pedido real 1535770109894199 (Girassol):
 * a API FINANCEIRA do Magalu (/seller/v1/financial-analysis/orders) NÃO mostra o estorno —
 * ela agrupa transações pela janela da COMPRA (limite de 15 dias por chamada), e o
 * cancelamento de 30/05 de uma venda de 11/05 simplesmente não aparece. O pedido continua
 * somando R$ 37,81 de "lucro" que não existe.
 *
 * Quem conta a verdade é a API de PEDIDOS: status 'cancelled' no pedido e na entrega, e
 * `deliveries[].returns[]` com external_id e a DATA do estorno (2026-05-30, batendo com o
 * portal). Então o desenho aqui é diferente do TikTok: lá a fonte era o extrato, aqui é o
 * pedido.
 *
 * Multi-empresa por parâmetro, como as outras libs.
 */

const CANCELADO = /cancel/i;

const cent = (v) => {
  /* o Magalu manda valores em centavos com o divisor no próprio objeto */
  if (!v || typeof v !== 'object') return 0;
  const n = Number(v.normalizer) || 100;
  return Math.round((Number(v.total) || 0) / n * 100) / 100;
};

/** Resume um pedido do Magalu do ponto de vista de cancelamento/devolução. */
function resumirPedido(p) {
  if (!p || typeof p !== 'object') return null;
  const entregas = Array.isArray(p.deliveries) ? p.deliveries : [];
  const devolucoes = [];
  let algumaEntregaCancelada = false;
  for (const d of entregas) {
    if (CANCELADO.test(String(d && d.status || ''))) algumaEntregaCancelada = true;
    const rs = Array.isArray(d && d.returns) ? d.returns : [];
    for (const r of rs) {
      devolucoes.push({
        external_id: r && r.external_id ? String(r.external_id) : null,
        /* a data do return é quando o estorno foi autorizado — é ela que manda no período */
        em: r && r.date ? String(r.date) : null,
      });
    }
  }
  const cancelado = CANCELADO.test(String(p.status || '')) || algumaEntregaCancelada;
  if (!cancelado && !devolucoes.length) return null;   // pedido normal: não interessa aqui

  return {
    code: String(p.code || p.id || ''),
    status: String(p.status || ''),
    cancelado,
    tem_devolucao: devolucoes.length > 0,
    devolucoes,
    /* a data que vale pro período é a do estorno; sem ela, a atualização do pedido */
    data_evento: devolucoes.map(d => d.em).filter(Boolean).sort().pop() || p.updated_at || null,
    comprado_em: p.purchased_at || p.created_at || null,
    valor_pedido: cent(p.amounts),
    comissao: cent(p.amounts && p.amounts.commission),
    frete: cent(p.amounts && p.amounts.freight),
  };
}

/** Percorre uma lista de pedidos crus e devolve só os que têm cancelamento ou devolução. */
function resumirLista(pedidos) {
  const out = [];
  for (const p of (Array.isArray(pedidos) ? pedidos : [])) {
    const r = resumirPedido(p);
    if (r) out.push(r);
  }
  out.sort((a, b) => String(b.data_evento || '').localeCompare(String(a.data_evento || '')));
  return out;
}

/** Total do período, pela DATA DO EVENTO (estorno), não pela data da compra. */
function totalNoPeriodo(resumidos, deISO, ateISO) {
  const de = deISO || '0000', ate = ateISO || '9999';
  const dentro = (resumidos || []).filter(r => {
    const d = String(r.data_evento || '').slice(0, 10);
    return d && d >= de && d <= ate;
  });
  const cancelados = dentro.filter(r => r.cancelado);
  return {
    pedidos_no_periodo: dentro.length,
    cancelados: cancelados.length,
    com_devolucao: dentro.filter(r => r.tem_devolucao).length,
    /* valor das vendas canceladas: é o que o dashboard está contando como lucro e não é */
    valor_cancelado: Math.round(cancelados.reduce((s, r) => s + (r.valor_pedido || 0), 0) * 100) / 100,
    comissao_envolvida: Math.round(cancelados.reduce((s, r) => s + (r.comissao || 0), 0) * 100) / 100,
    linhas: dentro.slice(0, 200),
  };
}

module.exports = { resumirPedido, resumirLista, totalNoPeriodo };
