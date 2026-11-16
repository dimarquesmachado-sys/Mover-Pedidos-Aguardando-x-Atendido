'use strict';
/* 15/11 — A CABEÇA COMUM DO ROUTES (docs/NORTE-2026-11.md, item C, passo 3): lib/checkout/cabeca-routes.

   O começo do handler das três empresas (/api/contexto → /descobrir-ids → portão de sessão → catálogo → sonda dos
   cancelados → operação) era igual, com os nomes da empresa à mão. Agora é a peça, com o que é da empresa vindo de
   config-empresa. Provas:
     1) config-empresa.descobrirIds: exatamente o que cada arquivo declarava (envs, padrões, rótulo); empresa nova segue a
        convenção e NÃO ganha padrão de código (Codex 16/09: sem a env, a conferência diz "falta", nunca "o padrão já é este");
     2) a peça, com peças de mentira: /api/contexto responde; /descobrir-ids sem a ADMIN_KEY → 403 e PARA (não chama o
        Bling), com a chave → consulta o Bling DESTA empresa e responde com o rótulo dela; rota protegida sem sessão → 401
        pelo portão e o catálogo/operação NÃO são chamados; com sessão → catálogo, depois operação, nessa ordem; o que
        ninguém atende devolve false; rota pública passa pelo portão; peça faltando → erro com o nome;
     3) os três arquivos usam a peça (e não têm mais a cabeça escrita à mão), com as peças deles. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { configCheckout } = require('../lib/checkout/config-empresa');

/* 1) a configuração do /descobrir-ids */
assert.deepStrictEqual(configCheckout('girassol').descobrirIds, { rotulo: 'GIRASSOL',
  envNomes: { atendido: 'GIRABKP_SIT_ATENDIDO', verificado: 'GIRABKP_SIT_VERIFICADO', aguardando: 'SITUACAO_AGUARDANDO', meLojaIds: 'ME_LOJA_IDS' },
  padroesEnv: { GIRABKP_SIT_ATENDIDO: '9', GIRABKP_SIT_VERIFICADO: '24', SITUACAO_AGUARDANDO: '745122' }, padroesExtras: { ME_LOJA_IDS: '203146903' } });
assert.deepStrictEqual(configCheckout('amb').descobrirIds, { rotulo: 'AMB',
  envNomes: { atendido: 'AMBBKP_SIT_ATENDIDO', despachados: 'AMBBKP_SIT_DESPACHADOS', verificado: 'AMBBKP_SIT_VERIFICADO', aguardando: 'AMB_SITUACAO_AGUARDANDO', meLojaIds: 'AMB_ME_LOJA_IDS' },
  padroesEnv: { AMBBKP_SIT_ATENDIDO: '9', AMBBKP_SIT_DESPACHADOS: '745123', AMBBKP_SIT_VERIFICADO: '24', AMB_SITUACAO_AGUARDANDO: '745122' }, padroesExtras: {} });
assert.deepStrictEqual(configCheckout('good').descobrirIds, { rotulo: 'GOOD',
  envNomes: { atendido: 'GOODBKP_SIT_ATENDIDO', despachados: 'GOODBKP_SIT_DESPACHADOS', verificado: 'GOODBKP_SIT_VERIFICADO', aguardando: 'GOOD_SITUACAO_AGUARDANDO', meLojaIds: 'GOOD_ME_LOJA_IDS' },
  padroesEnv: { GOODBKP_SIT_ATENDIDO: '9', GOODBKP_SIT_DESPACHADOS: '0', GOODBKP_SIT_VERIFICADO: '24', GOOD_SITUACAO_AGUARDANDO: '745122' }, padroesExtras: {} });
assert.strictEqual(configCheckout('amb').id, 'ambtotal', 'a sonda dos cancelados da AMB sempre foi montada como "ambtotal" (o id canônico)');
assert.strictEqual(configCheckout('amb').tiktokConta, 'amb');
{ const regNova = { normalizar: (x) => x, obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_' } : null) };
  assert.deepStrictEqual(configCheckout('nova', { registro: regNova }).descobrirIds, { rotulo: 'NOVA',
    envNomes: { atendido: 'NOVABKP_SIT_ATENDIDO', despachados: 'NOVABKP_SIT_DESPACHADOS', verificado: 'NOVABKP_SIT_VERIFICADO', aguardando: 'NOVA_SITUACAO_AGUARDANDO', meLojaIds: 'NOVA_ME_LOJA_IDS' },
    padroesEnv: {}, padroesExtras: {} }, 'empresa nova: convenção e nenhum padrão de código'); }
/* a configuração devolve CÓPIAS — mexer no que voltou não muda a próxima leitura */
{ const a = configCheckout('good').descobrirIds; a.padroesEnv.X = '1'; a.envNomes.atendido = 'Z';
  assert.strictEqual(configCheckout('good').descobrirIds.padroesEnv.X, undefined); assert.strictEqual(configCheckout('good').descobrirIds.envNomes.atendido, 'GOODBKP_SIT_ATENDIDO'); }

/* 2) a peça com peças de mentira */
process.env.ADMIN_KEY = 'chave-cabeca-teste';
const CAB = require('../lib/checkout/cabeca-routes');
assert.deepStrictEqual(CAB.PECAS.slice().sort(), ['blingGet', 'ehAdmin', 'json', 'lerChaveAdmin', 'lerConferidos', 'manifest', 'rotasCatalogo', 'rotasOperacao', 'uiBuild', 'validarSessao']);
const SO = require('../lib/checkout/sessao-operador');
const json = (res, status, corpo) => { res._s = status; res._b = JSON.stringify(corpo); res._fim = true; };
const lerChaveAdmin = (req, urlObj) => (urlObj.searchParams.get('k') || (req.headers && req.headers['x-admin-key']) || '');
const chamadas = []; const bling = [];
const blingGet = async (p) => { bling.push(p); return { ok: true, status: 200, data: { data: [] } }; };
const fazer = (emp) => {
  chamadas.length = 0; bling.length = 0;
  const PREF = '/' + configCheckout(emp).modulo + '/';   /* as peças de verdade (catálogo, operação) só atendem o módulo delas */
  return CAB.criar(emp, { json, lerChaveAdmin, blingGet, validarSessao: SO.validarSessao, ehAdmin: (n) => n === 'chefe',
    manifest: () => ({}), lerConferidos: () => ({}), uiBuild: 'ui-teste',
    rotasCatalogo: async (req, res, urlObj) => { if (!urlObj.pathname.startsWith(PREF)) return false; chamadas.push('catalogo:' + urlObj.pathname); if (/\/buscar-produto$/.test(urlObj.pathname)) { json(res, 200, { ok: true, de: 'catalogo' }); return true; } return false; },
    rotasOperacao: async (req, res, urlObj) => { if (!urlObj.pathname.startsWith(PREF)) return false; chamadas.push('operacao:' + urlObj.pathname); if (/\/contagem$/.test(urlObj.pathname)) { json(res, 200, { ok: true, de: 'operacao' }); return true; } return false; } });
};
async function pedir(cab, caminho, { cookie, key } = {}) {
  const u = new URL('http://x' + caminho + (key ? (caminho.includes('?') ? '&' : '?') + 'k=' + key : ''));
  const headers = {}; if (cookie) headers.cookie = cookie;
  const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._fim = true; this._b = String(b || ''); } };
  const tratou = await cab({ method: 'GET', url: u.pathname + u.search, headers }, res, u, 'GET', u.pathname);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { tratou, status: res._s, j };
}
(async () => {
  const cab = fazer('good');
  const sess = 'bkp_sess=' + SO.assinarSessao('chefe');
  /* /api/contexto: a identidade, antes de qualquer portão (é pública) */
  let r = await pedir(cab, '/good-checkout-offline/api/contexto');
  assert.ok(r.tratou && r.status === 200 && r.j && /good/i.test(JSON.stringify(r.j)) && /ui-teste/.test(JSON.stringify(r.j)), '/api/contexto tinha que responder a identidade da GOOD: ' + JSON.stringify(r).slice(0, 200));
  assert.ok(!/ADMIN_KEY|chave-cabeca-teste/.test(JSON.stringify(r.j)), 'o contexto não pode levar credencial');
  /* /descobrir-ids: só com a chave; sem ela 403 e PARA, sem encostar no Bling */
  r = await pedir(cab, '/good-checkout-offline/descobrir-ids');
  assert.ok(r.tratou && r.status === 403 && r.j.erro === 'chave inválida' && bling.length === 0, 'sem chave tinha que ser 403 sem chamar o Bling: ' + JSON.stringify(r));
  r = await pedir(cab, '/good-checkout-offline/descobrir-ids', { cookie: sess });
  assert.ok(r.status === 403 && bling.length === 0, 'sessão de admin não substitui a ADMIN_KEY no /descobrir-ids');
  r = await pedir(cab, '/good-checkout-offline/descobrir-ids', { key: 'errada' });
  assert.ok(r.status === 403 && bling.length === 0);
  /* sem ADMIN_KEY configurada no processo, NINGUÉM entra (nem com chave vazia casando com env vazia) */
  { const salva = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
    try { r = await pedir(cab, '/good-checkout-offline/descobrir-ids'); } finally { process.env.ADMIN_KEY = salva; }
    assert.ok(r.tratou && r.status === 403 && bling.length === 0, 'sem ADMIN_KEY configurada o /descobrir-ids tem que recusar: ' + JSON.stringify(r)); }
  r = await pedir(cab, '/good-checkout-offline/descobrir-ids', { key: 'chave-cabeca-teste' });
  assert.ok(r.tratou && r.status === 200 && r.j && r.j.empresa === 'GOOD' && r.j.recursos, 'com a chave tinha que descobrir com o rótulo da GOOD: ' + JSON.stringify(r).slice(0, 300));
  assert.ok(bling.length > 0 && bling.some((p) => /situacoes/.test(p)), 'tinha que perguntar ao Bling DESTA empresa: ' + bling.join(' '));
  assert.ok(JSON.stringify(r.j).includes('GOODBKP_SIT_ATENDIDO'), 'a sugestão de envs tem que usar os nomes da GOOD: ' + JSON.stringify(r.j).slice(0, 300));
  assert.deepStrictEqual(chamadas, [], 'o /descobrir-ids não passa por catálogo nem operação');
  /* rota protegida sem sessão: o portão responde 401 e NINGUÉM atrás dele é chamado */
  r = await pedir(cab, '/good-checkout-offline/buscar-produto?q=x');
  assert.ok(r.tratou && r.status === 401 && r.j && /Sessão necessária/.test(r.j.erro), 'sem sessão o portão tinha que fechar: ' + JSON.stringify(r));
  assert.deepStrictEqual(chamadas, [], 'catálogo/operação não podem ser chamados sem sessão');
  /* com sessão: catálogo primeiro; operação só se o catálogo não atendeu */
  r = await pedir(cab, '/good-checkout-offline/buscar-produto?q=x', { cookie: sess });
  assert.ok(r.tratou && r.status === 200 && r.j.de === 'catalogo', JSON.stringify(r));
  assert.deepStrictEqual(chamadas, ['catalogo:/good-checkout-offline/buscar-produto'], 'o catálogo atendeu — a operação não pode ser chamada');
  chamadas.length = 0;
  r = await pedir(cab, '/good-checkout-offline/contagem', { cookie: sess });
  assert.ok(r.tratou && r.status === 200 && r.j.de === 'operacao', JSON.stringify(r));
  assert.deepStrictEqual(chamadas, ['catalogo:/good-checkout-offline/contagem', 'operacao:/good-checkout-offline/contagem'], 'ordem: catálogo, depois operação');
  /* a ADMIN_KEY também abre o portão */
  chamadas.length = 0;
  r = await pedir(cab, '/good-checkout-offline/contagem', { key: 'chave-cabeca-teste' });
  assert.ok(r.status === 200 && r.j.de === 'operacao');
  /* o que ninguém atende: false, e o resto do handler da empresa segue */
  chamadas.length = 0;
  r = await pedir(cab, '/good-checkout-offline/rota-so-da-empresa', { cookie: sess });
  assert.ok(r.tratou === false && r.status === 0, 'rota que ninguém atende tem que devolver false: ' + JSON.stringify(r));
  assert.deepStrictEqual(chamadas, ['catalogo:/good-checkout-offline/rota-so-da-empresa', 'operacao:/good-checkout-offline/rota-so-da-empresa']);
  /* rota pública do módulo passa pelo portão sem sessão (e chega às peças) */
  chamadas.length = 0;
  r = await pedir(cab, '/good-checkout-offline/login');
  assert.ok(r.tratou === false && chamadas.length === 2, 'rota pública tinha que passar pelo portão: ' + JSON.stringify(r) + ' ' + chamadas.join(','));
  /* rota de OUTRO módulo: a cabeça desta empresa não encosta (o portão só age no módulo dela — não pode responder 401
     pela rota da outra; as peças só atendem o módulo delas) */
  chamadas.length = 0;
  r = await pedir(cab, '/amb-checkout-offline/buscar-produto');
  assert.ok(r.tratou === false && r.status === 0 && chamadas.length === 0, 'rota de outro módulo não é desta cabeça: ' + JSON.stringify(r) + ' ' + chamadas.join(','));
  /* a sonda dos cancelados é montada com o id canônico e a conta do TikTok da empresa (AMB: "ambtotal" / "amb") */
  const srcCab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'cabeca-routes.js'), 'utf8');
  assert.ok(/rotas-cancelados-mkt'\)\.criar\(\{ prefixo: PREFIXO, empresa: cfg\.id, tiktokConta: cfg\.tiktokConta,/.test(srcCab), 'a sonda tem que levar cfg.id e cfg.tiktokConta');
  assert.ok(/criar\(empresa, \{ validarSessao, lerChaveAdmin, json \}\)/.test(srcCab) && /montar\(\{ empresa, modulo: cfg\.modulo, json, uiBuild: p\.uiBuild \}\)/.test(srcCab), 'portão e contexto com a empresa como o arquivo chamava');
  /* a cabeça da AMB usa o prefixo da AMB */
  const cabA = fazer('amb');
  r = await pedir(cabA, '/amb-checkout-offline/descobrir-ids', { key: 'chave-cabeca-teste' });
  assert.ok(r.status === 200 && r.j.empresa === 'AMB' && JSON.stringify(r.j).includes('AMBBKP_SIT_ATENDIDO'), 'AMB: rótulo e envs dela: ' + JSON.stringify(r.j).slice(0, 200));
  r = await pedir(cabA, '/good-checkout-offline/descobrir-ids', { key: 'chave-cabeca-teste' });
  assert.ok(r.tratou === false, 'a cabeça da AMB não pode atender o /descobrir-ids da GOOD');
  /* peça faltando: erro com o nome, no boot (nunca em silêncio no meio de uma rota) */
  assert.throws(() => CAB.criar('good', { json, lerChaveAdmin, blingGet }), /cabeca-routes \(good\): falta validarSessao, ehAdmin, manifest, lerConferidos, uiBuild, rotasCatalogo, rotasOperacao/);
  assert.throws(() => fazer('nao-existe'), /desconhecida/);

  /* 3) as três usam a peça, e não têm mais a cabeça à mão */
  for (const [emp, arq] of [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf("require('../lib/checkout/cabeca-routes').criar('" + emp + "', {");
    assert.ok(i > 0, emp + ': tem que montar a cabeça comum com o id dela');
    const bloco = s.slice(i, s.indexOf('return async function handle(req, res, urlObj) {', i));
    assert.ok(/json, lerChaveAdmin, blingGet, validarSessao, ehAdmin, manifest, lerConferidos: \(\) => readJson\(CONFERIDOS_FILE, \{\}\),/.test(bloco) && /rotasCatalogo: _rotasCatalogo, rotasOperacao: _rotasOperacao,/.test(bloco) && /uiBuild: require\('\.\/painel-marca'\)\.UI_BUILD/.test(bloco), emp + ': as peças da cabeça têm que ser as do arquivo');
    assert.ok(/return async function handle\(req, res, urlObj\) \{\n    const \{ method \} = req;\n    const p = urlObj\.pathname;\n    if \(await _cabeca\(req, res, urlObj, method, p\)\) return true;\n/.test(s), emp + ': a cabeça tem que ser a PRIMEIRA coisa do handler');
    for (const re of [/contexto-api'\)\.montar\(/, /portao-sessao'\)\.criar\(/, /descobrir-ids'\)\.criar\(/, /rotas-cancelados-mkt'\)\.criar\(/, /_rotasCatalogo\(req, res/, /_rotasOperacao\(req, res/, /let _rotasCancMkt/, /\/descobrir-ids'\) \{/]) {
      assert.ok(!re.test(s), emp + ': sobrou a cabeça escrita à mão: ' + re);
    }
  }
  console.log('ok — a cabeça comum do routes: /api/contexto → /descobrir-ids (só ADMIN_KEY) → portão → catálogo → cancelados → operação, com o que é da empresa vindo de config-empresa; as três usam a peça');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
