'use strict';
/* 23/10 — o ano da GOOD rodou 5 fatias (~20 min de cota do Bling cada) e TODAS pararam no fim, na troca segura: o
   projeto Supabase da GOOD não tinha o script (sql/historico-troca-segura.sql). E o plano seguia pra próxima fatia,
   queimando cota pra falhar igual. Prova, com as peças de produção:
   1) bancoPreparado: 404 no rascunho = NÃO PREPARADO (conclusivo); OK = preparado; rede/5xx = NÃO SEI (segue);
   2) os DOIS backfills (o compartilhado — Girassol/GOOD — e o da AMB) perguntam ANTES de tocar no Bling;
   3) o plano (lib/backfill-fatiado) PAUSA sozinho, com o motivo, na primeira fatia "não preparado" — não roda as
      outras; erro passageiro continua seguindo; o `retentar` devolve as fatias com erro pra fila e tira a pausa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { bancoPreparado, NAO_PREPARADO } = require('../lib/checkout/troca-periodo-historico');
const fat = require('../lib/backfill-fatiado');

(async () => {
  // 1) a conferência
  const sr = (st, ok) => async () => ({ status: st, ok, body: '' });
  assert.deepStrictEqual((await bancoPreparado({ empresa: 'good', supaReq: sr(404, false) })).nao_preparado, true, '404 tinha que ser NÃO PREPARADO');
  assert.strictEqual((await bancoPreparado({ empresa: 'good', supaReq: sr(404, false) })).msg, NAO_PREPARADO);
  assert.strictEqual((await bancoPreparado({ empresa: 'good', supaReq: sr(200, true) })).ok, true, 'OK tinha que ser preparado');
  for (const st of [503, 0, null]) assert.strictEqual((await bancoPreparado({ empresa: 'good', supaReq: sr(st, false) })).ok, null, st + ' tinha que ser NÃO SEI (segue)');
  assert.strictEqual((await bancoPreparado({ empresa: 'good', supaReq: async () => { throw new Error('rede'); } })).ok, null, 'exceção tinha que ser NÃO SEI');
  let pediu = null; await bancoPreparado({ empresa: 'good', supaReq: async (e, m, c) => { pediu = [e, m, c]; return { status: 200, ok: true }; } });
  assert.deepStrictEqual(pediu, ['good', 'GET', 'vendas_historico_rascunho?select=lote&limit=1'], 'a conferência tem que ser uma leitura de 1 linha no rascunho DA empresa');

  // 2) os dois backfills perguntam ANTES do Bling
  for (const [arq, ini, bling] of [
    ['girassol-backup-offline/gbo-app.js', 'async function backfillVendas(de, ate, empresa, ctx){', 'garantirSitCancel(async p2 => await _blingGet(p2), empresa)'],
    ['amb-checkout-offline/index.js', 'async function backfillVendas(de, ate, empresa){', 'garantirSitCancel(async p2 => await blingGet(p2))'],
  ]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf(ini); const corpo = s.slice(i, s.indexOf('\n}\n', i));
    const iP = corpo.indexOf('.bancoPreparado({'), iB = corpo.indexOf(bling);
    assert.ok(iP > 0 && iB > 0 && iP < iB, arq + ': a conferência do banco não vem antes do Bling');
    assert.ok(/return Object\.assign\(\{\}, _backfill, \{ desfecho: 'abortado', ok: false, transitorio: false, nao_preparado: true \}\);/.test(corpo), arq + ': o "não preparado" não volta pro plano');
  }

  // 3) o plano pausa sozinho na 1ª fatia "não preparado"; passageiro segue; retentar destrava
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fat-'));
  assert.ok(fat.criar(dir, '2026-01-01', '2026-01-30', 10) !== false, 'não criou o plano');
  let chamadas = 0;
  const r1 = await fat.executar(dir, async () => { chamadas++; return { ok: false, desfecho: 'abortado', msg: NAO_PREPARADO, transitorio: false, nao_preparado: true }; });
  let p = fat.resumo(fat.ler(dir));
  assert.strictEqual(chamadas, 1, 'o plano seguiu pras outras fatias (gastando cota) depois do "não preparado"');
  assert.ok(r1.pausado === true && p.parado === true && p.motivo_parada === NAO_PREPARADO, 'o plano não pausou com o motivo: ' + JSON.stringify(p).slice(0, 200));
  assert.ok(p.fatias[0].estado === 'erro' && p.fatias[1].estado === 'pendente', 'as fatias seguintes tinham que ficar pendentes');
  assert.strictEqual(fat.retentar(dir), 1);
  p = fat.resumo(fat.ler(dir));
  assert.ok(p.parado === false && p.motivo_parada === null && p.fatias[0].estado === 'pendente', 'o retentar não destravou o plano');
  // erro passageiro: segue pras próximas (como antes)
  chamadas = 0;
  await fat.executar(dir, async () => { chamadas++; return { ok: false, desfecho: 'abortado', msg: 'rede', transitorio: true }; });
  assert.strictEqual(chamadas, 3, 'erro passageiro não pode pausar o plano');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — banco preparado: conferido antes do Bling nos dois backfills; o plano pausa sozinho no "não preparado" (não queima cota) e o retentar destrava');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
