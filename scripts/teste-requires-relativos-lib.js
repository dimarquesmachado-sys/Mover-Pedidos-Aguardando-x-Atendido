'use strict';
/* 31/10 — TODO require RELATIVO dentro de lib/ resolve a partir da pasta DO ARQUIVO. Pegou no #781 (Codex): as rotas comuns
   vieram do index.js das empresas pra lib/checkout/rotas-comuns.js, e três requires DENTRO das rotas
   (`require('../lib/nf-travadas')`, `../lib/bling-duplicatas`, `../lib/ml-fatura-cartao`) seguiram com o caminho de quem
   mora na pasta da empresa — em lib/checkout eles apontavam pra lib/lib/… e as rotas dariam 500 ("Cannot find module") nas
   três empresas. O require que fica DENTRO de uma função só falha quando a rota é chamada — a sintaxe e o boot passam.
   É o erro de toda peça que nasce de código movido de pasta (ciclo, diagnóstico, rotas de lote, rotas comuns…): esta
   varredura trava a classe. Só requires com texto fixo ('./x', '../x'); os montados em tempo de execução ficam de fora. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
function arquivos(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name.startsWith('.')) continue;
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...arquivos(p));
    else if (n.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const ruins = [];
let vistos = 0;
for (const f of arquivos(path.join(raiz, 'lib'))) {
  const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const m of s.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
    vistos++;
    try { require.resolve(path.resolve(path.dirname(f), m[1])); } catch (e) { ruins.push(path.relative(raiz, f) + ': ' + m[1]); }
  }
}
assert.ok(vistos > 50, 'a varredura viu poucos requires (' + vistos + ') — o padrão não está casando');
assert.deepStrictEqual(ruins, [], 'require relativo que NÃO resolve a partir da pasta do arquivo (daria "Cannot find module" quando a rota for chamada):\n  ' + ruins.join('\n  '));
console.log('ok — todo require relativo em lib/ resolve a partir da pasta do arquivo (' + vistos + ' conferidos)');
