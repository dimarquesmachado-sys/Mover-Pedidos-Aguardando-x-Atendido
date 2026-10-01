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
/* ⚠️ A CHAVE DA GOOD É 'hoje', NÃO 'dia' — o Codex pegou (#557 P2) e o teste tinha o mesmo
   erro que o código: eu copiei o nome da Girassol sem conferir o produtor DESTA tela.
   `janela('dia')` até cai nas datas de hoje por acaso, mas `pintarPeriodos()` acende o botão
   comparando a chave com PERIODO: com 'dia' a tela abriria com NENHUM botão aceso. */
assert.ok(/let PERIODO = 'hoje'/.test(js),
  'o painel da GOOD voltou a abrir no MÊS — a Girassol abre no dia por pedido do dono');
/* e a chave tem que EXISTIR na lista de períodos, senão nenhum botão acende */
const chaves = [...js.matchAll(/\['(\w+)','[^']+'\]/g)].map(m => m[1]);
assert.ok(chaves.includes('hoje'),
  'a chave inicial não está na lista de períodos — a tela abre sem botão aceso');

/* e a Girassol não pode ter mudado junto, senão a paridade quebra pro outro lado */
const gir = fs.readFileSync(path.join(__dirname, '..', 'girassol-backup-offline', 'dashboard.html'), 'utf8');
assert.ok(/let periodo = 'dia'/.test(gir), 'a Girassol deixou de abrir no dia');

/* 2) o aviso só acusa o backfill quando há BURACO de verdade */
assert.ok(!/ainda não cobriu os outros meses/.test(js),
  'voltou o texto que afirma falha do backfill só por o período escolhido estar vazio');

/* Codex #557 (P2): mês COM VENDA ≠ mês COBERTO. Mês legítimo sem venda viraria "buraco"; e a
   falha típica do backfill é parar no primeiro mês ruim, deixando um PREFIXO contíguo — aí não
   há buraco no meio e o aviso ESCONDIA a falha de verdade. Agora pergunta ao backfill. */
assert.ok(/backfill-status/.test(js),
  'o aviso voltou a adivinhar a cobertura pelas vendas em vez de perguntar ao backfill');
assert.ok(/catch \(e\) \{ falta = \[\]; \}/.test(js),
  'sem resposta do backfill o aviso precisa ficar calado — "não sei" não pode virar acusação');

/* Codex #557 (P2): o fetch do backfill-status é um 2º await — o período pode mudar nele.
   Tem que rechecar SEQ_CARDS DEPOIS dele (e antes de tocar em #avisos), e `falta` tem que
   chegar na tela (computar e não mostrar era o aviso que "conserta" sem consertar). */
const corpo = js.slice(js.indexOf('async function avisarOndeTemDado'));
const iStatus = corpo.indexOf("'/backfill-status'");
const iRecheck = corpo.indexOf('meu !== SEQ_CARDS', iStatus);
const iTela = corpo.indexOf('el.innerHTML =');
assert.ok(iStatus > 0 && iRecheck > iStatus && iRecheck < iTela,
  'falta rechecar SEQ_CARDS depois do fetch do backfill-status e antes de escrever o aviso');
assert.ok(/falta\.length \?/.test(corpo.slice(iTela)),
  'a cobertura que falta é calculada mas não aparece no aviso');

console.log('OK: painel da GOOD abre no DIA; aviso de backfill so acusa buraco real');
