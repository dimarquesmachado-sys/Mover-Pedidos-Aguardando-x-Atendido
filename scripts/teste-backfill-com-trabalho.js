/* 04/10 — OS BACKFILLS QUEBRAVAM EXATAMENTE QUANDO HAVIA TRABALHO.

   Achado F da auditoria do Codex. `_bf` e `_bfd` são `const` em `lib/checkout/rotas-backfill.js`,
   e as rotas os REATRIBUÍAM. Com a lista de alvos vazia a rota retorna antes — por isso o teste
   existente ficava verde e ninguém via. Com UM pedido pendente, as duas rotas lançavam
   `TypeError: Assignment to constant variable` antes de responder ou de consultar o Bling.

   Ou seja: o backfill falhava justamente na hora em que serviria pra alguma coisa.

   ⚠️ E TROCAR `const` POR `let` NÃO RESOLVERIA. O objeto é a MESMA referência que o módulo da
   empresa guarda (`cfg.statusValores` / `cfg.statusDetalhes`): reatribuir cria um objeto NOVO, e
   quem lê o status pelo `cfg` fica com a referência velha — veria "parado" pra sempre, enquanto
   a rodada corre. Por isso o teste não confere só "não lançou": confere que o estado visto DE
   FORA muda junto.

   Marcador estável [BACKFILL-TRABALHO]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-backfill'));

/* o estado que o módulo da empresa guarda — a MESMA referência passada no cfg */
const statusValores = { rodando: false, feitos: 0, total: 0 };
const statusDetalhes = { rodando: false, feitos: 0, total: 0 };

/* um pedido conferido, SEM detalhe e SEM valor: dá trabalho pros dois backfills */
const CONFERIDOS = [{
  id: 42, numero: '123037', bling_id: 42,
  conferido_em: new Date().toISOString(),
  itens: [], valor_total: null, detalhado: false,
}];

function montar() {
  return criar({
    prefixo: '/teste', json: (res, s, b) => { res._s = s; res._b = b; },
    readJson: () => JSON.parse(JSON.stringify(CONFERIDOS)),
    writeJson: () => {},
    ehAdmin: () => true,
    lerChaveAdmin: () => process.env.ADMIN_KEY,
    detalhePedido: async () => ({ id: 42, itens: [{ sku: 'X', valor: 10 }], total: 10 }),
    backfillNFLocal: async () => ({ ok: true }),
    dorme: async () => {},
    CONFERIDOS_FILE: '/tmp/conferidos-teste.json',
    statusValores, statusDetalhes,
  });
}

async function chamar(handler, caminho) {
  const res = { _s: 0, _b: null };
  const u = new URL('http://x' + caminho);
  const tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u, 'GET');
  return { tratou, status: res._s, corpo: res._b };
}

module.exports = (async () => {
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-backfill';
  const handler = montar();

  for (const [nome, rota, estado] of [
    ['detalhes', '/teste/backfill-detalhes?dias=30&k=' + process.env.ADMIN_KEY, statusDetalhes],
    ['valores', '/teste/backfill-valores?dias=30&k=' + process.env.ADMIN_KEY, statusValores],
  ]) {
    let erro = null;
    let r = null;
    try { r = await chamar(handler, rota); } catch (e) { erro = e; }

    assert.ok(!erro,
      '[BACKFILL-TRABALHO] backfill de ' + nome + ' LANÇOU com trabalho de verdade: ' +
      (erro && erro.message) + '. Com a lista vazia a rota retorna antes — por isso isto passava ' +
      'despercebido e o backfill falhava justamente quando serviria.');

    assert.ok(r && r.tratou === true, '[BACKFILL-TRABALHO] ' + nome + ': a rota não tratou');
    assert.ok(r.corpo && r.corpo.ok === true,
      '[BACKFILL-TRABALHO] ' + nome + ': respondeu ok:false → ' + JSON.stringify(r.corpo).slice(0, 110));
    assert.strictEqual(r.corpo.iniciado, true,
      '[BACKFILL-TRABALHO] ' + nome + ': não anunciou início, com 1 alvo pendente → ' +
      JSON.stringify(r.corpo).slice(0, 110));

    /* ⚠️ O VÍNCULO: o estado que o MÓDULO DA EMPRESA guarda tem que ter mudado. Se a rota
       reatribuir (mesmo com `let`), este objeto fica intocado e o painel mostra "parado"
       enquanto a rodada corre. */
    assert.strictEqual(estado.total, 1,
      '[BACKFILL-TRABALHO] ' + nome + ': o estado compartilhado NÃO foi atualizado (total=' +
      estado.total + '). A rota reatribuiu em vez de mutar: quem lê o status pelo cfg ficou com ' +
      'a referência velha e veria "parado" durante a rodada inteira.');
  }

  console.log('OK: os backfills iniciam COM trabalho e atualizam o estado compartilhado');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
