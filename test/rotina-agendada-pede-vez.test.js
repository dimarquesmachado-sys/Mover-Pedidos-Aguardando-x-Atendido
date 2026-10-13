'use strict';
// 13/10 — rotinas AGENDADAS (noturna, backfill de NF...) pedem a vez ao porteiro como FUNDO; chamada da tela nao muda.
const fs = require('fs'); const os = require('os'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
process.env.BLING_RITMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-'));
const P = require('../bling-ritmo.js')._interno;
let agora = Date.parse('2026-10-13T08:00:00Z'); P._agoraRef.fn = () => agora;
const chamadas = [];
global.fetch = async (url) => { chamadas.push(url); return { ok: true, status: 200, text: async () => '{"data":[]}', headers: { get: () => '' } }; };   // a lib usa o fetch global
const fab = require('../lib/checkout/base-funcoes.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rap2-'));
const f = (n) => path.join(tmp, n);
const mk = (conta) => fab.criar({ tag: 'T', envOperadores: 'X', envAdmin: 'Y', BLING_BASE: 'https://bling', garantirToken: async () => 'tk', PAUSA_MS: 0, sleep: async () => {},
  MANIFEST_FILE: f('m.json'), SKU_EAN_FILE: f('s.json'), LOC_FILE: f('l.json'), EAN_INDEX_FILE: f('e.json'), RESERVAS_FILE: f('r.json'), RESGATES_FILE: f('g.json'), RESERVA_TTL_MS: 1000, contaPorteiro: conta });
(async () => {
  const fnG = mk('girassol');
  await fnG.blingGet('/nfe?pagina=1');   // TELA (sem contexto de fundo)
  const est0 = P.estado('girassol');
  ok(chamadas.length === 1 && !(est0.por_servico && est0.por_servico['girassol-backup-offline.backfillnf']), '⚠️ chamada da TELA nao pede vez ao porteiro (operacao segue igual)');
  const { AsyncLocalStorage } = require('async_hooks');
  const ctx = global.__ctxFundoBling;
  await ctx.run({ fundo: true, servico: 'girassol-backup-offline.backfillNF' }, () => fnG.blingGet('/nfe?pagina=2'));
  const est = P.estado('girassol');
  ok(est.por_servico['girassol-backup-offline.backfillnf'] && est.por_servico['girassol-backup-offline.backfillnf'].permitidas === 1, '⚠️ dentro da rotina agendada a chamada PEDE A VEZ ao porteiro, com o nome da rotina');
  const fnSem = mk(null);
  await ctx.run({ fundo: true, servico: 'x.y' }, () => fnSem.blingGet('/a'));
  ok(!P.estado('girassol').por_servico['x.y'], '  checkout sem contaPorteiro: nada muda');
  // Codex #672: a FICHA vai junto — o sucesso dentro da rotina zera o degrau (antes so descia pelo tempo)
  for (let i = 0; i < 3; i++) P.aviso429('girassol', '', 'fundo', 'outro');
  agora += 400 * 1000;   // passa a pausa (o degrau continua alto)
  const deg0 = P.estado('girassol').degrau;
  await ctx.run({ fundo: true, servico: 'girassol-backup-offline.noturna' }, () => fnG.blingGet('/x'));
  ok(deg0 > 0 && P.estado('girassol').degrau === 0, '⚠️ sucesso com a ficha da permissao ZERA o degrau (' + deg0 + ' -> ' + P.estado('girassol').degrau + ')');
  // Codex #672: o signal de quem chama corta a espera pelo porteiro
  for (let i = 0; i < 3; i++) P.aviso429('girassol', '', 'fundo', 'outro');   // pausa de fundo valendo
  const ac = new AbortController(); ac.abort();
  const antes = chamadas.length;
  const rAb = await ctx.run({ fundo: true, servico: 'girassol-backup-offline.backupcache' }, () => fnG.blingGet('/y', 3, ac.signal));
  ok(rAb && rAb.erro === 'abortado' && chamadas.length === antes, '  chamada cancelada (signal) nao fica presa esperando o porteiro');
  const ag = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'agendador.js'), 'utf8');
  ok(/const _st = \(fn, ms\) => \(st \|\| setTimeout\)\(_emFundo\(fn\), ms\);/.test(ag) && /const _si = \(fn, ms\) => \(si \|\| setInterval\)\(_emFundo\(fn\), ms\);/.test(ag), '⚠️ o trabalho do agendador dos checkouts tambem roda como FUNDO (Codex #672)');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok(/ctx\.run\(\{ fundo: true, servico: String\(empresa\.id \|\| empresa\.nome \|\| 'mp'\) \+ '\.' \+ label \}, \(\) => fn\(\)\)/.test(idx), '⚠️ o agendador roda cada rotina no contexto de FUNDO');
  for (const [arq, c] of [['girassol-backup-offline/base.js', 'girassol'], ['amb-checkout-offline/base.js', 'ambtotal'], ['good-checkout-offline/base.js', 'good']]) {
    ok(new RegExp("contaPorteiro: '" + c + "'").test(fs.readFileSync(path.join(__dirname, '..', arq), 'utf8')), '  ' + arq + ' liga o porteiro na conta ' + c);
  }
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
