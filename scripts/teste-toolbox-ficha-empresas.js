'use strict';
/* 2.1.20 (V-09 do roteiro do Devoluções) — A TOOLBOX NÃO É MAIS FECHADA EM TRÊS.

   A lista das empresas vive em UM arquivo (toolbox-extensao/tb-empresas.js) e as telas se montam
   dela. Este teste prova, EXECUTANDO os arquivos de produção num navegador de mentira:
   · a ficha bate com o contrato-empresas.json (mesmas empresas, mesmo prefixo no Devoluções);
   · a ficha bate com o que a ponte de Devoluções (bg-devolucoes.js, ENDERECO_IDS) atende;
   · o popup e a Central desenham cada empresa a partir da ficha: botões da 1ª configuração,
     cartões/ajuda só dos módulos que a empresa tem, links com o prefixo certo e a barra no fim;
   · UMA QUARTA EMPRESA, acrescentada só na ficha, aparece em tudo (botão, links, módulos da
     Central) — sem editar popup.js, central.js nem tb-acoes.js;
   · os arquivos já migrados não voltaram a ter mapa próprio por empresa (varredura; a lista
     2.1.21: todos os bg-X/ct-X/telas migrados). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const ext = (f) => path.join(raiz, 'toolbox-extensao', f);
const ler = (f) => fs.readFileSync(ext(f), 'utf8');

const ficha = require(ext('tb-empresas.js'));
const contrato = require(path.join(raiz, 'contrato-empresas.json'));

/* ── 1. ficha × contrato ── */
for (const id of Object.keys(contrato.empresas)) {
  const c = contrato.empresas[id];
  if (!c || typeof c !== 'object' || !c.id_canonico) continue;
  const k = ficha.tbChave(c.id_canonico);
  assert.ok(k, 'a empresa "' + c.id_canonico + '" está no contrato-empresas.json e NÃO na ficha da Toolbox (tb-empresas.js) — é assim que uma empresa fica sem extensão');
  assert.strictEqual(ficha.TB_EMPRESAS[k].devolucoes, c.slug_http, 'prefixo do Devoluções da ' + k + ' na ficha ≠ slug_http do contrato');
  for (const a of (c.aliases || [])) assert.strictEqual(ficha.tbChave(a), k, 'o alias "' + a + '" do contrato não resolve pra ' + k + ' na ficha');
}
for (const k of ficha.tbEmpresas()) {
  const f = ficha.TB_EMPRESAS[k];
  assert.ok(contrato.empresas[f.canonico], 'a ficha tem "' + k + '" (canônico ' + f.canonico + ') e o contrato não — empresa só existe quando está nos dois');
  for (const campo of ['nome', 'curto', 'emoji', 'checkout', 'fiscal']) assert.strictEqual(typeof f[campo], 'string', k + ': campo ' + campo + ' ausente');
  assert.ok(f.respostas && f.respostas.loja && f.respostas.instancia, k + ': falta respostas.loja/instancia');
}
assert.strictEqual(ficha.tbChave(''), '', 'vazio não resolve');
assert.strictEqual(ficha.tbChave('inventada'), '', 'desconhecida não resolve');
assert.strictEqual(ficha.tbTem('inventada', 'shopee'), false, 'desconhecida não tem módulo nenhum');

/* ── 2. ficha × ponte de Devoluções (e os outros fundos) — EXECUTANDO os bg-* com a ficha ── */
function fundos(fichaExtra) {
  const chrome = { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => ({}), id: 'ext', getManifest: () => ({ version: 'teste' }) },
    webRequest: { onSendHeaders: { addListener() {} }, onBeforeSendHeaders: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: (k, cb) => { const r = {}; if (cb) cb(r); return Promise.resolve(r); }, set: async () => {} } },
    alarms: { create() {}, clear() {}, get(n, cb) { cb && cb(undefined); }, onAlarm: { addListener() {} } },
    tabs: { query: async () => [] }, windows: { update: async () => {} }, scripting: { executeScript: async () => [] } };
  const ctx = vm.createContext({ chrome, console: { log() {}, warn() {}, error() {} }, Date, String, Number, JSON, Promise, Map, Set, Math, Array, Object, Error, setTimeout, clearTimeout, encodeURIComponent, Intl, AbortController, fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) });
  vm.runInContext(ler('tb-empresas.js'), ctx);
  if (fichaExtra) vm.runInContext('Object.assign(TB_EMPRESAS, ' + JSON.stringify(fichaExtra) + '); TB_ORDEM.push(' + JSON.stringify(Object.keys(fichaExtra)[0]) + ');', ctx);
  for (const f of ['bg-devolucoes.js', 'bg-situacao.js', 'bg-coleta.js']) vm.runInContext(ler(f), ctx);
  return { ENDERECO_IDS: vm.runInContext('ENDERECO_IDS', ctx), PREFIXO_REGISTRO: vm.runInContext('PREFIXO_REGISTRO', ctx), SIT_PREFIXO: vm.runInContext('SIT_PREFIXO', ctx), COLETA_PREFIXO: vm.runInContext('COLETA_PREFIXO', ctx), chaveDaEmpresa: vm.runInContext('chaveDaEmpresa', ctx) };
}
{
  const F = fundos();
  for (const k of ficha.tbEmpresas()) {
    const f = ficha.TB_EMPRESAS[k];
    assert.ok(F.ENDERECO_IDS[f.canonico], 'a ponte de Devoluções não atende a ' + k);
    assert.ok(F.ENDERECO_IDS[f.canonico].startsWith(f.devolucoes + '/api/ids-fiscais'), 'endereço dos ids da ' + k + ' com o prefixo da ficha: ' + F.ENDERECO_IDS[f.canonico]);
    assert.strictEqual(F.PREFIXO_REGISTRO[f.canonico], f.devolucoes, 'prefixo de registro da ' + k + ' = prefixo da ficha');
    assert.strictEqual(F.SIT_PREFIXO[k], f.fiscal, 'prefixo fiscal (Consultar situação) da ' + k + ' = ficha');
    assert.strictEqual(F.COLETA_PREFIXO[k], '/' + f.checkout, 'prefixo do checkout (código da coleta) da ' + k + ' = ficha');
    assert.strictEqual(F.chaveDaEmpresa(k), f.canonico, 'chaveDaEmpresa(' + k + ') = canônico');
    for (const a of (f.aliases || [])) assert.strictEqual(F.chaveDaEmpresa(a), f.canonico, 'chaveDaEmpresa(' + a + ') = canônico');
  }
  assert.strictEqual(F.ENDERECO_IDS.good, '/api/ids-fiscais?empresa=good', 'a raiz (GOOD) continua pedindo os ids com ?empresa=good');
  assert.strictEqual(Object.keys(F.ENDERECO_IDS).length, ficha.tbEmpresas().length, 'a ponte atende exatamente as empresas da ficha');
}

/* ── 3. o popup de verdade, num DOM de mentira ── */
function domFalso() {
  const els = {};
  const mk = (id) => {
    const e = { id, textContent: '', _html: '', style: {}, _cls: new Set(), _ev: {}, dataset: {} };
    e.classList = { toggle: (c) => (e._cls.has(c) ? e._cls.delete(c) : e._cls.add(c)), add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), contains: (c) => e._cls.has(c) };
    e.addEventListener = (t, f) => { e._ev[t] = f; };
    e.querySelector = () => mk('x');
    Object.defineProperty(e, 'innerHTML', { get: () => e._html, set: (v) => { e._html = v; } });
    return e;
  };
  const el = (id) => (els[id] = els[id] || mk(id));
  return { els, document: { getElementById: el, querySelectorAll: () => [] } };
}
function abrirPopup(empresaGravada, fichaExtra) {
  const dom = domFalso();
  const abertas = [];
  const ctx = vm.createContext({ document: dom.document, console, Object, String, Array, URL, window: { close() {} },
    chrome: { runtime: { getManifest: () => ({ version: '9.9.9' }), getURL: (u) => 'ext://' + u }, tabs: { create: (o) => abertas.push(o.url) },
      storage: { local: { get: (ks, cb) => cb({ tb_empresa: empresaGravada }), set: (v, cb) => cb(), remove: (k, cb) => cb() }, sync: { get: (ks, cb) => cb({}) } } } });
  vm.runInContext(ler('tb-empresas.js'), ctx);
  if (fichaExtra) vm.runInContext('Object.assign(TB_EMPRESAS, ' + JSON.stringify(fichaExtra) + '); TB_ORDEM.push(' + JSON.stringify(Object.keys(fichaExtra)[0]) + ');', ctx);
  vm.runInContext(ler('popup.js'), ctx);
  return { els: dom.els, abertas };
}
const HOST_DEV = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';
/* o esperado sai do DADO da ficha (`sem`), não da função — senão uma tbTem quebrada concordaria consigo mesma */
const tem = (k, m) => (ficha.TB_EMPRESAS[k].sem || []).indexOf(m) === -1;
{
  const p = abrirPopup(null);
  const botoes = [...p.els.botoesEmpresa.innerHTML.matchAll(/data-emp="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(botoes, ficha.tbEmpresas(), 'os botões da 1ª configuração são as empresas da ficha, na ordem');
  assert.strictEqual(p.els.selEmpresa.style.display, 'block', 'sem empresa gravada mostra a escolha');
}
for (const k of ficha.tbEmpresas()) {
  const f = ficha.TB_EMPRESAS[k];
  const p = abrirPopup(k);
  assert.strictEqual(p.els.empNome.textContent, f.curto, k + ': nome curto no título');
  const cards = p.els.cards.innerHTML, ajuda = p.els.ajuda.innerHTML, links = p.els.links.innerHTML;
  assert.strictEqual(/href="bling\.html"/.test(cards), tem(k, 'bling'), k + ': cartão Cookie Bling só pra quem tem o módulo');
  assert.strictEqual(/href="mm\.html"/.test(cards), tem(k, 'mm'), k + ': cartão Madeira só pra quem tem o módulo');
  assert.strictEqual(/NF-e Fulfillment<\/b>/.test(ajuda), tem(k, 'mlfull'), k + ': ajuda do NF-e Fulfillment só pra quem tem');
  assert.strictEqual(/Esteira de preços/.test(ajuda), tem(k, 'esteira'), k + ': ajuda da Esteira só pra quem tem');
  /* ⚠️ A BARRA NO FIM: sem ela o módulo da empresa não abre (o dono testou na tela) */
  const dev = new RegExp('data-url="' + HOST_DEV.replace(/[.]/g, '\\.') + '([^"]*)">🔗 ↩️ Devoluções ' + f.curto + '<').exec(links);
  assert.ok(dev, k + ': falta o link de Devoluções dela no popup — foi o que aconteceu com a Girassol em 28/09');
  assert.strictEqual(dev[1], f.devolucoes + '/', k + ': link de Devoluções com prefixo da ficha e barra no fim');
  assert.ok(links.indexOf('/' + f.checkout + '/">🔗 🛒 Checkout offline ' + f.curto + '<') !== -1, k + ': link do checkout da ficha');
  assert.ok(links.indexOf('/respostas-rapidas/' + f.respostas.instancia + '/painel">') !== -1, k + ': link do painel de Respostas pela instância da ficha');
  assert.ok(/^Rodam sozinhos: /.test(p.els.autos.textContent), k + ': texto do que roda sozinho');
}

/* ── 4. a QUARTA empresa nasce só de dado ── */
const QUARTA = { lirio: { nome: 'Lírio Casa', curto: 'Lírio', emoji: '🌷', canonico: 'lirio', checkout: 'lirio-checkout-offline', devolucoes: '/lirio', fiscal: '/lirio', respostas: { loja: 'LIRIO', instancia: 'lirio' }, sem: [] } };
{
  const p = abrirPopup(null, QUARTA);
  assert.ok(/data-emp="lirio">🌷 Lírio Casa</.test(p.els.botoesEmpresa.innerHTML), 'a quarta empresa ganha botão na 1ª configuração sem mexer no popup');
  const q = abrirPopup('lirio', QUARTA);
  assert.strictEqual(q.els.empNome.textContent, 'Lírio', 'a quarta empresa abre o menu');
  assert.ok(/href="bling\.html"/.test(q.els.cards.innerHTML) && /href="mm\.html"/.test(q.els.cards.innerHTML), 'a quarta empresa tem TODOS os cartões (nivelar por cima: módulo novo é de todas, salvo `sem`)');
  assert.ok(q.els.links.innerHTML.indexOf(HOST_DEV + '/lirio/">🔗 ↩️ Devoluções Lírio<') !== -1, 'a quarta empresa tem o link de Devoluções com o prefixo dela e barra no fim');
  assert.ok(q.els.links.innerHTML.indexOf('/lirio-checkout-offline/">') !== -1, 'a quarta empresa tem o link do checkout dela');
}

/* ── 4b. a quarta empresa chega aos fundos (ponte, situação, coleta) sem editar nenhum deles ── */
{
  const F = fundos(QUARTA);
  assert.strictEqual(F.ENDERECO_IDS.lirio, '/lirio/api/ids-fiscais', 'a ponte atende a quarta empresa pelo prefixo da ficha');
  assert.strictEqual(F.PREFIXO_REGISTRO.lirio, '/lirio', 'o registro da quarta empresa vai pra área dela');
  assert.strictEqual(F.SIT_PREFIXO.lirio, '/lirio', 'o Consultar situação da quarta empresa vai pro módulo fiscal dela');
  assert.strictEqual(F.COLETA_PREFIXO.lirio, '/lirio-checkout-offline', 'o código da coleta da quarta empresa vai pro checkout dela');
  assert.strictEqual(F.chaveDaEmpresa('LIRIO'), 'lirio', 'a quarta empresa resolve pelo nome');
}

/* ── 5. a Central (tb-acoes.js) lê a mesma ficha ── */
function acoes(fichaExtra) {
  const ctx = vm.createContext({ chrome: { storage: { local: { get: async () => ({}) }, sync: { get: (k, cb) => cb({}) } } }, console, Object, String, Array, Promise, Map, JSON, setTimeout, clearTimeout, encodeURIComponent, navigator: { userAgent: 'x' } });
  ctx.self = ctx;
  vm.runInContext(ler('tb-empresas.js'), ctx);
  if (fichaExtra) vm.runInContext('Object.assign(TB_EMPRESAS, ' + JSON.stringify(fichaExtra) + '); TB_ORDEM.push(' + JSON.stringify(Object.keys(fichaExtra)[0]) + ');', ctx);
  vm.runInContext(ler('tb-acoes.js'), ctx);
  return ctx.tbAcoes;
}
{
  const T = acoes();
  for (const k of ficha.tbEmpresas()) {
    const f = ficha.TB_EMPRESAS[k];
    assert.strictEqual(T.NOME[k], f.nome, k + ': NOME da Central vem da ficha');
    assert.strictEqual(T.CHECKOUT[k], f.checkout, k + ': CHECKOUT da Central vem da ficha');
    assert.strictEqual(T.LOJA_RESPOSTAS[k], f.respostas.loja, k + ': loja das Respostas vem da ficha');
    const ids = T.itensDa(k).map((i) => i.id);
    assert.strictEqual(ids.indexOf('bling') !== -1, tem(k, 'bling'), k + ': Cookie Bling na Central só pra quem tem');
    assert.strictEqual(ids.indexOf('mm') !== -1, tem(k, 'mm'), k + ': Madeira na Central só pra quem tem');
  }
  assert.strictEqual(T.itensDa('inventada').length, 0, 'empresa desconhecida não tem item nenhum na Central');
  const T4 = acoes(QUARTA);
  assert.strictEqual(T4.itensDa('lirio').length, T4.ITENS.length, 'a quarta empresa tem todos os módulos na Central');
  assert.strictEqual(T4.NOME.lirio, 'Lírio Casa', 'a quarta empresa tem nome na Central');
}
{
  /* a Central preenche o <select> da ficha */
  const central = ler('central.js');
  assert.ok(/for \(const k of tbEmpresas\(\)\)[^\n]*createElement\('option'\)/.test(central), 'central.js monta as opções de empresa a partir da ficha');
  assert.ok(!/<option value="(girassol|good|amb)"/.test(ler('central.html')), 'central.html não tem mais as 3 empresas fixas');
  assert.ok(!/data-emp="(girassol|good|amb)"/.test(ler('popup.html')), 'popup.html não tem mais os 3 botões fixos');
  for (const h of ['popup.html', 'central.html']) assert.ok(/<script src="tb-empresas\.js"><\/script>/.test(ler(h)), h + ' carrega a ficha antes dos scripts que a usam');
}

/* ── 5b. os ids do Bling do NF-e Fulfillment (ct-nf.js) saíram dos mapas e vivem na ficha — os MESMOS números medidos no HTML do Bling ── */
{
  assert.deepStrictEqual(ficha.TB_EMPRESAS.good.blingFull, { magalu: { loja: '203381869', unidade: '1726045' } }, 'GOOD: loja/unidade do Magalu Full no Bling');
  assert.deepStrictEqual(ficha.TB_EMPRESAS.amb.blingFull, { magalu: { loja: '206018666', unidade: '2920232' }, shopee: { loja: '206017368', unidade: '2920348' } }, 'AMB: loja/unidade do Magalu Full e do Shopee Full no Bling');
  assert.ok(!ficha.TB_EMPRESAS.girassol.blingFull, 'Girassol não tem NF-e Fulfillment (sem ids)');
  const nf = ler('ct-nf.js');
  assert.ok(/LOJA\[_k\] = _f\.blingFull\.magalu\.loja; UNIDADE\[_k\] = _f\.blingFull\.magalu\.unidade;/.test(nf), 'ct-nf.js monta loja/unidade do Magalu da ficha');
  assert.ok(/LOJA_BLING\[_k\] = _f\.blingFull\.shopee\.loja; UNIDADE_BLING\[_k\] = _f\.blingFull\.shopee\.unidade;/.test(nf), 'ct-nf.js monta loja/unidade da Shopee da ficha');
  assert.ok(!/\{ good: '203381869'|\{ amb: '206017368'/.test(nf), 'os ids não estão mais escritos no ct-nf.js');
}

/* ── 5c. Codex #950 (P1): a ficha tem que ser carregada em TODO caminho que o navegador usa — não só no service worker
   do Chrome. O Firefox roda `background.scripts` do manifest (não o importScripts do bg-toolbox.js); cada grupo de
   content scripts é um escopo próprio; cada página .html carrega seus scripts. Quem chama tbFicha/tbEmpresas/tbTem
   precisa da ficha ANTES, em cada um desses caminhos. ── */
{
  const usaFicha = (f) => /\btb(Ficha|Empresas|Tem|Chave|QuemTem)\(/.test(ler(f));
  const manifesto = JSON.parse(ler('manifest.json'));
  assert.strictEqual(manifesto.background.scripts[0], 'tb-empresas.js', 'Firefox: background.scripts do manifest começa pela ficha');
  assert.ok(/importScripts\('tb-empresas\.js'/.test(ler('bg-toolbox.js')), 'Chrome/Edge: o service worker importa a ficha primeiro');
  for (const f of manifesto.background.scripts) assert.ok(fs.existsSync(ext(f)), 'background.scripts aponta pra arquivo que existe: ' + f);
  for (const cs of manifesto.content_scripts) {
    const precisa = cs.js.filter(usaFicha);
    if (!precisa.length) continue;
    const i = cs.js.indexOf('tb-empresas.js');
    assert.ok(i === 0, 'grupo de content scripts ' + JSON.stringify(cs.matches) + ' usa a ficha em ' + precisa.join(', ') + ' e não a carrega primeiro');
  }
  for (const h of fs.readdirSync(ext('.')).filter((x) => /\.html$/.test(x))) {
    const html = ler(h);
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const precisa = scripts.filter((f) => f !== 'tb-empresas.js' && fs.existsSync(ext(f)) && usaFicha(f));
    if (!precisa.length) continue;
    assert.ok(scripts.indexOf('tb-empresas.js') === 0, h + ' usa a ficha em ' + precisa.join(', ') + ' e não a carrega primeiro: ' + scripts.join(' → '));
  }
  /* e os content scripts de verdade rodam SEM ReferenceError quando a ficha vem antes? (a ponte, a situação e a coleta já rodam acima; aqui o Frágil) */
  const ctx = vm.createContext({ chrome: { storage: { local: { get: (k, cb) => cb({ tb_empresa: 'amb' }) }, onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } }, alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } } }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, fetch: async () => ({ ok: false }), Promise, JSON, Object, String, Date });
  vm.runInContext(ler('tb-empresas.js'), ctx); vm.runInContext(ler('bg-fragil.js'), ctx);
  vm.runInContext('empresaFragil()', ctx).then((empFragil) => {
    assert.strictEqual(empFragil, 'ambtotal', 'o Frágil manda o id canônico da ficha (amb → ambtotal)');
  }).catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
}

/* ── 6. varredura: mapa por empresa só na ficha ── */
const MIGRADOS = ['popup.js', 'tb-acoes.js', 'central.js', 'bg-devolucoes.js', 'bg-situacao.js', 'bg-coleta.js', 'bg-mm.js', 'bg-fragil.js', 'ct-nf.js', 'ct-respostas.js', 'ct-mm.js', 'ct-esteira.js', 'shopee.js', 'respostas.js', 'bling.js'];
const MAPA = /\b(girassol|good|amb|ambtotal)\s*:\s*['"\[{]|['"](girassol|good|amb|ambtotal)['"]\s*,\s*['"](girassol|good|amb|ambtotal)['"]|emp(resa)?\s*[!=]==?\s*['"](girassol|good|amb|ambtotal)['"]/;
for (const f of MIGRADOS) {
  const semComentarios = ler(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = MAPA.exec(semComentarios);
  assert.ok(!m, f + ' voltou a ter lista/mapa por empresa fora da ficha: "' + (m && m[0]) + '" — a lista é só a de tb-empresas.js');
}

console.log('OK: Toolbox — a ficha das empresas é uma só (bate com o contrato e com a ponte), popup e Central se montam dela, e uma quarta empresa nasce só de dado');
