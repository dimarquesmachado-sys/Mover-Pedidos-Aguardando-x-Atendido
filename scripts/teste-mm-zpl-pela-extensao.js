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
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: chromeBg, fetch: fetchBg, console, Date, JSON, Object, Number, String, Array, setTimeout, clearTimeout, AbortController });
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
  vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: ch5, fetch: fetch5, console, Date, JSON, Object, Number, String, Array, Error, setTimeout, clearTimeout, AbortController });
  await new Promise((s2) => ouvinte2({ tipo: 'MM_LOTES', ok: true, lotes: [{ batch: 555, status: 2, zpl: ZPL }] }, {}, s2));
  assert.ok(st5.mm_zpl_entregues && st5.mm_zpl_entregues['https://servidor-a.example|good'] && st5.mm_zpl_entregues['https://servidor-a.example|good']['555'], 'a confirmação tinha que ficar no destino do ENVIO (A)');
  assert.ok(!st5.mm_zpl_entregues['https://servidor-b.example|good'], 'a confirmação NÃO podia ir pro servidor novo (B), que nunca recebeu a etiqueta');

  /* Codex #804 (r3) — (6) "Sincronizar agora" no meio de uma rodada automática: o manual entra na fila e roda depois
     (a telinha espera o resultado 'manual'), e a resposta ao botão só vem quando ele terminou */
  {
    const msgs6 = []; let ouv6 = null; let soltar6; const preso = new Promise((ok) => { soltar6 = ok; });
    const st6 = { renderBase: 'https://servidor.example', tb_empresa: 'good' };
    const ch6 = { runtime: { sendMessage: (m) => msgs6.push(m), onMessage: { addListener: (f) => { ouv6 = f; } } },
      storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st6) o[k] = JSON.parse(JSON.stringify(st6[k])); return o; }, set: async (o) => Object.assign(st6, o) } } };
    let primeira = true;
    const f6 = async (url) => {
      if (/\/lotes$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ batch: 9, status: 2 }] }) };
      if (primeira) { primeira = false; await preso; }   /* a etiqueta da rodada automática demora */
      return { ok: true, status: 200, text: async () => ZPL };
    };
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'),
      { window: {}, chrome: ch6, fetch: f6, setInterval: () => 0, setTimeout, clearTimeout, AbortController, TextEncoder, console });
    await new Promise((s2) => setTimeout(s2, 30));
    let respondeu = false;
    ouv6({ tipo: 'MM_SYNC_AGORA', pedido: 'clique-6' }, {}, () => { respondeu = true; });
    assert.ok(respondeu, '2.1.8: o botão tinha que ser respondido NA HORA (a telinha conta o próprio tempo)');
    soltar6();
    for (let i = 0; i < 200 && msgs6.length < 2; i++) await new Promise((s2) => setTimeout(s2, 10));
    assert.deepStrictEqual(msgs6.map((m) => m.motivo), ['load', 'manual'], 'o manual tinha que rodar depois da rodada automática (veio: ' + msgs6.map((m) => m.motivo) + ')');
    /* Codex #805: a rodada que atende o clique leva o id dele; a automática (que já ia no meio) não leva nenhum */
    assert.ok((msgs6[0].pedidos || []).length === 0 && (msgs6[1].pedidos || []).includes('clique-6'), 'o id do clique tinha que ir SÓ na rodada que o atende: ' + JSON.stringify(msgs6.map((m) => m.pedidos)));
  }

  /* 2.1.8 — o caso real do dono: "Sincronizar agora" parado em "Sincronizando..." */
  /* (7) o Madeira NÃO RESPONDE a leitura dos lotes: a rodada termina no prazo (com o motivo) e o manual roda depois */
  {
    const msgs7 = []; let ouv7 = null;
    const ch7 = { runtime: { sendMessage: (m) => msgs7.push(m), onMessage: { addListener: (f) => { ouv7 = f; } } },
      storage: { local: { get: async () => ({}), set: async () => {} } } };
    const f7 = (url, opts) => new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado'))));   /* nunca responde */
    const relogio = (fn, ms) => setTimeout(fn, Math.min(ms, 40));
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'),
      { window: {}, chrome: ch7, fetch: f7, setInterval: () => 0, setTimeout: relogio, clearTimeout, AbortController, TextEncoder, console });
    ouv7({ tipo: 'MM_SYNC_AGORA' }, {}, () => {});
    for (let i = 0; i < 300 && msgs7.length < 2; i++) await new Promise((s2) => setTimeout(s2, 10));
    assert.ok(msgs7.length >= 2 && msgs7[0].ok === false && /não respondeu/.test(msgs7[0].erro || ''), 'com o Madeira mudo, a rodada tinha que terminar no prazo dizendo o motivo: ' + JSON.stringify(msgs7[0]));
    assert.strictEqual(msgs7[1].motivo, 'manual', 'o manual tinha que rodar depois (e não ficar preso atrás da rodada muda)');
  }
  /* (8) a TELINHA: o relógio começa no clique; só vale o resultado da rodada que atende ESTE clique (Codex #805); depois
     do aviso dos 90 s ela continua ouvindo e o resultado que chegar depois substitui o aviso */
  {
    const el = {}; const $el = (id) => (el[id] = el[id] || { value: '', textContent: '', onclick: null });
    const docFalso = { getElementById: $el };
    const ouvintes = []; let enviado = null;
    const chP = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: (f) => ouvintes.push(f), removeListener: (f) => { const i = ouvintes.indexOf(f); if (i >= 0) ouvintes.splice(i, 1); } } },
      tabs: { query: async () => [{ id: 1, url: 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/x' }], sendMessage: (id, m) => { enviado = m; /* a página nunca responde */ } },
      runtime: { lastError: null } };
    const relogioP = (fn, ms) => setTimeout(fn, Math.min(ms, 40));
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'mm.js'), 'utf8'), { document: docFalso, chrome: chP, setTimeout: relogioP, clearTimeout, Date, Math, Array, console });
    await el.sync.onclick();
    assert.ok(enviado && enviado.tipo === 'MM_SYNC_AGORA' && enviado.pedido, 'o clique tinha que mandar o id do pedido');
    const avisar = (st) => ouvintes.slice().forEach((f) => f({ ultimoStatus: { newValue: st } }, 'local'));
    /* o fim de uma rodada que NÃO atende este clique (gravado depois dele) não pode ser tomado como resposta */
    avisar({ etapa: 'sync', ok: true, motivo: 'manual', pedidos: ['outro'], quando: Date.now(), lidos: 1, prontos: 1 });
    assert.ok(!/Sincronizado/.test(el.status.textContent), 'a telinha aceitou o resultado de uma rodada que não atende o clique');
    for (let i = 0; i < 100 && !/90s/.test(el.status.textContent); i++) await new Promise((s2) => setTimeout(s2, 10));
    assert.ok(/90s/.test(el.status.textContent), 'a telinha ficou parada em "' + el.status.textContent + '" (o caso do dono)');
    /* chegou o resultado DA rodada do clique depois do aviso: ele substitui o aviso */
    avisar({ etapa: 'sync', ok: true, motivo: 'manual', pedidos: [enviado.pedido], quando: Date.now(), lidos: 6, prontos: 6 });
    assert.ok(/Sincronizado/.test(el.status.textContent), 'o resultado que chegou depois dos 90 s tinha que substituir o aviso (está: "' + el.status.textContent + '")');
  }
  /* (9) o SERVIDOR não responde o envio: o background registra o motivo em vez de esperar pra sempre */
  {
    let ouv9 = null; const st9 = { renderBase: 'https://servidor.example', tb_empresa: 'good', syncKey: 'k-mm' };
    const ch9 = { runtime: { onMessage: { addListener: (f) => { ouv9 = f; } } },
      storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st9) o[k] = st9[k]; return o; }, set: async (o) => Object.assign(st9, o) } } };
    const f9 = (url, opts) => new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado'))));
    const relogio9 = (fn, ms) => setTimeout(fn, Math.min(ms, 40));
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'),
      { chrome: ch9, fetch: f9, console, Date, JSON, Object, Number, String, Array, Error, setTimeout: relogio9, clearTimeout, AbortController });
    await new Promise((s2) => ouv9({ tipo: 'MM_LOTES', ok: true, motivo: 'manual', pedidos: ['clique-9'], lotes: [] }, {}, s2));
    assert.ok(st9.ultimoStatus && (st9.ultimoStatus.pedidos || []).includes('clique-9'), 'o status tinha que levar os ids dos cliques (Codex #805) — sem eles a telinha não reconhece a resposta');
    assert.ok(st9.ultimoStatus && st9.ultimoStatus.ok === false && /não respondeu em 60s/.test(st9.ultimoStatus.erro || '') && st9.ultimoStatus.motivo === 'manual', 'com o servidor mudo, o status tinha que dizer o motivo: ' + JSON.stringify(st9.ultimoStatus));
  }

  /* 2.1.9 — o caso real (3 de 6 lotes da GOOD ficando pra trás, e a telinha só dizendo "Sincronizado!"):
     (10) cada lote sem etiqueta aparece com o MOTIVO; demora tenta de novo antes (3 min) que erro HTTP (10 min) */
  {
    const msgs10 = []; let ouv10 = null;
    const ch10 = { runtime: { sendMessage: (m) => msgs10.push(m), onMessage: { addListener: (f) => { ouv10 = f; } } },
      storage: { local: { get: async () => ({}), set: async () => {} } } };
    const lotes10 = [{ batch: 306783, status: 2 }, { batch: 306782, status: 2 }, { batch: 306786, status: 2 }];
    const f10 = async (url, opts) => {
      if (/\/lotes$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(lotes10)) }) };
      if (/lote_id=306783/.test(url)) return new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado'))));   /* demora */
      if (/lote_id=306782/.test(url)) return { ok: false, status: 401, text: async () => '{}' };
      return { ok: true, status: 200, text: async () => ZPL };
    };
    const relogio10 = (fn, ms) => setTimeout(fn, Math.min(ms, 30));
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'),
      { window: {}, chrome: ch10, fetch: f10, setInterval: () => 0, setTimeout: relogio10, clearTimeout, AbortController, TextEncoder, console });
    for (let i = 0; i < 200 && !msgs10.length; i++) await new Promise((s2) => setTimeout(s2, 10));
    const m10 = msgs10[0];
    const fz = (b) => (m10.zpl_falhas || []).find((f) => f.batch === b);
    assert.ok(fz('306783') && /demorou mais de 60s/.test(fz('306783').motivo), 'a demora tinha que aparecer com o motivo: ' + JSON.stringify(m10.zpl_falhas));
    assert.ok(fz('306782') && /HTTP 401/.test(fz('306782').motivo), 'o 401 tinha que aparecer com o motivo: ' + JSON.stringify(m10.zpl_falhas));
    assert.ok(!fz('306786') && m10.lotes.find((l) => l.batch === 306786).zpl === ZPL, 'o lote que baixou tinha que ir com a etiqueta e fora da lista de falhas');
    /* na rodada seguinte as duas continuam na lista (esperando), sem novo download */
    await new Promise((ok) => ouv10({ tipo: 'MM_SYNC_AGORA', pedido: 'c10' }, {}, ok));
    for (let i = 0; i < 200 && msgs10.length < 2; i++) await new Promise((s2) => setTimeout(s2, 10));
    const m10b = msgs10[1];
    assert.ok((m10b.zpl_falhas || []).filter((f) => f.esperando).length === 2, 'na rodada seguinte as duas tinham que aparecer como esperando: ' + JSON.stringify(m10b.zpl_falhas));
    /* o background leva a lista pro status (é de lá que a telinha lê) */
    {
      let ouvB = null; const stB = { renderBase: 'https://servidor.example', tb_empresa: 'good', syncKey: 'k-mm' };
      const chB = { runtime: { onMessage: { addListener: (f) => { ouvB = f; } } },
        storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in stB) o[k] = stB[k]; return o; }, set: async (o) => Object.assign(stB, o) } } };
      const fB = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, total_no_mapa: 38, zpl_guardados: [] }) });
      vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-mm.js'), 'utf8'), { chrome: chB, fetch: fB, console, Date, JSON, Object, Number, String, Array, Error, setTimeout, clearTimeout, AbortController });
      await new Promise((s2) => ouvB(Object.assign({}, m10, { motivo: 'manual', pedidos: ['c'] }), {}, s2));
      assert.ok(stB.ultimoStatus && Array.isArray(stB.ultimoStatus.zpl_falhas) && stB.ultimoStatus.zpl_falhas.length === 2, 'o background não levou a lista do que ficou sem etiqueta pro status: ' + JSON.stringify(stB.ultimoStatus && stB.ultimoStatus.zpl_falhas));
    }
    /* a telinha mostra a lista */
    const el = {}; const $el = (id) => (el[id] = el[id] || { value: '', textContent: '', onclick: null });
    const chT = { storage: { local: { get: async () => ({ ultimoStatus: { etapa: 'sync', ok: true, motivo: 'manual', lidos: 6, prontos: 6, etiquetas: 1, resposta: { total_no_mapa: 38 }, zpl_falhas: m10.zpl_falhas, quando: Date.now() } }), set: async () => {} }, onChanged: { addListener: () => {}, removeListener: () => {} } },
      tabs: { query: async () => [] }, runtime: { lastError: null } };
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'mm.js'), 'utf8'), { document: { getElementById: $el }, chrome: chT, setTimeout, clearTimeout, Date, Math, Array, console });
    for (let i = 0; i < 50 && !/Sincronizado/.test($el('status').textContent); i++) await new Promise((s2) => setTimeout(s2, 10));
    const tela = $el('status').textContent;
    assert.ok(/lote 306783: o Madeira demorou mais de 60s/.test(tela) && /lote 306782: o Madeira respondeu HTTP 401/.test(tela) && /etiquetas entregues 1/.test(tela),
      'a telinha não mostra o que ficou sem etiqueta e por quê: ' + tela);
  }
  /* (12) Codex #808 (P1): 4 lotes que SEMPRE demoram na frente e um 5º saudável — com relógio VIRTUAL (o prazo de 60 s
     por etiqueta, os 100 s da rodada e a nova tentativa em 3 min valem de verdade) e uma rodada por minuto, o 5º tem
     que ser baixado em poucas rodadas (antes, as demoradas comiam o prazo de toda rodada e ele nunca chegava a vez) */
  {
    let agora = 1e12;
    class DataV extends Date { static now() { return agora; } }
    const relogioV = (fn, ms) => ms >= 200000 ? 0 : setTimeout(() => { agora += ms; fn(); }, 2);   /* o prazo "passa" no relógio virtual (o teto de 200 s da rodada não dispara: não é o que se testa) */
    const msgs12 = []; let ouv12 = null; const pedidos12 = [];
    const ch12 = { runtime: { sendMessage: (m) => msgs12.push(m), onMessage: { addListener: (f) => { ouv12 = f; } } },
      storage: { local: { get: async () => ({}), set: async () => {} } } };
    const f12 = async (url, opts) => {
      if (/\/lotes$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [1, 2, 3, 4, 5].map((b) => ({ batch: b, status: 2 })) }) };
      const id = Number(/lote_id=(\d+)/.exec(url)[1]); pedidos12.push(id);
      if (id <= 4) return new Promise((ok, falha) => opts.signal.addEventListener('abort', () => falha(new Error('abortado'))));
      return { ok: true, status: 200, text: async () => ZPL };
    };
    vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-mm.js'), 'utf8'),
      { window: {}, chrome: ch12, fetch: f12, setInterval: () => 0, setTimeout: relogioV, clearTimeout, AbortController, TextEncoder, console, Date: DataV });
    for (let i = 0; i < 300 && !msgs12.length; i++) await new Promise((s2) => setTimeout(s2, 5));
    let achou = (msgs12[0].lotes.find((l) => l.batch === 5) || {}).zpl === ZPL;
    for (let rodada = 2; rodada <= 6 && !achou; rodada++) {
      agora += 60000;   /* a próxima rodada, um minuto depois */
      const n0 = msgs12.length;
      await new Promise((ok) => ouv12({ tipo: 'MM_SYNC_AGORA', pedido: 'r' + rodada }, {}, ok));
      for (let i = 0; i < 300 && msgs12.length === n0; i++) await new Promise((s2) => setTimeout(s2, 5));
      achou = (msgs12[msgs12.length - 1].lotes.find((l) => l.batch === 5) || {}).zpl === ZPL;
    }
    /* Codex #808 (P2): com o orçamento da rodada esgotado, as falhas EM ESPERA do resto da lista continuam no status (o background troca o status inteiro) */
    /* (e o MOTIVO de cada uma continua lá — era isso que sumia da telinha) */
    assert.ok(msgs12.length < 2 || [1, 2, 3, 4].every((b) => (msgs12[1].zpl_falhas || []).some((x) => x.batch === String(b) && /demorou mais de 60s/.test(x.motivo || ''))),
      'o status da 2ª rodada perdeu o MOTIVO de alguma falha em espera: ' + JSON.stringify(msgs12[1] && msgs12[1].zpl_falhas));
    assert.ok(msgs12.length < 2 || [1, 2, 3, 4].every((b) => (msgs12[1].zpl_falhas || []).some((x) => x.batch === String(b))), 'o status da 2ª rodada perdeu falhas em espera: ' + JSON.stringify(msgs12[1] && msgs12[1].zpl_falhas));
    assert.ok(achou, 'o lote saudável (5º) nunca foi baixado — as etiquetas que demoram comeram o prazo de toda rodada (pedidas: ' + pedidos12.join(',') + ')');
  }
  /* (11) o menu principal mostra a VERSÃO (pedido do dono) */
  {
    const pop = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.html'), 'utf8');
    const popjs = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8');
    assert.ok(/id="versao"/.test(pop) && /getElementById\('versao'\)[\s\S]{0,120}chrome\.runtime\.getManifest\(\)\.version/.test(popjs), 'o menu principal não mostra a versão da extensão');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — a etiqueta do Madeira vem pela extensão: o servidor guarda o ZPL do lote pronto e usa sem ir à rede; a página baixa só o que falta, com a sessão; o background marca o que foi entregue POR DESTINO; o corpo cabe no limite, etiqueta travada não segura o resto e dá a vez; a confirmação fica no destino do envio; o "Sincronizar agora" no meio de uma rodada entra na fila; nada fica parado em "Sincronizando" (Madeira mudo, página muda ou servidor mudo)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
