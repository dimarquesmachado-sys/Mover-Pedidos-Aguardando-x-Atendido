'use strict';
/* 30/10 — passo 2 das ROTAS DE LOTE (lib/checkout/rotas-lote): a AMB e a Girassol GANHAM o que só a GOOD tinha — etiquetas
   em MASSA (o ZIP da Shopee: cada etiqueta casa com o pedido pela NF de dentro dela), a página de envio, as DANFEs em lote
   e o botão 📎 no painel (só admin). O comportamento da peça está provado em scripts/teste-rotas-lote-peca.js (inclusive
   com o prefixo da AMB); aqui: as três montam a peça com o prefixo, o log, o nome e a empresa DELAS, chamam DENTRO do
   handler (depois do porteiro de sessão), deixam o lote de DANFEs com o guard próprio (como a GOOD), e o painel de cada
   uma tem o botão apontando pra rota DELA.

   17/11 (norte C, montarCheckout passo 15): as três montam o lote PELO CONTRATO — `daEmpresa(empresa, { readBody, base, nf })`;
   o bloco escrito à mão de cada uma (docs/HISTORICO-ROTAS-LOTE.md) saiu. A prova, RODANDO com o base e as NFs reais de cada
   pasta (as envs de cada uma apontando pra uma pasta temporária, sessão de verdade):
     · o que o bloco de antes escrevia à mão sai igual: o prefixo nas rotas e na página, o nome no título, a tag, e o id
       nas Devoluções ('girassol' · 'amb' · 'good');
     · as peças são as do base DELA: a etiqueta grava na pasta dela, com o formato dela, no manifesto dela; quem é admin
       é o admin DELA (o admin de outra empresa leva 403); a DANFE vem das NFs que a pasta entrega;
     · faltou o base ou as NFs, ou empresa fora do contrato: derruba na montagem, com o nome. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const EMP = [
  /* nome, arquivo, pasta, empresa, a tag, o nome e o id nas Devoluções que o bloco de antes escrevia à mão */
  ['GOOD', 'good-checkout-offline/index.js', 'good-checkout-offline', 'good', 'GOODBKP', 'GOOD', 'good'],
  ['AMB', 'amb-checkout-offline/index.js', 'amb-checkout-offline', 'amb', 'AMBBKP', 'AMB', 'amb'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', 'girassol-backup-offline', 'girassol', 'GIRABKP', 'Girassol', 'girassol'],
];

/* as pastas e os admins de cada empresa, ANTES de carregar o base delas */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-tres-'));
for (const [, , , emp, tag] of EMP) {
  process.env[tag + '_CACHE_DIR'] = path.join(tmp, emp, 'cache');
  process.env[tag + '_ADMIN'] = 'admin-' + emp;
  delete process.env[tag + '_ETIQ_FORMATO'];
}
/* o aviso às Devoluções: espiado (nada de rede) */
const avisos = [];
require.cache[require.resolve('../lib/avisar-devolucoes')] = { id: 'av', filename: 'av', loaded: true, exports: (...a) => { avisos.push(a); } };
const { assinarSessao, SESS_COOKIE } = require('../lib/checkout/sessao-operador');
const cookie = (quem) => SESS_COOKIE + '=' + assinarSessao(quem);
const LOTE = require('../lib/checkout/rotas-lote');
const painel = require('../lib/checkout/painel/painel-galpao');

(async () => {
  for (const [nome, arq, pasta, emp, tag, nomeCurto, aviso] of EMP) {
    /* o arquivo da empresa: monta pelo contrato DENTRO do routes (o readBody é dele), e a fila chama depois do portão */
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const MONTA = "  const _lote = require('../lib/checkout/rotas-lote').daEmpresa('" + emp + "', { readBody, base, nf: require('./nf') });\n";
    assert.strictEqual(s.split(MONTA).length, 2, nome + ': não monta o lote pelo contrato (exatamente uma vez) com a empresa, o base e as NFs dela');
    assert.ok(!/criarRotasLote\(/.test(s), nome + ': sobrou o bloco escrito à mão');
    const iR = s.indexOf('function routes(readBody) {'), iM = s.indexOf(MONTA);
    const iH = s.indexOf("require('../lib/checkout/rotas-empresa').criar('"), iC = s.indexOf('    lote: (req, res, urlObj, method, p) => _lote.handle(req, res, p, method, urlObj),\n');   /* 16/11: a fila é a peça */
    assert.ok(iR > 0 && iM > iR && iH > iM && iC > iH, nome + ': o lote não é montado dentro do routes antes da fila, ou a chamada não está na fila');
    assert.ok(require('../lib/checkout/portao-sessao').publicasDe(require('../lib/checkout/config-empresa').configCheckout(nome.toLowerCase())).includes('/' + pasta + '/danfes-lote'), nome + ': o lote de DANFEs não tem o guard próprio (o porteiro devolveria 401 em vez de voltar pro painel)');
    const h = painel.renderizar(require(path.join(raiz, pasta, 'painel-marca.js')));
    assert.ok(h.includes('id="btnEtqMassa"') && h.includes("window.open('/" + pasta + "/etiquetas-massa'"), nome + ': o painel não tem o botão 📎 apontando pra rota DELA');
    assert.ok(!(pasta !== 'good-checkout-offline' && /good-checkout-offline\/etiquetas-massa/.test(h)), nome + ': o botão aponta pra GOOD');

    /* RODANDO, com o base e as NFs reais da pasta */
    const base = require(path.join(raiz, pasta, 'base.js'));
    const nf = require(path.join(raiz, pasta, 'nf.js'));
    assert.strictEqual(base.CACHE_DIR, path.join(tmp, emp, 'cache'), nome + ': o teste não apontou o base pra pasta temporária');
    const L = LOTE.daEmpresa(emp, { readBody: async (req) => req._body, base, nf });
    fs.mkdirSync(path.join(base.CACHE_DIR, '101'), { recursive: true });
    fs.writeFileSync(path.join(base.CACHE_DIR, '101', 'pedido.json'), JSON.stringify({ id: 101 }));
    fs.writeFileSync(base.MANIFEST_FILE, JSON.stringify({ 101: { nf_numero: 5555 } }));
    let resp = null;
    const res = { writeHead(c) { resp = { code: c }; }, end(b) { resp = Object.assign(resp || {}, { corpo: String(b || '') }); }, setHeader() {} };
    const zpl = Buffer.from('^XA^FO10,10^FD' + 'x'.repeat(300) + '^FS^XZ', 'latin1').toString('base64');
    const pedido = (quem) => ({ headers: { cookie: cookie(quem) }, _body: { etiquetas: [{ nf: 5555, zpl_base64: zpl }] } });
    const P = '/' + pasta;

    /* o admin de OUTRA empresa: 403 (quem é admin é o base DELA) */
    const outra = EMP.find((x) => x[3] !== emp)[3];
    assert.strictEqual(await L.handle(pedido('admin-' + outra), res, P + '/etiquetas-zpl-massa', 'POST', new URL('http://x' + P + '/etiquetas-zpl-massa')), true);
    assert.strictEqual(resp.code, 403, nome + ': o admin da ' + outra + ' passou no lote dela');
    assert.ok(!fs.existsSync(path.join(base.CACHE_DIR, '101', 'etiqueta.zpl')), nome + ': gravou com o admin errado');

    /* o admin dela: a etiqueta vai pra pasta dela, com o formato dela, no manifesto dela, e o aviso sai com o id dela */
    avisos.length = 0;
    const log = [], logOrig = console.log; console.log = (...a) => log.push(a.map(String).join(' '));
    try { assert.strictEqual(await L.handle(pedido('admin-' + emp), res, P + '/etiquetas-zpl-massa', 'POST', new URL('http://x' + P + '/etiquetas-zpl-massa')), true); }
    finally { console.log = logOrig; }
    assert.ok(log.some((l) => l.startsWith('[' + tag + '] etiquetas em MASSA: 1 anexada(s)')), nome + ': o log do lote não saiu com a tag dela: ' + JSON.stringify(log));
    assert.strictEqual(resp.code, 200, nome + ': o lote recusou o admin dela: ' + resp.corpo);
    assert.strictEqual(JSON.parse(resp.corpo).anexadas, 1, nome + ': o lote não casou a etiqueta pela NF do manifesto dela');
    assert.ok(fs.existsSync(path.join(base.CACHE_DIR, '101', 'etiqueta.zpl')), nome + ': a etiqueta não foi pra pasta dela');
    const man = JSON.parse(fs.readFileSync(base.MANIFEST_FILE, 'utf8'));
    assert.ok(man['101'].etiqueta_anexada === true && man['101'].etiqueta_formato === base.ETIQ_FORMATO && base.ETIQ_FORMATO === 'ZPL', nome + ': o manifesto dela não marcou a etiqueta com o formato dela');
    assert.deepStrictEqual(avisos.map((a) => [a[0], a[1], a[2], a[3] && a[3].massa]), [[aviso, 'etiqueta_anexada', '101', true]], nome + ': o aviso às Devoluções não saiu com o id dela');

    /* a página de envio: o nome e o prefixo dela */
    assert.strictEqual(await L.handle({ headers: { cookie: cookie('admin-' + emp) } }, res, P + '/etiquetas-massa', 'GET', new URL('http://x' + P + '/etiquetas-massa')), true);
    assert.ok(resp.corpo.includes('<title>Etiquetas em massa · ' + nomeCurto + '</title>') && resp.corpo.includes('fetch("' + P + '/etiquetas-zpl-massa"'), nome + ': a página de envio não tem o nome e o prefixo dela');
    assert.strictEqual(await L.handle({ headers: {} }, res, '/outra-empresa/etiquetas-massa', 'GET', new URL('http://x/')), false, nome + ': respondeu fora do prefixo dela');

    /* a DANFE vem das NFs que a pasta entrega */
    const baixou = [];
    const L2 = LOTE.daEmpresa(emp, { readBody: async () => ({}), base, nf: { baixarDanfe: async (id) => { baixou.push(id); return null; } } });
    fs.mkdirSync(path.join(base.CACHE_DIR, '102'), { recursive: true });
    fs.writeFileSync(path.join(base.CACHE_DIR, '102', 'pedido.json'), JSON.stringify({ id: 102, nf: { id: 'nf-102' } }));
    fs.writeFileSync(base.MANIFEST_FILE, JSON.stringify(Object.assign(man, { 102: { nf_numero: 6666 } })));
    assert.strictEqual(await L2.handle({ headers: { cookie: cookie('admin-' + emp) } }, res, P + '/danfes-lote', 'GET', new URL('http://x' + P + '/danfes-lote?nfs=6666&json=1')), true);
    assert.deepStrictEqual(baixou, ['nf-102'], nome + ': o lote de DANFEs não baixou pelas NFs entregues');
  }

  /* faltou o base ou as NFs, ou empresa fora do contrato: derruba na montagem */
  const b0 = require(path.join(raiz, 'amb-checkout-offline', 'base.js')), n0 = require(path.join(raiz, 'amb-checkout-offline', 'nf.js'));
  assert.throws(() => LOTE.daEmpresa('amb', { readBody: () => {}, nf: n0 }), /\(ambtotal\): falta o base da pasta/);
  assert.throws(() => LOTE.daEmpresa('amb', { readBody: () => {}, base: b0 }), /\(ambtotal\): falta o nf da pasta/);
  assert.throws(() => LOTE.daEmpresa('amb', { base: b0, nf: n0 }), /falta peça da empresa: readBody/);
  assert.throws(() => LOTE.daEmpresa('empresa-que-nao-existe', { readBody: () => {}, base: b0, nf: n0 }), /empresa desconhecida no contrato/);
  /* empresa nova: o nome curto é o do contrato (sem nada escrito à mão) */
  const nova = require('../lib/checkout/config-empresa').configCheckout('nova', { registro: { normalizar: (x) => x, obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_', nome: 'Nova Comércio' } : null) } });
  assert.deepStrictEqual([nova.nomeCurto, nova.tag, nova.modulo, nova.loja], ['Nova Comércio', 'NOVABKP', 'nova-checkout-offline', 'nova']);

  console.log('ok — etiquetas em massa, página de envio e DANFEs em lote nas três, montadas pelo contrato (prefixo, nome, tag e id nas Devoluções) com o base e as NFs de cada uma; botão 📎 no painel de cada uma');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
