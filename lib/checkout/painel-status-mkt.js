/* ════════════════════════════════════════════════════════════════════════════════════════
   CANCELADOS NO MARKETPLACE — peça compartilhada do painel (04/10).

   Confere, no período escolhido, se o marketplace cancelou pedido que o Bling ainda conta como
   venda. Cancelamento não abatido INFLA o faturamento e a margem do período — e é exatamente o
   tipo de número errado que a regra da casa não aceita.

   Mostra também o que NÃO foi verificado: canais sem cobertura (Magalu, Amazon, Olist) e os
   pedidos de ML/Shopee que a checagem não alcançou. Sem isso, "0 cancelados" seria lido como
   "está tudo certo", quando pode ser "ninguém olhou".

   ⚠️ MEDI ANTES DE ESCREVER, chamando as 13 rotas candidatas na GOOD: só `/status-mkt` e
   `/historico` respondem de verdade — e `/historico` a GOOD JÁ TEM (é a "Análise de Vendas", que
   eu quase dupliquei no #613). As outras não são tratadas, exigem sessão ou recusam por falta de
   peça. Esta peça cobre a única que faltava.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDoStatusMkt(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('canceladosMktAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  function periodo() {
    var de = document.getElementById('de'), ate = document.getElementById('ate');
    var h = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      de: (de && de.value) || (h.getFullYear() + '-' + p(h.getMonth() + 1) + '-01'),
      ate: (ate && ate.value) || (h.getFullYear() + '-' + p(h.getMonth() + 1) + '-' + p(h.getDate())),
    };
  }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🚫 Cancelados no marketplace ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">venda cancelada que o Bling ainda conta</span>' +
        '<button id="cmChecar" type="button" style="float:right">conferir período</button></div>' +
      '<div id="cmCorpo" style="font-size:13px;margin-top:8px;opacity:.75">clique em conferir</div>' +
    '</div>';

  var elCorpo = document.getElementById('cmCorpo');
  var bt = document.getElementById('cmChecar');
  var seq = 0;

  bt.addEventListener('click', function () {
    var p = periodo();
    var meu = ++seq;
    bt.disabled = true;
    elCorpo.innerHTML = 'conferindo ' + esc(p.de) + ' a ' + esc(p.ate) + '…';

    fetch(BASE + '/status-mkt?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate) + chave(),
          { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        bt.disabled = false;
        /* ⚠️ 'ok' ausente é FALHA, não "nada encontrado": 404 por chave vencida resolveria o
           fetch e viraria "nenhum cancelamento", que é a leitura mais perigosa possível aqui. */
        if (!d || d.ok !== true) {
          elCorpo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui conferir — veja se a sessão/chave ainda vale');
          return;
        }

        var achados = Array.isArray(d.numeros) ? d.numeros : [];
        var partes = [];

        if (achados.length) {
          partes.push('<div style="padding:8px 10px;border:1px solid rgba(220,70,70,.45);' +
            'background:rgba(220,70,70,.10);border-radius:8px">' +
            '<b>' + achados.length + ' pedido(s) cancelado(s) no marketplace</b> e ainda contados como venda: ' +
            esc(achados.slice(0, 40).join(', ')) + (achados.length > 40 ? ' …' : '') +
            '<div style="opacity:.8;margin-top:3px">enquanto não forem abatidos, o faturamento e a ' +
            'margem do período estão INFLADOS</div></div>');
        } else {
          partes.push('<div>nenhum cancelamento pendente nos canais conferidos</div>');
        }

        partes.push('<div style="margin-top:6px;opacity:.8">conferidos: ' +
          esc((d.canais_checados || []).join(', ') || '—') + ' · ' + (d.checados || 0) + ' pedido(s)</div>');

        /* ⚠️ O QUE NÃO FOI OLHADO precisa aparecer com o mesmo destaque: "0 cancelados" sem esta
           linha seria lido como "está tudo certo", quando pode ser "ninguém olhou esse canal". */
        var buracos = [];
        if ((d.sem_cobertura || []).length) buracos.push('sem cobertura: ' + (d.sem_cobertura || []).join(', '));
        if (Number(d.ml_nao_verificados || 0) > 0) buracos.push(d.ml_nao_verificados + ' do ML não verificados');
        if (Number(d.shopee_nao_verificados || 0) > 0) buracos.push(d.shopee_nao_verificados + ' da Shopee não verificados');
        if (Number(d.tiktok_sem_financeiro || 0) > 0) buracos.push(d.tiktok_sem_financeiro + ' do TikTok sem financeiro');
        if (buracos.length) {
          partes.push('<div style="margin-top:6px;padding:7px 10px;border:1px solid rgba(220,160,40,.45);' +
            'background:rgba(220,160,40,.10);border-radius:8px">⚠️ não conferido — ' +
            esc(buracos.join(' · ')) + '<div style="opacity:.8;margin-top:2px">aqui pode haver ' +
            'cancelamento que ninguém viu</div></div>');
        }
        if (d.aviso_tiktok) partes.push('<div style="margin-top:6px;opacity:.8">' + esc(d.aviso_tiktok) + '</div>');

        elCorpo.innerHTML = partes.join('');
      })
      .catch(function (e) {
        if (meu !== seq) return;
        bt.disabled = false;
        elCorpo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  });
})();`;
}

module.exports = { scriptDoStatusMkt };
