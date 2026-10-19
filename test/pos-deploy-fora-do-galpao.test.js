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
ok(a(15 * 60000, sp(17, 55)) === 15 * 60000, '  perto das 18h: roda depois das 18h, atraso de sempre');
ok(a(15 * 60000, sp(6, 50)) === (18 * 60 + 5 - (6 * 60 + 50)) * 60000, '⚠️ deploy as 6h50 com atraso de 15 min (cairia as 7h05): espera ate as 18h05 (Codex #677)');
const ag = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'agendador.js'), 'utf8');
const gbArq = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
// 15/10: conta DENTRO do bootstrap da GOOD (pesca e custos do pós-deploy). O arquivo inteiro passou a
// usar o adiamento também no plano automático do backfill (janela fora do galpão) — contar no arquivo
// todo faria um uso novo e legítimo derrubar esta guarda, e um uso que SUMISSE do boot poderia passar.
const _ib = gbArq.indexOf('function bootstrap() {');
const gb = _ib >= 0 ? gbArq.slice(_ib, gbArq.indexOf('\n}\n', _ib)) : '';
/* 19/10: os cancelados (agendador da AMB/Girassol e, agora, a GOOD também) usam o DIÁRIO ANCORADO fora do galpão
   (agendarDiarioForaDoGalpao, Codex #716) — conta junto: 3 usos de cada lado (pesca, custos, cancelados) */
const _usos = (src) => (src.match(/adiarForaDoGalpao\(/g) || []).length + (src.match(/agendarDiarioForaDoGalpao\(/g) || []).length;
ok(_usos(ag) === 3 && _usos(gb) === 3 && /agendarDiarioForaDoGalpao\(/.test(ag) && /agendarDiarioForaDoGalpao\(/.test(gb), '⚠️ agendador (AMB/Girassol: pesca, custos, cancelados) e bootstrap da GOOD (pesca, custos, cancelados) usam o adiamento');
ok(/_st\(\(\) => rodarCiclo\('boot'\), 20000\);/.test(ag), '  o ciclo do cache (lista de pedidos do galpao) continua logo no boot');
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
