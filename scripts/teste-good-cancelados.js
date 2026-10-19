'use strict';
/* 19/10 — a GOOD ganha a varredura de vendas canceladas (a MESMA peça da AMB e da Girassol, lib/imposto-cancelados).
   Antes, venda cancelada depois de entrar seguia contando como faturamento, imposto e margem no painel da GOOD. Prova:
   1) o contexto da GOOD tem TODOS os campos que a peça usa (lidos da própria peça — se ela passar a usar outro, cai aqui);
   2) o contexto DE PRODUÇÃO (recortado do módulo) consulta a Shopee pela loja DA GOOD, monta o índice por nº do pedido
      em ARRAY (duplicata do Bling não some) e grava o tombstone;
   3) montando o módulo de produção (cache temporário, sem rede): o status da varredura responde (não semPeca);
   4) o agendamento: 1x/dia, primeiro tiro empurrado pra fora do horário do galpão. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'good-canc-'));
process.env.GOODBKP_CACHE_DIR = dir;
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede no teste'); } };

let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
(async () => {
  const src = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const i = src.indexOf('const _ctxCancGood = {'); assert.ok(i > 0, 'o contexto de cancelados da GOOD sumiu');
  const fimCtx = src.indexOf('\n};\n', i) + 3;
  const blocoCtx = src.slice(i, fimCtx);
  // 1) todos os campos que a peça usa
  const lib = fs.readFileSync(path.join(raiz, 'lib', 'imposto-cancelados.js'), 'utf8');
  const iV = lib.indexOf('async function varrerCancelados'); const jV = lib.indexOf('\nasync function ', iV + 10);
  const usados = [...new Set((lib.slice(iV, jV > 0 ? jV : lib.length).match(/ctx\.([A-Za-z_]+)/g) || []).map(x => x.slice(4)))];
  assert.ok(usados.length >= 6, 'não achei o que a peça usa do contexto');
  for (const c of usados) assert.ok(new RegExp('(^|\\n)\\s*(get\\s+)?' + c + '\\b').test(blocoCtx), 'o contexto da GOOD não tem ' + c + ' (a peça usa)');
  // 2) o contexto DE PRODUÇÃO, rodando
  const chamadas = []; const disco = {};
  const ctx = new Function('readJson', 'writeJson', 'path', 'CACHE_DIR', 'CONFERIDOS_FILE', 'fetch', 'blingGet', 'garantirToken', 'DEFAULT_ALIQ_BK_GOOD', '_histCacheGood', 'require', 'console',
    'let _sitCancelGood = null;\n' + blocoCtx + '\nreturn _ctxCancGood;')(
    (p, d) => (p in disco ? JSON.parse(JSON.stringify(disco[p])) : d), (p, v) => { disco[p] = JSON.parse(JSON.stringify(v)); }, path, '/c', '/c/_conferidos.json',
    async (u) => { chamadas.push(String(u)); return { ok: true, status: 200, json: async () => ({ ok: true, order_sns: ['251019AAA'] }) }; },
    async () => ({ ok: true }), async () => 'tk', 4, {}, require, { log() {} });
  const antes = process.env.GOODBKP_SHOPEE_SYNC_KEY; process.env.GOODBKP_SHOPEE_SYNC_KEY = 'kg';
  const sns = await ctx.canceladosNoMarketplace(30);
  if (antes === undefined) delete process.env.GOODBKP_SHOPEE_SYNC_KEY; else process.env.GOODBKP_SHOPEE_SYNC_KEY = antes;
  assert.deepStrictEqual(sns, ['251019AAA']);
  assert.ok(/\/good\/interno\/cancelados\?dias=30&k=kg$/.test(chamadas[0]), 'a Shopee não foi consultada pela loja da GOOD: ' + chamadas[0]);
  disco['/c/_vendas_dia.json'] = { a: { numero_loja: '251019AAA', id: 1 }, b: { numero_loja: '251019AAA', id: 2 }, c: { numero_loja: '2000', id: 3 } };
  const idx = ctx.indicePorNumeroLoja();
  assert.strictEqual(idx['251019AAA'].length, 2, 'duplicata do Bling sumiu do índice (tem que ser ARRAY)');
  /* Codex #716: grava RELENDO o arquivo — campo/venda nova que o vendasSync gravou no meio não se perde, só as marcas entram */
  idx.__arquivo.a.cancelado_mkt = 1; idx.__arquivo.a.situacao = 'Cancelado na Shopee';
  disco['/c/_vendas_dia.json'].a.campo_novo = 'do sync'; disco['/c/_vendas_dia.json'].z = { numero_loja: '9' };
  ctx.gravarIndice(idx);
  const dia = disco['/c/_vendas_dia.json'];
  assert.strictEqual(dia.a.cancelado_mkt, 1, 'a marca de cancelamento não foi gravada no arquivo do dia');
  assert.strictEqual(dia.a.campo_novo, 'do sync', 'gravarIndice apagou o que o vendasSync gravou (tem que reler antes de gravar)');
  assert.ok(dia.z, 'gravarIndice apagou uma venda nova do arquivo');
  /* Codex #716: tombstone + espelho no CONFERIDOS por numero_loja (o histórico não pode mostrar como ativo) */
  disco['/c/_conferidos.json'] = { x: { numero: '1', numero_loja: '251019AAA' }, y: { numero: '2', numero_loja: '2000' } };
  ctx.marcarCanceladoMkt('251019AAA'); assert.ok(disco['/c/_cancelados_shopee.json']['251019AAA'], 'o tombstone não foi gravado');
  assert.strictEqual(disco['/c/_conferidos.json'].x.cancelado, 1, 'o cancelamento não foi espelhado no CONFERIDOS');
  assert.ok(!disco['/c/_conferidos.json'].y.cancelado, 'espelhou no pedido errado');
  // 3) o módulo de produção: o status da varredura responde
  const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  const u = new URL('http://x/good-checkout-offline/varrer-cancelados-status?k=' + encodeURIComponent(process.env.ADMIN_KEY));
  const tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
  const j = (() => { try { return JSON.parse(res._b); } catch (e) { return null; } })();
  assert.ok(tratou === true && j && j.ok === true && 'status' in j, 'GOOD: o status da varredura não respondeu: ' + res._b.slice(0, 160));
  // 4) agendamento
  assert.ok(/const _rodarCancGood = \(\) => \{[\s\S]*?janelaRotinaPesada\(\)[\s\S]*?\};/.test(src), 'GOOD: o disparo diário não reconfere o horário do galpão (Codex #716)');
  assert.ok(/const varrerCancelados = async[\s\S]*?reservarVagaBackfill[\s\S]*?finally \{ gbo\.liberarVagaBackfill\(\)/.test(src), 'GOOD: a varredura não pega/libera a vaga do backfill (Codex #716)');
  assert.ok(/setTimeout\(\(\) => \{ try \{ _rodarCancGood\(\); \} catch \(e\) \{\} \}, require\('\.\.\/lib\/checkout\/contexto-fundo'\)\.adiarForaDoGalpao\(15 \* 60 \* 1000\)\);/.test(src)
    && /setInterval\(\(\) => \{ try \{ _rodarCancGood\(\); \} catch \(e\) \{\} \}, 24 \* 3600 \* 1000\);/.test(src), 'GOOD: a varredura não está agendada 1x/dia fora do galpão');
  fs.rmSync(dir, { recursive: true, force: true });
  _fim = true;
  console.log('ok — GOOD: varredura de cancelados com a peça da AMB/Girassol — contexto completo, Shopee pela loja dela, índice em array, status no painel, 1x/dia');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
