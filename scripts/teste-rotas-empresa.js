'use strict';
/* 16/11 — A FILA DE PEÇAS DE ROTA É UMA PEÇA (lib/checkout/rotas-empresa), NA MESMA ORDEM NAS TRÊS (docs/NORTE-2026-11.md, item C).

   O `handle` das três empresas era a mesma fila de peças em ordens DIFERENTES (a GOOD consultava a fábrica do painel antes
   de tudo; a AMB punha o canário antes das rotas comuns e o diagnóstico depois da fábrica). Ordem é segurança (Codex #480;
   teste-fabrica-nao-rouba-rota): trocar a ordem só pode entrar se NÃO mudar quem responde. Provas:
     1) a peça: ordem fixa (cabeça primeiro, próprias antes das compartilhadas, fábrica por último), passos obrigatórios
        conferidos no boot, passo `{ montar }` montado na 1ª chamada (e falha de montagem vira "não trata", com erro no log),
        passo null = não tem, o primeiro que responde para a fila, nada respondeu → false;
     2) pelo `routes` REAL das três, SONDANDO CADA PASSO SOZINHO com cada uma das rotas conhecidas do checkout (GET e POST,
        sem credencial, rede bloqueada): quem responde PRIMEIRO na ordem nova é quem respondia primeiro na ordem antiga de
        cada empresa (a antiga está aqui como fixture, copiada do arquivo de cada uma antes da troca). Rota que mais de um
        passo reclama aparece na saída — é onde a ordem importa;
     3) texto: as três montam a peça e não têm mais a fila à mão. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* rede bloqueada: a sonda chama cada passo SEM passar pelo portão — nada pode sair pra Bling/ML/Shopee */
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
const nf = require.resolve('node-fetch'); require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: async () => { throw new Error('rede bloqueada no teste'); } };
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-rotas-teste';
for (const pfx of ['GIRABKP', 'AMBBKP', 'GOODBKP']) { process.env[pfx + '_CACHE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 're-' + pfx + '-')); process.env[pfx + '_ADMIN'] = 'dono-teste'; }

/* 1) a peça */
const RE = require('../lib/checkout/rotas-empresa');
assert.deepStrictEqual(RE.ORDEM, ['cabeca', 'comuns', 'lote', 'fotos', 'planoAno', 'plano', 'pwa', 'canEmp', 'backfillStatus', 'shopeeSessao', 'proprias', 'deParaSku', 'hist', 'pesca', 'canario', 'limpeza', 'noturna', 'shopee', 'diag', 'painel']);
assert.ok(RE.ORDEM[0] === 'cabeca' && RE.ORDEM[RE.ORDEM.length - 1] === 'painel' && RE.ORDEM.indexOf('proprias') < RE.ORDEM.indexOf('hist'), 'a cabeça (com o portão) primeiro, a fábrica por último, as próprias antes das compartilhadas');
{
  const ordem = [];
  const passo = (nome, pega) => (req, res, urlObj, method, p) => { ordem.push(nome); if (pega && p === pega) { res._s = 200; res._b = nome; return true; } return false; };
  const base = {};
  for (const n of RE.OBRIGATORIOS) base[n] = passo(n, null);
  const P = RE.criar('teste', Object.assign({}, base, { comuns: passo('comuns', '/x/a'), hist: passo('hist', '/x/a'), diag: passo('diag', '/x/b'),
    proprias: [passo('propria1', '/x/b')], fotos: null, limpeza: null, pwa: passo('pwa', '/x/c') }));
  const pedir = async (p) => { ordem.length = 0; const res = { _s: 0, _b: '' }; const u = new URL('http://x' + p); const t = await P.handle({ method: 'GET', headers: {} }, res, u); return { t, res, visitados: ordem.slice() }; };
  (async () => {
    let r = await pedir('/x/a');
    assert.ok(r.t === true && r.res._b === 'comuns', 'comuns vem antes de hist: ' + JSON.stringify(r));
    assert.deepStrictEqual(r.visitados, ['cabeca', 'comuns'], 'a fila para no primeiro que responde');
    r = await pedir('/x/b');
    assert.ok(r.res._b === 'propria1', 'a rota PRÓPRIA responde antes do diagnóstico compartilhado: ' + r.res._b);
    assert.deepStrictEqual(r.visitados, ['cabeca', 'comuns', 'lote', 'planoAno', 'plano', 'pwa', 'canEmp', 'backfillStatus', 'shopeeSessao', 'propria1'], 'a ordem é a declarada (sem os passos nulos)');
    r = await pedir('/x/c'); assert.ok(r.res._b === 'pwa');
    r = await pedir('/x/nada'); assert.ok(r.t === false && r.visitados.length === RE.OBRIGATORIOS.length + 2 && r.visitados[r.visitados.length - 1] === 'painel', 'ninguém responde → false, depois de passar por todos: ' + r.visitados.join(','));
    assert.deepStrictEqual(P.passos.map((x) => x.nome), ['cabeca', 'comuns', 'lote', 'planoAno', 'plano', 'pwa', 'canEmp', 'backfillStatus', 'shopeeSessao', 'propria1', 'deParaSku', 'hist', 'pesca', 'canario', 'noturna', 'shopee', 'diag', 'painel']);
    /* { montar }: montado na 1ª chamada; falha de montagem vira "não trata" com erro no log */
    let montagens = 0; const erros = []; const _err = console.error; console.error = (m) => erros.push(String(m));
    const P2 = RE.criar('teste', Object.assign({}, base, { painel: { montar: () => { montagens++; return passo('painel', '/x/p'); } }, diag: { montar: () => { throw new Error('peça quebrada'); } } }));
    try {
      let r2 = await P2.handle({ method: 'GET', headers: {} }, { _s: 0 }, new URL('http://x/x/p')); assert.ok(r2 === true && montagens === 1, 'montado na primeira chamada');
      r2 = await P2.handle({ method: 'GET', headers: {} }, { _s: 0 }, new URL('http://x/x/p')); assert.ok(r2 === true && montagens === 1, 'montado UMA vez só');
      r2 = await P2.handle({ method: 'GET', headers: {} }, { _s: 0 }, new URL('http://x/x/zz')); assert.strictEqual(r2, false, 'diag quebrado vira "não trata"');
      assert.ok(erros.some((e) => /\[diag\] falha ao montar: peça quebrada/.test(e)), 'a falha de montagem tem que ir pro log: ' + erros.join(' | '));
      assert.strictEqual(erros.filter((e) => /\[diag\]/.test(e)).length, 1, 'a montagem quebrada não é tentada de novo a cada pedido');
      /* montar() que não devolve função é montagem quebrada também (um `42` não pode virar "tratou") */
      const P3 = RE.criar('teste', Object.assign({}, base, { hist: { montar: () => 42 } }));
      const r3 = await P3.handle({ method: 'GET', headers: {} }, { _s: 0 }, new URL('http://x/x/zz'));
      assert.strictEqual(r3, false, 'montar() sem função vira "não trata"');
      assert.ok(erros.some((e) => /\[hist\] falha ao montar: montar\(\) não devolveu função/.test(e)), 'montar() sem função tem que ir pro log: ' + erros.join(' | '));
    } finally { console.error = _err; }
    assert.throws(() => RE.criar('teste', { cabeca: passo('c') }), /rotas-empresa \(teste\): falta comuns, lote, planoAno/, 'passo obrigatório faltando derruba no boot');
    assert.throws(() => RE.criar('teste', Object.assign({}, base, { hist: 'x' })), /tem que ser função/);

    /* 2) sondagem das três: quem responde primeiro na ordem nova é quem respondia na antiga */
    const ANTIGA = {   /* a fila de cada arquivo, como estava em 16/11 antes desta peça (sem os passos que a empresa não tem).
                          16/11 (passo 2): `shopeeSessao` (semear/devolução) era `propria1`/`propria2` da AMB — entra no lugar delas; a Girassol e a
                          GOOD não tinham as rotas (ninguém respondia): o passo entra onde a fila nova o põe, logo depois do backfill-status */
      girassol: ['cabeca', 'comuns', 'lote', 'fotos', 'planoAno', 'plano', 'pwa', 'canEmp', 'backfillStatus', 'shopeeSessao', 'deParaSku', 'hist', 'pesca', 'canario', 'limpeza', 'noturna', 'shopee', 'diag', 'painel'],
      amb: ['cabeca', 'canEmp', 'comuns', 'shopeeSessao', 'lote', 'planoAno', 'pwa', 'plano', 'backfillStatus', 'deParaSku', 'hist', 'pesca', 'canario', 'limpeza', 'noturna', 'shopee', 'painel', 'diag'],
      good: ['cabeca', 'pesca', 'shopee', 'noturna', 'canario', 'painel', 'comuns', 'backfillStatus', 'shopeeSessao', 'canEmp', 'plano', 'planoAno', 'propria1', 'lote', 'deParaSku', 'hist', 'diag'],
    };
    /* as rotas conhecidas do checkout: toda literal `PREFIXO + '/x'`, `p === '/<módulo>/x'` ou `R('x')` em lib/ e nas três pastas */
    const rotas = new Set(['', '/', '/nao-existe-xyz']);
    const varrer = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') varrer(f); } else if (/\.js$/.test(e.name)) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:PREFIXO|prefixo|pref|PREF|c\.prefixo|cfg\.prefixo) \+ '(\/[A-Za-z0-9_.\/-]+)'/g)) rotas.add(m[1]);
      for (const m of s.matchAll(/p === '\/[a-z-]+-(?:backup|checkout)-offline(\/[A-Za-z0-9_.\/-]+)'/g)) rotas.add(m[1]);
      for (const m of s.matchAll(/\bR\('([A-Za-z0-9_.\/-]+)'\)/g)) rotas.add('/' + m[1].replace(/^\//, ''));
    } } };
    for (const d of ['lib', 'girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) varrer(path.join(raiz, d));
    assert.ok(rotas.size > 150, 'a varredura de rotas conhecidas achou pouco: ' + rotas.size);
    const EMP = [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js'], ['good', '/good-checkout-offline', 'good-checkout-offline/index.js']];
    const _log = console.log, _warn = console.warn; console.log = () => {}; console.warn = () => {};
    const _err2 = console.error; console.error = () => {};
    const relatorio = [];
    try {
      for (const [emp, pref, arq] of EMP) {
        const mod = require(path.join(raiz, arq));
        const h = mod.routes(async () => ({}));
        assert.ok(Array.isArray(h.passos) && h.passos.length >= 15, emp + ': o routes tem que expor os passos da peça');
        const nomes = h.passos.map((x) => x.nome);
        for (const n of ANTIGA[emp]) assert.ok(nomes.includes(n), emp + ': a ordem antiga cita um passo que a peça não tem: ' + n);
        for (const n of nomes) assert.ok(ANTIGA[emp].includes(n), emp + ': a peça tem um passo que a ordem antiga não cita: ' + n);
        let comparadas = 0, repetidas = 0;
        const porPasso = Object.fromEntries(nomes.map((n) => [n, 0]));   /* cada passo tem que responder a ALGUMA rota conhecida — um passo que nunca trata é peça desligada */
        for (const rota of rotas) {
          for (const method of ['GET', 'POST']) {
            const claims = [];   /* quais passos respondem a esta rota (cada um sondado SOZINHO) */
            for (const passo of h.passos) {
              /* COM a chave de admin: sem ela a cabeça (o portão) responderia 401 pra quase tudo e a ordem dos passos de baixo
                 nem seria exercitada. Rede bloqueada e pastas temporárias seguram o efeito de rotas que agem */
              const u = new URL('http://x' + pref + rota + (rota.includes('?') ? '&' : '?') + 'k=chave-rotas-teste');
              const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
              let t = false;
              try { t = await Promise.race([passo.fn({ method, url: u.pathname + u.search, headers: {} }, res, u, method, u.pathname), new Promise((r2) => setTimeout(() => r2('demorou'), 1500))]); }
              catch (e) { t = 'erro'; }
              if (t === true) { claims.push(passo.nome); porPasso[passo.nome]++; }
            }
            if (!claims.length) continue;
            comparadas++;
            const primeiroNovo = claims[0];   /* h.passos já está na ordem nova */
            const primeiroAntigo = ANTIGA[emp].find((n) => claims.includes(n));
            if (claims.length > 1) { repetidas++; relatorio.push(emp + ' ' + method + ' ' + rota + ' → ' + claims.join(', ')); }
            assert.strictEqual(primeiroNovo, primeiroAntigo, emp + ': ' + method + ' ' + pref + rota + ' mudou de dono com a ordem nova — antes ' + primeiroAntigo + ', agora ' + primeiroNovo + ' (reclamam: ' + claims.join(', ') + ')');
          }
        }
        const mudos = nomes.filter((n) => !porPasso[n]);
        assert.deepStrictEqual(mudos, [], emp + ': passo(s) que não respondem a NENHUMA rota conhecida (peça desligada ou sonda cega): ' + mudos.join(', '));
        relatorio.push(emp + ': ' + comparadas + ' sondas com resposta, ' + repetidas + ' rota(s) reclamada(s) por mais de um passo (dono preservado); por passo: ' + nomes.map((n) => n + '=' + porPasso[n]).join(' '));
      }
    } finally { console.log = _log; console.warn = _warn; console.error = _err2; }

    /* 3) texto */
    for (const [emp, , arq] of EMP) {
      const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
      assert.ok(s.includes("require('../lib/checkout/rotas-empresa').criar('" + emp + "', {"), emp + ': tem que montar a fila pela peça');
      assert.ok(/const handle = _rotas\.handle; handle\.passos = _rotas\.passos;/.test(s) && /\n  return handle;\n/.test(s), emp + ': o routes devolve o handle da peça');
      assert.ok(!/return async function handle\(req, res, urlObj\)/.test(s), emp + ': a fila escrita à mão voltou');
      for (const re of [/_rotasPainel\w*Montado/, /let _rotasPainel\w+ = async/, /if \(await hist\(req, res, urlObj\)\) return true;/, /if \(await diag\(req, res, urlObj\)\) return true;/]) assert.ok(!re.test(s), emp + ': sobrou a fila antiga: ' + re);
    }
    console.log('ok — a fila de peças de rota é uma só nas três (cabeça → … → fábrica por último); sondando cada passo com ' + rotas.size + ' rotas × GET/POST, quem responde primeiro é quem respondia antes\n  ' + relatorio.join('\n  '));
    process.exit(0);
  })().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
}
