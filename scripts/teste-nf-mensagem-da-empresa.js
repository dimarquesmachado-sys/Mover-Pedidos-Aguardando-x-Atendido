/* 04/10 — A MENSAGEM DE ERRO DA NF DIZIA "AMB" PRA TODAS AS EMPRESAS.

   Achado numa auditoria do Codex (nº 11). `lib/fiscal/nf-token-manager.js` é compartilhada e já
   RECEBE `envId`, `envSecret` e `rotaSetup` por empresa — mas os textos de erro estavam
   chumbados com `AMB_NF_BLING_*` e `/amb/setup-nf`.

   Não é troca de credencial: é INSTRUÇÃO ERRADA. Quem opera a GOOD lia "cadastre
   AMB_NF_BLING_CLIENT_ID" ou "reautorize em /amb/setup-nf" e ia mexer na empresa errada — numa
   tela fiscal, onde mexer errado custa caro.

   ⚠️ O teste antigo (`teste-nf-token-manager.js`) ficava VERDE com o defeito presente: usava
   regex com `\b`, e `_` conta como parte de palavra, então `AMB_` nunca casava. Por isso este
   aqui EXECUTA a lib com três empresas e lê a mensagem que sai — em vez de procurar texto no
   arquivo.

   ⚠️ Codex #598: a 1ª versão usava um arquivo de token inexistente, então `garantirTokenNF()`
   sempre caía em "refresh_token ausente" e nunca chegava aos dois 403 (sonda /nfe e sonda
   pós-renovação) — dava pra reverter ambos pra `/amb/setup-nf` com o teste verde. Agora o
   `node-fetch` é simulado e CADA caminho de erro com nome de empresa é exercitado: sem token,
   403 na sonda, 403 após renovar e credencial ausente (as DUAS variáveis, por nome).

   Marcador estável [NF-EMPRESA] pra quem for verificar esta proteção distinguir "a asserção
   disparou" de "o processo morreu". */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* O fetch da lib é capturado na criação do gerenciador: troco o módulo no cache ANTES de
   carregar a lib, e devolvo no fim (assim também não depende do node_modules). `roteiro` decide o que cada chamada devolve. */
const Module = require('module');
const carregarOriginal = Module._load;
let roteiro = { nfe: [], oauth: null };
function resposta(status, corpo) {
  const texto = JSON.stringify(corpo);
  return { ok: status >= 200 && status < 300, status, text: async () => texto };
}
const fetchFalso = async (url) => {
  if (String(url).includes('/oauth/token')) return resposta(200, roteiro.oauth);
  const status = roteiro.nfe.shift();
  if (status == null) throw new Error('[NF-EMPRESA] sonda /nfe chamada mais vezes que o roteiro previa');
  return resposta(status, {});
};
Module._load = function (request, ...resto) {
  if (request === 'node-fetch') return fetchFalso;
  return carregarOriginal.call(this, request, ...resto);
};
const libId = require.resolve('../lib/fiscal/nf-token-manager');
delete require.cache[libId];
const { criarNfTokenManager } = require(libId);

const EMPRESAS = [
  ['GOOD', 'GOOD_NF_BLING_CLIENT_ID', 'GOOD_NF_BLING_CLIENT_SECRET', '/good/setup-nf'],
  ['Girassol', 'GIRASSOL_NF_BLING_CLIENT_ID', 'GIRASSOL_NF_BLING_CLIENT_SECRET', '/girassol/setup-nf'],
  ['AMBTotal', 'AMB_NF_BLING_CLIENT_ID', 'AMB_NF_BLING_CLIENT_SECRET', '/amb/setup-nf'],
];

const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-msg-'));
let n = 0;
function criar([rotulo, envId, envSecret, rotaSetup], tokens) {
  const arquivoToken = path.join(dirTmp, rotulo + '-' + (++n) + '.json');
  if (tokens) fs.writeFileSync(arquivoToken, JSON.stringify(tokens));
  delete process.env.TESTE_NF_TOKEN_FILE;
  return criarNfTokenManager({
    rotulo, envTokenFile: 'TESTE_NF_TOKEN_FILE', arquivoToken,
    envId, envSecret, envRedirect: 'TESTE_NF_REDIRECT', rotaSetup,
  });
}
async function erroDe(fn) {
  try { await fn(); } catch (e) { return String((e && e.message) || e); }
  return '';
}
/* a mensagem tem que existir, ser a esperada, citar a rota DA EMPRESA e NENHUMA rota de outra:
   era o defeito — quem opera a GOOD era mandado reautorizar o app da AMB */
function confere(emp, cenario, msg, trecho) {
  const [rotulo, , , rotaSetup] = emp;
  const ctx = '[NF-EMPRESA] ' + rotulo + ' / ' + cenario + ': ';
  assert.ok(msg, ctx + 'devia lançar erro explicando o que fazer');
  assert.ok(msg.includes(trecho), ctx + 'não é o erro esperado (' + trecho + ') → "' + msg.slice(0, 110) + '"');
  assert.ok(msg.includes(rotaSetup), ctx + 'a mensagem não cita ' + rotaSetup + ' → "' + msg.slice(0, 110) + '"');
  for (const outra of EMPRESAS) {
    if (outra[0] === rotulo) continue;
    assert.ok(!msg.includes(outra[3]),
      ctx + 'manda ir em ' + outra[3] + ' (rota da ' + outra[0] + ') → "' + msg.slice(0, 110) + '"');
  }
}

module.exports = (async () => {
  try {
    for (const emp of EMPRESAS) {
      const [rotulo, envId, envSecret] = emp;
      process.env[envId] = 'id-falso';
      process.env[envSecret] = 'segredo-falso';
      const bom = { access_token: 'token-valido-0123456789', refresh_token: 'refresh-valido' };

      /* 1) sem token nenhum → "refresh_token ausente" */
      roteiro = { nfe: [], oauth: null };
      confere(emp, 'sem token', await erroDe(() => criar(emp).garantirTokenNF()), 'refresh_token ausente');

      /* 2) token guardado, sonda /nfe responde 403 → reautorizar */
      roteiro = { nfe: [403], oauth: null };
      confere(emp, '403 na sonda', await erroDe(() => criar(emp, bom).garantirTokenNF()), '403 na sonda /nfe');

      /* 3) sonda 401 → renova (OAuth ok) → sonda do token NOVO responde 403 → reautorizar */
      roteiro = { nfe: [401, 403], oauth: { access_token: 'token-novo-0123456789', refresh_token: 'refresh-novo' } };
      confere(emp, '403 após renovar', await erroDe(() => criar(emp, bom).garantirTokenNF()), 'renovado SEM a permissão');
      assert.strictEqual(roteiro.nfe.length, 0, '[NF-EMPRESA] ' + rotulo + ': a sonda pós-renovação não rodou');
    }

    /* 4) credencial ausente: tem que dizer as DUAS variáveis da empresa, e nenhuma de outra */
    for (const emp of EMPRESAS) {
      const [rotulo, envId, envSecret] = emp;
      delete process.env[envId];
      delete process.env[envSecret];
      const msg = await erroDe(() => criar(emp).gerarTokenInicialNF('codigo-falso'));
      assert.ok(msg, '[NF-EMPRESA] ' + rotulo + ': sem credencial devia lançar erro');
      assert.ok(msg.includes(envId) && msg.includes(envSecret),
        '[NF-EMPRESA] ' + rotulo + ': a mensagem não cita ' + envId + ' e ' + envSecret + ' → "' + msg.slice(0, 110) + '"');
      for (const outra of EMPRESAS) {
        if (outra[0] === rotulo) continue;
        assert.ok(!msg.includes(outra[1]) && !msg.includes(outra[2]),
          '[NF-EMPRESA] ' + rotulo + ' cita variável da ' + outra[0] + ' → "' + msg.slice(0, 110) + '"');
      }
    }
  } finally {
    Module._load = carregarOriginal;
    fs.rmSync(dirTmp, { recursive: true, force: true });
  }

  console.log('OK: a mensagem da NF cita a rota e as variaveis DA PROPRIA empresa (todos os caminhos de erro)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
