'use strict';
/* 27/11 — PEDIDO QUE O BLING JÁ CANCELOU COM A NOTA VALENDO: TRATAR (lib/checkout/rota-cancelados-bling, ?preparar e ?resolver).
   O dono: "se nao der cancelar 24h da emissao, gera a nf devolução".

   O que se prova (o código de produção, com a vigia DE VERDADE por baixo):
   A. preparar: devolve o que a Toolbox precisa SÓ com tudo conferido na hora — pedido no aviso e ainda cancelado no Bling,
      não bipado, a nota é a do pedido e segue autorizada, passou das 24 h;
   B. "não foi enviado" é do marketplace: no TikTok quem diz é o TikTok (enviado = Devoluções; ativo e "não sei" = não trato);
      onde não há leitor, só com &conferi=sim do admin;
   C. resolver: "cancelada" só com a nota cancelada no Bling; "devolvida" repete as conferências; anota no registro comum
      e o pedido sai do aviso na hora; nada é escrito no Bling;
   D. quem grava exige admin, e com sessão exige POST + mesma origem;
   E. pelo routes REAL das três empresas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'canc-bling-tratar-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const nfetch = require.resolve('node-fetch');
const idas = [];
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (u) => { idas.push(String(u)); throw new Error('rede bloqueada no teste: ' + u); } };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-cbt';
for (const k of ['GIRASSOL', 'GOOD', 'AMB']) { delete process.env[k + '_ID_EMPRESA_CONTROL']; delete process.env[k + '_ID_NATUREZA_DEVOLUCAO_ENTRADA']; }
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
const CE = require('../lib/checkout/config-empresa');
const R = require('../lib/checkout/rota-cancelados-bling');
const V = require('../lib/checkout/cancelados-bling-vigia');
const T = require('../lib/checkout/rota-cancelados-tratar');

let _chegouAoFim = false;
process.on('exit', (cod) => { if (!_chegouAoFim && cod === 0) { console.error('FALHOU: o teste parou no meio'); process.exitCode = 1; } });

const AGORA = Date.parse('2026-11-27T20:00:00-03:00');
const AGORA_ISO = new Date(AGORA).toISOString();
/* 601 = ML, nota há 30 h · 602 = TikTok, nota há 7 dias · 603 = ML, nota há 6 h · 604 = Shopee · 605 = já resolvido (nota cancelada)
   606 = nota em outra situação · 607 = marcado tratado no registro da vigia */
const REG = () => ({ rodou_em: AGORA_ISO, dias: 3, pedidos: {
  601: { numero: 9601, numero_loja: 'ML601', loja_id: '201', data: '2026-11-26', marketplace: 'ml', estado: 'nf_valendo', nf_id: '7601', nf_numero: '131601', nf_emissao: '2026-11-26 14:00:00', nf_situacao: 5, visto_em: AGORA_ISO },
  602: { numero: 9602, numero_loja: 'TK602', loja_id: '202', data: '2026-11-20', marketplace: 'tiktok', estado: 'nf_valendo', nf_id: '7602', nf_numero: '131602', nf_emissao: '2026-11-20 10:00:00', nf_situacao: 6, visto_em: AGORA_ISO },
  603: { numero: 9603, numero_loja: 'ML603', loja_id: '201', data: '2026-11-27', marketplace: 'ml', estado: 'nf_valendo', nf_id: '7603', nf_numero: '131603', nf_emissao: '2026-11-27 14:00:00', nf_situacao: 5, visto_em: AGORA_ISO },
  604: { numero: 9604, numero_loja: 'SH604', loja_id: '203', data: '2026-11-20', marketplace: 'shopee', estado: 'nf_valendo', nf_id: '7604', nf_numero: '131604', nf_emissao: '2026-11-20 10:00:00', nf_situacao: 5, visto_em: AGORA_ISO },
  605: { numero: 9605, numero_loja: 'ML605', data: '2026-11-20', marketplace: 'ml', estado: 'nf_cancelada', nf_id: '7605', visto_em: AGORA_ISO },
  606: { numero: 9606, numero_loja: 'ML606', data: '2026-11-20', marketplace: 'ml', estado: 'nf_outra', nf_id: '7606', nf_situacao: 4, visto_em: AGORA_ISO },
  607: { numero: 9607, numero_loja: 'ML607', data: '2026-11-20', marketplace: 'ml', estado: 'nf_valendo', nf_id: '7607', nf_numero: '131607', nf_emissao: '2026-11-20 10:00:00', tratado: { em: 'x' }, visto_em: AGORA_ISO } } });
const PED = (id, extra) => Object.assign({ id, numero: 9000 + id, numeroLoja: REG().pedidos[id].numero_loja, situacao: { id: 12 }, notaFiscal: { id: 7000 + id }, contato: { nome: 'FULANO DE TAL', numeroDocumento: '11122233344' } }, extra || {});
const NF = (id, extra) => Object.assign({ id: 7000 + id, numero: '0' + (131000 + id), situacao: 5, dataEmissao: REG().pedidos[id].nf_emissao, numeroPedidoLoja: REG().pedidos[id].numero_loja, loja: { id: 201 }, contato: { nome: 'FULANO DE TAL' } }, extra || {});
const TKCANC = (id, extra) => Object.assign({ id, status: 'CANCELLED', rts_time: 1, tracking_number: 'R' + id, line_items: [{ display_status: 'CANCELLED', package_status: 'CANCELLED' }] }, extra || {});

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    const pref = '/emp';
    const cena = (op) => {
      op = op || {};
      const dir = pasta(); let t = op.agora || AGORA;
      fs.writeFileSync(path.join(dir, V.ARQ), JSON.stringify(op.reg || REG()));
      const cx = { dir, lidas: [], tkIdas: [], conf: op.conf || {}, sit: { ids: [15, 12], nomes: ['Cancelado pelo marketplace', 'Cancelado'] },
        ped: { 601: PED(601), 602: PED(602), 603: PED(603), 604: PED(604), 607: PED(607) }, nfe: { 7601: NF(601), 7602: NF(602, { situacao: { valor: 6 } }), 7603: NF(603), 7604: NF(604), 7607: NF(607) },
        tk: { TK602: TKCANC('TK602') }, tkErro: null, passa: (ms) => { t += ms; } };
      const blingGet = async (c) => { cx.lidas.push(c); if (cx.aoLer) cx.aoLer(c); const mp = /^\/pedidos\/vendas\/(\d+)$/.exec(c), mn = /^\/nfe\/(\d+)$/.exec(c); const d = mp ? cx.ped[mp[1]] : (mn ? cx.nfe[mn[1]] : undefined);
        if (d === 'ESTOURA') throw new Error('bling fora'); return d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: 429, data: null }; };
      const vigia = V.criar({ empresa: 'emp', cacheDir: dir, agora: () => t, blingGet, lerConferidos: () => cx.conf, garantirSitCancel: async () => cx.sit, lerTratados: () => T.idsTratados(dir), lojaMkt: {} });
      const rota = R.criar(Object.assign({ empresa: 'emp', prefixo: pref, vigia, agora: () => t, emFundo: (fn) => fn(),
        json: (res, st, ob) => { res._s = st; res._o = ob; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '',
        validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
        blingGet, cacheDir: dir, lerConferidos: () => cx.conf, tiktokConta: 'conta-emp',
        garantirSitCancel: async (bg) => { assert.strictEqual(typeof bg, 'function'); if (cx.sit === 'ESTOURA') throw new Error('x'); return cx.sit; },
        tiktokOAuth: () => ({ lerToken: () => ({ access_token: 'x' }), chamar: async (caminho, q, opc, conta) => { cx.tkIdas.push([q.ids, conta]); if (cx.aoTk) cx.aoTk();
          if (cx.tkErro) return { ok: false, http: 500, corpo: { code: 1, message: cx.tkErro } };
          return { ok: true, http: 200, corpo: { code: 0, data: { orders: q.ids.split(',').map((i) => cx.tk[i]).filter(Boolean) } } }; } }) }, op.extra || {}));
      cx.pedir = async (qs, cookie, hdr, metodo) => { const mt = metodo || (/resolver=/.test(qs || '') ? 'POST' : 'GET'); const u = new URL('http://x' + pref + '/cancelados-bling' + (qs || '')); const res = {};
        const req = { method: mt, headers: Object.assign({ cookie: cookie === undefined ? 'adm' : cookie, host: 'x' }, hdr || {}) }; await rota(req, res, u, mt, u.pathname); return Object.assign({ _s: res._s }, res._o || {}); };
      cx.tratados = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, T.ARQ), 'utf8')); } catch (e) { return null; } };
      cx.pend = async () => (await cx.pedir('')).pendentes.map((x) => x.pedido_id);
      return cx;
    };
    let c, r;

    /* a lista diz quem confirma o "não foi enviado": o TikTok (lido daqui) ou o admin */
    c = cena(); r = await c.pedir('');
    assert.deepStrictEqual(r.pendentes.map((x) => [x.pedido_id, x.acao, x.confirmacao, x.marketplace_nome]), [['601', 'devolucao', 'admin', 'Mercado Livre'], ['602', 'devolucao', 'tiktok', 'TikTok'], ['603', 'cancelar', 'admin', 'Mercado Livre'], ['604', 'devolucao', 'admin', 'Shopee']]);
    c = cena({ extra: { tiktokConta: null } }); r = await c.pedir(''); assert.strictEqual(r.pendentes[1].confirmacao, 'admin', 'empresa sem conta do TikTok: quem confirma é o admin');
    assert.deepStrictEqual(Object.keys(R.COM_LEITOR), ['tiktok'], 'o ML só entra aqui depois de calibrado com caso real');

    /* ═══ A. preparar ═══ */
    /* TikTok: o TikTok confirma sozinho */
    c = cena(); r = await c.pedir('?preparar=602');
    assert.deepStrictEqual(r, { _s: 200, ok: true, pedido_id: '602', nfe_id: '7602', numero: '0131602', id_loja: '201', confirmacao: 'tiktok', empresa: 'emp', so_leitura: true });
    assert.deepStrictEqual([c.lidas, c.tkIdas], [['/pedidos/vendas/602', '/nfe/7602'], [['TK602', 'conta-emp']]]);
    assert.ok(!/FULANO|11122233344/.test(JSON.stringify(r)), 'sem dado de gente');
    /* com os ids fiscais da empresa no ambiente, vão junto (a Toolbox emite sem login no Devoluções) */
    process.env.GIRASSOL_ID_EMPRESA_CONTROL = '4956030980'; process.env.GIRASSOL_ID_NATUREZA_DEVOLUCAO_ENTRADA = '5776118802';
    c = cena({ extra: { empresa: 'girassol' } }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual(r.ids_fiscais, require('../lib/checkout/ids-fiscais-devolucao').idsFiscaisDevolucao('girassol'));
    assert.ok(r.ids_fiscais && typeof r.ids_fiscais === 'object');
    delete process.env.GIRASSOL_ID_EMPRESA_CONTROL; delete process.env.GIRASSOL_ID_NATUREZA_DEVOLUCAO_ENTRADA;
    /* id torto */
    for (const ruim of ['abc', '1;2', '-5']) { c = cena(); r = await c.pedir('?preparar=' + encodeURIComponent(ruim)); assert.deepStrictEqual([r._s, r.ok, c.lidas.length], [400, false, 0]); }
    /* fora do aviso: desconhecido, nota já cancelada, nota em outra situação, tratado */
    for (const [id, etapa] of [['999', 'fora_da_lista'], ['605', 'fora_da_lista'], ['606', 'fora_da_lista'], ['607', 'ja_tratado']]) { c = cena(); r = await c.pedir('?preparar=' + id + '&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa, c.lidas.length, c.tkIdas.length], [false, etapa, 0, 0], id); }
    c = cena(); fs.writeFileSync(path.join(c.dir, T.ARQ), JSON.stringify({ 602: { em: AGORA_ISO, como: 'devolvida' } })); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.lidas.length], ['ja_tratado', 0]);
    c = cena(); fs.writeFileSync(path.join(c.dir, T.ARQ), '{ quebrado'); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.ok, r.etapa, c.lidas.length], [false, 'registro', 0]);
    c = cena(); fs.writeFileSync(path.join(c.dir, V.ARQ), '{ quebrado'); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.ok, r.etapa, c.lidas.length], [false, 'registro', 0]);
    /* o galpão bipou: é do Devoluções */
    c = cena({ conf: { 602: { conferido_em: 'x' } } }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, /Devoluções/.test(r.erro), c.lidas.length], ['bipado', true, 0]);
    /* sem a situação "Cancelado" */
    for (const sit of [null, { ids: [] }, 'ESTOURA']) { c = cena(); c.sit = sit; r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.lidas.length], ['sem_situacao', 0]); }
    /* o pedido no Bling: não veio; não está mais cancelado; a nota dele mudou ou sumiu */
    c = cena(); delete c.ped[602]; r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, /429/.test(r.erro), c.tkIdas.length], ['bling', true, 0]);
    c = cena(); c.ped[602] = 'ESTOURA'; r = await c.pedir('?preparar=602'); assert.strictEqual(r.etapa, 'bling');
    for (const sitP of [{ id: 9 }, null, {}, { id: '12x' }]) { c = cena(); c.ped[602] = PED(602, { situacao: sitP }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.lidas, c.tkIdas.length], ['nao_cancelado', ['/pedidos/vendas/602'], 0], JSON.stringify(sitP)); }
    c = cena(); c.ped[602] = PED(602, { situacao: { id: 15 } }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.ok, true, 'qualquer das situações de cancelamento serve');
    for (const nfp of [{ id: 7999 }, null, {}, { id: 0 }]) { c = cena(); c.ped[602] = PED(602, { notaFiscal: nfp }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.lidas], ['nota_diferente', ['/pedidos/vendas/602']], JSON.stringify(nfp)); }
    /* a nota no Bling: não veio; é outra; cancelada; sem efeito fiscal; de outra venda */
    c = cena(); delete c.nfe[7602]; r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.tkIdas.length], ['bling', 0]);
    c = cena(); c.nfe[7602] = NF(601); r = await c.pedir('?preparar=602'); assert.strictEqual(r.etapa, 'nota_diferente');
    c = cena(); c.nfe[7602] = NF(602, { situacao: 2 }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, /já cancelei/.test(r.erro), c.tkIdas.length], ['cancelada', true, 0]);
    for (const s of [1, 4, 9, null, 0, 'x']) { c = cena(); c.nfe[7602] = NF(602, { situacao: s }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'nota_sem_efeito'], 'situação ' + s); }
    for (const s of [5, 6, 7, { valor: 7 }]) { c = cena(); c.nfe[7602] = NF(602, { situacao: s }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.ok, true, 'situação ' + JSON.stringify(s)); }
    c = cena(); c.nfe[7602] = NF(602, { numeroPedidoLoja: 'OUTRA' }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.etapa, c.tkIdas.length], ['nota_de_outro_pedido', 0]);
    c = cena(); c.nfe[7602] = NF(602, { numeroPedidoLoja: null }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.ok, true, 'a nota não diz a venda: vale o vínculo pedido → nota, já conferido');
    /* as 24 h: antes disso é CANCELAR, não devolver; sem data não sei */
    c = cena(); r = await c.pedir('?preparar=603&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa, /CANCELAR/.test(r.erro)], [false, 'ainda_cancela', true]);
    c = cena(); c.nfe[7603] = NF(603, { dataEmissao: '2026-11-26 20:00:01' }); r = await c.pedir('?preparar=603&conferi=sim'); assert.strictEqual(r.etapa, 'ainda_cancela', '23h59m59s');
    c = cena(); c.nfe[7603] = NF(603, { dataEmissao: '2026-11-26 20:00:00' }); r = await c.pedir('?preparar=603&conferi=sim'); assert.strictEqual(r.ok, true, '24 h cravadas: devolução');
    c = cena(); c.nfe[7602] = NF(602, { dataEmissao: null }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.etapa, 'sem_data');
    c = cena(); c.nfe[7602] = NF(602, { dataEmissao: null, dataOperacao: '2026-11-20 10:00:00' }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.ok, true);
    /* a data que vale é a do BLING, não a do registro */
    c = cena(); c.nfe[7603] = NF(603, { dataEmissao: '2026-11-20 10:00:00' }); r = await c.pedir('?preparar=603&conferi=sim'); assert.strictEqual(r.ok, true);

    /* ═══ B. "não foi enviado" é do marketplace ═══ */
    c = cena(); c.tk.TK602 = TKCANC('TK602', { collection_time: 5 }); r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa, /Devoluções/.test(r.erro)], [false, 'postado', true], 'com leitor, o &conferi do admin NÃO passa por cima do marketplace');
    c = cena(); c.tk.TK602 = { id: 'TK602', status: 'AWAITING_COLLECTION' }; r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'ativo']);
    c = cena(); delete c.tk.TK602; r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'nao_sei']);
    c = cena(); c.tkErro = 'caiu'; r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa, /caiu/.test(r.erro)], [false, 'nao_sei', true]);
    c = cena(); c.tk.TK602 = { id: 'TK602' }; r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'nao_sei']);
    c = cena(); c.ped[602] = PED(602, { numeroLoja: '' }); c.nfe[7602] = NF(602, { numeroPedidoLoja: null }); r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.etapa, c.tkIdas.length], ['sem_numero', 0]);
    /* o número consultado no TikTok é o do PEDIDO no Bling, agora */
    c = cena(); c.ped[602] = PED(602, { numeroLoja: ' TK602 ' }); r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.ok, c.tkIdas], [true, [['TK602', 'conta-emp']]]);
    /* sem leitor (ML, Shopee…): só com a palavra do admin */
    for (const [id, nome] of [['601', 'Mercado Livre'], ['604', 'Shopee']]) {
      for (const cf of ['', '&conferi=nao', '&conferi=1']) { c = cena(); r = await c.pedir('?preparar=' + id + cf); assert.deepStrictEqual([r.ok, r.etapa, r.erro.includes(nome), c.tkIdas.length], [false, 'confirme_no_marketplace', true, 0], id + cf); }
      c = cena(); r = await c.pedir('?preparar=' + id + '&conferi=SIM'); assert.deepStrictEqual([r.ok, r.confirmacao, r.nfe_id, c.tkIdas.length], [true, 'admin', '7' + id, 0]);
    }
    /* empresa sem conta do TikTok: o pedido do TikTok também vai pela palavra do admin */
    c = cena({ extra: { tiktokConta: null } }); r = await c.pedir('?preparar=602'); assert.strictEqual(r.etapa, 'confirme_no_marketplace'); r = await c.pedir('?preparar=602&conferi=sim'); assert.deepStrictEqual([r.ok, r.confirmacao], [true, 'admin']);
    /* marketplace desconhecido (loja fora do mapa) */
    { const g = REG(); g.pedidos[601].marketplace = null; c = cena({ reg: g }); r = await c.pedir('?preparar=601'); assert.deepStrictEqual([r.etapa, /o marketplace daqui/.test(r.erro)], ['confirme_no_marketplace', true]); }
    /* enquanto eu lia, alguém tratou / o galpão bipou: não devolvo os dados */
    c = cena(); c.aoTk = () => { c.conf[602] = { conferido_em: 'y' }; }; r = await c.pedir('?preparar=602'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'bipado']);
    c = cena(); c.aoLer = (cam) => { if (/nfe/.test(cam)) fs.writeFileSync(path.join(c.dir, T.ARQ), JSON.stringify({ 601: { em: AGORA_ISO, como: 'devolvida' } })); }; r = await c.pedir('?preparar=601&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'ja_tratado']);

    /* ═══ C. resolver ═══ */
    for (const qs of ['?resolver=abc&como=devolvida&confirma=sim', '?resolver=602&como=outra&confirma=sim', '?resolver=602&confirma=sim']) { c = cena(); r = await c.pedir(qs); assert.deepStrictEqual([r._s, r.ok, c.lidas.length, c.tratados()], [400, false, 0, null], qs); }
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida'); assert.deepStrictEqual([r.ok, r.etapa, c.lidas.length, c.tratados()], [false, 'confirmacao', 0, null]);
    /* devolvida, TikTok */
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim&devolucao_id=5550001&devolucao_numero=131700');
    assert.deepStrictEqual(r, { _s: 200, ok: true, resolvido: { pedido_id: '602', numero: 9602, nf_numero: '0131602', como: 'devolvida', devolucao_numero: '131700' }, empresa: 'emp', so_leitura: false });
    assert.deepStrictEqual(c.tratados(), { 602: { em: AGORA_ISO, como: 'devolvida', por: 'admin', origem: 'cancelado_no_bling', numero: 9602, numero_loja: 'TK602', nf_numero: '0131602', confirmacao: 'tiktok', devolucao_id: '5550001', devolucao_numero: '131700' } });
    assert.deepStrictEqual(await c.pend(), ['601', '603', '604'], 'saiu do aviso NA HORA');
    r = await c.pedir('?resolver=602&como=devolvida&confirma=sim'); assert.strictEqual(r.etapa, 'ja_tratado', 'duas vezes não');
    /* devolução com id/número tortos: resolve, mas não guarda o lixo */
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim&devolucao_id=abc&devolucao_numero=' + '9'.repeat(13)); assert.deepStrictEqual([r.ok, 'devolucao_id' in c.tratados()[602], 'devolucao_numero' in c.tratados()[602], r.resolvido.devolucao_numero], [true, false, false, null]);
    /* devolvida repete TODAS as conferências */
    c = cena(); c.tk.TK602 = TKCANC('TK602', { collection_time: 5 }); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim&conferi=sim'); assert.deepStrictEqual([r.ok, r.etapa, c.tratados()], [false, 'postado', null]);
    c = cena(); r = await c.pedir('?resolver=601&como=devolvida&confirma=sim'); assert.deepStrictEqual([r.ok, r.etapa, c.tratados()], [false, 'confirme_no_marketplace', null]);
    c = cena(); r = await c.pedir('?resolver=601&como=devolvida&confirma=sim&conferi=sim'); assert.deepStrictEqual([r.ok, c.tratados()[601].confirmacao, c.tratados()[601].numero_loja], [true, 'admin', 'ML601']);
    c = cena(); c.ped[601] = PED(601, { situacao: { id: 9 } }); r = await c.pedir('?resolver=601&como=devolvida&confirma=sim&conferi=sim'); assert.deepStrictEqual([r.etapa, c.tratados()], ['nao_cancelado', null]);
    c = cena(); c.nfe[7601] = NF(601, { situacao: 2 }); r = await c.pedir('?resolver=601&como=devolvida&confirma=sim&conferi=sim'); assert.deepStrictEqual([r.etapa, c.tratados()], ['cancelada', null]);
    c = cena({ conf: { 601: { conferido_em: 'x' } } }); r = await c.pedir('?resolver=601&como=devolvida&confirma=sim&conferi=sim'); assert.deepStrictEqual([r.etapa, c.tratados()], ['bipado', null]);
    /* a devolução já saiu (a Toolbox emitiu): mesmo com menos de 24 h o registro é aceito — recusar deixaria a nota devolvida sem baixa */
    c = cena(); r = await c.pedir('?resolver=603&como=devolvida&confirma=sim&conferi=sim'); assert.strictEqual(r.ok, true);
    /* cancelada: só com a nota CANCELADA no Bling; não precisa do marketplace nem do pedido */
    c = cena(); r = await c.pedir('?resolver=603&como=cancelada&confirma=sim'); assert.deepStrictEqual([r.ok, r.etapa, /131603/.test(r.erro), c.lidas, c.tratados()], [false, 'nao_cancelada', true, ['/nfe/7603'], null]);
    c = cena(); c.nfe[7603] = NF(603, { situacao: { valor: 2 } }); r = await c.pedir('?resolver=603&como=cancelada&confirma=sim');
    assert.deepStrictEqual([r.ok, r.resolvido, c.lidas, c.tkIdas.length, c.tratados()[603]], [true, { pedido_id: '603', numero: 9603, nf_numero: '0131603', como: 'cancelada', devolucao_numero: null }, ['/nfe/7603'], 0, { em: AGORA_ISO, como: 'cancelada', por: 'admin', origem: 'cancelado_no_bling', numero: 9603, numero_loja: 'ML603', nf_numero: '0131603' }]);
    assert.deepStrictEqual(await c.pend(), ['601', '602', '604']);
    c = cena(); c.nfe[7603] = NF(603, { situacao: 2 }); r = await c.pedir('?resolver=603&como=cancelada&confirma=sim&devolucao_id=5&devolucao_numero=6'); assert.deepStrictEqual(['devolucao_id' in c.tratados()[603], 'devolucao_numero' in c.tratados()[603]], [false, false], 'cancelada não guarda devolução');
    c = cena(); delete c.nfe[7603]; r = await c.pedir('?resolver=603&como=cancelada&confirma=sim'); assert.deepStrictEqual([r.etapa, c.tratados()], ['bling', null]);
    c = cena(); c.nfe[7603] = NF(601, { situacao: 2 }); r = await c.pedir('?resolver=603&como=cancelada&confirma=sim'); assert.deepStrictEqual([r.etapa, c.tratados()], ['nota_diferente', null]);
    c = cena({ conf: { 603: { conferido_em: 'x' } } }); c.nfe[7603] = NF(603, { situacao: 2 }); r = await c.pedir('?resolver=603&como=cancelada&confirma=sim'); assert.strictEqual(r.etapa, 'bipado');
    c = cena(); r = await c.pedir('?resolver=999&como=cancelada&confirma=sim'); assert.deepStrictEqual([r.etapa, c.lidas.length], ['fora_da_lista', 0]);
    /* o registro não grava: diz, e o pedido continua no aviso */
    c = cena(); fs.mkdirSync(path.join(c.dir, T.ARQ + '.tmp')); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim'); assert.deepStrictEqual([r.ok, r.etapa, (await c.pend()).includes('602')], [false, 'registro', true]);
    /* o registro comum guarda o que o OUTRO fluxo (cancelado ainda na fila) já anotou; e limpa só o que passou de 120 dias */
    c = cena(); fs.writeFileSync(path.join(c.dir, T.ARQ), JSON.stringify({ 11: { em: AGORA_ISO, como: 'devolvida' }, 12: { em: new Date(AGORA - 121 * 864e5).toISOString(), como: 'cancelada' } }));
    await c.pedir('?resolver=602&como=devolvida&confirma=sim'); assert.deepStrictEqual(Object.keys(c.tratados()), ['11', '602']);
    /* nada é ESCRITO no Bling em nenhum caminho (a rota nem recebe blingWrite) */
    assert.ok(!/blingWrite/.test(fs.readFileSync(path.join(raiz, 'lib/checkout/rota-cancelados-bling.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

    /* ═══ D. quem pode ═══ */
    for (const [qs, ck, mt] of [['?preparar=602', '', 'GET'], ['?preparar=602', 'est', 'GET'], ['?resolver=602&como=devolvida&confirma=sim', 'est', 'POST'], ['?resolver=602&como=devolvida&confirma=sim', '', 'POST']]) { c = cena(); r = await c.pedir(qs, ck, null, mt); assert.deepStrictEqual([r._s, r.error, c.lidas.length, c.tratados()], [404, 'not found', 0, null], qs + ck); }
    /* com a sessão: resolver por GET não passa; de outro site não passa; POST da mesma origem passa */
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim', 'adm', null, 'GET'); assert.deepStrictEqual([r._s, r.etapa, c.lidas.length, c.tratados()], [403, 'origem', 0, null]);
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim', 'adm', { 'sec-fetch-site': 'cross-site' }); assert.deepStrictEqual([r._s, r.etapa, c.tratados()], [403, 'origem', null]);
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim', 'adm', { origin: 'http://outro' }); assert.deepStrictEqual([r._s, c.tratados()], [403, null]);
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim', 'adm', { origin: 'http://x' }); assert.strictEqual(r.ok, true);
    c = cena(); r = await c.pedir('?preparar=602', 'adm', { 'sec-fetch-site': 'cross-site' }, 'POST'); assert.strictEqual(r._s, 403, 'POST de outro site, mesmo sem resolver');
    /* com a chave (segredo): GET serve */
    c = cena(); r = await c.pedir('?resolver=602&como=devolvida&confirma=sim&k=chave-cbt', '', null, 'GET'); assert.deepStrictEqual([r.ok, !!c.tratados()[602]], [true, true]);
    /* a lista e o ?varrer seguem por GET com a sessão */
    c = cena(); r = await c.pedir('', 'adm', { 'sec-fetch-site': 'cross-site' }); assert.strictEqual(r.ok, true);
    /* peça que falta: diz qual, e não age */
    for (const pc of ['blingGet', 'garantirSitCancel', 'lerConferidos', 'cacheDir']) { const ex = {}; ex[pc] = undefined; c = cena({ extra: ex }); for (const qs of ['?preparar=602', '?resolver=602&como=devolvida&confirma=sim']) { r = await c.pedir(qs); assert.deepStrictEqual([r.ok, r.etapa, c.tratados()], [false, 'sem_peca', null], pc + qs); } r = await c.pedir(''); assert.strictEqual(r.ok, true, 'a lista não depende de ' + pc); }

    /* ═══ E. pelo routes REAL das três empresas ═══ */
    for (const emp of ['girassol', 'amb', 'good']) {
      const prefE = CE.prefixoDe(emp), dirE = path.join(PASTAS, emp);
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs, mt) => { const u = new URL('http://x' + prefE + '/cancelados-bling' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(bb) { this._b = String(bb || ''); } }; await h({ method: mt || 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [res._s, res._b]; };
      const reg = REG(); reg.rodou_em = new Date().toISOString(); fs.writeFileSync(path.join(dirE, V.ARQ), JSON.stringify(reg));
      /* sem credencial: nada */
      for (const [qs, mt] of [['?preparar=602', 'GET'], ['?resolver=602&como=cancelada&confirma=sim', 'POST']]) { const s0 = await real(qs, mt); assert.ok([404, 401, 302, 403].includes(s0[0]) && !/7602/.test(s0[1]), emp + ': sem credencial respondeu ' + s0[0]); }
      assert.ok(!fs.existsSync(path.join(dirE, T.ARQ)));
      /* fora do aviso / tratado no registro DESTA empresa / bipado nos conferidos DESTA empresa: responde sem ir a lugar nenhum */
      let b = JSON.parse((await real('?preparar=999&k=chave-cbt'))[1]); assert.deepStrictEqual([b.ok, b.etapa, b.empresa], [false, 'fora_da_lista', emp], emp);
      fs.writeFileSync(path.join(dirE, T.ARQ), JSON.stringify({ 601: { em: new Date().toISOString(), como: 'devolvida' } }));
      b = JSON.parse((await real('?preparar=601&conferi=sim&k=chave-cbt'))[1]); assert.deepStrictEqual([b.ok, b.etapa], [false, 'ja_tratado'], emp + ': lê o registro dos tratados da pasta da empresa');
      fs.unlinkSync(path.join(dirE, T.ARQ));
      const confArq = path.join(dirE, 'conferidos.json'); const tinha = fs.existsSync(confArq) ? fs.readFileSync(confArq) : null;
      fs.writeFileSync(confArq, JSON.stringify({ 604: { conferido_em: 'x' } }));
      b = JSON.parse((await real('?preparar=604&conferi=sim&k=chave-cbt'))[1]);
      assert.ok(b.ok === false && (b.etapa === 'bipado'), emp + ': lê os conferidos da empresa — veio ' + JSON.stringify(b).slice(0, 160));
      if (tinha) fs.writeFileSync(confArq, tinha); else fs.unlinkSync(confArq);
      assert.ok(!/sem_peca/.test(JSON.stringify(b)), emp + ': a fábrica passa todas as peças');
      fs.unlinkSync(path.join(dirE, V.ARQ));
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  _chegouAoFim = true;
  console.log('ok — cancelado no Bling com a NF valendo, tratar: preparar confere tudo na hora (pedido cancelado, não bipado, nota do pedido e autorizada, 24 h); "não foi enviado" vem do marketplace (TikTok) ou do admin (&conferi=sim); "já cancelei" só com a nota cancelada; sai do aviso na hora; nada é escrito no Bling; só admin, POST com a sessão; nas três empresas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', (e && e.stack) || e); process.exit(1); });
