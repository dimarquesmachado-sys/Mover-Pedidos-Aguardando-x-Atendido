'use strict';
/* 14/10 — TELA ÚNICA: a GOOD passa a ser servida a partir da tela da AMB (lib/checkout/dashboard-modelo.js).
   Prova: (1) a tela gerada chama SÓ rotas da GOOD, com as alíquotas que a GOOD passar, e todos os
   scripts embutidos compilam; (2) se o modelo mudar e uma troca não bater, a geração LANÇA — nunca
   sai tela meio-trocada; (3) a rota /dashboard da GOOD serve a tela nova, /dashboard-antigo a antiga,
   e com o modelo quebrado a rota CAI na antiga em vez de quebrar. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
process.env.GOODBKP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmg-'));
process.env.ADMIN_KEY = 'chave-teste';
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
const { gerarPainel, MODELO } = require('../lib/checkout/dashboard-modelo');

const ALIQ = { '2026-01': 11.819396, '2026-08': 14.9946 };
const cfg = { prefixo: '/good-checkout-offline', nome: 'GOOD Import', slugMagalu: 'good', defaultAliq: ALIQ, aliqPadrao: 15, logoEmoji: '📦', selo: 'G',
  capacidades: { vendasSync: false, shopeeResumo: false }, manifesto: false, projecaoMes: true };
const scripts = (h) => [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

(async () => {
  // 1) tela gerada
  const h = gerarPainel(cfg);
  assert.ok(/const MOD = '\/good-checkout-offline';/.test(h) && /const BASE = '\/good-checkout-offline';/.test(h));
  assert.ok(!/amb-checkout-offline/.test(h), 'sobrou rota da AMB');
  assert.ok(/<title>Inteligência de Vendas · GOOD Import<\/title>/.test(h) && /Inteligência de Vendas · GOOD Import/.test(h));
  /* Codex #695 (P1): mês sem apuração usa o PADRÃO do backend da empresa (15%), não herda agosto */
  const _dA = JSON.parse((h.match(/const DEFAULT_ALIQ = (\{[^\n]*?\});/) || [])[1] || 'null');
  assert.ok(_dA, 'DEFAULT_ALIQ não achado');
  assert.strictEqual(_dA['2026-01'], 11.819396); assert.strictEqual(_dA['2026-08'], 14.9946);
  assert.strictEqual(_dA['2026-09'], 15, 'setembro tinha que sair 15 (padrão do backend), não herdar agosto');
  assert.strictEqual(_dA[(new Date().getFullYear() + 1) + '-12'], 15);
  assert.ok(/'\/magalu\/ir\/good\?n='/.test(h), 'link do Magalu da empresa');
  assert.ok(/const DASH_BUILD = 'G-[^']+';/.test(h), 'selo de versão');
  const blocos = scripts(h); assert.ok(blocos.length >= 1);
  blocos.forEach((js, i) => { try { new vm.Script(js); } catch (e) { assert.fail('script embutido ' + i + ' não compila: ' + e.message); } });
  // Codex #695: capacidades — o que a GOOD não tem vira aviso, sem chamar a rota
  assert.ok(/window\.__CAPAC = \{"vendasSync":false,"shopeeResumo":false\}/.test(h));
  assert.ok(!/manifest\.webmanifest/.test(h), 'manifesto anunciado sem rota');
  assert.ok(/<div id="projecaoMesAqui"/.test(h) && /<script src="\/good-checkout-offline\/js\/projecao-mes\.js" defer><\/script>/.test(h), 'a projeção do mês da GOOD sumiu');
  const pegaFn = (assin) => { const i = h.indexOf(assin); assert.ok(i >= 0, assin); return h.slice(i, h.indexOf('\n}\n', i) + 2); };
  { const els = {}; const el = (id) => (els[id] = els[id] || { innerHTML: '' }); const chamadas = [];
    const ctx = new Function('window', 'document', 'fetch', 'intervalo', pegaFn('async function sincVendas(btn){') + '\n' + pegaFn('async function carregarDespesasShopee(){') + '\nreturn { sincVendas, carregarDespesasShopee };')(
      { __CAPAC: { vendasSync: false, shopeeResumo: false } }, { getElementById: el }, async (u) => { chamadas.push(u); return { json: async () => ({}) }; }, () => ({ de: '2026-10-01', ate: '2026-10-14' }));
    const btn = { disabled: false, textContent: '' };
    await ctx.sincVendas(btn); await ctx.carregarDespesasShopee();
    assert.deepStrictEqual(chamadas, [], 'chamou rota que a GOOD não tem: ' + chamadas.join(', '));
    assert.ok(/não ligada/.test(btn.textContent) && btn.disabled, 'o botão de atualizar tem que dizer que a venda do dia não está ligada');
    assert.ok(/não é coletado/.test(el('shpCards').innerHTML), 'a seção da Shopee tem que dizer que não é coletada'); }
  assert.ok(/\.filter\(function \(par\) \{ return !\(window\.__CAPAC && window\.__CAPAC\.shopeeResumo === false && par\[0\] === 'dsScript'\); \}\)/.test(h), 'a peça da Shopee não pode ser injetada sem a capacidade');
  // sem capacidades declaradas, nada muda (a tela da AMB se comporta como a da AMB)
  const hPadrao = gerarPainel({ prefixo: '/good-checkout-offline', nome: 'Teste', slugMagalu: 'good', defaultAliq: ALIQ, logoEmoji: 'x' });
  assert.ok(/window\.__CAPAC = \{"vendasSync":true,"shopeeResumo":true\}/.test(hPadrao) && /manifest\.webmanifest/.test(hPadrao) && !/projecaoMesAqui/.test(hPadrao));
  // a tela é a da AMB: as mesmas seções
  const amb = fs.readFileSync(MODELO, 'utf8');
  const secoes = (x) => (x.match(/<h2[^>]*>/g) || []).length;
  assert.strictEqual(secoes(h), secoes(amb), 'a tela gerada perdeu/ganhou seção em relação à da AMB');

  // 2) modelo que mudou: a geração lança (troca que some, troca que dobra)
  const _rfs = fs.readFileSync;
  const comModelo = (mut, fn) => { fs.readFileSync = function (f, ...r) { const t = _rfs.call(fs, f, ...r); return path.resolve(String(f)) === path.resolve(MODELO) ? mut(String(t)) : t; }; try { return fn(); } finally { fs.readFileSync = _rfs; } };
  let n = 0;
  for (const [rot, mut] of [['link do Magalu sumiu', (t) => t.replace("'/magalu/ir/amb?n='", "'/magalu/ir/x?n='")],
                            ['cabeçalho em dobro', (t) => t + "\n'<h1><img class=\"logo\" src=\"icone.png?v='+DASH_BUILD+'\" alt=\"AMBTotal\" style=\"object-fit:cover\"> Inteligência de Vendas · AMBTotal'"],
                            ['rota da AMB fora do padrão', (t) => t.replace("const MOD = '/amb-checkout-offline';", "const MOD = '/amb-checkout-offline' + '';\nfetch('/amb' + '-checkout-offline/x'); const _z='AMBTotal';")]]) {
    assert.throws(() => comModelo(mut, () => gerarPainel(Object.assign({}, cfg, { nome: 'GOOD Import ' + (++n) }))), /modelo do painel mudou|sobrou referência/, rot);
  }

  // 3) a rota da GOOD
  const mod = require(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));
  const pedir = async (rota) => { const u = new URL('http://x' + rota + '?k=chave-teste'); const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return res; };
  let r = await pedir('/good-checkout-offline/dashboard');
  assert.strictEqual(r._s, 200); assert.ok(/const MOD = '\/good-checkout-offline';/.test(r._b) && /Inteligência de Vendas · GOOD Import/.test(r._b), 'a rota não serviu a tela única');
  assert.ok(/const DEFAULT_ALIQ = \{"2026-01":11\.819396/.test(r._b), 'a rota não passou as alíquotas da GOOD');
  assert.ok(/"2026-09":15/.test(r._b), 'a rota não completou setembro com o padrão de 15%');
  r = await pedir('/good-checkout-offline/js/projecao-mes.js');
  assert.strictEqual(r._s, 200, 'a peça da projeção do mês tem que ser servida pra GOOD');
  r = await pedir('/good-checkout-offline/dashboard-antigo');
  assert.strictEqual(r._s, 200); assert.ok(/id="build">g\d+</.test(r._b), '/dashboard-antigo não serviu a tela antiga');
  // modelo quebrado: a rota cai na tela antiga
  const comModeloAsync = async (mut, fn) => { fs.readFileSync = function (f, ...rr) { const t = _rfs.call(fs, f, ...rr); return path.resolve(String(f)) === path.resolve(MODELO) ? mut(String(t)) : t; }; try { return await fn(); } finally { fs.readFileSync = _rfs; } };
  r = await comModeloAsync((t) => t.replace("'/magalu/ir/amb?n='", "'/magalu/ir/zz?n='"), () => pedir('/good-checkout-offline/dashboard'));
  assert.strictEqual(r._s, 200); assert.ok(/id="build">g\d+</.test(r._b), 'com o modelo quebrado a rota tinha que cair na tela antiga');
  console.log('ok — tela única da GOOD gerada da tela da AMB (só rotas da GOOD, alíquotas dela, scripts compilam); modelo que muda lança; a rota cai na antiga se precisar');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
