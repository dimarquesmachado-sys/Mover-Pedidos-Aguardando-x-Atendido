'use strict';
/* 15/11 — ENCERRAMENTO COM DRENAGEM, START/BUILD DO RENDER E LOCKFILE (auditoria geral do Codex de 15/11/2026, P2 nº 9, nº 10
   e nº 12).

   P2 nº 9: SIGTERM chamava `process.exit` na mesma linha do `server.close()` — ciclo, backfill, correção de NF cortados no
   meio, sem registro. Agora (lib/encerramento + contexto-fundo): as agendas param, rotina de fundo nova não começa, o que
   está em curso tem até ENCERRAMENTO_PRAZO_MS pra terminar, e o encerramento fica REGISTRADO (o que terminou, o que foi
   cortado) — visível no /health (`processo.ultimo_encerramento`). Segundo sinal = sai na hora.
   P2 nº 10: o render.yaml rodava `node index.js` — ignorava o `--max-old-space-size=340 --expose-gc` do `npm start`; o vigia
   de memória existia pra um limite que não valia. Agora `startCommand: npm start`.
   P2 nº 12: sem lockfile versionado e `engines >=18` — cada deploy e cada CI resolviam dependências de novo. Agora
   package-lock.json versionado, `npm ci` no Render e no CI, Node 22 em .node-version = engines = workflows.

   Prova com as peças de produção (contexto-fundo real, lib/encerramento com relógio/saída de mentira) e os arquivos de entrega. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const vigia = setTimeout(() => { console.error('FALHOU: o teste travou — 30s'); process.exit(1); }, 30000);
const ARQ = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enc-')), 'ultimo.json');
process.env.ENCERRAMENTO_FILE = ARQ;
const esperaMs = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const _log = console.log; const logs = []; console.log = (m) => logs.push(String(m));
  let falhou = null;
  try {
    /* ── contexto-fundo: sabe o que roda ── */
    const F = require('../lib/checkout/contexto-fundo');
    assert.deepStrictEqual(F.emCurso(), []); assert.strictEqual(F.encerrando(), false);
    let solta; const longa = F.emFundo('amb.ciclo', () => new Promise((r) => { solta = r; }));
    assert.strictEqual(F.emCurso().length, 1); assert.strictEqual(F.emCurso()[0].servico, 'amb.ciclo'); assert.ok(typeof F.emCurso()[0].segundos === 'number');
    assert.strictEqual(F.emFundo('x.sync', () => 7), 7, 'rotina síncrona devolve o valor');
    assert.strictEqual(F.emCurso().length, 1, 'rotina síncrona sai do registro ao voltar');
    assert.throws(() => F.emFundo('x.quebra', () => { throw new Error('boom'); }), /boom/); assert.strictEqual(F.emCurso().length, 1, 'rotina que lança sai do registro');
    await assert.rejects(F.emFundo('x.rejeita', async () => { throw new Error('rej'); }), /rej/); assert.strictEqual(F.emCurso().length, 1, 'rotina que rejeita sai do registro');
    /* o contexto de fundo continua valendo dentro (o porteiro lê daqui) */
    assert.deepStrictEqual(await F.emFundo('good.backfill', async () => F.contexto.getStore()), { fundo: true, servico: 'good.backfill' });
    solta('fim'); assert.strictEqual(await longa, 'fim'); assert.deepStrictEqual(F.emCurso(), []);

    /* ── lib/encerramento com um fundo de mentira (relógio e saída controlados) ── */
    const E = require('../lib/encerramento');
    const fundoFake = (lista) => { let enc = false; return { lista, emCurso: () => lista.slice(), marcarEncerrando: () => { enc = true; }, encerrando: () => enc }; };
    const montar = (fundo, extra) => { const saidas = []; const fechou = []; const enc = E.criar(Object.assign({ fundo, server: { close: () => fechou.push(1) }, sair: (c) => saidas.push(c), log: (m) => logs.push(m), prazoMs: 300, passoMs: 10 }, extra || {})); return { enc, saidas, fechou }; };
    /* a) nada em curso: para as agendas, fecha o server, registra e sai 0 */
    { const f = fundoFake([]); const { enc, saidas, fechou } = montar(f); let parou = 0; enc.registrarParada('crons', () => { parou++; });
      const reg = await enc.encerrar('SIGTERM');
      assert.deepStrictEqual([saidas, fechou.length, parou, f.encerrando()], [[0], 1, 1, true], 'sem nada em curso: sair(0), server fechado, agendas paradas, porta fechada');
      assert.deepStrictEqual([reg.sinal, reg.cortadas, reg.terminaram_a_tempo, reg.agendas_paradas], ['SIGTERM', [], [], ['crons']]);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ARQ, 'utf8')).sinal, 'SIGTERM', 'o encerramento tem que estar registrado no arquivo'); }
    /* b) rotina em curso que termina dentro do prazo: espera, sai 0, registra "terminou a tempo" */
    { const lista = [{ servico: 'amb.ciclo', desde: new Date().toISOString(), segundos: 3 }]; const f = fundoFake(lista); const { enc, saidas } = montar(f);
      setTimeout(() => lista.length = 0, 80);
      const ini = Date.now(); const reg = await enc.encerrar('SIGTERM');
      assert.ok(Date.now() - ini >= 70 && Date.now() - ini < 290, 'tinha que ESPERAR a rotina terminar (~80 ms), levou ' + (Date.now() - ini));
      assert.deepStrictEqual([saidas, reg.terminaram_a_tempo, reg.cortadas], [[0], ['amb.ciclo'], []], JSON.stringify(reg)); }
    /* c) rotina que NÃO termina: sai no prazo, registra como cortada (nome e há quanto tempo rodava) */
    { const f = fundoFake([{ servico: 'girassol.backfill', desde: new Date(Date.now() - 65000).toISOString(), segundos: 65 }]); const { enc, saidas } = montar(f);
      const ini = Date.now(); const reg = await enc.encerrar('SIGTERM');
      assert.ok(Date.now() - ini >= 290 && Date.now() - ini < 1500, 'tinha que esperar até o prazo (300 ms), levou ' + (Date.now() - ini));
      assert.deepStrictEqual(saidas, [0]); assert.deepStrictEqual(reg.cortadas, [{ servico: 'girassol.backfill', rodava_ha_s: 65 }]);
      const arq = JSON.parse(fs.readFileSync(ARQ, 'utf8')); assert.deepStrictEqual(arq.cortadas, reg.cortadas, 'a rotina cortada tem que estar no arquivo (é o que o próximo boot mostra)');
      assert.ok(logs.some((l) => /CORTANDO girassol\.backfill \(há 65 s\)/.test(l)), 'o log tem que dizer o que foi cortado'); }
    /* d) segundo sinal durante a espera: sai na hora, marcado como forçado */
    { const f = fundoFake([{ servico: 'x.lenta', desde: new Date().toISOString(), segundos: 1 }]); const { enc, saidas } = montar(f, { prazoMs: 5000 });
      const p = enc.encerrar('SIGTERM'); await esperaMs(30); assert.deepStrictEqual(saidas, [], 'ainda esperando');
      const ini = Date.now(); await enc.encerrar('SIGINT'); assert.ok(Date.now() - ini < 50 && saidas.length === 1, 'o 2º sinal tinha que sair na hora');
      const forc = JSON.parse(fs.readFileSync(ARQ, 'utf8')); assert.strictEqual(forc.saiu_forcado, true);
      /* Codex #901: o registro do 2º sinal vem FECHADO — a rotina que ainda rodava consta como cortada, com `fim` */
      assert.deepStrictEqual(forc.cortadas.map((c) => c.servico), ['x.lenta'], 'forçado: cortadas tem que listar o que ainda rodava: ' + JSON.stringify(forc));
      assert.ok(forc.fim && forc.terminaram_a_tempo.length === 0, 'forçado: o registro tem que ter fim');
      f.lista.length = 0; await p; }
    /* d2) rotina que terminou ENTRE os dois sinais conta como terminada a tempo, não cortada */
    { const lista = [{ servico: 'a.termina', desde: '2026-11-15T10:00:00.000Z', segundos: 2 }, { servico: 'b.presa', desde: '2026-11-15T10:00:01.000Z', segundos: 1 }]; const f = fundoFake(lista); const { enc } = montar(f, { prazoMs: 5000 });
      const p = enc.encerrar('SIGTERM'); await esperaMs(20); lista.shift();
      const regF = await enc.encerrar('SIGTERM');
      assert.deepStrictEqual([regF.terminaram_a_tempo, regF.cortadas.map((c) => c.servico)], [['a.termina'], ['b.presa']], JSON.stringify(regF));
      lista.length = 0; await p; }
    /* e) diagnóstico (vai no /health): sem dado de gente */
    { const f = fundoFake([]); const { enc } = montar(f); const d = enc.diagnostico();
      assert.ok(d.node === process.version && d.heap_limite_mb > 0 && typeof d.no_ar_ha_s === 'number' && d.encerrando === false && Array.isArray(d.rotinas_em_curso) && d.ultimo_encerramento && d.ultimo_encerramento.saiu_forcado === true, JSON.stringify(d).slice(0, 200));
      assert.deepStrictEqual(Object.keys(d).sort(), ['encerrando', 'heap_limite_mb', 'no_ar_ha_s', 'node', 'rotinas_em_curso', 'ultimo_encerramento']); }
    /* g) os callbacks agendados DEVOLVEM a promessa da rotina — é o que deixa a rotina no registro enquanto roda (Codex #901, P2) */
    { const { criarAgendador } = require('../lib/checkout/agendador');
      require('../lib/checkout/contexto-fundo').adiarForaDoGalpao = (ms) => ms;
      const agendados = []; const soltas = []; const presa = () => new Promise((r) => { soltas.push(r); });
      criarAgendador({ empresa: 'amb', minutoCustoDiario: 0, mlSyncFees: presa, custoSync: presa, custoDiario: presa, varrerCancelados: presa, mlBillingSync: presa, vendasSync: presa, rodarCiclo: presa, getUltimoResumo: () => ({ semEtiqueta: 3 }), log: () => {},
        setTimeout: (fn, ms) => { agendados.push(fn); return 0; }, setInterval: (fn, ms) => { agendados.push(fn); return 0; } })();
      assert.ok(agendados.length >= 11, 'agendamentos: ' + agendados.length);
      const _h = Date.prototype.getHours; Date.prototype.getHours = () => 23;   /* a rodada de custo do dia só dispara às 23h */
      try { for (const fn of agendados) fn(); } finally { Date.prototype.getHours = _h; }
      const emCurso = F.emCurso();
      assert.ok(soltas.length >= 10 && emCurso.length === soltas.length, 'cada rotina disparada tem que estar no registro enquanto roda: ' + soltas.length + ' rotinas, ' + emCurso.length + ' registradas (' + emCurso.map((x) => x.servico).join(',') + ')');
      assert.ok(emCurso.every((x) => x.servico === 'amb.agendador'));
      for (const r of soltas) r(); await esperaMs(5);
      assert.deepStrictEqual(F.emCurso(), [], 'terminadas, saem do registro');
      /* o diário fora do galpão da GOOD é agendado com o timer já embrulhado em comoFundo: o embrulho tem que DEVOLVER a promessa
         da rotina, senão o registro some antes de ela terminar */
      { let cb = null; let soltaD; F.adiarForaDoGalpao = (ms) => ms;
        F.agendarDiarioForaDoGalpao(() => new Promise((r) => { soltaD = r; }), 0, { setTimeout: (fn) => { cb = fn; }, setInterval: () => {} });
        const r = F.emFundo('good-checkout-offline.bootstrap', cb);
        assert.ok(r && typeof r.then === 'function' && F.emCurso().length === 1, 'o diário fora do galpão tem que ficar no registro enquanto roda (' + F.emCurso().length + ')');
        soltaD(); await r; assert.deepStrictEqual(F.emCurso(), []); } }
    /* f) com o contexto-fundo REAL: depois de marcar o encerramento, rotina nova NÃO começa (volta null, fn não roda) */
    { const { enc, saidas } = montar(F); let rodou = 0;
      await enc.encerrar('SIGTERM'); assert.deepStrictEqual(saidas, [0]);
      assert.strictEqual(F.encerrando(), true);
      const rec = F.emFundo('amb.ciclo', () => { rodou++; return 1; });
      /* Codex #901: recusa EXPLÍCITA (adiado), nunca null — o executor de fatias leria null como sucesso */
      assert.ok(rec && rec.adiado === true && rec.ok === false && rec.motivo === 'processo encerrando', 'encerrando: a rotina nova tem que ser pulada');
      assert.strictEqual(rodou, 0);
      /* e a fatia recusada VOLTA PRA FILA (não vira ok) — executor real, sem a opção adiadoVoltaPraFila */
      { const os = require('os'), fs2 = require('fs'), pth = require('path'); const fat = require('../lib/backfill-fatiado');
        const dir = fs2.mkdtempSync(pth.join(os.tmpdir(), 'enc-')); fat.criar(dir, '2026-01-01', '2026-01-10', 10);
        const r = await fat.executar(dir, (f) => F.emFundo('amb', () => ({ ok: true })), { pausaMs: 0 });
        const pl = fat.ler(dir); assert.strictEqual(pl.fatias[0].estado, 'pendente', 'fatia recusada no encerramento não pode virar ok: ' + JSON.stringify(pl.fatias[0]) + JSON.stringify(r)); } assert.ok(logs.some((l) => /amb\.ciclo: não começa — o processo está encerrando/.test(l))); }

    /* a GOOD agenda o bootstrap dela à mão (não pelo agendador): os callbacks lá também devolvem a promessa (Codex #901, P2) */
    for (const [arq, trecho] of [['good-checkout-offline/index.js', 'setTimeout = (fn, ms) => _timers.setTimeout(comoFundo('], ['lib/checkout/agendador.js', 'return function bootstrap() {']]) {
      const src = fs.readFileSync(path.join(raiz, arq), 'utf8'); const i = src.indexOf(trecho); assert.ok(i > 0, arq + ': o bootstrap mudou de lugar');
      const boot = src.slice(i, i + 9000);
      const semReturn = boot.match(/\(\) => \{ try \{ (?:console\.log\([^)]*\); |_log\([^)]*\); )?[A-Za-z]+\([^)]*\)\.catch\(\(\) => \{\}\); \} catch \(e\) \{\} \}/g) || [];
      assert.deepStrictEqual(semReturn, [], arq + ': callback agendado que dispara a rotina SEM devolver a promessa (o encerramento não a esperaria): ' + semReturn.join(' | '));
      assert.ok(/rodarCiclo\('auto-etiqueta'\)\.catch\(\(\) => \{\}\); \}/.test(boot) && /return rodarCiclo\('auto-etiqueta'\)/.test(boot), arq + ': o ciclo extra tem que devolver a promessa');
    }
    /* ── index.js: o SIGTERM antigo saiu; crons registrados e parados; /health com o diagnóstico ── */
    const idx = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
    assert.ok(!/process\.on\('SIGTERM', \(\) => \{ server\.close\(\); process\.exit\(0\); \}\)/.test(idx), 'o SIGTERM que saía na hora ainda está no index.js');
    assert.ok(/const _encerramento = require\('\.\/lib\/encerramento'\)\.criar\(\{ server \}\);/.test(idx) && /_encerramento\.instalar\(\);/.test(idx), 'o index.js tem que instalar o encerramento com o server');
    assert.ok(/_tarefasCron\.push\(cron\.schedule\(/.test(idx) && /_encerramento\.registrarParada\('crons das empresas', \(\) => \{ for \(const t of _tarefasCron\) \{ try \{ t\.stop\(\); \}/.test(idx), 'os crons têm que ser guardados e parados no encerramento');
    assert.ok(/processo: _encerramento\.diagnostico\(\)/.test(idx), 'o /health tem que levar o diagnóstico do processo');

    /* ── render.yaml (P2-10) e reprodutibilidade (P2-12) ── */
    const ry = fs.readFileSync(path.join(raiz, 'render.yaml'), 'utf8');
    assert.ok(/^\s*startCommand: npm start\s*$/m.test(ry), 'render.yaml tem que subir com `npm start` (senão o --max-old-space-size do package.json não vale)');
    assert.ok(/^\s*buildCommand: npm ci\s*$/m.test(ry), 'render.yaml tem que instalar com `npm ci` (o lock manda)');
    assert.ok(!/startCommand: node index\.js/.test(ry));
    const pk = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
    assert.ok(/--max-old-space-size=\d+/.test(pk.scripts.start) && /--expose-gc/.test(pk.scripts.start) && /index\.js$/.test(pk.scripts.start), 'o npm start continua declarando o teto de heap e o gc: ' + pk.scripts.start);
    assert.strictEqual(pk.engines.node, '22.x', 'engines.node fixado na major 22');
    assert.strictEqual(fs.readFileSync(path.join(raiz, '.node-version'), 'utf8').trim(), '22', '.node-version = 22 (é o que o Render lê)');
    for (const w of ['ai-pr-checks', 'orfaos', 'verifica']) {
      const y = fs.readFileSync(path.join(raiz, '.github', 'workflows', w + '.yml'), 'utf8');
      assert.ok(/node-version: 22\b/.test(y) && !/node-version: 20\b/.test(y), w + '.yml tem que rodar no Node 22 (o mesmo do Render)');
    }
    for (const w of ['ai-pr-checks', 'verifica']) {
      const y = fs.readFileSync(path.join(raiz, '.github', 'workflows', w + '.yml'), 'utf8');
      assert.ok(/npm ci\b/.test(y) && !/^\s*(run: )?\s*npm install( --silent)? --no-audit --no-fund\b/m.test(y), w + '.yml tem que instalar as dependências com `npm ci`');
    }
    assert.ok(!/^package-lock\.json$/m.test(fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8')), 'o package-lock.json não pode estar no .gitignore');
    const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
    assert.ok(lock.lockfileVersion >= 2 && lock.name === pk.name, 'package-lock.json versionado, formato novo, do mesmo pacote');
    for (const d of Object.keys(pk.dependencies)) {
      const e = lock.packages['node_modules/' + d];
      assert.ok(e && /^\d+\.\d+\.\d+/.test(String(e.version)), 'o lock não fixa ' + d);
      const inst = JSON.parse(fs.readFileSync(path.join(raiz, 'node_modules', d, 'package.json'), 'utf8')).version;   /* (zxing-wasm não exporta o package.json pelo require) */
      assert.strictEqual(e.version, inst, d + ': o lock (' + e.version + ') tem que ser a versão que a bateria testou (' + inst + ')');
    }
  } catch (e) { falhou = e; }
  finally { console.log = _log; clearTimeout(vigia); }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — encerramento: rotinas de fundo registradas (síncrona, assíncrona, que lança), SIGTERM para agendas, fecha o server, espera o que roda (até o prazo), registra terminadas e cortadas, 2º sinal sai na hora, rotina nova não começa; render.yaml com npm start/npm ci; Node 22 em .node-version = engines = 3 workflows; package-lock versionado e igual ao testado');
  process.exit(0);
})();
