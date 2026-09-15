'use strict';
/* 15/09 — primeira fatia do passo 4 da Fase 3: as rotas de catálogo (buscar produto e
   indexação de EAN) viram registrador único. Escolhidas por MEDIÇÃO e por COESÃO: das 45
   rotas comuns aos três checkouts, 18 têm corpo idêntico, e estas três andam juntas — buscar
   produto usa o índice que as outras duas constroem e acompanham. Extrair rota solta de um
   grupo que se apoia seria a meia-porta que já aconteceu duas vezes hoje.
   O teste guarda o que a extração arrisca: dependência faltando derruba na criação (não na
   primeira chamada), o prefixo é por empresa (rota da AMB não pode atender caminho da GOOD)
   e nenhuma cópia volta pras pastas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/rotas-catalogo');

const deps = {
  prefixo: '/x', json: () => {}, blingGet: async () => ({}), ehAdmin: () => true,
  skuEanCache: {}, lerIndiceEan: () => ({}), salvarNoIndiceEan: () => {},
  getPossiveisGtins: () => [], produtoDetalhe: async () => ({}), primeiraImagem: () => null,
  locCache: {}, localizacaoDeProduto: () => null, indexarCatalogoCompleto: async () => {},
  getIdxStatus: () => ({}),
};

assert.throws(() => criar({}), /falta prefixo/);
for (const faltando of ['blingGet', 'lerIndiceEan', 'getIdxStatus']) {
  const parcial = Object.assign({}, deps); delete parcial[faltando];
  assert.throws(() => criar(parcial), new RegExp('falta ' + faltando),
    'dependência ausente tem que derrubar na CRIAÇÃO — descobrir na primeira chamada é descobrir em produção');
}

const handle = criar(deps);
assert.strictEqual(typeof handle, 'function');

/* o prefixo isola: a instância de uma empresa não pode atender o caminho de outra */
(async () => {
  const res = {};
  const fora = await handle({ headers: {} }, res, { pathname: '/y/indexar-status', searchParams: new URLSearchParams() }, 'GET');
  assert.strictEqual(fora, false, 'caminho de outra empresa não pode ser capturado');
})();

/* as três pastas não podem ter a cópia de volta, e a delegação tem que vir DEPOIS
   da guarda de sessão — Codex (P1): a lib não valida sessão sozinha (buscar-produto
   e indexar-status saem sem checagem nenhuma), então se a chamada vier antes da
   guarda essas rotas ficam abertas sem cookie. */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  assert.ok(/_rotasCatalogo/.test(s), arq + ': tem que delegar pra lib');
  for (const rota of ['buscar-produto', 'indexar-catalogo', 'indexar-status']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s),
      arq + ': a cópia de /' + rota + ' voltou pra pasta — é por aí que a divergência retorna');
  }
  const posGuarda = s.indexOf('GUARDA DE SESSÃO');
  const posDelega = s.indexOf('_rotasCatalogo(req, res, urlObj, method)');
  assert.ok(posGuarda !== -1, arq + ': guarda de sessão sumiu do módulo');
  assert.ok(posDelega > posGuarda,
    arq + ': _rotasCatalogo tem que ser chamado DEPOIS da guarda de sessão, senão buscar-produto e indexar-status ficam sem sessão');
}

console.log('OK: rotas de catálogo — uma lib para as três, dependência ausente derruba na criação e o prefixo isola cada empresa');
