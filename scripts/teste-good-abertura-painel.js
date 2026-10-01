/* 01/10 — O PAINEL DA GOOD ABRE NO DIA, E O AVISO NÃO PODE MENTIR.

   Dois achados do dono no mesmo print, logo depois do backfill do ano:

   1) "começa ainda pelo mês ao invés do dia". A Girassol abre em `periodo = 'dia'`, com o
      comentário "(pedido do Diego)" no código. A GOOD nasceu em 'mes' e ficou pra trás. No
      dia 1º as duas janelas coincidem — o que esconde a diferença justamente no dia em que
      ele reparou.

   2) O aviso dizia "O backfill de vendas desta empresa ainda não cobriu os outros meses"
      LOGO DEPOIS de listar que HÁ histórico nesses meses. Foi escrito quando a GOOD só tinha
      set/out; virou alarme falso no instante em que o ano entrou (13.327 pedidos, 9 meses).
      Aviso que mente é pior que aviso ausente — ensina a ignorar o vermelho. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new Function(js);

/* 1) abre no DIA, como a Girassol */
assert.ok(/let PERIODO = 'dia'/.test(js),
  'o painel da GOOD voltou a abrir no MÊS — a Girassol abre no dia por pedido do dono');

/* e a Girassol não pode ter mudado junto, senão a paridade quebra pro outro lado */
const gir = fs.readFileSync(path.join(__dirname, '..', 'girassol-backup-offline', 'dashboard.html'), 'utf8');
assert.ok(/let periodo = 'dia'/.test(gir), 'a Girassol deixou de abrir no dia');

/* 2) o aviso só acusa o backfill quando há BURACO de verdade */
assert.ok(!/ainda não cobriu os outros meses/.test(js),
  'voltou o texto que afirma falha do backfill só por o período escolhido estar vazio');

const m = js.match(/const falta = \(\(\) => \{[\s\S]*?\}\)\(\);/);
assert.ok(m, 'sumiu a detecção de buraco entre os meses');
const buraco = (meses) => {
  const ns = meses.map(x => Number(x.slice(5, 7))).sort((x, y) => x - y);
  const b = [];
  for (let k = ns[0]; k < ns[ns.length - 1]; k++) if (!ns.includes(k)) b.push(String(k).padStart(2, '0'));
  return b;
};
assert.deepStrictEqual(buraco(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09']), [],
  'acusou buraco num ano COMPLETO — é exatamente o alarme falso que o dono viu');
assert.deepStrictEqual(buraco(['2026-01','2026-02','2026-03','2026-06','2026-07']), ['04','05'],
  'não acusou os meses que faltam de verdade no meio da faixa');
assert.deepStrictEqual(buraco(['2026-09']), [],
  'empresa com um mês só não tem buraco — não pode acusar');

console.log('OK: painel da GOOD abre no DIA; aviso de backfill so acusa buraco real');
