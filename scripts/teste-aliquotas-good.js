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

/* 18/09 — APURADO NÃO É O MESMO QUE "ESTÁ NA TABELA". O dono explicou o ritual: ele ESTIMA o
   mês, e por volta do dia 20 a contabilidade manda a apuração — é então que o número certo
   entra. As tabelas da AMB e da Girassol sempre tiveram os dois misturados (a AMB estima
   jul-dez pela curva do RBT12p; a Girassol deixava agosto em 15% de palpite), e só o
   comentário em prosa dizia qual era qual.

   A tela nova diz "apurada" ao lado de cada mês. Sem esta lista, ela chamaria ESTIMATIVA de
   apurada — e essa é a mentira mais cara que ela poderia contar: o dono deixa de conferir o
   DAS de um mês achando que já conferiu. */
for (const [emp, arq, lista] of [
  ['amb', 'amb-checkout-offline/index.js', 'DEFAULT_ALIQ_BK'],
  ['girassol', 'girassol-backup-offline/gbo-app.js', 'DEFAULT_ALIQ_BK'],
  ['good', 'good-checkout-offline/index.js', 'DEFAULT_ALIQ_BK_GOOD'],
]) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  assert.ok(/const ALIQ_APURADOS = \[/.test(s),
    emp + ': falta a lista de meses APURADOS — a tela chamaria estimativa de apurada');
  assert.ok(/apurados_meses: ALIQ_APURADOS/.test(s),
    emp + ': a rota /config-fiscal não devolve a lista — a tela não teria como distinguir');

  /* todo mês marcado como apurado precisa existir na tabela: marcar como apurado um mês sem
     valor seria prometer um dado que não está lá */
  const apurados = eval(/const ALIQ_APURADOS = (\[[^\]]*\])/.exec(s)[1]);
  const tab = eval('(' + new RegExp('const ' + lista + ' = (\\{[\\s\\S]*?\\n?\\});').exec(s)[1] + ')');
  for (const m of apurados) {
    assert.ok(tab[m] != null, emp + ': ' + m + ' está marcado como apurado mas não tem valor na tabela');
  }
}

/* e a tela precisa usar a lista, não a mera presença na tabela */
{
  const tela = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/jaApurados\.has\(k\)/.test(tela),
    'a tela decide "apurada" pela presença na tabela — estimativa apareceria como apurada');
  assert.ok(/ESTIMATIVA/.test(tela), 'a tela não avisa quando o valor é estimativa');
}

console.log('OK: alíquotas da GOOD — os 7 meses apurados conferem, agosto+ segue sem valor, e o painel mantém precedência');
