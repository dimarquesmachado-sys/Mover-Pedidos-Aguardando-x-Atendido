'use strict';
/* 17/11 — NORTE C, montarCheckout, passo 22: O BACKFILL MANUAL DE UM PERÍODO É A PEÇA lib/checkout/rota-backfill-periodo.

   Eram duas rotas pra mesma coisa — o /backfill da fábrica (Girassol e AMB) e o /backfill-vendas escrito no arquivo da GOOD
   (a última rota PRÓPRIA de um arquivo de entrada). A peça é a união, nos dois nomes e nas três. Aqui:
     1. a peça recusa o que falta (com o nome) e empresa fora do contrato;
     2. com peças de mentira: os dois nomes, GET e POST, só no prefixo da empresa; a TRAVA vem antes de tudo (sem chave nem
        sessão de admin, 404 — e nem o canário rodando aparece pra quem não é admin); o período é obrigatório e conferido
        (formato e de <= ate, 400 — sem as datas NÃO roda o ano inteiro); canário conferindo: espera; já rodando: o eco da
        2ª requisição (mesmo período, mesma empresa, há poucos segundos) e a recusa que diz qual período ocupa; o disparo é
        NA HORA, com a empresa, e a resposta diz onde acompanhar SEM a chave; o motor que falha (rejeita ou lança) vai pro
        log e não derruba o processo;
     3. RODANDO pelos três módulos reais (cada um na pasta temporária dele): os dois nomes chegam à peça pela fábrica (o
        400 dela, com o /backfill-ano na mensagem — o 400 de antes da GOOD não falava dele) e leem o registro de backfill
        DA empresa (o eco sai com a rodada marcada no registro dela). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const RBP = require('../lib/checkout/rota-backfill-periodo');
const ESTADO = require('../lib/checkout/backfill-estado');
process.env.ADMIN_KEY = 'chave-rbp';

let naoTratadas = 0;
process.on('unhandledRejection', () => { naoTratadas++; });
let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim'); process.exitCode = 1; } });

const PECAS = () => ({ json: (res, c, b) => { res.c = c; res.b = b; }, lerChaveAdmin: (req, u) => u.searchParams.get('k'),
  validarSessao: (ck) => (ck === 'sess=dono' ? { nome: 'dono', papel: 'admin' } : (ck === 'sess=op' ? { nome: 'op', papel: 'operador' } : null)),
  ehAdmin: (s) => !!s && s.papel === 'admin', backfillVendas: () => Promise.resolve({ ok: true }), estado: { rodando: false } });

(async () => {
  /* 1. o que falta */
  assert.throws(() => RBP.criar(), /falta empresa/);
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'backfillVendas']) {
    const o = Object.assign({ empresa: 'amb' }, PECAS()); delete o[k];
    assert.throws(() => RBP.criar(o), new RegExp('\\(amb\\): falta ' + k), 'sem ' + k + ' tinha que derrubar');
  }
  assert.throws(() => RBP.criar(Object.assign({ empresa: 'amb' }, PECAS(), { estado: null })), /falta o estado do backfill da empresa/);
  assert.throws(() => RBP.criar(Object.assign({ empresa: 'empresa-que-nao-existe' }, PECAS())), /empresa desconhecida no contrato/);

  /* 2. com peças de mentira, nas três */
  for (const [emp, pasta] of [['girassol', 'girassol-backup-offline'], ['amb', 'amb-checkout-offline'], ['good', 'good-checkout-offline']]) {
    const P = '/' + pasta;
    const chamadas = [];
    const pecas = Object.assign(PECAS(), { backfillVendas: (de, ate, e) => { chamadas.push([de, ate, e, JSON.stringify(ultimo.res)]); return Promise.resolve({ ok: true }); } });
    const canario = { rodando: false, desde: '10:00' };
    const rota = RBP.criar(Object.assign({ empresa: emp, canario }, pecas));
    const ultimo = { res: {} };
    const pedir = async (method, caminho, cookie) => { const u = new URL('http://x' + caminho); const res = {}; ultimo.res = res; const t = await rota({ headers: { cookie } }, res, u, method, u.pathname); return { t, res }; };
    const MES = '?de=2026-10-01&ate=2026-10-31';
    assert.deepStrictEqual(rota.caminhos, [P + '/backfill', P + '/backfill-vendas']);
    assert.ok(RBP.atende(P, 'POST', P + '/backfill-vendas') && !RBP.atende(P, 'PUT', P + '/backfill') && !RBP.atende(P, 'GET', P + '/backfill-status'));
    /* só os dois nomes, GET e POST, no prefixo DELA */
    for (const [m, c] of [['GET', '/' + (emp === 'amb' ? 'good-checkout-offline' : 'amb-checkout-offline') + '/backfill' + MES + '&k=chave-rbp'], ['PUT', P + '/backfill' + MES + '&k=chave-rbp'], ['GET', P + '/backfill-status?k=chave-rbp'], ['GET', P + '/backfill-ano?k=chave-rbp']])
      assert.strictEqual((await pedir(m, c)).t, false, emp + ': ' + m + ' ' + c + ' não é desta rota');
    /* a TRAVA antes de tudo — inclusive do canário */
    canario.rodando = true;
    for (const [qs, ck] of [[MES, undefined], [MES, 'sess=op'], [MES + '&k=errada', undefined]]) {
      const r = await pedir('GET', P + '/backfill' + qs, ck);
      assert.ok(r.t === true && r.res.c === 404 && r.res.b.error === 'not found', emp + ': sem credencial de admin (' + (ck || qs) + ') tinha que ser 404, antes até do canário: ' + JSON.stringify(r.res));
    }
    canario.rodando = false;
    /* servidor SEM a ADMIN_KEY configurada: "sem chave" não pode casar com "chave não configurada" */
    { const kAntes = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
      try {
        const semChave = RBP.criar(Object.assign({ empresa: emp, canario }, pecas, { lerChaveAdmin: (req, u) => u.searchParams.get('k') || undefined }));
        const u = new URL('http://x' + P + '/backfill' + MES); const res = {};
        await semChave({ headers: {} }, res, u, 'GET', u.pathname);
        assert.strictEqual(res.c, 404, emp + ': sem a ADMIN_KEY no servidor, pedir sem chave passou');
      } finally { process.env.ADMIN_KEY = kAntes; } }
    assert.strictEqual(chamadas.length, 0, emp + ': rodou sem credencial');
    /* o período: obrigatório e conferido */
    for (const qs of ['?k=chave-rbp', '?k=chave-rbp&de=2026-10-01', '?k=chave-rbp&ate=2026-10-31', '?k=chave-rbp&de=2026-1-01&ate=2026-10-31', '?k=chave-rbp&de=2026-10-01&ate=31/10/2026', '?k=chave-rbp&de=2026-10-01T00&ate=2026-10-31']) {
      const r = await pedir('GET', P + '/backfill' + qs);
      assert.ok(r.res.c === 400 && /use \?de=AAAA-MM-DD&ate=AAAA-MM-DD/.test(r.res.b.erro) && /\/backfill-ano/.test(r.res.b.erro), emp + ': período ausente/torto (' + qs + ') tinha que ser 400: ' + JSON.stringify(r.res));
    }
    let r = await pedir('POST', P + '/backfill-vendas?k=chave-rbp&de=2026-10-31&ate=2026-10-01');
    assert.ok(r.res.c === 400 && r.res.b.erro === 'de maior que ate', emp + ': de > ate tinha que ser 400');
    assert.strictEqual(chamadas.length, 0, emp + ': período inválido disparou o backfill (sem as datas, a rota da fábrica rodava o ANO inteiro)');
    /* o canário conferindo o Bling: espera */
    canario.rodando = true;
    r = await pedir('GET', P + '/backfill' + MES + '&k=chave-rbp');
    assert.ok(r.res.c === 200 && r.res.b.ok === false && /o canário está conferindo o Bling agora \(desde 10:00\)/.test(r.res.b.msg) && chamadas.length === 0, emp + ': com o canário rodando o backfill tinha que esperar');
    canario.rodando = false;
    /* dispara: na hora, com a empresa — pela chave e pela sessão de admin, nos dois nomes, GET e POST */
    for (const [m, nome, qs, ck] of [['GET', '/backfill', MES + '&k=chave-rbp', undefined], ['POST', '/backfill-vendas', MES, 'sess=dono'], ['GET', '/backfill-vendas', MES + '&k=chave-rbp', undefined], ['POST', '/backfill', MES, 'sess=dono']]) {
      const antes = chamadas.length;
      r = await pedir(m, P + nome + qs, ck);
      assert.ok(r.t === true && r.res.c === 200 && r.res.b.ok === true && /backfill iniciado em background/.test(r.res.b.msg), emp + ': ' + m + ' ' + nome + ' não disparou: ' + JSON.stringify(r.res));
      assert.deepStrictEqual(chamadas.slice(antes).map((x) => x.slice(0, 3)), [['2026-10-01', '2026-10-31', emp]], emp + ': o disparo não foi com o período e a empresa');
      assert.strictEqual(chamadas[antes][3], '{}', emp + ': o motor tem que ser chamado NA HORA (antes de responder), pra o andamento já sair "rodando" pro eco');
      assert.ok(r.res.b.acompanhe === P + '/backfill-status' && !JSON.stringify(r.res.b).includes('chave-rbp'), emp + ': a resposta tem que dizer onde acompanhar SEM a chave de admin: ' + JSON.stringify(r.res.b));
    }
    /* já rodando: o eco e a recusa */
    const rodando = (o) => { const e = Object.assign({ rodando: true, empresa: emp, de: '2026-10-01', ate: '2026-10-31', inicio: new Date().toISOString() }, o); return RBP.criar(Object.assign({ empresa: emp, canario }, pecas, { estado: e })); };
    const comEstado = async (o) => { const rr = rodando(o); const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp'); const res = {}; await rr({ headers: {} }, res, u, 'GET', u.pathname); return res; };
    const antes = chamadas.length;
    let x = await comEstado({});
    assert.ok(x.b.ok === true && /já foi iniciado/.test(x.b.msg), emp + ': a 2ª requisição do navegador apareceu como recusa');
    x = await comEstado({ inicio: new Date(Date.now() - 600000).toISOString() });
    assert.ok(x.b.ok === false && /já tem um backfill DESTE período rodando desde/.test(x.b.msg), emp + ': a rodada de 10 min atrás virou eco');
    x = await comEstado({ de: '2026-09-01', ate: '2026-09-30' });
    assert.ok(x.b.ok === false && /já tem um backfill rodando \(2026-09-01 a 2026-09-30\)/.test(x.b.msg), emp + ': outro período rodando tem que ser recusa dizendo qual');
    x = await comEstado({ inicio: undefined });
    assert.ok(x.b.ok === false, emp + ': estado sem carimbo de início virou eco');
    x = await comEstado({ empresa: emp === 'good' ? 'amb' : 'good' });
    assert.ok(x.b.ok === false, emp + ': Codex #519 — a rodada de OUTRA empresa com o mesmo período apareceu como "iniciado"');
    assert.strictEqual(chamadas.length, antes, emp + ': com backfill rodando a rota disparou outro');
    /* o motor que falha não derruba nada: rejeição e exceção vão pro log */
    const logs = []; const _e = console.error; console.error = (m) => logs.push(String(m));
    try {
      for (const bv of [() => Promise.reject(new Error('Bling fora')), () => { throw new Error('quebrou na hora'); }]) {
        const rr = RBP.criar(Object.assign({ empresa: emp, canario }, PECAS(), { backfillVendas: bv }));
        const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp'); const res = {};
        assert.strictEqual(await rr({ headers: {} }, res, u, 'GET', u.pathname), true);
        assert.ok(res.c === 200 && res.b.ok === true, emp + ': a falha do motor depois do disparo não muda a resposta');
      }
      await new Promise((ok) => setImmediate(ok));
    } finally { console.error = _e; }
    assert.ok(logs.some((l) => /backfill 2026-10-01→2026-10-31 falhou: Bling fora/.test(l)) && logs.some((l) => /falhou: quebrou na hora/.test(l)), emp + ': a falha do motor tem que ir pro log: ' + logs.join(' | '));
    /* Codex #937: o motor que RECUSA (adiado / nao_rodou) sem tocar no registro — a recusa e o motivo ficam no registro da empresa */
    for (const [rec, fase, motivo] of [[{ ok: false, desfecho: 'adiado', msg: 'caça da Magalu gravando agora — backfill adiado' }, 'nao_rodou', /caça da Magalu/],
                                       [{ ok: false, desfecho: 'adiado', adiado: 'reparo de SKU em andamento' }, 'nao_rodou', /reparo de SKU/],
                                       [{ ok: false, desfecho: 'nao_rodou', msg: 'recusou iniciar' }, 'nao_rodou', /recusou iniciar/]]) {
      const est = { rodando: false, fase: 'parado', de: '2026-01-01', ate: '2026-01-31', msg: 'rodada antiga' };
      const rr = RBP.criar(Object.assign({ empresa: emp, canario }, PECAS(), { estado: est, backfillVendas: () => Promise.resolve(rec) }));
      const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp'); const res = {};
      assert.strictEqual(await rr({ headers: {} }, res, u, 'GET', u.pathname), true);
      await new Promise((ok) => setImmediate(ok));
      assert.ok(est.rodando === false && est.fase === fase && est.de === '2026-10-01' && est.ate === '2026-10-31' && motivo.test(est.msg) && est.desfecho === rec.desfecho,
        emp + ': a recusa do motor não ficou no registro: ' + JSON.stringify(est));
    }
    /* recusa com OUTRA rodada já rodando não pisa nela */
    { const est = { rodando: false, fase: 'parado', msg: '' };
      const rr = RBP.criar(Object.assign({ empresa: emp, canario }, PECAS(), { estado: est, backfillVendas: () => { est.rodando = true; est.fase = 'lendo'; return Promise.resolve({ ok: false, desfecho: 'adiado', msg: 'x' }); } }));
      const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp');
      await rr({ headers: {} }, {}, u, 'GET', u.pathname); await new Promise((ok) => setImmediate(ok));
      assert.ok(est.rodando === true && est.fase === 'lendo', emp + ': a recusa pisou numa rodada em andamento'); }
  }
  assert.strictEqual(naoTratadas, 0, 'a falha do motor virou rejeição não tratada (derrubaria o processo)');

  /* 3. RODANDO pelos módulos reais */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbp-'));
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const [emp, arq, tag] of [['girassol', 'girassol-backup-offline/gbo-app.js', 'GIRABKP'], ['amb', 'amb-checkout-offline/index.js', 'AMBBKP'], ['good', 'good-checkout-offline/index.js', 'GOODBKP']]) {
      process.env[tag + '_CACHE_DIR'] = path.join(tmp, emp);
      const pref = require('../lib/checkout/config-empresa').prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const pedir = async (method, caminho) => { const u = new URL('http://x' + pref + caminho); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
        await h({ method, url: u.pathname + u.search, headers: {} }, res, u); let b = null; try { b = JSON.parse(res._b); } catch (e2) {} return { s: res._s, b }; };
      for (const [m, nome] of [['GET', '/backfill'], ['GET', '/backfill-vendas'], ['POST', '/backfill-vendas'], ['POST', '/backfill']]) {
        const r = await pedir(m, nome + '?k=chave-rbp');
        assert.ok(r.s === 400 && r.b && /\/backfill-ano/.test(r.b.erro), emp + ': ' + m + ' ' + nome + ' sem o período não chegou à peça: ' + JSON.stringify(r));
      }
      /* o registro lido é o DA empresa: com a rodada dela (mesmo período, agora) é eco; com a de outra empresa, nada aparece */
      const est = ESTADO.estado(emp);
      Object.assign(est, { rodando: true, empresa: emp, de: '2026-10-01', ate: '2026-10-31', inicio: new Date().toISOString() });
      let r = await pedir('GET', '/backfill-vendas?k=chave-rbp&de=2026-10-01&ate=2026-10-31');
      assert.ok(r.s === 200 && r.b.ok === true && /já foi iniciado/.test(r.b.msg) && r.b.acompanhe === pref + '/backfill-status' && !JSON.stringify(r.b).includes('chave-rbp'), emp + ': a peça não leu o registro de backfill DELA: ' + JSON.stringify(r).slice(0, 300));
      est.rodando = false;
      r = await pedir('POST', '/backfill?k=chave-rbp&de=2026-10-31&ate=2026-10-01');
      assert.ok(r.s === 400 && r.b.erro === 'de maior que ate', emp + ': ' + JSON.stringify(r));
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }

  /* nenhum arquivo de entrada escreve mais a rota (a GOOD tinha o /backfill-vendas) */
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(!/p === '\/[a-z-]+-(?:backup|checkout)-offline\/backfill(?:-vendas)?'/.test(s) && !/_rotaBackfillVendas/.test(s), arq + ': voltou a escrever a rota do backfill manual');
  }
  _chegouAoFim = true;
  console.log('ok — o backfill manual de um período é uma peça só (/backfill e /backfill-vendas, nas três): a trava antes de tudo, o período obrigatório e conferido, o canário e o eco, o disparo na hora com a empresa, sem a chave na resposta, e o registro da empresa');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
