'use strict';
/* 17/11 — O CONTEXTO DA MADRUGADA DA EMPRESA É A PEÇA (lib/checkout/noturna-empresa, `criar`; docs/NORTE-2026-11.md, item C —
   `montarCheckout`, passo 12).

   A madrugada já era uma só (criarNoturna), mas cada arquivo de entrada montava o contexto dela à mão (~25 campos, os mesmos
   nas três; a Girassol e a AMB por um embrulho de uma linha que só punha a empresa e o prefixo). Prova:
     1) a peça, com peças de mentira que anotam cada chamada:
        · montagem sem empresa, sem `pecas`, com peça faltando, com `historico` que não conhece a chave (ou que não é função) ou
          com empresa fora do contrato derruba; montar não lê nenhuma peça (várias nascem DEPOIS da madrugada no arquivo);
        · o prefixo e o token do ML saem do CONTRATO da empresa (as três);
        · cada campo da madrugada chama a peça certa da empresa, com os argumentos de antes (billing, pesca, cancelados só com
          os dias, TikTok, conferência e conserto do canário, canário das integrações com a versão e a sessão dela, devoluções
          45 dias e carteira 30 com o pedido à Shopee dela, Ads pela lib/shopee-ads com a pasta e o pedido dela, a pasta);
        · o histórico: o backfill e o resgate pela peça do backfill da empresa, o andamento pelo registro DA empresa; sem
          backfill de um dia próprio; `historico` troca só o que traz e `resgatarHistorico: null` tira a etapa;
        · a poda: quem entrega a função poda (com a janela e a pausa); quem entrega null mostra que roda na madrugada da
          Girassol (o bucket é um só);
        · as peças são lidas NA HORA (a peça trocada depois de montar é a que roda);
     2) pelos módulos REAIS (rede bloqueada): os três arquivos montam a madrugada pela peça com a empresa deles, e cada peça
        entregue é o objeto DA EMPRESA (o mesmo que o arquivo criou: backfill, canário, cancelados, billing, venda do dia, TikTok;
        a Shopee, o canário das integrações e a poda dos módulos da pasta dela; a base dela); só a Girassol poda; só a GOOD
        troca o histórico (a rotina diária dela, o andamento dela, o backfill de um dia com a trava dela, sem o resgate) — e a
        rota de status da madrugada responde no prefixo de cada uma, com a versão dela.
     3) 17/11 (montarCheckout, passo 13) O HORÁRIO DA MADRUGADA é do contrato (config-empresa `madrugada`): o status dizia
        "03:30" pras três (a AMB roda 03:45, a GOOD 04:00). Agora o cron que cada arquivo entrega ao orquestrador e o horário
        que o status mostra saem do mesmo lugar — Girassol 03:30, AMB 03:45, GOOD 04:00 —; a empresa nova tem o dela (04:30,
        depois das três e antes do galpão); um cron que não é diário aparece como está e, sem cron, o status não inventa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const NE = require('../lib/checkout/noturna-empresa');
const ESTADO = require('../lib/checkout/backfill-estado');
const { pecasFalsas, montagem } = require('./_fonte-noturna');

const resolver = (n) => require.resolve(n);
const trocar = (mapa) => {
  const salvo = {};
  for (const [n, exp] of Object.entries(mapa)) { const r = resolver(n); salvo[r] = require.cache[r]; require.cache[r] = { id: r, filename: r, loaded: true, exports: exp }; }
  return () => { for (const [r, v] of Object.entries(salvo)) { if (v) require.cache[r] = v; else delete require.cache[r]; } };
};

(async () => {
  /* ── 1) a peça ── */
  {
    /* derruba no boot */
    assert.throws(() => NE.criar(), /falta empresa/);
    assert.throws(() => NE.criar({ empresa: 'girassol' }), /falta pecas/);
    for (const n of NE.PECAS_NOTURNA) { const P = pecasFalsas(); delete P[n]; assert.throws(() => NE.criar({ empresa: 'amb', pecas: P }), new RegExp('falta ' + n + '$'), 'sem ' + n + ' tinha que derrubar'); }
    assert.throws(() => NE.criar({ empresa: 'quinta-que-nao-existe', pecas: pecasFalsas() }), /empresa desconhecida/);
    assert.throws(() => NE.criar({ empresa: 'good', pecas: pecasFalsas(), historico: { coletarAds: async () => ({}) } }), /historico não tem coletarAds/);
    assert.throws(() => NE.criar({ empresa: 'good', pecas: pecasFalsas(), historico: { backfillVendas: 'x' } }), /historico\.backfillVendas não é função/);
    assert.throws(() => NE.criar({ empresa: 'good', pecas: pecasFalsas(), historico: 'x' }), /historico inválido/);
    /* montar não lê nenhuma peça (getters que explodem) */
    const leAoMontar = { VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: () => {}, CACHE_DIR: null };   /* o básico que a madrugada guarda ao nascer (como antes) */
    const explode = {};
    for (const n of NE.PECAS_NOTURNA) {
      if (n in leAoMontar) explode[n] = leAoMontar[n];
      else Object.defineProperty(explode, n, { enumerable: true, get() { throw new Error('leu ' + n + ' na montagem'); } });
    }
    NE.criar({ empresa: 'amb', pecas: explode });

    /* o prefixo e o token do ML saem do contrato */
    const pastas = { girassol: 'girassol', amb: 'ambtotal', good: 'good' };
    const kTok = {}; for (const d of Object.values(pastas)) kTok[d] = resolver(path.join(raiz, d, 'mlTokenManager'));
    const salvoTok = {}; for (const [d, k] of Object.entries(kTok)) { salvoTok[k] = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports: { garantirTokenML: async () => 'token-' + d } }; }
    try {
      for (const [emp, pref] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
        const c = NE.criar({ empresa: emp, pecas: pecasFalsas() }).contexto;
        assert.deepStrictEqual([c.empresa, c.prefixo, await c.garantirTokenML()], [emp, pref, 'token-' + pastas[emp]], emp + ': o prefixo ou o token do ML não são os do contrato dela');
      }
    } finally { for (const [k, v] of Object.entries(salvoTok)) { if (v) require.cache[k] = v; else delete require.cache[k]; } }

    /* cada campo chama a peça certa, com os argumentos de antes */
    const log = [];
    const anota = (nome, ret) => async (...a) => { log.push([nome, ...a]); return ret === undefined ? { ok: true, de: nome } : ret; };
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'not-montada-'));
    const rj = (f, p) => p, wj = () => {}, vs = () => 'sessao', ea = () => true, js = () => {};
    const P = pecasFalsas({
      backfill: { backfillVendas: anota('bf.backfillVendas'), resgatarHistorico: anota('bf.resgatarHistorico') },
      canario: { conferir: anota('can.conferir'), consertar: anota('can.consertar') }, cancelados: { varrerCancelados: anota('canc.varrerCancelados') },
      mlBilling: { mlBillingSync: anota('mlb.mlBillingSync') }, vendasDia: { mlSyncFees: anota('vd.mlSyncFees') },
      shopee: { pedirAoSync: anota('sh.pedirAoSync'), coletarDevolucoes: anota('sh.coletarDevolucoes'), coletarCarteira: anota('sh.coletarCarteira') },
      tiktokFinanceiro: anota('tk.financeiro'), tiktokCompletar: anota('tk.completar'), canarioCron: anota('canarioCron'), podarExpedicao: anota('podar', { apagados: 1, mb: 2 }),
      CACHE_DIR: dirC, readJson: rj, writeJson: wj, VERSAO: 'v-amb-teste', validarSessao: vs, ehAdmin: ea, json: js,
    });
    const n = NE.criar({ empresa: 'amb', pecas: P });
    const c = n.contexto;
    assert.strictEqual(typeof n.rotinaNoturna, 'function'); assert.strictEqual(typeof n.rotas, 'function');
    assert.deepStrictEqual([c.cacheDir, c.VERSAO, c.validarSessao, c.ehAdmin, c.json], [dirC, 'v-amb-teste', vs, ea, js], 'o básico da madrugada não é o da empresa');
    const R = { ok: true, alertas: [] };
    const casos = [
      [() => c.mlBillingSync(2), ['mlb.mlBillingSync', 2]],
      [() => c.mlSyncFees(60), ['vd.mlSyncFees', 60]],
      [() => c.varrerCancelados(45, 'amb'), ['canc.varrerCancelados', 45]], [() => c.varrerCancelados(30, 'amb'), ['canc.varrerCancelados', 30]],
      [() => c.coletarFinanceiroTikTok(120), ['tk.financeiro', 120]],
      [() => c.completarTarifaTikTok(45), ['tk.completar', 45]],
      [() => c.conferirMarketplaces(3), ['can.conferir', 3, undefined, undefined]],
      [() => c.conferirMarketplaces(30, ['ml'], { x: 1 }), ['can.conferir', 30, ['ml'], { x: 1 }]],
      [() => c.consertarDoCanario(R), ['can.consertar', R]],
      [() => c.pedirAoSync('/caminho', { p: 1 }), ['sh.pedirAoSync', '/caminho', { p: 1 }]],
      [() => c.backfillVendas('2026-11-14', '2026-11-17', 'amb'), ['bf.backfillVendas', '2026-11-14', '2026-11-17']],
      [() => c.resgatarHistorico({ por: 'alteracao' }), ['bf.resgatarHistorico', { por: 'alteracao' }]],
      [() => c.podarExpedicao(45, 3000), ['podar', 45, 3000]],
    ];
    for (const [chama, esperado] of casos) { log.length = 0; await chama(); assert.deepStrictEqual(log, [esperado], 'a madrugada não chama a peça certa: esperava ' + JSON.stringify(esperado) + ', veio ' + JSON.stringify(log)); }
    log.length = 0; await c.consertarDoCanario(R); assert.strictEqual(log[0][1], R, 'o conserto não recebeu o resultado da conferência (o mesmo objeto)');
    /* o canário das integrações recebe a versão e a sessão DA empresa */
    log.length = 0; await c.canarioCron();
    assert.ok(log.length === 1 && log[0][0] === 'canarioCron' && log[0][1].VERSAO === 'v-amb-teste' && log[0][1].validarSessao === vs && Object.keys(log[0][1]).length === 2, 'o canário das integrações não recebeu a versão e a sessão da empresa');
    /* devoluções (45) e carteira (30) da Shopee, com o pedido à Shopee da empresa */
    for (const [chama, nome, dias] of [[() => c.coletarDevolucoes(), 'sh.coletarDevolucoes', 45], [() => c.coletarDevolucoes(10), 'sh.coletarDevolucoes', 10], [() => c.coletarCarteira(), 'sh.coletarCarteira', 30], [() => c.coletarCarteira(7), 'sh.coletarCarteira', 7]]) {
      log.length = 0; await chama();
      assert.ok(log.length === 1 && log[0][0] === nome && log[0][1] === dias && typeof log[0][2] === 'function', nome + ': janela ou pedido à Shopee errado: ' + JSON.stringify(log));
    }
    { log.length = 0; await c.coletarDevolucoes(); const ped = log[0][2]; log.length = 0; await ped('/x'); assert.deepStrictEqual(log, [['sh.pedirAoSync', '/x']], 'as devoluções não pedem à Shopee da empresa'); }
    /* os Ads da Shopee: a lib compartilhada com a pasta, a leitura/gravação e o pedido à Shopee DA empresa */
    { let visto = null; const volta = trocar({ '../lib/shopee-ads': { coletarAds: async (ctx, dias, loja) => { visto = { ctx, dias, loja }; return { ok: true }; }, resumoAds: () => ({}) } });
      try { await c.coletarAds(35); } finally { volta(); }
      assert.ok(visto && visto.dias === 35 && visto.loja === undefined && visto.ctx.CACHE_DIR === dirC && visto.ctx.readJson === rj && visto.ctx.writeJson === wj && visto.ctx.path === path, 'os Ads não usam a pasta/leitura/gravação da empresa');
      log.length = 0; await visto.ctx.pedirAoSync('/ads'); assert.deepStrictEqual(log, [['sh.pedirAoSync', '/ads']], 'os Ads não pedem à Shopee da empresa'); }
    /* o andamento é o do registro DA empresa (não o da Girassol, que é o padrão do registro) */
    { const b = ESTADO.estado('amb'), g = ESTADO.estado('girassol');
      b.rodando = true; b.de = '2026-07-01'; b.ate = '2026-07-31';
      try { assert.deepStrictEqual([c.backfillEstado().rodando, c.backfillEstado().de], [true, '2026-07-01'], 'a madrugada não lê o andamento da empresa'); assert.ok(!g.rodando); } finally { b.rodando = false; b.de = null; b.ate = null; }
      assert.strictEqual(c.backfillEstado().rodando, false); }
    assert.ok(!('backfillDia' in c), 'sem troca, a madrugada não tem backfill de um dia próprio (refaz pelo backfill da empresa)');
    /* a poda de quem não poda */
    assert.deepStrictEqual(await NE.criar({ empresa: 'good', pecas: pecasFalsas() }).contexto.podarExpedicao(45, 3000), { ok: true, pulado: 'poda do bucket roda na noturna da Girassol' });

    /* `historico` troca só o que traz; null tira a etapa */
    { const meu = { backfillVendas: async () => 'meu-bf', backfillEstado: () => ({ rodando: 'meu' }), backfillDia: async () => 'meu-dia' };
      const h = NE.criar({ empresa: 'good', pecas: P, historico: Object.assign({}, meu, { resgatarHistorico: null }) }).contexto;
      assert.ok(h.backfillVendas === meu.backfillVendas && h.backfillEstado === meu.backfillEstado && h.backfillDia === meu.backfillDia, 'o histórico da empresa não trocou o da peça');
      assert.ok(!('resgatarHistorico' in h), 'resgatarHistorico: null tinha que tirar a etapa do resgate');
      const h2 = NE.criar({ empresa: 'good', pecas: P, historico: { backfillVendas: meu.backfillVendas } }).contexto;
      log.length = 0; await h2.resgatarHistorico({ p: 2 });
      assert.ok(h2.backfillVendas === meu.backfillVendas && !('backfillDia' in h2) && JSON.stringify(log) === JSON.stringify([['bf.resgatarHistorico', { p: 2 }]]), 'o que o histórico não traz tinha que vir da peça');
      /* pela madrugada inteira: a GOOD sem resgate, com o backfill e o andamento dela */
      const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
      const _l = console.log, _e = console.error; console.log = () => {}; console.error = () => {};
      const bloq = (m) => { const M = require(m); const o = { request: M.request, get: M.get }; M.request = () => { throw new Error('rede bloqueada'); }; M.get = M.request; return () => Object.assign(M, o); };
      const solta = [bloq('http'), bloq('https')];
      let st;
      try {
        const rodou = [];
        const nG = NE.criar({ empresa: 'good', pecas: pecasFalsas({ backfill: { backfillVendas: async () => { rodou.push('bf-peca'); return { ok: true }; }, resgatarHistorico: async () => { rodou.push('resg-peca'); return { ok: true }; } } }),
          historico: { backfillVendas: async (de, ate) => { rodou.push('bf-dela:' + de + '>' + ate); return { ok: true }; }, backfillEstado: () => ({ rodando: false }), resgatarHistorico: null } });
        await nG.rotinaNoturna('teste');
        assert.ok(rodou.length === 1 && /^bf-dela:/.test(rodou[0]), 'GOOD: a madrugada não rodou só o backfill dela: ' + rodou.join(','));
        process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'adm-montada';
        const res = { c: 0, b: null };
        await nG.rotas({ method: 'GET', headers: {} }, res, new URL('http://h/good-checkout-offline/noturna-status?k=' + encodeURIComponent(process.env.ADMIN_KEY)));
        st = res.b;
      } finally { solta.forEach((f) => f()); console.log = _l; console.error = _e; global.setTimeout = _st; }
      const nomes = ((st && st.etapas) || []).map((e) => e.nome);
      assert.ok(nomes.length >= 10 && !nomes.some((x) => /resgate/.test(x)) && nomes.some((x) => /poda do bucket/.test(x)), 'GOOD: as etapas da madrugada não são as dela: ' + nomes.join(' | ')); }

    /* as peças são lidas NA HORA: a trocada depois de montar é a que roda */
    { let can = { conferir: async () => 'velho', consertar: async () => 'velho' }, sh = { pedirAoSync: async () => 'velho', coletarDevolucoes: async () => 'velho', coletarCarteira: async () => 'velho' };
      let bf = { backfillVendas: async () => 'velho', resgatarHistorico: async () => 'velho' }, cron = async () => 'velho', poda = null;
      const Pv = pecasFalsas(); for (const k of ['canario', 'shopee', 'backfill', 'canarioCron', 'podarExpedicao']) delete Pv[k];
      Object.defineProperties(Pv, { canario: { enumerable: true, get: () => can }, shopee: { enumerable: true, get: () => sh }, backfill: { enumerable: true, get: () => bf }, canarioCron: { enumerable: true, get: () => cron }, podarExpedicao: { enumerable: true, get: () => poda } });
      const cv = NE.criar({ empresa: 'girassol', pecas: Pv }).contexto;
      can = { conferir: async () => 'novo', consertar: async () => 'novo' }; sh = { pedirAoSync: async () => 'novo', coletarDevolucoes: async () => 'novo', coletarCarteira: async () => 'novo' };
      bf = { backfillVendas: async () => 'novo', resgatarHistorico: async () => 'novo' }; cron = async () => 'novo'; poda = async () => 'novo';
      assert.deepStrictEqual(await Promise.all([cv.conferirMarketplaces(3), cv.consertarDoCanario({}), cv.pedirAoSync('/x'), cv.coletarDevolucoes(), cv.coletarCarteira(), cv.backfillVendas('a', 'b'), cv.resgatarHistorico({}), cv.canarioCron(), cv.podarExpedicao(45, 1)]),
        Array(9).fill('novo'), 'a madrugada guardou a peça de quando montou (as do arquivo nascem depois dela)'); }
  }

  /* ── 3) o horário da madrugada: a conversão, o contrato e o status (os módulos reais conferem o cron e o status na parte 2) ── */
  {
    const CE = require('../lib/checkout/config-empresa');
    assert.deepStrictEqual(['30 3 * * *', '45 3 * * *', '0 4 * * *', '5 23 * * *', '*/5 * * * *', '60 3 * * *', '', null].map(NE.horaDoCron),
      ['03:30', '03:45', '04:00', '23:05', 'cron */5 * * * *', 'cron 60 3 * * *', null, null], 'o horário do cron não é o que ele agenda');
    assert.deepStrictEqual(['girassol', 'amb', 'good'].map((e) => CE.configCheckout(e).madrugada), ['30 3 * * *', '45 3 * * *', '0 4 * * *'], 'o contrato não tem o horário que cada arquivo sempre agendou');
    const regNova = { normalizar: (x) => x, obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_' } : null) };
    assert.strictEqual(CE.configCheckout('nova', { registro: regNova }).madrugada, '30 4 * * *', 'a empresa nova não tem o horário dela (depois das três, antes do galpão)');
    assert.strictEqual(CE.MADRUGADA_PADRAO, '30 4 * * *');
    /* o status: o da empresa montada pela peça; sem cron (a madrugada crua), não inventa */
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'adm-montada';
    const st = async (n, pref) => { const res = { c: 0, b: null }; await n.rotas({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + '/noturna-status?k=' + encodeURIComponent(process.env.ADMIN_KEY))); return res.b; };
    for (const [emp, pref, h] of [['girassol', '/girassol-backup-offline', '03:30'], ['amb', '/amb-checkout-offline', '03:45'], ['good', '/good-checkout-offline', '04:00']]) {
      const n = NE.criar({ empresa: emp, pecas: pecasFalsas() });
      assert.strictEqual(n.contexto.madrugada, CE.configCheckout(emp).madrugada, emp + ': a madrugada não leva o horário do contrato');
      assert.strictEqual((await st(n, pref)).horario, h + ' (America/Sao_Paulo)', emp + ': o status não mostra o horário dela');
    }
    const cru = NE.criarNoturna({ empresa: 'amb', prefixo: '/amb-checkout-offline', VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: (res, c, b) => { res.c = c; res.b = b; } });
    assert.strictEqual((await st(cru, '/amb-checkout-offline')).horario, null, 'sem o horário da empresa, o status inventou um');
  }

  /* ── 2) os módulos reais ── */
  {
    const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
    for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-nm';
    /* as fábricas das peças são embrulhadas pra anotar o objeto que cada arquivo criou (o real, sem mudança) */
    const criados = {};
    const anotar = (tipo, emp, obj) => { (criados[tipo] = criados[tipo] || {})[emp] = obj; return obj; };
    const emb = (mod, fn, tipo, empDe) => { const real = require(mod); return Object.assign({}, real, { [fn]: (...a) => anotar(tipo, empDe(a), real[fn](...a)) }); };
    const montagens = {};
    const realNE = require('../lib/checkout/noturna-empresa');
    const devolve = trocar({
      '../lib/checkout/backfill-empresa': emb('../lib/checkout/backfill-empresa', 'criar', 'backfill', (a) => a[0].empresa),
      '../lib/checkout/canario-empresa': emb('../lib/checkout/canario-empresa', 'criarCanarioDaEmpresa', 'canario', (a) => a[0]),
      '../lib/checkout/cancelados-empresa': emb('../lib/checkout/cancelados-empresa', 'criarCanceladosDaEmpresa', 'cancelados', (a) => a[0]),
      '../lib/checkout/ml-billing': emb('../lib/checkout/ml-billing', 'criarMlBillingDaEmpresa', 'mlBilling', (a) => a[0]),
      '../lib/checkout/vendas-dia-empresa': emb('../lib/checkout/vendas-dia-empresa', 'criar', 'vendasDia', (a) => a[0].empresa),
      '../lib/tiktok-financeiro': emb('../lib/tiktok-financeiro', 'criarColetorDaEmpresa', 'tiktokFinanceiro', (a) => a[0]),
      '../lib/tiktok-completar': emb('../lib/tiktok-completar', 'criarCompletadorDaEmpresa', 'tiktokCompletar', (a) => a[0]),
      '../lib/checkout/noturna-empresa': Object.assign({}, realNE, { criar: (o) => { const r = realNE.criar(o); (montagens[o.empresa] = montagens[o.empresa] || []).push({ o, r }); return r; } }),
    });
    const _log = console.log, _warn = console.warn, _err = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
    const mods = {};
    const ARQ = { girassol: ['girassol-backup-offline', 'gbo-app.js', 'GIRABKP_CACHE_DIR', 'gbo-shopee', 'canario', 'limpeza'], amb: ['amb-checkout-offline', 'index.js', 'AMBBKP_CACHE_DIR', 'amb-shopee', 'amb-canario', null /* o bucket é um só: quem poda é a Girassol */], good: ['good-checkout-offline', 'index.js', 'GOODBKP_CACHE_DIR', 'good-shopee', 'good-canario', null] };
    try {
      for (const [emp, [pasta, entrada, envDir]] of Object.entries(ARQ)) {
        process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-' + emp + '-'));
        mods[emp] = require(path.join(raiz, pasta, entrada));
      }
    } finally { console.log = _log; console.warn = _warn; console.error = _err; devolve(); }
    const sessao = require('../lib/checkout/sessao-operador');
    for (const [emp, [pasta, entrada, , shopeeMod, canarioMod, limpezaMod]] of Object.entries(ARQ)) {
      montagem(emp);   /* o arquivo monta a madrugada pela peça, com a empresa dele, uma vez */
      assert.ok(montagens[emp] && montagens[emp].length === 1, emp + ': a madrugada não foi montada pela peça (uma vez)');
      const { o, r } = montagens[emp][0];
      const P = o.pecas;
      for (const tipo of ['backfill', 'canario', 'cancelados', 'mlBilling', 'vendasDia', 'tiktokFinanceiro', 'tiktokCompletar']) {
        assert.ok(criados[tipo] && criados[tipo][emp], emp + ': o arquivo não criou a peça ' + tipo);
        assert.strictEqual(P[tipo], criados[tipo][emp], emp + ': a madrugada não recebe a peça ' + tipo + ' DESTA empresa');
      }
      const sh = require(path.join(raiz, pasta, shopeeMod));
      assert.ok(P.shopee.pedirAoSync === sh.pedirAoSync && P.shopee.coletarDevolucoes === sh.coletarDevolucoes && P.shopee.coletarCarteira === sh.coletarCarteira, emp + ': a Shopee da madrugada não é a do módulo dela (' + shopeeMod + ')');
      assert.strictEqual(P.canarioCron, require(path.join(raiz, pasta, canarioMod)).canarioCron, emp + ': o canário das integrações não é o dela (' + canarioMod + ')');
      if (limpezaMod) assert.strictEqual(P.podarExpedicao, require(path.join(raiz, pasta, limpezaMod)).podarExpedicao, emp + ': não poda o bucket com a poda dela');
      else assert.strictEqual(P.podarExpedicao, null, emp + ': poda o bucket');
      const base = require(path.join(raiz, pasta, 'base.js'));
      assert.ok(P.CACHE_DIR === base.CACHE_DIR && P.readJson === base.readJson && P.writeJson === base.writeJson && P.ehAdmin === base.ehAdmin && P.json === base.json && P.validarSessao === sessao.validarSessao, emp + ': o básico da madrugada não é o da base dela');
      const ver = /const VERSAO\s+= '([^']+)';/.exec(fs.readFileSync(path.join(raiz, pasta, entrada)).toString('utf8'))[1];
      assert.strictEqual(P.VERSAO, ver, emp + ': a versão da madrugada não é a do arquivo');
      /* a rota de status da madrugada responde no prefixo da empresa, com a versão dela (pelo roteador de produção) */
      const h = mods[emp].routes(async () => ({}));
      const u = new URL('http://x/' + pasta + '/noturna-status?k=' + encodeURIComponent(process.env.ADMIN_KEY));
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
      assert.strictEqual(res._s, 200, emp + ': /noturna-status não respondeu: ' + res._b.slice(0, 200));
      assert.strictEqual(JSON.parse(res._b).versao, ver, emp + ': o status da madrugada não é o desta empresa');
      /* 17/11 (passo 13): o horário que o arquivo agenda (o cron entregue ao orquestrador) é o do contrato, e o status mostra ele */
      const HORA = { girassol: ['30 3 * * *', '03:30'], amb: ['45 3 * * *', '03:45'], good: ['0 4 * * *', '04:00'] }[emp];
      assert.strictEqual(mods[emp].crons.noturna, HORA[0], emp + ': a madrugada não é agendada no horário dela');
      assert.strictEqual(JSON.parse(res._b).horario, HORA[1] + ' (America/Sao_Paulo)', emp + ': o status da madrugada não mostra o horário em que ela roda');
      assert.strictEqual(r.contexto.prefixo, '/' + pasta);
    }
    /* o histórico: a Girassol e a AMB pela peça; a GOOD troca pelo dela */
    for (const emp of ['girassol', 'amb']) assert.strictEqual(montagens[emp][0].o.historico, undefined, emp + ': troca o histórico da madrugada');
    const H = montagens.good[0].o.historico;
    assert.deepStrictEqual(Object.keys(H).sort(), ['backfillDia', 'backfillEstado', 'backfillVendas', 'resgatarHistorico'], 'GOOD: o histórico dela não é o de antes');
    assert.strictEqual(H.resgatarHistorico, null, 'GOOD: a madrugada ganhou um 2º resgate (a rotina diária já resgata)');
    { const realDia = require('../lib/checkout/diario-historico'); let d0 = null;
      const volta = trocar({ '../lib/checkout/diario-historico': Object.assign({}, realDia, { rodarDiario: async (d) => { d0 = d; return { ok: true }; } }) });
      const _l2 = console.log; console.log = () => {};
      let rG; try { rG = await montagens.good[0].r.contexto.backfillVendas(); } finally { console.log = _l2; volta(); }
      assert.ok(d0 && d0.empresa === 'good' && rG && rG.ok === true, 'GOOD: o backfill da madrugada não é a rotina diária dela'); }
    /* o andamento e o backfill de um dia da GOOD respeitam a trava dela (a vaga do registro, a rotina diária, o backfill dela) */
    { const b = ESTADO.estado('good'); b.rodando = true; b.de = '2026-10-01'; b.ate = '2026-10-02';
      try {
        assert.strictEqual(H.backfillEstado().rodando, true, 'GOOD: o andamento que a madrugada lê ignora a vaga do registro dela');
        assert.deepStrictEqual(await H.backfillDia('2026-10-05'), { ok: false, msg: 'backfill da GOOD em curso' }, 'GOOD: o backfill de um dia atropela o backfill dela');
      } finally { b.rodando = false; b.de = null; b.ate = null; }
      assert.strictEqual(H.backfillEstado().rodando, false); }
  }
  console.log('ok — o horário da madrugada é do contrato: o cron agendado e o status de cada empresa (03:30, 03:45, 04:00; a nova 04:30), sem inventar quando não há');
  console.log('ok — o contexto da madrugada da empresa é a peça (lib/checkout/noturna-empresa): prefixo e token do contrato; cada campo pela peça DA empresa, lida na hora (as do arquivo nascem depois); o andamento do registro dela; Ads pela lib com a pasta e a Shopee dela; só a Girassol poda (as outras dizem onde roda); a GOOD troca só o histórico (rotina diária, andamento e trava dela, sem 2º resgate); nas três, pelos módulos reais, as peças entregues são as do arquivo e o status responde no prefixo dela');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
