'use strict';
/* 26/10 — as DEVOLUÇÕES DO TIKTOK (coleta + linha do tempo) viraram a peça lib/tiktok-devolucoes-rotina: era um bloco
   igual nas madrugadas da Girassol e da AMB; a GOOD não tinha. Prova, com o TikTok de mentira:
   · coletar passa a EMPRESA certa; a linha do tempo só busca as que ainda não têm eventos, no máximo 40, grava o
     arquivo DA empresa, conta revelias e mantém os textos de antes;
   · as duas madrugadas usam a peça com a empresa delas e seguem com as mesmas etapas; a GOOD agenda fora do galpão;
   · a pesca de tarifas do ML da noite da GOOD é de 60 dias, como as outras. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const rot = require('../lib/tiktok-devolucoes-rotina');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkd-'));
  process.env.TIKTOK_CACHE_DIR = dir;
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  // coletar: a empresa vai pra lib
  let pediu = null;
  const r = await rot.coletar('good', 120, { devLib: { coletarDevolucoesTikTok: async (ctx, e, d) => { pediu = [e, d, ctx.CACHE_DIR]; return { vistas: 5, novas: 2 }; } } });
  assert.deepStrictEqual(pediu, ['good', 120, dir], 'a coleta não foi pra empresa certa');
  assert.strictEqual(rot.textoColeta(r), '5 vista(s) · 2 nova(s)', 'o texto da coleta mudou');
  // linha do tempo: só as sem eventos, no máximo 40, no arquivo DA empresa
  assert.deepStrictEqual(await rot.completarLinhaDoTempo('good', { chamar: async () => { throw new Error('não devia chamar'); } }), { semCache: true });
  assert.strictEqual(rot.textoLinha({ semCache: true }), 'sem cache — nada a fazer');
  const devs = {}; for (let i = 0; i < 45; i++) devs['R' + i] = { id: 'R' + i };
  devs.JA = { id: 'JA', eventos: { x: 1 } };
  fs.writeFileSync(path.join(dir, '_tiktok_devolucoes_good.json'), JSON.stringify({ devolucoes: devs }));
  const chamadas = [];
  const rl = await rot.completarLinhaDoTempo('good', {
    chamar: async (p, q, o, conta) => { chamadas.push([p, conta]); return { corpo: { data: { records: [{ event: 'x' }] } } }; },
    evLib: { resumirEventos: (recs) => ({ n: recs.length, perdeu_por_revelia: chamadas.length % 10 === 0 }) },
  });
  assert.strictEqual(chamadas.length, 40, 'a linha do tempo não respeitou o teto de 40 por vez');
  assert.ok(chamadas.every((c) => c[1] === 'good' && !/\/JA\//.test(c[0])), 'chamou com outra empresa ou buscou a que já tinha eventos');
  assert.deepStrictEqual(rl, { ok: 40, revelias: 4, semEventos: 5 }, 'contagem errada: ' + JSON.stringify(rl));
  assert.strictEqual(rot.textoLinha(rl), '40 processada(s) · 4 com revelia · 5 ainda sem linha do tempo');
  const gravado = JSON.parse(fs.readFileSync(path.join(dir, '_tiktok_devolucoes_good.json'), 'utf8'));
  assert.strictEqual(Object.values(gravado.devolucoes).filter((d) => d.eventos).length, 41, 'não gravou os eventos no arquivo da empresa');
  global.setTimeout = _st;
  fs.rmSync(dir, { recursive: true, force: true });
  // as madrugadas e a GOOD
  for (const [arq, emp] of [['girassol-backup-offline/noturna.js', 'girassol'], ['amb-checkout-offline/amb-noturna.js', 'amb']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("rotDev.coletar('" + emp + "', DIAS_TIKTOK)") && s.includes("rotDev.completarLinhaDoTempo('" + emp + "')"), arq + ': não usa a peça com a empresa dela');
    assert.ok(!/coletarDevolucoesTikTok\(ctxDev,/.test(s), arq + ': sobrou a cópia');
  }
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const i = gs.indexOf("const r = await rotDev.coletar('good', Number(process.env.TIKTOK_FINANCEIRO_DIAS) || 120);");
  assert.ok(i > 0 && gs.lastIndexOf('agendarDiarioForaDoGalpao(async () => {', i) > i - 500 && gs.includes("rotDev.completarLinhaDoTempo('good')"), 'a GOOD não agenda as devoluções do TikTok fora do galpão');
  assert.ok(/mlSyncFees: \(\) => mlSyncFees\(60\),/.test(gs), 'a pesca de tarifas da noite da GOOD não é de 60 dias');
  console.log('ok — devoluções do TikTok em peça única: coleta e linha do tempo iguais nas madrugadas, e a GOOD ganha; pesca da GOOD em 60 dias');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
