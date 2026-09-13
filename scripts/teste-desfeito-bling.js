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

for (const emp of ['ambtotal', 'good', 'girassol']) {
  const s = fs.readFileSync(path.join(__dirname, '..', emp, 'fluxos.js'), 'utf8');

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
