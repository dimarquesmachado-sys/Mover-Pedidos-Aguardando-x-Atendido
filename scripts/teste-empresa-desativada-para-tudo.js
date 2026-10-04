/* 04/10 — DESATIVAR UMA EMPRESA NÃO PARAVA TODO O TRABALHO DELA.

   Achado D da auditoria do Codex. Três caminhos escapavam do `SKIP_EMPRESAS`:

   1. empresa DECLARATIVA (sem pasta) — montada em `extras` ANTES do filtro e concatenada
      depois, então `SKIP_EMPRESAS=quarta` não a desligava. É justamente a forma que a empresa
      NOVA vai ter;
   2. a RETOMADA do ML Full varria o mapa inteiro: com checkpoint interrompido da GOOD e
      `SKIP_EMPRESAS=good`, ela pegava o batch e o concluía — chamando o ML em nome de uma loja
      desativada;
   3. a COLETA DIÁRIA usa `lib/empresas.lista()`, que lia só `EMPRESAS` e IGNORAVA o
      `SKIP_EMPRESAS` — ia ao marketplace pela empresa desligada.

   POR QUE ISSO IMPORTA MAIS QUE PARECE: desligar uma empresa é o ROLLBACK de quando algo dá
   errado. Plugar um CNPJ novo sem poder desligá-lo com segurança é entrar sem saída de
   emergência. Era o que travava a quarta empresa.

   ⚠️ E o `SKIP` tem que valer pro ALIAS e pro ID CANÔNICO (`amb` e `ambtotal`) — era o achado E
   da mesma auditoria: a env documentada usa `amb`, a lista interna usa `ambtotal`.

   Marcador estável [DESATIVADA]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');

function listaCom(empresas, skip) {
  delete require.cache[require.resolve(path.join(raiz, 'lib', 'empresas.js'))];
  const antes = { e: process.env.EMPRESAS, s: process.env.SKIP_EMPRESAS };
  process.env.EMPRESAS = empresas;
  if (skip == null) delete process.env.SKIP_EMPRESAS; else process.env.SKIP_EMPRESAS = skip;
  try {
    return require(path.join(raiz, 'lib', 'empresas.js')).lista();
  } finally {
    if (antes.e == null) delete process.env.EMPRESAS; else process.env.EMPRESAS = antes.e;
    if (antes.s == null) delete process.env.SKIP_EMPRESAS; else process.env.SKIP_EMPRESAS = antes.s;
  }
}

/* ── 1) a lista que as coletas usam respeita o SKIP ───────────────────────────────── */
{
  const todas = listaCom('girassol,good,amb', null);
  assert.deepStrictEqual(todas, ['girassol', 'good', 'amb'],
    '[DESATIVADA] sem SKIP, a lista mudou: ' + JSON.stringify(todas));

  const semGood = listaCom('girassol,good,amb', 'good');
  assert.ok(!semGood.includes('good'),
    '[DESATIVADA] `SKIP_EMPRESAS=good` e a lista AINDA traz a GOOD → ' + JSON.stringify(semGood) +
    '. A coleta diária chamaria o marketplace em nome de uma loja desativada.');
  assert.ok(semGood.includes('girassol') && semGood.includes('amb'),
    '[DESATIVADA] desligar a GOOD derrubou outra empresa junto → ' + JSON.stringify(semGood));

  /* ⚠️ ALIAS e ID CANÔNICO precisam desligar a MESMA empresa (achado E) */
  for (const nome of ['amb', 'ambtotal']) {
    const r = listaCom('girassol,good,amb', nome);
    assert.ok(!r.includes('amb') && !r.includes('ambtotal'),
      '[DESATIVADA] `SKIP_EMPRESAS=' + nome + '` não desligou a AMB → ' + JSON.stringify(r) +
      '. A env documentada usa um nome e a lista interna usa o outro: os dois têm que valer.');
  }
}

/* ── 2) a empresa SEM PASTA (declarativa) também é desligada ──────────────────────── */
{
  const fonte = require('fs').readFileSync(path.join(raiz, 'config', 'empresas.js'), 'utf8');
  const iExtras = fonte.indexOf('extras.push(montarEmpresa(');
  assert.ok(iExtras > 0, '[DESATIVADA] não achei a montagem das empresas sem pasta');

  const bloco = fonte.slice(Math.max(0, iExtras - 1200), iExtras);
  assert.ok(/SKIP\.has\(e\.id\)/.test(bloco),
    '[DESATIVADA] a empresa DECLARATIVA (sem pasta) é montada sem consultar o SKIP — e é ' +
    'justamente a forma que a empresa NOVA vai ter. Sem isto, não há rollback ao plugar um CNPJ.');
}

/* ── 3) a retomada do ML Full não reativa empresa desligada ───────────────────────── */
{
  const fonte = require('fs').readFileSync(path.join(raiz, 'ml-full.js'), 'utf8');
  const i = fonte.indexOf('function retomarSeriesInterrompidas');
  assert.ok(i > 0, '[DESATIVADA] não achei a retomada do ML Full');
  const corpo = fonte.slice(i, i + 2000);

  assert.ok(/require\('\.\/lib\/empresas'\)\.lista\(\)/.test(corpo),
    '[DESATIVADA] a retomada do ML Full não consulta as empresas ATIVAS — com checkpoint ' +
    'interrompido, ela conclui o batch de uma loja que o deploy desativou');

  /* ⚠️ e o checkpoint da empresa pulada NÃO pode ser apagado: ao reativar, retoma de onde parou */
  assert.ok(/checkpoint preservado/.test(corpo),
    '[DESATIVADA] a retomada pula a empresa desativada mas não deixa claro que PRESERVA o ' +
    'checkpoint — apagar o progresso transformaria "desligar" em "perder trabalho"');
}

console.log('OK: desativar uma empresa para a coleta, a empresa sem pasta e a retomada do ML Full');
