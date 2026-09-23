/* 23/09 — O BUG QUE O DONO ACHOU, e que eu diagnostiquei errado duas vezes antes de olhar o
   dado: ele procurava "lixas" na contagem, via "30 resultado(s)" e faltavam as variações que
   ele queria contar.

   MINHA PRIMEIRA HIPÓTESE (errada): o nome da variação seria só "GRÃO:g100", sem "lixa". Eu
   li isso na coluna Descrição de uma planilha dele e não confirmei na fonte. O JSON de
   /debug-produto-cru mostrou que o Bling manda o nome COMPLETO ("10 X Lixas Disco Grão Liso
   125mm … GRÃO:g100") tanto na listagem quanto no detalhe; "GRÃO:g100" é o `variacao.nome`,
   que é outro campo.

   A CAUSA REAL estava no meu próprio código: o corte em 30 acontecia ANTES da ordenação, então
   sobravam os 30 primeiros na ordem interna do índice — que é a ordem de inserção, arbitrária.
   Com 200 lixas ele via 30 SORTEADAS, não as 30 primeiras. O "30 resultado(s)" exato no print
   era o sinal, e eu demorei a ver.

   LIÇÃO: o número redondo bem no teto era a pista. Antes de teorizar sobre o dado do Bling, era
   pra eu ter olhado o que o MEU código faz com um resultado grande. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo'));

/* índice com 50 lixas EMBARALHADAS na ordem de inserção — é assim que ele fica de verdade,
   porque a varredura grava na ordem em que o Bling devolve */
const idx = {};
const nomes = [];
for (let i = 1; i <= 50; i++) nomes.push('Lixa Disco GRÃO:' + String(i * 10).padStart(4, '0'));
nomes.sort(() => Math.random() - 0.5);
nomes.forEach((n, i) => { idx['sku:L' + i] = { sku: 'L' + i, nome: n, id: i }; });

const handler = criar({
  prefixo: '/x', json: (r, st, o) => { r._o = o; }, blingGet: async () => ({ ok: false }),
  ehAdmin: () => true, skuEanCache: () => ({}), lerIndiceEan: () => idx,
  salvarNoIndiceEan: () => {}, getPossiveisGtins: () => [], produtoDetalhe: async () => null,
  primeiraImagem: () => '', locCache: () => ({}), localizacaoDeProduto: () => '',
  indexarCatalogoCompleto: async () => {}, getIdxStatus: () => ({ fim: 'x' }),
});
const pagina = async (off) => {
  const r = {};
  await handler({ headers: {} }, r, new URL('http://x/x/buscar-produto-nome?q=lixa&offset=' + off), 'GET');
  return r._o;
};

(async () => {
  const p1 = await pagina(0);

  assert.strictEqual(p1.total, 50,
    '`total` tem que ser quantos CASARAM (50), não quantos couberam na página — senão a tela ' +
    'diz "30 resultado(s)" e o dono acha que só existem 30');
  assert.strictEqual(p1.itens.length, 30, 'a página deveria trazer 30');
  assert.strictEqual(p1.tem_mais, true, 'não avisa que há mais — o resto fica invisível');

  /* O CORAÇÃO DO BUG: o primeiro item tem que ser o primeiro da ORDEM ALFABÉTICA de todos os
     50, não o primeiro que o índice devolveu. */
  assert.strictEqual(p1.itens[0].nome, 'Lixa Disco GRÃO:0010',
    'a lista foi cortada ANTES de ordenar — o que aparece são resultados SORTEADOS da ordem ' +
    'interna do índice, e o que o dono procura pode simplesmente não cair no sorteio');

  const p2 = await pagina(p1.proximo_offset);
  const todos = [...p1.itens, ...p2.itens].map(i => i.nome);
  assert.strictEqual(new Set(todos).size, 50, 'a paginação repetiu ou perdeu item');
  assert.deepStrictEqual(todos, [...todos].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    'as páginas não formam uma ordem contínua — item da página 2 deveria vir depois de todos da 1');
  assert.strictEqual(p2.tem_mais, false, 'diz que há mais quando acabou');

  console.log('OK: busca por nome ordena ANTES de cortar, e pagina o resto');
})().catch(e => { console.error(e); process.exit(1); });
