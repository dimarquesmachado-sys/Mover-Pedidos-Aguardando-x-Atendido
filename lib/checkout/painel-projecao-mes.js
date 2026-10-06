/* ════════════════════════════════════════════════════════════════════════════════════════
   COMO O MÊS DEVE FECHAR — peça compartilhada do painel (05/10).

   Pega o faturamento do mês corrente até hoje e projeta o fechamento pelo ritmo diário. É a
   resposta pra "vamos bater o mês?" sem esperar o dia 30.

   ⚠️ O CUIDADO QUE DEFINE ESTA SEÇÃO: ritmo de POUCOS DIAS não projeta mês. No dia 2, dois dias
   bons viram uma projeção eufórica e dois ruins viram pânico — e a decisão de compra sai disso.
   Abaixo de 5 dias corridos a seção mostra o faturamento até aqui e DIZ que ainda não dá pra
   projetar, em vez de cuspir um número que ninguém deveria usar.

   ⚠️ E vale pra todo mês: a divisão é pelo dia ATUAL e a multiplicação pelos dias REAIS do mês
   (28, 29, 30 ou 31) — nada de "30 dias" fixo, que erraria todo fevereiro e todo mês de 31.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaProjecaoMes(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('projecaoMesAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function brl(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  /* ⚠️ abaixo disso, projetar o mês é chute: 2 dias bons viram euforia, 2 ruins viram pânico */
  var MINIMO_DIAS = 5;

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">📆 Como o mês deve fechar ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">pelo ritmo até agora</span>' +
        '<button id="pmAtualizar" type="button" style="float:right">↻ atualizar</button></div>' +
      '<div id="pmCorpo" style="margin-top:8px;font-size:13px"></div>' +
    '</div>';

  var elCorpo = document.getElementById('pmCorpo');
  var bt = document.getElementById('pmAtualizar');
  var seq = 0;

  function carregar() {
    var meu = ++seq;
    var hj = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var ini = hj.getFullYear() + '-' + p(hj.getMonth() + 1) + '-01';
    var hoje = hj.getFullYear() + '-' + p(hj.getMonth() + 1) + '-' + p(hj.getDate());

    bt.disabled = true;
    elCorpo.textContent = 'carregando…';

    fetch(BASE + '/historico-longo?de=' + ini + '&ate=' + hoje + chave(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        bt.disabled = false;
        /* 'ok' ausente é FALHA, não mês zerado */
        if (!d || d.ok !== true || !d.totais) {
          elCorpo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui o faturamento do mês');
          return;
        }

        var fat = Number(d.totais.faturamento);
        if (!isFinite(fat)) {
          elCorpo.innerHTML = '⚠️ o servidor não mandou o faturamento do mês';
          return;
        }

        /* dias REAIS do mês: 28/29/30/31 — nada de 30 fixo */
        var diasNoMes = new Date(hj.getFullYear(), hj.getMonth() + 1, 0).getDate();
        var diaAtual = hj.getDate();

        var ateAqui = '<div>faturado até hoje (dia ' + diaAtual + '): <b>' + esc(brl(fat) || '—') + '</b></div>';

        if (diaAtual < MINIMO_DIAS) {
          /* ⚠️ o ponto da seção: com poucos dias, NÃO projeta. Número eufórico ou em pânico no
             dia 2 vira decisão de compra errada. */
          elCorpo.innerHTML = ateAqui +
            '<div style="margin-top:6px;padding:7px 10px;border:1px solid rgba(128,128,128,.35);' +
            'border-radius:8px;opacity:.85">ainda não dá pra projetar o fechamento: ' + diaAtual +
            ' dia(s) de mês não formam ritmo. A partir do dia ' + MINIMO_DIAS + ' a projeção aparece aqui.</div>';
          return;
        }

        var ritmo = fat / diaAtual;
        var previsto = ritmo * diasNoMes;

        elCorpo.innerHTML = ateAqui +
          '<div style="margin-top:4px">ritmo: <b>' + esc(brl(ritmo) || '—') + '</b> por dia</div>' +
          '<div style="margin-top:6px;padding:8px 10px;border:1px solid rgba(128,128,128,.35);' +
          'border-radius:8px">deve fechar o mês em <b style="font-size:15px">' + esc(brl(previsto) || '—') + '</b>' +
          '<div style="opacity:.75;margin-top:3px">projeção pelo ritmo dos ' + diaAtual + ' dias já corridos, ' +
          'sobre os ' + diasNoMes + ' dias deste mês — não considera sazonalidade nem campanha</div></div>';
      })
      .catch(function (e) {
        if (meu !== seq) return;
        bt.disabled = false;
        elCorpo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  }

  bt.addEventListener('click', carregar);
  carregar();
})();`;
}

module.exports = { scriptDaProjecaoMes };
