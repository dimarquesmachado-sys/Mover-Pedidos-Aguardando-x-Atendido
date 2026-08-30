'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  FINANCEIRO DO TIKTOK SHOP — código único, multi-empresa (14/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Fecha o último canal grande sem dado próprio: R$ 187 mil no ano só na Girassol,
//  com tarifa vinda do Bling e sem conferência. (No ML e na Shopee, conferir revelou
//  R$ 107 mil de tarifa invisível e o rebate que ninguém somava.)
//
//  MEDIDO NO DADO REAL (3 extratos + 4 transações, 15/08):
//   · a identidade fecha SEMPRE:  revenue + fee + shipping_cost + adjustment = settlement
//     (fee e shipping_cost já vêm NEGATIVOS quando são custo)
//   · a taxa do TikTok é  **R$ 2,00 fixo + 12% do valor**  — conferido em 3 pedidos:
//     49,90→7,98 · 37,90→6,54 · 29,90→5,58. Desses 12%, só 6% têm campo próprio
//     (`platform_commission_amount`); os outros 6% existem apenas dentro de `fee_amount`.
//     Por isso o parser usa `fee_amount` como a tarifa — não tenta reconstruir por partes.
//   · FRETE: `actual_shipping_fee` é o custo real e `platform_shipping_fee_discount` é o
//     subsídio do TikTok; o líquido já vem em `shipping_cost_amount`. Positivo = sobrou
//     dinheiro de frete pra loja (mesmo comportamento da Shopee).
//   · o extrato (`statements`) é POR PAGAMENTO; o detalhe (`statement_transactions`) é que
//     traz `order_id` — é dele que sai a margem por pedido.
//
//  ctx = { CACHE_DIR, path, readJson, writeJson, chamar(caminho, params, opts, loja) }
const _n = v => { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : 0; };
const arq = (ctx, loja) => ctx.path.join(ctx.CACHE_DIR, '_tiktok_financeiro_' + (loja || 'girassol') + '.json');

async function coletarFinanceiro(ctx, loja, dias, opts) {
  const total = Math.min(400, Math.max(1, Number(dias) || 60));
  const desde = Math.floor((Date.now() - total * 86400000) / 1000);
  const guardado = ctx.readJson(arq(ctx, loja), { pedidos: {}, extratos: {}, atualizado: null, ok_em: null });
  guardado.pedidos = guardado.pedidos || {}; guardado.extratos = guardado.extratos || {};
  // Codex (P2): o cache anterior foi gravado pela regra antiga (estorno sobrescrevia a venda).
  // Como os extratos já detalhados são PULADOS, a regra nova nunca rodaria neles sem alguém
  // lembrar do &refazer=1 — e a Girassol ficaria com dado sujo pra sempre. Versão do formato
  // resolve sozinho: mudou a versão, reprocessa os extratos uma vez.
  const FORMATO = 2;
  let migrou = 0;
  if (Number(guardado.formato || 1) < FORMATO) {
    migrou = Object.keys(guardado.extratos).length;
    guardado.extratos = {};
    guardado.formato = FORMATO;
  }
  const refazer = Boolean(opts && opts.refazer);
  let extratosVistos = 0, novos = 0, pedidosVistos = 0, sobra = 0, erro = null, paginas = 0;
  let token = '';

  for (let volta = 0; volta < 60; volta++) {
    const params = { page_size: '50', sort_field: 'statement_time', sort_order: 'DESC' };
    if (token) params.page_token = token;
    let r = null;
    try { r = await ctx.chamar('/finance/202309/statements', params, {}, loja); }
    catch (e) { erro = 'statements: ' + String(e.message || e).slice(0, 140); break; }
    if (!r || !r.ok || !r.corpo || r.corpo.code !== 0) {
      erro = 'statements: ' + ((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http)));
      break;
    }
    paginas++;
    const lista = (r.corpo.data && r.corpo.data.statements) || [];
    if (!lista.length) break;
    let passouDaJanela = false;
    for (const st of lista) {
      const quando = Number(st.statement_time) || 0;
      if (quando && quando < desde) { passouDaJanela = true; continue; }
      extratosVistos++;
      const id = String(st.id);
      if (guardado.extratos[id] && !refazer) continue;   // extrato já detalhado
      // Codex (#105): o extrato era marcado como processado ANTES de baixar as transações —
      // se alguma página falhasse, ele ficava "pronto" com pedidos faltando e nunca mais era
      // revisitado (só com &refazer=1 na mão). Agora só entra no índice no fim, se tudo deu certo.
      let falhouDetalhe = false;
      const regExtrato = { id, quando, pago_em: st.payment_time || null, status: st.payment_status || null,
        receita: _n(st.revenue_amount), tarifa: _n(st.fee_amount), frete: _n(st.shipping_cost_amount),
        ajuste: _n(st.adjustment_amount), repasse: _n(st.settlement_amount) };
      // detalhe: é aqui que aparece o order_id
      let tk = '';
      for (let p2 = 0; p2 < 20; p2++) {
        const par2 = { page_size: '50', sort_field: 'order_create_time' };
        if (tk) par2.page_token = tk;
        let r2 = null;
        try { r2 = await ctx.chamar('/finance/202309/statements/' + id + '/statement_transactions', par2, {}, loja); }
        catch (e) { erro = erro || ('transactions ' + id + ': ' + String(e.message || e).slice(0, 120)); falhouDetalhe = true; break; }
        if (!r2 || !r2.ok || !r2.corpo || r2.corpo.code !== 0) { erro = erro || ('transactions ' + id + ': ' + ((r2 && r2.corpo && r2.corpo.message) || 'falhou')); falhouDetalhe = true; break; }
        const trs = (r2.corpo.data && r2.corpo.data.statement_transactions) || [];
        for (const t of trs) {
          const sn = String(t.order_id || '').trim();
          if (!sn) continue;
          pedidosVistos++;
          const receita = _n(t.revenue_amount);
          // 18/08 — ACHADO pelo /tiktok/nao-fecharam: em ESTORNO (receita negativa) o TikTok
          // DEVOLVE a tarifa em vez de cobrar — `fee_amount` vem POSITIVO. Guardar sempre o
          // módulo e subtrair fazia a conta errar por 2× a tarifa (3 pedidos da Girassol,
          // −36,90 no total). Conferido nos três: −39,90 + 6,39 = −33,51 = o repasse.
          const feeCru = _n(t.fee_amount);
          const tarifaCredito = feeCru > 0;                     // crédito, não cobrança
          const tarifa = Math.abs(feeCru);                      // sempre positiva pro dashboard
          const freteLiq = _n(t.shipping_cost_amount);          // negativo = custo · positivo = sobrou
          const repasse = _n(t.settlement_amount);
          // a identidade usa o SINAL ORIGINAL: cobrança abate, devolução soma
          const dif = Math.round((receita + feeCru + freteLiq + _n(t.adjustment_amount) - repasse) * 100) / 100;
          if (Math.abs(dif) >= 0.01) sobra++;
          if (!guardado.pedidos[sn]) novos++;
          // Codex (P2): o mesmo `order_id` volta em transações posteriores (reembolso,
          // ajuste). Como a gravação era cega, a ÚLTIMA vencia — e o backfill passaria a usar
          // a tarifa do estorno como se fosse a da venda. Agora: a transação de VENDA (`ORDER`)
          // manda; as demais entram só como ajuste acumulado, sem apagar a venda.
          const tipoT = String(t.type || '').toUpperCase();
          const jaTem = guardado.pedidos[sn];
          // Codex (P2, 2ª rodada): se a VENDA é mais antiga que a janela, o estorno chegava
          // sozinho e virava a entrada do pedido — o backfill leria a tarifa dele como se
          // fosse a da venda. Transação que não é ORDER nunca vira entrada canônica.
          if (!jaTem && tipoT !== 'ORDER') {
            guardado.pedidos[sn] = { order_id: sn, tipo: tipoT, so_ajuste: true,
              ajustes_depois: _n(t.settlement_amount), tipos_vistos: [tipoT],
              // Codex (#126): o estorno também traz tarifa DEVOLVIDA (fee positivo). Guardar
              // só um booleano no registro canônico não bastava — o crédito tem que ser
              // ACUMULADO, senão o resumo segue cobrando a tarifa cheia da venda.
              tarifa_devolvida: Math.max(0, feeCru),
              tarifa: 0, receita: 0, frete_liquido: 0, repasse: 0, confere: 0,
              criado_em: t.order_create_time || null, liquidado_em: quando || null };
            continue;
          }
          // Codex (P2): com DOIS ajustes órfãos, o segundo passava por cima do primeiro e
          // virava entrada canônica com tarifa positiva. Registro `so_ajuste` também é protegido.
          if (jaTem && jaTem.so_ajuste && tipoT !== 'ORDER') {
            jaTem.ajustes_depois = Math.round(((jaTem.ajustes_depois || 0) + _n(t.settlement_amount)) * 100) / 100;
            jaTem.tarifa_devolvida = Math.round(((jaTem.tarifa_devolvida || 0) + Math.max(0, feeCru)) * 100) / 100;
            jaTem.reembolso_cliente = Math.round(((jaTem.reembolso_cliente || 0) + Math.abs(_n(t.customer_refund_amount))) * 100) / 100;
            jaTem.tipos_vistos = Array.from(new Set([].concat(jaTem.tipos_vistos || [], [tipoT])));
            continue;
          }
          if (jaTem && String(jaTem.tipo || '').toUpperCase() === 'ORDER' && tipoT !== 'ORDER') {
            // Codex (P2): guardar só o settlement descartava o reembolso ao cliente, o frete
            // da devolução e a taxa administrativa — e o resumo somava `reembolso_cliente` da
            // VENDA, que é zero. Agora o estorno soma nos campos certos da venda.
            jaTem.ajustes_depois = Math.round(((jaTem.ajustes_depois || 0) + _n(t.settlement_amount)) * 100) / 100;
            // Codex (#126): AQUI era o buraco — a venda já tinha registro, então o estorno caía
            // neste ramo e o crédito de tarifa nunca chegava ao pedido. O resumo seguia
            // cobrando a tarifa cheia mesmo depois de o TikTok devolver.
            jaTem.tarifa_devolvida = Math.round(((jaTem.tarifa_devolvida || 0) + Math.max(0, feeCru)) * 100) / 100;
            jaTem.reembolso_cliente = Math.round(((jaTem.reembolso_cliente || 0) + Math.abs(_n(t.customer_refund_amount))) * 100) / 100;
            jaTem.frete_devolucao = Math.round(((jaTem.frete_devolucao || 0) + Math.abs(_n(t.actual_return_shipping_fee_amount)) + Math.abs(_n(t.return_shipping_fee_amount))) * 100) / 100;
            jaTem.taxa_adm_reembolso = Math.round(((jaTem.taxa_adm_reembolso || 0) + Math.abs(_n(t.refund_administration_fee_amount))) * 100) / 100;
            jaTem.tipos_vistos = Array.from(new Set([].concat(jaTem.tipos_vistos || [], [tipoT])));
            continue;
          }
          guardado.pedidos[sn] = {
            order_id: sn, extrato_id: id, tipo: t.type || null,
            criado_em: t.order_create_time || null, liquidado_em: quando || null,
            receita, tarifa, tarifa_credito: tarifaCredito,
            frete_liquido: freteLiq, ajuste: _n(t.adjustment_amount), repasse,
            comissao_plataforma: Math.abs(_n(t.platform_commission_amount)),
            afiliado: Math.abs(_n(t.affiliate_commission_amount)) + Math.abs(_n(t.affiliate_partner_commission_amount)) + Math.abs(_n(t.affiliate_ads_commission_amount)),
            frete_real: Math.abs(_n(t.actual_shipping_fee_amount)),
            subsidio_frete: _n(t.platform_shipping_fee_discount_amount) + _n(t.shipping_cost_discount_amount),
            frete_pago_comprador: _n(t.customer_paid_shipping_fee_amount),
            reembolso_cliente: Math.abs(_n(t.customer_refund_amount)),
            frete_devolucao: Math.abs(_n(t.actual_return_shipping_fee_amount)) + Math.abs(_n(t.return_shipping_fee_amount)),
            taxa_adm_reembolso: Math.abs(_n(t.refund_administration_fee_amount)),
            desconto_plataforma: Math.abs(_n(t.platform_discount_amount)),
            confere: dif,                                       // 0 = identidade fechou
            ajustes_depois: (jaTem && jaTem.ajustes_depois) || 0,
            tipos_vistos: Array.from(new Set([].concat((jaTem && jaTem.tipos_vistos) || [], [tipoT])))
          };
        }
        tk = (r2.corpo.data && r2.corpo.data.next_page_token) || '';
        if (!tk) break;
        await new Promise(r3 => setTimeout(r3, 200));
      }
      if (!falhouDetalhe) guardado.extratos[id] = regExtrato;   // só agora conta como pronto
      await new Promise(r3 => setTimeout(r3, 200));
    }
    token = (r.corpo.data && r.corpo.data.next_page_token) || '';
    if (!token || passouDaJanela) break;
    await new Promise(r3 => setTimeout(r3, 250));
  }

  guardado.atualizado = new Date().toISOString();
  /* 30/08 (Codex #291 r4): guarda a JANELA que esta varredura cobriu. Sem isso, a cobertura
     era deduzida do registro mais antigo em cache — e como os mapas são mantidos entre
     rodadas, uma coleta de 270 dias hoje faria a de 120 de amanhã parecer cobrir 270. Aí um
     estorno lançado fora da janela nova passava batido com a tela dizendo "completo". */
  if (!erro) {
    guardado.ok_em = guardado.atualizado;
    guardado.varreu_desde = new Date(Date.now() - (Number(total) || 0) * 86400000).toISOString();
    guardado.varreu_dias = Number(total) || null;
  }
  ctx.writeJson(arq(ctx, loja), guardado);
  return { ok: !erro, loja, dias_pedidos: total, paginas, migrados_do_formato_antigo: migrou, extratos_vistos: extratosVistos,
    pedidos_vistos: pedidosVistos, pedidos_novos: novos, nao_fecharam: sobra,
    guardados: Object.keys(guardado.pedidos).length, erro };
}

function resumoFinanceiro(ctx, loja, de, ate) {
  const g = ctx.readJson(arq(ctx, loja), { pedidos: {} });
  const ini = Date.parse(de + 'T00:00:00-03:00') / 1000, fim = Date.parse(ate + 'T23:59:59-03:00') / 1000;
  let receita = 0, tarifa = 0, frete = 0, repasse = 0, comissao = 0, afiliado = 0, reembolso = 0, n = 0, naoFechou = 0;
  for (const p of Object.values(g.pedidos || {})) {
    const t = Number(p.criado_em) || 0;
    if (!(t >= ini && t <= fim)) continue;
    n++;
    receita = Math.round((receita + p.receita) * 100) / 100;
    // tarifa devolvida entra NEGATIVA: é dinheiro de volta. Duas origens possíveis —
    // a própria transação veio como crédito (`tarifa_credito`), ou o estorno chegou depois
    // e foi acumulado em `tarifa_devolvida`.
    const tarifaLiq = (p.tarifa_credito ? -p.tarifa : p.tarifa) - (p.tarifa_devolvida || 0);
    tarifa = Math.round((tarifa + tarifaLiq) * 100) / 100;
    frete = Math.round((frete + p.frete_liquido) * 100) / 100;
    repasse = Math.round((repasse + p.repasse) * 100) / 100;
    comissao = Math.round((comissao + (p.comissao_plataforma || 0)) * 100) / 100;
    afiliado = Math.round((afiliado + (p.afiliado || 0)) * 100) / 100;
    reembolso = Math.round((reembolso + (p.reembolso_cliente || 0)) * 100) / 100;
    if (Math.abs(p.confere || 0) >= 0.01) naoFechou++;
  }
  return {
    pedidos: n, receita, tarifa, pct_tarifa: receita > 0 ? Math.round(tarifa / receita * 1000) / 10 : null,
    frete_liquido: frete, repasse, comissao_plataforma: comissao, afiliado, reembolso_cliente: reembolso,
    nao_fecharam: naoFechou,
    nota: 'tarifa do TikTok medida: R$ 2,00 fixo + 12% do valor (6% em platform_commission, 6% so dentro de fee_amount). frete_liquido negativo = custo, positivo = sobrou. Ticket baixo paga MUITO mais em %: 29,90 => 18,7% e 117,70 => 14,7%',
    atualizado: g.atualizado || null, coleta_ok_em: g.ok_em || null
  };
}

// ── DEVOLUÇÕES DO TIKTOK (16/08) ────────────────────────────────────────────────
// Fecha o canal: ML e Shopee já têm devolução com detalhe; o TikTok só tinha o
// financeiro. O endpoint é `/return_refund/202309/returns/search` (POST) — o comentário
// dizia `return_orders`, que é o caminho ERRADO (recusado pelo TikTok) e que a chamada já
// não usa; a conversa do Devoluções leu o nome antigo na mensagem de erro e achou que
// tinha sobrado chamada velha. Não sobrou: o que estava desatualizado era o texto.
// Como em todo o resto, isto NÃO inventa formato: guarda o que vier e o resumo usa só
// os campos confirmados. Se o TikTok mudar a estrutura, aparece em `sem_valor`.
async function coletarDevolucoesTikTok(ctx, loja, dias) {
  const total = Math.min(365, Math.max(1, Number(dias) || 60));
  const desde = Math.floor((Date.now() - total * 86400000) / 1000);
  const arqD = ctx.path.join(ctx.CACHE_DIR, '_tiktok_devolucoes_' + (loja || 'girassol') + '.json');
  const g = ctx.readJson(arqD, { devolucoes: {}, atualizado: null, ok_em: null });
  g.devolucoes = g.devolucoes || {};
  let vistas = 0, novas = 0, erro = null;
  // Codex (P1): o caminho certo é `/return_refund/202309/returns/search` (eu tinha escrito
  // `return_orders`, que o TikTok recusa) — e a busca aceita no máximo 30 DIAS por chamada.
  // Então varre em janelas de 30 dias; o cache já é por id, então repetir não duplica.
  const JANELA = 30 * 86400;
  const agora = Math.floor(Date.now() / 1000);
  const janelas = [];
  for (let ini = desde; ini < agora; ini += JANELA) janelas.push([ini, Math.min(ini + JANELA, agora)]);
  for (const [jIni, jFim] of janelas) {
   let token = '';
   for (let v = 0; v < 60; v++) {
    const params = { page_size: '50' };
    if (token) params.page_token = token;
    let r = null;
    try {
      r = await ctx.chamar('/return_refund/202309/returns/search', params,
        { metodo: 'POST', body: { create_time_ge: jIni, create_time_lt: jFim } }, loja);   // Codex (P1): o limite superior é `lt`, não `le` — com `le` o filtro é recusado
    } catch (e) { erro = String(e.message || e).slice(0, 160); break; }
    if (!r || !r.ok || !r.corpo || r.corpo.code !== 0) {
      erro = 'returns/search: ' + ((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http)));
      break;
    }
    const lista = (r.corpo.data && (r.corpo.data.return_orders || r.corpo.data.returns || r.corpo.data.refund_orders)) || [];
    if (!lista.length) break;
    for (const d of lista) {
      const id = String(d.return_id || d.refund_id || d.return_order_id || '').trim();
      if (!id) continue;
      vistas++;
      if (!g.devolucoes[id]) novas++;
      g.devolucoes[id] = {
        id, order_id: String(d.order_id || '').trim() || null,
        tipo: d.return_type || d.refund_type || null,
        status: d.return_status || d.refund_status || null,
        motivo: d.return_reason || d.refund_reason || null,
        motivo_texto: d.return_reason_text || null,
        // Codex (P1): o valor vem como objeto { currency, value } — sem ler `.value`, TODA
        // devolução era guardada com valor 0 e o resumo diria que nada foi reembolsado.
        valor: _n((d.refund_amount && (d.refund_amount.value || d.refund_amount.refund_total || d.refund_amount.total)) || d.refund_total || 0),
        /* 29/08 — FRETE DA DEVOLUÇÃO QUE SAI DO BOLSO DA LOJA. A API sempre mandou (a sonda
           mostrou R$ 10,86 e R$ 12,84 em dois casos reais) e nós NUNCA líamos: esse custo
           não aparecia em diagnóstico nenhum. Vem como LISTA de objetos por moeda. */
        frete_devolucao_vendedor: (function () {
          const arr = Array.isArray(d.shipping_fee_amount) ? d.shipping_fee_amount : [];
          let s = 0;
          for (const f of arr) s += Math.abs(_n(f && f.seller_paid_return_shipping_fee));
          return Math.round(s * 100) / 100;
        })(),
        frete_devolucao_plataforma: (function () {
          const arr = Array.isArray(d.shipping_fee_amount) ? d.shipping_fee_amount : [];
          let s = 0;
          for (const f of arr) s += Math.abs(_n(f && f.platform_paid_return_shipping_fee));
          return Math.round(s * 100) / 100;
        })(),
        criado_em: Number(d.create_time) || null, atualizado_em: Number(d.update_time) || null,
        /* Codex (P2, PR#155 r6): o corte em 40 fazia a rota de raio-X responder que um campo NÃO
           existe quando ele só estava além do corte — e a pergunta que ela existe pra responder é
           justamente "a API manda campo de rastreio da reversa?". Guardo a lista inteira; são
           nomes de campo, não valores, então o peso é desprezível. */
        cru_campos: Object.keys(d)
      };
    }
    token = (r.corpo.data && r.corpo.data.next_page_token) || '';
    if (!token) break;
    // Codex (P2): sair do laço com token ainda válido = lista truncada. Publicar isso como
    // sucesso seria devolver resumo incompleto sem avisar.
    if (v === 59) { erro = 'lista de devoluções TRUNCADA numa janela de 30 dias (mais de 3.000)'; break; }
    await new Promise(r2 => setTimeout(r2, 250));
   }
   if (erro) break;
   await new Promise(r2 => setTimeout(r2, 300));
  }
  g.atualizado = new Date().toISOString();
  if (!erro) {
    g.ok_em = g.atualizado;
    g.varreu_desde = new Date(Date.now() - (Number(total) || 0) * 86400000).toISOString();   /* idem financeiro */
    g.varreu_dias = Number(total) || null;
  }
  ctx.writeJson(arqD, g);
  return { ok: !erro, loja, dias_pedidos: total, vistas, novas, guardadas: Object.keys(g.devolucoes).length, erro };
}

function resumoDevolucoesTikTok(ctx, loja, de, ate) {
  const arqD = ctx.path.join(ctx.CACHE_DIR, '_tiktok_devolucoes_' + (loja || 'girassol') + '.json');
  const g = ctx.readJson(arqD, { devolucoes: {} });
  const ini = Date.parse(de + 'T00:00:00-03:00') / 1000, fim = Date.parse(ate + 'T23:59:59-03:00') / 1000;
  const porMotivo = {}, porStatus = {};
  let n = 0, valor = 0, semValor = 0;
  const lista = [];
  let canceladas = 0;
  for (const d of Object.values(g.devolucoes || {})) {
    const t = Number(d.criado_em) || 0;
    if (!(t >= ini && t <= fim)) continue;
    porStatus[d.status || '?'] = (porStatus[d.status || '?'] || 0) + 1;
    // Codex (P2): devolução CANCELADA não devolveu dinheiro nenhum — somar o valor dela
    // inflaria o prejuízo. Mesma regra que a Shopee já aplica. Ela continua no por_status.
    if (/CANCEL/i.test(String(d.status || ''))) { canceladas++; continue; }
    n++;
    valor = Math.round((valor + _n(d.valor)) * 100) / 100;
    if (!_n(d.valor)) semValor++;
    porMotivo[d.motivo || 'sem motivo'] = (porMotivo[d.motivo || 'sem motivo'] || 0) + 1;
    lista.push({ id: d.id, order_id: d.order_id, status: d.status, motivo: d.motivo, texto: d.motivo_texto, valor: _n(d.valor) });
  }
  return { quantidade: n, valor_devolvido: valor, sem_valor: semValor, canceladas_fora_da_conta: canceladas,
    por_motivo: porMotivo, por_status: porStatus,
    maiores: lista.sort((a, b) => b.valor - a.valor).slice(0, 20),
    atualizado: g.atualizado || null, coleta_ok_em: g.ok_em || null };
}

module.exports = { coletarFinanceiro, resumoFinanceiro, coletarDevolucoesTikTok, resumoDevolucoesTikTok };
