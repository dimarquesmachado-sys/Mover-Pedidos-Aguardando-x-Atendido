'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  DEVOLUÇÕES DO MERCADO LIVRE — código ÚNICO (14/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Espelha o que a Shopee já tinha: qual produto voltou, por quê, quanto e com que
//  status. Hoje o dashboard só mostrava o AGREGADO do faturamento ("Devoluções R$ X"),
//  sem dizer de onde veio.
//
//  O QUE A SONDA MOSTROU (Girassol, 14/08 — dado real, não suposição):
//   · /post-purchase/v1/claims/search traz TUDO misturado: `returns` (devolução de
//     verdade), `mediations` (reclamação sem devolução), `cancel_purchase` e
//     `cancel_sale` (cancelamentos). Dos 12 abertos, só 5 eram returns — somar tudo
//     como devolução inflaria o número. Por isso o filtro por `type` é obrigatório.
//   · /post-purchase/v2/claims/{id}/returns dá o pedido, o item (MLB + variação), a
//     QUANTIDADE devolvida vs comprada, o status do retorno e se o dinheiro está retido.
//     Quando não há devolução associada responde 404 — é resposta normal, não erro.
//   · /post-purchase/v1/claims/{id}/charges/return-cost veio ZERO nos casos abertos;
//     o custo real segue vindo do faturamento do ML (que o painel já desconta).
//   · NÃO vem SKU: vem item_id/variation_id. O SKU sai do NOSSO histórico pelo order_id.
//
//  ctx = { CACHE_DIR, path, readJson, writeJson, token (string), skuDoPedido? }
const _num = v => { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const arqDev = ctx => ctx.path.join(ctx.CACHE_DIR, '_ml_devolucoes.json');
const TIPOS_DEVOLUCAO = ['returns'];   // `mediations`/`cancel_*` NÃO são devolução

// 14/08 — textos conferidos pelo Diego na tela do ML, um pedido de cada vez.
const MOTIVO_ML = {
  PDD9939: 'arrependimento (produto OK, comprador não quis mais)',
  PDD9941: 'produto com problema',        // único caso com custo de retorno cobrado (R$ 34,08)
  PDD9925: 'outro motivo'
};
// ★ Status que NÃO são prejuízo — o ML devolveu o dinheiro PRA LOJA:
//   expired   = "o comprador não enviou o produto, cancelamos a devolução e te devolvemos o dinheiro"
//   cancelled = "o comprador cancelou a devolução que tinha pedido, liberamos o valor desta venda"
const STATUS_SEM_EFEITO = ['expired', 'cancelled'];

async function coletarDevolucoesML(ctx, dias, opts) {
  const total = Math.min(365, Math.max(1, Number(dias) || 60));
  const limite = Date.now() - total * 86400000;
  const H = { headers: { Authorization: 'Bearer ' + ctx.token } };
  const arq = ctx.readJson(arqDev(ctx), { devolucoes: {}, atualizado: null, ok_em: null });
  arq.devolucoes = arq.devolucoes || {};
  // 14/08 — o detalhe (SKU/valor/custo) só é buscado de quem ainda não tem, pra não repetir
  // chamada à toa. Quando a REGRA muda (foi o caso: SKU passou a vir do pedido do ML),
  // `?refazer=1` limpa o marcador e reprocessa os que já estavam guardados.
  const refazer = Boolean(opts && opts.refazer);
  let reprocessados = 0;
  if (refazer) {
    for (const d of Object.values(arq.devolucoes)) { if (d && d.detalhe_em) { delete d.detalhe_em; reprocessados++; } }
  }
  let vistas = 0, novas = 0, comRetorno = 0, erro = null;

  let sellerId = null;
  try {
    const rm = await fetch('https://api.mercadolibre.com/users/me', H);
    const dm = await rm.json().catch(() => null);
    if (rm.ok && dm && dm.id) sellerId = dm.id;
  } catch (e) {}
  if (!sellerId) return { ok: false, erro: 'não consegui identificar o vendedor (/users/me)' };

  const base = 'players.user_id=' + sellerId + '&players.role=respondent&sort=date_created:desc&limit=50';
  for (const st of ['opened', 'closed']) {
    let parar = false;
    for (let off = 0; off < 2000 && !parar; off += 50) {
      let dc = null;
      try {
        const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/search?' + base + '&status=' + st + '&offset=' + off, H);
        dc = rc.ok ? await rc.json().catch(() => null) : null;
        if (!rc.ok) {
          // 14/08 — 403 aqui é SEMPRE permissão do app, não erro de código: a Girassol passou
          // por isso em julho. O ML embute o id do app no token (APP_USR-{app_id}-…), então a
          // resposta diz QUAL app precisa da permissão — senão vira caça ao tesouro no painel.
          if (rc.status === 403) {
            const appId = (String(ctx.token || '').match(/APP_USR-(\d+)-/) || [])[1] || 'não identificado';
            erro = 'HTTP 403 em claims/search: o app do ML (id ' + appId + ') não tem permissão de pós-venda. ' +
                   'Habilite as permissões funcionais em Leitura+escrita (principalmente "Venda e envios") no painel de aplicações ' +
                   'e REFAÇA a autorização (reconsentir) logado como dono da conta — o token atual não ganha o escopo sozinho.';
            break;
          }
          erro = erro || ('claims/search ' + st + ': HTTP ' + rc.status);
          break;
        }
      } catch (e) { erro = erro || ('claims/search ' + st + ': ' + String(e.message || e).slice(0, 120)); break; }
      const lista = (dc && dc.data) || [];
      if (!lista.length) break;
      for (const c of lista) {
        const dt = Date.parse(c && c.date_created);
        if (isFinite(dt) && dt < limite) { parar = true; continue; }   // ordenado por data desc
        if (!c || TIPOS_DEVOLUCAO.indexOf(String(c.type || '')) < 0) continue;   // só devolução de verdade
        vistas++;
        const id = String(c.id);
        const reg = arq.devolucoes[id] || {};
        if (!arq.devolucoes[id]) novas++;
        reg.claim_id = id;
        reg.order_id = String(c.resource_id || '');
        reg.status = c.status || null;
        reg.etapa = c.stage || null;
        reg.motivo = c.reason_id || null;
        reg.quantidade_tipo = c.quantity_type || null;
        reg.criado_em = c.date_created || null;
        reg.atualizado_em = c.last_updated || null;
        reg.resolucao = (c.resolution && c.resolution.reason) || null;
        reg.beneficiado = (c.resolution && c.resolution.benefited) || null;
        arq.devolucoes[id] = reg;
      }
      if (lista.length < 50) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // detalhe do retorno só de quem ainda não tem (o pesado é este; 1 chamada por devolução)
  const pendentes = Object.values(arq.devolucoes).filter(d => !d.detalhe_em).slice(0, refazer ? 400 : 120);
  for (const d of pendentes) {
    try {
      const r1 = await fetch('https://api.mercadolibre.com/post-purchase/v2/claims/' + d.claim_id + '/returns', H);
      if (r1.status === 404) { d.sem_retorno = true; }                 // resposta normal: reclamação sem devolução
      else if (r1.ok) {
        const j1 = await r1.json().catch(() => null);
        const ord = (j1 && j1.orders && j1.orders[0]) || null;
        if (ord) {
          d.item_id = ord.item_id || null;
          d.variacao_id = ord.variation_id || null;
          d.qtd_devolvida = Number(ord.return_quantity) || null;
          d.qtd_comprada = Number(ord.total_quantity) || null;
          if (!d.order_id && ord.order_id) d.order_id = String(ord.order_id);
        }
        d.status_retorno = (j1 && j1.status) || null;                  // label_generated, shipped…
        d.dinheiro = (j1 && j1.status_money) || null;                  // retained = ainda não devolvido
        d.tipo_retorno = (j1 && j1.subtype) || null;                   // return_total / parcial
        comRetorno++;
      }
    } catch (e) {}
    // 14/08 — MEDIDO: casar pelo histórico achou só 2 de 39. Motivo: a reclamação traz o
    // ORDER id (2000017…) e o histórico às vezes guarda o PACK (2000014…). O próprio pedido do
    // ML resolve os dois problemas de uma vez — traz `seller_sku`, título, preço e o pack_id.
    // É também o que o Diego determinou: dado do marketplace, não de terceiro.
    try {
      const ro = await fetch('https://api.mercadolibre.com/orders/' + d.order_id, H);
      if (ro.ok) {
        const jo = await ro.json().catch(() => null);
        const it = (jo && jo.order_items && jo.order_items[0]) || null;
        if (it) {
          d.sku = (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || null;
          d.nome = (it.item && it.item.title) || null;
          d.preco_unitario = _num(it.unit_price);
          d.valor_item = Math.round(_num(it.unit_price) * (Number(it.quantity) || 1) * 100) / 100;
        }
        if (jo && jo.pack_id) d.pack_id = String(jo.pack_id);
        if (jo && jo.status) d.status_pedido = jo.status;
      }
    } catch (e) {}
    try {
      const r2 = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + d.claim_id + '/charges/return-cost', H);
      if (r2.ok) { const j2 = await r2.json().catch(() => null); d.custo_retorno = _num(j2 && j2.amount); }
    } catch (e) {}
    d.detalhe_em = new Date().toISOString();
    await new Promise(r => setTimeout(r, 200));
  }

  arq.atualizado = new Date().toISOString();
  if (!erro) arq.ok_em = arq.atualizado;
  ctx.writeJson(arqDev(ctx), arq);
  return { ok: !erro, dias_pedidos: total, vistas, novas, reprocessados, com_retorno: comRetorno, detalhados_agora: pendentes.length, guardadas: Object.keys(arq.devolucoes).length, erro };
}

// resumo do período — SKU vem do nosso histórico (ctx.skuDoPedido), porque o ML não manda
async function resumoDevolucoesML(ctx, de, ate) {
  const arq = ctx.readJson(arqDev(ctx), { devolucoes: {} });
  const dev = arq.devolucoes || {};
  const ini = Date.parse(de + 'T00:00:00-03:00'), fim = Date.parse(ate + 'T23:59:59-03:00');
  const porMotivo = {}, porSku = {}, porStatus = {};
  // 14/08 — MEDIDO na 1ª rodada: casar o pedido só com o cache dos bipados deixou `valor: 0`
  // em tudo e `sku: null` em 7 de 20 — o cache guarda ~7 dias e a devolução de julho já saiu
  // dele. O histórico (Supabase) tem SKU e valor de TUDO; é dele que a informação vem agora,
  // com o cache como atalho pros pedidos recentes.
  const doHistorico = (typeof ctx.buscarNoHistorico === 'function')
    ? await ctx.buscarNoHistorico(Object.values(dev).map(d => d && d.order_id).filter(Boolean))
    : {};
  let qtd = 0, custo = 0, semRetorno = 0, aindaRetido = 0, semEfeito = 0, valorTotal = 0;
  const lista = [];
  for (const d of Object.values(dev)) {
    const t = Date.parse(d && d.criado_em);
    if (!isFinite(t) || t < ini || t > fim) continue;
    if (d.sem_retorno) { semRetorno++; continue; }
    const st = String(d.status_retorno || d.status || '').toLowerCase();
    porStatus[st || '?'] = (porStatus[st || '?'] || 0) + 1;
    if (STATUS_SEM_EFEITO.indexOf(st) >= 0) { semEfeito++; continue; }   // ML devolveu o dinheiro pra loja
    qtd++;
    custo = Math.round((custo + _num(d.custo_retorno)) * 100) / 100;
    const motTxt = MOTIVO_ML[d.motivo] || d.motivo || 'sem motivo';
    porMotivo[motTxt] = (porMotivo[motTxt] || 0) + 1;
    if (String(d.dinheiro || '') === 'retained') aindaRetido++;
    // ordem das fontes: pedido do ML (melhor) → histórico → cache dos bipados
    const info = (d.sku ? { sku: d.sku, nome: d.nome || null, valor: d.valor_item || 0 } : null)
      || (doHistorico && doHistorico[String(d.order_id || '')])
      || (doHistorico && d.pack_id && doHistorico[String(d.pack_id)])
      || ((typeof ctx.skuDoPedido === 'function' && d.order_id) ? (ctx.skuDoPedido(d.order_id) || null) : null);
    const sku = (info && info.sku) || null;
    if (sku) {
      porSku[sku] = porSku[sku] || { sku, nome: (info && info.nome) || null, qtd: 0, valor: 0, custo_retorno: 0 };
      porSku[sku].qtd += d.qtd_devolvida || 1;
      porSku[sku].valor = Math.round((porSku[sku].valor + ((info && info.valor) || 0)) * 100) / 100;
      valorTotal = Math.round((valorTotal + ((info && info.valor) || 0)) * 100) / 100;
      porSku[sku].custo_retorno = Math.round((porSku[sku].custo_retorno + _num(d.custo_retorno)) * 100) / 100;
    }
    lista.push({ claim_id: d.claim_id, order_id: d.order_id, sku, motivo: d.motivo || null,
      qtd_devolvida: d.qtd_devolvida || null, qtd_comprada: d.qtd_comprada || null,
      status: d.status_retorno || d.status || null, dinheiro: d.dinheiro || null,
      custo_retorno: _num(d.custo_retorno), criado_em: d.criado_em || null });
  }
  return {
    quantidade: qtd, custo_retorno_informado: custo,
    valor_devolvido: Math.round(valorTotal * 100) / 100,
    nao_concretizadas: semEfeito,
    ainda_com_dinheiro_retido: aindaRetido,
    reclamacoes_sem_devolucao: semRetorno,
    por_motivo: porMotivo, por_status: porStatus,
    por_sku: Object.values(porSku).sort((a, b) => b.qtd - a.qtd).slice(0, 30),
    maiores: lista.sort((a, b) => (b.custo_retorno - a.custo_retorno) || 0).slice(0, 20),
    nota: 'SKU/valor vem do PROPRIO pedido no ML. O custo real segue vindo do faturamento: em arrependimento com produto OK o ML nao cobra retorno do vendedor (por isso quase tudo zero). Devolucao expirada/cancelada NAO entra no total — o ML liberou o dinheiro de volta.',
    atualizado: arq.atualizado || null, coleta_ok_em: arq.ok_em || null
  };
}

module.exports = { coletarDevolucoesML, resumoDevolucoesML };
