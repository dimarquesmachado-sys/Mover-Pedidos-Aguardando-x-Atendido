'use strict';
/* 26/11 — CHECKOUT: O "↻ ATUALIZAR" DO PAINEL DO GALPÃO PEDE A CONSULTA POR UMA ROTA QUE ELE CONSEGUE CHAMAR.
   O dono: "qdo clico atualizar, tá dando falha ao pedir atualização pro servidor".

   A causa, lida no código: o botão chamava <empresa>/run. Caminho que termina em /run é ROTA CENTRAL DE ADMIN
   (lib/http/rotas-protegidas): o porteiro central do servidor só deixa passar com a chave de admin — e o painel do galpão
   não manda chave (quem usa é o estoquista, com sessão). A resposta era 404 e nenhum ciclo era pedido. Até o #971 a tela
   ignorava a resposta (o botão não fazia nada, calado); desde então confere e mostra a falha.

   O que se prova:
   A. a rota <empresa>/atualizar (lib/checkout/rotas-conferido): POST pede o ciclo e devolve a hora do pedido; nunca
      força o re-cache; GET não é ela; o /run segue como era (com o force);
   B. os dois porteiros DE VERDADE, nas três empresas: /atualizar NÃO é rota central de admin (o porteiro central não a
      tranca) e passa pelo porteiro de sessão — sem sessão 401, com sessão ou com a chave de admin passa; /run segue
      trancada no central;
   C. a CLASSE do erro: nenhuma chamada do painel do galpão aponta pra rota central de admin (o painel não tem a chave). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const RP = require('../lib/http/rotas-protegidas');
const PS = require('../lib/checkout/portao-sessao');
const { criar } = require('../lib/checkout/rotas-conferido');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });
const giros = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  /* ═══ A. a rota ═══ */
  {
    const obs = { ciclos: [], respostas: [] };
    const rota = criar({ prefixo: '/x', tag: 'T', json: (res, st, o) => obs.respostas.push([st, o]), readBody: async () => ({}), readJson: () => ({}), writeJson: () => {},
      lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {}, sincronizarConferidos: async () => ({}), rodarCiclo: async (motivo, forcar) => { obs.ciclos.push([motivo, !!forcar]); return {}; },
      CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't', esperaEntreTentativasMs: 5 });
    const pedir = (metodo, caminho, qs) => rota({ method: metodo, headers: {} }, {}, new URL('http://h' + caminho + (qs || '')), metodo, caminho);
    const antes = Date.now();
    assert.strictEqual(await pedir('POST', '/x/atualizar'), true, 'a rota atende');
    await giros();
    const [st, r] = obs.respostas[0];
    assert.deepStrictEqual([st, r.ok, Object.keys(r).sort(), obs.ciclos], [200, true, ['mensagem', 'ok', 'pedido_em'], [['manual', false]]], JSON.stringify(r));
    assert.ok(Date.parse(r.pedido_em) >= antes - 5 && Date.parse(r.pedido_em) <= Date.now() && r.pedido_em === new Date(Date.parse(r.pedido_em)).toISOString(), 'a hora do pedido, no relógio do servidor: ' + r.pedido_em);
    /* nunca força o re-cache, nem pedindo */
    obs.ciclos.length = 0; await pedir('POST', '/x/atualizar', '?force=1'); await giros();
    assert.deepStrictEqual(obs.ciclos, [['manual', false]], 'o force não vale no /atualizar');
    /* GET não é ela (ninguém dispara ciclo abrindo um link); caminho parecido também não */
    obs.ciclos.length = 0; obs.respostas.length = 0;
    for (const [m, c] of [['GET', '/x/atualizar'], ['POST', '/x/atualizar/'], ['POST', '/x/atualizar2'], ['POST', '/y/atualizar'], ['PUT', '/x/atualizar']]) await pedir(m, c);
    await giros();
    assert.deepStrictEqual([obs.ciclos, obs.respostas.filter((x) => x[1] && x[1].pedido_em).length], [[], 0], 'só POST no caminho exato');
    /* o /run segue como era: aceita o force */
    await pedir('POST', '/x/run', '?force=1'); await giros();
    assert.deepStrictEqual(obs.ciclos, [['manual-force', true]]);
  }

  /* ═══ B. os dois porteiros, nas três empresas ═══ */
  const idx = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
  assert.ok(/let ehAdmin = _ehCentral\(path\);/.test(idx) && /ehRotaCentralAdmin: _ehCentral/.test(idx), 'o porteiro central do servidor usa a regra de lib/http/rotas-protegidas');
  process.env.ADMIN_KEY = 'chave-de-teste';
  for (const [emp, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    assert.deepStrictEqual([RP.ehRotaCentralAdmin(prefixo + '/atualizar'), RP.ehRotaCentralAdmin(prefixo + '/run'), RP.ehCallbackOAuth(prefixo + '/atualizar'), RP.ehRotaChaveToolbox(prefixo + '/atualizar')],
      [false, true, false, false], emp + ': /atualizar não é rota central (o porteiro central não a tranca); /run é');
    let sessao = null, chave = '';
    const barrados = [];
    const portao = PS.criar(emp, { validarSessao: () => sessao, lerChaveAdmin: () => chave, json: (res, st, o) => barrados.push(st) });
    const passa = (caminho) => { barrados.length = 0; const req = { headers: {} }; const barrou = portao(req, {}, caminho, new URL('http://h' + caminho)); return [barrou, barrados.slice(), req._op || null]; };
    assert.ok(!PS.publicasDe(require('../lib/checkout/config-empresa').configCheckout(emp)).includes(prefixo + '/atualizar'), emp + ': /atualizar não é pública');
    assert.deepStrictEqual(passa(prefixo + '/atualizar'), [true, [401], null], emp + ': sem sessão e sem chave, 401');
    sessao = 'estoquista';
    assert.deepStrictEqual(passa(prefixo + '/atualizar'), [false, [], 'estoquista'], emp + ': quem está logado no checkout passa');
    sessao = null; chave = 'chave-de-teste';
    assert.deepStrictEqual(passa(prefixo + '/atualizar'), [false, [], 'admin-key'], emp + ': a chave de admin também passa');
    chave = 'errada';
    assert.deepStrictEqual(passa(prefixo + '/atualizar'), [true, [401], null], emp + ': chave errada não passa');
    /* o /run: o porteiro da empresa não pede sessão porque o CENTRAL já tranca com a chave */
    sessao = null; chave = '';
    assert.deepStrictEqual(passa(prefixo + '/run'), [false, [], null], emp + ': /run é do porteiro central');
  }
  delete process.env.ADMIN_KEY;

  /* ═══ C. a classe: o painel do galpão não chama rota central de admin ═══ */
  {
    const html = fs.readFileSync(path.join(raiz, 'lib/checkout/painel/painel-galpao.html'), 'utf8');
    const caminhos = [...new Set([...html.matchAll(/\{\{PREFIXO\}\}(\/[A-Za-z0-9_\-\/.]+)/g)].map((m) => m[1]))];
    assert.ok(caminhos.length > 20 && caminhos.includes('/atualizar') && caminhos.includes('/lista') && caminhos.includes('/ciclo-agora'), 'li as chamadas do painel: ' + caminhos.length);
    const trancadas = caminhos.filter((c) => RP.ehRotaCentralAdmin('/emp' + c));
    assert.deepStrictEqual(trancadas, [], 'o painel do galpão chama rota que o porteiro central só abre com a chave de admin — e o painel não manda chave (a resposta seria 404): ' + trancadas.join(', '));
    assert.ok(/const r = await fetch\('\{\{PREFIXO\}\}\/atualizar', Object\.assign\(\{ method:'POST' \}/.test(html), 'o Atualizar pede por POST na rota do painel');
  }

  /* ═══ D. DE VERDADE: o servidor inteiro, as três empresas, pedindo como o painel pede (POST, sem chave) ═══ */
  {
    const os = require('os'), http = require('http'), { spawn } = require('child_process');
    const post = (porta, caminho, cab) => new Promise((ok) => {
      const r = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'POST', timeout: 15000, headers: Object.assign({ 'Content-Length': 0 }, cab || {}) }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ code: res.statusCode, j }); }); });
      r.on('error', (e) => ok({ code: 0, j: null })); r.on('timeout', () => { r.destroy(); ok({ code: 0, j: null }); }); r.end();
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atualizar-'));
    const env = Object.assign({}, process.env, { ADMIN_KEY: 'adm-teste', PORT: String(40000 + Math.floor(Math.random() * 900)) });
    const EMP = [['girassol-backup-offline', 'GIRABKP_CACHE_DIR'], ['amb-checkout-offline', 'AMBBKP_CACHE_DIR'], ['good-checkout-offline', 'GOODBKP_CACHE_DIR']];
    for (const [, v] of EMP) { env[v] = path.join(tmp, v); fs.mkdirSync(env[v], { recursive: true }); }
    env.TIKTOK_CACHE_DIR = path.join(tmp, 'tiktok'); fs.mkdirSync(env.TIKTOK_CACHE_DIR, { recursive: true });
    const srv = spawn(process.execPath, [path.join(raiz, 'index.js')], { cwd: raiz, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const porta = Number(env.PORT);
    try {
      let pronto = false;
      for (let i = 0; i < 80 && !pronto; i++) { await new Promise((r) => setTimeout(r, 500)); const r = await post(porta, '/'); pronto = r.code > 0; }
      assert.ok(pronto, 'o servidor não subiu');
      for (const [pasta] of EMP) {
        /* o defeito, reproduzido: o /run sem a chave morre no porteiro central (404) — era isso que o botão recebia */
        const run = await post(porta, '/' + pasta + '/run');
        assert.deepStrictEqual([run.code, run.j && run.j.error, !!(run.j && run.j.pedido_em)], [404, 'not found', false], pasta + ': /run sem chave');
        /* a rota do painel: sem credencial, é o porteiro de SESSÃO que responde (401) — não o central */
        const sem = await post(porta, '/' + pasta + '/atualizar');
        assert.deepStrictEqual([sem.code, !!(sem.j && sem.j.pedido_em)], [401, false], pasta + ': /atualizar sem sessão: ' + JSON.stringify(sem));
        /* com credencial (aqui a chave de admin no cabeçalho; no galpão é o cookie da sessão): a consulta é pedida */
        const com = await post(porta, '/' + pasta + '/atualizar', { 'x-admin-key': 'adm-teste' });
        assert.deepStrictEqual([com.code, com.j && com.j.ok, isFinite(Date.parse(com.j && com.j.pedido_em))], [200, true, true], pasta + ': /atualizar com credencial: ' + JSON.stringify(com));
      }
    } finally { srv.kill('SIGKILL'); }
  }

  terminou = true; process.exitCode = 0;
  console.log('ok — checkout, o "Atualizar" do painel do galpão: pede a consulta em <empresa>/atualizar (POST, sem force), que passa pelo porteiro de sessão (logado ou chave de admin; sem nenhum, 401) e não é trancada pelo porteiro central; o /run segue só de admin; nenhuma chamada do painel aponta pra rota central de admin — nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
