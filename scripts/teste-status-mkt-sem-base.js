'use strict';
/* 14/10 — parecer do Codex (6.6): /status-mkt com a base de vendas do dia AUSENTE respondia ok com
   ml/shopee/tiktok em `canais_checados` e checados:0 — cobertura anunciada sem ter conferido nada.
   Monta a FÁBRICA de produção (lib/checkout/fabrica-rotas-painel.js) com peças de mentira, diretório
   temporário e um fetch que reprova qualquer chamada de rede. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let redes = 0;
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { redes++; throw new Error('rede não era pra ser chamada'); } };
process.env.ADMIN_KEY = 'chave-teste';
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smkt-'));
  const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
  let resp = null;
  const h = criarRotasPainel({ empresa: 'good', prefixo: '/good-checkout-offline', pecas: {
    json: (res, st, o) => { resp = { st, o }; }, lerChaveAdmin: (req, u) => u.searchParams.get('k'), validarSessao: () => null,
    readJson, writeJson: (f, o) => fs.writeFileSync(f, JSON.stringify(o)), CACHE_DIR: tmp, fsx: fs, pathx: path,
    estadoRotinas: { custo: {}, vendas: {} }, ehAdmin: () => false, readBody: async () => '', travaPesada: () => null, custoSyncTravado: () => false,
    _urlStatus: () => '', LOJA_MKT: {}, CONFERIDOS_FILE: path.join(tmp, 'conf.json'), garantirTokenML: async () => 'tk' } });
  const chama = async () => { resp = null; await h({ method: 'GET', headers: {} }, {}, '/good-checkout-offline/status-mkt', 'GET',
    new URL('http://x/good-checkout-offline/status-mkt?k=chave-teste&de=2026-10-01&ate=2026-10-13')); return resp; };

  // 1) sem arquivo: não sei — nenhum canal conferido
  let r = await chama();
  assert.ok(r && r.st === 200 && r.o.ok === true, JSON.stringify(r));
  assert.strictEqual(r.o.sem_base, true); assert.deepStrictEqual(r.o.canais_checados, [], 'anunciou canal conferido sem base');
  assert.ok(r.o.sem_cobertura.includes('ml') && r.o.sem_cobertura.includes('shopee') && r.o.sem_cobertura.includes('tiktok'));
  assert.ok(/nenhum cancelamento foi conferido/.test(r.o.aviso_base));
  // 2) arquivo vazio: idem, com a data do arquivo
  fs.writeFileSync(path.join(tmp, '_vendas_dia.json'), '{}');
  r = await chama(); assert.strictEqual(r.o.sem_base, true); assert.ok(/arquivo vazio desde/.test(r.o.aviso_base));
  // 3) base EXISTE e não tem pedido no período: período vazio de verdade, conferido
  fs.writeFileSync(path.join(tmp, '_vendas_dia.json'), JSON.stringify({ a: { numero: 1, numero_loja: '2000000000001', marketplace: 'ml', data: '2026-09-01' } }));
  r = await chama(); assert.ok(!r.o.sem_base); assert.deepStrictEqual(r.o.canais_checados, ['ml', 'shopee', 'tiktok']); assert.strictEqual(r.o.checados, 0);
  assert.strictEqual(redes, 0, 'chamou rede');
  // 4) as telas que consomem a rota mostram o aviso da base
  for (const f of ['girassol-backup-offline/dashboard.html', 'amb-checkout-offline/amb-dashboard.html'])
    assert.ok(/if\(d\.aviso_base\) avisos\.push\(d\.aviso_base\)/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ' não mostra o aviso da base');
  // 5) AMB e Girassol têm handler PRÓPRIO (rotasProprias) que vence a fábrica: o guard precisa estar nele também
  for (const f of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const i = src.indexOf("-offline/status-mkt') {");
    const trecho = src.slice(i, src.indexOf('const noPeriodo', i));
    assert.ok(i > 0 && /sem_base: true/.test(trecho) && /canais_checados: \[\]/.test(trecho) && /aviso_base/.test(trecho), f + ' sem o guard de base vazia no handler próprio');
  }
  console.log('ok — status-mkt sem base de vendas do dia não anuncia cobertura; período vazio de verdade segue conferido');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
