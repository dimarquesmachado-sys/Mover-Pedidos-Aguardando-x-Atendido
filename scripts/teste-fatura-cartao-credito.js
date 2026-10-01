/* 01/10 — O ESTORNO DE UMA COBRANÇA DO CARTÃO TEM QUE ABATER NO CARTÃO.

   O caso real, do raio-x da AMB em set/2026: 14 linhas de "Cancelamento da tarifa por campanha
   de Publicidade de Seguidores", R$ 322,33, TODAS marcadas pelo ML como descontadas na venda.
   Mas Ads não é cobrado na venda — só no cartão. O crédito não tinha onde abater e sumia: o
   painel cobrava a publicidade e nunca devolvia o estorno dela.

   ⚠️ A REGRA É ESTREITA DE PROPÓSITO, e o teste trava isso: só o crédito cuja categoria a
   empresa paga EXCLUSIVAMENTE no cartão. Estorno de frete, comissão, parcelamento ou Mercado
   Pago fica FORA, porque essas são descontadas no repasse e lá o estorno já abate — trazê-las
   pra cá descontaria duas vezes, e o painel passaria a mostrar menos que o débito real. */
const assert = require('assert');
const path = require('path');
const { faturas } = require(path.join(__dirname, '..', 'lib', 'ml-fatura-cartao'));

const agora = new Date().toISOString();
const doCiclo = (r, rotulo) => (r.faturas || []).find(f => f.rotulo === rotulo);

{
  const t = {
    a: { d: '2026-09-01', v: 5537.84, c: 'ads', cartao: true },
    /* o estorno de Ads: marcado como "na venda" pelo ML, mas Ads só existe no cartão */
    b: { d: '2026-09-02', v: -322.33, c: 'credito', a: 'ads', cartao: false },
    /* estes NÃO podem abater: são descontados na venda, onde o estorno já atua */
    c: { d: '2026-09-03', v: -1097.68, c: 'credito', a: 'frete', cartao: false },
    d: { d: '2026-09-04', v: -1056.33, c: 'credito', a: 'comissao', cartao: false },
    e: { d: '2026-09-05', v: -327.45, c: 'credito', a: 'parcelamento', cartao: false },
  };
  const f = doCiclo(faturas(t, { atualizado: agora, limite: 8 }), 'set/2026');
  assert.ok(f, 'o ciclo de setembro sumiu da fatura');

  assert.strictEqual(f.total, 5215.51,
    'o estorno de Ads não abateu no cartão — o painel cobra a publicidade e não devolve o ' +
    'cancelamento dela, ficando acima do débito real');

  /* e os três créditos de venda ficaram de fora: se entrassem, o total cairia pra ~2.734 */
  assert.ok(f.total > 5000,
    'estorno de frete/comissão/parcelamento entrou no cartão — essas são descontadas na venda, ' +
    'e abater duas vezes põe o painel ABAIXO do débito real');

  /* os DOIS números que o dono pediu */
  assert.strictEqual(f.cobrado, 5537.84, 'perdeu o "cobrado" — é o que o ML cobrou fora da venda');
  assert.strictEqual(f.estornado, -322.33, 'perdeu o "estornado" — é o que explica a diferença');
  assert.strictEqual(f.total, Math.round((f.cobrado + f.estornado) * 100) / 100,
    'o débito não é cobrado + estornado: os três números têm que fechar entre si');
}

/* sem estorno nenhum, o comportamento antigo segue intacto */
{
  const t = { a: { d: '2026-09-01', v: 100, c: 'ads', cartao: true } };
  const f = doCiclo(faturas(t, { atualizado: agora, limite: 8 }), 'set/2026');
  assert.strictEqual(f.total, 100, 'fatura sem estorno mudou de valor');
  assert.ok(!f.estornado, 'inventou estorno onde não há');
}

/* crédito SEM assunto conhecido não entra: "não sei de que é" não pode virar abatimento */
{
  const t = {
    a: { d: '2026-09-01', v: 500, c: 'ads', cartao: true },
    b: { d: '2026-09-02', v: -100, c: 'credito', cartao: false },
  };
  const f = doCiclo(faturas(t, { atualizado: agora, limite: 8 }), 'set/2026');
  assert.strictEqual(f.total, 500,
    'crédito sem assunto abateu no cartão — sem saber o que ele cancela, abater é chute');
}

/* e o card mostra os DOIS números nas DUAS empresas que têm fatura do cartão. A AMB é a
   empresa do caso que motivou tudo — deixá-la pra trás seria "vacilar com a cópia", que é o
   erro recorrente que a regra da casa nomeia. */
{
  const fs2 = require('fs');
  for (const arq of ['girassol-backup-offline/dashboard.html', 'amb-checkout-offline/amb-dashboard.html']) {
    const html = fs2.readFileSync(path.join(__dirname, '..', arq), 'utf8');
    assert.ok(/Fatura do cart/.test(html), arq + ': sumiu o card da fatura do cartão');
    assert.ok(/cobrado ' \+ BRL\(f\.cobrado \|\| 0\)/.test(html),
      arq + ': o card não mostra o COBRADO — sem ele a diferença contra o e-mail do débito ' +
      'fica sem explicação na tela');
    assert.ok(/estornado ' \+ BRL\(f\.estornado\)/.test(html),
      arq + ': o card não mostra o ESTORNADO');
    assert.ok(/f\.estornado && f\.estornado < 0/.test(html),
      arq + ': a linha aparece mesmo sem estorno — vira ruído em todo mês sem cancelamento');
  }
}

/* 01/10 — A CONTA FECHADA CONTRA A FATURA REAL. Cruzei a fatura oficial da AMB (set/2026) com
   o raio-x, e as três diferenças fecham na vírgula:

       painel          6.455,32
       − devolução      −207,98
       − estorno de Ads −322,33
       + Full faltando    +3,22
                      ──────────
                       5.928,23  = o débito que veio no e-mail

   A prova de que devolução não é do cartão não é só aritmética: a fatura do ML NÃO TEM linha
   "Devoluções" entre as tarifas — elas entram em "Tarifas de envios", descontadas na venda.

   ⚠️ E a COMISSÃO FICA. Era a outra candidata (as duas são "tarifa com pedido"), e tirá-la
   poria o painel ABAIXO do débito. Este teste trava as duas decisões juntas, porque é a
   distinção entre elas que a conta provou. */
{
  const t3 = {
    a: { d: '2026-09-01', v: 5537.84, c: 'ads', cartao: true },
    b: { d: '2026-09-02', v: 585.77, c: 'full', cartao: true },
    c: { d: '2026-09-03', v: 207.98, c: 'devolucao', cartao: true, o: '200001' },
    d: { d: '2026-09-04', v: 24.73, c: 'comissao', cartao: true, o: '200002' },
    e: { d: '2026-09-05', v: 99.00, c: 'assinatura', cartao: true },
    f: { d: '2026-09-06', v: -322.33, c: 'credito', a: 'ads', cartao: false },
  };
  const f3 = doCiclo(faturas(t3, { atualizado: agora, limite: 8 }), 'set/2026');

  assert.strictEqual(f3.total, 5925.01,
    'o painel saiu de 5.925,01 — que é o débito real (5.928,23) menos os R$ 3,22 de Full que a ' +
    'fatura tem a mais e que ainda não sei de onde vêm');

  /* a quebra vem em `composicao` (lista), lida da própria lib — não supus o formato */
  const porCat = {};
  for (const c of (f3.composicao || [])) porCat[c.categoria] = c.valor;

  /* devolução fora: a fatura não tem essa linha entre as tarifas do cartão */
  assert.ok(!porCat.devolucao,
    'devolução voltou pro cartão — o ML a marca como cartão, mas a fatura a cobra como envio');

  /* comissão DENTRO: tirar as duas por "parecerem o mesmo caso" poria o painel abaixo do débito */
  assert.strictEqual(porCat.comissao, 24.73,
    'a comissão saiu do cartão junto com a devolução — a conta contra a fatura real mostra que ' +
    'ela FICA, e tirá-la põe o painel abaixo do débito');
}

console.log('OK: estorno de categoria so-do-cartao abate; estorno de venda nao; cobrado + estornado = debito');
