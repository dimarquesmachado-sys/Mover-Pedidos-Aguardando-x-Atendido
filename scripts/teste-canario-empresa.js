'use strict';
/* 21/10 — os ADAPTADORES do canário (marketplace × Bling) viraram PEÇA ÚNICA (lib/checkout/canario-empresa), nascida do
   bloco da Girassol. Prova rodando o bloco ORIGINAL (scripts/fixtures/canario-girassol-antes.txt) e a PEÇA no MESMO
   cenário de mentira (Bling com pedidos e irmãs de pacote, ML com pacote e busca paginada, Shopee pela ponte, conserto
   com o importador) — mesmas respostas e mesmas chamadas. E as bordas da peça nas outras empresas: sem módulo da
   Shopee o canal fica de fora; sem importador do ML o conserto só avisa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarCanarioDaEmpresa } = require('../lib/checkout/canario-empresa');

function cenario() {
  const log = [];
  const LOJA_MKT = { '10': 'ml', '20': 'shopee' };
  const blingGet = async (u) => { log.push(['bling', u]);
    return { ok: true, status: 200, data: { data: /pagina=1&/.test(u) ? [
      { loja: { id: 10 }, numeroPedidoLoja: '2000000000000001' }, { loja: { id: 20 }, numeroPedidoLoja: 'SNA' }, { loja: { id: 99 }, numeroPedidoLoja: 'X1' }] : [] } }; };
  const irmasDoPack = (nl) => (nl === '2000000000000001' ? ['2000000000000002'] : null);
  const resp = (corpo, st) => ({ ok: (st || 200) < 400, status: st || 200, json: async () => corpo, text: async () => JSON.stringify(corpo) });
  const fetch = async (u) => { const s = String(u); log.push(['fetch', s.replace('https://api.mercadolibre.com', '')]);
    if (/\/orders\/2000000000000009$/.test(s)) return resp({ id: 2000000000000009, pack_id: 3000000000000001 });
    if (/\/packs\/3000000000000001$/.test(s)) return resp({ orders: [{ id: 2000000000000009 }, { id: 2000000000000010 }] });
    if (/\/users\/me$/.test(s)) return resp({ id: 555 });
    /* Codex #726: pedidos com o formato de produção — o adaptador só aceita status "paid" e data DENTRO da janela */
    if (/\/orders\/search/.test(s)) return resp(/offset=0/.test(s) ? { results: [
      { id: 2000000000000001, status: 'paid', date_created: '2025-10-09T11:40:00.000Z', pack_id: 3000000000000005 },
      { id: 2000000000000003, status: 'paid', date_created: '2025-10-09T20:00:00.000Z', pack_id: null },
      { id: 2000000000000004, status: 'cancelled', date_created: '2025-10-09T12:00:00.000Z' },
      { id: 2000000000000006, status: 'paid', date_created: '2025-10-11T12:00:00.000Z' }], paging: { total: 4 } } : { results: [], paging: { total: 4 } });
    return resp({}, 404); };
  /* Codex #726: o formato de produção da ponte (dados.resposta.response) — antes o teste comparava dois erros iguais */
  const pedirAoSync = async (op, a) => { log.push(['shopee', op, JSON.stringify(a)]); return { ok: true, dados: { resposta: { response: { order_list: [
    { order_sn: 'SNA', order_status: 'READY_TO_SHIP' }, { order_sn: 'SNB', order_status: 'COMPLETED' }, { order_sn: 'SNC', order_status: 'CANCELLED' }], more: false } } } }; };
  /* Codex #726: cliente do TikTok DE MENTIRA (sem token real, sem rede) — com a conta da empresa */
  const tiktok = { lerToken: (conta) => (conta === 'girassol' ? { access_token: 'x' } : null),
    chamar: async (p, q, o, conta) => { log.push(['tiktok', p, conta, JSON.stringify(q)]);
      return { ok: true, corpo: { code: 0, data: /page_token/.test(JSON.stringify(q)) ? { orders: [{ id: 'T3', status: 'COMPLETED' }], next_page_token: '' }
        : { orders: [{ id: 'T1', status: 'AWAITING_SHIPMENT' }, { id: 'T2', status: 'CANCELLED' }], next_page_token: 'pg2' } } }; } };
  const tok = { garantirTokenML: async () => 'TK' };
  const imp = { testarImportarPedido: async (v, conf) => { log.push(['importar', v, conf]); return { criado: true, pedido: { numero: 77 } }; } };
  return { log, LOJA_MKT, blingGet, irmasDoPack, fetch, pedirAoSync, tok, imp, tiktok };
}
const plano = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Set ? [...v].sort() : v)));

(async () => {
  const salvoKey = process.env.SHOPEE_SYNC_KEY; process.env.SHOPEE_SYNC_KEY = 'k';
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'canA-')), dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'canB-'));
  // ANTES: o bloco original, com as mesmas peças de mentira
  const a = cenario();
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'canario-girassol-antes.txt'), 'utf8');
  const reqA = (m) => m === '../girassol/mlTokenManager' ? a.tok : m === '../girassol/importarPedido' ? a.imp : m === '../lib/canario-conserto' ? require('../lib/canario-conserto') : m === '../tiktok-oauth' ? a.tiktok : require(m);
  const A = new Function('blingGet', 'LOJA_MKT', '_irmasDoPack', 'CACHE_DIR', 'pedirAoSync', 'fetch', 'require',
    src + '\nreturn { listarNoBling: _listarNoBlingCanario, listarNoMarketplace: _listarNoMarketplaceCanario, packDaVenda: _packDaVendaCanario, ordensDoPack: _ordensDoPackCanario, consertar: _consertarDoCanario };')(
    a.blingGet, a.LOJA_MKT, a.irmasDoPack, dirA, a.pedirAoSync, a.fetch, reqA);
  // DEPOIS: a peça
  const b = cenario();
  const B = criarCanarioDaEmpresa('girassol', { deps: () => ({ blingGet: b.blingGet, LOJA_MKT: b.LOJA_MKT, irmasDoPack: b.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: b.pedirAoSync, fetch: b.fetch }),
    mlTokenManager: () => b.tok, importarPedido: () => b.imp, tiktokOAuth: () => b.tiktok });
  const passos = [
    ['listarNoBling', (X) => X.listarNoBling('2026-10-01', '2026-10-02')],
    ['packDaVenda', (X) => X.packDaVenda('ml', '2000000000000009')],
    ['ordensDoPack', (X) => X.ordensDoPack('ml', '3000000000000001')],
    ['listarNoMarketplace ml', (X) => X.listarNoMarketplace('ml', 1760000000, 1760086400)],
    ['listarNoMarketplace shopee', (X) => X.listarNoMarketplace('shopee', 1760000000, 1760086400)],
    ['listarNoMarketplace tiktok', (X) => X.listarNoMarketplace('tiktok', 1760000000, 1760086400)],
    /* conserto: uma venda do ML que JÁ está no Bling (reconferida → pulada) e uma que não está (reimporta pelo importador) */
    ['consertar', (X) => X.consertar({ ok: true, alertas: [{ canal: 'ml', faltando: 2, gravidade: 'leve' }], por_canal: { ml: { exemplos: ['2000000000000001', '2000000000000077'] } } })],
  ];
  const esperado = {
    'listarNoMarketplace ml': [{ id: '2000000000000001', apelidos: ['2000000000000001', '3000000000000005'] }, { id: '2000000000000003', apelidos: ['2000000000000003'] }],
    'listarNoMarketplace shopee': ['SNA', 'SNB'],
    'listarNoMarketplace tiktok': ['T1', 'T3'],
  };
  for (const [nome, fn] of passos) {
    const ra = plano(await fn(A).catch(e => ({ erro: e.message })));
    const rb = plano(await fn(B).catch(e => ({ erro: e.message })));
    assert.deepStrictEqual(rb, ra, nome + ': a peça respondeu diferente do bloco original');
    if (esperado[nome]) assert.deepStrictEqual(rb, esperado[nome], nome + ': o adaptador não devolveu o esperado (o caminho de sucesso não foi exercitado?): ' + JSON.stringify(rb));
    assert.ok(!(rb && rb.erro), nome + ': caiu no erro em vez de exercitar o caminho de sucesso: ' + JSON.stringify(rb));
  }
  assert.ok(b.log.some(l => l[0] === 'tiktok' && l[2] === 'girassol'), 'o TikTok não foi chamado com a conta da empresa');
  assert.ok(a.log.some(l => l[0] === 'importar') && a.log.some(l => l[0] === 'shopee') && a.log.some(l => /orders\/search/.test(l[1] || '')), 'o cenário não exercitou os adaptadores (Bling, ML, Shopee e o importador do conserto): ' + JSON.stringify(a.log).slice(0, 300));
  assert.deepStrictEqual(b.log, a.log, 'a peça fez chamadas diferentes do bloco original');

  // bordas nas outras empresas: sem módulo da Shopee, o canal fica de fora; sem importador, o conserto só avisa
  const g = cenario();
  const G = criarCanarioDaEmpresa('good', { deps: () => ({ blingGet: g.blingGet, LOJA_MKT: g.LOJA_MKT, irmasDoPack: g.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: null, fetch: g.fetch }), mlTokenManager: () => g.tok });
  assert.strictEqual(await G.listarNoMarketplace('shopee', 1, 2), null, 'GOOD sem módulo da Shopee: o canal tinha que ficar de fora');
  const fonte = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'canario-empresa.js'), 'utf8');
  assert.ok(/if \(!C\.importarPedido\) return \{ ok: false, erro: 'esta empresa ainda não tem o importador do ML/.test(fonte), 'sem importador, o conserto não avisa');
  /* 25/10: a GOOD (e a AMB) ganharam o importador do ML (lib/importar-pedido-ml) — o conserto recoloca a venda nelas */
  assert.strictEqual(require('../lib/checkout/config-empresa').configCheckout('good').importarPedido, 'good/importarPedido');
  // a Girassol liga a peça e não sobra cópia
  const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(/criarCanarioDaEmpresa\('girassol', \{/.test(gbo) && !/const _listarNoBlingCanario = async \(de, ate\) => \{/.test(gbo), 'a Girassol ainda tem a cópia dos adaptadores');
  if (salvoKey === undefined) delete process.env.SHOPEE_SYNC_KEY; else process.env.SHOPEE_SYNC_KEY = salvoKey;
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
  /* 23/10 (passo 2): a CONFERÊNCIA e as ROTAS da peça — nas três */
  { const c1 = cenario();
    const P = criarCanarioDaEmpresa('good', { deps: () => ({ blingGet: c1.blingGet, LOJA_MKT: c1.LOJA_MKT, irmasDoPack: c1.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: null, fetch: c1.fetch }),
      mlTokenManager: () => c1.tok, tiktokOAuth: () => c1.tiktok, ocupado: () => ({ rodando: false }) });
    const rc = await P.conferir(1, ['ml'], {});
    assert.ok(rc && typeof rc === 'object' && c1.log.some(l => l[0] === 'bling'), 'a conferência da peça não consultou o Bling: ' + JSON.stringify(rc).slice(0, 160));
    assert.strictEqual(P.estado.rodando, false, 'o estado ficou "rodando" depois de terminar');
    // com o backfill da empresa rodando, não confere (a cota do Bling)
    const c2 = cenario();
    const Q = criarCanarioDaEmpresa('good', { deps: () => ({ blingGet: c2.blingGet, LOJA_MKT: c2.LOJA_MKT, irmasDoPack: c2.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: null, fetch: c2.fetch }),
      mlTokenManager: () => c2.tok, ocupado: () => ({ rodando: true, de: '2026-01-01', ate: '2026-01-10' }) });
    const rq = await Q.conferir(3, [], {});
    assert.ok(rq.ok === false && /backfill rodando/.test(rq.erro) && c2.log.length === 0, 'conferiu com o backfill da empresa rodando');
    // rotas: só admin; o estado lê o histórico do conserto DA empresa
    const resp = () => ({ c: 0, b: null });
    const rot = P.rotas({ PREFIXO: '/x', json: (r, c, b) => { r.c = c; r.b = b; }, validarSessao: () => null, ehAdmin: () => false, lerChaveAdmin: () => '' });
    let r0 = resp(); assert.strictEqual(await rot({ headers: {} }, r0, new URL('http://h/x/canario-estado'), 'GET', '/x/canario-estado'), true);
    assert.strictEqual(r0.c, 404, 'o aviso do canário apareceu sem login de admin');
    assert.strictEqual(await rot({ headers: {} }, resp(), new URL('http://h/x/outra'), 'GET', '/x/outra'), false);
    const rotA = P.rotas({ PREFIXO: '/x', json: (r, c, b) => { r.c = c; r.b = b; }, validarSessao: () => ({ u: 'diego' }), ehAdmin: () => true, lerChaveAdmin: () => '' });
    r0 = resp(); await rotA({ headers: {} }, r0, new URL('http://h/x/canario-estado'), 'GET', '/x/canario-estado');
    assert.ok(r0.c === 200 && r0.b && r0.b.ok === true && 'precisa_de_voce' in r0.b, 'o estado do canário não respondeu pro admin: ' + JSON.stringify(r0.b).slice(0, 160)); }
  for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb'], ['good-checkout-offline/index.js', 'good']]) {
    const s2 = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(new RegExp("criarCanarioDaEmpresa\\('" + emp + "', \\{").test(s2), arq + ': não usa a peça do canário');
    assert.ok(/\.rotas\(\{ PREFIXO: '\/[a-z-]+', json, validarSessao, ehAdmin, lerChaveAdmin \}\)\(req, res, urlObj, method, p\)/.test(s2), arq + ': as rotas do canário não são as da peça');
    assert.ok(!/const _listarNoBlingCanario = async \(de, ate\) => \{/.test(s2) && !/canLib\.conferir\(\{ empresa: '/.test(s2), arq + ': sobrou cópia do canário');
  }
  { const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(/agendarDiarioForaDoGalpao\(async \(\) => \{\s*\n\s*const rC = await _canGood\.conferir\(require\('\.\.\/lib\/canario-marketplace'\)\.diasDaNoturna\(\), \[\], \{\}\);/.test(gs), 'GOOD: o canário não está agendado (ou perdeu a janela de 30 dias do domingo)');
    assert.ok(/canarioRodando: \(\) => _canGood\.estado\.rodando/.test(gs), 'GOOD: o backfill (todas as entradas) não respeita o canário');
    assert.ok(/_diarioGood && _diarioGood\.estado === 'rodando'/.test(gs), 'GOOD: o canário não espera o diário');
    assert.ok(/_canGood\.estado\.rodando \|\|/.test(gs), 'GOOD: o plano do ano não espera o canário'); }
  { const cap = require('../lib/checkout/painel/empresas').PAINEL_EMPRESA;
    assert.ok(cap.ambtotal.capacidades.canario === true && cap.good.capacidades.canario === true && cap.girassol.capacidades.canario === true, 'o aviso do canário não está ligado nas três'); }
  /* Codex #731: pendência por ERRO de reimportação, resolução depois de conferência limpa, e Shopee fora do padrão da GOOD */
  { const cons = require('../lib/canario-conserto'); const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'canC-'));
    const pend = { ok: true, alertas: [{ canal: 'ml', gravidade: 'pontual', faltando: 2, de: 40, pct: 5 }], por_canal: { ml: { exemplos: ['1', '2'] } }, nao_verificados: [] };
    await cons.consertar(pend, { cacheDir: dirC, maxAuto: 5, jaEstaNoBling: async () => false, reimportar: async () => ({ ok: false, erro: 'sem importador' }) });
    assert.ok(cons.pendencia(cons.historico(dirC, 1)[0]), 'erro de reimportação não virou pendência (empresa sem importador ficaria sem aviso)');
    await cons.consertar({ ok: true, alertas: [], por_canal: { ml: {} }, nao_verificados: ['shopee'] }, { cacheDir: dirC });
    assert.ok(cons.pendencia(cons.historico(dirC, 1)[0]), 'conferência INDETERMINADA apagou a pendência');
    await cons.consertar({ ok: true, alertas: [], por_canal: { ml: {} }, nao_verificados: [] }, { cacheDir: dirC });
    assert.strictEqual(cons.pendencia(cons.historico(dirC, 1)[0]), null, 'conferência limpa não resolveu a pendência');
    const n = cons.historico(dirC, 50).length; await cons.consertar({ ok: true, alertas: [], por_canal: {}, nao_verificados: [] }, { cacheDir: dirC });
    assert.strictEqual(cons.historico(dirC, 50).length, n, 'conferência limpa sem pendência encheu o histórico');
    const g = cenario(); const G = criarCanarioDaEmpresa('good', { deps: () => ({ blingGet: g.blingGet, LOJA_MKT: g.LOJA_MKT, irmasDoPack: g.irmasDoPack, CACHE_DIR: dirC, pedirAoSync: null, fetch: g.fetch }),
      mlTokenManager: () => g.tok, ocupado: () => ({ rodando: false }) });
    const rg = await G.conferir(1, [], {});
    assert.ok(rg.ok && !('shopee' in rg.por_canal) && !(rg.nao_verificados || []).includes('shopee'), 'a GOOD (sem módulo da Shopee) ainda confere a Shopee por padrão: ' + JSON.stringify(rg.nao_verificados)); }
  console.log('ok — canário: adaptadores em peça única — a da Girassol faz o mesmo que o bloco dela (respostas e chamadas); sem Shopee ou sem importador, fica de fora com aviso');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
