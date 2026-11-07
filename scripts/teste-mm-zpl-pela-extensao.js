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
  const DEST = 'https://servidor.example|good';
  const storage = { renderBase: 'https://servidor.example/', tb_empresa: 'good', mm_zpl_entregues: { [DEST]: { '306700': Date.now() } } };
  const chrome = { runtime: { sendMessage: (m) => mensagens.push(m), onMessage: { addListener: () => {} } },
    storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in storage) o[k] = JSON.parse(JSON.stringify(storage[k])); return o; }, set: async (o) => Object.assign(storage, o) } } };
  const lotesMm = [{ batch: 306783, status: 2 }, { batch: 306700, status: 2 }, { batch: 306799, status: 1 }];
  const fetchPagina = async (url, opts) => {
    fetches.push({ url, opts });
    if (/\/lotes$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(lotesMm)) }) };
    return { ok: true, status: 200, text: async () => ZPL };
  };
  const caixa = { window: {}, chrome, fetch: fetchPagina, setInterval: () => 0, setTimeout, clearTimeout, AbortController, TextEncoder, console };
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
  storage.syncKey = 'k-mm';
  const fetchBg = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, total_no_mapa: 38, zpl_guardados: ['306783'] }) });
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: chromeBg, fetch: fetchBg, console, Date, JSON, Object, Number, String, Array });
  await new Promise((s) => ouvinte(msg, {}, s));
  assert.ok(storage.mm_zpl_entregues[DEST]['306783'] && storage.mm_zpl_entregues[DEST]['306700'], 'o background tinha que marcar o que o servidor guardou NO DESTINO (e manter o que já estava)');
  assert.strictEqual(storage.ultimoStatus && storage.ultimoStatus.etiquetas, 1, 'a telinha tinha que mostrar 1 etiqueta entregue');

  /* Codex #804 — rodando a página de novo, com cenários próprios */
  async function rodarPagina(st, lotes, porZpl, devolverTudo) {
    const msgs = [];
    let ouvinteMsg = null;
    const ch = { runtime: { sendMessage: (m) => msgs.push(m), onMessage: { addListener: (f) => { ouvinteMsg = f; } } },
      storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st) o[k] = JSON.parse(JSON.stringify(st[k])); return o; }, set: async (o) => Object.assign(st, o) } } };
    const f = async (url, opts) => (/\/lotes$/.test(url) ? { ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(lotes)) }) } : porZpl(url, opts));
    const relogio = (fn, ms) => setTimeout(fn, Math.min(ms, 30));   /* relógio acelerado: o prazo de 20 s vira 30 ms */
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'),
      { window: {}, chrome: ch, fetch: f, setInterval: () => 0, setTimeout: relogio, clearTimeout, AbortController, TextEncoder, console });
    for (let i = 0; i < 200 && !msgs.length; i++) await new Promise((s2) => setTimeout(s2, 10));
    if (!devolverTudo) return msgs[0];
    const deNovo = async () => { const n0 = msgs.length; await new Promise((ok) => ouvinteMsg({ tipo: 'MM_SYNC_AGORA' }, {}, ok)); for (let i = 0; i < 200 && msgs.length === n0; i++) await new Promise((s2) => setTimeout(s2, 10)); return msgs[msgs.length - 1]; };
    return { primeira: msgs[0], deNovo };
  }
  /* (1) teto sobre o corpo SERIALIZADO: etiquetas com aspas (o JSON escapa) — o corpo final cabe nos 4 MB */
  const grande = '^XA' + '"'.repeat(700000) + '^XZ';   /* 700 mil caracteres que viram ~1,4 MB no JSON */
  const m1 = await rodarPagina({ renderBase: 'https://servidor.example', tb_empresa: 'good' },
    [1, 2, 3, 4].map((b) => ({ batch: b, status: 2 })), async () => ({ ok: true, status: 200, text: async () => grande }));
  const tamCorpo = new TextEncoder().encode(JSON.stringify({ lotes: m1.lotes })).length;
  assert.ok(tamCorpo <= 4 * 1024 * 1024, 'o corpo do sync passou de 4 MB (' + tamCorpo + ' bytes) — o servidor cortaria e NADA sincronizaria');
  assert.ok(m1.lotes.filter((l) => l.zpl).length >= 1, 'com espaço, ao menos uma etiqueta tinha que ir');
  /* (2) download TRAVADO não segura o envio dos lotes (o prazo aborta e o lote fica pra próxima) */
  const m2 = await rodarPagina({ renderBase: 'https://servidor.example', tb_empresa: 'good' }, [{ batch: 7, status: 2 }, { batch: 8, status: 2 }],
    async (url, opts) => (/lote_id=7/.test(url)
      ? new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado'))))
      : { ok: true, status: 200, text: async () => ZPL }));
  assert.ok(m2 && m2.ok && m2.lotes.length === 2, 'a etiqueta travada segurou o envio dos lotes');
  assert.ok(!m2.lotes.find((l) => l.batch === 7).zpl && m2.lotes.find((l) => l.batch === 8).zpl === ZPL, 'o lote travado tinha que ir sem etiqueta e o outro com');
  /* (3) o "já entregue" é POR DESTINO: trocando o servidor, a etiqueta vai de novo */
  const m3 = await rodarPagina({ renderBase: 'https://outro-servidor.example', tb_empresa: 'good', mm_zpl_entregues: { [DEST]: { '306783': Date.now() } } },
    [{ batch: 306783, status: 2 }], async () => ({ ok: true, status: 200, text: async () => ZPL }));
  assert.strictEqual(m3.lotes[0].zpl, ZPL, 'trocando o servidor, a etiqueta entregue ao ANTERIOR tinha que ir pro novo');

  /* Codex #804 (r2) — (4) as primeiras TRAVAM sempre: na rodada seguinte elas esperam e as outras ganham a vez */
  const pedidasZpl = [];
  const r4 = await rodarPagina({ renderBase: 'https://servidor.example', tb_empresa: 'good' }, [1, 2, 3, 4].map((b) => ({ batch: b, status: 2 })),
    async (url, opts) => { const id = Number(/lote_id=(\d+)/.exec(url)[1]); pedidasZpl.push(id);
      return id <= 2 ? new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado')))) : { ok: true, status: 200, text: async () => ZPL }; }, true);
  pedidasZpl.length = 0;
  const seg = await r4.deNovo();
  assert.ok(!pedidasZpl.includes(1) && !pedidasZpl.includes(2), 'as etiquetas que travaram tinham que esperar na rodada seguinte (pedidas: ' + pedidasZpl + ')');
  assert.ok(seg && seg.lotes.find((l) => l.batch === 3).zpl === ZPL && seg.lotes.find((l) => l.batch === 4).zpl === ZPL, 'as etiquetas saudáveis de depois tinham que ganhar a vez');
  /* (5) o servidor trocado NO MEIO do envio: a confirmação fica no destino do ENVIO (A), não no novo (B) */
  let ouvinte2 = null;
  const st5 = { renderBase: 'https://servidor-a.example', tb_empresa: 'good', syncKey: 'k-mm' };
  const ch5 = { runtime: { onMessage: { addListener: (f) => { ouvinte2 = f; } } },
    storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st5) o[k] = JSON.parse(JSON.stringify(st5[k])); return o; }, set: async (o) => Object.assign(st5, o) } } };
  const fetch5 = async () => { st5.renderBase = 'https://servidor-b.example';   /* o dono trocou o servidor enquanto o envio ia */
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, zpl_guardados: ['555'] }) }; };
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: ch5, fetch: fetch5, console, Date, JSON, Object, Number, String, Array, Error });
  await new Promise((s2) => ouvinte2({ tipo: 'MM_LOTES', ok: true, lotes: [{ batch: 555, status: 2, zpl: ZPL }] }, {}, s2));
  assert.ok(st5.mm_zpl_entregues && st5.mm_zpl_entregues['https://servidor-a.example|good'] && st5.mm_zpl_entregues['https://servidor-a.example|good']['555'], 'a confirmação tinha que ficar no destino do ENVIO (A)');
  assert.ok(!st5.mm_zpl_entregues['https://servidor-b.example|good'], 'a confirmação NÃO podia ir pro servidor novo (B), que nunca recebeu a etiqueta');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — a etiqueta do Madeira vem pela extensão: o servidor guarda o ZPL do lote pronto e usa sem ir à rede; a página baixa só o que falta, com a sessão; o background marca o que foi entregue POR DESTINO; o corpo cabe no limite, etiqueta travada não segura o resto e dá a vez; a confirmação fica no destino do envio');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
