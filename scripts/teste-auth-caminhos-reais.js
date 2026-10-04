/* 04/10 — AUTENTICAÇÃO QUEBRADA PASSAVA VERDE.

   Achado numa auditoria do Codex (nº 3). As proteções que existiam procuravam TEXTO no fonte:
     · `teste-chave-header.js` casava `lerChaveAdmin(req, urlObj)` com aspas SIMPLES. Trocar a
       chamada por `urlObj.searchParams.get("k")` (aspas DUPLAS) fazia a rota deixar de aceitar
       o header — 200 virava 404 — e o teste seguia verde;
     · `teste-estado-sem-global.js` procurava os identificadores da sessão. Desligar o ramo com
       `false && sessS && ehAdmin(sessS)` mantém os nomes no arquivo: o admin logado perdia
       acesso e nenhum teste reclamava.

   Em rota de admin isso é sério nos dois sentidos: ou o dono perde acesso sem ninguém notar, ou
   uma forma de autenticar deixa de ser exigida.

   Aqui a verificação é COMPORTAMENTAL: chama a rota de verdade nas cinco formas e exige o status
   esperado em cada uma. Regex não demonstra decisão de autorização — foi o critério que o Codex
   deu, e este teste é a aplicação dele.

   Marcador estável [AUTH-REAL] pra distinguir "a asserção disparou" de "o processo morreu". */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const CHAVE = 'teste-auth-' + Date.now();
process.env.ADMIN_KEY = CHAVE;
/* Hermético: o verifica.js herda o ambiente de quem roda. Com GOODBKP_ADMIN=Diego o `ehAdmin`
   recusaria o cookie forjado e o teste falharia por motivo alheio à rota. Fixo a lista aqui,
   ANTES do require, com o mesmo nome usado no cookie. */
const ADMIN_TESTE = 'admin';
process.env.GOODBKP_ADMIN = ADMIN_TESTE;

/* a rota de status do backfill da GOOD: aceita CHAVE (query ou header) OU sessão de admin */
const ROTA = '/good-checkout-offline/backfill-status';

function chamar(handler, { query, header, bearer, cookie } = {}) {
  const res = {
    _s: 0, _b: '',
    writeHead(s) { this._s = s; },
    setHeader() {},
    end(b) { this._b = String(b || ''); },
  };
  const u = new URL('http://x' + ROTA + (query ? '?k=' + encodeURIComponent(query) : ''));
  const headers = {};
  if (header) headers['x-admin-key'] = header;
  if (bearer) headers['authorization'] = 'Bearer ' + bearer;
  if (cookie) headers['cookie'] = cookie;
  return handler({ method: 'GET', url: u.pathname + u.search, headers }, res, u)
    .then((tratou) => ({ tratou, status: res._s, corpo: res._b }));
}

module.exports = (async () => {
  const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));

  /* 1) chave na querystring → entra */
  {
    const r = await chamar(handler, { query: CHAVE });
    assert.strictEqual(r.status, 200,
      '[AUTH-REAL] chave na URL devia entrar e respondeu ' + r.status + ' — o dono perdeu acesso');
  }

  /* 2) chave no header → entra. ⚠️ É O CAMINHO QUE O TESTE ANTIGO NÃO PROVAVA: ele só procurava
     o texto `lerChaveAdmin(req, urlObj)` com aspas simples no fonte. */
  {
    const r = await chamar(handler, { header: CHAVE });
    assert.strictEqual(r.status, 200,
      '[AUTH-REAL] chave no header X-Admin-Key devia entrar e respondeu ' + r.status +
      ' — a rota parou de ler o header, e nenhum teste de texto pegaria isso');
  }

  /* 3) chave como Bearer → entra */
  {
    const r = await chamar(handler, { bearer: CHAVE });
    assert.strictEqual(r.status, 200,
      '[AUTH-REAL] chave como Bearer devia entrar e respondeu ' + r.status);
  }

  /* ⚠️ 4) SESSÃO DE ADMIN → entra. ESTE É O CAMINHO QUE FALTAVA: na primeira versão deste teste
     eu cobri só a chave, e a mutação do relatório (`false && sessS && ehAdmin(sessS)`) passou
     batida — o admin LOGADO perdia acesso e meu teste novo seguia verde. Quase repeti o erro que
     vim consertar.
     O cookie é montado como o servidor faz (payload base64url + HMAC do mesmo segredo), lendo o
     nome e o segredo do próprio módulo — nada inventado aqui. */
  {
    const crypto = require('crypto');
    /* ⚠️ o módulo NÃO exporta nada de sessão — e eu não vou exportar só pra testar, porque isso
       alargaria a superfície pública de um arquivo de produção. Leio o nome do cookie do fonte e
       derivo o segredo como o próprio servidor faz:
         const SESS_SECRET = process.env.ADMIN_KEY || process.env.SESSION_SECRET || …
       Como este teste define ADMIN_KEY, o segredo é conhecido sem inventar nada. */
    const fonte = require('fs').readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    const mCookie = fonte.match(/const SESS_COOKIE\s*=\s*'([^']+)'/);
    const nomeCookie = mCookie ? mCookie[1] : 'bkp_sess';
    const segredo = process.env.ADMIN_KEY;
    const admin = ADMIN_TESTE;
    if (segredo) {
      const pl = Buffer.from(JSON.stringify({ n: admin, exp: Date.now() + 600000 })).toString('base64url');
      const sig = crypto.createHmac('sha256', segredo).update(pl).digest('base64url');
      const r = await chamar(handler, { cookie: nomeCookie + '=' + pl + '.' + sig });
      assert.strictEqual(r.status, 200,
        '[AUTH-REAL] admin LOGADO devia entrar e respondeu ' + r.status + ' — o ramo da sessão ' +
        'foi desligado, e teste de texto não pega isso (os identificadores continuam no arquivo)');
    } else {
      /* ⚠️ se o módulo não expõe o segredo, NÃO finjo que testei: aviso e reprovo, porque um
         caminho de autenticação sem cobertura é falsa sensação de proteção. */
      assert.fail('[AUTH-REAL] não consegui montar sessão de admin — o módulo não expõe ' +
        'SESS_SECRET; sem isso o caminho da sessão fica SEM teste e a mutação do relatório passa');
    }
  }

  /* 5) SEM credencial nenhuma → NÃO entra. O outro lado do risco: se esta falhar, a rota de
     admin ficou aberta. */
  {
    const r = await chamar(handler, {});
    assert.notStrictEqual(r.status, 200,
      '[AUTH-REAL] a rota respondeu 200 SEM credencial — rota de admin aberta');
  }

  /* 6) chave ERRADA → NÃO entra */
  {
    const r = await chamar(handler, { query: 'chave-errada-de-proposito' });
    assert.notStrictEqual(r.status, 200,
      '[AUTH-REAL] a rota aceitou uma chave ERRADA — a comparação com ADMIN_KEY sumiu');
  }

  console.log('OK: a rota de admin aceita chave por URL, header e Bearer — e recusa sem/errada');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
