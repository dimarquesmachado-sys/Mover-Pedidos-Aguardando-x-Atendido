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

   Marcador estável [NF-EMPRESA] pra quem for verificar esta proteção distinguir "a asserção
   disparou" de "o processo morreu". */
const assert = require('assert');
const path = require('path');
const { criarNfTokenManager } = require(path.join(__dirname, '..', 'lib', 'fiscal', 'nf-token-manager'));

const EMPRESAS = [
  ['GOOD', 'GOOD_NF_BLING_CLIENT_ID', 'GOOD_NF_BLING_CLIENT_SECRET', '/good/setup-nf'],
  ['Girassol', 'GIRASSOL_NF_BLING_CLIENT_ID', 'GIRASSOL_NF_BLING_CLIENT_SECRET', '/girassol/setup-nf'],
  ['AMBTotal', 'AMB_NF_BLING_CLIENT_ID', 'AMB_NF_BLING_CLIENT_SECRET', '/amb/setup-nf'],
];

module.exports = (async () => {
  for (const [rotulo, envId, envSecret, rotaSetup] of EMPRESAS) {
    delete process.env[envId];
    delete process.env[envSecret];

    const tm = criarNfTokenManager({
      rotulo,
      envTokenFile: 'TESTE_NF_TOKEN_FILE',
      arquivoToken: '/tmp/nf-token-inexistente-' + rotulo + '.json',
      envId, envSecret,
      envRedirect: 'TESTE_NF_REDIRECT',
      rotaSetup,
    });

    let msg = '';
    try { await tm.garantirTokenNF(); } catch (e) { msg = String((e && e.message) || e); }

    assert.ok(msg, '[NF-EMPRESA] ' + rotulo + ': sem token e sem credencial, devia explicar o que fazer');

    /* a mensagem tem que apontar a rota DA EMPRESA */
    assert.ok(msg.includes(rotaSetup),
      '[NF-EMPRESA] ' + rotulo + ': a mensagem não cita ' + rotaSetup + ' → "' + msg.slice(0, 90) + '"');

    /* ⚠️ e NÃO pode citar a rota de outra empresa: era o defeito — quem opera a GOOD era mandado
       reautorizar o app da AMB */
    for (const [outro, , , rotaOutra] of EMPRESAS) {
      if (outro === rotulo) continue;
      assert.ok(!msg.includes(rotaOutra),
        '[NF-EMPRESA] ' + rotulo + ' manda ir em ' + rotaOutra + ' (rota da ' + outro + ') → "' +
        msg.slice(0, 90) + '"');
    }
  }

  /* e o erro de credencial ausente também tem que dizer o nome certo da variável */
  {
    const tm = criarNfTokenManager({
      rotulo: 'GOOD',
      envTokenFile: 'TESTE_NF_TOKEN_FILE',
      arquivoToken: '/tmp/nf-token-inexistente-GOOD.json',
      envId: 'GOOD_NF_BLING_CLIENT_ID', envSecret: 'GOOD_NF_BLING_CLIENT_SECRET',
      envRedirect: 'TESTE_NF_REDIRECT', rotaSetup: '/good/setup-nf',
    });
    let msg = '';
    try { await tm.gerarTokenInicialNF('codigo-falso'); } catch (e) { msg = String((e && e.message) || e); }
    assert.ok(!/AMB_NF_BLING/.test(msg),
      '[NF-EMPRESA] a GOOD manda cadastrar AMB_NF_BLING_* — variável de outra empresa → "' +
      msg.slice(0, 90) + '"');
  }

  console.log('OK: a mensagem da NF cita a rota e as variaveis DA PROPRIA empresa');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
