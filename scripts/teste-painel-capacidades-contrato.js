'use strict';
/* 16/11 — FASE 4: O PAINEL ESCONDE RECURSO POR CAPACIDADE DO CONTRATO, NUNCA POR NOME DE EMPRESA (docs/plano-multiloja-passos.md,
   Fase 4 — os dois itens que faltavam; docs/NORTE-2026-11.md, item C).

   Antes, `lib/checkout/painel/empresas.js` trazia as capacidades do painel escritas à mão por empresa (`shopeeResumo: true,
   freteMagalu: true` nas três) — uma segunda fonte de verdade ao lado do contrato (lib/empresas/registro: 'shopee', 'magalu'), e a
   quarta empresa precisaria de alguém lembrando de escrever as dela. Agora `capacidadesDoContrato(id)` lê o contrato: o resumo da
   Shopee aparece se a empresa tem 'shopee'; o ⚙️ do frete da Magalu se tem 'magalu'; `vendasSync` e `canario` são do checkout
   (todas têm). O que vier por `extra.capacidades` ganha por cima (ajuste pontual, testes).

   Prova:
     1) as três, pelo contrato REAL: shopee e magalu ligados (hoje é o que estava escrito à mão — nada muda na tela);
     2) uma empresa só de dado (registro sintético): sem 'shopee' → `shopeeResumo: false`; sem 'magalu' → `freteMagalu: false`;
        com os dois → ligados; e o HTML gerado leva o `__CAPAC` correspondente (o modelo esconde/avisa a partir dele);
     3) `extra.capacidades` ganha por cima; `registro` não vaza pro modelo;
     4) a tela não decide nada por nome de empresa: o modelo (dashboard-modelo) e o HTML não têm `=== 'good'`/`'amb'`/`'girassol'`;
     5) o arquivo não tem mais as capacidades escritas à mão. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const E = require('../lib/checkout/painel/empresas');

/* 1) as três pelo contrato real */
for (const id of ['ambtotal', 'girassol', 'good']) {
  assert.deepStrictEqual(E.capacidadesDoContrato(id), { vendasSync: true, canario: true, shopeeResumo: true, freteMagalu: true }, id + ': as três têm shopee e magalu no contrato');
}

/* 2) empresa só de dado */
const reg = (caps) => ({ temCapacidade: (id, c) => (id === 'quarta' ? caps.includes(c) : null) });
assert.deepStrictEqual(E.capacidadesDoContrato('quarta', reg(['fiscal', 'checkout', 'ml'])), { vendasSync: true, canario: true, shopeeResumo: false, freteMagalu: false }, 'sem shopee nem magalu');
assert.deepStrictEqual(E.capacidadesDoContrato('quarta', reg(['checkout', 'magalu'])), { vendasSync: true, canario: true, shopeeResumo: false, freteMagalu: true });
assert.deepStrictEqual(E.capacidadesDoContrato('quarta', reg(['checkout', 'shopee', 'magalu'])), { vendasSync: true, canario: true, shopeeResumo: true, freteMagalu: true });
assert.deepStrictEqual(E.capacidadesDoContrato('outra', reg(['shopee', 'magalu'])), { vendasSync: true, canario: true, shopeeResumo: false, freteMagalu: false }, 'empresa que o contrato não conhece: nada ligado (null não é true)');
/* o HTML da GOOD gerado com um contrato sem shopee: o __CAPAC diz pro modelo esconder o resumo */
const capacNoHtml = (html) => { const m = /__CAPAC\s*=\s*(\{[^;]*\});/.exec(html); assert.ok(m, 'o HTML tem que carregar o __CAPAC'); return JSON.parse(m[1]); };
let html = E.painelDaEmpresa('good', { defaultAliq: {}, registro: reg([]) });   /* a GOOD existe no painel; o contrato de mentira não a conhece → tudo desligado */
assert.deepStrictEqual(capacNoHtml(html), { vendasSync: true, shopeeResumo: false, freteMagalu: false, canario: true });
assert.ok(!/registro/.test(JSON.stringify(capacNoHtml(html))), 'o registro não vaza');
html = E.painelDaEmpresa('good', { defaultAliq: {} });
assert.deepStrictEqual(capacNoHtml(html), { vendasSync: true, shopeeResumo: true, freteMagalu: true, canario: true }, 'pelo contrato real, a GOOD tem os dois');

/* 3) extra.capacidades ganha por cima */
html = E.painelDaEmpresa('girassol', { defaultAliq: {}, capacidades: { shopeeResumo: false } });
assert.deepStrictEqual(capacNoHtml(html), { vendasSync: true, shopeeResumo: false, freteMagalu: true, canario: true });

/* 4) nada por nome de empresa na tela */
for (const arq of ['lib/checkout/dashboard-modelo.js', 'lib/checkout/painel/dashboard.html']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(!/===\s*'(good|amb|ambtotal|girassol)'/.test(s) && !/empresa\s*==\s*'(good|amb|girassol)'/.test(s), arq + ': recurso escondido por NOME de empresa — tem que ser por capacidade');
}
/* 5) sem as capacidades escritas à mão */
const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'empresas.js'), 'utf8');
assert.ok(!/shopeeResumo: true|freteMagalu: true/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'as capacidades do painel voltaram a ser escritas à mão em empresas.js');
assert.ok(/shopeeResumo: tem\('shopee'\), freteMagalu: tem\('magalu'\)/.test(src), 'a leitura do contrato sumiu');
console.log('ok — Fase 4: o painel liga o resumo da Shopee e o frete da Magalu pelo CONTRATO da empresa (as três iguais a antes; a quarta sai certa só pelo contrato); nada por nome de empresa');
