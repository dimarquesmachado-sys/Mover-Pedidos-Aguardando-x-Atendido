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
  capacidades: { vendasSync: false, shopeeResumo: false, freteMagalu: false }, manifesto: false, projecaoMes: true };
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
  assert.ok(/window\.__CAPAC = \{"vendasSync":false,"shopeeResumo":false,"freteMagalu":false,"canario":false\}/.test(h));
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
  // Codex #695 r2: frete do Magalu sem a capacidade — sem leitura, sem POST, seletor escondido com aviso
  assert.ok(/if \(!\(window\.__CAPAC && window\.__CAPAC\.freteMagalu === false\)\) try\{ const rm = await fetch\(MOD\+'\/config-frete-magalu'/.test(h), 'leitura do frete Magalu sem trava');
  assert.ok(/if\(magSel && !\(window\.__CAPAC && window\.__CAPAC\.freteMagalu === false\)\)\{ try\{ await fetch\(MOD\+'\/config-frete-magalu'/.test(h), 'POST do frete Magalu sem trava');
  assert.ok(/a previsão do frete ainda não está ligada nesta empresa/.test(h), 'aviso do frete Magalu');
  // Codex #695 r2: nome com apóstrofo, barra e tag não quebra o script da tela
  const hNome = gerarPainel(Object.assign({}, cfg, { nome: "D'Casa \\ <b>x</b>" }));
  scripts(hNome).forEach((js, i) => { try { new vm.Script(js); } catch (e) { assert.fail("nome com apóstrofo quebrou o script " + i + ': ' + e.message); } });
  // sem capacidades declaradas, nada muda (a tela da AMB se comporta como a da AMB)
  const hPadrao = gerarPainel({ prefixo: '/good-checkout-offline', nome: 'Teste', slugMagalu: 'good', defaultAliq: ALIQ, logoEmoji: 'x' });
  assert.ok(/window\.__CAPAC = \{"vendasSync":true,"shopeeResumo":true,"freteMagalu":true,"canario":false\}/.test(hPadrao) && /manifest\.webmanifest/.test(hPadrao) && !/projecaoMesAqui/.test(hPadrao));
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
  const handler = mod.routes(require('../lib/http').readBody);   /* o readBody de verdade: o POST de config lê o corpo */
  const pedir = async (rota) => { const u = new URL('http://x' + rota + '?k=chave-teste'); const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return res; };
  let r = await pedir('/good-checkout-offline/dashboard');
  assert.strictEqual(r._s, 200); assert.ok(/const MOD = '\/good-checkout-offline';/.test(r._b) && /Inteligência de Vendas · GOOD Import/.test(r._b), 'a rota não serviu a tela única');
  assert.ok(/const DEFAULT_ALIQ = \{"2026-01":11\.819396/.test(r._b), 'a rota não passou as alíquotas da GOOD');
  assert.ok(/"2026-09":15/.test(r._b), 'a rota não completou setembro com o padrão de 15%');
  r = await pedir('/good-checkout-offline/js/projecao-mes.js');
  assert.strictEqual(r._s, 200, 'a peça da projeção do mês tem que ser servida pra GOOD');
  // Codex #695 r2: o Flex da tela única (ml/shopee/outros) é aceito pela GOOD; 'outros' aposenta o 'geral' antigo
  { const { Readable } = require('stream');
    const postar = async (rota, corpo) => { const u = new URL('http://x' + rota + '?k=chave-teste'); const req = Readable.from([Buffer.from(JSON.stringify(corpo))]);
      req.method = 'POST'; req.url = u.pathname + u.search; req.headers = { 'content-type': 'application/json' };
      const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } }; await handler(req, res, u); return res; };
    let rp = await postar('/good-checkout-offline/config-fiscal', { flex: { geral: 5 } }); assert.strictEqual(rp._s, 200, rp._b.slice(0, 160));
    rp = await postar('/good-checkout-offline/config-fiscal', { flex: { ml: 10, shopee: 8, outros: 7 } }); assert.strictEqual(rp._s, 200, rp._b.slice(0, 160));
    const rg = await pedir('/good-checkout-offline/config-fiscal'); const cf = JSON.parse(rg._b).config || {};
    assert.deepStrictEqual(cf.flex, { ml: 10, shopee: 8, outros: 7 }, 'Flex gravado: ' + JSON.stringify(cf.flex));
    // Codex #695 r3: campo limpo (null) APAGA o override — não grava zero
    rp = await postar('/good-checkout-offline/config-fiscal', { flex: { ml: null } }); assert.strictEqual(rp._s, 200);
    const cf2 = JSON.parse((await pedir('/good-checkout-offline/config-fiscal'))._b).config || {};
    assert.deepStrictEqual(cf2.flex, { shopee: 8, outros: 7 }, 'campo limpo tinha que apagar o ml: ' + JSON.stringify(cf2.flex)); }
  // Codex #695 r3: o formulário de Flex nasce do 'geral' antigo (o mesmo que a conta usa)
  assert.ok(/CFG\.flex\.geral != null\) \? CFG\.flex\.geral/.test(h), '"Demais canais" tem que partir do geral antigo');
  // Codex #695 r3: o /historico da GOOD é o compartilhado (com custo pronto), não o cru que o escondia
  assert.ok(!/p === '\/good-checkout-offline\/historico'\) \{\s*const conf/.test(fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8')), 'sobrou o /historico cru da GOOD');
  r = await pedir('/good-checkout-offline/historico'); assert.ok(r._s === 401 || r._s === 200, 'historico: ' + r._s);
  /* 29/10: a tela velha da GOOD saiu — /dashboard-antigo LEVA pra tela única (o endereço salvo continua funcionando) */
  r = await pedir('/good-checkout-offline/dashboard-antigo');
  assert.strictEqual(r._s, 302, '/dashboard-antigo tinha que levar pra tela única: ' + r._s);
  /* 29/10: modelo quebrado → erro CLARO (500), como na Girassol e na AMB — a tela velha de reserva saiu */
  const comModeloAsync = async (mut, fn) => { fs.readFileSync = function (f, ...rr) { const t = _rfs.call(fs, f, ...rr); return path.resolve(String(f)) === path.resolve(MODELO) ? mut(String(t)) : t; }; try { return await fn(); } finally { fs.readFileSync = _rfs; } };
  r = await comModeloAsync((t) => t.replace("'/magalu/ir/amb?n='", "'/magalu/ir/zz?n='"), () => pedir('/good-checkout-offline/dashboard'));
  assert.strictEqual(r._s, 500, 'com o modelo quebrado a rota tinha que dar erro claro: ' + r._s);
  assert.ok(/painel: /.test(r._b), 'o erro não diz que foi a geração do painel: ' + String(r._b).slice(0, 120));
  console.log('ok — tela única da GOOD gerada da tela da AMB (só rotas da GOOD, alíquotas dela, scripts compilam); modelo que muda lança; /dashboard-antigo leva pra tela única');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
