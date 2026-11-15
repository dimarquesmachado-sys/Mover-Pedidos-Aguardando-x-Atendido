'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   UM PRODUTO DE PERTO NOS MARKETPLACES (15/11/2026) — "e ESTE anúncio?": leitura ao vivo, por SKU.

   O chat de análise sabe o SKU (é como a base de vendas identifica o item); os marketplaces conhecem o anúncio. Esta
   peça faz a ponte: dado um SKU, acha os anúncios dele e lê de cada um o que a 2ª rodada da sonda (#888, rodada em
   15/11 na Girassol, na AMB e na GOOD) mostrou que a API devolve — e SÓ isso:

   MERCADO LIVRE (com o token da loja):
     · os anúncios do SKU: `GET /users/{id}/items/search?sku=<sku>` (achou o anúncio pai pelo campo antigo
       `seller_custom_field`) e `…?seller_sku=<sku>` (o atributo SELLER_SKU, que nos anúncios com variação mora na
       variação) — os dois, porque a conta real tem SKU nos dois lugares;
     · o anúncio: `GET /items?ids=…&attributes=…&include_attributes=all` → situação, estoque, vendidos, preço, saúde,
       logística, e cada variação com SKU, estoque e vendidos;
     · as visitas por dia: `GET /items/{id}/visits/time_window?last=N&unit=day` (dias sem visita NÃO vêm na lista);
     · as promoções do anúncio: `GET /seller-promotions/items/{id}?app_version=v2` → `status: candidate` = pode entrar
       (NÃO entrou); `started` = está;
     · a qualidade: `GET /item/{id}/performance` → `score` (0–100), `level`, `level_wording`, e o que o ML diz que
       falta (`buckets[].variables[]` com `status: PENDING`);
     · o estoque por local: `GET /user-products/{MLBU…}/stock` → `locations[] { type: seller_warehouse | meli_facility,
       quantity }` — o Full é `meli_facility`; sem essa linha, o produto NÃO está no Full;
     · o anúncio em Product Ads: `GET /marketplace/advertising/{site}/product_ads/ads/{id}` (api-version 2) →
       `status` (idle = fora de campanha; hold…), `campaign_id` (0 = nenhuma), métricas do período.

   SHOPEE (pelo serviço que tem o token):
     · os anúncios do SKU: `product/search_item?item_sku=<sku>` → `item_id_list`;
     · o anúncio: `product/get_item_base_info` → situação, preço, estoque por local (`stock_info_v2`: `seller_stock` = o
       galpão; `shopee_stock` = o Full da Shopee, por centro), `deboost`;
     · visitas/vendas/avaliação: `product/get_item_extra_info` → `sale`, `views`, `likes`, `rating_star`, `comment_count`
       (acumulados — a Shopee não dá por dia);
     · as promoções: `product/get_item_promotion` (na conta real veio só `success_list` — o formato de promoção ativa
       NÃO foi visto; a peça devolve o que vier, encolhido, sem interpretar).

   NÚMERO ERRADO É PIOR QUE NÚMERO AUSENTE: parte que o marketplace não respondeu fica nula e entra em "faltou" com o
   motivo; "visitas: 0 num dia" só quando o ML listou o dia com 0 — dia que não veio é "sem dado"; "não está em Ads" só
   quando a API disse (`campaign_id: 0`/`status: idle`); erro 404 nessa consulta é "não respondeu", não "não está".
   Nada de comprador: as consultas são só de anúncio. Teto de SKUs por pergunta e de anúncios por SKU (cada anúncio
   são até 6 idas ao ML) — e um prazo pro conjunto (lib/checkout/com-prazo.js).
   ───────────────────────────────────────────────────────────────────────────── */

const { prazoEmSequencia } = require('./com-prazo');

const MAX_SKUS = 4;              /* por pergunta */
const MAX_ANUNCIOS_POR_SKU = 3;  /* anúncios lidos de perto, por SKU (a busca mostra quantos há) */
const MAX_VARIACOES = 20;
const MAX_PENDENCIAS = 12;
const DIAS_VISITAS = 7, DIAS_VISITAS_MAX = 30;
const PRAZO_MS = 60000;          /* a consulta inteira */
const PRAZO_PEDIDO_MS = 10000;
const ML = 'https://api.mercadolibre.com';
const ID_ITEM = /^[A-Z]{3}\d+$/, ID_PRODUTO = /^[A-Z]{3}U\d+$/, ID_SHOPEE = /^\d{4,20}$/;
const SKU_OK = /^[^\u0000-\u001f]{1,80}$/;

const numero = (x) => { if (x == null || x === '' || typeof x === 'boolean') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const contagem = (x) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
const texto = (x) => (typeof x === 'string' && x ? x : null);
const diaDe = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const skusPedidos = (lista) => Array.from(new Set((Array.isArray(lista) ? lista : []).map((s) => String(s == null ? '' : s).trim()).filter((s) => SKU_OK.test(s)))).slice(0, MAX_SKUS);

/* ═══ MERCADO LIVRE ═══ */
const skuDosAtributos = (lista) => { const a = Array.isArray(lista) ? lista.find((x) => x && x.id === 'SELLER_SKU') : null; return a && typeof a.value_name === 'string' ? a.value_name : null; };
function resumirAnuncioML(b) {
  if (!b || typeof b !== 'object') return null;
  const sh = b.shipping || {};
  const vars = Array.isArray(b.variations) ? b.variations.filter((v) => v && typeof v === 'object') : [];
  return { anuncio: texto(b.id), titulo: texto(b.title), situacao: texto(b.status), sub_situacao: Array.isArray(b.sub_status) ? b.sub_status.filter((x) => typeof x === 'string') : null,
    preco: numero(b.price), estoque_anunciado: contagem(b.available_quantity), vendidos_total: contagem(b.sold_quantity), saude: numero(b.health),
    sku_do_anuncio: texto(b.seller_custom_field) || skuDosAtributos(b.attributes), codigo_do_produto: ID_PRODUTO.test(String(b.user_product_id)) ? b.user_product_id : null,
    logistica: texto(sh.logistic_type), frete_gratis: typeof sh.free_shipping === 'boolean' ? sh.free_shipping : null, tipo_de_anuncio: texto(b.listing_type_id),
    variacoes_total: vars.length,
    variacoes: vars.slice(0, MAX_VARIACOES).map((v) => ({ id: v.id != null ? String(v.id) : null, sku: skuDosAtributos(v.attributes) || texto(v.seller_custom_field),
      nome: Array.isArray(v.attribute_combinations) ? v.attribute_combinations.filter((c) => c && typeof c === 'object').map((c) => (c.name ? c.name + ': ' : '') + (c.value_name == null ? '?' : c.value_name)).join(' / ') || null : null,
      estoque: contagem(v.available_quantity), vendidos_total: contagem(v.sold_quantity), preco: numero(v.price), codigo_do_produto: ID_PRODUTO.test(String(v.user_product_id)) ? v.user_product_id : null })) };
}
/* visitas por dia: só os dias que o ML listou; o total é o dele */
function resumirVisitas(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.results)) return null;
  const dias = v.results.filter((x) => x && typeof x === 'object' && diaDe(x.date) && contagem(x.total) != null).map((x) => ({ dia: diaDe(x.date), visitas: x.total })).sort((a, b) => (a.dia < b.dia ? -1 : 1));
  return { total: contagem(v.total_visits), de: diaDe(v.date_from), ate: diaDe(v.date_to), por_dia: dias, dias_listados: dias.length };
}
function resumirPromocoes(p) {
  if (!Array.isArray(p)) return null;
  const l = p.filter((x) => x && typeof x === 'object');
  const uma = (x) => ({ id: texto(x.id), tipo: texto(x.type), nome: texto(x.name), situacao: texto(x.status), comeca: texto(x.start_date), termina: texto(x.finish_date), preco_sugerido: numero(x.suggested_discounted_price), preco_na_promocao: numero(x.price) || null });
  return { participando: l.filter((x) => x.status && x.status !== 'candidate').map(uma), pode_entrar: l.filter((x) => x.status === 'candidate').map(uma) };
}
function resumirQualidade(q) {
  if (!q || typeof q !== 'object') return null;
  const pend = [];
  for (const b of (q.buckets || [])) for (const v of ((b && b.variables) || [])) if (v && v.status === 'PENDING' && texto(v.title)) pend.push({ area: texto(b.title), o_que: v.title });
  return { nota: numero(q.score), nivel: texto(q.level_wording) || texto(q.level), calculada_em: texto(q.calculated_at), pendencias_total: pend.length, pendencias: pend.slice(0, MAX_PENDENCIAS) };
}
/* o estoque por local: o Full é `meli_facility`; sem a linha, não está no Full (a API diz isso omitindo) */
function resumirEstoque(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.locations)) return null;
  const locs = e.locations.filter((l) => l && typeof l === 'object');
  const soma = (tipo) => { const x = locs.filter((l) => l.type === tipo); return x.length ? x.reduce((t, l) => t + (contagem(l.quantity) || 0), 0) : null; };
  return { galpao: soma('seller_warehouse'), full: soma('meli_facility'), tem_linha_do_full: locs.some((l) => l.type === 'meli_facility'), atualizado_em: texto(e.last_updated) };
}
function resumirAds(a) {
  if (!a || typeof a !== 'object') return null;
  const m = a.metrics || {};
  const camp = numero(a.campaign_id);
  return { situacao: texto(a.status), em_campanha: camp == null ? null : camp !== 0, campanha_id: camp, nivel: texto(a.current_level), recomendado: typeof a.recommended === 'boolean' ? a.recommended : null,
    periodo: { cliques: numero(m.clicks), impressoes: numero(m.prints), custo: numero(m.cost), vendas_atribuidas: numero(m.total_amount), acos: numero(m.acos) } };
}

async function consultarML(o) {
  const skus = skusPedidos(o && o.skus);
  if (!skus.length) return { ok: false, erro: 'nenhum SKU válido pedido' };
  const dias = Math.min(DIAS_VISITAS_MAX, Math.max(1, Math.floor(Number(o.diasVisitas) || DIAS_VISITAS)));
  const ir = prazoEmSequencia(Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS, Number(o.prazoPedidoMs) > 0 ? Number(o.prazoPedidoMs) : PRAZO_PEDIDO_MS);
  const semTempo = () => ({ erro: 'o prazo da consulta acabou antes deste pedido' });
  const tk = await ir(async () => ({ token: typeof o.garantirTokenML === 'function' ? await o.garantirTokenML() : null }), () => ({ erro: 'a renovação do token não respondeu no prazo' }), semTempo).catch((e) => ({ erro: String((e && e.message) || e).slice(0, 100) }));
  if (tk.erro) return { ok: false, erro: 'o acesso ao Mercado Livre não está disponível (' + tk.erro + ')' };
  if (!tk.token) return { ok: false, erro: 'esta loja está sem acesso ao Mercado Livre agora' };
  const get = (caminho, versao) => ir(async (sinal) => {
    const cab = { Authorization: 'Bearer ' + tk.token }; if (versao === 2) cab['api-version'] = '2';
    const r = await o.fetch(ML + caminho, { method: 'GET', headers: cab, signal: sinal });
    if (!r || !r.ok) return { erro: 'o Mercado Livre respondeu HTTP ' + (r ? r.status : '?') };
    let d = null; try { d = await r.json(); } catch (e) { d = null; }
    return d && typeof d === 'object' ? { corpo: d } : { erro: 'o Mercado Livre respondeu sem JSON' };
  }, () => ({ erro: 'o Mercado Livre não respondeu no prazo' }), semTempo).catch((e) => ({ erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));

  const eu = await get('/users/me');
  const id = eu.corpo && /^\d+$/.test(String(eu.corpo.id)) ? String(eu.corpo.id) : null;
  if (!id) return { ok: false, erro: 'o Mercado Livre não disse de quem é a conta (' + (eu.erro || 'a resposta veio sem o id') + ')' };
  const site = eu.corpo && /^[A-Z]{3}$/.test(String(eu.corpo.site_id)) ? String(eu.corpo.site_id) : null;
  const idsDe = (c) => ((c && Array.isArray(c.results)) ? c.results : []).filter((x) => typeof x === 'string' && ID_ITEM.test(x));
  const campos = 'id,title,status,sub_status,available_quantity,sold_quantity,price,user_product_id,seller_custom_field,shipping,health,listing_type_id,attributes,variations';
  const periodo = (() => { const h = o.hoje || new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10); const d = new Date(Date.parse(h + 'T12:00:00Z') - dias * 86400000).toISOString().slice(0, 10); return 'date_from=' + d + '&date_to=' + h; })();
  const porSku = [];
  for (const sku of skus) {
    const faltou = [];
    const falha = (oQue, r) => { if (r.erro) faltou.push({ o_que: oQue, motivo: r.erro }); return r.corpo || null; };
    const b1 = await get('/users/' + id + '/items/search?sku=' + encodeURIComponent(sku) + '&limit=' + MAX_ANUNCIOS_POR_SKU);
    const b2 = await get('/users/' + id + '/items/search?seller_sku=' + encodeURIComponent(sku) + '&limit=' + MAX_ANUNCIOS_POR_SKU);
    const c1 = falha('a busca dos anúncios pelo SKU (campo sku)', b1), c2 = falha('a busca dos anúncios pelo SKU (atributo seller_sku)', b2);
    if (!c1 && !c2) { porSku.push({ sku, anuncios_encontrados: null, anuncios: [], faltou }); continue; }
    const ids = Array.from(new Set(idsDe(c1).concat(idsDe(c2))));
    const total = Math.max(contagem(c1 && c1.paging && c1.paging.total) || 0, contagem(c2 && c2.paging && c2.paging.total) || 0, ids.length);
    const anuncios = [];
    for (const item of ids.slice(0, MAX_ANUNCIOS_POR_SKU)) {
      const det = falha('o detalhe do anúncio ' + item, await get('/items?ids=' + item + '&attributes=' + campos + '&include_attributes=all'));
      const corpo = Array.isArray(det) && det[0] && det[0].body && typeof det[0].body === 'object' ? det[0].body : null;
      if (det && !corpo) faltou.push({ o_que: 'o detalhe do anúncio ' + item, motivo: 'a resposta veio sem o corpo do anúncio' });
      const a = resumirAnuncioML(corpo) || { anuncio: item };
      a.visitas = resumirVisitas(falha('as visitas do anúncio ' + item, await get('/items/' + item + '/visits/time_window?last=' + dias + '&unit=day')));
      a.promocoes = resumirPromocoes(falha('as promoções do anúncio ' + item, await get('/seller-promotions/items/' + item + '?app_version=v2')));
      a.qualidade = resumirQualidade(falha('a qualidade do anúncio ' + item, await get('/item/' + item + '/performance')));
      /* o estoque por local: do produto do anúncio ou, com variação, da primeira variação que tiver o código */
      const up = a.codigo_do_produto || ((a.variacoes || []).find((v) => v.codigo_do_produto) || {}).codigo_do_produto || null;
      a.estoque_por_local = up ? resumirEstoque(falha('o estoque por local do anúncio ' + item, await get('/user-products/' + up + '/stock'))) : null;
      if (!up) faltou.push({ o_que: 'o estoque por local do anúncio ' + item, motivo: 'o anúncio não trouxe o código do produto (user_product_id)' });
      a.estoque_por_local_e_de = up && a.codigo_do_produto ? 'anúncio' : (up ? 'primeira variação com código' : null);
      a.product_ads = site ? resumirAds(falha('o anúncio ' + item + ' em Product Ads', await get('/marketplace/advertising/' + site + '/product_ads/ads/' + item + '?' + periodo + '&metrics=clicks,prints,cost,acos,total_amount', 2))) : null;
      anuncios.push(a);
    }
    porSku.push({ sku, anuncios_encontrados: total, anuncios_lidos: anuncios.length, anuncios, faltou });
  }
  return { ok: true, dias_de_visitas: dias, por_sku: porSku };
}

/* ═══ SHOPEE ═══ */
function resumirAnuncioShopee(x, extra) {
  if (!x || typeof x !== 'object') return null;
  const st = x.stock_info_v2 || {};
  const soma = (lista) => (Array.isArray(lista) ? lista.filter((l) => l && typeof l === 'object' && contagem(l.stock) != null) : null);
  const galpao = soma(st.seller_stock), full = soma(st.shopee_stock);
  const preco = (x.price_info && x.price_info[0]) || {};
  const e = extra && typeof extra === 'object' ? extra : null;
  return { anuncio: x.item_id != null ? String(x.item_id) : null, titulo: texto(x.item_name), situacao: texto(x.item_status), sku_do_anuncio: texto(x.item_sku),
    preco: numero(preco.current_price), preco_original: numero(preco.original_price),
    estoque: { galpao: galpao ? galpao.reduce((t, l) => t + l.stock, 0) : null, full_shopee: full ? full.filter((l) => texto(l.location_id)).reduce((t, l) => t + l.stock, 0) : null,
      full_por_centro: full ? full.filter((l) => texto(l.location_id)).map((l) => ({ centro: l.location_id, estoque: l.stock })) : null, reservado: st.summary_info ? contagem(st.summary_info.total_reserved_stock) : null },
    rebaixado_na_busca: x.deboost === 'TRUE' ? true : (x.deboost === 'FALSE' ? false : null), tem_variacao: typeof x.has_model === 'boolean' ? x.has_model : null,
    acumulado: e ? { vendidos: contagem(e.sale), visitas: contagem(e.views), curtidas: contagem(e.likes), nota: numero(e.rating_star), avaliacoes: contagem(e.comment_count) } : null };
}
async function consultarShopee(o) {
  if (!o || typeof o.pedirAoSync !== 'function') return { ok: false, erro: 'esta loja não tem a Shopee ligada ao dashboard' };
  const skus = skusPedidos(o.skus);
  if (!skus.length) return { ok: false, erro: 'nenhum SKU válido pedido' };
  const ir = prazoEmSequencia(Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS, Number(o.prazoPedidoMs) > 0 ? Number(o.prazoPedidoMs) : PRAZO_PEDIDO_MS);
  /* um pedido pelo serviço que tem o token: { corpo } (o `response` da Shopee) ou { erro } — `ok: false` do serviço é recusa */
  const pedir = async (caminho, q) => {
    const r = await ir(() => o.pedirAoSync('shopee-raw', { caminho, q }), () => ({ ok: false, erro: 'a Shopee não respondeu no prazo' }), () => ({ ok: false, erro: 'o prazo da consulta acabou antes deste pedido' }))
      .catch((e) => ({ ok: false, erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));
    const dados = (r && r.dados) || null;
    const corpo = dados ? (dados.resposta !== undefined ? dados.resposta : dados) : null;
    const erroShopee = corpo && corpo.error ? String(corpo.error) + (corpo.message ? ' — ' + String(corpo.message).slice(0, 160) : '') : null;
    if (r && r.ok === false) return { erro: (r.erro && String(r.erro)) || (dados && dados.erro && String(dados.erro)) || erroShopee || ('o serviço da Shopee respondeu HTTP ' + (r.status != null ? r.status : '?')) };
    if (erroShopee) return { erro: erroShopee };
    return corpo && corpo.response && typeof corpo.response === 'object' ? { corpo: corpo.response } : { erro: 'a Shopee respondeu sem conteúdo' };
  };
  const porSku = [];
  for (const sku of skus) {
    const faltou = [];
    const falha = (oQue, r) => { if (r.erro) faltou.push({ o_que: oQue, motivo: r.erro }); return r.erro ? null : r.corpo; };
    const busca = falha('a busca dos anúncios pelo SKU', await pedir('/api/v2/product/search_item', 'offset=0&page_size=' + MAX_ANUNCIOS_POR_SKU + '&item_sku=' + encodeURIComponent(sku)));
    if (!busca) { porSku.push({ sku, anuncios_encontrados: null, anuncios: [], faltou }); continue; }
    const ids = (Array.isArray(busca.item_id_list) ? busca.item_id_list : []).map((x) => String(x)).filter((x) => ID_SHOPEE.test(x)).slice(0, MAX_ANUNCIOS_POR_SKU);
    const anuncios = [];
    if (ids.length) {
      const lista = ids.join(',');
      const base = falha('o detalhe dos anúncios', await pedir('/api/v2/product/get_item_base_info', 'item_id_list=' + lista));
      const extra = falha('visitas, vendas e avaliação dos anúncios', await pedir('/api/v2/product/get_item_extra_info', 'item_id_list=' + lista));
      const promo = falha('as promoções dos anúncios', await pedir('/api/v2/product/get_item_promotion', 'item_id_list=' + lista));
      const itens = base && Array.isArray(base.item_list) ? base.item_list : [];
      const extras = extra && Array.isArray(extra.item_list) ? extra.item_list : [];
      for (const idA of ids) {
        const x = itens.find((i) => i && String(i.item_id) === idA);
        const e = extras.find((i) => i && String(i.item_id) === idA);
        const a = resumirAnuncioShopee(x, e) || { anuncio: idA, acumulado: e ? resumirAnuncioShopee({ item_id: idA }, e).acumulado : null };
        if (base && !x) faltou.push({ o_que: 'o detalhe do anúncio ' + idA, motivo: 'a Shopee não devolveu este anúncio na lista' });
        a.promocoes_como_a_shopee_mandou = promo ? require('./sondas-marketplace').encolher(promo) : null;
        anuncios.push(a);
      }
    }
    porSku.push({ sku, anuncios_encontrados: contagem(busca.total_count) != null ? busca.total_count : ids.length, anuncios_lidos: anuncios.length, anuncios, faltou });
  }
  return { ok: true, por_sku: porSku };
}

module.exports = { consultarML, consultarShopee, resumirAnuncioML, resumirVisitas, resumirPromocoes, resumirQualidade, resumirEstoque, resumirAds, resumirAnuncioShopee, skusPedidos,
  MAX_SKUS, MAX_ANUNCIOS_POR_SKU, MAX_VARIACOES, MAX_PENDENCIAS, DIAS_VISITAS, DIAS_VISITAS_MAX, PRAZO_MS, PRAZO_PEDIDO_MS };
