'use strict';
/* 22/10 — a OLIST (encerrada por volta de abr/mai-2026) era uma regra escrita à mão nos dois backfills: pedido da loja
   203301094 (a da Olist no Bling da GIRASSOL) ou com nº começando em "ORD" → canal Olist, 22% de taxa e R$ 12 de frete
   (o Bling não guarda nenhum dos dois). O dono: só a Girassol e a GOOD venderam pela Olist; a AMB e empresa nova não.
   Prova: a configuração única diz quem tem Olist (e com que taxa/frete); os dois backfills leem dela e não sobra a regra
   escrita à mão (22%, R$ 12, a loja da Girassol) — sem isso, empresa sem Olist veria 22% inventados num "ORD" qualquer. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { configCheckout } = require('../lib/checkout/config-empresa');

assert.deepStrictEqual(configCheckout('girassol').olist, { taxaPct: 22, freteReais: 12, lojaBling: '203301094' }, 'Girassol: Olist errada');
assert.deepStrictEqual(configCheckout('good').olist, { taxaPct: 22, freteReais: 12, lojaBling: null }, 'GOOD: Olist errada');
assert.strictEqual(configCheckout('amb').olist, null, 'a AMB nunca vendeu pela Olist');
const fonteCfg = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'config-empresa.js'), 'utf8');
assert.ok(/\n\s*olist: h\.olist \|\| null,/.test(fonteCfg), 'empresa nova tem que nascer SEM Olist');

/* 29/10 (3b-2): a AMB roda o backfill COMPARTILHADO — que lê a Olist da configuração DA EMPRESA (configCheckout(empresa)) */
assert.ok(fs.readFileSync(path.join(raiz, 'amb-checkout-offline/index.js'), 'utf8').includes("require('../girassol-backup-offline/gbo-app').backfillVendas(de, ate, 'amb', _ctxBackfillAmb())"), 'amb: não roda o backfill compartilhado');
for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', "configCheckout(empresa || 'girassol').olist"]]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(s.includes(emp), arq + ': o backfill não lê a Olist da configuração');
  const iB = s.indexOf('async function backfillVendas(');
  const corpo = s.slice(iB, s.indexOf('\n}\n', iB));
  assert.ok(!/ljId === '203301094'/.test(corpo), arq + ': sobrou a loja da Olist da Girassol escrita à mão');
  assert.ok(!/somaProd \* 22 \/ 100/.test(corpo) && !/frete = 12;/.test(corpo), arq + ': sobrou a taxa/frete da Olist escritos à mão');
  assert.ok(/const ehOlist = !!_olistCfg\w* && \(/.test(corpo), arq + ': sem Olist configurada, o "ORD" ainda viraria Olist');
}
console.log('ok — Olist por empresa: Girassol e GOOD (22% e R$ 12), AMB e empresa nova sem; os dois backfills leem da configuração');
