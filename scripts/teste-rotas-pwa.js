'use strict';
/* 15/11 — ÍCONE E MANIFESTO DO APP (PWA) pela peça lib/checkout/rotas-pwa (docs/NORTE-2026-11.md, item C: rotas-cópia).

   Eram duas cópias (Girassol e AMB); a AMB versionava a URL do ícone no manifesto (Codex PR#9: fura o cache de 30 dias
   quando o ícone muda) e a Girassol não. Provas:
     1) a peça: /icone.png devolve o PNG byte a byte com os cabeçalhos de sempre (30 dias); /manifest.webmanifest devolve
        o JSON com nome, atalho, descrição, start_url/scope do prefixo e os DOIS ícones versionados; só GET; só o prefixo
        dela; config faltando ou ícone que não é PNG derrubam na montagem;
     2) as duas empresas montam a peça com o prefixo, o nome e o ícone delas, e não têm mais a cópia; a GOOD (sem ícone
        PNG) continua anunciando `manifesto: false` no painel;
     3) pelo `routes` REAL da Girassol e da AMB: /icone.png e /manifest.webmanifest respondem sem sessão (são públicas no
        portão), e o manifesto da Girassol agora sai versionado como o da AMB.
   17/11 (montarCheckout, passo 16): a parte 2 passa a provar a montagem PELO CONTRATO nas três (o de antes guardado em
   scripts/fixtures/pwa-antes.json). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) a peça */
const PWA = require('../lib/checkout/rotas-pwa');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-de-mentira')]);
const cfg = { prefixo: '/x-checkout-offline', nome: 'Inteligência · X', shortName: 'X', descricao: 'd', iconeB64: png.toString('base64'), VERSAO: 'x v1 b2 ç' };
const rota = PWA.criar(cfg);
const pedir = (p, method) => { const res = { _s: 0, _h: null, _b: null, writeHead(s, h) { this._s = s; this._h = h; }, end(b) { this._b = b; } }; const t = rota({ method: method || 'GET' }, res, p, method || 'GET'); return { t, res }; };
{ const { t, res } = pedir('/x-checkout-offline/icone.png');
  assert.strictEqual(t, true); assert.strictEqual(res._s, 200);
  assert.ok(Buffer.isBuffer(res._b) && res._b.equals(png), 'o PNG tem que sair byte a byte');
  assert.deepStrictEqual(res._h, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=2592000' }); }
{ const { t, res } = pedir('/x-checkout-offline/manifest.webmanifest');
  assert.strictEqual(t, true); assert.strictEqual(res._s, 200);
  assert.deepStrictEqual(res._h, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  const m = JSON.parse(res._b);
  assert.deepStrictEqual(m, { name: 'Inteligência · X', short_name: 'X', description: 'd', start_url: '/x-checkout-offline/dashboard', scope: '/x-checkout-offline/',
    display: 'standalone', orientation: 'portrait-primary', background_color: '#0a0e1a', theme_color: '#0a0e1a',
    icons: [{ src: 'icone.png?v=x%20v1%20b2%20%C3%A7', sizes: '128x128', type: 'image/png', purpose: 'any' }, { src: 'icone.png?v=x%20v1%20b2%20%C3%A7', sizes: '128x128', type: 'image/png', purpose: 'maskable' }] }); }
assert.strictEqual(pedir('/x-checkout-offline/icone.png', 'POST').t, false, 'só GET');
assert.strictEqual(pedir('/x-checkout-offline/manifest.webmanifest', 'HEAD').t, false, 'só GET');
assert.strictEqual(pedir('/y-checkout-offline/icone.png').t, false, 'só o prefixo dela');
assert.strictEqual(pedir('/x-checkout-offline/icone.png/').t, false);
assert.strictEqual(pedir('/x-checkout-offline/dashboard').t, false);
assert.throws(() => PWA.criar(Object.assign({}, cfg, { VERSAO: '' })), /falta VERSAO/);
assert.throws(() => PWA.criar(Object.assign({}, cfg, { iconeB64: Buffer.from('<svg/>').toString('base64') })), /não é um PNG/);
assert.throws(() => PWA.criar({}), /falta prefixo/);

/* 2) 17/11 (montarCheckout, passo 16): as três montam o app PELO CONTRATO (`rotas-pwa.daEmpresa(empresa, { VERSAO })`: o prefixo do
   contrato; o nome, a descrição e o ícone do painel da empresa). A Girassol e a AMB servem EXATAMENTE o que serviam com o bloco
   escrito à mão de antes (scripts/fixtures/pwa-antes.json: o ícone byte a byte e o manifesto, com os cabeçalhos); a GOOD (sem
   ícone PNG) recebe null — a fila pula o passo — e continua anunciando `manifesto: false` no painel. Sem cópia nas três. */
const ANTES = require('./fixtures/pwa-antes.json');
const crypto = require('crypto');
for (const [emp, arq] of [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.strictEqual(s.split("const _rotasPwa = require('../lib/checkout/rotas-pwa').daEmpresa('" + emp + "', { VERSAO });\n").length, 2, emp + ': não monta o app pelo contrato (exatamente uma vez) com a empresa dela');
  assert.strictEqual((s.match(/pwa: _rotasPwa && \(\(req, res, urlObj, method, p\) => _rotasPwa\(req, res, p, method\)\),/g) || []).length, 1, emp + ': o app tem que ser um passo da fila (uma vez)');
  assert.ok(!/ICONE_B64|iconeB64|rotas-pwa'\)\.criar\(/.test(s), emp + ': sobrou o ícone ou a montagem escrita à mão');
  assert.ok(!/p === '\/[\w-]+\/icone\.png'/.test(s) && !/manifest\.webmanifest'\)/.test(s) && !/application\/manifest\+json/.test(s), emp + ': a cópia da rota voltou');
}
const pedirDe = (rotaE, p) => { const res = { _s: 0, _h: null, _b: null, writeHead(st, h) { this._s = st; this._h = h; }, end(b) { this._b = b; } }; const t = rotaE({ method: 'GET' }, res, p, 'GET'); return { t, res }; };
for (const emp of ['girassol', 'amb']) {
  const A = ANTES[emp];
  const r = PWA.daEmpresa(emp, { VERSAO: 'v-teste' });
  assert.strictEqual(typeof r, 'function', emp + ': a empresa perdeu o app (o painel dela não tem PWA_EMPRESA)');
  const i = pedirDe(r, A.prefixo + '/icone.png');
  assert.ok(i.t === true && i.res._s === 200 && Buffer.isBuffer(i.res._b), emp + ': o ícone não saiu');
  assert.deepStrictEqual([i.res._b.length, crypto.createHash('sha256').update(i.res._b).digest('hex'), i.res._h], [A.icone.bytes, A.icone.sha256, A.icone.cabecalhos], emp + ': o ícone não é o mesmo de antes (byte a byte)');
  const m = pedirDe(r, A.prefixo + '/manifest.webmanifest');
  assert.ok(m.t === true && m.res._s === 200, emp + ': o manifesto não saiu');
  assert.deepStrictEqual([String(m.res._b), m.res._h], [A.manifesto.corpo, A.manifesto.cabecalhos], emp + ': o manifesto não é o mesmo de antes');
  assert.strictEqual(pedirDe(r, '/' + (emp === 'amb' ? 'girassol-backup-offline' : 'amb-checkout-offline') + '/icone.png').t, false, emp + ': respondeu no prefixo da outra');
}
let semApp; try { semApp = PWA.daEmpresa('good', { VERSAO: 'v' }); } catch (e) { semApp = 'quebrou: ' + e.message; }
assert.strictEqual(semApp, null, 'a GOOD não tem ícone PNG — não monta o app (e não pode quebrar o boot)');
assert.throws(() => PWA.daEmpresa('girassol', {}), /falta VERSAO/, 'sem a versão (que versiona o ícone no manifesto) tem que derrubar');
assert.throws(() => PWA.daEmpresa('empresa-que-nao-existe', { VERSAO: 'v' }), /empresa desconhecida no contrato/);
assert.ok(/good: \{[\s\S]{0,600}?manifesto: false/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'empresas.js'), 'utf8')), 'o painel da GOOD tem que seguir sem anunciar manifesto');

/* 3) pelo routes real das duas: públicas, e o manifesto versionado nas duas */
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-pwa-teste';
for (const [emp, pref, arq, envDir] of [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR']]) {
  process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-' + emp + '-'));
  const mod = require(path.join(raiz, arq));
  const h = mod.routes(async () => ({}));
  const chamar = async (caminho) => { const u = new URL('http://x' + caminho); const res = { _s: 0, _h: null, _b: null, writeHead(s, hd) { this._s = s; this._h = hd; }, setHeader() {}, end(b) { this._b = b; } };
    const t = await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return { t, res }; };
  (async () => {
    const i = await chamar(pref + '/icone.png');
    assert.ok(i.t === true && i.res._s === 200 && Buffer.isBuffer(i.res._b) && i.res._b.readUInt32BE(0) === 0x89504e47 && i.res._h['Cache-Control'] === 'public, max-age=2592000', emp + ': /icone.png tem que sair público, PNG, 30 dias: ' + i.res._s);
    const m = await chamar(pref + '/manifest.webmanifest');
    assert.ok(m.t === true && m.res._s === 200, emp + ': /manifest.webmanifest tem que sair público: ' + m.res._s);
    const j = JSON.parse(m.res._b);
    assert.strictEqual(j.start_url, pref + '/dashboard'); assert.strictEqual(j.scope, pref + '/');
    assert.ok(j.icons.length === 2 && j.icons.every((ic) => /^icone\.png\?v=.+/.test(ic.src)), emp + ': os ícones do manifesto têm que sair versionados: ' + JSON.stringify(j.icons));
    assert.ok(/Girassol|AMBTotal/.test(j.name) && (emp === 'girassol' ? /Girassol/ : /AMBTotal/).test(j.short_name), emp + ': nome errado no manifesto: ' + j.name);
  })().then(() => { if (emp === 'amb') { console.log('ok — ícone e manifesto do app pela peça única: PNG byte a byte, manifesto versionado nas duas (a Girassol ganhou o ?v=), só GET e só o prefixo; públicos pelo routes real'); process.exit(0); } })
    .catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
}
