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

  /* 30/08 — CLASSIFICAÇÃO (o dono separou os casos, e são bem diferentes):
       1. cancelado SEM pagamento aprovado e SEM NF → cliente desistiu / pagamento não passou.
          Nunca entrou no faturamento. NÃO é prejuízo e não pode ser descontado — era isso que
          inflava o número da AMB (73 pedidos, muitos de R$ 5,90).
       2. PAGO e cancelado antes de postar → entrou no histórico se virou NF; precisa sair.
       3. PAGO, POSTADO e estornado/devolvido → o pior: sai do faturamento E pode ter custado
          produto e frete. É o caso do 1535770109894199 da Girassol.
     O que separa: nota fiscal emitida e pagamento aprovado (o pedido traz os dois). */
  const notas = [];
  for (const d of entregas) for (const nf of (Array.isArray(d && d.invoices) ? d.invoices : [])) {
    if (nf && (nf.key || nf.issued_at)) notas.push({ chave: nf.key || null, em: nf.issued_at || null, status: (nf.status && nf.status.id) || null });
  }
  const pagamentos = Array.isArray(p.payments) ? p.payments : [];
  const pagoAprovado = !!p.approved_at || pagamentos.some(pg => /approv|paid|captur|authoriz/i.test(String(pg && (pg.status || pg.state) || '')));
  const temNF = notas.length > 0;

  /* 30/08 — PEDIDO DE TESTE DO MAGALU: apareceu no topo da lista da AMB com cliente
     'Treinamento Luiza Labs' e destinatário 'Pedido teste ambtotal'. É homologação da
     plataforma, não venda — não pode entrar em conta nenhuma. */
  const nomes = [p.customer && p.customer.name, ...entregas.map(d => d && d.shipping && d.shipping.recipient && d.shipping.recipient.name)];
  const ehTeste = nomes.filter(Boolean).some(n => /treinamento|luiza\s*labs|pedido\s*teste|teste\s+/i.test(String(n)));

  let classe, conta_no_faturamento;
  if (ehTeste) { classe = 'pedido_teste'; conta_no_faturamento = false; }
  else if (!pagoAprovado && !temNF) { classe = 'nao_pago'; conta_no_faturamento = false; }
  else if (devolucoes.length) { classe = 'estornado_apos_envio'; conta_no_faturamento = true; }
  else if (temNF) { classe = 'pago_cancelado_com_nf'; conta_no_faturamento = true; }
  else { classe = 'pago_cancelado_sem_nf'; conta_no_faturamento = false; }

  /* 30/08: guarda canal e seller — apareceram pedidos que o token alcança mas não são da
     empresa (R$ 5,90 e R$ 10,00 num catálogo sem nada abaixo de R$ 100). Sem esses campos
     não dava nem pra perceber. */
  /* 30/08: o seller vem como OBJETO {id, name} — eu lia como string e dava null em todos.
     Guardo o NOME, que é o que dá pra conferir contra a empresa ('ambtotal'). */
  const sellerObj = entregas.map(d => d && d.seller).filter(Boolean)[0] || null;
  const sellerEntrega = sellerObj ? (sellerObj.name || sellerObj.id || null) : null;
  return {
    classe, conta_no_faturamento, pago: pagoAprovado, tem_nf: temNF, notas,
    canal: p.channel || null, canal_origem: p.source_channel || null, seller: sellerEntrega ? String(sellerEntrega) : null,
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
  /* 30/08: só entra na conta o que CHEGOU a contar como venda. Desistência antes do
     pagamento não é prejuízo — descontá-la seria inventar perda. */
  const contam = dentro.filter(r => r.conta_no_faturamento);
  const naoPagos = dentro.filter(r => r.classe === 'nao_pago');
  const testes = dentro.filter(r => r.classe === 'pedido_teste');
  const porClasse = {};
  for (const r of dentro) porClasse[r.classe] = (porClasse[r.classe] || 0) + 1;
  const soma = (arr, campo) => Math.round(arr.reduce((s, r) => s + (r[campo] || 0), 0) * 100) / 100;
  return {
    pedidos_no_periodo: dentro.length,
    cancelados: cancelados.length,
    com_devolucao: dentro.filter(r => r.tem_devolucao).length,
    por_classe: porClasse,
    /* o número que vale pro dashboard */
    a_descontar: contam.length,
    valor_a_descontar: soma(contam, 'valor_pedido'),
    comissao_a_descontar: soma(contam, 'comissao'),
    /* ruído, mostrado à parte pra ninguém achar que sumiu dado */
    pedidos_teste_ignorados: testes.length,
    nao_pagos_ignorados: naoPagos.length,
    valor_nao_pago_ignorado: soma(naoPagos, 'valor_pedido'),
    linhas: dentro.slice(0, 200),
  };
}

module.exports = { resumirPedido, resumirLista, totalNoPeriodo };
