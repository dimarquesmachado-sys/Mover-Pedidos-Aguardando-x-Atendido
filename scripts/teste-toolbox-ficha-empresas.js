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
     cresce a cada arquivo migrado — os bg-X/ct-X entram no PR seguinte). */
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

/* ── 2. ficha × ponte de Devoluções ── */
const bg = ler('bg-devolucoes.js');
const bloco = /const ENDERECO_IDS = \{([\s\S]*?)\};/.exec(bg);
assert.ok(bloco, 'sumiu o ENDERECO_IDS do bg-devolucoes');
for (const m of bloco[1].matchAll(/^\s*(\w+):\s*'([^']*)'/gm)) {
  const k = ficha.tbChave(m[1]);
  assert.ok(k, 'a ponte atende "' + m[1] + '" e a ficha não conhece');
  assert.ok(m[2].startsWith(ficha.TB_EMPRESAS[k].devolucoes + '/api/'), 'o endereço da ponte da ' + k + ' (' + m[2] + ') não começa pelo prefixo da ficha (' + ficha.TB_EMPRESAS[k].devolucoes + ')');
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

/* ── 6. varredura: mapa por empresa só na ficha ── */
const MIGRADOS = ['popup.js', 'tb-acoes.js', 'central.js'];
const MAPA = /\b(girassol|good|amb|ambtotal)\s*:\s*['"\[{]|['"](girassol|good|amb|ambtotal)['"]\s*,\s*['"](girassol|good|amb|ambtotal)['"]|emp(resa)?\s*[!=]==?\s*['"](girassol|good|amb|ambtotal)['"]/;
for (const f of MIGRADOS) {
  const semComentarios = ler(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = MAPA.exec(semComentarios);
  assert.ok(!m, f + ' voltou a ter lista/mapa por empresa fora da ficha: "' + (m && m[0]) + '" — a lista é só a de tb-empresas.js');
}

console.log('OK: Toolbox — a ficha das empresas é uma só (bate com o contrato e com a ponte), popup e Central se montam dela, e uma quarta empresa nasce só de dado');
