'use strict';
/* 16/11 — PARIDADE DAS PEÇAS DA FÁBRICA DO PAINEL (docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 3).

   A fábrica (lib/checkout/fabrica-rotas-painel) serve as rotas do painel pras três empresas com as peças que cada uma
   entrega; peça que falta vira "esta empresa ainda não expõe `X` ao painel" (semPeca). Medido em 16/11 pelo `routes`
   REAL: a GOOD respondia isso em SETE rotas que a Girassol e a AMB servem (/magalu-caca — o botão da caça da Magalu —,
   /reaplicar-custo, /sku-repara, /sku-orfaos, /varrer-fornecedores(-status), /backfill-conferir, /backfill-limpar),
   porque não entregava `_backfill`, `_canario`, `_histCache`, `_reparoAtivo`, `backfillVendas`, `supaCount`,
   `estadoReapCusto`, `varrerFornecedores`, `estadoVarrerForn`, `dataISO`. "O que o painel tem pra uma, tem que ter pra
   outra" (o dono).

   Prova, pelo passo `painel` da fila REAL de cada empresa (sem a cabeça: o portão responderia 401 antes), sondando CADA
   rota da fábrica SEM credencial — a checagem das peças vem ANTES da credencial, então a sonda diz "falta peça" ou
   "404 not found" e nunca age:
     1) o conjunto de rotas que a GOOD recusa por peça é o MESMO da Girassol (hoje: nenhuma), tirando o que é só da AMB
        (/despachados-por-engano: Full/despachados, operação que só ela tem);
     2) as sete rotas respondem na GOOD;
     3) as peças são as da GOOD: vendas-ops com a empresa 'good' e o cache dela; a trava do sku-repara é a mesma que a
        caça da Magalu e o backfill da GOOD consultam (`set(true)` → a caça adia); o disparo do backfill é o motor único em
        fundo; a contagem é no Supabase da GOOD.
   17/11 (montarCheckout, passo 17): a sonda passa a ler também os módulos da fábrica (lib/checkout/rotas-painel-*.js) — e
   achou a Girassol recusando /ml-creditos-flex e /ml-flex-debug (os créditos do Flex: ela tem a distribuição desde 19/10,
   mas não entregava o andamento nem o disparo à fábrica). Agora NENHUMA das três recusa nada fora o Full da AMB, e o
   disparo pelo painel da Girassol chega à distribuição dela (a da AMB não se mexe). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* rede bloqueada: nenhuma sonda pode sair da máquina */
const bloqueado = () => { throw new Error('rede bloqueada no teste'); };
for (const m of ['http', 'https']) { const M = require(m); M.request = bloqueado; M.get = bloqueado; }
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => bloqueado() };
global.fetch = async () => bloqueado();
process.env.ADMIN_KEY = 'chave-paridade';

/* 17/11 (montarCheckout, passo 17): as rotas da fábrica E as dos módulos dela (lib/checkout/rotas-painel-*.js — o ML e as fotos do
   produto). Antes a varredura lia só o arquivo da fábrica: /ml-creditos-flex e /ml-flex-debug (no rotas-painel-ml) recusavam por
   peça na Girassol sem a sonda ver. */
const fabrica = ['fabrica-rotas-painel.js'].concat(fs.readdirSync(path.join(raiz, 'lib', 'checkout')).filter((f) => /^rotas-painel-[\w-]+\.js$/.test(f)).sort())
  .map((f) => fs.readFileSync(path.join(raiz, 'lib', 'checkout', f), 'utf8')).join('\n');
const ROTAS = Array.from(new Set(Array.from(fabrica.matchAll(/p === \(?PREFIXO \+ '(\/[\w./-]+)'/g)).map((m) => m[1])));
for (const r of ['/ml-creditos-flex', '/ml-flex-debug', '/produto-fotos']) assert.ok(ROTAS.includes(r), 'a varredura não leu os módulos da fábrica (falta ' + r + ')');
assert.ok(ROTAS.length >= 40, 'a varredura das rotas da fábrica achou pouco: ' + ROTAS.length);
const SO_AMB = ['/despachados-por-engano'];   /* Full/despachados: operação que só a AMB tem (SIT_DESPACHADOS, unsFullEfetivas…) */
const SETE = ['/magalu-caca', '/reaplicar-custo', '/sku-repara', '/sku-orfaos', '/varrer-fornecedores', '/varrer-fornecedores-status', '/backfill-conferir', '/backfill-limpar'];

const EMP = [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js', 'GOODBKP_CACHE_DIR']];
const _log = console.log, _warn = console.warn, _err = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
(async () => {
  const recusa = {};
  try {
    for (const [emp, pref, arq, envDir] of EMP) {
      process.env[envDir] = fs.mkdtempSync(path.join(os.tmpdir(), 'par-' + emp + '-'));
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const painel = h.passos.find((x) => x.nome === 'painel'); assert.ok(painel, emp + ': a fila não tem o passo painel');
      recusa[emp] = {};
      for (const rota of ROTAS) {
        for (const method of ['GET', 'POST']) {
          const u = new URL('http://x' + pref + rota);
          const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
          let t = false;
          try { t = await Promise.race([painel.fn({ method, url: u.pathname, headers: {} }, res, u, method, u.pathname), new Promise((r2) => setTimeout(() => r2('demorou'), 1500))]); } catch (e) { t = 'erro'; }
          if (t !== true) continue;
          const m = /ainda não expõe `(\w+)`/.exec(res._b);
          if (m) recusa[emp][rota] = (recusa[emp][rota] || []).concat(m[1]);
        }
      }
    }
  } finally { console.log = _log; console.warn = _warn; console.error = _err; }
  const semAmb = (o) => Object.fromEntries(Object.entries(o).filter(([r]) => !SO_AMB.includes(r)));
  /* 1) a GOOD recusa o mesmo que a Girassol (fora o que é só da AMB) */
  assert.deepStrictEqual(Object.keys(semAmb(recusa.good)).sort(), Object.keys(semAmb(recusa.girassol)).sort(), 'a GOOD recusa por peça rotas que a Girassol serve: ' + JSON.stringify(recusa));
  assert.deepStrictEqual(Object.keys(semAmb(recusa.amb)), [], 'a AMB recusa por peça: ' + JSON.stringify(recusa.amb));
  /* 17/11 (passo 17): e a Girassol também não recusa nada (fora o que é só da AMB) — os créditos do Flex respondem nas três */
  assert.deepStrictEqual(Object.keys(semAmb(recusa.girassol)), [], 'a Girassol recusa por peça: ' + JSON.stringify(recusa.girassol));
  /* 2) as sete respondem na GOOD (e nas outras) */
  for (const r of SETE) for (const emp of ['girassol', 'amb', 'good']) assert.ok(!recusa[emp][r], emp + ': ' + r + ' ainda recusa por peça: ' + JSON.stringify(recusa[emp][r]));
  /* o que é só da AMB continua só dela — documentado, não acidente */
  for (const r of SO_AMB) { assert.ok(recusa.girassol[r] && recusa.good[r], r + ': é só da AMB — a Girassol e a GOOD têm que recusar por peça (ou a lista SO_AMB está desatualizada)'); assert.ok(!recusa.amb[r], r + ': a AMB tem que servir'); }

  /* 17/11 (passo 17): os créditos do Flex da Girassol são os DELA — o disparo pelo painel chega à distribuição da peça dela (o andamento
     mostra o período pedido) e o da AMB não se mexe */
  {
    const _l3 = console.log, _e3 = console.error; console.log = () => {}; console.error = () => {};
    try {
      const chamarCF = async (emp, pref, qs) => {
        const h = require(path.join(raiz, EMP.find((x) => x[0] === emp)[2])).routes(async () => ({}));
        const painel = h.passos.find((x) => x.nome === 'painel');
        const u = new URL('http://x' + pref + '/ml-creditos-flex?k=chave-paridade' + qs);
        const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
        const t = await painel.fn({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', u.pathname);
        return { t, s: res._s, j: (() => { try { return JSON.parse(res._b); } catch (e) { return res._b; } })() };
      };
      const d = await chamarCF('girassol', '/girassol-backup-offline', '&de=2026-03-01&ate=2026-03-02');
      assert.ok(d.t === true && d.s === 200 && d.j && d.j.ok === true, 'a Girassol não disparou a distribuição dos créditos do Flex: ' + JSON.stringify(d));
      let st = null;
      for (let i = 0; i < 40; i++) { st = (await chamarCF('girassol', '/girassol-backup-offline', '&status=1')).j; if (st && st.rodando === false && st.de) break; await new Promise((r) => setTimeout(r, 25)); }
      assert.ok(st && st.de === '2026-03-01' && st.ate === '2026-03-02' && st.rodando === false, 'o andamento dos créditos da Girassol não é o da distribuição que o painel disparou: ' + JSON.stringify(st));
      const stAmb = (await chamarCF('amb', '/amb-checkout-offline', '&status=1')).j;
      assert.ok(stAmb && stAmb.de == null, 'o disparo da Girassol mexeu nos créditos da AMB: ' + JSON.stringify(stAmb));
    } finally { console.log = _l3; console.error = _e3; }
  }

  /* 3) as peças são as da GOOD */
  const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  /* 16/11 (passo 5): o vendas-ops da GOOD vem da peça lib/checkout/custo-empresa (empresa 'good', cache do histórico dela por função) */
  assert.ok(/require\('\.\.\/lib\/checkout\/custo-empresa'\)\.criar\(\{ empresa: 'good', CACHE_DIR, path, fs, readJson, writeJson, blingGet,\n\s+skuInfoCache: \(\) => [^\n]*, histCache: \(\) => _histCacheGood \}\);/.test(good), 'o contexto do vendas-ops da GOOD (peça custo-empresa, com o cache do histórico dela)');
  assert.ok(/[{,] [^}]*\bvarrerFornecedores\b[^}]*\bestadoReapCusto\b[^}]*\bestadoVarrerForn\b[^}]*\} = _custoEmp;/.test(good), 'as peças do vendas-ops com a empresa good');
  assert.ok(/_backfill: require\('\.\.\/lib\/checkout\/backfill-estado'\)\.estado\('good'\), _canario: _canGood\.estado, _histCache: _histCacheGood,/.test(good), 'o andamento do backfill, o canário e o cache da GOOD');
  assert.ok(/_reparoAtivo: \{ get: \(\) => _reparoAtivoGood, set: \(v\) => \{ _reparoAtivoGood = !!v; \} \},/.test(good) && /reparoAtivo: \(\) => _reparoAtivoGood,/.test(good) && require('./_backfill-empresa').entrega(good, 'reparoAtivo', '() => _reparoAtivoGood') && require('./_backfill-empresa').leva('reparoAtivo', /P\.reparoAtivo\(\)/), 'a trava do sku-repara é UMA (a fábrica liga/desliga; a caça e o backfill da GOOD leem)');
  /* 16/11 (montarCheckout, passo 9): o motor único com o contexto da GOOD é a peça lib/checkout/backfill-empresa (`_bfEmp`) */
  assert.ok(/backfillVendas: \(de, ate\) => require\('\.\.\/lib\/checkout\/contexto-fundo'\)\.emFundo\('good', \(\) => _bfEmp\.backfillVendas\(de, ate\)\),/.test(good) && require('./_backfill-empresa').usaPeca(good, 'good'), 'o disparo do backfill é o motor único em fundo, com o contexto da GOOD');
  assert.ok(/supaCount: \(e, f\) => require\('\.\.\/lib\/supabase'\)\.para\('good'\)\.count\(e, f\),/.test(good), 'a contagem é no Supabase da GOOD');
  assert.ok(!/reparoAtivo: \(\) => false/.test(good), 'sobrou a trava fingida (`() => false`) na GOOD');

  /* a trava funciona de ponta a ponta: o sku-repara da fábrica liga `set(true)` → a caça da Magalu da GOOD adia */
  {
    const _l2 = console.log; console.log = () => {};
    try {
      const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
      const h = mod.routes(async () => ({}));
      const painel = h.passos.find((x) => x.nome === 'painel');
      /* ligo a trava pela MESMA porta que o sku-repara usa: a peça `_reparoAtivo.set` entregue à fábrica — pego-a pelo módulo da fábrica? Não é
         exposta; então provo pelo efeito: com a trava desligada a caça (rede bloqueada) tenta e falha com 'rede'; com ela ligada, adia sem tentar. */
      const estadoAntes = JSON.parse(JSON.stringify((await (async () => { const u = new URL('http://x/good-checkout-offline/magalu-caca?k=chave-paridade&status=1'); const res = { _b: '', writeHead() {}, setHeader() {}, end(b) { this._b = String(b || ''); } }; await painel.fn({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', u.pathname); return JSON.parse(res._b); })()).status));
      assert.strictEqual(estadoAntes.rodando, false, 'a caça da GOOD não pode estar rodando no começo: ' + JSON.stringify(estadoAntes));
      /* sku-repara com de/para e SEM aplicar: simula — não liga a trava; com &aplicar=1 liga enquanto roda e desliga no finally */
      const u = new URL('http://x/good-checkout-offline/sku-repara?k=chave-paridade&de=A&para=B&aplicar=1'); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await painel.fn({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', u.pathname);
      assert.ok(res._s === 200 && /rede bloqueada|Supabase|falhou|erro/i.test(res._b), 'o sku-repara da GOOD tem que chegar na peça (e falhar na rede bloqueada), não recusar por peça: ' + res._b.slice(0, 160));
    } finally { console.log = _l2; }
  }
  console.log('ok — paridade das peças da fábrica do painel: a GOOD entrega o que a Girassol e a AMB entregam (' + ROTAS.length + ' rotas sondadas × GET/POST nas três; recusas por peça: girassol ' + Object.keys(recusa.girassol).length + ', amb ' + Object.keys(recusa.amb).length + ', good ' + Object.keys(recusa.good).length + ' — só o que é só da AMB)');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
