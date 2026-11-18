'use strict';
/* 14/10 — parecer do Codex (6.1, P1): o backfill da GOOD roda pela função da Girassol e gravava,
   como empresa='good', custo/comissão/frete tirados das fontes da GIRASSOL (linha do tempo de custo,
   billing ML, token ML, escrow Shopee, loja→canal, frete Magalu, contador) — e o cache das situações
   de cancelamento era um só pras duas contas. Três provas:
   1) o resolvedor (lib/checkout/backfill-deps.js) nunca entrega fonte da Girassol a outra empresa;
   2) o corpo do backfillVendas de PRODUÇÃO não tem atalho: toda fonte financeira passa pelo `_D`;
   3) garantirSitCancel de PRODUÇÃO (15/11: a peça lib/checkout/situacoes-cancelamento) guarda as situações POR EMPRESA. */
const assert = require('assert');
const fs = require('fs');
require('./_gbo-com-motor').instalar();   /* 13/11: o motor do histórico saiu do arquivo da Girassol pra lib/checkout/backfill-motor.js — este teste lê o arquivo COM o motor no lugar, tirado da peça viva */
const path = require('path');
const raiz = path.join(__dirname, '..');
const { resolverDepsBackfill, NOMES } = require('../lib/checkout/backfill-deps');

// 1) resolvedor
const GIR = {}; for (const n of NOMES) GIR[n] = 'GIRASSOL:' + n;
let d = resolverDepsBackfill('girassol', null, GIR, 'girassol');
for (const n of NOMES) assert.strictEqual(d[n], 'GIRASSOL:' + n, 'girassol sem contexto usa as próprias: ' + n);
d = resolverDepsBackfill('good', { custoVigenteEm: 'GOOD:custo' }, GIR, 'girassol');
assert.strictEqual(d.custoVigenteEm, 'GOOD:custo');
for (const n of NOMES.filter(x => x !== 'custoVigenteEm')) assert.strictEqual(d[n], null, 'GOOD recebeu fonte da Girassol: ' + n);
d = resolverDepsBackfill('good', null, GIR, 'girassol');
for (const n of NOMES) assert.strictEqual(d[n], null, 'GOOD sem contexto herdou da Girassol: ' + n);
d = resolverDepsBackfill('girassol', { escrowEmLote: null }, GIR, 'girassol');
assert.strictEqual(d.escrowEmLote, null, 'null explícito no contexto tem que valer'); assert.strictEqual(d.LOJA_MKT, 'GIRASSOL:LOJA_MKT');

// 2) o backfill de produção não fura o resolvedor
const src = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
const ini = src.indexOf('async function backfillVendas(de, ate, empresa, ctx){');
const fim = src.indexOf('\n}\n', ini);
let corpo = src.slice(ini, fim);
const bloco = corpo.indexOf("require('../lib/checkout/backfill-deps').resolverDepsBackfill(");
assert.ok(bloco > 0, 'o backfill não usa o resolvedor');
const fimBloco = corpo.indexOf("}, 'girassol');", bloco);
const guardaML = corpo.indexOf("if (empresa === 'girassol') {");
let semExcecoes = corpo.slice(0, bloco) + corpo.slice(fimBloco);
if (guardaML > 0) { const g2 = semExcecoes.indexOf("if (empresa === 'girassol') {"); semExcecoes = semExcecoes.slice(0, g2); }   // o trecho só-ML é guardado pela própria empresa
const proibidos = [/[^.\w]custoVigenteEm\(/, /[^.\w]_mapasBilling\(/, /girassol\/mlTokenManager/, /_tiktok_financeiro_girassol/, /[^.\w]escrowEmLote\(/,
  /[^.\w]escrowDoPedido\(/, /[^.\w]LOJA_MKT\[/, /[^.\w]magaluFreteSkuLer\(/, /[^.\w]supaCount\(/, /_sitCancel\./];
for (const re of proibidos) assert.ok(!re.test(semExcecoes), 'backfillVendas usa fonte da Girassol sem passar pelo contexto: ' + re);
assert.ok(/_D\.custoVigenteEm/.test(corpo) && /_D\.escrowDoPedido/.test(corpo) && /_D\.magaluFreteSkuLer/.test(corpo), 'as fontes têm que vir de _D');
assert.ok(/garantirSitCancel\(async p2 => await _blingGet\(p2\), empresa\)/.test(corpo), 'situações de cancelamento sem a empresa');

// 3) garantirSitCancel de produção, por empresa (15/11: a peça, carregada de novo a cada `mk` — cache e env próprios)
const srcSit = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'situacoes-cancelamento.js'), 'utf8');
const mk = (proc, cons) => { const module = { exports: {} }; new Function('process', 'console', 'module', 'require', srcSit)(proc, cons, module, require);
  return { garantirSitCancel: module.exports.garantirSitCancel, get girassol() { return module.exports.alvo('girassol'); } }; };
assert.ok(/situacoes-cancelamento'\)\.garantirSitCancel\(bg, 'good'\)/.test(fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8')), 'a GOOD tem que descobrir as situações DELA pela peça');
assert.ok(/const garantirSitCancel = _SIT\.garantirSitCancel;/.test(src), 'a Girassol tem que usar a mesma peça');
const fakeBg = (id) => async (p) => p === '/situacoes/modulos' ? { ok: true, data: { data: [{ id: 1, nome: 'Vendas' }] } } : { ok: true, data: { data: [{ id, nome: 'Cancelado' }, { id: 9, nome: 'Em aberto' }] } };
(async () => {
  const m = mk({ env: {} }, { log() {} });
  const g = await m.garantirSitCancel(fakeBg(111));
  const o = await m.garantirSitCancel(fakeBg(222), 'good');
  assert.deepStrictEqual(g.ids, [111]); assert.deepStrictEqual(o.ids, [222], 'a GOOD herdou as situações da Girassol');
  assert.deepStrictEqual(m.girassol.ids, [111], 'a GOOD sobrescreveu o cache da Girassol');
  assert.deepStrictEqual((await m.garantirSitCancel(fakeBg(333))).ids, [111], 'cache da Girassol (12h) deixou de valer');
  // env de fallback é só da Girassol
  const m2 = mk({ env: { GIRABKP_SIT_CANCELADO: '777' } }, { log() {} });
  const semMod = async () => ({ ok: true, data: { data: [] } });
  assert.deepStrictEqual((await m2.garantirSitCancel(semMod, 'good')).ids, [], 'a GOOD pegou o GIRABKP_SIT_CANCELADO');
  assert.deepStrictEqual((await m2.garantirSitCancel(semMod)).ids, [777]);

  // 4) a GOOD passa o MESMO contexto nos dois backfills, com as fontes dela e sem as que não tem
  const g4 = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  /* 14/10: o diário também usa o contexto — o que importa é que período E ano usem */
  /* 16/11 (montarCheckout, passo 9): o contexto é a peça lib/checkout/backfill-empresa; `_ctxBackfillGood()` devolve o dela e o ano
     (o plano) roda pelo backfill da mesma peça */
  const _BE = require('./_backfill-empresa');
  /* 17/11 (passo 22): o período (o backfill manual) é a peça rota-backfill-periodo, pela fábrica — a GOOD entrega o backfill da MESMA peça */
  assert.ok(/backfillVendas: \(de, ate\) => require\('\.\.\/lib\/checkout\/contexto-fundo'\)\.emFundo\('good', \(\) => _bfEmp\.backfillVendas\(de, ate\)\)/.test(g4) && /function _ctxBackfillGood\(\) \{ return _bfEmp\.ctx\(\); \}/.test(g4) && /\(\) => _bfEmp\.backfillVendas\(de, ate\)\); \}/.test(g4) && _BE.usaPeca(g4, 'good')   /* 15/10: o ano agora roda pelo plano automático */, 'período e ano têm que usar _ctxBackfillGood');
  /* o contexto DE VERDADE da peça declara cada dependência (nenhuma cai no padrão), montado com peças de mentira */
  { const pecas = {}; for (const n of require('../lib/checkout/backfill-empresa').PECAS) pecas[n] = n === 'reparoAtivo' ? () => false : (n === 'canario' ? { rodando: false } : {});
    const ctxR = require('../lib/checkout/backfill-empresa').criar({ empresa: 'good', pecas }).ctx();
    for (const n of NOMES) assert.ok(Object.prototype.hasOwnProperty.call(ctxR, n), 'o contexto da GOOD não declara ' + n + ' — cairia no padrão'); }
  assert.strictEqual(require('../lib/checkout/config-empresa').configCheckout('good').mlTokenManager, 'good/mlTokenManager', 'token da GOOD');
  assert.ok(!/girassol/.test(_BE.montagem(g4)), 'fontes da GOOD');
  console.log('ok — backfill da GOOD sem fonte da Girassol (resolvedor, corpo de produção, situações por empresa, contexto único)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
