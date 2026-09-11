'use strict';
/* Fatia 4 (11/09): irmãs do mesmo carrinho do ML. O formato real do banco de tarifas usa
   `o` (número da venda) e `p` (pack) — li no código antes de escrever o teste, depois de
   ter errado o palpite na primeira tentativa. */
const assert = require('assert');
const criar = require('../lib/checkout/packs-ml').criar;

const banco = { tarifas: {
  1: { o: 'V1', p: 'PK' },
  2: { o: 'V2', p: 'PK' },
  3: { o: 'V3', p: 'V3' },   // venda == pack: não é carrinho, tem que ser ignorada
  4: { o: 'V4' },            // sem pack: ignorada
} };
const api = criar({ MLB_FILE: () => '/tmp/mlb.json', readJson: () => banco });

const irmas = api._irmasDoPack('V1');
assert.ok(Array.isArray(irmas) || irmas instanceof Set || irmas, 'V1 tem irmãs');
const lista = Array.from(irmas || []);
assert.ok(lista.includes('V2'), 'V2 é irmã de V1 no mesmo carrinho — veio: ' + JSON.stringify(lista));

assert.strictEqual(api._irmasDoPack('V3'), null, 'venda igual ao pack não é carrinho');
assert.strictEqual(api._irmasDoPack('V4'), null, 'venda sem pack não tem irmãs');
assert.strictEqual(api._irmasDoPack('NAO-EXISTE'), null);

// o cache de 30 min é por instância: outra empresa = outra instância = outro cache
const api2 = criar({ MLB_FILE: () => '/tmp/outro.json', readJson: () => ({ tarifas: {} }) });
assert.strictEqual(api2._irmasDoPack('V1'), null, 'a segunda empresa não pode enxergar o cache da primeira');

assert.throws(() => criar({}), /falta a dependência/);
console.log('OK: packs do ML — irmãs do carrinho, venda==pack ignorada, sem pack ignorada, cache por empresa');
