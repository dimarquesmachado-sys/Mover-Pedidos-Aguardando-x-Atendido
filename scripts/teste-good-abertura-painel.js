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

/* 1) abre no DIA, como a Girassol — mas com a chave que a GOOD realmente usa pro botão "Hoje".
   pintarPeriodos() só acende o botão cuja chave === PERIODO (Codex P2): 'dia' não existe em
   PERIODOS e a tela abriria sem período ativo. */
const ini = js.match(/let PERIODO = '([^']+)'/);
assert.ok(ini, 'sumiu a inicialização de PERIODO');
assert.strictEqual(ini[1], 'hoje',
  'o painel da GOOD tem que abrir em "hoje" (o dia) — outra chave deixa a tela sem botão ativo');
const chaves = [...js.match(/const PERIODOS = \[([\s\S]*?)\n\];/)[1].matchAll(/\['([^']+)','/g)].map(x => x[1]);
assert.ok(chaves.includes(ini[1]), 'PERIODO inicial não é uma chave de PERIODOS');

/* e a Girassol não pode ter mudado junto, senão a paridade quebra pro outro lado */
const gir = fs.readFileSync(path.join(__dirname, '..', 'girassol-backup-offline', 'dashboard.html'), 'utf8');
assert.ok(/let periodo = 'dia'/.test(gir), 'a Girassol deixou de abrir no dia');

/* 2) o aviso NÃO infere falha de backfill a partir de meses com venda (Codex P2): mês sem
   venda não é mês não importado, e um backfill interrompido deixa prefixo contíguo */
assert.ok(!/ainda não cobriu os outros meses/.test(js),
  'voltou o texto que afirma falha do backfill só por o período escolhido estar vazio');
assert.ok(!/const falta = /.test(js) && !/o backfill não cobriu esses meses/.test(js),
  'voltou a inferência de buraco de backfill a partir dos meses com venda');

console.log('OK: painel da GOOD abre em "hoje"; aviso nao infere falha de backfill');
