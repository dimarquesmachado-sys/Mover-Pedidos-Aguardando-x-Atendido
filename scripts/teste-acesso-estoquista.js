'use strict';
/* 11/11 — O QUE O ESTOQUISTA ALCANÇA (dono: "pro estoquista tem botões que não podem aparecer... JAMAIS pode dar acesso ao
   dashboard pro estoquista... vai que um dia apaga [a lista de admins]").
   O servidor DE VERDADE sobe aqui (disco temporário, sem rede), com operadores nas três empresas:
   · Girassol e AMB com admin configurado ("chefe"); a GOOD com a lista de admins VAZIA (o caso "um dia apaga").
   Logado como ESTOQUISTA em cada uma, chamo TODAS as rotas GET do checkout (tiradas do código) e:
   1) toda rota que responde 200 com conteúdo tem que estar na lista REVISADA do que é do galpão — rota nova que vaze pro
      estoquista derruba este teste até alguém decidir, olhando, que ela é dele;
   2) o dashboard nunca abre; as rotas de admin somem (404) — inclusive as quatro que aceitavam qualquer operador logado
      (/vendas-sync, que DISPARA a sincronização; /ml-billing-status, com tarifas; /reaplicar-status; /varrer-cancelados-status);
   3) com a lista de admins VAZIA ninguém vira admin pelo login (antes: todo mundo) — e o /operadores avisa;
   4) o admin de verdade continua entrando (sessão dele ou a ADMIN_KEY).
   E na tela: a regra do "sou admin" é a mesma do servidor, e o estoquista ganha só a barra mínima dele. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const raiz = path.join(__dirname, '..');

const EMP = { girassol: ['/girassol-backup-offline', 'GIRABKP'], amb: ['/amb-checkout-offline', 'AMBBKP'], good: ['/good-checkout-offline', 'GOODBKP'] };
/* o que é DO GALPÃO (revisado em 11/11, rota a rota): a fila, o pedido, a separação, a busca de produto, a contagem, o
   histórico (que o servidor já entrega enxuto pro operador), impressão, saúde e os arquivos estáticos da tela */
const DO_GALPAO = new Set(['/', '/arq-info/', '/buscar-produto', '/buscar-produto-nome', '/contagem', '/contagem-lista', '/contagem-saldo',
  '/historico', '/icone.png', '/indexar-status', '/lista', '/localizacoes-log', '/manifest.webmanifest', '/nf-travadas', '/operadores',
  '/painel', '/produto-fotos', '/qz-cert', '/qz-sign', '/saude', '/health', '/separacao', '/separacao-por-pedido', '/sincronizar', '/status',
  '/etiquetas-massa', '/sw.js', '/manifest.json']);
const SO_ADMIN = ['/custos-manuais?lista=1', '/backfill-status', '/backfill-plano', '/vendas-sync', '/vendas-sync?status=1', '/ml-billing-status', '/reaplicar-status',
  '/varrer-cancelados-status', '/produto-cru?id=1', '/etiqueta-diag?id=1', '/status-mkt', '/plano-compra', '/sku-info?sku=X', '/historico-longo', '/custo-diario'];

function rotasDoCodigo(pasta) {
  const nomes = new Set();
  const arqs = fs.readdirSync(path.join(raiz, 'lib', 'checkout')).filter((f) => f.endsWith('.js')).map((f) => path.join(raiz, 'lib', 'checkout', f))
    .concat(fs.readdirSync(path.join(raiz, pasta)).filter((f) => f.endsWith('.js')).map((f) => path.join(raiz, pasta, f)));
  for (const a of arqs) {
    const s = fs.readFileSync(a, 'utf8');
    for (const m of s.matchAll(/(?:PREFIXO|prefixo) \+ '(\/[a-z0-9][\w./-]*)'/g)) nomes.add(m[1]);
    for (const m of s.matchAll(new RegExp("'/" + pasta + "(/[a-z0-9][\\w./-]*)'", 'g'))) nomes.add(m[1]);
    for (const m of s.matchAll(/R\('([a-z0-9][\w-]*)'\)/g)) nomes.add('/' + m[1]);
  }
  return [...nomes].sort();
}
function pedir(porta, metodo, caminho, cookie, corpo) {
  return new Promise((ok) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, timeout: 8000,
      headers: Object.assign({}, cookie ? { Cookie: cookie } : {}, dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}) }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => ok({ st: res.statusCode, corpo: Buffer.concat(partes).toString('utf8'), cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') }));
    });
    req.on('timeout', () => { req.destroy(); ok({ st: 0, corpo: 'timeout' }); });
    req.on('error', (e) => ok({ st: 0, corpo: String(e.message) }));
    if (dados) req.write(dados);
    req.end();
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acesso-'));
  const porta = 4300 + Math.floor(Math.random() * 500);
  const env = Object.assign({}, process.env, { PORT: String(porta), ADMIN_KEY: 'chave-ci', ML_FULL_DIR: path.join(tmp, 'mlf'), ML_FULL_CONF_ARQ: path.join(tmp, 'mlf.json'),
    GIRABKP_CACHE_DIR: path.join(tmp, 'g'), AMBBKP_CACHE_DIR: path.join(tmp, 'a'), GOODBKP_CACHE_DIR: path.join(tmp, 'o'),
    GIRABKP_OPERADORES: 'estoq:123,chefe:456', AMBBKP_OPERADORES: 'estoq:123,chefe:456', GOODBKP_OPERADORES: 'estoq:123,chefe:456',
    GIRABKP_ADMIN: 'chefe', AMBBKP_ADMIN: 'chefe', GOODBKP_ADMIN: '' });   /* a GOOD: lista de admins VAZIA */
  const srv = spawn(process.execPath, ['index.js'], { cwd: raiz, env, stdio: 'ignore' });
  const encerrar = () => { try { srv.kill('SIGKILL'); } catch (e) { /* já foi */ } };
  process.on('exit', encerrar);
  try {
    let no_ar = false;
    for (let i = 0; i < 80 && !no_ar; i++) { await new Promise((s) => setTimeout(s, 500)); no_ar = (await pedir(porta, 'GET', '/girassol-backup-offline/operadores')).st === 200 && (await pedir(porta, 'GET', '/good-checkout-offline/operadores')).st === 200 && (await pedir(porta, 'GET', '/amb-checkout-offline/operadores')).st === 200; }
    assert.ok(no_ar, 'o servidor não subiu em 40 s');
    const vazou = [];
    for (const emp of Object.keys(EMP)) {
      const [pref] = EMP[emp];
      const lg = await pedir(porta, 'POST', pref + '/login', null, { nome: 'estoq', senha: '123' });
      assert.ok(lg.st === 200 && lg.cookie, emp + ': o estoquista não conseguiu logar: ' + lg.corpo.slice(0, 120));
      /* 1) tudo o que responde 200 com conteúdo pro estoquista tem que ser do galpão */
      for (const r of rotasDoCodigo(pref.slice(1))) {
        const x = await pedir(porta, 'GET', pref + r, lg.cookie);
        if (x.st !== 200) continue;
        let j = null; try { j = JSON.parse(x.corpo); } catch (e) { j = null; }
        const recusa = (j && j.ok === false) || /Acesso só pra admin/.test(x.corpo);   /* respondeu 200 só pra dizer que não pode / que falta parâmetro */
        if (recusa || DO_GALPAO.has(r) || /^\/js\/[\w-]+\.js$/.test(r)) continue;
        vazou.push(emp + ' ' + r + ' → ' + x.corpo.slice(0, 70).replace(/\s+/g, ' '));
      }
      /* 2) dashboard e rotas de admin */
      const dash = await pedir(porta, 'GET', pref + '/dashboard', lg.cookie);
      assert.ok(dash.st !== 200, emp + ': o ESTOQUISTA abriu o dashboard (HTTP ' + dash.st + ')');
      for (const r of SO_ADMIN) {
        const x = await pedir(porta, 'GET', pref + r, lg.cookie);
        assert.ok(x.st === 404 || x.st === 401 || x.st === 403, emp + ': rota de admin respondeu pro estoquista: ' + r + ' → HTTP ' + x.st + ' ' + x.corpo.slice(0, 80));
      }
    }
    assert.deepStrictEqual(vazou, [], 'rota respondendo conteúdo pro ESTOQUISTA sem estar na lista revisada do galpão:\n  ' + vazou.join('\n  '));
    /* 3) lista de admins VAZIA (a GOOD aqui): nem o "chefe" vira admin pelo login; e o /operadores avisa */
    const op = JSON.parse((await pedir(porta, 'GET', '/good-checkout-offline/operadores')).corpo);
    assert.ok(Array.isArray(op.admins) && op.admins.length === 0 && /nenhum admin configurado/.test(op.aviso_admin || ''), 'lista vazia: o /operadores tinha que avisar: ' + JSON.stringify(op));
    const chefeGood = await pedir(porta, 'POST', '/good-checkout-offline/login', null, { nome: 'chefe', senha: '456' });
    for (const r of ['/dashboard', '/reaplicar-status', '/custos-manuais?lista=1']) {
      const x = await pedir(porta, 'GET', '/good-checkout-offline' + r, chefeGood.cookie);
      assert.ok(x.st !== 200, 'lista de admins VAZIA deu admin pelo login na GOOD: ' + r + ' → HTTP ' + x.st);
    }
    assert.strictEqual((await pedir(porta, 'GET', '/good-checkout-offline/reaplicar-status?k=chave-ci')).st, 200, 'com a lista vazia a ADMIN_KEY tem que continuar entrando');
    /* 4) o admin de verdade continua entrando — pela sessão dele e pela chave */
    for (const emp of ['girassol', 'amb']) {
      const [pref] = EMP[emp];
      const ch = await pedir(porta, 'POST', pref + '/login', null, { nome: 'chefe', senha: '456' });
      for (const r of ['/reaplicar-status', '/varrer-cancelados-status', '/vendas-sync?status=1', '/dashboard']) {
        const x = await pedir(porta, 'GET', pref + r, ch.cookie);
        assert.strictEqual(x.st, 200, emp + ': o ADMIN perdeu acesso a ' + r + ' (HTTP ' + x.st + ' ' + x.corpo.slice(0, 80) + ')');
      }
      const op2 = JSON.parse((await pedir(porta, 'GET', pref + '/operadores')).corpo);
      assert.ok(op2.admins.join() === 'chefe' && !op2.aviso_admin, emp + ': com admin configurado não tem aviso');
    }
  } finally { encerrar(); }
  /* a tela: a mesma regra do servidor, e a barra do estoquista */
  const tela = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
  assert.ok(/function souAdmin\(\)\{ const a = window\.ADMINS \|\| \[\]; return a\.includes\(opAtual\(\)\.toLowerCase\(\)\); \}/.test(tela), 'a tela ainda trata lista de admins vazia como "todo mundo admin"');
  assert.ok(/if\(souAdmin\(\)\)\{ if\(window\.navPaineisMostrar\) window\.navPaineisMostrar\(\); \} else if\(window\.navPaineisEstoquista\) window\.navPaineisEstoquista\(\);/.test(tela), 'a tela tem que escolher a barra pelo papel');
  const nav = fs.readFileSync(path.join(raiz, 'public', 'comum', 'nav.js'), 'utf8');
  const me = nav.slice(nav.indexOf('function montarEstoquista()'), nav.indexOf('function montar() {'));
  assert.ok(me && !/fetch\(/.test(me) && !/PAINEIS|COMUNS|Dashboard/.test(me) && /itensEstoque\(\)/.test(me) && /d\[0\]\.indexOf\(emp\) >= 0/.test(me), 'a barra do estoquista só pode ter o Estoque e as Devoluções DA EMPRESA dele, sem avisos nem outros painéis');
  assert.ok(/function desmontar\(\)/.test(nav) && /aviso-chave-shopee/.test(nav.slice(nav.indexOf('function desmontar()'), nav.indexOf('function empresaDaTela()'))), 'trocar de usuário tem que tirar a barra e os avisos do admin');
  console.log('ok — acesso do estoquista: só alcança o que é do galpão (lista revisada), nunca o dashboard nem rota de admin; lista de admins vazia = ninguém é admin pelo login; o admin segue entrando');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
