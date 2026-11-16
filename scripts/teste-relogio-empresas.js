'use strict';
/* 16/11 — O RELÓGIO DAS TRÊS É O MESMO (lib/checkout/agendador; docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 7).

   A GOOD agendava à mão o próprio relógio (70 linhas) e o custo diário dela ia por dois crons do orquestrador; a Girassol e a
   AMB usavam o agendador, mas retomavam o plano do ano no CARREGAMENTO do arquivo, e só a GOOD se preparava sozinha. Prova,
   pelos módulos REAIS (rede bloqueada; o agendador verdadeiro, só observado):
     1) as três montam o agendador com a empresa, o minuto do custo diário DELA (23h15 Girassol, 23h00 AMB, 23h30 GOOD) e o
        plano do ano DELA (a peça backfill-plano-empresa: `existe` olha a pasta dela, `criarPlano` grava lá);
     2) cada rotina entregue chama a da empresa (custo diário, custo travado, venda do dia, cancelados, faturamento, pesca,
        ciclo) — sem nada à mão;
     3) carregar o arquivo NÃO agenda nada (o plano é retomado pelo bootstrap, que só roda com a empresa ativa);
     4) a GOOD não tem mais o custo diário nos crons do orquestrador (o relógio já agenda; os dois rodariam em dobro). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => bloqueado() };
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-relogio';

/* o agendador verdadeiro, observado */
const rA = require.resolve('../lib/checkout/agendador');
const real = require('../lib/checkout/agendador');
const vistos = {};
require.cache[rA] = { id: rA, filename: rA, loaded: true, exports: Object.assign({}, real, { criarAgendador: (cfg) => { vistos[cfg.empresa] = cfg; return real.criarAgendador(cfg); } }) };

/* 3) carregar o arquivo não agenda nada: conto os timers de 3 min criados durante o require */
const _st = global.setTimeout; const longos = [];
global.setTimeout = function (fn, ms, ...r) { if (ms === 3 * 60000) longos.push(new Error().stack.split('\n').slice(2, 4).join(' | ')); return _st.call(this, fn, ms, ...r); };

const EMP = [['girassol', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR', 15], ['amb', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR', 0], ['good', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR', 30]];
const mods = {};
const _log = console.log, _warn = console.warn, _err = console.error;
console.log = () => {}; console.warn = () => {}; console.error = () => {};
try {
  for (const [emp, arq, envDir] of EMP) {
    process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-' + emp + '-'));
    mods[emp] = require(path.join(raiz, arq));
  }
} finally { console.log = _log; console.warn = _warn; console.error = _err; global.setTimeout = _st; }
assert.deepStrictEqual(longos, [], 'carregar o arquivo agendou a retomada do plano (tem que ser só no bootstrap): ' + longos.join(' || '));

(async () => {
  for (const [emp, arq, envDir, minuto] of EMP) {
    const cfg = vistos[emp];
    /* 1) */
    assert.ok(cfg, emp + ': não montou o agendador');
    assert.strictEqual(typeof mods[emp].bootstrap, 'function', emp + ': o bootstrap exportado tem que ser o do agendador');
    assert.strictEqual(cfg.minutoCustoDiario, minuto, emp + ': o minuto do custo diário');
    const dir = process.env[envDir];
    assert.strictEqual(cfg.plano.existe(), false, emp + ': pasta vazia, plano não existe');
    const pl = cfg.plano.criarPlano('2026-01-01', '2026-01-20', 10);
    assert.ok(pl && pl.fatias && pl.fatias.length === 2, emp + ': o plano criado');
    assert.strictEqual(cfg.plano.existe(), true, emp + ': o plano é gravado na pasta DELA');
    assert.ok(fs.readdirSync(dir).some((n) => /plano|fatia|backfill/i.test(n)), emp + ': o plano tem que estar na pasta da empresa: ' + fs.readdirSync(dir).join(','));
    try { cfg.plano.motor.estado(); } catch (e) { assert.fail(emp + ': o motor do plano é o da peça: ' + e.message); }
    /* 2) cada rotina entregue é função */
    for (const n of ['mlSyncFees', 'custoSync', 'custoDiario', 'varrerCancelados', 'mlBillingSync', 'vendasSync', 'rodarCiclo', 'getUltimoResumo', 'aoIniciar']) assert.strictEqual(typeof cfg[n], 'function', emp + ': ' + n);
    const src = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const k = src.indexOf("const bootstrap = require('../lib/checkout/agendador').criarAgendador({"), b = src.slice(k, src.indexOf('\n});', k));
    assert.ok(k > 0 && /custoSync: \(\.\.\.a\) => custoSyncTravado\(\.\.\.a\),/.test(b) && /custoDiario: \(\.\.\.a\) => custoDiario\(\.\.\.a\),/.test(b) && /vendasSync: \(\.\.\.a\) => vendasSync\(\.\.\.a\),/.test(b) && /varrerCancelados: \(\.\.\.a\) => varrerCancelados\(\.\.\.a\),/.test(b), emp + ': o relógio chama as rotinas DELA (o custo pela trava do processo)');
    assert.ok(!/function bootstrap\(/.test(src) && !/retomarNoBoot\(\)/.test(src) && !/prepararSozinha\(/.test(src), emp + ': sobrou relógio à mão');
  }
  /* 4) */
  assert.ok(!mods.good.crons.custoDiario && !mods.good.crons.custoDiarioRecupera, 'a GOOD ainda agenda o custo diário pelo orquestrador (em dobro com o relógio)');
  for (const emp of ['girassol', 'amb', 'good']) assert.ok(mods[emp].crons.noturna && mods[emp].crons.mlSyncFees && mods[emp].crons.backupCache, emp + ': os crons de sempre continuam');
  console.log('ok — o relógio das três é o agendador: o minuto do custo diário e o plano do ano de cada uma; nada agendado no carregamento; a GOOD sem o custo diário em dobro');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
