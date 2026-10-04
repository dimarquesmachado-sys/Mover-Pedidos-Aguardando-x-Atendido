/* 04/10 — ESCALADA DE PRIVILÉGIO: operador virava admin declarando o nome na URL.

   Achado A da auditoria do Codex (P1), confirmado nas três empresas. As rotas administrativas
   decidiam com `ehAdmin(op)` — e `op` vinha da QUERY ou do BODY, não da sessão. Um estoquista logado
   passava `?op=<nome de um admin>` (os nomes são PÚBLICOS em /operadores) e reabria/revertia pedido.

   Codex #602 pediu cobertura de TODAS as rotas, não só `/reabrir`: o teste agora DESCOBRE no fonte
   cada rota protegida por `souAdmin(` (inclusive as isentas da guarda, como debug-*, e o POST
   /restaurar com o nome no body) e CHAMA todas, em GET e POST:
     1. operador comum + `op=`/body.op de admin        → não pode dar ok:true
     2. operador comum chamado literalmente "admin-key" → não pode virar admin (Codex P2)
     3. sem sessão nenhuma                              → não pode dar ok:true
     4. controle POSITIVO: sessão de admin real passa da autorização (senão o teste seria vazio)

   Marcador estável [ADMIN-DECLARADO]. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-escalada';

const EMPRESAS = [
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline', 'GOODBKP_ADMIN'],
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline', 'AMBBKP_ADMIN'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', 'GIRABKP_ADMIN'],
];
/* rotas administrativas que moram em módulos extraídos (a Girassol delega o diagnóstico) */
const EXTRAS = {
  Girassol: ['girassol-backup-offline/diagnostico.js'],
  GOOD: ['lib/checkout/rotas-catalogo.js'],
  AMB: ['lib/checkout/rotas-catalogo.js'],
};

const ADMIN = 'chefe-teste';

function cookieDe(fonte, nome) {
  const m = fonte.match(/const SESS_COOKIE\s*=\s*'([^']+)'/);
  const cookie = m ? m[1] : 'bkp_sess';
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + 600000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_KEY).update(pl).digest('base64url');
  return cookie + '=' + pl + '.' + sig;
}

/* acha, em cada `souAdmin(`, a rota (método + caminho) declarada logo acima */
function rotasAdmin(fonte, prefixo) {
  const linhas = fonte.split('\n'); const achadas = new Map();
  linhas.forEach((l, i) => {
    if (!/souAdmin\(req/.test(l) || /require\(/.test(l)) return;
    for (let j = i; j >= Math.max(0, i - 25); j--) {
      /* o método é irrelevante: o teste chama cada rota em GET e em POST */
      const m = linhas[j].match(/\bp (?:===|\.startsWith\() ?\(?(?:prefixo \+ )?'(\/[^']+)'/) ||
                linhas[j].match(/\bp\.startsWith\(\(?(?:prefixo \+ )?'(\/[^']+)'/);
      if (m) {
        let rota = m[1]; const prefixa = /startsWith/.test(linhas[j]);
        if (!rota.startsWith('/girassol') && !rota.startsWith('/good') && !rota.startsWith('/amb')) rota = prefixo + rota;
        achadas.set('* ' + rota, prefixa);
        break;
      }
    }
  });
  return achadas;
}

function chamar(handler, metodo, caminho, cookie, body) {
  const u = new URL('http://x' + caminho);
  const conteudo = body ? JSON.stringify(body) : '';
  const req = Readable.from(conteudo ? [Buffer.from(conteudo)] : []);
  req.method = metodo; req.url = u.pathname + u.search;
  req.headers = Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {});
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, write(b) { this._b += String(b || ''); }, end(b) { this._b += String(b || ''); } };
  return Promise.resolve(handler(req, res, u))
    .then(() => res, () => res)
    .then((r) => { let c = {}; try { c = JSON.parse(r._b || '{}'); } catch (e) {} return { status: r._s, corpo: r._b, json: c }; });
}

module.exports = (async () => {
  let total = 0;
  for (const [emp, arq, prefixo, envAdmin] of EMPRESAS) {
    process.env[envAdmin] = ADMIN;
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const todas = new Map(rotasAdmin(fonte, prefixo));
    for (const extra of (EXTRAS[emp] || [])) {
      const fx = fs.readFileSync(path.join(raiz, extra), 'utf8');
      for (const [k, v] of rotasAdmin(fx, prefixo)) todas.set(k, v);
    }
    assert.ok(todas.size >= 3, '[ADMIN-DECLARADO] ' + emp + ': o teste não achou rotas administrativas (' + todas.size +
      ') — a descoberta quebrou e o teste ficou vazio');
    /* as rotas que o Codex citou PRECISAM estar entre as cobertas */
    for (const obrigatoria of [prefixo + '/restaurar', prefixo + '/backup', prefixo + '/reabrir/', prefixo + '/reenvio-resolver/']) {
      assert.ok([...todas.keys()].some((k) => k === '* ' + obrigatoria),
        '[ADMIN-DECLARADO] ' + emp + ': rota ' + obrigatoria + ' não foi descoberta pelo teste');
    }

    const handler = require(path.join(raiz, arq)).routes(async () => ({}));
    const cOper = cookieDe(fonte, 'ygor-teste');
    const cLookalike = cookieDe(fonte, 'admin-key');
    const cAdmin = cookieDe(fonte, ADMIN);

    for (const [rotulo, prefixa] of todas) {
      const caminho = rotulo.split(' ')[1] + (prefixa ? '999999' : '');
      for (const metodo of ['GET', 'POST']) {
        const q = '?op=' + encodeURIComponent(ADMIN);
        const corpo = { op: ADMIN, dados: {} };
        const casos = [
          ['operador comum + op de admin', cOper],
          ['operador chamado "admin-key"', cLookalike],
          ['sem sessão', null],
        ];
        for (const [quem, cookie] of casos) {
          const r = await chamar(handler, metodo, caminho + q, cookie, metodo === 'POST' ? corpo : null);
          total++;
          assert.notStrictEqual(r.json.ok, true,
            '[ADMIN-DECLARADO] ' + emp + ' ' + metodo + ' ' + caminho + ' (' + quem + ') respondeu ok:true: ' + r.corpo.slice(0, 90));
        }
      }
    }

    /* controle POSITIVO: admin de verdade passa da autorização em /reabrir (cai na regra seguinte) */
    const rr = await chamar(handler, 'GET', prefixo + '/reabrir/999999', cAdmin, null);
    assert.ok(!/apenas o admin|só admin|apenas admin/.test(rr.corpo),
      '[ADMIN-DECLARADO] ' + emp + ': o ADMIN de verdade foi barrado em /reabrir — teste vazio ou autorização quebrada: ' + rr.corpo.slice(0, 90));
    const rk = await chamar(handler, 'GET', prefixo + '/reabrir/999999?k=' + process.env.ADMIN_KEY, null, null);
    assert.ok(!/apenas o admin|só admin|apenas admin/.test(rk.corpo),
      '[ADMIN-DECLARADO] ' + emp + ': a ADMIN_KEY deixou de valer em /reabrir: ' + rk.corpo.slice(0, 90));

    /* e a decisão não pode ter voltado a ler `op` da URL/body */
    const fontes = [fonte].concat((EXTRAS[emp] || []).map((x) => fs.readFileSync(path.join(raiz, x), 'utf8')));
    for (const bruto of fontes) {
      const f = bruto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* comentário não decide nada */
      assert.ok(!/ehAdmin\(\s*(?:String\()?\s*(?:op\b|body\.op|urlObj\.searchParams|\(urlObj)/.test(f),
        '[ADMIN-DECLARADO] ' + emp + ': voltou a decidir permissão com `ehAdmin(op)` (op da query/body)');
      assert.ok(!/_quem === 'admin-key'|_op === 'admin-key'/.test(f),
        '[ADMIN-DECLARADO] ' + emp + ': a ADMIN_KEY voltou a ser reconhecida pelo NOME "admin-key" (use req._admKey)');
    }
  }

  console.log('OK: ' + total + ' chamadas em ' + EMPRESAS.length + ' empresas — ninguém vira admin declarando o nome');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
