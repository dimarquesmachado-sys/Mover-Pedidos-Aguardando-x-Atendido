'use strict';
/* Passo 2.2 do plano multiloja (13/09): o cliente da API de NF do Bling virou código único.
   O que este teste guarda é o que a unificação mais arrisca perder — os valores que DEVEM
   continuar diferentes por empresa:
     • a pasta do cache de IE, separada de propósito (misturar Inscrição Estadual entre CNPJs
       é erro FISCAL, não desorganização);
     • o nome do intermediador que vai na NF-e (AMBTOTAL, GIMPO, MAGAZINEGIRASSOL);
     • o rótulo que identifica a empresa no log e na mensagem de erro — sem ele, investigar
       um erro de NF vira adivinhação de qual CNPJ falhou. */
const assert = require('assert');
const { criarNfBlingApi } = require('../lib/fiscal/nf-bling-api');

const base = {
  nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
  envPausa: 'X_NF_PAUSA_MS', envIntermediadorCnpj: 'X_CNPJ', envIntermediadorNome: 'X_NOME',
  intermediadorCnpj: '03007331000141', intermediadorNome: 'TESTE', pastaCacheIE: '/tmp/ie-teste',
};
assert.throws(() => criarNfBlingApi({}), /falta rotulo/);
assert.throws(() => criarNfBlingApi(Object.assign({ rotulo: 'X' }, base, { pastaCacheIE: null })), /falta pastaCacheIE/);

const api = criarNfBlingApi(Object.assign({ rotulo: 'X' }, base));
assert.deepStrictEqual(Object.keys(api).sort(), [
  'atualizarIEContato', 'enviarNF', 'getCidadePorCEP', 'getContato', 'getIEPorCNPJ',
  'getNFDetalhe', 'getNFsParaCorrigir', 'getNFsSituacaoConsulta', 'salvarNF', 'sleepNF',
]);

// as três fachadas mantêm o contrato e cada uma carrega os SEUS valores
const fs = require('fs');
const cfgDe = (pasta) => fs.readFileSync(require('path').join(__dirname, '..', pasta, 'nfBlingApi.js'), 'utf8');
const amb = cfgDe('ambtotal'), good = cfgDe('good'), gir = cfgDe('girassol');

assert.ok(/pastaCacheIE: '\/data\/ambtotal'/.test(amb), 'AMB tem que ter cache de IE próprio');
assert.ok(/pastaCacheIE: '\/data\/good'/.test(good), 'GOOD tem que ter cache de IE próprio');
assert.ok(/pastaCacheIE: '\/data\/girassol'/.test(gir), 'Girassol tem que ter cache de IE próprio');
const pastas = [amb, good, gir].map(s => /pastaCacheIE: '([^']+)'/.exec(s)[1]);
assert.strictEqual(new Set(pastas).size, 3, 'as três pastas de cache de IE precisam ser DIFERENTES: ' + pastas.join(', '));

assert.ok(/intermediadorNome: 'AMBTOTAL'/.test(amb));
assert.ok(/intermediadorNome: 'GIMPO'/.test(good), 'a GOOD emite como GIMPO — trocar isso sai na NF-e');
assert.ok(/intermediadorNome: 'MAGAZINEGIRASSOL'/.test(gir));

const rotulos = [amb, good, gir].map(s => /rotulo: '([^']+)'/.exec(s)[1]);
assert.strictEqual(new Set(rotulos).size, 3, 'cada empresa precisa de rótulo próprio no log: ' + rotulos.join(', '));

for (const pasta of ['ambtotal', 'good', 'girassol']) {
  const m = require('../' + pasta + '/nfBlingApi.js');
  assert.strictEqual(Object.keys(m).length, 10, 'a fachada de ' + pasta + ' mudou o que exporta');
}

console.log('OK: cliente de NF único — deps obrigatórias, contrato das 3 fachadas intacto, e cache de IE / intermediador / rótulo seguem DIFERENTES por empresa');
