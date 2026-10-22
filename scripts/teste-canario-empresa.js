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
    if (/\/orders\/search/.test(s)) return resp(/offset=0/.test(s) ? { results: [{ id: 2000000000000001 }, { id: 2000000000000003, pack_id: null }], paging: { total: 2 } } : { results: [], paging: { total: 2 } });
    return resp({}, 404); };
  const pedirAoSync = async (op, a) => { log.push(['shopee', op, JSON.stringify(a)]); return { ok: true, response: { order_list: [{ order_sn: 'SNA' }, { order_sn: 'SNB' }], more: false } }; };
  const tok = { garantirTokenML: async () => 'TK' };
  const imp = { testarImportarPedido: async (v, conf) => { log.push(['importar', v, conf]); return { criado: true, pedido: { numero: 77 } }; } };
  return { log, LOJA_MKT, blingGet, irmasDoPack, fetch, pedirAoSync, tok, imp };
}
const plano = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Set ? [...v].sort() : v)));

(async () => {
  const salvoKey = process.env.SHOPEE_SYNC_KEY; process.env.SHOPEE_SYNC_KEY = 'k';
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'canA-')), dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'canB-'));
  // ANTES: o bloco original, com as mesmas peças de mentira
  const a = cenario();
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'canario-girassol-antes.txt'), 'utf8');
  const reqA = (m) => m === '../girassol/mlTokenManager' ? a.tok : m === '../girassol/importarPedido' ? a.imp : m === '../lib/canario-conserto' ? require('../lib/canario-conserto') : m === '../tiktok-oauth' ? require('../tiktok-oauth') : require(m);
  const A = new Function('blingGet', 'LOJA_MKT', '_irmasDoPack', 'CACHE_DIR', 'pedirAoSync', 'fetch', 'require',
    src + '\nreturn { listarNoBling: _listarNoBlingCanario, listarNoMarketplace: _listarNoMarketplaceCanario, packDaVenda: _packDaVendaCanario, ordensDoPack: _ordensDoPackCanario, consertar: _consertarDoCanario };')(
    a.blingGet, a.LOJA_MKT, a.irmasDoPack, dirA, a.pedirAoSync, a.fetch, reqA);
  // DEPOIS: a peça
  const b = cenario();
  const B = criarCanarioDaEmpresa('girassol', { deps: () => ({ blingGet: b.blingGet, LOJA_MKT: b.LOJA_MKT, irmasDoPack: b.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: b.pedirAoSync, fetch: b.fetch }),
    mlTokenManager: () => b.tok, importarPedido: () => b.imp });
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
  for (const [nome, fn] of passos) {
    const ra = plano(await fn(A).catch(e => ({ erro: e.message })));
    const rb = plano(await fn(B).catch(e => ({ erro: e.message })));
    assert.deepStrictEqual(rb, ra, nome + ': a peça respondeu diferente do bloco original');
  }
  assert.ok(a.log.some(l => l[0] === 'importar') && a.log.some(l => l[0] === 'shopee') && a.log.some(l => /orders\/search/.test(l[1] || '')), 'o cenário não exercitou os adaptadores (Bling, ML, Shopee e o importador do conserto): ' + JSON.stringify(a.log).slice(0, 300));
  assert.deepStrictEqual(b.log, a.log, 'a peça fez chamadas diferentes do bloco original');

  // bordas nas outras empresas: sem módulo da Shopee, o canal fica de fora; sem importador, o conserto só avisa
  const g = cenario();
  const G = criarCanarioDaEmpresa('good', { deps: () => ({ blingGet: g.blingGet, LOJA_MKT: g.LOJA_MKT, irmasDoPack: g.irmasDoPack, CACHE_DIR: dirB, pedirAoSync: null, fetch: g.fetch }), mlTokenManager: () => g.tok });
  assert.strictEqual(await G.listarNoMarketplace('shopee', 1, 2), null, 'GOOD sem módulo da Shopee: o canal tinha que ficar de fora');
  const fonte = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'canario-empresa.js'), 'utf8');
  assert.ok(/if \(!C\.importarPedido\) return \{ ok: false, erro: 'esta empresa ainda não tem o importador do ML/.test(fonte), 'sem importador, o conserto não avisa');
  assert.strictEqual(require('../lib/checkout/config-empresa').configCheckout('good').importarPedido, null);
  // a Girassol liga a peça e não sobra cópia
  const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(/criarCanarioDaEmpresa\('girassol', \{/.test(gbo) && !/const _listarNoBlingCanario = async \(de, ate\) => \{/.test(gbo), 'a Girassol ainda tem a cópia dos adaptadores');
  if (salvoKey === undefined) delete process.env.SHOPEE_SYNC_KEY; else process.env.SHOPEE_SYNC_KEY = salvoKey;
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
  console.log('ok — canário: adaptadores em peça única — a da Girassol faz o mesmo que o bloco dela (respostas e chamadas); sem Shopee ou sem importador, fica de fora com aviso');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
