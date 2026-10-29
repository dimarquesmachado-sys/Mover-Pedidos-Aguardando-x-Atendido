'use strict';
/* 19/10 — faturamento do ML + créditos do Flex viraram PEÇA ÚNICA (lib/checkout/ml-billing), nascida das funções da AMB.
   Prova, rodando as funções ORIGINAIS (guardadas em scripts/fixtures) e a PEÇA no MESMO cenário de mentira (API de
   faturamento do ML com 2 páginas, Supabase, arquivos), com o relógio das esperas encurtado:
   · AMB: chamadas ao ML e ao Supabase, arquivos gravados e o estado final (_mlb, _mlcred) IGUAIS;
   · Girassol: o faturamento igual, e ela GANHA a distribuição dos créditos do Flex (só a AMB tinha);
   · GOOD: ganha os dois (o painel deixa de responder semPeca);
   · o estado é o MESMO objeto do começo ao fim (a cópia trocava o objeto e a fábrica do painel lia o velho). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarMlBillingDaEmpresa } = require('../lib/checkout/ml-billing');
const { _mlbCategoria, _mlbAssuntoDoCredito } = require('../lib/checkout/ml-tarifa-categoria');

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const limpa = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x).replace(ISO, '<ts>'));
const hoje = new Date().toISOString().slice(0, 10);

function ambiente() {
  const log = [], disco = {};
  disco['/c/conferidos.json'] = { c1: { numero: 1, numero_loja: '2000000000000001', ml_order: '2000000000000001' } };
  disco['/c/_vendas_dia.json'] = { v1: { numero_loja: '2000000000000001', credito_ml: 0 } };
  const resp = (ok, corpo, st) => ({ ok, status: st || (ok ? 200 : 404), text: async () => JSON.stringify(corpo), json: async () => corpo });
  const fetch = async (u) => {
    const s = String(u); log.push(['ml', s.replace('https://api.mercadolibre.com', '')]);
    if (/monthly\/periods/.test(s)) return resp(true, { results: [{ key: hoje.slice(0, 8) + '01' }] });
    if (/details/.test(s)) {
      if (/from_id=0$/.test(s)) return resp(true, { results: [
        { charge_info: { detail_id: 11, detail_amount: 9.5, transaction_detail: 'Tarifa de venda', detail_type: 'CHARGE' }, sales_info: { order_id: '2000000000000001', sale_date_time: hoje + 'T10:00:00' } },
        { charge_info: { detail_id: 12, detail_amount: 7, transaction_detail: 'Bonificação por envio Flex', detail_type: 'BONUS' }, sales_info: { order_id: '2000000000000001', sale_date_time: hoje + 'T10:00:00' } },
        { charge_info: { detail_id: 13, detail_amount: 30, transaction_detail: 'Campanha de publicidade', detail_type: 'CHARGE', debited_from_operation: 'NO' }, sales_info: { sale_date_time: hoje + 'T11:00:00' } },
      ], last_id: 13 });
      return resp(true, { results: [] });
    }
    return resp(false, null);
  };
  const supaReq = async (e, m, pq, body) => { log.push(['supa', e, m, pq, body ? JSON.stringify(body) : null]);
    if (m === 'GET') return { ok: true, status: 200, body: JSON.stringify([{ id: 77, credito_ml: null }]) };
    return { ok: true, status: 204, body: '' }; };
  const d = { CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conferidos.json', path, fetch, supaReq,
    readJson: (p, def) => (p in disco ? JSON.parse(JSON.stringify(disco[p])) : def),
    writeJson: (p, v) => { log.push(['grava', p]); disco[p] = JSON.parse(JSON.stringify(v)); return true; } };
  const tkML = { garantirTokenML: async () => 'tk' };
  return { log, disco, d, tkML };
}
const espera = () => new Promise(r => setImmediate(r));
async function comRelogioCurto(fn) {
  const st = global.setTimeout; global.setTimeout = (f) => setImmediate(f);
  try { return await fn(); } finally { global.setTimeout = st; }
}
async function aguardarFlex(estado) { for (let i = 0; i < 200 && estado().rodando; i++) await espera(); for (let i = 0; i < 20; i++) await espera(); }

function original(arquivo, amb, tokenMod) {
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', arquivo), 'utf8');
  const nomes = Object.keys(amb.d);
  const req = (m) => (m === tokenMod ? amb.tkML : require(m));
  const temFlex = src.includes('async function aplicarCreditosFlex');
  return new Function(...nomes, '_mlbCategoria', '_mlbAssuntoDoCredito', 'require',
    'const MLB_FILE = () => path.join(CACHE_DIR, \'_ml_billing.json\');\n' + (temFlex ? '' : 'async function aplicarCreditosFlex() {}\n') + src +
    '\nreturn { mlBillingSync, aplicarCreditosFlex: ' + (temFlex ? 'aplicarCreditosFlex' : 'null') + ', mlb: () => _mlb, mlcred: () => ' + (temFlex ? '_mlcred' : 'null') + ' };')(
    ...nomes.map(n => amb.d[n]), _mlbCategoria, _mlbAssuntoDoCredito, req);
}

(async () => {
  // AMB: original x peça
  const a1 = ambiente(), o = original('ml-billing-amb-antes.txt', a1, '../ambtotal/mlTokenManager');
  await comRelogioCurto(async () => { await o.mlBillingSync(3); await aguardarFlex(o.mlcred); });
  const a2 = ambiente(), p = criarMlBillingDaEmpresa('amb', { deps: () => a2.d, mlTokenManager: () => a2.tkML });
  const objMlb = p._mlb, objCred = p._mlcred;
  await comRelogioCurto(async () => { await p.mlBillingSync(3); await aguardarFlex(() => p._mlcred); });
  assert.ok(a1.log.length > 6 && a1.log.some(l => l[0] === 'supa' && l[2] === 'PATCH'), 'o cenário não exercitou o faturamento e os créditos');
  assert.deepStrictEqual(a2.log, a1.log, 'AMB: as chamadas ao ML/Supabase ou as gravações mudaram');
  assert.deepStrictEqual(limpa(a2.disco), limpa(a1.disco), 'AMB: o que foi gravado mudou');
  assert.deepStrictEqual(limpa(p._mlb), limpa(o.mlb()), 'AMB: o estado do faturamento mudou');
  assert.deepStrictEqual(limpa(p._mlcred), limpa(o.mlcred()), 'AMB: o estado dos créditos mudou');
  assert.ok(p._mlb === objMlb && p._mlcred === objCred, 'o estado foi trocado por outro objeto (a fábrica do painel leria o velho)');

  // Girassol: faturamento igual + GANHA os créditos do Flex
  const g1 = ambiente(), og = original('ml-billing-girassol-antes.txt', g1, '../girassol/mlTokenManager');
  await comRelogioCurto(async () => { await og.mlBillingSync(3); });
  const g2 = ambiente(), pg = criarMlBillingDaEmpresa('girassol', { deps: () => g2.d, mlTokenManager: () => g2.tkML });
  await comRelogioCurto(async () => { await pg.mlBillingSync(3); await aguardarFlex(() => pg._mlcred); });
  assert.deepStrictEqual(g2.log.filter(l => l[0] === 'ml'), g1.log.filter(l => l[0] === 'ml'), 'Girassol: as chamadas ao ML mudaram');
  assert.deepStrictEqual(limpa(g2.disco['/c/_ml_billing.json']), limpa(g1.disco['/c/_ml_billing.json']), 'Girassol: o faturamento gravado mudou');
  assert.ok(!g1.log.some(l => l[0] === 'supa'), 'a Girassol de antes não tinha os créditos do Flex (a referência mudou?)');
  assert.ok(g2.log.some(l => l[0] === 'supa' && l[1] === 'girassol' && l[2] === 'PATCH' && /vendas_historico\?id=eq\.77/.test(l[3])), 'Girassol: não ganhou a distribuição dos créditos do Flex (no Supabase DELA)');
  assert.ok(g2.log.some(l => l[0] === 'supa' && /empresa=eq\.girassol&/.test(l[3])), 'Girassol: os créditos consultaram o histórico de outra empresa');

  // GOOD: ganha os dois, no Supabase dela
  const d2 = ambiente(), pd = criarMlBillingDaEmpresa('good', { deps: () => d2.d, mlTokenManager: () => d2.tkML });
  await comRelogioCurto(async () => { await pd.mlBillingSync(3); await aguardarFlex(() => pd._mlcred); });
  assert.ok(d2.disco['/c/_ml_billing.json'] && Object.keys(d2.disco['/c/_ml_billing.json'].tarifas).length === 3, 'GOOD: o faturamento não gravou');
  assert.ok(d2.log.some(l => l[0] === 'supa' && l[1] === 'good' && /empresa=eq\.good&/.test(l[3])), 'GOOD: os créditos do Flex não foram pro Supabase da GOOD');

  // ligação nas três: sem cópia sobrando; GOOD entrega as peças à fábrica
  for (const [arq, emp] of [['amb-checkout-offline/index.js', 'amb'], ['girassol-backup-offline/gbo-app.js', 'girassol'], ['good-checkout-offline/index.js', 'good']]) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(src.includes("require('../lib/checkout/ml-billing').criarMlBillingDaEmpresa('" + emp + "', {"), arq + ': não usa a peça');
    assert.ok(!/\nlet _mlb = \{/.test(src) && !/\nlet _mlcred = \{/.test(src) && !/\nasync function mlBillingSync\(maxPeriodos\) \{/.test(src) && !/\nasync function aplicarCreditosFlex\(de, ate\) \{/.test(src), arq + ': sobrou cópia do faturamento do ML');
  }
  const gsrc = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/_mlb: _mlBillingGood\._mlb, _mlcred: _mlBillingGood\._mlcred, mlBillingSync: /.test(gsrc), 'GOOD: a fábrica do painel não recebe o faturamento do ML');
  assert.ok(/setInterval\(\(\) => \{ try \{ mlBillingSync\(3\)\.catch\(\(\) => \{\}\); \} catch \(e\) \{\} \}, 24 \* 3600 \* 1000\);/.test(gsrc), 'GOOD: o faturamento não está agendado 1x/dia');
  /* Codex #720 (P1 ×2): (a) o backfill da GOOD recebe os MAPAS do faturamento (eram null) — a peça monta pelo cache DA
     EMPRESA; (b) o backfill compartilhado (Girassol e GOOD) redistribui os créditos do Flex depois da troca, como a AMB */
  { const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-mapa-'));
    fs.writeFileSync(path.join(dir, '_ml_billing.json'), JSON.stringify({ tarifas: {
      '1': { d: hoje, v: 9.5, c: 'comissao', o: '2000000000000001', t: 'Tarifa de venda' },
      '2': { d: hoje, v: 15, c: 'frete', o: '2000000000000001', t: 'Tarifa de envio' } }, porDia: {}, atualizado: new Date().toISOString() }));
    const pm = criarMlBillingDaEmpresa('good', { deps: () => ({ CACHE_DIR: dir, path }) });
    const mp = await pm.mapasBilling();
    assert.ok(Object.keys(mp.com).length > 0 || Object.keys(mp.fre).length > 0, 'GOOD: os mapas do faturamento vieram vazios com o cache cheio: ' + JSON.stringify(mp).slice(0, 200));
    fs.rmSync(dir, { recursive: true, force: true }); }
  { const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    const iC = gs.indexOf('function _ctxBackfillGood()'); const ctxG = gs.slice(iC, gs.indexOf('\n}\n', iC));
    assert.ok(/mapasBilling: \(\) => _mlBillingGood\.mapasBilling\(\),/.test(ctxG) && !/mapasBilling: null/.test(ctxG), 'GOOD: o backfill continua sem os mapas do faturamento');
    assert.ok(/creditosFlex: \(de, ate\) => _mlBillingGood\.aplicarCreditosFlexNaFila\(de, ate\),/.test(ctxG), 'GOOD: o backfill não redistribui os créditos do Flex');
    const gb = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
    /* 29/10: depois dos créditos do Flex pode vir outra dependência (a caça da Magalu) — o que importa é a ligação existir */
    assert.ok(/creditosFlex: \(de2, ate2\) => _mlBilling\.aplicarCreditosFlexNaFila\(de2, ate2\)(,| \}, 'girassol'\);)/.test(gb), 'Girassol: o backfill dela não redistribui os créditos do Flex');
    assert.ok(/if \(\(_backfill\.fase === 'concluido' \|\| _backfill\.fase === 'concluido_com_erros'\) && typeof _D\.creditosFlex === 'function'\) \{\s*\n\s*try \{ const _rc = _D\.creditosFlex\(de, ate\);/.test(gb), 'o backfill compartilhado não chama a redistribuição depois da troca');
    assert.ok(require('../lib/checkout/backfill-deps').NOMES.includes('creditosFlex'), 'a dependência creditosFlex não existe no resolvedor');
    for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js']) assert.ok(/async function _mapasBilling\(\) \{ return _mlBilling\.mapasBilling\(\); \}/.test(fs.readFileSync(path.join(raiz, arq), 'utf8')), arq + ': os mapas do faturamento não vêm da peça'); }
  console.log('ok — faturamento do ML + créditos do Flex: peça única — AMB idêntica, Girassol ganha os créditos, GOOD ganha os dois; estado nunca trocado');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
