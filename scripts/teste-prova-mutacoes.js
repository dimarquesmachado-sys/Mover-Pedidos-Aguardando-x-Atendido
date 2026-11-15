'use strict';
/* 15/11 — A PROVA DE MUTAÇÕES VERSIONADA PROVA O QUE PROMETE (auditoria do Codex de 15/11/2026, P3 nº 1).

   Duas coisas, e as duas baratas (rodam na bateria a cada push):
   1. As FIXTURES de mutação (scripts/fixtures/mutacoes/*.json) continuam casando com o código: cada trecho `de` existe
      exatamente uma vez no arquivo e cada teste citado existe. Um refactor que mova o trecho sem atualizar a fixture
      cai AQUI, na bateria — não só no job semanal.
   2. O executor (scripts/prova-mutacoes.js) distingue os quatro desfechos num repositório de brinquedo: mutação PEGA (o
      teste cai por asserção), ESCAPOU (teste segue verde), DESATUALIZADA (trecho sumiu/duplicou), NÃO CONCLUSIVA (a
      mutação não compila / o teste cai sem asserção / trava) — e restaura o arquivo depois de cada uma; controle positivo
      (teste já vermelho) invalida a fixture; `ok` só com tudo pego. O job de verdade é o .github/workflows/mutacoes.yml. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const P = require('./prova-mutacoes');

/* 1. as fixtures casam com o código de hoje */
const fixtures = P.carregar(P.DIR);
assert.ok(fixtures.length >= 20, 'as fixtures de mutação sumiram: ' + fixtures.length);
const total = fixtures.reduce((a, f) => a + f.mutacoes.length, 0);
assert.ok(total >= 800, 'as mutações registradas encolheram: ' + total);
const problemas = P.conferirAncoras(raiz, fixtures);
assert.deepStrictEqual(problemas, [], 'fixture de mutação desatualizada (o trecho mudou de lugar ou o teste sumiu — atualize a fixture junto com o código):\n  ' + problemas.slice(0, 12).join('\n  '));
for (const fx of fixtures) for (const m of fx.mutacoes) assert.notStrictEqual(m.de, m.para, fx.nome + ' › ' + m.nome + ': mutação que não muda nada');
/* uma fixture inválida é recusada ao carregar */
{ const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')); fs.writeFileSync(path.join(d, 'ruim.json'), JSON.stringify({ mutacoes: [{ nome: 'x', arquivo: 'a.js', de: 'a', para: 'b' }] }));
  assert.throws(() => P.carregar(d), /sem teste que a vigie/, 'mutação sem teste tem que ser recusada');
  fs.writeFileSync(path.join(d, 'ruim.json'), JSON.stringify({ testes: ['t.js'], mutacoes: [{ nome: 'x', arquivo: 'a.js', de: 'a' }] }));
  assert.throws(() => P.carregar(d), /sem `para`/); }

/* 2. o executor num repositório de brinquedo */
const toy = fs.mkdtempSync(path.join(os.tmpdir(), 'toy-'));
fs.mkdirSync(path.join(toy, 'lib')); fs.mkdirSync(path.join(toy, 'scripts'));
fs.writeFileSync(path.join(toy, 'lib', 'soma.js'), "'use strict';\nfunction soma(a, b) { if (typeof a !== 'number') throw new Error('a tem que ser número'); return a + b; }\nfunction dobro(x) { return x * 2; }\nmodule.exports = { soma, dobro };\n");
fs.writeFileSync(path.join(toy, 'scripts', 'teste-soma.js'), "const assert = require('assert'); const { soma } = require('../lib/soma'); assert.strictEqual(soma(2, 3), 5, 'soma errada'); assert.throws(() => soma('2', 3), /número/, 'aceitou texto'); console.log('ok');\n");
fs.writeFileSync(path.join(toy, 'scripts', 'teste-sempre-vermelho.js'), "process.exit(1);\n");
const FX = [{ nome: 'toy', origem: 'brinquedo', mutacoes: [
  { nome: 'm1 soma vira subtração', arquivo: 'lib/soma.js', de: 'return a + b;', para: 'return a - b;', testes: ['scripts/teste-soma.js'] },
  { nome: 'm2 aceita texto', arquivo: 'lib/soma.js', de: "if (typeof a !== 'number') throw new Error('a tem que ser número'); ", para: '', testes: ['scripts/teste-soma.js'] },
  { nome: 'm3 dobro vira triplo (ninguém testa)', arquivo: 'lib/soma.js', de: 'return x * 2;', para: 'return x * 3;', testes: ['scripts/teste-soma.js'] },
  { nome: 'm4 trecho que não existe', arquivo: 'lib/soma.js', de: 'return a * b;', para: 'return 0;', testes: ['scripts/teste-soma.js'] },
  { nome: 'm5 não compila', arquivo: 'lib/soma.js', de: 'module.exports = { soma, dobro };', para: 'module.exports = { soma, dobro', testes: ['scripts/teste-soma.js'] },
  { nome: 'm6 módulo que não carrega', arquivo: 'lib/soma.js', de: "'use strict';", para: "'use strict'; require('./nao-existe');", testes: ['scripts/teste-soma.js'] },
  { nome: 'm7 erro de execução no caminho testado (conta como pega)', arquivo: 'lib/soma.js', de: 'return a + b;', para: 'return a.x.y + b;', testes: ['scripts/teste-soma.js'] },
] }];
const logs = [];
const antes = fs.readFileSync(path.join(toy, 'lib', 'soma.js'), 'utf8');
const rel = P.provar(FX, { dir: toy, log: (m) => logs.push(m) });
assert.strictEqual(fs.readFileSync(path.join(toy, 'lib', 'soma.js'), 'utf8'), antes, 'o arquivo tem que voltar ao original depois de cada mutação');
assert.strictEqual(rel.pegas, 3, 'm1, m2 e m7 tinham que ser pegas: ' + JSON.stringify(rel));
assert.deepStrictEqual(rel.escaparam, ['toy › m3 dobro vira triplo (ninguém testa)']);
assert.deepStrictEqual(rel.desatualizadas, ['toy › m4 trecho que não existe (trecho sumiu)']);
assert.strictEqual(rel.inconclusivas.length, 2, JSON.stringify(rel.inconclusivas));
assert.ok(/m5 não compila: a mutação não compila/.test(rel.inconclusivas[0]) && /m6 .*caiu sem asserção nem erro de execução/.test(rel.inconclusivas[1]), JSON.stringify(rel.inconclusivas));
assert.ok(logs.some((l) => /✓ pega: m7 .*\(por erro de execução\)/.test(l)), 'o erro de execução no caminho testado conta como detecção, dito como tal: ' + logs.filter((l) => /m7/.test(l)).join(' | '));
assert.strictEqual(rel.ok, false);
assert.ok(logs.some((l) => /✓ pega: m1/.test(l)) && logs.some((l) => /✗ ESCAPOU: m3/.test(l)) && logs.some((l) => /✗ desatualizada: m4/.test(l)) && logs.some((l) => /✗ não conclusiva: m5/.test(l)), logs.join('\n'));
/* trecho duplicado = desatualizada */
{ const r2 = P.provar([{ nome: 'dup', mutacoes: [{ nome: 'd1', arquivo: 'lib/soma.js', de: 'function', para: 'const', testes: ['scripts/teste-soma.js'] }] }], { dir: toy, log: () => {} });
  assert.deepStrictEqual(r2.desatualizadas, ['dup › d1 (trecho 2×)']); }
/* controle positivo: teste já vermelho invalida a fixture (nenhuma mutação roda) */
{ const r3 = P.provar([{ nome: 'ctl', mutacoes: [{ nome: 'c1', arquivo: 'lib/soma.js', de: 'return a + b;', para: 'return a - b;', testes: ['scripts/teste-sempre-vermelho.js'] }] }], { dir: toy, log: () => {} });
  assert.strictEqual(r3.pegas + r3.escaparam.length + r3.inconclusivas.length + r3.desatualizadas.length, 0, 'com o controle vermelho NENHUMA mutação pode rodar: ' + JSON.stringify(r3)); assert.ok(r3.controle.length === 1 && /JÁ FALHA/.test(r3.controle[0]) && r3.ok === false); }
/* só uma mutação que escapa = não ok */
{ const r6 = P.provar([{ nome: 'esc', mutacoes: [FX[0].mutacoes[2]] }], { dir: toy, log: () => {} }); assert.ok(r6.ok === false && r6.escaparam.length === 1 && r6.pegas === 0, JSON.stringify(r6)); }
/* conferirAncoras acusa trecho duplicado, trecho ausente, arquivo e teste inexistentes */
{ const pr = P.conferirAncoras(toy, [{ nome: 'anc', mutacoes: [
    { nome: 'dup', arquivo: 'lib/soma.js', de: 'function', para: 'x', testes: ['scripts/teste-soma.js'] },
    { nome: 'sumiu', arquivo: 'lib/soma.js', de: 'return a * b;', para: 'x', testes: ['scripts/teste-soma.js'] },
    { nome: 'semarq', arquivo: 'lib/nada.js', de: 'a', para: 'b', testes: ['scripts/teste-soma.js'] },
    { nome: 'semteste', arquivo: 'lib/soma.js', de: 'return a + b;', para: 'x', testes: ['scripts/teste-nada.js'] },
    { nome: 'ok', arquivo: 'lib/soma.js', de: 'return a + b;', para: 'x', testes: ['scripts/teste-soma.js'] }] }]);
  assert.deepStrictEqual(pr, ['anc › dup: o trecho aparece 2× em lib/soma.js', 'anc › sumiu: o trecho SUMIU de lib/soma.js', 'anc › semarq: o arquivo lib/nada.js não existe', 'anc › semteste: o teste scripts/teste-nada.js não existe'], JSON.stringify(pr)); }
/* tudo pego = ok */
{ const r4 = P.provar([{ nome: 'bom', mutacoes: FX[0].mutacoes.slice(0, 2) }], { dir: toy, log: () => {} }); assert.ok(r4.ok === true && r4.pegas === 2); }
/* `--so` filtra pelo nome */
{ const r5 = P.provar(FX, { dir: toy, log: () => {}, so: 'm3' }); assert.strictEqual(r5.pegas, 0); assert.deepStrictEqual(r5.escaparam, ['toy › m3 dobro vira triplo (ninguém testa)']); }

/* 3. o job dedicado existe e roda o executor (e a prova-dos-testes antiga) */
const wf = fs.readFileSync(path.join(raiz, '.github', 'workflows', 'mutacoes.yml'), 'utf8');
assert.ok(/node scripts\/prova-mutacoes\.js/.test(wf) && /PROVA_DOS_TESTES=1|prova-dos-testes\.js/.test(wf), 'o workflow tem que rodar o executor e a prova dos testes');
assert.ok(/workflow_dispatch/.test(wf) && /schedule:/.test(wf), 'o job é semanal e à mão (não por PR — custa minutos)');
assert.ok(/npm ci/.test(wf) && /node-version: 22/.test(wf), 'o job instala pelo lock e roda no Node 22, como os demais');

console.log('ok — prova de mutações versionada: ' + total + ' mutações em ' + fixtures.length + ' fixtures casam com o código; o executor distingue pega / escapou / desatualizada / não conclusiva, restaura o arquivo, invalida fixture com controle vermelho; o job semanal existe');
