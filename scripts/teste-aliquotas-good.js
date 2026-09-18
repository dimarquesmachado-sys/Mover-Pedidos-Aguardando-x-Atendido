'use strict';
/* 17/09/2026 — as alíquotas do Simples da GOOD Import de 2026, informadas pelo dono como
   APURADAS e fechadas. Até hoje a tabela de fallback dela ficava vazia de propósito (chutar
   alíquota seria inventar imposto) e o cálculo caía no padrão de 15% — a auditoria listava
   isso como aproximação a confirmar.

   Este teste guarda os valores contra digitação errada e contra a tabela voltar a ficar vazia.
   Alíquota errada não quebra nada: ela só faz a margem sair errada na tela, com um número
   plausível. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ESPERADO = {
  '2026-01': 11.819396,
  '2026-02': 12.7287,
  '2026-03': 13.2889,
  '2026-04': 14.2829,
  '2026-05': 14.8073,
  '2026-06': 15.0707,
  '2026-07': 15.03,
  '2026-08': 14.9946,
};

const s = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline/index.js'), 'utf8');
const bloco = /const DEFAULT_ALIQ_BK_GOOD = \{[\s\S]*?\n\};/.exec(s);
assert.ok(bloco, 'não achei a tabela de alíquotas da GOOD');

const tabela = eval('(' + bloco[0].replace('const DEFAULT_ALIQ_BK_GOOD = ', '').replace(/;$/, '') + ')');

for (const [mes, valor] of Object.entries(ESPERADO)) {
  assert.strictEqual(tabela[mes], valor,
    'alíquota de ' + mes + ': esperado ' + valor + '%, está ' + tabela[mes] + '% — ' +
    'alíquota errada não quebra nada, só faz a margem sair errada com um número plausível');
}

/* 18/09 — A LISTA CRAVADA ESTAVA ERRADA e o próprio teste mostrou: eu tinha escrito
   ['2026-08', ..., '2026-12'] como "meses que não podem ter alíquota", e agosto FECHOU. A
   lista envelhece a cada mês apurado, e o teste passaria a reprovar dado legítimo — guarda que
   acusa o certo ensina a ignorar o vermelho.

   A regra de verdade não é sobre meses nomeados: é que mês que AINDA NÃO FECHOU não pode ter
   alíquota, porque apurar exige o mês terminado. Escrita assim, ela vale sozinha no ano que
   vem. */
{
  /* mês fecha pelo relógio de São Paulo, não pelo UTC: nas últimas 3h de cada mês em BRT
     (21h–23h59), o UTC já virou o mês seguinte, e getUTCMonth() liberaria um valor estimado
     pro mês local ainda em aberto — o dashboard usa o mesmo fuso pra essa conta. */
  const mesCorrente = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  for (const mes of Object.keys(tabela)) {
    assert.ok(mes < mesCorrente,
      'a tabela tem alíquota para ' + mes + ', que ainda não fechou — imposto estimado vira ' +
      'número errado na tela, e número errado é pior que número ausente');
  }
}

/* A PRECEDÊNCIA vive na lib do histórico, não no módulo — minha primeira versão deste teste
   procurou no arquivo errado e reprovou o código certo. Aqui ela é exercitada como o código
   faz: painel primeiro, tabela só quando o painel não tem valor para o mês. */
{
  const hist = fs.readFileSync(path.join(__dirname, '..', 'lib/checkout/historico.js'), 'utf8');
  const m = /const _aliqR = mes => \{[\s\S]*?: null; \};/.exec(hist);
  assert.ok(m, 'não achei a função que decide a alíquota do mês na lib do histórico');

  const _aliqR = new Function('_cfgR', 'DEFAULT_ALIQ_BK',
    m[0].replace('const _aliqR = ', 'return ') + '');

  const escolher = (painel, tabela) => _aliqR({ aliquotas: painel }, tabela);

  /* painel ganha da tabela */
  assert.strictEqual(escolher({ '2026-03': 9.5 }, tabela)('2026-03'), 9.5,
    'a alíquota salva no painel tem que vencer a tabela de fallback');

  /* sem painel, usa a tabela — que agora tem o valor apurado */
  assert.strictEqual(escolher({}, tabela)('2026-03'), 13.2889,
    'sem valor no painel, o cálculo tem que usar a alíquota apurada');

  /* mês não apurado: nem painel nem tabela → null, e o chamador cai no padrão.
     Tabela sintética isolada (não a "tabela" real, que ganha um mês novo a cada apuração) —
     senão este teste voltaria a ficar preso a um mês fixo que um dia é apurado de verdade. */
  assert.strictEqual(escolher({}, { '2026-03': 13.2889 })('2099-12'), null,
    'mês sem alíquota apurada tem que devolver null em vez de inventar um número');

  /* 0% no painel é campo em branco gravado por engano, não alíquota (regra de 19/08) */
  assert.strictEqual(escolher({ '2026-03': 0 }, tabela)('2026-03'), 13.2889,
    '0% no painel é campo em branco — tem que cair na tabela, não zerar o imposto');
}

/* Codex #499 (P1) — O BACKFILL TAMBÉM PRECISA DA TABELA CERTA. A rota de backfill de vendas
   da GOOD chama a função da Girassol passando um contexto; a tabela de alíquotas era a do
   módulo da GIRASSOL, fixa. Rodando pra GOOD, o backfill gravaria o imposto da Girassol nos
   pedidos dela — e as tabelas são diferentes de verdade (janeiro: 11,41% × 11,82%).
   Imposto de outra empresa entrando no histórico, sem erro nenhum. */
{
  const gbo = fs.readFileSync(path.join(__dirname, '..', 'girassol-backup-offline/gbo-app.js'), 'utf8');

  /* a função tem que usar a tabela do CONTEXTO, caindo na própria só quando ninguém passou */
  assert.ok(/_ctx && _ctx\.DEFAULT_ALIQ_BK \? _ctx\.DEFAULT_ALIQ_BK : DEFAULT_ALIQ_BK/.test(gbo),
    'o backfill não aceita a tabela de alíquotas de quem chamou — aplicaria a da Girassol em outra empresa');
  assert.ok(!/\(DEFAULT_ALIQ_BK\[mes\]!=null\?DEFAULT_ALIQ_BK\[mes\]:15\)/.test(gbo),
    'o cálculo ainda lê a tabela do módulo direto, ignorando o contexto');

  /* e a GOOD tem que passar a dela */
  const idx = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline/index.js'), 'utf8');
  const ctx = /const ctxGood = \{[\s\S]*?\n        \};/.exec(idx);
  assert.ok(ctx, 'não achei o ctxGood do backfill');
  assert.ok(/DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD/.test(ctx[0]),
    'o ctxGood não passa a tabela da GOOD — o backfill usaria a da Girassol');

  /* as duas tabelas PRECISAM ser diferentes: se alguém as igualar, o teste acima vira decorativo */
  const gTab = eval('(' + /const DEFAULT_ALIQ_BK = (\{[^}]*\})/.exec(gbo)[1] + ')');
  assert.notStrictEqual(gTab['2026-01'], tabela['2026-01'],
    'as alíquotas de janeiro da Girassol e da GOOD ficaram iguais — conferir, porque são empresas com faturamentos diferentes');
}

console.log('OK: alíquotas da GOOD — os meses apurados conferem, nenhum mês em aberto tem valor, e o painel mantém precedência');
