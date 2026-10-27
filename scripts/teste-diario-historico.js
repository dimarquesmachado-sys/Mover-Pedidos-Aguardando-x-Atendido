'use strict';
/* 14/10 — rotina diária do histórico (GOOD). A foto mostrou o histórico da GOOD parando em 30/09:
   ela não tinha rotina diária. Prova a peça de PRODUÇÃO (lib/checkout/diario-historico.js) em todas
   as saídas e a ligação na GOOD (cron, contexto dela, trava, status). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rodarDiario, diaSP } = require('../lib/checkout/diario-historico');
const raiz = path.join(__dirname, '..');

(async () => {
  // calendário de SP: 14/10 02:00 UTC ainda é 13/10 em SP
  assert.strictEqual(diaSP(Date.UTC(2026, 9, 14, 2, 0), 0), '2026-10-13');
  const agora = Date.UTC(2026, 9, 14, 8, 15);   // 05:15 em SP
  const base = (extra) => Object.assign({ empresa: 'good', agoraMs: agora, dorme: async () => {}, esperaMs: 0, maxEsperas: 3 }, extra);

  // 1) caminho feliz: espera a trava (2x), refaz 3 dias, roda o resgate com o plano do dia
  let ocup = 2, chamadas = [], planos = [];
  let r = await rodarDiario(base({ ocupado: () => ocup-- > 0, backfillVendas: async (de, ate, e) => { chamadas.push([de, ate, e]); return { ok: true, desfecho: 'ok', pedidos: 140, gravados: 180 }; },
    resgatar: async (p) => { planos.push(p); return { ok: true, faltando: 1, resgatados: ['2026-10-10'], adiados: [] }; }, planoResgate: (ms) => ({ por: 'alteracao', ms }) }));
  assert.deepStrictEqual(chamadas, [['2026-10-11', '2026-10-14', 'good']]);
  assert.strictEqual(r.esperas, 2); assert.strictEqual(r.ok, true); assert.strictEqual(r.backfill.gravados, 180);
  assert.deepStrictEqual(planos, [{ por: 'alteracao', ms: agora }]); assert.deepStrictEqual(r.resgate.resgatados, ['2026-10-10']);
  // 2) ja_rodando e adiado esperam e tentam de novo
  let seq = [{ ok: false, desfecho: 'ja_rodando' }, { ok: false, desfecho: 'adiado', adiado: 'reparo de SKU' }, { ok: true, desfecho: 'com_erros', erros: 2 }];
  r = await rodarDiario(base({ backfillVendas: async () => seq.shift(), resgatar: async () => ({ ok: true }) }));
  assert.strictEqual(r.esperas, 2); assert.strictEqual(r.backfill.desfecho, 'com_erros'); assert.strictEqual(r.ok, true);
  // 3) abortado / erro / resposta vazia / exceção: não fecha e NÃO roda o resgate
  for (const resp of [{ ok: false, desfecho: 'abortado', transitorio: true }, { ok: false, desfecho: 'erro', msg: 'x' }, undefined, 'THROW']) {
    let resgatou = false;
    r = await rodarDiario(base({ backfillVendas: async () => { if (resp === 'THROW') throw new Error('caiu'); return resp; }, resgatar: async () => { resgatou = true; return { ok: true }; } }));
    assert.strictEqual(r.ok, false, JSON.stringify(resp)); assert.strictEqual(resgatou, false, 'resgate rodou depois de backfill que não fechou: ' + JSON.stringify(resp));
    assert.ok(/não fechou/.test(r.resgate.pulado));
  }
  assert.strictEqual(r.backfill.desfecho, 'erro'); assert.ok(/caiu/.test(r.backfill.msg));
  r = await rodarDiario(base({ backfillVendas: async () => undefined, resgatar: async () => ({ ok: true }) }));
  assert.strictEqual(r.backfill.desfecho, 'desconhecido', 'resposta vazia não pode virar sucesso');
  // 4) trava ocupada a janela toda: não chama o backfill
  chamadas = [];
  r = await rodarDiario(base({ ocupado: () => true, backfillVendas: async () => { chamadas.push(1); return { ok: true }; } }));
  assert.deepStrictEqual(chamadas, []); assert.strictEqual(r.ok, false); assert.strictEqual(r.esperas, 3); assert.strictEqual(r.backfill.desfecho, 'ja_rodando');
  // 5) ja_rodando além do orçamento: para sem resgate
  r = await rodarDiario(base({ backfillVendas: async () => ({ ok: false, desfecho: 'ja_rodando' }), resgatar: async () => { throw new Error('não era pra rodar'); } }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.esperas, 3);
  // 6) resgate que falha ou estoura deixa a rodada como não-ok, com o motivo
  r = await rodarDiario(base({ backfillVendas: async () => ({ ok: true, desfecho: 'ok' }), resgatar: async () => ({ ok: false, erro: 'backfill em curso' }) }));
  assert.strictEqual(r.ok, false); assert.ok(/em curso/.test(r.resgate.erro));
  r = await rodarDiario(base({ backfillVendas: async () => ({ ok: true, desfecho: 'ok' }), resgatar: async () => { throw new Error('Supabase fora'); } }));
  assert.strictEqual(r.ok, false); assert.ok(/Supabase/.test(r.resgate.erro));
  // 6b) resgate ok:true COM dia adiado ou memo não gravado NÃO fecha a rodada (Codex #688)
  for (const rr of [{ ok: true, adiados: ['2026-10-10'], ultimo_erro: 'bling fora' }, { ok: true, adiados: [], memo_falhou: true, ultimo_erro: 'memo' }]) {
    r = await rodarDiario(base({ backfillVendas: async () => ({ ok: true, desfecho: 'ok' }), resgatar: async () => rr }));
    assert.strictEqual(r.ok, false, JSON.stringify(rr)); assert.ok(r.resgate.erro, 'sem motivo');
  }
  r = await rodarDiario(base({ backfillVendas: async () => ({ ok: true, desfecho: 'ok' }), resgatar: async () => ({ ok: true, adiados: [], memo_falhou: false }) }));
  assert.strictEqual(r.ok, true);
  // 7) contexto incompleto
  r = await rodarDiario({ empresa: 'good' }); assert.strictEqual(r.ok, false); assert.ok(/contexto/.test(r.erro));

  // 8) a GOOD está ligada: cron e rotina com o mesmo nome (o orquestrador casa as chaves), contexto dela, trava, status
  const g = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  /* 27/10: a rotina diária do histórico da GOOD roda DENTRO da madrugada única (a etapa do backfill dos últimos dias) */
  assert.ok(/const r = await rodarDiarioHistoricoGood\('noturna'\);/.test(g) && /noturna: \(\) => _noturnaGood\.rotinaNoturna\('cron'\)/.test(g), 'a rotina diária não roda na madrugada');
  assert.ok(/noturna: '0 4 \* \* \*'/.test(g), 'a madrugada da GOOD não está no cron');
  const fn = g.slice(g.indexOf('async function rodarDiarioHistoricoGood'), g.indexOf('function _diarioGoodParaStatus'));
  assert.ok(/_ctxBackfillGood\(\)/.test(fn), 'o diário tem que usar o contexto da GOOD');
  assert.ok(/garantirSitCancel\([^)]*\), 'good'\)/.test(fn), 'situações de cancelamento sem a empresa');
  assert.ok(/reservarVagaBackfill/.test(fn) && /liberarVagaBackfill/.test(fn), 'o resgate da GOOD tem que reservar a vaga');
  assert.ok(/GOOD_DIARIO_HISTORICO/.test(fn), 'sem chave de desligar');
  assert.ok(/gbo\.backfillOcupado\(\)/.test(fn), 'a trava do diário tem que olhar a rodada do ANO da Girassol (backfillOcupado)');
  const ini = fn.indexOf("'desligado'"); assert.ok(/writeJson/.test(fn.slice(ini, fn.indexOf('return _diarioGood', ini))), 'o desligado tem que ir pro disco');
  assert.ok(/diario: _diarioGoodParaStatus\(\)/.test(g), 'o /backfill-status não mostra o diário');
  // e o gbo exporta o que a GOOD usa
  const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  const exp = gbo.slice(gbo.lastIndexOf('module.exports = {'));
  for (const n of ['garantirSitCancel', 'reservarVagaBackfill', 'liberarVagaBackfill', 'backfillVendas', 'backfillEstado', 'backfillOcupado']) assert.ok(new RegExp('\\b' + n + '\\b').test(exp), 'gbo não exporta ' + n);
  console.log('ok — rotina diária do histórico: espera a trava, refaz 3 dias, resgate só quando fecha; GOOD ligada (05:15)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
