'use strict';
/* 27/10 — os DIAS DA SHOPEE SEM REPASSE são refeitos sozinhos (caso real: a Partner Key da Girassol venceu em 23/10 e
   as vendas da Shopee até 27/10 ficaram com a comissão do Bling, sem nada anotado pra refazer). Prova:
   · a peça: o backfill anota os dias com pedido sem repasse e LIMPA os do período que saíram completos; tentativas;
   · o BACKFILL DE PRODUÇÃO (o compartilhado, com o contexto da GOOD): repasse falhando → o dia fica anotado na pasta da
     GOOD; repasse voltando → o dia sai; e o da AMB tem os mesmos ganchos;
   · a MADRUGADA: com a Shopee recusando a chave, pula; senão refaz os 3 mais antigos; com 7 tentativas, desiste;
   · as três empresas entregam a pasta delas (a GOOD, o backfill de um dia com a trava dela). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const RP = require('../lib/checkout/repasse-pendente');
const _logO = console.log, _errO = console.error;   /* os originais: a madrugada é rodada em silêncio, e a falha tem que aparecer */

(async () => {
  // 1) a peça
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  RP.anotarRodada(d1, '2026-10-23', '2026-10-27', { '2026-10-23': 2, '2026-10-25': 1 });
  assert.deepStrictEqual(RP.listar(d1).map((x) => x.dia + ':' + x.pedidos + ':' + x.tentativas), ['2026-10-23:2:0', '2026-10-25:1:0'], 'não anotou os dias sem repasse');
  RP.anotarRodada(d1, '2026-10-25', '2026-10-25', {});   /* refeito completo */
  RP.anotarRodada(d1, '2026-10-23', '2026-10-23', { '2026-10-23': 1 });   /* refeito e ainda falhou */
  assert.deepStrictEqual(RP.listar(d1).map((x) => x.dia + ':' + x.pedidos + ':' + x.tentativas), ['2026-10-23:1:1'], 'não limpou o dia completo ou não contou a tentativa');
  fs.rmSync(d1, { recursive: true, force: true });

  // 2) a madrugada
  const dN = fs.mkdtempSync(path.join(os.tmpdir(), 'rpn-'));
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  process.env.ADMIN_KEY = 'adm-rp';
  const rodar = async (prova, pend) => {
    fs.writeFileSync(path.join(dN, RP.ARQ), JSON.stringify({ dias: pend }));
    try { fs.unlinkSync(path.join(dN, '_shopee_chave_prova.json')); } catch (e) {}
    if (prova) fs.writeFileSync(path.join(dN, '_shopee_chave_prova.json'), JSON.stringify(prova));
    const refeitos = [];
    const n = require('../lib/checkout/noturna-empresa').criarNoturna({ empresa: 'girassol', prefixo: '/girassol-backup-offline', cacheDir: dN,
      backfillDia: async (d) => { refeitos.push(d); RP.anotarRodada(dN, d, d, {}); return { ok: true, desfecho: 'ok' }; },
      mlBillingSync: async () => ({ ok: true }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }), mlSyncFees: async () => ({}), varrerCancelados: async () => ({}),
      VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: (res, c, b) => { res.c = c; res.b = b; } });
    await n.rotinaNoturna('teste');
    const res = { c: 0, b: null };
    await n.rotas({ method: 'GET', headers: {} }, res, new URL('http://h/girassol-backup-offline/noturna-status?k=adm-rp'));
    return { refeitos, etapa: (res.b.etapas || []).find((e) => /sem repasse/.test(e.nome)), restam: RP.listar(dN).map((x) => x.dia) };
  };
  const pend = { '2026-10-23': { pedidos: 1, tentativas: 0 }, '2026-10-24': { pedidos: 1, tentativas: 0 }, '2026-10-25': { pedidos: 1, tentativas: 0 }, '2026-10-26': { pedidos: 1, tentativas: 0 } };
  let r = await rodar({ quando: new Date().toISOString(), recusou: 'error_partner_key' }, pend);
  assert.ok(r.refeitos.length === 0 && r.etapa && r.etapa.estado === 'pulado' && r.restam.length === 4, 'com a Shopee recusando a chave tinha que PULAR: ' + JSON.stringify(r));
  r = await rodar({ quando: new Date().toISOString(), assinaturaOk: true }, pend);
  assert.deepStrictEqual(r.refeitos, ['2026-10-23', '2026-10-24', '2026-10-25'], 'não refez os 3 MAIS ANTIGOS');
  assert.ok(r.etapa && r.etapa.estado === 'ok' && r.restam.length === 1 && /restam 1/.test(r.etapa.detalhe || r.etapa.resultado || ''), 'a etapa não contou o que restou: ' + JSON.stringify(r.etapa));
  r = await rodar(null, { '2026-10-20': { pedidos: 2, tentativas: 7 }, '2026-10-21': { pedidos: 1, tentativas: 2 } });
  assert.ok(r.refeitos.join() === '2026-10-21' && r.restam.length === 0, 'não desistiu do dia com 7 tentativas: ' + JSON.stringify(r));
  console.log = _log; console.error = _err; global.setTimeout = _st;
  fs.rmSync(dN, { recursive: true, force: true });

  // 3) os ganchos nos dois backfills e o contexto das três
  for (const [arq, cache] of [['girassol-backup-offline/gbo-app.js', '_CACHE_DIR'], ['amb-checkout-offline/index.js', 'CACHE_DIR']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/_backfill\.shopee\.sem_repasse_por_dia\[dtP\] = /.test(s) && s.includes("require('../lib/checkout/repasse-pendente').anotarRodada(" + cache + ', de, ate,'), arq + ': o backfill não anota os dias sem repasse');
    const iT = s.indexOf("_backfill.fase = _backfill.erros ? 'concluido_com_erros' : 'concluido';"), iA = s.indexOf("repasse-pendente').anotarRodada(");
    assert.ok(iT > 0 && iA > iT && iA - iT < 600, arq + ': a anotação não está logo depois da troca feita');
  }
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/  cacheDir: CACHE_DIR,\n  backfillDia: async \(dia\) => \{\n    if \(_backfillGoodOcupado\(\)\) return/.test(gs), 'a GOOD não entrega o backfill de um dia com a trava dela');
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) assert.ok(/  cacheDir: CACHE_DIR,   \/\* 27\/10: os dias da Shopee sem repasse/.test(fs.readFileSync(path.join(raiz, arq), 'utf8')), arq + ': a madrugada não recebe a pasta');
  console.log('ok — dias da Shopee sem repasse: anotados pelo backfill, limpos quando completos, refeitos pela madrugada (3 por noite, pula com a chave recusada, desiste em 7)');
  process.exit(0);
})().catch((e) => { console.log = _logO; console.error = _errO; console.error('FALHOU:', e.message); process.exit(1); });
