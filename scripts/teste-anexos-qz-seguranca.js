'use strict';
/* 15/11 — ID DE PEDIDO SÓ COM DÍGITOS E ASSINATURA DO QZ SÓ LOGADO E SÓ PEDIDO DE IMPRESSÃO
   (auditoria geral do Codex de 15/11/2026, P2 nº 1 e nº 2).

   P2 nº 1: rotas montavam `<CACHE_DIR>/<id>/…` com o id vindo da URL ou do corpo sem conferência — `../x` escapava do cache
   da empresa (no /etiqueta-anexar, com a chave de admin, ESCREVIA e APAGAVA fora da pasta dela). Agora todo id de pedido que
   vem de fora passa por lib/checkout/id-pedido (só dígitos) e a rota responde 400 ANTES de montar caminho; anexar etiqueta/NF
   ainda exige que o pedido seja DESTA empresa (na fila ou já cacheado) — 404 se não for.

   P2 nº 2: o /qz-sign era público (GET) e assinava QUALQUER texto com a chave privada da empresa — e o QZ Tray do PC do
   galpão aceita, com essa assinatura, `file.write`, `file.remove`, `usb.*`, `serial.*`… O qz-tray.js manda pra assinar só o
   RESUMO (sha256) de {call, params, timestamp}; agora o painel manda o resumo E o pedido, por POST, e o servidor só assina se
   estiver logado, o resumo for do pedido e o pedido for imprimir/olhar impressora com timestamp perto de agora.

   Prova com as PEÇAS DE PRODUÇÃO (rotas-comuns, rotas-nf-anexar, rotas-conferido, rotas-separacao, qz-pedido, id-pedido,
   portao-sessao) e disco de verdade numa pasta temporária. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const raiz = path.join(__dirname, '..');

const vigia = setTimeout(() => { console.error('FALHOU: o teste travou (promise pendente) — 30s'); process.exit(1); }, 30000);
const RUINS = ['../x', '..', '12/..', 'abc', '12.5', '1e3', '-1', '%2e%2e', '7 8', '123456789012345678901'];
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 0x20)]).toString('base64');

(async () => {
  const _log = console.log, _warn = console.warn; console.log = () => {}; console.warn = () => {};
  let falhou = null;
  try {
    /* ── a peça id-pedido ── */
    const { idPedido } = require('../lib/checkout/id-pedido');
    assert.strictEqual(idPedido(' 123 '), '123'); assert.strictEqual(idPedido(123), '123'); assert.strictEqual(idPedido('00017'), '00017');
    for (const r of RUINS.concat(['', null, undefined, {}, []])) assert.strictEqual(idPedido(r), null, 'id ruim passou: ' + JSON.stringify(r));

    /* ── disco da empresa: pedido 123 na fila (manifesto + pasta); 777 não é dela ── */
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'seg2-'));
    const CACHE_DIR = path.join(base, 'cache'), ARQUIVO_DIR = path.join(base, 'arquivo');
    fs.mkdirSync(path.join(CACHE_DIR, '123'), { recursive: true }); fs.mkdirSync(ARQUIVO_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, '123', 'pedido.json'), JSON.stringify({ id: 123, numero: '123', itens: [{ codigo: 'A1', quantidade: 1 }] }));
    const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ 123: { numero: '123' } }));
    const readJson = (f, pad) => { lidos.push(String(f)); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const writeJson = (f, o) => { fs.writeFileSync(f, JSON.stringify(o)); return true; };
    const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
    let lidos = [];
    const foraDaBase = () => lidos.filter((f) => !path.resolve(f).startsWith(base + path.sep));
    const arquivosDe = (d) => { const out = []; (function anda(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) anda(f); else out.push(path.relative(base, f)); } })(d); return out.sort(); };
    const antesNoDisco = arquivosDe(base);

    /* ── a peça de rotas comuns como a AMB a monta (stubs mudos no que não é deste teste) ── */
    const { criarRotasComuns, PECAS } = require('../lib/checkout/rotas-comuns');
    const { privateKey: QZ_PRIVKEY, publicKey: QZ_PUB } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    let sessao = 'ygor', corpo = {}, admin = true;
    const resp = [];
    const o = { prefixo: '/amb-checkout-offline', tag: 'AMBBKP', empresa: 'amb' };
    for (const k of PECAS) o[k] = () => undefined;
    Object.assign(o, { CACHE_DIR, ARQUIVO_DIR, MANIFEST_FILE, ETIQ_FORMATO: 'ZPL', QZ_PRIVKEY, QZ_CERT: 'CERT', readJson, writeJson, ensureDir,
      json: (res, code, body) => { res._s = code; res._b = body; resp.push({ code, body }); },
      readBody: async () => corpo, validarSessao: () => sessao, ehAdmin: () => admin, lerChaveAdmin: () => null, fetch: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }) });
    const rc = criarRotasComuns(o);
    const P = '/amb-checkout-offline';
    /* o caminho vai CRU pra peça (como `p` chega do servidor): o teste não deixa o URL normalizar `..` — a defesa é da rota */
    const chama = async (method, p, headers, bodyObj) => {
      corpo = bodyObj || {}; const res = { _s: null, _b: null, _txt: '', writeHead(c) { res._s = res._s || c; }, setHeader() {}, end(b) { res._txt += String(b || ''); } };
      const u = new URL('http://x' + encodeURI(p).replace(/\.\./g, '%2E%2E')); const req = { method, headers: Object.assign({ host: 'x' }, headers || {}) };
      const t = await rc.handle(req, res, p, method, u);
      return { tratou: t, status: res._s, body: res._b, texto: res._txt };
    };

    /* P2 nº 1 — as 12 rotas GET com id na URL: id ruim = 400 sem ler nada fora da base; id bom segue */
    const GETS = ['/estoque-pedido/', '/etiqueta/', '/danfe/', '/etiqueta-pdf/', '/imprimir/', '/nf-danfe-live/', '/arq-info/', '/arq-etiqueta-pdf/', '/arq-danfe/', '/danfe-simp/', '/etiqueta-fundida/', '/etiqueta-madeira-zpl/'];
    for (const rota of GETS) {
      for (const ruim of RUINS) {
        lidos = [];
        const r = await chama('GET', P + rota + ruim);
        assert.ok(r.tratou === true && r.status === 400 && /id de pedido inválido/.test(JSON.stringify(r.body)), rota + ' com id ' + JSON.stringify(ruim) + ': tinha que ser 400 "id de pedido inválido", veio ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
        assert.deepStrictEqual(foraDaBase(), [], rota + ' com id ' + JSON.stringify(ruim) + ' LEU fora da base: ' + foraDaBase().join(', '));
        assert.deepStrictEqual(lidos, [], rota + ' com id ruim leu disco antes de recusar: ' + lidos.join(', '));
      }
    }
    lidos = [];
    let r = await chama('GET', P + '/estoque-pedido/123');
    assert.ok(r.tratou === true && r.status === 200 && r.body && r.body.ok !== false, '/estoque-pedido/123 (id bom, pedido na fila) tinha que seguir: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
    r = await chama('GET', P + '/arq-info/123');
    assert.ok(r.status === 200 && r.body && r.body.id === '123' && r.body.arquivado === false, '/arq-info/123 tinha que responder o id canônico: ' + JSON.stringify(r.body));
    r = await chama('GET', P + '/pedido/123');
    assert.ok(r.tratou === true && r.status !== 400, '/pedido/123 (id bom) não pode ser recusado como inválido');
    for (const ruim of ['..', 'abc', '12.5']) { lidos = []; r = await chama('GET', P + '/pedido/' + ruim); assert.ok(r.status === 404 && /não cacheado/.test(JSON.stringify(r.body)), '/pedido/' + ruim + ': 404 "não cacheado" (como pedido que não existe), veio ' + r.status); assert.deepStrictEqual(lidos, [], '/pedido/' + ruim + ' foi ao disco com id ruim: ' + lidos.join(', ')); }

    /* /etiqueta-anexar (admin): id ruim = 400; pedido de outra empresa = 404 e NADA gravado; pedido da fila grava dentro da pasta dele */
    for (const ruim of RUINS) {
      r = await chama('POST', P + '/etiqueta-anexar', {}, { id: ruim, pdf_base64: PDF });
      assert.ok(r.status === 400 && /só dígitos/.test(JSON.stringify(r.body)), '/etiqueta-anexar id ' + JSON.stringify(ruim) + ': 400, veio ' + r.status + ' ' + JSON.stringify(r.body));
    }
    r = await chama('POST', P + '/etiqueta-anexar', {}, { id: '777', pdf_base64: PDF });
    assert.ok(r.status === 404 && /não está na fila desta empresa/.test(JSON.stringify(r.body)), '/etiqueta-anexar de pedido fora da fila: 404, veio ' + r.status + ' ' + JSON.stringify(r.body));
    assert.deepStrictEqual(arquivosDe(base), antesNoDisco, 'o anexo recusado NÃO pode ter tocado o disco');
    r = await chama('POST', P + '/etiqueta-anexar', {}, { id: '123', pdf_base64: PDF });
    assert.ok(r.status === 200 && r.body && r.body.ok === true && r.body.formato === 'pdf', '/etiqueta-anexar do pedido da fila tinha que gravar: ' + r.status + ' ' + JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(CACHE_DIR, '123', 'etiqueta.pdf')), 'a etiqueta tinha que estar em cache/123/etiqueta.pdf');
    assert.deepStrictEqual(arquivosDe(base).filter((f) => !antesNoDisco.includes(f)), [path.join('cache', '123', 'etiqueta.pdf')], 'só o arquivo do pedido 123 pode ter nascido');
    /* pedido que já saiu do manifesto mas tem pasta no cache (o backfill/arquivo ainda não levou) também é desta empresa */
    fs.mkdirSync(path.join(CACHE_DIR, '456'), { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, '456', 'pedido.json'), JSON.stringify({ id: 456 }));
    r = await chama('POST', P + '/etiqueta-anexar', {}, { id: '456', pdf_base64: PDF });
    assert.ok(r.status === 200 && fs.existsSync(path.join(CACHE_DIR, '456', 'etiqueta.pdf')), 'pedido só cacheado (fora do manifesto) é desta empresa — tinha que gravar: ' + r.status + ' ' + JSON.stringify(r.body));

    /* ── /nf-anexar (peça própria), /conferido, /reservar, /liberar ── */
    const nfa = require('../lib/checkout/rotas-nf-anexar').criar({ prefixo: P, empresaId: 'amb-checkout-offline', json: o.json, readBody: async () => corpo, readJson, writeJson, ensureDir, ehAdmin: () => true, lerChaveAdmin: () => null,
      mlSyncFees: async () => ({}), shopeeKeepAlive: async () => ({ ok: true }), shopeeSessaoLer: () => ({}), CACHE_DIR, MANIFEST_FILE, SHOPEE_ENV_COOKIE: 'X', VERSAO: 't', statusMlSync: () => ({}) });
    const chamaPeca = async (handle, method, p, bodyObj, vs) => { corpo = bodyObj || {}; const res = { _s: null, _b: null }; const u = new URL('http://x' + p); const req = { method, headers: { host: 'x' }, _op: 'ygor' }; const t = await handle(req, res, u, method, vs || (() => 'ygor')); return { tratou: t, status: res._s, body: res._b }; };
    for (const ruim of RUINS) { r = await chamaPeca(nfa, 'POST', P + '/nf-anexar', { id: ruim, pdf_base64: PDF }); assert.ok(r.status === 400 && /só dígitos/.test(JSON.stringify(r.body)), '/nf-anexar id ' + JSON.stringify(ruim) + ': 400, veio ' + r.status); }
    const antesNf = arquivosDe(base);
    r = await chamaPeca(nfa, 'POST', P + '/nf-anexar', { id: '777', pdf_base64: PDF });
    assert.ok(r.status === 404 && /não está na fila desta empresa/.test(JSON.stringify(r.body)), '/nf-anexar fora da fila: 404, veio ' + r.status + ' ' + JSON.stringify(r.body));
    assert.deepStrictEqual(arquivosDe(base), antesNf, 'a NF recusada não pode ter tocado o disco');
    r = await chamaPeca(nfa, 'POST', P + '/nf-anexar', { id: '123', pdf_base64: PDF });
    assert.ok(r.status === 200 && fs.existsSync(path.join(CACHE_DIR, '123', 'danfe.pdf')), '/nf-anexar do pedido da fila tinha que gravar cache/123/danfe.pdf: ' + r.status + ' ' + JSON.stringify(r.body));

    const conf = require('../lib/checkout/rotas-conferido').criar({ prefixo: P, tag: 'AMBBKP', json: o.json, readBody: async () => corpo, readJson, writeJson, lerReservas: () => ({}), moverSituacao: async () => ({ ok: true }),
      arquivarFinalizado: () => {}, sincronizarConferidos: async () => ({}), rodarCiclo: async () => ({}), CONFERIDOS_FILE: path.join(base, 'conferidos.json'), RESERVAS_FILE: path.join(base, 'reservas.json'), CACHE_DIR, SIT_VERIFICADO: 1, SYNC_ON: false, VERSAO: 't' });
    for (const ruim of RUINS) { lidos = []; r = await chamaPeca(conf, 'POST', P + '/conferido', { id: ruim, user: 'ygor' }); assert.ok(r.status === 400 && /id de pedido inválido/.test(JSON.stringify(r.body)), '/conferido id ' + JSON.stringify(ruim) + ': 400, veio ' + r.status + ' ' + JSON.stringify(r.body)); assert.deepStrictEqual(lidos, [], '/conferido com id ruim leu disco'); }
    assert.ok(!fs.existsSync(path.join(base, 'conferidos.json')), 'nenhuma finalização com id ruim pode ter sido gravada');

    const reservas = {};
    const sep = require('../lib/checkout/rotas-separacao').criar({ prefixo: P, tag: 'AMBBKP', json: o.json, readBody: async () => corpo, readJson, writeJson: (f, v) => { Object.assign(reservas, v); return true; }, blingGet: async () => ({}), blingWrite: async () => ({}),
      lerReservas: () => reservas, locCache: {}, localizacaoDeProduto: () => null, salvarLoc: () => {}, montarSeparacao: () => ({}), montarSeparacaoPorPedido: () => ({}), RESERVAS_FILE: path.join(base, 'reservas.json'), LOC_LOG_FILE: path.join(base, 'loc.log') });
    for (const rota of ['/reservar', '/liberar']) for (const ruim of RUINS) { r = await chamaPeca(sep, 'POST', P + rota, { id: ruim, user: 'ygor' }); assert.ok(r.status === 400 && /id de pedido inválido/.test(JSON.stringify(r.body)), rota + ' id ' + JSON.stringify(ruim) + ': 400, veio ' + r.status + ' ' + JSON.stringify(r.body)); }
    assert.deepStrictEqual(Object.keys(reservas), [], 'reserva com id ruim gravada');
    r = await chamaPeca(sep, 'POST', P + '/reservar', { id: '123', user: 'ygor' }); assert.ok(r.status === 200 && reservas['123'], '/reservar 123 tinha que reservar: ' + r.status + ' ' + JSON.stringify(r.body));
    r = await chamaPeca(sep, 'POST', P + '/liberar', { id: '123' }); assert.ok(r.status === 200, '/liberar 123');

    /* ── P2 nº 2 — /qz-sign ── */
    const { recusarAssinatura, sha256Hex } = require('../lib/checkout/qz-pedido');
    const pedidoDe = (obj) => JSON.stringify(obj);
    const bom = pedidoDe({ call: 'print', params: { printer: 'ZD220', data: [{ type: 'raw', data: '^XA^XZ' }] }, timestamp: Date.now() });
    const hBom = sha256Hex(bom);
    const assina = async (headers, bodyObj, method) => chama(method || 'POST', P + '/qz-sign', headers, bodyObj);

    r = await assina({}, { request: hBom, pedido: bom }, 'GET');
    assert.ok(r.tratou === true && r.status === 405 && /recarregue o painel/.test(JSON.stringify(r.body)), 'GET /qz-sign (o painel velho) tinha que ser 405 com aviso, veio ' + r.status);
    sessao = null;
    r = await assina({}, { request: hBom, pedido: bom });
    assert.ok(r.status === 401 && /só pra quem está logado/.test(JSON.stringify(r.body)), 'sem sessão: 401, veio ' + r.status + ' ' + JSON.stringify(r.body));
    sessao = 'ygor';
    r = await assina({ 'sec-fetch-site': 'cross-site' }, { request: hBom, pedido: bom });
    assert.ok(r.status === 403 && /CSRF/.test(JSON.stringify(r.body)), 'de outro site: 403, veio ' + r.status);
    r = await assina({ origin: 'http://outro' }, { request: hBom, pedido: bom });
    assert.ok(r.status === 403, 'de outra origem: 403, veio ' + r.status);

    r = await assina({ origin: 'http://x' }, { request: hBom, pedido: bom });
    assert.ok(r.tratou === true && r.status === 200 && r.texto.length > 100, 'o pedido de impressão do painel tinha que ser assinado: ' + r.status + ' ' + JSON.stringify(r.body) + ' ' + r.texto.slice(0, 40));
    assert.ok(crypto.verify('RSA-SHA512', Buffer.from(hBom, 'utf8'), QZ_PUB, Buffer.from(r.texto, 'base64')), 'a assinatura tem que ser RSA-SHA512 do RESUMO (o que o qz-tray confere)');
    for (const call of ['printers.find', 'printers.getDefault', 'printers.detail']) {
      const pd = pedidoDe({ call, params: call === 'printers.find' ? { query: 'ZD' } : null, timestamp: Date.now() });
      r = await assina({}, { request: sha256Hex(pd), pedido: pd }); assert.ok(r.status === 200 && r.texto.length > 100, call + ' tinha que ser assinado: ' + r.status);
    }
    const recusa = async (bodyObj, trecho, nome) => { r = await assina({}, bodyObj); assert.ok(r.status === 400 && trecho.test(JSON.stringify(r.body)) && r.texto === '', nome + ': tinha que recusar (400 ' + trecho + '), veio ' + r.status + ' ' + JSON.stringify(r.body) + ' txt=' + r.texto.slice(0, 20)); };
    const comResumo = (pd) => ({ request: sha256Hex(pd), pedido: pd });
    for (const call of ['file.write', 'file.remove', 'file.read', 'usb.openStream', 'serial.openPort', 'socket.open', 'networking.devices', 'hid.sendData', 'printers.clearQueue', 'getVersion'])
      await recusa(comResumo(pedidoDe({ call, params: { path: 'C:\\x' }, timestamp: Date.now() })), /chamada não permitida: /, 'call ' + call);
    await recusa({ request: hBom }, /pedido ausente/, 'só o resumo (o que o qz-tray mandava)');
    await recusa({ request: 'a'.repeat(64), pedido: bom }, /resumo não é deste pedido/, 'resumo de outro pedido');
    await recusa({ request: hBom, pedido: bom + ' ' }, /resumo não é deste pedido/, 'pedido alterado depois do resumo');
    await recusa({ request: 'texto qualquer pra assinar', pedido: bom }, /resumo inválido/, 'texto arbitrário no lugar do resumo (o P2 do Codex)');
    await recusa({ request: hBom.toUpperCase(), pedido: bom }, /resumo inválido/, 'resumo em maiúsculas (o qz-tray manda minúsculas)');
    await recusa(comResumo('isto não é json'), /não é o JSON/, 'pedido que não é JSON');
    await recusa(comResumo('[1,2]'), /não é o JSON/, 'pedido lista');
    await recusa(comResumo(pedidoDe({ params: {}, timestamp: Date.now() })), /sem `call`/, 'sem call');
    await recusa(comResumo(pedidoDe({ call: ['print'], timestamp: Date.now() })), /sem `call`/, 'call que não é texto');
    await recusa(comResumo(pedidoDe({ call: 'print', params: {} })), /timestamp ausente/, 'sem timestamp');
    await recusa(comResumo(pedidoDe({ call: 'print', params: {}, timestamp: Date.now() - 25 * 3600 * 1000 })), /fora da janela/, 'timestamp de ontem');
    await recusa(comResumo(pedidoDe({ call: 'print', params: {}, timestamp: Date.now() + 25 * 3600 * 1000 })), /fora da janela/, 'timestamp de amanhã');
    await recusa(comResumo(pedidoDe({ call: 'print', params: {}, timestamp: 'agora' })), /fora da janela/, 'timestamp texto');
    const gigante = pedidoDe({ call: 'print', params: { data: 'x'.repeat(6 * 1024 * 1024) }, timestamp: Date.now() });
    await recusa(comResumo(gigante), /grande demais/, 'pedido > 6 MiB');
    await recusa({}, /resumo inválido/, 'corpo vazio');
    /* a peça sozinha: motivo null só no pedido bom; timestamp a 23h ainda vale (relógio do PC errado em horas) */
    assert.strictEqual(recusarAssinatura(hBom, bom, Date.now()), null);
    assert.strictEqual(recusarAssinatura(hBom, bom, Date.now() + 23 * 3600 * 1000), null, '23h de diferença ainda assina');
    assert.ok(/timestamp/.test(recusarAssinatura(hBom, bom, Date.now() + 25 * 3600 * 1000)), '25h não');
    /* sem chave privada: continua respondendo vazio (sem certificado o QZ pergunta ao operador) — mas só depois das checagens */
    o.QZ_PRIVKEY = ''; const rc2 = criarRotasComuns(o);
    { corpo = { request: hBom, pedido: bom }; const res = { _s: null, _txt: '', writeHead(c) { res._s = c; }, setHeader() {}, end(b) { res._txt += String(b || ''); } }; const u = new URL('http://x' + P + '/qz-sign');
      await rc2.handle({ method: 'POST', headers: { host: 'x' } }, res, u.pathname, 'POST', u); assert.ok(res._s === 200 && res._txt === '', 'sem chave: 200 vazio');
      corpo = { request: hBom, pedido: pedidoDe({ call: 'file.write', timestamp: Date.now() }) }; const res2 = { _s: null, _b: null, _txt: '', writeHead(c) { res2._s = res2._s || c; }, setHeader() {}, end(b) { res2._txt += String(b || ''); } };
      await rc2.handle({ method: 'POST', headers: { host: 'x' } }, res2, u.pathname, 'POST', u); assert.ok(res2._s === 400, 'sem chave, pedido ruim ainda é recusado (400), veio ' + res2._s); }
    o.QZ_PRIVKEY = QZ_PRIVKEY;

    /* ── o portão: /qz-sign saiu da lista pública das três; /qz-cert segue ── */
    const { publicasDe } = require('../lib/checkout/portao-sessao');
    const { configCheckout } = require('../lib/checkout/config-empresa');
    for (const [emp, pref] of [['amb', '/amb-checkout-offline'], ['girassol', '/girassol-backup-offline'], ['good', '/good-checkout-offline']]) {
      const pub = publicasDe(configCheckout(emp));
      assert.ok(!pub.includes(pref + '/qz-sign'), emp + ': /qz-sign continua PÚBLICO no portão');
      assert.ok(pub.includes(pref + '/qz-cert'), emp + ': /qz-cert (o certificado) tem que seguir público');
    }

    /* ── o painel: manda resumo E pedido por POST; guarda o pedido no hash; não usa mais o GET ?request= ── */
    const painel = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
    assert.ok(!/qz-sign\?request=/.test(painel), 'o painel ainda chama o GET /qz-sign?request= (o servidor responde 405)');
    assert.ok(/qz\.api\.setSha256Type\(d => _qzSha\(d\)\.then\(h => \{[^\n]*_qzPedidos\.set\(h, d\)/.test(painel), 'o painel tem que guardar o pedido pelo resumo no hash do qz-tray');
    assert.ok(/fetch\('\{\{PREFIXO\}\}\/qz-sign', \{method:'POST'[^\n]*body: JSON\.stringify\(\{ request: toSign, pedido \}\)/.test(painel), 'o painel tem que mandar { request, pedido } por POST');
    assert.ok(/const pedido = _qzPedidos\.get\(toSign\) \|\| null;/.test(painel), 'o pedido mandado é o guardado pelo resumo que o qz-tray pede');
    assert.ok(/window\.sha256 \? Promise\.resolve\(sha256\(d\)\) : crypto\.subtle\.digest\('SHA-256'/.test(painel), 'sem a lib sha256 (CDN fora) o navegador faz o hash — a impressão não pode depender do CDN');
    assert.ok(/if\(!r\.ok\) return r\.json\(\)\.then\(function\(j\)\{ throw new Error/.test(painel), 'recusa do servidor vira erro de assinatura (não uma assinatura vazia que o QZ aceita como "sem certificado")');
    /* o resumo que o painel calcula é o mesmo do servidor (js-sha256 e crypto.subtle são sha256 hex minúsculo) */
    assert.strictEqual(sha256Hex(bom), crypto.createHash('sha256').update(bom).digest('hex'));
    /* o qz-tray 2.2.6 (o que o painel carrega) assina {call, params, timestamp} e os nomes de chamada são 'print', 'printers.find'… */
    assert.ok(/qz-tray@2\.2\.6\/qz-tray\.js/.test(painel), 'o painel carrega outro qz-tray — rever o formato do pedido assinado');
  } catch (e) { falhou = e; }
  finally { console.log = _log; console.warn = _warn; clearTimeout(vigia); }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — anexos e QZ: id de pedido só com dígitos em 17 rotas (400 antes de tocar o disco; `../` não escapa do cache), anexar etiqueta/NF só em pedido desta empresa (404), /qz-sign só por POST de dentro do sistema, logado, resumo = sha256 do pedido e pedido só de imprimir/olhar impressora com timestamp de hoje; o painel manda os dois');
  process.exit(0);
})();
