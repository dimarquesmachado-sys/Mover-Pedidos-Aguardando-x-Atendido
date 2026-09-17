'use strict';
/* 17/09 — PORTE achado ao classificar a `/sku-info`. A AMB e a Girassol pedem 10 cadastros ao
   Bling e escolhem o ATIVO (`escolherProdutoAtivo`, conserto de 19/08); a GOOD pedia
   `limite=1` e ficava com o PRIMEIRO que viesse.

   Se um SKU tem cadastro antigo EXCLUÍDO no Bling, a GOOD lia o custo dele. E custo errado
   vira MARGEM ERRADA no dashboard — que é pior que margem ausente, porque ninguém desconfia
   de um número plausível. Eram DOIS pontos, não um: o /sku-info e a rotina irmã.

   Este teste exercita a função de produção com listas reais e exige que nenhuma empresa volte
   a pegar o primeiro da lista. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1. A FUNÇÃO em si: com excluído na frente, tem que devolver o vivo */
{
  const { criar } = require('../lib/checkout/produto-ativo');
  let cache = {};
  const { escolherProdutoAtivo } = criar({
    CACHE_DIR: '/tmp', readJson: () => ({}), writeJson: () => {},
    lerSkuInfoCache: () => cache, gravarSkuInfoCache: (v) => { cache = v; },
  });

  const excluido = { id: 1, codigo: 'SKU-X', situacao: 'E', nome: 'cadastro velho' };
  const vivo = { id: 2, codigo: 'SKU-X', situacao: 'A', nome: 'cadastro atual' };

  const escolhido = escolherProdutoAtivo([excluido, vivo], 'SKU-X', null, 10);
  assert.ok(escolhido, 'não escolheu ninguém com um ativo disponível');
  assert.strictEqual(escolhido.id, 2,
    'escolheu o cadastro EXCLUÍDO (id ' + escolhido.id + ') — é dele que sairia o custo, e custo errado vira margem errada');

  /* só excluídos: não pode inventar um ativo */
  const soExcluido = escolherProdutoAtivo([excluido], 'SKU-X', null, 10);
  assert.ok(!soExcluido || soExcluido.id !== 2, 'inventou um produto que não estava na lista');

  assert.strictEqual(escolherProdutoAtivo([], 'SKU-X', null, 10), null, 'lista vazia tem que devolver null');
  assert.strictEqual(escolherProdutoAtivo(null, 'SKU-X', null, 10), null, 'lista nula tem que devolver null');
}

/* 2. As TRÊS empresas usam a função — e nenhuma pede limite=1 na busca por código */
const MODULOS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};
for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(/escolherProdutoAtivo\(/.test(codigo),
    emp + ': não usa escolherProdutoAtivo — pode ler o custo de um cadastro excluído');
  assert.ok(!/limite=1&criterio=5/.test(codigo),
    emp + ': ainda pede `limite=1` na busca por código — com um só resultado não há o que escolher, ' +
    'e se ele for o cadastro excluído o custo sai errado sem erro nenhum');
}

console.log('OK: produto ativo — as três escolhem o cadastro vivo, e nenhuma pede limite=1 na busca por código');
