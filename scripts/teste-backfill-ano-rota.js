'use strict';
/* 15/11 — O /backfill-ano É A ROTA DA PEÇA DO PLANO, NAS TRÊS (docs/NORTE-2026-11.md, item C: rotas-cópia, parte 2).

   A Girassol e a AMB rodavam o ano em memória, mês a mês de uma vez (`backfillAnoTodo`/`_backfillAno`): uma queda no meio
   perdia o andamento, e nada esperava o galpão fechar. A GOOD já fazia o ano virar PLANO em disco (fatias de 10 dias,
   fora do horário do galpão, retoma sozinha) — era a melhor das três e virou a `rotaAno` de lib/checkout/backfill-plano-empresa.
   O ano em memória saiu das três (na GOOD estava morto desde 15/10). Provas:
     1) a peça, com peças de mentira: 404 sem credencial (chave OU sessão de admin quando a empresa entrega validarSessao/
        ehAdmin; sem elas, só a chave); 409 quando a empresa está ocupada (backfill/canário) e NADA é criado; 400 pra ano/mês
        inválidos; 202 cria o plano em disco de 1º de janeiro até o fim resolvido, em fatias de 10 dias, com a resposta
        dizendo o período de verdade, `comeca` pela janela do galpão e `acompanhe` SEM a chave; 409 se já há plano em
        andamento, e &refazer=1 recomeça; GET e POST; outra rota → false;
     2) pelo `routes` REAL da Girassol e da AMB (a GOOD já é provada em teste-backfill-plano-motor): 404 sem chave, 202 com
        a chave criando o plano na pasta da empresa, 409 no clique duplo; e o /backfill-status mostra o plano (sem o `ano`
        em memória);
     3) texto: as três chamam a rotaAno; o ano em memória sumiu das três. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

process.env.ADMIN_KEY = 'chave-ano-teste';
for (const pfx of ['GIRABKP', 'AMBBKP']) process.env[pfx + '_ADMIN'] = 'dono-teste';   /* o admin das duas (pra sessão de admin valer no routes real) */
const fat = require('../lib/backfill-fatiado');
const cf = require('../lib/checkout/contexto-fundo');
cf.janelaRotinaPesada = () => ({ ok: false, esperaMs: 3600000, motivo: 'galpão em operação — volta às 18h05' });   /* o motor não roda no teste */
const SO = require('../lib/checkout/sessao-operador');
const json = (res, status, corpo) => { res._s = status; res._b = JSON.stringify(corpo); };
const lerChaveAdmin = (req, urlObj) => urlObj.searchParams.get('k') || '';
async function pedir(rota, caminho, { method, cookie } = {}) {
  const u = new URL('http://x' + caminho); const headers = {}; if (cookie) headers.cookie = cookie;
  const res = { _s: 0, _b: '' };
  const t = await rota({ method: method || 'GET', headers }, res, u, method || 'GET', u.pathname);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { t, s: res._s, j };
}
const montar = (extra) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-'));
  const est = { ocupado: false, fatias: [] };
  const P = require('../lib/checkout/backfill-plano-empresa').criar(Object.assign({ empresa: 'teste', prefixo: '/teste-checkout-offline', cacheDir: dir, json, lerChaveAdmin,
    rodarFatia: async (f) => { est.fatias.push(f); return { ok: true, desfecho: 'ok' }; }, ocupado: () => est.ocupado, pausaMs: 0 }, extra || {}));
  return { P, dir, est };
};

(async () => {
  /* 1) a peça */
  const { P, dir, est } = montar({ validarSessao: SO.validarSessao, ehAdmin: (n) => n === 'chefe' });
  const R = P.rotaAno;
  assert.strictEqual((await pedir(R, '/teste-checkout-offline/backfill-status?k=chave-ano-teste')).t, false, 'outra rota não é desta');
  assert.strictEqual((await pedir(R, '/outra-checkout-offline/backfill-ano?k=chave-ano-teste')).t, false, 'outro prefixo não é desta');
  let r = await pedir(R, '/teste-checkout-offline/backfill-ano');
  assert.ok(r.t && r.s === 404 && r.j.error === 'not found' && !fat.ler(dir), 'sem credencial: 404 e nada criado');
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=errada');
  assert.ok(r.s === 404 && !fat.ler(dir), 'chave errada: 404');
  r = await pedir(R, '/teste-checkout-offline/backfill-ano', { cookie: 'bkp_sess=' + SO.assinarSessao('estoquista') });
  assert.ok(r.s === 404 && !fat.ler(dir), 'sessão de operador (não admin): 404');
  /* ocupada: 409 e nada criado */
  est.ocupado = true;
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&ano=2026&ate=03');
  assert.ok(r.s === 409 && /já tem backfill rodando/.test(r.j.erro) && !fat.ler(dir), 'ocupada tinha que ser 409 sem criar plano: ' + JSON.stringify(r));
  est.ocupado = false;
  /* período inválido */
  for (const q of ['ano=abcd&ate=03', 'ano=2026&ate=13', 'ano=2026&ate=0', 'ano=1999&ate=03']) {
    r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&' + q);
    assert.ok(r.s === 400 && r.j.ok === false && r.j.erro && !fat.ler(dir), q + ' tinha que ser 400 sem criar plano: ' + JSON.stringify(r));
  }
  /* 202: o plano em disco, de 1º de janeiro ao fim do mês pedido, em fatias de 10 dias */
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&ano=2026&ate=03');
  assert.ok(r.t && r.s === 202, 'tinha que ser 202: ' + JSON.stringify(r));
  assert.deepStrictEqual({ ok: r.j.ok, empresa: r.j.empresa, ano: r.j.ano, de: r.j.de, ate: r.j.ate, automatico: r.j.automatico, comeca: r.j.comeca, acompanhe: r.j.acompanhe },
    { ok: true, empresa: 'teste', ano: '2026', de: '2026-01-01', ate: '2026-03-31', automatico: true, comeca: 'galpão em operação — volta às 18h05', acompanhe: '/teste-checkout-offline/backfill-status' }, JSON.stringify(r.j));
  assert.ok(!/k=/.test(JSON.stringify(r.j)), 'a chave NÃO pode voltar na resposta (13/09)');
  const pl = fat.ler(dir);
  assert.ok(pl && pl.fatias.length === r.j.fatias && pl.fatias.length === 9, 'jan–mar em fatias de 10 dias são 9: ' + (pl && pl.fatias.length));
  assert.strictEqual(pl.fatias[0].de, '2026-01-01'); assert.strictEqual(pl.fatias[pl.fatias.length - 1].ate, '2026-03-31');
  assert.ok(pl.fatias.every((f) => f.estado === 'pendente'), 'com o galpão aberto o motor não roda — as fatias ficam pendentes');
  assert.strictEqual(est.fatias.length, 0, 'nenhuma fatia rodou com o galpão aberto');
  /* clique duplo: 409 com o resumo; &refazer=1 recomeça */
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&ano=2026&ate=03', { method: 'POST' });
  assert.ok(r.s === 409 && /plano em andamento/.test(r.j.erro) && r.j.plano, 'clique duplo tinha que ser 409: ' + JSON.stringify(r));
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&ano=2026&ate=02&refazer=1', { method: 'POST' });
  assert.ok(r.s === 202 && r.j.ate === '2026-02-28' && fat.ler(dir).fatias.length === 6 && fat.ler(dir).fatias.length === r.j.fatias, '&refazer=1 tinha que recomeçar com jan–fev (6 fatias): ' + JSON.stringify(r.j));
  /* sessão de ADMIN vale como a chave (a empresa entregou validarSessao/ehAdmin) */
  r = await pedir(R, '/teste-checkout-offline/backfill-ano?ano=2026&ate=01&refazer=1', { cookie: 'bkp_sess=' + SO.assinarSessao('chefe') });
  assert.ok(r.s === 202 && r.j.ate === '2026-01-31', 'sessão de admin tinha que valer: ' + JSON.stringify(r));
  /* sem validarSessao/ehAdmin, só a chave */
  const semSess = montar();
  r = await pedir(semSess.P.rotaAno, '/teste-checkout-offline/backfill-ano?ano=2026&ate=01', { cookie: 'bkp_sess=' + SO.assinarSessao('chefe') });
  assert.ok(r.s === 404 && !fat.ler(semSess.dir), 'sem as peças de sessão, a sessão de admin não vale (só a chave)');
  /* sem ADMIN_KEY configurada, ninguém entra */
  { const salva = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
    try { r = await pedir(semSess.P.rotaAno, '/teste-checkout-offline/backfill-ano?k=&ano=2026&ate=01'); } finally { process.env.ADMIN_KEY = salva; }
    assert.ok(r.s === 404 && !fat.ler(semSess.dir), 'sem ADMIN_KEY configurada: 404'); }
  /* a trava que explode conta como ocupada */
  const explode = montar({ ocupado: () => { throw new Error('boom'); } });
  r = await pedir(explode.P.rotaAno, '/teste-checkout-offline/backfill-ano?k=chave-ano-teste&ano=2026&ate=01');
  assert.ok(r.s === 409 && !fat.ler(explode.dir), 'trava que explode tem que contar como ocupada (nunca cria por erro)');

  /* 2) pelo routes real da Girassol e da AMB */
  for (const [emp, pref, arq, envDir] of [['girassol', '/girassol-backup-offline', 'girassol-backup-offline/gbo-app.js', 'GIRABKP_CACHE_DIR'], ['amb', '/amb-checkout-offline', 'amb-checkout-offline/index.js', 'AMBBKP_CACHE_DIR']]) {
    const dirE = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-' + emp + '-')); process.env[envDir] = dirE;
    const mod = require(path.join(raiz, arq));
    const h = mod.routes(async () => ({}));
    const chamar = async (caminho, method) => { const u = new URL('http://x' + caminho); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      const t = await h({ method: method || 'GET', url: u.pathname + u.search, headers: {} }, res, u); let j = null; try { j = JSON.parse(res._b); } catch (e) {} return { t, s: res._s, j }; };
    let a = await chamar(pref + '/backfill-ano?ano=2026&ate=02');
    assert.ok(a.t && (a.s === 401 || a.s === 404) && !fat.ler(dirE), emp + ': sem credencial tinha que fechar (401 do portão) sem criar plano: ' + JSON.stringify(a));
    a = await chamar(pref + '/backfill-ano?ano=2026&ate=02&k=chave-ano-teste');
    assert.ok(a.s === 202 && a.j.empresa === emp && a.j.de === '2026-01-01' && a.j.ate === '2026-02-28' && a.j.automatico === true && a.j.fatias === 6 && /18h05/.test(a.j.comeca) && a.j.acompanhe === pref + '/backfill-status', emp + ': o ano tinha que virar plano (202): ' + JSON.stringify(a.j));
    assert.ok(fat.ler(dirE) && fat.ler(dirE).fatias.length === 6, emp + ': o plano tem que estar na pasta da empresa');
    a = await chamar(pref + '/backfill-ano?ano=2026&ate=02&k=chave-ano-teste');
    assert.ok(a.s === 409, emp + ': clique duplo tinha que ser 409: ' + JSON.stringify(a));
    /* a sessão de ADMIN vale como a chave (como a rota da empresa sempre aceitou); a de operador não */
    const comCookie = async (caminho, nome) => { const u = new URL('http://x' + caminho); const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: { cookie: 'bkp_sess=' + SO.assinarSessao(nome) } }, res, u); let j = null; try { j = JSON.parse(res._b); } catch (e) {} return { s: res._s, j }; };
    a = await comCookie(pref + '/backfill-ano?ano=2026&ate=01&refazer=1', 'estoquista-teste');
    assert.ok(a.s === 404 && fat.ler(dirE).fatias.length === 6, emp + ': sessão de operador não pode criar o plano do ano: ' + JSON.stringify(a));
    a = await comCookie(pref + '/backfill-ano?ano=2026&ate=01&refazer=1', 'dono-teste');
    assert.ok(a.s === 202 && a.j.ate === '2026-01-31' && fat.ler(dirE).fatias.length === 4, emp + ': a sessão de admin tinha que valer como a chave: ' + JSON.stringify(a));
    const st = await chamar(pref + '/backfill-status?k=chave-ano-teste');
    assert.ok(st.s === 200 && st.j.ok === true && st.j.status && st.j.plano && st.j.plano.motor && st.j.ano === undefined, emp + ': o status mostra o plano (sem o `ano` em memória): ' + JSON.stringify(st.j).slice(0, 300));
  }

  /* 3) texto */
  for (const [arq, plano] of [['girassol-backup-offline/gbo-app.js', '_planoGir'], ['amb-checkout-offline/index.js', '_planoAmb'], ['good-checkout-offline/index.js', '_planoGood']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes('if (await ' + plano + '.rotaAno(req, res, urlObj, method, p)) return true;'), arq + ': a rota do ano tem que ser a da peça');
    assert.ok(!/p === '\/[\w-]+\/backfill-ano'/.test(s) && !/backfillAnoTodo|_backfillAno\b|backfillAnoGood|_bfGoodAno|ULTIMO_DIA/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), arq + ': sobrou o ano em memória');
  }
  console.log('ok — /backfill-ano é a rotaAno da peça do plano nas três: chave ou sessão de admin, 409 ocupada/clique duplo, 400 período, 202 com o plano em disco em fatias de 10 dias e a resposta sem a chave; o ano em memória saiu');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
