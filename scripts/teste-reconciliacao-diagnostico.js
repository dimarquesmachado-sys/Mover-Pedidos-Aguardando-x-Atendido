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

/* Codex #491 (P2) — 'ok' SÓ QUANDO A RECONCILIAÇÃO CONCLUIU. Havia ramos em que ela é
   ADIADA (a sonda do ciclo anterior não assentou) ou ABORTADA (token mudo no meio do lote), e
   nos dois o valor ficava 'ok': a /lista diria que a limpeza rodou, e o dono procuraria em
   outro lugar a pasta órfã que continua no painel.
   ⚠️ Cada empresa marca o que REALMENTE acontece nela: a AMB e a GOOD têm os ramos da sonda
   pendente e do token mudo; a Girassol tem o da trava. Marcar na Girassol um ramo que ela não
   tem seria inventar diagnóstico. */
{
  const semComentario = (p) => fs.readFileSync(path.join(raiz, p, 'ciclo.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  for (const pasta of ['amb-checkout-offline', 'good-checkout-offline']) {
    const c = semComentario(pasta);
    assert.ok(/_sondaPendente\)/.test(c), pasta + ': esperava o ramo da sonda pendente');
    /* o Codex usou UM rótulo pros dois casos (`adiada_bling_mudo`) em vez dos dois que eu
       tinha separado, e é melhor: menos vocabulário no log de quem lê. O que importa é que
       NENHUM dos dois ramos siga reportando 'ok'. */
    const marcas = (c.match(/reconciliacao = 'adiada_[a-z_]+';/g) || []);
    assert.ok(marcas.length >= 2,
      pasta + ": os ramos de adiamento (sonda pendente e token mudo) ainda reportam 'ok' — a /lista diria que a limpeza rodou");
  }

  /* a Girassol NÃO tem esses ramos — tem o da trava. Marcar o que ela não faz seria inventar. */
  const g = semComentario('girassol-backup-offline');
  assert.ok(!/adiada_bling_mudo/.test(g),
    'a Girassol não tem o ramo da sonda pendente nem o do token mudo — marcá-los seria diagnóstico inventado');
  assert.ok(/reconciliacao = 'abortada_trava';/.test(g), 'a Girassol tem o ramo da trava e ele tem que continuar marcado');
}

console.log('OK: reconciliação — as três calculam e expõem, e o ramo da fila vazia NÃO foi copiado pra quem roda com ela');
