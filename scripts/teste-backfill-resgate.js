'use strict';
/* 14/10 — resgate do histórico: pedido que nasce hoje com data de venda antiga. Exercita a
   função DE PRODUÇÃO (lib/checkout/backfill-resgate.js) com Bling/Supabase/backfill de mentira,
   e confere que as duas empresas ligaram a peça na noturna. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resgatar, planoDaNoturna } = require('../lib/checkout/backfill-resgate');

function bling(pedidos) {   // lista paginada de 100
  const chamadas = [];
  return { chamadas, blingGet: async (p) => {
    chamadas.push(p);
    const pg = Number(/pagina=(\d+)/.exec(p)[1]);
    return { ok: true, status: 200, data: { data: pedidos.slice((pg - 1) * 100, pg * 100) } };
  } };
}
function supa(existem) {
  return async (emp, met, q) => {
    assert.strictEqual(met, 'GET'); assert.ok(q.includes('empresa=eq.' + emp));
    const ids = decodeURIComponent(/in\.\(([^)]*)\)/.exec(q)[1]).split(',');
    return { ok: true, status: 200, body: JSON.stringify(ids.filter(i => existem.includes(i)).map(i => ({ numero_pedido: i }))) };
  };
}
(async () => {
  const de = '2026-10-11', ate = '2026-10-14';
  const lista = [
    { numero: 123645, data: '2026-10-10' },   // o caso real: alterado hoje, venda de antes da janela, fora do histórico
    { numero: 123700, data: '2026-10-13' },   // dentro da janela: o backfill normal já cuidou
    { numero: 120000, data: '2026-10-01' },   // antigo alterado, mas JÁ está no histórico
    { numero: 119000, data: '2026-09-28' },   // antigo, fora do histórico
    { numero: 119001, data: '2026-09-28' },   // mesmo dia
    { numero: 118000, data: '' },             // sem data: não dá pra situar
  ];
  // 1) modo alteração: só quem tem data ANTES da janela e não está no histórico; agrupa por dia
  let b = bling(lista), feitos = [];
  let r = await resgatar({ empresa: 'girassol', blingGet: b.blingGet, supaReq: supa(['120000']), backfillVendas: async (d1, d2, e) => { feitos.push([d1, d2, e]); return { ok: true, desfecho: 'ok' }; } }, { de, ate, por: 'alteracao' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(b.chamadas[0].includes('dataAlteracaoInicial=' + de + '&dataAlteracaoFinal=' + ate), b.chamadas[0]);
  assert.strictEqual(r.candidatos, 4); assert.strictEqual(r.faltando, 3); assert.strictEqual(r.sem_data, 1);
  assert.deepStrictEqual(r.dias.map(d => d.dia), ['2026-09-28', '2026-10-10']);
  assert.deepStrictEqual(feitos, [['2026-09-28', '2026-09-28', 'girassol'], ['2026-10-10', '2026-10-10', 'girassol']]);
  assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-10']); assert.deepStrictEqual(r.adiados, []);
  // 2) modo data: considera todos (o de dentro da janela também), filtro dataInicial
  b = bling(lista); feitos = [];
  r = await resgatar({ empresa: 'amb', blingGet: b.blingGet, supaReq: supa(['120000', '123700']), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true, desfecho: 'com_erros' }; } }, { de: '2026-08-15', ate, por: 'data' });
  assert.ok(b.chamadas[0].includes('dataInicial=2026-08-15&dataFinal=' + ate));
  assert.strictEqual(r.candidatos, 5); assert.strictEqual(r.faltando, 3); assert.deepStrictEqual(feitos, ['2026-09-28', '2026-10-10']);
  // 3) teto de dias: o resto fica adiado; somenteListar não roda nada
  b = bling(lista); feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: b.blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true }; } }, { de, ate, maxDias: 1 });
  assert.deepStrictEqual(r.resgatados, ['2026-09-28']); assert.deepStrictEqual(r.adiados, ['2026-10-01', '2026-10-10']);
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => { throw new Error('nao era pra rodar'); } }, { de, ate, somenteListar: true });
  assert.strictEqual(r.faltando, 4); assert.deepStrictEqual(r.resgatados, []);
  // 4) backfill abortado (Bling limitado) PARA a rodada e deixa tudo adiado; ocupado idem
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: false, desfecho: 'abortado', transitorio: true, msg: '429' }; } }, { de, ate });
  assert.deepStrictEqual(feitos, ['2026-09-28']); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']); assert.ok(r.ok); assert.ok(/429/.test(r.ultimo_erro));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => { throw new Error('nao era pra rodar'); }, backfillEstado: () => ({ rodando: true, de: '2026-07-01', ate: '2026-07-31' }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/em curso/.test(r.erro)); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']);
  // 4b) AMB: backfill não devolve nada — o resultado está em backfillEstado(); reparo de SKU = adiado
  let estA = {};
  r = await resgatar({ empresa: 'amb', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { estA = { de: d1, ate: d1, rodando: false, fase: d1 === '2026-10-01' ? 'erro' : 'concluido' }; }, backfillEstado: () => estA }, { de, ate });
  assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-10']); assert.deepStrictEqual(r.adiados, ['2026-10-01']); assert.strictEqual(r.ultimo_erro, 'erro');
  estA = {};
  r = await resgatar({ empresa: 'amb', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => ({ adiado: 'reparo de SKU em andamento' }), backfillEstado: () => estA }, { de, ate });
  assert.deepStrictEqual(r.resgatados, []); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']); assert.ok(/reparo/.test(r.ultimo_erro));
  // 5) Bling fora / Supabase fora / lista truncada → ok:false, nada decidido
  r = await resgatar({ empresa: 'girassol', blingGet: async () => ({ ok: false, status: 429 }), supaReq: supa([]), backfillVendas: async () => ({ ok: true }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/429/.test(r.erro));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: async () => ({ ok: false, status: 500 }), backfillVendas: async () => ({ ok: true }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/Supabase/.test(r.erro));
  const muitos = Array.from({ length: 250 }, (_, i) => ({ numero: 100000 + i, data: '2026-10-01' }));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(muitos).blingGet, supaReq: supa([]), backfillVendas: async () => ({ ok: true }) }, { de, ate, maxPg: 2 });
  assert.strictEqual(r.ok, false); assert.ok(/TRUNCADA/.test(r.erro));
  // 6) contexto incompleto / período inválido
  r = await resgatar({ empresa: 'girassol' }, { de, ate }); assert.strictEqual(r.ok, false);
  r = await resgatar({ empresa: 'girassol', blingGet: async () => ({}), supaReq: async () => ({}), backfillVendas: async () => ({}) }, { de: ate, ate: de }); assert.strictEqual(r.ok, false);
  // 7) plano da noturna: alteração 3 dias; domingo (SP) 60 dias por data
  const seg = Date.UTC(2026, 9, 12, 6, 30), dom = Date.UTC(2026, 9, 11, 6, 30);
  let p = planoDaNoturna(seg); assert.strictEqual(p.por, 'alteracao'); assert.strictEqual(p.de, '2026-10-09'); assert.strictEqual(p.ate, '2026-10-12'); assert.strictEqual(p.maxDias, 5);
  p = planoDaNoturna(dom); assert.strictEqual(p.por, 'data'); assert.strictEqual(p.de, '2026-08-12'); assert.strictEqual(p.ate, '2026-10-11');
  p = planoDaNoturna(Date.UTC(2026, 9, 12, 2, 0)); assert.strictEqual(p.por, 'data', 'domingo 23h em SP ainda é domingo');
  // 8) as duas empresas ligaram a peça: ctx e etapa
  for (const f of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) assert.ok(/resgatarHistorico:/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ' passa resgatarHistorico');
  for (const f of ['girassol-backup-offline/noturna.js', 'amb-checkout-offline/amb-noturna.js']) { const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); assert.ok(/resgate do histórico/.test(s) && /resgatarHistorico\(_plano\)/.test(s), f + ' tem a etapa'); }
  console.log('ok — resgate do histórico: alteração/data, teto, adiados, falhas, plano da noturna, as duas empresas');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
