/* 04/10 — ESCALADA DE PRIVILÉGIO: operador virava admin declarando o nome na URL.

   Achado A da auditoria do Codex (P1), confirmado nas três empresas. As rotas administrativas
   (`/reabrir/`, `/reenvio-resolver/`, `/enviar-docs/`, `/backup`, `/restaurar`) decidiam com
   `ehAdmin(op)` — e `op` vinha da QUERY ou do BODY, não da sessão.

   O estrago é concreto no galpão: um estoquista logado passava `?op=<nome de um admin>` e
   reabria/revertia pedido já conferido. E os nomes dos admins são PÚBLICOS em `/operadores` —
   não era preciso adivinhar nada.

   A identidade autenticada SEMPRE esteve disponível em `req._op`, posta pela guarda a partir da
   sessão ou da ADMIN_KEY. O código simplesmente não a usava.

   Este teste CHAMA as rotas com uma sessão de operador comum e `op=` de admin: tem que recusar.
   Verificação textual não serve aqui — autorização é decisão de execução.

   Marcador estável [ADMIN-DECLARADO]. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-escalada';

const EMPRESAS = [
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline'],
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
];

/* monta o cookie de sessão como o servidor faz, lendo nome e segredo do próprio fonte */
function cookieDe(fonte, nome) {
  const m = fonte.match(/const SESS_COOKIE\s*=\s*'([^']+)'/);
  const cookie = m ? m[1] : 'bkp_sess';
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + 600000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_KEY).update(pl).digest('base64url');
  return cookie + '=' + pl + '.' + sig;
}

function chamar(handler, caminho, cookie) {
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  const u = new URL('http://x' + caminho);
  return handler({ method: 'GET', url: u.pathname + u.search, headers: cookie ? { cookie } : {} }, res, u)
    .then((tratou) => ({ tratou, status: res._s, corpo: res._b }));
}

module.exports = (async () => {
  for (const [emp, arq, prefixo] of EMPRESAS) {
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');

    /* descobre um nome de ADMIN e um de operador comum, do próprio fonte */
    const mAdm = fonte.match(/ADMINS?\s*=\s*\[([^\]]*)\]/);
    const admins = mAdm ? [...mAdm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    const nomeAdmin = admins[0] || 'admin';

    const handler = require(path.join(raiz, arq)).routes(async () => ({}));
    const cookieOperador = cookieDe(fonte, 'ygor-teste');   /* operador comum, NÃO admin */

    /* ⚠️ O ATAQUE: sessão de operador comum + nome de admin na query */
    const alvo = prefixo + '/reabrir/999999?op=' + encodeURIComponent(nomeAdmin);
    const r = await chamar(handler, alvo, cookieOperador);

    let corpo = {};
    try { corpo = JSON.parse(r.corpo || '{}'); } catch (e) { /* resposta não-JSON também não é ok:true */ }

    assert.notStrictEqual(corpo.ok, true,
      '[ADMIN-DECLARADO] ' + emp + ': um operador comum virou ADMIN só passando `op=' + nomeAdmin +
      '` na URL — e os nomes dos admins são públicos em /operadores. Resposta: ' +
      r.corpo.slice(0, 90));

    /* ⚠️ e o contrário: sem sessão nenhuma, a rota não pode responder ok:true */
    const semSessao = await chamar(handler, alvo, null);
    let c2 = {};
    try { c2 = JSON.parse(semSessao.corpo || '{}'); } catch (e) {}
    assert.notStrictEqual(c2.ok, true,
      '[ADMIN-DECLARADO] ' + emp + ': rota administrativa respondeu ok:true SEM sessão nenhuma');

    /* ⚠️ e a decisão não pode ter voltado a ler o `op` da URL em NENHUMA das rotas de admin */
    assert.ok(!/if \(!ehAdmin\(op\)\)/.test(fonte),
      '[ADMIN-DECLARADO] ' + emp + ': voltou a decidir permissão com `ehAdmin(op)`, onde `op` vem ' +
      'da query/body — é a escalada de privilégio de novo');
  }

  console.log('OK: nenhuma empresa deixa um operador virar admin declarando o nome na URL');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
