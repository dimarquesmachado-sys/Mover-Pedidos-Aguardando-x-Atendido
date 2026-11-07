'use strict';
/* 07/11 — A ETIQUETA DO MADEIRA VEM PELA EXTENSÃO. Caso real (GOOD, 02-04/11): 6 pedidos do Madeira com o lote no mapa e o
   card "achei o lote, mas a etiqueta não baixou (nem o ZPL nem o PDF)". O endereço "público" do ZPL responde 403 conforme
   de onde vem o pedido (o dono, na China, só baixou com VPN) e o servidor também não baixava mais. A extensão roda no
   navegador LOGADO no Madeira: agora ela baixa o ZPL de cada lote pronto e manda junto no sync. Prova:
   SERVIDOR (lib/checkout/mm-etiquetas, a peça de produção, com a rede trocada):
   · o /sync guarda o ZPL do lote PRONTO e responde zpl_guardados; ZPL inválido, lote não pronto e nome de lote estranho
     ficam de fora;
   · o zplPorBatch (que o ciclo do checkout, o A4 e a impressão usam) devolve o guardado SEM ir à rede;
   · o diagnóstico aceita a ADMIN_KEY e mostra o guardado + o que o endereço público responde ao servidor (403 aqui);
   EXTENSÃO (toolbox-extensao/ct-mm.js e bg-mm.js, rodando de verdade numa caixa de areia com o navegador de mentira):
   · a página baixa o ZPL só dos lotes PRONTOS ainda não entregues, com a sessão (credentials: include), e manda junto;
   · o background marca o que o servidor confirmou (não baixa de novo) e conta as etiquetas entregues. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const https = require('https');
const { EventEmitter } = require('events');
const raiz = path.join(__dirname, '..');

const ZPL = '^XA^PW812^LL1054^FO48,210^A0N,24,24^FD81350^FS^XZ\n^XA^PW812^FO48,210^A0N,24,24^FDvolume 2^FS^XZ';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmzpl-'));
process.env.GOOD_MM_SYNC_KEY = 'k-mm'; process.env.ADMIN_KEY = 'k-adm'; process.env.GOOD_MM_DATA = path.join(dir, 'good-mm-mapa.json');
delete process.env.GOOD_MM_TOKEN;
/* a rede: o endereço público do ZPL responde 403 (o que o dono viu sem VPN); qualquer outra chamada também conta */
let chamadasRede = 0;
https.request = function (url, opts, cb) {
  chamadasRede++;
  const req = new EventEmitter(); req.end = () => { const resp = new EventEmitter(); resp.statusCode = 403; resp.headers = { 'content-type': 'text/html' }; cb(resp); setImmediate(() => { resp.emit('data', Buffer.from('<html>403 Forbidden</html>')); resp.emit('end'); }); }; req.destroy = () => {};
  return req;
};
const { criarMmEtiquetas } = require('../lib/checkout/mm-etiquetas');
const mm = criarMmEtiquetas('good');
const handle = mm.routes();
function chamar(metodo, url, corpo, headers) {
  return new Promise((resolve) => {
    const req = new EventEmitter(); req.method = metodo; req.headers = Object.assign({}, headers || {});
    const res = { code: 0, writeHead(c) { this.code = c; }, end(b) { resolve({ code: this.code, body: (() => { try { return JSON.parse(b); } catch (e) { return b; } })() }); } };
    handle(req, res, new URL('http://x' + url));
    setImmediate(() => { if (corpo != null) req.emit('data', Buffer.from(JSON.stringify(corpo))); req.emit('end'); });
  });
}

(async () => {
  /* SERVIDOR */
  const r = await chamar('POST', '/good-mm-etiquetas/sync', { lotes: [
    { batch: 306783, status: 2, orders: [{ order_id: '10075265' }], nf: '81350', zpl: ZPL },
    { batch: 306790, status: 2, orders: [{ order_id: '1' }], zpl: 'lixo sem etiqueta' },
    { batch: 306791, status: 1, orders: [{ order_id: '2' }], zpl: ZPL },
    { batch: '../fora', status: 2, orders: [{ order_id: '3' }], zpl: ZPL },
  ] }, { 'x-mm-key': 'k-mm' });
  assert.strictEqual(r.code, 200, 'o sync não respondeu 200: ' + JSON.stringify(r));
  assert.deepStrictEqual(r.body.zpl_guardados, ['306783'], 'só o ZPL válido de lote PRONTO com nome de lote normal podia ser guardado: ' + JSON.stringify(r.body.zpl_guardados));
  chamadasRede = 0;
  assert.strictEqual(await mm.zplPorBatch('306783'), ZPL, 'o zplPorBatch não devolveu o ZPL que a extensão mandou');
  assert.strictEqual(chamadasRede, 0, 'com o ZPL guardado, o zplPorBatch não podia ir à rede');
  assert.strictEqual(await mm.zplPorBatch('306790'), null, 'lote sem ZPL guardado e com o público em 403 tinha que voltar null');
  assert.ok(chamadasRede > 0, 'sem o guardado, o caminho antigo (endereço público) tinha que ser tentado');
  assert.strictEqual((mm.acharLote('81350') || {}).batch, '306783', 'o pedido tinha que ser achado pela NF no mapa');
  const d = await chamar('GET', '/good-mm-etiquetas/teste-zpl?batch=306783&k=k-adm', null, {});
  assert.ok(d.code === 200 && d.body.guardado_pela_extensao === true && d.body.publico.statusCode === 403, 'o diagnóstico (com a ADMIN_KEY) tinha que mostrar o guardado e o 403 do público: ' + JSON.stringify(d));
  assert.strictEqual((await chamar('GET', '/good-mm-etiquetas/mapa?k=errada', null, {})).code, 401, 'chave errada tinha que ser recusada');

  /* EXTENSÃO — a página do Madeira */
  const mensagens = [], fetches = [];
  const storage = { mm_zpl_entregues: { '306700': Date.now() } };
  const chrome = { runtime: { sendMessage: (m) => mensagens.push(m), onMessage: { addListener: () => {} } },
    storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in storage) o[k] = JSON.parse(JSON.stringify(storage[k])); return o; }, set: async (o) => Object.assign(storage, o) } } };
  const lotesMm = [{ batch: 306783, status: 2 }, { batch: 306700, status: 2 }, { batch: 306799, status: 1 }];
  const fetchPagina = async (url, opts) => {
    fetches.push({ url, opts });
    if (/\/lotes$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(lotesMm)) }) };
    return { ok: true, status: 200, text: async () => ZPL };
  };
  const caixa = { window: {}, chrome, fetch: fetchPagina, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'), caixa);
  for (let i = 0; i < 50 && !mensagens.length; i++) await new Promise((s) => setTimeout(s, 10));
  const msg = mensagens[0];
  assert.ok(msg && msg.tipo === 'MM_LOTES' && msg.ok, 'a página não mandou os lotes');
  const por = (b) => msg.lotes.find((l) => String(l.batch) === b);
  assert.strictEqual(por('306783').zpl, ZPL, 'o lote pronto e não entregue tinha que ir com o ZPL');
  assert.ok(!por('306700').zpl, 'lote já entregue não podia ser baixado de novo');
  assert.ok(!por('306799').zpl, 'lote que não está pronto não podia ir com ZPL');
  const fz = fetches.filter((f) => /format=zpl/.test(f.url));
  assert.ok(fz.length === 1 && fz[0].opts.credentials === 'include', 'o ZPL tinha que ser baixado uma vez, com a sessão do navegador');

  /* EXTENSÃO — o background */
  let ouvinte = null;
  const chromeBg = { runtime: { onMessage: { addListener: (f) => { ouvinte = f; } } }, storage: chrome.storage };
  storage.renderBase = 'https://servidor.example'; storage.syncKey = 'k-mm'; storage.tb_empresa = 'good';
  const fetchBg = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, total_no_mapa: 38, zpl_guardados: ['306783'] }) });
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: chromeBg, fetch: fetchBg, console, Date, JSON, Object, Number, String, Array });
  await new Promise((s) => ouvinte(msg, {}, s));
  assert.ok(storage.mm_zpl_entregues['306783'] && storage.mm_zpl_entregues['306700'], 'o background tinha que marcar o que o servidor guardou (e manter o que já estava)');
  assert.strictEqual(storage.ultimoStatus && storage.ultimoStatus.etiquetas, 1, 'a telinha tinha que mostrar 1 etiqueta entregue');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — a etiqueta do Madeira vem pela extensão: o servidor guarda o ZPL do lote pronto e usa sem ir à rede; a página baixa só o que falta, com a sessão; o background marca o que foi entregue');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
