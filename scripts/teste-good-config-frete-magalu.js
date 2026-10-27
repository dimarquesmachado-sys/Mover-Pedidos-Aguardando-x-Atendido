'use strict';
/* 19/10 — o ⚙️ "frete Magalu" do painel da GOOD (a tela é o modelo da AMB desde o #695) respondia semPeca: a fábrica só
   expõe a config pra empresa que a CONSOME. Desde o #714 a GOOD consome (a venda do dia calcula o frete provisório da
   Magalu pela lib/checkout/magalu-frete, que lê _config-frete-magalu.json). Prova, montando o módulo DE PRODUÇÃO da GOOD
   numa pasta de cache temporária e sem rede: GET devolve a config; POST salva; e o que foi salvo é o que a peça do
   frete lê. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'good-fm-'));
process.env.GOODBKP_CACHE_DIR = dir;
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede no teste'); } };

let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
(async () => {
  const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
  const base = require(path.join(raiz, 'good-checkout-offline', 'base.js'));
  assert.strictEqual(path.resolve(base.CACHE_DIR), path.resolve(dir), 'o teste não isolou o cache da GOOD (escreveria no de verdade)');
  /* UM roteador só (como em produção): a fábrica do painel é montada na 1ª chamada e guarda o readBody dela */
  let _corpo = {};
  const handler = mod.routes(async () => _corpo);
  const chamar = async (method, corpo) => {
    _corpo = corpo || {};
    const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const u = new URL('http://x/good-checkout-offline/config-frete-magalu?k=' + encodeURIComponent(process.env.ADMIN_KEY));
    const tratou = await handler({ method, url: u.pathname + u.search, headers: {} }, res, u);
    return { tratou, s: res._s, j: (() => { try { return JSON.parse(res._b); } catch (e) { return null; } })(), b: res._b };
  };
  const g = await chamar('GET');
  assert.ok(g.tratou === true && g.j && g.j.ok === true, 'GOOD: o GET do frete Magalu não respondeu ok: ' + g.b.slice(0, 160));
  const p = await chamar('POST', { nivel_desconto: '25' });
  assert.ok(p.j && p.j.ok === true && p.j.salvo === '25', 'GOOD: o POST não salvou o nível: ' + p.b.slice(0, 160));
  const salvo = JSON.parse(fs.readFileSync(path.join(dir, '_config-frete-magalu.json'), 'utf8'));
  assert.strictEqual(salvo.nivel_desconto, '25');
  /* o que a peça do frete da GOOD lê é o que o ⚙️ salvou (mesma pasta, mesmo arquivo) */
  const mf = require(path.join(raiz, 'lib', 'checkout', 'magalu-frete')).criar({ CACHE_DIR: base.CACHE_DIR, readJson: base.readJson, writeJson: base.writeJson, blingGet: async () => ({ ok: false }), resolverProdutoPorSku: async () => null });
  const col = mf.magaluNivelColuna();
  assert.ok(col !== undefined && col !== null, 'a peça do frete não leu o nível');
  fs.writeFileSync(path.join(dir, '_config-frete-magalu.json'), JSON.stringify({ nivel_desconto: '50' }));
  assert.notStrictEqual(mf.magaluNivelColuna(), col, 'a peça do frete não acompanha o nível salvo pelo ⚙️');
  /* Codex #715: a TELA da GOOD (o modelo da AMB) também tem que mostrar o ⚙️ e o botão da venda do dia — gerada do jeito
     que a GOOD gera, com a capacidade ligada (senão o seletor some e a rota nunca é chamada) */
  { const res = { _s: 0, _b: '', writeHead(s2) { this._s = s2; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const u = new URL('http://x/good-checkout-offline/dashboard?k=' + encodeURIComponent(process.env.ADMIN_KEY));
    await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    const m = res._b.match(/window\.__CAPAC = (\{[^}]*\})/);
    assert.ok(m, 'GOOD: a tela não veio do modelo (capacidades não achadas): ' + res._b.slice(0, 120));
    const capac = JSON.parse(m[1]);
    assert.strictEqual(capac.freteMagalu, true, 'GOOD: a tela esconde o ⚙️ do frete Magalu');
    assert.strictEqual(capac.vendasSync, true, 'GOOD: a tela desliga o botão da venda do dia (que existe desde o #714)');
    /* 27/10: a GOOD ganhou o módulo da Shopee (lib/checkout/shopee-empresa) — o resumo existe e o card liga */
    assert.strictEqual(capac.shopeeResumo, true, 'GOOD: a tela desliga o resumo da Shopee (que a GOOD tem desde 27/10)'); }
  fs.rmSync(dir, { recursive: true, force: true });
  _fim = true;
  console.log('ok — GOOD: o ⚙️ do frete Magalu responde, salva, e a peça do frete da venda do dia lê o nível salvo');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
