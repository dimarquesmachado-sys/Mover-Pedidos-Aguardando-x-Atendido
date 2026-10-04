/* 04/10 — RESPOSTA OAUTH ANÔMALA APAGAVA O TOKEN VÁLIDO.

   Achado B da auditoria do Codex (P1), nos dois gerenciadores:

   · Bling (`lib/fiscal/token-manager.js`): `postOAuth` olhava só `data.error` e IGNORAVA o
     status HTTP. Um 502 com `{"message":"gateway unavailable"}` passava como renovação
     bem-sucedida: `access_token` vinha `undefined`, `salvarTokens` gravava `{}` por cima do
     arquivo bom, e o log anunciava "renovado ✓".

   · ML (`lib/fiscal/ml-token-manager.js`): o status era conferido, mas os CAMPOS não. Um HTTP
     200 com corpo `{}` era gravado igual.

   O estrago é o pior tipo: uma instabilidade momentânea do provedor DESTRÓI a credencial. A NF
   para de emitir, ninguém liga o sintoma à causa, e recuperar exige reautorizar o app à mão —
   e, no ML, o refresh é de USO ÚNICO, então sem ele guardado não há segunda chance.

   O teste escreve um token BOM em disco, faz o provedor responder de forma anômala e exige duas
   coisas: a renovação LANÇA, e o arquivo continua com o token bom. Verificação textual não
   serviria — o que importa é o que sobra no disco depois.

   Marcador estável [OAUTH-TOKEN]. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');

/* ⚠️ AS LIBS USAM `node-fetch`, NÃO O `fetch` GLOBAL. Minha 1ª versão substituía `global.fetch`
   e NÃO valia nada: a chamada real saía, batia no bloqueio de rede do ambiente, e o teste
   "passava" por um motivo que nada tem a ver com o defeito. As três mutações passaram batidas e
   foi só isso que me mostrou o furo.
   Trocar no cache de módulos é o que de fato intercepta — e precisa vir ANTES do require das
   libs, senão elas já guardaram a referência original. */
let _responder = async () => { throw new Error('resposta não configurada'); };
require.cache[require.resolve('node-fetch')] = {
  id: require.resolve('node-fetch'),
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: (...args) => _responder(...args),
};

const { criarTokenManager } = require(path.join(raiz, 'lib', 'fiscal', 'token-manager'));
const { criarMlTokenManager } = require(path.join(raiz, 'lib', 'fiscal', 'ml-token-manager'));

const BOM = {
  access_token: 'token-bom-que-nao-pode-sumir',
  refresh_token: 'refresh-bom-que-nao-pode-sumir',
  expira_em: Date.now() - 1000,          /* vencido: força a renovação */
};

function lerArquivo(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return null; }
}

/* cada caso: como o provedor responde, e o apelido pra mensagem de erro */
const ANOMALAS = [
  ['HTTP 502 com JSON de gateway', { status: 502, ok: false, corpo: { message: 'gateway unavailable' } }],
  ['HTTP 200 com corpo vazio', { status: 200, ok: true, corpo: {} }],
  ['HTTP 200 sem refresh_token', { status: 200, ok: true, corpo: { access_token: 'novo-token-valido-123', expires_in: 3600 } }],
  ['HTTP 500 com corpo vazio', { status: 500, ok: false, corpo: {} }],
  /* ⚠️ ESTE CASO É O QUE ISOLA A CHECAGEM DE STATUS: corpo COMPLETO e aparentemente válido, mas
     HTTP 502. Sem ele, remover `if (!resp.ok)` passava batido — as checagens de campo pegavam
     todos os meus outros casos, e eu concluiria que a guarda de status não fazia falta.
     Um provedor atrás de gateway pode devolver 5xx com corpo de cache/placeholder; gravar isso
     substitui a credencial boa por uma que não autentica. */
  ['HTTP 502 com corpo que PARECE válido', { status: 502, ok: false,
    corpo: { access_token: 'token-do-gateway-que-nao-autentica', refresh_token: 'refresh-falso', expires_in: 3600 } }],
  /* Codex #603 (P2): campos truthy mas NÃO string — String({}) = "[object Object]" passava */
  ['HTTP 200 com credenciais nao-string', { status: 200, ok: true,
    corpo: { access_token: { value: 'bad-objeto-longo' }, refresh_token: { value: 'bad' } } }],
  /* Codex #603 (P1): corpo traz só o refresh_token — a mensagem não pode vazá-lo */
  ['HTTP 200 so com refresh_token', { status: 200, ok: true, corpo: { refresh_token: 'refresh-vazado-sem-access' } }],
];

/* Codex #603 (P1): nenhuma mensagem de erro pode conter credencial vinda do corpo */
const SEGREDOS = ['token-do-gateway-que-nao-autentica', 'refresh-falso', 'refresh-vazado-sem-access', 'novo-token-valido-123'];
function semVazamento(e, rotulo) {
  for (const s of SEGREDOS) {
    assert.ok(!String(e && e.message).includes(s),
      '[OAUTH-TOKEN] ' + rotulo + ': a mensagem de erro VAZOU credencial do corpo (' + s + ')');
  }
}

module.exports = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-token-'));

  try {
    /* ── BLING ───────────────────────────────────────────────────────────────────── */
    for (const [nome, resposta] of ANOMALAS) {
      const arq = path.join(dir, 'bling-' + nome.replace(/\W+/g, '-') + '.json');
      fs.writeFileSync(arq, JSON.stringify(BOM));

      process.env.TESTE_BLING_ID = 'id-falso';
      process.env.TESTE_BLING_SECRET = 'segredo-falso';
      _responder = async () => ({
        ok: resposta.ok, status: resposta.status,
        json: async () => resposta.corpo,
        text: async () => JSON.stringify(resposta.corpo),
      });

      const tm = criarTokenManager({
        rotulo: 'TESTE', arquivoToken: arq, envTokenFile: 'TESTE_TOKEN_FILE',
        envBlingClientId: 'TESTE_BLING_ID', envBlingClientSecret: 'TESTE_BLING_SECRET',
        envBlingRedirectUri: 'TESTE_BLING_REDIRECT',
      });

      let lancou = false;
      try { await tm.renovarToken(); } catch (e) { lancou = true; semVazamento(e, 'Bling / ' + nome); }

      assert.ok(lancou,
        '[OAUTH-TOKEN] Bling / ' + nome + ': a renovação NÃO lançou — anunciaria "renovado ✓" ' +
        'com um token inútil');

      /* a troca do código de autorização é a OUTRA porta de escrita */
      let lancou2 = false;
      try { await tm.gerarTokenInicial('codigo-falso'); } catch (e) { lancou2 = true; semVazamento(e, 'Bling inicial / ' + nome); }
      assert.ok(lancou2, '[OAUTH-TOKEN] Bling inicial / ' + nome + ': a troca de código NÃO lançou');

      const depois = lerArquivo(arq);
      assert.ok(depois && depois.access_token === BOM.access_token,
        '[OAUTH-TOKEN] Bling / ' + nome + ': o token VÁLIDO foi apagado do disco (ficou ' +
        JSON.stringify(depois) + '). Uma instabilidade do provedor destruiria a credencial e a ' +
        'NF pararia de emitir.');
      assert.strictEqual(depois.refresh_token, BOM.refresh_token,
        '[OAUTH-TOKEN] Bling / ' + nome + ': o refresh_token foi perdido — sem ele não há como ' +
        'renovar de novo');
    }

    /* ── MERCADO LIVRE ───────────────────────────────────────────────────────────── */
    for (const [nome, resposta] of ANOMALAS) {
      const arq = path.join(dir, 'ml-' + nome.replace(/\W+/g, '-') + '.json');
      fs.writeFileSync(arq, JSON.stringify(BOM));

      process.env.TESTE_ML_ID = 'id-falso';
      process.env.TESTE_ML_SECRET = 'segredo-falso';
      _responder = async () => ({
        ok: resposta.ok, status: resposta.status,
        json: async () => resposta.corpo,
        text: async () => JSON.stringify(resposta.corpo),
      });

      const tm = criarMlTokenManager({
        rotulo: 'TESTE', arquivoToken: arq, envTokenFile: 'TESTE_ML_TOKEN_FILE',
        envClientId: 'TESTE_ML_ID', envClientSecret: 'TESTE_ML_SECRET', envRedirect: 'TESTE_ML_REDIRECT',
      });

      const renovar = tm.renovarTokenML || tm.garantirTokenML || tm.renovarToken;
      if (typeof renovar !== 'function') {
        assert.fail('[OAUTH-TOKEN] ML: não achei a função de renovação — o teste precisa ser ' +
          'atualizado em vez de passar sem exercitar nada');
      }

      let lancou = false;
      try { await renovar(); } catch (e) { lancou = true; semVazamento(e, 'ML / ' + nome); }

      assert.ok(lancou,
        '[OAUTH-TOKEN] ML / ' + nome + ': a renovação NÃO lançou');

      /* Codex #603 (P1): trocarCodigoPorToken (/callback-ml) é a OUTRA porta de escrita — um
         200 {} na reautorização sobrescrevia o arquivo bom */
      let lancou2 = false;
      try { await tm.trocarCodigoPorToken('codigo-falso'); } catch (e) { lancou2 = true; semVazamento(e, 'ML troca / ' + nome); }
      assert.ok(lancou2, '[OAUTH-TOKEN] ML troca de código / ' + nome + ': NÃO lançou');

      const depois = lerArquivo(arq);
      assert.ok(depois && depois.access_token === BOM.access_token,
        '[OAUTH-TOKEN] ML / ' + nome + ': o token VÁLIDO foi apagado (ficou ' +
        JSON.stringify(depois) + '). O refresh do ML é de USO ÚNICO: sem ele guardado, não há ' +
        'segunda chance — só reautorizar o app à mão.');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ['TESTE_BLING_ID', 'TESTE_BLING_SECRET', 'TESTE_ML_ID', 'TESTE_ML_SECRET']) delete process.env[k];
  }

  console.log('OK: resposta OAuth anomala nao apaga o token valido (Bling e ML)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
