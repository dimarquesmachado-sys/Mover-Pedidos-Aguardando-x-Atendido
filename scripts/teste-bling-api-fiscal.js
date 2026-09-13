'use strict';
/* Passo 2.7 (13/09): o cliente da API do Bling virou peça única das três. Depois dos portes
   de hoje, o que separava as cópias era rótulo e nome de env. O que o teste guarda:
     • as três expõem o MESMO conjunto de funções (16) — nenhuma perdeu nada na extração;
     • as PAUSAS continuam por empresa: elas existem pra não estourar a cota do Bling, que é
       da CONTA e não do código; empresa que vende mais pode precisar de ritmo diferente, e
       igualar isso em silêncio é o caminho pra derrubar a operação de alguém;
     • nenhuma mensagem com empresa fixa no texto (a lição do #411: rótulo errado manda quem
       investiga olhar o CNPJ errado). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarBlingApi } = require('../lib/fiscal/bling-api');

assert.throws(() => criarBlingApi({}), /falta rotulo/);
assert.throws(() => criarBlingApi({ rotulo: 'X' }), /falta env/);

const base = Object.keys(require('../ambtotal/blingApi.js')).sort();
assert.ok(base.length >= 16, 'esperava ao menos 16 funções, achei ' + base.length);
for (const emp of ['good', 'girassol']) {
  assert.deepStrictEqual(Object.keys(require('../' + emp + '/blingApi.js')).sort(), base,
    emp + ' não expõe o mesmo conjunto de funções que a AMB');
}

const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p, 'blingApi.js'), 'utf8');
const fach = ['ambtotal', 'good', 'girassol'].map(fonte);

for (const campo of ['rotulo', 'envPausaMs', 'envGetPausaMs']) {
  const vals = fach.map(s => (new RegExp(campo + ": '([^']+)'").exec(s) || [])[1]);
  assert.ok(vals.every(Boolean), 'toda fachada declara ' + campo + ': ' + vals.join(', '));
  assert.strictEqual(new Set(vals).size, 3, campo + ' tem que ser por empresa (cota do Bling é da conta): ' + vals.join(', '));
}

const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'bling-api.js'), 'utf8');
const presos = lib.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .filter(l => /throw new Error|console\.(log|warn|error)/.test(l))
  .filter(l => /\b(AMB|AMBTOTAL|AMBTotal|GOOD|GIMPO|GIRASSOL|MAGAZINEGIRASSOL)\b/.test(l));
assert.deepStrictEqual(presos, [], 'mensagem com empresa fixa no texto: ' + presos.join(' | '));

console.log('OK: cliente Bling — as três com as mesmas ' + base.length + ' funções, pausas por empresa e nenhuma mensagem com empresa fixa');
