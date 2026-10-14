'use strict';
// 13/10 — a fabrica fiscal (F1/F2/F3/Corrigir-NFs das 3 empresas) pede a vez ao porteiro como OPERACAO.
const fs = require('fs'); const os = require('os'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
process.env.BLING_RITMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpv-'));
const P = require('../bling-ritmo.js')._interno;
let agora = Date.parse('2026-10-13T16:00:00Z'); P._agoraRef.fn = () => agora;
const { emFundo } = require('../lib/checkout/contexto-fundo.js');
const { criarPorteiroFiscal } = require('../lib/fiscal/porteiro-fiscal.js');
let status = 200; const urls = [];
require.cache[require.resolve('node-fetch')] = { id: 'nf', filename: 'nf', loaded: true, exports: async (u) => { urls.push(u); return { status, ok: status < 300, headers: { get: () => '' }, json: async () => ({ data: [] }), text: async () => '{}' }; } };
(async () => {
  const pf = criarPorteiroFiscal('GIRASSOL', { sleep: async () => {} });
  const f = await emFundo('girassol.expediente', () => pf.vez());
  const est = P.estado('girassol');
  ok(f && est.por_servico['girassol.expediente'] && est.por_servico['girassol.expediente'].permitidas === 1, '⚠️ a rotina da fabrica pede a vez com o NOME dela (girassol.expediente)');
  for (let i = 0; i < 3; i++) P.aviso429('girassol', '', 'fundo', 'outro');
  agora += 400 * 1000;
  const deg0 = P.estado('girassol').degrau;
  const f2 = await pf.vez(); pf.ok(f2);
  ok(deg0 > 0 && P.estado('girassol').degrau === 0, '  sucesso com a ficha zera o degrau');
  // operacao com o porteiro negando: nunca segura mais de 20 s
  let t = 0; const pf2 = criarPorteiroFiscal('GIRASSOL', { sleep: async (ms) => { t += ms; }, agora: () => agora + t });
  P.aviso429('girassol', '60', 'operacao', 'x');   // pausa de operacao de 60 s
  const f3 = await pf2.vez();
  ok(f3 === null && t >= 19000 && t <= 22000, '⚠️ operacao nunca fica presa mais de ~20 s esperando a vez (' + t + ' ms)');
  // a fabrica de PRODUCAO pede a vez em cada chamada
  agora += 120 * 1000;
  const api = require('../lib/fiscal/bling-api.js').criarBlingApi({ rotulo: 'GIRASSOL', envPausaMs: 'X1', envGetPausaMs: 'X2', envMaxPaginas: 'X3', envMaxPaginasNfe: 'X4', envJanelaUltimosDias: 'X5', envMeLojaIds: 'X6', envSituacaoAguardando: 'X7' });
  const antes = (P.estado('girassol').por_servico['girassol.f3'] || { permitidas: 0 }).permitidas;
  await emFundo('girassol.f3', () => api.getPedidoDetalhe('tk', 123).catch(() => null));
  const depois = (P.estado('girassol').por_servico['girassol.f3'] || { permitidas: 0 }).permitidas;
  ok(depois === antes + 1 && urls.length >= 1, '⚠️ a fabrica de producao (bling-api) pede a vez antes de chamar o Bling');
  const nf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'nf-bling-api.js'), 'utf8');
  ok((nf.match(/_porteiro\.chamar\(\(\) => fetch\(url/g) || []).length === 2 && /const _ficha = await _porteiro\.vez\(\);/.test(nf), '  a fabrica de NF tambem (fetchComRetryNF + PUT da NF + enviar NF)');
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
