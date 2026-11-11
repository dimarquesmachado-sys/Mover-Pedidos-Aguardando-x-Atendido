'use strict';
/* 11/11 (plano multiloja, Fase 3 4e) — O PERÍODO DO "BACKFILL DO ANO". A Girassol e a AMB tinham o ANO 2026 e o mês "07"
   FIXOS no código: /backfill-ano sem &ate refazia só janeiro a julho, e em 2027 continuaria refazendo 2026. A regra certa
   (a da GOOD) virou lib/checkout/backfill-ano-periodo e as três a usam.
   Prova (a função DE PRODUÇÃO, com o relógio na mão — sempre no fuso de São Paulo):
   · hoje (novembro/2026) sem nada → 2026, até OUTUBRO (o mês passado), fim em 31/10;
   · JANEIRO de 2027 sem nada → o ano ANTERIOR inteiro (2026, até 12) — a virada que quebraria o código antigo;
   · 23h de 31/12 em São Paulo (já é dia 1º em UTC) ainda é dezembro: até novembro;
   · ano passado explícito → 12; ano corrente em janeiro sem &ate → pede o mês; &ate do mês corrente → fim = hoje;
   · fevereiro de ano bissexto termina dia 29 (a tabela antiga dizia 28);
   · recusas: mês inválido, ano inválido, ano fora da faixa, período que ainda não começou;
   · os meses saem um a um com início e fim (pro backfill mês a mês da Girassol e da AMB);
   e nas três empresas: a rota usa a regra, e o ano fixo e a tabela de dias sumiram do backfill do ano. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { resolverPeriodoAno, ultimoDiaDoMes } = require('../lib/checkout/backfill-ano-periodo');

const NOV = new Date('2026-11-11T15:00:00Z');
let r = resolverPeriodoAno({}, NOV);
assert.ok(r.ok && r.ano === '2026' && r.ate === '10' && r.de === '2026-01-01' && r.fim === '2026-10-31' && r.meses.length === 10 && r.meses[9].mes === '2026-10' && r.meses[1].ate === '2026-02-28', 'novembro sem nada: até outubro: ' + JSON.stringify(r));
r = resolverPeriodoAno({}, new Date('2027-01-15T15:00:00Z'));
assert.ok(r.ok && r.ano === '2026' && r.ate === '12' && r.fim === '2026-12-31' && r.meses.length === 12, 'JANEIRO de 2027 sem nada tinha que refazer 2026 INTEIRO: ' + JSON.stringify(r));
r = resolverPeriodoAno({}, new Date('2027-01-01T02:00:00Z'));   /* 23h de 31/12/2026 em São Paulo */
assert.ok(r.ok && r.ano === '2026' && r.ate === '11', 'às 23h de 31/12 em São Paulo ainda é dezembro (até novembro): ' + JSON.stringify(r));
r = resolverPeriodoAno({ ano: '2025' }, NOV);
assert.ok(r.ok && r.ano === '2025' && r.ate === '12' && r.fim === '2025-12-31', 'ano passado explícito: o ano inteiro');
r = resolverPeriodoAno({ ano: '2027' }, new Date('2027-01-15T15:00:00Z'));
assert.ok(!r.ok && /não há mês fechado em 2027/.test(r.erro), 'ano corrente em janeiro sem &ate tinha que pedir o mês: ' + JSON.stringify(r));
r = resolverPeriodoAno({ ate: '11' }, NOV);
assert.ok(r.ok && r.ate === '11' && r.fim === '2026-11-11' && r.meses[10].ate === '2026-11-11', 'o mês corrente termina HOJE, não no fim do mês: ' + JSON.stringify(r.meses[10]));
r = resolverPeriodoAno({ ano: '2028', ate: '3' }, new Date('2028-06-10T15:00:00Z'));
assert.ok(r.ok && r.ate === '03' && r.meses[1].ate === '2028-02-29' && ultimoDiaDoMes(2028, 2) === '2028-02-29' && ultimoDiaDoMes(2026, 2) === '2026-02-28', 'fevereiro bissexto termina dia 29: ' + JSON.stringify(r.meses));
for (const [ent, re] of [[{ ate: '13' }, /use &ate=MM/], [{ ate: 'x' }, /use &ate=MM/], [{ ano: '26', ate: '5' }, /use &ano=AAAA/], [{ ano: '2019', ate: '5' }, /fora da faixa/], [{ ano: '2030', ate: '5' }, /fora da faixa/], [{ ano: '2027', ate: '3' }, /período vazio/]]) {
  r = resolverPeriodoAno(ent, NOV);
  assert.ok(!r.ok && re.test(r.erro), JSON.stringify(ent) + ' tinha que ser recusado com ' + re + ': ' + JSON.stringify(r));
}
/* nas três empresas */
for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf('async function backfillAnoTodo(periodo){'); assert.ok(i > 0, arq + ': o backfill do ano não recebe o período resolvido');
  const f = s.slice(i, s.indexOf('\n}\n', i));
  assert.ok(!/'20\d\d-/.test(f) && !/ULTIMO_DIA/.test(s), arq + ': sobrou ano fixo ou a tabela de último dia no backfill do ano');
  assert.ok(f.includes("backfillVendas(M.de, M.ate, '" + emp + "')") && /ano: periodo\.ano/.test(f), arq + ': o mês tem que rodar com o início e o fim resolvidos, da empresa certa');
  const rota = s.slice(s.indexOf("/backfill-ano') {"), s.indexOf("/backfill-ano') {") + 2200);
  assert.ok(/backfill-ano-periodo'\)\.resolverPeriodoAno\(/.test(rota) && /if \(!_per\.ok\) \{ json\(res, 400/.test(rota) && /backfillAnoTodo\(_per\)/.test(rota) && !/'07'/.test(rota), arq + ': a rota não usa a regra comum (ou sobrou o padrão "07")');
  assert.ok(/_canario\.rodando/.test(rota), arq + ': o backfill do ano tem que esperar o canário');
  /* Codex #839: a RESPOSTA também não pode ter ano fixo — o campo `ate` dizia '2026-MM' mesmo pedindo outro ano */
  assert.ok(!/'20\d\d-/.test(rota) && /ano: _per\.ano, de: _per\.de, ate: _per\.ano\+'-'\+ateMes, fim: _per\.fim/.test(rota), arq + ': a resposta da rota ainda tem ano fixo (ou não diz o período de verdade)');
}
const g = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
const rg = g.slice(g.indexOf("/backfill-ano') {"), g.indexOf("/backfill-ano') {") + 2600);
assert.ok(/backfill-ano-periodo'\)\.resolverPeriodoAno\(/.test(rg) && /const _fimPl = _per\.fim;/.test(rg) && !/formatToParts/.test(rg), 'GOOD: a rota tem que usar a regra comum (sem a conta de datas escrita à mão)');
console.log('ok — backfill do ano: sem nada, vai até o mês passado (em janeiro, o ano anterior inteiro); ano e mês validados; bissexto certo; as três empresas usam a mesma regra e o ano fixo sumiu');
