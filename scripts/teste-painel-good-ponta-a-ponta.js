/* 05/10 — O PAINEL DA GOOD TEM QUE ABRIR INTEIRO, NÃO SÓ EXISTIR.

   O painel ganhou 6 seções em peças compartilhadas (plano de compra, ferramentas de custo,
   devoluções do ML, manutenção, financeiro do ML, ficha do produto). Cada uma depende de 3 coisas
   que moram em arquivos DIFERENTES, e já quebrou em todas:

     · o <script src> na tela      — faltou no #610 e a seção não aparecia;
     · a liberação na guarda       — sem ela, quem abre por `?k=` toma 401 e a seção fica vazia;
     · a fábrica servindo o script — sem ela, 404 silencioso.

   Este teste abre a tela, lê os `<script src>` DELA (não uma lista que eu escrevi) e exige que
   cada um seja servido, com 200, compilando, e com o prefixo da GOOD. É a diferença entre "a
   seção está no código" e "a seção abre".

   ⚠️ Lê da TELA de propósito: lista escrita à mão envelhece em silêncio — some um script e o
   teste continua verde testando os outros.

   Marcador estável [GOOD-PAINEL]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';

module.exports = (async () => {
  /* só markup ATIVO: <script> ou <div> dentro de <!-- ... --> o navegador não carrega */
  /* 28/10: a tela velha da GOOD saiu — confere a TELA ÚNICA dela (a que a rota de verdade serve) */
  const tela = require('./_tela-empresa').lerTela('good-checkout-offline/dashboard.html')
    .replace(/<!--[\s\S]*?-->/g, '');
  const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));

  /* ⚠️ a lista BRUTA (com repetição) vem primeiro: o `new Set` que deduplica apagava justamente a
     evidência que a verificação de duplicata procura — ela passava sempre. */
  /* a tela única carrega as seções de dois jeitos: <script src> estático (a projeção do mês) e INJETADAS pelo carregador
     dela depois do montar() — o endereço literal (previsão, plano de compra) ou o par [id, nome] da lista */
  const srcsBrutos = [
    ...[...tela.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["'](\/good-checkout-offline\/js\/[^"']+)["']/gi)].map((m) => m[1].split('?')[0]),
    ...[...tela.matchAll(/\.src\s*=\s*['"](\/good-checkout-offline\/js\/[\w-]+\.js)/g)].map((m) => m[1]),
    ...[...tela.matchAll(/\[\s*'[A-Za-z]+Script'\s*,\s*'([\w-]+)'/g)].map((m) => '/good-checkout-offline/js/' + m[1] + '.js'),
  ];
  const srcs = [...new Set(srcsBrutos)];                 /* sem o ?v= de cache, que não faz parte da rota */
  assert.ok(srcs.length >= 4,
    '[GOOD-PAINEL] achei só ' + srcs.length + ' script(s) do painel na tela — o teste viraria ' +
    'decoração. As seções do painel vêm de peças compartilhadas e são várias.');

  const quebrados = [];
  const corpos = {};                                   /* script -> corpo servido, pra achar o espaço dele */
  for (const src of srcs) {
    const caminho = src;
    const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const u = new URL('http://x' + caminho);
    let tratou = false;
    try { tratou = await handler({ method: 'GET', url: u.pathname, headers: {} }, res, u); }
    catch (e) { tratou = 'erro: ' + String(e.message || e).slice(0, 50); }

    if (tratou !== true) { quebrados.push(caminho + ' — ninguém serve (401/404: guarda ou fábrica)'); continue; }
    if (res._s !== 200) { quebrados.push(caminho + ' — respondeu ' + res._s); continue; }
    corpos[caminho] = res._b;
    try { new Function(res._b); }
    catch (e) { quebrados.push(caminho + ' — não compila: ' + String(e.message).slice(0, 50)); continue; }
    /* 28/10: a seção que só DESENHA (a da Shopee: sem fetch, usa o MOD da página) não precisa do prefixo — o que não
       pode é rota de OUTRA loja, ou chamar rota sem o prefixo da GOOD e sem o MOD da página */
    const _outra = /\/(girassol-backup-offline|amb-checkout-offline)\//.test(res._b);
    const _chama = /fetch\(/.test(res._b);
    if (_outra || (_chama && !res._b.includes('/good-checkout-offline') && !/\bMOD\b/.test(res._b))) {
      quebrados.push(caminho + ' — servido SEM o prefixo da GOOD (chamaria as rotas de outra loja)');
    }
  }

  assert.deepStrictEqual(quebrados, [],
    '[GOOD-PAINEL] seções do painel que NÃO abrem:\n  ' + quebrados.join('\n  ') +
    '\nCada seção precisa das três pontas: <script src> na tela, liberação na guarda de sessão e ' +
    'a fábrica servindo o script. Faltando uma, a seção some sem erro visível.');

  /* ⚠️ ── NENHUMA PEÇA PODE SER CARREGADA DUAS VEZES ───────────────────────────────────
     Achado em 05/10: `plano-compra`, `ferramentas-custo` e `devolucoes-ml` estavam DUPLICADOS na
     tela (linhas 1168-1177). Cada peça desenha a seção ao carregar; carregada duas vezes, ela
     desenha por cima da anterior — e as duas ficam ouvindo o mesmo clique. O dono veria a seção
     recarregar sozinha, ou dois pedidos iguais saindo a cada botão.
     Veio de junções sucessivas: cada PR acrescentou seu `<script src>` sem ver que outro já
     tinha posto o mesmo. */
  {
    const nomes = srcsBrutos;
    const repetidos = [...new Set(nomes.filter((n, i) => nomes.indexOf(n) !== i))];
    assert.deepStrictEqual(repetidos, [],
      '[GOOD-PAINEL] estas peças estão incluídas MAIS DE UMA VEZ na tela: ' + repetidos.join(', ') +
      ' — cada uma desenha a seção ao carregar, então a segunda desenha por cima da primeira e as ' +
      'duas ouvem o mesmo clique (dois pedidos por botão). Costuma vir de junção: cada PR ' +
      'acrescenta seu script sem ver que outro já pôs o mesmo.');
  }

  /* ⚠️ ── O BURACO QUE ESTE BLOCO FECHA ────────────────────────────────────────────────
     Ler os scripts DA TELA tem um ponto cego: se alguém apagar um `<script src>`, o teste
     simplesmente não o vê e continua verde — a seção some do painel sem nada acusar. Provei:
     removendo o script da ficha do produto, as outras 8 passavam.
     Então o outro lado também é exigido: toda peça `painel-*.js` que a FÁBRICA serve precisa
     estar incluída na tela da GOOD. A fonte da verdade passa a ser o repositório, não o HTML. */
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  /* qualquer literal '/js/x.js' da fábrica — não depende de como a comparação do `p` é escrita */
  const servidos = [...new Set([...fab.matchAll(/['"](\/js\/[\w-]+\.js)['"]/g)].map((m) => m[1]))];
  assert.ok(servidos.length >= 4,
    '[GOOD-PAINEL] li só ' + servidos.length + ' script(s) servidos pela fábrica — teste virou decoração');

  /* ⚠️ 09/10 — peça que a fábrica serve CONDICIONADA à empresa não vale como obrigatória aqui.
     As despesas da Shopee só existem na AMB e na Girassol; a rota é `&& EMPRESA !== 'good'`. Sem
     esta leitura, o teste exigiria da GOOD uma seção que ela não tem — e a saída seria eu
     inventar markup morto só pra deixar verde, que é pior que o problema. */
  const soOutras = new Set(
    [...fab.matchAll(/\(PREFIXO \+ '(\/js\/[\w-]+\.js)'\)\s*&&\s*EMPRESA !== 'good'/g)].map((m) => m[1]));
  const foraDaTela = servidos
    .filter((js) => !soOutras.has(js))
    .filter((js) => !srcs.includes('/good-checkout-offline' + js));
  assert.deepStrictEqual(foraDaTela, [],
    '[GOOD-PAINEL] a fábrica serve estas peças e a tela da GOOD NÃO as inclui: ' + foraDaTela.join(', ') +
    ' — a seção existe no servidor e não aparece pro dono, sem erro nenhum. É a GOOD ficando pra ' +
    'trás das outras lojas, que é o que o multiloja existe pra evitar.');

  /* ⚠️ e cada script precisa do seu ESPAÇO na tela: sem o <div id=...Aqui>, a peça carrega,
     não encontra onde desenhar e sai calada — seção invisível com tudo "funcionando". */
  const semEspaco = [];
  for (const src of srcs) {
    const ids = [...new Set([...(corpos[src] || '').matchAll(/getElementById\(\s*['"](\w+Aqui)['"]\s*\)/g)].map((m) => m[1]))];
    /* 28/10: a seção da Shopee é uma PONTE — a peça só se registra (window.pecaDespesasShopee) e a tela única desenha no
       card dela (#shpCards); confere que a tela chama a ponte e tem o card */
    if (!ids.length && /window\.pecaDespesasShopee\s*=/.test(corpos[src] || '')) {
      if (!/window\.pecaDespesasShopee/.test(tela) || !/id=\\?["']shpCards\\?["']/.test(tela)) semEspaco.push(src + ' — a tela não usa a ponte da Shopee ou não tem o card #shpCards');
      continue;
    }
    if (!ids.length) { semEspaco.push(src + ' — não achei qual <div id="...Aqui"> ela usa'); continue; }
    for (const id of ids) {
      if (!new RegExp('<[a-z0-9]+\\b[^>]*\\bid\\s*=\\s*["\']' + id + '["\']', 'i').test(tela)) {
        semEspaco.push(src + ' — falta <div id="' + id + '"> na tela');
      }
    }
  }
  assert.deepStrictEqual(semEspaco, [],
    '[GOOD-PAINEL] peça sem o seu espaço na tela (carrega, não acha onde desenhar e sai calada):\n  ' + semEspaco.join('\n  '));

  /* ⚠️ ── AS SEÇÕES NATIVAS TAMBÉM (buraco do meu próprio teste) ───────────────────────
     O teste cobria só as peças compartilhadas, descobertas pelos `<script src>`. As três nativas
     — Alíquotas do Simples, Análise de Vendas e Top 15 produtos — não tinham asserção NENHUMA:
     qualquer uma podia sumir da tela sem o teste ficar vermelho. O próprio documento do painel
     registrava isso como gap conhecido; aqui ele fecha.

     A asserção é sobre funcionamento, não sobre texto: cada seção precisa de TODOS os elementos
     que o código dela usa (o título pode ficar e o resto sumir) E de TODAS as rotas que ela
     consome respondendo bem. */
  {
    /* `ids`: o que o JS da seção lê/escreve; `rotas`: tudo que precisa responder pra ela encher.
       Análise de Vendas é GATEADA por /historico-longo (carregar() retorna antes de chamar
       /historico-linhas se ele falha) e o Top 15 é desenhado em #quebras com esse mesmo dado. */
    /* 28/10: as seções nativas da TELA ÚNICA (a velha tinha outros ids) — as mesmas três, com as mesmas rotas */
    const NATIVAS = [
      { titulo: 'Análise de Vendas', ids: ['secAnalise', 'anCards', 'anResumo'],
        rotas: ['/historico-longo?de=2026-09-01&ate=2026-09-30', '/historico-linhas?de=2026-09-01&ate=2026-09-30&pagina=1'] },
      { titulo: 'Impostos e Taxas', ids: ['secCfg', 'cfgBox'], rotas: ['/config-fiscal'] },
      { titulo: 'Buscar Pedido e Lucro', ids: ['secBusca', 'buscaRes'], rotas: ['/buscar-lucro?q=teste'] },
    ];
    const temId = (id) => new RegExp('<[a-z0-9]+\\b[^>]*\\bid\\s*=\\s*\\\\?["\']' + id + '\\\\?["\']', 'i').test(tela);   /* 28/10: o montar() da tela única monta por innerHTML (aspa escapada) */

    const semBloco = NATIVAS.map((n) => {
      const falta = [...(tela.includes(n.titulo) ? [] : ['título']), ...n.ids.filter((id) => !temId(id)).map((id) => '#' + id)];
      return falta.length ? n.titulo + ' (falta ' + falta.join(', ') + ')' : null;
    }).filter(Boolean);
    assert.deepStrictEqual(semBloco, [],
      '[GOOD-PAINEL] seções NATIVAS incompletas na tela: ' + semBloco.join('; ') +
      ' — elas não vêm de peça compartilhada, então nada mais as cobre.');

    const mudas = [];
    for (const n of NATIVAS) for (const rota of n.rotas) {
      const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._fim = true; this._b = String(b || ''); } };
      const u = new URL('http://x/good-checkout-offline' + rota +
        (rota.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(process.env.ADMIN_KEY));
      let tratou = false;
      try { tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); }
      catch (e) { tratou = 'erro: ' + String(e.message || e).slice(0, 50); }
      /* ⚠️ ter handler não basta: rota que responde 500 por erro de runtime deixa a seção vazia
         igual. Aceito só (a) 200 com ok:true ou (b) o 500 ESPERADO aqui — "Supabase não
         configurado" (no ar ele existe). Qualquer outro status/corpo é falha. */
      let corpo = null;
      try { corpo = JSON.parse(res._b); } catch (e) { corpo = null; }
      const ok200 = res._s === 200 && !!corpo && corpo.ok === true;
      const semSupabase = res._s === 500 && !!corpo && corpo.ok === false && corpo.erro === 'Supabase não configurado';
      if (tratou !== true || !res._fim || !(ok200 || semSupabase)) {
        mudas.push(n.titulo + ' (' + rota.split('?')[0] + ': ' + (tratou === true ? res._s + ' ' + res._b.slice(0, 60) : tratou) + ')');
      }
    }
    assert.deepStrictEqual(mudas, [],
      '[GOOD-PAINEL] seções NATIVAS cuja rota não responde direito: ' + mudas.join(', ') +
      ' — a seção aparece na tela e fica vazia, sem erro visível pro dono.');
  }

  console.log('OK: as ' + srcs.length + ' secoes do painel da GOOD sao servidas, compilam e tem espaco na tela');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
