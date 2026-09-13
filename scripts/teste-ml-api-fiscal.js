'use strict';
/* Passo 2.5 (13/09), versão UNIÃO. O dono cravou o critério ao ver a primeira medição:
   "uma tem, outra não; agora ambas têm". Então este teste deixou de guardar a SEPARAÇÃO
   (que era o estado provisório de algumas horas atrás) e passa a guardar o contrário:
     • as TRÊS empresas expõem o mesmo conjunto de funções — nenhuma fica sem capacidade
       que outra tem, que era a dívida silenciosa entre elas;
     • cada uma mantém o próprio rótulo no log, senão erro do ML não diz de qual CNPJ é.
   Teste que guarda decisão velha é pior que teste nenhum: ele impede a decisão nova. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarMlApi } = require('../lib/fiscal/ml-api');

const UNIAO = ['baixarXmlNFe', 'enviarNFeParaML', 'getShipmentInfo', 'getShipmentRaw', 'getShipmentSubstatus'];

assert.throws(() => criarMlApi({}), /falta rotulo/);
assert.deepStrictEqual(Object.keys(criarMlApi({ rotulo: 'X' })).sort(), UNIAO);

for (const emp of ['ambtotal', 'good', 'girassol']) {
  const m = require('../' + emp + '/mlApi.js');
  assert.deepStrictEqual(Object.keys(m).sort(), UNIAO, emp + ' não tem a união das funções');
}

/* getShipmentRaw veio da Girassol; baixarXmlNFe existia nas três mas ela não exportava.
   Os dois casos são a mesma dívida vista de lados opostos. */
for (const emp of ['ambtotal', 'good', 'girassol']) {
  const m = require('../' + emp + '/mlApi.js');
  assert.strictEqual(typeof m.getShipmentRaw, 'function', emp + ' precisa do getShipmentRaw (veio da Girassol)');
  assert.strictEqual(typeof m.baixarXmlNFe, 'function', emp + ' precisa exportar baixarXmlNFe');
}

const rot = ['ambtotal', 'good', 'girassol'].map(p =>
  (/rotulo: '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', p, 'mlApi.js'), 'utf8')) || [])[1]);
assert.ok(rot.every(Boolean), 'toda fachada declara rótulo: ' + rot.join(', '));
assert.strictEqual(new Set(rot).size, 3, 'os rótulos têm que ser distintos: ' + rot.join(', '));

console.log('OK: cliente ML fiscal — as TRÊS empresas com a união das funções e rótulo próprio');
