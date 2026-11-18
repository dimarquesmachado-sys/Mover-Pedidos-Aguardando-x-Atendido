'use strict';
/* 16/11 — AS DUAS ROTAS DA SESSÃO DA SHOPEE (semear o cookie; consultar a devolução) viraram a peça
   lib/checkout/rotas-shopee-sessao, montada pelas três (docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 2).
   Eram as últimas rotas PRÓPRIAS da AMB; a Girassol e a GOOD não as tinham, embora usem a mesma sessão da Shopee.

   Prova:
     1) MOVER NÃO É REESCREVER: o corpo das duas rotas na peça é o da AMB (scripts/fixtures/rotas-shopee-sessao-amb-antes.txt),
        byte a byte, desfeita a única troca (o prefixo da AMB virou `PREFIXO`); a peça recusa montagem incompleta;
     2) a peça com sessão/rede/disco de mentira:
        · semear: só a chave (404 sem ela, 404 com a errada); corpo sem cookie → 400; aceita o cURL inteiro (pega o -H 'Cookie:');
          sem SPC_ST → 400 e diz quais cookies vieram; grava o jar com a semente (hash) e origem 'semeado'; disco que falha → 500;
        · devolução: chave OU sessão de admin (sessão de operador → 404); sem rid/rsn → 400; cache "entregue" responde sem rede;
          sem cookie → ok:false com o passo; rsn → resolve o rid no detalhe e grava o de-para; histórico com "entregue" → ok,
          entregue_em, grava o cache; `diag=1` traz os passos; a resposta de cada chamada passa pelo `shopeeSessaoAtualiza`;
        · só GET/POST certos, só o prefixo dela;
     3) as três montam a peça com a sessão delas (a AMB não tem mais a cópia), o passo é obrigatório na fila e as duas rotas
        são públicas no portão das três (checam a própria credencial) — pelo routes REAL: sem credencial é 404 (não 401). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const RS = require('../lib/checkout/rotas-shopee-sessao');

/* 1) mover não é reescrever */
{
  const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-shopee-sessao.js'), 'utf8');
  const antes = fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-shopee-sessao-amb-antes.txt'), 'utf8');
  const i = peca.indexOf('async function _rotaShopeeSemear('), f = peca.indexOf('  return async function rotasShopeeSessao(');
  assert.ok(i > 0 && f > i, 'cadê as duas rotas na peça?');
  let corpo = peca.slice(i, f).replace(/\n$/, '');
  /* a peça está desindentada em 2 (era corpo de função); a troca única: o prefixo */
  corpo = corpo.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
  corpo = corpo.split("PREFIXO + '/shopee-semear'").join("'/amb-checkout-offline/shopee-semear'").split("PREFIXO + '/shopee-devolucao'").join("'/amb-checkout-offline/shopee-devolucao'");
  assert.strictEqual(corpo.trimEnd(), antes.trimEnd(), 'fora do prefixo, o corpo das duas rotas tem que ser o da AMB (mover não é reescrever)');
  assert.ok(antes.split('\n').length > 100, 'a fixture encolheu');
  assert.deepStrictEqual(RS.ROTAS, ['/shopee-semear', '/shopee-devolucao']);
  assert.throws(() => RS.criar({}), /rotas-shopee-sessao: falta PREFIXO, VERSAO, CACHE_DIR/);
}

/* 2) a peça */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-'));
const disco = {};
const readJson = (f, d) => (f in disco ? JSON.parse(JSON.stringify(disco[f])) : d);
let gravaFalha = false;
const writeJson = (f, o) => { if (gravaFalha) throw new Error('disco cheio'); disco[f] = JSON.parse(JSON.stringify(o)); };
const SESS_FILE = path.join(tmp, '_shopee-sessao.json');
let cookieAtual = 'SPC_CDS=cds-1; csrftoken=tok-1; SPC_ST=st-1';
const atualizadas = [];
const sessao = { shopeeSessaoLer: () => ({ cookie: cookieAtual, origem: 'semeado' }), shopeeSessaoAtualiza: (r) => { atualizadas.push(r.status); return false; }, SHOPEE_SESSAO_FILE: SESS_FILE, _shopeeHash: (s) => 'h' + s.length };
const rede = { detail: null, hist: null, chamadas: [] };
const fetch = async (url, opts) => {
  rede.chamadas.push({ url, headers: opts && opts.headers });
  const r = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  if (/\/api\/v3\/return\/detail/.test(url)) return rede.detail ? r(200, rede.detail) : r(500, { erro: 'x' });
  if (/reverse_logistics_tracking_history/.test(url)) return rede.hist ? r(200, rede.hist) : r(500, { erro: 'x' });
  return r(404, {});
};
process.env.ADMIN_KEY = 'chave-rss';
const PREF = '/x-checkout-offline';
const rota = RS.criar({ PREFIXO: PREF, VERSAO: 'x v1', CACHE_DIR: tmp, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k'),
  validarSessao: (ck) => (ck === 'sess=dono' ? { nome: 'dono', papel: 'admin' } : (ck === 'sess=op' ? { nome: 'op', papel: 'operador' } : null)), ehAdmin: (s) => s && s.papel === 'admin',
  readBody: async (req) => req._body, readJson, writeJson, ensureDir: () => {}, fetch, sessao, SHOPEE_ENV_COOKIE: 'XBKP_SHOPEE_COOKIE' });
const pedir = async (method, caminho, extra) => { const u = new URL('http://x' + caminho); const res = { _s: 0, _o: null }; const req = Object.assign({ method, headers: {} }, extra || {}); const t = await rota(req, res, u, method, u.pathname); return { t, res }; };

(async () => {
  /* semear */
  let r = await pedir('POST', PREF + '/shopee-semear'); assert.ok(r.t === true && r.res._s === 404, 'semear sem chave: 404');
  r = await pedir('POST', PREF + '/shopee-semear?k=errada'); assert.strictEqual(r.res._s, 404);
  r = await pedir('POST', PREF + '/shopee-semear?k=chave-rss', { _body: {} }); assert.strictEqual(r.res._s, 400); assert.ok(/faltou \{cookie/.test(r.res._o.erro));
  r = await pedir('POST', PREF + '/shopee-semear?k=chave-rss', { _body: { cookie: 'SPC_CDS=a; csrftoken=b' } }); assert.strictEqual(r.res._s, 400); assert.ok(/NAO tem SPC_ST/.test(r.res._o.erro)); assert.deepStrictEqual(r.res._o.nomes, ['SPC_CDS', 'csrftoken']);
  assert.ok(!(SESS_FILE in disco), 'cookie sem SPC_ST não pode ir pro jar');
  r = await pedir('POST', PREF + '/shopee-semear?k=chave-rss', { _body: { curl: "curl 'https://seller.shopee.com.br/api/x' -H 'Cookie: SPC_CDS=a; SPC_ST=st-9; csrftoken=b' -H 'Accept: */*'" } });
  assert.strictEqual(r.res._s, 200); assert.deepStrictEqual(r.res._o, { ok: true, gravado: true, tam_cookie: 'SPC_CDS=a; SPC_ST=st-9; csrftoken=b'.length, tem_SPC_ST: true, cookies: 3, nomes: ['SPC_CDS', 'SPC_ST', 'csrftoken'], versao: 'x v1' });
  assert.strictEqual(disco[SESS_FILE].cookie, 'SPC_CDS=a; SPC_ST=st-9; csrftoken=b', 'o cURL inteiro: só o valor do -H Cookie vai pro jar'); assert.strictEqual(disco[SESS_FILE].origem, 'semeado'); assert.strictEqual(disco[SESS_FILE].semente, 'h' + disco[SESS_FILE].cookie.length); assert.strictEqual(disco[SESS_FILE].renovacoes, 0);
  r = await pedir('POST', PREF + '/shopee-semear?k=chave-rss', { _body: JSON.stringify({ cookie: 'cookie: SPC_ST=z' }) }); assert.strictEqual(r.res._s, 200, 'corpo como texto JSON também vale'); assert.strictEqual(disco[SESS_FILE].cookie, 'SPC_ST=z', 'o prefixo "cookie:" sai');
  gravaFalha = true; r = await pedir('POST', PREF + '/shopee-semear?k=chave-rss', { _body: { cookie: 'SPC_ST=w' } }); assert.strictEqual(r.res._s, 500); assert.ok(/falhou ao gravar o jar: disco cheio/.test(r.res._o.erro)); gravaFalha = false;
  assert.strictEqual((await pedir('GET', PREF + '/shopee-semear?k=chave-rss')).t, false, 'semear é só POST');
  assert.strictEqual((await pedir('POST', '/y-checkout-offline/shopee-semear?k=chave-rss')).t, false, 'só o prefixo dela');

  /* devolução */
  r = await pedir('GET', PREF + '/shopee-devolucao?rid=1'); assert.ok(r.t === true && r.res._s === 404, 'devolução sem credencial: 404');
  r = await pedir('GET', PREF + '/shopee-devolucao?rid=1', { headers: { cookie: 'sess=op' } }); assert.strictEqual(r.res._s, 404, 'sessão de operador não vale');
  r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss'); assert.strictEqual(r.res._s, 400); assert.ok(/faltou \?rid=/.test(r.res._o.erro));
  /* sem cookie na sessão */
  cookieAtual = ''; r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss&rid=77');
  assert.strictEqual(r.res._s, 200); assert.strictEqual(r.res._o.ok, false); assert.ok(r.res._o.passos.some((p) => p.passo === 'cookie' && /XBKP_SHOPEE_COOKIE/.test(p.erro)), JSON.stringify(r.res._o));
  assert.strictEqual(rede.chamadas.length, 0, 'sem cookie não vai à rede');
  cookieAtual = 'SPC_CDS=cds-1; csrftoken=tok-1; SPC_ST=st-1';
  /* rsn → rid pelo detalhe; histórico diz entregue */
  rede.detail = { data: { return: { return_id: 555 } } };
  rede.hist = { data: { list: [{ ctime: 1763000000, description: 'Pedido devolvido ao vendedor' }, { ctime: 1762900000, description: 'Em trânsito' }] } };
  r = await pedir('GET', PREF + '/shopee-devolucao?rid=&rsn=rsn-abc', { headers: { cookie: 'sess=dono' } });
  assert.strictEqual(r.res._s, 200, JSON.stringify(r.res._o));
  assert.deepStrictEqual([r.res._o.ok, r.res._o.rid, r.res._o.rsn, r.res._o.entregue, r.res._o.entregue_em, r.res._o.eventos.length, r.res._o.origem_cookie, r.res._o.passos], [true, '555', 'RSN-ABC', true, new Date(1763000000 * 1000).toISOString(), 2, 'semeado', undefined], JSON.stringify(r.res._o));
  assert.strictEqual(r.res._o.ultimo_evento.texto, 'Pedido devolvido ao vendedor');
  assert.strictEqual(rede.chamadas.length, 2); assert.ok(/return_sn=rsn-abc/i.test(rede.chamadas[0].url) && /SPC_CDS=cds-1/.test(rede.chamadas[0].url) && rede.chamadas[0].headers['X-CSRFToken'] === 'tok-1' && rede.chamadas[0].headers.Cookie === cookieAtual, 'o detalhe vai com o cookie e o csrf da sessão');
  assert.ok(/return_id=555/.test(rede.chamadas[1].url), 'o histórico vai com o rid resolvido');
  assert.deepStrictEqual(atualizadas, [200, 200], 'cada resposta passa pelo shopeeSessaoAtualiza (renova o cookie)');
  const ARQ_DEV = path.join(tmp, '_shopee-devolucoes.json');
  assert.deepStrictEqual(disco[ARQ_DEV]['rsn:RSN-ABC'], '555', 'o de-para rsn→rid vai pro disco'); assert.strictEqual(disco[ARQ_DEV]['555'].entregue, true);
  /* cache: entregue responde sem rede */
  rede.chamadas.length = 0;
  r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss&rsn=rsn-abc');
  assert.deepStrictEqual([r.res._o.ok, r.res._o.origem, r.res._o.rid, r.res._o.entregue], [true, 'cache', '555', true]); assert.strictEqual(rede.chamadas.length, 0, 'cache não vai à rede');
  /* diag=1 ignora o cache e traz os passos */
  r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss&rid=555&diag=1');
  assert.ok(Array.isArray(r.res._o.passos) && r.res._o.passos.some((p) => p.passo === 'historico'), JSON.stringify(r.res._o)); assert.strictEqual(rede.chamadas.length, 1);
  /* histórico sem "entregue" */
  rede.hist = { data: { list: [{ ctime: 1762900000, description: 'Em trânsito' }] } };
  r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss&rid=999'); assert.deepStrictEqual([r.res._o.ok, r.res._o.entregue, r.res._o.entregue_em], [true, false, null]); assert.ok(!disco[ARQ_DEV]['999'], 'não entregue não vai pro cache');
  /* rede que falha: ok:false com os passos */
  rede.detail = null; r = await pedir('GET', PREF + '/shopee-devolucao?k=chave-rss&rsn=nova'); assert.strictEqual(r.res._o.ok, false); assert.ok(/nao consegui ler a devolucao/.test(r.res._o.erro) && r.res._o.passos.some((p) => p.passo === 'resolver-rsn' && p.status === 500));
  assert.strictEqual((await pedir('POST', PREF + '/shopee-devolucao?k=chave-rss&rid=1')).t, false, 'devolução é só GET');
  assert.strictEqual((await pedir('GET', PREF + '/shopee-devolucao/x?k=chave-rss&rid=1')).t, false);

  /* 3) as três */
  const RE = require('../lib/checkout/rotas-empresa');
  assert.ok(RE.OBRIGATORIOS.includes('shopeeSessao') && RE.ORDEM.indexOf('shopeeSessao') === RE.ORDEM.indexOf('proprias') - 1, 'o passo é obrigatório e vem logo antes das próprias');
  const CFG = require('../lib/checkout/config-empresa'), PS = require('../lib/checkout/portao-sessao');
  for (const [emp, pref, arq] of [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    /* 17/11 (montarCheckout, passo 20): a empresa no lugar do prefixo — ele sai do contrato (provado em scripts/teste-prefixo-do-contrato.js) */
    assert.ok(CFG.prefixoDe(emp) === pref && s.includes("    shopeeSessao: require('../lib/checkout/rotas-shopee-sessao').criar({ empresa: '" + emp + "', VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody,\n      readJson, writeJson, ensureDir, fetch, sessao: _shopeeSessao, SHOPEE_ENV_COOKIE }),"), emp + ': tem que montar a peça com a sessão dela');
    assert.ok(!/shopee-semear'\)\) return false|shopee-devolucao'\)\) return false|_rotaShopeeSemear|_rotaShopeeDevolucao/.test(s), emp + ': sobrou a cópia das rotas');
    const pub = PS.publicasDe(CFG.configCheckout(emp));
    for (const rt of RS.ROTAS) assert.ok(pub.includes(pref + rt), emp + ': ' + rt + ' tem que ser pública no portão (checa a própria credencial)');
  }
  /* pelo routes real: sem credencial, 404 (a rota) e não 401 (o portão) */
  process.env.ADMIN_KEY = 'chave-rss-real';
  for (const [emp, pref, arq, envDir] of [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR']]) {
    process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-' + emp + '-'));
    const _log = console.log; console.log = () => {};
    let h; try { h = require(path.join(raiz, arq)).routes(async () => ({})); } finally { console.log = _log; }
    for (const [m, rt] of [['GET', '/shopee-devolucao?rid=1'], ['POST', '/shopee-semear']]) {
      const u = new URL('http://x' + pref + rt); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      const t = await h({ method: m, url: u.pathname + u.search, headers: {} }, res, u);
      assert.ok(t === true && res._s === 404 && /not found/.test(res._b), emp + ' ' + m + ' ' + rt + ': sem credencial tem que ser 404 da rota, não 401 do portão: ' + res._s + ' ' + res._b.slice(0, 80));
    }
  }
  console.log('ok — semear o cookie e consultar a devolução da Shopee: peça única das três (o código da AMB, movido); só a chave semeia, chave ou sessão de admin consulta; cache, de-para rsn→rid e renovação da sessão; públicas no portão das três');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
