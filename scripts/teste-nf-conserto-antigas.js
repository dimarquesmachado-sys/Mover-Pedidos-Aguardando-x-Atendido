'use strict';
/* 20/11 — CONSERTO DA NF RECUSADA PELO ML: AS NOTAS ANTIGAS QUE FICARAM PRA TRÁS.
   O conserto entrega a nota NOVA ao ML; a recusada continua autorizada no Bling até alguém tratar. A regra do dono:
   cancelar ("fica visível, mais fácil de ver e saber q realmente cancelou") e, "se passar de 24h da emissão da NF, aí sim,
   gera a NF devolução". Cancelar/devolver é na tela do Bling; o que o sistema garante é que a nota antiga não seja
   esquecida.

   O que se prova (o código de produção), nas TRÊS empresas:
   A. a rota: só admin; entra na lista só nota cujo conserto TERMINOU (nova aceita pelo ML), que não é de teste e que não
      foi tratada; a ação é "cancelar" até 24 h da emissão e "devolução" depois — e "não sei" quando não há data;
   B. a nota que já aparece CANCELADA no Bling sai sozinha; qualquer outra situação fica; "não consegui ler" não tira;
      olha poucas por chamada e cada uma no máximo de meia em meia hora;
   C. tirar da lista à mão: só admin, só com confirma, só nota que está pendente;
   D. a criação guarda quando a nota recusada foi emitida;
   E. o aviso no painel: só o admin vê, diz o que cabe a cada nota, e o botão "já tratei" pede confirmação. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const Reg = require('../lib/fiscal/nf-conserto-registro');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-conserto-antigas-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const nfetch = require.resolve('node-fetch');
const idas = [];
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (u) => { idas.push(String(u)); throw new Error('rede bloqueada no teste: ' + u); } };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-antigas';
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
const CE = require('../lib/checkout/config-empresa');
const A = require('../lib/checkout/rota-nf-conserto-antigas');

const AGORA = Date.parse('2026-11-20T15:00:00-03:00');
/* grava um conserto no registro, no ponto que `ate` disser */
function conserto(dir, id, op) {
  op = op || {};
  Reg.abrir(dir, id, { numero: op.numero || ('N' + id), pedido_ml: op.pedido || ('2000' + id), teste: !!op.teste, emitida_em: op.emitida === undefined ? '2026-11-20 09:00:00' : op.emitida });
  if (op.ate === 'criando') return;
  if (op.ate === 'incerta') return Reg.duvida(dir, id, 'x');
  Reg.fechar(dir, id, { id: 'NOVA' + id, numero: 'NN' + id });
  if (op.ate === 'criada') return;
  Reg.anotar(dir, id, Object.assign({ no_ml_em: op.noMl || '2026-11-20T13:00:00.000Z' }, op.extra || {}));
}

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const cena = (bling, extra) => {
        const dir = pasta(); const lidas = []; let t = AGORA;
        const rota = A.criar(Object.assign({ empresa: emp, cacheDir: dir, agora: () => t, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '',
          validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
          blingGet: async (c) => { lidas.push(c); const r = typeof bling === 'function' ? bling(c) : (bling || {})[c]; if (r === 'ESTOURA') throw new Error('bling fora'); return r ? { ok: true, status: 200, data: { data: r } } : { ok: false, status: 429, data: null }; } }, extra || {}));
        const pedir = async (qs, cookie) => { const u = new URL('http://x' + pref + '/nf-conserto-antigas' + (qs || '')); const res = {}; const tt = await rota({ method: 'GET', headers: { cookie: cookie === undefined ? 'adm' : cookie } }, res, u, 'GET', u.pathname); return Object.assign(res._o || {}, { _s: res._s, _t: tt }); };
        return { dir, lidas, pedir, passa: (ms) => { t += ms; } };
      };
      assert.strictEqual(A.atende(pref, 'POST', pref + '/nf-conserto-antigas'), false); assert.strictEqual(A.atende(pref, 'GET', pref + '/nf-conserto-antiga'), false);

      /* ═══ A. quem entra na lista, e o que cabe a cada uma ═══ */
      const a = cena();
      conserto(a.dir, '101', { emitida: '2026-11-20 09:00:00', noMl: '2026-11-20T13:00:00.000Z' });          /* 6 h → cancelar */
      conserto(a.dir, '102', { emitida: '2026-11-19 15:00:01', noMl: '2026-11-20T12:00:00.000Z' });          /* 23h59m59 → cancelar */
      conserto(a.dir, '103', { emitida: '2026-11-19 15:00:00', noMl: '2026-11-20T11:00:00.000Z' });          /* 24 h cravadas → devolução */
      conserto(a.dir, '104', { emitida: '2026-11-18 09:38:51', noMl: '2026-11-20T10:00:00.000Z' });          /* 2 dias → devolução */
      conserto(a.dir, '105', { emitida: null, noMl: '2026-11-20T09:00:00.000Z' });                           /* sem data → não sei */
      conserto(a.dir, '201', { ate: 'criando' }); conserto(a.dir, '202', { ate: 'incerta' }); conserto(a.dir, '203', { ate: 'criada' });   /* o conserto não terminou */
      conserto(a.dir, '204', { teste: true }); conserto(a.dir, '205', { extra: { antiga_resolvida_em: '2026-11-20T14:00:00.000Z', antiga_resolvida_como: 'devolvida' } });
      /* sem credencial / estoquista: 404, sem ler nada */
      for (const [qs, ck] of [['', null], ['?k=errada', null], ['', 'est']]) { const r = await a.pedir(qs, ck); assert.deepStrictEqual([r._s, r.error, a.lidas.length], [404, 'not found', 0], emp + ': só admin'); }
      const l1 = await a.pedir();
      assert.deepStrictEqual([l1.ok, l1.total, l1.empresa, l1._s], [true, 5, emp, 200]);
      assert.deepStrictEqual(l1.antigas.map((x) => [x.nfe_id, x.acao, x.horas_desde_a_emissao]), [['105', null, null], ['104', 'devolucao', 53.4], ['103', 'devolucao', 24], ['102', 'cancelar', 24], ['101', 'cancelar', 6]],
        emp + ': só as de conserto TERMINADO, sem teste e sem tratada; até 24 h cancela (23h59m59 ainda cancela), 24 h cravadas já é devolução; a mais antiga primeiro: ' + JSON.stringify(l1.antigas.map((x) => [x.nfe_id, x.acao, x.horas_desde_a_emissao])));
      assert.deepStrictEqual(l1.antigas[4], { nfe_id: '101', numero: 'N101', nova_numero: 'NN101', pedido_ml: '2000101', horas_desde_a_emissao: 6, acao: 'cancelar', consertada_em: '2026-11-20T13:00:00.000Z' }, emp + ': o que a lista diz de cada nota — só números de nota e de venda');
      assert.strictEqual((await a.pedir('?k=chave-antigas', null)).total, 5, emp + ': pela chave também');

      /* ═══ B. o que o Bling mostra ═══ */
      /* olha poucas por chamada, e a mesma nota só de meia em meia hora */
      assert.deepStrictEqual(a.lidas, ['/nfe/101', '/nfe/102', '/nfe/103', '/nfe/104', '/nfe/105', '/nfe/101'], emp + ': com o Bling fora (429), cada chamada tenta 3 — e a vez RODA: as que não respondem não seguram as outras');
      assert.ok(['101', '102', '103', '104', '105'].every((id) => Reg.de(a.dir, id).antiga_vista_em === undefined && Reg.de(a.dir, id).antiga_resolvida_em === undefined), emp + ': o que não foi lido não é marcado como visto nem tratado');
      const b = cena({ '/nfe/101': { situacao: 2 }, '/nfe/102': { situacao: { valor: 2 } }, '/nfe/103': { situacao: 5 }, '/nfe/104': { situacao: 6, dataEmissao: '2026-11-18 09:38:51' }, '/nfe/106': 'ESTOURA', '/nfe/107': { situacao: 7 } });
      for (const id of ['101', '102', '103', '104', '105', '106', '107']) conserto(b.dir, id, { emitida: id === '104' ? null : '2026-11-20 09:00:00', noMl: '2026-11-20T1' + id.slice(2) + ':00:00.000Z' });
      const b1 = await b.pedir();
      assert.deepStrictEqual([b.lidas, b1.antigas.map((x) => x.nfe_id)], [['/nfe/101', '/nfe/102', '/nfe/103'], ['103', '104', '105', '106', '107']], emp + ': no máximo 3 por chamada; as CANCELADAS (situação 2, nos dois formatos) saem sozinhas; a autorizada fica');
      assert.deepStrictEqual([Reg.de(b.dir, '101').antiga_resolvida_como, Reg.de(b.dir, '101').antiga_resolvida_por, !!Reg.de(b.dir, '101').antiga_resolvida_em, Reg.de(b.dir, '103').antiga_resolvida_em, !!Reg.de(b.dir, '103').antiga_vista_em], ['cancelada', 'bling', true, undefined, true]);
      b.lidas.length = 0;
      const b2 = await b.pedir();
      assert.deepStrictEqual([b.lidas, b2.antigas.map((x) => [x.nfe_id, x.acao])], [['/nfe/104', '/nfe/105', '/nfe/106'], [['103', 'cancelar'], ['104', 'devolucao'], ['105', 'cancelar'], ['106', 'cancelar'], ['107', 'cancelar']]],
        emp + ': a chamada seguinte olha as que faltavam (não repete as já vistas); a nota sem data ganha a do Bling (e vira devolução); "não consegui ler" (429, exceção) NÃO tira da lista');
      assert.deepStrictEqual([Reg.de(b.dir, '104').emitida_em, Reg.de(b.dir, '105').antiga_vista_em, Reg.de(b.dir, '106').antiga_vista_em], ['2026-11-18 09:38:51', undefined, undefined], emp + ': o que não foi lido não é marcado como visto — tenta de novo na próxima');
      b.lidas.length = 0; await b.pedir();
      assert.deepStrictEqual(b.lidas, ['/nfe/107', '/nfe/105', '/nfe/106'], emp + ': as não lidas voltam pra fila — depois da que ainda não teve vez; as vistas há pouco, não');
      b.lidas.length = 0; b.passa(29 * 60000); await b.pedir();
      assert.deepStrictEqual(b.lidas, ['/nfe/105', '/nfe/106'], emp + ': antes de meia hora, nota já vista não é relida');
      b.lidas.length = 0; b.passa(2 * 60000); await b.pedir();
      assert.deepStrictEqual(b.lidas, ['/nfe/103', '/nfe/104', '/nfe/107'], emp + ': passada meia hora, relê — primeiro as que esperam há mais tempo');
      /* a data que o registro já tem não é trocada pela do Bling; nota de teste e conserto por terminar nunca são lidos */
      const b3 = cena({ '/nfe/101': { situacao: 5, dataEmissao: '2020-01-01 00:00:00' } }); conserto(b3.dir, '101'); conserto(b3.dir, '204', { teste: true }); conserto(b3.dir, '203', { ate: 'criada' });
      await b3.pedir();
      assert.deepStrictEqual([b3.lidas, Reg.de(b3.dir, '101').emitida_em], [['/nfe/101'], '2026-11-20 09:00:00']);
      /* registro ilegível / sem pasta: diz, não inventa lista vazia */
      const q = cena(); fs.writeFileSync(Reg.arquivo(q.dir), '{ quebrado');
      const rq = await q.pedir(); assert.deepStrictEqual([rq.ok, rq.etapa, rq.antigas], [false, 'registro', undefined], emp + ': registro ilegível não é "nenhuma pendente"');
      const sp = cena(null, { cacheDir: undefined }); assert.strictEqual((await sp.pedir()).etapa, 'sem_peca');
      const vazio = cena(); assert.deepStrictEqual([(await vazio.pedir()).total, vazio.lidas.length], [0, 0]);

      /* ═══ C. tirar da lista à mão ═══ */
      const c = cena({ '/nfe/101': { situacao: 5 }, '/nfe/104': { situacao: 5 } }); conserto(c.dir, '101'); conserto(c.dir, '104'); conserto(c.dir, '203', { ate: 'criada' }); conserto(c.dir, '204', { teste: true });
      for (const [qs, ck] of [['?resolver=101&como=devolvida&confirma=sim', null], ['?resolver=101&como=devolvida&confirma=sim', 'est']]) assert.strictEqual((await c.pedir(qs, ck))._s, 404);
      assert.strictEqual(Reg.de(c.dir, '101').antiga_resolvida_em, undefined, emp + ': quem não é admin não tira nada');
      for (const qs of ['?resolver=abc&como=devolvida&confirma=sim', '?resolver=101&como=sumiu&confirma=sim', '?resolver=101&confirma=sim', '?resolver=101&como=&confirma=sim']) { const r = await c.pedir(qs); assert.ok(r._s === 400 && /use \?resolver=/.test(r.erro), emp + ': ' + qs); }
      const semConf = await c.pedir('?resolver=101&como=devolvida');
      assert.deepStrictEqual([semConf.ok, semConf.etapa, Reg.de(c.dir, '101').antiga_resolvida_em], [false, 'confirmacao', undefined]);
      for (const id of ['999', '203', '204', '__proto__'.replace(/\D/g, '') || '0']) { const r = await c.pedir('?resolver=' + id + '&como=devolvida&confirma=sim'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'nao_pendente'], emp + ': ' + id + ' não está pendente'); }
      c.lidas.length = 0;
      const ok = await c.pedir('?resolver=101&como=DEVOLVIDA&confirma=SIM');
      assert.deepStrictEqual([ok.ok, ok.resolvida, c.lidas.length], [true, { nfe_id: '101', numero: 'N101', como: 'devolvida', devolucao_numero: null }, 0], emp + ': tirar da lista não vai ao Bling');
      assert.deepStrictEqual([Reg.de(c.dir, '101').antiga_resolvida_como, Reg.de(c.dir, '101').antiga_resolvida_por, Reg.de(c.dir, '101').estado, Reg.de(c.dir, '101').nova_id, Reg.de(c.dir, '101').no_ml_em], ['devolvida', 'admin', 'criada', 'NOVA101', '2026-11-20T13:00:00.000Z'], emp + ': anota como foi tratada sem perder o resto do registro');
      assert.strictEqual((await c.pedir('?resolver=101&como=cancelada&confirma=sim')).etapa, 'nao_pendente', emp + ': a mesma nota não é tratada duas vezes');
      assert.deepStrictEqual((await c.pedir()).antigas.map((x) => x.nfe_id), ['104']);
      assert.strictEqual((await c.pedir('?resolver=104&como=cancelada&confirma=sim')).resolvida.como, 'cancelada');
      assert.strictEqual((await c.pedir()).total, 0);

      /* ═══ pelo routes REAL da empresa: a rota existe, pede credencial e lê o registro DESTA empresa ═══ */
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      conserto(path.join(PASTAS, emp), '7' + emp.length, { extra: { antiga_vista_em: new Date().toISOString() } });
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-antigas' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(bb) { this._b = String(bb || ''); } }; await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [res._s, res._b]; };
      idas.length = 0;
      const semK = await real('');
      assert.ok(semK[0] === 404 || semK[0] === 401 || semK[0] === 302, emp + ': sem credencial o routes real respondeu ' + semK[0]);
      const comK = await real('?k=chave-antigas');
      assert.ok(comK[0] === 200 && new RegExp('"total":1').test(comK[1]) && new RegExp('"nfe_id":"7' + emp.length + '"').test(comK[1]) && !/sem_peca/.test(comK[1]), emp + ': o routes real não listou a nota do registro desta empresa: ' + comK[0] + ' ' + comK[1].slice(0, 200));
      assert.strictEqual(idas.length, 0, emp + ': nota vista há pouco não é relida no Bling');
    }

    /* ═══ D. a criação guarda quando a nota recusada foi emitida ═══ */
    {
      const R = require('../lib/checkout/rota-nf-conserto');
      const dir = pasta();
      const END = { street_name: 'Avenida Nova', street_number: '250', comment: '', neighborhood: { name: 'Centro' }, city: { name: 'São Paulo' }, state: { id: 'BR-SP' }, zip_code: '04567000' };
      const nfV = { id: 777, numero: '130772', situacao: 5, dataEmissao: '2026-11-18 09:00:00', numeroPedidoLoja: '2000016', naturezaOperacao: { id: 15 }, loja: { id: 1 }, contato: { id: 9, nome: 'X Y', endereco: { endereco: 'Xxxxxxx', numero: 'XXXXXXX', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '' } }, itens: [{ codigo: 'A', quantidade: 1, valor: 5 }], transporte: {} };
      const rota = R.criar({ empresa: 'girassol', cacheDir: dir, json: (res, st, o) => { res._o = o; }, lerChaveAdmin: () => 'chave-antigas', validarSessao: () => null, ehAdmin: () => false, tokenML: async () => 't',
        fetch: async (u) => { const p = String(u).replace('https://api.mercadolibre.com', ''); const r = { '/orders/2000016': { shipping: { id: 1 } }, '/shipments/1': { status: 'ready_to_ship', substatus: 'invoice_pending', destination: { shipping_address: END } } }[p]; return { status: r ? 200 : 404, json: async () => r || {} }; },
        blingGet: async () => ({ ok: true, status: 200, data: { data: nfV } }), blingWrite: async () => ({ ok: true, status: 201, data: { data: { id: 888, numero: '130800' } } }) });
      const u = new URL('http://x/girassol-backup-offline/nf-conserto-criar?nf=777&confirma=sim'); const res = {};
      await rota({ method: 'GET', headers: {} }, res, u, 'GET', u.pathname);
      assert.deepStrictEqual([res._o.criou, Reg.de(dir, '777').emitida_em], [true, '2026-11-18 09:00:00'], 'a criação tem que guardar a emissão da nota recusada: ' + JSON.stringify(res._o).slice(0, 200));
    }

    /* ═══ E. o aviso no painel ═══ */
    {
      const html = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
      assert.ok(/<div id="nfAntigas" style="display:none/.test(html), 'a caixa do aviso não está no painel (escondida até ter o que mostrar)');
      const i0 = html.indexOf('function _nfaLimpo'), fim = 'setInterval(checarNFAntigas, 5*60000);\n', i1 = html.indexOf(fim);
      assert.ok(i0 > 0 && i1 > i0, 'o trecho do aviso das antigas não está no painel');
      const nav = (op) => {
        op = op || {}; const el = { style: { display: 'none' }, innerHTML: '' }; const obs = { buscas: [], toasts: [], confirma: [], intervalos: [] };
        const papel = op.papel || { admin: true };
        const f = new Function('document', 'fetch', 'setInterval', 'souAdmin', 'confirm', 'toast', html.slice(i0, i1 + fim.length).split('{{PREFIXO}}').join('/emp') + '\nreturn { checarNFAntigas, resolverNFAntiga, _nfaHoras, _nfaLimpo };')(
          { getElementById: (id) => (id === 'nfAntigas' && !op.semEl ? el : null) },
          async (u) => { obs.buscas.push(u); if (op.rede) throw new Error('rede'); if (/resolver=/.test(u)) return { json: async () => (op.respResolver === undefined ? { ok: true } : op.respResolver) }; return { json: async () => (typeof op.lista === 'function' ? op.lista() : op.lista) }; },
          (fn, ms) => obs.intervalos.push(ms), () => papel.admin, (m) => { obs.confirma.push(m); return op.confirma !== false; }, (m) => obs.toasts.push(m));
        return { f, el, obs, papel };
      };
      const LISTA = { ok: true, total: 3, antigas: [{ nfe_id: '101', numero: '082108', nova_numero: '082183', pedido_ml: '2000016131230817', horas_desde_a_emissao: 53.4, acao: 'devolucao' }, { nfe_id: '102', numero: '130<b>772', nova_numero: null, pedido_ml: null, horas_desde_a_emissao: 6.25, acao: 'cancelar' }, { nfe_id: "10'3", numero: null, acao: null, horas_desde_a_emissao: null }] };
      const n = nav({ lista: LISTA }); assert.deepStrictEqual(n.obs.intervalos, [5 * 60000], 'a lista é reconsultada de 5 em 5 minutos');
      await n.f.checarNFAntigas();
      const h = n.el.innerHTML;
      assert.ok(n.el.style.display === '' && /3 notas antigas pra cancelar ou devolver/.test(h), 'o aviso: ' + h.slice(0, 200));
      assert.ok(/href="https:\/\/www\.bling\.com\.br\/notas\.fiscais\.php#edit\/101"[^>]*><b>NF 082108<\/b><\/a> \(substituída pela 082183\) · pedido ML 2000016131230817: gerar a <b>NF de DEVOLUÇÃO<\/b> \(emitida há 2 dias/.test(h), 'a de mais de 24 h: devolução, com o atalho pra nota no Bling');
      assert.ok(/<b>NF 130b772<\/b><\/a>: <b>CANCELAR<\/b> no Bling \(emitida há 6,3 h — até 24 h ainda cancela\)/.test(h) && !/<b>772/.test(h.replace(/<b>NF 130b772<\/b>/, '')), 'a de menos de 24 h: cancelar; o número entra limpo');
      assert.ok(/<b>NF 103<\/b><\/a>: cancelar \(até 24 h da emissão\) ou devolver — não sei quando foi emitida/.test(h) && /resolverNFAntiga\('103','103','devolvida'\)/.test(h), 'sem data: diz que não sabe; id e número limpos no botão');
      assert.ok(/onclick="resolverNFAntiga\('101','082108','devolvida'\)"/.test(h) && /onclick="resolverNFAntiga\('101','082108','cancelada'\)"/.test(h));
      assert.deepStrictEqual([n.f._nfaHoras(0.04), n.f._nfaHoras(23.96), n.f._nfaHoras(47.9), n.f._nfaHoras(48), n.f._nfaHoras(240), n.f._nfaHoras(null)], ['0 h', '24 h', '47,9 h', '2 dias', '10 dias', '']);
      /* uma só: singular; mais de 8: diz quantas ficaram de fora */
      const um = nav({ lista: { ok: true, total: 1, antigas: [LISTA.antigas[0]] } }); await um.f.checarNFAntigas(); assert.ok(/1 nota antiga pra cancelar/.test(um.el.innerHTML));
      const muitas = nav({ lista: { ok: true, total: 11, antigas: Array.from({ length: 11 }, (_, i) => ({ nfe_id: String(500 + i), numero: 'N' + i, acao: 'cancelar', horas_desde_a_emissao: 1 })) } }); await muitas.f.checarNFAntigas();
      assert.ok((muitas.el.innerHTML.match(/'devolvida'/g) || []).length === 8 && /… e mais 3\./.test(muitas.el.innerHTML));
      /* não-admin não vê nem consulta; lista vazia e resposta de erro escondem; falha de rede não apaga o que está na tela */
      const est = nav({ lista: LISTA, papel: { admin: false } }); est.el.innerHTML = 'velho'; est.el.style.display = ''; await est.f.checarNFAntigas();
      assert.deepStrictEqual([est.obs.buscas.length, est.el.style.display, est.el.innerHTML], [0, 'none', ''], 'o estoquista não vê a lista (e ela some se trocou de operador)');
      const trocou = nav({ lista: LISTA }); const pt = trocou.f.checarNFAntigas(); trocou.papel.admin = false; await pt;
      assert.strictEqual(trocou.el.style.display, 'none', 'trocou pra estoquista enquanto a consulta voltava: não desenha');
      for (const lista of [{ ok: true, total: 0, antigas: [] }, { ok: false, etapa: 'registro' }, null]) { const v = nav({ lista }); v.el.style.display = ''; v.el.innerHTML = 'velho'; await v.f.checarNFAntigas(); assert.deepStrictEqual([v.el.style.display, v.el.innerHTML], ['none', ''], JSON.stringify(lista)); }
      const rede = nav({ lista: LISTA, rede: true }); rede.el.style.display = ''; rede.el.innerHTML = 'o que já estava'; await rede.f.checarNFAntigas();
      assert.deepStrictEqual([rede.el.style.display, rede.el.innerHTML], ['', 'o que já estava']);
      await nav({ lista: LISTA, semEl: true }).f.checarNFAntigas();
      /* "já tratei": confirma, chama a rota, avisa e reconsulta */
      const r1 = nav({ lista: LISTA }); await r1.f.resolverNFAntiga('101', '082108', 'devolvida');
      assert.deepStrictEqual(r1.obs.buscas, ['/emp/nf-conserto-antigas?resolver=101&como=devolvida&confirma=sim', '/emp/nf-conserto-antigas']);
      assert.ok(/Tirar a NF 082108 da lista\?/.test(r1.obs.confirma[0]) && /DEVOLVIDA/.test(r1.obs.confirma[0]) && /não cancela nem devolve nada/.test(r1.obs.confirma[0]) && /fora da lista/.test(r1.obs.toasts[0]));
      const r2 = nav({ lista: LISTA }); await r2.f.resolverNFAntiga('102', '130772', 'cancelada'); assert.ok(/CANCELADA/.test(r2.obs.confirma[0]) && /como=cancelada/.test(r2.obs.buscas[0]));
      const r3 = nav({ lista: LISTA, confirma: false }); await r3.f.resolverNFAntiga('101', '082108', 'devolvida'); assert.deepStrictEqual(r3.obs.buscas, [], 'sem confirmar, nada sai');
      const r4 = nav({ lista: LISTA, papel: { admin: false } }); await r4.f.resolverNFAntiga('101', '082108', 'devolvida'); assert.deepStrictEqual([r4.obs.buscas.length, r4.obs.confirma.length], [0, 0], 'não-admin não trata');
      const r5 = nav({ lista: LISTA, respResolver: { ok: false, erro: 'essa nota não está na lista' } }); await r5.f.resolverNFAntiga('101', '082108', 'devolvida'); assert.ok(/não consegui tirar da lista: essa nota não está na lista/.test(r5.obs.toasts[0]) && r5.obs.buscas.length === 2);
      const r6 = nav({ lista: LISTA, respResolver: null }); await r6.f.resolverNFAntiga('101', '082108', 'devolvida'); assert.ok(/sem resposta/.test(r6.obs.toasts[0]));
      const r7 = nav({ lista: LISTA, rede: true }); await r7.f.resolverNFAntiga('101', '082108', 'devolvida'); assert.ok(/falha de comunicação/.test(r7.obs.toasts[0]));
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — conserto da NF, as notas antigas que ficaram pra trás: só entra a de conserto terminado (nunca a de teste); cancelar até 24 h, devolução depois, "não sei" sem data; a cancelada no Bling sai sozinha (poucas leituras, de meia em meia hora, e "não li" não tira); tirar à mão só admin e com confirmação; e o aviso no painel só pro admin — nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
