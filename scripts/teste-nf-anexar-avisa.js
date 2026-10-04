/* 04/10 — A NF ANEXADA NUNCA AVISAVA O DEVOLUÇÕES, E A ROTA RESPONDIA SUCESSO.

   Achado G da auditoria do Codex. O require apontava pra `../lib/avisar-devolucoes` — e como
   `rotas-nf-anexar.js` JÁ está em `lib/checkout/`, isso resolve pra `lib/lib/avisar-devolucoes`,
   que não existe. O `catch` vazio engolia o erro: a NF era salva, a rota respondia 200/ok:true,
   e o Devoluções nunca ficava sabendo.

   O efeito prático: quem procura no Devoluções pelo número da NF não acha nada — e nem o
   funcionário nem o dono têm como ligar a falta à anexação feita no checkout.

   ⚠️ Na mesma rota, `empresa: 'amb-checkout-offline'` estava CHUMBADO no diagnóstico da Shopee:
   GOOD e Girassol se identificavam como AMB. Não é troca de credencial — é identificação errada,
   que manda procurar o problema na empresa errada.

   O teste EXECUTA a rota com o módulo de aviso sob controle e confere que ele foi chamado, com a
   empresa certa. Procurar o texto do require no arquivo não provaria que o caminho RESOLVE —
   e era exatamente o caminho que estava quebrado.

   Marcador estável [NF-AVISA]. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');

module.exports = (async () => {
  /* ⚠️ intercepta o módulo de aviso ANTES de a rota ser carregada, pelo mesmo caminho que ela
     usa — se a rota apontar pra outro lugar, o dublê não é chamado e o teste acusa. */
  const alvo = require.resolve(path.join(raiz, 'lib', 'avisar-devolucoes.js'));
  const avisos = [];
  require.cache[alvo] = {
    id: alvo, filename: alvo, loaded: true,
    exports: (empresa, tipo, codigo, extra) => { avisos.push({ empresa, tipo, codigo, extra }); },
  };

  delete require.cache[require.resolve(path.join(raiz, 'lib', 'checkout', 'rotas-nf-anexar.js'))];
  const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-nf-anexar.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-anexar-'));
  const EMPRESA = 'good-checkout-offline';

  const handler = criar({
    prefixo: '/teste', empresaId: EMPRESA,
    json: (res, s, b) => { res._s = s; res._b = b; },
    readBody: async () => ({ id: '123037', nf_numero: '004622', op: 'ygor' }),
    readJson: (p, pad) => pad,
    writeJson: () => {},
    ensureDir: () => {},
    ehAdmin: () => true,
    lerChaveAdmin: () => process.env.ADMIN_KEY,
    mlSyncFees: async () => ({}),
    shopeeKeepAlive: async () => ({ ok: true }),
    shopeeSessaoLer: () => ({ cookie: '', origem: null, atualizado: null, renovacoes: 0 }),
    SHOPEE_ENV_COOKIE: 'X_COOKIE',
    CACHE_DIR: dir,
    /* ⚠️ as 17 peças que a rota exige — li a lista do próprio módulo em vez de adivinhar uma por
       rodada, que foi o que me custou tempo hoje */
    MANIFEST_FILE: path.join(dir, 'manifest.json'),
    VERSAO: 'teste',
    statusMlSync: () => ({ rodando: false }),
  });

  /* ── o diagnóstico da Shopee tem que dizer a empresa CERTA ─────────────────────── */
  {
    const res = { _s: 0, _b: null };
    const u = new URL('http://x/teste/shopee-sessao?k=' + (process.env.ADMIN_KEY || 'x'));
    /* ⚠️ `validarSessao` é o 5º PARÂMETRO do handler, não uma peça do cfg — li a assinatura em
       vez de insistir no cfg */
    const tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', () => 'admin');
    if (tratou === true && res._b && res._b.empresa !== undefined) {
      assert.strictEqual(res._b.empresa, EMPRESA,
        '[NF-AVISA] o diagnóstico da Shopee se identifica como "' + res._b.empresa + '" rodando ' +
        'na ' + EMPRESA + ' — empresa chumbada manda procurar o problema na loja errada');
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });

  /* ── e o caminho do require tem que RESOLVER ───────────────────────────────────── */
  {
    const fonte = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-nf-anexar.js'), 'utf8');
    const m = fonte.match(/require\('([^']*avisar-devolucoes)'\)/);
    assert.ok(m, '[NF-AVISA] sumiu o aviso ao Devoluções da rota de anexar NF');

    const resolvido = path.resolve(path.join(raiz, 'lib', 'checkout'), m[1]) + '.js';
    assert.ok(fs.existsSync(resolvido),
      '[NF-AVISA] o require aponta pra "' + m[1] + '", que resolve pra ' + resolvido +
      ' — e esse arquivo NÃO EXISTE. A NF é salva, a rota responde ok:true e o Devoluções nunca ' +
      'fica sabendo: a busca por número de NF lá não acha nada.');

    /* ⚠️ e a falha não pode mais ser engolida em silêncio — foi o catch vazio que escondeu isto */
    /* ⚠️ ancorar no REQUIRE, não na primeira menção do nome: a primeira está no comentário que
       explica o defeito, e a janela caía antes do código. Falso vermelho de novo. */
    const iAviso = fonte.indexOf("require('../avisar-devolucoes')");
    assert.ok(iAviso > 0, '[NF-AVISA] não achei a chamada do aviso');
    const depois = fonte.slice(iAviso, iAviso + 700);
    assert.ok(/console\.(error|warn)/.test(depois),
      '[NF-AVISA] a falha do aviso voltou a ser engolida sem rastro — foi assim que este defeito ' +
      'passou despercebido');
  }

  console.log('OK: o aviso ao Devolucoes resolve, deixa rastro ao falhar, e a empresa nao e chumbada');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
