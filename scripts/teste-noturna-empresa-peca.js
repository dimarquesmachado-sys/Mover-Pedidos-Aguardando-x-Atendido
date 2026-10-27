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
  let resultado;
  try {
    // Girassol: idêntica
    const gv = await rodar(antigo('girassol-backup-offline', 'noturna-girassol-antes.js'));
    const gn = await rodar(require('../girassol-backup-offline/noturna.js').criarNoturna);
    assert.ok(gn.log.length >= 10, 'a madrugada da Girassol não rodou as etapas: ' + gn.log.length);
    assert.deepStrictEqual(gn.log, gv.log, 'Girassol: as chamadas (ou a ordem) mudaram');
    assert.ok(gn.etapas.length >= 10, 'não li o resultado das etapas pela rota de status: ' + JSON.stringify(gn.etapas).slice(0, 200));
    assert.deepStrictEqual(gn.etapas, gv.etapas, 'Girassol: o resultado das etapas mudou');
    // AMB: as mesmas chamadas, na ordem da Girassol
    const av = await rodar(antigo('amb-checkout-offline', 'noturna-amb-antes.js'));
    const an = await rodar(require('../amb-checkout-offline/amb-noturna.js').criarNoturna);
    assert.deepStrictEqual(an.log.slice().sort(), av.log.slice().sort(), 'AMB: mudaram as chamadas da madrugada (não só a ordem)');
    assert.deepStrictEqual(an.log.map((l) => l.replace(/amb/g, 'EMP')), gn.log.map((l) => l.replace(/girassol/g, 'EMP')), 'AMB: a ordem não é a da madrugada única');
    assert.ok(an.log.some((l) => l === 'backfillVendas(' + an.log.find((x) => x.startsWith('backfillVendas')).slice(15).split(',').slice(0, 2).join(',') + ',amb)'), 'AMB: o backfill não foi com a empresa dela');
    const iTk = an.log.findIndex((l) => l.startsWith('coletarFinanceiroTikTok')), iBf = an.log.findIndex((l) => l.startsWith('backfillVendas'));
    assert.ok(iTk >= 0 && iBf >= 0 && iTk < iBf, 'AMB: o financeiro do TikTok tem que ser coletado ANTES do backfill');
    resultado = 'ok';
  } finally {
    for (const [k, v] of Object.entries(salvos)) { if (v) require.cache[k] = v; else delete require.cache[k]; }
    console.log = _log; console.error = _err; global.setTimeout = _st;
  }
  // as rotas no prefixo de cada uma
  for (const [arq, emp, pref] of [['girassol-backup-offline/noturna.js', 'girassol', '/girassol-backup-offline'], ['amb-checkout-offline/amb-noturna.js', 'amb', '/amb-checkout-offline']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("empresa: '" + emp + "', prefixo: '" + pref + "'") && /require\('\.\.\/lib\/checkout\/noturna-empresa'\)/.test(s), arq + ': não é a madrugada única com a empresa dela');
  }
  console.log('ok — madrugada única: a Girassol igual ao de antes; a AMB com as mesmas chamadas, agora na ordem certa (TikTok antes do backfill)');
  process.exit(0);
})().catch((e) => { console.log = console.log; console.error('FALHOU:', e.message); process.exit(1); });
