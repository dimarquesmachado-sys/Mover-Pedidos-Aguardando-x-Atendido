'use strict';
/* 08/11 — GRUPO DOS CUSTOS NA FÁBRICA (plano, Fase 3 4c). A Girassol tinha cópia de /reaplicar-custo, /custo-diario,
   /custos-manuais, /varrer-fornecedores(-status) e /reaplicar-imposto; a AMB de /reaplicar-custo, /varrer-fornecedores e
   /reaplicar-imposto — e era a cópia que atendia. Agora quem atende é a fábrica (a diferença era só a empresa escrita à
   mão × a empresa como parâmetro; a AMB ganha o /varrer-fornecedores-status, que a cópia dela não tinha).
   Prova (a fábrica DE VERDADE, montada com peças de mentira, uma vez por empresa):
   · /reaplicar-custo simula com as datas e a empresa certas; /reaplicar-imposto reaplica os meses pedidos DA empresa;
   · /custo-diario chama o custo diário da empresa; /varrer-fornecedores-status responde o estado; /custos-manuais?lista=1
     devolve o que está gravado;
   · e no arquivo de cada empresa: as cópias saíram, as rotas saíram de rotasProprias e as peças chegam à fábrica. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

(async () => {
  process.env.ADMIN_KEY = 'k';
  for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabc-'));
    let resp = null; const chamou = [];
    const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => 'k', validarSessao: () => null,
      readJson: (f, d) => (/manuais/.test(f) ? { SKU1: { custo: 10, em: '2026-11-01' } } : d), writeJson: () => {}, CACHE_DIR: dir, fsx: fs, pathx: path,
      ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: { rodando: false }, vendas: {} }, travaPesada: { quemEsta: () => null, pegar: () => true, soltar: () => {} },
      custoSyncTravado: async () => {}, _urlStatus: () => '', _inferCanal: () => 'outro', _diaFechadoDoDisco: () => null, _cstDiario: {}, LOJA_MKT: {}, CONFERIDOS_FILE: path.join(dir, 'c.json'),
      reaplicarCusto: async (de, ate, emp, opts) => { chamou.push(['custo', de, ate, emp, opts]); return { ok: true }; }, estadoReapCusto: () => ({ rodando: false }),
      reaplicarImposto: async (lista, emp) => { chamou.push(['imposto', lista, emp]); },
      custoDiario: async (...a) => { chamou.push(['diario', ...a]); return { ok: true }; }, CUSTO_FILE_DIARIO: path.join(dir, '_custos.json'),
      varrerFornecedores: async () => { chamou.push(['forn']); }, estadoVarrerForn: () => ({ rodando: false, feitos: 3 }) };
    const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
    const r = async (rota, q) => { resp = null; const u = new URL('http://h' + prefixo + '/' + rota + '?k=k' + (q || ''));
      const ok = await rot({ method: 'GET', headers: {} }, {}, prefixo + '/' + rota, 'GET', u); await new Promise((s) => setImmediate(s)); return { ok, resp }; };
    let x = await r('reaplicar-custo', '&de=2026-10-01&ate=2026-10-31&simular=1');
    assert.ok(x.ok && x.resp.body.simulacao && chamou.some((c) => c[0] === 'custo' && c[1] === '2026-10-01' && c[2] === '2026-10-31' && c[3] === empresa && c[4].simular), empresa + ': /reaplicar-custo não simulou com as datas e a empresa certas: ' + JSON.stringify(chamou));
    x = await r('reaplicar-imposto', '&meses=2026-10');
    assert.ok(x.ok && x.resp.code === 202 && chamou.some((c) => c[0] === 'imposto' && c[1].join() === '2026-10' && c[2] === empresa), empresa + ': /reaplicar-imposto não reaplicou os meses da empresa: ' + JSON.stringify(chamou));
    x = await r('custo-diario', '&dia=2026-11-07');
    assert.ok(x.ok && chamou.some((c) => c[0] === 'diario'), empresa + ': /custo-diario não chamou o custo diário da empresa: ' + JSON.stringify(x.resp));
    x = await r('varrer-fornecedores-status');
    assert.ok(x.ok && x.resp.code === 200 && x.resp.body.status && x.resp.body.status.feitos === 3, empresa + ': /varrer-fornecedores-status não respondeu o estado: ' + JSON.stringify(x.resp));
    x = await r('custos-manuais', '&lista=1');
    assert.ok(x.ok && x.resp.code === 200 && x.resp.body.total === 1 && x.resp.body.itens[0].sku === 'SKU1', empresa + ': /custos-manuais?lista=1 não devolveu o que está gravado: ' + JSON.stringify(x.resp));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [arq, pfx, rotas, pecasNec] of [
    ['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', ['reaplicar-custo', 'custo-diario', 'custos-manuais', 'varrer-fornecedores', 'varrer-fornecedores-status', 'reaplicar-imposto'], ['reaplicarCusto', 'estadoReapCusto', 'reaplicarImposto', 'custoDiario', 'CUSTO_FILE_DIARIO', 'varrerFornecedores', 'estadoVarrerForn', 'skuInfoCache']],
    ['amb-checkout-offline/index.js', '/amb-checkout-offline', ['reaplicar-custo', 'varrer-fornecedores', 'reaplicar-imposto'], ['reaplicarCusto', 'estadoReapCusto', 'reaplicarImposto', 'custoDiario', 'CUSTO_FILE_DIARIO', 'varrerFornecedores', 'estadoVarrerForn']]]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const ch = s.slice(s.indexOf('criarRotasPainel({'), s.indexOf('\n        });', s.indexOf('criarRotasPainel({')));
    const prop = new Set([...(/rotasProprias:\s*\[([^\]]*)\]/.exec(ch) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    for (const rt of rotas) {
      assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + '/' + rt + "'").test(s), arq + ': sobrou cópia de /' + rt);
      assert.ok(!prop.has(rt), arq + ': /' + rt + ' continua em rotasProprias — a fábrica não atenderia');
    }
    for (const n of pecasNec) assert.ok(new RegExp('\\b' + n + '\\b').test(ch.slice(ch.indexOf('pecas:'))), arq + ': a peça ' + n + ' não chega à fábrica');
  }
  console.log('ok — grupo dos custos na fábrica: reaplicar custo/imposto, custo diário, fornecedores e custos manuais respondem pela fábrica com a empresa certa; as cópias da Girassol e da AMB saíram');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
