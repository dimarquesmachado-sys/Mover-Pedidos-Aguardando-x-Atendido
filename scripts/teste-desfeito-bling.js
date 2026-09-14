'use strict';
/* Passo 2.9, 2º achado (13/09): detecção de DESFEITO PELO BLING, portada da Girassol.
   O que existia em AMB e GOOD: um contador que percebia que o pedido voltou pra ATENDIDO.
   O que faltava: a PROVA. Sem guardar a que horas NÓS movemos, o log não permite dizer ao
   suporte do Bling "movemos às X e vocês desfizeram Y minutos depois" — e sem os dois
   horários o ticket vira discussão de opinião.
   O teste guarda as três pontas, porque qualquer uma sozinha não serve: o mapa, a marca
   gravada no momento do move, e o log com os dois horários. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* 14/09: o F1/F2 das gêmeas saiu das pastas e virou lib/fiscal/fluxos-pedidos.js (elas eram
   idênticas). A Girassol segue com implementação própria, por usar outra estratégia de
   retentativa. A garantia deste teste não mudou — ela vale pras TRÊS —, só mudou onde cada
   uma guarda o código: a lib responde pelas gêmeas, a pasta responde pela Girassol. */
const FONTES = [
  ['AMB/GOOD (lib)', path.join(__dirname, '..', 'lib', 'fiscal', 'fluxos-pedidos.js')],
  ['girassol', path.join(__dirname, '..', 'girassol', 'fluxos.js')],
];
for (const [emp, caminho] of FONTES) {
  const s = fs.readFileSync(caminho, 'utf8');

  assert.ok(/_movidosPorNos = new Map\(\)/.test(s), emp + ': falta o mapa do que movemos');
  assert.ok(/_movidosPorNos\.set\(String\(p\.id\), \{ em: Date\.now\(\)/.test(s),
    emp + ': a marca tem que ser gravada COM a hora, no momento do move');
  assert.ok(/DESFEITO PELO BLING/.test(s), emp + ': falta o log do desfeito');

  /* os dois horários na mesma linha são o ponto: um sozinho não prova nada */
  const i = s.indexOf('DESFEITO PELO BLING');
  const trecho = s.slice(i, i + 700);
  assert.ok(/new Date\(marca\.em\)/.test(trecho), emp + ': o log precisa dizer QUANDO nós movemos');
  assert.ok(/min}? min depois|\$\{min\}/.test(trecho), emp + ': o log precisa dizer quantos minutos depois voltou');

  assert.ok(/desfeitos\+\+/.test(s), emp + ': o desfeito tem que ser contado');
  assert.ok(/DESFEITOS PELO BLING=\$\{desfeitos\}/.test(s), emp + ': o resumo do F1 tem que mostrar os desfeitos do dia');
}

console.log('OK: desfeito pelo Bling — as TRÊS guardam a hora do move, registram os dois horários no log e contam no resumo');
