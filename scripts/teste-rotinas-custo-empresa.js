'use strict';
/* 16/11 — AS ROTINAS DE CUSTO DA EMPRESA NUMA PEÇA (lib/checkout/rotinas-custo-empresa; docs/NORTE-2026-11.md, item C —
   `montarCheckout`, passo 6).

   Os três arquivos de entrada montavam o mesmo bloco: o estado e a anotação da falha do sync de custo, o sync (custo-sync), o
   sync travado com a re-tentativa (custo-sync-travado), o custo diário das 23 h (custo-diario) e a fila de recálculo
   (custo-recalculo). Prova:
     1) a peça, com as quatro peças de baixo de mentira no require.cache (registram o que receberam):
        · montagem sem empresa, sem `pecas`, com peça faltando ou com opção desconhecida derruba no boot, dizendo o quê;
        · montar NÃO lê as peças da empresa (só a pasta do cache, pra o caminho do `_custos.json`) — a ordem do arquivo dela
          não importa; cada acessor é lido NA HORA (trocado depois, vale o novo);
        · o sync recebe a empresa, as opções que ela declarou (e só elas), o estado DELA (`estadoDe(empresa).custo`), a anotação
          que escreve nesse estado, a trava do processo, o Supabase da empresa e a limpeza do sku-info PROTEGIDA;
        · o travado recebe a empresa, a mesma trava, o mesmo estado e chama o sync desta peça;
        · o custo diário recebe o `_custos.json` da pasta da empresa, a escrita segura (grava de verdade), o estado, a vigência
          lida e gravada na peça de custo DESTA empresa, o registro de custo e a fila de recálculo da empresa, que recalcula
          pelo custo dela;
     2) pelos módulos REAIS das três (rede bloqueada; as peças de baixo verdadeiras, só observadas): cada uma monta as rotinas
        com a empresa dela (a GOOD com as três opções dela, as outras sem nenhuma), a pasta dela e o estado dela; o
        `/custo-sync?status=1` de cada uma mostra a falha anotada no estado DELA e não a de outra;
     3) os três arquivos não têm mais o bloco à mão e desestruturam os mesmos nomes. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ER = require('../lib/checkout/estado-rotinas');
const PECAS_SYNC = require('../lib/checkout/custo-sync').PECAS;

const resolver = (n) => require.resolve('../lib/checkout/' + n);
const trocar = (mapa) => { const salvo = {}; for (const [n, exp] of Object.entries(mapa)) { const r = resolver(n); salvo[r] = require.cache[r]; require.cache[r] = { id: r, filename: r, loaded: true, exports: exp }; } return () => { for (const [r, v] of Object.entries(salvo)) { if (v) require.cache[r] = v; else delete require.cache[r]; } }; };

(async () => {
  /* ── 1) a peça ── */
  {
    const visto = {};
    const devolve = trocar({
      'custo-sync': { criar: (G) => { visto.sync = G; return async (fresh) => { visto.syncRodou = (visto.syncRodou || 0) + 1; return fresh ? 7 : 0; }; } },
      'custo-sync-travado': { criar: (G) => { visto.trav = G; return { custoRetryPendente: () => 'pend', custoSyncTravado: async (f, r) => ['trav', f, r, await G.custoSync(f)] }; } },
      'custo-diario': { criar: (D) => { visto.diario = D; return { custoDiario: async (...a) => ['diario', ...a], _cstDiario: { ultimo: 'u' }, _diaFechadoDoDisco: () => 'fechado', _diaLocalHoje: () => '2026-11-16' }; } },
      'custo-recalculo': { daEmpresa: (cfg) => { visto.fila = cfg; return { pedir: (sku, dia) => ['pedir', cfg.empresa, sku, dia], estado: (sku) => ['estado', cfg.empresa, sku] }; } },
    });
    let R;
    try {
      R = require('../lib/checkout/rotinas-custo-empresa');
      const lidas = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rce-'));
      const vig = { valor: null };
      let ce = { registrarCustoVigente: (...a) => ['reg', ...a], resolverDeParaSku: (s) => 'dp:' + s, lerVigencias: () => ({ v: 1 }), reaplicarCusto: async (...a) => ['reap', ...a], _vigenciaDeRef: vig };
      const val = { CACHE_DIR: dir, CONFERIDOS_FILE: dir + '/conf.json', _histCache: { h: 1 }, _limparSkuInfo: (s) => { lidas.push('limpou:' + s); throw new Error('cache ruim'); }, blingGet: async (u) => 'bling:' + u, readJson: (p, d) => ['rj', p, d], writeJson: () => true, resolverProdutoPorSku: async () => null };
      const pecas = {};
      for (const n of Object.keys(val)) Object.defineProperty(pecas, n, { enumerable: true, get() { lidas.push(n); return val[n]; } });
      Object.defineProperty(pecas, 'custoEmpresa', { enumerable: true, get() { lidas.push('custoEmpresa'); return ce; } });

      assert.throws(() => R.criar({}), /falta empresa/);
      assert.throws(() => R.criar({ empresa: 'q' }), /falta pecas/);
      for (const n of R.PECAS) { const p2 = Object.assign({}, val, { custoEmpresa: ce }); delete p2[n]; assert.throws(() => R.criar({ empresa: 'q', pecas: p2 }), new RegExp('falta ' + n + '$')); }
      assert.throws(() => R.criar({ empresa: 'q', pecas: Object.assign({}, val, { custoEmpresa: ce }), opcoesCustoSync: { seletorr: 'x' } }), /opção desconhecida do custo-sync: seletorr/);

      const P = R.criar({ empresa: 'quarta', opcoesCustoSync: { seletor: 'sel-q', histSkusDoArquivo: true }, pecas });
      assert.deepStrictEqual(lidas, ['CACHE_DIR'], 'montar só pode ler a pasta do cache (o caminho do _custos.json) — leu: ' + lidas.join(','));
      assert.deepStrictEqual(Object.keys(P).sort(), ['CUSTO_FILE_DIARIO', '_anotarFalhaCusto', '_cst', '_cstDiario', '_diaFechadoDoDisco', '_filaRecalculoCusto', 'custoDiario', 'custoRetryPendente', 'custoSync', 'custoSyncTravado', 'travaPesada']);
      const cst = ER.estadoDe('quarta').custo;
      assert.strictEqual(P._cst, cst, 'o estado é o da empresa (o mesmo objeto que o painel lê)');
      assert.strictEqual(P.travaPesada, require('../lib/checkout/trava-pesada'), 'a trava é a do processo');
      assert.strictEqual(P.CUSTO_FILE_DIARIO, path.join(dir, '_custos.json'));

      /* o sync */
      const G = visto.sync;
      assert.deepStrictEqual([G.empresa, G.seletor, G.fornecedorEstrito, G.histSkusDoArquivo], ['quarta', 'sel-q', undefined, true], 'a empresa e as opções que ela declarou (e só elas)');
      for (const n of PECAS_SYNC) assert.ok(n in G, 'o sync não recebe ' + n);
      assert.strictEqual(G._cst, cst); assert.strictEqual(G.travaPesada, P.travaPesada); assert.strictEqual(G._custoComp, require('../lib/custo-composicao'));
      lidas.length = 0; assert.strictEqual(G.CONFERIDOS_FILE, dir + '/conf.json'); assert.deepStrictEqual(lidas, ['CONFERIDOS_FILE'], 'o acessor lê a peça na hora');
      val.CONFERIDOS_FILE = '/outro'; assert.strictEqual(G.CONFERIDOS_FILE, '/outro', 'trocada depois, vale a nova');
      assert.strictEqual(G._histCache, val._histCache); assert.strictEqual(await G.blingGet('/x'), 'bling:/x'); assert.deepStrictEqual(G.readJson('a', 1), ['rj', 'a', 1]); assert.strictEqual(G.writeJson, val.writeJson); assert.strictEqual(G.resolverProdutoPorSku, val.resolverProdutoPorSku);
      assert.deepStrictEqual(G.registrarCustoVigente('S', 3, 'o'), ['reg', 'S', 3, 'o']); assert.strictEqual(G.resolverDeParaSku('A'), 'dp:A');
      const ceVelho = ce; ce = Object.assign({}, ceVelho, { resolverDeParaSku: (s) => 'novo:' + s }); assert.strictEqual(G.resolverDeParaSku('A'), 'novo:A', 'a peça de custo é lida na hora'); ce = ceVelho;
      lidas.length = 0; assert.doesNotThrow(() => G._limparSkuInfo('K1'), 'a limpeza do sku-info é protegida (nivelado pela GOOD)'); assert.ok(lidas.includes('limpou:K1'), 'e chama a da empresa com o SKU');
      process.env.SUPABASE_URL_VENDAS_QUARTA = 'https://q'; process.env.SUPABASE_KEY_VENDAS_QUARTA = 'kq';
      assert.deepStrictEqual(G.supaCfg('quarta'), { url: 'https://q', key: 'kq' }, 'o Supabase é o da empresa');
      delete process.env.SUPABASE_URL_VENDAS_QUARTA; delete process.env.SUPABASE_KEY_VENDAS_QUARTA;
      G._anotarFalhaCusto('SKU-F', 'motivo-f'); assert.strictEqual(cst.falhas_detalhe[0].sku, 'SKU-F', 'a anotação escreve no estado da empresa');
      assert.strictEqual(await P.custoSync(true), 7); assert.strictEqual(visto.syncRodou, 1);

      /* o travado */
      const T = visto.trav;
      assert.deepStrictEqual([T.empresa, T.travaPesada === P.travaPesada, T._cst === cst, T._histCache === val._histCache], ['quarta', true, true, true]);
      assert.deepStrictEqual(await P.custoSyncTravado(true, 'r'), ['trav', true, 'r', 7], 'a travada repassa o retentar e chama o sync desta peça');
      assert.strictEqual(P.custoRetryPendente(), 'pend');

      /* o custo diário */
      const D = visto.diario;
      assert.strictEqual(D.empresa, 'quarta'); assert.strictEqual(D.CUSTO_FILE, path.join(dir, '_custos.json')); assert.strictEqual(D.estadoSync(), cst);
      assert.deepStrictEqual(D.readJson('x', 2), ['rj', 'x', 2]); assert.strictEqual(await D.blingGet('/y'), 'bling:/y'); assert.strictEqual(await D.custoSync(true), 7);
      D.escrever(path.join(dir, '_custos.json'), { S: { custo: 5 } }); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '_custos.json'), 'utf8')), { S: { custo: 5 } }, 'a escrita grava (segura: temporário + troca)');
      assert.ok(!/writeFileSync/.test(D.escrever.toString()) && /gravarAtomico/.test(D.escrever.toString()), 'a escrita do custo diário é a segura');
      vig.valor = '2026-11-01'; assert.strictEqual(D.lerVigenciaDe(), '2026-11-01'); D.gravarVigenciaDe('2026-11-05'); assert.strictEqual(vig.valor, '2026-11-05', 'a vigência é a da peça de custo da empresa');
      assert.deepStrictEqual(D.registrarCustoVigente('S', 1, 'x'), ['reg', 'S', 1, 'x']); assert.deepStrictEqual(D.lerVigencias(), { v: 1 });
      assert.deepStrictEqual(D.pedirRecalculo('K', '2026-11-02'), ['pedir', 'quarta', 'K', '2026-11-02'], 'a fila é a da empresa');
      assert.deepStrictEqual(D.estadoRecalculo('K'), ['estado', 'quarta', 'K']);
      assert.strictEqual(visto.fila.empresa, 'quarta'); assert.deepStrictEqual(await visto.fila.reaplicar('a', 'b', 'quarta', { o: 1 }), ['reap', 'a', 'b', 'quarta', { o: 1 }], 'a fila recalcula pelo custo DESTA empresa'); assert.strictEqual(visto.fila.hoje(), '2026-11-16');
      assert.deepStrictEqual(await P.custoDiario(1, 2), ['diario', 1, 2]); assert.deepStrictEqual(P._cstDiario, { ultimo: 'u' }); assert.strictEqual(P._diaFechadoDoDisco(), 'fechado');

      /* outra empresa, sem opções: nada declarado chega ao sync */
      R.criar({ empresa: 'quinta', pecas: Object.assign({}, val, { custoEmpresa: ce }) });
      assert.deepStrictEqual([visto.sync.empresa, visto.sync.seletor, visto.sync.fornecedorEstrito, visto.sync.histSkusDoArquivo], ['quinta', undefined, undefined, undefined]);
      assert.notStrictEqual(visto.sync._cst, cst, 'cada empresa com o estado dela');
    } finally { devolve(); delete require.cache[resolver('rotinas-custo-empresa')]; }
  }

  /* ── 2) os módulos reais das três ── */
  {
    const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
    for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
    require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => bloqueado() };
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-rce';
    const visto = { sync: {}, diario: {} };
    const realSync = require('../lib/checkout/custo-sync'), realDiario = require('../lib/checkout/custo-diario');
    const devolve = trocar({
      'custo-sync': Object.assign({}, realSync, { criar: (G) => { visto.sync[G.empresa] = G; return realSync.criar(G); } }),
      'custo-diario': Object.assign({}, realDiario, { criar: (D) => { visto.diario[D.empresa] = D; return realDiario.criar(D); } }),
    });
    const _log = console.log, _warn = console.warn, _err = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    const EMP = [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR']];
    const handlers = {};
    try {
      for (const [emp, , arq, envDir] of EMP) {
        process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'rce-' + emp + '-'));
        delete require.cache[resolver('rotinas-custo-empresa')];
        handlers[emp] = require(path.join(raiz, arq)).routes(async () => ({}));
      }
    } finally { console.log = _log; console.warn = _warn; console.error = _err; devolve(); }
    for (const [emp, , , envDir] of EMP) {
      const G = visto.sync[emp], D = visto.diario[emp];
      assert.ok(G && D, emp + ': não montou o sync e o custo diário pelas rotinas');
      const opc = [G.seletor, G.fornecedorEstrito, G.histSkusDoArquivo];
      assert.deepStrictEqual(opc, emp === 'good' ? ['ativo-v1', true, true] : [undefined, undefined, undefined], emp + ': as opções do sync');
      assert.strictEqual(G._cst, ER.estadoDe(emp).custo, emp + ': o estado do sync é o da empresa');
      assert.strictEqual(G.CACHE_DIR, process.env[envDir], emp + ': a pasta é a da empresa');
      assert.strictEqual(D.CUSTO_FILE, path.join(process.env[envDir], '_custos.json'), emp + ': o _custos.json é o da empresa');
      assert.strictEqual(D.estadoSync(), ER.estadoDe(emp).custo);
      assert.strictEqual(typeof G.resolverDeParaSku, 'function'); assert.strictEqual(typeof G.registrarCustoVigente, 'function'); assert.strictEqual(typeof G._histCache, 'object');
      ER.anotarFalhaCusto(ER.estadoDe(emp).custo, 'MARCA-' + emp, 'teste');
    }
    for (const [emp, pref] of EMP) {
      const h = handlers[emp];
      const u = new URL('http://x' + pref + '/custo-sync?k=' + encodeURIComponent(process.env.ADMIN_KEY) + '&status=1');
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
      assert.strictEqual(res._s, 200, emp + ': /custo-sync?status=1 respondeu ' + res._s + ' ' + res._b.slice(0, 120));
      const j = JSON.parse(res._b);
      const skus = (j.falhas_detalhe || []).map((f) => f.sku);
      assert.ok(skus.includes('MARCA-' + emp) && skus.every((s) => !/^MARCA-/.test(s) || s === 'MARCA-' + emp), emp + ': o status do custo tem que mostrar o estado DELA: ' + JSON.stringify(skus));
    }
  }

  /* ── 3) o texto dos três arquivos ── */
  for (const [arq, emp, hist] of [['girassol-backup-offline/gbo-app.js', 'girassol', '_histCache'], ['amb-checkout-offline/index.js', 'amb', '_histCache'], ['good-checkout-offline/index.js', 'good', '_histCacheGood']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    for (const re of [/require\('\.\.\/lib\/checkout\/custo-sync'\)/, /require\('\.\.\/lib\/checkout\/custo-sync-travado'\)/, /require\('\.\.\/lib\/checkout\/custo-diario'\)/, /require\('\.\.\/lib\/checkout\/custo-recalculo'\)/, /require\('\.\.\/lib\/checkout\/trava-pesada'\)/, /require\('\.\.\/lib\/custo-composicao'\)/, /anotarFalhaCusto\(_cst/, /_custoDiarioMod/, /_filaRecalculoCusto/]) {
      assert.ok(!re.test(s), arq + ': sobrou o bloco à mão ' + re);
    }
    const i = s.indexOf("require('../lib/checkout/rotinas-custo-empresa').criar({"); assert.ok(i > 0, arq + ': não monta as rotinas de custo pela peça');
    const bloco = s.slice(i, s.indexOf('\n});', i));
    assert.ok(new RegExp("\\n  empresa: '" + emp + "',").test(bloco) && bloco.includes('get _histCache() { return ' + hist + '; }') && bloco.includes('get custoEmpresa() { return _custoEmp; }'), arq + ': a empresa, o cache do histórico e a peça de custo DELA');
    assert.ok(s.includes('const { _cst, travaPesada, CUSTO_FILE_DIARIO, custoSyncTravado, custoRetryPendente, custoDiario, _cstDiario, _diaFechadoDoDisco } = _rotCusto;'), arq + ': os mesmos nomes, das rotinas');
  }
  console.log('ok — as rotinas de custo da empresa são uma peça (lib/checkout/rotinas-custo-empresa): sync, travado, custo diário e fila com o estado, a pasta, a vigência e o custo DESTA empresa; as três montam a peça (a GOOD com as opções dela) e o status de cada uma mostra o estado dela');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
