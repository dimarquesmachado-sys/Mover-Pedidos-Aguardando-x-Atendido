'use strict';
/* Fatia 2 (11/09): a regra que veio do caso caro do 10xE14 — cadastro EXCLUÍDO nunca vale.
   Exercita a lib de produção; o cache do sku-info entra por acessores, como no checkout. */
const assert = require('assert');
const criar = require('../lib/checkout/produto-ativo').criar;

let cacheHost = {};
const api = criar({
  CACHE_DIR: '/tmp/teste-produto-ativo', readJson: (p, d) => d, writeJson: () => {},
  lerSkuInfoCache: () => cacheHost, gravarSkuInfoCache: (v) => { cacheHost = v; },
});

assert.strictEqual(api._prodExcluido({ situacao: 'E' }), true);
assert.strictEqual(api._prodExcluido({ situacao: 'Excluido' }), true);
assert.strictEqual(api._prodExcluido({ situacao: 'A' }), false);
assert.strictEqual(api._prodAtivo({ situacao: 'A' }), true);

// o caso real: dois cadastros do mesmo SKU, um excluído (composição de 6) e um ativo (kit de 10)
const escolhido = api.escolherProdutoAtivo(
  [{ id: 1, situacao: 'E', codigo: '10xE14' }, { id: 2, situacao: 'A', codigo: '10xE14' }],
  '10xE14', {}, null);
assert.ok(escolhido && escolhido.id === 2, 'tem que escolher o ATIVO, nunca o excluído');

// só excluídos: não devolve nenhum (custo de cadastro apagado é o bug que originou a regra)
const soExcluido = api.escolherProdutoAtivo([{ id: 1, situacao: 'E', codigo: 'X' }], 'X', {}, null);
assert.ok(!soExcluido, 'com só cadastro excluído, não pode devolver produto');

// o cache do sku-info é o do HOST (se a lib tivesse o próprio, este teste veria {} aqui)
cacheHost = { ABC: { saldo: 1 } };
api._limparSkuInfo('ABC');
assert.deepStrictEqual(cacheHost, {}, 'limpar tem que mexer no cache do host, não numa cópia');

assert.throws(() => criar({}), /falta a dependência/);
console.log('OK: produto ativo — excluído nunca escolhido, só-excluído devolve vazio, cache do host compartilhado');
