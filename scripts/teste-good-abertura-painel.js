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

/* Codex #557 (P2): mês COM VENDA ≠ mês COBERTO. Mês legítimo sem venda viraria "buraco"; e a
   falha típica do backfill é parar no primeiro mês ruim, deixando um PREFIXO contíguo — aí não
   há buraco no meio e o aviso ESCONDIA a falha de verdade. Agora pergunta ao backfill. */
/* 29/10: na TELA ÚNICA o aviso diz em que meses do ano HÁ venda no histórico (fato), e não acusa o backfill de nada —
   então a armadilha do #557 (mês sem venda tomado por mês não importado) não existe: nada é afirmado sobre cobertura */
assert.ok(/backfill-status/.test(js) || (/function avisarOndeTemDado\(\)/.test(js) && /'-01-01&ate='\+ano\+'-12-31'/.test(js) && !/backfill n[ãa]o cobriu/.test(js)),
  'o aviso voltou a adivinhar a cobertura pelas vendas em vez de perguntar ao backfill');
/* 29/10: o aviso da TELA ÚNICA, rodando a função DE PRODUÇÃO (recortada da tela) com DOM e fetch de mentira:
   · o histórico do ano responde → diz em que meses HÁ venda;
   · a busca falha → fica calado ("não sei" não vira afirmação nenhuma);
   · trocou pra um período de OUTRO ano durante a busca → a resposta velha não é escrita. */
{
  const m = /let _ondeTemDado = null;\nasync function avisarOndeTemDado\(\)\{[\s\S]*?\n\}/.exec(js);
  assert.ok(m, 'não achei o aviso de onde tem dado na tela');
  const montar = (fetchFake, ivFn) => {
    const el = { innerHTML: '' };
    const doc = { getElementById: (id) => (id === 'ondeTemDado' ? el : null) };
    const fn = new Function('document', 'fetch', 'intervalo', 'MOD', 'esc', m[0] + '; return avisarOndeTemDado;')(doc, fetchFake, ivFn, '/good-checkout-offline', (x) => String(x));
    return { el, fn };
  };
  (async () => {
    const r1 = montar(async () => ({ json: async () => ({ ok: true, dias: { '2026-03-02': {}, '2026-05-10': {}, '2026-05-11': {} } }) }), () => ({ de: '2026-10-29' }));
    await r1.fn();
    assert.ok(/03\/2026, 05\/2026/.test(r1.el.innerHTML), 'o aviso não disse em que meses há venda: ' + r1.el.innerHTML);
    const r2 = montar(async () => { throw new Error('rede'); }, () => ({ de: '2026-10-29' }));
    await r2.fn();
    assert.strictEqual(r2.el.innerHTML, '', 'sem resposta o aviso precisa ficar calado — "não sei" não pode virar afirmação');
    let ano = '2026';
    const r3 = montar(async () => { ano = '2025'; return { json: async () => ({ ok: true, dias: { '2026-03-02': {} } }) }; }, () => ({ de: ano + '-06-01' }));
    await r3.fn();
    assert.strictEqual(r3.el.innerHTML, '', 'a resposta do ano anterior foi escrita no período novo');
    console.log('OK: painel da GOOD (tela única) abre no DIA; período vazio diz onde há venda, calado quando não sabe');
  })().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
}
