'use strict';
// 13/10 — rotinas pesadas de POS-DEPLOY (pesca de tarifas 14 dias, custos, cancelados 45 dias) so fora do galpao.
// Caso real: o deploy do #672 ao meio-dia rodou elas em pleno galpao (girassol.agendador: 106 liberadas, 203 esperas).
const fs = require('fs'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const { adiarForaDoGalpao: a } = require('../lib/checkout/contexto-fundo.js');
const sp = (h, m) => () => new Date(Date.UTC(2026, 9, 13, h + 3, m));   // Sao Paulo = UTC-3
ok(a(90000, sp(12, 0)) === (6 * 60 + 5) * 60000, '⚠️ deploy ao meio-dia: a pesca espera ate as 18h05 (nao roda em pleno galpao)');
ok(a(90000, sp(20, 0)) === 90000 && a(90000, sp(6, 30)) === 90000, '  deploy fora do horario (20h, 6h30): o atraso de sempre');
ok(a(15 * 60000, sp(17, 55)) === 15 * 60000, '  perto das 18h: nunca encurta o atraso original');
const ag = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'agendador.js'), 'utf8');
const gb = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
ok((ag.match(/adiarForaDoGalpao\(/g) || []).length === 3 && (gb.match(/adiarForaDoGalpao\(/g) || []).length === 2, '⚠️ agendador (AMB/Girassol: pesca, custos, cancelados) e bootstrap da GOOD (pesca, custos) usam o adiamento');
ok(/_st\(\(\) => rodarCiclo\('boot'\), 20000\);/.test(ag), '  o ciclo do cache (lista de pedidos do galpao) continua logo no boot');
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
