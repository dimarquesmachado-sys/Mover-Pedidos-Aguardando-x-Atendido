'use strict';
/* 18/11 — OS AVISOS DA MARGEM SAEM DE DENTRO DO CARD DO LUCRO BRUTO (a tela única das três empresas).

   O dono, com o "Ano" da AMB na tela: "olha os dizeres laranjas abaixo do botão card lá superior, fica mto feio estranho
   pra visualização. tem como melhorar isso não? arrumar". Eram dois parágrafos laranja de 10px dentro do card — "17
   venda(s) fora deste total…" e "margem NÃO fechada: 9.017 pedido(s)…" —, que triplicavam a altura do card e esticavam
   a fileira inteira.

   Agora: no card, UMA linha ("⚠ margem não fechada · ver por quê"); o clique abre o MESMO texto, inteiro, numa faixa
   embaixo da fileira de cards (e o "por canal", que só existia no balão do mouse, passa a ser lido); outro clique fecha.
   Nenhum aviso some: sem abrir, o card continua dizendo que a margem não está fechada.

   O QUE SE PROVA (as funções de PRODUÇÃO, recortadas da tela gerada de cada empresa):
   A. os avisos: os dois textos de antes, palavra por palavra, com os números do print do dono; sem histórico (período
      curto), tudo real ou sem os campos → nenhum;
   B. o card (o trecho de produção): com aviso, UMA linha curta e nenhum parágrafo; sem aviso, nada;
   C. a faixa: fechada de saída; o clique abre com o texto inteiro e redesenha; outro clique fecha; aviso que some
      (trocou de período) fecha a faixa mesmo com ela aberta;
   D. a página tem a faixa logo depois da fileira de cards, e o render a pinta. */
const assert = require('assert');
const T = require('./_tela-empresa');
const scriptDe = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const recorte = (js, ini, fim, oQue) => { const a = js.indexOf(ini), b = js.indexOf(fim, a + 1); assert.ok(a >= 0 && b > a, 'não achei ' + oQue + ' na tela'); return js.slice(a, b); };
const linha = (js, re, oQue) => { const m = re.exec(js); assert.ok(m, 'não achei ' + oQue + ' na tela'); return m[0]; };

for (const emp of ['girassol', 'good', 'ambtotal']) {
  const html = T.telaDaEmpresa(emp), js = scriptDe(html);
  const BASICO = [linha(js, /^const BRL = [^\n]+$/m, 'o BRL'), linha(js, /^const N = [^\n]+$/m, 'o N'), linha(js, /^const esc = [^\n]+$/m, 'o esc')].join('\n');
  const BLOCO = recorte(js, 'let _avisoMgAberto = false;', '\nfunction despesasMLper(){', 'os avisos da margem');
  const montar = () => { const amb = { el: { innerHTML: 'lixo', style: { display: '' } }, renders: 0 };
    amb.t = new Function('document', 'render', BASICO + '\n' + BLOCO + '\nreturn { avisosDaMargem, linhaAvisoMargem, pintarAvisoMargem, alternarAvisoMargem, get aberto(){ return _avisoMgAberto; } };')(
      { getElementById: (id) => (id === 'margemDet' ? amb.el : null) }, () => { amb.renders++; });
    return amb; };

  /* ═══ A. os avisos (os números do print do dono) ═══ */
  const fin = { linhas: 9200, por_linha: { real: 123, estimado: 111, ausente: 8966 }, completo: false, pedidos_nao_reais: 9017,
    por_canal: { mercadolivre: { estimado: 0, ausente: 7000 }, shopee: { estimado: 111, ausente: 1966 } }, ausentes_fora_do_total: 17, ausentes_no_total: 8949 };
  const HIST = { totais: { margens_sem_parcela: 17, financeiro: fin } };
  const { t } = montar();
  const itens = t.avisosDaMargem(true, HIST);
  assert.deepStrictEqual(itens, [
    '⚠ 17 venda(s) fora deste total — comissão ou frete ainda não gravados (total PARCIAL)',
    '⚠ margem NÃO fechada: 9.017 pedido(s) com comissão/frete NÃO CONFIRMADO (8.966 linha(s): 17 fora do total — PARCIAL; 8.949 no total sem confirmação) ou ESTIMADO (111 linha(s)) · por canal (linhas estimadas + não confirmadas): mercadolivre 7.000, shopee 2.077',
  ], emp + ': os avisos da margem mudaram de texto');
  assert.deepStrictEqual(t.avisosDaMargem(false, HIST), [], emp + ': no período curto (sem o histórico) esses avisos não existem');
  assert.deepStrictEqual(t.avisosDaMargem(true, null), []); assert.deepStrictEqual(t.avisosDaMargem(true, { totais: {} }), []);
  assert.deepStrictEqual(t.avisosDaMargem(true, { totais: { margens_sem_parcela: 0, financeiro: Object.assign({}, fin, { completo: true }) } }), [], emp + ': tudo real = sem aviso');
  assert.strictEqual(t.avisosDaMargem(true, { totais: { margens_sem_parcela: 3 } }).length, 1, emp + ': só a venda fora do total também avisa');
  assert.strictEqual(t.avisosDaMargem(true, { totais: { financeiro: fin } }).length, 1, emp + ': só a fonte não confirmada também avisa');

  /* ═══ B. o card do Lucro Bruto, pelo trecho de produção ═══ */
  {
    const a = montar();
    const card = recorte(js, "    (MC.temCfg\n      ? (function(){", "\n      : '<div class=\"kpi\" style=\"--kc:#64748b;cursor:pointer\"", 'o card do Lucro Bruto').replace("    (MC.temCfg\n      ? ", '');
    const rodar = (av) => new Function('usaHist', 'HIST', 'MC', 'fat', 'intervalo', 'MLB_PER', 'MLB_CK', 'despesasSHPper', 'BRL', '_avMg', 'linhaAvisoMargem',
      'return ' + card + ';')(true, { totais: { margem: 1000, faturamento: 4000 } }, {}, 0, () => ({ de: 'a', ate: 'b' }), null, '', () => 0, new Function(BASICO + '\nreturn BRL;')(), av, a.t.linhaAvisoMargem);
    const com = rodar(itens);
    assert.ok(com.includes('Lucro Bruto (M.C.)') && com.includes('>R$ 1.000,00'), emp + ': o card do lucro mudou: ' + com);
    assert.ok(com.endsWith('<div class="avMg" onclick="alternarAvisoMargem()" title="clique pra ler o aviso inteiro, embaixo dos cards">⚠ margem não fechada · <u>ver por quê</u></div></div></div>'), emp + ': o card não tem a linha curta do aviso: ' + com.slice(-260));
    assert.ok(!/fora deste total|NÃO CONFIRMADO|ESTIMADO|class="warn"/.test(com), emp + ': o parágrafo laranja voltou pra dentro do card: ' + com);
    const sem = rodar([]);
    assert.ok(!sem.includes('avMg') && sem.endsWith('histórico completo</div></div>'), emp + ': sem aviso o card não pode ter a linha: ' + sem.slice(-200));
  }

  /* ═══ C. a faixa embaixo dos cards ═══ */
  {
    const a = montar();
    a.t.pintarAvisoMargem(itens);
    assert.deepStrictEqual([a.el.innerHTML, a.el.style.display, a.t.aberto], ['', 'none', false], emp + ': a faixa tem que nascer fechada');
    a.t.alternarAvisoMargem();
    assert.ok(a.t.aberto === true && a.renders === 1, emp + ': o clique tem que abrir e redesenhar a tela');
    a.t.pintarAvisoMargem(itens);
    assert.strictEqual(a.el.innerHTML, '<div>' + itens[0] + '</div><div>' + itens[1] + '</div>', emp + ': a faixa aberta tem que trazer o texto inteiro dos avisos');
    assert.strictEqual(a.el.style.display, 'block');
    assert.ok(a.t.linhaAvisoMargem(itens).includes('<u>fechar</u>'), emp + ': aberta, a linha do card oferece fechar');
    a.t.pintarAvisoMargem([]);   /* trocou pra um período sem aviso, com a faixa aberta */
    assert.deepStrictEqual([a.el.innerHTML, a.el.style.display], ['', 'none'], emp + ': sem aviso a faixa não pode ficar aberta com o texto do período anterior');
    a.t.alternarAvisoMargem(); a.t.pintarAvisoMargem(itens);
    assert.deepStrictEqual([a.el.innerHTML, a.el.style.display, a.renders], ['', 'none', 2], emp + ': o segundo clique fecha');
    /* o nome do canal vem do servidor: não vira HTML na faixa */
    const xss = a.t.avisosDaMargem(true, { totais: { financeiro: Object.assign({}, fin, { por_canal: { '<img src=x>': { estimado: 1, ausente: 0 } } }) } });
    assert.ok(xss[0].includes('&lt;img src=x&gt; 1') && !xss[0].includes('<img'), emp + ': o nome do canal entrou cru na faixa');
  }

  /* ═══ D. a página ═══ */
  assert.ok(js.includes(`'<div class="kpis" id="kpis"></div>'+'<div class="mgDet" id="margemDet"></div>'+`), emp + ': a faixa tem que ficar logo depois da fileira de cards');
  assert.ok(/const _avMg = avisosDaMargem\(usaHist, HIST\);[^\n]*\n  pintarAvisoMargem\(_avMg\);\n  \$\('kpis'\)\.innerHTML =/.test(js), emp + ': o render tem que montar os avisos e pintar a faixa junto dos cards');
  assert.ok(/\.mgDet\{display:none;/.test(html) && /\.kpi \.avMg\{[^}]*white-space:nowrap/.test(html), emp + ': o estilo da linha (uma linha só) e da faixa (fechada de saída)');
}
console.log('ok — avisos da margem (as três empresas): uma linha no card do Lucro Bruto, o texto inteiro numa faixa embaixo dos cards que abre e fecha no clique; nenhum aviso some');
