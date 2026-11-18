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
    /* o motor de mentira padrão leva mais que a espera da resposta (a rodada segue em segundo plano, como a de verdade) */
    const pecas = Object.assign(PECAS(), { esperaRecusaMs: 5, backfillVendas: (de, ate, e) => { chamadas.push([de, ate, e, JSON.stringify(ultimo.res)]); return new Promise((ok) => setTimeout(() => ok({ ok: true, desfecho: 'ok', pedidos: 3 }), 40)); } });
    const canario = { rodando: false, desde: '10:00' };
    const rota = RBP.criar(Object.assign({ empresa: emp, canario }, pecas));
    const livre = () => ESTADO.marcarManual(emp, { estado: 'ok' });   /* a rodada manual anterior terminou (sem esperar o relógio do motor de mentira) */
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
      assert.ok(ESTADO.manual(emp).estado === 'rodando' && ESTADO.manual(emp).de === '2026-10-01', emp + ': a rodada manual tem que aparecer "rodando" no registro da empresa');
      livre();
    }
    /* Codex #937: o DESFECHO da rodada manual fica no registro (o /backfill-status mostra) — inclusive a recusa do motor,
       que vem antes de qualquer trabalho e não mexe no andamento; se vier logo, a resposta já diz que NÃO rodou e por quê */
    {
      const motor = (resposta, ms) => RBP.criar(Object.assign({ empresa: emp, canario }, PECAS(), { esperaRecusaMs: 30, backfillVendas: () => (ms ? new Promise((ok) => setTimeout(() => ok(resposta), ms)) : Promise.resolve(resposta)) }));
      const disparar = async (rr) => { const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp'); const res = {}; await rr({ headers: {} }, res, u, 'GET', u.pathname); return res; };
      for (const [resp, motivo] of [[{ ok: false, desfecho: 'adiado', adiado: 'reparo de SKU em andamento' }, 'reparo de SKU em andamento'],
        [{ ok: false, desfecho: 'adiado', msg: 'caça da Magalu gravando agora — backfill adiado' }, 'caça da Magalu gravando agora'],
        [{ adiado: 'o servidor está encerrando' }, 'o servidor está encerrando'],
        [{ ok: false, desfecho: 'ja_rodando', de: '2026-09-01', ate: '2026-09-30' }, 'já havia um backfill em andamento (2026-09-01 a 2026-09-30)']]) {
        livre();
        const res = await disparar(motor(resp));
        assert.ok(res.c === 200 && res.b.ok === false && res.b.msg.startsWith('o backfill NÃO rodou: ') && res.b.msg.includes(motivo), emp + ': a recusa do motor (' + JSON.stringify(resp) + ') saiu como "iniciado": ' + JSON.stringify(res.b));
        const m = ESTADO.manual(emp);
        assert.ok(m.estado === 'nao_rodou' && m.motivo.includes(motivo) && m.de === '2026-10-01' && m.ate === '2026-10-31' && m.terminado, emp + ': a recusa não ficou no registro da rodada manual: ' + JSON.stringify(m));
      }
      /* falha rápida e conclusão rápida também são ditas */
      livre();
      let res = await disparar(motor({ ok: false, desfecho: 'abortado', msg: 'trava de sanidade: NADA foi apagado' }));
      assert.ok(res.b.ok === false && /^o backfill falhou: trava de sanidade/.test(res.b.msg) && ESTADO.manual(emp).estado === 'falhou', emp + ': o abortado tem que ser dito e registrado');
      livre();
      res = await disparar(motor({ ok: true, desfecho: 'com_erros', erros: 2 }));
      assert.ok(res.b.ok === true && /terminou — terminou, mas houve erros/.test(res.b.msg) && ESTADO.manual(emp).estado === 'concluido_com_erros' && ESTADO.manual(emp).erros === 2, emp + ': o com_erros tem que ser dito e registrado');
      /* a recusa que vem DEPOIS da espera: a resposta já disse "iniciado", e o registro guarda o que houve */
      livre();
      res = await disparar(motor({ ok: false, desfecho: 'adiado', msg: 'canário conferindo o Bling agora — backfill adiado' }, 80));
      assert.ok(res.b.ok === true && /iniciado em background/.test(res.b.msg) && ESTADO.manual(emp).estado === 'rodando', emp + ': sem o desfecho dentro da espera, a resposta é "iniciado" e a rodada segue marcada');
      /* enquanto a rodada manual espera a vez (o motor ainda nem marcou o andamento), outro pedido NÃO dispara outra */
      const outro = await disparar(motor({ ok: true }));
      assert.ok(outro.b.ok === true && /já foi iniciado/.test(outro.b.msg), emp + ': a 2ª requisição durante a espera da rodada manual tinha que ser o eco: ' + JSON.stringify(outro.b));
      const u2 = new URL('http://x' + P + '/backfill?de=2026-09-01&ate=2026-09-30&k=chave-rbp'); const r2 = {};
      await motor({ ok: true })({ headers: {} }, r2, u2, 'GET', u2.pathname);
      assert.ok(r2.b.ok === false && /já tem um backfill rodando \(2026-10-01 a 2026-10-31\)/.test(r2.b.msg), emp + ': outro período durante a rodada manual tinha que ser recusa: ' + JSON.stringify(r2.b));
      await new Promise((ok) => setTimeout(ok, 120));
      assert.ok(ESTADO.manual(emp).estado === 'nao_rodou' && /canário conferindo/.test(ESTADO.manual(emp).motivo), emp + ': a recusa tardia não ficou no registro: ' + JSON.stringify(ESTADO.manual(emp)));
      /* o desfecho de uma rodada velha não passa por cima de uma nova */
      livre();
      const lenta = motor({ ok: false, desfecho: 'adiado', adiado: 'velha' }, 60);
      await disparar(lenta);
      ESTADO.marcarManual(emp, { estado: 'rodando', marca: 'outra-rodada', de: '2026-11-01', ate: '2026-11-15' });
      await new Promise((ok) => setTimeout(ok, 100));
      assert.strictEqual(ESTADO.manual(emp).marca, 'outra-rodada', emp + ': o desfecho de uma rodada velha passou por cima da nova');
      livre();
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
    /* o motor que falha não derruba nada: rejeição e exceção vão pro log e pro registro da rodada manual (e a resposta diz) */
    const logs = []; const _e = console.error; console.error = (m) => logs.push(String(m));
    try {
      for (const [bv, txt] of [[() => Promise.reject(new Error('Bling fora')), 'Bling fora'], [() => { throw new Error('quebrou na hora'); }, 'quebrou na hora']]) {
        livre();
        const rr = RBP.criar(Object.assign({ empresa: emp, canario }, PECAS(), { esperaRecusaMs: 30, backfillVendas: bv }));
        const u = new URL('http://x' + P + '/backfill' + MES + '&k=chave-rbp'); const res = {};
        assert.strictEqual(await rr({ headers: {} }, res, u, 'GET', u.pathname), true);
        assert.ok(res.c === 200 && res.b.ok === false && res.b.msg === 'o backfill falhou: ' + txt, emp + ': a falha do motor tem que ser dita: ' + JSON.stringify(res.b));
        assert.ok(ESTADO.manual(emp).estado === 'falhou' && ESTADO.manual(emp).motivo === txt, emp + ': a falha do motor tem que ficar no registro');
      }
      await new Promise((ok) => setImmediate(ok));
    } finally { console.error = _e; }
    assert.ok(logs.some((l) => /backfill 2026-10-01→2026-10-31 falhou: Bling fora/.test(l)) && logs.some((l) => /falhou: quebrou na hora/.test(l)), emp + ': a falha do motor tem que ir pro log: ' + logs.join(' | '));
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
