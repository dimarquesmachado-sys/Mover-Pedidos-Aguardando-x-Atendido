/* ════════════════════════════════════════════════════════════════════════════════════════
   FINANCEIRO DO MERCADO LIVRE — peça compartilhada do painel (04/10).

   Duas coisas que a AMB mostra e a GOOD não mostrava:

     · DESPESAS POR CATEGORIA (`/ml-billing-resumo?de=&ate=`) — o faturamento oficial do ML:
       tarifa de venda, frete, Full, publicidade. É o que explica a diferença entre o que a
       venda rende e o que cai na conta;
     · FATURA NO CARTÃO (`/ml-fatura-cartao`) — a fatura do ML fecha dia 12 e é debitada; saber
       o valor antes evita susto.

   ⚠️ MEDI ANTES DE ESCREVER, na GOOD: `/ml-fee` NÃO É TRATADA (nem existe na fábrica),
   `/status-mkt` exige período e `/tiktok-custo-devolucoes` RECUSA por falta de peça. Nenhuma das
   três entra: seção que nasce mostrando erro é pior que seção ausente.

   Mesma forma das outras peças: gera o markup, empresa como PARÂMETRO, sem onclick inline.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDoMlFinanceiro(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('mlFinanceiroAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function brl(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  /* o período que o painel já usa; sem ele, o mês corrente */
  function periodo() {
    var de = document.getElementById('de'), ate = document.getElementById('ate');
    var hoje = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var ini = hoje.getFullYear() + '-' + pad(hoje.getMonth() + 1) + '-01';
    var fim = hoje.getFullYear() + '-' + pad(hoje.getMonth() + 1) + '-' + pad(hoje.getDate());
    return {
      de: (de && de.value) || ini,
      ate: (ate && ate.value) || fim,
    };
  }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">💳 Financeiro do Mercado Livre ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que o ML cobra, por categoria</span>' +
        '<button id="mlfAtualizar" type="button" style="float:right">↻ atualizar</button></div>' +
      '<div id="mlfFatura" style="font-size:13px;margin:8px 0;opacity:.85"></div>' +
      '<div id="mlfTab" style="overflow:auto"></div>' +
    '</div>';

  var elFatura = document.getElementById('mlfFatura');
  var elTab = document.getElementById('mlfTab');
  var bt = document.getElementById('mlfAtualizar');

  function carregarFatura() {
    var k = chave();
    return fetch(BASE + '/ml-fatura-cartao' + (k ? '?' + k : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) { elFatura.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui a fatura'); return; }
        var v = brl(d.valor != null ? d.valor : d.total);
        elFatura.innerHTML = '🧾 Fatura do cartão: ' +
          (v ? '<b>' + esc(v) + '</b>' : '<span style="opacity:.6">sem valor ainda</span>') +
          (d.atualizado ? ' <span style="opacity:.6">· atualizado ' + esc(String(d.atualizado).slice(0, 10)) + '</span>' : '') +
          (d.leia ? '<div style="opacity:.7;font-size:12px;margin-top:2px">' + esc(d.leia) + '</div>' : '');
      })
      .catch(function (e) { elFatura.textContent = '⚠️ ' + ((e && e.message) || e); });
  }

  function carregarDespesas() {
    var p = periodo();
    var k = chave();
    var url = BASE + '/ml-billing-resumo?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate) +
              (k ? '&' + k : '');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) { elTab.innerHTML = '<div style="opacity:.75">⚠️ ' + esc((d && d.erro) || 'não consegui as despesas') + '</div>'; return; }
        var cats = d.categorias || {};
        var nomes = Object.keys(cats);
        if (!nomes.length) {
          /* ⚠️ "sem dado" NÃO é "zero": dizer R$ 0,00 aqui faria o dono acreditar que o ML não
             cobrou nada no período, quando a coleta é que não rodou. */
          elTab.innerHTML = '<div style="opacity:.75">sem despesas coletadas de ' + esc(p.de) + ' a ' + esc(p.ate) +
            ' — isto NÃO quer dizer que o ML não cobrou: quer dizer que não há coleta no período</div>';
          return;
        }
        var linhas = nomes.map(function (n) { return { nome: n, valor: Number(cats[n] || 0) }; })
                          .sort(function (a, b) { return b.valor - a.valor; });
        var total = linhas.reduce(function (s, l) { return s + l.valor; }, 0);
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>categoria</th><th style="text-align:right">valor</th>' +
          '<th style="text-align:right">%</th></tr></thead><tbody>' +
          linhas.map(function (l) {
            var pct = total > 0 ? ((l.valor / total) * 100).toFixed(1) + '%' : '—';
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(l.nome) + '</td>' +
              '<td style="text-align:right">' + esc(brl(l.valor) || '—') + '</td>' +
              '<td style="text-align:right;opacity:.7">' + pct + '</td></tr>';
          }).join('') +
          '<tr style="border-top:2px solid rgba(128,128,128,.45)"><td style="padding:5px 0"><b>total</b></td>' +
          '<td style="text-align:right"><b>' + esc(brl(total) || '—') + '</b></td><td></td></tr>' +
          '</tbody></table>';
      })
      .catch(function (e) { elTab.innerHTML = '<div style="opacity:.75">⚠️ ' + esc((e && e.message) || e) + '</div>'; });
  }

  function carregar() {
    bt.disabled = true;
    elFatura.textContent = 'carregando…';
    elTab.innerHTML = '<div style="opacity:.6">carregando…</div>';
    Promise.all([carregarFatura(), carregarDespesas()]).then(function () { bt.disabled = false; });
  }

  bt.addEventListener('click', carregar);
  carregar();
})();`;
}

module.exports = { scriptDoMlFinanceiro };
