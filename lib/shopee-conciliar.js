'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  CONCILIAÇÃO CARTEIRA × ESCROW — código ÚNICO (14/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Responde, com dado, duas perguntas que vinham sendo respondidas no chute:
//   1) "a Shopee me pagou o que devia?" — pedido a pedido, no período;
//   2) "a recarga de ads por comissão é retida ANTES do repasse?" — se a carteira
//      creditar MENOS que o escrow, algo é retido antes e o custo já está embutido
//      na margem por pedido; se bater, é custo à parte.
//  Medido na AMB em 01→13/08: 133 pedidos, R$ 8.487,86 nos dois lados, diferença ZERO.
//
//  ctx = { readJson, ARQ_CAR, escrowEmLote, loja? }
const _num = v => { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };

async function conciliar(ctx, de, ate, max) {
  const maxP = Math.min(300, Math.max(10, Number(max) || 150));
  // Codex (P2): os dashboards recortam o dia em America/Sao_Paulo (UTC−3). Usar limites em UTC
  // jogava crédito da madrugada (00:00–02:59Z) para o dia seguinte e conciliava outro conjunto
  // de pedidos do que o operador escolheu na tela.
  const ini = Date.parse(de + 'T00:00:00-03:00') / 1000, fim = Date.parse(ate + 'T23:59:59-03:00') / 1000;
  const arq = ctx.readJson(ctx.ARQ_CAR(), { transacoes: {} });
  const car = arq.transacoes || {};
  if (!Object.keys(car).length) return { ok: false, erro: 'carteira vazia — rode /shopee/coletar-carteira antes' };
  // Codex (P1): a coleta da carteira pega no máximo 180 dias (30 por padrão) e não guarda o
  // intervalo coberto. Pedir um período mais antigo que a coleta devolveria "bate" olhando só
  // a parte que existe. Deduz a cobertura pela transação mais antiga guardada.
  let maisAntiga = null;
  for (const x of Object.values(car)) { const q0 = Number(x.quando || 0); if (q0 && (maisAntiga === null || q0 < maisAntiga)) maisAntiga = q0; }
  const forais = [];
  if (maisAntiga !== null && ini < maisAntiga - 86400) {
    forais.push('a carteira coletada começa em ' + new Date(maisAntiga * 1000).toISOString().slice(0, 10) + ', depois do início pedido (' + de + ') — rode /shopee/coletar-carteira com mais dias');
  }
  // Codex (P1, 3ª rodada): faltava conferir a ponta de CIMA. Se a coleta foi ao meio-dia e o
  // período vai até hoje, os créditos da tarde não estão no cache — e o resultado sairia
  // "batem" sem ter visto metade do dia.
  // Codex (P1): `atualizado` é gravado MESMO quando a coleta falhou — então ele não prova
  // cobertura. Só vale como limite superior se a última coleta foi bem-sucedida (o coletor
  // agora grava `ok_em`); sem essa marca, o resultado é parcial por precaução.
  const coletadoEm = arq.ok_em ? Math.floor(Date.parse(arq.ok_em) / 1000)
                   : (arq.atualizado ? Math.floor(Date.parse(arq.atualizado) / 1000) : null);
  if (!arq.ok_em && arq.atualizado) {
    forais.push('a última coleta da carteira não registrou sucesso — pode ter falhado e mantido dados velhos; rode /shopee/coletar-carteira e confira');
  }
  if (coletadoEm && fim > coletadoEm) {
    forais.push('a carteira foi coletada em ' + new Date(coletadoEm * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z e o período vai até ' + ate + ' — o que entrou depois disso não está no cache; rode /shopee/coletar-carteira de novo');
  }

  const creditoPorPedido = {};
  let creditoTotal = 0, semOrderSn = 0;
  for (const x of Object.values(car)) {
    const quando = Number(x.quando || 0);
    if (!(quando >= ini && quando <= fim)) continue;
    if (!/^(ESCROW_VERIFIED_ADD|ORDER_INCOME)/i.test(String(x.tipo || ''))) continue;
    const v = _num(x.valor);
    creditoTotal = Math.round((creditoTotal + v) * 100) / 100;
    const sn = String(x.order_sn || '').trim();
    if (!sn) { semOrderSn++; continue; }
    creditoPorPedido[sn] = Math.round(((creditoPorPedido[sn] || 0) + v) * 100) / 100;
  }
  const todos = Object.keys(creditoPorPedido);
  const sns = todos.slice(0, maxP);
  // Codex: cortar no teto e mesmo assim dar veredito de período inteiro esconde divergência
  // nos pedidos que ficaram de fora. Truncou → o resultado é PARCIAL e diz isso.
  let truncado = todos.length > sns.length;
  if (!sns.length) return { ok: false, erro: 'nenhum crédito de pedido na carteira nesse período' };

  const escrowPorPedido = {}; let falhas = 0;
  for (let i0 = 0; i0 < sns.length; i0 += 50) {
    const lote = sns.slice(i0, i0 + 50);
    let mapa = null;
    try { mapa = await ctx.escrowEmLote(lote, ctx.loja); } catch (e) { mapa = null; }
    if (!mapa) { falhas += lote.length; continue; }
    for (const sn of lote) {
      const e = mapa[sn];
      if (!e) { falhas++; continue; }
      escrowPorPedido[sn] = _num(e.escrow);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  const linhas = [];
  let somaCredito = 0, somaEscrow = 0, comparados = 0;
  for (const sn of sns) {
    if (escrowPorPedido[sn] === undefined) continue;
    comparados++;
    const cr = creditoPorPedido[sn], es = escrowPorPedido[sn];
    somaCredito = Math.round((somaCredito + cr) * 100) / 100;
    somaEscrow = Math.round((somaEscrow + es) * 100) / 100;
    const dif = Math.round((cr - es) * 100) / 100;
    if (Math.abs(dif) >= 0.01) linhas.push({ order_sn: sn, creditado: cr, escrow: es, diferenca: dif });
  }
  linhas.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));
  const difTotal = Math.round((somaCredito - somaEscrow) * 100) / 100;
  // Codex (P1): nenhum pedido comparado → as duas somas ficam ZERO e o texto diria "batem".
  // Conclusão falsa a partir de comparação nenhuma é pior que erro nenhum.
  if (!comparados) {
    return { ok: false, de, ate, pedidos_comparados: 0, sem_escrow: falhas,
      erro: 'nenhum pedido pôde ser comparado (o serviço de escrow não respondeu para nenhum) — inconclusivo, tente de novo' };
  }
  // Codex (P1): um pedido pago a menos e outro a mais se anulam no total. O veredito passa a
  // olhar TAMBÉM se algum pedido divergiu — que é o que esta rota promete conferir.
  const temDivergentePorPedido = linhas.length > 0;
  // Codex (P1/P2, 2ª rodada): QUALQUER buraco de cobertura tira o direito de dar veredito
  // definitivo — escrow que faltou em parte dos pedidos, crédito de pedido sem order_sn
  // (não dá pra conferir), ou corte no teto. Nesses casos o resultado é PARCIAL e o texto
  // diz o motivo, em vez de afirmar "batem pedido a pedido" sobre um subconjunto.
  const buracos = forais.slice();
  if (truncado) buracos.push('só ' + sns.length + ' de ' + todos.length + ' pedidos do período foram conferidos (limite &max=)');
  if (falhas) buracos.push(falhas + ' pedido(s) sem resposta do escrow');
  if (semOrderSn) buracos.push(semOrderSn + ' crédito(s) da carteira sem número de pedido — impossível conferir');
  if (buracos.length) truncado = true;
  return {
    ok: true, de, ate, parcial: truncado, buracos,
    pedidos_no_periodo: todos.length, pedidos_divergentes: linhas.length,
    pedidos_comparados: comparados,
    creditado_no_periodo: creditoTotal, creditos_sem_order_sn: semOrderSn,
    soma_creditado: somaCredito, soma_escrow: somaEscrow, diferenca_total: difTotal,
    leitura: (difTotal < -0.01
      ? 'a carteira creditou MENOS que o escrow: algo é retido antes do repasse (candidato: recarga de ads por comissão) — nesse caso o custo JÁ está embutido e não deve ser somado de novo'
      : (difTotal > 0.01 ? 'a carteira creditou MAIS que o escrow — investigar (ajuste/estorno a favor)'
                         : (temDivergentePorPedido
                            ? 'o TOTAL bate, mas há pedidos divergentes que se anulam (uns pagos a menos, outros a mais) — ver `divergentes` antes de concluir qualquer coisa'
                            : 'carteira e escrow batem pedido a pedido: nada é retido antes do repasse, então recarga por comissão (se houver) é custo A PARTE')))
      + (buracos.length ? ' ⚠️ RESULTADO PARCIAL (' + buracos.join(' · ') + ') — não vale como conciliação do período inteiro' : ''),
    divergentes: linhas.slice(0, 30), sem_escrow: falhas,
    carteira_atualizada_em: arq.atualizado || null
  };
}

module.exports = { conciliar };
