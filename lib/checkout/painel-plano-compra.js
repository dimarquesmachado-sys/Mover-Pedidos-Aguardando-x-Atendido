/* ════════════════════════════════════════════════════════════════════════════
   PLANO DE COMPRA DO PAINEL — peça compartilhada (02/10), versão 2.

   ⚠️ A VERSÃO 1 (#581) FOI FECHADA E A CAUSA VALE REGISTRAR: eu tentei EXTRAIR o bloco do
   painel da AMB, e ele monta a tela concatenando strings DENTRO do JavaScript
   (`'<div…>'+\n '<div…>'+`). Não existe markup pra recortar: o que fui jogar no `innerHTML`
   era código-fonte, com `'+`, quebras de linha e `//` no meio. A tela mostraria fragmentos.
   Antes disso, colar o bloco direto no painel da GOOD falhou três vezes (onclick sem função,
   função em outro <script>, variável fantasma).

   Então esta versão NÃO EXTRAI NADA: a seção é escrita aqui, contra a resposta REAL da rota
   `/plano-compra`, com os campos que ela devolve de verdade — sku, nome, img, curva, un, un30,
   tendencia, md, saldo, acaba_em, custo_un, mc_un, risco, sem_saldo, investir.

   Sem estado solto, sem helper de fora, sem `onclick` inline: tudo vive dentro da própria peça.
   A empresa entra como PARÂMETRO, igual à fábrica de rotas.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDoPlano(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('planoCompraAqui');
  if (!alvo) return;   /* empresa que ainda não abriu espaço: não faz nada, e a tela segue */

  var PLANO = null, carregando = false, filtro = '';

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function brl(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { return (Number(v) || 0).toLocaleString('pt-BR'); }

  /* a seção inteira, montada por elemento — nada de innerHTML com fonte serializada */
  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🧮 Plano de Compra ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">quanto comprar pra não faltar · ordenado pelo LUCRO EM RISCO</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        /* Codex #582 (P1): A ROTA LÊ MESES, NÃO DIAS. Eu tinha posto 30/45/15 com teto de
           180/365/120 e mandado direto — a rota cortava em 24+24+6 MESES e devolvia número
           absurdo. Agora o rótulo diz "meses" e os padrões/limites são os da rota (4, 5, 0;
           máx 24/24/6). */
        '<label style="font-size:13px">reposição <input id="pcLead" type="number" value="4" min="0" max="24" style="width:58px"> meses</label>' +
        '<label style="font-size:13px">cobertura <input id="pcCob" type="number" value="5" min="0.5" max="24" step="0.5" style="width:58px"> meses</label>' +
        '<label style="font-size:13px">segurança <input id="pcSeg" type="number" value="0" min="0" max="6" style="width:58px"> meses</label>' +
        /* Codex #582 (P2): a rota só busca saldo dos 260 primeiros SKUs do recorte e devolve todos;
           com 'todas' e mais de 260 SKUs, o resto vinha "sem saldo" pra sempre. Por isso a tela
           oferece a curva (A+B por padrão) e manda ela. */
        '<label style="font-size:13px">curva <select id="pcCurva"><option value="AB" selected>A+B</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="todas">todas</option></select></label>' +
        '<button id="pcCalc" type="button">calcular</button>' +
        '<input id="pcFiltro" placeholder="filtrar por SKU ou nome" style="flex:1;min-width:150px">' +
        '<button id="pcCsv" type="button">baixar CSV</button>' +
      '</div>' +
      '<div id="pcInfo" style="font-size:13px;opacity:.75;margin-bottom:6px">clique em calcular</div>' +
      '<div id="pcTab" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('pcInfo');
  var elTab = document.getElementById('pcTab');

  function param() {
    /* Codex #582: 'seg' pode ser 0 de propósito — trocar 0 pelo padrão ignoraria a escolha */
    /* Codex #582 (P2): corta nos MESMOS limites da rota e devolve o valor usado pro campo, pra
       a tela nunca mostrar um número e calcular com outro (cob mínima da rota é 0.5). */
    var g = function (id, pad, min, max) {
      var e = document.getElementById(id); var n = Number(e && e.value);
      if (!(isFinite(n) && e && e.value !== '')) n = pad;
      n = Math.min(max, Math.max(min, n));
      if (e) e.value = n;
      return n;
    };
    var cv = document.getElementById('pcCurva');
    return { lead: g('pcLead', 4, 0, 24), cob: g('pcCob', 5, 0.5, 24), seg: g('pcSeg', 0, 0, 6), curva: (cv && cv.value) || 'AB' };
  }

  function linhas() {
    if (!PLANO || !PLANO.itens) return [];
    var q = filtro.trim().toLowerCase();
    if (!q) return PLANO.itens;
    return PLANO.itens.filter(function (i) {
      return (String(i.sku || '') + ' ' + String(i.nome || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function render() {
    var its = linhas();
    if (!its.length) { elTab.innerHTML = '<div style="opacity:.7;font-size:13px">nenhum item</div>'; return; }
    elTab.innerHTML =
      '<table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr style="text-align:left;opacity:.7">' +
        '<th>SKU</th><th>produto</th><th style="text-align:right">saldo</th>' +
        '<th style="text-align:right">30d</th><th style="text-align:right">acaba</th>' +
        '<th style="text-align:right">comprar</th><th style="text-align:right">investir</th>' +
        '<th style="text-align:right">lucro em risco</th></tr></thead><tbody>' +
      its.map(function (i) {
        return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
          '<td style="padding:4px 0;white-space:nowrap">' + esc(i.sku) + (i.curva ? ' <span style="opacity:.6">' + esc(i.curva) + '</span>' : '') + '</td>' +
          '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.nome) + '</td>' +
          '<td style="text-align:right">' + (i.sem_saldo ? '<span style="opacity:.6">sem saldo</span>' : num(i.saldo)) + '</td>' +
          '<td style="text-align:right">' + num(i.un30) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + /* P1: 0 dias = JÁ ACABOU, o caso mais urgente — '||' escondia justamente ele */
          (i.acaba_em == null ? '—' : (Number(i.acaba_em) <= 0 ? '<b style="color:#f87171">acabou</b>' : esc(i.acaba_em))) + '</td>' +
          /* Codex #582 (P1): 'un' é o VENDIDO no histórico; a quantidade recomendada é 'comprar'.
             Mostrar 'un' sob o título "comprar" mandaria o dono pedir o número errado. */
          '<td style="text-align:right">' + (i.comprar == null ? '<span style="opacity:.6" title="sem saldo: não dá pra calcular">—</span>' : '<b>' + num(i.comprar) + '</b>') + '</td>' +
          /* P1: 'investir: null' quer dizer NÃO SEI (sem custo ou sem saldo) — mostrar R$ 0,00
             faria aprovar compra sem contar o desembolso */
          '<td style="text-align:right">' + (i.investir == null ? '<span style="opacity:.6">—</span>' : esc(brl(i.investir))) + '</td>' +
          /* Codex #582 r3 (P2): sem saldo, a rota não calcula a data de ruptura e o risco sai 0 —
             mostrar "R$ 0,00" faz o item parecer SEGURO e empurra o dono pras outras linhas,
             quando ele pode já estar faltando. Sem saldo = risco desconhecido. */
          '<td style="text-align:right">' + (i.sem_saldo ? '<span style="opacity:.6" title="sem saldo: não dá pra avaliar o risco">—</span>' : esc(brl(i.risco))) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  var seq = 0;   /* Codex #582 (P1): cada clique ganha um número */
  function carregar() {
    /* ⚠️ ANTES EU DESCARTAVA O CLIQUE enquanto uma carga estava em curso. A primeira demora
       (a rota busca saldo produto a produto no Bling), e se o dono mudasse reposição/cobertura
       e clicasse de novo, o clique sumia — e o resultado ANTIGO chegava depois, como se fosse
       dos parâmetros novos. Número errado é pior que número ausente.
       Agora todo clique vale: o pedido antigo é ignorado na volta pelo número de sequência. */
    /* Codex #582 (P1, acerto): ANTES OS DOIS PEDIDOS SAÍAM. Eu só ignorava o antigo na volta,
       mas ele já tinha ido — e esta rota busca saldo produto a produto no Bling, então dois
       cliques = o DOBRO de chamadas na cota da conta, que é justamente o que derruba a bipagem
       do galpão. Agora o clique novo marca o pedido anterior como descartado ANTES de sair, e
       o botão fica em espera enquanto há uma carga em curso. */
    var meu = ++seq;
    carregando = true;
    var bt = document.getElementById('pcCalc');
    if (bt) { bt.disabled = true; bt.textContent = 'calculando…'; }
    var solta = function () { if (bt) { bt.disabled = false; bt.textContent = 'calcular'; } };
    var p = param();
    elInfo.textContent = '⏳ calculando… na primeira vez busca saldo de cada produto no Bling, leva um pouco';
    fetch(BASE + '/plano-compra?lead=' + p.lead + '&cob=' + p.cob + '&seg=' + p.seg + '&curva=' + encodeURIComponent(p.curva) + '&base=180', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;   /* chegou atrasado: outro clique já mandou outro pedido */
        carregando = false; solta();
        /* ⚠️ a rota RECUSA EXPLICANDO quando a empresa não tem a peça ("primeiraImagem",
           "supaCfg") — mostrar o motivo é melhor que tabela vazia, que pareceria "não tem dado" */
        /* Codex #582 (P2): falha LIMPA o plano velho. Sem isso, digitar no filtro chamava o
           render e repintava os números da rodada anterior como se fossem destes parâmetros. */
        if (!d || !d.ok) { PLANO = null; elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui calcular'); elTab.innerHTML = ''; return; }
        PLANO = d;
        var t = d.totais || {};
        /* Codex #582 r3 (P1): O TOTAL A INVESTIR PODE ESTAR INCOMPLETO. A rota soma com
           (c.investir || 0), então SKU sem custo em cache entra como zero — o total sai MENOR
           que o desembolso real, e é justamente o número que o dono olha pra decidir quanto
           vai gastar. Agora, se alguma linha está sem custo, o resumo diz "no mínimo" e conta
           quantas ficaram de fora. Número incompleto anunciado é melhor que número redondo
           mentiroso. */
        /* Codex #582 (P2, acerto): SEM SALDO ≠ SEM CUSTO, e o dono age diferente em cada um.
           Sem saldo é problema de leitura do Bling (ou produto zerado); sem custo é cadastro
           faltando, que ele resolve no Bling e some. Contar os dois juntos como "sem custo"
           mandaria procurar no lugar errado. */
        var semCusto = (d.itens || []).filter(function (i) { return i.investir == null && !i.sem_saldo; }).length;
        elInfo.textContent = num(d.skus) + ' SKU(s) · comprar ' + num(t.skus_a_comprar) +
          ' · investir ' + (semCusto ? 'no mínimo ' : '') + brl(t.investir) +
          (semCusto ? ' (' + num(semCusto) + ' sem custo, fora da soma)' : '') +
          /* Codex #582 (P2, acerto): o total de RISCO tem o mesmo furo do de investir — item
             sem saldo entra como 0 na soma. Mesmo tratamento: diz que é no mínimo. */
          ' · lucro em risco ' + (d.skus_sem_saldo ? 'no mínimo ' : '') + brl(t.risco) +
          (d.skus_sem_saldo ? ' · ' + num(d.skus_sem_saldo) + ' sem saldo no Bling' : '');
        render();
      })
      .catch(function (e) { if (meu !== seq) return; carregando = false; solta(); PLANO = null; elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  }

  /* ⚠️ nada de onclick inline: foi um dos furos da v1 (o HTML chamava função que não existia
     no escopo). Aqui o próprio script liga os eventos nos elementos que ele mesmo criou. */
  document.getElementById('pcCalc').addEventListener('click', carregar);
  document.getElementById('pcFiltro').addEventListener('input', function (ev) { filtro = ev.target.value || ''; render(); });
  document.getElementById('pcCsv').addEventListener('click', function () {
    var its = linhas();
    if (!its.length) return;
    var cab = ['sku', 'nome', 'curva', 'saldo', 'un30', 'acaba_em', 'comprar', 'investir', 'risco'];
    /* Codex #582 (P2): todo campo entre aspas, aspas dobradas, quebra de linha vira espaço —
       nome com ';' ou enter deslocava colunas e casava a quantidade com o produto errado */
    /* Codex #582 (P2, acerto): NEUTRALIZA PREFIXO DE FÓRMULA. Nome de produto começando com
       =, +, - ou @ vira fórmula ao abrir o CSV no Excel — na melhor hipótese a célula mostra
       erro, na pior executa algo. Prefixo de aspa simples resolve e o Excel não a exibe. */
    var cel = function (v) { var _t = String(v == null ? '' : v); if (/^[=+\-@]/.test(_t)) _t = "'" + _t; return '"' + _t.replace(/[\\r\\n]+/g, ' ').replace(/"/g, '""') + '"'; };
    var linhasCsv = [cab.join(';')].concat(its.map(function (i) {
      return [i.sku, i.nome, i.curva, i.saldo, i.un30, i.acaba_em, i.comprar, i.investir, i.risco].map(cel).join(';');
    }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\\ufeff' + linhasCsv.join('\\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'plano-compra.csv';
    a.click();
  });
})();`;
}

module.exports = { scriptDoPlano };
