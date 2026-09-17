'use strict';
/* 17/09 — PORTE achado ao classificar a `/custo-sync`, uma das divergentes. A diferença de 21
   linhas era quase toda capacidade faltando na GOOD, não regra: a AMB e a Girassol guardam o
   MOTIVO de cada falha do sync de custo (`falhas_detalhe`), a GOOD só contava quantas foram.

   "3 falhas" não diz o que fazer. O SKU e o motivo dizem — e é justamente no sync de custo
   que uma falha silenciosa vira margem errada no dashboard, que é pior que margem ausente.

   O teste guarda o par PRODUZ + EXPÕE, que é a lição do #490: expor campo sem produtor
   devolve null pra sempre e a tela mostra diagnóstico vazio parecendo que está tudo bem. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const MODULOS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};

for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');

  /* PRODUZ: o estado tem o campo e existe quem o preencha */
  assert.ok(/let _cst = \{[^}]*falhas_detalhe/.test(s),
    emp + ': o estado do sync de custo não tem `falhas_detalhe` — a rota devolveria lista vazia pra sempre');
  assert.ok(/function _anotarFalhaCusto\(sku, motivo\)/.test(s),
    emp + ': falta a função que registra o motivo da falha');

  /* e TODO ponto que conta falha registra o motivo: contar sem registrar é o estado anterior,
     onde o número existia e a causa não */
  const contagens = (s.match(/_cst\.falhas\+\+;/g) || []).length;
  const registros = (s.match(/_cst\.falhas\+\+; _anotarFalhaCusto\(/g) || []).length;
  assert.strictEqual(registros, contagens,
    emp + ': ' + (contagens - registros) + ' ponto(s) contam falha sem registrar o motivo — ' +
    'o número sobe e ninguém sabe qual SKU nem por quê');

  /* EXPÕE: a rota devolve o campo */
  assert.ok(/falhas_detalhe: _cst\.falhas_detalhe \|\| \[\]/.test(s),
    emp + ': /custo-sync?status=1 não devolve `falhas_detalhe` — o dado é coletado e não chega na tela');
}

console.log('OK: sync de custo — as três guardam o motivo de cada falha, todo ponto que conta registra, e a rota devolve');
