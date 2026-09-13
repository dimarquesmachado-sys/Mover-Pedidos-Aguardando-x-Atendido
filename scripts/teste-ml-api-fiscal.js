'use strict';
/* Passo 2.5 (13/09): o cliente ML fiscal de AMB e GOOD virou peça única — elas diferiam por
   UM comentário. A Girassol ficou de fora de propósito, e este teste guarda os dois lados:
     • AMB e GOOD mantêm exatamente as 4 funções de antes e cada uma com o próprio rótulo
       (sem ele, erro do ML não diz de qual CNPJ é);
     • a Girassol continua INTACTA, com as funções dela — inclusive a que as outras não têm.
   O teste falha se alguém unificar a Girassol sem decisão, que é o risco real aqui. */
const assert = require('assert');
const { criarMlApi } = require('../lib/fiscal/ml-api');

assert.throws(() => criarMlApi({}), /falta rotulo/);
const api = criarMlApi({ rotulo: 'X' });
assert.deepStrictEqual(Object.keys(api).sort(), ['baixarXmlNFe', 'enviarNFeParaML', 'getShipmentInfo', 'getShipmentSubstatus']);

const amb = require('../ambtotal/mlApi.js');
const good = require('../good/mlApi.js');
const gir = require('../girassol/mlApi.js');

assert.deepStrictEqual(Object.keys(amb).sort(), Object.keys(good).sort(), 'as gêmeas têm que seguir idênticas');

/* a Girassol tem getShipmentRaw (as outras não) e NÃO tem baixarXmlNFe (as outras têm) —
   cada lado tem uma função que falta no outro. Está documentado em
   docs/fase2-diferencas-girassol.md e é decisão do dono, não de refatoração. */
assert.ok(typeof gir.getShipmentRaw === 'function', 'a Girassol tem getShipmentRaw — não pode sumir numa unificação');
assert.ok(typeof amb.getShipmentRaw === 'undefined', 'se a AMB ganhou getShipmentRaw, foi decisão? então atualize o documento');
assert.ok(typeof amb.baixarXmlNFe === 'function', 'AMB/GOOD têm baixarXmlNFe');
assert.ok(typeof gir.baixarXmlNFe === 'undefined', 'se a Girassol ganhou baixarXmlNFe, foi decisão? então atualize o documento');

const fs = require('fs'); const path = require('path');
const rot = ['ambtotal', 'good'].map(p => (/rotulo: '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', p, 'mlApi.js'), 'utf8')) || [])[1]);
assert.strictEqual(new Set(rot).size, 2, 'AMB e GOOD precisam de rótulos distintos no log: ' + rot.join(', '));

console.log('OK: cliente ML fiscal — gêmeas unificadas com rótulo próprio, e a Girassol intacta com as funções que só ela tem');
