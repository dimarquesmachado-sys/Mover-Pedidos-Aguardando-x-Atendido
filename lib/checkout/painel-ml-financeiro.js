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

  /* o período que o painel já escolheu. O estado do painel da GOOD é PERIODO + janela() (e
     P_DE/P_ATE no "custom"); não existem campos #de/#ate. Sem ele NÃO invento outro período:
     mostrar o mês corrente sob um painel em "Hoje" seria o número de outra janela. */
  function periodo() {
    try {
      if (typeof janela === 'function' && typeof PERIODO !== 'undefined') {
        var j = janela(PERIODO);
        if (j && j.de && j.ate) return { de: j.de, ate: j.ate };
      }
    } catch (e) {}
    return { de: '', ate: '' };
  }
  function dmy(iso) { return String(iso || '').slice(0, 10).split('-').reverse().join('/'); }

  /* coleta parada não pode passar por dado atual */
  var LIMITE_H = 36;
  function idadeH(iso) {
    var t = iso ? Date.parse(iso) : NaN;
    return isFinite(t) ? (Date.now() - t) / 36e5 : null;
  }
  var seq = 0;   /* resposta atrasada de um clique anterior não sobrescreve a atual */

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

  function carregarFatura(meu) {
    var k = chave();
    return fetch(BASE + '/ml-fatura-cartao' + (k ? '?' + k : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        /* 404 {error} (sessão vencida / não-admin) e 500 {ok:false} NÃO são "sem fatura" */
        if (!d || d.ok !== true) { elFatura.textContent = '⚠️ ' + ((d && (d.erro || d.error)) || 'não consegui a fatura'); return; }
        /* a rota devolve { faturas: [...] }, cada uma com o próprio total; a primeira é o ciclo
           mais recente. Não existe valor/total no topo. */
        var f = Array.isArray(d.faturas) ? d.faturas[0] : null;
        var v = f ? brl(f.total) : null;
        var h = idadeH(d.atualizado);
        elFatura.innerHTML = '🧾 Fatura do cartão' + (f && f.rotulo ? ' (' + esc(f.rotulo) + ')' : '') + ': ' +
          (v ? '<b>' + esc(v) + '</b>' : '<span style="opacity:.6">sem valor ainda</span>') +
          (f && f.situacao ? ' <span style="opacity:.6">· ' + esc(f.situacao) + '</span>' : '') +
          (d.atualizado ? ' <span style="opacity:.6">· atualizado ' + esc(dmy(d.atualizado)) + '</span>' : '') +
          (d.atualizado && (h == null || h > LIMITE_H) ? ' <span>· ⚠️ coleta antiga, pode estar desatualizado</span>' : '') +
          (d.leia ? '<div style="opacity:.7;font-size:12px;margin-top:2px">' + esc(d.leia) + '</div>' : '');
      })
      .catch(function (e) { if (meu !== seq) return; elFatura.textContent = '⚠️ ' + ((e && e.message) || e); });
  }

  function carregarDespesas(meu) {
    var p = periodo();
    var k = chave();
    if (!p.de || !p.ate) {
      elTab.innerHTML = '<div style="opacity:.75">⚠️ não consegui ler o período do painel</div>';
      return Promise.resolve();
    }
    var url = BASE + '/ml-billing-resumo?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate) +
              (k ? '&' + k : '');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        /* só ok:true é sucesso: o 404 {error} não tem "ok", e tratá-lo como vazio diria "sem
           despesas" para uma falha de autorização */
        if (!d || d.ok !== true) { elTab.innerHTML = '<div style="opacity:.75">⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui as despesas') + '</div>'; return; }
        var cats = d.categorias || {};
        var h = idadeH(d.atualizado);
        var aviso = '<div style="opacity:.7;font-size:12px;margin-top:6px">' + esc(dmy(p.de)) + ' → ' + esc(dmy(p.ate)) +
          (d.atualizado ? ' · coleta atualizada em ' + esc(dmy(d.atualizado)) : ' · sem registro de coleta') +
          (d.atualizado && (h == null || h > LIMITE_H) ? ' · <b>⚠️ coleta parada: o período pode estar incompleto</b>' : '') + '</div>';
        var nomes = Object.keys(cats);
        if (!nomes.length) {
          /* ⚠️ "sem dado" NÃO é "zero": dizer R$ 0,00 aqui faria o dono acreditar que o ML não
             cobrou nada no período, quando a coleta é que não rodou. */
          elTab.innerHTML = '<div style="opacity:.75">sem despesas coletadas de ' + esc(p.de) + ' a ' + esc(p.ate) +
            ' — isto NÃO quer dizer que o ML não cobrou: quer dizer que não há coleta no período</div>' + aviso;
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
          '</tbody></table>' + aviso;
      })
      .catch(function (e) { if (meu !== seq) return; elTab.innerHTML = '<div style="opacity:.75">⚠️ ' + esc((e && e.message) || e) + '</div>'; });
  }

  function carregar() {
    var meu = ++seq;
    bt.disabled = true;
    elFatura.textContent = 'carregando…';
    elTab.innerHTML = '<div style="opacity:.6">carregando…</div>';
    Promise.all([carregarFatura(meu), carregarDespesas(meu)]).then(function () { if (meu === seq) bt.disabled = false; });
  }

  bt.addEventListener('click', carregar);
  carregar();
})();`;
}

module.exports = { scriptDoMlFinanceiro };
