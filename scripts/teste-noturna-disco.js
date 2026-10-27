'use strict';
/* 27/10 — a ÚLTIMA MADRUGADA de cada empresa fica gravada em disco: o estado vivia só na memória e cada deploy apagava
   (em 27/10 a tela de status da Girassol voltou vazia depois dos merges do dia, e não dava pra saber se a noite rodou).
   Prova, com a madrugada única de verdade: grava a cada etapa e no fim; outra instância (= o serviço reiniciou) mostra a
   última rodada, marcada como de antes do reinício; caiu NO MEIO → aparece como interrompida, com o que já tinha rodado;
   sem pasta, segue como antes (só memória). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntd-'));
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  process.env.ADMIN_KEY = 'adm-nd';
  let falhou = null;
  try {
    const ctxDe = (cacheDir) => ({ empresa: 'amb', prefixo: '/amb-checkout-offline', cacheDir,
      mlBillingSync: async () => ({ ok: true, meses: 1 }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }),
      mlSyncFees: async () => ({ ok: 1, total: 1, falhas: 0 }), varrerCancelados: async () => ({}),
      VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: (res, c, b) => { res.c = c; res.b = b; } });
    const status = async (n) => { const res = { c: 0, b: null }; await n.rotas({ method: 'GET', headers: {} }, res, new URL('http://h/amb-checkout-offline/noturna-status?k=adm-nd')); return res.b; };
    const N = require('../lib/checkout/noturna-empresa');
    // 1) roda e grava
    const n1 = N.criarNoturna(ctxDe(dir));
    await n1.rotinaNoturna('teste');
    const arq = path.join(dir, '_noturna_ultima.json');
    const gravado = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.ok(gravado.fim && gravado.rodando === false && gravado.etapas.length >= 3 && gravado.resumo, 'a madrugada não gravou a última rodada: ' + JSON.stringify(gravado).slice(0, 200));
    // 2) "reiniciou": outra instância mostra a última, marcada
    const s2 = await status(N.criarNoturna(ctxDe(dir)));
    assert.ok(s2 && s2.antes_do_reinicio === true && s2.etapas.length === gravado.etapas.length && s2.fim === gravado.fim && s2.rodando === false, 'depois do reinício a tela voltou vazia: ' + JSON.stringify(s2).slice(0, 200));
    // 3) caiu NO MEIO: aparece interrompida, com o que já tinha rodado
    fs.writeFileSync(arq, JSON.stringify({ rodando: true, inicio: '2026-10-27T06:30:00Z', fim: null, disparo: 'cron', etapas: [{ nome: 'billing', estado: 'ok' }, { nome: 'backfill', estado: 'rodando' }], resumo: '' }));
    const s3 = await status(N.criarNoturna(ctxDe(dir)));
    assert.ok(s3 && s3.rodando === false && s3.interrompida === true && /interrompida/.test(s3.resumo) && s3.etapas.length === 2, 'a rodada que caiu no meio não apareceu como interrompida: ' + JSON.stringify(s3).slice(0, 200));
    // 4) sem pasta: só memória, sem quebrar
    const s4 = await status(N.criarNoturna(ctxDe(null)));
    assert.ok(s4 && !s4.antes_do_reinicio && Array.isArray(s4.etapas) && s4.etapas.length === 0, 'sem pasta, a madrugada mudou de comportamento');
  } catch (e) { falhou = e; }
  finally { console.log = _log; console.error = _err; global.setTimeout = _st; fs.rmSync(dir, { recursive: true, force: true }); }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  console.log('ok — a última madrugada fica em disco: sobrevive ao reinício, e a que caiu no meio aparece como interrompida');
  process.exit(0);
})();
