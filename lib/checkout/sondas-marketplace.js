'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   SONDAS DE MARKETPLACE (15/11/2026) — anúncios, estoque do Full, promoções e Ads no Mercado Livre; saúde da conta,
   anúncios e campanhas na Shopee. SÓ LEITURA, só admin.

   Por que existe: o chat de análise ainda NÃO enxerga se o anúncio estava ativo, o estoque do Full, promoções e
   campanhas, nem a saúde da conta na Shopee. Antes de ligar qualquer um ao chat, é preciso VER o que cada API devolve
   pra ESTA conta — a reputação do ML foi escrita pela documentação e ensinou: formato lido de documentação não é
   formato conferido. A ordem é a que já deu certo no escrow da Shopee: sondar → olhar o JSON real → só então escrever
   o leitor.

   O QUE A SONDA FAZ: uma sequência curta e FIXA de pedidos GET (nenhum caminho vem de fora), com poucos itens por
   pedido, e devolve cada resposta como veio — encolhida. Não grava nada, não interpreta nada.

   O QUE ELA NÃO FAZ, de propósito:
   · não pede pedido/venda nenhuma (nada de comprador);
   · do `/users/me` do ML só saem o id, o site e o apelido da loja (o resto é cadastro: documento, e-mail, telefone);
   · campo com nome de dado de gente (`email`, `phone`, `identification`, `buyer`, `order_sn`…) sai como "[omitido]",
     venha de onde vier;
   · lista longa é cortada (os primeiros itens + quantos sobraram) e resposta grande demais vira o começo dela.

   OS CAMINHOS foram conferidos na documentação em 15/11/2026 (ML: itens do vendedor, multiget, estoque do Full,
   Product Ads — a versão nova, `/marketplace/advertising/…`, a antiga saiu em 06/2025). Os da Shopee seguem o padrão
   `/api/v2/<módulo>/<operação>` e parte deles é CANDIDATO: a sonda existe pra a própria Shopee dizer quais valem.
   Erro numa resposta é informação, não defeito da sonda.

   PRAZO: cada pedido tem o seu e a sonda inteira tem um total (lib/checkout/com-prazo.js) — API que emudece vira
   "sem resposta no prazo" naquele passo, e os seguintes ficam como "pulado".
   ───────────────────────────────────────────────────────────────────────────── */

const { comPrazo } = require('./com-prazo');

const PRAZO_PASSO_MS = 15000;
const PRAZO_TOTAL_MS = 75000;
const MINIMO_PRA_OUTRO_PASSO_MS = 500;
const MAX_LISTA = 8;          /* itens de uma lista que saem na resposta */
const MAX_TEXTO = 300;        /* caracteres de um texto */
const MAX_RESPOSTA = 12000;   /* caracteres da resposta de UM passo, já encolhida */
const ML = 'https://api.mercadolibre.com';
const GRUPOS_ML = ['anuncios', 'full', 'promocoes', 'ads'];
const GRUPOS_SHOPEE = ['conta', 'anuncios', 'campanhas', 'ads'];

/* nomes de campo que identificam GENTE (ou pedido de gente): nunca saem */
const OMITIR = new Set(['identification', 'email', 'secure_email', 'phone', 'alternative_phone', 'address', 'first_name', 'last_name', 'doc_number', 'doc_type',
  'receiver_name', 'receiver_phone', 'recipient_address', 'buyer', 'buyer_username', 'buyer_user_id', 'payer', 'billing_info', 'registration_identifiers', 'company', 'bank_account',
  'order_sn', 'ordersn', 'order_id']);

function limpar(v, nivel) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_TEXTO ? v.slice(0, MAX_TEXTO) + '…[+' + (v.length - MAX_TEXTO) + ' caracteres]' : v;
  if (nivel > 12) return '[aninhado demais]';
  if (Array.isArray(v)) {
    const a = v.slice(0, MAX_LISTA).map((x) => limpar(x, nivel + 1));
    if (v.length > MAX_LISTA) a.push('…e mais ' + (v.length - MAX_LISTA) + ' (lista cortada pela sonda)');
    return a;
  }
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = OMITIR.has(k.toLowerCase()) ? '[omitido pela sonda]' : limpar(v[k], nivel + 1);
    return o;
  }
  return String(v);
}
/* a resposta de um passo: limpa e, se ainda for grande demais, só o começo (dito) */
function encolher(v) {
  const limpo = limpar(v, 0);
  const txt = JSON.stringify(limpo);
  if (txt == null) return null;
  return txt.length <= MAX_RESPOSTA ? limpo : { cortada_pela_sonda: true, tamanho: txt.length, comeco: txt.slice(0, MAX_RESPOSTA) };
}

const hojeSP = (agora) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora || new Date());
const diasAtras = (dia, n) => new Date(Date.parse(dia + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const prazos = (o) => ({ passo: Number(o.prazoPassoMs) > 0 ? Number(o.prazoPassoMs) : PRAZO_PASSO_MS, total: Number(o.prazoTotalMs) > 0 ? Number(o.prazoTotalMs) : PRAZO_TOTAL_MS });
const gruposPedidos = (oque, todos) => { const g = String(oque || '').trim().toLowerCase(); return todos.includes(g) ? [g] : todos; };

/* ═══ MERCADO LIVRE ═══ */
async function sondarML(o) {
  const p = prazos(o || {});
  const acaba = Date.now() + p.total;
  const grupos = gruposPedidos(o && o.oque, GRUPOS_ML);
  const hoje = (o && o.hoje) || hojeSP();
  const passos = [];
  const fim = (ok, extra) => Object.assign({ ok, sonda: 'mercado-livre', grupos, feita_em: new Date().toISOString(), passos,
    leia: 'Sonda SÓ LEITURA: cada passo é um GET ao Mercado Livre e a resposta dele como veio (encolhida; dado de gente omitido). Nada foi gravado nem interpretado. Erro num passo (403, 404, "not found") é informação: diz que aquele caminho não vale pra esta conta ou que o app não tem a permissão.' }, extra);

  let token = null;
  try { token = await comPrazo(Math.min(p.passo, p.total), () => o.garantirTokenML(), () => null); }
  catch (e) { return fim(false, { erro: 'o acesso ao Mercado Livre não está disponível (' + String((e && e.message) || e).slice(0, 100) + ')' }); }
  if (!token) return fim(false, { erro: 'esta loja está sem acesso ao Mercado Livre agora' });

  /* um GET. Devolve o corpo (objeto) ou null; registra o passo. `versao`: 1 → "Api-Version: 1"; 2 → "api-version: 2" */
  const pedir = async (grupo, nome, caminho, q, versao, mostrar) => {
    const pedido = 'GET ' + caminho + (q ? '?' + q : '') + (versao ? '  [api-version ' + versao + ']' : '');
    const resta = acaba - Date.now();
    if (resta < MINIMO_PRA_OUTRO_PASSO_MS) { passos.push({ grupo, passo: nome, pedido, pulado: 'a sonda chegou ao prazo total antes deste passo' }); return null; }
    const cab = { Authorization: 'Bearer ' + token };
    if (versao === 1) { cab['Api-Version'] = '1'; cab['Content-Type'] = 'application/json'; }
    if (versao === 2) cab['api-version'] = '2';
    const r = await comPrazo(Math.min(p.passo, resta), async (sinal) => {
      const resp = await o.fetch(ML + caminho + (q ? '?' + q : ''), { method: 'GET', headers: cab, signal: sinal });
      const txt = await resp.text();
      let corpo = null; try { corpo = JSON.parse(txt); } catch (e) { corpo = txt.slice(0, MAX_TEXTO); }
      return { http: resp.status, corpo };
    }, () => ({ http: null, erro: 'sem resposta no prazo' })).catch((e) => ({ http: null, erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));
    const reg = { grupo, passo: nome, pedido, http: r.http };
    if (r.erro) reg.erro = r.erro; else reg.resposta = encolher(mostrar ? mostrar(r.corpo) : r.corpo);
    passos.push(reg);
    return (!r.erro && r.http >= 200 && r.http < 300 && r.corpo && typeof r.corpo === 'object') ? r.corpo : null;
  };
  const idsDe = (corpo, n) => ((corpo && Array.isArray(corpo.results)) ? corpo.results : []).filter((x) => typeof x === 'string' && /^[A-Z]{3}\d+$/.test(x)).slice(0, n);

  /* quem sou: do cadastro só saem o id, o site e o apelido da loja */
  const eu = await pedir('conta', 'quem sou (só id, site e apelido)', '/users/me', '', 0, (c) => (c && typeof c === 'object' ? { id: c.id, site_id: c.site_id, nickname: c.nickname } : c));
  const id = eu && /^\d+$/.test(String(eu.id)) ? String(eu.id) : null;
  const site = eu && /^[A-Z]{3}$/.test(String(eu.site_id)) ? String(eu.site_id) : null;
  if (!id) return fim(false, { erro: 'não consegui saber de quem é a conta (o passo "quem sou" não respondeu com o id)' });
  const meus = '/users/' + id + '/items/search';
  const detalhe = 'id,title,status,sub_status,available_quantity,sold_quantity,price,inventory_id,shipping,health,catalog_listing,listing_type_id,last_updated,seller_custom_field,variations';

  if (grupos.includes('anuncios')) {
    await pedir('anuncios', 'todos os anúncios, com os filtros disponíveis (quantos por situação, por logística…)', meus, 'include_filters=true&limit=5');
    const ativos = await pedir('anuncios', 'anúncios ATIVOS (o total e os 5 primeiros)', meus, 'status=active&limit=5');
    await pedir('anuncios', 'anúncios PAUSADOS (o total)', meus, 'status=paused&limit=1');
    await pedir('anuncios', 'anúncios perdendo exposição', meus, 'reputation_health_gauge=unhealthy&limit=3');
    const ids = idsDe(ativos, 5);
    if (ids.length) await pedir('anuncios', 'o detalhe de ' + ids.length + ' anúncio(s) ativo(s)', '/items', 'ids=' + ids.join(',') + '&attributes=' + detalhe);
  }
  if (grupos.includes('full')) {
    const full = await pedir('full', 'anúncios no FULL (logística fulfillment)', meus, 'logistic_type=fulfillment&status=active&limit=5');
    const ids = idsDe(full, 5);
    const det = ids.length ? await pedir('full', 'o detalhe de ' + ids.length + ' anúncio(s) do Full (o código de estoque é o inventory_id)', '/items', 'ids=' + ids.join(',') + '&attributes=id,title,status,available_quantity,inventory_id,shipping,variations') : null;
    const inv = [];
    for (const linha of (Array.isArray(det) ? det : [])) {
      const b = linha && linha.body;
      if (b && typeof b.inventory_id === 'string') inv.push(b.inventory_id);
      for (const v of ((b && Array.isArray(b.variations)) ? b.variations : [])) if (v && typeof v.inventory_id === 'string') inv.push(v.inventory_id);
    }
    for (const codigo of Array.from(new Set(inv)).filter((c) => /^[A-Z0-9]{4,20}$/.test(c)).slice(0, 2)) await pedir('full', 'o estoque no Full do código ' + codigo, '/inventories/' + codigo + '/stock/fulfillment', '');
  }
  if (grupos.includes('promocoes')) await pedir('promocoes', 'promoções da conta', '/seller-promotions/users/' + id, 'app_version=v2');
  if (grupos.includes('ads')) {
    const anunciante = await pedir('ads', 'o anunciante de Product Ads desta conta', '/advertising/advertisers', 'product_id=PADS', 1);
    const a = anunciante && Array.isArray(anunciante.advertisers) ? anunciante.advertisers[0] : null;
    const adv = a && /^\d+$/.test(String(a.advertiser_id)) ? String(a.advertiser_id) : null;
    const siteAds = (a && /^[A-Z]{3}$/.test(String(a.site_id)) ? String(a.site_id) : null) || site;
    if (adv && siteAds) {
      const base = '/marketplace/advertising/' + siteAds + '/advertisers/' + adv + '/product_ads';
      const periodo = 'date_from=' + diasAtras(hoje, 7) + '&date_to=' + hoje;
      await pedir('ads', 'campanhas de Product Ads (as 5 primeiras, com os números dos últimos 7 dias)', base + '/campaigns', 'limit=5&offset=0&' + periodo + '&metrics=clicks,prints,cost,cpc,acos,roas,units_quantity,total_amount&metrics_summary=true', 2);
      await pedir('ads', 'anúncios dentro de Product Ads (os 5 primeiros)', base + '/ads/search', 'limit=5&offset=0&' + periodo + '&metrics=clicks,prints,cost,acos', 2);
    }
  }
  return fim(true, { loja: eu.nickname || null });
}

/* ═══ SHOPEE ═══ (pelo serviço que tem o token: `pedirAoSync('shopee-raw', { caminho, q }, loja)`) */
function roteiroShopee(hoje) {
  const dd = (dia) => dia.slice(8, 10) + '-' + dia.slice(5, 7) + '-' + dia.slice(0, 4);   /* a Shopee usa DD-MM-AAAA nos relatórios de ads */
  const pag = 'page_no=1&page_size=5';
  return [
    ['conta', 'dados da loja', '/api/v2/shop/get_shop_info', ''],
    ['conta', 'desempenho da loja (saúde da conta)', '/api/v2/account_health/get_shop_performance', ''],
    ['conta', 'desempenho da loja — nome antigo do mesmo pedido', '/api/v2/account_health/shop_performance', ''],
    ['conta', 'pontos de penalidade da loja', '/api/v2/account_health/get_shop_penalty', ''],
    ['conta', 'pontos de penalidade — nome antigo do mesmo pedido', '/api/v2/account_health/shop_penalty', ''],
    ['conta', 'histórico de pontos de penalidade', '/api/v2/account_health/get_penalty_point_history', pag],
    ['conta', 'punições em andamento', '/api/v2/account_health/get_punishment_history', 'punishment_status=1&' + pag],
    ['conta', 'anúncios com problema', '/api/v2/account_health/get_listings_with_issues', pag],
    ['anuncios', 'anúncios ATIVOS (o total e os 5 primeiros)', '/api/v2/product/get_item_list', 'offset=0&page_size=5&item_status=NORMAL'],
    ['anuncios', 'anúncios DESATIVADOS (o total)', '/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=UNLIST'],
    ['anuncios', 'anúncios BANIDOS (o total)', '/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=BANNED'],
    ['campanhas', 'descontos em andamento', '/api/v2/discount/get_discount_list', 'discount_status=ongoing&' + pag],
    ['campanhas', 'cupons em andamento', '/api/v2/voucher/get_voucher_list', 'status=ongoing&' + pag],
    ['campanhas', 'combos (bundle deal) em andamento', '/api/v2/bundle_deal/get_bundle_deal_list', 'time_status=3&' + pag],
    ['campanhas', 'leve mais por menos (add-on deal) em andamento', '/api/v2/add_on_deal/get_add_on_deal_list', 'promotion_status=ongoing&' + pag],
    ['campanhas', 'ofertas relâmpago da loja', '/api/v2/shop_flash_sale/get_shop_flash_sale_list', 'type=2&offset=0&limit=5'],
    ['ads', 'saldo de anúncios', '/api/v2/ads/get_total_balance', ''],
    ['ads', 'anúncios ligados ou desligados na loja', '/api/v2/ads/get_shop_toggle_info', ''],
    ['ads', 'as campanhas de anúncio por produto', '/api/v2/ads/get_product_level_campaign_id_list', 'ad_type=all&offset=0&limit=5'],
    ['ads', 'o consumo de anúncios por dia (7 dias) — o pedido que o sistema já usa', '/api/v2/ads/get_all_cpc_ads_daily_performance', 'start_date=' + dd(diasAtras(hoje, 7)) + '&end_date=' + dd(hoje)],
  ];
}
async function sondarShopee(o) {
  const p = prazos(o || {});
  const acaba = Date.now() + p.total;
  const grupos = gruposPedidos(o && o.oque, GRUPOS_SHOPEE);
  const hoje = (o && o.hoje) || hojeSP();
  const passos = [];
  for (const [grupo, nome, caminho, q] of roteiroShopee(hoje)) {
    if (!grupos.includes(grupo)) continue;
    const pedido = 'GET ' + caminho + (q ? '?' + q : '');
    const resta = acaba - Date.now();
    if (resta < MINIMO_PRA_OUTRO_PASSO_MS) { passos.push({ grupo, passo: nome, pedido, pulado: 'a sonda chegou ao prazo total antes deste passo' }); continue; }
    const r = await comPrazo(Math.min(p.passo, resta), () => o.pedirAoSync('shopee-raw', { caminho, q }, o.loja), () => ({ ok: false, erro: 'sem resposta no prazo' }))
      .catch((e) => ({ ok: false, erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));
    const cru = r && r.dados && typeof r.dados === 'object' ? (r.dados.resposta !== undefined ? r.dados.resposta : r.dados) : null;
    const reg = { grupo, passo: nome, pedido, http: (r && r.status) || null };
    const erro = (r && r.erro) || (cru && typeof cru === 'object' && cru.error ? String(cru.error) + (cru.message ? ' — ' + String(cru.message).slice(0, 200) : '') : null);
    if (erro) reg.erro = erro;
    if (cru != null) reg.resposta = encolher(cru);
    passos.push(reg);
  }
  const respondeu = passos.some((x) => x.resposta != null);
  return { ok: respondeu, sonda: 'shopee', loja: (o && o.loja) || null, grupos, feita_em: new Date().toISOString(), passos, erro: respondeu ? undefined : 'nenhum passo teve resposta da Shopee (o serviço que tem o token respondeu? veja o "erro" de cada passo)',
    leia: 'Sonda SÓ LEITURA: cada passo é um GET à Shopee, feito pelo serviço que tem o token, e a resposta dele como veio (encolhida; dado de gente omitido). Nada foi gravado nem interpretado. Parte dos caminhos é CANDIDATO — "error_not_found", "error_param" ou erro de permissão num passo é a própria Shopee dizendo que aquele nome/parâmetro não vale ou que o app não tem o acesso: é informação, não defeito.' };
}

module.exports = { sondarML, sondarShopee, roteiroShopee, limpar, encolher, GRUPOS_ML, GRUPOS_SHOPEE, PRAZO_PASSO_MS, PRAZO_TOTAL_MS, MAX_LISTA, MAX_TEXTO, MAX_RESPOSTA };
