'use strict';
/* 15/11 — ROTINAS IGUAIS NAS TRÊS EMPRESAS VIRAM PEÇA (docs/NORTE-2026-11.md, item C, passo 2).

   Medido em 15/11: a sessão de operador (21 linhas), o `shopeeKeepAlive` (só o tag do log mudava), o `_anotarFalhaCusto`
   e o `_inferCanal` eram cópias byte a byte (a GOOD ainda tinha a cópia inteira da sessão da Shopee, ~88 linhas). Agora:
   `lib/checkout/sessao-operador` (nova), `shopee-sessao.criar({ …, TAG, fetch })` ganha `shopeeKeepAlive`,
   `estado-rotinas.anotarFalhaCusto(custo, sku, motivo)`, e Girassol/AMB usam `inferir-canal` como a GOOD. Provas:
     1) a sessão de operador: assina, valida, recusa adulterada/vencida/sem cookie, acha o cookie no meio dos outros;
        o cookie vale nas três (mesmo segredo) — e as três usam a peça (nenhuma cópia local);
     2) o keep-alive da Shopee pela peça, com fetch de mentira: sem cookie; sessão viva com cookie renovado (o jar em disco
        muda, o log leva o TAG da empresa); resposta sem `"code":0`; fetch que explode; TAG deduzido do nome da env;
     3) a anotação de falha de custo: mais nova na frente, 10 no máximo, nunca lança;
     4) nenhuma das três tem mais `shopeeKeepAlive`, `_anotarFalhaCusto`, `_inferCanal`, `assinarSessao`/`validarSessao`
        locais, e a GOOD não tem mais a cópia da sessão da Shopee. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) sessão de operador */
process.env.ADMIN_KEY = 'segredo-de-teste';
const SO = require('../lib/checkout/sessao-operador');
assert.strictEqual(SO.SESS_COOKIE, 'bkp_sess'); assert.strictEqual(SO.SESS_TTL, 14 * 3600 * 1000);
const tok = SO.assinarSessao('ana');
assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok), 'o token é payload.assinatura em base64url: ' + tok);
assert.strictEqual(SO.validarSessao('bkp_sess=' + tok), 'ana');
assert.strictEqual(SO.validarSessao('outro=1; bkp_sess=' + tok + '; mais=2'), 'ana', 'tem que achar o cookie no meio dos outros');
assert.strictEqual(SO.validarSessao('bkp_sessx=' + tok), null, 'cookie com nome parecido não vale');
assert.strictEqual(SO.validarSessao('xbkp_sess=' + tok), null, 'cookie com prefixo a mais não vale (o nome tem que começar no início ou depois de ";")');
assert.strictEqual(SO.validarSessao('a=1;bkp_sess=' + tok), 'ana', 'sem espaço depois do ";" também vale');
assert.strictEqual(SO.validarSessao(''), null); assert.strictEqual(SO.validarSessao(undefined), null);
assert.strictEqual(SO.validarSessao('bkp_sess=' + tok.slice(0, -2) + 'zz'), null, 'assinatura adulterada');
{ const [pl, sig] = tok.split('.'); const plX = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(pl, 'base64url').toString()), { n: 'admin' }))).toString('base64url');
  assert.strictEqual(SO.validarSessao('bkp_sess=' + plX + '.' + sig), null, 'payload trocado com a assinatura antiga'); }
assert.strictEqual(SO.validarSessao('bkp_sess=' + tok + '.x'), null, 'três partes');
{ const plV = Buffer.from(JSON.stringify({ n: 'ana', exp: Date.now() - 1000 })).toString('base64url');
  const sigV = require('crypto').createHmac('sha256', SO.SESS_SECRET).update(plV).digest('base64url');
  assert.strictEqual(SO.validarSessao('bkp_sess=' + plV + '.' + sigV), null, 'sessão vencida tem que ser recusada'); }
{ const plS = Buffer.from(JSON.stringify({ n: 'ana' })).toString('base64url');
  const sigS = require('crypto').createHmac('sha256', SO.SESS_SECRET).update(plS).digest('base64url');
  assert.strictEqual(SO.validarSessao('bkp_sess=' + plS + '.' + sigS), null, 'sem validade não entra'); }
/* o segredo vem da ADMIN_KEY: outra chave, outro segredo (a peça é lida uma vez por processo — carrego de novo) */
{ const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'sessao-operador.js'), 'utf8');
  const m2 = { exports: {} }; new Function('process', 'module', 'require', src)({ env: { ADMIN_KEY: 'outra' } }, m2, require);
  assert.strictEqual(m2.exports.validarSessao('bkp_sess=' + tok), null, 'o cookie de um segredo não pode valer em outro');
  assert.strictEqual(m2.exports.validarSessao('bkp_sess=' + m2.exports.assinarSessao('bia')), 'bia'); }

/* 2) keep-alive da Shopee pela peça */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-'));
const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const logs = []; const _log = console.log; console.log = (m) => logs.push(String(m));
const respostas = []; const chamadas = [];
const fetchFake = async (url, opts) => { chamadas.push({ url: String(url), cookie: opts && opts.headers && opts.headers.Cookie }); const r = respostas.shift(); if (r instanceof Error) throw r; return r; };
const resp = (status, corpo, setCookie) => ({ status, text: async () => corpo, headers: { getSetCookie: () => setCookie || [], get: (k) => (k === 'set-cookie' && setCookie && setCookie.length) ? setCookie.join(', ') : null } });
(async () => {
  try {
    delete process.env.XPTO_SHOPEE_COOKIE;
    const S1 = require('../lib/checkout/shopee-sessao').criar({ CACHE_DIR: dir, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE: 'XPTO_SHOPEE_COOKIE', fetch: fetchFake });
    assert.strictEqual(S1.TAG, 'XPTO', 'sem TAG, o prefixo do log vem do nome da env');
    assert.strictEqual(typeof S1.shopeeKeepAlive, 'function');
    let r = await S1.shopeeKeepAlive();
    assert.deepStrictEqual(r, { ok: false, motivo: 'sem cookie' }); assert.strictEqual(chamadas.length, 0, 'sem cookie não chama a Shopee');
    assert.ok(logs.some((l) => /^\[XPTO\] shopee keep-alive: sem cookie \(env XPTO_SHOPEE_COOKIE vazia\)/.test(l)), logs.join('\n'));
    /* cookie na env: sessão viva, e a Shopee devolve um cookie renovado → o jar em disco muda */
    process.env.XPTO_SHOPEE_COOKIE = 'SPC_CDS=abc; SPC_EC=velho';
    const S2 = require('../lib/checkout/shopee-sessao').criar({ CACHE_DIR: dir, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE: 'XPTO_SHOPEE_COOKIE', TAG: 'TESTBKP', fetch: fetchFake });
    respostas.push(resp(200, '{"code":0,"data":{}}', ['SPC_EC=novo; Path=/; HttpOnly']));
    r = await S2.shopeeKeepAlive();
    assert.deepStrictEqual(r, { ok: true, status: 200, renovou: 1, corpo: '{"code":0,"data":{}}' }, JSON.stringify(r));
    assert.ok(/keyword=keepalive/.test(chamadas[0].url) && /SPC_CDS=abc/.test(chamadas[0].url) && chamadas[0].cookie === 'SPC_CDS=abc; SPC_EC=velho', JSON.stringify(chamadas[0]));
    assert.strictEqual(readJson(S2.SHOPEE_SESSAO_FILE, {}).cookie, 'SPC_CDS=abc; SPC_EC=novo', 'o jar em disco tinha que trazer o cookie renovado');
    assert.strictEqual(S2.shopeeSessaoLer().renovacoes, 1);
    assert.ok(logs.some((l) => /^\[TESTBKP\] shopee keep-alive: HTTP 200 ✓ sessão viva · 1 cookie\(s\) renovado\(s\), total 1$/.test(l)), logs.join('\n'));
    /* 200 sem code 0 = não está logada; nada a renovar */
    respostas.push(resp(200, '{"code":2,"message":"login"}', []));
    r = await S2.shopeeKeepAlive();
    assert.deepStrictEqual(r, { ok: false, status: 200, renovou: 0, corpo: '{"code":2,"message":"login"}' });
    assert.ok(logs.some((l) => /^\[TESTBKP\] shopee keep-alive: HTTP 200 ✗ sessão NÃO respondeu como logada · nada a renovar$/.test(l)), logs.join('\n'));
    /* 403 */
    respostas.push(resp(403, '{"code":0}', []));
    r = await S2.shopeeKeepAlive(); assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 403);
    /* fetch explode */
    respostas.push(new Error('ECONNRESET'));
    r = await S2.shopeeKeepAlive(); assert.deepStrictEqual(r, { ok: false, erro: 'ECONNRESET' });
    assert.ok(logs.some((l) => /^\[TESTBKP\] shopee keep-alive falhou: ECONNRESET$/.test(l)), logs.join('\n'));
    /* o corpo volta cortado em 300 */
    respostas.push(resp(200, '{"code":0,"x":"' + 'y'.repeat(500) + '"}', []));
    r = await S2.shopeeKeepAlive(); assert.strictEqual(r.ok, true); assert.strictEqual(r.corpo.length, 300);
  } finally { console.log = _log; }

  /* 3) anotação de falha de custo */
  const ER = require('../lib/checkout/estado-rotinas');
  const custo = ER.estadoDe('teste-rot').custo;
  ER.anotarFalhaCusto(custo, 'SKU-1', 'o Bling não devolveu');
  ER.anotarFalhaCusto(custo, 'SKU-2', null);
  assert.strictEqual(custo.falhas_detalhe.length, 2); assert.strictEqual(custo.falhas_detalhe[0].sku, 'SKU-2', 'a mais nova vem na frente'); assert.strictEqual(custo.falhas_detalhe[0].motivo, '?');
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(custo.falhas_detalhe[0].em));
  for (let i = 0; i < 20; i++) ER.anotarFalhaCusto(custo, 'S' + i, 'm');
  assert.strictEqual(custo.falhas_detalhe.length, 10, 'no máximo 10'); assert.strictEqual(custo.falhas_detalhe[0].sku, 'S19');
  const semLista = { falhas_detalhe: 'xyz' }; ER.anotarFalhaCusto(semLista, 'a', 'b');
  assert.ok(Array.isArray(semLista.falhas_detalhe) && semLista.falhas_detalhe.length === 1 && semLista.falhas_detalhe[0].sku === 'a', 'lista que não é lista vira lista (com a falha dentro)');
  assert.doesNotThrow(() => ER.anotarFalhaCusto(null, 'a', 'b'), 'nunca lança');
  assert.strictEqual(ER.estadoDe('teste-rot').custo, custo, 'o estado continua o mesmo objeto');

  /* 4) as três usam as peças; nenhuma cópia local */
  const arqs = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' };
  const TAGS = { girassol: 'GIRABKP', amb: 'AMBBKP', good: 'GOODBKP' };
  const rotCusto = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotinas-custo-empresa.js'), 'utf8');
  for (const [emp, arq] of Object.entries(arqs)) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    for (const re of [/async function shopeeKeepAlive\(/, /function _anotarFalhaCusto\(/, /function _inferCanal\(/, /function assinarSessao\(/, /function validarSessao\(/, /const SESS_SECRET =/, /function shopeeSessaoLer\(/, /function shopeeSessaoAtualiza\(/, /function shopeeUrlBusca\(/, /const SHOPEE_CAB = \{/, /function _urlStatus\(/, /function _shopeeHash\(/]) {
      assert.ok(!re.test(s), emp + ': sobrou a cópia local ' + re);
    }
    assert.ok(/const \{ SESS_TTL, SESS_COOKIE, assinarSessao, validarSessao \} = require\('\.\.\/lib\/checkout\/sessao-operador'\);/.test(s), emp + ': a sessão de operador tem que vir da peça');
    assert.ok(new RegExp("require\\('\\.\\.\\/lib\\/checkout\\/shopee-sessao'\\)\\.criar\\(\\{\\n  CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE, TAG: '" + TAGS[emp] + "',\\n\\}\\);").test(s), emp + ': a sessão da Shopee tem que vir da peça com o TAG da empresa');
    assert.ok(/const \{ shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, shopeeKeepAlive, SHOPEE_CAB, SHOPEE_SESSAO_FILE,\n        _shopeeHash, _urlStatus \} = _shopeeSessao;/.test(s), emp + ': o keep-alive tem que vir da peça');
    /* 16/11 (montarCheckout, passo 6): a anotação mora nas rotinas de custo da empresa (lib/checkout/rotinas-custo-empresa), sobre o _cst DELA */
    assert.ok(/const _anotarFalhaCusto = \(sku, motivo\) => require\('\.\/estado-rotinas'\)\.anotarFalhaCusto\(_cst, sku, motivo\);/.test(rotCusto) && /const _cst = require\('\.\/estado-rotinas'\)\.estadoDe\(empresa\)\.custo;/.test(rotCusto) && new RegExp("require\\('\\.\\./lib/checkout/rotinas-custo-empresa'\\)\\.criar\\(\\{\\n  empresa: '" + emp + "',").test(s), emp + ': a anotação de falha tem que ser a peça sobre o _cst da empresa');
    assert.ok(/const _inferCanal = require\('\.\.\/lib\/checkout\/inferir-canal'\)\.inferirCanal;/.test(s), emp + ': o canal pelo número tem que vir da peça');
    assert.ok(new RegExp("const SHOPEE_ENV_COOKIE  = '" + TAGS[emp] + "_SHOPEE_COOKIE';").test(s), emp + ': o nome da env do cookie continua o da empresa');
  }
  console.log('ok — sessão de operador, keep-alive da Shopee, anotação de falha de custo e canal pelo número: peças únicas, usadas pelas três; nenhuma cópia local sobrou');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
