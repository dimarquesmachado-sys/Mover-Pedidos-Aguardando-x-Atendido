/* 04/10 — AS ROTAS DO PAINEL PRECISAM RESPONDER DE VERDADE, NÃO SÓ EXISTIR NO TEXTO.

   Achado removendo cópias da AMB: apaguei três handlers e esqueci de tirar os nomes de
   `rotasProprias`. Resultado: a fábrica RECUSAVA (a empresa diz "essa rota é minha") e a cópia
   não existia mais — as três rotas simplesmente PARARAM DE RESPONDER.

   ⚠️ E A BATERIA INTEIRA PASSOU VERDE. Conferi: nenhum dos testes de rotas (`teste-rotas-*`,
   `teste-fabrica-rotas-painel`, `teste-paridade-rotas-dashboard`) CHAMA uma rota — todos
   comparam TEXTO. Uma rota morta era invisível, que é a mesma classe do PR #597 ("rota apagada
   passava no CI porque 404 < 500").

   Este teste MONTA o módulo de cada empresa e CHAMA cada rota que a fábrica serve, exigindo que
   alguém responda: a cópia da empresa ou a peça compartilhada, tanto faz — mas não o silêncio.

   ⚠️ Chamo com `k` INVÁLIDA de propósito (Codex #622): com a chave verdadeira, qualquer rota que
   dispara trabalho (varredura, reconciliação de marketplace, tarifa do TikTok) EXECUTARIA de
   verdade e comeria cota. O objetivo é saber se ALGUÉM atende — e a recusa de chave é uma
   resposta. Como a decisão "a rota é da empresa" vem ANTES da autenticação, rota órfã continua
   aparecendo. Por garantia, as que disparam trabalho também ficam de fora por nome.

   Exijo ainda que a resposta TERMINE (`end` chamado): handler que devolve `true` e esquece de
   responder deixa a requisição pendurada e o roteador externo para de despachar.

   Marcador estável [ROTA-MUDA]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';

/* ⚠️ LISTA DE PERMITIDAS, NÃO DE PROIBIDAS — e isso me custou duas tentativas erradas.

   1ª: listei 15 rotas "perigosas" de cabeça. Rodei e a Girassol DISPAROU uma varredura de
       cancelados e RENOVOU UM TOKEN DO BLING. O teste estava comendo cota da conta, que é o que
       a regra da casa proíbe — "a operação sempre perde primeiro".
   2ª: tentei DERIVAR o filtro do texto da fábrica. Não serve: `custo-diario` e
       `canario-marketplaces` aparecem como seguras ali, e eu VI as duas dispararem trabalho. O
       trabalho mora na PEÇA que a empresa passa, não no bloco da fábrica — o texto do bloco não
       pode responder isso.

   Então: só entram rotas de LEITURA/STATUS verificadas UMA A UMA, cada uma rodada em processo
   isolado conferindo que não aparece marcador de trabalho no log ([CUSTO], [CANCEL], [BACKFILL],
   tokenManager). Lista curta de propósito: o objetivo é pegar rota MUDA, e 8 rotas bastam pra
   isso. Rota nova só entra aqui depois da mesma verificação. */
const SEGURAS = [
  'custos-manuais',           /* página estática */
  'custo-historico',          /* lê cache; sem sku responde 400, e 400 é resposta */
  'varrer-cancelados-status', /* só estado */
  'varrer-fornecedores-status',
];

/* ⚠️ `backfill-conferir` SAIU (Codex #622): parecia leitura de cache, mas o handler chama `supaCount`
   no ano, em cada mês e em nove canais — dezenas de requisições reais ao Supabase por rodada, e o
   teste passaria a depender da rede de produção. Rota que fala com serviço externo não entra aqui.

   `custo-diario` também não entra (dispara a rotina de custo): a rota órfã dela só é pega pela
   checagem ESTÁTICA no laço abaixo — todo nome em `rotasProprias` precisa ter handler na empresa.

   ⚠️ `sku-depara-manual`, `ml-fatura-cartao` e `ml-billing-resumo` SAÍRAM da lista: elas
   responderam na AMB, mas vêm da CÓPIA da empresa — a fábrica não as serve. Pô-las aqui faria o
   teste afirmar algo sobre a peça compartilhada medindo a cópia, que é o engano que me custou um
   PR inteiro no #613. A guarda logo abaixo foi quem acusou. */

const EMPRESAS = [
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline'],
  /* ⚠️ a Girassol monta a fábrica igual às outras duas (33 rotas próprias) e eu tinha deixado
     ela de fora — justamente a maior das três em pedidos e faturamento. Teste multiloja que
     cobre 2 de 3 dá a sensação de cobertura sem ter. */
  ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
];

module.exports = (async () => {
  const fs = require('fs');
  /* a fábrica delega as rotas de ML a `rotas-painel-ml.js`: ler os dois (Codex #622) */
  const servidas = [];
  for (const arqFab of ['fabrica-rotas-painel.js', 'rotas-painel-ml.js']) {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', arqFab), 'utf8');
    for (const m of fab.matchAll(/p === \(PREFIXO \+ '\/([\w-]+)'\)/g)) {
      if (!servidas.includes(m[1])) servidas.push(m[1]);
    }
  }
  assert.ok(servidas.length > 10, '[ROTA-MUDA] não li as rotas da fábrica — teste virou decoração');

  /* ⚠️ toda rota da lista de seguras precisa EXISTIR na fábrica: se alguém renomear uma, a lista
     silenciosamente deixaria de testar aquilo e o teste viraria decoração sem avisar. */
  for (const r of SEGURAS) {
    assert.ok(servidas.includes(r),
      '[ROTA-MUDA] a rota segura "' + r + '" não está mais na fábrica — foi renomeada ou removida, ' +
      'e a lista precisa ser revista (senão o teste encolhe em silêncio)');
  }

  for (const [emp, arq, prefixo] of EMPRESAS) {
    delete require.cache[require.resolve(path.join(raiz, arq))];
    const mod = require(path.join(raiz, arq));
    if (typeof mod.routes !== 'function') continue;
    const handler = mod.routes(async () => ({}));

    /* checagem ESTÁTICA, sem executar nada (Codex #622): nome em `rotasProprias` sem handler local
       é rota órfã — a fábrica recusa e ninguém atende. Pega também as rotas que disparam trabalho
       e por isso não podem ser chamadas aqui (ex.: custo-diario na AMB). */
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const lista = fonte.match(/rotasProprias:\s*\[([^\]]*)\]/);
    const orfas = lista ? [...lista[1].matchAll(/'([\w-]+)'/g)].map(x => x[1])
      .filter(n => !fonte.includes("'" + prefixo + '/' + n + "'")) : [];
    assert.deepStrictEqual(orfas, [],
      '[ROTA-MUDA] ' + emp + ': `rotasProprias` lista rota SEM handler na empresa: ' + orfas.join(', ') +
      ' — a fábrica cede a vez e ninguém responde. Tire o nome da lista (a peça compartilhada atende).');

    const mudas = [];
    for (const rota of SEGURAS) {
      /* ⚠️ `_fim` veio do outro lado do merge e é melhor que o meu: `tratou === true` sem resposta
         enviada também é rota muda — ela diz "eu trato" e não responde nada. */
      const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._fim = true; this._b = String(b || ''); } };
      const u = new URL('http://x' + prefixo + '/' + rota + '?k=' + encodeURIComponent(process.env.ADMIN_KEY));
      let tratou = false;
      try { tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); }
      catch (e) { tratou = 'erro: ' + String(e.message || e).slice(0, 60); }
      if (tratou !== true) mudas.push(rota + ' (' + tratou + ')');
      else if (!res._fim) mudas.push(rota + ' (disse que trata e não respondeu nada)');
    }

    assert.deepStrictEqual(mudas, [],
      '[ROTA-MUDA] ' + emp + ': estas rotas do painel NÃO RESPONDEM — nem a cópia da empresa, nem ' +
      'a peça compartilhada: ' + mudas.join(', ') + '. Costuma ser handler removido sem tirar o ' +
      'nome de `rotasProprias`: a fábrica recusa porque "a rota é da empresa", e a empresa não ' +
      'tem mais. O painel mostra seção vazia e nada acusa.');
  }

  console.log('OK: toda rota do painel responde em alguem — copia da empresa ou peca compartilhada');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
