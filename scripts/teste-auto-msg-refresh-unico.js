/* 04/10 — DUAS RENOVAÇÕES SIMULTÂNEAS QUEIMAVAM O REFRESH DO ML (Auto Mensagens).

   Achado C da auditoria do Codex (P1). O refresh do Mercado Livre é de USO ÚNICO. Neste módulo
   `refreshToken()` era chamado direto, sem promessa compartilhada: dois chamadores cruzando a
   expiração ao mesmo tempo disparavam DOIS POSTs com o MESMO refresh. O provedor aceita o
   primeiro e responde `invalid_grant` ao segundo — e aí o segundo chamador falha, ou pior,
   grava por cima.

   Não é hipótese: há crons coincidentes e chamada manual no mesmo processo.

   `lib/fiscal/ml-token-manager.js` já resolvia isso com promessa única; este módulo ficou de
   fora. Agora usa o mesmo padrão.

   O teste prova COMPORTAMENTO: dispara dois `garantirTokenML()` ao mesmo tempo com o token
   vencido e conta quantos POSTs saíram. Contar POST é a única forma de demonstrar isto —
   procurar `_renovacaoEmVoo` no arquivo não prova que os chamadores compartilham a promessa.

   ⚠️ O transporte simulado é de USO ÚNICO, como o provedor real: o segundo POST com o mesmo
   refresh recebe `invalid_grant`. Assim, se a corrida voltar, o teste não "passa por sorte".

   Marcador estável [REFRESH-UNICO]. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');

module.exports = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-msg-'));
  process.env.AUTO_MSG_DATA_DIR = dir;   /* ⚠️ o nome é este, não DATA_DIR — conferido no módulo */
  process.env.ML_CLIENT_ID = process.env.ML_CLIENT_ID || 'id-falso';
  process.env.ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'segredo-falso';

  /* token VENCIDO: força a renovação nos dois chamadores */
  fs.writeFileSync(path.join(dir, 'ml-tokens.json'), JSON.stringify({
    access_token: 'velho', refresh_token: 'refresh-uso-unico',
    expires_in: 21600, obtained_at: Date.now() - (21600 * 1000),
    user_id: 1,
  }));

  const fetchOriginal = global.fetch;
  let posts = 0;
  const refreshUsados = new Set();

  global.fetch = async (url, opts) => {
    const corpo = String((opts && opts.body) || '');
    const usado = (corpo.match(/refresh_token=([^&]+)/) || [])[1] || '';
    posts++;
    /* ⚠️ USO ÚNICO, como o provedor: o mesmo refresh só vale uma vez */
    if (refreshUsados.has(usado)) {
      const corpoRuim = '{"error":"invalid_grant","message":"refresh já utilizado"}';
      return { ok: false, status: 400, json: async () => JSON.parse(corpoRuim), text: async () => corpoRuim };
    }
    refreshUsados.add(usado);
    await new Promise((r) => setTimeout(r, 30));   /* latência: dá tempo de a corrida acontecer */
    /* ⚠️ O MÓDULO LÊ COM `r.text()`, NÃO `r.json()`. Meu dublê devolvia `text: '{}'` e o módulo
       gravou um token vazio — o teste falhava com "Nenhum token" e eu quase fui procurar o
       defeito no lugar errado. O corpo tem que estar no `text`. */
    const corpoOk = JSON.stringify({ access_token: 'novo-token-valido', refresh_token: 'refresh-novo',
                                     expires_in: 21600, user_id: 1 });
    return { ok: true, status: 200, json: async () => JSON.parse(corpoOk), text: async () => corpoOk };
  };

  try {
    /* ⚠️  é const avaliada NO CARREGAMENTO do módulo: a env tem que existir ANTES
       do require, e o cache precisa ser limpo — senão o módulo aponta pro /data de produção e o
       teste falha com "Nenhum token", sem relação com o defeito. */
    delete require.cache[require.resolve(path.join(raiz, 'auto-mensagens', 'mlTokenManager.js'))];
    const tm = require(path.join(raiz, 'auto-mensagens', 'mlTokenManager.js'));

    /* ── OS DOIS AO MESMO TEMPO, como cron + chamada manual ───────────────────────── */
    const [a, b] = await Promise.allSettled([tm.garantirTokenML(), tm.garantirTokenML()]);

    assert.strictEqual(posts, 1,
      '[REFRESH-UNICO] dois chamadores simultâneos dispararam ' + posts + ' POST(s) de refresh. ' +
      'O refresh do ML é de USO ÚNICO: o segundo recebe `invalid_grant` e aquele chamador fica ' +
      'sem token — com crons coincidentes, isso derruba o Auto Mensagens sozinho.');

    assert.strictEqual(a.status, 'fulfilled',
      '[REFRESH-UNICO] o 1º chamador falhou: ' + (a.reason && a.reason.message));
    assert.strictEqual(b.status, 'fulfilled',
      '[REFRESH-UNICO] o 2º chamador falhou — sinal de que ele mandou o próprio POST e levou ' +
      '`invalid_grant`: ' + (b.reason && b.reason.message));
    assert.strictEqual(a.value, b.value,
      '[REFRESH-UNICO] os dois chamadores receberam tokens DIFERENTES — não compartilharam a ' +
      'mesma renovação');

    /* ── e depois da renovação, uma nova chamada NÃO pode renovar de novo ─────────── */
    const antes = posts;
    await tm.garantirTokenML();
    assert.strictEqual(posts, antes,
      '[REFRESH-UNICO] renovou de novo com token recém-obtido — gastaria refresh à toa');
  } finally {
    global.fetch = fetchOriginal;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AUTO_MSG_DATA_DIR;
  }

  console.log('OK: dois chamadores simultaneos geram UM POST de refresh no Auto Mensagens');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
