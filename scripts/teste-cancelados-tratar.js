'use strict';
/* 26/11 — CANCELADO NO MARKETPLACE ANTES DA POSTAGEM: TRATAR (lib/checkout/rota-cancelados-tratar).
   Pedido do dono: avisar no checkout, "gerar cancelamento se menos 24h da emissão da NF ou devolução se for mais q isso",
   e "depois mover ele pra status cancelado dentro do bling". A regra que manda: "só pode ser de pedidos AINDA NÃO POSTADOS".

   O que se prova (o código de produção), nas TRÊS empresas:
   A. a lista: só admin; só pedido na fila SEM conferência e cancelado no TikTok SEM sinal de envio; a ação é "cancelar"
      até 24 h da emissão, "devolução" depois, "sem_nf" sem nota, e null sem data; sem dado de gente; TikTok fora não vira
      lista vazia "ok"; a lista não vai ao Bling;
   B. preparar a devolução: as duas pontas conferidas NA HORA (postado, ativo, conferido, fora do ar → nada); a nota é a
      mesma, não está cancelada e já passou das 24 h (pela data do Bling);
   C. resolver: confere as duas pontas de novo; "já cancelei" só vale com a nota CANCELADA no Bling; move o pedido pra
      "Cancelado" (uma tentativa; o que o Bling recusa por já estar lá vale como movido); falha ao mover não tira da lista;
      tratado sai da lista e não é tratado duas vezes;
   D. o routes REAL de cada empresa atende a rota, com a fila e a pasta DELA. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'cancelados-tratar-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const nfetch = require.resolve('node-fetch');
const idas = [];
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (u) => { idas.push(String(u)); throw new Error('rede bloqueada no teste: ' + u); } };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-canc';
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
const CE = require('../lib/checkout/config-empresa');
const T = require('../lib/checkout/rota-cancelados-tratar');

const AGORA = Date.parse('2026-11-26T15:00:00-03:00');
const CANC = (id, extra) => Object.assign({ id, status: 'CANCELLED', rts_time: 1, tracking_number: 'R' + id, line_items: [{ display_status: 'CANCELLED', package_status: 'CANCELLED' }] }, extra || {});
/* a fila: 10 = o caso (NF há 6 h), 11 = NF há 30 h, 12 = sem nota, 13 = nota sem data, 14 = postado (coletado),
   15 = ativo, 16 = já conferido pelo checkout, 17 = outro marketplace, 18 = sem número do TikTok, 19 = TikTok não devolve */
const MAN = () => ({
  10: { numero: 1010, marketplace: 'tiktok', numero_loja: 'T10', cliente: 'FULANO DE TAL', nf_numero: '131074', nf_emissao: '2026-11-26 09:00:00' },
  11: { numero: 1011, marketplace: 'TikTok', numero_loja: 'T11', cliente: 'BELTRANO', nf_numero: '131000', nf_emissao: '2026-11-25 09:00:00' },
  12: { numero: 1012, marketplace: 'tiktok', numero_loja: 'T12' },
  13: { numero: 1013, marketplace: 'tiktok', numero_loja: 'T13', nf_numero: '131013' },
  14: { numero: 1014, marketplace: 'tiktok', numero_loja: 'T14', nf_numero: '131014', nf_emissao: '2026-11-20 09:00:00' },
  15: { numero: 1015, marketplace: 'tiktok', numero_loja: 'T15', nf_numero: '131015', nf_emissao: '2026-11-20 09:00:00' },
  16: { numero: 1016, marketplace: 'tiktok', numero_loja: 'T16', nf_numero: '131016', nf_emissao: '2026-11-20 09:00:00' },
  17: { numero: 1017, marketplace: 'shopee', numero_loja: 'T17', nf_numero: '131017', nf_emissao: '2026-11-20 09:00:00' },
  18: { numero: 1018, marketplace: 'tiktok', numero_loja: null, nf_numero: '131018', nf_emissao: '2026-11-20 09:00:00' },
  19: { numero: 1019, marketplace: 'tiktok', numero_loja: 'T19', nf_numero: '131019', nf_emissao: '2026-11-20 09:00:00' },
});
const TK = () => ({ T10: CANC('T10'), T11: CANC('T11'), T12: CANC('T12'), T13: CANC('T13'), T14: CANC('T14', { collection_time: 5 }), T15: { id: 'T15', status: 'AWAITING_COLLECTION' },
  T16: CANC('T16'), T17: CANC('T17'), T18: CANC('T18') });
const NFE = () => ({
  '/nfe/9010': { id: 9010, numeroPedidoLoja: 'T10', numero: '131074', situacao: 5, dataEmissao: '2026-11-26 09:00:00', loja: { id: 205 } },
  '/nfe/9011': { id: 9011, numeroPedidoLoja: 'T11', numero: '0131000', situacao: { valor: 6 }, dataEmissao: '2026-11-25 09:00:00', loja: { id: 205 } },
  '/nfe/9013': { id: 9013, numeroPedidoLoja: 'T13', numero: '131013', situacao: 5, loja: { id: 205 } },
  '/nfe/9014': { id: 9014, numeroPedidoLoja: 'T14', numero: '131014', situacao: 5, dataEmissao: '2026-11-20 09:00:00', loja: { id: 205 } },
});

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const cena = (op) => {
        op = op || {};
        const dir = pasta(); let t = AGORA;
        const man = op.man || MAN(), conf = op.conf || { 16: { conferido_em: '2026-11-26T10:00:00Z' } };
        const tk = op.tk || TK(), nfe = op.nfe || NFE();
        for (const id of Object.keys(man)) { if (!man[id].nf_numero || (op.semSnap || []).includes(id)) continue; fs.mkdirSync(path.join(dir, id), { recursive: true }); fs.writeFileSync(path.join(dir, id, 'pedido.json'), JSON.stringify(Object.assign({ nf: { id: 9000 + Number(id), numero: man[id].nf_numero } }, (op.snap || {})[id] || {}))); }
        const o = { tkIdas: [], lidas: [], escritas: [], sit: [] };
        const cx = { dir, o, man, conf, tk, nfe, tkErro: null, tkEstoura: false, escreve: () => ({ ok: true, status: 204, data: null }), pedidoBling: null,
          sitCancel: { ids: [15, 12], nomes: ['Cancelado pelo marketplace', 'Cancelado'] }, passa: (ms) => { t += ms; } };
        const rota = T.criar(Object.assign({ empresa: emp, prefixo: pref, cacheDir: dir, agora: () => t, tiktokConta: 'conta-' + emp,
          json: (res, st, ob) => { res._s = st; res._o = ob; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '',
          validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
          manifest: () => cx.man, lerConferidos: () => cx.conf,
          tiktokOAuth: () => ({ lerToken: () => ({ access_token: 'x' }), chamar: async (caminho, q, opc, conta) => {
            o.tkIdas.push([caminho, q.ids, opc.metodo, conta]);
            if (cx.aoTk) cx.aoTk();
            if (cx.tkEstoura) throw new Error('tiktok caiu');
            if (cx.tkErro) return { ok: false, http: 500, corpo: { code: 1, message: cx.tkErro } };
            return { ok: true, http: 200, corpo: { code: 0, data: { orders: q.ids.split(',').map((i) => cx.tk[i]).filter(Boolean) } } };
          } }),
          blingGet: async (c) => { o.lidas.push(c); if (cx.aoLer) cx.aoLer(c); if (/^\/pedidos\/vendas\//.test(c)) return cx.pedidoBling ? { ok: true, status: 200, data: { data: cx.pedidoBling } } : { ok: false, status: 404, data: null };
            const r = cx.nfe[c]; if (r === 'ESTOURA') throw new Error('bling fora'); return r ? { ok: true, status: 200, data: { data: r } } : { ok: false, status: 429, data: null }; },
          blingWrite: async (m, c, corpo, opc) => { if (cx.antesDoEnvio) cx.antesDoEnvio(); if (opc && opc.antesDeEscrever && !opc.antesDeEscrever()) return { ok: false, status: 0, data: null, recusado: true }; o.escritas.push([m, c, corpo, opc && { semRetryDeRede: opc.semRetryDeRede }]); const r = cx.escreve(); if (r === 'ESTOURA') throw new Error('rede'); return r; },
          garantirSitCancel: async (bg) => { o.sit.push(typeof bg); if (cx.aoSit) cx.aoSit(); if (cx.sitCancel === 'ESTOURA') throw new Error('x'); return cx.sitCancel; } }, op.extra || {}));
        cx.pedir = async (qs, cookie, extraHdr, metodo) => { const mt = metodo || (/resolver=/.test(qs || '') ? 'POST' : 'GET'); const u = new URL('http://x' + pref + '/cancelados-tratar' + (qs || '')); const res = {}; const tt = await rota({ method: mt, headers: Object.assign({ cookie: cookie === undefined ? 'adm' : cookie, host: 'x' }, extraHdr || {}) }, res, u, mt, u.pathname); return Object.assign(res._o || {}, { _s: res._s, _t: tt }); };
        cx.tratados = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, T.ARQ), 'utf8')); } catch (e) { return null; } };
        return cx;
      };
      assert.strictEqual(T.atende(pref, 'POST', pref + '/cancelados-tratar'), true); assert.strictEqual(T.atende(pref, 'PUT', pref + '/cancelados-tratar'), false); assert.strictEqual(T.atende(pref, 'GET', pref + '/cancelados-trata'), false);
      assert.strictEqual(T.caminhoDe(pref), pref + '/cancelados-tratar');

      /* ═══ A. a lista ═══ */
      const a = cena();
      for (const [qs, ck] of [['', null], ['?k=errada', null], ['', 'est'], ['?resolver=10&como=devolvida&confirma=sim', 'est'], ['?preparar=11', null]]) {
        const r = await a.pedir(qs, ck); assert.deepStrictEqual([r._s, r.error, a.o.tkIdas.length, a.o.lidas.length, a.o.escritas.length], [404, 'not found', 0, 0, 0], emp + ': só admin — ' + qs);
      }
      const l1 = await a.pedir();
      assert.deepStrictEqual([l1._s, l1.ok, l1.total, l1.empresa, l1.erro], [200, true, 4, emp, undefined]);
      assert.deepStrictEqual(l1.pendentes, [
        { pedido_id: '10', numero: 1010, numero_loja: 'T10', marketplace: 'tiktok', nf_numero: '131074', nfe_id: '9010', horas_desde_a_emissao: 6, acao: 'cancelar' },
        { pedido_id: '11', numero: 1011, numero_loja: 'T11', marketplace: 'tiktok', nf_numero: '131000', nfe_id: '9011', horas_desde_a_emissao: 30, acao: 'devolucao' },
        { pedido_id: '12', numero: 1012, numero_loja: 'T12', marketplace: 'tiktok', nf_numero: null, nfe_id: null, horas_desde_a_emissao: null, acao: 'sem_nf' },
        { pedido_id: '13', numero: 1013, numero_loja: 'T13', marketplace: 'tiktok', nf_numero: '131013', nfe_id: '9013', horas_desde_a_emissao: null, acao: null },
      ], emp + ': só fila sem conferência + cancelado sem envio (o postado, o ativo, o conferido, o de outro marketplace, o sem número e o que o TikTok não devolveu ficam de fora)');
      assert.ok(!/FULANO|BELTRANO|cliente/.test(JSON.stringify(l1)), emp + ': a lista não leva dado de gente');
      assert.deepStrictEqual([a.o.tkIdas, a.o.lidas.length, a.o.escritas.length, a.tratados()], [[['/order/202309/orders', 'T10,T11,T12,T13,T14,T15,T19', 'GET', 'conta-' + emp]], 0, 0, null],
        emp + ': uma consulta ao TikTok com a conta da empresa; a lista não vai ao Bling nem grava nada');
      assert.strictEqual((await a.pedir('?k=chave-canc', null)).total, 4, emp + ': pela chave também');
      /* a fronteira das 24 h: 23h59m59 ainda cancela; 24 h cravadas já é devolução */
      const f = cena({ man: { 10: { numero: 1, marketplace: 'tiktok', numero_loja: 'T10', nf_numero: '1', nf_emissao: '2026-11-25 15:00:01' }, 11: { numero: 2, marketplace: 'tiktok', numero_loja: 'T11', nf_numero: '2', nf_emissao: '2026-11-25 15:00:00' } }, conf: {} });
      assert.deepStrictEqual((await f.pedir()).pendentes.map((x) => [x.pedido_id, x.acao, x.horas_desde_a_emissao]), [['10', 'cancelar', 24], ['11', 'devolucao', 24]]);
      /* nota anexada à mão (o id guardado seria o da nota antiga) ou pasta sem a nota: a lista mostra, sem o id */
      const sn = cena({ snap: { 10: { nf_anexada: true } }, semSnap: ['11'] });
      assert.deepStrictEqual((await sn.pedir()).pendentes.slice(0, 2).map((x) => [x.pedido_id, x.nfe_id, x.acao]), [['10', null, 'cancelar'], ['11', null, 'devolucao']]);
      /* TikTok fora: NÃO é "nenhum pendente" */
      for (const quebra of ['tkErro', 'tkEstoura']) {
        const q = cena(); q[quebra] = quebra === 'tkErro' ? 'limite' : true;
        const r = await q.pedir(); assert.deepStrictEqual([r.ok, r.total, r.pendentes, typeof r.erro], [false, 0, [], 'string'], emp + ': ' + quebra + ' — ' + JSON.stringify(r));
      }
      /* Codex #993 — (1) a escrita só sai se, NA HORA do envio (inclusive nas repetições), o pedido ainda está na fila */
      { const nfC = Object.assign(NFE(), { '/nfe/9010': { id: 9010, numeroPedidoLoja: 'T10', numero: '131074', situacao: 2, dataEmissao: '2026-11-26 09:00:00', loja: { id: 205 } } });
        const w = cena({ nfe: nfC }); w.antesDoEnvio = () => { w.conf[10] = { conferido_em: '2026-11-26T12:00:00Z' }; };
        const r = await w.pedir('?resolver=10&como=cancelada&confirma=sim');
        assert.deepStrictEqual([r.ok, r.etapa, w.o.escritas.length, w.tratados()], [false, 'fora_da_fila', 0, null], emp + ': conferido durante a espera da escrita — não move: ' + JSON.stringify(r)); }
      /* (2) a nota precisa ser DESTE pedido, confirmado no Bling */
      { const nfX = Object.assign(NFE(), { '/nfe/9011': { id: 9011, numeroPedidoLoja: 'T99', numero: '131000', situacao: 5, dataEmissao: '2026-11-25 09:00:00', loja: { id: 205 } } });
        const x = cena({ nfe: nfX });
        const r1 = await x.pedir('?preparar=11'); assert.deepStrictEqual([r1.ok, r1.etapa], [false, 'nota_de_outro_pedido'], emp + ': nota de outra venda — não prepara devolução');
        const nfY = Object.assign(NFE(), { '/nfe/9011': { id: 9011, numero: '131000', situacao: 5, dataEmissao: '2026-11-25 09:00:00', loja: { id: 205 } } });
        const y = cena({ nfe: nfY });
        let r2 = await y.pedir('?preparar=11'); assert.deepStrictEqual([r2.ok, r2.etapa], [false, 'sem_vinculo'], emp + ': sem prova do vínculo — não prepara');
        y.pedidoBling = { notaFiscal: { id: 9999 } }; r2 = await y.pedir('?preparar=11'); assert.strictEqual(r2.etapa, 'sem_vinculo', emp + ': o pedido aponta pra outra nota');
        y.pedidoBling = { notaFiscal: { id: 9011 } }; r2 = await y.pedir('?preparar=11'); assert.deepStrictEqual([r2.ok, r2.nfe_id], [true, '9011'], emp + ': o pedido aponta pra esta nota — prepara');
        assert.strictEqual(x.o.escritas.length + y.o.escritas.length, 0); }
      /* (3) resolver grava: GET/outro site com o cookie é recusado; POST do próprio site passa; a chave passa */
      { const g = cena({ nfe: Object.assign(NFE(), { '/nfe/9010': { id: 9010, numeroPedidoLoja: 'T10', numero: '131074', situacao: 2, dataEmissao: '2026-11-26 09:00:00', loja: { id: 205 } } }) });
        const qs = '?resolver=10&como=cancelada&confirma=sim';
        for (const [hd, mt] of [[{}, 'GET'], [{ 'sec-fetch-site': 'cross-site' }, 'POST'], [{ origin: 'http://outro.com' }, 'POST']]) {
          const r = await g.pedir(qs, 'adm', hd, mt); assert.deepStrictEqual([r._s, r.ok, g.o.escritas.length, g.o.tkIdas.length], [403, false, 0, 0], emp + ': CSRF ' + mt + ' ' + JSON.stringify(hd)); }
        const ok = await g.pedir(qs, 'adm', { origin: 'http://x', 'sec-fetch-site': 'same-origin' }); assert.deepStrictEqual([ok._s, ok.ok, g.o.escritas.length], [200, true, 1], emp + ': POST do próprio site passa'); }
      /* sem ninguém do TikTok na fila: nem consulta */
      const v = cena({ man: { 17: MAN()[17], 16: MAN()[16] } });
      assert.deepStrictEqual([(await v.pedir()).pendentes, v.o.tkIdas.length], [[], 0]);
      /* registro ilegível / sem pasta: diz, não inventa */
      const rq = cena(); fs.writeFileSync(path.join(rq.dir, T.ARQ), '{ quebrado');
      for (const qs of ['', '?preparar=11', '?resolver=10&como=cancelada&confirma=sim']) { const r = await rq.pedir(qs); assert.deepStrictEqual([r.ok, r.etapa, r.pendentes, rq.o.escritas.length], [false, 'registro', undefined, 0], emp + ': registro ilegível — ' + qs); }
      fs.writeFileSync(path.join(rq.dir, T.ARQ), '[1,2]'); assert.strictEqual((await rq.pedir()).total, 4, emp + ': registro que não é objeto vale como vazio');
      const sp = cena({ extra: { cacheDir: undefined } }); assert.strictEqual((await sp.pedir()).etapa, 'sem_peca');

      /* ═══ B. preparar a devolução ═══ */
      const b = cena();
      for (const qs of ['?preparar=abc', '?preparar=1%2011']) { const r = await b.pedir(qs); assert.ok(r._s === 400 && /use \?preparar=/.test(r.erro), emp + ': ' + qs); }
      const okP = await b.pedir('?preparar=11');
      assert.deepStrictEqual([okP._s, okP.ok, okP.pedido_id, okP.nfe_id, okP.numero, okP.id_loja, okP.empresa], [200, true, '11', '9011', '131000', '205', emp], emp + ': ' + JSON.stringify(okP));
      /* 27/11: os ids fiscais da empresa vão junto quando ESTE serviço os tem (as variáveis DELA, com o nome do Devoluções) — e só então */
      assert.ok(!('ids_fiscais' in okP), emp + ': sem as variáveis, o preparar não inventa ids');
      {
        const PF = { girassol: 'GIRASSOL_', amb: 'AMB_', good: 'GOOD_' }[emp], OUTRA = { girassol: 'AMB_', amb: 'GOOD_', good: 'GIRASSOL_' }[emp];
        const nomes = [PF + 'ID_EMPRESA_CONTROL', PF + 'ID_NATUREZA_DEVOLUCAO_ENTRADA', OUTRA + 'ID_EMPRESA_CONTROL', OUTRA + 'ID_NATUREZA_DEVOLUCAO_ENTRADA'];
        const guard = nomes.map((k) => process.env[k]);
        try {
          for (const k of nomes) delete process.env[k];
          process.env[OUTRA + 'ID_EMPRESA_CONTROL'] = '99998888'; process.env[OUTRA + 'ID_NATUREZA_DEVOLUCAO_ENTRADA'] = '77776666';
          assert.ok(!('ids_fiscais' in (await cena().pedir('?preparar=11'))), emp + ': as variáveis de OUTRA empresa não servem');
          process.env[PF + 'ID_EMPRESA_CONTROL'] = '11112222';
          assert.ok(!('ids_fiscais' in (await cena().pedir('?preparar=11'))), emp + ': só o id da empresa, sem a natureza, não vai');
          process.env[PF + 'ID_NATUREZA_DEVOLUCAO_ENTRADA'] = '33334444';
          const comIds = await cena().pedir('?preparar=11');
          assert.deepStrictEqual([comIds.ok, comIds.ids_fiscais, comIds.nfe_id], [true, { idNaturezaOperacao: '33334444', idEmpresaControl: '11112222' }, '9011'], emp + ': ' + JSON.stringify(comIds));
        } finally { nomes.forEach((k, i) => { if (guard[i] === undefined) delete process.env[k]; else process.env[k] = guard[i]; }); }
      }
      assert.deepStrictEqual([b.o.tkIdas, b.o.lidas, b.o.escritas.length, b.tratados()], [[['/order/202309/orders', 'T11', 'GET', 'conta-' + emp]], ['/nfe/9011'], 0, null], emp + ': preparar confere o TikTok NA HORA, lê a nota uma vez e não escreve nada');
      /* cada ponta que não fecha: nada é preparado, e o Bling nem é lido */
      for (const [id, etapa] of [['14', 'postado'], ['15', 'ativo'], ['16', 'fora_da_fila'], ['17', 'fora_da_fila'], ['999', 'fora_da_fila'], ['18', 'sem_numero'], ['19', 'nao_sei']]) {
        b.o.lidas.length = 0; const r = await b.pedir('?preparar=' + id);
        assert.deepStrictEqual([r.ok, r.etapa, r.nfe_id, b.o.lidas.length, typeof r.erro], [false, etapa, undefined, 0, 'string'], emp + ': preparar ' + id + ' → ' + JSON.stringify(r));
      }
      /* o pedido estava na lista e DEIXOU de fechar as pontas (foi coletado, foi conferido, o TikTok caiu) */
      const b2 = cena(); b2.tk.T11 = CANC('T11', { line_items: [{ display_status: 'IN_TRANSIT' }] });
      assert.strictEqual((await b2.pedir('?preparar=11')).etapa, 'postado', emp + ': coletado entre a lista e o clique');
      b2.tk.T11 = CANC('T11'); b2.conf[11] = { conferido_em: 'x' };
      assert.strictEqual((await b2.pedir('?preparar=11')).etapa, 'fora_da_fila', emp + ': conferido entre a lista e o clique');
      delete b2.conf[11]; b2.tkErro = 'fora';
      { const rr = await b2.pedir('?preparar=11'); assert.deepStrictEqual([rr.etapa, b2.o.lidas.length, /^TikTok não respondeu: fora — não sei se segue cancelado/.test(rr.erro)], ['nao_sei', 0, true], emp + ': diz o que o TikTok respondeu: ' + rr.erro); }
      b2.tkErro = null; b2.tkEstoura = true; assert.strictEqual((await b2.pedir('?preparar=11')).etapa, 'nao_sei'); b2.tkEstoura = false;
      b2.tk.T11 = { id: 'T11' }; assert.strictEqual((await b2.pedir('?preparar=11')).etapa, 'nao_sei', emp + ': pedido sem status não é veredito');
      /* a nota */
      const b3 = cena();
      assert.deepStrictEqual([(await b3.pedir('?preparar=10')).etapa, (await b3.pedir('?preparar=12')).etapa, (await b3.pedir('?preparar=13')).etapa], ['ainda_cancela', 'sem_nf', 'sem_data'], emp + ': menos de 24 h cancela; sem nota; sem data');
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { situacao: 2 }); assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'cancelada');
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { numero: '999' }); assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'nota_diferente', emp + ': outro número');
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { id: 1 }); assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'nota_diferente', emp + ': outro id');
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { numero: null }); assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'nota_diferente', emp + ': nota sem número não se confere');
      delete b3.nfe['/nfe/9011']; assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'bling');
      b3.nfe['/nfe/9011'] = 'ESTOURA'; assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'bling');
      /* a data que vale é a do BLING: o checkout diz 30 h, o Bling diz 2 h → ainda cancela; e loja torta vira null */
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { dataEmissao: '2026-11-26 13:00:00' }); assert.strictEqual((await b3.pedir('?preparar=11')).etapa, 'ainda_cancela');
      b3.nfe['/nfe/9011'] = Object.assign({}, NFE()['/nfe/9011'], { dataEmissao: null, dataOperacao: '2026-11-24 13:00:00', loja: { id: 'x' } });
      assert.deepStrictEqual([(await b3.pedir('?preparar=11')).ok, (await b3.pedir('?preparar=11')).id_loja], [true, null]);
      const b4 = cena({ semSnap: ['11'] }); assert.deepStrictEqual([(await b4.pedir('?preparar=11')).etapa, b4.o.lidas.length], ['sem_nf', 0], emp + ': sem o id da nota não vou ao Bling');

      /* ═══ C. resolver: move o pedido pra Cancelado ═══ */
      const c = cena();
      for (const qs of ['?resolver=abc&como=devolvida&confirma=sim', '?resolver=11&como=sumiu&confirma=sim', '?resolver=11&confirma=sim', '?resolver=11&como=&confirma=sim']) { const r = await c.pedir(qs); assert.ok(r._s === 400 && /use \?resolver=/.test(r.erro), emp + ': ' + qs); }
      const semConf = await c.pedir('?resolver=11&como=devolvida');
      assert.deepStrictEqual([semConf.ok, semConf.etapa, c.o.tkIdas.length, c.o.escritas.length], [false, 'confirmacao', 0, 0]);
      /* as pontas, de novo */
      for (const [id, etapa] of [['14', 'postado'], ['15', 'ativo'], ['16', 'fora_da_fila'], ['17', 'fora_da_fila'], ['18', 'sem_numero'], ['19', 'nao_sei'], ['12', 'sem_nf']]) {
        for (const como of ['devolvida', 'cancelada']) { const r = await c.pedir('?resolver=' + id + '&como=' + como + '&confirma=sim'); assert.deepStrictEqual([r.ok, r.etapa, c.o.escritas.length, c.tratados()], [false, etapa, 0, null], emp + ': resolver ' + id + '/' + como + ' → ' + JSON.stringify(r)); }
      }
      /* "já cancelei" com a nota AINDA valendo: não move */
      c.o.lidas.length = 0;
      const nc = await c.pedir('?resolver=10&como=cancelada&confirma=sim');
      assert.deepStrictEqual([nc.ok, nc.etapa, /131074 ainda NÃO aparece cancelada/.test(nc.erro), c.o.lidas, c.o.escritas.length, c.tratados()], [false, 'nao_cancelada', true, ['/nfe/9010'], 0, null], emp + ': ' + JSON.stringify(nc));
      for (const [troca, etapa] of [[undefined, 'bling'], ['ESTOURA', 'bling'], [Object.assign({}, NFE()['/nfe/9010'], { numero: '5' }), 'nota_diferente'], [Object.assign({}, NFE()['/nfe/9010'], { situacao: { valor: 5 } }), 'nao_cancelada'], [Object.assign({}, NFE()['/nfe/9010'], { situacao: null }), 'nao_cancelada']]) {
        if (troca === undefined) delete c.nfe['/nfe/9010']; else c.nfe['/nfe/9010'] = troca;
        const r = await c.pedir('?resolver=10&como=cancelada&confirma=sim'); assert.deepStrictEqual([r.etapa, c.o.escritas.length], [etapa, 0], emp + ': cancelada com a nota ' + JSON.stringify(troca));
      }
      /* cancelada de verdade (situação 2, nos dois formatos): move pra "Cancelado" — o que se chama só "Cancelado", não o primeiro */
      c.nfe['/nfe/9010'] = Object.assign({}, NFE()['/nfe/9010'], { situacao: { valor: 2 } });
      c.o.lidas.length = 0; c.o.tkIdas.length = 0;
      const okC = await c.pedir('?resolver=10&como=CANCELADA&confirma=SIM&devolucao_id=77&devolucao_numero=88');
      assert.deepStrictEqual([okC.ok, okC.resolvido, okC.empresa], [true, { pedido_id: '10', numero: 1010, nf_numero: '131074', como: 'cancelada', movido_pra_cancelado: true, devolucao_numero: null, anotado: true }, emp], emp + ': ' + JSON.stringify(okC));
      assert.deepStrictEqual([c.o.tkIdas.map((x) => x[1]), c.o.lidas, c.o.escritas, c.o.sit], [['T10'], ['/nfe/9010'], [['PATCH', '/pedidos/vendas/10/situacoes/12', null, { semRetryDeRede: true }]], ['function']], emp + ': confere o TikTok, confere a nota, UMA escrita sem repetição de rede');
      assert.deepStrictEqual(c.tratados(), { 10: { em: new Date(AGORA).toISOString(), como: 'cancelada', por: 'admin', numero: 1010, numero_loja: 'T10', nf_numero: '131074' } }, emp + ': o registro — sem dado de gente; devolução só se anota na devolvida');
      /* tratado: sai da lista e não é tratado (nem preparado) de novo */
      c.o.escritas.length = 0;
      assert.deepStrictEqual([(await c.pedir()).pendentes.map((x) => x.pedido_id), (await c.pedir('?resolver=10&como=cancelada&confirma=sim')).etapa, (await c.pedir('?preparar=10')).etapa, c.o.escritas.length], [['11', '12', '13'], 'ja_tratado', 'ja_tratado', 0]);
      /* devolvida: vale a palavra de quem gerou (não lê a nota), com o id e o número da devolução anotados quando vêm certos */
      c.o.lidas.length = 0;
      const okD = await c.pedir('?resolver=11&como=devolvida&confirma=sim&devolucao_id=5550001&devolucao_numero=131200');
      assert.deepStrictEqual([okD.ok, okD.resolvido.como, okD.resolvido.devolucao_numero, c.o.lidas.length, c.o.escritas[0][1]], [true, 'devolvida', '131200', 0, '/pedidos/vendas/11/situacoes/12']);
      assert.deepStrictEqual([c.tratados()[11].devolucao_id, c.tratados()[11].devolucao_numero, Object.keys(c.tratados())], ['5550001', '131200', ['10', '11']]);
      const d2 = cena(); await d2.pedir('?resolver=11&como=devolvida&confirma=sim&devolucao_id=abc&devolucao_numero=1%3Cb%3E');
      assert.deepStrictEqual([d2.tratados()[11].devolucao_id, d2.tratados()[11].devolucao_numero], [undefined, undefined], emp + ': id/número tortos não são anotados');

      /* Codex #992: o galpão FINALIZA o pedido (ou ele sai da fila) enquanto se espera o TikTok, o Bling ou a situação —
         nada é preparado, nada é movido, nada é anotado */
      for (const [quando, rota, lidasEsperadas] of [['aoTk', '?preparar=11', 0], ['aoLer', '?preparar=11', 1], ['aoTk', '?resolver=11&como=devolvida&confirma=sim', 0], ['aoSit', '?resolver=11&como=devolvida&confirma=sim', 0],
        ['aoTk', '?resolver=10&como=cancelada&confirma=sim', 0], ['aoLer', '?resolver=10&como=cancelada&confirma=sim', 1], ['aoSit', '?resolver=10&como=cancelada&confirma=sim', 1]]) {
        for (const sai of ['conferido', 'sumiu']) {
          const k = cena(); k.nfe['/nfe/9010'] = Object.assign({}, NFE()['/nfe/9010'], { situacao: 2 });
          const id = /=10&/.test(rota) ? '10' : '11';
          k[quando] = () => { if (sai === 'conferido') k.conf[id] = { conferido_em: 'agora' }; else delete k.man[id]; };
          const rr = await k.pedir(rota);
          assert.deepStrictEqual([rr.ok, rr.etapa, /foi conferido ou saiu da fila do galpão enquanto eu conferia/.test(rr.erro), rr.nfe_id, k.o.escritas.length, k.tratados(), k.o.lidas.length], [false, 'fora_da_fila', true, undefined, 0, null, lidasEsperadas],
            emp + ': ' + sai + ' durante ' + quando + ' em ' + rota + ' → ' + JSON.stringify(rr));
        }
      }
      /* e sem ninguém mexer no meio, os mesmos ganchos não atrapalham */
      { const k = cena(); let n3 = 0; k.aoTk = k.aoLer = k.aoSit = () => { n3++; }; const rr = await k.pedir('?resolver=11&como=devolvida&confirma=sim'); assert.deepStrictEqual([rr.ok, n3, k.o.escritas.length], [true, 2, 1]); }

      /* mover: as saídas */
      const m = cena();
      const tentar = async () => m.pedir('?resolver=11&como=devolvida&confirma=sim');
      m.escreve = () => ({ ok: false, status: 400, data: null });
      let r = await tentar();
      assert.deepStrictEqual([r.ok, r.etapa, /não moveu o pedido pra Cancelado \(resposta 400\)/.test(r.erro), m.o.lidas, m.tratados(), (await m.pedir()).total], [false, 'mover', true, ['/pedidos/vendas/11'], null, 4], emp + ': o Bling recusou e o pedido NÃO está cancelado → fica na lista: ' + JSON.stringify(r));
      for (const resp of [() => 'ESTOURA', () => null, () => ({ ok: false, status: 0, data: null, ambiguo: true })]) { m.escreve = resp; r = await tentar(); assert.deepStrictEqual([r.etapa, /sem resposta/.test(r.erro), m.tratados()], ['mover', true, null], emp + ': escrita que se perdeu'); }
      /* o Bling recusou porque o pedido JÁ está numa situação de cancelamento (qualquer uma delas): vale como movido */
      m.pedidoBling = { id: 11, situacao: { id: 9 } }; assert.strictEqual((await tentar()).etapa, 'mover', emp + ': situação que não é de cancelamento não vale');
      m.pedidoBling = { id: 11, situacao: { id: 15 } }; r = await tentar();
      assert.deepStrictEqual([r.ok, r.resolvido.movido_pra_cancelado, Object.keys(m.tratados())], [true, true, ['11']], emp + ': já estava cancelado no Bling');
      /* a situação de cancelamento */
      const s1 = cena(); s1.sitCancel = { ids: [15, 31], nomes: ['Cancelado pelo marketplace', 'Cancelamento manual'] };
      await s1.pedir('?resolver=11&como=devolvida&confirma=sim'); assert.strictEqual(s1.o.escritas[0][1], '/pedidos/vendas/11/situacoes/15', emp + ': sem uma que se chame só "Cancelado", vai a primeira');
      const s2 = cena(); s2.sitCancel = { ids: [15, 12], nomes: ['(definido em ENV)', 'Cancelado', 'outra'] };
      await s2.pedir('?resolver=11&como=devolvida&confirma=sim'); assert.strictEqual(s2.o.escritas[0][1], '/pedidos/vendas/11/situacoes/15', emp + ': nomes que não casam com os ids não escolhem nada');
      for (const sc of [{ ids: [], nomes: [] }, null, 'ESTOURA', { ids: ['x', 0, -1] }]) { const s3 = cena(); s3.sitCancel = sc; r = await s3.pedir('?resolver=11&como=devolvida&confirma=sim'); assert.deepStrictEqual([r.etapa, /não achei a situação "Cancelado"/.test(r.erro), s3.o.escritas.length, s3.tratados()], ['mover', true, 0, null], emp + ': sem situação — ' + JSON.stringify(sc)); }
      const sw = cena({ extra: { blingWrite: undefined } }); r = await sw.pedir('?resolver=11&como=devolvida&confirma=sim');
      assert.deepStrictEqual([r.etapa, /escrita no Bling/.test(r.erro), sw.tratados()], ['mover', true, null]);
      /* o registro guarda 120 dias */
      const g = cena(); fs.writeFileSync(path.join(g.dir, T.ARQ), JSON.stringify({ 1: { em: new Date(AGORA - 121 * 864e5).toISOString() }, 2: { em: new Date(AGORA - 119 * 864e5).toISOString() }, 3: { em: 'torto' }, 4: null }));
      await g.pedir('?resolver=11&como=devolvida&confirma=sim'); assert.deepStrictEqual(Object.keys(g.tratados()), ['2', '11']);
      /* o registro não gravou (pasta sumiu): o pedido JÁ foi movido — responde ok e avisa */
      const ng = cena(); const _ws = fs.writeFileSync; fs.writeFileSync = (arq, ...resto) => { if (String(arq).endsWith(T.ARQ + '.tmp')) throw new Error('disco'); return _ws(arq, ...resto); };
      try { r = await ng.pedir('?resolver=11&como=devolvida&confirma=sim'); } finally { fs.writeFileSync = _ws; }
      assert.deepStrictEqual([r.ok, r.resolvido.anotado, r.resolvido.movido_pra_cancelado, ng.o.escritas.length], [true, false, true, 1]);

      /* ═══ Codex #993 (P1): com o blingWrite DE VERDADE (lib/checkout/base-funcoes) — o 1º PATCH leva 429, o galpão finaliza o
         pedido durante a espera, e a 2ª tentativa NÃO sai ═══ */
      {
        const idas2 = []; const _gf = global.fetch;
        for (const finalizaNaEspera of [true, false]) {
          idas2.length = 0;
          const w = cena();
          const B = require('../lib/checkout/base-funcoes').criar({ tag: 'T', envOperadores: 'X_OP', envAdmin: 'X_AD', BLING_BASE: 'https://bling.teste/v3', garantirToken: async () => 'tok', PAUSA_MS: 0,
            MANIFEST_FILE: path.join(w.dir, 'm.json'), SKU_EAN_FILE: path.join(w.dir, 's.json'), LOC_FILE: path.join(w.dir, 'l.json'), EAN_INDEX_FILE: path.join(w.dir, 'e.json'), RESERVAS_FILE: path.join(w.dir, 'r.json'), RESERVA_TTL_MS: 1,
            sleep: async () => { if (finalizaNaEspera) w.conf[11] = { conferido_em: 'durante a espera do 429' }; } });
          const rotaW = T.criar({ empresa: emp, prefixo: pref, cacheDir: w.dir, agora: () => AGORA, tiktokConta: 'c', json: (res, st, ob) => { res._s = st; res._o = ob; }, lerChaveAdmin: () => '', validarSessao: () => ({ admin: true }), ehAdmin: () => true,
            manifest: () => w.man, lerConferidos: () => w.conf, tiktokOAuth: () => ({ lerToken: () => ({}), chamar: async (c0, q) => ({ ok: true, http: 200, corpo: { code: 0, data: { orders: q.ids.split(',').map((i) => w.tk[i]).filter(Boolean) } } }) }),
            blingGet: async () => ({ ok: false, status: 404, data: null }), blingWrite: B.blingWrite, garantirSitCancel: async () => ({ ids: [12], nomes: ['Cancelado'] }) });
          global.fetch = async (u, op) => { idas2.push([op.method, String(u)]); const st = idas2.length === 1 ? 429 : 204; return { ok: st === 204, status: st, headers: { get: () => null }, text: async () => '' }; };
          let rr; const u = new URL('http://x' + pref + '/cancelados-tratar?resolver=11&como=devolvida&confirma=sim'); const res = {};
          try { await rotaW({ method: 'POST', headers: { cookie: 'adm', host: 'x' } }, res, u, 'POST', u.pathname); rr = res._o; } finally { global.fetch = _gf; }
          const PATCH = ['PATCH', 'https://bling.teste/v3/pedidos/vendas/11/situacoes/12'];
          if (finalizaNaEspera) assert.deepStrictEqual([rr.ok, rr.etapa, idas2, w.tratados()], [false, 'fora_da_fila', [PATCH], null], emp + ': finalizado durante a espera do 429 — a 2ª tentativa não pode sair: ' + JSON.stringify([rr, idas2]));
          else assert.deepStrictEqual([rr.ok, rr.resolvido && rr.resolvido.movido_pra_cancelado, idas2], [true, true, [PATCH, PATCH]], emp + ': sem ninguém mexer, o 429 é repetido e o pedido é movido: ' + JSON.stringify([rr, idas2]));
        }
      }

      /* ═══ D. pelo routes REAL da empresa ═══ */
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      fs.writeFileSync(path.join(PASTAS, emp, T.ARQ), '{ quebrado');   /* o registro DESTA empresa: se a rota real lê a pasta certa, responde "registro" — e não chama ninguém */
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs) => { const u = new URL('http://x' + pref + '/cancelados-tratar' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(bb) { this._b = String(bb || ''); } }; await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [res._s, res._b]; };
      idas.length = 0;
      const semK = await real('');
      assert.ok(semK[0] === 404 || semK[0] === 401 || semK[0] === 302, emp + ': sem credencial o routes real respondeu ' + semK[0]);
      const comK = await real('?k=chave-canc');
      assert.ok(comK[0] === 200 && /"etapa":"registro"/.test(comK[1]) && new RegExp('"empresa":"' + emp + '"').test(comK[1]) && !/sem_peca/.test(comK[1]), emp + ': o routes real não leu o registro desta empresa: ' + comK[0] + ' ' + comK[1].slice(0, 200));
      fs.writeFileSync(path.join(PASTAS, emp, T.ARQ), '{}');
      const vazia = await real('?k=chave-canc');
      assert.ok(vazia[0] === 200 && /"ok":true,"total":0,"pendentes":\[\]/.test(vazia[1]), emp + ': fila vazia no routes real: ' + vazia[1].slice(0, 200));
      assert.strictEqual(idas.length, 0, emp + ': sem ninguém do TikTok na fila, ninguém é chamado');
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — cancelado antes da postagem, tratar: lista só o não postado (fila sem conferência + cancelado sem envio), com cancelar até 24 h / devolução depois; preparar e resolver conferem as duas pontas na hora; "já cancelei" só com a nota cancelada no Bling; o pedido vai pra Cancelado e sai da lista; só admin; nas três empresas');
})().catch((e) => { console.error(e); process.exit(1); });
