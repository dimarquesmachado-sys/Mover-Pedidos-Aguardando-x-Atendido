'use strict';
/* Fatia 7 (13/09): o relógio da operação. Rotina que deixa de ser agendada NÃO FALHA — ela
   simplesmente não acontece, em silêncio, e alguém descobre dias depois por um número
   estranho. Por isso este teste confere os 12 agendamentos um a um, com os tempos exatos
   que estavam no bootstrap antigo, e prova que o minuto do custo diário é por empresa. */
const assert = require('assert');
const { criarAgendador } = require('../lib/checkout/agendador');

function montar(empresa, minuto, extra) {
  const agendados = [];
  const nada = async () => {};
  const cfg = Object.assign({
    empresa, minutoCustoDiario: minuto,
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
const esperado = [
  't90000', 't240000', 'i21600000', 'i60000', 't900000', 'i86400000',
  't1500000', 'i86400000', 't150000', 'i300000', 'i300000', 't20000',
].sort();
assert.deepStrictEqual(chave, esperado, 'os 12 agendamentos do bootstrap antigo têm que continuar todos aqui');

// dependência faltando falha ALTO, em vez de agendar pela metade
assert.throws(() => criarAgendador({ empresa: 'amb' }), /falta /);
assert.throws(() => criarAgendador({}), /falta empresa/);

// aoIniciar (ensureDir do CACHE_DIR + log de versão) roda SÍNCRONO, antes de qualquer timer
// ser sequer registrado — Codex #400: sem isso, a primeira gravação num disco novo falha
// em silêncio até o ciclo de boot rodar, 20s depois.
{
  let chamou = false;
  montar('amb', 0, { aoIniciar: () => { chamou = true; } });
  assert.strictEqual(chamou, true, 'aoIniciar tem que rodar ao montar o agendador');
}

// o minuto do custo diário é POR EMPRESA (23h00 x 23h15 — separadas pra não disputar cota)
for (const [empresa, minuto, horaTeste, minutoTeste, deveRodar] of [
  ['amb', 0, 23, 5, true], ['girassol', 15, 23, 5, false], ['girassol', 15, 23, 20, true],
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

console.log('OK: agendador — os 12 agendamentos preservados, deps obrigatórias, e o custo diário respeita o minuto de cada empresa (23h00 x 23h15) e a janela da madrugada');
