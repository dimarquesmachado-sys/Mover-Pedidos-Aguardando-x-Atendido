/* ════════════════════════════════════════════════════════════════════════════════════════
   PREVISÃO DE VENDAS POR PRODUTO — peça compartilhada do painel (05/10).

   Mostra, por SKU: quanto vendeu na base escolhida, a tendência (últimos 30 dias contra os 30
   anteriores) e quanto deve sair em 1 semana, 1 mês e 3 meses, mantido o ritmo.

   É a seção que responde "o que comprar e quanto" — e a GOOD era a única das três sem ela,
   embora a rota `/previsao-vendas` JÁ RESPONDA lá: vem de `rotasHistorico`, que a GOOD monta. O
   que faltava era só a tela.

   ⚠️ TENDÊNCIA SÓ COM BASE SUFICIENTE: comparar 30 dias contra os 30 anteriores exige pelo menos
   60 dias de histórico. Com base menor a comparação não existe — e mostrar uma seta de tendência
   calculada sobre meio período seria inventar informação de compra.

   ⚠️ E "SEM DADO" NÃO VIRA ZERO: SKU sem venda na base não aparece como "vai vender 0" — isso
   diria "não compre", quando o certo é "não há base pra dizer".
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaPrevisao(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('previsaoVendasAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function num(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  var OPCOES = [[30, '1 mês'], [60, '2 meses'], [90, '3 meses'], [180, '6 meses'], [365, '1 ano']];
  var baseDias = 90;
  var seq = 0;

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">📈 Previsão de vendas por produto ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que deve sair, mantido o ritmo</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<span style="font-size:13px;opacity:.75">base de histórico:</span>' +
        '<select id="pvBase"></select>' +
        '<span id="pvInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="pvTab" style="overflow:auto"></div>' +
    '</div>';

  var sel = document.getElementById('pvBase');
  var elInfo = document.getElementById('pvInfo');
  var elTab = document.getElementById('pvTab');

  sel.innerHTML = OPCOES.map(function (o) {
    return '<option value="' + o[0] + '"' + (o[0] === baseDias ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');

  function tendencia(t) {
    if (t == null || !isFinite(Number(t))) {
      /* ⚠️ sem base pra comparar: NÃO desenha seta. Seta neutra seria lida como "estável". */
      return '<span style="opacity:.55" title="precisa de pelo menos 60 dias de base pra comparar">—</span>';
    }
    var n = Number(t);
    if (n >= 25) return '<span style="color:#2e7d32">▲ ' + n + '%</span>';
    if (n <= -25) return '<span style="color:#c62828">▼ ' + n + '%</span>';
    return '<span style="opacity:.7">≈ ' + (n > 0 ? '+' : '') + n + '%</span>';
  }

  function carregar() {
    var meu = ++seq;
    sel.disabled = true;
    elInfo.textContent = 'calculando com ' + baseDias + ' dias de histórico…';
    elTab.innerHTML = '';

    fetch(BASE + '/previsao-vendas?base=' + encodeURIComponent(baseDias) + chave(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        sel.disabled = false;
        /* ⚠️ 'ok' ausente é FALHA, não "nada a prever" */
        if (!d || d.ok !== true) {
          elInfo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui calcular');
          return;
        }

        /* ⚠️ Codex #626 (P1): eu li o produtor ERRADO. 'lib/checkout/historico.js:366' devolve
           '{ skus: <CONTAGEM>, produtos: [...] }' — 'skus' é NÚMERO, não lista, e 'itens' não
           existe. Com os dois ramos errados, a seção dizia "sem vendas na base" SEMPRE, mesmo com
           histórico cheio: um "não tem o que comprar" falso, na tela que serve pra decidir compra.
           É a regra 12 de novo — ler o produtor antes de escrever o consumidor. */
        var itens = Array.isArray(d.produtos) ? d.produtos : [];
        elInfo.innerHTML = 'base: ' + esc(String(d.de || '').slice(0, 10)) + ' → ' + esc(String(d.ate || '').slice(0, 10)) +
          (d.linhas != null ? ' · ' + esc(String(d.linhas)) + ' itens vendidos' : '') +
          (d.skus != null ? ' · ' + esc(String(d.skus)) + ' SKUs' : '') +
          (d.cache ? ' <span style="opacity:.6">(do cache — recalcula a cada 30 min)</span>' : '');

        if (!itens.length) {
          elTab.innerHTML = '<div style="opacity:.75;font-size:13px">sem vendas na base escolhida — ' +
            'isto NÃO quer dizer que os produtos não vendem: quer dizer que não há histórico nesse período</div>';
          return;
        }

        /* ⚠️ a tendência compara 30 dias com os 30 anteriores: com base < 60 dias ela não existe */
        var podeTendencia = baseDias >= 60;

        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>#</th><th>produto</th>' +
          '<th style="text-align:right">vendidas</th>' +
          '<th style="text-align:right" title="últimos 30 dias contra os 30 anteriores">tendência</th>' +
          '<th style="text-align:right">1 sem</th><th style="text-align:right">1 mês</th>' +
          '<th style="text-align:right">3 meses</th></tr></thead><tbody>' +
          itens.slice(0, 50).map(function (it, i) {
            /* o campo das unidades vendidas é 'un' (li em historico.js), não 'vendidas'/'qtd' */
            var vend = num(it.un);
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0;opacity:.6">' + (i + 1) + '</td>' +
              '<td>' + esc(it.sku || it.produto || '—') + '</td>' +
              '<td style="text-align:right">' + (vend != null ? esc(vend) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right">' + (podeTendencia ? tendencia(it.tendencia) :
                '<span style="opacity:.55" title="base menor que 60 dias: não dá pra comparar 30 com 30">—</span>') + '</td>' +
              '<td style="text-align:right">' + (num(it.p7) != null ? esc(num(it.p7)) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right"><b>' + (num(it.p30) != null ? esc(num(it.p30)) : '<span style="opacity:.6">—</span>') + '</b></td>' +
              '<td style="text-align:right">' + (num(it.p90) != null ? esc(num(it.p90)) : '<span style="opacity:.6">—</span>') + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (podeTendencia ? '' :
            '<div style="opacity:.75;font-size:12px;margin-top:6px">⚠️ a tendência compara os últimos 30 dias ' +
            'com os 30 anteriores — com base de ' + baseDias + ' dias não há os dois períodos, então ela não é mostrada</div>');
      })
      .catch(function (e) {
        if (meu !== seq) return;
        sel.disabled = false;
        elInfo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  }

  sel.addEventListener('change', function () {
    baseDias = Number(sel.value) || 90;
    carregar();
  });
  carregar();
})();`;
}

module.exports = { scriptDaPrevisao };
