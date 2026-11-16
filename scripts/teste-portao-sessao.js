'use strict';
/* 15/11 — O PORTÃO DE SESSÃO (lib/checkout/portao-sessao) FAZ EXATAMENTE O QUE O BLOCO DE CADA EMPRESA FAZIA.

   O bloco "GUARDA DE SESSÃO" era escrito à mão dentro do `routes` das três, igual a menos da lista de rotas públicas.
   Virou peça; a lista de cada empresa virou configuração (lib/checkout/config-empresa, `portao.publicasExtras`). Mudar
   uma rota de pública pra protegida muda quem abre o quê — então este teste prova três coisas:

   A. A LISTA de cada empresa é, caminho por caminho, a que estava no arquivo dela na main (fixture copiada do
      `_pub` de cada arquivo em 190f2953, Merge #893). Nem uma a mais, nem uma a menos — por empresa.
   B. A MATRIZ DE SAÍDAS da peça, com dublês: fora do prefixo · pública · callback do OAuth · chave da Toolbox · porteiro
      central · sessão válida · ADMIN_KEY · chave errada · sem ADMIN_KEY no servidor · sem credencial (401 e PARA) ·
      peça faltando (recusa ao montar) · empresa nova (só as comuns).
   C. Pelo `routes` REAL das três, sem rede: a mesma rota é pública numa empresa e protegida em outra — como era
      (/historico: Girassol e AMB têm auth própria em camadas; na GOOD o portão barra), e a chave ou a sessão abrem. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portao-sessao-'));
const CHAVE = 'chave-teste-portao';
process.env.ADMIN_KEY = CHAVE;
for (const p of ['GIRABKP', 'AMBBKP', 'GOODBKP']) { process.env[p + '_ADMIN'] = 'dono-teste'; process.env[p + '_CACHE_DIR'] = path.join(TMP, p); }
process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tiktok');

/* rede bloqueada e contada (a parte C só pede leitura/recusa) */
const rede = [];
{
  const recusa = (quem) => (...a) => { rede.push(quem + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); return Promise.reject(new Error('rede bloqueada no teste')); };
  const k = require.resolve('node-fetch');
  const duble = recusa('node-fetch'); duble.default = duble;
  require.cache[k] = { id: k, filename: k, loaded: true, exports: duble };
  global.fetch = recusa('fetch');
  for (const m of ['http', 'https']) {
    const mod = require(m);
    for (const f of ['request', 'get']) mod[f] = (...a) => { rede.push(m + '.' + f + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); throw new Error('rede bloqueada no teste'); };
  }
}

const PS = require('../lib/checkout/portao-sessao');
const CFG = require('../lib/checkout/config-empresa');

/* ───────── A. a lista de cada empresa, como estava no arquivo dela (main 190f2953) ───────── */
const COMUNS_MAIN = ['', '/', '/painel', '/js/plano-compra.js', '/js/previsao-vendas.js', '/js/ferramentas-custo.js', '/js/devolucoes-ml.js',
  '/js/despesas-shopee.js', '/js/ficha-produto.js', '/js/chat-analise.js', '/js/manutencao.js', '/js/ml-financeiro.js', '/js/nf-local.js',
  '/nf-travadas', '/login', '/operadores', '/health', '/saude', '/qz-cert', '/danfes-lote', '/dashboard',   /* 15/11 (Codex P2-2): /qz-sign saiu da lista pública — assinar exige sessão */
  '/icone.png', '/manifest.webmanifest'];   /* 15/11 (rotas-cópia, lib/checkout/rotas-pwa): o navegador busca manifesto e ícone SEM cookie — entraram nas públicas (só nome e imagem) */
const LISTA_NA_MAIN = {
  girassol: COMUNS_MAIN.concat(['/historico', '/ml-billing-resumo']),
  amb: COMUNS_MAIN.concat(['/duplicatas', '/historico', '/ml-billing-outros', '/ml-billing-resumo', '/ml-fatura-auditoria', '/ml-fatura-cartao', '/shopee-devolucao', '/shopee-semear']),
  good: COMUNS_MAIN.concat(['/backfill-status', '/backfill-vendas', '/custos-manuais', '/dashboard-antigo', '/duplicatas', '/js/projecao-mes.js', '/shopee-sessao-cookies', '/custo-historico', '/sku-depara-manual', '/sku-depara']),
};
const PREFIXO = { girassol: '/girassol-backup-offline', amb: '/amb-checkout-offline', good: '/good-checkout-offline' };
assert.deepStrictEqual([LISTA_NA_MAIN.girassol.length, LISTA_NA_MAIN.amb.length, LISTA_NA_MAIN.good.length], [25, 31, 33], 'a fixture tem o tamanho das três listas da main menos o /qz-sign (Codex P2-2) mais /icone.png e /manifest.webmanifest (15/11) (contadas por `p === \'…\'` na expressão inteira da main 190f2953 — a 1ª contagem parou num `);` de comentário e perdeu 3 da GOOD, Codex #894)');
for (const emp of ['girassol', 'amb', 'good']) {
  const cfg = CFG.configCheckout(emp);
  const peca = PS.publicasDe(cfg).slice().sort();
  const antes = LISTA_NA_MAIN[emp].map((s) => PREFIXO[emp] + s).sort();
  assert.deepStrictEqual(peca, antes, emp + ': a lista pública da peça tem que ser a do arquivo da empresa, caminho por caminho');
  assert.strictEqual(new Set(peca).size, peca.length, emp + ': caminho repetido na lista');
  for (const s of cfg.portao.publicasExtras) assert.ok(!PS.PUBLICAS_COMUNS.includes(s), emp + ': ' + s + ' está nas comuns E nas extras');
}
/* a configuração devolve uma CÓPIA: mexer nela não muda a próxima leitura */
{ const a = CFG.configCheckout('good'); a.portao.publicasExtras.push('/x'); assert.ok(!CFG.configCheckout('good').portao.publicasExtras.includes('/x'), 'a lista de extras vazou por referência'); }

/* ───────── B. a matriz de saídas, com dublês ───────── */
function montar(emp, extra) {
  const chamadas = { sessao: [], chave: [] };
  const sess = (extra && extra.sessao) || {};
  const peca = PS.criar(emp, Object.assign({
    validarSessao: (cookie) => { chamadas.sessao.push(cookie); return sess[cookie] || null; },
    lerChaveAdmin: (req, u) => { chamadas.chave.push(u.pathname); return u.searchParams.get('k'); },
    json: (res, st, body) => { res._s = st; res._b = JSON.stringify(body); res._fim = true; },
  }, (extra && extra.pecas) || {}), extra && extra.opts);
  return { peca, chamadas };
}
function pedir(peca, caminho, cookie) {
  const u = new URL('http://x' + caminho);
  const req = { headers: cookie ? { cookie } : {} }, res = { _s: 0, _b: '', _fim: false };
  const barrou = peca(req, res, u.pathname, u);
  return { barrou, req, res };
}
{
  const P = '/good-checkout-offline';
  const { peca, chamadas } = montar('good', { sessao: { 'sess=boa': 'estoquista' } });
  /* fora do prefixo: não é dele — nem olha credencial */
  let r = pedir(peca, '/amb-checkout-offline/sku-info');
  assert.deepStrictEqual([r.barrou, r.res._fim, r.req._op, chamadas.sessao.length, chamadas.chave.length], [false, false, undefined, 0, 0], 'rota de OUTRO módulo não é do portão');
  r = pedir(peca, '/good-checkout-offline-x/sku-info');
  assert.strictEqual(r.barrou, true, 'o prefixo casa por startsWith, como antes — /good-checkout-offline-x é "do módulo" e sem credencial barra');
  /* públicas: passam sem credencial e sem tocar na sessão */
  const n0 = chamadas.sessao.length;
  for (const s of ['', '/', '/painel', '/login', '/health', '/dashboard', '/js/plano-compra.js', '/backfill-status', '/dashboard-antigo', '/duplicatas']) {
    r = pedir(peca, P + s);
    assert.deepStrictEqual([r.barrou, r.res._fim, r.req._op], [false, false, undefined], 'pública ' + s + ' passou sem pedir nada');
  }
  assert.strictEqual(chamadas.sessao.length, n0, 'pública não consulta a sessão');
  /* 15/11 (Codex P2-2): /qz-sign saiu da lista pública — assinar pedido ao QZ exige sessão; o certificado segue público */
  r = pedir(peca, P + '/qz-sign?request=x'); assert.strictEqual(r.barrou, true, '/qz-sign deixou de ser público (Codex P2-2)');
  r = pedir(peca, P + '/qz-cert'); assert.strictEqual(r.barrou, false, '/qz-cert segue público (o certificado)');
  /* o que é da Girassol/AMB NÃO é público aqui (lista por empresa) */
  r = pedir(peca, P + '/historico'); assert.strictEqual(r.barrou, true, '/historico na GOOD é protegido, como era');
  r = pedir(peca, P + '/ml-billing-resumo'); assert.strictEqual(r.barrou, true, '/ml-billing-resumo na GOOD é protegido, como era');
  /* pública com querystring continua pública (o portão olha o pathname) */
  r = pedir(peca, P + '/dashboard?k=qualquer'); assert.strictEqual(r.barrou, false);
  /* um pedaço do caminho não basta: /painel/x e /loginx são protegidos */
  for (const s of ['/painel/x', '/loginx', '/js/plano-compra.js.map', '/health/']) { r = pedir(peca, P + s); assert.strictEqual(r.barrou, true, s + ' não é pública (só o caminho exato)'); }
  /* callback do OAuth, chave da Toolbox e porteiro central passam (a regra é a de lib/http/rotas-protegidas) */
  for (const s of ['/ml/callback', '/shopee/oauth/callback', '/ml-codigo-coleta', '/run', '/run/ciclo', '/robo/x', '/forcar/y', '/setup-ml', '/debug/z', '/debug-x', '/pedido/debug']) {
    r = pedir(peca, P + s); assert.strictEqual(r.barrou, false, s + ' tem que passar (callback / Toolbox / porteiro central)');
  }
  r = pedir(peca, P + '/pedido/debugging/123'); assert.strictEqual(r.barrou, true, '/pedido/debugging/123 não é rota central (Codex F01)');
  r = pedir(peca, P + '/callbackx'); assert.strictEqual(r.barrou, true, 'callback só no FIM do caminho');
  /* sessão válida: passa e o operador fica no req; a chave nem é lida */
  const c0 = chamadas.chave.length;
  r = pedir(peca, P + '/sku-info', 'sess=boa');
  assert.deepStrictEqual([r.barrou, r.req._op, r.req._admKey, r.res._fim, chamadas.chave.length], [false, 'estoquista', undefined, false, c0], 'sessão válida passa, sem olhar a chave');
  /* sem sessão, com a ADMIN_KEY: passa como admin-key */
  r = pedir(peca, P + '/sku-info?k=' + CHAVE, 'sess=ruim');
  assert.deepStrictEqual([r.barrou, r.req._op, r.req._admKey, r.res._fim], [false, 'admin-key', true, false], 'a ADMIN_KEY vale como credencial no portão (Codex PR#38)');
  /* chave errada: 401 exato e PARA */
  r = pedir(peca, P + '/sku-info?k=errada');
  assert.deepStrictEqual([r.barrou, r.res._s, JSON.parse(r.res._b), r.req._op], [true, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }, undefined], 'chave errada: 401 com o texto de sempre');
  /* sem credencial nenhuma: 401 */
  r = pedir(peca, P + '/sku-info');
  assert.deepStrictEqual([r.barrou, r.res._s, r.res._b], [true, 401, JSON.stringify({ ok: false, erro: 'Sessão necessária. Faça login.' })]);
  /* servidor SEM ADMIN_KEY: a chave certa de antes não abre (process.env vazio ⇒ ninguém passa por chave) */
  const guard = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
  try { r = pedir(peca, P + '/sku-info?k=' + CHAVE); assert.strictEqual(r.barrou, true, 'sem ADMIN_KEY no servidor, chave nenhuma abre'); }
  finally { process.env.ADMIN_KEY = guard; }
  /* ADMIN_KEY VAZIA no servidor (env criada sem valor): pedido SEM chave não pode casar '' com '' e entrar */
  process.env.ADMIN_KEY = '';
  try {
    const { peca: pecaReal } = montar('good', { pecas: { lerChaveAdmin: require('../lib/http/chave-admin').lerChaveAdmin } });
    r = pedir(pecaReal, P + '/sku-info'); assert.strictEqual(r.barrou, true, 'ADMIN_KEY vazia + pedido sem chave: tem que barrar (vazio não casa com vazio)');
    r = pedir(pecaReal, P + '/sku-info?k='); assert.strictEqual(r.barrou, true, 'ADMIN_KEY vazia + k= vazio: tem que barrar');
  } finally { process.env.ADMIN_KEY = guard; }
  /* a resposta do 401 é um objeto NOVO a cada vez (quem receber e mexer não contamina o próximo) */
  const a1 = pedir(peca, P + '/x'), a2 = pedir(peca, P + '/y'); assert.notStrictEqual(a1.res._b, undefined); assert.strictEqual(a1.res._b, a2.res._b);
}
/* peça faltando: recusa ao MONTAR, dizendo qual */
for (const falta of ['validarSessao', 'lerChaveAdmin', 'json']) {
  const pecas = { validarSessao: () => null, lerChaveAdmin: () => null, json: () => {} }; delete pecas[falta];
  assert.throws(() => PS.criar('amb', pecas), new RegExp('portao-sessao \\(ambtotal\\): falta a peça ' + falta), 'sem ' + falta + ' tinha que recusar');
}
/* o porteiro central pode ser injetado (os testes de uma regra nova não precisam da real) */
{
  const { peca } = montar('amb', { pecas: { rotasProtegidas: { ehCallbackOAuth: () => false, ehRotaChaveToolbox: () => false, ehRotaCentralAdmin: (p) => p.endsWith('/livre') } } });
  assert.strictEqual(pedir(peca, '/amb-checkout-offline/x/livre').barrou, false);
  assert.strictEqual(pedir(peca, '/amb-checkout-offline/ml/callback').barrou, true, 'com o porteiro injetado, vale só a regra dele');
}
/* empresa NOVA (só no contrato, sem exceção nenhuma): as comuns e mais nada, com o prefixo da convenção */
{
  const reg = require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' });
  const falsa = {
    normalizar: (id) => (id === 'nova' ? 'nova' : reg.normalizar(id)),
    obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_' } : reg.obter(id)),
  };
  const cfg = CFG.configCheckout('nova', { registro: falsa });
  assert.deepStrictEqual(cfg.portao, { publicasExtras: [] });
  assert.deepStrictEqual(PS.publicasDe(cfg).sort(), PS.PUBLICAS_COMUNS.map((s) => '/nova-checkout-offline' + s).sort(), 'empresa nova: só as comuns');
  const peca = PS.criar('nova', { validarSessao: () => null, lerChaveAdmin: () => null, json: (res, st) => { res._s = st; } }, { registro: falsa });
  assert.strictEqual(pedir(peca, '/nova-checkout-offline/painel').barrou, false);
  assert.strictEqual(pedir(peca, '/nova-checkout-offline/historico').barrou, true, 'empresa nova não herda exceção de ninguém');
}

/* ───────── C. pelo routes REAL das três ───────── */
const EMPRESAS = [
  ['girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
  ['amb', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['good', 'good-checkout-offline/index.js', '/good-checkout-offline'],
];
function cookieDe(nome, fonte) {
  /* 15/11: a sessão de operador é a peça lib/checkout/sessao-operador — o arquivo da empresa tem que usá-la, e o nome do cookie vem dela */
  assert.ok(/= require\('\.\.\/lib\/checkout\/sessao-operador'\);/.test(fonte), 'a empresa tem que usar a peça da sessão de operador');
  const m = /const SESS_COOKIE\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'sessao-operador.js'), 'utf8'));
  assert.ok(m, 'não achei o nome do cookie de sessão na peça');
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + 600000 })).toString('base64url');
  return m[1] + '=' + pl + '.' + crypto.createHmac('sha256', CHAVE).update(pl).digest('base64url');
}
async function pedirReal(handler, metodo, caminho, { cookie, chave } = {}) {
  const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._fim = true; this._b = String(b == null ? '' : b); } };
  const u = new URL('http://x' + caminho + (chave ? (caminho.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(chave) : ''));
  const headers = {}; if (cookie) headers.cookie = cookie;
  const tratou = await handler({ method: metodo, url: u.pathname + u.search, headers }, res, u);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { tratou, status: res._s, corpo: res._b, j };
}
const ehPortao = (r) => r.tratou === true && r.status === 401 && r.j && r.j.erro === 'Sessão necessária. Faça login.';

(async () => {
  for (const [emp, arq, P] of EMPRESAS) {
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(!/const _pub = \(/.test(fonte), emp + ': o bloco antigo da guarda ainda está no arquivo');
    /* 15/11: o portão é montado pela CABEÇA COMUM (lib/checkout/cabeca-routes), com o id da empresa */
    assert.ok(fonte.includes("require('../lib/checkout/cabeca-routes').criar('" + emp + "'"), emp + ': o arquivo não monta a cabeça comum (e o portão) com o id dele');
    assert.ok(/portao-sessao'\)\.criar\(empresa, \{ validarSessao, lerChaveAdmin, json \}\)/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'cabeca-routes.js'), 'utf8')), 'a cabeça não monta o portão da peça');
    const mod = require(path.join(raiz, arq));
    const h = mod.routes(async () => ({}));
    const operador = cookieDe('estoquista-teste', fonte);
    const antesRede = rede.length;
    /* protegida sem credencial: o 401 do portão — inclusive as rotas do CATÁLOGO, que não validam sessão sozinhas e
       por isso têm que vir DEPOIS do portão (Codex #480) */
    for (const s of ['/buscar-produto?q=x', '/buscar-produto-nome?q=x', '/indexar-status', '/indexar-catalogo']) {
      const c = await pedirReal(h, 'GET', P + s);
      assert.ok(ehPortao(c), emp + ': ' + s + ' sem credencial devia ser barrado pelo portão (o catálogo ficou na frente dele): ' + c.status + ' ' + c.corpo.slice(0, 80));
    }
    let r = await pedirReal(h, 'GET', P + '/sku-info?sku=X');
    assert.ok(ehPortao(r), emp + ': /sku-info sem credencial devia ser barrado pelo portão: ' + r.status + ' ' + r.corpo.slice(0, 80));
    r = await pedirReal(h, 'GET', P + '/sku-info?sku=X', { chave: 'errada' });
    assert.ok(ehPortao(r), emp + ': chave errada devia ser barrada');
    /* pública sem credencial: NÃO é o 401 do portão (a rota responde por conta — o login, por exemplo, é dela) */
    for (const s of ['/health', '/login', '/js/plano-compra.js']) {
      r = await pedirReal(h, 'GET', P + s);
      assert.ok(!ehPortao(r), emp + ': ' + s + ' é pública e o portão barrou');
    }
    /* a MESMA rota: pública onde a empresa listava (a rota responde com a auth PRÓPRIA dela), protegida onde não —
       exatamente como na main. (/historico não serve de prova: a auth própria dele responde o MESMO 401 do portão.) */
    r = await pedirReal(h, 'GET', P + '/duplicatas');
    if (emp === 'girassol') assert.ok(ehPortao(r), 'Girassol: /duplicatas sem credencial é barrado pelo portão (como era)');
    else assert.ok(r.tratou === true && r.status === 404 && r.j && r.j.error === 'not found', emp + ': /duplicatas é pública e a rota recusa por conta (404 dela), não o portão (' + r.status + ' ' + r.corpo.slice(0, 60) + ')');
    /* as três de custo/de-para da GOOD (Codex #894: tinham ficado fora da lista): públicas nela, com o 404 PRÓPRIO sem chave */
    for (const s of ['/sku-depara', '/custo-historico']) {
      r = await pedirReal(h, 'GET', P + s);
      if (emp === 'good') assert.ok(r.tratou === true && r.status === 404 && r.j && r.j.error === 'not found', 'GOOD: ' + s + ' é pública e a rota recusa por conta (404 dela): ' + r.status + ' ' + r.corpo.slice(0, 60));
      else assert.ok(ehPortao(r), emp + ': ' + s + ' é protegido pelo portão (como era)');
    }
    r = await pedirReal(h, 'GET', P + '/backfill-status');
    if (emp === 'good') assert.ok(r.tratou === true && r.status === 404 && r.j && r.j.error === 'not found', 'GOOD: /backfill-status é pública e a rota recusa por conta (404 dela, de propósito), não o portão (' + r.status + ')');
    else assert.ok(ehPortao(r), emp + ': /backfill-status é protegido pelo portão (como era)');
    /* a chave e a sessão abrem o portão (a rota decide o resto) */
    r = await pedirReal(h, 'GET', P + '/localizacoes-log', { chave: CHAVE });
    assert.ok(r.tratou === true && r.status === 200 && r.j && r.j.ok === true, emp + ': com a ADMIN_KEY o portão tinha que abrir (' + r.status + ')');
    r = await pedirReal(h, 'GET', P + '/localizacoes-log', { cookie: operador });
    assert.ok(r.tratou === true && r.status === 200 && r.j && r.j.ok === true, emp + ': com a sessão o portão tinha que abrir (' + r.status + ')');
    /* o portão de uma empresa não barra a rota de outra */
    for (const [, , outro] of EMPRESAS) if (outro !== P) {
      r = await pedirReal(h, 'GET', outro + '/sku-info');
      assert.ok(!ehPortao(r), emp + ': barrou uma rota do prefixo ' + outro);
    }
    assert.deepStrictEqual(rede.slice(antesRede), [], emp + ': tentou REDE: ' + rede.slice(antesRede).join(' | '));
  }
  console.log('ok — portão de sessão: a lista pública de cada empresa é a do arquivo dela menos o /qz-sign (23/29/31), a matriz de saídas da peça, empresa nova só com as comuns, e pelo routes real das três a mesma rota é pública ou protegida exatamente como era; zero rede');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
