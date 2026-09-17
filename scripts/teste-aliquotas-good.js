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

/* agosto em diante NÃO pode estar preenchido: o mês que ainda não fechou não tem alíquota
   apurada, e estimá-lo é exatamente o erro que a tabela vazia evitava */
for (const mes of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) {
  assert.ok(tabela[mes] === undefined,
    mes + ' está preenchido, mas não foi apurado — estimar o mês que não fechou é inventar imposto');
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

  /* mês não apurado: nem painel nem tabela → null, e o chamador cai no padrão */
  assert.strictEqual(escolher({}, tabela)('2026-09'), null,
    'mês sem alíquota apurada tem que devolver null em vez de inventar um número');

  /* 0% no painel é campo em branco gravado por engano, não alíquota (regra de 19/08) */
  assert.strictEqual(escolher({ '2026-03': 0 }, tabela)('2026-03'), 13.2889,
    '0% no painel é campo em branco — tem que cair na tabela, não zerar o imposto');
}

console.log('OK: alíquotas da GOOD — os 7 meses apurados conferem, agosto+ segue sem valor, e o painel mantém precedência');
