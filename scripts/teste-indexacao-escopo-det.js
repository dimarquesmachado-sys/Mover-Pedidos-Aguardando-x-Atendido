/* 04/10 — `det` DECLARADO DENTRO DO `if` DERRUBA A INDEXAÇÃO DO CATÁLOGO.

   Achado nº 2 da auditoria do Codex. A proteção que existia (`teste-contagem-estoque.js`) exige
   a presença de `let det = null;` e compara posições com a primeira `}` depois do `if` — ou seja,
   tenta inferir ESCOPO contando caracteres. Mover a declaração pra dentro do `if` mantém o teste
   verde, e a indexação aborta com `det is not defined` em todo produto que JÁ tem GTIN.

   ⚠️ E ISSO JÁ ACONTECEU DE VERDADE: o comentário no próprio `ciclo.js` registra o estrago —
   "um ReferenceError toda vez que o produto já tinha EAN, e o produto sem GTIN nunca ganhava a
   marca". Com ~9.000 SKUs na Girassol, metade kits, uma indexação que aborta no primeiro produto
   com EAN é o índice inteiro parado.

   COMO ESTE TESTE PROVA, sem contar chaves e sem chamar o Bling: recorta o laço real do arquivo
   e o COMPILA com `new Function`, trocando as dependências por dublês. Se `det` estiver fora do
   alcance de quem o usa, o motor do JavaScript acusa — é ele quem decide escopo, não regex.

   ⚠️ Contar chaves foi o que eu tentei antes, num teste meu, e deu falso positivo: chave dentro
   de string e de comentário conta igual. Por isso aqui quem julga é o compilador.

   Marcador estável [ESCOPO-DET]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');

/* o mesmo trecho existe nas três empresas — a dívida de checkout em cópia por pasta */
const ARQUIVOS = [
  ['AMB', 'amb-checkout-offline/ciclo.js'],
  ['GOOD', 'good-checkout-offline/ciclo.js'],
  ['Girassol', 'girassol-backup-offline/ciclo.js'],
];

let testados = 0;

module.exports = (async () => {
for (const [emp, rel] of ARQUIVOS) {
  const p = path.join(raiz, rel);
  assert.ok(fs.existsSync(p), '[ESCOPO-DET] ' + emp + ': ' + rel + ' não existe — caminho errado tiraria a empresa da cobertura em silêncio');
  const src = fs.readFileSync(p, 'utf8');

  /* ⚠️ A ÂNCORA NÃO PODE SER A LINHA QUE O DEFEITO APAGA. Eu ancorava em `let det = null;` — e
     a mutação do relatório remove justamente essa linha, então o teste PULAVA a empresa inteira
     e saía verde. Era pior que o teste antigo, que ao menos pegava. Agora ancoro no USO de
     `det`, que é o que não pode sumir: se sumiu, a classificação de kit saiu dali e a proteção
     precisa ser revista de propósito, não por acidente. */
  const iDet = src.indexOf('const _alvo = det || it;');
  /* as três empresas TÊM o trecho: sumiu a âncora = falha, nunca `continue` (senão a empresa
     sai da cobertura e a suíte passa com as outras duas) */
  assert.ok(iDet >= 0,
    '[ESCOPO-DET] ' + emp + ': `const _alvo = det || it;` sumiu de ' + rel + ' — se a classificação de ' +
    'kit saiu dali, esta proteção precisa ser revista (e não silenciosamente removida)');
  testados++;

  /* recorta do `for (const it of itens)` até o uso de `det` depois do if */
  const iFor = src.lastIndexOf('for (const it of itens)', iDet);
  assert.ok(iFor > 0, '[ESCOPO-DET] ' + emp + ': não achei o laço do catálogo');

  const iAlvo = iDet;

  const trecho = src.slice(iFor, iAlvo + 'const _alvo = det || it;'.length);

  /* ⚠️ QUEM DECIDE ESCOPO É O MOTOR — MAS SÓ AO EXECUTAR. Minha 1ª versão deste teste COMPILAVA
     o trecho e exigia erro: não funciona, porque `det` fora de escopo é ReferenceError em TEMPO
     DE EXECUÇÃO, não de compilação. O controle negativo me avisou ("ainda compila"), e foi ele
     que impediu este teste de nascer inútil — era exatamente o buraco das minhas proteções.
     Então aqui o trecho RODA, com dublês no lugar das dependências, no caso que quebra: um
     produto que JÁ TEM GTIN (sem GTIN, o `if` executa e a variável existiria de qualquer jeito). */
  const monta = (corpoDoLaco) => `
    'use strict';
    return (async () => {
      const itens = [{ id: 1, nome: 'Produto com EAN', codigo: 'SKU-1' }];
      const idxStatus = { feitos: 0 };
      const profundo = false;                       /* modo normal */
      const getPossiveisGtins = () => ['7891234567895'];   /* JÁ TEM GTIN → o if NÃO executa */
      const produtoDetalhe = async () => ({ id: 1 });
      const sleep = async () => {};
      const PAUSA = 0;
      ${corpoDoLaco}
      }
      return 'rodou';
    })();
  `;

  let saiu = '', falhou = '';
  try { saiu = await new Function(monta(trecho))(); }
  catch (e) { falhou = String(e.message || e); }

  assert.ok(!falhou,
    '[ESCOPO-DET] ' + emp + ': o laço do catálogo QUEBRA num produto que já tem GTIN — ' + falhou +
    '. É o estrago que o próprio comentário do ciclo.js registra: a indexação aborta e o índice ' +
    'do catálogo inteiro para.');

  /* ⚠️ CONTROLE NEGATIVO: com `det` declarado dentro do `if`, isto PRECISA quebrar. Se não
     quebrar, o teste não prova escopo nenhum. */
  const quebrado = trecho
    .replace('let det = null;', '')
    .replace('det = await produtoDetalhe(', 'let det = await produtoDetalhe(');
  let quebrou = false;
  try { await new Function(monta(quebrado))(); } catch (e) { quebrou = /det is not defined/.test(String(e.message || e)); }

  assert.ok(quebrou,
    '[ESCOPO-DET] ' + emp + ': mover `det` pra dentro do `if` NÃO quebrou a execução — então ' +
    'este teste não prova escopo e precisa ser refeito antes de alguém confiar nele');
}

assert.strictEqual(testados, ARQUIVOS.length,
  '[ESCOPO-DET] o teste cobriu ' + testados + ' de ' + ARQUIVOS.length + ' empresas — virou decorativo');

console.log('OK: `det` alcanca quem o usa em ' + testados + ' empresa(s) — provado EXECUTANDO o laco');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
