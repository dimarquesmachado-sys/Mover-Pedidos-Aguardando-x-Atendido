/* ════════════════════════════════════════════════════════════════════════════
   FERRAMENTAS DE CUSTO DO PAINEL — peça compartilhada (02/10).

   Mesma forma do Plano de Compra (#582/#583): gera o markup, empresa como PARÂMETRO, sem
   onclick inline, sem estado solto. Não extrai nada do painel da AMB — aquele monta a tela
   concatenando strings dentro do JS, e tentar recortar de lá foi o que fechou o #581.

   Junta duas coisas que o dono usou hoje de verdade e que a GOOD não tinha na tela:
     · DE-PARA DE SKU  — `/sku-depara-manual` devolve `pares`; é o que liga o SKU renomeado no
       Bling ao do histórico, e sem isso o produto aparece "sem custo" pra sempre;
     · CUSTOS MANUAIS  — `/custos-manuais` já serve uma TELA própria, então aqui é só o acesso.
       Card que refaz uma tela que já existe é duplicação, e duplicação diverge.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDeCusto(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('ferramentasCustoAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🔧 Ferramentas de custo ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que resolve SKU sem custo no painel</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<a href="' + BASE + '/custos-manuais" target="_blank" rel="noopener" ' +
          'style="padding:6px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;text-decoration:none">' +
          '✏️ custos manuais</a>' +
        '<button id="fcDepara" type="button">🔗 ver de-para de SKU</button>' +
        '<span id="fcInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="fcTab" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('fcInfo');
  var elTab = document.getElementById('fcTab');
  var bt = document.getElementById('fcDepara');

  bt.addEventListener('click', function () {
    bt.disabled = true;
    elInfo.textContent = 'carregando…';
    fetch(BASE + '/sku-depara-manual', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        bt.disabled = false;
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui carregar'); elTab.innerHTML = ''; return; }
        var pares = d.pares || {};
        var chaves = Object.keys(pares);
        elInfo.textContent = chaves.length ? (chaves.length + ' par(es) cadastrado(s)') : 'nenhum par cadastrado';
        if (!chaves.length) { elTab.innerHTML = ''; return; }
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:6px">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>SKU antigo</th><th>vira</th></tr></thead><tbody>' +
          chaves.sort().map(function (de) {
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(de) + '</td>' +
              '<td>' + esc(pares[de]) + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function (e) { bt.disabled = false; elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  });
})();`;
}

module.exports = { scriptDeCusto };
