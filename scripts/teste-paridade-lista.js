'use strict';
/* 17/09 — PORTE achado ao classificar as rotas quase-idênticas do passo 4. A rota `/lista`
   diferia em 2 linhas entre a Girassol e as outras duas, e a diferença NÃO era rótulo: a
   Girassol expunha `reconciliacao` e `paginas_refeitas`, a AMB e a GOOD não — embora o
   ciclo.js das TRÊS já produza os dois campos.

   O que isso custava: quando a limpeza do cache é pulada porque a lista do Bling veio
   incompleta, a `reconciliacao` é o único lugar que diz POR QUE. Sem o campo, a AMB e a GOOD
   mostravam o sintoma (pedido despachado preso como "sem etiqueta") sem a causa — e esse é
   exatamente o incidente de 13/08 que motivou o campo existir.

   Este teste guarda a PARIDADE DOS CAMPOS que a /lista devolve: é aí que uma empresa fica
   cega enquanto a outra enxerga, sem nada quebrar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ARQS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};

/* os campos de diagnóstico do ciclo têm que estar nas três */
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  /* só os campos que o ciclo.js das TRÊS produz. `reconciliacao` ficou de fora de propósito:
     só a Girassol calcula, e expor onde ninguém preenche é devolver null pra sempre — a tela
     mostra o diagnóstico vazio e parece que está tudo bem. Está anotado como porte a fazer. */
  for (const campo of ['paginas_refeitas', 'ciclo_rodou_em']) {
    assert.ok(new RegExp(campo + ':\\s*\\(getUltimoResumo\\(\\)').test(s),
      emp + ' não expõe `' + campo + '` na /lista — o ciclo.js dela PRODUZ o dado, ' +
      'e sem ele a empresa mostra o sintoma sem a causa');
  }
}

/* e o produtor tem que continuar existindo nos três ciclos — expor campo que ninguém produz
   seria devolver null pra sempre, que é pior: parece que está tudo bem */
for (const [emp, pasta] of Object.entries({ amb: 'amb-checkout-offline', girassol: 'girassol-backup-offline', good: 'good-checkout-offline' })) {
  const c = fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8');
  assert.ok(/paginasRefeitas/.test(c), emp + ': o ciclo.js não produz `paginasRefeitas` — a rota devolveria 0 pra sempre');
}

/* a regra que este teste existe pra guardar: campo exposto tem que ter PRODUTOR. Foi ela que
   me impediu de portar `reconciliacao` pra duas empresas que nunca o calculariam. */
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const expoe = /reconciliacao:\s*\(getUltimoResumo\(\)/.test(s);
  const pasta = { amb: 'amb-checkout-offline', girassol: 'girassol-backup-offline', good: 'good-checkout-offline' }[emp];
  const produz = /reconciliacao/.test(fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8'));
  assert.ok(!expoe || produz,
    emp + ' expõe `reconciliacao` na /lista mas o ciclo.js dela não calcula — devolveria null pra sempre');
}

console.log('OK: paridade da /lista — campo exposto tem produtor nas três, e `reconciliacao` fica pendente porque só a Girassol o calcula');
