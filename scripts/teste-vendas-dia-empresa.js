'use strict';
/* 16/11 — A VENDA DO DIA DA EMPRESA NUMA PEÇA (lib/checkout/vendas-dia-empresa; docs/NORTE-2026-11.md, item C — `montarCheckout`,
   passo 8).

   Os três arquivos de entrada montavam o mesmo bloco: o estado da venda do dia, o canal pelo número, a pesca do ML, o frete
   da Magalu, a fase direta (com o serviço da Shopee e o token do ML escritos à mão, com as envs de cada um), a venda do dia e
   a pesca das tarifas do ML nos conferidos. Prova:
     1) a peça, com as quatro peças de baixo de mentira no require.cache (registram o que receberam):
        · montagem sem empresa, sem versão do marcador, sem `pecas`, com peça faltando ou com empresa fora do contrato derruba;
        · montar só lê a pasta do cache; cada acessor é lido na hora (trocado depois, vale o novo);
        · a fase direta recebe o serviço da Shopee e o token do ML DA CONFIGURAÇÃO da empresa (uma "quarta" de mentira, pela
          convenção, sem escrever env à mão), o node-fetch e a chave/porta do processo;
        · o frete da Magalu é UMA instância: o leitor devolvido e o gravador que a venda do dia usa são os mesmos;
        · a venda do dia nasce na primeira chamada, com a empresa e as peças lidas na hora (as devoluções do ML da peça de custo
          DELA); a segunda chamada reaproveita;
        · a pesca das tarifas recebe a empresa, a versão declarada, o token da empresa (o require na hora da chamada) e o
          estado `_mls` que vai e VOLTA ao arquivo;
     2) pelos módulos REAIS das três (rede bloqueada; a fase direta e a pesca verdadeiras, só observadas): o serviço da Shopee
        que cada uma passa à fase direta é EXATAMENTE o que o arquivo dela lia à mão (as expressões antigas estão aqui), em
        todas as combinações das envs envolvidas; a versão do marcador (2, 1, 2) e o token do ML de cada uma;
     3) os três arquivos não têm mais o bloco à mão. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ER = require('../lib/checkout/estado-rotinas');

const resolver = (n) => require.resolve('../lib/checkout/' + n);
const trocar = (mapa) => { const salvo = {}; for (const [n, exp] of Object.entries(mapa)) { const r = resolver(n); salvo[r] = require.cache[r]; require.cache[r] = { id: r, filename: r, loaded: true, exports: exp }; } return () => { for (const [r, v] of Object.entries(salvo)) { if (v) require.cache[r] = v; else delete require.cache[r]; } }; };
const URL_PADRAO = require('../lib/checkout/config-empresa').URL_SHOPEE_PADRAO;

(async () => {
  /* ── 1) a peça ── */
  {
    const visto = { vd: 0 };
    const magInst = { magaluFreteSkuLer: () => 'ler', magaluFreteSkuGravar: () => 'gravar', magaluFreteProvisorio: () => 'prov', magaluFretePrevistoSku: () => 'prev', MAGALU_FRETE_TABELA: [] };
    const devolve = trocar({
      'fase-direta': { criarFaseDireta: (c) => { visto.fd = c; return async () => 'fase'; } },
      'magalu-frete': { criar: (c) => { visto.mag = c; return magInst; } },
      'vendas-dia': { criarVendasSyncDaEmpresa: (emp, c) => { visto.vd++; visto.vdEmp = emp; visto.vdCfg = c; return async () => ['rodou', c.deps()]; } },
      'ml-sync-fees': { criar: (G) => { visto.mls = G; return async (d) => ['pesca', d]; } },
    });
    try {
      delete require.cache[resolver('vendas-dia-empresa')];
      const V = require('../lib/checkout/vendas-dia-empresa');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vde-'));
      const lidas = [];
      let mls = { rodando: false, marca: 'arquivo' };
      const devol = async () => 'devolucoes';
      const val = { CACHE_DIR: dir, CONFERIDOS_FILE: dir + '/c.json', LOJA_MKT: { 1: 'ml' }, blingGet: async (u) => 'b:' + u, readJson: (p, d) => ['rj', p, d], writeJson: () => true, json: () => {}, nfDoPedido: () => 'nf', resolverProdutoPorSku: async (s) => 'prod:' + s, custoEmpresa: { buscarDevolucoesML: devol } };
      const pecas = {};
      for (const n of Object.keys(val)) Object.defineProperty(pecas, n, { enumerable: true, get() { lidas.push(n); return val[n]; } });
      Object.defineProperty(pecas, '_mls', { enumerable: true, get() { lidas.push('_mls'); return mls; }, set(v) { mls = v; } });
      /* a "quarta" empresa, de mentira, pela convenção do contrato */
      const regQ = { normalizar: (x) => x, obter: (id) => (id === 'quarta' ? { id: 'quarta', prefixoEnv: 'QUARTA_' } : null) };
      const cfgQ = (emp) => require('../lib/checkout/config-empresa').configCheckout(emp, { registro: regQ });

      assert.throws(() => V.criar({}), /falta empresa/);
      assert.throws(() => V.criar({ empresa: 'quarta', pecas }), /falta versaoCustos/);
      assert.throws(() => V.criar({ empresa: 'quarta', versaoCustos: 0, pecas }), /falta versaoCustos/);
      assert.throws(() => V.criar({ empresa: 'quarta', versaoCustos: 2 }), /falta pecas/);
      for (const n of V.PECAS) { const p2 = Object.assign({}, val, { _mls: {} }); delete p2[n]; assert.throws(() => V.criar({ empresa: 'quarta', versaoCustos: 2, pecas: p2, configCheckout: cfgQ }), new RegExp('falta ' + n + '$')); }
      assert.throws(() => V.criar({ empresa: 'quinta', versaoCustos: 2, pecas: Object.assign({}, val, { _mls: {} }), configCheckout: cfgQ }), /desconhecida no contrato/);

      const envAntes = { QUARTABKP_SHOPEE_SYNC_KEY: process.env.QUARTABKP_SHOPEE_SYNC_KEY, SHOPEE_SYNC_URL: process.env.SHOPEE_SYNC_URL, ADMIN_KEY: process.env.ADMIN_KEY, PORT: process.env.PORT };
      process.env.QUARTABKP_SHOPEE_SYNC_KEY = 'chave-q'; delete process.env.SHOPEE_SYNC_URL; process.env.ADMIN_KEY = 'adm-q'; process.env.PORT = '4321';
      let P;
      try { P = V.criar({ empresa: 'quarta', versaoCustos: 3, pecas, configCheckout: cfgQ }); }
      finally { for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
      assert.deepStrictEqual(lidas, ['CACHE_DIR'], 'montar só pode ler a pasta do cache — leu: ' + lidas.join(','));
      assert.strictEqual(P._vsy, ER.estadoDe('quarta').vendas, 'o estado da venda do dia é o da empresa');
      assert.strictEqual(P._inferCanal, require('../lib/checkout/inferir-canal').inferirCanal);
      assert.strictEqual(P.pescarDadosML, require('../lib/ml-pesca').pescarDadosML);

      /* a fase direta */
      const FD = visto.fd;
      assert.deepStrictEqual([FD.empresa, FD.shopeeKey, FD.shopeeUrlEnv, FD.shopeeLoja, FD.adminKey, FD.porta], ['quarta', 'chave-q', URL_PADRAO, 'quarta', 'adm-q', '4321'], 'a fase direta pela configuração da empresa (convenção): ' + JSON.stringify(FD));
      assert.strictEqual(FD.fetch, require('node-fetch'), 'a fase direta usa o node-fetch (o `timeout` dos canais)');
      assert.throws(() => FD.mlTokenManager(), /quarta\/mlTokenManager/, 'o token do ML é o do contrato da empresa (a quarta não tem o módulo: o require falha NA CHAMADA, não na montagem)');
      assert.strictEqual(typeof P._faseDireta, 'function', 'a fase direta montada é devolvida');

      /* o frete da Magalu */
      const M = visto.mag;
      assert.strictEqual(M.CACHE_DIR, dir);
      lidas.length = 0; assert.deepStrictEqual(M.readJson('a', 1), ['rj', 'a', 1]); assert.strictEqual(await M.blingGet('/x'), 'b:/x'); assert.strictEqual(await M.resolverProdutoPorSku('S'), 'prod:S');
      assert.deepStrictEqual(lidas, ['readJson', 'blingGet', 'resolverProdutoPorSku'], 'o frete lê as peças na hora');
      val.resolverProdutoPorSku = async (s) => 'novo:' + s; assert.strictEqual(await M.resolverProdutoPorSku('S'), 'novo:S', 'trocada depois, vale a nova');
      for (const n of Object.keys(magInst)) assert.strictEqual(P[n], magInst[n], 'a peça devolve o frete da Magalu: ' + n);

      /* a venda do dia */
      assert.strictEqual(visto.vd, 0, 'a venda do dia só nasce na primeira chamada');
      const r1 = await P.vendasSync();
      assert.strictEqual(visto.vd, 1); assert.strictEqual(visto.vdEmp, 'quarta'); assert.strictEqual(visto.vdCfg.fetch, require('node-fetch'));
      const d = r1[1];
      assert.ok(d.CACHE_DIR === dir && d.CONFERIDOS_FILE === dir + '/c.json' && d.LOJA_MKT === val.LOJA_MKT && d.json === val.json && d.nfDoPedido === val.nfDoPedido && d.readJson === val.readJson && d.writeJson === val.writeJson && d.blingGet === val.blingGet, 'as peças da empresa');
      assert.ok(d._vsy === P._vsy && d._inferCanal === P._inferCanal && d.pescarDadosML === P.pescarDadosML && d.path === path, 'as peças comuns');
      assert.ok(d._faseDireta && (await d._faseDireta()) === 'fase', 'a fase direta desta peça');
      assert.ok(d.magaluFreteProvisorio === magInst.magaluFreteProvisorio && d.magaluFreteSkuGravar === magInst.magaluFreteSkuGravar, 'o gravador do frete é da MESMA instância que o leitor devolvido');
      assert.strictEqual(d.buscarDevolucoesML, devol, 'as devoluções do ML da peça de custo DESTA empresa');
      val.CONFERIDOS_FILE = '/outro'; const r2 = await P.vendasSync();
      assert.strictEqual(visto.vd, 1, 'a segunda chamada reaproveita'); assert.strictEqual(r2[1].CONFERIDOS_FILE, '/outro', 'as peças são lidas a cada rodada');

      /* a pesca das tarifas */
      const G = visto.mls;
      assert.deepStrictEqual([G.empresa, G.versaoCustos], ['quarta', 3]);
      assert.strictEqual(G._mls.marca, 'arquivo'); G._mls = { marca: 'nova' }; assert.strictEqual(mls.marca, 'nova', 'o estado da pesca VOLTA pro arquivo (as rotas de status o leem)');
      assert.strictEqual(G.CONFERIDOS_FILE, '/outro'); assert.strictEqual(G.readJson, val.readJson); assert.strictEqual(G.writeJson, val.writeJson);
      assert.throws(() => G.garantirTokenML(), /quarta\/mlTokenManager/, 'o token da pesca é o do contrato da empresa, na hora da chamada');
      assert.deepStrictEqual(await P.mlSyncFees(14), ['pesca', 14]);
    } finally { devolve(); delete require.cache[resolver('vendas-dia-empresa')]; }
  }

  /* ── 2) os módulos reais das três ── */
  {
    const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
    for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-vde';
    const realFD = require('../lib/checkout/fase-direta'), realMls = require('../lib/checkout/ml-sync-fees');
    const visto = { fd: {}, mls: {} };
    const devolve = trocar({
      'fase-direta': Object.assign({}, realFD, { criarFaseDireta: (c) => { visto.fd[c.empresa] = c; return realFD.criarFaseDireta(c); } }),
      'ml-sync-fees': Object.assign({}, realMls, { criar: (G) => { visto.mls[G.empresa] = G; return realMls.criar(G); } }),
    });
    const NOMES = ['SHOPEE_SYNC_URL', 'SHOPEE_SYNC_KEY', 'SHOPEE_SYNC_LOJA', 'GBO_SHOPEE_SYNC_URL', 'GBO_SHOPEE_SYNC_KEY', 'GBO_SHOPEE_SYNC_LOJA', 'AMBBKP_SHOPEE_SYNC_URL', 'AMBBKP_SHOPEE_SYNC_KEY', 'AMBBKP_SHOPEE_SYNC_LOJA', 'GOODBKP_SHOPEE_SYNC_URL', 'GOODBKP_SHOPEE_SYNC_KEY', 'GOODBKP_SHOPEE_SYNC_LOJA'];
    /* o que cada arquivo lia à mão até 16/11 (a referência) */
    const D = 'https://girassol-shopee-sync-organizar-envio.onrender.com';
    const ANTES = {
      girassol: (e) => ({ key: e.GBO_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', url: e.GBO_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, loja: e.GBO_SHOPEE_SYNC_LOJA || 'girassol' }),
      amb:      (e) => ({ key: e.AMBBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', url: e.AMBBKP_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, loja: e.AMBBKP_SHOPEE_SYNC_LOJA || 'amb' }),
      good:     (e) => ({ key: e.GOODBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', url: e.GOODBKP_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, loja: e.GOODBKP_SHOPEE_SYNC_LOJA || 'good' }),
    };
    const EMP = [['girassol', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR', 2, 'girassol'], ['amb', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR', 1, 'ambtotal'], ['good', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR', 2, 'good']];
    /* uma combinação de envs pela carga real (o módulo carrega uma vez); as 4.096 pela configuração que a peça lê */
    const salvo = {}; for (const n of NOMES) salvo[n] = process.env[n];
    for (const n of NOMES) process.env[n] = 'v-' + n;
    delete process.env.SHOPEE_SYNC_LOJA; delete process.env.AMBBKP_SHOPEE_SYNC_KEY; delete process.env.GOODBKP_SHOPEE_SYNC_URL;
    const envCarga = {}; for (const n of NOMES) if (process.env[n]) envCarga[n] = process.env[n];
    const _log = console.log, _warn = console.warn, _err = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
      for (const [emp, arq, envDir] of EMP) { process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'vde-' + emp + '-')); delete require.cache[resolver('vendas-dia-empresa')]; require(path.join(raiz, arq)); }
    } finally { console.log = _log; console.warn = _warn; console.error = _err; devolve(); }
    for (const [emp, , , versao, pasta] of EMP) {
      const FD = visto.fd[emp], G = visto.mls[emp];
      assert.ok(FD && G, emp + ': não montou a fase direta e a pesca pela peça');
      assert.deepStrictEqual({ key: FD.shopeeKey, url: FD.shopeeUrlEnv, loja: FD.shopeeLoja }, ANTES[emp](envCarga), emp + ': a fase direta leu o serviço da Shopee diferente do que o arquivo lia');
      assert.strictEqual(G.versaoCustos, versao, emp + ': a versão do marcador');
      assert.strictEqual(require('../lib/checkout/config-empresa').configCheckout(emp).mlTokenManager, pasta + '/mlTokenManager', emp + ': o token do ML');
    }
    const { configCheckout } = require('../lib/checkout/config-empresa');
    for (const [emp] of EMP) {
      const c = configCheckout(emp);
      for (let m = 0; m < (1 << NOMES.length); m++) {
        const env = {};
        NOMES.forEach((n, i) => { if (m & (1 << i)) { env[n] = 'v-' + n; process.env[n] = env[n]; } else delete process.env[n]; });
        const agora = { key: c.ler(c.faseDireta.shopeeKey), url: c.ler(c.faseDireta.shopeeUrl), loja: c.ler(c.faseDireta.shopeeLoja) };
        assert.deepStrictEqual(agora, ANTES[emp](env), emp + ' (fase direta): com as envs ' + Object.keys(env).join(',') + ' a configuração lê diferente do que o arquivo lia');
      }
    }
    for (const n of NOMES) { if (salvo[n] === undefined) delete process.env[n]; else process.env[n] = salvo[n]; }
  }

  /* ── 3) o texto dos três arquivos ── */
  for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb'], ['good-checkout-offline/index.js', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    for (const re of [/require\('\.\.\/lib\/checkout\/fase-direta'\)/, /require\('\.\.\/lib\/checkout\/magalu-frete'\)/, /require\('\.\.\/lib\/checkout\/vendas-dia'\)/, /require\('\.\.\/lib\/checkout\/ml-sync-fees'\)/, /require\('\.\.\/lib\/ml-pesca'\)/, /require\('\.\.\/lib\/checkout\/inferir-canal'\)/, /_SHOPEE_SYNC_(KEY|URL|LOJA)/, /async function vendasSync\(/, /async function mlSyncFees\(/]) {
      assert.ok(!re.test(s), arq + ': sobrou o bloco à mão ' + re);
    }
    assert.ok(new RegExp("require\\('\\.\\./lib/checkout/vendas-dia-empresa'\\)\\.criar\\(\\{\\n  empresa: '" + emp + "',").test(s), arq + ': não monta a venda do dia pela peça');
    assert.ok(s.includes('const { _inferCanal, pescarDadosML, vendasSync, mlSyncFees, magaluFreteSkuLer, magaluFretePrevistoSku } = _rotVendas;'), arq + ': os mesmos nomes, da peça');
  }
  console.log('ok — a venda do dia da empresa é uma peça (lib/checkout/vendas-dia-empresa): a fase direta com o serviço da Shopee e o token do ML da configuração (as três leem o que liam, em 4.096 combinações de env), o frete da Magalu numa instância só, a venda do dia e a pesca das tarifas com o estado que volta; as três montam a peça');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
