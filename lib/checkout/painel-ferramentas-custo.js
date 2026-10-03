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
        /* Codex #585 (P2): LEVA A CHAVE quando a página foi aberta por '?k='. Navegação não
           passa pelo wrapper de fetch do painel, e '/custos-manuais' exige sessão ou chave —
           sem isso o dono que entra por chave clica e cai num 401. */
        '<a href="' + BASE + '/custos-manuais' + _k() + '" target="_blank" rel="noopener" ' +
          'style="padding:6px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;text-decoration:none">' +
          '✏️ custos manuais</a>' +
        '<button id="fcDepara" type="button">🔗 ver de-para de SKU</button>' +
        '<span id="fcInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="fcTab" style="overflow:auto"></div>' +
    '</div>';

  /* a chave da página atual, se houver — repassada só pra links do MESMO serviço */
  function _k() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('?k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

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
        /* Codex #585 (P2): 'pares' É UMA LISTA de {de, para, em}, não um mapa — eu inventei a
           forma em vez de ler o produtor, e 'Object.keys' devolveria 0,1,2…: a tabela mostraria
           ÍNDICES no lugar dos SKUs. Já vem ordenada da rota, então não reordeno. */
        var pares = Array.isArray(d.pares) ? d.pares : [];
        elInfo.textContent = pares.length ? (pares.length + ' par(es) cadastrado(s)') : 'nenhum par cadastrado';
        if (!pares.length) { elTab.innerHTML = ''; return; }
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:6px">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>SKU antigo</th><th>vira</th><th>desde</th></tr></thead><tbody>' +
          pares.map(function (pr) {
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(pr && pr.de) + '</td>' +
              '<td>' + esc(pr && pr.para) + '</td>' +
              '<td style="opacity:.65">' + esc((pr && pr.em) ? String(pr.em).slice(0, 10) : '—') + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function (e) { bt.disabled = false; elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  });
})();`;
}

module.exports = { scriptDeCusto };
