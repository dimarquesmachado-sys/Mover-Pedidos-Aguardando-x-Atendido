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
   · campo com nome de dado de gente (`email`, `phone`, `identification`, `buyer`, `order_sn`…) ou de credencial
     (`access_token`, `secret`, `sign`…) sai como "[omitido]", venha de onde vier — o JSON da sonda é colado numa conversa;
   · lista longa é cortada (os primeiros itens + quantos sobraram) e resposta grande demais vira o começo dela.

   OS CAMINHOS foram conferidos na documentação em 15/11/2026 (ML: itens do vendedor, multiget, estoque do Full,
   Product Ads — a versão nova, `/marketplace/advertising/…`, a antiga saiu em 06/2025). Os da Shopee seguem o padrão
   `/api/v2/<módulo>/<operação>` e parte deles é CANDIDATO: a sonda existe pra a própria Shopee dizer quais valem.
   Erro numa resposta é informação, não defeito da sonda.

   2ª RODADA (15/11, depois de ver o JSON real da Girassol): o grupo `produto` (`&oque=produto`, e `&item=` pra escolher
   o anúncio) olha UM anúncio de perto — o SKU dele, os anúncios do mesmo SKU, as promoções, as visitas por dia, a
   qualidade, o estoque por local (Full × galpão) e o que Product Ads diz dele —, que é o que falta pra responder "e
   este produto?". Ele NÃO entra na sonda sem `oque` (que continua a da 1ª rodada); `&item=` sozinho já pede o grupo.
   Conferidos na documentação em 15/11: visitas (`/items/<id>/visits/time_window`, `/users/<id>/items_visits/time_window`),
   promoções do anúncio (`/seller-promotions/items/<id>`), estoque por local (`/user-products/<id>/stock`), um anúncio em
   Product Ads (`/marketplace/advertising/<site>/product_ads/ads/<id>`) e o filtro `filters[item_id]` — que a documentação
   mostra em `…/product_ads/ads`; a sonda tenta nele e no `…/ads/search`, que foi o que respondeu na 1ª rodada.
   O que a 1ª rodada ensinou: o `/campaigns` de Product Ads, que é o que a documentação mostra, respondeu 404 de verdade
   — a sonda agora tenta `/campaigns/search` (CANDIDATO, pelo padrão do `/ads/search`, que respondeu); dois nomes da
   saúde da conta da Shopee não existem (saíram do roteiro); e a lista de métricas da Shopee sai INTEIRA (o corte de 8
   escondia 9 das 17).
   (Codex #888) ANÚNCIO COM VARIAÇÃO: o SKU, o código do produto e o código de estoque podem morar nas VARIAÇÕES, não no
   anúncio. O grupo `produto` procura nos dois (um número limitado de variações) — e quando não acha, ou quando falta
   qualquer peça pra um passo (anúncio ativo, anunciante, anúncio no Full…), o passo aparece como "pulado" com o motivo.
   Nenhum passo some calado: sonda que pula sem dizer parece resposta completa.

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
const MAX_LISTA_INTEIRA = 40; /* …e de uma lista que precisa sair inteira (as métricas da saúde da conta) */
const MAX_VARIACOES = 8;      /* variações de um anúncio em que o grupo `produto` procura SKU e códigos */
const MAX_CODIGOS = 2;        /* códigos (de estoque, de produto) consultados por anúncio */
const SKU_OK = /^[^\u0000-\u001f]{1,80}$/;
/* os grupos de cada sonda; sem `oque` rodam os da 1ª rodada (`produto` só quando pedido) */
const GRUPOS_ML = ['anuncios', 'full', 'promocoes', 'ads', 'produto'];
const GRUPOS_SHOPEE = ['conta', 'anuncios', 'campanhas', 'ads', 'produto'];
const SEM_OQUE = (todos) => todos.filter((g) => g !== 'produto');

/* nomes de campo que identificam GENTE (ou pedido de gente): nunca saem */
const OMITIR = new Set(['identification', 'email', 'secure_email', 'phone', 'alternative_phone', 'address', 'first_name', 'last_name', 'doc_number', 'doc_type',
  'receiver_name', 'receiver_phone', 'recipient_address', 'buyer', 'buyer_username', 'buyer_user_id', 'payer', 'billing_info', 'registration_identifiers', 'company', 'bank_account',
  'order_sn', 'ordersn', 'order_id',
  /* …e nada com cara de CREDENCIAL: o JSON da sonda é colado numa conversa — chave que aparece ali está queimada */
  'access_token', 'refresh_token', 'token', 'secret', 'client_secret', 'partner_key', 'sign', 'authorization', 'password', 'api_key', 'apikey']);

/* (Codex #887) e credencial também não sai DENTRO de um texto: o valor de um parâmetro secreto numa URL (`?k=…`,
   `access_token=…`, `sign=…`) e o que vem depois de "Bearer". É assim que uma chave escapa sem ter "nome de campo": a
   mensagem de erro de rede traz a URL inteira do pedido que falhou. Vale pra todo texto que a sonda devolve. */
const PARAM_SECRETO = /([?&](?:k|key|access_token|refresh_token|token|sign|secret|client_secret|partner_key|api_key|apikey|password)=)[^&\s"'<>]*/gi;
function semSegredo(txt) { return String(txt).replace(PARAM_SECRETO, '$1[omitido]').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[omitido]'); }

function limpar(v, nivel, maxLista) {
  const max = maxLista > 0 ? maxLista : MAX_LISTA;
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') v = semSegredo(v);
  if (typeof v === 'string') return v.length > MAX_TEXTO ? v.slice(0, MAX_TEXTO) + '…[+' + (v.length - MAX_TEXTO) + ' caracteres]' : v;
  if (nivel > 12) return '[aninhado demais]';
  if (Array.isArray(v)) {
    const a = v.slice(0, max).map((x) => limpar(x, nivel + 1, max));
    if (v.length > max) a.push('…e mais ' + (v.length - max) + ' (lista cortada pela sonda)');
    return a;
  }
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = OMITIR.has(k.toLowerCase()) ? '[omitido pela sonda]' : limpar(v[k], nivel + 1, max);
    return o;
  }
  return String(v);
}
/* a resposta de um passo: limpa e, se ainda for grande demais, só o começo (dito) */
function encolher(v, maxLista) {
  const limpo = limpar(v, 0, maxLista);
  const txt = JSON.stringify(limpo);
  if (txt == null) return null;
  return txt.length <= MAX_RESPOSTA ? limpo : { cortada_pela_sonda: true, tamanho: txt.length, comeco: txt.slice(0, MAX_RESPOSTA) };
}

const hojeSP = (agora) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora || new Date());
const diasAtras = (dia, n) => new Date(Date.parse(dia + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const prazos = (o) => ({ passo: Number(o.prazoPassoMs) > 0 ? Number(o.prazoPassoMs) : PRAZO_PASSO_MS, total: Number(o.prazoTotalMs) > 0 ? Number(o.prazoTotalMs) : PRAZO_TOTAL_MS });
const gruposPedidos = (oque, todos, item) => { const g = String(oque || '').trim().toLowerCase(); return todos.includes(g) ? [g] : (item ? ['produto'] : SEM_OQUE(todos)); };
/* o `&item=` como a pessoa cola: sem espaço, em maiúsculas, e sem o hífen que o endereço do anúncio traz ("MLB-123" → "MLB123") */
const itemPedido = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^([A-Z]{3})-(?=\d)/, '$1');

/* ═══ MERCADO LIVRE ═══ */
async function sondarML(o) {
  const p = prazos(o || {});
  const acaba = Date.now() + p.total;
  const pedido = itemPedido(o && o.item);
  const grupos = gruposPedidos(o && o.oque, GRUPOS_ML, pedido);
  const hoje = (o && o.hoje) || hojeSP();
  const passos = [];
  const fim = (ok, extra) => Object.assign({ ok, sonda: 'mercado-livre', grupos, feita_em: new Date().toISOString(), passos,
    leia: 'Sonda SÓ LEITURA: cada passo é um GET ao Mercado Livre e a resposta dele como veio (encolhida; dado de gente omitido). Nada foi gravado nem interpretado. Erro num passo (403, 404, "not found") é informação: diz que aquele caminho não vale pra esta conta ou que o app não tem a permissão.' }, extra);

  /* anúncio pedido fora do formato: diz, em vez de olhar OUTRO anúncio calado */
  const ID_ITEM = /^[A-Z]{3}\d+$/;
  if (grupos.includes('produto') && pedido && !ID_ITEM.test(pedido)) return fim(false, { erro: 'o &item= não tem o formato de um anúncio do Mercado Livre (ex.: MLB1234567890) — nada foi pedido' });

  let token = null, semPrazo = false;
  try { token = await comPrazo(Math.min(p.passo, p.total), () => o.garantirTokenML(), () => { semPrazo = true; return null; }); }
  catch (e) { return fim(false, { erro: 'o acesso ao Mercado Livre não está disponível (' + semSegredo((e && e.message) || e).slice(0, 100) + ')' }); }
  if (semPrazo) return fim(false, { erro: 'o acesso ao Mercado Livre não veio no prazo (a renovação do token não respondeu)' });
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
    if (r.erro) reg.erro = semSegredo(r.erro); else reg.resposta = encolher(mostrar ? mostrar(r.corpo) : r.corpo);
    passos.push(reg);
    return (!r.erro && r.http >= 200 && r.http < 300 && r.corpo && typeof r.corpo === 'object') ? r.corpo : null;
  };
  const idsDe = (corpo, n) => ((corpo && Array.isArray(corpo.results)) ? corpo.results : []).filter((x) => typeof x === 'string' && ID_ITEM.test(x)).slice(0, n);

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
  /* o anunciante de Product Ads: o número e o site dele (sem ele, o da conta) — só no formato certo */
  const periodo = 'date_from=' + diasAtras(hoje, 7) + '&date_to=' + hoje;
  const anuncianteDeAds = async (grupo) => {
    const anunciante = await pedir(grupo, 'o anunciante de Product Ads desta conta', '/advertising/advertisers', 'product_id=PADS', 1);
    const a = anunciante && Array.isArray(anunciante.advertisers) ? anunciante.advertisers[0] : null;
    const adv = a && /^\d+$/.test(String(a.advertiser_id)) ? String(a.advertiser_id) : null;
    const siteAds = (a && /^[A-Z]{3}$/.test(String(a.site_id)) ? String(a.site_id) : null) || site;
    return adv && siteAds ? { siteAds, base: '/marketplace/advertising/' + siteAds + '/advertisers/' + adv + '/product_ads' } : null;
  };
  if (grupos.includes('ads')) {
    const an = await anuncianteDeAds('ads');
    if (an) {
      const base = an.base;
      await pedir('ads', 'campanhas de Product Ads (as 5 primeiras, com os números dos últimos 7 dias) — caminho CANDIDATO', base + '/campaigns/search', 'limit=5&offset=0&' + periodo + '&metrics=clicks,prints,cost,cpc,acos,roas,units_quantity,total_amount&metrics_summary=true', 2);
      await pedir('ads', 'anúncios dentro de Product Ads (os 5 primeiros)', base + '/ads/search', 'limit=5&offset=0&' + periodo + '&metrics=clicks,prints,cost,acos', 2);
    }
  }
  if (grupos.includes('produto')) {
    /* passo que não dá pra fazer aparece, com o motivo — nunca some calado */
    const pular = (nome, motivo) => { passos.push({ grupo: 'produto', passo: nome, pulado: motivo }); };
    const corpoDoItem = (det) => (det && det[0] && det[0].body) || null;
    const variacoes = (b) => (Array.isArray(b.variations) ? b.variations.filter((v) => v).slice(0, MAX_VARIACOES) : []);
    const skuDosAtributos = (lista) => { const a = Array.isArray(lista) ? lista.find((x) => x && x.id === 'SELLER_SKU') : null; return a ? a.value_name : null; };
    /* o SKU: o do anúncio (atributo; depois o campo antigo); sem ele, o da primeira variação que tiver */
    const skuDe = (b) => {
      if (!b) return null;
      const candidatos = [skuDosAtributos(b.attributes), b.seller_custom_field];
      for (const v of variacoes(b)) candidatos.push(skuDosAtributos(v.attributes), v.seller_custom_field);
      return candidatos.find((x) => typeof x === 'string' && SKU_OK.test(x)) || null;
    };
    /* um código (de estoque, de produto): o do anúncio e os das variações — só no formato certo, sem repetir, poucos */
    const codigosDe = (b, campo, formato) => (b ? Array.from(new Set([b[campo]].concat(variacoes(b).map((v) => v[campo])).filter((x) => typeof x === 'string' && formato.test(x)))).slice(0, MAX_CODIGOS) : []);
    const COD_ESTOQUE = /^[A-Z0-9]{4,20}$/, COD_PRODUTO = /^[A-Z]{3}U\d+$/;
    /* dos atributos (dezenas, no anúncio e em cada variação) só interessam o SKU e o código de barras */
    const soSkuEBarras = (lista) => lista.filter((a) => a && (a.id === 'SELLER_SKU' || a.id === 'GTIN')).map((a) => ({ id: a.id, value_name: a.value_name }));
    const enxuto = (c) => (Array.isArray(c) ? c.map((l) => {
      if (!l || !l.body || typeof l.body !== 'object') return l;   /* linha sem corpo (ou com um texto no lugar): como veio */
      const body = Object.assign({}, l.body);
      if (Array.isArray(body.attributes)) body.attributes = soSkuEBarras(body.attributes);
      if (Array.isArray(body.variations)) body.variations = body.variations.map((v) => (v && Array.isArray(v.attributes) ? Object.assign({}, v, { attributes: soSkuEBarras(v.attributes) }) : v));
      return Object.assign({}, l, { body });
    }) : c);
    const campos = 'id,title,status,sub_status,available_quantity,sold_quantity,price,inventory_id,user_product_id,seller_custom_field,shipping,health,attributes,variations';
    const estoquePorLocal = async (b, deQuem) => {
      const ups = codigosDe(b, 'user_product_id', COD_PRODUTO);
      if (!ups.length) pular('o estoque por local (Full × galpão) ' + deQuem, 'o anúncio não trouxe o código do produto (user_product_id) — nem no anúncio, nem nas variações');
      for (const up of ups) await pedir('produto', 'o estoque do produto ' + up + ' por local (Full × galpão)', '/user-products/' + up + '/stock', '');
    };
    /* o anúncio a olhar: o pedido em `&item=` ou o ativo que mais vendeu */
    const item = pedido || idsDe(await pedir('produto', 'o anúncio ativo que mais vendeu', meus, 'status=active&orders=sold_quantity_desc&limit=1'), 1)[0] || null;
    if (!item) pular('o anúncio de perto', 'a busca não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)');
    else {
      const b = corpoDoItem(await pedir('produto', 'o anúncio ' + item + ' (dos atributos, só o SKU e o código de barras; `include_attributes=all` traz os das variações)', '/items', 'ids=' + item + '&attributes=' + campos + '&include_attributes=all', 0, enxuto));
      const sku = skuDe(b);
      if (!sku) pular('os anúncios do mesmo SKU', 'o anúncio não trouxe SKU — nem no anúncio, nem nas variações');
      else {
        await pedir('produto', 'os anúncios do mesmo SKU — busca pelo SKU do atributo (seller_sku)', meus, 'seller_sku=' + encodeURIComponent(sku) + '&limit=5');
        await pedir('produto', 'os anúncios do mesmo SKU — busca pelo SKU do campo antigo (sku)', meus, 'sku=' + encodeURIComponent(sku) + '&limit=5');
      }
      await pedir('produto', 'as promoções do anúncio ' + item, '/seller-promotions/items/' + item, 'app_version=v2');
      await pedir('produto', 'as visitas do anúncio ' + item + ', por dia (7 dias)', '/items/' + item + '/visits/time_window', 'last=7&unit=day');
      await pedir('produto', 'as visitas da conta inteira, por dia (7 dias)', '/users/' + id + '/items_visits/time_window', 'last=7&unit=day');
      await pedir('produto', 'a qualidade do anúncio ' + item + ' — caminho CANDIDATO', '/item/' + item + '/performance', '');
      await estoquePorLocal(b, 'do anúncio ' + item);
      /* o anúncio em Product Ads: pela lista com filtro (nos dois caminhos) e direto. E, pra um 404 não ficar sem leitura
         (o caminho não vale × este anúncio não está em Ads), o MESMO pedido direto pra um anúncio que está em Ads com certeza */
      const an = await anuncianteDeAds('produto');
      if (!an) pular('o anúncio ' + item + ' em Product Ads', 'não achei o anunciante de Product Ads desta conta (o passo anterior diz o que veio)');
      else {
        const metricas = '&metrics=clicks,prints,cost,acos,total_amount';
        const comFiltro = 'limit=5&offset=0&' + periodo + metricas + '&filters[item_id]=' + item;
        await pedir('produto', 'o anúncio ' + item + ' em Product Ads — pela busca, com filtro', an.base + '/ads/search', comFiltro, 2);
        await pedir('produto', 'o anúncio ' + item + ' em Product Ads — pela lista com filtro, no caminho da documentação', an.base + '/ads', comFiltro, 2);
        await pedir('produto', 'o anúncio ' + item + ' em Product Ads — direto', '/marketplace/advertising/' + an.siteAds + '/product_ads/ads/' + item, periodo + metricas, 2);
        const emAds = await pedir('produto', 'um anúncio que está em Product Ads', an.base + '/ads/search', 'limit=1&offset=0&' + periodo + '&metrics=clicks', 2);
        const r0 = emAds && Array.isArray(emAds.results) ? emAds.results[0] : null;
        const outro = r0 && ID_ITEM.test(String(r0.item_id)) ? String(r0.item_id) : null;
        if (!outro) pular('um anúncio que está em Product Ads — direto', 'o passo anterior não devolveu um anúncio em Product Ads pra conferir o caminho direto');
        else if (outro !== item) await pedir('produto', 'o anúncio ' + outro + ' (que está em Product Ads) — direto', '/marketplace/advertising/' + an.siteAds + '/product_ads/ads/' + outro, periodo + metricas, 2);
      }
    }
    /* um anúncio do FULL, com o estoque pelos DOIS caminhos: o do Full e o por local */
    const noFull = idsDe(await pedir('produto', 'um anúncio do Full', meus, 'logistic_type=fulfillment&status=active&limit=1'), 1)[0] || null;
    if (!noFull) pular('o estoque de um anúncio do Full', 'a busca não devolveu nenhum anúncio ativo no Full (o passo anterior diz o que veio)');
    else {
      const f = corpoDoItem(await pedir('produto', 'o anúncio do Full ' + noFull, '/items', 'ids=' + noFull + '&attributes=id,title,status,available_quantity,inventory_id,user_product_id,shipping,variations'));
      const codigos = codigosDe(f, 'inventory_id', COD_ESTOQUE);
      if (!codigos.length) pular('o estoque no Full do anúncio ' + noFull, 'o anúncio não trouxe o código de estoque (inventory_id) — nem no anúncio, nem nas variações');
      for (const codigo of codigos) await pedir('produto', 'o estoque no Full do código ' + codigo, '/inventories/' + codigo + '/stock/fulfillment', '');
      await estoquePorLocal(f, 'do anúncio do Full ' + noFull);
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
    ['conta', 'desempenho da loja (saúde da conta), com TODAS as métricas', '/api/v2/account_health/get_shop_performance', '', MAX_LISTA_INTEIRA],
    /* (`shop_performance` e `get_shop_penalty` não existem — a Shopee respondeu error_not_found em 15/11. Este existe, mas veio "api_suspended".) */
    ['conta', 'pontos de penalidade da loja', '/api/v2/account_health/shop_penalty', ''],
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
  const pedido = itemPedido(o && o.item);
  const grupos = gruposPedidos(o && o.oque, GRUPOS_SHOPEE, pedido);
  const hoje = (o && o.hoje) || hojeSP();
  const passos = [];
  const fim = (ok, erro) => ({ ok, sonda: 'shopee', loja: (o && o.loja) || null, grupos, feita_em: new Date().toISOString(), passos, erro,
    leia: 'Sonda SÓ LEITURA: cada passo é um GET à Shopee, feito pelo serviço que tem o token, e a resposta dele como veio (encolhida; dado de gente omitido). Nada foi gravado nem interpretado. Parte dos caminhos é CANDIDATO — "error_not_found", "error_param" ou erro de permissão num passo é a própria Shopee dizendo que aquele nome/parâmetro não vale ou que o app não tem o acesso: é informação, não defeito.' });
  /* anúncio pedido fora do formato: diz, em vez de olhar OUTRO anúncio calado */
  const ID_ANUNCIO = /^\d{4,20}$/;
  if (grupos.includes('produto') && pedido && !ID_ANUNCIO.test(pedido)) return fim(false, 'o &item= não tem o formato de um anúncio da Shopee (só o número, ex.: 23456789012) — nada foi pedido');
  /* um pedido à Shopee. Devolve a resposta dela (objeto) quando veio sem erro, senão null; registra o passo */
  const passo = async (grupo, nome, caminho, q, maxLista) => {
    const pedido = 'GET ' + caminho + (q ? '?' + q : '');
    const resta = acaba - Date.now();
    if (resta < MINIMO_PRA_OUTRO_PASSO_MS) { passos.push({ grupo, passo: nome, pedido, pulado: 'a sonda chegou ao prazo total antes deste passo' }); return null; }
    const r = await comPrazo(Math.min(p.passo, resta), () => o.pedirAoSync('shopee-raw', { caminho, q }, o.loja), () => ({ ok: false, erro: 'sem resposta no prazo' }))
      .catch((e) => ({ ok: false, erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));
    const cru = r && r.dados && typeof r.dados === 'object' ? (r.dados.resposta !== undefined ? r.dados.resposta : r.dados) : null;
    const reg = { grupo, passo: nome, pedido, http: (r && r.status) || null };
    /* (mesma classe do Codex #889) o serviço que tem o token diz `ok: false` quando o HTTP falhou ou quando ELE recusou, com
       o motivo em `dados.erro` — não no `erro` de cima. Recusa não é resposta da Shopee: o passo sai com `erro` (e o
       corpo, como veio, pra conferência), e não alimenta o passo seguinte. */
    const erroShopee = cru && typeof cru === 'object' && cru.error ? String(cru.error) + (cru.message ? ' — ' + String(cru.message).slice(0, 200) : '') : null;
    const recusa = r && r.ok === false ? ((r.erro && String(r.erro)) || (r.dados && typeof r.dados === 'object' && r.dados.erro && String(r.dados.erro)) || erroShopee || ('o serviço da Shopee respondeu HTTP ' + (r.status != null ? r.status : '?'))) : null;
    const erro = recusa || erroShopee;
    if (erro) reg.erro = semSegredo(erro);
    if (cru != null) reg.resposta = encolher(cru, maxLista);
    passos.push(reg);
    return erro ? null : cru;
  };
  for (const [grupo, nome, caminho, q, maxLista] of roteiroShopee(hoje)) if (grupos.includes(grupo)) await passo(grupo, nome, caminho, q, maxLista);
  if (grupos.includes('produto')) {
    /* passo que não dá pra fazer aparece, com o motivo — nunca some calado (Codex #888) */
    const pular = (nome, motivo) => { passos.push({ grupo: 'produto', passo: nome, pulado: motivo }); };
    /* UM anúncio de perto: o pedido em `&item=` ou o primeiro ativo da lista */
    let item = pedido || null;
    if (!item) {
      const lista = await passo('produto', 'um anúncio ativo', '/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=NORMAL');
      const primeiro = lista && lista.response && lista.response.item && lista.response.item[0];
      item = primeiro && ID_ANUNCIO.test(String(primeiro.item_id)) ? String(primeiro.item_id) : null;
    }
    if (!item) pular('o anúncio de perto', 'a lista não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)');
    else {
      const base = await passo('produto', 'o anúncio ' + item + ' (SKU, situação, estoque, preço)', '/api/v2/product/get_item_base_info', 'item_id_list=' + item);
      await passo('produto', 'o anúncio ' + item + ' — visitas, vendas e avaliação', '/api/v2/product/get_item_extra_info', 'item_id_list=' + item);
      const modelos = await passo('produto', 'as variações do anúncio ' + item + ' (SKU e estoque de cada uma)', '/api/v2/product/get_model_list', 'item_id=' + item);
      await passo('produto', 'as promoções do anúncio ' + item, '/api/v2/product/get_item_promotion', 'item_id_list=' + item);
      /* o SKU: o do anúncio; anúncio com variação guarda o SKU em cada variação — vale o da primeira que tiver */
      const umItem = base && base.response && base.response.item_list && base.response.item_list[0];
      const lista = modelos && modelos.response && Array.isArray(modelos.response.model) ? modelos.response.model.slice(0, MAX_VARIACOES) : [];
      const sku = [umItem && umItem.item_sku].concat(lista.map((m) => m && m.model_sku)).find((x) => typeof x === 'string' && SKU_OK.test(x)) || null;
      if (!sku) pular('os anúncios do mesmo SKU', 'o anúncio não trouxe SKU — nem no anúncio (item_sku), nem nas variações (model_sku)');
      else await passo('produto', 'os anúncios do mesmo SKU — parâmetro CANDIDATO', '/api/v2/product/search_item', 'offset=0&page_size=5&item_sku=' + encodeURIComponent(sku));
    }
  }
  const respondeu = passos.some((x) => x.resposta != null && !x.erro);
  return fim(respondeu, respondeu ? undefined : 'nenhum passo teve resposta da Shopee (o serviço que tem o token respondeu? veja o "erro" de cada passo)');
}

module.exports = { sondarML, sondarShopee, roteiroShopee, limpar, encolher, semSegredo, GRUPOS_ML, GRUPOS_SHOPEE, PRAZO_PASSO_MS, PRAZO_TOTAL_MS, MAX_LISTA, MAX_LISTA_INTEIRA, MAX_VARIACOES, MAX_CODIGOS, MAX_TEXTO, MAX_RESPOSTA };
