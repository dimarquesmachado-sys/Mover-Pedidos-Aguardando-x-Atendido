'use strict';
/* Fatia 7 (13/09): o relógio da operação. Rotina que deixa de ser agendada NÃO FALHA — ela
   simplesmente não acontece, em silêncio, e alguém descobre dias depois por um número
   estranho. Por isso este teste confere os 12 agendamentos um a um, com os tempos exatos
   que estavam no bootstrap antigo, e prova que o minuto do custo diário é por empresa. */
const assert = require('assert');
const { criarAgendador } = require('../lib/checkout/agendador');
// 13/10: as rotinas pesadas de pos-deploy esperam o fim do horario do galpao (adiarForaDoGalpao) — este teste confere
// os agendamentos, nao o relogio: aqui o adiamento devolve o atraso original
require('../lib/checkout/contexto-fundo').adiarForaDoGalpao = (ms) => ms;

/* 16/11 (montarCheckout, passo 7): o plano do ano da empresa (lib/checkout/backfill-plano-empresa) — retomado 3 min depois do
   boot, e a preparação sozinha 4 min depois (as duas eram só da GOOD, agendadas à mão; a Girassol e a AMB retomavam o plano
   no carregamento do arquivo) */
const planoFake = (reg) => ({ motor: { tocar: async () => { (reg || []).push('tocou'); return { ok: true }; } }, criarPlano: (de, ate, dias) => { (reg || []).push(['criou', de, ate, dias]); return { fatias: [1, 2, 3] }; }, existe: () => false });
function montar(empresa, minuto, extra) {
  const agendados = [];
  const nada = async () => {};
  const cfg = Object.assign({
    empresa, minutoCustoDiario: minuto, plano: planoFake(),
    mlSyncFees: nada, custoSync: nada, custoDiario: nada, varrerCancelados: nada,
    mlBillingSync: nada, vendasSync: nada, rodarCiclo: nada, getUltimoResumo: () => null, log: () => {},
    setTimeout: (fn, ms) => { agendados.push({ tipo: 'timeout', ms, fn }); return 0; },
    setInterval: (fn, ms) => { agendados.push({ tipo: 'interval', ms, fn }); return 0; },
  }, extra || {});
  criarAgendador(cfg)();
  return agendados;
}

/* Codex #400, complemento: o conserto garante que o CACHE_DIR é criado — mas o valor real
   está na ORDEM. Se a criação acontecer DEPOIS de algum agendamento, um disco novo volta a
   ter janela de gravação sem pasta, que foi exatamente o defeito. Este caso trava isso. */
{
  const ordem = [];
  montar('amb', 0, {
    aoIniciar: () => ordem.push('pastas'),
    setTimeout: () => ordem.push('agendou'),
    setInterval: () => ordem.push('agendou'),
  });
  assert.strictEqual(ordem[0], 'pastas', 'a pasta de cache tem que nascer ANTES do primeiro agendamento: ' + ordem.slice(0, 3).join(','));
}

const ag = montar('amb', 0);
const chave = ag.map(a => a.tipo[0] + a.ms).sort();
/* 19/10 (Codex #716): o diário dos CANCELADOS passou a ser ANCORADO — o intervalo de 24 h não nasce mais no boot (contado
   do boot, um deploy ao meio-dia punha a varredura todo dia ao meio-dia, em pleno galpão): nasce quando o tiro adiado
   roda. Então no boot são 11; o 12º (i86400000 dos cancelados) aparece quando o t900000 dispara — conferido logo abaixo. */
const esperado = [
  't90000', 't240000', 'i21600000', 'i60000', 't900000',
  't1500000', 'i86400000', 't150000', 'i300000', 'i300000', 't20000',
  't180000', 't240000',   /* 16/11: o plano do ano (3 min) e a preparação sozinha (4 min) */
].sort();
assert.deepStrictEqual(chave, esperado, 'os agendamentos do bootstrap têm que continuar todos aqui (13 no boot + o diário ancorado dos cancelados)');
{
  const t9 = ag.find(a => a.tipo === 'timeout' && a.ms === 900000);
  const antes = ag.length; t9.fn();
  const novos = ag.slice(antes).map(a => a.tipo[0] + a.ms);
  assert.deepStrictEqual(novos, ['i86400000'], 'o diário dos cancelados tem que nascer do tiro adiado (12º agendamento)');
}

// dependência faltando falha ALTO, em vez de agendar pela metade
assert.throws(() => criarAgendador({ empresa: 'amb' }), /falta /);
assert.throws(() => criarAgendador({}), /falta empresa/);
{ const nada = async () => {}; const base = { empresa: 'amb', mlSyncFees: nada, custoSync: nada, custoDiario: nada, varrerCancelados: nada, mlBillingSync: nada, vendasSync: nada, rodarCiclo: nada };
  assert.throws(() => criarAgendador(base), /falta plano/, 'sem o plano do ano a empresa não retomaria nem se prepararia — tem que derrubar no boot');
  assert.throws(() => criarAgendador(Object.assign({}, base, { plano: { motor: {}, criarPlano: () => null, existe: () => false } })), /falta plano/);
  assert.throws(() => criarAgendador(Object.assign({}, base, { plano: { motor: { tocar: nada }, existe: () => false } })), /falta plano/);
  assert.throws(() => criarAgendador(Object.assign({}, base, { plano: { motor: { tocar: nada }, criarPlano: () => null } })), /falta plano/); }

// aoIniciar (ensureDir do CACHE_DIR + log de versão) roda SÍNCRONO, antes de qualquer timer
// ser sequer registrado — Codex #400: sem isso, a primeira gravação num disco novo falha
// em silêncio até o ciclo de boot rodar, 20s depois.
{
  let chamou = false;
  montar('amb', 0, { aoIniciar: () => { chamou = true; } });
  assert.strictEqual(chamou, true, 'aoIniciar tem que rodar ao montar o agendador');
}

// o minuto do custo diário é POR EMPRESA (23h00 x 23h15 x 23h30 — separadas pra não disputar cota)
for (const [empresa, minuto, horaTeste, minutoTeste, deveRodar] of [
  ['amb', 0, 23, 5, true], ['girassol', 15, 23, 5, false], ['girassol', 15, 23, 20, true],
  ['good', 30, 23, 20, false], ['good', 30, 23, 31, true],
  ['amb', 0, 4, 0, true],            // madrugada: janela de recuperação
  ['amb', 0, 14, 0, false],          // meio do expediente: nunca
]) {
  let rodou = false;
  const ags = montar(empresa, minuto, { custoDiario: async () => { rodou = true; } });
  const tick = ags.find(a => a.tipo === 'interval' && a.ms === 60000);
  const RealDate = Date;
  global.Date = class extends RealDate { getHours() { return horaTeste; } getMinutes() { return minutoTeste; } };
  try { tick.fn(); } finally { global.Date = RealDate; }
  assert.strictEqual(rodou, deveRodar, `${empresa} às ${horaTeste}h${minutoTeste} devia ${deveRodar ? '' : 'NÃO '}rodar o custo diário`);
}

// 16/11: o plano do ano é retomado aos 3 min e a empresa se prepara sozinha aos 4 min — com o banco, o início de vendas e o plano DELA
(async () => {
  const reg = [];
  let existeAgora = false;
  const ags = montar('amb', 0, { plano: Object.assign(planoFake(reg), { existe: () => existeAgora }) });
  await ags.find((a) => a.tipo === 'timeout' && a.ms === 180000).fn();
  assert.deepStrictEqual(reg, ['tocou'], 'aos 3 min o plano da empresa tem que ser retomado');
  const rSd = require.resolve('../lib/checkout/saude-dados-empresa'); const antes = require.cache[rSd];
  let recebeu = null;
  require.cache[rSd] = { id: rSd, filename: rSd, loaded: true, exports: { prepararSozinha: async (emp, d) => { recebeu = { emp, d }; return { motivo: await d.criarPlanoAno('2026-04-09', '2026-11-16').then((r) => 'criou ' + JSON.stringify(r)) }; } } };
  try { const pr = ags.filter((a) => a.tipo === 'timeout' && a.ms === 240000); for (const a of pr) { const r = a.fn(); if (r && r.then) await r.catch(() => {}); } }
  finally { if (antes) require.cache[rSd] = antes; else delete require.cache[rSd]; }
  assert.ok(recebeu && recebeu.emp === 'amb', 'a preparação tem que ser da empresa do agendador');
  assert.strictEqual(recebeu.d.inicioVendas, require('../lib/checkout/config-empresa').configCheckout('amb').inicioVendas, 'o início das vendas é o da empresa (a AMB começou em abril)');
  assert.strictEqual(typeof recebeu.d.supa.req, 'function'); assert.strictEqual(recebeu.d.planoExiste(), false); existeAgora = true; assert.strictEqual(recebeu.d.planoExiste(), true, 'o "já existe" é o do plano DA empresa, lido na hora');
  assert.deepStrictEqual(reg.slice(1), [['criou', '2026-04-09', '2026-11-16', 10]], 'o plano do ano é criado PELA peça do plano da empresa, em fatias de 10 dias');
  /* e uma falha na preparação não derruba nada (fica no log) */
  const ags2 = montar('girassol', 15, { plano: planoFake([]) });
  require.cache[rSd] = { id: rSd, filename: rSd, loaded: true, exports: { prepararSozinha: async () => { throw new Error('banco fora'); } } };
  const _e = console.error; let logou = ''; console.error = (...a) => { logou += a.join(' '); };
  try { for (const a of ags2.filter((x) => x.tipo === 'timeout' && x.ms === 240000)) { const r = a.fn(); if (r && r.then) await r; } }
  finally { console.error = _e; if (antes) require.cache[rSd] = antes; else delete require.cache[rSd]; }
  assert.ok(/girassol preparar.*banco fora/.test(logou), 'a falha da preparação tem que ir pro log, sem lançar: ' + logou);
  console.log('OK: agendador — os 14 agendamentos preservados (o plano do ano e a preparação sozinha nas três), deps obrigatórias (o plano inclusive), e o custo diário respeita o minuto de cada empresa (23h00 x 23h15 x 23h30) e a janela da madrugada');
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
