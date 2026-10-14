'use strict';
/* 14/10 — a GOOD ganha o custo diário (a mesma peça da Girassol e da AMB, lib/checkout/custo-diario.js,
   que tem teste próprio). Aqui a prova é da LIGAÇÃO, por execução: monta o módulo da GOOD, chama a rota
   /custo-diario (com chave errada de propósito, pra não disparar a rotina) e exige a recusa de chave —
   antes a rota respondia que faltava a peça; confere que o orquestrador recebe rotina e cron com o
   mesmo nome; e que a vigência retroativa chega ao registro de custo, como na Girassol. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GOODBKP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-'));
process.env.ADMIN_KEY = 'chave-certa';
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('rede não era pra ser chamada'); } };

(async () => {
  const mod = require(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));
  /* chave CERTA, mas com a trava pesada do processo segura pelo teste: a rota passa por todas as
     checagens de peça e de chave e para no 409 "rotina pesada em curso" — sem disparar nada */
  const trava = require('../lib/checkout/trava-pesada');
  assert.ok(trava.tentarEntrar('teste-custo-diario-good'), 'não consegui segurar a trava pesada pro teste');
  const u = new URL('http://x/good-checkout-offline/custo-diario?k=chave-certa');
  const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  try { await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); } finally { trava.sair('teste-custo-diario-good'); }
  assert.ok(!/falta|semPeca|não expõe|nao expoe/i.test(res._b), 'a rota /custo-diario da GOOD ainda diz que falta a peça: ' + res._b.slice(0, 160));
  assert.strictEqual(res._s, 409, 'com a peça montada e a trava ocupada, a rota tem que recusar com 409 — veio ' + res._s + ' ' + res._b.slice(0, 160));
  assert.ok(/teste-custo-diario-good/.test(res._b), 'o 409 tem que nomear quem segura a trava: ' + res._b.slice(0, 160));
  for (const k of ['custoDiario', 'custoDiarioRecupera']) {
    assert.strictEqual(typeof (mod.rotinas || {})[k], 'function', 'rotina ' + k + ' não exportada');
    assert.ok(typeof (mod.crons || {})[k] === 'string' && mod.crons[k].trim().split(/\s+/).length === 5, 'cron ' + k + ' ausente ou inválido');
    try { const v = require('node-cron').validate; if (typeof v === 'function') assert.ok(v(mod.crons[k]), 'cron ' + k + ' recusado pelo node-cron'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/registrarCustoVigente\(_ctxCusto, sku, v, org, _vigenciaDeRef\.valor\)/.test(src), 'a vigência retroativa da madrugada não chega ao registro de custo da GOOD');
  assert.ok(/require\('\.\.\/lib\/checkout\/custo-diario'\)\.criar\(\{\s*empresa: 'good'/.test(src), 'o custo diário da GOOD tem que ser a peça compartilhada');
  console.log('ok — custo diário ligado na GOOD (rota responde, rotina e cron no orquestrador, vigência retroativa)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
