'use strict';
/* 17/09 — PORTE DO CÁLCULO da reconciliação. Ficou anotado no #490: a AMB e a GOOD expunham
   o sintoma sem a causa, porque o `reconciliacao` só a Girassol calculava. Portar a LINHA da
   rota não resolvia (devolveria null pra sempre) — o que faltava era o cálculo.

   ⚠️ E o cálculo NÃO foi copiado tal e qual: a Girassol marca 'pulada_lista_vazia' quando a
   fila vem vazia, mas na AMB e na GOOD a reconciliação RODA com fila vazia desde que haja
   cache a conferir (conserto dos fantasmas, 25/08). Copiar aquele ramo marcaria como pulado
   um ciclo que rodou — diagnóstico errado é pior que diagnóstico ausente, porque manda
   investigar o lugar errado. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const PASTAS = ['amb-checkout-offline', 'girassol-backup-offline', 'good-checkout-offline'];

/* as três CALCULAM e as três EXPÕEM — é o par que o #490 separou */
for (const pasta of PASTAS) {
  const c = fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8');
  assert.ok(/let reconciliacao = 'ok';/.test(c), pasta + ': o ciclo.js não calcula `reconciliacao`');
  assert.ok(/reconciliacao = 'pulada_lista_incompleta';/.test(c),
    pasta + ": falta o ramo da lista incompleta — é o caso que prendeu pedido despachado no cache (13/08)");
  assert.ok(/reconciliacao = 'sem_lista';/.test(c), pasta + ': falta o ramo do Bling fora do ar');
  assert.ok(/^\s*reconciliacao,/m.test(c), pasta + ': calcula mas não devolve no resumo do ciclo');
}

/* o ramo que NÃO pode ser copiado: aqui a reconciliação roda com fila vazia */
for (const pasta of ['amb-checkout-offline', 'good-checkout-offline']) {
  /* olhar só CÓDIGO: a menção no comentário que explica o porte não é uso — é a terceira vez
     hoje que meu filtro linha-a-linha não pega continuação de bloco. */
  const bruto = fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8');
  const c = bruto.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/pulada_lista_vazia/.test(c),
    pasta + ": copiou o 'pulada_lista_vazia' da Girassol — aqui a reconciliação RODA com fila vazia " +
    '(conserto dos fantasmas, 25/08), então esse rótulo marcaria como pulado um ciclo que rodou');
}

/* e a rota continua expondo nas três */
const ROTAS = { amb: 'amb-checkout-offline/index.js', girassol: 'girassol-backup-offline/gbo-app.js', good: 'good-checkout-offline/index.js' };
for (const [emp, arq] of Object.entries(ROTAS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/reconciliacao:\s*\(getUltimoResumo\(\)/.test(s),
    emp + ': a /lista não expõe `reconciliacao` — agora que o ciclo calcula, o campo tem que chegar na tela');
}

console.log('OK: reconciliação — as três calculam e expõem, e o ramo da fila vazia NÃO foi copiado pra quem roda com ela');
