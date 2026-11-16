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
/* nas três empresas — 15/11 (rotas-cópia): a rota /backfill-ano é a `rotaAno` da peça do plano (lib/checkout/backfill-plano-empresa),
   a mesma das três; o ano em memória da Girassol e da AMB (`backfillAnoTodo`/`_backfillAno`) saiu */
const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'backfill-plano-empresa.js'), 'utf8');
const rotaAno = peca.slice(peca.indexOf('async function rotaAno('), peca.indexOf('/* 3 min depois do boot'));
assert.ok(/backfill-ano-periodo'\)\.resolverPeriodoAno\(\{ ano: urlObj\.searchParams\.get\('ano'\), ate: urlObj\.searchParams\.get\('ate'\) \}\)/.test(rotaAno) && /if \(!per\.ok\) \{ json\(res, 400/.test(rotaAno), 'a rota do ano (peça) não usa a regra comum do período');
assert.ok(!/'20\d\d-/.test(rotaAno) && !/'07'/.test(rotaAno) && /ano: per\.ano, de: per\.de, ate: per\.fim/.test(rotaAno) && /criarPlano\(per\.de, per\.fim, 10\)/.test(rotaAno), 'a resposta e o plano têm que seguir o período resolvido (sem ano fixo nem padrão "07")');
assert.ok(/o\.ocupado\(\)/.test(rotaAno) && /json\(res, 409/.test(rotaAno), 'o ano tem que esperar a trava da empresa (canário/backfill em curso) — 409');
for (const [arq, plano] of [['girassol-backup-offline/gbo-app.js', '_planoGir'], ['amb-checkout-offline/index.js', '_planoAmb'], ['good-checkout-offline/index.js', '_planoGood']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(s.includes('planoAno: (req, res, urlObj, method, p) => ' + plano + '.rotaAno(req, res, urlObj, method, p),'), arq + ': a rota do ano tem que ser a da peça do plano (passo planoAno da fila)');
  assert.ok(!/p === '\/[\w-]+\/backfill-ano'/.test(s), arq + ': a cópia da rota /backfill-ano voltou');
  assert.ok(!/async function backfillAnoTodo\(/.test(s) && !/_backfillAno\./.test(s) && !/ULTIMO_DIA/.test(s), arq + ': sobrou o ano em memória (backfillAnoTodo/_backfillAno) ou a tabela de último dia');
}
console.log('ok — backfill do ano: sem nada, vai até o mês passado (em janeiro, o ano anterior inteiro); ano e mês validados; bissexto certo; as três empresas usam a mesma regra e o ano fixo sumiu');
