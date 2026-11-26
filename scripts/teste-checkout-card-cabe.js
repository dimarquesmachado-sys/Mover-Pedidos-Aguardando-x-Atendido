'use strict';
/* 26/11 — CHECKOUT: O CARD CABE NA TELA (o dono: "faz caber ali as informações no card, pra não ter q puxar essa barrinha
   pra horizontal"). O motivo do "sem etiqueta" às vezes é um texto comprido sem espaço (a resposta crua de um serviço);
   sem quebra, ele alargava a coluna dos cards e a página ganhava rolagem lateral — medido no navegador: card de 920 px
   numa coluna de 376. A linha do motivo (.smeta) agora quebra onde precisar.
   O que se prova: a regra está no estilo do painel, na versão de tela grande, e a de celular não a desfaz. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lib/checkout/painel/painel-galpao.html'), 'utf8');
const regras = [...html.matchAll(/\.smeta\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(regras.length >= 1, 'achei o estilo da linha do motivo');
const base = regras[0].split(';').map((x) => x.trim());
for (const r of ['overflow-wrap:anywhere', 'word-break:break-word', 'min-width:0']) assert.ok(base.includes(r), 'a linha do motivo quebra texto comprido: falta ' + r);
for (const r of regras) assert.ok(!/white-space:\s*nowrap|overflow-wrap:\s*normal|word-break:\s*(normal|keep-all)/.test(r), 'nenhuma regra da linha do motivo desfaz a quebra: ' + r);
assert.ok(/<div class="smeta">NF \'\+\(p\.nf_numero\?esc\(p\.nf_numero\):\'—\'\)\+\' · \'\+\(p\.etq_motivo\?esc\(p\.etq_motivo\)/.test(html), 'o motivo do sem etiqueta sai na linha .smeta');
console.log('ok — checkout: a linha do motivo do card quebra texto comprido sem espaço (não alarga a coluna nem cria barra horizontal)');
