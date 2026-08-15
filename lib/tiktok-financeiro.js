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
      guardado.extratos[id] = { id, quando, pago_em: st.payment_time || null, status: st.payment_status || null,
        receita: _n(st.revenue_amount), tarifa: _n(st.fee_amount), frete: _n(st.shipping_cost_amount),
        ajuste: _n(st.adjustment_amount), repasse: _n(st.settlement_amount) };
      // detalhe: é aqui que aparece o order_id
      let tk = '';
      for (let p2 = 0; p2 < 20; p2++) {
        const par2 = { page_size: '50', sort_field: 'order_create_time' };
        if (tk) par2.page_token = tk;
        let r2 = null;
        try { r2 = await ctx.chamar('/finance/202309/statements/' + id + '/statement_transactions', par2, {}, loja); }
        catch (e) { erro = erro || ('transactions ' + id + ': ' + String(e.message || e).slice(0, 120)); break; }
        if (!r2 || !r2.ok || !r2.corpo || r2.corpo.code !== 0) { erro = erro || ('transactions ' + id + ': ' + ((r2 && r2.corpo && r2.corpo.message) || 'falhou')); break; }
        const trs = (r2.corpo.data && r2.corpo.data.statement_transactions) || [];
        for (const t of trs) {
          const sn = String(t.order_id || '').trim();
          if (!sn) continue;
          pedidosVistos++;
          const receita = _n(t.revenue_amount);
          const tarifa = Math.abs(_n(t.fee_amount));            // vem negativo; guardamos positivo
          const freteLiq = _n(t.shipping_cost_amount);          // negativo = custo · positivo = sobrou
          const repasse = _n(t.settlement_amount);
          const dif = Math.round((receita - tarifa + freteLiq + _n(t.adjustment_amount) - repasse) * 100) / 100;
          if (Math.abs(dif) >= 0.01) sobra++;
          if (!guardado.pedidos[sn]) novos++;
          guardado.pedidos[sn] = {
            order_id: sn, extrato_id: id, tipo: t.type || null,
            criado_em: t.order_create_time || null, liquidado_em: quando || null,
            receita, tarifa, frete_liquido: freteLiq, ajuste: _n(t.adjustment_amount), repasse,
            comissao_plataforma: Math.abs(_n(t.platform_commission_amount)),
            afiliado: Math.abs(_n(t.affiliate_commission_amount)) + Math.abs(_n(t.affiliate_partner_commission_amount)) + Math.abs(_n(t.affiliate_ads_commission_amount)),
            frete_real: Math.abs(_n(t.actual_shipping_fee_amount)),
            subsidio_frete: _n(t.platform_shipping_fee_discount_amount) + _n(t.shipping_cost_discount_amount),
            frete_pago_comprador: _n(t.customer_paid_shipping_fee_amount),
            reembolso_cliente: Math.abs(_n(t.customer_refund_amount)),
            frete_devolucao: Math.abs(_n(t.actual_return_shipping_fee_amount)) + Math.abs(_n(t.return_shipping_fee_amount)),
            taxa_adm_reembolso: Math.abs(_n(t.refund_administration_fee_amount)),
            desconto_plataforma: Math.abs(_n(t.platform_discount_amount)),
            confere: dif                                        // 0 = identidade fechou
          };
        }
        tk = (r2.corpo.data && r2.corpo.data.next_page_token) || '';
        if (!tk) break;
        await new Promise(r3 => setTimeout(r3, 200));
      }
      await new Promise(r3 => setTimeout(r3, 200));
    }
    token = (r.corpo.data && r.corpo.data.next_page_token) || '';
    if (!token || passouDaJanela) break;
    await new Promise(r3 => setTimeout(r3, 250));
  }

  guardado.atualizado = new Date().toISOString();
  if (!erro) guardado.ok_em = guardado.atualizado;
  ctx.writeJson(arq(ctx, loja), guardado);
  return { ok: !erro, loja, dias_pedidos: total, paginas, extratos_vistos: extratosVistos,
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
    tarifa = Math.round((tarifa + p.tarifa) * 100) / 100;
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

module.exports = { coletarFinanceiro, resumoFinanceiro };
