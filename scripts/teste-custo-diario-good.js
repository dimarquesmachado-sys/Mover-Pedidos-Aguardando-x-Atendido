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
  /* 16/11 (passo 5): o registro de custo vem da peça lib/checkout/custo-empresa, que liga a vigência retroativa (`_vigenciaDeRef.valor`) — a GOOD
     desestrutura os dois nomes dela; a peça em si é provada em scripts/teste-custo-empresa.js */
  assert.ok(/registrarCustoVigente:\s+\(sku, v, org\) => _custoLib\.registrarCustoVigente\(_ctxCusto, sku, v, org, _vigenciaDeRef\.valor\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'custo-empresa.js'), 'utf8')), 'a vigência retroativa da madrugada não chega ao registro de custo (peça custo-empresa)');
  /* 16/11 (passo 6): a vigência é lida e gravada pelas rotinas de custo da empresa (lib/checkout/rotinas-custo-empresa), no
     `_vigenciaDeRef` da peça de custo DESTA empresa — a GOOD entrega a peça dela às rotinas */
  const rot = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'rotinas-custo-empresa.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/custo-empresa'\)\.criar\(\{ empresa: 'good',/.test(src) && /get custoEmpresa\(\) \{ return _custoEmp; \}/.test(src)
    && /lerVigenciaDe: \(\) => CE\(\)\._vigenciaDeRef\.valor,/.test(rot) && /gravarVigenciaDe: \(v\) => \{ CE\(\)\._vigenciaDeRef\.valor = v; \},/.test(rot) && /registrarCustoVigente: \(\.\.\.a\) => CE\(\)\.registrarCustoVigente\(\.\.\.a\),/.test(rot), 'a GOOD tem que montar a peça do custo e usar o registro e a vigência dela');
  assert.ok(/require\('\.\.\/lib\/checkout\/rotinas-custo-empresa'\)\.criar\(\{\s*empresa: 'good'/.test(src) && /require\('\.\/custo-diario'\)\.criar\(\{\s*empresa,/.test(rot), 'o custo diário da GOOD tem que ser a peça compartilhada');
  console.log('ok — custo diário ligado na GOOD (rota responde, rotina e cron no orquestrador, vigência retroativa)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
