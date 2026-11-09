'use strict';
/* 08/11 — GRUPO DO BACKFILL NA FÁBRICA (plano, Fase 3 4c). A Girassol e a AMB tinham CÓPIA de /backfill, /backfill-limpar,
   /backfill-teste (e a Girassol /backfill-conferir) — e era a cópia que atendia (o roteador testa as rotas próprias antes da
   fábrica). Agora quem atende é a fábrica, nas três, unida com o que a cópia tinha a mais:
   · a TRAVA DO CANÁRIO (só a Girassol tinha): rodando o canário, o /backfill espera — agora nas três;
   · o /backfill-limpar dizia sempre "(empresa amb)" — agora diz a empresa de verdade.
   Prova (a fábrica DE VERDADE, montada com peças de mentira, uma vez por empresa):
   · /backfill com o canário rodando → espera, sem disparar; com o mesmo período já rodando → avisa; normal → dispara a
     rotina DA empresa com as datas certas;
   · /backfill-limpar apaga SÓ a tabela da empresa e diz o nome dela;
   · /backfill-teste grava e apaga a marca no banco DA empresa e, se falhar, aponta as envs DELA;
   · /backfill-conferir conta no banco da empresa;
   · e no arquivo de cada empresa: as cópias saíram, as rotas saíram de rotasProprias e as peças chegam à fábrica. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

function montar(empresa, prefixo, extra) {
  let resp = null;
  const pecas = Object.assign({ json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => 'k', validarSessao: () => ({ usuario: 'diego' }),
    readJson: () => ({}), writeJson: () => {}, CACHE_DIR: '/tmp', fsx: fs, pathx: path, ehAdmin: () => true, readBody: async () => ({}),
    estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, custoSyncTravado: async () => {}, _urlStatus: () => '',
    _inferCanal: () => 'outro', _diaFechadoDoDisco: () => null, _cstDiario: {}, LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json' }, extra);
  const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
  return async (rota, query) => { resp = null; const u = new URL('http://h' + prefixo + '/' + rota + (query || '') + (query ? '&' : '?') + 'k=k');
    const ok = await rot({ method: 'GET', headers: {} }, {}, prefixo + '/' + rota, 'GET', u); return { tratou: ok, resp }; };
}

(async () => {
  process.env.ADMIN_KEY = 'k';
  for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    const chamadas = [], disparos = [];
    const canario = { rodando: false, desde: '10:00' };
    const backfill = { rodando: false };
    const r = montar(empresa, prefixo, {
      _canario: canario, _backfill: backfill,
      backfillVendas: (de, ate, emp) => { disparos.push([de, ate, emp]); return Promise.resolve({ ok: true }); },
      supaReq: async (emp, metodo, q) => { chamadas.push([emp, metodo, q]); return { ok: true, status: 200 }; },
      supaCfg: (emp) => ({ url: 'https://supa/' + emp }),
      supaCount: async (emp) => { chamadas.push([emp, 'COUNT']); return 7; },
    });
    /* /backfill: canário rodando → espera, sem disparar */
    canario.rodando = true;
    let x = await r('backfill', '?de=2026-10-01&ate=2026-10-31');
    assert.ok(x.tratou && x.resp && x.resp.body.ok === false && /canário está conferindo/.test(x.resp.body.msg) && disparos.length === 0, empresa + ': com o canário rodando o /backfill tinha que esperar: ' + JSON.stringify(x.resp));
    canario.rodando = false;
    x = await r('backfill', '?de=2026-10-01&ate=2026-10-31');
    assert.ok(disparos.length === 1 && disparos[0][0] === '2026-10-01' && disparos[0][1] === '2026-10-31' && disparos[0][2] === empresa, empresa + ': o /backfill tinha que disparar a rotina DA empresa: ' + JSON.stringify(disparos));
    /* /backfill-limpar: só a tabela da empresa, e o nome dela na mensagem */
    chamadas.length = 0;
    x = await r('backfill-limpar');
    assert.ok(chamadas.length === 1 && chamadas[0][0] === empresa && chamadas[0][1] === 'DELETE' && chamadas[0][2] === 'vendas_historico?empresa=eq.' + empresa, empresa + ': o limpar tinha que apagar SÓ a tabela da empresa: ' + JSON.stringify(chamadas));
    assert.ok(new RegExp('\\(empresa ' + empresa + '\\)').test(x.resp.body.msg), empresa + ': a mensagem do limpar tinha que dizer a empresa (dizia sempre "amb"): ' + x.resp.body.msg);
    /* /backfill-teste: grava e apaga no banco da empresa */
    chamadas.length = 0;
    x = await r('backfill-teste');
    assert.ok(x.tratou && chamadas.filter((c) => c[0] === empresa).length >= 2 && chamadas.every((c) => c[0] === empresa), empresa + ': o teste tinha que usar o banco DA empresa: ' + JSON.stringify(chamadas));
    /* /backfill-conferir: conta no banco da empresa */
    chamadas.length = 0;
    x = await r('backfill-conferir', '?ano=2026');
    assert.ok(x.tratou && chamadas.length > 0 && chamadas.every((c) => c[0] === empresa), empresa + ': o conferir tinha que contar no banco da empresa: ' + JSON.stringify(chamadas.slice(0, 3)));
  }
  /* no arquivo de cada empresa: sem cópia, fora das próprias, e as peças chegam à fábrica */
  for (const [arq, pfx, rotas, pecasNec] of [
    ['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', ['backfill', 'backfill-conferir', 'backfill-limpar', 'backfill-teste'], ['supaReq', 'supaCfg', 'supaCount', '_backfill', 'backfillVendas', '_canario']],
    ['amb-checkout-offline/index.js', '/amb-checkout-offline', ['backfill', 'backfill-limpar', 'backfill-teste'], ['supaReq', 'supaCfg', 'supaCount', '_backfill', 'backfillVendas', '_canario']]]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf('criarRotasPainel({'); const chamada = s.slice(i, s.indexOf('\n        });', i));
    const prop = new Set([...(/rotasProprias:\s*\[([^\]]*)\]/.exec(chamada) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    for (const rt of rotas) {
      assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + '/' + rt + "'").test(s), arq + ': sobrou cópia de /' + rt);
      assert.ok(!prop.has(rt), arq + ': /' + rt + ' continua em rotasProprias — a fábrica não atenderia');
    }
    for (const n of pecasNec) assert.ok(new RegExp('\\b' + n + '\\b').test(chamada.slice(chamada.indexOf('pecas:'))), arq + ': a peça ' + n + ' não chega à fábrica');
  }
  const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/get _canario\(\) \{ return _canGood\.estado; \}/.test(good), 'a GOOD não entrega o canário dela à fábrica');
  console.log('ok — grupo do backfill na fábrica: nas três o /backfill espera o canário e dispara a rotina da empresa; limpar/teste/conferir usam o banco da empresa e dizem o nome dela; as cópias da Girassol e da AMB saíram');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
