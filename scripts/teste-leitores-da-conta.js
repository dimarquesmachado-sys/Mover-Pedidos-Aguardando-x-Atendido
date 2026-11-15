'use strict';
/* 15/11 — OS LEITORES DA CONTA: os anúncios da conta no Mercado Livre (lib/checkout/anuncios-ml.js) e a saúde da conta
   na Shopee (lib/checkout/saude-shopee.js), ligados ao chat de análise (lib/checkout/chat-olhos.js).

   Os formatos usados aqui são os REAIS — os que as sondas (#887, #888) trouxeram em 15/11: a conta da Girassol no
   Mercado Livre e na Shopee, e a da AMB na Shopee (com as 17 métricas da saúde da conta).

   O que se prova (as peças de produção, com o ML e o serviço da Shopee de mentira):
   A. ANÚNCIOS DO ML: o resumo sai do formato real (total, por situação, por motivo, perdendo exposição, no Full,
      promoções abertas); situação que o ML não listou não vira zero; a soma é conferida contra o total; a consulta é
      uma sequência fixa de GETs com o token da loja, e do `/users/me` só o id é usado; parte que falha fica NULA e
      entra em "faltou" com o motivo; sem a contagem por situação não há leitura; ML mudo custa só o prazo daquele
      pedido; estourado o prazo total nada mais é pedido; nunca lança.
   B. SAÚDE DA SHOPEE: o resumo sai do formato real (nota em código, reprovadas por área, cada métrica com valor, meta e
      `dentro_da_meta` só quando dá pra comparar; área e unidade só dos códigos vistos); tudo pelo repasse cru do serviço
      (`shopee-raw`), só caminhos de leitura; erro da Shopee vira "faltou"; sem nenhuma resposta, a peça diz.
   C. AS FOTOS: uma por dia no cache DA EMPRESA; o disco que recusa é dito (o gravador de produção devolve `false`, não
      lança); "o que mudou" em código — número ausente numa das fotos dá diferença NULA, não zero.
   D. PELO CHAT: as duas consultas respondem "não disponível" sem a peça da loja; gravam a foto do dia; dizem desde
      quando há histórico, o que não veio agora e quando a autorização do app na Shopee está pra vencer.
   E. PELA ROTA DE VERDADE: as seis consultas vão pro modelo e rodam com as peças DA EMPRESA; as rotas de conferência
      (`?anuncios=1`, `?saude_shopee=1`) são só do admin, não chamam o modelo nem gastam pergunta.
   F. A MADRUGADA tira as duas fotos (cada uma só pra empresa que passou a peça dela); se a leitura falha a etapa ACUSA
      e a noite segue.
   G. NAS TRÊS EMPRESAS: a fachada do histórico e a madrugada de cada uma entregam o pedido à Shopee DELA. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leitores-rota-'));
process.env.ADMIN_KEY = 'chave-adm'; process.env.GOODBKP_ADMIN = 'dono'; process.env.GOODBKP_CACHE_DIR = TMP; process.env.AMBBKP_CACHE_DIR = path.join(TMP, 'amb'); process.env.GIRABKP_CACHE_DIR = path.join(TMP, 'gira'); process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tk'); process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;
/* a rede de mentira (antes de qualquer peça carregar o node-fetch): a API da Anthropic e o Mercado Livre */
const rede = { api: [], roteiro: [], ml: [], mlResposta: null };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) { rede.api.push(JSON.parse(opts.body)); const t = rede.roteiro.shift(); if (!t) throw new Error('a API foi chamada mais vezes do que o roteiro previa'); return t; }
  if (url.startsWith('https://api.mercadolibre.com/')) { rede.ml.push([url.replace('https://api.mercadolibre.com', ''), opts && opts.headers && opts.headers.Authorization]); return rede.mlResposta(url.replace('https://api.mercadolibre.com', '')); }
  return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
} };

const ANU = require('../lib/checkout/anuncios-ml');
const SAU = require('../lib/checkout/saude-shopee');
const OLHOS = require('../lib/checkout/chat-olhos');
const { prazoEmSequencia, MINIMO_PRA_OUTRO_PEDIDO_MS } = require('../lib/checkout/com-prazo');
const { validarPeriodo } = require('../lib/checkout/chat-analise');

const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const novoDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'leitores-'));
const copia = (x) => JSON.parse(JSON.stringify(x));
const nunca = () => new Promise(() => {});
const HOJE = '2026-11-15';
const AGORA = Date.parse('2026-11-15T15:00:00.000Z');   /* 12:00 em Brasília */
const J = (corpo, st) => ({ ok: !st || st < 300, status: st || 200, json: async () => corpo });

/* ── o Mercado Livre como respondeu de verdade (Girassol, 15/11) ── */
const ML = {
  todos: { seller_id: '252698567', results: ['MLB1184985061', 'MLB1202178427'], paging: { limit: 5, offset: 0, total: 2384 }, query: null, orders: [{ id: 'stop_time_asc' }],
    available_filters: [
      { id: 'status', name: 'Status', values: [{ id: 'pending', name: 'Inactive items for debt or MercadoLibre policy violation', results: 104 }, { id: 'not_yet_active', name: 'Items newly created or pending activation', results: 0 },
        { id: 'programmed', name: 'Items scheduled for future activation', results: 0 }, { id: 'active', name: 'Active items', results: 716 }, { id: 'paused', name: 'Paused items', results: 1562 }, { id: 'closed', name: 'closed items', results: 2 }] },
      { id: 'sub_status', name: 'Substatus', values: [{ id: 'deleted', name: 'Deleted substatus', results: 0 }, { id: 'forbidden', name: 'Forbidden substatus', results: 34 }, { id: 'freezed', name: 'Freezed substatus', results: 0 },
        { id: 'held', name: 'Held substatus', results: 0 }, { id: 'suspended', name: 'Suspended substatus', results: 0 }, { id: 'waiting_for_patch', name: 'Waiting for patch substatus', results: 70 }, { id: 'warning', name: 'Warning items with MercadoLibre policy violation', results: 0 }] },
      { id: 'buying_mode', name: 'Buying Mode', values: [{ id: 'buy_it_now', name: 'Buy it now', results: 2384 }] },
      { id: 'shipping_free_methods', name: 'Shipping free methods', values: [{ id: 100009, results: 3 }] }] },
  perdendo: { seller_id: '252698567', results: ['MLB5307472224', 'MLB1488163643', 'MLB1488162445'], paging: { limit: 3, offset: 0, total: 55 }, query: null },
  full: { seller_id: '252698567', results: ['MLB1202555743'], paging: { limit: 5, offset: 0, total: 8 }, query: null },
  promocoes: { results: [{ id: 'LGH-MLB1000', type: 'LIGHTNING', status: 'started' },
    { id: 'P-MLB17023040', type: 'UNHEALTHY_STOCK', status: 'started', start_date: '2026-02-12T23:00:00Z', finish_date: '2027-02-12T15:00:00Z', deadline_date: '2027-02-12T15:00:00Z', name: 'Acelere suas vendas do Full' },
    { id: 'P-MLB17937078', type: 'SMART', status: 'started', start_date: '2026-08-23T03:50:00Z', finish_date: '2027-02-20T02:50:00Z', deadline_date: '2027-02-20T02:50:00Z', name: 'Impulsione suas vendas' },
    { id: 'P-MLB17911004', type: 'DEAL', status: 'started', start_date: '2026-11-12T03:00:00Z', finish_date: '2026-12-01T03:00:00Z', deadline_date: '2026-11-30T15:00:00Z', name: 'Black Friday 2026' }], paging: { total: 4, limit: 50, offset: 0 } },
};
const RESUMO_ML = { total: 2384,
  por_situacao: { inativos_por_pendencia_ou_infracao: 104, recem_criados_ainda_nao_ativos: 0, programados: 0, ativos: 716, pausados: 1562, encerrados: 2 },
  outras_situacoes: {}, a_soma_das_situacoes_bate_com_o_total: true,
  por_motivo: [{ codigo: 'forbidden', nome_no_mercado_livre: 'Forbidden substatus', anuncios: 34 }, { codigo: 'waiting_for_patch', nome_no_mercado_livre: 'Waiting for patch substatus', anuncios: 70 }],
  perdendo_exposicao: 55, no_full_ativos: 8,
  promocoes_abertas: [{ id: 'LGH-MLB1000', tipo: 'LIGHTNING', nome: null, situacao: 'started', comeca: null, termina: null, data_limite: null },
    { id: 'P-MLB17023040', tipo: 'UNHEALTHY_STOCK', nome: 'Acelere suas vendas do Full', situacao: 'started', comeca: '2026-02-12T23:00:00Z', termina: '2027-02-12T15:00:00Z', data_limite: '2027-02-12T15:00:00Z' },
    { id: 'P-MLB17937078', tipo: 'SMART', nome: 'Impulsione suas vendas', situacao: 'started', comeca: '2026-08-23T03:50:00Z', termina: '2027-02-20T02:50:00Z', data_limite: '2027-02-20T02:50:00Z' },
    { id: 'P-MLB17911004', tipo: 'DEAL', nome: 'Black Friday 2026', situacao: 'started', comeca: '2026-11-12T03:00:00Z', termina: '2026-12-01T03:00:00Z', data_limite: '2026-11-30T15:00:00Z' }],
  promocoes_abertas_total: 4 };
const CAMINHOS_ML = ['/users/me', '/users/252698567/items/search?include_filters=true&limit=5', '/users/252698567/items/search?reputation_health_gauge=unhealthy&limit=3',
  '/users/252698567/items/search?logistic_type=fulfillment&status=active&limit=5', '/seller-promotions/users/252698567?app_version=v2'];
/* o ML de mentira: responde pelo caminho; `extra(c, opts)` troca uma resposta */
const respostaML = (c) => {
  if (c === '/users/me') return J({ id: 252698567, site_id: 'MLB', nickname: 'MAGAZINEGIRASSOL', email: 'dono@loja.com', identification: { number: '12345678000199' } });
  if (c.includes('include_filters=true')) return J(copia(ML.todos));
  if (c.includes('reputation_health_gauge=unhealthy')) return J(copia(ML.perdendo));
  if (c.includes('logistic_type=fulfillment')) return J(copia(ML.full));
  if (c.startsWith('/seller-promotions/users/')) return J(copia(ML.promocoes));
  return J({ message: 'caminho que o teste não previu: ' + c }, 500);
};
const mlDeMentira = (extra) => {
  const vistos = [];
  const fetch = async (url, opts) => {
    const c = String(url).replace('https://api.mercadolibre.com', '');
    vistos.push({ url: String(url), c, metodo: opts.method, cab: opts.headers, sinal: opts.signal, temCorpo: 'body' in opts });
    const r = extra ? extra(c, opts) : undefined;
    return r !== undefined ? r : respostaML(c);
  };
  return { fetch, vistos, caminhos: () => vistos.map((v) => v.c) };
};

/* ── a Shopee como respondeu de verdade (Girassol, 15/11) ── */
const M = (tipo, id, pai, nome, atual, anterior, unidade, valor, comparador) => ({ metric_type: tipo, metric_id: id, parent_metric_id: pai, metric_name: nome, exemption_end_date: '', current_period: atual, last_period: anterior, unit: unidade, target: { value: valor, comparator: comparador } });
const SH = {
  desempenho: { error: '', message: '', request_id: 'x', response: { overall_performance: { rating: 3, fulfillment_failed: 0, listing_failed: 0, custom_service_failed: 1 },
    metric_list: [M(1, 1, 0, 'late_shipment_rate', 1.96, 1.96, 2, 5, '<'), M(1, 3, 0, 'non_fulfillment_rate', 0, 0, 2, 8, '<'), M(3, 11, 0, 'response_rate', 0, 0, 2, 60, '>='), M(2, 12, 0, 'pre_order_listing_rate', 0, 0, 2, 20, '<='),
      M(2, 15, 12, 'the_amount_of_pre_order_listing', null, null, 1, 6, '<'), M(3, 22, 0, 'shop_rating', 4.83, 4.83, 1, 4.5, '>='), M(1, 42, 3, 'cancellation_rate', 0, 0, 2, 8, '<'), M(1, 43, 3, 'return_refund_rate', 0, 0, 2, 8, '<')] } },
  penalidades: { error: '', message: '', response: { total_count: 0, penalty_point_list: [] } },
  punicoes: { error: '', message: '', response: { total_count: 0, punishment_list: [] } },
  com_problema: { error: '', message: '', response: { total_count: 0, listing_list: [] } },
  ativos: { error: '', message: '', response: { item: [{ item_id: 41221196871, item_status: 'NORMAL', update_time: 1794413591, tag: { kit: false } }], total_count: 341, has_next_page: true, next_offset: 5, next: '' } },
  desativados: { error: '', message: '', response: { item: [{ item_id: 22492187157, item_status: 'UNLIST' }], total_count: 1, has_next_page: false, next_offset: 1, next: '' } },
  banidos: { error: '', message: '', response: { total_count: 0, has_next_page: false, next: '' } },
  loja: { shop_name: 'Magazine Girassol', region: 'BR', status: 'NORMAL', is_sip: true, auth_time: 1779302631, expire_time: 1810838630, error: '', message: '' },
};
const m = (nome, area, atual, anterior, unidade, comparador, valor, dentro, sub) => ({ nome, area, atual, periodo_anterior: anterior, unidade, meta: { comparador, valor }, dentro_da_meta: dentro, sub_metrica_de: sub || null, isenta_ate: null });
const RESUMO_SH = { nota_geral_codigo: 3, reprovadas_por_area: { envio: 0, anuncios: 0, atendimento: 1 },
  metricas: [m('late_shipment_rate', 'envio', 1.96, 1.96, '%', '<', 5, true), m('non_fulfillment_rate', 'envio', 0, 0, '%', '<', 8, true), m('response_rate', 'atendimento', 0, 0, '%', '>=', 60, false), m('pre_order_listing_rate', 'anuncios', 0, 0, '%', '<=', 20, true),
    m('the_amount_of_pre_order_listing', 'anuncios', null, null, 'número', '<', 6, null, 'pre_order_listing_rate'), m('shop_rating', 'atendimento', 4.83, 4.83, 'número', '>=', 4.5, true),
    m('cancellation_rate', 'envio', 0, 0, '%', '<', 8, true, 'non_fulfillment_rate'), m('return_refund_rate', 'envio', 0, 0, '%', '<', 8, true, 'non_fulfillment_rate')],
  fora_da_meta: ['response_rate'], lancamentos_de_penalidade: 0, punicoes_em_andamento: 0, anuncios_com_problema: 0,
  anuncios: { ativos: 341, desativados: 1, banidos: 0 }, loja: { situacao: 'NORMAL', autorizacao_do_app_vale_ate: '2027-05-20' } };
const PEDIDOS_SH = [['/api/v2/account_health/get_shop_performance', ''], ['/api/v2/account_health/get_penalty_point_history', 'page_no=1&page_size=5'], ['/api/v2/account_health/get_punishment_history', 'punishment_status=1&page_no=1&page_size=5'],
  ['/api/v2/account_health/get_listings_with_issues', 'page_no=1&page_size=5'], ['/api/v2/product/get_item_list', 'offset=0&page_size=5&item_status=NORMAL'], ['/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=UNLIST'],
  ['/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=BANNED'], ['/api/v2/shop/get_shop_info', '']];
const CHAVE_SH = { '/api/v2/account_health/get_shop_performance|': 'desempenho', '/api/v2/account_health/get_penalty_point_history|page_no=1&page_size=5': 'penalidades', '/api/v2/account_health/get_punishment_history|punishment_status=1&page_no=1&page_size=5': 'punicoes',
  '/api/v2/account_health/get_listings_with_issues|page_no=1&page_size=5': 'com_problema', '/api/v2/product/get_item_list|offset=0&page_size=5&item_status=NORMAL': 'ativos', '/api/v2/product/get_item_list|offset=0&page_size=1&item_status=UNLIST': 'desativados',
  '/api/v2/product/get_item_list|offset=0&page_size=1&item_status=BANNED': 'banidos', '/api/v2/shop/get_shop_info|': 'loja' };
/* o serviço da Shopee de mentira: devolve a resposta dentro do envelope do serviço; `extra(chave, params)` troca uma */
const shDeMentira = (extra) => {
  const vistos = [];
  const pedirAoSync = async (oQue, params, loja) => {
    vistos.push([oQue, params.caminho, params.q, loja, Object.keys(params).sort().join(',')]);
    const chave = CHAVE_SH[params.caminho + '|' + params.q];
    const r = extra ? extra(chave, params) : undefined;
    if (r !== undefined) return r;
    return chave ? { ok: true, status: 200, dados: { ok: true, resposta: copia(SH[chave]) } } : { ok: false, status: 500, erro: 'pedido que o teste não previu' };
  };
  return { pedirAoSync, vistos };
};

(async () => {
  /* ═══ A. ANÚNCIOS DO MERCADO LIVRE ═══ */
  {
    /* A1. o resumo, do formato real */
    assert.deepStrictEqual(ANU.resumir(copia(ML)), RESUMO_ML, 'o resumo dos anúncios não saiu do formato real');
    /* A2. o que não veio não vira zero */
    assert.deepStrictEqual([ANU.resumir(null), ANU.resumir({}), ANU.resumir({ todos: null }), ANU.resumir({ todos: { paging: { total: 5 } } }), ANU.resumir({ todos: { available_filters: 'lixo' } }), ANU.resumir({ todos: { available_filters: [null, { id: 'status' }] } }),
      ANU.resumir({ todos: { available_filters: [{ id: 'status', values: [] }] } }), ANU.resumir({ todos: { available_filters: [{ id: 'status', values: [null, { id: 'active', results: '716' }, { id: '', results: 3 }, { results: 3 }, { id: 'paused', results: -1 }, { id: 'closed', results: 1.5 }] }] } })],
    [null, null, null, null, null, null, null, null], 'sem a contagem por situação não há leitura');
    assert.deepStrictEqual([ANU.resumir({ todos: { available_filters: [{ id: 'status', values: 7 }] } }), ANU.resumir({ todos: { available_filters: [{ id: 'status', values: { active: 3 } }] } }),
      ANU.resumir({ todos: { available_filters: [{ id: 'status', values: [{ id: 'active', results: 1 }] }, { id: 'sub_status', values: 'lixo' }] } }).por_motivo], [null, null, null], 'valores que não são lista não derrubam nem viram leitura');
    {
      const so = (st, mais) => ANU.resumir(Object.assign({ todos: Object.assign({ available_filters: [{ id: 'status', values: st }] }, mais) }));
      /* situação que o ML não listou fica de FORA (não é zero); situação desconhecida só aparece se tiver anúncio */
      const r = so([{ id: 'active', results: 10 }, { id: 'under_review', results: 4 }, { id: 'inactive', results: 0 }, { id: 'paused', results: '7' }, null], { paging: { total: 14 } });
      assert.deepStrictEqual([r.por_situacao, r.outras_situacoes, r.total, r.a_soma_das_situacoes_bate_com_o_total, r.por_motivo, r.perdendo_exposicao, r.no_full_ativos, r.promocoes_abertas, r.promocoes_abertas_total],
        [{ ativos: 10 }, { under_review: 4 }, 14, true, null, null, null, null, null]);
      assert.ok(!('pausados' in r.por_situacao), 'situação não informada não pode virar zero');
      /* código que o objeto "herda" (constructor, toString, __proto__) não acha nada na tabela nem estraga a contagem */
      const h = so([{ id: 'active', results: 10 }, { id: 'constructor', results: 2 }, { id: 'toString', results: 3 }, { id: '__proto__', results: 4 }, { id: 'hasOwnProperty', results: 0 }], { paging: { total: 19 } });
      assert.deepStrictEqual([h.por_situacao, h.outras_situacoes, h.a_soma_das_situacoes_bate_com_o_total, Object.getPrototypeOf(h.outras_situacoes) === Object.prototype], [{ ativos: 10 }, {}, true, true]);
      /* a soma é conferida contra o total; sem o total, não dá pra dizer */
      assert.deepStrictEqual([so([{ id: 'active', results: 10 }], { paging: { total: 11 } }).a_soma_das_situacoes_bate_com_o_total, so([{ id: 'active', results: 10 }], {}).a_soma_das_situacoes_bate_com_o_total, so([{ id: 'active', results: 10 }], { paging: { total: '10' } }).total], [false, null, null]);
      /* as partes: o total de cada busca; resposta sem o total fica nula */
      const p = ANU.resumir({ todos: copia(ML.todos), perdendo: { paging: {} }, full: { paging: { total: 0 } }, promocoes: { results: 'lixo' } });
      assert.deepStrictEqual([p.perdendo_exposicao, p.no_full_ativos, p.promocoes_abertas, p.promocoes_abertas_total], [null, 0, null, null]);
      /* motivo: só os que têm anúncio, com o nome que o ML dá (ou nulo) */
      const mot = ANU.resumir({ todos: { available_filters: [{ id: 'status', values: [{ id: 'active', results: 1 }] }, { id: 'sub_status', values: [{ id: 'held', results: 2 }, { id: 'warning', name: 7, results: 1 }, { id: 'x', results: 0 }, null, { results: 3 }, { id: 'y', results: '4' }, { id: '', results: 5 }] }] } });
      assert.deepStrictEqual(mot.por_motivo, [{ codigo: 'held', nome_no_mercado_livre: null, anuncios: 2 }, { codigo: 'warning', nome_no_mercado_livre: null, anuncios: 1 }]);
      /* promoções: no máximo MAX_PROMOCOES na lista, e o total é o que o ML diz (ou o tamanho da lista) */
      const muitas = { results: Array.from({ length: ANU.MAX_PROMOCOES + 5 }, (_, i) => ({ id: 'P' + i, type: 'DEAL', status: 'started' })).concat([null, 'lixo']), paging: { total: 99 } };
      const pm = ANU.resumir({ todos: copia(ML.todos), promocoes: muitas });
      assert.deepStrictEqual([pm.promocoes_abertas.length, pm.promocoes_abertas_total, pm.promocoes_abertas[0], ANU.resumir({ todos: copia(ML.todos), promocoes: { results: [{ id: 1, type: null, name: '' }, null, 'lixo', 7] } }).promocoes_abertas_total,
        ANU.resumir({ todos: copia(ML.todos), promocoes: { results: [{ id: 1, type: null, name: '' }] } }).promocoes_abertas],
      [ANU.MAX_PROMOCOES, 99, { id: 'P0', tipo: 'DEAL', nome: null, situacao: 'started', comeca: null, termina: null, data_limite: null }, 1, [{ id: null, tipo: null, nome: null, situacao: null, comeca: null, termina: null, data_limite: null }]]);
    }

    /* A3. a consulta: uma sequência fixa de GETs, com o token da loja; do cadastro só o id é usado */
    {
      const ml = mlDeMentira();
      const r = await ANU.consultar({ garantirTokenML: async () => 'tk-loja', fetch: ml.fetch });
      assert.deepStrictEqual([r.ok, r.resumo, r.faltou, r.erro], [true, RESUMO_ML, [], undefined]);
      assert.deepStrictEqual(ml.caminhos(), CAMINHOS_ML, 'a sequência de pedidos ao Mercado Livre mudou');
      assert.ok(ml.vistos.every((v) => v.metodo === 'GET' && v.url.startsWith('https://api.mercadolibre.com/') && v.cab.Authorization === 'Bearer tk-loja' && v.sinal && !v.temCorpo), 'a consulta fez algo que não é um GET ao Mercado Livre com o token da loja');
      assert.deepStrictEqual(Object.keys(r.cru).sort(), ['full', 'perdendo', 'promocoes', 'todos'], 'o cadastro do vendedor não é guardado');
      assert.ok(!/dono@loja|12345678000199|tk-loja/.test(JSON.stringify(r)), 'dado do cadastro (ou o token) saiu na consulta');
      assert.ok(!ml.caminhos().some((c) => /\/orders|\/packs|\/shipments|\/messages|\/claims|\/payments/.test(c)));
    }
    /* parte que falha fica NULA e entra em "faltou" com o motivo — e o resto vale */
    {
      const ml = mlDeMentira((c) => { if (c.includes('unhealthy')) return J({ message: 'erro' }, 500); if (c.includes('fulfillment')) throw new Error('ECONNRESET'); if (c.startsWith('/seller-promotions/')) return { ok: true, status: 200, json: async () => { throw new Error('não é JSON'); } }; return undefined; });
      const r = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: ml.fetch });
      assert.deepStrictEqual([r.ok, r.resumo.por_situacao.ativos, r.resumo.perdendo_exposicao, r.resumo.no_full_ativos, r.resumo.promocoes_abertas, r.faltou, ml.vistos.length],
        [true, 716, null, null, null, [{ o_que: 'os anúncios perdendo exposição', motivo: 'o Mercado Livre respondeu HTTP 500' }, { o_que: 'os anúncios ativos no Full', motivo: 'não respondeu (ECONNRESET)' }, { o_que: 'as promoções abertas pra conta', motivo: 'o Mercado Livre respondeu sem JSON' }], 5]);
      for (const corpo of ['texto', 7, null]) {
        const r2 = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('unhealthy') ? J(corpo) : undefined)).fetch });
        assert.deepStrictEqual([r2.ok, r2.faltou], [true, [{ o_que: 'os anúncios perdendo exposição', motivo: 'o Mercado Livre respondeu sem JSON' }]], 'resposta que não é objeto: ' + JSON.stringify(corpo));
      }
    }
    /* sem a contagem por situação NÃO há leitura (e diz por quê) */
    {
      const r1 = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('include_filters') ? J({}, 503) : undefined)).fetch });
      assert.deepStrictEqual([r1.ok, r1.erro, 'resumo' in r1], [false, 'não consegui ler os anúncios da conta (o Mercado Livre respondeu HTTP 503)', false]);
      const r2 = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('include_filters') ? J({ paging: { total: 9 }, results: [] }) : undefined)).fetch });
      assert.deepStrictEqual([r2.ok, r2.erro], [false, 'o Mercado Livre respondeu sem a contagem dos anúncios por situação']);
    }
    /* a conta: sem o id (ou com um id que não é número) nada mais é pedido */
    for (const [resp, motivo] of [[J({ id: '12/../x' }), 'a resposta veio sem o id'], [J({ nickname: 'X' }), 'a resposta veio sem o id'], [J({}, 401), 'o Mercado Livre respondeu HTTP 401'], [null, 'o Mercado Livre respondeu HTTP ?']]) {
      const ml = mlDeMentira((c) => (c === '/users/me' ? resp : undefined));
      const r = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: ml.fetch });
      assert.deepStrictEqual([r.ok, r.erro, ml.vistos.length], [false, 'o Mercado Livre não disse de quem é a conta (' + motivo + ')', 1]);
    }
    /* sem token: diz e não pede nada */
    for (const [g, erro] of [[async () => null, 'esta loja está sem acesso ao Mercado Livre agora'], [async () => '', 'esta loja está sem acesso ao Mercado Livre agora'], [undefined, 'esta loja está sem acesso ao Mercado Livre agora'],
      [async () => { throw new Error('refresh falhou'); }, 'o acesso ao Mercado Livre não está disponível (refresh falhou)'], [nunca, 'o acesso ao Mercado Livre não está disponível (a renovação do token não respondeu no prazo)']]) {
      const ml = mlDeMentira(); const r = await ANU.consultar({ garantirTokenML: g, fetch: ml.fetch, prazoPedidoMs: 40, prazoMs: 3000 });
      assert.deepStrictEqual([r, ml.vistos.length], [{ ok: false, erro }, 0]);
    }
    assert.deepStrictEqual(await ANU.consultar(null), { ok: false, erro: 'esta loja está sem acesso ao Mercado Livre agora' });
    assert.deepStrictEqual((await ANU.consultar({ garantirTokenML: async () => 'tk' })).ok, false, 'sem o fetch a consulta diz, não lança');
    /* o ML EMUDECE num pedido: custa só o prazo dele (a conexão é abortada) e o resto vale; o corpo que nunca chega, idem */
    {
      let sinal = null;
      const ml = mlDeMentira((c, o) => { if (c.includes('unhealthy')) { sinal = o.signal; return nunca(); } if (c.includes('fulfillment')) return { ok: true, status: 200, json: nunca }; return undefined; });
      const t0 = Date.now();
      const r = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: ml.fetch, prazoPedidoMs: 60, prazoMs: 5000 });
      assert.deepStrictEqual([r.ok, r.faltou.map((f) => f.motivo), sinal.aborted, r.resumo.promocoes_abertas_total, ml.vistos.length, Date.now() - t0 < 3000], [true, ['o Mercado Livre não respondeu no prazo', 'o Mercado Livre não respondeu no prazo'], true, 4, 5, true]);
    }
    /* estourado o prazo TOTAL, nada mais é pedido — e o que falta diz por quê */
    {
      const ml = mlDeMentira((c) => (c.includes('unhealthy') ? nunca() : undefined));
      const r = await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: ml.fetch, prazoPedidoMs: 5000, prazoMs: 700 });
      assert.deepStrictEqual([r.ok, ml.vistos.length, r.faltou.map((f) => f.motivo)], [true, 3, ['o Mercado Livre não respondeu no prazo', 'o prazo da consulta acabou antes deste pedido', 'o prazo da consulta acabou antes deste pedido']]);
    }
    /* sem prazo combinado valem os da peça */
    {
      const _st = global.setTimeout; const pedidos = [];
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      try { await ANU.consultar({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch }); } finally { global.setTimeout = _st; }
      assert.ok(pedidos.includes(ANU.PRAZO_PEDIDO_MS) && ANU.PRAZO_PEDIDO_MS >= 3000 && ANU.PRAZO_PEDIDO_MS <= 20000 && ANU.PRAZO_MS >= ANU.PRAZO_PEDIDO_MS * 2 && ANU.PRAZO_MS <= 60000, 'prazos dos anúncios: ' + pedidos + ' × ' + ANU.PRAZO_PEDIDO_MS + '/' + ANU.PRAZO_MS);
    }
  }

  /* ═══ B. SAÚDE DA CONTA NA SHOPEE ═══ */
  {
    /* B1. o resumo, do formato real */
    assert.deepStrictEqual(SAU.resumir(copia(SH)), RESUMO_SH, 'o resumo da saúde da conta não saiu do formato real');
    /* B1b. A CONTA DA AMB (JSON real de 15/11, já com as 17 métricas — a 1ª sonda só mostrava 8): unidade de código
       não visto fica nula; métrica sem valor atual não tem "dentro da meta" (mesmo com o período anterior fora dela);
       e as que o leitor dá como fora da meta batem, área por área, com as reprovadas que a PRÓPRIA Shopee soma */
    {
      const AMB = { desempenho: { error: '', message: '', response: { overall_performance: { rating: 3, fulfillment_failed: 0, listing_failed: 0, custom_service_failed: 1 }, metric_list: [
        M(1, 1, 0, 'late_shipment_rate', 0.94, 0, 2, 5, '<'), M(1, 3, 0, 'non_fulfillment_rate', 1, 0.82, 2, 8, '<'), M(3, 11, 0, 'response_rate', 21.74, 23.08, 2, 60, '>='), M(2, 12, 0, 'pre_order_listing_rate', 0, 0, 2, 20, '<='),
        M(2, 15, 12, 'the_amount_of_pre_order_listing', null, null, 1, 6, '<'), M(3, 22, 0, 'shop_rating', 4.86, 4.86, 1, 4.5, '>='), M(1, 42, 3, 'cancellation_rate', 1, 0, 2, 8, '<'), M(1, 43, 3, 'return_refund_rate', 0, 0.82, 2, 8, '<'),
        M(2, 52, 0, 'severe_listing_violations', null, 0, 1, 0, '<='), M(2, 53, 0, 'other_listing_violations', null, 3, 1, 0, '<='), M(2, 54, 52, 'prohibited_listings', null, 0, 1, 0, '<='), M(2, 55, 52, 'counterfeit_ip_infringement', null, 0, 1, 0, '<='),
        M(2, 56, 52, 'spam_listings', null, 0, 1, 0, '<='), M(2, 2011, 52, 'pqr_products', null, null, 1, 0, '<='), M(1, 2032, 0, 'saturday_shipment_rate', 75, 0, 2, 20, '>='), M(1, 2033, 0, 'avg_preparation_time_ps', 0.78, 0.78, 4, 1, '<'), M(1, 2037, 0, 'otdr_dd_rate', 100, 96.55, 2, 85, '>=')] } },
        loja: { shop_name: 'AMBTotal', region: 'BR', status: 'NORMAL', auth_time: 1779298820, expire_time: 1810834819, shop_fulfillment_flag: 'PFF - FBS Shop', error: '', message: '' } };
      const ra = SAU.resumir(copia(AMB));
      const de = (nome) => ra.metricas.find((x) => x.nome === nome);
      assert.deepStrictEqual([ra.metricas.length, ra.fora_da_meta, ra.reprovadas_por_area, ra.nota_geral_codigo, ra.loja], [17, ['response_rate'], { envio: 0, anuncios: 0, atendimento: 1 }, 3, { situacao: 'NORMAL', autorizacao_do_app_vale_ate: '2027-05-20' }]);
      assert.deepStrictEqual(de('avg_preparation_time_ps'), { nome: 'avg_preparation_time_ps', area: 'envio', atual: 0.78, periodo_anterior: 0.78, unidade: null, meta: { comparador: '<', valor: 1 }, dentro_da_meta: true, sub_metrica_de: null, isenta_ate: null }, 'unidade de código não visto (4) fica nula — não chutada');
      assert.deepStrictEqual(de('other_listing_violations'), { nome: 'other_listing_violations', area: 'anuncios', atual: null, periodo_anterior: 3, unidade: 'número', meta: { comparador: '<=', valor: 0 }, dentro_da_meta: null, sub_metrica_de: null, isenta_ate: null }, 'sem valor atual não há "dentro da meta" — o período anterior não decide');
      assert.deepStrictEqual([de('prohibited_listings').sub_metrica_de, de('pqr_products').sub_metrica_de, de('cancellation_rate').sub_metrica_de, de('saturday_shipment_rate').dentro_da_meta, de('otdr_dd_rate').dentro_da_meta, de('response_rate').dentro_da_meta, de('response_rate').area],
        ['severe_listing_violations', 'severe_listing_violations', 'non_fulfillment_rate', true, true, false, 'atendimento']);
      /* as fora da meta, área por área, batem com o que a Shopee soma (nas duas contas reais: esta e a da Girassol) */
      for (const r of [ra, SAU.resumir(copia(SH))]) {
        const conta = { envio: 0, anuncios: 0, atendimento: 0 };
        for (const x of r.metricas) if (x.dentro_da_meta === false) conta[x.area]++;
        assert.deepStrictEqual(conta, r.reprovadas_por_area, 'as fora da meta não batem com as reprovadas que a Shopee soma');
      }
    }
    /* B2. o que não veio não vira zero; nada veio = sem leitura */
    assert.deepStrictEqual([SAU.resumir(null), SAU.resumir({}), SAU.resumir('lixo'), SAU.resumir({ outra: { response: {} } })], [null, null, null, null]);
    {
      const r = SAU.resumir({ ativos: copia(SH.ativos) });
      assert.deepStrictEqual(r, { nota_geral_codigo: null, reprovadas_por_area: null, metricas: null, fora_da_meta: null, lancamentos_de_penalidade: null, punicoes_em_andamento: null, anuncios_com_problema: null, anuncios: { ativos: 341, desativados: null, banidos: null }, loja: null });
      /* resposta sem o miolo (ou com o total torto) fica nula */
      const t = SAU.resumir({ penalidades: { error: '' }, punicoes: { response: { total_count: '3' } }, com_problema: { response: { total_count: 2 } }, banidos: { response: 'lixo' }, loja: { status: 7, expire_time: 0 }, desempenho: { response: { overall_performance: 'lixo', metric_list: 'lixo' } } });
      assert.deepStrictEqual([t.lancamentos_de_penalidade, t.punicoes_em_andamento, t.anuncios_com_problema, t.anuncios.banidos, t.loja, t.nota_geral_codigo, t.reprovadas_por_area, t.metricas, t.fora_da_meta], [null, null, 2, null, { situacao: null, autorizacao_do_app_vale_ate: null }, null, null, null, null]);
      assert.deepStrictEqual(SAU.resumir({ loja: { status: 'NORMAL', expire_time: '1810838630' } }).loja, { situacao: 'NORMAL', autorizacao_do_app_vale_ate: null }, 'a validade só vale como número');
    }
    /* cada total vem do pedido DELE (nenhum lê o do vizinho) */
    {
      const tc = (n) => ({ error: '', response: { total_count: n } });
      const d = SAU.resumir({ penalidades: tc(3), punicoes: tc(5), com_problema: tc(7), ativos: tc(11), desativados: tc(13), banidos: tc(17), desempenho: { response: { overall_performance: { rating: 2, fulfillment_failed: 4, listing_failed: 6, custom_service_failed: 8 } } } });
      assert.deepStrictEqual([d.lancamentos_de_penalidade, d.punicoes_em_andamento, d.anuncios_com_problema, d.anuncios, d.nota_geral_codigo, d.reprovadas_por_area], [3, 5, 7, { ativos: 11, desativados: 13, banidos: 17 }, 2, { envio: 4, anuncios: 6, atendimento: 8 }]);
    }
    /* cada métrica: `dentro_da_meta` só com valor, meta e comparador conhecido; área e unidade só dos códigos vistos */
    {
      const uma = (x) => SAU.resumir({ desempenho: { response: { metric_list: [Object.assign(M(1, 1, 0, 'x', 5, 4, 2, 5, '<'), x)] } } }).metricas[0];
      assert.deepStrictEqual([uma({}).dentro_da_meta, uma({ current_period: 4.99 }).dentro_da_meta, uma({ target: { value: 5, comparator: '<=' } }).dentro_da_meta, uma({ target: { value: 5, comparator: '>' } }).dentro_da_meta, uma({ target: { value: 5, comparator: '>=' } }).dentro_da_meta,
        uma({ current_period: 6, target: { value: 5, comparator: '>' } }).dentro_da_meta, uma({ current_period: 6, target: { value: 5, comparator: '<=' } }).dentro_da_meta, uma({ current_period: 4, target: { value: 5, comparator: '>=' } }).dentro_da_meta],
      [false, true, true, false, true, true, false, false]);
      assert.deepStrictEqual([uma({ target: { value: 5, comparator: '=' } }).dentro_da_meta, uma({ target: { value: 5 } }).dentro_da_meta, uma({ target: { comparator: '<' } }).dentro_da_meta, uma({ target: null }).dentro_da_meta, uma({ target: null }).meta, uma({ current_period: null }).dentro_da_meta, uma({ current_period: '' }).atual,
        uma({ current_period: '4.5' }).atual, uma({ current_period: true }).atual, uma({ target: { value: '', comparator: '<' } }).dentro_da_meta, uma({ target: { value: 5, comparator: 'toString' } }).dentro_da_meta],
      [null, null, null, null, null, null, null, 4.5, null, null, null], 'sem valor, sem meta ou com comparador desconhecido não dá pra dizer se está na meta');
      assert.deepStrictEqual([uma({ metric_type: 9 }).area, uma({ metric_type: 3 }).area, uma({ unit: 9 }).unidade, uma({ unit: 1 }).unidade, uma({ exemption_end_date: '2026-12-01' }).isenta_ate, uma({ parent_metric_id: 77 }).sub_metrica_de, uma({ last_period: 'x' }).periodo_anterior],
        [null, 'atendimento', null, 'número', '2026-12-01', null, null]);
      /* meta torta não vira meta; e "sem pai" (0) não acha um indicador de código 0 */
      assert.deepStrictEqual([uma({ target: 'lixo' }).meta, uma({ target: 'lixo' }).dentro_da_meta, uma({ target: {} }).meta], [null, null, { comparador: null, valor: null }]);
      const comZero = SAU.resumir({ desempenho: { response: { metric_list: [M(1, 0, 0, 'zero', 1, 1, 2, 5, '<'), M(1, 5, 0, 'solta', 1, 1, 2, 5, '<'), M(1, 6, 5, 'filha', 1, 1, 2, 5, '<'), { metric_id: 9 }, M(1, 7, 9, 'filha_de_sem_nome', 1, 1, 2, 5, '<')] } } }).metricas;
      assert.deepStrictEqual(comZero.map((x) => [x.nome, x.sub_metrica_de]), [['zero', null], ['solta', null], ['filha', 'solta'], ['filha_de_sem_nome', null]]);
      /* código que o objeto "herda" não acha nada na tabela */
      assert.deepStrictEqual([uma({ metric_type: 'toString' }).area, uma({ unit: 'constructor' }).unidade, uma({ parent_metric_id: 'toString' }).sub_metrica_de, uma({ parent_metric_id: 1 }).sub_metrica_de, uma({ target: { value: 5, comparator: 'constructor' } }).dentro_da_meta], [null, null, null, 'x', null]);
      /* métrica sem nome some; a lista tem teto */
      const l = SAU.resumir({ desempenho: { response: { metric_list: [null, 'lixo', { metric_name: '' }, { metric_id: 1 }, M(1, 1, 0, 'a', 1, 1, 2, 5, '<')].concat(Array.from({ length: SAU.MAX_METRICAS + 3 }, (_, i) => M(1, 100 + i, 0, 'm' + i, 9, 9, 2, 5, '<'))) } } });
      assert.deepStrictEqual([l.metricas.length, l.metricas[0].nome, l.fora_da_meta.length], [SAU.MAX_METRICAS - 4, 'a', SAU.MAX_METRICAS - 5]);
      assert.ok(SAU.MAX_METRICAS >= 17 && SAU.MAX_METRICAS <= 200);
    }

    /* B3. a consulta: tudo pelo repasse cru do serviço, na loja pedida, só caminhos de leitura */
    {
      const sh = shDeMentira();
      const r = await SAU.consultar({ pedirAoSync: sh.pedirAoSync, loja: 'amb' });
      assert.deepStrictEqual([r.ok, r.resumo, r.faltou, r.erro], [true, RESUMO_SH, [], undefined]);
      assert.deepStrictEqual(sh.vistos.map((v) => [v[1], v[2]]), PEDIDOS_SH, 'a sequência de pedidos à Shopee mudou');
      assert.ok(sh.vistos.every((v) => v[0] === 'shopee-raw' && v[3] === 'amb' && v[4] === 'caminho,q'), 'a consulta pediu algo fora do repasse cru: ' + JSON.stringify(sh.vistos[0]));
      assert.ok(sh.vistos.every((v) => /^\/api\/v2\/(account_health|product|shop)\/get_[a-z_]+$/.test(v[1])) && !sh.vistos.some((v) => /\/(order|returns|payment|logistics|chat)\//.test(v[1])), 'caminho fora da leitura da conta');
      assert.deepStrictEqual(SAU.ROTEIRO.map((x) => [x[2], x[3]]), PEDIDOS_SH);
      assert.deepStrictEqual(Object.keys(r.cru).sort(), ['ativos', 'banidos', 'com_problema', 'desativados', 'desempenho', 'loja', 'penalidades', 'punicoes']);
      /* sem a loja dita, vai a da própria peça (o serviço decide) */
      const sh2 = shDeMentira(); await SAU.consultar({ pedirAoSync: sh2.pedirAoSync });
      assert.ok(sh2.vistos.every((v) => v[3] === undefined));
    }
    /* erro da Shopee, do serviço, queda de rede, resposta vazia: a parte fica NULA e entra em "faltou" — o resto vale */
    {
      const sh = shDeMentira((k) => {
        if (k === 'penalidades') return { ok: false, status: 200, dados: { ok: false, resposta: { error: 'api_suspended', message: 'Permission denied.', response: { total_count: 9 } } } };
        if (k === 'punicoes') return { ok: false, status: 502, erro: 'serviço fora' };
        if (k === 'com_problema') throw new Error('ECONNREFUSED');
        if (k === 'ativos') return { ok: true, status: 200, dados: null };
        if (k === 'desativados') return { ok: true, status: 200, dados: { total_count: 0, response: { total_count: 4 } } };   /* sem o envelope "resposta" */
        if (k === 'banidos') return { ok: true, status: 200, dados: { resposta: 'texto' } };
        if (k === 'loja') return null;   /* o serviço devolveu NADA */
        return undefined;
      });
      const r = await SAU.consultar({ pedirAoSync: sh.pedirAoSync, loja: 'good' });
      assert.deepStrictEqual([r.ok, r.resumo.metricas.length, r.resumo.lancamentos_de_penalidade, r.resumo.punicoes_em_andamento, r.resumo.anuncios_com_problema, r.resumo.anuncios, sh.vistos.length],
        [true, 8, null, null, null, { ativos: null, desativados: 4, banidos: null }, 8]);
      assert.strictEqual(r.resumo.loja, null);
      assert.deepStrictEqual(r.faltou.pop(), { o_que: 'os dados da loja', motivo: 'a Shopee respondeu sem conteúdo' });
      assert.deepStrictEqual(r.faltou, [{ o_que: 'o histórico de pontos de penalidade', motivo: 'api_suspended — Permission denied.' }, { o_que: 'as punições em andamento', motivo: 'serviço fora' }, { o_que: 'os anúncios com problema', motivo: 'não respondeu (ECONNREFUSED)' },
        { o_que: 'os anúncios ativos', motivo: 'a Shopee respondeu sem conteúdo' }, { o_que: 'os anúncios banidos', motivo: 'a Shopee respondeu sem conteúdo' }]);
    }
    /* loja sem a Shopee ligada; e a Shopee que não responde a NADA */
    assert.deepStrictEqual([await SAU.consultar(null), await SAU.consultar({}), await SAU.consultar({ pedirAoSync: 'x' })], Array(3).fill({ ok: false, erro: 'esta loja não tem a Shopee ligada ao dashboard' }));
    {
      const r = await SAU.consultar({ pedirAoSync: async () => ({ ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste servico' }) });
      assert.deepStrictEqual(r, { ok: false, erro: 'a Shopee não respondeu a nenhum dos pedidos (falta a env SHOPEE_SYNC_KEY neste servico)' });
    }
    /* o serviço EMUDECE num pedido: custa só o prazo dele; estourado o total, nada mais é pedido */
    {
      const sh = shDeMentira((k) => (k === 'penalidades' ? nunca() : undefined));
      const t0 = Date.now();
      const r = await SAU.consultar({ pedirAoSync: sh.pedirAoSync, prazoPedidoMs: 60, prazoMs: 5000 });
      assert.deepStrictEqual([r.ok, r.faltou, sh.vistos.length, Date.now() - t0 < 3000], [true, [{ o_que: 'o histórico de pontos de penalidade', motivo: 'a Shopee não respondeu no prazo' }], 8, true]);
      const sh2 = shDeMentira((k) => (k === 'penalidades' ? nunca() : undefined));
      const r2 = await SAU.consultar({ pedirAoSync: sh2.pedirAoSync, prazoPedidoMs: 5000, prazoMs: 700 });
      assert.deepStrictEqual([r2.ok, sh2.vistos.length, r2.faltou.length, r2.faltou.slice(1).every((f) => f.motivo === 'o prazo da consulta acabou antes deste pedido'), r2.resumo.metricas.length], [true, 2, 7, true, 8]);
    }
    {
      const _st = global.setTimeout; const pedidos = [];
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      try { await SAU.consultar({ pedirAoSync: shDeMentira().pedirAoSync }); } finally { global.setTimeout = _st; }
      assert.ok(pedidos.includes(SAU.PRAZO_PEDIDO_MS) && SAU.PRAZO_PEDIDO_MS >= 3000 && SAU.PRAZO_PEDIDO_MS <= 20000 && SAU.PRAZO_MS >= SAU.PRAZO_PEDIDO_MS * 2 && SAU.PRAZO_MS <= 90000, 'prazos da saúde: ' + pedidos + ' × ' + SAU.PRAZO_PEDIDO_MS + '/' + SAU.PRAZO_MS);
    }
  }

  /* ═══ C. AS FOTOS E "O QUE MUDOU" ═══ */
  {
    /* o prazo em sequência: cada pedido com o que sobra do total; acabou o total, nem começa */
    {
      const ir = prazoEmSequencia(400, 5000);
      const t0 = Date.now();
      const a = await ir(async () => 'veio', () => 'estourou', () => 'sem tempo');
      const b = await ir(() => nunca(), () => 'estourou', () => 'sem tempo');
      let rodou = false;
      const c = await ir(async () => { rodou = true; return 'veio'; }, () => 'estourou', () => 'sem tempo');
      assert.deepStrictEqual([a, b, c, rodou, Date.now() - t0 < 2500], ['veio', 'estourou', 'sem tempo', false, true]);
      const ir2 = prazoEmSequencia(5000, 60);
      assert.deepStrictEqual([await ir2(() => nunca(), () => 'estourou', () => 'sem tempo'), await ir2(async () => 'veio', () => 'estourou', () => 'sem tempo')], ['estourou', 'veio']);
      await assert.rejects(() => ir2(async () => { throw new Error('caiu'); }, () => 'estourou', () => 'sem tempo'), /caiu/);
      assert.ok(MINIMO_PRA_OUTRO_PEDIDO_MS >= 100 && MINIMO_PRA_OUTRO_PEDIDO_MS <= 1000);
    }
    const FOTOS = require('../lib/checkout/fotos-diarias');
    assert.throws(() => FOTOS.criar({}), /falta o nome do arquivo/); assert.throws(() => FOTOS.criar(null), /falta o nome do arquivo/);
    {
      const g = FOTOS.criar({ arquivo: '_teste_fotos.json', maxFotos: 3 }), dirG = novoDir(), cxG = { CACHE_DIR: dirG, readJson, writeJson };
      assert.deepStrictEqual([g.gravar(null, '2026-01-01', { em: 'a' }), g.gravar(cxG, '2026-01-01', null), g.gravar(cxG, '2026-01-01', 'texto'), g.gravar(cxG, '', { em: 'a' }), g.gravar(cxG, '2026-1-1', { em: 'a' }), fs.readdirSync(dirG)], [false, false, false, false, false, []]);
      for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) assert.strictEqual(g.gravar(cxG, d, { em: d, n: 1 }), true);
      assert.deepStrictEqual([Object.keys(g.ler(cxG)), g.historico(cxG, '2026-01-03', '2026-01-03'), readJson(path.join(dirG, '_teste_fotos.json'), {}).atualizado, g.arquivo, g.maxFotos, FOTOS.criar({ arquivo: 'x' }).maxFotos],
        [['2026-01-02', '2026-01-03', '2026-01-04'], [{ dia: '2026-01-03', em: '2026-01-03', n: 1 }], '2026-01-04', '_teste_fotos.json', 3, 400]);
    }
    for (const [LIB, resumo, nome] of [[ANU, RESUMO_ML, 'anúncios'], [SAU, RESUMO_SH, 'saúde']]) {
      const dir = novoDir(); const cx = { CACHE_DIR: dir, readJson, writeJson };
      /* grava no cache DA EMPRESA, uma por dia (a última do dia vence), e devolve true */
      assert.strictEqual(LIB.fotografar(Object.assign({ dia: '2026-11-14', resumo: copia(resumo), em: '2026-11-14T10:00:00.000Z' }, cx)), true, nome);
      assert.strictEqual(LIB.fotografar(Object.assign({ dia: '2026-11-15', resumo: copia(resumo), em: '2026-11-15T08:00:00.000Z' }, cx)), true);
      assert.strictEqual(LIB.fotografar(Object.assign({ dia: '2026-11-15', resumo: copia(resumo), em: '2026-11-15T12:00:00.000Z' }, cx)), true);
      const arq = readJson(path.join(dir, LIB.ARQUIVO), null);
      assert.deepStrictEqual([Object.keys(arq.dias), arq.dias['2026-11-15'].em, arq.atualizado, fs.readdirSync(dir)], [['2026-11-14', '2026-11-15'], '2026-11-15T12:00:00.000Z', '2026-11-15T12:00:00.000Z', [LIB.ARQUIVO]], nome + ': a foto do dia');
      /* o histórico: as do intervalo, da mais antiga pra mais nova, com o dia */
      assert.deepStrictEqual([LIB.historico(Object.assign({ de: '2026-11-15', ate: '2026-11-30' }, cx)).map((f) => f.dia), LIB.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx)).map((f) => f.dia), LIB.historico(Object.assign({ de: '2026-12-01', ate: '2026-12-02' }, cx)),
        LIB.historico(Object.assign({ de: '2026-11-01', ate: '2026-11-14' }, cx)).map((f) => f.dia)],
        [['2026-11-15'], ['2026-11-14', '2026-11-15'], [], ['2026-11-14']]);
      /* o disco RECUSA (o gravador de produção devolve false, não lança) ou lança: a foto NÃO foi gravada, e isso é dito */
      assert.deepStrictEqual([LIB.fotografar({ CACHE_DIR: dir, readJson, writeJson: () => false, dia: '2026-11-16', resumo: copia(resumo) }), LIB.fotografar({ CACHE_DIR: dir, readJson, writeJson: () => { throw new Error('disco cheio'); }, dia: '2026-11-16', resumo: copia(resumo) }),
        LIB.fotografar({ CACHE_DIR: dir, readJson, writeJson: () => undefined, dia: '2026-11-16', resumo: copia(resumo) })], [false, false, true], nome + ': o disco que recusa');
      /* sem dia válido ou sem resumo não grava */
      assert.deepStrictEqual([LIB.fotografar(Object.assign({ dia: '15/11/2026', resumo: copia(resumo) }, cx)), LIB.fotografar(Object.assign({ dia: '2026-11-15' }, cx)), LIB.fotografar(null), LIB.fotografar(Object.assign({ resumo: copia(resumo) }, cx))], [false, false, false, false]);
      /* arquivo torto não derruba: lê o que der */
      writeJson(path.join(dir, LIB.ARQUIVO), { dias: { '2026-11-10': { em: 'x' }, lixo: { em: 'y' }, '2026-11-1x': { em: 'z' }, '2026-11': { em: 'w' }, '2026-11-11': null, '2026-11-12': 'texto' } });
      assert.deepStrictEqual(LIB.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx)).map((f) => f.dia), ['2026-11-10']);
      for (const torto of [{ dias: [1, 2] }, { dias: 'x' }, 'lixo', null]) { writeJson(path.join(dir, LIB.ARQUIVO), torto); assert.deepStrictEqual(LIB.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx)), []); }
      /* guarda no máximo MAX_FOTOS dias (os mais novos) */
      const muitos = {}; for (let i = 0; i < LIB.MAX_FOTOS + 5; i++) muitos[new Date(Date.parse('2020-01-01T12:00:00Z') + i * 86400000).toISOString().slice(0, 10)] = { em: 'x' };
      writeJson(path.join(dir, LIB.ARQUIVO), { dias: muitos });
      LIB.fotografar(Object.assign({ dia: '2026-11-15', resumo: copia(resumo) }, cx));
      const dias = Object.keys(readJson(path.join(dir, LIB.ARQUIVO), {}).dias);
      assert.deepStrictEqual([dias.length, dias[dias.length - 1], dias.includes('2020-01-01'), LIB.MAX_FOTOS >= 365 && LIB.MAX_FOTOS <= 1000], [LIB.MAX_FOTOS, '2026-11-15', false, true], nome + ': teto de fotos');
    }

    /* o que mudou — anúncios do ML */
    {
      const dir = novoDir(); const cx = { CACHE_DIR: dir, readJson, writeJson };
      const antes = copia(RESUMO_ML); antes.total = 2400; antes.por_situacao.ativos = 760; antes.por_situacao.pausados = 1530; antes.perdendo_exposicao = 40; antes.no_full_ativos = null;
      antes.promocoes_abertas = [{ id: 'P-VELHA', tipo: 'DEAL', nome: 'Semana do Cliente' }, { id: 'LGH-MLB1000', tipo: 'LIGHTNING', nome: null }, { id: null, tipo: 'X', nome: 'sem id' }];
      ANU.fotografar(Object.assign({ dia: '2026-11-08', resumo: antes, em: 'a' }, cx)); ANU.fotografar(Object.assign({ dia: '2026-11-15', resumo: copia(RESUMO_ML), em: 'b' }, cx));
      const fotos = ANU.historico(Object.assign({ de: '2026-11-01', ate: '2026-11-15' }, cx));
      assert.deepStrictEqual(fotos[1], { dia: '2026-11-15', em: 'b', total: 2384, por_situacao: RESUMO_ML.por_situacao, perdendo_exposicao: 55, no_full_ativos: 8,
        promocoes: [{ id: 'LGH-MLB1000', tipo: 'LIGHTNING', nome: null }, { id: 'P-MLB17023040', tipo: 'UNHEALTHY_STOCK', nome: 'Acelere suas vendas do Full' }, { id: 'P-MLB17937078', tipo: 'SMART', nome: 'Impulsione suas vendas' }, { id: 'P-MLB17911004', tipo: 'DEAL', nome: 'Black Friday 2026' }] }, 'a foto dos anúncios guarda só o que o chat compara');
      assert.deepStrictEqual(ANU.comparar(fotos), { de: '2026-11-08', ate: '2026-11-15', fotos: 2, total: { antes: 2400, depois: 2384, diferenca: -16 }, ativos: { antes: 760, depois: 716, diferenca: -44 }, pausados: { antes: 1530, depois: 1562, diferenca: 32 },
        inativos_por_pendencia_ou_infracao: { antes: 104, depois: 104, diferenca: 0 }, perdendo_exposicao: { antes: 40, depois: 55, diferenca: 15 }, no_full_ativos: { antes: null, depois: 8, diferenca: null },
        promocoes_que_entraram: [{ id: 'P-MLB17023040', tipo: 'UNHEALTHY_STOCK', nome: 'Acelere suas vendas do Full' }, { id: 'P-MLB17937078', tipo: 'SMART', nome: 'Impulsione suas vendas' }, { id: 'P-MLB17911004', tipo: 'DEAL', nome: 'Black Friday 2026' }],
        promocoes_que_sairam: [{ id: 'P-VELHA', tipo: 'DEAL', nome: 'Semana do Cliente' }] });
      assert.deepStrictEqual([ANU.comparar([]), ANU.comparar([fotos[0]]), ANU.comparar(null)], [null, null, null]);
      /* a foto não guarda promoção sem id; e sem a lista de promoções a foto guarda NULO (não lista vazia) */
      assert.deepStrictEqual(fotos[0].promocoes, [{ id: 'P-VELHA', tipo: 'DEAL', nome: 'Semana do Cliente' }, { id: 'LGH-MLB1000', tipo: 'LIGHTNING', nome: null }]);
      const semLista = copia(RESUMO_ML); semLista.promocoes_abertas = null;
      ANU.fotografar(Object.assign({ dia: '2026-11-16', resumo: semLista, em: 'c' }, cx));
      const comSem = ANU.historico(Object.assign({ de: '2026-11-15', ate: '2026-11-16' }, cx));
      assert.deepStrictEqual([comSem[1].promocoes, ANU.comparar(comSem).promocoes_que_entraram, ANU.comparar(comSem).promocoes_que_sairam, ANU.comparar(comSem).ativos.diferenca], [null, null, null, 0], 'uma das fotos sem a lista de promoções: não dá pra dizer o que entrou nem o que saiu');
      /* foto sem o número (ou sem a lista de promoções): diferença NULA — não dá pra dizer, e não é zero */
      const c = ANU.comparar([{ dia: 'a', total: '9', por_situacao: null, promocoes: null }, { dia: 'm', total: 1 }, { dia: 'b', total: 7, por_situacao: { ativos: 3 }, promocoes: [{ id: 'P1' }] }]);
      assert.deepStrictEqual([c.fotos, c.de, c.ate, c.total, c.ativos, c.pausados, c.perdendo_exposicao, c.promocoes_que_entraram, c.promocoes_que_sairam], [3, 'a', 'b', { antes: null, depois: 7, diferenca: null }, { antes: null, depois: 3, diferenca: null }, { antes: null, depois: null, diferenca: null }, { antes: null, depois: null, diferenca: null }, null, null]);
      assert.deepStrictEqual(ANU.comparar([{ dia: 'a', promocoes: [{ id: 'P1' }, null, { nome: 'x' }] }, { dia: 'b', promocoes: [] }]).promocoes_que_sairam, [{ id: 'P1' }]);
      /* a linha de cada dia */
      assert.deepStrictEqual([ANU.linhaDoDia(fotos[0]), ANU.linhaDoDia({ dia: 'x' })], [{ dia: '2026-11-08', total: 2400, ativos: 760, pausados: 1530, inativos_por_pendencia_ou_infracao: 104, perdendo_exposicao: 40, no_full_ativos: null },
        { dia: 'x', total: null, ativos: null, pausados: null, inativos_por_pendencia_ou_infracao: null, perdendo_exposicao: null, no_full_ativos: null }]);
    }
    /* o que mudou — saúde da Shopee */
    {
      const dir = novoDir(); const cx = { CACHE_DIR: dir, readJson, writeJson };
      const antes = copia(RESUMO_SH); antes.nota_geral_codigo = 4; antes.reprovadas_por_area.atendimento = 0; antes.metricas[0].atual = 0.5; antes.metricas[2].atual = 80; antes.metricas[5].atual = null; antes.fora_da_meta = ['shop_rating'];
      antes.anuncios = { ativos: 350, desativados: 1, banidos: null }; antes.punicoes_em_andamento = null; antes.anuncios_com_problema = 3;
      SAU.fotografar(Object.assign({ dia: '2026-11-08', resumo: antes, em: 'a' }, cx)); SAU.fotografar(Object.assign({ dia: '2026-11-15', resumo: copia(RESUMO_SH), em: 'b' }, cx));
      const fotos = SAU.historico(Object.assign({ de: '2026-11-01', ate: '2026-11-15' }, cx));
      assert.deepStrictEqual(fotos[1], { dia: '2026-11-15', em: 'b', nota_geral_codigo: 3, reprovadas_por_area: { envio: 0, anuncios: 0, atendimento: 1 },
        metricas: { late_shipment_rate: 1.96, non_fulfillment_rate: 0, response_rate: 0, pre_order_listing_rate: 0, the_amount_of_pre_order_listing: null, shop_rating: 4.83, cancellation_rate: 0, return_refund_rate: 0 }, fora_da_meta: ['response_rate'],
        lancamentos_de_penalidade: 0, punicoes_em_andamento: 0, anuncios_com_problema: 0, anuncios: { ativos: 341, desativados: 1, banidos: 0 } }, 'a foto da saúde guarda só o que o chat compara');
      assert.deepStrictEqual(SAU.comparar(fotos), { de: '2026-11-08', ate: '2026-11-15', fotos: 2, nota_geral_codigo: { antes: 4, depois: 3, diferenca: -1 },
        reprovadas_por_area: { envio: { antes: 0, depois: 0, diferenca: 0 }, anuncios: { antes: 0, depois: 0, diferenca: 0 }, atendimento: { antes: 0, depois: 1, diferenca: 1 } },
        anuncios: { ativos: { antes: 350, depois: 341, diferenca: -9 }, desativados: { antes: 1, depois: 1, diferenca: 0 }, banidos: { antes: null, depois: 0, diferenca: null } },
        lancamentos_de_penalidade: { antes: 0, depois: 0, diferenca: 0 }, punicoes_em_andamento: { antes: null, depois: 0, diferenca: null }, anuncios_com_problema: { antes: 3, depois: 0, diferenca: -3 },
        metricas_que_mudaram: [{ nome: 'late_shipment_rate', antes: 0.5, depois: 1.96, diferenca: 1.46 }, { nome: 'response_rate', antes: 80, depois: 0, diferenca: -80 }], sairam_da_meta: ['response_rate'], voltaram_pra_meta: ['shop_rating'] });
      assert.deepStrictEqual([SAU.comparar([]), SAU.comparar([fotos[0]]), SAU.comparar(null)], [null, null, null]);
      const c = SAU.comparar([{ dia: 'a', metricas: null, fora_da_meta: null, anuncios: 'lixo' }, { dia: 'b', metricas: { x: 1 }, fora_da_meta: [], reprovadas_por_area: { envio: 2 } }]);
      assert.deepStrictEqual([c.metricas_que_mudaram, c.sairam_da_meta, c.voltaram_pra_meta, c.reprovadas_por_area.envio, c.anuncios.ativos, c.nota_geral_codigo], [null, null, null, { antes: null, depois: 2, diferenca: null }, { antes: null, depois: null, diferenca: null }, { antes: null, depois: null, diferenca: null }]);
      /* uma das fotos sem a lista das fora da meta (ou com algo que não é lista): não dá pra dizer quem saiu nem quem voltou */
      for (const [fa, fb] of [[['x'], null], [null, ['x']], ['x', ['x']], [['x'], 'x'], [undefined, undefined]]) {
        const u = SAU.comparar([{ dia: 'a', fora_da_meta: fa }, { dia: 'b', fora_da_meta: fb }]);
        assert.deepStrictEqual([u.sairam_da_meta, u.voltaram_pra_meta], [null, null], JSON.stringify([fa, fb]));
      }
      /* a diferença sai arredondada (0,3 − 0,1 não é 0,19999…) */
      assert.deepStrictEqual(SAU.comparar([{ dia: 'a', metricas: { x: 0.1 } }, { dia: 'b', metricas: { x: 0.3 } }]).metricas_que_mudaram, [{ nome: 'x', antes: 0.1, depois: 0.3, diferenca: 0.2 }]);
      /* sem as métricas, a foto guarda NULO (não um objeto vazio, que leria como "nenhuma métrica") */
      const semMetricas = copia(RESUMO_SH); semMetricas.metricas = null; semMetricas.fora_da_meta = null;
      SAU.fotografar(Object.assign({ dia: '2026-11-16', resumo: semMetricas, em: 'c' }, cx));
      const ult = SAU.historico(Object.assign({ de: '2026-11-15', ate: '2026-11-16' }, cx));
      assert.deepStrictEqual([ult[1].metricas, ult[1].fora_da_meta, SAU.comparar(ult).metricas_que_mudaram, SAU.comparar(ult).voltaram_pra_meta], [null, null, null, null]);
      /* métrica que só existe numa das fotos não é "mudança" */
      assert.deepStrictEqual(SAU.comparar([{ dia: 'a', metricas: { x: 1, saiu: 2 } }, { dia: 'b', metricas: { x: 1, nova: 9, y: null } }]).metricas_que_mudaram, []);
    }

    /* a etapa da madrugada: lê e grava a foto de hoje; se não leu ou não gravou, LANÇA */
    {
      const dir = novoDir();
      const txt = await ANU.fotoDaMadrugada({ CACHE_DIR: dir, readJson, writeJson, garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, dia: '2026-03-07' });
      assert.deepStrictEqual([txt, readJson(path.join(dir, ANU.ARQUIVO), {}).dias['2026-03-07'].por_situacao.ativos], ['716 ativos · 1562 pausados · 104 inativos por pendência/infração', 716]);
      const txt2 = await ANU.fotoDaMadrugada({ CACHE_DIR: novoDir(), readJson, writeJson, garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => { if (c.includes('unhealthy')) return J({}, 500); if (c.includes('include_filters')) return J({ available_filters: [{ id: 'status', values: [{ id: 'paused', results: 3 }] }] }); return undefined; }).fetch, dia: '2026-03-07' });
      assert.strictEqual(txt2, '? ativos · 3 pausados · ? inativos por pendência/infração (faltou: os anúncios perdendo exposição)');
      await assert.rejects(() => ANU.fotoDaMadrugada({ CACHE_DIR: dir, readJson, writeJson, garantirTokenML: async () => null, fetch: mlDeMentira().fetch }), /sem acesso ao Mercado Livre/);
      await assert.rejects(() => ANU.fotoDaMadrugada({ CACHE_DIR: dir, readJson, writeJson: () => false, garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, dia: '2026-03-07' }), /não consegui gravar a foto do dia/);
      const hojeSP = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
      const d3 = novoDir(); await ANU.fotoDaMadrugada({ CACHE_DIR: d3, readJson, writeJson, garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch });
      assert.ok([hojeSP, new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10)].includes(Object.keys(readJson(path.join(d3, ANU.ARQUIVO), {}).dias)[0]), 'sem o dia dito, a foto é a de hoje (Brasília)');

      const ds = novoDir();
      assert.strictEqual(await SAU.fotoDaMadrugada({ CACHE_DIR: ds, readJson, writeJson, pedirAoSync: shDeMentira().pedirAoSync, dia: '2026-03-07' }), '1 métrica(s) fora da meta (response_rate)');
      assert.strictEqual(readJson(path.join(ds, SAU.ARQUIVO), {}).dias['2026-03-07'].metricas.shop_rating, 4.83);
      const tudoOk = copia(SH.desempenho); tudoOk.response.metric_list[2].current_period = 90;
      assert.strictEqual(await SAU.fotoDaMadrugada({ CACHE_DIR: novoDir(), readJson, writeJson, pedirAoSync: shDeMentira((k) => (k === 'desempenho' ? { ok: true, dados: { resposta: tudoOk } } : (k === 'loja' ? { ok: false, erro: 'fora' } : undefined))).pedirAoSync, dia: '2026-03-07' }), 'todas as métricas dentro da meta (faltou: os dados da loja)');
      const muitasFora = copia(SH.desempenho); for (const x of muitasFora.response.metric_list) if (x.current_period != null) x.current_period = x.target.comparator.startsWith('>') ? 0 : 99;
      assert.strictEqual(await SAU.fotoDaMadrugada({ CACHE_DIR: novoDir(), readJson, writeJson, pedirAoSync: shDeMentira((k) => (k === 'desempenho' ? { ok: true, dados: { resposta: muitasFora } } : undefined)).pedirAoSync, dia: '2026-03-07' }), '7 métrica(s) fora da meta (late_shipment_rate, non_fulfillment_rate, response_rate)');
      assert.strictEqual(await SAU.fotoDaMadrugada({ CACHE_DIR: novoDir(), readJson, writeJson, pedirAoSync: shDeMentira((k) => (k === 'desempenho' ? { ok: false, erro: 'fora' } : undefined)).pedirAoSync, dia: '2026-03-07' }), 'métricas não informadas (faltou: o desempenho da loja (as métricas))');
      await assert.rejects(() => SAU.fotoDaMadrugada({ CACHE_DIR: ds, readJson, writeJson }), /não tem a Shopee ligada/);
      await assert.rejects(() => SAU.fotoDaMadrugada({ CACHE_DIR: ds, readJson, writeJson: () => false, pedirAoSync: shDeMentira().pedirAoSync, dia: '2026-03-07' }), /não consegui gravar a foto do dia/);
    }
  }

  /* ═══ D. PELO CHAT (as consultas dos olhos) ═══ */
  {
    const olhos = (dir, extra) => OLHOS.criarOlhos(Object.assign({ hoje: HOJE, empresa: 'good', CACHE_DIR: dir, readJson, writeJson, validarPeriodo, agora: () => AGORA }, extra)).F;
    /* sem a peça da loja: "não disponível" (e nada é pedido) */
    assert.deepStrictEqual([await olhos(novoDir(), {}).anuncios_mercado_livre({}), await olhos(novoDir(), { garantirTokenML: async () => 'tk' }).anuncios_mercado_livre({}), await olhos(novoDir(), { fetch: async () => J({}) }).anuncios_mercado_livre({})],
      Array(3).fill({ disponivel: false, motivo: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' }));
    assert.deepStrictEqual(await olhos(novoDir(), {}).saude_conta_shopee({}), { disponivel: false, motivo: 'esta loja não tem a Shopee ligada ao dashboard' });

    /* ── anúncios ── a primeira leitura: grava a foto de hoje e diz desde quando há histórico */
    {
      const dir = novoDir(); const ml = mlDeMentira();
      const r = await olhos(dir, { garantirTokenML: async () => 'tk-loja', fetch: ml.fetch }).anuncios_mercado_livre({});
      assert.deepStrictEqual([r.agora, r.nao_veio_agora, r.historico_guardado_desde, r.janela, r.o_que_mudou_na_janela, r.por_dia, ml.vistos.map((v) => v.cab.Authorization).filter((x, i, a) => a.indexOf(x) === i)],
        [RESUMO_ML, [], HOJE, { de: '2026-10-16', ate: HOJE, fotos: 1 }, null, [{ dia: HOJE, total: 2384, ativos: 716, pausados: 1562, inativos_por_pendencia_ou_infracao: 104, perdendo_exposicao: 55, no_full_ativos: 8 }], ['Bearer tk-loja']]);
      assert.deepStrictEqual(r.avisos, ['O histórico de os anúncios do Mercado Livre começa em ' + HOJE + ' (uma foto por dia, a partir de quando esta consulta entrou no ar): não dá pra dizer o que mudou antes disso.']);
      assert.deepStrictEqual([readJson(path.join(dir, ANU.ARQUIVO), {}).dias[HOJE].em, /não QUAIS/.test(r.leia) && /NÃO diz quais anúncios entraram/.test(r.leia) && /não é zero/.test(r.leia)], [new Date(AGORA).toISOString(), true]);
      /* com foto antiga: o que mudou, em código; `dias` escolhe a janela (com piso e teto) */
      const fotos = readJson(path.join(dir, ANU.ARQUIVO), {});
      fotos.dias['2026-11-01'] = Object.assign({}, fotos.dias[HOJE], { em: 'x', por_situacao: Object.assign({}, RESUMO_ML.por_situacao, { ativos: 800 }) });
      fotos.dias['2026-09-01'] = Object.assign({}, fotos.dias[HOJE], { em: 'y', total: 2000 });
      writeJson(path.join(dir, ANU.ARQUIVO), fotos);
      const F = olhos(dir, { garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch });
      const r2 = await F.anuncios_mercado_livre({ dias: 20 });
      assert.deepStrictEqual([r2.janela, r2.o_que_mudou_na_janela.ativos, r2.por_dia.map((x) => [x.dia, x.ativos]), r2.historico_guardado_desde, r2.avisos], [{ de: '2026-10-26', ate: HOJE, fotos: 2 }, { antes: 800, depois: 716, diferenca: -84 }, [['2026-11-01', 800], [HOJE, 716]], '2026-09-01', []]);
      assert.deepStrictEqual([(await F.anuncios_mercado_livre({ dias: 5 })).janela.fotos, (await F.anuncios_mercado_livre({ dias: 9999 })).janela, (await F.anuncios_mercado_livre({ dias: 0 })).janela.de, (await F.anuncios_mercado_livre({ dias: 'x' })).janela.de, (await F.anuncios_mercado_livre()).janela.de],
        [1, { de: '2025-11-15', ate: HOJE, fotos: 3 }, '2026-11-14', '2026-10-16', '2026-10-16']);
      assert.deepStrictEqual([OLHOS.DIAS_CONTA, OLHOS.DIAS_CONTA_MAX], [30, 365]);
      /* o ML não respondeu AGORA: diz, e entrega só o histórico */
      const r3 = await olhos(dir, { garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c === '/users/me' ? J({}, 503) : undefined)).fetch }).anuncios_mercado_livre({});
      assert.deepStrictEqual([r3.agora, r3.nao_veio_agora, r3.janela.fotos, r3.avisos], [null, null, 2, ['Não consegui ler os anúncios do Mercado Livre AGORA (o Mercado Livre não disse de quem é a conta (o Mercado Livre respondeu HTTP 503)) — o que segue é só o histórico guardado.']]);
      /* veio pela metade, e a soma não bate: os dois avisos */
      const torto = copia(ML.todos); torto.paging.total = 9999;
      const r4 = await olhos(novoDir(), { garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('include_filters') ? J(torto) : (c.includes('fulfillment') ? J({}, 500) : undefined))).fetch }).anuncios_mercado_livre({});
      assert.deepStrictEqual([r4.agora.no_full_ativos, r4.nao_veio_agora, r4.avisos.slice(1)], [null, [{ o_que: 'os anúncios ativos no Full', motivo: 'o Mercado Livre respondeu HTTP 500' }],
        ['A soma dos anúncios por situação não bate com o total que o Mercado Livre informou — use os números por situação com cuidado.', 'O Mercado Livre não respondeu a tudo agora — ficou sem: os anúncios ativos no Full (o Mercado Livre respondeu HTTP 500). O que falta está nulo, não é zero.']]);
      /* sem o total (não dá pra conferir a soma): nenhum aviso sobre a soma */
      const semTotal = copia(ML.todos); delete semTotal.paging;
      const r4b = await olhos(novoDir(), { garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('include_filters') ? J(semTotal) : undefined)).fetch }).anuncios_mercado_livre({});
      assert.deepStrictEqual([r4b.agora.total, r4b.agora.a_soma_das_situacoes_bate_com_o_total, r4b.avisos.filter((a) => /soma/.test(a))], [null, null, []]);
      /* o disco recusou a foto: dito */
      const r5 = await olhos(novoDir(), { garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch, writeJson: () => false }).anuncios_mercado_livre({});
      assert.deepStrictEqual(r5.avisos, ['Li os anúncios do Mercado Livre, mas não consegui guardar a foto de hoje (o disco recusou): o histórico fica sem este dia.', 'Ainda não há nenhuma foto guardada de os anúncios do Mercado Livre.']);
      /* janela longa: no máximo MAX_PONTOS_DE_FOTO linhas por dia, com a primeira e a última */
      const d6 = novoDir(); const muitos = {};
      for (let i = 1; i <= 100; i++) muitos[new Date(Date.parse(HOJE + 'T12:00:00Z') - i * 86400000).toISOString().slice(0, 10)] = { em: 'x', total: i, por_situacao: { ativos: i } };
      writeJson(path.join(d6, ANU.ARQUIVO), { dias: muitos });
      const r6 = await olhos(d6, { garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch }).anuncios_mercado_livre({ dias: 365 });
      assert.deepStrictEqual([r6.janela.fotos, r6.por_dia.length <= OLHOS.MAX_PONTOS_DE_FOTO + 1, r6.por_dia.length >= 30, r6.por_dia[0].ativos, r6.por_dia[r6.por_dia.length - 1].dia, r6.o_que_mudou_na_janela.fotos], [101, true, true, 100, HOJE, 101]);
    }

    /* ── saúde da Shopee ── */
    {
      const dir = novoDir(); const sh = shDeMentira();
      const r = await olhos(dir, { pedirAoSync: sh.pedirAoSync }).saude_conta_shopee({});
      assert.deepStrictEqual([r.agora, r.nao_veio_agora, r.historico_guardado_desde, r.janela, r.o_que_mudou_na_janela, sh.vistos.length], [RESUMO_SH, [], HOJE, { de: '2026-10-16', ate: HOJE, fotos: 1 }, null, 8]);
      assert.deepStrictEqual(r.avisos, ['O histórico de a saúde da conta na Shopee começa em ' + HOJE + ' (uma foto por dia, a partir de quando esta consulta entrou no ar): não dá pra dizer o que mudou antes disso.']);
      assert.ok(readJson(path.join(dir, SAU.ARQUIVO), {}).dias[HOJE].em === new Date(AGORA).toISOString() && /NÃO foi conferido no painel da loja/.test(r.leia) && /TOTAL de pontos de penalidade a Shopee não entregou/.test(r.leia));
      const fotos = readJson(path.join(dir, SAU.ARQUIVO), {});
      fotos.dias['2026-11-10'] = Object.assign({}, fotos.dias[HOJE], { em: 'x', fora_da_meta: [], metricas: Object.assign({}, fotos.dias[HOJE].metricas, { response_rate: 75 }) });
      writeJson(path.join(dir, SAU.ARQUIVO), fotos);
      const r2 = await olhos(dir, { pedirAoSync: shDeMentira().pedirAoSync }).saude_conta_shopee({ dias: 10 });
      assert.deepStrictEqual([r2.janela, r2.o_que_mudou_na_janela.metricas_que_mudaram, r2.o_que_mudou_na_janela.sairam_da_meta, r2.avisos], [{ de: '2026-11-05', ate: HOJE, fotos: 2 }, [{ nome: 'response_rate', antes: 75, depois: 0, diferenca: -75 }], ['response_rate'], []]);
      /* a Shopee não respondeu AGORA; veio pela metade; o disco recusou */
      const r3 = await olhos(dir, { pedirAoSync: async () => ({ ok: false, erro: 'serviço fora' }) }).saude_conta_shopee({});
      assert.deepStrictEqual([r3.agora, r3.nao_veio_agora, r3.janela.fotos, r3.avisos], [null, null, 2, ['Não consegui ler a saúde da conta na Shopee AGORA (a Shopee não respondeu a nenhum dos pedidos (serviço fora)) — o que segue é só o histórico guardado.']]);
      const r4 = await olhos(novoDir(), { pedirAoSync: shDeMentira((k) => (k === 'punicoes' ? { ok: false, erro: 'fora' } : undefined)).pedirAoSync }).saude_conta_shopee({});
      assert.deepStrictEqual([r4.agora.punicoes_em_andamento, r4.avisos[1]], [null, 'A Shopee não respondeu a tudo agora — ficou sem: as punições em andamento (fora). O que falta está nulo, não é zero.']);
      const r4b = await olhos(novoDir(), { pedirAoSync: shDeMentira((k) => (k === 'loja' ? { ok: false, erro: 'fora' } : undefined)).pedirAoSync }).saude_conta_shopee({});
      assert.deepStrictEqual([r4b.agora.loja, r4b.agora.metricas.length, r4b.avisos.filter((a) => /autorização/.test(a))], [null, 8, []], 'sem os dados da loja a consulta segue (e não inventa aviso de validade)');
      const r5 = await olhos(novoDir(), { pedirAoSync: shDeMentira().pedirAoSync, writeJson: () => false }).saude_conta_shopee({});
      assert.deepStrictEqual(r5.avisos, ['Li a saúde da conta na Shopee, mas não consegui guardar a foto de hoje (o disco recusou): o histórico fica sem este dia.', 'Ainda não há nenhuma foto guardada de a saúde da conta na Shopee.']);
      /* a autorização do app: avisa quando falta pouco (ou já venceu) — e só então */
      const comValidade = (dia) => shDeMentira((k) => (k === 'loja' ? { ok: true, dados: { resposta: Object.assign({}, SH.loja, { expire_time: Date.parse(dia + 'T15:00:00Z') / 1000 }) } } : undefined)).pedirAoSync;
      const avisoDe = async (dia) => (await olhos(novoDir(), { pedirAoSync: comValidade(dia) }).saude_conta_shopee({})).avisos.filter((a) => /autorização do app/.test(a));
      assert.deepStrictEqual([await avisoDe('2026-12-15'), await avisoDe('2026-12-16'), await avisoDe('2026-11-15'), await avisoDe('2026-11-10'), await avisoDe('2027-05-20')],
        [['A autorização do app na Shopee vale até 2026-12-15 (faltam 30 dia(s)) — sem renovar, as coletas da Shopee param.'], [], ['A autorização do app na Shopee vale até 2026-11-15 (faltam 0 dia(s)) — sem renovar, as coletas da Shopee param.'],
          ['A autorização do app na Shopee vale até 2026-11-10 (JÁ VENCEU) — sem renovar, as coletas da Shopee param.'], []]);
    }
    /* o que a tela mostra enquanto consulta, e a lista de consultas */
    assert.deepStrictEqual(['anuncios_mercado_livre', 'saude_conta_shopee'].map((n) => OLHOS.descrever(n, {})), ['Olhando os anúncios da conta no Mercado Livre', 'Consultando a saúde da conta na Shopee']);
    assert.deepStrictEqual(OLHOS.FERRAMENTAS.map((f) => f.name), ['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'anuncios_mercado_livre', 'saude_conta_shopee']);
    assert.ok(OLHOS.FERRAMENTAS.slice(4).every((f) => f.description.length > 80 && f.input_schema.type === 'object' && f.input_schema.properties.dias.type === 'integer' && Array.isArray(f.input_schema.required) && f.input_schema.required.length === 0));
    assert.ok(/anuncios_mercado_livre/.test(OLHOS.REGRAS[0]) && /saude_conta_shopee/.test(OLHOS.REGRAS[0]) && /da CONTA inteira/.test(OLHOS.REGRAS[1]) && /se UM anúncio específico estava ativo ou pausado/.test(OLHOS.REGRAS[1]), 'as regras do chat têm que apresentar as duas consultas e dizer o que elas NÃO respondem');
  }

  /* ═══ E. PELA ROTA DE VERDADE (a GOOD, pela fachada de produção) ═══ */
  const C = require('../lib/checkout/chat-analise');
  const P = '/good-checkout-offline';
  {
    const turno = ({ texto, usos }) => {
      const evs = [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }]; let i = 0;
      if (texto) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: texto } }, { type: 'content_block_stop', index: i }); i++; }
      for (const u of (usos || [])) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: u.id, name: u.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } }, { type: 'content_block_stop', index: i }); i++; }
      evs.push({ type: 'message_delta', delta: { stop_reason: (usos || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
      const buf = Buffer.from(evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), 'utf8');
      return { ok: true, status: 200, text: async () => '', body: (async function* () { yield buf; })() };
    };
    const novoRes = () => ({ _json: null, _txt: '', writeHead() {}, setHeader() {}, write(x) { this._txt += String(x); return true; }, end(x) { if (x != null) this._txt += String(x); }, on() {} });
    let sh = shDeMentira((k) => (k === 'loja' ? { ok: true, status: 200, dados: { ok: true, resposta: Object.assign({}, SH.loja, { email: 'dono@loja.com' }) } } : undefined));
    const montar = (extra) => require('../good-checkout-offline/historico-good').rotasHistorico(Object.assign({ validarSessao: (ck) => (ck === 'sess=dono' ? 'dono' : null), supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: TMP,
      json: (res, st, o) => { res._json = [st, o]; }, garantirTokenML: async () => 'tk-da-good', pedirAoSync: (...a) => sh.pedirAoSync(...a), blingGet: async () => ({ ok: false }) }, extra));
    const h = montar();
    const _log = console.log; console.log = () => {};   /* a rota registra cada pergunta no console */
    try {
      rede.mlResposta = respostaML;
      rede.roteiro = [turno({ texto: 'Vou olhar.', usos: [{ id: 't1', name: 'anuncios_mercado_livre', input: {} }, { id: 't2', name: 'saude_conta_shopee', input: { dias: 7 } }] }), turno({ texto: 'Pronto.' })];
      let res = novoRes();
      await h({ method: 'POST', headers: { 'x-admin-key': 'chave-adm' }, body: { pergunta: 'por que caiu no Mercado Livre e na Shopee?' } }, res, new URL('http://x' + P + '/chat-analise'));
      const ev = res._txt.split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
      assert.ok(ev.some((e) => e.t === 'fim') && !ev.some((e) => e.t === 'erro'), 'a pergunta não chegou ao fim: ' + res._txt.slice(0, 300));
      const p1 = rede.api[0], p2 = rede.api[1];
      assert.deepStrictEqual(p1.tools.map((t) => t.name), C.FERRAMENTAS.map((t) => t.name).concat(['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'anuncios_mercado_livre', 'saude_conta_shopee']), 'as seis consultas dos olhos têm que ir na lista que o modelo recebe');
      assert.ok(/anuncios_mercado_livre/.test(p1.system) && /saude_conta_shopee/.test(p1.system) && /da CONTA inteira/.test(p1.system), 'as regras das duas consultas não foram pro prompt');
      /* cada consulta rodou com as peças DA EMPRESA e o resultado voltou pro modelo */
      const voltou = p2.messages[p2.messages.length - 1].content;
      assert.deepStrictEqual(voltou.map((x) => [x.type, x.tool_use_id, x.is_error]), [['tool_result', 't1', undefined], ['tool_result', 't2', undefined]]);
      const [anu, sau] = voltou.map((x) => JSON.parse(x.content));
      assert.deepStrictEqual([anu.agora, anu.nao_veio_agora, rede.ml.map((x) => x[0]), rede.ml.every((x) => x[1] === 'Bearer tk-da-good')], [RESUMO_ML, [], CAMINHOS_ML, true]);
      assert.deepStrictEqual([sau.agora, sau.janela.fotos, sh.vistos.map((v) => [v[1], v[2]]), sh.vistos.every((v) => v[0] === 'shopee-raw' && v[3] === undefined)], [RESUMO_SH, 1, PEDIDOS_SH, true]);
      /* a foto de cada uma foi pro cache DA EMPRESA */
      const diaA = Object.keys(readJson(path.join(TMP, ANU.ARQUIVO), {}).dias), diaS = Object.keys(readJson(path.join(TMP, SAU.ARQUIVO), {}).dias);
      assert.ok(diaA.length === 1 && diaS.length === 1 && diaA[0] === diaS[0] && /^\d{4}-\d{2}-\d{2}$/.test(diaA[0]), 'as consultas pelo chat gravam a foto do dia no cache da empresa');
      assert.deepStrictEqual(ev.filter((e) => e.t === 'passo').map((e) => e.texto), ['Olhando os anúncios da conta no Mercado Livre', 'Consultando a saúde da conta na Shopee']);
      assert.strictEqual(ev.find((e) => e.t === 'fim').uso.consultas, 0, 'os olhos não leem a base de vendas');
      assert.ok(!/dono@loja|12345678000199|tk-da-good/.test(JSON.stringify(rede.api)), 'cadastro, e-mail ou token foi pra API do modelo');

      /* ── as rotas de conferência: só admin, sem modelo, sem gastar pergunta ── */
      const usoAntes = JSON.stringify(readJson(path.join(TMP, '_chat-analise-uso.json'), {}));
      for (const [param, LIB, esperado, chaves, pedidosAntes, quantos] of [['anuncios', ANU, RESUMO_ML, ['full', 'perdendo', 'promocoes', 'todos'], () => rede.ml.length, 5], ['saude_shopee', SAU, RESUMO_SH, ['ativos', 'banidos', 'com_problema', 'desativados', 'desempenho', 'loja', 'penalidades', 'punicoes'], () => sh.vistos.length, 8]]) {
        const u = new URL('http://x' + P + '/chat-analise?' + param + '=1');
        rede.api.length = 0; rede.ml.length = 0; sh.vistos.length = 0;
        fs.unlinkSync(path.join(TMP, LIB.ARQUIVO));   /* a foto que a pergunta gravou sai: a rota tem que gravar a dela */
        res = novoRes(); await h({ method: 'GET', headers: {} }, res, u);
        assert.deepStrictEqual([res._json, pedidosAntes(), fs.existsSync(path.join(TMP, LIB.ARQUIVO))], [[404, { error: 'not found' }], 0, false], param + ': a conferência é só do admin (sem a chave, nada é pedido nem gravado)');
        res = novoRes(); await h({ method: 'GET', headers: { cookie: 'sess=outro' } }, res, u);
        assert.deepStrictEqual([res._json[0], pedidosAntes()], [404, 0]);
        res = novoRes(); await h({ method: 'GET', headers: { cookie: 'sess=dono' } }, res, u);
        const j = res._json[1];
        assert.deepStrictEqual([res._json[0], j.ok, j.erro, j.resumo, j.nao_veio, Object.keys(j.como_o_marketplace_mandou).sort(), j.foto_de_hoje_gravada, j.fotos_guardadas.length, pedidosAntes()], [200, true, undefined, esperado, [], chaves, true, 1, quantos], param);
        assert.ok(fs.existsSync(path.join(TMP, LIB.ARQUIVO)) && /não zero/.test(j.leia), param + ': a conferência grava a foto do dia');
        assert.ok(rede.ml.every((x) => x[1] === 'Bearer tk-da-good') && sh.vistos.every((v) => v[0] === 'shopee-raw'), param + ': a conferência roda com as peças DA EMPRESA');
        assert.deepStrictEqual([rede.api.length, JSON.stringify(readJson(path.join(TMP, '_chat-analise-uso.json'), {}))], [0, usoAntes], param + ': a conferência não chama o modelo nem gasta pergunta');
      }
      /* a resposta do marketplace sai ENCOLHIDA: dado de gente omitido, lista longa cortada (e dita) */
      {
        const SM = require('../lib/checkout/sondas-marketplace');
        const longo = copia(ML.promocoes); longo.results = Array.from({ length: SM.MAX_LISTA_INTEIRA + 9 }, (_, i) => ({ id: 'P' + i, type: 'DEAL', status: 'started' })); longo.paging.total = SM.MAX_LISTA_INTEIRA + 9;
        rede.mlResposta = (c) => (c.startsWith('/seller-promotions/') ? J(longo) : respostaML(c));
        res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?anuncios=1'));
        const lista = res._json[1].como_o_marketplace_mandou.promocoes.results;
        /* o teto é o das "listas inteiras" da sonda (as 17 métricas da Shopee cabem), não o de 8 */
        assert.deepStrictEqual([lista.length, lista[SM.MAX_LISTA_INTEIRA], res._json[1].resumo.promocoes_abertas_total, SM.MAX_LISTA_INTEIRA > 17], [SM.MAX_LISTA_INTEIRA + 1, '…e mais 9 (lista cortada pela sonda)', SM.MAX_LISTA_INTEIRA + 9, true], 'a resposta crua tem que sair encolhida, com o teto das listas inteiras');
        rede.mlResposta = respostaML;
        res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?saude_shopee=1'));
        assert.deepStrictEqual([res._json[1].como_o_marketplace_mandou.loja.email, res._json[1].como_o_marketplace_mandou.loja.shop_name, /dono@loja/.test(JSON.stringify(res._json[1]))], ['[omitido pela sonda]', 'Magazine Girassol', false]);
      }
      /* o marketplace não respondeu: a rota diz, não grava foto nova e mostra as que já havia */
      {
        rede.mlResposta = (c) => (c === '/users/me' ? J({}, 401) : respostaML(c));
        res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?anuncios=1'));
        assert.deepStrictEqual([res._json[1].ok, res._json[1].erro, res._json[1].resumo, res._json[1].nao_veio, res._json[1].como_o_marketplace_mandou, res._json[1].foto_de_hoje_gravada, res._json[1].fotos_guardadas.length],
          [false, 'o Mercado Livre não disse de quem é a conta (o Mercado Livre respondeu HTTP 401)', null, null, null, null, 1]);
        rede.mlResposta = respostaML;
        const shFora = sh; sh = { pedirAoSync: async () => ({ ok: false, erro: 'serviço fora' }), vistos: [] };
        res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?saude_shopee=1'));
        assert.deepStrictEqual([res._json[1].ok, res._json[1].erro, res._json[1].resumo, res._json[1].foto_de_hoje_gravada, res._json[1].fotos_guardadas.length], [false, 'a Shopee não respondeu a nenhum dos pedidos (serviço fora)', null, null, 1]);
        sh = shFora;
      }
      /* loja sem a peça: diz qual falta (e a outra conferência continua valendo) */
      res = novoRes(); await montar({ garantirTokenML: null })({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?anuncios=1'));
      assert.deepStrictEqual(res._json[1], { ok: false, erro: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' });
      res = novoRes(); await montar({ pedirAoSync: null })({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?saude_shopee=1'));
      assert.deepStrictEqual(res._json[1], { ok: false, erro: 'esta loja não tem a Shopee ligada ao dashboard' });
      res = novoRes(); await montar({ pedirAoSync: null })({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?anuncios=1'));
      assert.strictEqual(res._json[1].ok, true);
      /* `?anuncios=0` (ou outro valor) não é a conferência: cai no estado do chat, como antes */
      res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, new URL('http://x' + P + '/chat-analise?anuncios=0&saude_shopee=sim'));
      assert.ok(res._json[1].ok && res._json[1].configurado === true && !('resumo' in res._json[1]));
      /* e POST com `?anuncios=1` não é a conferência (é pergunta do chat — aqui, sem pergunta, é recusada) */
      rede.ml.length = 0;
      res = novoRes(); await h({ method: 'POST', headers: { 'x-admin-key': 'chave-adm' }, body: {} }, res, new URL('http://x' + P + '/chat-analise?anuncios=1'));
      assert.ok(rede.ml.length === 0 && !(res._json && res._json[1] && 'resumo' in res._json[1]), 'POST não pode cair na rota de conferência');
    } finally { console.log = _log; }
  }

  /* ═══ F. A MADRUGADA TIRA AS DUAS FOTOS ═══ */
  {
    const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
    const _log = console.log; console.log = () => {};
    const raiz = path.join(__dirname, '..');
    const dubles = { [require.resolve(path.join(raiz, 'tiktok-oauth', 'index.js'))]: { chamar: async () => ({ ok: true, http: 200, corpo: { code: 0, data: {} } }), lerToken: () => null },
      [require.resolve(path.join(raiz, 'magalu-oauth', 'index.js'))]: { coletarCancelados: async () => ({ ok: true, vistos: 0, novos: 0 }) } };
    const salvos = {};
    for (const [k, v] of Object.entries(dubles)) { salvos[k] = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports: v }; }
    try {
      const noite = async (extra) => {
        const dir = novoDir();
        const ctx = Object.assign({ empresa: 'good', prefixo: P, cacheDir: dir, mlBillingSync: async () => ({ linhas: 0 }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }),
          mlSyncFees: async () => ({ ok: 0, total: 0, falhas: 0 }), varrerCancelados: async () => ({ ok: true }), VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: () => {} }, extra);
        const r = await require('../lib/checkout/noturna-empresa').criarNoturna(ctx).rotinaNoturna('teste');
        const de = (nome) => { const i = r.etapas.findIndex((e) => e.nome === nome); return i < 0 ? null : Object.assign({ posicao: i, depois: r.etapas.length - 1 - i }, r.etapas[i]); };
        return { dir, anuncios: de('foto dos anúncios do Mercado Livre'), saude: de('foto da saúde da conta na Shopee'), reputacao: de('foto da reputação do Mercado Livre'), resumo: r.resumo };
      };
      /* com as peças da empresa: as duas fotos vão pro cache DELA, com as peças DELA */
      const ml = mlDeMentira(), sh = shDeMentira();
      let n = await noite({ garantirTokenML: async () => 'tk-noite', fetch: ml.fetch, pedirAoSync: sh.pedirAoSync });
      assert.ok(n.anuncios && n.anuncios.estado === 'ok' && n.anuncios.detalhe === '716 ativos · 1562 pausados · 104 inativos por pendência/infração', 'a madrugada não tirou a foto dos anúncios: ' + JSON.stringify(n.anuncios));
      assert.ok(n.saude && n.saude.estado === 'ok' && n.saude.detalhe === '1 métrica(s) fora da meta (response_rate)', 'a madrugada não tirou a foto da saúde da conta: ' + JSON.stringify(n.saude));
      /* (a reputação pede `/users/me` uma vez; os anúncios, os cinco pedidos deles — todos com o token da empresa) */
      assert.deepStrictEqual([ml.caminhos(), ml.vistos.every((v) => v.cab.Authorization === 'Bearer tk-noite'), sh.vistos.map((v) => [v[0], v[1], v[2]])], [['/users/me'].concat(CAMINHOS_ML), true, PEDIDOS_SH.map((x) => ['shopee-raw', x[0], x[1]])]);
      const fa = readJson(path.join(n.dir, ANU.ARQUIVO), {}).dias, fs2 = readJson(path.join(n.dir, SAU.ARQUIVO), {}).dias;
      assert.ok(Object.keys(fa).length === 1 && Object.values(fa)[0].por_situacao.ativos === 716 && Object.keys(fs2).length === 1 && Object.values(fs2)[0].metricas.shop_rating === 4.83 && Object.keys(fa)[0] === Object.keys(fs2)[0], 'as fotos da madrugada vão pro cache da empresa, no dia de hoje');
      assert.ok(n.reputacao && n.anuncios.posicao === n.reputacao.posicao + 1 && n.saude.posicao === n.anuncios.posicao + 1, 'as fotos da conta vêm logo depois da foto da reputação');
      /* a leitura falha: a etapa ACUSA (noite sem foto é dia sem histórico), nada é gravado, e a noite SEGUE */
      n = await noite({ garantirTokenML: async () => 'tk', fetch: mlDeMentira((c) => (c.includes('include_filters') ? J({}, 503) : undefined)).fetch, pedirAoSync: async () => ({ ok: false, erro: 'serviço fora' }) });
      assert.ok(n.anuncios.estado === 'erro' && /HTTP 503/.test(n.anuncios.detalhe) && n.saude.estado === 'erro' && /serviço fora/.test(n.saude.detalhe) && /foto dos anúncios do Mercado Livre/.test(n.resumo) && /foto da saúde da conta na Shopee/.test(n.resumo), 'a falha da foto tem que aparecer: ' + JSON.stringify([n.anuncios, n.saude]));
      assert.ok(!fs.existsSync(path.join(n.dir, ANU.ARQUIVO)) && !fs.existsSync(path.join(n.dir, SAU.ARQUIVO)) && n.saude.depois > 0, 'falhou a foto: nada gravado, e a noite segue');
      /* o marketplace EMUDECE: a etapa acusa o prazo e a noite segue (aqui o relógio do teste dispara na hora) */
      n = await noite({ garantirTokenML: async () => 'tk', fetch: () => nunca(), pedirAoSync: () => nunca() });
      assert.ok(n.anuncios.estado === 'erro' && /não respondeu no prazo|o prazo da consulta acabou/.test(n.anuncios.detalhe) && n.saude.estado === 'erro' && /não respondeu no prazo|o prazo da consulta acabou/.test(n.saude.detalhe) && n.saude.depois > 0, 'o marketplace emudeceu e a madrugada não seguiu: ' + JSON.stringify([n.anuncios, n.saude]));
      /* cada foto só roda pra empresa que passou a peça DELA */
      n = await noite({});
      assert.deepStrictEqual([n.anuncios, n.saude, n.reputacao], [null, null, null]);
      n = await noite({ pedirAoSync: shDeMentira().pedirAoSync });
      assert.deepStrictEqual([n.anuncios, n.saude.estado], [null, 'ok']);
      n = await noite({ garantirTokenML: async () => 'tk', fetch: mlDeMentira().fetch });
      assert.deepStrictEqual([n.anuncios.estado, n.saude], ['ok', null]);
    } finally { global.setTimeout = _st; console.log = _log; for (const k of Object.keys(dubles)) { if (salvos[k]) require.cache[k] = salvos[k]; else delete require.cache[k]; } }
  }

  /* ═══ G. NAS TRÊS EMPRESAS ═══ */
  {
    const raiz = path.join(__dirname, '..');
    const EMPRESAS = [['amb', 'amb-checkout-offline', 'amb-historico.js', 'amb-shopee.js', 'index.js', 'pedirAoSync'], ['girassol', 'girassol-backup-offline', 'historico.js', 'gbo-shopee.js', 'gbo-app.js', 'pedirAoSync'], ['good', 'good-checkout-offline', 'historico-good.js', 'good-shopee.js', 'index.js', 'pedirAoSyncShopeeGood']];
    /* a peça do histórico de mentira: só anota o que a fachada de cada empresa entregou */
    const kHist = require.resolve('../lib/checkout/historico');
    const histDeVerdade = require.cache[kHist];
    let entregue = null;
    require.cache[kHist] = { id: kHist, filename: kHist, loaded: true, exports: { rotasHistorico: (c) => { entregue = c; return async () => false; } } };
    const guardados = {};
    try {
      for (const [emp, pasta, fachada, pecaShopee] of EMPRESAS) {
        const kSh = require.resolve(path.join(raiz, pasta, pecaShopee));
        guardados[kSh] = require.cache[kSh];
        require.cache[kSh] = { id: kSh, filename: kSh, loaded: true, exports: { pedirAoSync: async (...a) => ['a-shopee-da-' + emp, a] } };
        const kF = require.resolve(path.join(raiz, pasta, fachada)); delete require.cache[kF];
        entregue = null;
        require(kF).rotasHistorico({ validarSessao: () => null });
        assert.ok(entregue && entregue.empresa === emp, emp + ': a fachada do histórico não montou a peça com a empresa dela');
        assert.strictEqual(typeof entregue.pedirAoSync, 'function', emp + ': a fachada não entrega o pedido à Shopee ao chat — a saúde da conta ficaria "não disponível"');
        assert.deepStrictEqual(await entregue.pedirAoSync('shopee-raw', { caminho: '/x', q: '' }, undefined), ['a-shopee-da-' + emp, ['shopee-raw', { caminho: '/x', q: '' }, undefined]], emp + ': o pedido à Shopee entregue ao chat não é o DESTA empresa');
        delete require.cache[kF];
      }
    } finally { require.cache[kHist] = histDeVerdade; for (const [k, v] of Object.entries(guardados)) { if (v) require.cache[k] = v; else delete require.cache[k]; } }
    /* a peça comum repassa aos olhos o que a fachada entregou (e "não tem" quando a fachada não entrega) */
    {
      const fonte = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');
      assert.ok(/pedirAoSync: typeof ctx\.pedirAoSync === 'function' \? ctx\.pedirAoSync : null \},/.test(fonte), 'lib/checkout/historico.js não repassa o pedido à Shopee aos olhos do chat');
    }
    /* a madrugada de cada empresa recebe o pedido à Shopee DELA (lido no arquivo que monta a madrugada) */
    for (const [emp, pasta, , pecaShopee, entrada, nome] of EMPRESAS) {
      const fonte = fs.readFileSync(path.join(raiz, pasta, entrada), 'utf8');
      const i0 = fonte.search(/const _noturna(Good)? = (require\('\.\.\/lib\/checkout\/noturna-empresa'\)\.)?criarNoturna\(\{/);
      assert.ok(i0 >= 0, emp + ': não achei onde a madrugada é montada');
      const bloco = fonte.slice(i0, fonte.indexOf('\n});\n', i0));
      const mm = /^  pedirAoSync: \(\.\.\.a\) => ([A-Za-z]+)\(\.\.\.a\),$/m.exec(bloco);
      assert.ok(mm && mm[1] === nome, emp + ': a madrugada não recebe o pedido à Shopee desta empresa (a foto diária da saúde da conta não roda)');
      /* …e esse nome vem da peça da Shopee DESTA empresa */
      const imp = new RegExp('\\b' + (nome === 'pedirAoSync' ? 'pedirAoSync' : 'pedirAoSync: ' + nome) + '\\b[^;]*\\} = require\\(\'\\./' + pecaShopee.replace('.js', '') + '\'\\);').test(fonte);
      assert.ok(imp, emp + ': o pedido à Shopee da madrugada não vem de ./' + pecaShopee);
    }
  }

  _chegouAoFim = true;
  console.log('ok — os leitores da conta: anúncios do ML e saúde da Shopee saem do formato real; o que não veio fica nulo e é dito; prazo por pedido e total; uma foto por dia e "o que mudou" em código; pelo chat (seis consultas, com as peças da empresa, sem dado de gente); as rotas de conferência são só do admin; a madrugada tira as duas fotos; nas três empresas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
