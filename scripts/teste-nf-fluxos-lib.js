'use strict';
/* Fase 2 da auditoria multiloja, 1ª peça (13/09): o fluxo de correção de NF-e virou código
   único. O que este teste guarda:
     1. a fábrica exige as dependências (fluxo fiscal meio ligado é pior que desligado);
     2. as TRÊS fachadas exportam exatamente as mesmas funções de antes — a migração não
        pode mudar o que as pastas entregam, senão quebra require() espalhado;
     3. o cooldown de cada empresa lê a env DELA — era a única diferença entre as cópias, e
        trocar isso entre empresas faria uma esperar o tempo da outra pra reenviar à SEFAZ. */
const assert = require('assert');
const { criarFluxoNF } = require('../lib/fiscal/nf-fluxos');

const fake = {
  nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
  nfBlingApi: {
    sleepNF: async () => {}, getNFsParaCorrigir: async () => [], getNFDetalhe: async () => null,
    salvarNF: async () => {}, enviarNF: async () => {}, getContato: async () => null,
    atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null,
  },
};

assert.throws(() => criarFluxoNF({}), /falta nfTokenManager/);
assert.throws(() => criarFluxoNF(Object.assign({}, fake)), /falta envCooldown/);

const api = criarFluxoNF(Object.assign({ envCooldown: 'AMB_NF_COOLDOWN_MIN' }, fake));
assert.deepStrictEqual(Object.keys(api).sort(), ['corrigirNFsPendentes', 'getEstadoRetrySEFAZ', 'retryNFManual']);

// as três fachadas seguem entregando o mesmo contrato
for (const pasta of ['ambtotal', 'good', 'girassol']) {
  const m = require('../' + pasta + '/nfFluxos.js');
  assert.deepStrictEqual(Object.keys(m).sort(), ['corrigirNFsPendentes', 'getEstadoRetrySEFAZ', 'retryNFManual'],
    'a fachada de ' + pasta + ' mudou o que exporta');
}

// cada empresa lê a PRÓPRIA env de cooldown
process.env.AMB_NF_COOLDOWN_MIN = '7';
process.env.GOOD_NF_COOLDOWN_MIN = '19';
const lido = (env) => {
  delete require.cache[require.resolve('../lib/fiscal/nf-fluxos')];
  const { criarFluxoNF: cria } = require('../lib/fiscal/nf-fluxos');
  const inst = cria(Object.assign({ envCooldown: env }, fake));
  return inst.getEstadoRetrySEFAZ();
};
const amb = lido('AMB_NF_COOLDOWN_MIN');
const good = lido('GOOD_NF_COOLDOWN_MIN');
assert.strictEqual(amb.cooldown_min, 7, 'a AMB tem que ler AMB_NF_COOLDOWN_MIN');
assert.strictEqual(good.cooldown_min, 19, 'a GOOD tem que ler GOOD_NF_COOLDOWN_MIN');
assert.strictEqual(amb.env_cooldown, 'AMB_NF_COOLDOWN_MIN', 'o estado declara qual env foi usada');

console.log('OK: fluxo de NF único — exige deps, as 3 fachadas mantêm o contrato e cada empresa usa a própria env de cooldown');
