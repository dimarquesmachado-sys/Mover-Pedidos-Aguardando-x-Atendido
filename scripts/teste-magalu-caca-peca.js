'use strict';
/* 29/10 — a CAÇA DE VENDAS DA MAGALU virou PEÇA ÚNICA (lib/checkout/magalu-caca): era um bloco de ~340 linhas só da AMB.
   Prova, rodando o código de ANTES (fixture) e a peça LADO A LADO nos mesmos dados (Magalu, Bling e Supabase de mentira):
   · magaluLinhas devolve as MESMAS linhas (imposto, custo, comissão real ou pela taxa, frete real ou o previsto por SKU,
     itens que vieram do Bling, suspeito de valor absurdo fora, cancelado separado, o que já está no histórico pulado);
   · cacaMagalu faz as MESMAS gravações no Supabase, na mesma ordem, e termina no MESMO estado (normal e ?refazer=1);
   · reparo de SKU em andamento adia igual; a hora a hora pega os últimos 3 dias da empresa;
   · o ESTADO é de cada empresa (uma caça da AMB não aparece na peça de outra);
   · a AMB usa a peça (a cópia saiu) e o resto do arquivo lê o estado dela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarCacaMagalu } = require('../lib/checkout/magalu-caca');
const criarAntigo = require('./fixtures/magalu-caca-amb-antes');

function cenario() {
  const log = [];
  const supa = { existentes: ['M-JA', 'M-C'],   /* M-C já está no histórico e a Magalu diz cancelado: a caça apaga */ semSku: ['M-REF'], antigas: { 'M-REF': [{ id: 7, numero_loja: 'M-REF', sku: '' }] } };
  const pedidos = [
    { code: 'M-1', id: 'uuid-1', purchased_at: '2026-10-20T10:00:00Z', status: 'approved', total: 200, itens: [{ sku: 'SK1', desc: 'a', qtd: 2, valor: 100 }] },
    { code: 'M-2', id: 'uuid-2', purchased_at: '2026-10-21T10:00:00Z', status: 'approved', total: 150, itens: [] },                     /* sem itens: vem do Bling */
    { code: 'M-JA', id: 'uuid-3', purchased_at: '2026-10-21T10:00:00Z', status: 'approved', total: 90, itens: [{ sku: 'SK1', qtd: 1, valor: 90 }] },
    { code: 'M-C', id: 'uuid-4', purchased_at: '2026-10-22T10:00:00Z', status: 'cancelled', total: 80, itens: [{ sku: 'SK2', qtd: 1, valor: 80 }] },
    { code: 'M-X', id: 'uuid-5', purchased_at: '2026-10-22T10:00:00Z', status: 'approved', total: 99999, itens: [{ sku: 'SK2', qtd: 1, valor: 99999 }] },
    { code: 'M-REF', id: 'uuid-6', purchased_at: '2026-10-23T10:00:00Z', status: 'approved', total: 60, itens: [{ sku: 'SK2', qtd: 1, valor: 60 }] },
    { code: 'M-FORA', id: 'uuid-7', purchased_at: '2026-09-01T10:00:00Z', status: 'approved', total: 60, itens: [{ sku: 'SK2', qtd: 1, valor: 60 }] },
  ];
  const fetch = async (url) => {
    log.push('fetch ' + String(url).replace(/k=[^&]*/, 'k=*').replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
    const r = (b) => ({ status: 200, ok: true, json: async () => b });
    if (/pedidos-do-dia/.test(url)) return r({ ok: true, pedidos, parcial: false });
    if (/financeiro-lote/.test(url)) return r({ ok: true, pedidos: { 'M-1': { frete_debito: -12.5, comissao: -20, mdr: -3, tarifa_fixa: 0 } } });
    return r(null);
  };
  const blingGet = async (p) => {
    log.push('bling ' + p);
    if (/\/pedidos\/vendas\?dataInicial=2026-10-21/.test(p)) return { ok: true, data: { data: [{ id: 555, numeroLoja: 'uuid-2' }] } };
    if (/\/pedidos\/vendas\?/.test(p)) return { ok: true, data: { data: [] } };
    if (/\/pedidos\/vendas\/555$/.test(p)) return { ok: true, data: { data: { itens: [{ codigo: 'SK3', descricao: 'c', quantidade: 1, valor: 150 }] } } };
    return { ok: false };
  };
  const supaReq = async (emp, metodo, pq, body) => {
    log.push('supa ' + emp + ' ' + metodo + ' ' + pq + (body ? ' ' + JSON.stringify(body) : ''));
    if (metodo === 'GET' && /or=\(sku\.is\.null,sku\.eq\.\)/.test(pq)) return { ok: true, status: 200, body: JSON.stringify(supa.semSku.map((n) => ({ numero_loja: n }))) };
    if (metodo === 'GET' && /select=numero_loja/.test(pq)) return { ok: true, status: 200, body: JSON.stringify(supa.existentes.concat(supa.semSku).map((n) => ({ numero_loja: n }))) };
    if (metodo === 'GET' && /select=\*/.test(pq)) { const m = /numero_loja=eq\.([^&]+)/.exec(pq); return { ok: true, status: 200, body: JSON.stringify(supa.antigas[decodeURIComponent(m[1])] || []) }; }
    if (metodo === 'GET') return { ok: true, status: 200, body: '[]' };
    if (metodo === 'DELETE') return { ok: true, status: 204, body: '' };
    if (metodo === 'POST') return { ok: true, status: 201, body: '' };
    return { ok: true, status: 200, body: '' };
  };
  const readJson = (arq, d) => {
    if (/_config-fiscal\.json$/.test(arq)) return { aliquotas: { '2026-10': 6.5 }, taxas: { magalu: 16 } };
    if (/_custos\.json$/.test(arq)) return { SK1: { custo: 30 }, SK2: { custo: 20 }, SK3: { custo: 50 } };
    return d;
  };
  const dep = { fetch, path, readJson, CACHE_DIR: '/tmp/x', blingGet, supaReq, magaluFreteSkuLer: () => ({ SK2: { media: 9.9 }, SK3: { media: 14 } }),
    _histCache: { a: 1 }, DEFAULT_ALIQ_BK: { '2026-09': 5 } };
  return { log, dep };
}

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log; console.log = () => {};
  process.env.ADMIN_KEY = 'adm'; process.env.PORT = '3999';
  let falhou = null;
  try {
    const sem = (o) => JSON.parse(JSON.stringify(o, (k, v) => (['em', 'fim'].includes(k) ? undefined : v)));
    const roda = async (qual, fn) => {
      const c = cenario();
      const m = qual === 'antigo' ? criarAntigo(c.dep)
        : criarCacaMagalu({ empresa: 'amb', magaluEmpresa: () => 'amb', supaReq: c.dep.supaReq, blingGet: c.dep.blingGet, readJson: c.dep.readJson, CACHE_DIR: c.dep.CACHE_DIR,
          DEFAULT_ALIQ_BK: () => c.dep.DEFAULT_ALIQ_BK, magaluFreteSkuLer: c.dep.magaluFreteSkuLer, reparoAtivo: () => false, histCache: () => c.dep._histCache, fetch: c.dep.fetch });
      const r = await fn(m);
      return { r: sem(r), log: c.log, cache: c.dep._histCache };
    };
    // 1) magaluLinhas
    const fL = (m) => m.magaluLinhas('2026-10-01', '2026-10-28', 'amb', new Set(['M-JA']));
    const a1 = await roda('antigo', fL), b1 = await roda('nova', fL);
    assert.deepStrictEqual(b1.r, a1.r, 'magaluLinhas: as linhas mudaram');
    assert.deepStrictEqual(b1.log, a1.log, 'magaluLinhas: as chamadas mudaram');
    assert.ok(a1.r.linhas.length >= 3 && a1.r.pedidos >= 2 && a1.r.suspeitos.length === 1 && a1.r.cancelados.includes('M-C') && a1.r.enriquecidos_bling === 1, 'o cenário não exercitou os caminhos: ' + JSON.stringify(a1.r).slice(0, 200));
    // 2) cacaMagalu, normal e refazer
    for (const opts of [{}, { refazer: true }]) {
      const f = (m) => m.cacaMagalu('2026-10-01', '2026-10-28', 'amb', opts);
      const a = await roda('antigo', f), b = await roda('nova', f);
      assert.deepStrictEqual(b.log, a.log, 'cacaMagalu ' + JSON.stringify(opts) + ': as gravações no Supabase mudaram');
      assert.deepStrictEqual(b.r, a.r, 'cacaMagalu ' + JSON.stringify(opts) + ': o estado final mudou');
      assert.deepStrictEqual(b.cache, a.cache, 'cacaMagalu: o cache do histórico não foi limpo igual');
      assert.ok(a.log.some((l) => /supa amb POST vendas_historico/.test(l)) && a.log.some((l) => /supa amb DELETE/.test(l)), 'o cenário não gravou/apagou (a comparação não provaria nada): ' + JSON.stringify(a.r).slice(0, 300) + ' | ' + a.log.slice(-4).join(' ; ').slice(0, 300));
    }
    // 3) reparo em andamento adia igual
    { const c = cenario(); const ant = criarAntigo(c.dep); ant.setReparo(true);
      const nova = criarCacaMagalu({ empresa: 'amb', supaReq: c.dep.supaReq, blingGet: c.dep.blingGet, readJson: c.dep.readJson, CACHE_DIR: '/tmp/x', reparoAtivo: () => true, fetch: c.dep.fetch });
      const ra = sem(await ant.cacaMagalu('2026-10-01', '2026-10-02', 'amb')), rb = sem(await nova.cacaMagalu('2026-10-01', '2026-10-02', 'amb'));
      assert.deepStrictEqual(rb, ra, 'reparo em andamento não adiou igual'); assert.ok(ra.adiado, 'o cenário de reparo não adiou'); }
    // 4) a hora a hora é da EMPRESA da peça, e o estado é de cada empresa
    { const c = cenario();
      const g = criarCacaMagalu({ empresa: 'girassol', supaReq: c.dep.supaReq, blingGet: c.dep.blingGet, readJson: c.dep.readJson, CACHE_DIR: '/tmp/x', fetch: c.dep.fetch });
      const am = criarCacaMagalu({ empresa: 'amb', supaReq: c.dep.supaReq, blingGet: c.dep.blingGet, readJson: c.dep.readJson, CACHE_DIR: '/tmp/x', fetch: c.dep.fetch });
      await g.cacaMagaluCron();
      assert.ok(c.log.some((l) => /pedidos-do-dia\?empresa=girassol/.test(l)) && c.log.some((l) => /supa girassol GET vendas_historico\?empresa=eq\.girassol/.test(l)), 'a hora a hora não usou a empresa da peça');
      assert.ok(g.estado().de && !am.estado().de, 'a caça da Girassol apareceu no estado da AMB (estado dividido)'); }
  } catch (e) { falhou = e; }
  finally { console.log = _log; global.setTimeout = _st; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  // 5) a AMB usa a peça
  const s = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(s.includes("const _cacaMgAmb = require('../lib/checkout/magalu-caca').criarCacaMagalu({") && !/async function magaluLinhas\(/.test(s) && !/let _mgc = \{/.test(s), 'a AMB não usa a peça (ou sobrou a cópia)');
  assert.ok(!/[^.\w]_mgc\./.test(s.replace(/_mgc: _cacaMgAmb\.estado\(\)/g, '')), 'sobrou leitura do estado antigo (_mgc) na AMB');
  console.log('ok — caça da Magalu em peça única: a AMB faz exatamente o que fazia (linhas, gravações, estado); estado por empresa');
  process.exit(0);
})();
