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

   ⚠️ Só rotas de LEITURA/STATUS, e com `k` inválida de propósito em nada destrutivo: o objetivo
   é saber se ALGUÉM atende, não exercitar o Bling. Rotas que disparam trabalho ficam de fora por
   nome — cota do Bling é da conta, e um teste não pode comer a cota do galpão.

   Marcador estável [ROTA-MUDA]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-ci';

/* ⚠️ estas DISPARAM trabalho (sync, backfill, coleta) — chamar aqui gastaria cota do Bling */
const NAO_CHAMAR = new Set([
  'custo-diario', 'custo-sync', 'vendas-sync', 'ml-sync-fees', 'backfill', 'backfill-limpar',
  'backfill-teste', 'backfill-nf', 'reaplicar-status', 'ml-devolucoes-coletar', 'magalu-caca',
  'completar-detalhes', 'despachados-por-engano', 'setup-ml', 'ml-trocar-code',
]);

const EMPRESAS = [
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline'],
];

module.exports = (async () => {
  const fs = require('fs');
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  const servidas = [...fab.matchAll(/p === \(PREFIXO \+ '\/([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(servidas.length > 10, '[ROTA-MUDA] não li as rotas da fábrica — teste virou decoração');

  for (const [emp, arq, prefixo] of EMPRESAS) {
    delete require.cache[require.resolve(path.join(raiz, arq))];
    const mod = require(path.join(raiz, arq));
    if (typeof mod.routes !== 'function') continue;
    const handler = mod.routes(async () => ({}));

    const mudas = [];
    for (const rota of servidas) {
      if (NAO_CHAMAR.has(rota)) continue;
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      const u = new URL('http://x' + prefixo + '/' + rota + '?k=' + encodeURIComponent(process.env.ADMIN_KEY));
      let tratou = false;
      try { tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); }
      catch (e) { tratou = 'erro: ' + String(e.message || e).slice(0, 60); }
      if (tratou !== true) mudas.push(rota + ' (' + tratou + ')');
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
