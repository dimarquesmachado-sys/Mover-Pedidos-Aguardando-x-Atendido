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

  const base = {
    prefixo: '/teste', empresaId: EMPRESA,
    json: (res, s, b) => { res._s = s; res._b = b; },
    readBody: async () => ({ id: '123037', nf_numero: '004622', op: 'ygor' }),
    readJson: (p, pad) => pad,
    writeJson: () => {},
    /* ⚠️ a rota GRAVA de verdade: um ensureDir de mentira fazia a anexação falhar e o teste
       nunca chegava no aviso */
    ensureDir: (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} },
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
  };
  const handler = criar(base);

  /* ── 1) A ROTA DE ANEXAR NF TEM QUE DISPARAR O AVISO (Codex #608) ──────────────────
     ⚠️ A versão anterior deste teste só chamava a rota GET da Shopee e depois conferia TEXTO do
     arquivo — o dublê instalado e o array `avisos` ficavam sem uso. Regressão onde a chamada
     fosse inalcançável, ou fosse feita com o código de evento/pedido errado, passaria batida.
     Agora o POST roda de verdade e o aviso é inspecionado. */
  {
    const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(300)).toString('base64');
    const xml = Buffer.from('<nfeProc><NFe><infNFe><ide><nNF>004622</nNF>' +
      '<dhEmi>2026-10-04T10:00:00-03:00</dhEmi></ide></infNFe></NFe></nfeProc>').toString('base64');
    const h2 = criar(Object.assign({}, base, {
      /* ⚠️ `numeroNF` sai do XML (<nNF>), não de um campo do corpo — li o código em vez de supor.
         Sem XML o aviso cai pro número do pedido, que é o comportamento certo. */
      /* ⚠️ a rota recebe UM arquivo em `pdf_base64` e descobre o tipo pelo CONTEÚDO (não existe
         `xml_base64`). Mando o XML por ali: é dele que sai o `numeroNF` (<nNF>), que é o código
         pelo qual se pesquisa no Devoluções. Li o módulo em vez de supor o nome do campo. */
      readBody: async () => ({ id: '123037', pdf_base64: xml, op: 'ygor' }),
    }));
    const res = { _s: 0, _b: null };
    const u = new URL('http://x/teste/nf-anexar');
    const tratou = await h2({ method: 'POST', url: u.pathname, headers: {} }, res, u, 'POST', () => 'admin');

    assert.strictEqual(tratou, true, '[NF-AVISA] a rota /nf-anexar não tratou o POST');
    assert.ok(res._b && res._b.ok === true,
      '[NF-AVISA] a anexação falhou: ' + JSON.stringify(res._b).slice(0, 120));

    assert.strictEqual(avisos.length, 1,
      '[NF-AVISA] a rota salvou a NF e respondeu ok:true, mas disparou ' + avisos.length +
      ' aviso(s) ao Devoluções. A busca por número de NF lá não acharia nada, e ninguém ligaria ' +
      'a falta à anexação feita no checkout.');

    const av = avisos[0];
    assert.strictEqual(av.tipo, 'nf_anexada',
      '[NF-AVISA] o evento foi "' + av.tipo + '" em vez de "nf_anexada" — o Devoluções não ' +
      'registraria como NF');
    assert.strictEqual(String(av.codigo), '004622',
      '[NF-AVISA] o aviso levou o código "' + av.codigo + '" em vez do número da NF — é por ele ' +
      'que se pesquisa no Devoluções');
    assert.ok(av.extra && String(av.extra.pedido) === '123037',
      '[NF-AVISA] o aviso não levou o pedido → ' + JSON.stringify(av.extra).slice(0, 90));
  }

  /* ── 2) o diagnóstico da Shopee tem que dizer a empresa CERTA ──────────────────────
     ⚠️ Codex #608: antes isto era condicional (`if (tratou && ...)`) — renomear a rota ou
     devolver `false` fazia o bloco inteiro ser PULADO e o teste passava mesmo assim. */
  {
    const res = { _s: 0, _b: null };
    const u = new URL('http://x/teste/shopee-sessao?k=' + (process.env.ADMIN_KEY || 'x'));
    const tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET', () => 'admin');

    assert.strictEqual(tratou, true,
      '[NF-AVISA] a rota /shopee-sessao não respondeu — sumiu ou foi renomeada, e a identificação ' +
      'da empresa que este conserto garante deixou de existir');
    assert.ok(res._b && res._b.empresa !== undefined,
      '[NF-AVISA] o diagnóstico não traz mais o campo `empresa`');
    assert.strictEqual(res._b.empresa, 'teste',
      '[NF-AVISA] o diagnóstico se identifica como "' + res._b.empresa + '" com prefixo /teste — ' +
      'empresa errada manda procurar o problema na loja errada');
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

  /* ── 4) A ENTREGA que falha tem que DEIXAR RASTRO (Codex #608) ─────────────────────
     O ajudante ignorava o status da resposta e engolia erro de rede com ouvinte VAZIO. "Fire-
     and-forget" virava "nunca soube": a NF anexada, a rota ok:true, e o aviso podia não chegar
     sem uma linha de log. Foi assim que o caminho de require quebrado ficou escondido.
     Aqui o ajudante REAL é exercitado contra uma porta fechada. */
  {
    delete require.cache[alvo];                      /* tira o dublê: quero o módulo de verdade */
    const avisarReal = require(alvo);
    const erros = [];
    const origErr = console.error;
    console.error = (m) => erros.push(String(m));
    const antesU = process.env.DEVOLUCOES_URL, antesK = process.env.DEVOLUCOES_KEY;
    process.env.DEVOLUCOES_URL = 'http://127.0.0.1:59999';   /* ninguém ouvindo */
    process.env.DEVOLUCOES_KEY = 'k';
    try {
      avisarReal('good', 'nf_anexada', '004622', { pedido: '123037' });
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      console.error = origErr;
      if (antesU == null) delete process.env.DEVOLUCOES_URL; else process.env.DEVOLUCOES_URL = antesU;
      if (antesK == null) delete process.env.DEVOLUCOES_KEY; else process.env.DEVOLUCOES_KEY = antesK;
    }

    assert.ok(erros.length > 0,
      '[NF-AVISA] o aviso falhou na ENTREGA e não deixou rastro nenhum — "fire-and-forget" virou ' +
      '"nunca soube", que é exatamente o que escondeu o caminho de require quebrado');
    assert.ok(/004622/.test(erros.join(' ')),
      '[NF-AVISA] o rastro da falha não diz QUAL NF → ' + erros.join(' ').slice(0, 110));
  }

  console.log('OK: o aviso ao Devolucoes resolve, deixa rastro ao falhar, e a empresa nao e chumbada');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
