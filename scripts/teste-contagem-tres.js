'use strict';
/* 27/10 — a CONTAGEM DE ESTOQUE nas três empresas: a tela era só da Girassol (girassol-backup-offline/contagem.html; as
   rotas já eram a peça lib/checkout/rotas-contagem). Agora a tela é peça única (lib/checkout/painel/contagem.html) com a
   MARCA do painel de cada empresa, e a AMB e a GOOD montam a contagem. Prova:
   · a Girassol recebe BYTE A BYTE a tela de antes (sha256);
   · AMB e GOOD: a tela com o prefixo, o nome e o logo DELAS (nada da Girassol);
   · a rota de verdade (a peça) entrega a tela renderizada pra quem está logado e 401 pra quem não está;
   · AMB e GOOD montam a contagem com o prefixo, a pasta e o depósito DELAS. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const C = require('../lib/checkout/painel/contagem');

const SHA_GIRASSOL_ANTES = '4c72e604d97671e9a86168cc5559285394e7d184b7bedde46679c795ac8a1e15';   /* girassol-backup-offline/contagem.html em 27/10 */
(async () => {
  const mg = require('../girassol-backup-offline/painel-marca');
  assert.strictEqual(crypto.createHash('sha256').update(C.renderizar(mg), 'utf8').digest('hex'), SHA_GIRASSOL_ANTES, 'a tela da contagem da Girassol pela peça NÃO é a de antes (byte a byte)');
  for (const [pasta, nome] of [['amb-checkout-offline', 'AMBTotal'], ['good-checkout-offline', 'GOOD Import']]) {
    const mk = require('../' + pasta + '/painel-marca');
    const h = C.renderizar(mk);
    assert.ok(h.includes("const MOD = '/" + pasta + "';") && h.includes('<title>Contagem de Estoque · ' + nome + '</title>') && h.includes('<span class="empresa">' + nome + '</span>') && h.includes(mk.LOGO), pasta + ': a tela não tem o prefixo, o nome e o logo dela');
    assert.ok(!/girassol-backup-offline|Magazine Girassol/.test(h) && !h.includes(mg.LOGO), pasta + ': sobrou coisa da Girassol na tela');
    const ix = fs.readFileSync(path.join(raiz, pasta, 'index.js'), 'utf8');
    const i = ix.indexOf("const _rotasContagem = require('../lib/checkout/rotas-contagem').criar({");
    const bloco = ix.slice(i, ix.indexOf('\n  });\n', i));
    const env = pasta.startsWith('amb') ? 'AMBBKP_DEPOSITO_GERAL' : 'GOODBKP_DEPOSITO_GERAL';
    assert.ok(i > 0 && bloco.includes("prefixo: '/" + pasta + "'") && bloco.includes("pasta: '" + pasta + "'") && bloco.includes("envDeposito: '" + env + "'") && bloco.includes("marca: require('./painel-marca')"), pasta + ': não monta a contagem com o que é dela');
    assert.ok(ix.includes('if (await _rotasContagem(req, res, urlObj, method)) return true;'), pasta + ': a contagem não está nas rotas');
  }
  // a rota de verdade (a peça), com a marca da GOOD
  const rot = require('../lib/checkout/rotas-contagem').criar({
    prefixo: '/good-checkout-offline', json: (res, c, b) => { res.c = c; res.b = b; }, validarSessao: (ck) => (ck === 'sess=ok' ? { u: 'op' } : null),
    lerIndiceEan: () => ({}), getIdxStatus: () => ({}), CACHE_DIR: '/tmp', readJson: (a, d) => d, writeJson: () => {}, readBody: async () => '{}', blingGet: async () => ({ ok: true, data: { data: [] } }),
    produtoDetalhe: async () => null, localizacaoDeProduto: () => null, locCache: {}, blingWrite: async () => ({ ok: false }), ehAdmin: () => false, lerAdmins: () => [], PAUSA_MS: 0, sleep: async () => {},
    marca: require('../good-checkout-offline/painel-marca'), empresa: { pasta: 'good-checkout-offline', envDeposito: 'GOODBKP_DEPOSITO_GERAL' },
  });
  const pedir = async (cookie) => { const res = { c: 0, b: null, h: null, writeHead(c) { this.c = c; }, end(x) { this.b = x; } }; await rot({ headers: { cookie } }, res, new URL('http://h/good-checkout-offline/contagem'), 'GET'); return res; };
  const ok = await pedir('sess=ok');
  assert.ok(ok.c === 200 && String(ok.b).includes("const MOD = '/good-checkout-offline';"), 'a rota da contagem da GOOD não entregou a tela dela: ' + ok.c);
  const sem = await pedir('');
  assert.strictEqual(sem.c, 401, 'a tela da contagem abriu sem login');
  assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'contagem.html')), 'sobrou a cópia da tela na pasta da Girassol');
  const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(gbo.includes("    marca: require('./painel-marca'),\n    empresa: {\n      pasta: 'girassol-backup-offline',"), 'a Girassol não serve a tela pela peça');
  console.log('ok — contagem de estoque nas três: a Girassol byte a byte; AMB e GOOD com a tela, o prefixo, o nome, o logo e o depósito delas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
