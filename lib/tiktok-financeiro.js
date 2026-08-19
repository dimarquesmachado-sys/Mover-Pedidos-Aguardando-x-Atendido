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
  if (!erro) guardado.ok_em = guardado.atualizado;
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
// financeiro. O endpoint é `/return_refund/202309/return_orders/search` (POST).
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
      erro = 'return_orders: ' + ((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http)));
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
        criado_em: Number(d.create_time) || null, atualizado_em: Number(d.update_time) || null,
        cru_campos: Object.keys(d).slice(0, 40)   // se o formato mudar, dá pra ver aqui
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
  if (!erro) g.ok_em = g.atualizado;
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


// ── CALIBRAÇÃO DA REGRA DE TARIFA (19/08) ──────────────────────────────────────
// Ideia do Diego: "será q não tinha q fazer algo aproximado, tipo o frete da magalu?
// deve ter a regra do tiktok... ou até pelas vendas passadas já cristalizadas".
//
// A regra OFICIAL vigente desde 15/07/2026 (seller-br.tiktok.com/university):
//   · comissão      10% se o pedido for < R$ 50 · 6% de R$ 50 pra cima
//   · taxa fixa     R$ 4,00 (< R$ 50) · R$ 6,00 (>= R$ 50) — POR ITEM vendido, não por pedido
//   · PTE           6% do produto, só para quem participa do Programa de Frete Grátis
//   · afiliado      definido pelo VENDEDOR, variável — não é regra da plataforma
//
// Esta função NÃO estima nada ainda: ela CONFERE a regra contra os pedidos que já têm
// extrato, e devolve o erro. Sem isso, aplicar a fórmula nos pedidos sem extrato seria
// trocar um número errado conhecido (o do Bling) por um chute com cara de precisão.
// Ela também responde de graça duas perguntas que ninguém sabe: se a loja está no PTE, e
// qual a taxa de afiliado que ela pratica de fato.
// Codex (P1): sem a contagem de itens, a fixa que falta num pedido multi-item é IDÊNTICA aos 6%
// do PTE — 30 pedidos de R$ 100 com 2 itens sem PTE dão os mesmos R$ 18 do modelo 1-item COM PTE.
// Escolher "o que erra menos" cravaria a configuração errada da loja com toda a confiança. Então
// não invento: o PTE fica INDETERMINADO até o Diego informar (&pte=1 ou &pte=0) — ele sabe, é
// configuração da conta dele. Sem essa informação, o veredito não libera estimativa.
function calibrarRegraTarifa(ctx, loja, de, ate, pteInformado) {
  const g = ctx.readJson(arq(ctx, loja), { pedidos: {} });
  const ini = Date.parse(de + 'T00:00:00-03:00') / 1000, fim = Date.parse(ate + 'T23:59:59-03:00') / 1000;

  const regra = (receita, itens, comPTE) => {
    const r = Number(receita) || 0;
    if (r <= 0) return null;
    const abaixo = r < 50;
    const comissao = r * (abaixo ? 0.10 : 0.06);
    const fixa = (abaixo ? 4 : 6) * Math.max(1, Number(itens) || 1);
    const pte = comPTE ? r * 0.06 : 0;
    return Math.round((comissao + fixa + pte) * 100) / 100;
  };

  // Codex (P2): a regra atual só vale a partir de 15/07/2026 — pedido anterior foi cobrado por
  // outra tabela (comissão 6% para todos, fixa R$ 4). Misturar os dois períodos produziria erro,
  // veredito e conclusão sobre o PTE todos falsos. Corte por pedido, não pelo período pedido.
  const REGRA_VALE_DE = Math.floor(Date.parse('2026-07-15T00:00:00-03:00') / 1000);
  const amostra = [];
  let fora_regra_antiga = 0, fora_estorno = 0, fora_nao_fecha = 0, zeradosLiquidados = 0;
  for (const p of Object.values(g.pedidos || {})) {
    const t = Number(p.criado_em) || 0;
    if (!(t >= ini && t <= fim)) continue;
    if (p.so_ajuste) continue;                       // linha de ajuste, não é venda
    if (t < REGRA_VALE_DE) { fora_regra_antiga++; continue; }
    if (Math.abs(p.confere || 0) >= 0.01) { fora_nao_fecha++; continue; }
    const receita = Number(p.receita) || 0;
    if (receita <= 0) continue;
    // Codex (P2): reembolso PARCIAL devolve menos que a tarifa inteira, então `tarifaLiq` continua
    // positiva e o pedido passava — a fórmula comparava a receita CHEIA contra uma tarifa já
    // abatida. Qualquer devolução de tarifa tira o pedido da amostra, como as limitações já diziam.
    if (Number(p.tarifa_devolvida || 0) > 0 || p.tarifa_credito) { fora_estorno++; continue; }
    // Codex (P2): pedido liquidado com tarifa ZERO (isenção, cortesia, ou campo que não sabemos ler)
    // é um CONTRAEXEMPLO da regra — ela sempre prevê cobrança. Descartar em silêncio deixaria a
    // amostra parecer perfeita. Fica contado à parte e entra no veredito.
    const tarifaLiq = Number(p.tarifa);
    if (!isFinite(tarifaLiq)) continue;                       // sem dado de tarifa: fora
    if (tarifaLiq === 0) { zeradosLiquidados++; continue; }    // com dado e ZERO: contraexemplo
    if (tarifaLiq < 0) continue;
    amostra.push({ order_id: p.order_id, receita, tarifa: tarifaLiq, afiliado: Number(p.afiliado) || 0 });
  }
  const descartes = { regra_antiga_antes_de_15_07_2026: fora_regra_antiga, com_estorno_de_tarifa: fora_estorno, identidade_nao_fechou: fora_nao_fecha, liquidados_com_tarifa_zero: zeradosLiquidados };
  if (!amostra.length) return { ok: true, loja, de, ate, pedidos: 0, descartes, aviso: 'nenhum pedido liquidado sob a regra atual no período' };

  // O número de itens não vem no extrato — a fixa é POR ITEM e isso limita a precisão.
  // Assumo 1 item por pedido e registro a limitação, em vez de esconder.
  // Codex (P2, o mais importante dos cinco): somar o afiliado REAL do próprio pedido é usar uma
  // informação que NÃO existirá na hora de estimar — o pedido sem extrato não tem afiliado nenhum.
  // Uma amostra assim pode acusar 100% de acerto e liberar um estimador que erra feio na prática.
  // Por isso avalio DOIS modos: `afiliado_real` só para conferir a fórmula da PLATAFORMA, e
  // `afiliado_medio` (o que o estimador realmente teria) — e é este que decide o veredito.
  const afilMedioPct = (() => {
    const rec = amostra.reduce((s2, a) => s2 + a.receita, 0);
    const af = amostra.reduce((s2, a) => s2 + a.afiliado, 0);
    return rec > 0 ? af / rec : 0;
  })();

  const avalia = (comPTE, modoAfiliado) => {
    let somaErro = 0, somaAbs = 0, somaAbsRel = 0, dentro5 = 0, dentro10 = 0, tarifaTot = 0, previstoTot = 0, pior = 0;
    for (const a of amostra) {
      const afil = modoAfiliado === 'real' ? a.afiliado : a.receita * afilMedioPct;
      const prev = regra(a.receita, 1, comPTE) + afil;
      const erro = prev - a.tarifa;
      somaErro += erro; somaAbs += Math.abs(erro);
      tarifaTot += a.tarifa; previstoTot += prev;
      if (a.tarifa > 0) {
        const rel = Math.abs(erro) / a.tarifa;
        somaAbsRel += rel;
        if (rel <= 0.05) dentro5++;
        if (rel <= 0.10) dentro10++;
        if (rel > pior) pior = rel;
      }
    }
    const n = amostra.length;
    return {
      com_pte: comPTE, afiliado: modoAfiliado,
      erro_medio: Math.round(somaErro / n * 100) / 100,
      erro_medio_absoluto: Math.round(somaAbs / n * 100) / 100,
      erro_relativo_medio_pct: Math.round(somaAbsRel / n * 1000) / 10,
      dentro_de_5pct: dentro5, dentro_de_5pct_percentual: Math.round(dentro5 / n * 1000) / 10,
      dentro_de_10pct_percentual: Math.round(dentro10 / n * 1000) / 10,
      pior_erro_relativo_pct: Math.round(pior * 1000) / 10,
      tarifa_real_total: Math.round(tarifaTot * 100) / 100,
      tarifa_prevista_total: Math.round(previstoTot * 100) / 100,
      desvio_total_pct: tarifaTot > 0 ? Math.round((previstoTot - tarifaTot) / tarifaTot * 1000) / 10 : null
    };
  };

  // o PTE é característica da LOJA: decido por qual modelo erra menos com o afiliado real
  // (aí a diferença que sobra é a da plataforma, não a do afiliado)
  const semPTE = avalia(false, 'real'), comPTE = avalia(true, 'real');
  const pteConhecido = (pteInformado === true || pteInformado === false);
  const pteUsado = pteConhecido ? pteInformado : (comPTE.erro_medio_absoluto < semPTE.erro_medio_absoluto);
  const melhor = pteUsado ? comPTE : semPTE;
  const comoVaiEstimar = avalia(pteUsado, 'medio');   // ESTE é o estimador de verdade

  const comAfil = amostra.filter(a => a.afiliado > 0);
  const recTot = amostra.reduce((s, a) => s + a.receita, 0);
  const afilTot = amostra.reduce((s, a) => s + a.afiliado, 0);

  // os 10 piores, pra olhar caso a caso em vez de acreditar na média
  // Codex (P2): eu listava os piores usando o afiliado REAL — o veredito podia reprovar e a lista
  // mostrar erro zero em todos, escondendo justamente os pedidos que causaram a reprovação.
  // Os piores casos agora usam o MESMO estimador que decide (afiliado médio).
  const piores = amostra.map(a => {
    const prev = regra(a.receita, 1, pteUsado) + a.receita * afilMedioPct;
    const erro = prev - a.tarifa;
    return { order_id: a.order_id, receita: a.receita, tarifa_real: a.tarifa,
             tarifa_prevista: Math.round(prev * 100) / 100, erro: Math.round(erro * 100) / 100,
             erro_relativo_pct: a.tarifa > 0 ? Math.round(Math.abs(erro) / a.tarifa * 1000) / 10 : null,
             afiliado_real_do_pedido: a.afiliado };
  }).sort((x, y) => Math.abs(y.erro) - Math.abs(x.erro)).slice(0, 10);

  return {
    ok: true, loja, de, ate, pedidos: amostra.length,
    regra_oficial: 'comissao 10% (<R$50) ou 6% (>=R$50) + fixa R$4/R$6 por item + PTE 6% (opcional) + afiliado do vendedor',
    sem_pte: semPTE, com_pte: comPTE,
    // é assim que o estimador vai funcionar de verdade: sem saber o afiliado do pedido
    como_vai_estimar: comoVaiEstimar,
    veredito: (function(){
      // Codex (P2): sem mínimo de amostra, UM pedido bastava para declarar o modelo bom e
      // "descobrir" o PTE. E o desvio total esconde erros que se cancelam — 80% exatos mais
      // 10 erros para cada lado dão desvio ~0 com erro grande em 20% dos pedidos. Agora o
      // veredito exige amostra, olha o erro ABSOLUTO relativo e limita o pior caso.
      const MIN = 30;
      if (amostra.length < MIN) {
        return { conclusivo: false, motivo: 'amostra pequena: ' + amostra.length + ' pedidos liquidados sob a regra atual (mínimo ' + MIN + ')',
                 loja_parece_estar_no_pte: null, serve_para_estimar: false };
      }
      if (!pteConhecido) {
        return { conclusivo: false,
          motivo: 'não dá para saber sozinho se a loja está no Programa de Frete Grátis (PTE): num pedido com 2+ itens a taxa fixa que falta é IGUAL aos 6% do PTE, e o extrato não traz a contagem de itens',
          o_que_fazer: 'repita a chamada com &pte=1 (a loja participa) ou &pte=0 (não participa) — essa informação está no Seller Center',
          palpite_sem_confirmacao: comPTE.erro_medio_absoluto < semPTE.erro_medio_absoluto ? 'parece estar no PTE' : 'parece NÃO estar no PTE',
          serve_para_estimar: false };
      }
      if (zeradosLiquidados > 0) {
        return { conclusivo: false,
          motivo: zeradosLiquidados + ' pedido(s) liquidado(s) com tarifa ZERO no período — a regra sempre prevê cobrança, então ou há isenção que não modelamos ou um campo de tarifa que não sabemos ler',
          serve_para_estimar: false };
      }
      const e = comoVaiEstimar;
      return {
        conclusivo: true,
        loja_esta_no_pte: pteUsado, fonte_do_pte: 'informado na chamada',
        erro_relativo_medio_pct: e.erro_relativo_medio_pct,
        acerto_dentro_de_5pct: e.dentro_de_5pct_percentual + '%',
        acerto_dentro_de_10pct: e.dentro_de_10pct_percentual + '%',
        pior_erro_relativo_pct: e.pior_erro_relativo_pct,
        serve_para_estimar: e.erro_relativo_medio_pct <= 5 && e.dentro_de_10pct_percentual >= 90 && Math.abs(e.desvio_total_pct) <= 3,
        leia: 'o veredito usa o modo afiliado_medio, que e o unico disponivel num pedido sem extrato'
      };
    })(),
    descartes,
    afiliado: {
      pedidos_com_afiliado: comAfil.length,
      percentual_dos_pedidos: Math.round(comAfil.length / amostra.length * 1000) / 10,
      total: Math.round(afilTot * 100) / 100,
      pct_da_receita: recTot > 0 ? Math.round(afilTot / recTot * 1000) / 10 : null
    },
    piores_casos: piores,
    limitacoes: [
      'a taxa fixa e POR ITEM e o extrato nao traz a contagem de itens: assumido 1 item por pedido, entao pedido multi-item aparece com tarifa prevista MENOR que a real',
      'o bloco sem_pte/com_pte usa o afiliado REAL de cada pedido — serve para conferir a formula da PLATAFORMA, nao para prever',
      'quem manda no veredito e como_vai_estimar, que usa o afiliado MEDIO da amostra (' + Math.round(afilMedioPct * 1000) / 10 + '% da receita), porque e o unico numero disponivel num pedido sem extrato',
      'pedidos anteriores a 15/07/2026 (regra antiga), com estorno de tarifa ou cuja identidade nao fechou ficaram de fora — ver o bloco descartes'
    ]
  };
}

module.exports = { coletarFinanceiro, resumoFinanceiro, coletarDevolucoesTikTok, resumoDevolucoesTikTok, calibrarRegraTarifa };
