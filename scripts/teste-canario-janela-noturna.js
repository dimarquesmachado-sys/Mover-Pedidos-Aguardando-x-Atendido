'use strict';
/* 13/10 — a noturna confere 3 dias nos dias comuns e 30 no domingo (fuso de Sao Paulo).
   Exercita a funcao DE PRODUCAO e as duas noturnas que a usam. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { diasDaNoturna } = require('../lib/canario-marketplace');

const limpa = () => { delete process.env.CANARIO_DIAS_NOTURNA; delete process.env.CANARIO_DIAS_SEMANAL; };
limpa();
// 2026-10-11 e domingo. 03:30 em SP = 06:30 UTC.
const dom = Date.UTC(2026, 9, 11, 6, 30), seg = Date.UTC(2026, 9, 12, 6, 30);
assert.strictEqual(diasDaNoturna(dom), 30, 'domingo varre 30');
assert.strictEqual(diasDaNoturna(seg), 3, 'dia comum varre 3');
// fuso: domingo 23h em SP ja e segunda 02h em UTC — continua domingo
assert.strictEqual(diasDaNoturna(Date.UTC(2026, 9, 12, 2, 0)), 30, 'domingo 23h SP ainda e domingo');
// sabado 22h SP = domingo 01h UTC — ainda e sabado
assert.strictEqual(diasDaNoturna(Date.UTC(2026, 9, 11, 1, 0)), 3, 'sabado 22h SP nao e domingo');
// envs
process.env.CANARIO_DIAS_NOTURNA = '5'; process.env.CANARIO_DIAS_SEMANAL = '14';
assert.strictEqual(diasDaNoturna(seg), 5); assert.strictEqual(diasDaNoturna(dom), 14);
process.env.CANARIO_DIAS_NOTURNA = 'abc'; process.env.CANARIO_DIAS_SEMANAL = '-2';
assert.strictEqual(diasDaNoturna(seg), 3, 'env invalida volta ao padrao');
assert.strictEqual(diasDaNoturna(dom), 30, 'env invalida volta ao padrao');
process.env.CANARIO_DIAS_NOTURNA = '90'; process.env.CANARIO_DIAS_SEMANAL = '2';
assert.strictEqual(diasDaNoturna(seg), 30, 'teto de 30');
assert.strictEqual(diasDaNoturna(dom), 30, 'semanal nunca menor que o diario');
limpa();
assert.ok([3, 30].includes(diasDaNoturna()), 'sem argumento usa o relogio');
assert.strictEqual(diasDaNoturna('lixo') === 3 || diasDaNoturna('lixo') === 30, true);

// as duas noturnas chamam a regra (nenhuma ficou com o 3 cravado)
for (const f of ['girassol-backup-offline/noturna.js', 'amb-checkout-offline/amb-noturna.js']) {
  const s = require('./_fonte-noturna').fonteNoturna(f);
  assert.ok(/diasDaNoturna\(\)/.test(s), f + ' usa diasDaNoturna');
  assert.ok(!/conferirMarketplaces\(3\)/.test(s), f + ' sem o 3 cravado');
}
console.log('ok — canario: 3 dias toda noite, 30 no domingo (as duas noturnas)');
