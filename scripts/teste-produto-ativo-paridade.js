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

  /* Codex #497 (P2): exigir UMA chamada em qualquer lugar do arquivo era fraco demais — a GOOD
     tem DOIS laços de busca de SKU em produção, e se um regredisse pra `data.data[0]` o teste
     seguiria verde por causa do outro. Agora: todo laço que busca produto por código tem que
     usar o seletor. */
  const laços = (codigo.match(/await bg2?\(`\/produtos\?codigo=/g) || []).length;
  const seletores = (codigo.match(/escolherProdutoAtivo\(/g) || []).length;
  assert.ok(laços > 0, emp + ': não achei nenhuma busca de produto por código');
  assert.strictEqual(seletores, laços,
    emp + ': ' + laços + ' busca(s) por código e só ' + seletores + ' uso(s) do seletor — ' +
    'a que ficou de fora pode ler o custo de um cadastro excluído');
  assert.ok(!/limite=1&criterio=5/.test(codigo),
    emp + ': ainda pede `limite=1` na busca por código — com um só resultado não há o que escolher, ' +
    'e se ele for o cadastro excluído o custo sai errado sem erro nenhum');
}

/* Codex #497 (P1 e P2) — o conserto tem que alcançar o DADO JÁ GRAVADO, e a reserva de inativo
   só pode entrar em último caso. */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');

  /* P1: o filtro do custo-sync tem que revalidar o que o seletor ANTIGO gravou. Sem isso, os
     SKUs com custo do cadastro excluído ficariam 7 dias intocados — o conserto não alcançaria
     justamente o dado errado que existe pra corrigir. */
  assert.ok(/k\.sel !== SEL_ATUAL/.test(s),
    'o filtro do custo-sync não revalida o que a lógica antiga gravou — o dado errado sobrevive 7 dias');
  assert.ok(/sel: SEL_ATUAL/.test(s),
    'a gravação não carimba o seletor — sem a marca, ou revalida pra sempre ou nunca corrige o legado');

  /* P1: consulta concluindo "todos excluídos" NÃO pode restaurar o custo em cache: ele veio do
     cadastro excluído. Isso é diferente de consulta que FALHOU, onde o cache é a proteção certa. */
  assert.ok(/_soExcluidos \? null : _custoLib\.custoDeSku/.test(s),
    'com todos os cadastros excluídos, o custo em cache seria restaurado — é o dado ruim voltando');
  assert.ok(/todos_excluidos && !.*inconclusivo/.test(s),
    'o descarte tem que distinguir "concluí que estão excluídos" de "a consulta veio inconclusiva"');

  /* P2: id novo invalida o sku-info, senão saldo e preço continuam vindo do cadastro velho */
  assert.ok(/_limparSkuInfo\(sku\)/.test(s), 'trocou o id e não invalidou o sku-info em cache');

  /* P1 (r2): a /sku-info descarta o custo em cache quando conclui "só excluído", mas quem
     POPULA `_custos.json` é o custo-sync — sem apagar `cc[sku]` também aqui, o custo do
     cadastro apagado sobrevive indefinidamente nesse cache (o "sister cost-sync path" que o
     Codex apontou). Tem que virar lápide, e a lápide tem que ter grace no filtro de alvos
     (senão bate o Bling de novo a cada rodada pro mesmo SKU já confirmado apagado). */
  assert.ok(/apagado_em: Date\.now\(\)/.test(s),
    'custo-sync não apaga/tumba cc[sku] quando conclui que só há cadastro excluído — sobrevive indefinidamente no cache permanente');
  assert.ok(/k\.apagado_em/.test(s),
    'o filtro de alvos não conhece a lápide — sem grace, bate o Bling de novo a cada rodada pro mesmo SKU confirmado apagado');

  /* P1 (r2): 429/timeout numa variante não pode virar "confirmado excluído" só porque outra
     variante, sem falha, devolveu só cadastro excluído — a falha esconde o que a variante
     de verdade tinha (podia ser o ativo). */
  assert.ok(/_falhaBusca/.test(s),
    'não distingue "todas as variantes concluíram excluído" de "uma variante falhou (429/timeout)" — pode apagar custo bom por causa de instabilidade da rede');
}

/* P2: o inativo só entra como ÚLTIMO recurso, depois de tentar todas as variantes de caixa */
for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/let _reserva = null;/.test(s),
    emp + ': aceita o primeiro não-excluído que aparecer — se a variante exata trouxer um INATIVO, ' +
    'as outras variantes (que talvez tenham o ativo) nunca são tentadas');
  assert.ok(/if \(!prod && _reserva && _reserva\.id\)/.test(s),
    emp + ': guarda a reserva e nunca a usa — SKU só com cadastro inativo ficaria sem custo');
}

console.log('OK: produto ativo — as três escolhem o cadastro vivo, e nenhuma pede limite=1 na busca por código');
