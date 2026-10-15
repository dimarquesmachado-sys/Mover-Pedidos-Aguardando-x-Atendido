'use strict';
/* 15/10 — o backfill do ano vira PLANO AUTOMÁTICO (pedido do dono: "esse backfill tinha que ser
   automático" / "já tivemos problemas disso antes"). Prova o MOTOR de produção
   (lib/backfill-fatiado.js → criarMotor) com relógio e agenda de mentira, e a ligação na GOOD. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fat = require('../lib/backfill-fatiado');

function cenario(op) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-'));
  const agenda = [];
  const rodadas = [];
  let janelaAberta = op.janela !== false, ocupado = !!op.ocupado;
  const motor = fat.criarMotor({
    cacheDir: dir, pausaMs: 0,
    agendar: (fn, ms) => { const t = { fn, ms }; agenda.push(t); return t; }, cancelar: (t) => { const i = agenda.indexOf(t); if (i >= 0) agenda.splice(i, 1); },
    rodarFatia: async (f) => { rodadas.push(f.de); return op.rodar ? op.rodar(f, rodadas.length) : { ok: true, desfecho: 'ok', pedidos: 10 }; },
    ocupado: () => ocupado,
    podeRodarAgora: () => janelaAberta ? { ok: true } : { ok: false, esperaMs: 3600000, motivo: 'galpão em operação' },
    maxRetentativas: op.maxRet != null ? op.maxRet : 3,
  });
  return { dir, agenda, rodadas, motor, set: (k, v) => { if (k === 'janela') janelaAberta = v; if (k === 'ocupado') ocupado = v; },
    rodaAgenda: async () => { const t = agenda.shift(); if (t) { await t.fn(); await new Promise(r => setImmediate(r)); } return t; } };
}
const plano = (c) => fat.ler(c.dir);

(async () => {
  // 1) janela fechada: nada roda, a volta fica agendada pra quando abrir
  let c = cenario({ janela: false }); fat.criar(c.dir, '2026-01-01', '2026-01-25', 10);
  let r = await c.motor.tocar();
  assert.strictEqual(c.rodadas.length, 0); assert.strictEqual(c.agenda.length, 1); assert.strictEqual(c.agenda[0].ms, 3600000);
  assert.ok(/galpão/.test(c.motor.estado().proximo.motivo));
  // abriu a janela: a volta agendada roda o plano inteiro e confere o fim
  c.set('janela', true); await c.rodaAgenda();
  assert.deepStrictEqual(c.rodadas, ['2026-01-01', '2026-01-11', '2026-01-21']);
  assert.strictEqual(fat.resumo(plano(c)).concluidas, 3);
  await c.rodaAgenda(); assert.strictEqual(c.motor.estado().ultimo.motivo, 'plano concluído'); assert.strictEqual(c.agenda.length, 0, 'plano concluído não reagenda');
  // 2) ocupado: cede a vez e volta em 10 min
  c = cenario({ ocupado: true }); fat.criar(c.dir, '2026-02-01', '2026-02-10', 10);
  await c.motor.tocar(); assert.strictEqual(c.rodadas.length, 0); assert.strictEqual(c.agenda[0].ms, 10 * 60000);
  // 3) fatia que encontra outro backfill (ja_rodando) volta pra fila — não vira erro
  c = cenario({ rodar: (f, n) => n === 1 ? { ok: false, desfecho: 'ja_rodando' } : { ok: true, desfecho: 'ok' } }); fat.criar(c.dir, '2026-03-01', '2026-03-15', 10);
  await c.motor.tocar();
  let pl = plano(c); assert.strictEqual(pl.fatias[0].estado, 'pendente', 'ja_rodando virou erro'); assert.strictEqual(c.agenda[0].ms, 10 * 60000);
  await c.rodaAgenda(); assert.strictEqual(fat.resumo(plano(c)).concluidas, 2);
  // 4) erro: volta pra fila sozinho, até 3 rodadas, e depois para dizendo por quê
  c = cenario({ rodar: () => ({ ok: false, desfecho: 'abortado', transitorio: true, msg: 'Bling 429' }), maxRet: 2 }); fat.criar(c.dir, '2026-04-01', '2026-04-05', 10);
  await c.motor.tocar(); assert.strictEqual(plano(c).fatias[0].estado, 'erro');
  await c.rodaAgenda();   // conferir o fim → refaz (rodada 1)
  assert.strictEqual(plano(c).retentativas_auto, 1); assert.strictEqual(c.agenda[0].ms, 15 * 60000);
  await c.rodaAgenda(); await c.rodaAgenda();   // roda de novo (erro) → conferir → refaz (rodada 2)
  assert.strictEqual(plano(c).retentativas_auto, 2);
  await c.rodaAgenda(); await c.rodaAgenda();   // erro de novo → conferir → desiste
  assert.ok(/depois de 2 rodada/.test(c.motor.estado().ultimo.motivo)); assert.strictEqual(c.rodadas.length, 3);
  // 5) RETOMADA: processo morreu com uma fatia "rodando" — o motor novo (boot) refaz essa fatia inteira
  c = cenario({}); fat.criar(c.dir, '2026-05-01', '2026-05-20', 10);
  pl = plano(c); pl.fatias[0].estado = 'ok'; pl.fatias[1].estado = 'rodando'; fs.writeFileSync(path.join(c.dir, '_backfill_plano.json'), JSON.stringify(pl));
  await c.motor.tocar(); assert.deepStrictEqual(c.rodadas, ['2026-05-11'], 'não retomou a fatia interrompida'); assert.strictEqual(fat.resumo(plano(c)).concluidas, 2);
  // 6) a janela FECHA no meio: para entre fatias e agenda a volta
  c = cenario({ rodar: () => { c.set('janela', false); return { ok: true, desfecho: 'ok' }; } }); fat.criar(c.dir, '2026-06-01', '2026-06-30', 10);
  await c.motor.tocar(); assert.strictEqual(c.rodadas.length, 1); assert.strictEqual(c.agenda[0].ms, 3600000); assert.strictEqual(fat.resumo(plano(c)).faltam, 2);
  // 7) plano parado: o motor não toca
  c = cenario({}); fat.criar(c.dir, '2026-07-01', '2026-07-05', 10); fat.parar(c.dir);
  r = await c.motor.tocar(); assert.strictEqual(r.motivo, 'plano parado'); assert.strictEqual(c.rodadas.length, 0);

  // 8) a GOOD: /backfill-ano cria o plano (com o galpão "aberto", o motor espera), /backfill-status e /backfill-plano mostram
  process.env.GOODBKP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-')); process.env.ADMIN_KEY = 'chave-teste';
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
  const cf = require('../lib/checkout/contexto-fundo'); cf.adiarForaDoGalpao = () => 3600000;   // galpão em operação durante o teste
  const mod = require('../good-checkout-offline/index.js');
  const h = mod.routes(async () => ({}));
  const pedir = async (rota) => { const u = new URL('http://x' + rota); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); let o = null; try { o = JSON.parse(res._b); } catch (e) {} return { s: res._s, o }; };
  let a = await pedir('/good-checkout-offline/backfill-ano?ano=2026&ate=10&k=chave-teste');
  assert.strictEqual(a.s, 202, JSON.stringify(a.o)); assert.strictEqual(a.o.automatico, true); assert.ok(/18h05/.test(a.o.comeca));
  assert.strictEqual(a.o.de, '2026-01-01'); assert.ok(a.o.fatias >= 28, 'fatias: ' + a.o.fatias);
  a = await pedir('/good-checkout-offline/backfill-ano?ano=2026&ate=10&k=chave-teste'); assert.strictEqual(a.s, 409, 'clique duplo recriou o plano');
  a = await pedir('/good-checkout-offline/backfill-status?k=chave-teste'); assert.strictEqual(a.o.plano.existe, true); assert.ok(a.o.plano.motor.proximo && /galpão/.test(a.o.plano.motor.proximo.motivo));
  a = await pedir('/good-checkout-offline/backfill-plano?k=chave-teste'); assert.strictEqual(a.o.ok, true); assert.strictEqual(a.o.concluidas, 0);
  a = await pedir('/good-checkout-offline/backfill-plano?acao=parar&k=chave-teste'); assert.strictEqual(a.o.ok, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/function bootstrap\(\) \{\s*\/\*[^*]*\*\/\s*\{ const _t = setTimeout\(\(\) => \{ _motorPlanoGood\.tocar\(\)/.test(src), 'o boot não retoma o plano');
  console.log('ok — plano automático: espera o galpão fechar, cede a vez, refaz o que falha, retoma depois da queda; GOOD ligada');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
