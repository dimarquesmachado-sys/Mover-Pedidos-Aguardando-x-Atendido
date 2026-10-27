'use strict';
/* 27/10 — a GOOD ganha o módulo da Shopee (a peça única lib/checkout/shopee-empresa, a mesma da Girassol e da AMB): antes
   ela não tinha o resumo da Shopee no painel nem as coletas de devoluções, carteira e Ads. Prova:
   · o módulo da GOOD conversa com a loja DELA no serviço (/good/...), com as variáveis dela (GOODBKP_* → as gerais);
   · as rotas /good-checkout-offline/shopee/* respondem (só admin onde a peça exige) e vêm ANTES da fábrica do painel;
   · a madrugada da GOOD ganha as três coletas da Shopee; o card da Shopee do painel liga (capacidade shopeeResumo). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gshp-'));
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CONFERIDOS_FILE: path.join(dir, 'c.json'), CACHE_DIR: dir, readJson, writeJson: (a, v) => fs.writeFileSync(a, JSON.stringify(v)) };
  const log = [];
  const fakeFetch = async (url) => { log.push(String(url).replace(/k=[^&]+/, 'k=*')); return { status: 200, ok: true, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }; };
  process.env.ADMIN_KEY = 'adm-g'; process.env.GOODBKP_SHOPEE_SYNC_KEY = 'k-good'; delete process.env.GOODBKP_SHOPEE_SYNC_LOJA;
  // o embrulho da GOOD, com o base e o fetch de mentira
  const src = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'good-shopee.js'), 'utf8');
  assert.ok(/criarShopeeDaEmpresa\(\{/.test(src) && src.includes("prefixo: '/good-checkout-offline'") && src.includes("loja: process.env.GOODBKP_SHOPEE_SYNC_LOJA || 'good'") &&
    src.includes('process.env.GOODBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY'), 'good-shopee.js não é a peça com as variáveis da GOOD');
  const cfgShopee = new Function('process', 'return (' + /shopee: (\(\) => \(\{[\s\S]*?\}\)),\n/.exec(src)[1] + ')')(process)();
  const m = require('../lib/checkout/shopee-empresa').criarShopeeDaEmpresa({ base, prefixo: '/good-checkout-offline', shopee: () => cfgShopee, adsMaxDias: 180, fetch: fakeFetch });
  await m.escrowDoPedido('SNGOOD1');
  assert.ok(log.some((u) => u.includes('/good/interno/escrow/SNGOOD1') && u.includes('k=*')), 'o escrow da GOOD não foi na loja dela: ' + log.join(' ; '));
  const res = { c: 0, b: null };
  const tratou = await m.rotasShopee({ validarSessao: () => null })({ method: 'GET', headers: {} }, res, new URL('http://h/good-checkout-offline/shopee/status?k=adm-g'));
  assert.ok(tratou && res.c === 200 && res.b && /loja "good"/.test(String(res.b.quem_tem_o_token || '')), 'a rota de status da Shopee da GOOD não respondeu: ' + JSON.stringify(res.b).slice(0, 200));
  fs.rmSync(dir, { recursive: true, force: true });
  // o index da GOOD: rotas antes da fábrica, as coletas na madrugada
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const iR = gs.indexOf('if (await rotasShopeeGood({ validarSessao })(req, res, urlObj)) return true;'), iF = gs.indexOf('if (await _rotasPainelGood(req, res, p, method, urlObj)) return true;');
  assert.ok(iR > 0 && iF > iR, 'as rotas da Shopee da GOOD não vêm antes da fábrica do painel');
  for (const re of [/coletarDevolucoes: \(d\) => coletarDevolucoesShopeeGood\(d \|\| 45, pedirAoSyncShopeeGood\)/, /coletarCarteira: \(d\) => coletarCarteiraShopeeGood\(d \|\| 30, pedirAoSyncShopeeGood\)/, /coletarAds: \(d\) => coletarAdsShopeeGood\(d\)/]) {
    assert.ok(re.test(gs), 'a madrugada da GOOD não tem a coleta da Shopee: ' + re);
  }
  const emp = require('../lib/checkout/painel/empresas.js');
  const lista = Object.values(emp).find((v) => v && typeof v === 'object' && (v.good || (Array.isArray(v) && v.some((x) => x && x.id === 'good'))));
  const sE = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'empresas.js'), 'utf8');
  assert.ok(!/shopeeResumo: false/.test(sE), 'o card da Shopee do painel continua desligado em alguma empresa' + (lista ? '' : ''));
  console.log('ok — a GOOD ganhou a Shopee: a loja dela no serviço, as rotas antes da fábrica, as coletas na madrugada e o card no painel');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
