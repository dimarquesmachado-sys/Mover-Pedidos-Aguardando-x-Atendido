'use strict';
/* 19/10 — varredura de cancelados por empresa: UM ligador (lib/checkout/cancelados-empresa) pras três — a AMB e a
   Girassol trocam a cópia do contexto, a GOOD ganha a varredura. Prova, com as peças DE PRODUÇÃO:
   1) o contexto tem TUDO que a regra (lib/imposto-cancelados) usa — lido da própria regra;
   2) nas três: a Shopee é consultada pela loja e pela chave DAQUELA empresa; índice em array (duplicata não some);
   3) Codex #716 — gravação do arquivo do dia SÓ com as marcas: o que a venda do dia gravou no meio sobrevive e linha
      podada não ressuscita; e a venda do dia (peça de produção) devolve as marcas que achar no disco;
   4) Codex #716 — o cancelamento vai pros FINALIZADOS (conferidos) pelo nº do pedido na loja, além do tombstone;
   5) Codex #716 — o diário ancorado: deploy ao meio-dia ⇒ 1º tiro às 18h05, o intervalo nasce dele, e execução que cair
      no horário do galpão reagenda em vez de rodar;
   6) as três ligadas (sem cópia de contexto sobrando), e o status da varredura responde no módulo de produção da GOOD. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarCanceladosDaEmpresa } = require('../lib/checkout/cancelados-empresa');

let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
const disco = () => { const m = {}; return { m, readJson: (p, d) => (p in m ? JSON.parse(JSON.stringify(m[p])) : d), writeJson: (p, v) => { m[p] = JSON.parse(JSON.stringify(v)); } }; };

(async () => {
  // 1) tudo que a regra usa
  const lib = fs.readFileSync(path.join(raiz, 'lib', 'imposto-cancelados.js'), 'utf8');
  const usados = [...new Set((lib.match(/ctx\.([A-Za-z_]+)/g) || []).map(x => x.slice(4)))];
  const lig = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'cancelados-empresa.js'), 'utf8');
  const iC = lig.indexOf('const ctx = {'); const blocoCtx = lig.slice(iC, lig.indexOf('\n  };\n', iC));
  for (const u of usados) assert.ok(new RegExp('\\n\\s*(get\\s+)?' + u + '\\b').test(blocoCtx), 'o contexto do ligador não tem ' + u + ' (a regra usa)');

  // 2) as três: loja e chave da empresa; índice em array
  const salvo = { ...process.env };
  for (const [emp, loja, envK] of [['girassol', 'girassol', 'GBO_SHOPEE_SYNC_KEY'], ['amb', 'amb', 'AMBBKP_SHOPEE_SYNC_KEY'], ['good', 'good', 'GOODBKP_SHOPEE_SYNC_KEY']]) {
    const dk = disco(); const urls = [];
    const L = criarCanceladosDaEmpresa(emp, { deps: () => ({ CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conf.json', path, readJson: dk.readJson, writeJson: dk.writeJson,
      fetch: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ ok: true, order_sns: ['SN1'] }) }; } }) });
    process.env[envK] = 'chave-' + emp;
    assert.deepStrictEqual(await L.ctx.canceladosNoMarketplace(30), ['SN1']);
    assert.ok(urls[0].includes('/' + loja + '/interno/cancelados?dias=30&k=chave-' + emp), emp + ': Shopee consultada fora da loja/chave dela: ' + urls[0]);
    delete process.env[envK];
    dk.m['/c/_vendas_dia.json'] = { a: { numero_loja: 'SN1', numero: 1 }, b: { numero_loja: 'SN1', numero: 2 } };
    assert.strictEqual(L.ctx.indicePorNumeroLoja().SN1.length, 2, emp + ': duplicata sumiu do índice');
    assert.strictEqual(L.empresa, loja);
  }
  for (const k of Object.keys(process.env)) if (!(k in salvo)) delete process.env[k];

  // 3) gravação só com as marcas (Codex #716)
  { const dk = disco();
    const L = criarCanceladosDaEmpresa('good', { deps: () => ({ CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conf.json', path, readJson: dk.readJson, writeJson: dk.writeJson }) });
    dk.m['/c/_vendas_dia.json'] = { a: { numero_loja: 'SN1', total: 10 }, z: { numero_loja: 'SN9', total: 5 } };
    const idx = L.ctx.indicePorNumeroLoja();                       // a varredura lê o retrato…
    dk.m['/c/_vendas_dia.json'] = { a: { numero_loja: 'SN1', total: 99 }, n: { numero_loja: 'SN2', total: 7 } };   // …a venda do dia grava no meio (podou z, mudou a, trouxe n)
    for (const v of idx.SN1) { v.cancelado_mkt = 1; v.situacao = 'Cancelado na Shopee'; v.escrow_final = 1; }
    idx.__arquivo.z.cancelado_mkt = 1;                              // marca numa linha que a venda do dia podou
    L.ctx.gravarIndice(idx);
    const f = dk.m['/c/_vendas_dia.json'];
    assert.strictEqual(f.a.total, 99, 'a gravação apagou o que a venda do dia gravou no meio');
    assert.ok(f.n, 'a gravação apagou a venda nova que a venda do dia trouxe no meio');
    assert.ok(!f.z, 'a gravação ressuscitou uma linha podada');
    assert.deepStrictEqual([f.a.cancelado_mkt, f.a.situacao, f.a.escrow_final], [1, 'Cancelado na Shopee', 1], 'as marcas não foram aplicadas'); }
  // 3b) a venda do dia (peça de produção) devolve as marcas que achar no disco
  { const { criarVendasSync } = require('../lib/checkout/vendas-dia');
    const dk = disco(); let leituras = 0;
    dk.m['/c/_vendas_dia.json'] = { '77': { id: 77, numero: 77, numero_loja: 'SNX', data: new Date().toISOString().slice(0, 10), marketplace: 'shopee', total: 5 } };
    const readJson = (p, d) => { const r = dk.readJson(p, d); if (p === '/c/_vendas_dia.json' && ++leituras === 1) { const m2 = dk.readJson(p, {}); m2['77'].cancelado_mkt = 1; m2['77'].situacao = 'Cancelado na Shopee'; dk.writeJson(p, m2); } return r; };
    const vs = criarVendasSync({ tag: 'T', magEmpresa: () => 'x', mlTokenManager: () => ({ garantirTokenML: async () => null }), tiktokConta: 'x', shopeeUrl: () => 'http://x', shopeeKey: () => '', shopeeLoja: () => 'x',
      deps: () => ({ CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conf.json', LOJA_MKT: {}, _faseDireta: async () => {}, _inferCanal: () => 'outro', _vsy: {}, blingGet: async () => ({ ok: true, data: { data: [] } }),
        buscarDevolucoesML: async () => [], json: () => {}, magaluFreteProvisorio: async () => null, magaluFreteSkuGravar: () => {}, nfDoPedido: async () => null, path, pescarDadosML: async () => null, readJson, writeJson: dk.writeJson }),
      fetch: async () => ({ ok: false, status: 404, json: async () => null }) });
    await vs();
    const f = dk.m['/c/_vendas_dia.json'] || {};
    assert.ok(f['77'] && f['77'].cancelado_mkt === 1 && /Cancelado/.test(f['77'].situacao), 'a venda do dia apagou a marca de cancelado gravada no meio da rodada: ' + JSON.stringify(f['77'])); }

  // 4) finalizados + tombstone
  { const dk = disco();
    const L = criarCanceladosDaEmpresa('amb', { deps: () => ({ CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conf.json', path, readJson: dk.readJson, writeJson: dk.writeJson }) });
    dk.m['/c/conf.json'] = { p1: { numero_loja: 'SN5', numero: 5 }, p2: { numero_loja: 'OUTRO' } };
    L.ctx.marcarCanceladoMkt('SN5');
    assert.ok(dk.m['/c/_cancelados_shopee.json'].SN5, 'tombstone não gravado');
    assert.strictEqual(dk.m['/c/conf.json'].p1.cancelado, 1, 'o cancelamento não foi pros finalizados');
    assert.ok(!dk.m['/c/conf.json'].p2.cancelado, 'marcou finalizado de outro pedido'); }

  // 5) diário ancorado
  { const { agendarDiarioForaDoGalpao } = require('../lib/checkout/contexto-fundo');
    let agora = new Date('2026-10-19T15:00:00Z');   /* 12:00 em São Paulo */
    const tim = []; const ints = []; let rodou = 0;
    agendarDiarioForaDoGalpao(() => { rodou++; }, 15 * 60000, { agoraFn: () => agora, setTimeout: (fn, ms) => tim.push({ fn, ms }), setInterval: (fn, ms) => ints.push({ fn, ms }) });
    assert.strictEqual(ints.length, 0, 'o intervalo nasceu no boot (tem que nascer do tiro adiado)');
    assert.strictEqual(tim[0].ms, (6 * 60 + 5) * 60000, 'o 1º tiro de um deploy ao meio-dia tinha que ir pras 18h05');
    agora = new Date('2026-10-19T21:05:00Z'); tim[0].fn();
    assert.strictEqual(rodou, 1); assert.strictEqual(ints.length, 1); assert.strictEqual(ints[0].ms, 24 * 3600000);
    agora = new Date('2026-10-20T15:00:00Z'); ints[0].fn();   /* intervalo batendo ao meio-dia (relógio deslizou) */
    assert.strictEqual(rodou, 1, 'rodou em pleno horário do galpão'); assert.strictEqual(tim[tim.length - 1].ms, (6 * 60 + 5) * 60000, 'não reagendou pra 18h05'); }

  // 6) as três ligadas, sem cópia sobrando; status no módulo de produção da GOOD
  for (const [arq, emp] of [['amb-checkout-offline/index.js', 'amb'], ['girassol-backup-offline/gbo-app.js', 'girassol'], ['good-checkout-offline/index.js', 'good']]) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(src.includes("require('../lib/checkout/cancelados-empresa').criarCanceladosDaEmpresa('" + emp + "', {"), arq + ': não usa o ligador');
    assert.ok(!/const _ctxImp = \{/.test(src) && !/canceladosNoMarketplace: async/.test(src), arq + ': sobrou cópia do contexto de cancelados');
  }
  assert.ok(/agendarDiarioForaDoGalpao\(_emFundo\(\(\) => varrerCancelados\(45, empresa\)\)/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'agendador.js'), 'utf8')), 'o agendador (AMB/Girassol) não usa o diário ancorado');
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'good-canc2-')); process.env.GOODBKP_CACHE_DIR = dir; process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';
    require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
    const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
    const handler = mod.routes(async () => ({}));
    const res = { _b: '', writeHead() {}, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const u = new URL('http://x/good-checkout-offline/varrer-cancelados-status?k=' + encodeURIComponent(process.env.ADMIN_KEY));
    const t = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    const j = (() => { try { return JSON.parse(res._b); } catch (e) { return null; } })();
    assert.ok(t === true && j && j.ok === true && 'status' in j, 'GOOD: o status da varredura não respondeu: ' + res._b.slice(0, 160));
    fs.rmSync(dir, { recursive: true, force: true }); }
  _fim = true;
  console.log('ok — cancelados por empresa: um ligador pras três, gravação só com as marcas, finalizados espelhados, diário ancorado fora do galpão');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
