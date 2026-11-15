'use strict';
/* 15/11 — UM PRODUTO DE PERTO (lib/checkout/anuncio-produto.js): por SKU, os anúncios no Mercado Livre e na Shopee —
   situação, estoque por local, variações, visitas, promoções, qualidade, Ads —, ligados ao chat (anuncios_do_item).

   Os formatos são os REAIS, da 2ª rodada da sonda (#888) rodada em 15/11: Girassol no ML (as Lixas Disco, com 17
   variações; a Politriz do Full), AMB e GOOD na Shopee (a Luminária com estoque no Full da Shopee; a Arandela sem).

   O que se prova (as peças de produção, com o ML e o serviço da Shopee de mentira):
   A. ML: o resumo sai do formato real (anúncio com variação: SKU/estoque/vendidos de cada; estoque por local com e sem a
      linha do Full; visitas só nos dias listados; promoção "candidate" é PODE ENTRAR, não "está"; qualidade com as
      pendências; Ads idle/campanha 0 = fora de campanha); a consulta busca pelos DOIS campos de SKU, lê poucos
      anúncios por SKU e poucos SKUs, só GET com o token da loja; parte que falha fica nula e dita; SKU sem anúncio diz
      zero (não erra); prazos.
   B. SHOPEE: o resumo sai do formato real (estoque galpão × Full por centro; acumulados; rebaixado); tudo pelo repasse
      cru, só leitura de anúncio; `ok: false` do serviço é recusa; a promoção sai crua (formato não conferido).
   C. PELO CHAT: a consulta pede os dois canais com as peças da empresa; canal sem peça é dito; avisos (SKU sem anúncio,
      mais anúncios que os lidos, o que faltou); teto de SKUs; a lista de consultas tem 7.
   D. PELA ROTA DE VERDADE: a consulta vai pro modelo e roda com as peças DA EMPRESA, sem dado de gente. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-rota-'));
process.env.ADMIN_KEY = 'chave-adm'; process.env.GOODBKP_ADMIN = 'dono'; process.env.GOODBKP_CACHE_DIR = TMP; process.env.AMBBKP_CACHE_DIR = path.join(TMP, 'amb'); process.env.GIRABKP_CACHE_DIR = path.join(TMP, 'gira'); process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tk'); process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;
const rede = { api: [], roteiro: [], ml: [], mlResposta: null };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) { rede.api.push(JSON.parse(opts.body)); const t = rede.roteiro.shift(); if (!t) throw new Error('a API foi chamada mais vezes do que o roteiro previa'); return t; }
  if (url.startsWith('https://api.mercadolibre.com/')) { const c = url.replace('https://api.mercadolibre.com', ''); rede.ml.push([c, opts && opts.headers && opts.headers.Authorization]); return rede.mlResposta(c, opts); }
  return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
} };

const P = require('../lib/checkout/anuncio-produto');
const OLHOS = require('../lib/checkout/chat-olhos');
const { validarPeriodo } = require('../lib/checkout/chat-analise');
const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const copia = (x) => JSON.parse(JSON.stringify(x));
const nunca = () => new Promise(() => {});
const HOJE = '2026-11-15';
const J = (corpo, st) => ({ ok: !st || st < 300, status: st || 200, json: async () => corpo });

/* ── o Mercado Livre como respondeu de verdade (Girassol, 15/11) ── */
const VAR = (id, grao, qtd, vend, sku, gtin, up) => ({ id, price: 34.9, attribute_combinations: [{ id: null, name: 'GRÃO', value_id: null, value_name: grao, values: [{ id: null, name: grao }], value_type: 'string' }], available_quantity: qtd, sold_quantity: vend, sale_terms: [], picture_ids: ['966877-MLB84027402782_052025'],
  seller_custom_field: '', catalog_product_id: null, attributes: [{ id: 'GTIN', value_name: gtin }, { id: 'SELLER_SKU', value_name: sku }], inventory_id: null, item_relations: [], user_product_id: up });
const LIXAS = { id: 'MLB2927951211', title: '10 Lixas Disco 7 Pol. 180mm Grão Variado 8 Furos Vellcro Pro', user_product_id: null, price: 34.9, inventory_id: null, available_quantity: 3121, sold_quantity: 4860,
  shipping: { mode: 'me2', methods: [], tags: ['self_service_available', 'self_service_out'], dimensions: null, local_pick_up: false, free_shipping: false, logistic_type: 'cross_docking', store_pick_up: false }, attributes: [], listing_type_id: 'gold_pro',
  variations: [VAR(187807672869, '24', 161, 22, '10-furo-g24-180mm', '7898693943284', 'MLBU3161744712'), VAR(187807672871, '40', 0, 37, '10-furo-g40-180mm', '7898693943291', 'MLBU3156257425'), VAR(187807672873, '60', 0, 18, '10-furo-g60-180mm', '7898693943307', 'MLBU3156255945')],
  status: 'active', sub_status: [], seller_custom_field: '10-furo-180mm-PAI', health: 0.88 };
const POLITRIZ = { id: 'MLB1202555743', title: 'Lixadeira Politriz 1400w Angular 7 Oficina 220v Kaqi Sg-9180 220v', user_product_id: 'MLBU1785809978', inventory_id: 'EULX68999', available_quantity: 422, sold_quantity: 90, price: 899,
  shipping: { mode: 'me2', methods: [], tags: ['self_service_in', 'mandatory_free_shipping'], dimensions: null, local_pick_up: false, free_shipping: true, logistic_type: 'fulfillment', store_pick_up: false }, variations: [], status: 'active', sub_status: [], seller_custom_field: 'KAQI-9180-220', health: 0.9, attributes: [{ id: 'SELLER_SKU', value_name: 'KAQI-9180-220' }, { id: 'BRAND', value_name: 'Kaqi' }] };
const VISITAS = { item_id: 'MLB2927951211', date_from: '2026-11-08T00:00:00Z', date_to: '2026-11-15T00:00:00Z', total_visits: 6, last: 7, unit: 'day', results: [{ date: '2026-11-13T00:00:00Z', total: 1, visits_detail: [{ company: 'mercadolibre', quantity: 1 }] }, { date: '2026-11-09T00:00:00Z', total: 2, visits_detail: [] }, { date: '2026-11-11T00:00:00Z', total: 2 }, { date: '2026-11-10T00:00:00Z', total: 1 }] };
const PROMOS = [{ type: 'PRICE_DISCOUNT', status: 'candidate', price: 0, original_price: 34.9, name: '', min_discounted_price: 12.22, max_discounted_price: 33.15, suggested_discounted_price: 33.15 },
  { id: 'P-MLB17911004', type: 'DEAL', status: 'candidate', price: 0, original_price: 34.9, start_date: '2026-11-12T00:00:00-03:00', finish_date: '2026-12-01T00:00:00-03:00', name: 'Black Friday 2026', min_discounted_price: 6.99, max_discounted_price: 33.84, suggested_discounted_price: 30.35 }];
const QUALIDADE = { entity_type: 'ITEM', entity_id: 'MLB2927951211', score: 57, level: 'medium', calculated_at: '2026-11-14T09:58:05.838Z', level_wording: 'Satisfatória',
  buckets: [{ key: 'CHARACTERISTICS', type: 'ITEM', status: 'PENDING', score: 85.88235, title: 'Dados do produto', variables: [{ key: 'SHORTS', status: 'PENDING', score: 0, title: 'Crie vídeo para não perder vendas', rules: [] }, { key: 'TECHNICAL_SPECIFICATIONS_MAIN', status: 'COMPLETED', score: 100, title: 'Corrija as características', rules: [] }, { key: 'FISCAL_DATA', status: 'PENDING', score: 0, title: 'Preencha os dados fiscais para emitir faturas' }, null] },
    { key: 'OFFER', type: 'ITEM', status: 'PENDING', score: 15.000002, title: 'Condições de venda', variables: [{ key: 'FREE_SHIPPING', status: 'PENDING', score: 0, title: 'Ofereça frete grátis para que seu anúncio seja mais competitivo' }, { key: 'PRICE', status: 'PENDING', score: 0, title: 'Baixe o preço para recuperar a exposição do seu anúncio' }, { key: 'PROMOTIONS', status: 'PENDING', score: 0, title: 'Participe de uma promoção para receber mais visitas' }, { key: 'FINANCING', status: 'COMPLETED', score: 100, title: 'Ofereça parcelamento' }] }, 'lixo'] };
const ESTOQUE_GALPAO = { id: 'MLBU3161744712', user_id: 252698567, locations: [{ type: 'seller_warehouse', store_id: '49129163', quantity: 161, network_node_id: 'BRP2526985671', country_id: 'BR', status: 'active' }], last_updated: '2026-11-13T19:41:38Z', available_sites: ['MLB'], product_release_date: null, stock_mode: 'countable' };
const ESTOQUE_FULL = { id: 'MLBU1785809978', user_id: 252698567, locations: [{ type: 'seller_warehouse', store_id: '49129163', quantity: 422, network_node_id: 'BRP2526985671', country_id: 'BR', status: 'active' }, { type: 'meli_facility', availability_type: 'in_stock', quantity: 0 }], last_updated: '2026-11-14T15:12:10Z', available_sites: ['MLB'], product_release_date: null, stock_mode: 'countable' };
const ADS_IDLE = { item_id: 'MLB2927951211', campaign_id: 0, ad_group_id: 446434153, price: 34.9, title: '10 Lixas Disco 7 Pol.', status: 'idle', has_discount: false, logistic_type: 'cross_docking', listing_type_id: 'gold_pro', current_level: 'green', recommended: true, metrics: { clicks: 0, prints: 0, cost: 0, direct_amount: 0, indirect_amount: 0, total_amount: 0, acos: 0 } };
const ADS_HOLD = { item_id: 'MLB978621613', campaign_id: 294906605, ad_group_id: 1998497445, price: 492.69, status: 'hold', current_level: 'green', recommended: false, metrics: { clicks: 3, prints: 120, cost: 4.5, direct_amount: 0, indirect_amount: 492.69, total_amount: 492.69, acos: 0.91 } };
const BUSCA = (ids, total) => ({ seller_id: '252698567', results: ids, paging: { limit: 3, offset: 0, total: total == null ? ids.length : total }, query: null });

const mlDeMentira = (extra) => {
  const vistos = [];
  const fetch = async (url, opts) => {
    const c = String(url).replace('https://api.mercadolibre.com', '');
    vistos.push({ c, metodo: opts.method, cab: opts.headers, sinal: opts.signal, temCorpo: 'body' in opts });
    const r = extra ? extra(c, opts) : undefined; if (r !== undefined) return r;
    if (c === '/users/me') return J({ id: 252698567, site_id: 'MLB', nickname: 'MAGAZINEGIRASSOL', email: 'dono@loja.com' });
    if (c.includes('/items/search?sku=10-furo-180mm-PAI')) return J(BUSCA(['MLB2927973113', 'MLB2927951211'], 2));
    if (c.includes('/items/search?seller_sku=10-furo-180mm-PAI')) return J(BUSCA([], 0));
    if (c.includes('/items/search?sku=KAQI-9180-220')) return J(BUSCA([], 0));
    if (c.includes('/items/search?seller_sku=KAQI-9180-220')) return J(BUSCA(['MLB1202555743']));
    if (c.includes('/items/search?')) return J(BUSCA([], 0));
    if (c.startsWith('/items?ids=MLB2927951211')) return J([{ code: 200, body: copia(LIXAS) }]);
    if (c.startsWith('/items?ids=MLB2927973113')) return J([{ code: 200, body: Object.assign(copia(LIXAS), { id: 'MLB2927973113', status: 'paused', sub_status: ['out_of_stock'], available_quantity: 0, variations: [], seller_custom_field: '10-furo-180mm-PAI', user_product_id: 'MLBU999' }) }]);
    if (c.startsWith('/items?ids=MLB1202555743')) return J([{ code: 200, body: copia(POLITRIZ) }]);
    if (/^\/items\/[A-Z]{3}\d+\/visits\/time_window/.test(c)) return J(copia(VISITAS));
    if (c.startsWith('/seller-promotions/items/')) return J(copia(PROMOS));
    if (/^\/item\/[A-Z]{3}\d+\/performance$/.test(c)) return J(copia(QUALIDADE));
    if (c === '/user-products/MLBU1785809978/stock') return J(copia(ESTOQUE_FULL));
    if (c.startsWith('/user-products/')) return J(copia(ESTOQUE_GALPAO));
    if (/\/product_ads\/ads\/MLB1202555743/.test(c)) return J(copia(ADS_HOLD));
    if (/\/product_ads\/ads\//.test(c)) return J(copia(ADS_IDLE));
    return J({ message: 'caminho que o teste não previu: ' + c }, 500);
  };
  return { fetch, vistos, caminhos: () => vistos.map((v) => v.c) };
};

/* ── a Shopee como respondeu de verdade (AMB e GOOD, 15/11) ── */
const LUMINARIA = { item_id: 23899414754, category_id: 100719, item_name: 'Luminária Chão 177cm Piso Articulada Dupla para 2 Lâmpadas Pedestal Coluna Metal Fl 1011 Branco', description: 'Uma luminária…', item_sku: 'FL-1011-BRANCO', create_time: 1775745816, update_time: 1794335604, attribute_list: [],
  price_info: [{ currency: 'BRL', original_price: 149.9, current_price: 149.9 }], image: { image_id_list: [] }, weight: '5', item_status: 'NORMAL', has_model: false, promotion_id: 0, has_promotion: false, deboost: 'FALSE', is_fulfillment_by_shopee: false, tag: { kit: false },
  stock_info_v2: { summary_info: { total_reserved_stock: 0, total_available_stock: 913 }, seller_stock: [{ location_id: 'BRZ', stock: 906, if_saleable: true }], shopee_stock: [{ location_id: 'BRFSP1', stock: 3, if_saleable: true }, { location_id: 'BRFPE1', stock: 2, if_saleable: true }, { location_id: 'BRFGO1', stock: 1, if_saleable: true }, { location_id: 'BRFRS1', stock: 1, if_saleable: true }], advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 } } };
const ARANDELA = { item_id: 22897751519, item_name: 'Luminária Arandela Parede 360° LED 3x1 Barra Luz Indireta Gimpo KJBD-171-PRETO', item_sku: 'KJBD-171-PRETO-60', price_info: [{ currency: 'BRL', original_price: 197.9, current_price: 179.9 }], item_status: 'NORMAL', has_model: false, deboost: 'TRUE',
  stock_info_v2: { summary_info: { total_reserved_stock: 1, total_available_stock: 19 }, seller_stock: [{ location_id: 'BRZ', stock: 19, if_saleable: true }], shopee_stock: [{ location_id: '', stock: 0 }], advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 } } };
const EXTRA = { item_list: [{ item_id: 23899414754, sale: 164, views: 2371, likes: 556, rating_star: 4.831325301204819, comment_count: 83 }, { item_id: 22299462428, sale: 1, views: 10, likes: 0, rating_star: 0, comment_count: 0 }] };
const resp = (response) => ({ ok: true, status: 200, dados: { ok: true, resposta: { error: '', message: '', request_id: 'x', response } } });
const shDeMentira = (extra) => {
  const vistos = [];
  const pedirAoSync = async (oQue, params, loja) => {
    vistos.push([oQue, params.caminho, params.q, loja, Object.keys(params).sort().join(',')]);
    const r = extra ? extra(params.caminho, params.q) : undefined; if (r !== undefined) return r;
    const c = params.caminho, q = params.q;
    if (c.endsWith('/search_item')) return resp(q.includes('item_sku=FL-1011-BRANCO') ? { item_id_list: [23899414754, 22299462428], total_count: 2, next_offset: '' } : (q.includes('KJBD') ? { item_id_list: [22897751519], total_count: 1, next_offset: '' } : { item_id_list: [], total_count: 0, next_offset: '' }));
    if (c.endsWith('/get_item_base_info')) return resp({ item_list: [copia(LUMINARIA), copia(ARANDELA)].filter((x) => q.includes(String(x.item_id))) });
    if (c.endsWith('/get_item_extra_info')) return resp({ item_list: EXTRA.item_list.filter((x) => q.includes(String(x.item_id))) });
    if (c.endsWith('/get_item_promotion')) return resp({ success_list: q.split('item_id_list=')[1].split(',').map((i) => ({ item_id: Number(i) })) });
    return { ok: false, status: 500, erro: 'pedido que o teste não previu: ' + c };
  };
  return { pedirAoSync, vistos, pedidos: () => vistos.map((v) => v[1] + '?' + v[2]) };
};

(async () => {
  /* ═══ A. MERCADO LIVRE ═══ */
  {
    /* A1. o anúncio com variação, do formato real */
    const a = P.resumirAnuncioML(copia(LIXAS));
    assert.deepStrictEqual(a, { anuncio: 'MLB2927951211', titulo: '10 Lixas Disco 7 Pol. 180mm Grão Variado 8 Furos Vellcro Pro', situacao: 'active', sub_situacao: [], preco: 34.9, estoque_anunciado: 3121, vendidos_total: 4860, saude: 0.88,
      sku_do_anuncio: '10-furo-180mm-PAI', codigo_do_produto: null, logistica: 'cross_docking', frete_gratis: false, tipo_de_anuncio: 'gold_pro', variacoes_total: 3,
      variacoes: [{ id: '187807672869', sku: '10-furo-g24-180mm', nome: 'GRÃO: 24', estoque: 161, vendidos_total: 22, preco: 34.9, codigo_do_produto: 'MLBU3161744712' }, { id: '187807672871', sku: '10-furo-g40-180mm', nome: 'GRÃO: 40', estoque: 0, vendidos_total: 37, preco: 34.9, codigo_do_produto: 'MLBU3156257425' }, { id: '187807672873', sku: '10-furo-g60-180mm', nome: 'GRÃO: 60', estoque: 0, vendidos_total: 18, preco: 34.9, codigo_do_produto: 'MLBU3156255945' }] }, 'o anúncio com variação não saiu do formato real');
    const b = P.resumirAnuncioML(copia(POLITRIZ));
    assert.deepStrictEqual([b.sku_do_anuncio, b.codigo_do_produto, b.logistica, b.frete_gratis, b.variacoes_total, b.variacoes], ['KAQI-9180-220', 'MLBU1785809978', 'fulfillment', true, 0, []]);
    /* o que não veio fica nulo; variação torta; teto de variações */
    const t = P.resumirAnuncioML({ id: 'MLB1', price: '12.5', available_quantity: -1, sold_quantity: 2.5, health: 'x', shipping: 'lixo', sub_status: ['a', 7, null], seller_custom_field: '', attributes: [{ id: 'SELLER_SKU', value_name: 'ATR' }], user_product_id: 'MLB1', variations: [null, 'lixo', { id: 5, attributes: 'lixo', attribute_combinations: [{ value_name: 'Azul' }, null, { name: 'Tam', value_name: null }], available_quantity: '3' }] });
    assert.deepStrictEqual([t.preco, t.estoque_anunciado, t.vendidos_total, t.saude, t.logistica, t.frete_gratis, t.sub_situacao, t.sku_do_anuncio, t.codigo_do_produto, t.variacoes_total, t.variacoes], [12.5, null, null, null, null, null, ['a'], 'ATR', null, 1, [{ id: '5', sku: null, nome: 'Azul / Tam: ?', estoque: null, vendidos_total: null, preco: null, codigo_do_produto: null }]]);
    /* variação com o SKU no campo antigo; código do produto fora do formato; variações que não são lista; frete e recomendado que não são booleanos */
    const v2 = P.resumirAnuncioML({ id: 'MLB2', variations: [{ id: 1, attributes: [], seller_custom_field: 'V-CAMPO', user_product_id: 'MLB1' }], shipping: { free_shipping: 'true' } });
    assert.deepStrictEqual([v2.variacoes[0].sku, v2.variacoes[0].codigo_do_produto, v2.frete_gratis, P.resumirAnuncioML({ id: 'MLB3', variations: 'lixo' }).variacoes, P.resumirAnuncioML({ id: 'MLB3', shipping: 7 }).logistica], ['V-CAMPO', null, null, [], null]);
    assert.deepStrictEqual([P.resumirAnuncioML(null), P.resumirAnuncioML('x'), P.resumirAnuncioML({ variations: Array.from({ length: P.MAX_VARIACOES + 3 }, (_, i) => ({ id: i })) }).variacoes.length, P.resumirAnuncioML({ variations: Array.from({ length: P.MAX_VARIACOES + 3 }, (_, i) => ({ id: i })) }).variacoes_total, P.resumirAnuncioML({ attribute_combinations: [] }).variacoes], [null, null, P.MAX_VARIACOES, P.MAX_VARIACOES + 3, []]);
    assert.ok(P.MAX_VARIACOES >= 17 && P.MAX_VARIACOES <= 50, 'as Lixas têm 17 variações: todas têm que caber');
    /* A2. as visitas: só os dias listados, em ordem; dia que não veio NÃO é zero */
    assert.deepStrictEqual(P.resumirVisitas(copia(VISITAS)), { total: 6, de: '2026-11-08', ate: '2026-11-15', por_dia: [{ dia: '2026-11-09', visitas: 2 }, { dia: '2026-11-10', visitas: 1 }, { dia: '2026-11-11', visitas: 2 }, { dia: '2026-11-13', visitas: 1 }], dias_listados: 4 });
    assert.deepStrictEqual([P.resumirVisitas(null), P.resumirVisitas({ total_visits: 3 }), P.resumirVisitas({ results: [null, 'x', { date: 'ontem', total: 1 }, { date: '2026-11-01T00:00:00Z', total: '2' }, { date: '2026-11-02T00:00:00Z', total: 0 }] })], [null, null, { total: null, de: null, ate: null, por_dia: [{ dia: '2026-11-02', visitas: 0 }], dias_listados: 1 }]);
    /* A3. promoções: "candidate" é PODE ENTRAR, não "está" */
    assert.deepStrictEqual(P.resumirPromocoes(copia(PROMOS)), { participando: [], pode_entrar: [{ id: null, tipo: 'PRICE_DISCOUNT', nome: null, situacao: 'candidate', comeca: null, termina: null, preco_sugerido: 33.15, preco_na_promocao: null },
      { id: 'P-MLB17911004', tipo: 'DEAL', nome: 'Black Friday 2026', situacao: 'candidate', comeca: '2026-11-12T00:00:00-03:00', termina: '2026-12-01T00:00:00-03:00', preco_sugerido: 30.35, preco_na_promocao: null }] });
    assert.deepStrictEqual(P.resumirPromocoes([{ id: 'P1', type: 'DEAL', status: 'started', price: 29.9 }, null, 'x', { type: 'SMART', status: 'pending' }, { type: 'X' }]), { participando: [{ id: 'P1', tipo: 'DEAL', nome: null, situacao: 'started', comeca: null, termina: null, preco_sugerido: null, preco_na_promocao: 29.9 }, { id: null, tipo: 'SMART', nome: null, situacao: 'pending', comeca: null, termina: null, preco_sugerido: null, preco_na_promocao: null }], pode_entrar: [] });
    assert.deepStrictEqual([P.resumirPromocoes(null), P.resumirPromocoes({ results: [] }), P.resumirPromocoes([])], [null, null, { participando: [], pode_entrar: [] }]);
    /* A4. qualidade: a nota e o que falta */
    assert.deepStrictEqual(P.resumirQualidade(copia(QUALIDADE)), { nota: 57, nivel: 'Satisfatória', calculada_em: '2026-11-14T09:58:05.838Z', pendencias_total: 5, pendencias: [{ area: 'Dados do produto', o_que: 'Crie vídeo para não perder vendas' }, { area: 'Dados do produto', o_que: 'Preencha os dados fiscais para emitir faturas' }, { area: 'Condições de venda', o_que: 'Ofereça frete grátis para que seu anúncio seja mais competitivo' }, { area: 'Condições de venda', o_que: 'Baixe o preço para recuperar a exposição do seu anúncio' }, { area: 'Condições de venda', o_que: 'Participe de uma promoção para receber mais visitas' }] });
    const muitas = { score: 10, level: 'low', buckets: [{ title: 'A', variables: Array.from({ length: P.MAX_PENDENCIAS + 4 }, (_, i) => ({ status: 'PENDING', title: 'p' + i })) }] };
    assert.deepStrictEqual(P.resumirQualidade({ score: 1, buckets: [{ title: 'A', variables: [{ status: 'PENDING' }, { status: 'PENDING', title: '' }, { status: 'PENDING', title: 'x' }] }, { title: 'B', variables: 'lixo' }, 7, null] }).pendencias, [{ area: 'A', o_que: 'x' }], 'pendência sem título não entra; bucket torto não derruba');
    assert.deepStrictEqual([P.resumirQualidade(muitas).pendencias.length, P.resumirQualidade(muitas).pendencias_total, P.resumirQualidade(muitas).nivel, P.resumirQualidade(null), P.resumirQualidade({}), P.resumirQualidade({ buckets: 'x' }).pendencias], [P.MAX_PENDENCIAS, P.MAX_PENDENCIAS + 4, 'low', null, { nota: null, nivel: null, calculada_em: null, pendencias_total: 0, pendencias: [] }, []]);
    /* A5. estoque por local: o Full é a linha meli_facility; sem ela, NÃO está no Full */
    assert.deepStrictEqual(P.resumirEstoque(copia(ESTOQUE_GALPAO)), { galpao: 161, full: null, tem_linha_do_full: false, atualizado_em: '2026-11-13T19:41:38Z' });
    assert.deepStrictEqual(P.resumirEstoque(copia(ESTOQUE_FULL)), { galpao: 422, full: 0, tem_linha_do_full: true, atualizado_em: '2026-11-14T15:12:10Z' });
    assert.deepStrictEqual([P.resumirEstoque({ locations: [{ type: 'meli_facility', quantity: 5 }, { type: 'meli_facility', quantity: 7 }, null, { type: 'seller_warehouse', quantity: '9' }] }), P.resumirEstoque(null), P.resumirEstoque({ locations: 'x' })], [{ galpao: 0, full: 12, tem_linha_do_full: true, atualizado_em: null }, null, null]);
    /* A6. Ads: campanha 0 / idle = fora de campanha; nulo quando não dá pra dizer */
    assert.deepStrictEqual(P.resumirAds(copia(ADS_IDLE)), { situacao: 'idle', em_campanha: false, campanha_id: 0, nivel: 'green', recomendado: true, periodo: { cliques: 0, impressoes: 0, custo: 0, vendas_atribuidas: 0, acos: 0 } });
    assert.deepStrictEqual(P.resumirAds(copia(ADS_HOLD)), { situacao: 'hold', em_campanha: true, campanha_id: 294906605, nivel: 'green', recomendado: false, periodo: { cliques: 3, impressoes: 120, custo: 4.5, vendas_atribuidas: 492.69, acos: 0.91 } });
    assert.deepStrictEqual([P.resumirAds({ recommended: 'yes', metrics: 'x' }).recomendado, P.resumirAds({ recommended: 'yes', metrics: 'x' }).periodo.cliques], [null, null]);
    assert.deepStrictEqual([P.resumirAds({ status: 'x' }), P.resumirAds(null)], [{ situacao: 'x', em_campanha: null, campanha_id: null, nivel: null, recomendado: null, periodo: { cliques: null, impressoes: null, custo: null, vendas_atribuidas: null, acos: null } }, null]);

    /* A7. a consulta: pelos DOIS campos de SKU, poucos anúncios, só GET com o token */
    const ml = mlDeMentira();
    const r = await P.consultarML({ garantirTokenML: async () => 'tk-loja', fetch: ml.fetch, skus: ['10-furo-180mm-PAI', ' KAQI-9180-220 ', 'NAO-EXISTE'], hoje: HOJE });
    assert.deepStrictEqual([r.ok, r.dias_de_visitas, r.por_sku.length, r.por_sku.map((p) => [p.sku, p.anuncios_encontrados, p.anuncios_lidos, p.faltou])], [true, 7, 3, [['10-furo-180mm-PAI', 2, 2, []], ['KAQI-9180-220', 1, 1, []], ['NAO-EXISTE', 0, 0, []]]]);
    const PER = 'date_from=2026-11-08&date_to=2026-11-15&metrics=clicks,prints,cost,acos,total_amount';
    const CAMPOS = 'id,title,status,sub_status,available_quantity,sold_quantity,price,user_product_id,seller_custom_field,shipping,health,listing_type_id,attributes,variations&include_attributes=all';
    const porItem = (it) => ['/items?ids=' + it + '&attributes=' + CAMPOS, '/items/' + it + '/visits/time_window?last=7&unit=day', '/seller-promotions/items/' + it + '?app_version=v2', '/item/' + it + '/performance'];
    assert.deepStrictEqual(ml.caminhos(), ['/users/me',
      '/users/252698567/items/search?sku=10-furo-180mm-PAI&limit=3', '/users/252698567/items/search?seller_sku=10-furo-180mm-PAI&limit=3',
      ...porItem('MLB2927973113'), '/user-products/MLBU999/stock', '/marketplace/advertising/MLB/product_ads/ads/MLB2927973113?' + PER,
      ...porItem('MLB2927951211'), '/user-products/MLBU3161744712/stock', '/marketplace/advertising/MLB/product_ads/ads/MLB2927951211?' + PER,
      '/users/252698567/items/search?sku=KAQI-9180-220&limit=3', '/users/252698567/items/search?seller_sku=KAQI-9180-220&limit=3',
      ...porItem('MLB1202555743'), '/user-products/MLBU1785809978/stock', '/marketplace/advertising/MLB/product_ads/ads/MLB1202555743?' + PER,
      '/users/252698567/items/search?sku=NAO-EXISTE&limit=3', '/users/252698567/items/search?seller_sku=NAO-EXISTE&limit=3'], 'a sequência de pedidos ao Mercado Livre mudou');
    assert.ok(ml.vistos.every((v) => v.metodo === 'GET' && v.cab.Authorization === 'Bearer tk-loja' && v.sinal && !v.temCorpo) && ml.vistos.filter((v) => v.cab['api-version'] === '2').length === 3 && ml.vistos.filter((v) => v.cab['api-version']).length === 3, 'só GET com o token da loja; versão 2 só em Product Ads');
    assert.ok(!ml.caminhos().some((c) => /\/orders|\/shipments|\/messages|\/claims|\/payments/.test(c)) && !/dono@loja|tk-loja/.test(JSON.stringify(r)));
    /* o anúncio com variação: o estoque por local vem da PRIMEIRA variação com código (e isso é dito) */
    const lixas = r.por_sku[0].anuncios[1], pausado = r.por_sku[0].anuncios[0], politriz = r.por_sku[1].anuncios[0];
    assert.deepStrictEqual([lixas.anuncio, lixas.situacao, lixas.variacoes.length, lixas.estoque_por_local, lixas.estoque_por_local_e_de, lixas.visitas.total, lixas.promocoes.pode_entrar.length, lixas.promocoes.participando, lixas.qualidade.nota, lixas.product_ads.em_campanha],
      ['MLB2927951211', 'active', 3, { galpao: 161, full: null, tem_linha_do_full: false, atualizado_em: '2026-11-13T19:41:38Z' }, 'primeira variação com código', 6, 2, [], 57, false]);
    assert.deepStrictEqual([pausado.anuncio, pausado.situacao, pausado.sub_situacao, pausado.estoque_anunciado, pausado.estoque_por_local_e_de], ['MLB2927973113', 'paused', ['out_of_stock'], 0, 'anúncio']);
    assert.deepStrictEqual([politriz.logistica, politriz.estoque_por_local, politriz.product_ads.em_campanha, politriz.product_ads.campanha_id], ['fulfillment', { galpao: 422, full: 0, tem_linha_do_full: true, atualizado_em: '2026-11-14T15:12:10Z' }, true, 294906605]);
    /* A8. parte que falha fica nula e DITA; sem código do produto o estoque por local é dito; o resto do anúncio segue */
    {
      const m = mlDeMentira((c) => { if (/visits/.test(c)) return J({}, 500); if (/performance/.test(c)) throw new Error('ECONNRESET'); if (/product_ads/.test(c)) return J({ error: 'not found' }, 404); if (c.startsWith('/items?ids=MLB2927951211')) return J([{ code: 200, body: Object.assign(copia(LIXAS), { variations: [], user_product_id: null }) }]); return undefined; });
      const r2 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m.fetch, skus: ['10-furo-180mm-PAI'], hoje: HOJE });
      const a2 = r2.por_sku[0].anuncios[1];
      assert.deepStrictEqual([a2.visitas, a2.qualidade, a2.product_ads, a2.estoque_por_local, a2.estoque_por_local_e_de, a2.promocoes.pode_entrar.length], [null, null, null, null, null, 2]);
      assert.deepStrictEqual(r2.por_sku[0].faltou.filter((f) => /MLB2927951211/.test(f.o_que)), [{ o_que: 'as visitas do anúncio MLB2927951211', motivo: 'o Mercado Livre respondeu HTTP 500' }, { o_que: 'a qualidade do anúncio MLB2927951211', motivo: 'não respondeu (ECONNRESET)' }, { o_que: 'o estoque por local do anúncio MLB2927951211', motivo: 'o anúncio não trouxe o código do produto (user_product_id)' }, { o_que: 'o anúncio MLB2927951211 em Product Ads', motivo: 'o Mercado Livre respondeu HTTP 404' }]);
      /* o detalhe não veio: o anúncio sai só com o id, e o resto é lido mesmo assim */
      /* (Codex #890) o multiget diz o status DE CADA item: 404 com corpo de erro NÃO é anúncio — o id pedido fica, e o 404 é dito */
      for (const [linha, motivo] of [[{ code: 404, body: { message: 'Item not found', error: 'not_found', status: 404 } }, 'o Mercado Livre respondeu 404 pra este anúncio (Item not found)'], [{ code: 404, body: null }, 'o Mercado Livre respondeu 404 pra este anúncio'], [{ code: 200 }, 'a resposta veio sem o corpo do anúncio'], [{ body: { id: 'X' } }, 'a resposta veio sem o corpo do anúncio'], [null, 'a resposta veio sem o corpo do anúncio'], ['lixo', 'a resposta veio sem o corpo do anúncio']]) {
        const m3 = mlDeMentira((c) => (c.startsWith('/items?ids=MLB1202555743') ? J([linha]) : undefined));
        const r3 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m3.fetch, skus: ['KAQI-9180-220'], hoje: HOJE });
        assert.deepStrictEqual([r3.por_sku[0].anuncios[0].anuncio, r3.por_sku[0].anuncios[0].situacao, r3.por_sku[0].anuncios[0].visitas.total, r3.por_sku[0].faltou.map((f) => f.motivo)], ['MLB1202555743', undefined, 6, [motivo, 'o anúncio não trouxe o código do produto (user_product_id)']], JSON.stringify(linha));
      }
      assert.strictEqual((await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.startsWith('/items?ids=MLB1202555743') ? J([{ code: 299, body: copia(POLITRIZ) }]) : undefined)).fetch, skus: ['KAQI-9180-220'], hoje: HOJE })).por_sku[0].anuncios[0].situacao, 'active');
      const m3b = mlDeMentira((c) => (c.startsWith('/items?ids=MLB1202555743') ? J({ message: 'erro' }, 500) : undefined));
      const r3b = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m3b.fetch, skus: ['KAQI-9180-220'], hoje: HOJE });
      assert.deepStrictEqual(r3b.por_sku[0].faltou[0], { o_que: 'o detalhe do anúncio MLB1202555743', motivo: 'o Mercado Livre respondeu HTTP 500' });
      /* as duas buscas falharam: o SKU fica sem anúncios (nulo, não zero) e dito */
      const m4 = mlDeMentira((c) => (c.includes('/items/search?') ? J({}, 503) : undefined));
      const r4 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m4.fetch, skus: ['X'], hoje: HOJE });
      assert.deepStrictEqual(r4.por_sku, [{ sku: 'X', anuncios_encontrados: null, busca_incompleta: true, anuncios_lidos: 0, anuncios: [], faltou: [{ o_que: 'a busca dos anúncios pelo SKU (campo sku)', motivo: 'o Mercado Livre respondeu HTTP 503' }, { o_que: 'a busca dos anúncios pelo SKU (atributo seller_sku)', motivo: 'o Mercado Livre respondeu HTTP 503' }] }]);
      /* uma busca falhou e a outra achou: lê o que achou, diz a que falhou e marca a busca como incompleta */
      const m5 = mlDeMentira((c) => (c.includes('seller_sku=10-furo') ? J({}, 503) : undefined));
      const r5 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m5.fetch, skus: ['10-furo-180mm-PAI'], hoje: HOJE });
      assert.deepStrictEqual([r5.por_sku[0].anuncios_encontrados, r5.por_sku[0].busca_incompleta, r5.por_sku[0].anuncios_lidos, r5.por_sku[0].faltou.length], [2, true, 2, 1]);
      /* (Codex #890) uma busca falhou e a outra NÃO achou: não se sabe — nulo, não zero */
      const m5b = mlDeMentira((c) => (c.includes('seller_sku=NAO-EXISTE') ? J({}, 503) : undefined));
      const r5b = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m5b.fetch, skus: ['NAO-EXISTE'], hoje: HOJE });
      assert.deepStrictEqual([r5b.por_sku[0].anuncios_encontrados, r5b.por_sku[0].busca_incompleta, r5b.por_sku[0].anuncios_lidos, r5b.por_sku[0].faltou.length, r.por_sku[2].busca_incompleta, r.por_sku[0].busca_incompleta], [null, true, 0, 1, false, false]);
      /* o SKU tem mais anúncios que o teto: lê o teto, diz o total; ids repetidos nas duas buscas não dobram; id torto não vira caminho */
      const m6 = mlDeMentira((c) => (c.includes('sku=MUITOS') ? J(BUSCA(['MLB1202555743', '../orders', 'MLB1202555743', 'MLB2927951211', 'MLB2927973113', 'MLB9'], 9)) : undefined));
      const r6 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m6.fetch, skus: ['MUITOS'], hoje: HOJE });
      assert.deepStrictEqual([r6.por_sku[0].anuncios_encontrados, r6.por_sku[0].anuncios.map((a) => a.anuncio), m6.caminhos().some((c) => c.includes('..'))], [9, ['MLB1202555743', 'MLB2927951211', 'MLB2927973113'], false]);
      /* SKU com caractere especial vai codificado; o detalhe que veio como lista vazia não derruba; id de conta torto é recusado */
      const m8 = mlDeMentira((c) => (c.includes('sku=A%20B%2FC%26x') ? J(BUSCA(['MLB1202555743'])) : (c.startsWith('/items?ids=MLB1202555743') ? J([]) : undefined)));
      const r8 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m8.fetch, skus: ['A B/C&x'], hoje: HOJE });
      assert.deepStrictEqual([m8.caminhos()[1], r8.por_sku[0].anuncios_encontrados, r8.por_sku[0].anuncios[0].anuncio, r8.por_sku[0].faltou[0].motivo], ['/users/252698567/items/search?sku=A%20B%2FC%26x&limit=3', 1, 'MLB1202555743', 'a resposta veio sem o corpo do anúncio']);
      const m9 = mlDeMentira((c) => (c === '/users/me' ? J({ id: '12/../x', site_id: 'MLB' }) : undefined));
      assert.deepStrictEqual([(await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m9.fetch, skus: ['a'] })).ok, m9.vistos.length], [false, 1]);
      /* a busca sem o total: vale o que veio */
      const m7 = mlDeMentira((c) => (c.includes('sku=SEMTOTAL') ? J({ results: ['MLB1202555743'] }) : undefined));
      assert.deepStrictEqual((await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m7.fetch, skus: ['SEMTOTAL'], hoje: HOJE })).por_sku[0].anuncios_encontrados, 1);
    }
    /* A9. SKUs: teto, repetidos, vazios, fora do formato; `dias_de_visitas` com piso e teto; sem token / sem conta */
    assert.deepStrictEqual([P.skusPedidos(['a', ' a ', '', null, 'b', 'c\nd', 'S'.repeat(81), 'e', 'f', 'g']), P.skusPedidos('x'), P.skusPedidos([]), P.MAX_SKUS], [['a', 'b', 'e', 'f'], [], [], 4]);
    assert.deepStrictEqual([await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, skus: [] }), await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, skus: ['a\u0001'] })], [{ ok: false, erro: 'nenhum SKU válido pedido' }, { ok: false, erro: 'nenhum SKU válido pedido' }]);
    for (const [d, esperado, ultimo] of [[1, 1, 'last=1&unit=day'], [99, 30, 'last=30&unit=day'], ['x', 7, 'last=7&unit=day'], [0, 7, 'last=7&unit=day'], [-3, 1, 'last=1&unit=day'], [14.7, 14, 'last=14&unit=day']]) {
      const m = mlDeMentira(); const rd = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m.fetch, skus: ['KAQI-9180-220'], diasVisitas: d, hoje: HOJE });
      assert.ok(rd.dias_de_visitas === esperado && m.caminhos().some((c) => c.endsWith(ultimo)), 'dias=' + d);
      const de = new Date(Date.parse(HOJE + 'T12:00:00Z') - esperado * 86400000).toISOString().slice(0, 10);
      assert.ok(m.caminhos().some((c) => /product_ads/.test(c) && c.includes('date_from=' + de + '&date_to=' + HOJE)), 'o período de Ads tem que acompanhar os dias: ' + d);
    }
    assert.deepStrictEqual([(await P.consultarML({ garantirTokenML: async () => null, fetch: mlDeMentira().fetch, skus: ['a'] })).erro, (await P.consultarML({ garantirTokenML: async () => { throw new Error('refresh falhou'); }, fetch: mlDeMentira().fetch, skus: ['a'] })).erro, (await P.consultarML({ fetch: mlDeMentira().fetch, skus: ['a'] })).erro,
      (await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c === '/users/me' ? J({}, 401) : undefined)).fetch, skus: ['a'] })).erro],
    ['esta loja está sem acesso ao Mercado Livre agora', 'o acesso ao Mercado Livre não está disponível (refresh falhou)', 'esta loja está sem acesso ao Mercado Livre agora', 'o Mercado Livre não disse de quem é a conta (o Mercado Livre respondeu HTTP 401)']);
    /* sem o site da conta, nada de Ads (e dito) */
    const mS = mlDeMentira((c) => (c === '/users/me' ? J({ id: 252698567 }) : undefined));
    const rS = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mS.fetch, skus: ['KAQI-9180-220'], hoje: HOJE });
    assert.deepStrictEqual([rS.por_sku[0].anuncios[0].product_ads, mS.caminhos().some((c) => /product_ads/.test(c))], [null, false]);
    /* A10. o ML EMUDECE num pedido: custa só o prazo dele; estourado o total, o resto fica dito */
    {
      let sinal = null;
      const m = mlDeMentira((c, o) => { if (/visits/.test(c)) { sinal = o.signal; return nunca(); } return undefined; });
      const t0 = Date.now();
      const r9 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m.fetch, skus: ['KAQI-9180-220'], hoje: HOJE, prazoPedidoMs: 60, prazoMs: 5000 });
      assert.deepStrictEqual([r9.por_sku[0].anuncios[0].visitas, r9.por_sku[0].faltou, sinal.aborted, r9.por_sku[0].anuncios[0].qualidade.nota, Date.now() - t0 < 3000], [null, [{ o_que: 'as visitas do anúncio MLB1202555743', motivo: 'o Mercado Livre não respondeu no prazo' }], true, 57, true]);
      const m2 = mlDeMentira((c) => (/visits/.test(c) ? nunca() : undefined));
      const r10 = await P.consultarML({ garantirTokenML: async () => 'tk', fetch: m2.fetch, skus: ['KAQI-9180-220', '10-furo-180mm-PAI'], hoje: HOJE, prazoPedidoMs: 5000, prazoMs: 700 });
      assert.deepStrictEqual([r10.ok, m2.vistos.length, r10.por_sku[1].anuncios_encontrados, r10.por_sku[1].faltou.every((f) => f.motivo === 'o prazo da consulta acabou antes deste pedido'), r10.por_sku[0].faltou.slice(1).every((f) => f.motivo === 'o prazo da consulta acabou antes deste pedido')], [true, 5, null, true, true]);
      const _st = global.setTimeout; const pedidos = [];
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      try { await P.consultarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, skus: ['NAO-EXISTE'] }); } finally { global.setTimeout = _st; }
      assert.ok(pedidos.includes(P.PRAZO_PEDIDO_MS) && P.PRAZO_PEDIDO_MS >= 3000 && P.PRAZO_PEDIDO_MS <= 20000 && P.PRAZO_MS >= 30000 && P.PRAZO_MS <= 120000, 'prazos: ' + pedidos);
    }
  }

  /* ═══ B. SHOPEE ═══ */
  {
    /* B1. o resumo, do formato real: estoque galpão × Full por centro; acumulados; rebaixado */
    assert.deepStrictEqual(P.resumirAnuncioShopee(copia(LUMINARIA), EXTRA.item_list[0]), { anuncio: '23899414754', titulo: 'Luminária Chão 177cm Piso Articulada Dupla para 2 Lâmpadas Pedestal Coluna Metal Fl 1011 Branco', situacao: 'NORMAL', sku_do_anuncio: 'FL-1011-BRANCO', preco: 149.9, preco_original: 149.9,
      estoque: { galpao: 906, full_shopee: 7, full_por_centro: [{ centro: 'BRFSP1', estoque: 3 }, { centro: 'BRFPE1', estoque: 2 }, { centro: 'BRFGO1', estoque: 1 }, { centro: 'BRFRS1', estoque: 1 }], reservado: 0 }, rebaixado_na_busca: false, tem_variacao: false,
      acumulado: { vendidos: 164, visitas: 2371, curtidas: 556, nota: 4.831325301204819, avaliacoes: 83 } }, 'o anúncio da Shopee não saiu do formato real');
    const ar = P.resumirAnuncioShopee(copia(ARANDELA), null);
    assert.deepStrictEqual([ar.estoque, ar.rebaixado_na_busca, ar.preco, ar.preco_original, ar.acumulado], [{ galpao: 19, full_shopee: 0, full_por_centro: [], reservado: 1 }, true, 179.9, 197.9, null], 'centro sem nome (a linha "vazia" da GOOD) não é centro');
    assert.deepStrictEqual([P.resumirAnuncioShopee({ item_id: 1, price_info: [null] }).preco, P.resumirAnuncioShopee({ item_id: 1, stock_info_v2: { seller_stock: 'x' } }).estoque.galpao], [null, null]);
    assert.deepStrictEqual([P.resumirAnuncioShopee(null), P.resumirAnuncioShopee({ item_id: 1, stock_info_v2: 'x', price_info: 'y', deboost: 'x' }), P.resumirAnuncioShopee({ item_id: 1, stock_info_v2: { seller_stock: [{ stock: '3' }, null], shopee_stock: [{ location_id: 'A', stock: 2 }, { location_id: 7, stock: 1 }] } }).estoque],
      [null, { anuncio: '1', titulo: null, situacao: null, sku_do_anuncio: null, preco: null, preco_original: null, estoque: { galpao: null, full_shopee: null, full_por_centro: null, reservado: null }, rebaixado_na_busca: null, tem_variacao: null, acumulado: null }, { galpao: 0, full_shopee: 2, full_por_centro: [{ centro: 'A', estoque: 2 }], reservado: null }]);
    /* B2. a consulta: pelo repasse cru, só leitura de anúncio; um pedido por lista; promoção crua */
    const sh = shDeMentira();
    const r = await P.consultarShopee({ pedirAoSync: sh.pedirAoSync, skus: ['FL-1011-BRANCO', 'KJBD-171-PRETO-60', 'NADA'] });
    assert.deepStrictEqual(sh.pedidos(), ['/api/v2/product/search_item?offset=0&page_size=3&item_sku=FL-1011-BRANCO', '/api/v2/product/get_item_base_info?item_id_list=23899414754,22299462428', '/api/v2/product/get_item_extra_info?item_id_list=23899414754,22299462428', '/api/v2/product/get_item_promotion?item_id_list=23899414754,22299462428',
      '/api/v2/product/search_item?offset=0&page_size=3&item_sku=KJBD-171-PRETO-60', '/api/v2/product/get_item_base_info?item_id_list=22897751519', '/api/v2/product/get_item_extra_info?item_id_list=22897751519', '/api/v2/product/get_item_promotion?item_id_list=22897751519',
      '/api/v2/product/search_item?offset=0&page_size=3&item_sku=NADA'], 'a sequência de pedidos à Shopee mudou');
    assert.ok(sh.vistos.every((v) => v[0] === 'shopee-raw' && v[3] === undefined && v[4] === 'caminho,q' && /^\/api\/v2\/product\/(get_item_[a-z_]+|search_item)$/.test(v[1])), 'fora do repasse cru / fora da leitura de anúncio');
    assert.deepStrictEqual(r.por_sku.map((p) => [p.sku, p.anuncios_encontrados, p.anuncios_lidos, p.faltou]), [['FL-1011-BRANCO', 2, 2, [{ o_que: 'o detalhe do anúncio 22299462428', motivo: 'a Shopee não devolveu este anúncio na lista' }]], ['KJBD-171-PRETO-60', 1, 1, []], ['NADA', 0, 0, []]]);
    const lum = r.por_sku[0].anuncios[0], segundo = r.por_sku[0].anuncios[1];
    assert.deepStrictEqual([lum.estoque.full_shopee, lum.acumulado.vendidos, lum.promocoes_como_a_shopee_mandou, segundo.anuncio, segundo.situacao, segundo.acumulado], [7, 164, { success_list: [{ item_id: 23899414754 }, { item_id: 22299462428 }] }, '22299462428', undefined, { vendidos: 1, visitas: 10, curtidas: 0, nota: 0, avaliacoes: 0 }]);
    /* `ok: false` do serviço é recusa (motivo em dados.erro); erro da Shopee; serviço fora; o resto segue */
    {
      const s2 = shDeMentira((c) => { if (c.endsWith('get_item_base_info')) return { ok: false, status: 503, dados: { ok: false, erro: 'service unavailable' } }; if (c.endsWith('get_item_extra_info')) return { ok: true, status: 200, dados: { ok: true, resposta: { error: 'error_param', message: 'x' } } }; if (c.endsWith('get_item_promotion')) throw new Error('ECONNREFUSED'); return undefined; });
      const r2 = await P.consultarShopee({ pedirAoSync: s2.pedirAoSync, skus: ['KJBD-171-PRETO-60'] });
      assert.deepStrictEqual([r2.por_sku[0].anuncios.map((a) => [a.anuncio, a.situacao, a.acumulado, a.promocoes_como_a_shopee_mandou]), r2.por_sku[0].faltou], [[['22897751519', undefined, null, null]], [{ o_que: 'o detalhe dos anúncios', motivo: 'service unavailable' }, { o_que: 'visitas, vendas e avaliação dos anúncios', motivo: 'error_param — x' }, { o_que: 'as promoções dos anúncios', motivo: 'não respondeu (ECONNREFUSED)' }]]);
      const s3 = shDeMentira((c) => (c.endsWith('search_item') ? { ok: false, status: 200, dados: { ok: false, resposta: { error: 'error_auth', message: 'Invalid access_token.' } } } : undefined));
      assert.deepStrictEqual((await P.consultarShopee({ pedirAoSync: s3.pedirAoSync, skus: ['X'] })).por_sku, [{ sku: 'X', anuncios_encontrados: null, anuncios_lidos: 0, anuncios: [], faltou: [{ o_que: 'a busca dos anúncios pelo SKU', motivo: 'error_auth — Invalid access_token.' }] }]);
      const s4 = shDeMentira((c) => (c.endsWith('search_item') ? { ok: true, status: 200, dados: { ok: true, resposta: { error: '' } } } : undefined));
      assert.deepStrictEqual((await P.consultarShopee({ pedirAoSync: s4.pedirAoSync, skus: ['X'] })).por_sku[0].faltou, [{ o_que: 'a busca dos anúncios pelo SKU', motivo: 'a Shopee respondeu sem conteúdo' }]);
      /* id torto na lista não vira pedido; mais que o teto, lê o teto e diz o total */
      const s5 = shDeMentira((c) => (c.endsWith('search_item') ? resp({ item_id_list: ['12/../x', 22897751519, 123, 23899414754, 22299462428, 99999999999], total_count: 6 }) : undefined));
      const r5 = await P.consultarShopee({ pedirAoSync: s5.pedirAoSync, skus: ['X'] });
      assert.deepStrictEqual([r5.por_sku[0].anuncios_encontrados, r5.por_sku[0].anuncios.map((a) => a.anuncio), s5.pedidos()[1]], [6, ['22897751519', '23899414754', '22299462428'], '/api/v2/product/get_item_base_info?item_id_list=22897751519,23899414754,22299462428']);
    }
    { const s8 = shDeMentira(); await P.consultarShopee({ pedirAoSync: s8.pedirAoSync, skus: ['A B/C&x'] }); assert.strictEqual(s8.pedidos()[0], '/api/v2/product/search_item?offset=0&page_size=3&item_sku=A%20B%2FC%26x', 'o SKU vai codificado'); }
    assert.deepStrictEqual([await P.consultarShopee(null), await P.consultarShopee({ pedirAoSync: shDeMentira().pedirAoSync, skus: [] })], [{ ok: false, erro: 'esta loja não tem a Shopee ligada ao dashboard' }, { ok: false, erro: 'nenhum SKU válido pedido' }]);
    /* o serviço EMUDECE: só o prazo daquele pedido; estourado o total, o resto é dito */
    {
      const s6 = shDeMentira((c) => (c.endsWith('get_item_extra_info') ? nunca() : undefined));
      const t0 = Date.now();
      const r6 = await P.consultarShopee({ pedirAoSync: s6.pedirAoSync, skus: ['KJBD-171-PRETO-60'], prazoPedidoMs: 60, prazoMs: 5000 });
      assert.deepStrictEqual([r6.por_sku[0].faltou, r6.por_sku[0].anuncios[0].estoque.galpao, Date.now() - t0 < 3000], [[{ o_que: 'visitas, vendas e avaliação dos anúncios', motivo: 'a Shopee não respondeu no prazo' }], 19, true]);
      const s7 = shDeMentira((c) => (c.endsWith('get_item_extra_info') ? nunca() : undefined));
      const r7 = await P.consultarShopee({ pedirAoSync: s7.pedirAoSync, skus: ['KJBD-171-PRETO-60', 'FL-1011-BRANCO'], prazoPedidoMs: 5000, prazoMs: 700 });
      assert.deepStrictEqual([s7.vistos.length, r7.por_sku[1].anuncios_encontrados, r7.por_sku[1].faltou[0].motivo], [3, null, 'o prazo da consulta acabou antes deste pedido']);
    }
  }

  /* ═══ C. PELO CHAT ═══ */
  {
    const olhos = (extra) => OLHOS.criarOlhos(Object.assign({ hoje: HOJE, empresa: 'good', CACHE_DIR: TMP, readJson, writeJson, validarPeriodo }, extra)).F;
    const ml = mlDeMentira(), sh = shDeMentira();
    const r = await olhos({ garantirTokenML: async () => 'tk-loja', fetch: ml.fetch, pedirAoSync: sh.pedirAoSync }).anuncios_do_item({ skus: ['10-furo-180mm-PAI', 'FL-1011-BRANCO'] });
    assert.deepStrictEqual([r.skus, r.mercado_livre.dias_de_visitas, r.mercado_livre.por_sku.map((p) => [p.sku, p.anuncios_encontrados]), r.shopee.por_sku.map((p) => [p.sku, p.anuncios_encontrados])], [['10-furo-180mm-PAI', 'FL-1011-BRANCO'], 7, [['10-furo-180mm-PAI', 2], ['FL-1011-BRANCO', 0]], [['10-furo-180mm-PAI', 0], ['FL-1011-BRANCO', 2]]]);
    assert.deepStrictEqual(r.avisos, ['Mercado Livre: nenhum anúncio com o SKU "FL-1011-BRANCO" (o SKU do anúncio pode ser outro — confira com buscar_item ou pelo painel).', 'Shopee: nenhum anúncio com o SKU "10-furo-180mm-PAI" (o SKU do anúncio pode ser outro — confira com buscar_item ou pelo painel).',
      'Shopee, SKU "FL-1011-BRANCO": não veio o detalhe do anúncio 22299462428 (a Shopee não devolveu este anúncio na lista) — o que falta está nulo, não é zero.']);
    assert.ok(/não no dia da venda/.test(r.leia) && /tem_linha_do_full/.test(r.leia) && /pode_entrar/.test(r.leia) && /dia que não aparece é sem dado/.test(r.leia) && /rebaixado_na_busca/.test(r.leia) && /busca_incompleta/.test(r.leia));
    assert.ok(ml.vistos.every((v) => v.cab.Authorization === 'Bearer tk-loja') && sh.vistos.every((v) => v[0] === 'shopee-raw'));
    /* canal sem peça: dito, o outro responde */
    const r2 = await olhos({ pedirAoSync: shDeMentira().pedirAoSync }).anuncios_do_item({ skus: ['FL-1011-BRANCO'] });
    assert.deepStrictEqual([r2.mercado_livre, r2.shopee.por_sku[0].anuncios_encontrados, r2.avisos[0]], [null, 2, 'Mercado Livre: não consegui ler (esta loja não tem a conta do Mercado Livre ligada ao dashboard).']);
    const r2b = await olhos({ garantirTokenML: async () => 'tk' }).anuncios_do_item({ skus: ['FL-1011-BRANCO'] });   /* sem o fetch não tenta */
    assert.deepStrictEqual([r2b.mercado_livre, r2b.avisos[0]], [null, 'Mercado Livre: não consegui ler (esta loja não tem a conta do Mercado Livre ligada ao dashboard).']);
    const r3 = await olhos({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch }).anuncios_do_item({ skus: ['KAQI-9180-220'] });
    assert.deepStrictEqual([r3.shopee, r3.mercado_livre.por_sku[0].anuncios[0].logistica, r3.avisos], [null, 'fulfillment', ['Shopee: não consegui ler (esta loja não tem a Shopee ligada ao dashboard).']]);
    /* mais anúncios que os lidos; o ML que falhou; teto de SKUs; dias_de_visitas */
    const m4 = mlDeMentira((c) => (c.includes('sku=MUITOS') ? J(BUSCA(['MLB1202555743'], 9)) : (c === '/users/me' ? J({}, 503) : undefined)));
    const r4 = await olhos({ garantirTokenML: async () => 'tk', fetch: m4.fetch, pedirAoSync: shDeMentira().pedirAoSync }).anuncios_do_item({ skus: ['A', 'B', 'C', 'D', 'E', 'F'], dias_de_visitas: 99 });
    assert.deepStrictEqual([r4.skus, r4.mercado_livre, r4.avisos[0], r4.avisos[r4.avisos.length - 1]], [['A', 'B', 'C', 'D'], null, 'Mercado Livre: não consegui ler (o Mercado Livre não disse de quem é a conta (o Mercado Livre respondeu HTTP 503)).', 'Foram pedidos 6 SKUs; li os 4 primeiros.']);
    const m5 = mlDeMentira((c) => (c.includes('sku=MUITOS') ? J(BUSCA(['MLB1202555743'], 9)) : undefined));
    const r5 = await olhos({ garantirTokenML: async () => 'tk', fetch: m5.fetch }).anuncios_do_item({ skus: ['MUITOS'], dias_de_visitas: 99 });
    assert.deepStrictEqual([r5.mercado_livre.dias_de_visitas, r5.avisos.filter((a) => /tem 9 anúncios; li os 1 primeiros/.test(a)).length, m5.caminhos().some((c) => c.endsWith('last=30&unit=day'))], [30, 1, true]);
    /* a busca que FALHOU não é "nenhum anúncio": o aviso é "não deu pra saber" + o que faltou */
    const m6 = mlDeMentira((c) => (c.includes('/items/search?') ? J({}, 503) : undefined));
    const r6 = await olhos({ garantirTokenML: async () => 'tk', fetch: m6.fetch }).anuncios_do_item({ skus: ['X'] });
    assert.deepStrictEqual(r6.avisos.filter((a) => /Mercado Livre/.test(a)), ['Mercado Livre: não deu pra saber se há anúncio com o SKU "X" (a busca não respondeu — veja o que faltou).', 'Mercado Livre, SKU "X": não veio a busca dos anúncios pelo SKU (campo sku) (o Mercado Livre respondeu HTTP 503); a busca dos anúncios pelo SKU (atributo seller_sku) (o Mercado Livre respondeu HTTP 503) — o que falta está nulo, não é zero.']);
    /* (Codex #890) uma busca falhou e a outra não achou: "não deu pra saber", NUNCA "nenhum anúncio"; uma falhou e a outra achou: "pode haver a mais" */
    const m6b = mlDeMentira((c) => (c.includes('seller_sku=') ? J({}, 503) : undefined));
    const r6b = await olhos({ garantirTokenML: async () => 'tk', fetch: m6b.fetch }).anuncios_do_item({ skus: ['NAO-EXISTE', '10-furo-180mm-PAI'] });
    assert.deepStrictEqual(r6b.avisos.filter((a) => /Mercado Livre:/.test(a)), ['Mercado Livre: não deu pra saber se há anúncio com o SKU "NAO-EXISTE" (a busca não respondeu — veja o que faltou).', 'Mercado Livre: do SKU "10-furo-180mm-PAI" só uma das duas buscas respondeu — pode haver anúncio a mais do que os 2 vistos.']);
    assert.ok(!r6b.avisos.some((a) => /nenhum anúncio/.test(a)));
    await assert.rejects(() => olhos({}).anuncios_do_item({ skus: [] }), /diga os SKUs/);
    await assert.rejects(() => olhos({}).anuncios_do_item({}), /diga os SKUs/);
    /* a lista de consultas, a descrição e as regras */
    assert.deepStrictEqual(OLHOS.FERRAMENTAS.map((f) => f.name), ['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'anuncios_mercado_livre', 'saude_conta_shopee', 'anuncios_do_item']);
    const f = OLHOS.FERRAMENTAS[6];
    assert.ok(/estado de AGORA/.test(f.description) && f.input_schema.required.includes('skus') && f.input_schema.properties.skus.maxItems === P.MAX_SKUS && f.input_schema.properties.dias_de_visitas.type === 'integer');
    assert.deepStrictEqual([OLHOS.descrever('anuncios_do_item', { skus: ['a', 'b'] }), OLHOS.descrever('anuncios_do_item', {})], ['Olhando os anúncios de 2 item(ns) nos marketplaces', 'Olhando os anúncios de ? item(ns) nos marketplaces']);
    assert.ok(/anuncios_do_item/.test(OLHOS.REGRAS[0]) && /AGORA: "o anúncio está pausado hoje" é fato/.test(OLHOS.REGRAS[1]));
  }

  /* ═══ D. PELA ROTA DE VERDADE ═══ */
  {
    const C = require('../lib/checkout/chat-analise');
    const turno = ({ texto, usos }) => {
      const evs = [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }]; let i = 0;
      if (texto) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: texto } }, { type: 'content_block_stop', index: i }); i++; }
      for (const u of (usos || [])) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: u.id, name: u.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } }, { type: 'content_block_stop', index: i }); i++; }
      evs.push({ type: 'message_delta', delta: { stop_reason: (usos || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
      const buf = Buffer.from(evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), 'utf8');
      return { ok: true, status: 200, text: async () => '', body: (async function* () { yield buf; })() };
    };
    const novoRes = () => ({ _json: null, _txt: '', writeHead() {}, setHeader() {}, write(x) { this._txt += String(x); return true; }, end(x) { if (x != null) this._txt += String(x); }, on() {} });
    const mlR = mlDeMentira(); rede.mlResposta = (c, o) => mlR.fetch('https://api.mercadolibre.com' + c, o);
    const sh = shDeMentira();
    const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: (ck) => (ck === 'sess=dono' ? 'dono' : null), supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: TMP,
      json: (res, st, o) => { res._json = [st, o]; }, garantirTokenML: async () => 'tk-da-good', pedirAoSync: (...a) => sh.pedirAoSync(...a), blingGet: async () => ({ ok: false }) });
    const _log = console.log; console.log = () => {};
    try {
      rede.roteiro = [turno({ texto: 'Vou olhar.', usos: [{ id: 't1', name: 'anuncios_do_item', input: { skus: ['10-furo-180mm-PAI', 'FL-1011-BRANCO'], dias_de_visitas: 14 } }] }), turno({ texto: 'Pronto.' })];
      const res = novoRes();
      await h({ method: 'POST', headers: { 'x-admin-key': 'chave-adm' }, body: { pergunta: 'por que as lixas caíram?' } }, res, new URL('http://x/good-checkout-offline/chat-analise'));
      const ev = res._txt.split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
      assert.ok(ev.some((e) => e.t === 'fim') && !ev.some((e) => e.t === 'erro'), 'a pergunta não chegou ao fim: ' + res._txt.slice(0, 300));
      const p1 = rede.api[0], p2 = rede.api[1];
      assert.deepStrictEqual(p1.tools.map((t) => t.name).slice(-3), ['anuncios_mercado_livre', 'saude_conta_shopee', 'anuncios_do_item']);
      assert.ok(/anuncios_do_item/.test(p1.system));
      const voltou = JSON.parse(p2.messages[p2.messages.length - 1].content[0].content);
      assert.deepStrictEqual([voltou.mercado_livre.dias_de_visitas, voltou.mercado_livre.por_sku[0].anuncios[1].variacoes[0].sku, voltou.shopee.por_sku[1].anuncios[0].estoque.full_shopee, rede.ml.every((x) => x[1] === 'Bearer tk-da-good'), sh.vistos.every((v) => v[0] === 'shopee-raw')], [14, '10-furo-g24-180mm', 7, true, true]);
      assert.deepStrictEqual(ev.filter((e) => e.t === 'passo').map((e) => e.texto), ['Olhando os anúncios de 2 item(ns) nos marketplaces']);
      assert.ok(!/dono@loja|tk-da-good/.test(JSON.stringify(rede.api)) && ev.find((e) => e.t === 'fim').uso.consultas === 0);
    } finally { console.log = _log; }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  _chegouAoFim = true;
  console.log('ok — um produto de perto: ML (anúncio com variação, estoque galpão × Full, visitas só nos dias listados, promoção "candidate" não é "está", qualidade, Ads idle = fora) e Shopee (galpão × Full por centro, acumulados, rebaixado) saem do formato real; busca pelos dois campos de SKU; parte que falha é dita; prazos; pelo chat e pela rota de verdade com as peças da empresa');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
