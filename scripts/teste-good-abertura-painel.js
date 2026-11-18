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

const html = require('./_tela-empresa').lerTela('good-checkout-offline/dashboard.html');   /* 29/10: a tela única da GOOD (a velha saiu) */
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new Function(js);

/* 1) abre no DIA, como a Girassol */
/* ⚠️ A CHAVE DA GOOD É 'hoje', NÃO 'dia' — o Codex pegou (#557 P2) e o teste tinha o mesmo
   erro que o código: eu copiei o nome da Girassol sem conferir o produtor DESTA tela.
   `janela('dia')` até cai nas datas de hoje por acaso, mas `pintarPeriodos()` acende o botão
   comparando a chave com PERIODO: com 'dia' a tela abriria com NENHUM botão aceso. */
/* 29/10: a GOOD usa a TELA ÚNICA (a tela velha saiu) — lá a chave do dia é 'dia' e é com ela que a tela abre */
assert.ok(/let PERIODO = 'hoje'/.test(js) || /let periodo = 'dia', pDe = '', pAte = '';/.test(js),
  'o painel da GOOD voltou a abrir no MÊS — a Girassol abre no dia por pedido do dono');
/* e a chave tem que EXISTIR na lista de períodos, senão nenhum botão acende */
const chaves = [...js.matchAll(/\['(\w+)','[^']+'\]/g)].map(m => m[1]);
assert.ok(chaves.includes('hoje') || (/let periodo = 'dia'/.test(js) && chaves.includes('dia')),   /* na tela única a chave é 'dia' */
  'a chave inicial não está na lista de períodos — a tela abre sem botão aceso');

/* e a Girassol não pode ter mudado junto, senão a paridade quebra pro outro lado */
const gir = require('./_tela-empresa').telaDaEmpresa('girassol');
assert.ok(/let periodo = 'dia'/.test(gir), 'a Girassol deixou de abrir no dia');

/* 2) o aviso só acusa o backfill quando há BURACO de verdade */
assert.ok(!/ainda não cobriu os outros meses/.test(js),
  'voltou o texto que afirma falha do backfill só por o período escolhido estar vazio');

/* 18/11 — O PERÍODO VAZIO MOSTRA SÓ O SELO E AS DATAS (o dono, olhando "Hoje" de manhã cedo: "esse texto fica estranho
   no topo do dashboard. não me diz algo q me sirva e polui a tela"). Saíram a sugestão de trocar de período, o lembrete
   da busca de pedido e o "o histórico de AAAA tem venda em …" — este nasceu aqui (29/10, herdado da tela velha da GOOD:
   um período vazio fazia parecer que a GOOD não tinha venda nenhuma; antes ainda, Codex #557, era um aviso que adivinhava
   a cobertura do backfill). Esse risco hoje é do card Faturado no Ano, que mostra o ano inteiro em qualquer período.
   Rodando o trecho de PRODUÇÃO do topo (recortado da tela da GOOD): vazio → o selo e as datas, nada mais; e o card do
   ano segue nos cards de cima. */
{
  const ini = js.indexOf("$('cover').innerHTML = _semVenda ?");
  const fim = js.indexOf('\n  const kpi=', ini);
  assert.ok(ini > 0 && fim > ini, 'não achei o topo do período na tela');
  const el = { innerHTML: '' };
  new Function('$', '_semVenda', 'dBR', 'de', 'ate', js.slice(ini, fim))(() => el, true, (d) => d.split('-').reverse().join('/'), '2026-11-18', '2026-11-18');
  assert.strictEqual(el.innerHTML, '<span class="pill w covResumo" style="cursor:default">∅ sem vendas neste período</span><span class="dim covItem">18/11/2026 → 18/11/2026</span>',
    'o topo do período vazio voltou a ter texto além do selo e das datas: ' + el.innerHTML);
  assert.ok(!/avisarOndeTemDado|ondeTemDado|experimente <b>Ontem/.test(js), 'voltou o texto do período vazio no topo (ou o aviso de onde tem venda)');
  assert.ok(/\bfunction cardFatAno\(/.test(js) && /\+\s*cardFatAno\(/.test(js), 'o card Faturado no Ano saiu dos cards de cima — sem ele, período vazio volta a parecer "sem venda nenhuma"');
  console.log('OK: painel da GOOD (tela única) abre no DIA; período vazio mostra só o selo e as datas (o ano está no card do ano)');
}
