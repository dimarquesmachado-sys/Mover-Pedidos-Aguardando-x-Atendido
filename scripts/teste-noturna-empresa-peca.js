'use strict';
/* 26/10 — a MADRUGADA ÚNICA (lib/checkout/noturna-empresa): era noturna.js (Girassol) e amb-noturna.js (AMB) — as mesmas
   etapas, em ORDENS diferentes (a AMB fazia o backfill ANTES de coletar o financeiro do TikTok; a ordem certa é coletar
   antes, pra o backfill já gravar com a tarifa real). Prova, rodando a madrugada inteira com peças falsas (e o TikTok e a
   Magalu de mentira):
   · Girassol: as MESMAS chamadas, na MESMA ordem, com os MESMOS resultados de cada etapa que o código de antes;
   · AMB: as MESMAS chamadas (nenhuma a mais, nenhuma a menos) e as mesmas etapas — só a ordem passa a ser a da Girassol;
   · cada uma com a empresa dela em cada chamada, e as rotas no prefixo dela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  // o TikTok e a Magalu de mentira (sem rede)
  const falsos = {
    [require.resolve(path.join(raiz, 'tiktok-oauth', 'index.js'))]: { chamar: async () => ({ ok: true, http: 200, corpo: { code: 0, data: { return_orders: [] } } }), lerToken: () => ({ access_token: 'x' }) },
    [require.resolve(path.join(raiz, 'magalu-oauth', 'index.js'))]: { coletarCancelados: async (e) => ({ ok: true, vistos: 2, novos: 1, empresa: e }) },
  };
  const salvos = {};
  for (const [k, v] of Object.entries(falsos)) { salvos[k] = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports: v }; }
  const rodar = async (criarNoturna) => {
    const log = [];
    const f = (nome, ret) => async (...a) => { log.push(nome + '(' + a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',') + ')'); return typeof ret === 'function' ? ret(...a) : ret; };
    const ctx = {
      mlBillingSync: f('mlBillingSync', { ok: true, meses: 2 }), backfillVendas: f('backfillVendas', { ok: true }), backfillEstado: () => ({ rodando: false }),
      mlSyncFees: f('mlSyncFees', { ok: 3, total: 4, falhas: 1 }), varrerCancelados: f('varrerCancelados', { ok: true }), canarioCron: f('canarioCron', undefined),
      podarExpedicao: f('podarExpedicao', { apagados: 1, mb: 2 }), resgatarHistorico: f('resgatarHistorico', { ok: true, faltando: 0, candidatos: 5, resgatados: [], adiados: [] }),
      coletarDevolucoes: f('coletarDevolucoes', { novas: 1, vistas: 2, guardadas: 3 }), coletarCarteira: f('coletarCarteira', { novas: 0, vistas: 1, guardadas: 1 }),
      coletarAds: f('coletarAds', { ok: true, dias: 3 }), conferirMarketplaces: f('conferirMarketplaces', { ok: true, por_canal: { ml: { verificado: true, faltando_no_bling: 0, no_marketplace: 2 } }, alertas: [] }),
      consertarDoCanario: f('consertarDoCanario', { tentou: 0 }), coletarFinanceiroTikTok: f('coletarFinanceiroTikTok', { ok: true, pedidos_novos: 1 }),
      completarTarifaTikTok: f('completarTarifaTikTok', { ok: true, linhas_atualizadas: 0 }), VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: () => {},
    };
    ctx.json = (res, c, b) => { res.c = c; res.b = b; };
    process.env.ADMIN_KEY = 'adm-n';
    const n = criarNoturna(ctx);
    await n.rotinaNoturna('teste');
    /* o resultado de cada etapa, pela rota de status (só admin) — a mesma que o dono abre */
    const rot = n.rotas;
    let st = null;
    for (const pref of ['/girassol-backup-offline', '/amb-checkout-offline']) {
      const res = { c: 0, b: null };
      if (await rot({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + '/noturna-status?k=adm-n'))) { st = res.b; break; }
    }
    const ult = st && (st.ultima || st.ultimaRodada || st);
    const lista = (ult && (ult.etapas || ult.passos)) || [];
    return { log, etapas: lista.map((e) => (e.nome || e.etapa) + ' => ' + (e.ok === false || e.erro ? 'ERRO ' + (e.erro || '') : 'ok ' + (e.resultado || e.msg || ''))) };
  };
  const antigo = (pasta, fixture) => {
    const arq = path.join(raiz, pasta, '_noturna_antiga_teste.js');
    fs.writeFileSync(arq, fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8'));
    try { return require(arq).criarNoturna; } finally { try { fs.unlinkSync(arq); } catch (e) {} }
  };
  /* 17/11 (montarCheckout, passo 12): os embrulhos de uma linha (noturna.js, amb-noturna.js) saíram — o arquivo de cada empresa
     monta a madrugada pela peça (`criar`, que põe a empresa e o prefixo do contrato). A madrugada única é a mesma `criarNoturna`
     com a empresa e o prefixo de cada uma (o que os embrulhos faziam); a montagem tem o teste dela (scripts/teste-noturna-montada.js) */
  const NE = require('../lib/checkout/noturna-empresa');
  const daEmpresa = (emp) => (ctx) => NE.criarNoturna(Object.assign({}, ctx, { empresa: emp, prefixo: '/' + require('../lib/checkout/config-empresa').configCheckout(emp).modulo }));
  let resultado;
  try {
    // Girassol: idêntica
    const gv = await rodar(antigo('girassol-backup-offline', 'noturna-girassol-antes.js'));
    const gn = await rodar(daEmpresa('girassol'));
    assert.ok(gn.log.length >= 10, 'a madrugada da Girassol não rodou as etapas: ' + gn.log.length);
    assert.deepStrictEqual(gn.log, gv.log, 'Girassol: as chamadas (ou a ordem) mudaram');
    assert.ok(gn.etapas.length >= 10, 'não li o resultado das etapas pela rota de status: ' + JSON.stringify(gn.etapas).slice(0, 200));
    assert.deepStrictEqual(gn.etapas, gv.etapas, 'Girassol: o resultado das etapas mudou');
    // AMB: as mesmas chamadas, na ordem da Girassol
    const av = await rodar(antigo('amb-checkout-offline', 'noturna-amb-antes.js'));
    const an = await rodar(daEmpresa('amb'));
    assert.deepStrictEqual(an.log.slice().sort(), av.log.slice().sort(), 'AMB: mudaram as chamadas da madrugada (não só a ordem)');
    assert.deepStrictEqual(an.log.map((l) => l.replace(/amb/g, 'EMP')), gn.log.map((l) => l.replace(/girassol/g, 'EMP')), 'AMB: a ordem não é a da madrugada única');
    assert.ok(an.log.some((l) => l === 'backfillVendas(' + an.log.find((x) => x.startsWith('backfillVendas')).slice(15).split(',').slice(0, 2).join(',') + ',amb)'), 'AMB: o backfill não foi com a empresa dela');
    const iTk = an.log.findIndex((l) => l.startsWith('coletarFinanceiroTikTok')), iBf = an.log.findIndex((l) => l.startsWith('backfillVendas'));
    assert.ok(iTk >= 0 && iBf >= 0 && iTk < iBf, 'AMB: o financeiro do TikTok tem que ser coletado ANTES do backfill');
    /* Codex #748 (P1): cada empresa com a SUA trava e o SEU status — com a madrugada da Girassol ainda rodando (o billing
       dela pendurado), a da AMB tem que rodar as etapas DELA, e cada rota de status mostra a rodada da própria empresa */
    { let soltar; const pendura = new Promise((r) => { soltar = r; });
      const chamadasA = [];
      const ctxBase = (emp, billing) => ({ mlBillingSync: billing, backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }), mlSyncFees: async () => ({}),
        varrerCancelados: async () => ({}), canarioCron: async () => undefined, podarExpedicao: async () => ({}), conferirMarketplaces: async () => ({ ok: true, por_canal: {}, alertas: [] }),
        coletarFinanceiroTikTok: async () => ({ ok: true }), completarTarifaTikTok: async () => ({ ok: true }), VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false,
        json: (res, c, b) => { res.c = c; res.b = b; } });
      const g = daEmpresa('girassol')(ctxBase('girassol', async () => { await pendura; return { ok: true }; }));
      const a = daEmpresa('amb')(ctxBase('amb', async () => { chamadasA.push('billing-amb'); return { ok: true }; }));
      const pg = g.rotinaNoturna('teste');
      await new Promise((r) => _st(r, 5));
      const ra = await a.rotinaNoturna('teste');
      assert.ok(chamadasA.includes('billing-amb') && ra && ra.rodando === false && ra.etapas.length > 3, 'a madrugada da AMB não rodou enquanto a da Girassol estava rodando (trava dividida)');
      const st = async (m, pref) => { const res = { c: 0, b: null }; await m.rotas({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + '/noturna-status?k=adm-n')); return res.b; };
      const sg = await st(g, '/girassol-backup-offline'), sa = await st(a, '/amb-checkout-offline');
      assert.ok(sg.rodando === true && sa.rodando === false, 'o status de uma empresa mostrou a rodada da outra');
      soltar(); await pg; }
    /* 27/10 — a GOOD na madrugada única: roda as etapas dela na ordem da madrugada (TikTok antes do backfill); com a rotina
       diária desligada (GOOD_DIARIO_HISTORICO=0), a etapa do backfill acusa em vez de dizer que rodou. 17/11 (passo 12): montada
       pela peça como as outras — a Shopee dela (devoluções, carteira, Ads), a poda dizendo que roda na madrugada da Girassol, e
       SEM a etapa do resgate (a rotina diária dela já resgata) */
    { /* 17/11 (passo 12): a GOOD monta a madrugada pela peça com as peças dela (as mesmas das outras) e troca só o histórico */
      const bloco = require('./_fonte-noturna').montagem('good');
      const chaves = (bloco.match(/^    (?:get )?([a-zA-Z_]+)(?:\(\) \{|:)/gm) || []).map((x) => x.trim().replace(/^get /, '').replace(/(\(\) \{|:)$/, '')).sort();
      assert.deepStrictEqual(chaves, ['backfill', 'backfillDia', 'backfillEstado', 'backfillVendas', 'canario', 'canarioCron', 'cancelados', 'mlBilling', 'podarExpedicao', 'resgatarHistorico', 'shopee', 'tiktokCompletar', 'tiktokFinanceiro', 'vendasDia'].sort(),
        'a GOOD não entrega à madrugada exatamente as peças dela e o histórico próprio: ' + chaves.join(','));
      assert.ok(bloco.includes('    CACHE_DIR, readJson, writeJson, VERSAO, validarSessao, ehAdmin, json,'), 'GOOD: faltou o básico da madrugada');
      const logG = [];
      const fG = (nome, ret) => async (...a) => { logG.push(nome); return ret; };
      const n = NE.criar({ empresa: 'good', pecas: require('./_fonte-noturna').pecasFalsas({
        mlBilling: { mlBillingSync: fG('billing', { ok: true }) }, vendasDia: { mlSyncFees: fG('pesca', {}) }, cancelados: { varrerCancelados: fG('cancelados', {}) },
        tiktokFinanceiro: fG('tiktok', { ok: true }), tiktokCompletar: fG('completar', { ok: true }),
        canario: { conferir: fG('canario', { ok: true, por_canal: {}, alertas: [] }), consertar: fG('conserto', {}) }, canarioCron: fG('integracoes', undefined),
        shopee: { pedirAoSync: fG('pedirAoSync', { ok: true }), coletarDevolucoes: fG('devolucoes', { novas: 0, vistas: 0, guardadas: 0 }), coletarCarteira: fG('carteira', { novas: 0, vistas: 0, guardadas: 0 }) },
        backfill: { backfillVendas: fG('backfill-da-peca', { ok: true }), resgatarHistorico: fG('resgate-da-peca', { ok: true }) } }),
      historico: { backfillVendas: fG('backfill', { ok: false, msg: 'GOOD_DIARIO_HISTORICO=0 (a rotina diária do histórico está desligada)' }), backfillEstado: () => ({ rodando: false }), resgatarHistorico: null } });
      await n.rotinaNoturna('teste');
      assert.ok(logG.indexOf('tiktok') >= 0 && logG.indexOf('tiktok') < logG.indexOf('backfill'), 'GOOD: o TikTok não veio antes do backfill: ' + logG.join(','));
      for (const k of ['billing', 'backfill', 'pesca', 'cancelados', 'completar', 'canario', 'conserto', 'integracoes', 'devolucoes', 'carteira']) assert.ok(logG.includes(k), 'GOOD: a madrugada não rodou ' + k);
      assert.ok(!logG.includes('backfill-da-peca') && !logG.includes('resgate-da-peca'), 'GOOD: a madrugada rodou o histórico da peça em vez do dela: ' + logG.join(','));
      const res = { c: 0, b: null };
      await n.rotas({ method: 'GET', headers: {} }, res, new URL('http://h/good-checkout-offline/noturna-status?k=adm-n'));
      const et = (res.b && res.b.etapas) || [];
      assert.ok(!et.some((e) => /resgate/i.test(e.nome)), 'GOOD: apareceu a etapa do resgate (a rotina diária já resgata): ' + et.map((e) => e.nome).join(' | '));
      const poda = et.find((e) => /poda do bucket/.test(e.nome));
      assert.ok(poda && poda.estado === 'ok' && poda.detalhe === 'não roda nesta empresa — poda do bucket roda na noturna da Girassol', 'GOOD: a poda não diz onde roda: ' + JSON.stringify(poda));
      const bf = et.find((e) => /backfill/.test(e.nome));
      assert.ok(bf && bf.estado === 'erro' && /GOOD_DIARIO_HISTORICO=0/.test(bf.erro || bf.detalhe || ''), 'GOOD: com a rotina diária desligada, a etapa do backfill não acusou: ' + JSON.stringify(bf)); }
    /* Codex #749: (a) com um backfill da empresa rodando, a correção da tarifa do TikTok PULA (não corrige linhas que o
       backfill está trocando) — pela peça, vale pras três; (b) na GOOD, a rotina diária que PAROU não vira "ok" */
    { const chamou = [];
      const n2 = require('../lib/checkout/noturna-empresa').criarNoturna({ empresa: 'amb', prefixo: '/amb-checkout-offline',
        mlBillingSync: async () => ({ ok: true }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: true, de: '2026-01-01', ate: '2026-01-10' }),
        mlSyncFees: async () => ({}), varrerCancelados: async () => ({}), completarTarifaTikTok: async () => { chamou.push('completar'); return { ok: true }; },
        VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: (res, c, b) => { res.c = c; res.b = b; } });
      await n2.rotinaNoturna('teste');
      const res2 = { c: 0, b: null };
      await n2.rotas({ method: 'GET', headers: {} }, res2, new URL('http://h/amb-checkout-offline/noturna-status?k=adm-n'));
      const ec = (res2.b.etapas || []).find((e) => /tarifa do TikTok/.test(e.nome));
      assert.ok(chamou.length === 0 && ec && ec.estado === 'pulado', 'com backfill rodando, a correção da tarifa tinha que PULAR: ' + JSON.stringify(ec)); }
    { const gsrc = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
      assert.ok(/if \(!r \|\| r\.estado !== 'ok'\) return Object\.assign\(\{\}, r \|\| \{\}, \{ ok: false, msg: /.test(gsrc) && /return Object\.assign\(\{\}, r, \{ ok: true \}\);/.test(gsrc),
        'GOOD: a rotina diária que parou ainda pode virar "ok" na madrugada'); }
    resultado = 'ok';
  } finally {
    for (const [k, v] of Object.entries(salvos)) { if (v) require.cache[k] = v; else delete require.cache[k]; }
    console.log = _log; console.error = _err; global.setTimeout = _st;
  }
  // as rotas no prefixo de cada uma — 17/11 (passo 12): o prefixo sai do contrato, e as três montam a madrugada pela peça
  for (const [emp, pref] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    require('./_fonte-noturna').montagem(emp);
    assert.strictEqual(NE.criar({ empresa: emp, pecas: require('./_fonte-noturna').pecasFalsas() }).contexto.prefixo, pref, emp + ': a madrugada não responde no prefixo dela');
  }
  assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'noturna.js')) && !fs.existsSync(path.join(raiz, 'amb-checkout-offline', 'amb-noturna.js')), 'voltou o embrulho da madrugada');
  console.log('ok — madrugada única: a Girassol igual ao de antes; a AMB com as mesmas chamadas, agora na ordem certa (TikTok antes do backfill)');
  process.exit(0);
})().catch((e) => { console.log = console.log; console.error('FALHOU:', e.message); process.exit(1); });
