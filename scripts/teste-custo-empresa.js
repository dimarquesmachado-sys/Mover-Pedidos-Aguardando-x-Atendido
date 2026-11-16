'use strict';
/* 16/11 — O CUSTO DA EMPRESA NUMA PEÇA (lib/checkout/custo-empresa; docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 5).

   Os três arquivos de entrada montavam o mesmo bloco: o contexto do lib/custo, vinte e tantos atalhos (custo manual, vigência,
   de-para de SKU, nome do produto) e o vendas-ops (recálculo de custo, fornecedores, estados). Idênticos na Girassol e na AMB;
   a GOOD tinha parte. Prova:
     1) a peça devolve os MESMOS nomes, cada um chamando o lib/custo ou o vendas-ops com o contexto DESTA empresa (lib de mentira
        no require.cache: registra o que recebeu); `_ctxCusto.skuInfoCache` e `_ctxOps.histCache` são lidos NA HORA (o cache que
        nasce depois no arquivo da empresa chega); a vigência retroativa (`_vigenciaDeRef.valor`) entra no registro de custo; os
        estados são os da empresa; montagem incompleta derruba no boot;
     2) as três montam a peça com a empresa, o cache do sku-info e o cache do histórico DELAS, desestruturam os mesmos nomes e
        não têm mais o bloco à mão (`_custoLib.X(_ctxCusto`, `_ctxOps`);
     3) pelo módulo REAL das três: `custoVigenteEm`/`registrarCustoVigente` continuam exportados e funcionando (gravam e leem
        a vigência no cache da empresa), e `estadoReapCusto()` de uma empresa não é o da outra. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) a peça, com lib de mentira */
{
  const chamadas = [];
  const reg = (nome) => (...a) => { chamadas.push([nome, a]); return nome + '!'; };
  const custoFake = {}; for (const n of ['lerCustosManuais', 'gravarCustosManuais', 'custoManualDe', 'comCustosManuais', 'parsearCustosColados', 'telaCustosManuais', 'lerVigencias', 'gravarVigencias', 'registrarCustoVigente', 'custoVigenteEm', 'lerDeParaSku', 'gravarDeParaSku', 'resolverDeParaSku', 'sugerirDeParaSku', 'resolverNomeSku', 'carregarCatalogoDePara']) custoFake[n] = reg(n);
  custoFake._hojeISO = () => 'H'; custoFake._ontemISO = () => 'O'; custoFake._diaAntes = () => 'A';
  const opsFake = { buscarDevolucoesML: reg('buscarDevolucoesML'), varrerFornecedores: reg('varrerFornecedores'), reaplicarCusto: reg('reaplicarCusto'), estadoReaplicar: reg('estadoReaplicar'), estadoVarrerFornecedores: reg('estadoVarrerFornecedores') };
  const rc = require.resolve('../lib/custo'), ro = require.resolve('../lib/vendas-ops');
  const salvo = { [rc]: require.cache[rc], [ro]: require.cache[ro] };
  require.cache[rc] = { id: rc, filename: rc, loaded: true, exports: custoFake };
  require.cache[ro] = { id: ro, filename: ro, loaded: true, exports: opsFake };
  const CE = require('../lib/checkout/custo-empresa');
  let cache = undefined, hist = { h: 1 };
  const deps = { empresa: 'x', CACHE_DIR: '/c', path, fs, readJson: () => 'rj', writeJson: () => true, blingGet: async () => 'bg', skuInfoCache: () => cache, histCache: () => hist };
  const P = CE.criar(deps);
  for (const [k, v] of Object.entries(salvo)) { if (v) require.cache[k] = v; else delete require.cache[k]; }
  assert.deepStrictEqual(Object.keys(P).sort(), ['_ctxCusto', '_ctxOps', '_vigenciaDeRef', 'buscarDevolucoesML', 'carregarCatalogoDePara', 'comCustosManuais', 'custoManualDe', 'custoVigenteEm', 'estadoReapCusto', 'estadoVarrerForn', 'gravarCustosManuais', 'gravarDeParaSku', 'gravarVigencias', 'lerCustosManuais', 'lerDeParaSku', 'lerVigencias', 'parsearCustosColados', 'reaplicarCusto', 'registrarCustoVigente', 'resolverDeParaSku', 'resolverNomeSku', 'sugerirDeParaSku', 'telaCustosManuais', 'varrerFornecedores', '_diaAntes', '_hojeISO', '_ontemISO'].sort());
  /* o contexto do custo: o que é da empresa, e o cache do sku-info por getter (undefined vira null; depois o que nascer) */
  assert.deepStrictEqual([P._ctxCusto.CACHE_DIR, P._ctxCusto.readJson(), P._ctxCusto.skuInfoCache], ['/c', 'rj', null]);
  cache = { S: 1 }; assert.deepStrictEqual(P._ctxCusto.skuInfoCache, { S: 1 }, 'o cache do sku-info é lido na hora');
  assert.deepStrictEqual([P._ctxOps.empresa, P._ctxOps.histCache], ['x', { h: 1 }]); hist = { h: 2 }; assert.deepStrictEqual(P._ctxOps.histCache, { h: 2 }, 'o cache do histórico é lido na hora');
  /* cada atalho chama o lib com o contexto da empresa e os argumentos na ordem */
  P.lerCustosManuais(); P.gravarCustosManuais('g'); P.custoManualDe('s', 'b'); P.comCustosManuais('m'); P.parsearCustosColados('t'); P.telaCustosManuais('n', 'mod');
  P.lerVigencias(); P.gravarVigencias('v'); P.registrarCustoVigente('s', 9, 'org'); P.custoVigenteEm('s', '2026-01-01'); P.lerDeParaSku(); P.gravarDeParaSku('d'); P.resolverDeParaSku('s'); P.sugerirDeParaSku('v', ['c']); P.resolverNomeSku('d'); P.carregarCatalogoDePara();
  const c = P._ctxCusto;
  assert.deepStrictEqual(chamadas, [['lerCustosManuais', [c]], ['gravarCustosManuais', [c, 'g']], ['custoManualDe', [c, 's', 'b']], ['comCustosManuais', [c, 'm']], ['parsearCustosColados', ['t']], ['telaCustosManuais', ['n', 'mod']],
    ['lerVigencias', [c]], ['gravarVigencias', [c, 'v']], ['registrarCustoVigente', [c, 's', 9, 'org', null]], ['custoVigenteEm', [c, 's', '2026-01-01']], ['lerDeParaSku', [c]], ['gravarDeParaSku', [c, 'd']], ['resolverDeParaSku', [c, 's']], ['sugerirDeParaSku', [c, 'v', ['c']]], ['resolverNomeSku', [c, 'd']], ['carregarCatalogoDePara', [c]]]);
  /* a vigência retroativa da madrugada entra no registro */
  chamadas.length = 0; P._vigenciaDeRef.valor = '2026-10-01'; P.registrarCustoVigente('s', 9, 'org'); assert.deepStrictEqual(chamadas, [['registrarCustoVigente', [c, 's', 9, 'org', '2026-10-01']]]);
  /* o vendas-ops: com o contexto dele, e os estados da EMPRESA */
  chamadas.length = 0; P.buscarDevolucoesML('tk', 'd'); P.varrerFornecedores(5); P.reaplicarCusto('a', 'b', 'x', { o: 1 }); P.estadoReapCusto(); P.estadoVarrerForn();
  const o2 = P._ctxOps;
  assert.deepStrictEqual(chamadas, [['buscarDevolucoesML', ['tk', 'd']], ['varrerFornecedores', [o2, 5]], ['reaplicarCusto', [o2, 'a', 'b', 'x', { o: 1 }]], ['estadoReaplicar', ['x']], ['estadoVarrerFornecedores', ['x']]]);
  assert.strictEqual(o2.custoVigenteEm, P.custoVigenteEm, 'o vendas-ops recebe o custoVigenteEm da própria peça');
  assert.deepStrictEqual([P._hojeISO(), P._ontemISO(), P._diaAntes()], ['H', 'O', 'A']);
  assert.throws(() => CE.criar({}), /custo-empresa: falta empresa, CACHE_DIR, path/); assert.throws(() => CE.criar(Object.assign({}, deps, { histCache: {} })), /têm que ser funções/);
}

/* 2) as três montam a peça */
for (const [emp, arq, hist] of [['girassol', 'girassol-backup-offline/gbo-app.js', '_histCache'], ['amb', 'amb-checkout-offline/index.js', '_histCache'], ['good', 'good-checkout-offline/index.js', '_histCacheGood']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(s.includes("const _custoEmp = require('../lib/checkout/custo-empresa').criar({ empresa: '" + emp + "', CACHE_DIR, path, fs, readJson, writeJson, blingGet,\n  skuInfoCache: () => (typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null), histCache: () => " + hist + " });"), arq + ': tem que montar a peça do custo com a empresa e os caches dela');
  assert.ok(/const \{ _ctxCusto, _vigenciaDeRef, lerCustosManuais, gravarCustosManuais, custoManualDe, comCustosManuais, parsearCustosColados, telaCustosManuais,\n  lerVigencias, gravarVigencias, registrarCustoVigente, custoVigenteEm, lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku,\n  resolverNomeSku, carregarCatalogoDePara, _hojeISO, _ontemISO, _diaAntes, buscarDevolucoesML, varrerFornecedores, reaplicarCusto, estadoReapCusto, estadoVarrerForn \} = _custoEmp;/.test(s), arq + ': os mesmos nomes, da peça');
  for (const re of [/_custoLib\.\w+\(_ctxCusto/, /const _ctxOps\b/, /const _ctxOpsGood\b/, /const _ctxCusto = \{/, /_ops\.estadoReaplicar\(/, /require\('\.\.\/lib\/vendas-ops'\)\.(varrerFornecedores|reaplicarCusto|estadoReaplicar|estadoVarrerFornecedores)\(/]) assert.ok(!re.test(s), arq + ': sobrou o bloco à mão: ' + re);
}

/* 3) pelo módulo REAL das três: o arquivo carrega com a peça no lugar (a ordem das declarações — os caches nascem depois — continua
      valendo) e o `routes` monta; o /custos-manuais (fábrica do painel, com o `comCustosManuais` da peça) responde pelo passo painel */
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-ce';
const _log = console.log; console.log = () => {};
(async () => {
  try {
    for (const [emp, pref, arq, envDir] of [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR']]) {
      process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-' + emp + '-'));
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const painel = h.passos.find((x) => x.nome === 'painel');
      const u = new URL('http://x' + pref + '/custos-manuais?k=' + encodeURIComponent(process.env.ADMIN_KEY)); const res = { _s: 0, _b: '', writeHead(s2) { this._s = s2; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      const t = await painel.fn({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', u.pathname);
      assert.ok(t === true && res._s === 200 && !/ainda não expõe/.test(res._b), emp + ': /custos-manuais tem que responder pela peça (status ' + res._s + '): ' + res._b.slice(0, 120));
    }
  } finally { console.log = _log; }
  console.log('ok — o custo da empresa é uma peça (lib/checkout/custo-empresa): os mesmos nomes, com o contexto de cada empresa; os caches chegam na hora; as três montam e não têm mais o bloco à mão; o /custos-manuais responde nas três');
  process.exit(0);   /* os módulos reais deixam timers vivos */
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
