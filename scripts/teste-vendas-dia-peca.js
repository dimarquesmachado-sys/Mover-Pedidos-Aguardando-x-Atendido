'use strict';
/* 17/10 — a venda do dia virou peça única (lib/checkout/vendas-dia.js), nascida da versão da Girassol. Prova de que,
   pra Girassol, NADA muda: roda a função ORIGINAL (recortada do gbo-app.js de antes da migração, guardado em
   scripts/fixtures) e a PEÇA com a configuração da Girassol, no MESMO cenário de mentira (Bling, ML, Shopee, Magalu,
   arquivos), e compara: as chamadas externas, na ordem, e tudo o que foi gravado. Dois cenários: dia vazio e um dia
   com pedidos de ML, Shopee e Magalu passando pelas fases. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarVendasSync } = require('../lib/checkout/vendas-dia');

const ORIG = fs.readFileSync(path.join(__dirname, 'fixtures', 'vendasSync-girassol-antes.js'), 'utf8');
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const limpa = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x).replace(ISO, '<ts>'));

function ambiente(cen) {
  const log = [], disco = {};
  const tkML = { garantirTokenML: async () => 'tk-ml' };
  const resp = (ok, corpo) => ({ ok, status: ok ? 200 : 404, json: async () => corpo, text: async () => JSON.stringify(corpo) });
  const d = {
    CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conferidos.json', LOJA_MKT: { '1': 'ml', '2': 'shopee', '3': 'magalu' }, path,
    _vsy: {},
    _inferCanal: (nl) => /^2\d{15}$/.test(String(nl)) ? 'ml' : 'outro',
    readJson: (p, def) => (p in disco ? JSON.parse(JSON.stringify(disco[p])) : (cen.disco && p in cen.disco ? JSON.parse(JSON.stringify(cen.disco[p])) : def)),
    writeJson: (p, v) => { log.push(['grava', p]); disco[p] = JSON.parse(JSON.stringify(v)); return true; },
    blingGet: async (u) => { log.push(['bling', u]); return (cen.bling && cen.bling(u)) || { ok: true, data: { data: [] } }; },
    json: () => {},
    _faseDireta: async () => { log.push(['fase-direta']); },
    pescarDadosML: async (nl) => { log.push(['pesca-ml', nl]); return (cen.pesca && cen.pesca(nl)) || null; },
    buscarDevolucoesML: async () => { log.push(['devolucoes-ml']); return []; },
    nfDoPedido: async (id) => { log.push(['nf-do-pedido', id]); return null; },
    magaluFreteProvisorio: async (v) => { log.push(['frete-prov', v && v.numero]); return null; },
    magaluFreteSkuGravar: (sku) => { log.push(['frete-sku', sku]); },
  };
  const fetch = async (u) => { log.push(['fetch', String(u).replace(/k=[^&]*/, 'k=<k>')]); const r = cen.fetch && cen.fetch(String(u)); return r || resp(false, null); };
  return { d, fetch, log, disco, tkML };
}

async function rodar(qual, cen) {
  const amb = ambiente(cen);
  let vs;
  if (qual === 'original') {
    const i = ORIG.indexOf('\nasync function vendasSync'), j = ORIG.lastIndexOf('\n}');
    const corpo = ORIG.slice(i + 1, j + 2);
    const req = (m) => (m === '../girassol/mlTokenManager' ? amb.tkML : m === '../tiktok-oauth' ? require('../tiktok-oauth') : require(m));
    const nomes = Object.keys(amb.d);
    vs = new Function(...nomes, 'fetch', 'require', 'ML_REAL_V', corpo + '\nreturn vendasSync;')(...nomes.map(n => amb.d[n]), amb.fetch, req, 2);
  } else {
    vs = criarVendasSync({ tag: 'GIRABKP', magEmpresa: () => process.env.MAGALU_EMPRESA || 'girassol', mlTokenManager: () => amb.tkML,
      tiktokConta: 'girassol', shopeeUrl: () => process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
      shopeeKey: () => process.env.SHOPEE_SYNC_KEY || '', shopeeLoja: () => 'girassol', deps: () => amb.d, fetch: amb.fetch });
  }
  let erro = null; try { await vs(); } catch (e) { erro = String(e && e.message); }
  return { log: amb.log, disco: limpa(amb.disco), vsy: limpa(amb.d._vsy), erro };
}

const hojeBling = new Date().toISOString().slice(0, 10);
const CENARIOS = {
  'dia vazio': {},
  'dia com ML, Shopee e Magalu': {
    disco: { '/c/conferidos.json': { '501': { conferido_em: '2026-10-17T10:00:00Z' } } },
    bling: (u) => {
      if (/^\/pedidos\/vendas\?/.test(u) && /pagina=1&/.test(u)) return { ok: true, data: { data: [
        { id: 501, numero: 9001, numeroLoja: '2000019000000001', data: hojeBling, total: 150, loja: { id: 1 }, situacao: { id: 9 }, contato: { nome: 'A' } },
        { id: 502, numero: 9002, numeroLoja: '251017ABCDEF', data: hojeBling, total: 80, loja: { id: 2 }, situacao: { id: 6 }, contato: { nome: 'B' } },
        { id: 503, numero: 9003, numeroLoja: 'LU-123', data: hojeBling, total: 60, loja: { id: 3 }, situacao: { id: 6 }, contato: { nome: 'C' } } ] } };
      if (/^\/pedidos\/vendas\/50\d$/.test(u)) { const id = Number(u.split('/').pop());
        return { ok: true, data: { data: { id, loja: { id: id - 500 }, itens: [{ codigo: 'SKU' + id, quantidade: 1, valor: 50, descricao: 'X' }], taxas: { taxaComissao: 5, custoFrete: 3 } } } }; }
      return null;
    },
    fetch: (u) => /api\.mercadolibre\.com\/orders\//.test(u) ? { ok: true, status: 200, json: async () => ({ id: 1, date_created: '2026-10-17T09:00:00.000-03:00', shipping: { id: 77 } }) } : null,
    pesca: () => ({ comissao: 10, frete: 5, costs_ok: true, ship_ok: true }),
  },
};

(async () => {
  for (const [nome, cen] of Object.entries(CENARIOS)) {
    for (const env of [{}, { SHOPEE_SYNC_KEY: 'chave', ADMIN_KEY: 'adm' }]) {
      const salvo = {}; for (const k of Object.keys(env)) { salvo[k] = process.env[k]; process.env[k] = env[k]; }
      const a = await rodar('original', cen), b = await rodar('peca', cen);
      for (const k of Object.keys(env)) { if (salvo[k] === undefined) delete process.env[k]; else process.env[k] = salvo[k]; }
      const rot = nome + (Object.keys(env).length ? ' (com Shopee e Magalu ligados)' : '');
      assert.strictEqual(b.erro, a.erro, rot + ': erro diferente: ' + b.erro + ' x ' + a.erro);
      assert.deepStrictEqual(b.log, a.log, rot + ': as chamadas externas mudaram');
      assert.deepStrictEqual(b.disco, a.disco, rot + ': o que foi gravado mudou');
      assert.deepStrictEqual(b.vsy, a.vsy, rot + ': o estado da rodada (_vsy) mudou');
      assert.ok(a.log.length > 0, rot + ': o cenário não exercitou nada');
    }
  }
  // a Girassol usa a peça, com a configuração dela
  const g = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/vendas-dia'\)\.criarVendasSync\(\{\s*\n\s*tag: 'GIRABKP'/.test(g), 'a Girassol não usa a peça');
  assert.ok(!/\nasync function vendasSync\(\) \{\n  const MAG_EMPRESA/.test(g), 'a cópia antiga da venda do dia continua na Girassol');
  console.log('ok — venda do dia: a peça única faz exatamente o que a função da Girassol fazia (chamadas, gravações e estado), em 4 cenários');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
