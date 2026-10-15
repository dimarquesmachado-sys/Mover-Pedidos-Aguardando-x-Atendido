'use strict';
/* 15/10 — ordem do dono: "pedido Full que cai no ATENDIDO sai de lá na hora e vai pra despachados" (não só
   esconder da fila). Prova, nos ciclos de produção da AMB e da GOOD (as que têm o caminho do Full → DESPACHADOS):
   o pedido com full_ml no manifesto entra no MESMO caminho do Full reconhecido pela unidade (idsFullVistos),
   ANTES do expurgo e do move; quem não é full_ml não entra; sem repetição. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const [emp, arq] of [['AMB', 'amb-checkout-offline/ciclo.js'], ['GOOD', 'good-checkout-offline/ciclo.js']]) {
  const src = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const ini = src.indexOf('/* 15/10 — ORDEM DO DONO: "pedido Full que cai no ATENDIDO');
  const exp = src.indexOf('    if (Array.isArray(idsFullVistos) && idsFullVistos.length) {\n      let expurgados = 0;');
  const mov = src.indexOf('const r = await moverSituacao(id, SIT_DESPACHADOS);');
  assert.ok(ini > 0 && exp > ini && mov > exp, emp + ': o Full do ML tem que entrar ANTES do expurgo e do move pra DESPACHADOS');
  const bloco = src.slice(src.indexOf('{ const _fullML', ini), exp);
  const roda = new Function('man', 'idsFullVistos', 'console', bloco + '\nreturn idsFullVistos;');
  const man = { '1': { full_ml: true }, '2': { full_ml: false }, '3': { tem_etiqueta: true }, '4': { full_ml: true } };
  const r = roda(man, ['4'], { log: () => {} });
  assert.deepStrictEqual(r.slice().sort(), ['1', '4'], emp + ': full_ml não entrou no caminho do Full (ou entrou repetido/indevido): ' + JSON.stringify(r));
}
console.log('ok — venda Full confirmada pelo ML entra no caminho que tira do cache e move pra DESPACHADOS (AMB e GOOD)');
