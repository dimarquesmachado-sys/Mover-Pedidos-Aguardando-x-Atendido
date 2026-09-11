'use strict';
/* Fatia 3 (11/09): a sessão da Shopee sobrevive a deploy. A regra que não pode se perder na
   desduplicação: o cookie do DISCO ganha da env (senão todo deploy voltaria pra semente
   velha e o painel pararia), A MENOS que o dono cole semente NOVA na env — detectada por
   hash da própria env. O retorno é um objeto { cookie, semente, origem, ... }. */
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const criar = require('../lib/checkout/shopee-sessao').criar;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopee-sessao-'));
let disco = null;
const api = criar({
  CACHE_DIR: dir,
  readJson: (p, d) => (disco === null ? d : disco),
  writeJson: (p, o) => { disco = o; },
  ensureDir: () => {},
  SHOPEE_ENV_COOKIE: 'TESTE_COOKIE_ENV',
});
process.env.TESTE_COOKIE_ENV = 'cookie-da-env';

// 1) nada no disco → a env vale, e é GRAVADA (pra sobreviver ao próximo boot)
disco = null;
let s = api.shopeeSessaoLer();
assert.strictEqual(s.cookie, 'cookie-da-env');
assert.strictEqual(s.origem, 'env');
assert.ok(disco && disco.cookie === 'cookie-da-env', 'a semente da env tem que ser persistida');

// 2) disco com a MESMA semente → o disco ganha (o cookie renovado sobrevive ao deploy)
disco = { cookie: 'cookie-renovado-no-disco', semente: api._shopeeHash('cookie-da-env'), origem: 'disco' };
s = api.shopeeSessaoLer();
assert.strictEqual(s.cookie, 'cookie-renovado-no-disco', 'o disco tem que ganhar da env');

// 3) semente NOVA na env (hash diferente) → a env ganha do disco
disco = { cookie: 'cookie-velho-do-disco', semente: api._shopeeHash('SEMENTE-ANTIGA'), origem: 'disco' };
s = api.shopeeSessaoLer();
assert.strictEqual(s.cookie, 'cookie-da-env', 'semente nova colada na env tem prioridade');

// 4) sem env e sem disco → estado declarado, não exceção
delete process.env.TESTE_COOKIE_ENV; disco = null;
s = api.shopeeSessaoLer();
assert.strictEqual(s.origem, 'nenhum');

assert.throws(() => criar({}), /falta a dependência/);
console.log('OK: sessão Shopee — env persiste, disco ganha da env, semente nova ganha do disco, vazio é declarado');
