'use strict';
/* Trava a fatia extraída em 11/09: os números do frete Magalu não podem mudar com a
   desduplicação. Os valores esperados foram colhidos do código ANTIGO (antes da extração),
   rodando os mesmos três casos — se alguém mexer na tabela sem querer, isto acusa. */
const assert = require('assert');
const api = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR: '/tmp/teste-magalu-frete', readJson: (p, d) => d, writeJson: () => {},
  blingGet: async () => ({}), resolverProdutoPorSku: async () => null,
});

const casos = [
  [{ largura: 20, altura: 20, profundidade: 20 }, 1, 21.45],
  [{ largura: 60, altura: 40, profundidade: 30 }, 8, 49.45],
  [{ largura: 100, altura: 80, profundidade: 60 }, 25, 114.95],
];
for (const [dim, peso, esperado] of casos) {
  const v = api.magaluFreteTabela(dim, peso);
  assert.strictEqual(v, esperado, `frete de ${JSON.stringify(dim)} peso ${peso}: esperava ${esperado}, veio ${v}`);
}
assert.ok(Array.isArray(api.MAGALU_FRETE_TABELA) && api.MAGALU_FRETE_TABELA.length, 'a tabela precisa estar exposta');
assert.throws(() => require('../lib/checkout/magalu-frete').criar({}), /falta a dependência/, 'sem deps tem que falhar alto, não em silêncio');
console.log('OK: frete Magalu — 3 faixas com os MESMOS números de antes da extração, e a fábrica exige suas dependências');
