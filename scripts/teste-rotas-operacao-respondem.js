'use strict';
/* 14/11 — AS ROTAS DA OPERAÇÃO RESPONDEM DE VERDADE NAS TRÊS, pelo `routes` REAL de cada empresa.

   scripts/teste-rotas-operacao.js prova que a ligação nova (lib/checkout/rotas-operacao) entrega a cada peça de rota o
   mesmo que o bloco escrito à mão entregava. Este prova a outra metade, que comparar ligação não mostra: com o módulo de
   PRODUÇÃO de cada empresa montado (`mod.routes(readBody)`), um pedido de verdade a UMA rota de cada uma das cinco peças
   chega na peça certa, com o que é da empresa (a tela da contagem sai com o prefixo DELA), e o portão de sessão continua
   NA FRENTE (lição do #480: estas rotas não validam sessão sozinhas — sem o portão antes, ficam abertas).

   ⚠️ Só rotas de LEITURA / recusa, escolhidas uma a uma lendo o código de cada uma, e conferidas por EXECUÇÃO: a rede
   fica bloqueada (node-fetch, fetch global, http/https) e o teste exige ZERO tentativa de rede — nada de Bling, Shopee
   ou ML. As pastas de dados são temporárias (o servidor usa /data, que não existe na máquina de testes do GitHub).

     peça          rota                       quem pede            resposta que prova que a PEÇA atendeu
     contagem      GET  /contagem             operador logado      200, a tela com `const MOD = '<prefixo da empresa>'`
     separação     GET  /localizacoes-log     operador logado      200 { ok, total, log }
     backfill      GET  /backfill-nf          operador (não admin) 404 { error: 'not found' } — a recusa é DA peça
     NF anexada    GET  /shopee-sessao        operador (não admin) 403 'apenas admin'
     NF anexada    GET  /ml-sync-fees?status=1  chave de admin     200, só o estado (não dispara a pesca)
     conferido     POST /conferido  {}        operador logado      400 'id obrigatório'
   e as cinco, SEM credencial nenhuma: 401 do portão ("Sessão necessária"). */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rotas-operacao-'));
const CHAVE = 'chave-teste-operacao';
process.env.ADMIN_KEY = CHAVE;                       /* ANTES dos requires: o segredo da sessão nasce dela */
for (const p of ['GIRABKP', 'AMBBKP', 'GOODBKP']) {
  process.env[p + '_ADMIN'] = 'dono-teste';          /* o operador do teste NÃO é admin */
  process.env[p + '_CACHE_DIR'] = path.join(TMP, p);
}
process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tiktok');

/* a rede bloqueada e contada */
const rede = [];
{
  const recusa = (quem) => (...a) => { rede.push(quem + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); return Promise.reject(new Error('rede bloqueada no teste')); };
  const k = require.resolve('node-fetch');
  const duble = recusa('node-fetch'); duble.default = duble;
  require.cache[k] = { id: k, filename: k, loaded: true, exports: duble };
  global.fetch = recusa('fetch');
  for (const m of ['http', 'https']) {
    const mod = require(m);
    for (const f of ['request', 'get']) mod[f] = (...a) => { rede.push(m + '.' + f + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); throw new Error('rede bloqueada no teste'); };
  }
}

const EMPRESAS = [
  ['girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
  ['amb', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['good', 'good-checkout-offline/index.js', '/good-checkout-offline'],
];

function cookieDe(nome, fonte) {
  /* 15/11: a sessão de operador é a peça lib/checkout/sessao-operador — a empresa tem que usá-la; o nome do cookie vem dela */
  assert.ok(/= require\('\.\.\/lib\/checkout\/sessao-operador'\);/.test(fonte), 'a empresa tem que usar a peça da sessão de operador');
  const m = /const SESS_COOKIE\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'sessao-operador.js'), 'utf8'));
  assert.ok(m, 'não achei o nome do cookie de sessão no arquivo da empresa');
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + 600000 })).toString('base64url');
  return m[1] + '=' + pl + '.' + crypto.createHmac('sha256', CHAVE).update(pl).digest('base64url');
}

async function pedir(handler, metodo, caminho, { cookie, chave } = {}) {
  const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._fim = true; this._b = String(b == null ? '' : b); } };
  const u = new URL('http://x' + caminho + (chave ? (caminho.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(chave) : ''));
  const headers = {}; if (cookie) headers.cookie = cookie;
  const tratou = await handler({ method: metodo, url: u.pathname + u.search, headers }, res, u);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { tratou, status: res._s, fim: res._fim, corpo: res._b, j };
}

(async () => {
  const retrato = {};
  for (const [emp, arq, P] of EMPRESAS) {
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const mod = require(path.join(raiz, arq));
    assert.strictEqual(typeof mod.routes, 'function', emp + ': o módulo não exporta routes');
    const h = mod.routes(async () => ({}));
    const operador = cookieDe('estoquista-teste', fonte);
    const R = retrato[emp] = {};
    const antesRede = rede.length;

    /* sem credencial: o portão responde antes de qualquer uma das cinco */
    for (const [met, rota] of [['GET', '/contagem'], ['GET', '/localizacoes-log'], ['GET', '/backfill-nf'], ['GET', '/shopee-sessao'], ['GET', '/ml-sync-fees?status=1'], ['POST', '/conferido']]) {
      const r = await pedir(h, met, P + rota);
      R['sem credencial ' + met + ' ' + rota] = [r.tratou, r.status, r.corpo];
      assert.ok(r.tratou === true && r.status === 401 && r.j && /Sess[aã]o necess[aá]ria/.test(r.j.erro || ''),
        emp + ': ' + met + ' ' + rota + ' SEM credencial respondeu ' + r.status + ' ' + r.corpo.slice(0, 80) + ' — a rota ficou na frente do portão de sessão');
    }
    /* chave errada também não entra */
    {
      const r = await pedir(h, 'GET', P + '/localizacoes-log', { chave: 'chave-errada' });
      assert.strictEqual(r.status, 401, emp + ': chave ERRADA passou pelo portão (' + r.status + ')');
    }

    /* contagem: a tela, com o prefixo DESTA empresa */
    {
      const r = await pedir(h, 'GET', P + '/contagem', { cookie: operador });
      R['contagem'] = [r.tratou, r.status, crypto.createHash('sha256').update(r.corpo).digest('hex')];
      assert.ok(r.tratou === true && r.status === 200 && r.corpo.includes("const MOD = '" + P + "';"), emp + ': a tela da contagem não veio com o prefixo dela (' + r.status + ' ' + r.corpo.slice(0, 80) + ')');
      for (const [, , outro] of EMPRESAS) if (outro !== P) assert.ok(!r.corpo.includes("const MOD = '" + outro + "';"), emp + ': a tela da contagem veio com o prefixo de OUTRA empresa');
    }
    /* separação: o registro das localizações (lê o arquivo da pasta de dados; vazio aqui) */
    {
      const r = await pedir(h, 'GET', P + '/localizacoes-log', { cookie: operador });
      R['separacao'] = [r.tratou, r.status, r.corpo];
      assert.ok(r.tratou === true && r.status === 200 && r.j && r.j.ok === true && r.j.total === 0 && Array.isArray(r.j.log), emp + ': /localizacoes-log não respondeu pela peça da separação: ' + r.status + ' ' + r.corpo.slice(0, 80));
    }
    /* backfill: operador que NÃO é admin é recusado PELA PEÇA (404 dela) — e nada roda */
    {
      const r = await pedir(h, 'GET', P + '/backfill-nf', { cookie: operador });
      R['backfill'] = [r.tratou, r.status, r.corpo];
      assert.ok(r.tratou === true && r.status === 404 && r.j && r.j.error === 'not found', emp + ': /backfill-nf com operador comum devia ser recusado pela peça do backfill: ' + r.status + ' ' + r.corpo.slice(0, 80));
    }
    /* NF anexada: a sessão da Shopee é só do admin; e o estado da pesca do ML (status=1 não dispara nada) */
    {
      const r = await pedir(h, 'GET', P + '/shopee-sessao', { cookie: operador });
      R['nf-anexada sessao'] = [r.tratou, r.status, r.corpo];
      assert.ok(r.tratou === true && r.status === 403 && r.j && r.j.erro === 'apenas admin', emp + ': /shopee-sessao com operador comum devia dar 403 da peça: ' + r.status + ' ' + r.corpo.slice(0, 80));
      const s = await pedir(h, 'GET', P + '/ml-sync-fees?status=1', { chave: CHAVE });
      R['nf-anexada pesca'] = [s.tratou, s.status, s.j && Object.keys(s.j).sort().join(',')];
      assert.ok(s.tratou === true && s.status === 200 && s.j && s.j.ok === true && s.j.rodando === false && /^\d+\/\d+$/.test(String(s.j.progresso)), emp + ': /ml-sync-fees?status=1 não devolveu o estado da pesca: ' + s.status + ' ' + s.corpo.slice(0, 120));
      assert.ok(!s.j.iniciado, emp + ': pedir o STATUS disparou a pesca das tarifas');
    }
    /* conferido: sem id, a peça recusa antes de gravar qualquer coisa */
    {
      const r = await pedir(h, 'POST', P + '/conferido', { cookie: operador });
      R['conferido'] = [r.tratou, r.status, r.corpo];
      assert.ok(r.tratou === true && r.status === 400 && r.j && r.j.erro === 'id obrigatório', emp + ': POST /conferido sem id devia dar 400 da peça do conferido: ' + r.status + ' ' + r.corpo.slice(0, 80));
    }
    /* o pedido a uma empresa não é atendido com o prefixo de outra */
    for (const [, , outro] of EMPRESAS) if (outro !== P) {
      const r = await pedir(h, 'GET', outro + '/localizacoes-log', { cookie: operador });
      assert.ok(!(r.status === 200 && r.j && r.j.ok === true), emp + ': atendeu /localizacoes-log pelo prefixo de outra empresa (' + outro + ')');
    }
    assert.deepStrictEqual(rede.slice(antesRede), [], emp + ': as rotas deste teste tentaram REDE — ele só pode pedir leitura/recusa: ' + rede.slice(antesRede).join(' | '));
  }
  /* pra comparar lado a lado com outra versão do repositório (usado na conferência com a main) */
  if (process.env.ROTAS_OPERACAO_RETRATO) fs.writeFileSync(process.env.ROTAS_OPERACAO_RETRATO, JSON.stringify(retrato, null, 1));
  console.log('ok — rotas da operação nas três, pelo routes real: contagem (tela com o prefixo dela), separação, backfill, NF anexada e conferido respondem pela peça certa; sem credencial o portão barra as cinco; zero rede');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
