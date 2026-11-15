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
   D. AS ROTAS: `<prefixo>/chat-analise?sonda=ml` e `<prefixo>/shopee/sonda-conta` são só do admin (sem a chave: 404 e
      NADA é pedido), rodam com as peças DA EMPRESA, não gravam nada e não gastam pergunta do chat. */
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
      '/marketplace/advertising/MLB/advertisers/777/product_ads/campaigns?limit=5&offset=0&date_from=2026-11-08&date_to=2026-11-15&metrics=clicks,prints,cost,cpc,acos,roas,units_quantity,total_amount&metrics_summary=true',
      '/marketplace/advertising/MLB/advertisers/777/product_ads/ads/search?limit=5&offset=0&date_from=2026-11-08&date_to=2026-11-15&metrics=clicks,prints,cost,acos',
    ], 'a sequência de pedidos da sonda do ML mudou (ou algo que veio de uma resposta entrou no caminho sem ter o formato certo)');
    /* só leitura, só o ML, com o token da loja e a versão certa em cada pedido */
    assert.ok(ml.vistos.every((v) => v.metodo === 'GET' && v.url.startsWith('https://api.mercadolibre.com/') && v.cab.Authorization === 'Bearer tk-loja' && v.sinal && !('body' in v)), 'a sonda fez algo que não é um GET ao Mercado Livre com o token da loja');
    assert.deepStrictEqual(ml.vistos.map((v) => v.cab['Api-Version'] || v.cab['api-version'] || ''), ['', '', '', '', '', '', '', '', '', '', '', '1', '2', '2'], 'Product Ads: o anunciante pede a versão 1 e as campanhas/anúncios a versão 2');
    assert.ok(!ml.caminhos().some((c) => /\/orders|\/packs|\/shipments|\/messages|\/claims|\/payments/.test(c)), 'a sonda consultou pedido/venda');
    /* do cadastro só saem o id, o site e o apelido */
    assert.deepStrictEqual(r.passos[0], { grupo: 'conta', passo: 'quem sou (só id, site e apelido)', pedido: 'GET /users/me', http: 200, resposta: { id: 123456, site_id: 'MLB', nickname: 'LOJA TESTE' } });
    assert.ok(!/dono@loja|12345678000199|11999990000|Fulano|Rua X/.test(JSON.stringify(r)), 'dado do cadastro do vendedor saiu na sonda');
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
      assert.ok(m5.caminhos()[2].startsWith('/marketplace/advertising/MLB/advertisers/9/product_ads/campaigns?'), m5.caminhos().join(' '));
      /* sem anunciante (a conta não usa Product Ads): para ali, sem inventar caminho */
      const m6 = mlDeMentira((c) => (c.startsWith('/advertising/advertisers?') ? J({ message: 'No permissions found for user_id' }, 404) : undefined));
      const r6 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m6.fetch, hoje: '2026-11-15', oque: 'ads' });
      assert.deepStrictEqual([m6.vistos.length, r6.passos[1].http, r6.passos[1].resposta.message], [2, 404, 'No permissions found for user_id']);
    }

    /* sem token: diz e não pede nada */
    for (const [g, re] of [[async () => null, /sem acesso ao Mercado Livre agora/], [async () => { throw new Error('refresh falhou'); }, /não está disponível \(refresh falhou\)/], [nunca, /sem acesso ao Mercado Livre agora/]]) {
      const m7 = mlDeMentira(); const r7 = await S.sondarML({ garantirTokenML: g, fetch: m7.fetch, prazoPassoMs: 40, prazoTotalMs: 2000 });
      assert.deepStrictEqual([r7.ok, re.test(r7.erro), m7.vistos.length, r7.passos], [false, true, 0, []]);
    }
    /* a rede cai num passo, a resposta não é JSON noutro: viram informação e a sonda segue */
    {
      const m8 = mlDeMentira((c) => { if (c.includes('status=paused')) throw new Error('ECONNRESET'); if (c.includes('reputation_health_gauge')) return J('<html>erro</html>', 502); return undefined; });
      const r8 = await S.sondarML({ garantirTokenML: async () => 'tk', fetch: m8.fetch, hoje: '2026-11-15', oque: 'anuncios' });
      assert.deepStrictEqual([r8.ok, r8.passos[3].erro, r8.passos[3].http, r8.passos[4].http, r8.passos[4].resposta, r8.passos.length], [true, 'não respondeu (ECONNRESET)', null, 502, '<html>erro</html>', 6]);
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
      if (c === '/api/v2/account_health/shop_performance') return { ok: false, status: 200, dados: { ok: false, resposta: { error: 'error_not_found', message: 'api not found' } } };
      if (c === '/api/v2/account_health/get_listings_with_issues') return { ok: false, status: 502, erro: 'serviço fora' };
      if (c === '/api/v2/voucher/get_voucher_list') return { ok: true, status: 200, dados: { voucher_list: [{ voucher_id: 1, order_sn: 'SN1' }] } };   /* sem o envelope "resposta" */
      return { ok: true, status: 200, dados: { ok: true, resposta: { error: '', response: { total_count: 3, item: [{ item_id: 1 }] } } } };
    };
    chamadas.length = 0;
    const r = await S.sondarShopee({ pedirAoSync: sync(bom), loja: 'amb', hoje: '2026-11-15' });
    assert.deepStrictEqual([r.ok, r.sonda, r.loja, r.grupos, r.erro, r.passos.length, chamadas.length], [true, 'shopee', 'amb', ['conta', 'anuncios', 'campanhas', 'ads'], undefined, 20, 20]);
    /* tudo pelo serviço que tem o token, na loja pedida, só com o caminho e a consulta */
    assert.ok(chamadas.every((c) => c[0] === 'shopee-raw' && c[3] === 'amb' && c[4] === 'caminho,q'), 'a sonda da Shopee pediu algo fora do repasse cru: ' + JSON.stringify(chamadas[0]));
    /* só caminhos de leitura da conta / anúncio / campanha / ads — nada de pedido, devolução, pagamento, nem de escrita */
    const caminhos = chamadas.map((c) => c[1]);
    assert.ok(caminhos.every((c) => /^\/api\/v2\/(shop|account_health|product|discount|voucher|bundle_deal|add_on_deal|shop_flash_sale|ads)\/get_[a-z_]+$|^\/api\/v2\/account_health\/shop_(performance|penalty)$/.test(c)), 'caminho fora da lista de leitura: ' + caminhos.filter((c) => !/get_|shop_p/.test(c)).join(' '));
    assert.ok(!caminhos.some((c) => /\/(order|returns|payment|logistics|chat|sellerchat)\//.test(c) || /^(add|update|delete|end|set|create|edit|unlist|boost|upload|cancel|ship)_/.test(c.split('/').pop())), 'a sonda da Shopee tem caminho de pedido ou de escrita');
    assert.deepStrictEqual(S.roteiroShopee('2026-11-15').map((x) => x[2]), caminhos, 'o roteiro publicado é o que a sonda roda');
    assert.deepStrictEqual(chamadas[chamadas.length - 1].slice(1, 3), ['/api/v2/ads/get_all_cpc_ads_daily_performance', 'start_date=08-11-2026&end_date=15-11-2026'], 'o relatório de ads usa DD-MM-AAAA, como o sistema já usa');
    /* a resposta como veio (dado de gente omitido); o erro da Shopee aparece no passo; serviço fora também */
    const de = (c) => r.passos.find((x) => x.pedido.startsWith('GET ' + c));
    assert.deepStrictEqual(de('/api/v2/shop/get_shop_info'), { grupo: 'conta', passo: 'dados da loja', pedido: 'GET /api/v2/shop/get_shop_info', http: 200, resposta: { shop_name: 'LOJA S', region: 'BR', status: 'NORMAL', email: '[omitido pela sonda]' } });
    assert.deepStrictEqual([de('/api/v2/account_health/shop_performance').erro, de('/api/v2/account_health/shop_performance').resposta.error, de('/api/v2/account_health/get_listings_with_issues').erro, de('/api/v2/account_health/get_listings_with_issues').http, 'resposta' in de('/api/v2/account_health/get_listings_with_issues')],
      ['error_not_found — api not found', 'error_not_found', 'serviço fora', 502, false]);
    assert.deepStrictEqual([de('/api/v2/voucher/get_voucher_list').resposta, de('/api/v2/product/get_item_list').erro, de('/api/v2/product/get_item_list').pedido], [{ voucher_list: [{ voucher_id: 1, order_sn: '[omitido pela sonda]' }] }, undefined, 'GET /api/v2/product/get_item_list?offset=0&page_size=5&item_status=NORMAL']);
    assert.ok(/SÓ LEITURA/.test(r.leia) && /CANDIDATO/.test(r.leia));
    /* um grupo só */
    for (const [oque, n] of [['conta', 8], ['anuncios', 3], ['campanhas', 5], ['ADS', 4], ['x', 20]]) {
      chamadas.length = 0;
      const r2 = await S.sondarShopee({ pedirAoSync: sync(bom), loja: 'good', hoje: '2026-11-15', oque });
      assert.deepStrictEqual([chamadas.length, r2.passos.length, chamadas.every((c) => c[3] === 'good')], [n, n, true], 'oque=' + oque);
    }
    /* o serviço EMUDECE: "sem resposta no prazo" naquele passo, e a sonda segue; lança: idem */
    {
      chamadas.length = 0;
      const r3 = await S.sondarShopee({ pedirAoSync: sync((c) => { if (c.endsWith('get_shop_info')) return nunca(); if (c.endsWith('get_shop_performance')) throw new Error('ECONNREFUSED'); return bom(c); }), loja: 'amb', hoje: '2026-11-15', oque: 'conta', prazoPassoMs: 60, prazoTotalMs: 5000 });
      assert.deepStrictEqual([r3.passos[0].erro, r3.passos[1].erro, r3.passos.length, r3.ok], ['sem resposta no prazo', 'não respondeu (ECONNREFUSED)', 8, true]);
    }
    /* prazo total: o resto fica "pulado"; e sem NENHUMA resposta a sonda diz */
    {
      chamadas.length = 0;
      const r4 = await S.sondarShopee({ pedirAoSync: sync(() => nunca()), loja: 'amb', hoje: '2026-11-15', prazoPassoMs: 5000, prazoTotalMs: 900 });
      assert.deepStrictEqual([chamadas.length, r4.passos[0].erro, r4.passos.slice(1).every((x) => /prazo total/.test(x.pulado)), r4.passos.length, r4.ok, /nenhum passo teve resposta da Shopee/.test(r4.erro)], [1, 'sem resposta no prazo', true, 20, false, true]);
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
    assert.strictEqual(fs.readdirSync(TMP).sort().join(','), antes2, 'a sonda da Shopee gravou arquivo');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  _chegouAoFim = true;
  console.log('ok — sondas de marketplace: dado de gente omitido e resposta encolhida (dito); ML: sequência fixa e só de leitura, cadastro reduzido a id/site/apelido, nada de pedido, só entra em caminho o que tem o formato certo, erro e API muda viram informação; Shopee: tudo pelo repasse cru do serviço, só caminhos de leitura, erro da Shopee no passo; as duas rotas são só do admin, com as peças da empresa, e não gravam nada');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
