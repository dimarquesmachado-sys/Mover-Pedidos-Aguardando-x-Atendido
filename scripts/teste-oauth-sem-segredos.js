'use strict';
/* 01/11 — ERRO DE OAUTH SEM PEDAÇO DE CREDENCIAL (auditoria do Codex no SHA 208fdb7d, achado F13). O gerenciador de token
   das NFs (lib/fiscal/nf-token-manager) copiava os primeiros 120 caracteres do corpo CRU da resposta pra mensagem do erro —
   e o JSON inteiro quando vinha `error` —, e o callback mostrava a mensagem na TELA: uma resposta parcial com access_token
   aparecia lá. Os gerenciadores do frágil e dos dois estoques tinham o mesmo `JSON.stringify(data)` no erro. Prova:
   · a regra (lib/http/sem-segredos): tira o VALOR de access_token, refresh_token, code, client_secret e Bearer — em JSON
     (inclusive cortado no meio do valor) e em formulário — e mantém o resto (status, tipo do erro);
   · a FUNÇÃO DE PRODUÇÃO (gerarTokenInicialNF) com o Bling de mentira devolvendo uma resposta parcial com access_token
     e sem refresh_token: o erro sai SEM o token (e continua dizendo o HTTP); com `error` + tokens, idem;
   · os outros três gerenciadores e a tela do callback passam pela mesma regra. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const raiz = path.join(__dirname, '..');
const { semSegredos } = require('../lib/http/sem-segredos');

const TOK = 'SEGREDO-abc123XYZ';
const casos = [
  ['{"access_token":"' + TOK + '","expires_in":21600}', 'JSON'],
  ['{"refresh_token":"' + TOK + '","token_type":"bearer"}', 'JSON refresh'],
  ['{"access_token":"' + TOK.slice(0, 9), 'JSON cortado no meio do valor'],
  ['grant_type=refresh_token&refresh_token=' + TOK + '&x=1', 'formulário'],
  ['code=' + TOK, 'código de autorização'],
  ['Authorization: Bearer ' + TOK, 'Bearer'],
  ['{"client_secret":"' + TOK + '"}', 'client_secret'],
];
for (const [t, desc] of casos) {
  const s = semSegredos(t);
  assert.ok(!s.includes(TOK) && !s.includes(TOK.slice(0, 9)), desc + ': sobrou pedaço do segredo: ' + s);
  assert.ok(s.includes('[oculto]'), desc + ': não marcou o que tirou: ' + s);
}
assert.strictEqual(semSegredos('{"error":"invalid_grant","error_description":"expirado"}'), '{"error":"invalid_grant","error_description":"expirado"}', 'texto sem segredo não pode mudar (o diagnóstico continua)');
assert.ok(semSegredos({ error: 'x', access_token: TOK }).indexOf(TOK) < 0, 'objeto também tinha que sair sem o segredo');

(async () => {
  /* a função de produção, com o Bling de mentira */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nftok-'));
  let corpo = '';
  let status = 200;
  const _load = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'node-fetch') return async () => ({ ok: status >= 200 && status < 300, status, text: async () => corpo, json: async () => JSON.parse(corpo) });
    return _load.apply(this, arguments);
  };
  process.env.TESTE_NF_ID = 'id'; process.env.TESTE_NF_SECRET = 'segredo-do-app'; process.env.TESTE_NF_REDIRECT = 'https://x/cb';
  delete require.cache[require.resolve('../lib/fiscal/nf-token-manager')];
  const { criarNfTokenManager } = require('../lib/fiscal/nf-token-manager');
  const tm = criarNfTokenManager({ rotulo: 'TESTE', envTokenFile: 'TESTE_NF_TOKEN_FILE', arquivoToken: path.join(dir, 'tok.json'), envId: 'TESTE_NF_ID', envSecret: 'TESTE_NF_SECRET', envRedirect: 'TESTE_NF_REDIRECT', rotaSetup: '/teste/setup-nf' });
  /* resposta PARCIAL: access_token sem refresh_token (o caso do Codex) */
  corpo = '{"access_token":"' + TOK + '","expires_in":21600,"token_type":"Bearer"}'; status = 200;
  let erro = null; try { await tm.gerarTokenInicialNF('cod-123'); } catch (e) { erro = e.message; }
  assert.ok(erro && !erro.includes(TOK) && !erro.includes(TOK.slice(0, 9)), 'o erro da resposta parcial carregou o token: ' + erro);
  assert.ok(/HTTP 200/.test(erro), 'o erro tinha que continuar dizendo o HTTP (diagnóstico): ' + erro);
  /* resposta com `error` e os tokens juntos */
  corpo = '{"access_token":"' + TOK + '","refresh_token":"' + TOK + '","error":"estranho"}'; status = 200;
  erro = null; try { await tm.gerarTokenInicialNF('cod-123'); } catch (e) { erro = e.message; }
  assert.ok(erro && !erro.includes(TOK), 'o erro com `error` carregou o token: ' + erro);
  Module._load = _load;
  fs.rmSync(dir, { recursive: true, force: true });
  /* os outros três gerenciadores e a tela do callback passam pela regra */
  for (const arq of ['fragil/tokenManager.js', 'estoque/tokenManager.js', 'estoque-girassol/tokenManager.js']) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(!/OAuth error: \$\{JSON\.stringify\(data\)\}/.test(s) && /sem-segredos'\)\.semSegredos\(data\)/.test(s), arq + ': o erro do OAuth ainda copia o corpo cru');
  }
  const cm = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'criar-modulo.js'), 'utf8');
  assert.ok(/NF Erro: \$\{require\('\.\.\/http\/sem-segredos'\)\.semSegredos\(e\.message\)\}/.test(cm), 'a tela do callback das NFs mostra a mensagem sem passar pela regra');
  console.log('ok — erro de OAuth sem pedaço de credencial: a regra tira os valores (JSON, cortado, formulário, Bearer), o gerenciador das NFs e os outros três passam por ela, e a tela do callback também');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
