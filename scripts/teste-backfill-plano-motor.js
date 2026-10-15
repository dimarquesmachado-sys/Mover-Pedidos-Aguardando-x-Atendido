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
  // 4a) Codex #696 r3: disco recusa a gravação na hora de refazer — NÃO gasta rodada, avisa, tenta de novo; 3 seguidas = para
  { const ea = require('../lib/escrita-atomica');
    c = cenario({ rodar: () => ({ ok: false, desfecho: 'abortado', transitorio: true, msg: 'Bling 429' }) }); fat.criar(c.dir, '2026-04-06', '2026-04-08', 10);
    await c.motor.tocar();   // 1ª passada: erro passageiro gravado
    const _g = ea.gravarAtomico; ea.gravarAtomico = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; };
    try {
      await c.rodaAgenda();   // conferir o fim → refazer → disco recusa
      assert.strictEqual(plano(c).retentativas_auto, undefined, 'gastou rodada sem conseguir gravar');
      assert.strictEqual(plano(c).fatias[0].estado, 'erro'); assert.ok(/disco/.test(c.motor.estado().proximo.motivo), 'não avisou o problema de disco');
      await c.rodaAgenda(); await c.rodaAgenda();   // 2ª e 3ª recusas
      assert.ok(/vezes seguidas; parei/.test(c.motor.estado().ultimo.motivo)); assert.strictEqual(c.agenda.length, 0, 'disco quebrado não pode reagendar pra sempre');
    } finally { ea.gravarAtomico = _g; } }
  // 4b) Codex #696: erro que NÃO melhora sozinho (trava de sanidade, spool, Supabase) não é refeito
  c = cenario({ rodar: () => ({ ok: false, desfecho: 'abortado', transitorio: false, msg: 'dados novos abaixo de 60%' }) }); fat.criar(c.dir, '2026-04-10', '2026-04-12', 10);
  await c.motor.tocar(); assert.strictEqual(plano(c).fatias[0].transitorio, false);
  await c.rodaAgenda();   // conferir o fim → NÃO refaz
  assert.strictEqual(c.rodadas.length, 1, 'refez erro determinístico'); assert.ok(/não melhora sozinho/.test(c.motor.estado().ultimo.motivo)); assert.strictEqual(c.agenda.length, 0);
  // 4c) Codex #696: o plano da Girassol (executar sem a opção do motor) segue como antes — ja_rodando vira erro visível
  { const d0 = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-')); fat.criar(d0, '2026-04-20', '2026-04-22', 10);
    await fat.executar(d0, async () => ({ ok: false, desfecho: 'ja_rodando' }), { pausaMs: 0 });
    assert.strictEqual(fat.ler(d0).fatias[0].estado, 'erro', 'mudou o comportamento do plano da Girassol'); }
  // 4d) Codex #696: plano que não foi pro disco não é aceito — criar() lança
  { const ea = require('../lib/escrita-atomica'); const _g = ea.gravarAtomico; ea.gravarAtomico = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; };
    try { assert.throws(() => fat.criar(fs.mkdtempSync(path.join(os.tmpdir(), 'plano-')), '2026-04-01', '2026-04-05', 10), /não consegui gravar o plano/); } finally { ea.gravarAtomico = _g; } }
  // 4f) Codex #696 r4: disco que recusa o 'rodando' NÃO roda a fatia; 'com_erros' vira erro visível, não 'ok'
  { const ea = require('../lib/escrita-atomica');
    c = cenario({}); fat.criar(c.dir, '2026-08-01', '2026-08-05', 10);
    const _g = ea.gravarAtomico; ea.gravarAtomico = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; };
    try { await c.motor.tocar(); assert.strictEqual(c.rodadas.length, 0, 'rodou a fatia sem conseguir gravar o rodando'); assert.ok(/disco/.test(c.motor.estado().proximo.motivo)); }
    finally { ea.gravarAtomico = _g; }
    c = cenario({ rodar: () => ({ ok: true, desfecho: 'com_erros', erros: 4 }) }); fat.criar(c.dir, '2026-08-10', '2026-08-12', 10);
    await c.motor.tocar(); assert.strictEqual(plano(c).fatias[0].estado, 'erro'); assert.ok(/4 erro/.test(plano(c).fatias[0].msg)); assert.ok(!plano(c).fatias[0].transitorio); }
  // 4e) Codex #696: a janela da rotina pesada tem fronteira em 18h05 (e abre antes das 7h)
  { const { janelaRotinaPesada: jr } = require('../lib/checkout/contexto-fundo'); const sp = (h, m) => () => new Date(Date.UTC(2026, 9, 15, h + 3, m));
    let j = jr(sp(18, 2)); assert.strictEqual(j.ok, false); assert.strictEqual(j.esperaMs, 3 * 60000);
    assert.strictEqual(jr(sp(18, 5)).ok, true); assert.strictEqual(jr(sp(6, 59)).ok, true); assert.strictEqual(jr(sp(7, 0)).ok, false); assert.strictEqual(jr(sp(12, 0)).esperaMs, (6 * 60 + 5) * 60000); }
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
  process.env.GOODBKP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-')); process.env.ADMIN_KEY = 'chave-teste'; process.env.GOOD_PLANO_PAUSA_MS = '0';
  /* o backfill de produção fica de fora: um gbo de mentira registra o que o status mostrava DURANTE cada fatia */
  const vistosDurante = []; let pedirRef = null;
  const arqGbo = require.resolve('../girassol-backup-offline/gbo-app');
  require.cache[arqGbo] = { id: arqGbo, filename: arqGbo, loaded: true, exports: {
    backfillVendas: async (de, ate, emp) => { const st = await pedirRef('/good-checkout-offline/backfill-status?k=chave-teste'); vistosDurante.push({ de, emp, estado: st.o.estado, pelo_plano: st.o.pelo_plano }); return { ok: true, desfecho: 'ok', pedidos: 1 }; },
    backfillEstado: () => ({ rodando: false }) } };
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
  const cf = require('../lib/checkout/contexto-fundo'); cf.janelaRotinaPesada = () => ({ ok: false, esperaMs: 3600000, motivo: 'galpão em operação — volta às 18h05' });   // galpão em operação durante o teste
  const mod = require('../good-checkout-offline/index.js');
  const h = mod.routes(async () => ({}));
  const pedir = pedirRef = async (rota) => { const u = new URL('http://x' + rota); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); let o = null; try { o = JSON.parse(res._b); } catch (e) {} return { s: res._s, o }; };
  let a = await pedir('/good-checkout-offline/backfill-ano?ano=2026&ate=10&k=chave-teste');
  assert.strictEqual(a.s, 202, JSON.stringify(a.o)); assert.strictEqual(a.o.automatico, true); assert.ok(/18h05/.test(a.o.comeca));
  assert.strictEqual(a.o.de, '2026-01-01'); assert.ok(a.o.fatias >= 28, 'fatias: ' + a.o.fatias);
  a = await pedir('/good-checkout-offline/backfill-ano?ano=2026&ate=10&k=chave-teste'); assert.strictEqual(a.s, 409, 'clique duplo recriou o plano');
  a = await pedir('/good-checkout-offline/backfill-ano?ano=2099&ate=01&refazer=1&k=chave-teste'); assert.strictEqual(a.s, 400, 'ano futuro virou plano vazio aceito: ' + JSON.stringify(a.o));
  a = await pedir('/good-checkout-offline/backfill-status?k=chave-teste'); assert.strictEqual(a.o.plano.existe, true); assert.ok(a.o.plano.motor.proximo && /galpão/.test(a.o.plano.motor.proximo.motivo));
  a = await pedir('/good-checkout-offline/backfill-plano?k=chave-teste'); assert.strictEqual(a.o.ok, true); assert.strictEqual(a.o.concluidas, 0);
  a = await pedir('/good-checkout-offline/backfill-plano?acao=parar&k=chave-teste'); assert.strictEqual(a.o.ok, true);
  a = await pedir('/good-checkout-offline/backfill-ano?ano=0026&ate=01&refazer=1&k=chave-teste'); assert.strictEqual(a.s, 400, 'ano 0026 virou plano de séculos');
  // Codex #696 r2 (P1): o bootstrap de PRODUÇÃO executa sem cair na zona morta do setTimeout local
  assert.doesNotThrow(() => mod.bootstrap(), 'o bootstrap da GOOD lança');
  const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
  const boot = src.slice(src.indexOf('function bootstrap() {'), src.indexOf('\n}\n', src.indexOf('function bootstrap() {')));
  assert.ok(/setTimeout\(\(\) => \{ _motorPlanoGood\.tocar\(\)/.test(boot), 'o boot não retoma o plano');
  // Codex #696 r2: com a janela ABERTA o motor roda — e a fatia em curso aparece no estado da GOOD
  cf.janelaRotinaPesada = () => ({ ok: true });
  a = await pedir('/good-checkout-offline/backfill-ano?ano=2026&ate=01&refazer=1&k=chave-teste'); assert.strictEqual(a.s, 202, JSON.stringify(a.o));
  for (let i = 0; i < 50 && vistosDurante.length < 4; i++) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(vistosDurante.length, 4, 'o motor não rodou as 4 fatias de janeiro: ' + vistosDurante.length);
  assert.ok(vistosDurante.every(v => v.estado === 'rodando' && v.pelo_plano === true && v.emp === 'good'), 'a fatia automática não aparece no estado da GOOD: ' + JSON.stringify(vistosDurante[0]));
  a = await pedir('/good-checkout-offline/backfill-status?k=chave-teste'); assert.strictEqual(a.o.plano.concluidas, 4);
  console.log('ok — plano automático: espera o galpão fechar, cede a vez, refaz o que falha, retoma depois da queda; GOOD ligada');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
