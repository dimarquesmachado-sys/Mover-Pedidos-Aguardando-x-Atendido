'use strict';
/* 27/11 — A ROTA DOS PEDIDOS QUE O BLING JÁ CANCELOU COM A NOTA AINDA VALENDO (lib/checkout/rota-cancelados-bling).
   A regra da varredura é provada em scripts/teste-cancelados-bling-vigia.js. Aqui, a rota (o código de produção):
   A. a trava: só admin (chave ou sessão); sem credencial, 404 e nada roda;
   B. a lista: os pendentes da vigia (com a vigia DE VERDADE por baixo), sem esperar a varredura;
   C. a vigia se renova sozinha: lista pedida + rodada velha → uma rodada LEVE, em fundo; rodada recente, ou já em andamento,
      ou já disparada há pouco → nada;
   D. ?varrer=1: leve a qualquer hora; a das antigas (mais de 7 dias) é recusada no horário do galpão, salvo &forcar=sim;
      uma por vez; dias torto = 400;
   E. o horário do galpão (São Paulo, seg–sex 7h–18h);
   F. pelo routes REAL das três empresas: liga, trava e lê o registro da pasta da empresa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'canc-bling-rota-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const nfetch = require.resolve('node-fetch');
const idas = [];
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (u) => { idas.push(String(u)); throw new Error('rede bloqueada no teste: ' + u); } };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-cb';
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
const CE = require('../lib/checkout/config-empresa');
const R = require('../lib/checkout/rota-cancelados-bling');
const V = require('../lib/checkout/cancelados-bling-vigia');

const AGORA = Date.parse('2026-11-27T20:00:00-03:00');   /* sexta, 20h: fora do horário do galpão */
const MIN = 60 * 1000;
const tique = () => new Promise((r) => setImmediate(r));
const REG = (rodouHaMin) => ({ rodou_em: rodouHaMin == null ? undefined : new Date(AGORA - rodouHaMin * MIN).toISOString(), dias: 3, ultimo: { ok: true, dias: 3, nf_valendo: 2 }, pedidos: {
  501: { numero: 9001, numero_loja: 'L1', loja_id: 201, data: '2026-11-26', marketplace: 'ml', estado: 'nf_valendo', nf_id: '7001', nf_numero: '131189', nf_emissao: '2026-11-27 13:24:00', nf_situacao: 5 },
  502: { numero: 9002, numero_loja: 'L2', loja_id: 202, data: '2026-11-20', marketplace: 'tiktok', estado: 'nf_valendo', nf_id: '7002', nf_numero: '130900', nf_emissao: '2026-11-20 10:00:00', nf_situacao: 6 },
  503: { numero: 9003, numero_loja: 'L3', data: '2026-11-26', estado: 'nf_cancelada', nf_id: '7003' },
  504: { numero: 9004, numero_loja: 'L4', data: '2026-11-26', estado: 'bipado' },
  505: { numero: 9005, numero_loja: 'L5', data: '2026-11-26', estado: 'nf_outra', nf_id: '7005', nf_numero: '131300', nf_emissao: '2026-11-26 10:00:00', nf_situacao: 4 } } });

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    const pref = '/emp';
    /* a rota com a vigia DE VERDADE por baixo; o Bling da vigia é de mentira e conta as idas */
    const cena = (op) => {
      op = op || {};
      const dir = pasta(); let t = op.agora || AGORA;
      if (op.reg !== undefined) fs.writeFileSync(path.join(dir, V.ARQ), typeof op.reg === 'string' ? op.reg : JSON.stringify(op.reg));
      const cx = { dir, bling: [], fundo: [], varridas: [], passa: (ms) => { t += ms; }, segura: null, galpao: op.galpao };
      const vigia = V.criar({ empresa: 'emp', cacheDir: dir, agora: () => t, lerConferidos: () => ({}),
        garantirSitCancel: async () => (op.semSit ? null : { ids: [12], nomes: ['Cancelado'] }),
        blingGet: async (c) => { cx.bling.push(c); if (cx.segura) await cx.segura; if (op.blingEstoura) throw new Error('bling fora'); return { ok: true, status: 200, data: { data: [] } }; } });
      const varrer0 = vigia.varrer; vigia.varrer = (o2) => { cx.varridas.push(o2); if (op.varrerEstoura) return Promise.reject(new Error('estourou feio')); return varrer0(o2); };
      const rota = R.criar(Object.assign({ empresa: 'emp', prefixo: pref, vigia, agora: () => t,
        json: (res, st, ob) => { res._s = st; res._o = ob; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '',
        validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
        emFundo: (fn) => { cx.fundo.push(1); return op.adiado ? { ok: false, adiado: true, motivo: 'processo encerrando' } : fn(); } },
        op.galpao === undefined ? {} : { noGalpao: (tt) => { cx.galpaoVisto = tt; return cx.galpao; } }));
      cx.vigia = vigia;
      cx.pedir = async (qs, cookie, metodo) => { const mt = metodo || 'GET'; const u = new URL('http://x' + pref + '/cancelados-bling' + (qs || '')); const res = {}; const tt = await rota({ method: mt, headers: { cookie: cookie === undefined ? 'adm' : cookie } }, res, u, mt, u.pathname); return { tratou: tt, s: res._s, b: res._o }; };
      cx.arquivo = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, V.ARQ), 'utf8')); } catch (e) { return null; } };
      return cx;
    };
    let a, r;

    /* ═══ A. a trava e o caminho ═══ */
    assert.deepStrictEqual([R.caminhoDe(pref), R.atende(pref, 'GET', pref + '/cancelados-bling'), R.atende(pref, 'POST', pref + '/cancelados-bling'), R.atende(pref, 'GET', pref + '/cancelados-blin'), R.atende(pref, 'GET', '/outra/cancelados-bling')], [pref + '/cancelados-bling', true, false, false, false]);
    a = cena({ reg: REG(120) });
    r = await a.pedir('', 'adm', 'POST'); assert.strictEqual(r.tratou, false, 'POST não é desta rota');
    for (const [qs, ck] of [['', ''], ['', 'est'], ['?k=errada', ''], ['?varrer=1', 'est'], ['?varrer=1&dias=90&forcar=sim', '']]) {
      r = await a.pedir(qs, ck); assert.deepStrictEqual([r.tratou, r.s, r.b], [true, 404, { error: 'not found' }], 'sem admin: ' + qs + ' / ' + ck);
    }
    await tique(); assert.deepStrictEqual([a.varridas, a.fundo, a.bling], [[], [], []], 'sem admin nada roda — nem a renovação');
    r = await a.pedir('?k=chave-cb', ''); assert.deepStrictEqual([r.s, r.b.ok], [200, true], 'a chave também abre');
    { const g = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY; a = cena({ reg: REG(1) }); r = await a.pedir('?k=', ''); assert.strictEqual(r.s, 404, 'sem ADMIN_KEY no ambiente, chave vazia não abre'); r = await a.pedir('?k=undefined', ''); assert.strictEqual(r.s, 404); process.env.ADMIN_KEY = g; }

    /* ═══ B. a lista ═══ */
    a = cena({ reg: REG(5) }); r = await a.pedir('');
    assert.deepStrictEqual([r.s, r.b.ok, r.b.empresa, r.b.so_leitura, r.b.total, r.b.em_andamento, r.b.ultimo, r.b.ultimo_erro, r.b.rodou_em], [200, true, 'emp', true, 2, false, { ok: true, dias: 3, nf_valendo: 2 }, null, new Date(AGORA - 5 * MIN).toISOString()]);
    assert.deepStrictEqual(r.b.pendentes, [
      { pedido_id: '501', numero: 9001, numero_loja: 'L1', marketplace: 'ml', data: '2026-11-26', nf_numero: '131189', nfe_id: '7001', horas_desde_a_emissao: 6.6, acao: 'cancelar', prova_local: true },
      { pedido_id: '502', numero: 9002, numero_loja: 'L2', marketplace: 'tiktok', data: '2026-11-20', nf_numero: '130900', nfe_id: '7002', horas_desde_a_emissao: 178, acao: 'devolucao', prova_local: true }]);
    assert.ok(/Devolução já emitida não aparece/.test(r.b.leia));
    assert.deepStrictEqual(r.b.nota_em_outra_situacao, [{ pedido_id: '505', numero: 9005, nf_numero: '131300', nf_situacao: 4 }], 'a nota rejeitada/pendente fica à parte, sem ação');
    await tique(); assert.deepStrictEqual([a.varridas, a.bling], [[], []], 'rodada de 5 min atrás: não renova');
    /* sem registro nenhum: lista vazia, e a 1ª rodada é disparada */
    a = cena(); r = await a.pedir('');
    assert.deepStrictEqual([r.b.ok, r.b.total, r.b.pendentes, r.b.rodou_em, r.b.ultimo], [true, 0, [], null, null]);
    await tique(); await tique(); assert.deepStrictEqual([a.varridas, a.fundo.length], [[{ dias: 3, leituras: 40 }], 1], 'sem rodada nenhuma: dispara a leve, como FUNDO');
    /* registro ilegível: diz, e não dispara nada (a varredura não pode gravar por cima do que não leu) */
    a = cena({ reg: '{ quebrado' }); r = await a.pedir('');
    assert.deepStrictEqual([r.s, r.b.ok, r.b.etapa, r.b.empresa], [200, false, 'registro', 'emp']); await tique(); assert.deepStrictEqual(a.varridas, []);

    /* ═══ C. a vigia se renova sozinha ═══ */
    a = cena({ reg: REG(31) }); r = await a.pedir('');
    assert.deepStrictEqual([r.b.ok, r.b.total, a.bling.length <= 1], [true, 2, true], 'a resposta sai com o que já se sabe, sem esperar a varredura');
    for (let i = 0; i < 6; i++) await tique();
    assert.deepStrictEqual([a.varridas, a.fundo.length, a.bling.length > 0, a.arquivo().rodou_em], [[{ dias: 3, leituras: 40 }], 1, true, new Date(AGORA).toISOString()], 'rodada de 31 min: renova (leve), e grava a hora');
    r = await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 1, 'acabou de rodar: não renova de novo');
    a.passa(29 * MIN); r = await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 1, '29 min: ainda não');
    a.passa(2 * MIN); r = await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 2, '31 min: renova');
    /* exatamente no limite de 30 min: renova (o "recente" é MENOS de 30 min) */
    a = cena({ reg: REG(30) }); await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 1);
    a = cena({ reg: REG(29) }); await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 0);
    /* rodada que FALHA (não grava a hora): não vira martelo — só tenta de novo depois de 30 min; e o erro aparece */
    a = cena({ reg: REG(600), semSit: true }); await a.pedir(''); for (let i = 0; i < 4; i++) await tique();
    r = await a.pedir(''); await tique();
    assert.deepStrictEqual([a.varridas.length, r.b.ok, r.b.total, /não achei a situação "Cancelado"/.test(r.b.ultimo_erro), a.arquivo().rodou_em], [1, true, 2, true, new Date(AGORA - 600 * MIN).toISOString()], 'falhou: a lista continua, o erro é dito, e não martela');
    a.passa(31 * MIN); await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 2);
    /* varredura que estoura não derruba a rota */
    a = cena({ reg: REG(600), varrerEstoura: true }); r = await a.pedir(''); for (let i = 0; i < 4; i++) await tique();
    r = await a.pedir(''); assert.deepStrictEqual([r.s, r.b.ok, r.b.ultimo_erro], [200, true, 'a varredura falhou: estourou feio']);
    /* o processo está encerrando: o fundo adia, e isso é dito (não vira "undefined") */
    a = cena({ reg: REG(600), adiado: true }); await a.pedir(''); for (let i = 0; i < 4; i++) await tique();
    r = await a.pedir(''); assert.deepStrictEqual([a.varridas, r.b.ultimo_erro], [[], 'processo encerrando']);
    /* já tem uma em andamento: a lista diz, e não dispara outra */
    a = cena({ reg: REG(600) }); let solta; a.segura = new Promise((ok) => { solta = ok; });
    await a.pedir(''); await tique(); await tique();
    a.passa(40 * MIN); r = await a.pedir(''); await tique();
    assert.deepStrictEqual([r.b.em_andamento, a.varridas.length], [true, 1], 'em andamento: avisa e não empilha');
    r = await a.pedir('?varrer=1'); assert.deepStrictEqual([r.s, r.b.ok, r.b.etapa, a.varridas.length], [200, false, 'rodando', 1], '?varrer com uma em andamento: recusa');
    solta(); a.segura = null; for (let i = 0; i < 8; i++) await tique();
    r = await a.pedir(''); assert.deepStrictEqual([r.b.em_andamento, r.b.ultimo_erro], [false, null]);

    /* ═══ D. ?varrer=1 ═══ */
    a = cena({ reg: REG(1), galpao: true }); r = await a.pedir('?varrer=1'); await tique();
    assert.deepStrictEqual([r.s, r.b, a.varridas], [200, { ok: true, disparada: { dias: 3, pesada: false }, acompanhe: pref + '/cancelados-bling', empresa: 'emp', so_leitura: true }, [{ dias: 3, leituras: 40 }]], 'leve roda a qualquer hora, mesmo com rodada recente');
    a = cena({ reg: REG(1), galpao: true }); r = await a.pedir('?varrer=1&dias=7'); await tique(); assert.deepStrictEqual([r.b.ok, a.varridas], [true, [{ dias: 7, leituras: 40 }]], '7 dias ainda é leve');
    /* a das antigas, no horário do galpão: recusada */
    a = cena({ reg: REG(1), galpao: true }); r = await a.pedir('?varrer=1&dias=8'); await tique();
    assert.deepStrictEqual([r.s, r.b.ok, r.b.etapa, /horário do galpão/.test(r.b.erro) && /&forcar=sim/.test(r.b.erro), a.varridas, a.galpaoVisto], [200, false, 'horario_do_galpao', true, [], AGORA]);
    for (const f of ['nao', 'SIM ', 'Sim']) { a = cena({ reg: REG(1), galpao: true }); r = await a.pedir('?varrer=1&dias=90&forcar=' + encodeURIComponent(f)); await tique(); assert.deepStrictEqual([r.b.ok, a.varridas.length], f === 'nao' ? [false, 0] : [true, 1], 'forcar=' + f); }
    a = cena({ reg: REG(1), galpao: true }); r = await a.pedir('?varrer=1&dias=90&forcar=sim'); await tique(); assert.deepStrictEqual([r.b.disparada, a.varridas], [{ dias: 90, pesada: true }, [{ dias: 90, leituras: 600 }]]);
    /* fora do horário: roda, com mais leituras */
    a = cena({ reg: REG(1), galpao: false }); r = await a.pedir('?varrer=1&dias=60'); await tique(); assert.deepStrictEqual([r.b.ok, r.b.disparada, a.varridas, a.fundo.length], [true, { dias: 60, pesada: true }, [{ dias: 60, leituras: 600 }], 1]);
    a = cena({ reg: REG(1), galpao: false }); r = await a.pedir('?varrer=1&dias=999'); await tique(); assert.deepStrictEqual(a.varridas, [{ dias: 180, leituras: 600 }], 'teto de 180 dias');
    a = cena({ reg: REG(1), galpao: false }); r = await a.pedir('?varrer=1&dias=0'); await tique(); assert.deepStrictEqual(a.varridas, [{ dias: 1, leituras: 40 }]);
    for (const ruim of ['abc', '-5', '3.5', '1e2', '1234', '7;x']) { a = cena({ reg: REG(1), galpao: false }); r = await a.pedir('?varrer=1&dias=' + encodeURIComponent(ruim)); await tique(); assert.deepStrictEqual([r.s, r.b.ok, a.varridas], [400, false, []], 'dias ' + ruim); }
    /* a que acabou de ser disparada segura a renovação automática (não dispara em dobro) */
    a = cena({ reg: REG(600), semSit: true }); await a.pedir('?varrer=1'); await tique(); await a.pedir(''); await tique(); assert.strictEqual(a.varridas.length, 1);

    /* ═══ E. o horário do galpão (São Paulo) ═══ */
    const H = (iso) => R.noGalpaoAgora(Date.parse(iso));
    assert.deepStrictEqual([H('2026-11-27T06:59:00-03:00'), H('2026-11-27T07:00:00-03:00'), H('2026-11-27T12:00:00-03:00'), H('2026-11-27T17:59:00-03:00'), H('2026-11-27T18:00:00-03:00'), H('2026-11-27T23:30:00-03:00'), H('2026-11-28T00:10:00-03:00')],
      [false, true, true, true, false, false, false], 'sexta');
    assert.deepStrictEqual([H('2026-11-28T10:00:00-03:00'), H('2026-11-29T10:00:00-03:00'), H('2026-11-30T10:00:00-03:00'), H('2026-11-30T12:00:00Z'), H('2026-11-30T09:30:00Z')], [false, false, true, true, false], 'sábado, domingo, segunda; e a conta é em São Paulo, não em UTC');
    /* sem `noGalpao` de fora, a rota usa o relógio de verdade: sexta 20h deixa; sexta 10h recusa */
    a = cena({ reg: REG(1) }); r = await a.pedir('?varrer=1&dias=30'); await tique(); assert.deepStrictEqual([r.b.ok, a.varridas.length], [true, 1]);
    a = cena({ reg: REG(1), agora: Date.parse('2026-11-27T10:00:00-03:00') }); r = await a.pedir('?varrer=1&dias=30'); await tique(); assert.deepStrictEqual([r.b.etapa, a.varridas.length], ['horario_do_galpao', 0]);

    /* peça faltando: estoura na montagem, com o nome */
    const base = { empresa: 'emp', prefixo: pref, json() {}, lerChaveAdmin() {}, validarSessao() {}, ehAdmin() {}, vigia: { varrer() {}, pendentes() {} } };
    for (const k of Object.keys(base)) { const o = Object.assign({}, base); delete o[k]; assert.throws(() => R.criar(o), /rota-cancelados-bling.*falta/, 'sem ' + k); }
    assert.throws(() => R.criar(Object.assign({}, base, { vigia: { varrer() {} } })), /falta prefixo\/vigia/);

    /* ═══ F. pelo routes REAL das três empresas ═══ */
    for (const emp of ['girassol', 'amb', 'good']) {
      const prefE = CE.prefixoDe(emp);
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs) => { const u = new URL('http://x' + prefE + '/cancelados-bling' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(bb) { this._b = String(bb || ''); } }; await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [res._s, res._b]; };
      /* o registro DESTA empresa, com rodada de agora (não dispara renovação: nada de rede) */
      const reg = REG(0); reg.rodou_em = new Date().toISOString(); reg.pedidos[501].numero = 8000 + emp.length;
      fs.writeFileSync(path.join(PASTAS, emp, V.ARQ), JSON.stringify(reg));
      idas.length = 0;
      const semK = await real('');
      assert.ok(semK[0] === 404 || semK[0] === 401 || semK[0] === 302, emp + ': sem credencial o routes real respondeu ' + semK[0]);
      assert.ok(!/131189/.test(semK[1]), emp + ': sem credencial não vaza a lista');
      const comK = await real('?k=chave-cb');
      assert.ok(comK[0] === 200 && !/sem_peca/.test(comK[1]), emp + ': o routes real respondeu ' + comK[0] + ' ' + comK[1].slice(0, 200));
      const d = JSON.parse(comK[1]);
      assert.deepStrictEqual([d.ok, d.empresa, d.total, d.pendentes.map((p) => [p.pedido_id, p.numero, p.nf_numero, p.marketplace])], [true, emp, 2, [['501', 8000 + emp.length, '131189', 'ml'], ['502', 9002, '130900', 'tiktok']]], emp + ': a lista vem do registro da pasta desta empresa');
      assert.ok(!/chave-cb/.test(comK[1]), 'a chave não volta na resposta');
      fs.writeFileSync(path.join(PASTAS, emp, V.ARQ), '{ quebrado');
      const q = await real('?k=chave-cb'); assert.ok(q[0] === 200 && /"etapa":"registro"/.test(q[1]), emp + ': registro ilegível no routes real: ' + q[1].slice(0, 160));
      await tique(); assert.strictEqual(idas.length, 0, emp + ': com rodada recente (ou registro ilegível) ninguém é chamado');
      fs.unlinkSync(path.join(PASTAS, emp, V.ARQ));
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — pedidos cancelados no Bling com a NF valendo, a rota: só admin; lista os pendentes sem esperar a varredura; a vigia se renova sozinha (leve, em fundo, sem martelar); a varredura das antigas é recusada no horário do galpão; nas três empresas');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
