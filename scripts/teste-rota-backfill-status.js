'use strict';
/* 17/11 — NORTE C, montarCheckout, passo 21: O /backfill-status DA EMPRESA É A PEÇA lib/checkout/rota-backfill-status.

   Era a última rota própria escrita nos três arquivos de entrada (a mesma trava e o prefixo à mão; o que cada uma MOSTRA
   continua dela). Aqui:
     1. a peça recusa o que falta (com o nome) e empresa fora do contrato;
     2. a trava, com peças de mentira: no prefixo do contrato (não no de outra, nem POST); sem chave nem sessão de admin, 404
        (rota de diagnóstico não confirma que existe); chave de admin passa; sessão de admin passa; sessão de operador, 404;
        o corpo é `{ ok, status, plano }` — o `status` é o MESMO objeto do registro da empresa (backfill-estado) — e os
        `extras` entram sem tirar `ok`, `status` nem `plano` do lugar;
     3. RODANDO pelos módulos reais (cada um na pasta temporária dele): a Girassol e a AMB respondem EXATAMENTE `{ ok, status,
        plano }` (o andamento do registro DELAS e o plano em fatias delas); a GOOD responde o que já respondia (o estado da
        última rodada dela, a rotina diária e o plano com o motor) e GANHA o `ok` e o `status` do registro DELA. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const RBS = require('../lib/checkout/rota-backfill-status');
const ESTADO = require('../lib/checkout/backfill-estado');
process.env.ADMIN_KEY = 'chave-rbs';

const PECAS = () => ({ json: (res, c, b) => { res.c = c; res.b = b; }, lerChaveAdmin: (req, u) => u.searchParams.get('k'),
  validarSessao: (ck) => (ck === 'sess=dono' ? { nome: 'dono', papel: 'admin' } : (ck === 'sess=op' ? { nome: 'op', papel: 'operador' } : null)),
  ehAdmin: (s) => !!s && s.papel === 'admin', plano: { status: () => ({ existe: false, motor: { marca: 'plano-de-mentira' } }) } });

(async () => {
  /* 1. o que falta */
  assert.throws(() => RBS.criar(), /falta empresa/);
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin']) {
    const o = Object.assign({ empresa: 'amb' }, PECAS()); delete o[k];
    assert.throws(() => RBS.criar(o), new RegExp('\\(amb\\): falta ' + k), 'sem ' + k + ' tinha que derrubar');
  }
  assert.throws(() => RBS.criar(Object.assign({ empresa: 'amb' }, PECAS(), { plano: {} })), /falta o plano em fatias da empresa/);
  assert.throws(() => RBS.criar(Object.assign({ empresa: 'amb' }, PECAS(), { extras: { a: 1 } })), /extras tem que ser função/);
  assert.throws(() => RBS.criar(Object.assign({ empresa: 'empresa-que-nao-existe' }, PECAS())), /empresa desconhecida no contrato/);

  /* 2. a trava e o corpo, com peças de mentira, nas três */
  for (const [emp, pasta] of [['girassol', 'girassol-backup-offline'], ['amb', 'amb-checkout-offline'], ['good', 'good-checkout-offline']]) {
    const rota = RBS.criar(Object.assign({ empresa: emp }, PECAS()));
    const P = '/' + pasta + '/backfill-status';
    const pedir = async (method, caminho, cookie) => { const u = new URL('http://x' + caminho); const res = {}; const t = await rota({ headers: { cookie } }, res, u, method, u.pathname); return { t, res }; };
    assert.strictEqual((await pedir('GET', '/' + (emp === 'amb' ? 'good-checkout-offline' : 'amb-checkout-offline') + '/backfill-status?k=chave-rbs')).t, false, emp + ': respondeu no prefixo de outra');
    assert.strictEqual((await pedir('POST', P + '?k=chave-rbs')).t, false, emp + ': respondeu POST');
    let r = await pedir('GET', P);
    assert.ok(r.t === true && r.res.c === 404 && r.res.b.error === 'not found', emp + ': sem credencial tinha que ser 404');
    r = await pedir('GET', P, 'sess=op');
    assert.ok(r.t === true && r.res.c === 404, emp + ': sessão de operador passou');
    r = await pedir('GET', P + '?k=errada');
    assert.ok(r.t === true && r.res.c === 404, emp + ': chave errada passou');
    for (const [qs, ck] of [['?k=chave-rbs', undefined], ['', 'sess=dono']]) {
      r = await pedir('GET', P + qs, ck);
      assert.ok(r.t === true && r.res.c === 200, emp + ': ' + (ck ? 'a sessão' : 'a chave') + ' de admin não passou');
      /* 17/11 (passo 22, Codex #937): + `manual`, o desfecho da última rodada manual de um período (o registro da empresa) */
      assert.deepStrictEqual(Object.keys(r.res.b), ['ok', 'status', 'plano', 'manual'], emp + ': o corpo mudou de forma');
      assert.ok(r.res.b.ok === true && r.res.b.status === ESTADO.estado(emp) && r.res.b.plano.motor.marca === 'plano-de-mentira', emp + ': o corpo não é o andamento do registro dela e o plano dela');
      assert.strictEqual(r.res.b.manual, ESTADO.manual(emp), emp + ': o `manual` não é o registro da rodada manual DELA');
    }
    /* os extras entram sem tirar ok/status/plano do lugar */
    const rx = RBS.criar(Object.assign({ empresa: emp }, PECAS(), { extras: () => ({ estado: 'rodando', ok: false, status: 'outro', plano: 'outro', diario: { x: 1 } }) }));
    const res = {}; await rx({ headers: {} }, res, new URL('http://x' + P + '?k=chave-rbs'), 'GET', P);
    assert.ok(res.b.estado === 'rodando' && res.b.diario.x === 1 && res.b.ok === true && res.b.status === ESTADO.estado(emp) && res.b.plano.motor.marca === 'plano-de-mentira', emp + ': os extras tiraram o ok/status/plano do lugar');
  }

  /* 3. RODANDO pelos módulos reais */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbs-'));
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const [emp, arq, tag] of [['girassol', 'girassol-backup-offline/gbo-app.js', 'GIRABKP'], ['amb', 'amb-checkout-offline/index.js', 'AMBBKP'], ['good', 'good-checkout-offline/index.js', 'GOODBKP']]) {
      process.env[tag + '_CACHE_DIR'] = path.join(tmp, emp);
      const pref = require('../lib/checkout/config-empresa').prefixoDe(emp);
      const est = ESTADO.estado(emp); est.msg = 'MARCA-' + emp;
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const u = new URL('http://x' + pref + '/backfill-status?k=chave-rbs');
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
      assert.strictEqual(res._s, 200, emp + ': ' + res._b.slice(0, 200));
      const b = JSON.parse(res._b);
      assert.ok(b.ok === true && b.status && b.status.msg === 'MARCA-' + emp, emp + ': o /backfill-status não mostra o andamento do registro DELA');
      assert.ok(b.plano && 'existe' in b.plano && b.plano.motor && typeof b.plano.motor === 'object', emp + ': o /backfill-status não mostra o plano em fatias dela');
      if (emp === 'good') {
        assert.ok(b.estado === 'nunca rodou neste processo' && b.diario && typeof b.diario === 'object', 'GOOD: deixou de mostrar o estado da última rodada dela ou a rotina diária: ' + JSON.stringify(b).slice(0, 300));
        assert.deepStrictEqual(Object.keys(b).sort(), ['diario', 'estado', 'manual', 'ok', 'plano', 'status'], 'GOOD: o corpo mudou além do que ganhou');
      } else {
        assert.deepStrictEqual(Object.keys(b), ['ok', 'status', 'plano', 'manual'], emp + ': o corpo mudou de forma');
      }
      /* a rodada manual DELA (e não a de outra empresa) */
      ESTADO.marcarManual(emp, { estado: 'nao_rodou', motivo: 'MARCA-MANUAL-' + emp });
      const res2 = { _s: 0, _b: '', writeHead(s2) { this._s = s2; }, setHeader() {}, end(b2) { this._b = String(b2 || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res2, u);
      assert.strictEqual(JSON.parse(res2._b).manual.motivo, 'MARCA-MANUAL-' + emp, emp + ': o /backfill-status não mostra a rodada manual DELA');
      est.msg = '';
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — /backfill-status: peça única das três (a trava e o prefixo do contrato); Girassol e AMB mostram o mesmo de sempre, a GOOD o dela + o andamento do registro');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
