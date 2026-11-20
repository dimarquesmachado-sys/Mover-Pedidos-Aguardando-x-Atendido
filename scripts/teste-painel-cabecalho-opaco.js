'use strict';
/* 20/11 — O CABEÇALHO GRUDADO DO DASHBOARD NÃO DEIXA OS CARDS APARECEREM ATRAVÉS DELE.

   O dono, na GOOD, no período ANO: "fica meio zuado o topo. os textos encavalados nos cards". No print, o título dos
   cards (Taxas e Fretes, Lucro Bruto…) aparecia ATRÁS da segunda fileira de "ir para", e o "01/01/2026 → 20/11/2026"
   do período em cima do chip do card.

   Causa (medida num Chromium com o CSS de produção): o fundo do `.hdr` (sticky) era um degradê que virava
   TRANSPARENTE nos 30% de baixo. Enquanto o cabeçalho era baixo, esses 30% eram só respiro; com chips + linha do
   período + DUAS fileiras de atalhos (12 botões em 6 colunas), os 30% de baixo têm texto — e, rolando a página, os
   cards passam por baixo e aparecem através (luminância 138 na faixa de baixo do cabeçalho, contra 26 do fundo).

   Conserto: a caixa do cabeçalho é opaca inteira (cor do fundo da página) e o degradê fica SÓ abaixo dela, num
   `::after` fora da caixa, onde não há texto. Depois: 26 — só o fundo.

   Este teste roda na bateria (sem navegador) e prende as duas pontas no CSS de produção:
     · a regra `.hdr{…}` tem fundo SÓLIDO (sem degradê, sem alpha menor que 1) — nenhuma parada transparente dentro da
       caixa onde há texto;
     · o degradê de respiro existe, mas em `.hdr::after`, posicionado ABAIXO da caixa (top:100%) e sem capturar clique;
     · o cabeçalho continua grudado (sticky) e por cima do conteúdo (z-index), como sempre. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'lib/checkout/painel/dashboard.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

/* a regra `.hdr{...}` (a primeira, fora de media query): o bloco inteiro entre as chaves */
function regra(seletor) {
  const i = css.indexOf('\n  ' + seletor + '{');
  assert.ok(i >= 0, 'não achei a regra ' + seletor + ' no CSS do dashboard');
  const fim = css.indexOf('}', i);
  return css.slice(i + seletor.length + 4, fim);
}
const hdr = regra('.hdr');
assert.ok(/position:sticky/.test(hdr) && /z-index:50/.test(hdr), '.hdr continua grudado no topo e por cima do conteúdo: ' + hdr);
const fundo = /background:([^;]+)/.exec(hdr);
assert.ok(fundo, '.hdr declara fundo');
assert.ok(!/gradient/.test(fundo[1]), '⚠️ o fundo da caixa do cabeçalho é SÓLIDO, não degradê (texto do cabeçalho não pode ficar em cima de faixa transparente): ' + fundo[1]);
assert.ok(!/rgba\([^)]*,\s*0?\.\d+\)|rgba\([^)]*,\s*0\)|transparent/.test(fundo[1]), '⚠️ o fundo da caixa do cabeçalho não tem transparência: ' + fundo[1]);
assert.ok(/^#0a0e1a$|^var\(--bg\)$/.test(fundo[1].trim()), '  é a cor do fundo da página (' + fundo[1].trim() + ')');

const depois = regra('.hdr::after');
assert.ok(/content:''/.test(depois) && /position:absolute/.test(depois), '.hdr::after existe e é posicionado');
assert.ok(/top:100%/.test(depois), '⚠️ o degradê de respiro fica ABAIXO da caixa do cabeçalho (top:100%), não dentro dela: ' + depois);
assert.ok(/linear-gradient\([^)]*rgba\(10,\s*14,\s*26,\s*0\)\)/.test(depois), '  o respiro vai da cor do fundo ao transparente');
assert.ok(/pointer-events:none/.test(depois), '  o respiro não captura clique');

console.log('ok — cabeçalho do dashboard: caixa opaca (sem degradê/alpha), respiro só abaixo dela (::after, top:100%), sticky e z-index intactos');
