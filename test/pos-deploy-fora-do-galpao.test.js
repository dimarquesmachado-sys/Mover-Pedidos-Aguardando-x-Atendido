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
/* 23/10: + o canário diário da GOOD (fora do galpão) */
/* 24/10: + o TikTok diário da GOOD (coleta e correção da tarifa) */
/* 26/10: + os cancelamentos da Magalu da GOOD */
/* 26/10: + o canário das integrações da GOOD */
ok(_usos(ag) === 3 && _usos(gb) === 7 && /agendarDiarioForaDoGalpao\(/.test(ag) && /agendarDiarioForaDoGalpao\(/.test(gb), '⚠️ agendador (AMB/Girassol: pesca, custos, cancelados) e bootstrap da GOOD (pesca, custos, cancelados, canário, TikTok, cancelamentos da Magalu, canário das integrações) usam o adiamento');
ok(/_st\(\(\) => rodarCiclo\('boot'\), 20000\);/.test(ag), '  o ciclo do cache (lista de pedidos do galpao) continua logo no boot');
/* 24/10 (dono: "não precisa parar de sábado não"; a regra dele: "depois das 18h OU fim de semana") — sábado e domingo
   não têm galpão: a rotina pesada roda o dia todo; sexta e segunda continuam protegidas */
{ const cf = require('../lib/checkout/contexto-fundo');
  const em = (iso) => () => new Date(iso);
  ok(cf.janelaRotinaPesada(em('2026-10-24T13:00:00Z')).ok === true, '⚠️ sábado 10h: a rotina pesada roda (o ano da GOOD parou num sábado esperando as 18h05)');
  ok(cf.janelaRotinaPesada(em('2026-10-25T15:00:00Z')).ok === true, '  domingo 12h: roda');
  ok(cf.janelaRotinaPesada(em('2026-10-26T13:00:00Z')).ok === false && cf.janelaRotinaPesada(em('2026-10-23T13:00:00Z')).ok === false, '  segunda e sexta 10h: galpão protegido');
  ok(cf.adiarForaDoGalpao(15 * 60000, em('2026-10-24T13:00:00Z')) === 15 * 60000, '  pós-deploy num sábado de manhã: o atraso de sempre, sem esperar as 18h05');
  ok(cf.adiarForaDoGalpao(30 * 60000, em('2026-10-23T20:00:00Z')) === 65 * 60000, '  sexta 17h + 30 min: ainda é galpão — espera as 18h05');
  ok(cf.adiarForaDoGalpao(15 * 60000, em('2026-10-26T09:50:00Z')) === (11 * 60 + 15) * 60000, '  segunda 6h50 + 15 min (cai 7h05): espera as 18h05');
  process.env.GALPAO_OPERA_FIM_DE_SEMANA = '1';
  ok(cf.janelaRotinaPesada(em('2026-10-24T13:00:00Z')).ok === false, '  GALPAO_OPERA_FIM_DE_SEMANA=1: o sábado volta a ser protegido');
  delete process.env.GALPAO_OPERA_FIM_DE_SEMANA; }
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
