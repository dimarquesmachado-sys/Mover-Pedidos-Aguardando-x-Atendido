'use strict';
/* 15/11 — SONDAS DE MARKETPLACE (lib/checkout/sondas-marketplace.js): o que o Mercado Livre e a Shopee devolvem pra a
   conta sobre anúncios, estoque do Full, promoções, Ads e saúde da conta — o passo de ANTES de ligar isso ao chat.

   O que se prova (a peça de produção e as rotas de produção, com o ML e o serviço da Shopee de mentira):
   A. ENCOLHER: dado de gente some (em qualquer profundidade, com qualquer caixa); lista longa é cortada e diz quantos
      sobraram; texto longo e resposta grande demais são cortados e DIZEM que foram.
   B. MERCADO LIVRE: a sequência é fixa e SÓ de leitura (GET), só pra api.mercadolibre.com, com a versão certa em cada
      pedido de Ads; do cadastro só saem id, site e apelido; nada de pedido/venda é consultado; o que vem de uma
      resposta só entra no caminho do pedido seguinte se tiver o formato certo (id de anúncio, código de estoque,
      número do anunciante); `oque` roda um grupo só; passo com erro vira informação e a sonda segue; API muda vira
      "sem resposta no prazo" (e a conexão é abortada); passado o prazo total, os passos seguintes ficam "pulado";
      sem token, a sonda diz e não pede nada.
   C. SHOPEE: todo passo vai pelo serviço que tem o token (`shopee-raw`), na loja pedida, só em caminhos de leitura da
      conta/anúncio/campanha/ads (nada de pedido, devolução ou pagamento); o erro que a Shopee manda aparece no passo;
      serviço mudo vira "sem resposta no prazo"; `oque` roda um grupo só; sem nenhuma resposta, a sonda diz.
   (Codex #887) CREDENCIAL DENTRO DE TEXTO: a mensagem de erro de rede traz a URL inteira do pedido que falhou — com a
      chave do serviço da Shopee no `?k=`. Ela não sai: nem na sonda (todo texto passa pelo filtro), nem na ORIGEM (a
      peça da Shopee tira a chave de toda mensagem de erro que devolve — vale pras sondas que já existiam).
   D. AS ROTAS: `<prefixo>/chat-analise?sonda=ml` e `<prefixo>/shopee/sonda-conta` são só do admin (sem a chave: 404 e
      NADA é pedido), rodam com as peças DA EMPRESA, não gravam nada e não gastam pergunta do chat.
   F. 2ª RODADA — O GRUPO `produto` (UM anúncio de perto): só roda quando pedido (`oque=produto`, ou `&item=` sozinho) —
      a sonda sem `oque` continua a da 1ª rodada; a sequência é fixa e só de leitura; `&item=` fora do formato é
      RECUSADO sem pedir nada (em vez de a sonda olhar outro anúncio calada); o SKU, o código do produto, o código de
      estoque e o anúncio que vêm de uma resposta só entram no pedido seguinte no formato certo (o SKU, codificado);
      dos atributos do anúncio só saem o SKU e o código de barras; e a lista de métricas da saúde da conta da Shopee
      sai inteira (as outras listas continuam cortadas).
      (Codex #888) ANÚNCIO COM VARIAÇÃO: o SKU, o código do produto e o código de estoque são procurados também nas
      variações (poucas, sem repetir); e todo passo que não dá pra fazer aparece como "pulado" COM O MOTIVO — nenhum
      some calado. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sondas-'));
process.env.ADMIN_KEY = 'chave-adm'; process.env.GOODBKP_ADMIN = 'dono'; process.env.GOODBKP_CACHE_DIR = TMP; process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste';
const rede = { vistos: [], ml: null };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url, opts) => { rede.vistos.push([String(url), opts || {}]); return rede.ml(String(url), opts || {}); } };

const S = require('../lib/checkout/sondas-marketplace');
const J = (corpo, st) => ({ status: st || 200, ok: !st || st < 300, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)), json: async () => corpo });
const nunca = () => new Promise(() => {});

/* o Mercado Livre de mentira: responde pelo caminho */
const mlDeMentira = (extra) => {
  const vistos = [];
  const fetch = async (url, opts) => {
    vistos.push({ url, metodo: opts.method, cab: opts.headers, sinal: opts.signal });
    const c = url.replace('https://api.mercadolibre.com', '');
    if (extra) { const r = extra(c, opts); if (r !== undefined) return r; }
    if (c === '/users/me') return J({ id: 123456, site_id: 'MLB', nickname: 'LOJA TESTE', email: 'dono@loja.com', first_name: 'Fulano', identification: { type: 'CNPJ', number: '12345678000199' }, phone: { number: '11999990000' }, address: { address: 'Rua X, 1' } });
    if (c.startsWith('/users/123456/items/search?include_filters=true')) return J({ paging: { total: 900 }, results: ['MLB1', 'MLB2'], available_filters: [{ id: 'status', values: [{ id: 'active', results: 812 }, { id: 'paused', results: 88 }] }] });
    if (c.startsWith('/users/123456/items/search?status=active')) return J({ paging: { total: 812 }, results: ['MLB1001', 'MLB1002', '../../orders/1', 'MLB1003?x=1', 42, 'MLB1004'] });
    if (c.startsWith('/users/123456/items/search?logistic_type=fulfillment')) return J({ paging: { total: 40 }, results: ['MLB2001'] });
    if (c.startsWith('/users/123456/items/search')) return J({ paging: { total: 3 }, results: [] });
    if (c.startsWith('/items?ids=MLB2001')) return J([{ code: 200, body: { id: 'MLB2001', inventory_id: 'ABCD12345', variations: [{ inventory_id: 'EFGH67890' }, { inventory_id: 'IJKL11111' }, { inventory_id: '../x' }] } }]);
    if (c.startsWith('/items?ids=')) return J([{ code: 200, body: { id: 'MLB1001', title: 'Kit', status: 'active', available_quantity: 5 } }]);
    if (c.startsWith('/inventories/')) return J({ inventory_id: c.split('/')[2], total: 10, available_quantity: 8, not_available_quantity: 2 });
    if (/^\/items\/[A-Z]{3}\d+\/visits\/time_window\?/.test(c) || c.startsWith('/users/123456/items_visits/time_window?')) return J({ total_visits: 70, last: 7, unit: 'day', results: [{ date: '2026-11-14T00:00:00Z', total: 10 }] });
    if (/^\/item\/[A-Z]{3}\d+\/performance$/.test(c)) return J({ score: 80, level: 'Profissional' });
    if (/^\/user-products\/[A-Z]{3}U\d+\/stock$/.test(c)) return J({ locations: [{ type: 'meli_facility', quantity: 3 }, { type: 'selling_address', quantity: 9 }], user_id: 123456 });
    if (c.startsWith('/seller-promotions/')) return J({ message: 'forbidden', status: 403 }, 403);
    if (c.startsWith('/advertising/advertisers?')) return J({ advertisers: [{ advertiser_id: 777, site_id: 'MLB', advertiser_name: 'LOJA TESTE' }] });
    if (c.startsWith('/marketplace/advertising/')) return J({ paging: { total: 2 }, results: [{ id: 1, name: 'Campanha', status: 'active', budget: 50 }] });
    return J({ erro: 'caminho que o teste não previu: ' + c }, 500);
  };
  return { fetch, vistos, caminhos: () => vistos.map((v) => v.url.replace('https://api.mercadolibre.com', '')) };
};

(async () => {
  /* ═══ A. ENCOLHER ═══ */
  {
    const sujo = { id: 1, email: 'a@b.c', Email: 'x', PHONE: '9', buyer: { nickname: 'COMPRADOR' }, order_sn: '2511SN', dentro: [{ identification: { number: '123' }, ok: true, first_name: 'Fulano' }], titulo: 'Kit', billing_info: { doc_number: '1' } };
    assert.deepStrictEqual(S.limpar(sujo, 0), { id: 1, email: '[omitido pela sonda]', Email: '[omitido pela sonda]', PHONE: '[omitido pela sonda]', buyer: '[omitido pela sonda]', order_sn: '[omitido pela sonda]',
      dentro: [{ identification: '[omitido pela sonda]', ok: true, first_name: '[omitido pela sonda]' }], titulo: 'Kit', billing_info: '[omitido pela sonda]' }, 'dado de gente saiu na sonda');
    /* nada com cara de credencial sai: o JSON da sonda é colado numa conversa */
    assert.deepStrictEqual(S.limpar({ access_token: 'APP_USR-123', Refresh_Token: 'TG-9', dentro: { secret: 's', sign: 'abc', partner_key: 'k', Authorization: 'Bearer x', password: 'p', api_key: 'a' }, token_type: 'bearer', expires_in: 21600 }, 0),
      { access_token: '[omitido pela sonda]', Refresh_Token: '[omitido pela sonda]', dentro: { secret: '[omitido pela sonda]', sign: '[omitido pela sonda]', partner_key: '[omitido pela sonda]', Authorization: '[omitido pela sonda]', password: '[omitido pela sonda]', api_key: '[omitido pela sonda]' }, token_type: 'bearer', expires_in: 21600 },
      'credencial saiu na sonda');
    /* (Codex #887) …nem DENTRO de um texto: o valor de um parâmetro secreto numa URL e o que vem depois de "Bearer" */
    assert.deepStrictEqual([
      S.semSegredo('request to https://servico.onrender.com/amb/interno/shopee-raw?caminho=%2Fapi%2Fv2%2Fshop&q=&k=SEGREDO-123 failed, reason: connect ECONNREFUSED 10.0.0.1:443'),
      S.semSegredo('GET https://partner.shopeemobile.com/api/v2/x?partner_id=1&sign=abcdef&access_token=tok123&shop_id=9 falhou; Authorization: Bearer APP_USR-1.2-3_x fim'),
      S.semSegredo('https://x/y?K=Maiusculo&Token=t&refresh_token=r&secret=s&client_secret=c&partner_key=p&api_key=a&apikey=b&password=z&key=y'),
      S.semSegredo('token_type=bearer&page_token=abc&k9=1&ok=2&monkey=3 — nada disto é segredo'), S.semSegredo(''), S.semSegredo(12)],
    ['request to https://servico.onrender.com/amb/interno/shopee-raw?caminho=%2Fapi%2Fv2%2Fshop&q=&k=[omitido] failed, reason: connect ECONNREFUSED 10.0.0.1:443',
      'GET https://partner.shopeemobile.com/api/v2/x?partner_id=1&sign=[omitido]&access_token=[omitido]&shop_id=9 falhou; Authorization: Bearer [omitido] fim',
      'https://x/y?K=[omitido]&Token=[omitido]&refresh_token=[omitido]&secret=[omitido]&client_secret=[omitido]&partner_key=[omitido]&api_key=[omitido]&apikey=[omitido]&password=[omitido]&key=[omitido]',
      'token_type=bearer&page_token=abc&k9=1&ok=2&monkey=3 — nada disto é segredo', '', '12'], 'credencial dentro de um texto saiu (ou o filtro comeu o que não é segredo)');
    assert.deepStrictEqual(S.limpar({ erro: 'request to https://s/x?k=SEGREDO-123 failed', lista: ['ok', 'Bearer abc.def'], n: 1 }, 0), { erro: 'request to https://s/x?k=[omitido] failed', lista: ['ok', 'Bearer [omitido]'], n: 1 }, 'texto DENTRO da resposta saiu com credencial');
    const lista = S.limpar(Array.from({ length: S.MAX_LISTA + 7 }, (_, i) => i), 0);
    assert.deepStrictEqual([lista.length, lista[S.MAX_LISTA - 1], lista[S.MAX_LISTA]], [S.MAX_LISTA + 1, S.MAX_LISTA - 1, '…e mais 7 (lista cortada pela sonda)'], 'lista longa tem que ser cortada e dizer quantos sobraram');
    assert.deepStrictEqual(S.limpar([1, 2], 0), [1, 2]);
    const texto = S.limpar('x'.repeat(S.MAX_TEXTO + 50), 0);
    assert.ok(texto.length < S.MAX_TEXTO + 40 && /\[\+50 caracteres\]$/.test(texto), 'texto longo tem que ser cortado e dizer');
    assert.deepStrictEqual([S.limpar(null, 0), S.limpar(0, 0), S.limpar(false, 0), S.limpar('', 0), S.limpar(undefined, 0)], [null, 0, false, '', undefined]);
    let fundo = 'fim'; for (let i = 0; i < 20; i++) fundo = { a: fundo };
    assert.ok(/aninhado demais/.test(JSON.stringify(S.limpar(fundo, 0))));
    /* resposta grande demais: só o começo, e DIZ */
    const grande = {}; for (let i = 0; i < 400; i++) grande['campo_' + i] = 'y'.repeat(100);
    const g = S.encolher(grande);
    assert.deepStrictEqual([g.cortada_pela_sonda, g.comeco.length, g.tamanho > S.MAX_RESPOSTA], [true, S.MAX_RESPOSTA, true], 'resposta grande demais tem que virar o começo dela, dito');
    assert.deepStrictEqual([S.encolher({ a: 1 }), S.encolher(undefined)], [{ a: 1 }, null]);
    /* o corte vem DEPOIS de omitir: o começo de uma resposta grande não traz dado de gente */
    assert.ok(!/segredo@/.test(JSON.stringify(S.encolher(Object.assign({ email: 'segredo@x.com' }, grande)))));
  }

  /* ═══ B. MERCADO LIVRE ═══ */
  {
    const ml = mlDeMentira();
    const r = await S.sondarML({ garantirTokenML: async () => 'tk-loja', fetch: ml.fetch, hoje: '2026-11-15' });
    assert.deepStrictEqual([r.ok, r.sonda, r.loja, r.grupos, r.erro], [true, 'mercado-livre', 'LOJA TESTE', ['anuncios', 'full', 'promocoes', 'ads'], undefined]);
    /* a sequência, inteira e na ordem */
    const DET = 'id,title,status,sub_status,available_quantity,sold_quantity,price,inventory_id,shipping,health,catalog_listing,listing_type_id,last_updated,seller_custom_field,variations';
    assert.deepStrictEqual(ml.caminhos(), [
      '/users/me',
      '/users/123456/items/search?include_filters=true&limit=5',
      '/users/123456/items/search?status=active&limit=5',
      '/users/123456/items/search?status=paused&limit=1',
      '/users/123456/items/search?reputation_health_gauge=unhealthy&limit=3',
      '/items?ids=MLB1001,MLB1002,MLB1004&attributes=' + DET,
      '/users/123456/items/search?logistic_type=fulfillment&status=active&limit=5',
      '/items?ids=MLB2001&attributes=id,title,status,available_quantity,inventory_id,shipping,variations',
      '/inventories/ABCD12345/stock/fulfillment',
      '/inventories/EFGH67890/stock/fulfillment',
      '/seller-promotions/users/123456?app_version=v2',
      '/advertising/advertisers?product_id=PADS',
      '/marketplace/advertising/MLB/advertisers/777/product_ads/campaigns/search?limit=5&offset=0&date_from=2026-11-08&date_to=2026-11-15&metrics=clicks,prints,cost,cpc,acos,roas,units_quantity,total_amount&metrics_summary=true',
      '/marketplace/advertising/MLB/advertisers/777/product_ads/ads/search?limit=5&offset=0&date_from=2026-11-08&date_to=2026-11-15&metrics=clicks,prints,cost,acos',
    ], 'a sequência de pedidos da sonda do ML mudou (ou algo que veio de uma resposta entrou no caminho sem ter o formato certo)');
    /* só leitura, só o ML, com o token da loja e a versão certa em cada pedido */
    assert.ok(ml.vistos.every((v) => v.metodo === 'GET' && v.url.startsWith('https://api.mercadolibre.com/') && v.cab.Authorization === 'Bearer tk-loja' && v.sinal && !('body' in v)), 'a sonda fez algo que não é um GET ao Mercado Livre com o token da loja');
    assert.deepStrictEqual(ml.vistos.map((v) => v.cab['Api-Version'] || v.cab['api-version'] || ''), ['', '', '', '', '', '', '', '', '', '', '', '1', '2', '2'], 'Product Ads: o anunciante pede a versão 1 e as campanhas/anúncios a versão 2');
    assert.ok(!ml.caminhos().some((c) => /\/orders|\/packs|\/shipments|\/messages|\/claims|\/payments/.test(c)), 'a sonda consultou pedido/venda');
    /* do cadastro só saem o id, o site e o apelido */
    assert.deepStrictEqual(r.passos[0], { grupo: 'conta', passo: 'quem sou (só id, site e apelido)', pedido: 'GET /users/me', http: 200, resposta: { id: 123456, site_id: 'MLB', nickname: 'LOJA TESTE' } });
    assert.ok(!/dono@loja|12345678000199|11999990000|Fulano|Rua X/.test(JSON.stringify(r)), 'dado do cadastro do vendedor saiu na sonda');
    assert.ok(!/tk-loja|Bearer/.test(JSON.stringify(r)), 'o token da loja apareceu na resposta da sonda');
    /* cada passo diz o pedido que fez e traz a resposta como veio */
    assert.deepStrictEqual([r.passos.length, r.passos.map((x) => x.grupo).filter((g, i, a) => a.indexOf(g) === i), r.passos[2].pedido, r.passos[2].resposta.paging.total, r.passos[11].pedido, r.passos[12].http],
      [14, ['conta', 'anuncios', 'full', 'promocoes', 'ads'], 'GET /users/123456/items/search?status=active&limit=5', 812, 'GET /advertising/advertisers?product_id=PADS  [api-version 1]', 200]);
    /* passo com erro é informação: aparece com o HTTP e a resposta, e a sonda SEGUE */
    const promo = r.passos.find((x) => x.grupo === 'promocoes');
    assert.deepStrictEqual([promo.http, promo.resposta, r.passos.indexOf(promo) < r.passos.length - 1], [403, { message: 'forbidden', status: 403 }, true]);
    assert.ok(/SÓ LEITURA/.test(r.leia) && /Erro num passo .* é informação/.test(r.leia));

    /* `oque` roda um grupo só (e nome desconhecido roda todos) */
    for (const [oque, grupos, n] of [['full', ['full'], 5], ['ADS', ['ads'], 4], ['promocoes', ['promocoes'], 2], ['anuncios', ['anuncios'], 6], ['qualquer', ['anuncios', 'full', 'promocoes', 'ads'], 14], ['', ['anuncios', 'full', 'promocoes', 'ads'], 14]]) {
      const m2 = mlDeMentira(); const r2 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m2.fetch, hoje: '2026-11-15', oque });
      assert.deepStrictEqual([r2.grupos, m2.vistos.length], [grupos, n], 'oque=' + oque);
    }

    /* o que vem de uma resposta só vira caminho se tiver o formato certo */
    {
      const m3 = mlDeMentira((c) => {
        if (c === '/users/me') return J({ id: '12/../x', site_id: 'MLB' });
        return undefined;
      });
      const r3 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m3.fetch, hoje: '2026-11-15' });
      assert.deepStrictEqual([r3.ok, /não consegui saber de quem é a conta/.test(r3.erro), m3.vistos.length], [false, true, 1], 'id de conta fora do formato virou caminho');
      const m4 = mlDeMentira((c) => {
        if (c.startsWith('/advertising/advertisers?')) return J({ advertisers: [{ advertiser_id: '7/../../orders', site_id: 'MLB' }] });
        if (c.startsWith('/items?ids=MLB2001')) return J([{ code: 200, body: { inventory_id: 'abc/../x', variations: 'lixo' } }, null, { code: 404 }]);
        return undefined;
      });
      const r4 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m4.fetch, hoje: '2026-11-15' });
      assert.ok(r4.ok && !m4.caminhos().some((c) => c.startsWith('/inventories/') || c.startsWith('/marketplace/')), 'código de estoque ou anunciante fora do formato virou caminho: ' + m4.caminhos().join(' '));
      /* o site do anunciante vale; sem ele, o da conta; site fora do formato não vira caminho */
      const m5 = mlDeMentira((c) => (c.startsWith('/advertising/advertisers?') ? J({ advertisers: [{ advertiser_id: 9, site_id: 'M/B' }] }) : undefined));
      await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m5.fetch, hoje: '2026-11-15', oque: 'ads' });
      assert.ok(m5.caminhos()[2].startsWith('/marketplace/advertising/MLB/advertisers/9/product_ads/campaigns/search?'), m5.caminhos().join(' '));
      /* sem anunciante (a conta não usa Product Ads): para ali, sem inventar caminho */
      const m6 = mlDeMentira((c) => (c.startsWith('/advertising/advertisers?') ? J({ message: 'No permissions found for user_id' }, 404) : undefined));
      const r6 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m6.fetch, hoje: '2026-11-15', oque: 'ads' });
      assert.deepStrictEqual([m6.vistos.length, r6.passos[1].http, r6.passos[1].resposta.message], [2, 404, 'No permissions found for user_id']);
    }

    /* sem token: diz e não pede nada */
    for (const [g, re] of [[async () => null, /sem acesso ao Mercado Livre agora/], [async () => '', /sem acesso ao Mercado Livre agora/], [async () => { throw new Error('refresh falhou'); }, /não está disponível \(refresh falhou\)/], [nunca, /não veio no prazo \(a renovação do token não respondeu\)/]]) {
      const m7 = mlDeMentira(); const r7 = await S.sondarML({ garantirTokenML: g, fetch: m7.fetch, prazoPassoMs: 40, prazoTotalMs: 2000 });
      assert.deepStrictEqual([r7.ok, re.test(r7.erro), m7.vistos.length, r7.passos], [false, true, 0, []]);
    }
    /* a rede cai num passo, a resposta não é JSON noutro: viram informação e a sonda segue */
    {
      const m8 = mlDeMentira((c) => { if (c.includes('status=paused')) throw new Error('ECONNRESET'); if (c.includes('reputation_health_gauge')) return J('<html>erro</html>', 502); return undefined; });
      const r8 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m8.fetch, hoje: '2026-11-15', oque: 'anuncios' });
      assert.deepStrictEqual([r8.ok, r8.passos[3].erro, r8.passos[3].http, r8.passos[4].http, r8.passos[4].resposta, r8.passos.length], [true, 'não respondeu (ECONNRESET)', null, 502, '<html>erro</html>', 6]);
    }
    /* (Codex #887) a mensagem de erro de rede (que traz a URL do pedido) e a do token nunca saem com credencial */
    {
      const m13 = mlDeMentira((c) => { if (c.includes('status=paused')) throw new Error('request to https://api.mercadolibre.com/x?access_token=APP_USR-999 failed (Bearer tk-loja)'); return undefined; });
      const r13 = await S.sondarML({ garantirTokenML: async () => 'tk-loja', fetch: m13.fetch, hoje: '2026-11-15', oque: 'anuncios' });
      assert.ok(/não respondeu \(request to https:\/\/api\.mercadolibre\.com\/x\?access_token=\[omitido\] failed \(Bearer \[omitido\]\)/.test(r13.passos[3].erro) && !/APP_USR-999|tk-loja/.test(JSON.stringify(r13)), 'o erro de rede do ML saiu com credencial: ' + r13.passos[3].erro);
      const r14 = await S.sondarML({ garantirTokenML: async () => { throw new Error('POST https://api.mercadolibre.com/oauth/token?client_secret=SEGREDO-APP recusado'); }, fetch: mlDeMentira().fetch });
      assert.ok(r14.ok === false && /client_secret=\[omitido\]/.test(r14.erro) && !/SEGREDO-APP/.test(JSON.stringify(r14)), 'o erro do token saiu com credencial: ' + r14.erro);
    }
    /* resposta de ERRO não alimenta o passo seguinte, mesmo que traga uma lista (o corpo de um erro não é dado) */
    {
      const m12 = mlDeMentira((c) => (c.includes('status=active&limit=5') ? J({ message: 'erro interno', results: ['MLB7777'] }, 500) : undefined));
      const r12 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m12.fetch, hoje: '2026-11-15', oque: 'anuncios' });
      assert.ok(!m12.caminhos().some((c) => c.startsWith('/items?ids=')) && r12.passos[2].http === 500 && r12.passos[2].resposta.message === 'erro interno', 'a lista que veio dentro de uma resposta de erro virou o pedido seguinte: ' + m12.caminhos().join(' '));
    }
    /* o ML EMUDECE num passo: "sem resposta no prazo", a conexão é abortada, e a sonda segue */
    {
      let sinalMudo = null;
      const m9 = mlDeMentira((c, o) => { if (c.includes('status=paused')) { sinalMudo = o.signal; return nunca(); } return undefined; });
      const t0 = Date.now();
      const r9 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m9.fetch, hoje: '2026-11-15', oque: 'anuncios', prazoPassoMs: 60, prazoTotalMs: 5000 });
      assert.deepStrictEqual([r9.passos[3].erro, r9.passos[3].http, sinalMudo.aborted, r9.passos.length, Date.now() - t0 < 3000], ['sem resposta no prazo', null, true, 6, true], 'o ML emudeceu e a sonda não seguiu com o motivo');
      /* o corpo que nunca chega também */
      const m10 = mlDeMentira((c) => (c.includes('status=paused') ? { status: 200, text: nunca } : undefined));
      const r10 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m10.fetch, hoje: '2026-11-15', oque: 'anuncios', prazoPassoMs: 60, prazoTotalMs: 5000 });
      assert.strictEqual(r10.passos[3].erro, 'sem resposta no prazo');
    }
    /* passado o prazo TOTAL, os passos seguintes ficam "pulado" (ditos), e nada mais é pedido */
    {
      const m11 = mlDeMentira((c) => (c.includes('include_filters') ? nunca() : undefined));
      const r11 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m11.fetch, hoje: '2026-11-15', prazoPassoMs: 5000, prazoTotalMs: 900 });
      const pulados = r11.passos.filter((x) => x.pulado);
      assert.deepStrictEqual([m11.vistos.length, r11.passos[1].erro, pulados.length >= 5, pulados.every((x) => /prazo total/.test(x.pulado) && x.pedido.startsWith('GET /')), r11.passos.some((x) => x.grupo === 'ads')], [2, 'sem resposta no prazo', true, true, true],
        'estourado o prazo total a sonda ainda pediu coisa (ou não disse o que pulou): ' + JSON.stringify(r11.passos.map((x) => [x.passo.slice(0, 20), x.erro || x.pulado || x.http])));
    }
    /* sem prazo combinado valem os da peça (o relógio é pedido com eles) */
    {
      const _st = global.setTimeout; const pedidos = [];
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      try { await S.sondarML({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, oque: 'promocoes' }); } finally { global.setTimeout = _st; }
      assert.ok(pedidos.includes(S.PRAZO_PASSO_MS) && S.PRAZO_PASSO_MS >= 5000 && S.PRAZO_PASSO_MS <= 30000 && S.PRAZO_TOTAL_MS >= S.PRAZO_PASSO_MS * 2 && S.PRAZO_TOTAL_MS <= 120000, 'prazos da sonda: ' + pedidos + ' × ' + S.PRAZO_PASSO_MS + '/' + S.PRAZO_TOTAL_MS);
    }
  }

  /* ═══ C. SHOPEE ═══ */
  {
    const chamadas = [];
    const sync = (como) => async (oQue, params, loja) => { chamadas.push([oQue, params.caminho, params.q, loja, Object.keys(params).sort().join(',')]); return como(params.caminho, params.q); };
    const bom = (c) => {
      if (c === '/api/v2/shop/get_shop_info') return { ok: true, status: 200, dados: { ok: true, resposta: { shop_name: 'LOJA S', region: 'BR', status: 'NORMAL', email: 'dono@loja.com' } } };
      if (c === '/api/v2/account_health/shop_penalty') return { ok: false, status: 200, dados: { ok: false, resposta: { error: 'api_suspended', message: 'api suspended' } } };
      if (c === '/api/v2/account_health/get_shop_performance') return { ok: true, status: 200, dados: { ok: true, resposta: { error: '', response: { overall_performance: { rating: 3 }, metric_list: Array.from({ length: 17 }, (_, i) => ({ metric_id: i + 1, metric_name: 'metrica_' + (i + 1), current_period: i, target: { value: 5, comparator: '<' } })) } } } };
      if (c === '/api/v2/discount/get_discount_list') return { ok: true, status: 200, dados: { ok: true, resposta: { error: '', response: { discount_list: Array.from({ length: 11 }, (_, i) => ({ discount_id: i })) } } } };
      if (c === '/api/v2/account_health/get_listings_with_issues') return { ok: false, status: 502, erro: 'serviço fora' };
      if (c === '/api/v2/voucher/get_voucher_list') return { ok: true, status: 200, dados: { voucher_list: [{ voucher_id: 1, order_sn: 'SN1' }] } };   /* sem o envelope "resposta" */
      return { ok: true, status: 200, dados: { ok: true, resposta: { error: '', response: { total_count: 3, item: [{ item_id: 1 }] } } } };
    };
    chamadas.length = 0;
    const r = await S.sondarShopee({ pedirAoSync: sync(bom), loja: 'amb', hoje: '2026-11-15' });
    assert.deepStrictEqual([r.ok, r.sonda, r.loja, r.grupos, r.erro, r.passos.length, chamadas.length], [true, 'shopee', 'amb', ['conta', 'anuncios', 'campanhas', 'ads'], undefined, 18, 18]);
    /* tudo pelo serviço que tem o token, na loja pedida, só com o caminho e a consulta */
    assert.ok(chamadas.every((c) => c[0] === 'shopee-raw' && c[3] === 'amb' && c[4] === 'caminho,q'), 'a sonda da Shopee pediu algo fora do repasse cru: ' + JSON.stringify(chamadas[0]));
    /* só caminhos de leitura da conta / anúncio / campanha / ads — nada de pedido, devolução, pagamento, nem de escrita */
    const caminhos = chamadas.map((c) => c[1]);
    const SO_LEITURA = /^\/api\/v2\/(shop|account_health|product|discount|voucher|bundle_deal|add_on_deal|shop_flash_sale|ads)\/get_[a-z_]+$|^\/api\/v2\/account_health\/shop_penalty$|^\/api\/v2\/product\/search_item$/;
    assert.ok(caminhos.every((c) => SO_LEITURA.test(c)), 'caminho fora da lista de leitura: ' + caminhos.filter((c) => !SO_LEITURA.test(c)).join(' '));
    /* (os dois nomes que a Shopee disse que não existem saíram do roteiro) */
    assert.ok(!caminhos.includes('/api/v2/account_health/shop_performance') && !caminhos.includes('/api/v2/account_health/get_shop_penalty') && !caminhos.some((c) => c.endsWith('search_item')));
    assert.ok(!caminhos.some((c) => /\/(order|returns|payment|logistics|chat|sellerchat)\//.test(c) || /^(add|update|delete|end|set|create|edit|unlist|boost|upload|cancel|ship)_/.test(c.split('/').pop())), 'a sonda da Shopee tem caminho de pedido ou de escrita');
    assert.deepStrictEqual(S.roteiroShopee('2026-11-15').map((x) => x[2]), caminhos, 'o roteiro publicado é o que a sonda roda');
    assert.deepStrictEqual(chamadas[chamadas.length - 1].slice(1, 3), ['/api/v2/ads/get_all_cpc_ads_daily_performance', 'start_date=08-11-2026&end_date=15-11-2026'], 'o relatório de ads usa DD-MM-AAAA, como o sistema já usa');
    /* a resposta como veio (dado de gente omitido); o erro da Shopee aparece no passo; serviço fora também */
    const de = (c) => r.passos.find((x) => x.pedido.startsWith('GET ' + c));
    assert.deepStrictEqual(de('/api/v2/shop/get_shop_info'), { grupo: 'conta', passo: 'dados da loja', pedido: 'GET /api/v2/shop/get_shop_info', http: 200, resposta: { shop_name: 'LOJA S', region: 'BR', status: 'NORMAL', email: '[omitido pela sonda]' } });
    assert.deepStrictEqual([de('/api/v2/account_health/shop_penalty').erro, de('/api/v2/account_health/shop_penalty').resposta.error, de('/api/v2/account_health/get_listings_with_issues').erro, de('/api/v2/account_health/get_listings_with_issues').http, 'resposta' in de('/api/v2/account_health/get_listings_with_issues')],
      ['api_suspended — api suspended', 'api_suspended', 'serviço fora', 502, false]);
    /* a lista de métricas da saúde da conta sai INTEIRA (o corte de 8 escondia 9 das 17); as outras listas continuam cortadas */
    const metricas = de('/api/v2/account_health/get_shop_performance').resposta.response.metric_list, descontos = de('/api/v2/discount/get_discount_list').resposta.response.discount_list;
    assert.deepStrictEqual([metricas.length, metricas[16], descontos.length, descontos[S.MAX_LISTA]], [17, { metric_id: 17, metric_name: 'metrica_17', current_period: 16, target: { value: 5, comparator: '<' } }, S.MAX_LISTA + 1, '…e mais 3 (lista cortada pela sonda)'],
      'as métricas da saúde da conta têm que sair inteiras — e só elas');
    /* …inteira até um teto: lista maior que ele é cortada e diz */
    const longa = S.limpar({ l: Array.from({ length: S.MAX_LISTA_INTEIRA + 2 }, (_, i) => [i, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]) }, 0, S.MAX_LISTA_INTEIRA).l;
    assert.deepStrictEqual([S.MAX_LISTA_INTEIRA >= 17 && S.MAX_LISTA_INTEIRA <= 60, longa.length, longa[S.MAX_LISTA_INTEIRA], longa[0][1].length, S.limpar([1, 2, 3], 0, 2), S.encolher({ l: [1, 2, 3] }, 2), S.limpar([1, 2, 3], 0, 0), S.limpar([1, 2, 3], 0, -1)],
      [true, S.MAX_LISTA_INTEIRA + 1, '…e mais 2 (lista cortada pela sonda)', 12, [1, 2, '…e mais 1 (lista cortada pela sonda)'], { l: [1, 2, '…e mais 1 (lista cortada pela sonda)'] }, [1, 2, 3], [1, 2, 3]]);
    assert.deepStrictEqual([de('/api/v2/voucher/get_voucher_list').resposta, de('/api/v2/product/get_item_list').erro, de('/api/v2/product/get_item_list').pedido], [{ voucher_list: [{ voucher_id: 1, order_sn: '[omitido pela sonda]' }] }, undefined, 'GET /api/v2/product/get_item_list?offset=0&page_size=5&item_status=NORMAL']);
    assert.ok(/SÓ LEITURA/.test(r.leia) && /CANDIDATO/.test(r.leia));
    /* um grupo só */
    for (const [oque, n] of [['conta', 6], ['anuncios', 3], ['campanhas', 5], ['ADS', 4], ['x', 18]]) {
      chamadas.length = 0;
      const r2 = await S.sondarShopee({ pedirAoSync: sync(bom), loja: 'good', hoje: '2026-11-15', oque });
      assert.deepStrictEqual([chamadas.length, r2.passos.length, chamadas.every((c) => c[3] === 'good')], [n, n, true], 'oque=' + oque);
    }
    /* o serviço EMUDECE: "sem resposta no prazo" naquele passo, e a sonda segue; lança: idem */
    {
      chamadas.length = 0;
      const r3 = await S.sondarShopee({ pedirAoSync: sync((c) => { if (c.endsWith('get_shop_info')) return nunca(); if (c.endsWith('get_shop_performance')) throw new Error('ECONNREFUSED'); return bom(c); }), loja: 'amb', hoje: '2026-11-15', oque: 'conta', prazoPassoMs: 60, prazoTotalMs: 5000 });
      assert.deepStrictEqual([r3.passos[0].erro, r3.passos[1].erro, r3.passos.length, r3.ok], ['sem resposta no prazo', 'não respondeu (ECONNREFUSED)', 6, true]);
    }
    /* (Codex #887) o serviço cai e a mensagem de erro traz a URL com a chave; a resposta do serviço ecoa uma URL assinada */
    {
      const r6 = await S.sondarShopee({ pedirAoSync: async (oQue, p) => (p.caminho.endsWith('get_total_balance')
        ? { ok: false, erro: 'request to https://servico/amb/interno/shopee-raw?caminho=x&q=&k=CHAVE-DO-SERVICO failed, reason: connect ECONNREFUSED' }
        : { ok: false, status: 500, dados: { ok: false, erro: 'GET https://partner.shopeemobile.com/api/v2/ads/x?sign=ASSINATURA&access_token=TOKEN-SHOPEE falhou' } }), loja: 'amb', hoje: '2026-11-15', oque: 'ads' });
      assert.ok(/k=\[omitido\] failed, reason: connect ECONNREFUSED/.test(r6.passos[0].erro) && /sign=\[omitido\]&access_token=\[omitido\]/.test(r6.passos[1].resposta.erro) && !/CHAVE-DO-SERVICO|ASSINATURA|TOKEN-SHOPEE/.test(JSON.stringify(r6)),
        'a sonda da Shopee devolveu credencial dentro de um texto: ' + JSON.stringify(r6.passos.slice(0, 2)));
    }
    /* (mesma classe do Codex #889) o serviço devolve `ok: false` com o motivo em `dados.erro` (HTTP 503) — recusa não é resposta:
       o passo sai com erro, o corpo fica pra conferência, o passo seguinte não é alimentado, e oito recusas são "nenhuma resposta" */
    {
      const r7 = await S.sondarShopee({ pedirAoSync: async (oQue, p) => (p.caminho.endsWith('get_shop_info') ? { ok: false, status: 503, dados: { ok: false, erro: 'service unavailable' }, cru: 'x' }
        : (p.caminho.endsWith('get_shop_performance') ? { ok: false, status: 401, dados: { ok: false, resposta: { error: '', response: { metric_list: [] } } } } : { ok: true, status: 200, dados: { ok: true, resposta: { error: '', response: { total_count: 0 } } } })), loja: 'amb', hoje: '2026-11-15', oque: 'conta' });
      assert.deepStrictEqual([r7.ok, r7.passos[0].erro, r7.passos[0].http, r7.passos[0].resposta, r7.passos[1].erro, r7.passos[1].resposta, r7.passos[2].erro], [true, 'service unavailable', 503, { ok: false, erro: 'service unavailable' }, 'o serviço da Shopee respondeu HTTP 401', { error: '', response: { metric_list: [] } }, undefined]);
      const r8 = await S.sondarShopee({ pedirAoSync: async () => ({ ok: false, status: 503, dados: { ok: false, erro: 'service unavailable' } }), loja: 'amb', hoje: '2026-11-15', oque: 'ads' });
      assert.deepStrictEqual([r8.ok, /nenhum passo teve resposta da Shopee/.test(r8.erro), r8.passos.every((x) => x.erro === 'service unavailable')], [false, true, true], 'oito recusas não são "ok"');
      /* o serviço disse ok, mas a PRÓPRIA Shopee mandou erro no corpo: também é erro do passo (e não alimenta o seguinte) */
      const r8b = await S.sondarShopee({ pedirAoSync: async (oQue, p) => ({ ok: true, status: 200, dados: { ok: true, resposta: { error: 'error_param', message: 'Wrong parameter.', response: { item: [{ item_id: 23456789012 }] } } } }), loja: 'amb', hoje: '2026-11-15', oque: 'produto' });
      assert.deepStrictEqual([r8b.passos[0].erro, r8b.passos.length, r8b.passos[1].pulado], ['error_param — Wrong parameter.', 2, 'a lista não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)']);
      /* no grupo produto, a lista recusada não escolhe anúncio nenhum */
      const r9 = await S.sondarShopee({ pedirAoSync: async (oQue, p) => (p.caminho.endsWith('get_item_list') ? { ok: false, status: 503, dados: { ok: false, erro: 'fora', resposta: { response: { item: [{ item_id: 23456789012 }] } } } } : { ok: true, dados: { resposta: { response: {} } } }), loja: 'amb', hoje: '2026-11-15', oque: 'produto' });
      assert.deepStrictEqual([r9.passos.length, r9.passos[1].pulado], [2, 'a lista não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)']);
    }
    /* prazo total: o resto fica "pulado"; e sem NENHUMA resposta a sonda diz */
    {
      chamadas.length = 0;
      const r4 = await S.sondarShopee({ pedirAoSync: sync(() => nunca()), loja: 'amb', hoje: '2026-11-15', prazoPassoMs: 5000, prazoTotalMs: 900 });
      assert.deepStrictEqual([chamadas.length, r4.passos[0].erro, r4.passos.slice(1).every((x) => /prazo total/.test(x.pulado)), r4.passos.length, r4.ok, /nenhum passo teve resposta da Shopee/.test(r4.erro)], [1, 'sem resposta no prazo', true, 18, false, true]);
      const r5 = await S.sondarShopee({ pedirAoSync: async () => ({ ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste servico' }), loja: 'amb', hoje: '2026-11-15', oque: 'ads' });
      assert.deepStrictEqual([r5.ok, r5.passos.map((x) => x.erro).filter((e, i, a) => a.indexOf(e) === i), r5.passos.every((x) => !('resposta' in x))], [false, ['falta a env SHOPEE_SYNC_KEY neste servico'], true]);
    }
  }

  /* ═══ D. AS ROTAS ═══ */
  {
    const novoRes = () => ({ _json: null, c: 0, b: null, writeHead() {}, setHeader() {}, write() { return true; }, end() {}, on() {} });
    /* D1. a do ML mora na rota do chat da empresa (a GOOD, pela fachada de produção) */
    const P = '/good-checkout-offline';
    const _log = console.log; console.log = () => {};
    try {
      const montar = (extra) => require('../good-checkout-offline/historico-good').rotasHistorico(Object.assign({ validarSessao: (ck) => (ck === 'sess=dono' ? 'dono' : null), supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: TMP,
        json: (res, st, o) => { res._json = [st, o]; }, garantirTokenML: async () => 'tk-da-good' }, extra));
      const h = montar();
      const mlG = mlDeMentira();
      rede.ml = (url, opts) => mlG.fetch(url, opts);
      const u = (q) => new URL('http://x' + P + '/chat-analise?sonda=ml' + (q || ''));
      const antes = fs.readdirSync(TMP).sort().join(',');
      /* sem a chave: 404 e NADA é pedido ao Mercado Livre */
      let res = novoRes(); await h({ method: 'GET', headers: {} }, res, u());
      assert.deepStrictEqual([res._json, rede.vistos.length], [[404, { error: 'not found' }], 0], 'a sonda do ML é só do admin');
      res = novoRes(); await h({ method: 'GET', headers: { cookie: 'sess=outro' } }, res, u());
      assert.deepStrictEqual([res._json[0], rede.vistos.length], [404, 0]);
      /* com a chave: roda com o token DA EMPRESA, um grupo só quando pedido */
      res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u('&oque=promocoes'));
      assert.deepStrictEqual([res._json[0], res._json[1].ok, res._json[1].sonda, res._json[1].grupos, res._json[1].passos.length, rede.vistos.map((v) => v[1].headers.Authorization), rede.vistos.every((v) => v[1].method === 'GET')],
        [200, true, 'mercado-livre', ['promocoes'], 2, ['Bearer tk-da-good', 'Bearer tk-da-good'], true]);
      rede.vistos.length = 0;
      res = novoRes(); await h({ method: 'GET', headers: { cookie: 'sess=dono' } }, res, u());
      assert.deepStrictEqual([res._json[1].passos.length, rede.vistos.length], [14, 14], 'o admin logado roda a sonda inteira');
      /* (2ª rodada) `&item=` chega à sonda: olha o anúncio pedido; fora do formato, a rota diz e nada é pedido */
      rede.vistos.length = 0;
      res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u('&oque=produto&item=MLB-4004'));
      assert.deepStrictEqual([res._json[1].ok, res._json[1].grupos, rede.vistos[1][0].startsWith('https://api.mercadolibre.com/items?ids=MLB4004&'), rede.vistos.some((v) => /sold_quantity_desc/.test(v[0]))], [true, ['produto'], true, false], 'a rota não repassou o &item= à sonda do ML');
      rede.vistos.length = 0;
      res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u('&item=' + encodeURIComponent('MLB1/../orders')));
      assert.deepStrictEqual([res._json[0], res._json[1].ok, /o &item= não tem o formato/.test(res._json[1].erro), rede.vistos.length], [200, false, true, 0]);
      rede.vistos.length = 0;
      /* não grava nada no cache da empresa, não gasta pergunta, não chama o modelo */
      assert.ok(fs.readdirSync(TMP).sort().join(',') === antes && !rede.vistos.some((v) => /anthropic/.test(v[0])), 'a sonda do ML gravou arquivo ou chamou o modelo');
      /* loja sem a conta do ML ligada */
      rede.vistos.length = 0;
      res = novoRes(); await montar({ garantirTokenML: null })({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u());
      assert.deepStrictEqual([res._json[1], rede.vistos.length], [{ ok: false, erro: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' }, 0]);
      /* o estado do chat (GET simples) continua o de antes — a sonda não tomou o lugar dele */
      res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise'));
      assert.ok(res._json[1].ok && res._json[1].configurado === true && !('passos' in res._json[1]));
    } finally { console.log = _log; }

    /* D2. a da Shopee mora nas rotas da Shopee da empresa (a peça de produção) */
    const pedidosAoServico = [];
    const fetchServico = async (url) => { pedidosAoServico.push(String(url)); return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, resposta: { error: '', response: { total_count: 1 } } }) }; };
    const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CONFERIDOS_FILE: path.join(TMP, 'conf.json'), CACHE_DIR: TMP, readJson: (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } }, writeJson: (a, v) => fs.writeFileSync(a, JSON.stringify(v)) };
    const peca = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({ base, prefixo: '/amb-checkout-offline', shopee: () => ({ url: 'https://servico.shopee.teste', key: 'k-amb', loja: 'amb' }), adsMaxDias: 180, fetch: fetchServico });
    const rota = peca.rotasShopee({ validarSessao: () => null });
    const antes2 = fs.readdirSync(TMP).sort().join(',');
    let res = novoRes();
    assert.strictEqual(await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/shopee/sonda-conta')), true);
    assert.deepStrictEqual([res.c, res.b, pedidosAoServico.length], [404, { error: 'not found' }, 0], 'a sonda da Shopee é só do admin (sem a chave, nada é pedido)');
    res = novoRes(); await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/shopee/sonda-conta?k=chave-adm&oque=anuncios'));
    assert.deepStrictEqual([res.c, res.b.ok, res.b.sonda, res.b.loja, res.b.passos.length, pedidosAoServico.length], [200, true, 'shopee', 'amb', 3, 3]);
    assert.ok(pedidosAoServico.every((p) => p.startsWith('https://servico.shopee.teste/amb/interno/shopee-raw?') && /caminho=%2Fapi%2Fv2%2Fproduct%2Fget_item_list/.test(p)), 'a sonda da Shopee não foi pelo repasse cru da loja da empresa: ' + pedidosAoServico[0]);
    /* &loja= olha outra loja daqui (só as três que o serviço atende) */
    pedidosAoServico.length = 0;
    res = novoRes(); await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/shopee/sonda-conta?k=chave-adm&oque=ads&loja=girassol'));
    assert.ok(res.b.loja === 'girassol' && pedidosAoServico.length === 4 && pedidosAoServico.every((p) => p.startsWith('https://servico.shopee.teste/girassol/interno/shopee-raw?')));
    /* (2ª rodada) `&item=` chega à sonda da Shopee */
    pedidosAoServico.length = 0;
    res = novoRes(); await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/shopee/sonda-conta?k=chave-adm&oque=produto&item=999888777'));
    assert.deepStrictEqual([res.b.grupos, pedidosAoServico.length, /caminho=%2Fapi%2Fv2%2Fproduct%2Fget_item_base_info/.test(pedidosAoServico[0]) && decodeURIComponent(pedidosAoServico[0]).includes('q=item_id_list=999888777')], [['produto'], 4, true], 'a rota não repassou o &item= à sonda da Shopee: ' + pedidosAoServico[0]);
    pedidosAoServico.length = 0;
    res = novoRes(); await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/shopee/sonda-conta?k=chave-adm&item=abc'));
    assert.deepStrictEqual([res.c, res.b.ok, /o &item= não tem o formato/.test(res.b.erro), pedidosAoServico.length], [200, false, true, 0]);
    assert.strictEqual(fs.readdirSync(TMP).sort().join(','), antes2, 'a sonda da Shopee gravou arquivo');
  }

  /* ═══ E. NA ORIGEM (Codex #887): a peça da Shopee não devolve a chave do serviço em mensagem de erro ═══ */
  {
    const CHAVE = 'k-amb/seg+1~!';   /* com caracteres que cada jeito de montar URL codifica de um jeito */
    const formas = [CHAVE, encodeURIComponent(CHAVE), new URLSearchParams({ k: CHAVE }).toString().slice(2)];
    assert.strictEqual(new Set(formas).size, 3, 'o teste supõe três formas diferentes da mesma chave');
    const semAChave = (x, onde) => { const t = JSON.stringify(x); for (const f of formas) assert.ok(!t.includes(f), onde + ': a chave do serviço da Shopee saiu na resposta (' + f + '): ' + t.slice(0, 300)); };
    /* o node-fetch põe a URL inteira na mensagem de erro de rede */
    const caiu = async (url) => { throw new Error('request to ' + url + ' failed, reason: connect ECONNREFUSED 10.0.0.1:443'); };
    const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CONFERIDOS_FILE: path.join(os.tmpdir(), 'nao-existe-conf.json'), CACHE_DIR: os.tmpdir(), readJson: (a, d) => d, writeJson: () => true };
    const peca = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({ base, prefixo: '/amb-checkout-offline', shopee: () => ({ url: 'https://servico.shopee.teste', key: CHAVE, loja: 'amb' }), adsMaxDias: 180, fetch: caiu });
    const a = await peca.pedirAoSync('shopee-raw', { caminho: '/api/v2/shop/get_shop_info', q: '' }), b = await peca.escrowDoPedido('2511SN1');
    assert.ok(a.ok === false && /ECONNREFUSED/.test(a.erro) && /k=\[chave omitida\]/.test(a.erro) && b.ok === false && /ECONNREFUSED/.test(b.erro), 'o erro de rede tem que continuar dizendo o motivo: ' + a.erro + ' | ' + b.erro);
    semAChave(a, 'pedirAoSync'); semAChave(b, 'escrowDoPedido');
    /* a chave citada fora de um `k=` (crua ou codificada) também sai */
    const peca2 = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({ base, prefixo: '/amb-checkout-offline', shopee: () => ({ url: 'https://servico.shopee.teste', key: CHAVE, loja: 'amb' }), adsMaxDias: 180,
      fetch: async () => { throw new Error('a chave ' + CHAVE + ' (' + encodeURIComponent(CHAVE) + ') foi recusada'); } });
    const c = await peca2.pedirAoSync('shopee-raw', { caminho: '/x', q: '' });
    assert.strictEqual(c.erro, 'a chave [chave omitida] ([chave omitida]) foi recusada'); semAChave(c, 'texto livre');
    /* pelas rotas: a sonda nova E as que já existiam */
    const novoRes = () => ({ c: 0, b: null });
    const rota = peca.rotasShopee({ validarSessao: () => null });
    for (const u of ['/shopee/sonda-conta?k=chave-adm&oque=conta', '/shopee/api?k=chave-adm&caminho=/api/v2/shop/get_shop_info', '/shopee/carteira?k=chave-adm', '/shopee/sonda?k=chave-adm&pedido=2511SN1']) {
      const res = novoRes(); await rota({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline' + u));
      assert.ok(res.c === 200 && /ECONNREFUSED/.test(JSON.stringify(res.b)), u + ': a rota tinha que responder com o erro de rede: ' + JSON.stringify(res.b).slice(0, 200));
      semAChave(res.b, u);
    }
  }

  /* ═══ F. 2ª RODADA — O GRUPO `produto` ═══ */
  {
    const CAMPOS = 'id,title,status,sub_status,available_quantity,sold_quantity,price,inventory_id,user_product_id,seller_custom_field,shipping,health,attributes,variations&include_attributes=all';
    const DO_FULL = '/items?ids=MLB2001&attributes=id,title,status,available_quantity,inventory_id,user_product_id,shipping,variations';
    const PER = 'date_from=2026-11-08&date_to=2026-11-15', MET = '&metrics=clicks,prints,cost,acos,total_amount';
    const SKU = 'KIT 01/A&x=1';
    const anuncio = (mais) => Object.assign({ id: 'MLB1001', title: 'Kit', status: 'active', available_quantity: 5, user_product_id: 'MLBU555', seller_custom_field: 'CAMPO-ANTIGO',
      attributes: [{ id: 'BRAND', value_name: 'Marca', values: [{ id: '1', name: 'Marca' }] }, null, { id: 'SELLER_SKU', value_name: SKU, value_id: null, values: [{ name: SKU }] }, { id: 'GTIN', value_name: '7890000000011', values: [] }, { id: 'MODEL', value_name: 'X' }] }, mais);
    const mlProduto = (o) => mlDeMentira((c, opts) => {
      const meu = o && o.extra ? o.extra(c, opts) : undefined; if (meu !== undefined) return meu;
      if (c.startsWith('/items?ids=MLB2001')) return J([{ code: 200, body: { id: 'MLB2001', inventory_id: 'ABCD12345', user_product_id: 'MLBU777', available_quantity: 351 } }]);
      if (c.startsWith('/items?ids=')) return J([{ code: 200, body: anuncio(Object.assign({ id: c.slice(11, c.indexOf('&')) }, o && o.anuncio)) }]);
      if (/\/product_ads\/ads\/search\?limit=1&/.test(c)) return J({ paging: { total: 393 }, results: [{ item_id: 'MLB3003', status: 'hold' }] });
      return undefined;
    });
    const rodar = async (m, mais) => S.sondarML(Object.assign({ garantirTokenML: async () => 'tk-loja', fetch: m.fetch, hoje: '2026-11-15', oque: 'produto' }, mais));

    /* F1. a sequência, inteira e na ordem (sem `&item=`: o ativo que mais vendeu) */
    const m1 = mlProduto();
    const r1 = await rodar(m1);
    assert.deepStrictEqual([r1.ok, r1.grupos, r1.erro], [true, ['produto'], undefined]);
    assert.deepStrictEqual(m1.caminhos(), [
      '/users/me',
      '/users/123456/items/search?status=active&orders=sold_quantity_desc&limit=1',
      '/items?ids=MLB1001&attributes=' + CAMPOS,
      '/users/123456/items/search?seller_sku=KIT%2001%2FA%26x%3D1&limit=5',
      '/users/123456/items/search?sku=KIT%2001%2FA%26x%3D1&limit=5',
      '/seller-promotions/items/MLB1001?app_version=v2',
      '/items/MLB1001/visits/time_window?last=7&unit=day',
      '/users/123456/items_visits/time_window?last=7&unit=day',
      '/item/MLB1001/performance',
      '/user-products/MLBU555/stock',
      '/advertising/advertisers?product_id=PADS',
      '/marketplace/advertising/MLB/advertisers/777/product_ads/ads/search?limit=5&offset=0&' + PER + MET + '&filters[item_id]=MLB1001',
      '/marketplace/advertising/MLB/advertisers/777/product_ads/ads?limit=5&offset=0&' + PER + MET + '&filters[item_id]=MLB1001',
      '/marketplace/advertising/MLB/product_ads/ads/MLB1001?' + PER + MET,
      '/marketplace/advertising/MLB/advertisers/777/product_ads/ads/search?limit=1&offset=0&' + PER + '&metrics=clicks',
      '/marketplace/advertising/MLB/product_ads/ads/MLB3003?' + PER + MET,
      '/users/123456/items/search?logistic_type=fulfillment&status=active&limit=1',
      DO_FULL,
      '/inventories/ABCD12345/stock/fulfillment',
      '/user-products/MLBU777/stock',
    ], 'a sequência do grupo produto do ML mudou');
    assert.ok(m1.vistos.every((v) => v.metodo === 'GET' && v.url.startsWith('https://api.mercadolibre.com/') && v.cab.Authorization === 'Bearer tk-loja' && v.sinal && !('body' in v)), 'o grupo produto fez algo que não é um GET ao Mercado Livre com o token da loja');
    assert.deepStrictEqual(m1.vistos.map((v) => v.cab['Api-Version'] || v.cab['api-version'] || ''), ['', '', '', '', '', '', '', '', '', '', '1', '2', '2', '2', '2', '2', '', '', '', ''], 'Product Ads: o anunciante pede a versão 1 e os anúncios a versão 2');
    assert.ok(!m1.caminhos().some((c) => /\/orders|\/packs|\/shipments|\/messages|\/claims|\/payments/.test(c)), 'o grupo produto consultou pedido/venda');
    assert.ok(r1.passos.every((x) => x.grupo === (x.pedido === 'GET /users/me' ? 'conta' : 'produto')) && r1.passos.length === 20 && !r1.passos.some((x) => 'pulado' in x) && !/tk-loja|Bearer/.test(JSON.stringify(r1)));
    /* dos atributos do anúncio só saem o SKU e o código de barras (só id e valor); o resto do anúncio sai como veio */
    assert.deepStrictEqual(r1.passos[2].resposta, [{ code: 200, body: { id: 'MLB1001', title: 'Kit', status: 'active', available_quantity: 5, user_product_id: 'MLBU555', seller_custom_field: 'CAMPO-ANTIGO',
      attributes: [{ id: 'SELLER_SKU', value_name: SKU }, { id: 'GTIN', value_name: '7890000000011' }] } }], 'dos atributos do anúncio só saem o SKU e o código de barras');
    /* resposta sem a lista de atributos (ou que nem é lista) sai como veio, sem inventar o campo */
    {
      const m = mlProduto({ extra: (c) => (c.startsWith('/items?ids=MLB1001') ? J([{ code: 404, body: { message: 'not found' } }, 'lixo', null]) : undefined) });
      const r = await rodar(m);
      assert.deepStrictEqual([r.passos[2].resposta, m.caminhos().slice(3, 5)], [[{ code: 404, body: { message: 'not found' } }, 'lixo', null], ['/seller-promotions/items/MLB1001?app_version=v2', '/items/MLB1001/visits/time_window?last=7&unit=day']]);
      const mB = mlProduto({ extra: (c) => (c.startsWith('/items?ids=MLB1001') ? J({ message: 'formato inesperado' }) : undefined) });
      assert.deepStrictEqual((await rodar(mB)).passos[2].resposta, { message: 'formato inesperado' });
      /* o detalhe não veio (erro do ML), ou veio vazio: a sonda SEGUE sem SKU e sem o código do produto — não cai */
      const vazios = [[{ message: 'erro interno' }, 500], [[]], [[null]], [[{ code: 200 }]], [[{ code: 200, body: 'texto' }]], [[{ code: 200, body: null }]]];
      for (const [corpo, http] of vazios) {
        const resp = J(corpo, http);
        const mC = mlProduto({ extra: (c) => (c.startsWith('/items?ids=') ? resp : undefined) });
        const rC = await rodar(mC);
        assert.deepStrictEqual(rC.passos[2].resposta, corpo, 'o detalhe que veio vazio (ou torto) sai como veio: ' + JSON.stringify(corpo));
        assert.deepStrictEqual([rC.ok, mC.caminhos().slice(3, 7), mC.caminhos().some((c) => /[?&](seller_sku|sku)=|^\/user-products\/|^\/inventories\//.test(c)), mC.vistos.length],
          [true, ['/seller-promotions/items/MLB1001?app_version=v2', '/items/MLB1001/visits/time_window?last=7&unit=day', '/users/123456/items_visits/time_window?last=7&unit=day', '/item/MLB1001/performance'], false, 15]);
      }
    }

    /* F2. o SKU: o do atributo; sem ele, o do campo antigo; sem nenhum (ou fora do formato), não busca por SKU */
    for (const [anu, esperado] of [
      [{ attributes: [{ id: 'GTIN', value_name: '789' }] }, 'CAMPO-ANTIGO'],
      [{ attributes: 'lixo' }, 'CAMPO-ANTIGO'],
      [{ attributes: [{ id: 'SELLER_SKU', value_name: 42 }] }, 'CAMPO-ANTIGO'],
      [{ attributes: [{ id: 'SELLER_SKU', value_name: 'S'.repeat(80) }] }, 'S'.repeat(80)],
      [{ attributes: [{ id: 'SELLER_SKU', value_name: 'S'.repeat(81) }], seller_custom_field: null }, null],
      [{ attributes: [{ id: 'SELLER_SKU', value_name: 'A\nB' }], seller_custom_field: '' }, null],
      [{ attributes: [], seller_custom_field: null }, null],
    ]) {
      const m = mlProduto({ anuncio: anu }); await rodar(m);
      const buscas = m.caminhos().filter((c) => /[?&](seller_sku|sku)=/.test(c));
      assert.deepStrictEqual(buscas, esperado == null ? [] : ['/users/123456/items/search?seller_sku=' + esperado + '&limit=5', '/users/123456/items/search?sku=' + esperado + '&limit=5'], 'SKU de ' + JSON.stringify(anu).slice(0, 80));
    }
    /* (Codex #888) ANÚNCIO COM VARIAÇÃO: o SKU pode morar na variação. Vale o do anúncio (atributo, depois o campo antigo);
       sem ele, o da primeira variação que tiver — olhando poucas (as primeiras MAX_VARIACOES) */
    {
      const semSku = { attributes: [{ id: 'GTIN', value_name: '789' }], seller_custom_field: null };
      const v = (attr, campo) => ({ id: 1, attributes: attr === undefined ? undefined : [{ id: 'COLOR', value_name: 'Azul' }, null, { id: 'SELLER_SKU', value_name: attr }], seller_custom_field: campo === undefined ? null : campo });
      for (const [anu, esperado] of [
        [Object.assign({}, semSku, { variations: [v('VAR-ATR', 'VAR-CAMPO'), v('OUTRA')] }), 'VAR-ATR'],
        [Object.assign({}, semSku, { variations: [v(undefined, 'VAR-CAMPO'), v('OUTRA')] }), 'VAR-CAMPO'],
        [Object.assign({}, semSku, { variations: [v(undefined), null, 'lixo', v(42, ''), v('SEGUNDA')] }), 'SEGUNDA'],
        [{ variations: [v('VAR-ATR')] }, 'KIT%2001%2FA%26x%3D1'],                                   /* o do anúncio vem antes do da variação */
        [{ attributes: [], seller_custom_field: 'CAMPO-ANTIGO', variations: [v('VAR-ATR')] }, 'CAMPO-ANTIGO'],
        [Object.assign({}, semSku, { variations: Array.from({ length: S.MAX_VARIACOES }, () => v(undefined)).concat([v('LONGE-DEMAIS')]) }), null],
        [Object.assign({}, semSku, { variations: Array.from({ length: S.MAX_VARIACOES - 1 }, () => v(undefined)).concat([v('NA-ULTIMA')]) }), 'NA-ULTIMA'],
        [Object.assign({}, semSku, { variations: 'lixo' }), null],
        [Object.assign({}, semSku, { variations: [v('A\nB', 'S'.repeat(81))] }), null],
      ]) {
        const m = mlProduto({ anuncio: anu }); const r = await rodar(m);
        const buscas = m.caminhos().filter((c) => /[?&](seller_sku|sku)=/.test(c));
        assert.deepStrictEqual(buscas, esperado == null ? [] : ['/users/123456/items/search?seller_sku=' + esperado + '&limit=5', '/users/123456/items/search?sku=' + esperado + '&limit=5'], 'SKU (variações) de ' + JSON.stringify(anu).slice(0, 120));
        /* sem SKU, o passo aparece PULADO com o motivo — não some */
        const pulou = r.passos.filter((x) => x.passo === 'os anúncios do mesmo SKU');
        assert.deepStrictEqual(pulou, esperado == null ? [{ grupo: 'produto', passo: 'os anúncios do mesmo SKU', pulado: 'o anúncio não trouxe SKU — nem no anúncio, nem nas variações' }] : [], 'sem SKU a sonda tem que dizer');
      }
      assert.ok(S.MAX_VARIACOES >= 2 && S.MAX_VARIACOES <= 20 && S.MAX_CODIGOS >= 1 && S.MAX_CODIGOS <= 5);
      /* na resposta, os atributos de CADA variação também saem só com o SKU e o código de barras; o resto dela, como veio */
      const mV = mlProduto({ anuncio: { variations: [{ id: 7, price: 10, inventory_id: 'VARI11111', picture_ids: ['a'], attributes: [{ id: 'COLOR', value_name: 'Azul', values: [1] }, null, { id: 'SELLER_SKU', value_name: 'V1', values: [2] }, { id: 'GTIN', value_name: '789', x: 1 }] }, { id: 8, attributes: 'lixo' }, null, 'texto', { id: 9 }] } });
      const rV = await rodar(mV);
      assert.deepStrictEqual(rV.passos[2].resposta[0].body.variations, [{ id: 7, price: 10, inventory_id: 'VARI11111', picture_ids: ['a'], attributes: [{ id: 'SELLER_SKU', value_name: 'V1' }, { id: 'GTIN', value_name: '789' }] }, { id: 8, attributes: 'lixo' }, null, 'texto', { id: 9 }], 'os atributos das variações têm que sair enxutos — e só eles');
      assert.deepStrictEqual(rV.passos[2].resposta[0].body.attributes, [{ id: 'SELLER_SKU', value_name: SKU }, { id: 'GTIN', value_name: '7890000000011' }]);
    }

    /* F3. `&item=`: olha o anúncio pedido (como a pessoa cola), sem procurar o que mais vendeu — e sozinho já pede o grupo */
    for (const [mais, grupos, n] of [[{ item: ' mlb-4004 ' }, ['produto'], 19], [{ item: 'MLB4004', oque: '' }, ['produto'], 19], [{ item: 'MLB4004', oque: 'nada' }, ['produto'], 19], [{ item: 'MLB4004', oque: 'promocoes' }, ['promocoes'], 2]]) {
      const m = mlProduto(); const r = await rodar(m, mais);
      assert.deepStrictEqual([r.grupos, m.vistos.length, m.caminhos()[1]], [grupos, n, n === 2 ? '/seller-promotions/users/123456?app_version=v2' : '/items?ids=MLB4004&attributes=' + CAMPOS], 'item=' + JSON.stringify(mais));
      if (n === 19) assert.ok(m.caminhos().includes('/items/MLB4004/visits/time_window?last=7&unit=day') && m.caminhos().includes('/marketplace/advertising/MLB/product_ads/ads/MLB4004?' + PER + MET) && !m.caminhos().some((c) => c.includes('sold_quantity_desc') || c.includes('MLB1001')));
    }
    /* …fora do formato: RECUSA dizendo, sem pedir nada (nem o token) — nunca olha outro anúncio calada */
    for (const item of ['MLB12/../orders', 'MLB', '123456', 'MLB-', 'MLBU123', 'MLB123?x=1', 'ML1B23', 'MLB 123', 'XMLB123', 'MLB--123', 'MLB123-']) {
      for (const oque of ['produto', '', undefined]) {
        let pediuToken = 0; const m = mlProduto();
        const r = await S.sondarML({ garantirTokenML: async () => { pediuToken++; return 'tk'; }, fetch: m.fetch, hoje: '2026-11-15', oque, item });
        assert.deepStrictEqual([r.ok, /o &item= não tem o formato de um anúncio do Mercado Livre/.test(r.erro), r.grupos, r.passos, m.vistos.length, pediuToken], [false, true, ['produto'], [], 0, 0], 'item=' + item + ' oque=' + oque);
      }
    }
    /* (com outro grupo pedido às claras, o `&item=` não é usado — e não atrapalha) */
    { const m = mlProduto(); const r = await rodar(m, { oque: 'full', item: '../x' }); assert.deepStrictEqual([r.ok, r.grupos, m.vistos.length], [true, ['full'], 4]); }
    /* (item vazio não é pedido de anúncio) */
    for (const item of ['', '   ', null, undefined]) { const m = mlDeMentira(); const r = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m.fetch, hoje: '2026-11-15', item }); assert.deepStrictEqual([r.grupos.length, m.vistos.length], [4, 14], 'item=' + JSON.stringify(item)); }

    /* F4. o que vem de uma resposta só entra no pedido seguinte no formato certo */
    {
      /* o código do produto e o do estoque */
      for (const [up, vale] of [['MLBU555', true], ['MLB555', false], ['MLBU55/../x', false], ['mlbu555', false], [555, false], [null, false], ['MLBU', false], ['XMLBU555', false]]) {
        const m = mlProduto({ anuncio: { user_product_id: up }, extra: (c) => (c.startsWith('/items?ids=MLB2001') ? J([{ code: 200, body: { id: 'MLB2001', inventory_id: 'abc/../x', user_product_id: up } }]) : undefined) });
        await rodar(m);
        assert.deepStrictEqual(m.caminhos().filter((c) => c.startsWith('/user-products/') || c.startsWith('/inventories/')), vale ? ['/user-products/MLBU555/stock', '/user-products/MLBU555/stock'] : [], 'user_product_id=' + up);
      }
      for (const [inv, vale] of [['ABCD12345', true], ['ABC', false], ['A'.repeat(21), false], ['ABCD-1234', false], [12345, false], [null, false]]) {
        const m = mlProduto({ extra: (c) => (c.startsWith('/items?ids=MLB2001') ? J([{ code: 200, body: { id: 'MLB2001', inventory_id: inv } }]) : undefined) });
        await rodar(m);
        assert.deepStrictEqual(m.caminhos().filter((c) => c.startsWith('/inventories/')), vale ? ['/inventories/' + inv + '/stock/fulfillment'] : [], 'inventory_id=' + inv);
      }
      /* (Codex #888) os códigos podem morar nas VARIAÇÕES: o do anúncio e os delas, no formato, sem repetir, e poucos */
      {
        const full = (corpo) => (c) => (c.startsWith('/items?ids=MLB2001') ? J([{ code: 200, body: Object.assign({ id: 'MLB2001' }, corpo) }]) : undefined);
        for (const [corpo, estoques, produtos] of [
          [{ inventory_id: null, user_product_id: null, variations: [{ inventory_id: 'VARI11111', user_product_id: 'MLBU111' }, { inventory_id: 'VARI22222', user_product_id: 'MLBU222' }, { inventory_id: 'VARI33333', user_product_id: 'MLBU333' }] }, ['VARI11111', 'VARI22222'], ['MLBU111', 'MLBU222']],
          [{ inventory_id: 'PAIS00000', user_product_id: 'MLBU999', variations: [{ inventory_id: 'PAIS00000', user_product_id: 'MLBU999' }, { inventory_id: 'VARI22222', user_product_id: 'MLBU222' }] }, ['PAIS00000', 'VARI22222'], ['MLBU999', 'MLBU222']],
          [{ variations: [{ inventory_id: '../x', user_product_id: 'MLB111' }, null, 'lixo', { inventory_id: 77777, user_product_id: 222 }, { inventory_id: 'VARI55555', user_product_id: 'MLBU555' }] }, ['VARI55555'], ['MLBU555']],
          [{ variations: Array.from({ length: S.MAX_VARIACOES }, () => ({ id: 1 })).concat([{ inventory_id: 'LONGE0000', user_product_id: 'MLBU888' }]) }, [], []],
          [{ variations: 'lixo' }, [], []],
          [{}, [], []],
        ]) {
          const m = mlProduto({ anuncio: { user_product_id: null }, extra: full(corpo) }); const r = await rodar(m);
          assert.deepStrictEqual([m.caminhos().filter((c) => c.startsWith('/inventories/')), m.caminhos().filter((c) => c.startsWith('/user-products/'))], [estoques.map((x) => '/inventories/' + x + '/stock/fulfillment'), produtos.map((x) => '/user-products/' + x + '/stock')], 'códigos de ' + JSON.stringify(corpo).slice(0, 120));
          /* o que faltou é DITO: o passo aparece pulado, com o motivo */
          const pulados = r.passos.filter((x) => 'pulado' in x).map((x) => [x.grupo, x.passo, x.pulado]);
          assert.deepStrictEqual(pulados, [['produto', 'o estoque por local (Full × galpão) do anúncio MLB1001', 'o anúncio não trouxe o código do produto (user_product_id) — nem no anúncio, nem nas variações']]
            .concat(estoques.length ? [] : [['produto', 'o estoque no Full do anúncio MLB2001', 'o anúncio não trouxe o código de estoque (inventory_id) — nem no anúncio, nem nas variações']])
            .concat(produtos.length ? [] : [['produto', 'o estoque por local (Full × galpão) do anúncio do Full MLB2001', 'o anúncio não trouxe o código do produto (user_product_id) — nem no anúncio, nem nas variações']]), 'o que a sonda pulou tem que estar dito: ' + JSON.stringify(corpo).slice(0, 80));
        }
        /* o código do produto do anúncio olhado também vem das variações */
        const mU = mlProduto({ anuncio: { user_product_id: null, variations: [{ user_product_id: 'MLBU111' }, { user_product_id: 'MLBU111' }, { user_product_id: 'MLBU222' }, { user_product_id: 'MLBU333' }] } }); await rodar(mU);
        assert.deepStrictEqual(mU.caminhos().filter((c) => c.startsWith('/user-products/')), ['/user-products/MLBU111/stock', '/user-products/MLBU222/stock', '/user-products/MLBU777/stock']);
      }
      /* o anúncio "que está em Ads": só no formato de anúncio, e sem repetir o pedido se for o mesmo */
      for (const [outro, vale] of [['MLB3003', true], ['MLB1001', false], ['../../orders', false], [3003, false], [undefined, false]]) {
        const m = mlProduto({ extra: (c) => (/\/product_ads\/ads\/search\?limit=1&/.test(c) ? J({ results: [{ item_id: outro }] }) : undefined) });
        const r = await rodar(m);
        assert.deepStrictEqual(m.caminhos().filter((c) => /\/product_ads\/ads\/[^s]/.test(c)), ['/marketplace/advertising/MLB/product_ads/ads/MLB1001?' + PER + MET].concat(vale ? ['/marketplace/advertising/MLB/product_ads/ads/' + outro + '?' + PER + MET] : []), 'outro=' + outro);
        /* não achou outro: DIZ. É o mesmo anúncio: o pedido direto já foi feito — nada a pular */
        assert.deepStrictEqual(r.passos.filter((x) => 'pulado' in x), vale || outro === 'MLB1001' ? [] : [{ grupo: 'produto', passo: 'um anúncio que está em Product Ads — direto', pulado: 'o passo anterior não devolveu um anúncio em Product Ads pra conferir o caminho direto' }], 'outro=' + outro);
      }
      for (const corpo of [{ results: 'lixo' }, { results: [] }, { results: [null] }, {}]) {
        const m = mlProduto({ extra: (c) => (/\/product_ads\/ads\/search\?limit=1&/.test(c) ? J(corpo) : undefined) });
        const r = await rodar(m); assert.deepStrictEqual([r.ok, m.vistos.length, r.passos.filter((x) => 'pulado' in x).map((x) => x.passo)], [true, 19, ['um anúncio que está em Product Ads — direto']], JSON.stringify(corpo));
      }
      /* o anunciante fora do formato (ou a conta sem Product Ads): pula a parte de Ads e SEGUE pro Full */
      for (const resp of [J({ advertisers: [{ advertiser_id: '7/../../orders', site_id: 'MLB' }] }), J({ message: 'No permissions found for user_id' }, 404), J({ advertisers: [] })]) {
        const m = mlProduto({ extra: (c) => (c.startsWith('/advertising/advertisers?') ? resp : undefined) });
        const r = await rodar(m);
        assert.deepStrictEqual([m.caminhos().some((c) => c.startsWith('/marketplace/')), m.caminhos().slice(-3), r.ok], [false, [DO_FULL, '/inventories/ABCD12345/stock/fulfillment', '/user-products/MLBU777/stock'], true]);
        assert.deepStrictEqual(r.passos.filter((x) => 'pulado' in x), [{ grupo: 'produto', passo: 'o anúncio MLB1001 em Product Ads', pulado: 'não achei o anunciante de Product Ads desta conta (o passo anterior diz o que veio)' }]);
      }
      /* o site do anunciante vale; sem ele (ou fora do formato), o da conta */
      {
        const m = mlProduto({ extra: (c) => (c.startsWith('/advertising/advertisers?') ? J({ advertisers: [{ advertiser_id: 9, site_id: 'MLA' }] }) : undefined) }); await rodar(m);
        assert.ok(m.caminhos().includes('/marketplace/advertising/MLA/advertisers/9/product_ads/ads/search?limit=5&offset=0&' + PER + MET + '&filters[item_id]=MLB1001') && m.caminhos().includes('/marketplace/advertising/MLA/advertisers/9/product_ads/ads?limit=5&offset=0&' + PER + MET + '&filters[item_id]=MLB1001') && m.caminhos().includes('/marketplace/advertising/MLA/product_ads/ads/MLB1001?' + PER + MET) && m.caminhos().includes('/marketplace/advertising/MLA/product_ads/ads/MLB3003?' + PER + MET), m.caminhos().join(' '));
        const m2 = mlProduto({ extra: (c) => (c.startsWith('/advertising/advertisers?') ? J({ advertisers: [{ advertiser_id: 9, site_id: 'M/A' }] }) : undefined) }); await rodar(m2);
        assert.ok(m2.caminhos().includes('/marketplace/advertising/MLB/product_ads/ads/MLB1001?' + PER + MET));
      }
      /* sem anúncio ativo nenhum: pula o anúncio e SEGUE pro Full; sem anúncio no Full: acaba ali */
      {
        const m = mlProduto({ extra: (c) => (c.includes('sold_quantity_desc') ? J({ paging: { total: 0 }, results: ['../x', 7] }) : undefined) });
        const r = await rodar(m);
        assert.deepStrictEqual([r.ok, m.caminhos().slice(2)], [true, ['/users/123456/items/search?logistic_type=fulfillment&status=active&limit=1', DO_FULL, '/inventories/ABCD12345/stock/fulfillment', '/user-products/MLBU777/stock']]);
        assert.deepStrictEqual(r.passos.filter((x) => 'pulado' in x), [{ grupo: 'produto', passo: 'o anúncio de perto', pulado: 'a busca não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)' }]);
        const m2 = mlProduto({ extra: (c) => (c.includes('logistic_type=fulfillment') ? J({ paging: { total: 0 }, results: [] }) : undefined) });
        const rSemFull = await rodar(m2);
        assert.deepStrictEqual([m2.vistos.length, m2.caminhos().slice(-1)], [17, ['/users/123456/items/search?logistic_type=fulfillment&status=active&limit=1']]);
        assert.deepStrictEqual(rSemFull.passos.filter((x) => 'pulado' in x), [{ grupo: 'produto', passo: 'o estoque de um anúncio do Full', pulado: 'a busca não devolveu nenhum anúncio ativo no Full (o passo anterior diz o que veio)' }]);
        /* o detalhe do anúncio do Full não veio (ou veio sem corpo): nada de estoque inventado */
        const m3 = mlProduto({ extra: (c) => (c.startsWith('/items?ids=MLB2001') ? J([{ code: 404 }]) : undefined) }); await rodar(m3);
        assert.strictEqual(m3.vistos.length, 18);
      }
    }

    /* F5. SHOPEE — o grupo produto */
    {
      const chamadas = [];
      const sync = (como) => async (oQue, params, loja) => { chamadas.push([oQue, params.caminho, params.q, loja, Object.keys(params).sort().join(',')]); return como(params.caminho, params.q); };
      const ok = (response) => ({ ok: true, status: 200, dados: { ok: true, resposta: { error: '', response } } });
      const loja = (o) => (c) => {
        const meu = o && o.extra ? o.extra(c) : undefined; if (meu !== undefined) return meu;
        if (c.endsWith('/get_item_list')) return ok({ item: [{ item_id: 23456789012, item_status: 'NORMAL' }, { item_id: 999 }], total_count: 341 });
        if (c.endsWith('/get_item_base_info')) return ok({ item_list: [{ item_id: 23456789012, item_sku: o && 'sku' in o ? o.sku : SKU, item_name: 'Kit', item_status: 'NORMAL' }] });
        return ok({ total_count: 1 });
      };
      const rodarS = async (o, mais) => { chamadas.length = 0; return S.sondarShopee(Object.assign({ pedirAoSync: sync(loja(o)), loja: 'girassol', hoje: '2026-11-15', oque: 'produto' }, mais)); };
      const pedidos = () => chamadas.map((c) => c[1] + (c[2] ? '?' + c[2] : ''));
      const r = await rodarS();
      assert.deepStrictEqual([r.ok, r.grupos, r.erro, r.loja, r.passos.every((x) => x.grupo === 'produto')], [true, ['produto'], undefined, 'girassol', true]);
      assert.deepStrictEqual(pedidos(), [
        '/api/v2/product/get_item_list?offset=0&page_size=1&item_status=NORMAL',
        '/api/v2/product/get_item_base_info?item_id_list=23456789012',
        '/api/v2/product/get_item_extra_info?item_id_list=23456789012',
        '/api/v2/product/get_model_list?item_id=23456789012',
        '/api/v2/product/get_item_promotion?item_id_list=23456789012',
        '/api/v2/product/search_item?offset=0&page_size=5&item_sku=KIT%2001%2FA%26x%3D1',
      ], 'a sequência do grupo produto da Shopee mudou');
      assert.ok(chamadas.every((c) => c[0] === 'shopee-raw' && c[3] === 'girassol' && c[4] === 'caminho,q' && /^\/api\/v2\/product\/(get_[a-z_]+|search_item)$/.test(c[1])), 'o grupo produto da Shopee pediu algo fora do repasse cru / fora da leitura de anúncio');
      assert.deepStrictEqual(r.passos.map((x) => x.pedido), pedidos().map((x) => 'GET ' + x));
      /* `&item=`: olha o pedido, sem listar; fora do formato: RECUSA sem pedir nada */
      const r2 = await rodarS(null, { item: ' 999888777 ', oque: undefined });
      assert.deepStrictEqual([r2.grupos, pedidos()[0], chamadas.length], [['produto'], '/api/v2/product/get_item_base_info?item_id_list=999888777', 5]);
      await rodarS(null, { item: '999888777', oque: 'ads' }); assert.strictEqual(chamadas.length, 4);
      /* (com outro grupo pedido às claras, o `&item=` não é usado — e não atrapalha) */
      { const rA = await rodarS(null, { item: 'abc', oque: 'ads' }); assert.deepStrictEqual([rA.ok, rA.grupos, chamadas.length], [true, ['ads'], 4]); }
      for (const item of ['12/../x', 'MLB123', '123', '1'.repeat(21), '12 34', '-1234', '1234.5']) {
        for (const oque of ['produto', '', undefined]) {
          const r3 = await rodarS(null, { item, oque });
          assert.deepStrictEqual([r3.ok, /o &item= não tem o formato de um anúncio da Shopee/.test(r3.erro), r3.grupos, r3.passos, chamadas.length, r3.sonda, r3.loja, /SÓ LEITURA/.test(r3.leia)], [false, true, ['produto'], [], 0, 'shopee', 'girassol', true], 'item=' + item + ' oque=' + oque);
        }
      }
      /* sem `oque` e sem `&item=`, o grupo produto NÃO roda */
      for (const item of ['', '  ', null, undefined]) { const r4 = await rodarS(null, { oque: '', item }); assert.deepStrictEqual([r4.grupos, chamadas.length], [['conta', 'anuncios', 'campanhas', 'ads'], 18]); }
      /* o id que vem da lista só entra no pedido seguinte se for número; o SKU, só texto no formato (e codificado) */
      for (const lista of [{ item: [{ item_id: '12/../x' }] }, { item: [] }, { item: 'lixo' }, {}, { item: [null] }, { item: [{ item_id: 123 }] }]) {
        await rodarS({ extra: (c) => (c.endsWith('/get_item_list') ? ok(lista) : undefined) });
        assert.strictEqual(chamadas.length, 1, 'id de anúncio fora do formato virou pedido: ' + JSON.stringify(lista));
      }
      /* a lista veio sem o miolo, ou nem veio: acaba ali, sem cair */
      for (const resp of [{ ok: true, status: 200, dados: { ok: true, resposta: { error: '' } } }, { ok: false, status: 502, erro: 'serviço fora' }, { ok: true, status: 200, dados: { ok: true, resposta: 'texto solto' } }]) {
        const rL = await rodarS({ extra: (c) => (c.endsWith('/get_item_list') ? resp : undefined) });
        /* …e DIZ que pulou o anúncio (Codex #888: passo que não dá pra fazer não some calado) */
        assert.deepStrictEqual([chamadas.length, rL.passos.length, rL.passos[1]], [1, 2, { grupo: 'produto', passo: 'o anúncio de perto', pulado: 'a lista não devolveu nenhum anúncio ativo (o passo anterior diz o que veio)' }], JSON.stringify(resp));
      }
      for (const [sku, vale] of [['S'.repeat(80), true], ['S'.repeat(81), false], ['', false], [42, false], [null, false], ['A\tB', false]]) {
        const rK = await rodarS({ sku });
        assert.deepStrictEqual(pedidos().filter((x) => x.includes('search_item')), vale ? ['/api/v2/product/search_item?offset=0&page_size=5&item_sku=' + sku] : [], 'sku=' + JSON.stringify(sku));
        /* sem SKU, o passo aparece PULADO com o motivo */
        assert.deepStrictEqual(rK.passos.filter((x) => 'pulado' in x), vale ? [] : [{ grupo: 'produto', passo: 'os anúncios do mesmo SKU', pulado: 'o anúncio não trouxe SKU — nem no anúncio (item_sku), nem nas variações (model_sku)' }], 'sku=' + JSON.stringify(sku));
      }
      /* (Codex #888) ANÚNCIO COM VARIAÇÃO: o SKU mora em cada variação (model_sku). Vale o do anúncio; sem ele, o da
         primeira variação que tiver — olhando poucas */
      for (const [sku, modelos, esperado] of [
        ['', { model: [{ model_id: 1, model_sku: '' }, null, 'lixo', { model_sku: 42 }, { model_sku: 'MOD 2/B' }, { model_sku: 'MOD-3' }] }, 'MOD%202%2FB'],
        ['DO-ANUNCIO', { model: [{ model_sku: 'MOD-1' }] }, 'DO-ANUNCIO'],
        ['', { model: Array.from({ length: S.MAX_VARIACOES }, () => ({ model_sku: '' })).concat([{ model_sku: 'LONGE-DEMAIS' }]) }, null],
        ['', { model: Array.from({ length: S.MAX_VARIACOES - 1 }, () => ({ model_sku: '' })).concat([{ model_sku: 'NA-ULTIMA' }]) }, 'NA-ULTIMA'],
        ['', { model: 'lixo' }, null], ['', {}, null], ['', { model: [{ model_sku: 'S'.repeat(81) }, { model_sku: 'A\nB' }] }, null],
      ]) {
        await rodarS({ sku, extra: (c) => (c.endsWith('/get_model_list') ? ok(modelos) : undefined) });
        assert.deepStrictEqual(pedidos().filter((x) => x.includes('search_item')), esperado == null ? [] : ['/api/v2/product/search_item?offset=0&page_size=5&item_sku=' + esperado], 'SKU das variações: ' + JSON.stringify(modelos).slice(0, 100));
      }
      /* as variações vieram com ERRO (ou sem o miolo): o SKU delas não é usado */
      for (const resp of [{ ok: false, status: 200, dados: { ok: false, resposta: { error: 'error_param', response: { model: [{ model_sku: 'DENTRO-DO-ERRO' }] } } } }, { ok: true, status: 200, dados: { ok: true, resposta: { error: '' } } }, { ok: false, status: 502, erro: 'serviço fora' }]) {
        await rodarS({ sku: '', extra: (c) => (c.endsWith('/get_model_list') ? resp : undefined) });
        assert.deepStrictEqual([chamadas.length, pedidos().some((x) => x.includes('search_item'))], [5, false], JSON.stringify(resp).slice(0, 90));
      }
      /* o detalhe do anúncio veio com ERRO (ou sem a lista): não busca por SKU — e os outros passos seguem */
      for (const resp of [{ ok: false, status: 200, dados: { ok: false, resposta: { error: 'error_param', message: 'x', response: { item_list: [{ item_sku: 'DENTRO-DO-ERRO' }] } } } }, ok({ item_list: 'lixo' }), ok({ item_list: [] }), ok({}), { ok: true, status: 200, dados: { ok: true, resposta: { error: '' } } }, { ok: false, status: 502, erro: 'serviço fora', dados: { resposta: { response: { item_list: [{ item_sku: 'COM-ERRO-DO-SERVICO' }] } } } }]) {
        await rodarS({ extra: (c) => (c.endsWith('/get_item_base_info') ? resp : undefined) });
        assert.deepStrictEqual([chamadas.length, pedidos().some((x) => x.includes('search_item'))], [5, false], JSON.stringify(resp).slice(0, 90));
      }
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  _chegouAoFim = true;
  console.log('ok — sondas de marketplace: dado de gente omitido e resposta encolhida (dito); ML: sequência fixa e só de leitura, cadastro reduzido a id/site/apelido, nada de pedido, só entra em caminho o que tem o formato certo, erro e API muda viram informação; Shopee: tudo pelo repasse cru do serviço, só caminhos de leitura, erro da Shopee no passo; as duas rotas são só do admin, com as peças da empresa, e não gravam nada; 2ª rodada: o grupo produto só roda quando pedido, sequência fixa nas duas, &item= fora do formato é recusado sem pedir nada, o que vem de resposta só entra em pedido no formato certo, as métricas da saúde da conta saem inteiras');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
