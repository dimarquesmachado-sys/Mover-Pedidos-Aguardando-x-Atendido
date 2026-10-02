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
        '<label style="font-size:13px">prazo de reposição <input id="pcLead" type="number" value="30" min="1" max="180" style="width:64px"></label>' +
        '<label style="font-size:13px">cobertura <input id="pcCob" type="number" value="45" min="1" max="365" style="width:64px"></label>' +
        '<label style="font-size:13px">segurança <input id="pcSeg" type="number" value="15" min="0" max="120" style="width:64px"></label>' +
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
    var g = function (id, pad) { var e = document.getElementById(id); var n = Number(e && e.value); return (n > 0 ? n : pad); };
    return { lead: g('pcLead', 30), cob: g('pcCob', 45), seg: g('pcSeg', 15) };
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
          '<td style="text-align:right;white-space:nowrap">' + esc(i.acaba_em || '—') + '</td>' +
          '<td style="text-align:right">' + num(i.un) + '</td>' +
          '<td style="text-align:right">' + esc(brl(i.investir)) + '</td>' +
          '<td style="text-align:right">' + esc(brl(i.risco)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function carregar() {
    if (carregando) return;
    carregando = true;
    var p = param();
    elInfo.textContent = '⏳ calculando… na primeira vez busca saldo de cada produto no Bling, leva um pouco';
    fetch(BASE + '/plano-compra?lead=' + p.lead + '&cob=' + p.cob + '&seg=' + p.seg + '&base=180', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        carregando = false;
        /* ⚠️ a rota RECUSA EXPLICANDO quando a empresa não tem a peça ("primeiraImagem",
           "supaCfg") — mostrar o motivo é melhor que tabela vazia, que pareceria "não tem dado" */
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui calcular'); elTab.innerHTML = ''; return; }
        PLANO = d;
        var t = d.totais || {};
        elInfo.textContent = num(d.skus) + ' SKU(s) · comprar ' + num(t.skus_a_comprar) +
          ' · investir ' + brl(t.investir) + ' · lucro em risco ' + brl(t.risco) +
          (d.skus_sem_saldo ? ' · ' + num(d.skus_sem_saldo) + ' sem saldo no Bling' : '');
        render();
      })
      .catch(function (e) { carregando = false; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  }

  /* ⚠️ nada de onclick inline: foi um dos furos da v1 (o HTML chamava função que não existia
     no escopo). Aqui o próprio script liga os eventos nos elementos que ele mesmo criou. */
  document.getElementById('pcCalc').addEventListener('click', carregar);
  document.getElementById('pcFiltro').addEventListener('input', function (ev) { filtro = ev.target.value || ''; render(); });
  document.getElementById('pcCsv').addEventListener('click', function () {
    var its = linhas();
    if (!its.length) return;
    var cab = ['sku', 'nome', 'curva', 'saldo', 'un30', 'acaba_em', 'comprar', 'investir', 'risco'];
    var linhasCsv = [cab.join(';')].concat(its.map(function (i) {
      return [i.sku, String(i.nome || '').replace(/;/g, ','), i.curva, i.saldo, i.un30, i.acaba_em, i.un, i.investir, i.risco].join(';');
    }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\\ufeff' + linhasCsv.join('\\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'plano-compra.csv';
    a.click();
  });
})();`;
}

module.exports = { scriptDoPlano };
