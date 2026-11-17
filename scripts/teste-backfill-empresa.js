'use strict';
/* 16/11 — O CONTEXTO DO BACKFILL DA EMPRESA NUMA PEÇA (lib/checkout/backfill-empresa; docs/NORTE-2026-11.md, item C —
   `montarCheckout`, passo 9).

   A AMB e a GOOD montavam à mão o contexto do motor único (`_ctxBackfillAmb`, `_ctxBackfillGood`), a AMB guardava o andamento
   num objeto próprio que só entrava no registro por empresa na 1ª rodada, e tinha a CÓPIA inteira das situações de
   cancelamento (com o env AMBBKP_SIT_CANCELADO). Prova:
     1) a peça, com o backfill-rodar e o Supabase de mentira no require.cache:
        · montagem sem empresa, sem `pecas`, com peça faltando, com alíquota de reserva inválida ou empresa fora do contrato
          derruba; montar não lê nenhuma peça;
        · o contexto tem as chaves que a AMB montava (22, com a reserva) — a GOOD as mesmas sem a reserva, mais o andamento e
          as situações de cancelamento (que o motor já usava por padrão); cada campo chama a peça da empresa NA HORA;
        · o Supabase, o token do ML e as situações de cancelamento são os DA EMPRESA; o andamento é o do registro;
        · o backfill roda o backfill-rodar com a empresa e um contexto novo a cada rodada;
     2) as situações de cancelamento: o env de contorno vale por convenção (AMBBKP_, GOODBKP_; a Girassol com o GIRABKP_ dela)
        e nunca o de outra empresa;
     3) pelos módulos REAIS (rede bloqueada): a AMB e a GOOD — e, desde o passo 10 (16/11), a Girassol — montam a peça com a
        empresa, a tabela de alíquotas e a reserva DELAS; o canário que trava é o objeto vivo da empresa; o `/backfill-status`
        da AMB mostra o andamento do REGISTRO desde o boot (o objeto é um só); a AMB não tem mais a cópia das situações de
        cancelamento; a Girassol não monta mais o motor (era a "dona" dos padrões dele). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ESTADO = require('../lib/checkout/backfill-estado');
const SIT = require('../lib/checkout/situacoes-cancelamento');

const resolver = (n) => require.resolve(n);
const trocar = (mapa) => { const salvo = {}; for (const [n, exp] of Object.entries(mapa)) { const r = resolver(n); salvo[r] = require.cache[r]; require.cache[r] = { id: r, filename: r, loaded: true, exports: exp }; } return () => { for (const [r, v] of Object.entries(salvo)) { if (v) require.cache[r] = v; else delete require.cache[r]; } }; };

(async () => {
  /* ── 1) a peça ── */
  {
    const visto = { rodar: [], supa: [] };
    const devolve = trocar({
      '../lib/checkout/backfill-rodar': { backfillVendas: async (de, ate, emp, ctx) => { visto.rodar.push({ de, ate, emp, ctx }); return { ok: true, desfecho: 'ok' }; } },
      '../lib/supabase': { para: (emp) => ({ req: (...a) => { visto.supa.push(['req', emp, ...a]); return 'r'; }, count: (...a) => { visto.supa.push(['count', emp, ...a]); return 7; } }) },
    });
    try {
      delete require.cache[resolver('../lib/checkout/backfill-empresa')];
      const BE = require('../lib/checkout/backfill-empresa');
      const lidas = [];
      const val = { blingGet: (p) => 'bling:' + p, readJson: () => 'rj', CACHE_DIR: '/c', DEFAULT_ALIQ_BK: { '2026-01': 9 }, ehFlex: () => 'flex', LOJA_MKT: { 1: 'ml' }, escrowEmLote: (...a) => ['lote', ...a], escrowDoPedido: (...a) => ['ped', ...a],
        magaluFreteSkuLer: (...a) => ['ler', ...a], custoEmpresa: { custoVigenteEm: (s, d) => 'cv:' + s + ':' + d }, mlBilling: { mapasBilling: () => 'mapas', aplicarCreditosFlexNaFila: (a, b) => 'cred:' + a + b },
        cacaMagalu: { magaluLinhas: (...a) => ['linhas', ...a], estado: () => ({ rodando: false }) }, canario: { rodando: false }, reparoAtivo: () => false };
      const pecas = {}; for (const n of Object.keys(val)) Object.defineProperty(pecas, n, { enumerable: true, get() { lidas.push(n); return val[n]; } });

      assert.throws(() => BE.criar({}), /falta empresa/);
      assert.throws(() => BE.criar({ empresa: 'amb' }), /falta pecas/);
      for (const n of BE.PECAS) { const p2 = Object.assign({}, val); delete p2[n]; assert.throws(() => BE.criar({ empresa: 'amb', pecas: p2 }), new RegExp('falta ' + n + '$')); }
      assert.throws(() => BE.criar({ empresa: 'amb', aliqReserva: 'x', pecas: val }), /aliqReserva inválida/);
      assert.throws(() => BE.criar({ empresa: 'quinta', pecas: val }), /desconhecida no contrato/);

      const P = BE.criar({ empresa: 'amb', aliqReserva: 14.1, pecas });
      assert.deepStrictEqual(lidas, [], 'montar não pode ler as peças da empresa — leu: ' + lidas.join(','));
      assert.strictEqual(P.estado, ESTADO.estado('amb'), 'o andamento é o do registro por empresa');
      const c = P.ctx();
      assert.deepStrictEqual(Object.keys(c).sort(), ['CACHE_DIR', 'DEFAULT_ALIQ_BK', 'LOJA_MKT', 'aliqReserva', 'blingGet', 'cacaMagaluRodando', 'canarioRodando', 'creditosFlex', 'custoVigenteEm', 'ehFlex', 'escrowDoPedido', 'escrowEmLote', 'estadoBackfill', 'garantirSitCancel', 'garantirTokenML', 'magaluFreteSkuLer', 'magaluLinhas', 'mapasBilling', 'readJson', 'reparoAtivo', 'supaCount', 'supaReq']);
      assert.ok(c.blingGet === val.blingGet && c.readJson === val.readJson && c.CACHE_DIR === '/c' && c.DEFAULT_ALIQ_BK === val.DEFAULT_ALIQ_BK && c.ehFlex === val.ehFlex && c.LOJA_MKT === val.LOJA_MKT && c.aliqReserva === 14.1 && c.estadoBackfill === P.estado);
      /* cada campo chama a peça NA HORA (trocada depois, vale a nova) */
      assert.deepStrictEqual(c.escrowEmLote(1), ['lote', 1]); val.escrowEmLote = (...a) => ['lote2', ...a]; assert.deepStrictEqual(c.escrowEmLote(1), ['lote2', 1], 'o escrow é lido na hora');
      assert.deepStrictEqual(c.escrowDoPedido(2), ['ped', 2]); assert.deepStrictEqual(c.magaluFreteSkuLer('S'), ['ler', 'S']);
      assert.strictEqual(c.custoVigenteEm('S', '2026-10-01'), 'cv:S:2026-10-01'); assert.strictEqual(c.mapasBilling(), 'mapas'); assert.strictEqual(c.creditosFlex('a', 'b'), 'cred:ab');
      assert.deepStrictEqual(c.magaluLinhas(1, 2, 3, 4), ['linhas', 1, 2, 3, 4]);
      assert.strictEqual(c.cacaMagaluRodando(), false); val.cacaMagalu = { magaluLinhas: () => [], estado: () => ({ rodando: true }) }; assert.strictEqual(c.cacaMagaluRodando(), true, 'a caça é lida na hora');
      val.cacaMagalu = { magaluLinhas: () => [], estado: () => null }; assert.strictEqual(c.cacaMagaluRodando(), false, 'caça sem estado: não está rodando (não estoura)');
      assert.strictEqual(c.canarioRodando(), false); val.canario = { rodando: true }; assert.strictEqual(c.canarioRodando(), true, 'o canário é lido na hora');
      assert.strictEqual(c.reparoAtivo(), false); val.reparoAtivo = () => 1; assert.strictEqual(c.reparoAtivo(), true, 'a trava do reparo é lida na hora (e vira booleano)');
      /* o Supabase, o token e as situações são DA EMPRESA */
      assert.strictEqual(c.supaReq('amb', 'GET', 'x', null), 'r'); assert.strictEqual(c.supaCount('amb', 'f'), 7);
      assert.deepStrictEqual(visto.supa, [['req', 'amb', 'amb', 'GET', 'x', null], ['count', 'amb', 'amb', 'f']], 'o Supabase é o da empresa');
      const sitAntes = SIT.alvo('amb'); const bgSit = async () => ({ ok: true, data: { data: [] } });
      const rs = await c.garantirSitCancel(bgSit); assert.strictEqual(rs, sitAntes, 'as situações de cancelamento são as da empresa (o objeto dela, estável)');
      /* o token do ML: o do contrato, carregado NA CHAMADA (uma empresa sem o módulo estoura só ali) */
      const regQ = require('../lib/checkout/config-empresa');
      assert.strictEqual(regQ.configCheckout('amb').mlTokenManager, 'ambtotal/mlTokenManager');
      assert.ok(/require\(path\.join\(RAIZ, cfg\.mlTokenManager\)\)\.garantirTokenML\(\)/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'backfill-empresa.js'), 'utf8')), 'o token do ML é o do contrato da empresa');
      /* sem reserva declarada, o contexto não traz a chave (o motor usa a dele) */
      const G = BE.criar({ empresa: 'good', pecas: val });
      assert.ok(!('aliqReserva' in G.ctx()), 'sem reserva declarada, a chave não vai');
      assert.strictEqual(G.ctx().estadoBackfill, ESTADO.estado('good'));
      /* o backfill: o backfill-rodar com a empresa e um contexto NOVO a cada rodada */
      await P.backfillVendas('2026-10-01', '2026-10-02'); await P.backfillVendas('2026-10-03', '2026-10-03');
      assert.deepStrictEqual(visto.rodar.map((r) => [r.de, r.ate, r.emp]), [['2026-10-01', '2026-10-02', 'amb'], ['2026-10-03', '2026-10-03', 'amb']]);
      assert.notStrictEqual(visto.rodar[0].ctx, visto.rodar[1].ctx, 'o contexto é montado a cada rodada');
      assert.strictEqual(visto.rodar[0].ctx.aliqReserva, 14.1);
    } finally { devolve(); delete require.cache[resolver('../lib/checkout/backfill-empresa')]; }
  }

  /* ── 2) as situações de cancelamento: o env de contorno por convenção ── */
  {
    const semModulo = async () => ({ ok: true, data: { data: [] } });
    const envs = ['GIRABKP_SIT_CANCELADO', 'AMBBKP_SIT_CANCELADO', 'GOODBKP_SIT_CANCELADO']; const salvo = {}; for (const n of envs) salvo[n] = process.env[n];
    try {
      process.env.GIRABKP_SIT_CANCELADO = '111'; process.env.AMBBKP_SIT_CANCELADO = '222,223'; process.env.GOODBKP_SIT_CANCELADO = '333';
      for (const e of ['girassol', 'amb', 'good']) { const a = SIT.alvo(e); a.ids = []; a.ts = 0; }
      assert.deepStrictEqual((await SIT.garantirSitCancel(semModulo, 'amb')).ids, [222, 223], 'a AMB lê o AMBBKP_SIT_CANCELADO (o env da cópia que saiu)');
      assert.deepStrictEqual((await SIT.garantirSitCancel(semModulo, 'good')).ids, [333], 'a GOOD, pela convenção');
      assert.deepStrictEqual((await SIT.garantirSitCancel(semModulo, 'girassol')).ids, [111], 'a Girassol, a exceção histórica');
      delete process.env.AMBBKP_SIT_CANCELADO; const a = SIT.alvo('amb'); a.ids = []; a.ts = 0;
      assert.deepStrictEqual((await SIT.garantirSitCancel(semModulo, 'amb')).ids, [], 'a AMB nunca pega o env de outra empresa');
      assert.deepStrictEqual([SIT.envFixoDe('girassol'), SIT.envFixoDe('amb'), SIT.envFixoDe('good'), SIT.envFixoDe('quinta')], ['GIRABKP_SIT_CANCELADO', 'AMBBKP_SIT_CANCELADO', 'GOODBKP_SIT_CANCELADO', null]);
    } finally { for (const n of envs) { if (salvo[n] === undefined) delete process.env[n]; else process.env[n] = salvo[n]; } for (const e of ['girassol', 'amb', 'good']) { const a = SIT.alvo(e); a.ids = []; a.ts = 0; } }
  }

  /* ── 3) os módulos reais ── */
  {
    const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
    for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-be';
    const realBE = require('../lib/checkout/backfill-empresa');
    const visto = {};
    const devolve = trocar({ '../lib/checkout/backfill-empresa': Object.assign({}, realBE, { criar: (o) => { visto[o.empresa] = o; return realBE.criar(o); } }) });
    const _log = console.log, _warn = console.warn, _err = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
    const mods = {};
    try {
      for (const [emp, arq, envDir] of [['amb', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR'], ['good', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR'], ['girassol', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR']]) {
        process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'be-' + emp + '-'));
        mods[emp] = require(path.join(raiz, arq));
      }
    } finally { console.log = _log; console.warn = _warn; console.error = _err; devolve(); }
    const ambSrc = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
    const goodSrc = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    const girSrc = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js')).toString('utf8');
    const tabela = (src, nome) => eval('(' + new RegExp('const ' + nome + ' = (\\{[^}]*\\})').exec(src)[1] + ')');
    for (const [emp, src, tab, reserva] of [['amb', ambSrc, 'DEFAULT_ALIQ_BK', 14.1], ['good', goodSrc, 'DEFAULT_ALIQ_BK_GOOD', undefined], ['girassol', girSrc, 'DEFAULT_ALIQ_BK', undefined]]) {
      const o = visto[emp]; assert.ok(o, emp + ': não montou a peça');
      assert.strictEqual(o.aliqReserva, reserva, emp + ': a alíquota de reserva');
      assert.deepStrictEqual(o.pecas.DEFAULT_ALIQ_BK, tabela(src, tab), emp + ': a tabela de alíquotas é a DELA');
      const c = realBE.criar(o).ctx();
      assert.strictEqual(c.estadoBackfill, ESTADO.estado(emp), emp + ': o andamento do registro');
      assert.strictEqual(typeof c.custoVigenteEm, 'function'); assert.strictEqual(typeof o.pecas.mlBilling.mapasBilling, 'function'); assert.strictEqual(typeof o.pecas.cacaMagalu.magaluLinhas, 'function');
      assert.strictEqual(c.canarioRodando(), false); assert.strictEqual(c.reparoAtivo(), false); assert.strictEqual(c.cacaMagaluRodando(), false);
      /* o canário que trava o backfill é o objeto VIVO da empresa (a peça dela), não uma cópia de quando montou */
      const can = o.pecas.canario; assert.ok(can && typeof can.ativos === 'number', emp + ': não entrega o estado do canário (lib/checkout/canario-empresa)');
      can.ativos++; try { assert.strictEqual(c.canarioRodando(), true, emp + ': o canário conferindo não trava o backfill dela'); } finally { can.ativos--; }
    }
    /* 16/11 (passo 10): a Girassol roda pela peça — sem reserva própria (o motor usa a padrão, 15, que era a dela), com o reparo de
       SKU DELA (a variável que a fábrica liga em /sku-repara) — e não monta mais o motor */
    assert.ok(require('./_backfill-empresa').entrega(girSrc, 'reparoAtivo', '() => _reparoAtivo') && /_reparoAtivo: \{ get: \(\) => _reparoAtivo, set: \(v\) => \{ _reparoAtivo = v; \} \}/.test(girSrc), 'a Girassol: o reparo de SKU que trava o backfill não é o que a fábrica liga');
    assert.ok(!girSrc.includes("require('../lib/checkout/backfill-motor')") && !/async function _mapasBilling\(|const _feeMLLeve = |const SHOPEE_TODOS = /.test(girSrc), 'a Girassol ainda monta o motor (ou sobrou o que só ele usava)');
    assert.ok(!/async function garantirSitCancel\(/.test(ambSrc) && !/AMBBKP_SIT_CANCELADO\)/.test(ambSrc) && /const _sitCancel = require\('\.\.\/lib\/checkout\/situacoes-cancelamento'\)\.alvo\('amb'\);/.test(ambSrc), 'a AMB ainda tem a cópia das situações de cancelamento');
    assert.ok(!/function _ctxBackfillAmb\(/.test(ambSrc) && !/require\('\.\.\/lib\/checkout\/backfill-rodar'\)\.backfillVendas\(de, ate, 'amb'/.test(ambSrc), 'sobrou o contexto à mão na AMB');
    assert.ok(!/supaReq: \(empresa, metodo, pq, body\) => supa\.req/.test(goodSrc), 'sobrou o contexto à mão na GOOD');
    /* o /backfill-status da AMB mostra o andamento do REGISTRO desde o boot */
    const est = ESTADO.estado('amb'); est.msg = 'MARCA-REGISTRO';
    const h = mods.amb.routes(async () => ({}));
    const u = new URL('http://x/amb-checkout-offline/backfill-status?k=' + encodeURIComponent(process.env.ADMIN_KEY));
    const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    assert.strictEqual(res._s, 200, res._b.slice(0, 200));
    assert.strictEqual(JSON.parse(res._b).status.msg, 'MARCA-REGISTRO', 'o /backfill-status da AMB tem que mostrar o andamento do registro por empresa (o objeto é um só)');
    est.msg = '';
  }
  console.log('ok — o contexto do backfill da empresa é uma peça (lib/checkout/backfill-empresa): as 22 chaves da AMB, cada uma lida na hora, Supabase/token/situações/andamento DA empresa; a AMB, a GOOD e a Girassol montam a peça com a tabela e a reserva delas (e o canário vivo); o andamento da AMB é o do registro desde o boot; as situações de cancelamento com o env por convenção (a cópia da AMB saiu)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
