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
  /* 01/10 — O ESTADO SAIU DO ARQUIVO DA EMPRESA pra lib/checkout/estado-rotinas.js (uma
     instância por empresa), porque era ele que impedia a fábrica de rotas do painel. O campo
     continua obrigatório — o que mudou é ONDE ele é declarado. Aceita as duas formas: a antiga
     (`let _cst = {...}` no próprio arquivo) e a nova (vindo da lib), e nesta segunda confere o
     campo NA LIB, senão o teste passaria sem olhar nada. */
  const viaLib = /_cst = _estadoRotinas\.custo/.test(s);
  if (viaLib) {
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'estado-rotinas.js'), 'utf8');
    assert.ok(/falhas_detalhe/.test(lib),
      'o estado de custo veio da lib, mas a lib não tem `falhas_detalhe` — a rota devolveria ' +
      'lista vazia pra sempre e o dono não saberia QUAIS SKUs falharam');
    assert.ok(/estadoDe\(/.test(lib) && /new Map\(\)/.test(lib),
      'a lib não isola por empresa — duas rodadas zerariam o contador uma da outra');
  }
  assert.ok(viaLib || /let _cst = \{[^}]*falhas_detalhe/.test(s),
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
