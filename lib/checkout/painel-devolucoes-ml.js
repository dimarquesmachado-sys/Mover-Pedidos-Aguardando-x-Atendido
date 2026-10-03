/* ════════════════════════════════════════════════════════════════════════════
   DEVOLUÇÕES DO MERCADO LIVRE no painel — peça compartilhada (02/10).

   Mesmo desenho que deu certo no Plano de Compra (#582/#583): a seção é ESCRITA aqui contra a
   resposta real da rota `/ml-devolucoes`, com a empresa como parâmetro, e servida como script.
   Nada de extrair do painel da AMB — ele monta a tela concatenando strings dentro do JS, e
   tentar recortar daquilo foi o que me custou o #581 inteiro.

   Campos que a rota devolve (lib/ml-devolucoes.js → resumoDevolucoesML): quantidade,
   valor_devolvido, custo_retorno_informado, nao_concretizadas, ainda_com_dinheiro_retido,
   reclamacoes_sem_devolucao, por_motivo, por_status, por_sku.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDasDevolucoes(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('devolucoesMlAqui');
  if (!alvo) return;

  var carregando = false, seq = 0;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function brl(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { return (Number(v) || 0).toLocaleString('pt-BR'); }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">↩️ Devoluções do Mercado Livre ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">do período escolhido acima</span></div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin:8px 0">' +
        '<button id="dvCalc" type="button">carregar</button>' +
        '<span id="dvInfo" style="font-size:13px;opacity:.75">clique em carregar</span>' +
      '</div>' +
      '<div id="dvTab" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('dvInfo');
  var elTab = document.getElementById('dvTab');
  var bt = document.getElementById('dvCalc');

  /* usa o MESMO período que o resto do painel já escolheu, em vez de inventar outro:
     a tela guarda de/ate nos campos do seletor de período */
  function periodo() {
    var de = (document.getElementById('de') || {}).value;
    var ate = (document.getElementById('ate') || {}).value;
    return { de: de || '', ate: ate || '' };
  }

  function bloco(titulo, pares) {
    var linhas = Object.keys(pares || {}).map(function (k) { return [k, pares[k]]; })
      .sort(function (x, y) { return (Number(y[1]) || 0) - (Number(x[1]) || 0); });
    if (!linhas.length) return '';
    return '<div style="margin-top:10px"><b style="font-size:13px">' + titulo + '</b>' +
      '<table style="width:100%;font-size:13px;margin-top:4px"><tbody>' +
      linhas.map(function (l) {
        return '<tr><td style="padding:2px 0">' + esc(l[0] || 'sem motivo') + '</td>' +
          '<td style="text-align:right">' + num(l[1]) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function carregar() {
    var meu = ++seq;
    carregando = true;
    if (bt) { bt.disabled = true; bt.textContent = 'carregando…'; }
    var solta = function () { if (bt) { bt.disabled = false; bt.textContent = 'carregar'; } };
    var p = periodo();
    elInfo.textContent = '⏳ consultando as reclamações do ML…';
    fetch(BASE + '/ml-devolucoes' + (p.de ? ('?de=' + p.de + '&ate=' + p.ate) : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        carregando = false; solta();
        /* a rota recusa explicando quando falta peça (token do ML) — mostrar o motivo é melhor
           que tabela vazia, que pareceria "não teve devolução" */
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui carregar'); elTab.innerHTML = ''; return; }
        elInfo.textContent = num(d.quantidade) + ' devolução(ões) · ' + brl(d.valor_devolvido) + ' devolvidos' +
          (d.custo_retorno_informado ? ' · ' + brl(d.custo_retorno_informado) + ' de frete de retorno' : '') +
          (d.ainda_com_dinheiro_retido ? ' · ' + num(d.ainda_com_dinheiro_retido) + ' com dinheiro ainda retido' : '') +
          (d.reclamacoes_sem_devolucao ? ' · ' + num(d.reclamacoes_sem_devolucao) + ' reclamação(ões) sem retorno físico' : '');
        elTab.innerHTML = bloco('por motivo', d.por_motivo) + bloco('por status', d.por_status);
      })
      .catch(function (e) { if (meu !== seq) return; carregando = false; solta(); elTab.innerHTML = '';
        elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  }

  bt.addEventListener('click', carregar);
})();`;
}

module.exports = { scriptDasDevolucoes };
