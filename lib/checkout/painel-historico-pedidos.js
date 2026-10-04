/* ════════════════════════════════════════════════════════════════════════════════════════
   HISTÓRICO DE PEDIDOS — peça compartilhada do painel (04/10).

   Lista os pedidos do período com canal, valor, custo e margem, direto de `/historico-linhas` —
   a mesma rota que a AMB usa. É a seção que responde "quais pedidos formaram esse número": sem
   ela, o painel da GOOD mostrava totais sem como abrir.

   PAGINADO de propósito (200 por página, como na AMB): puxar o período inteiro de uma vez em
   empresa com volume trava a tela e pesa no banco.

   ⚠️ Três cuidados que vêm de erro cometido aqui no repositório:
     · a página que FALHOU não pode fazer o botão repetir a anterior — guardo o que foi TENTADO;
     · `catch` vazio deixa a tela em "carregando" pra sempre (foi apontado no PR #131 da AMB);
     · valor/custo/margem AUSENTES não viram "R$ 0,00": zero mente sobre a margem.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDoHistorico(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('historicoPedidosAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function brl(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function pct(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;
    return Number(v).toFixed(1) + '%';
  }

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
      '<div class="card-tit">📜 Histórico de pedidos ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">quais pedidos formaram o número</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<button id="hpCarregar" type="button">carregar período</button>' +
        '<button id="hpAnterior" type="button" disabled>‹ anterior</button>' +
        '<button id="hpProxima" type="button" disabled>próxima ›</button>' +
        '<span id="hpInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="hpTab" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('hpInfo');
  var elTab = document.getElementById('hpTab');
  var btCarregar = document.getElementById('hpCarregar');
  var btAnt = document.getElementById('hpAnterior');
  var btProx = document.getElementById('hpProxima');

  var LIM = 200;
  var pagina = 1;
  var seq = 0;

  function botoes(ligados, temProxima) {
    btCarregar.disabled = !ligados;
    btAnt.disabled = !ligados || pagina <= 1;
    btProx.disabled = !ligados || !temProxima;
  }

  function carregar(n) {
    var p = periodo();
    /* ⚠️ guardo o que foi TENTADO, não o que deu certo: se a página 2 falhar, "próxima" não pode
       voltar a trazer a página 1 como se nada tivesse acontecido. */
    var tentada = Math.max(1, Number(n) || 1);
    var meu = ++seq;

    botoes(false, false);
    elInfo.textContent = 'carregando página ' + tentada + '…';

    var url = BASE + '/historico-linhas?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate) +
              '&pagina=' + tentada + '&lim=' + LIM + chave();

    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;                     /* resposta atrasada */
        if (!d || d.ok !== true) {
          /* ⚠️ 'ok' ausente é FALHA, não lista vazia: 404 por sessão/chave vencida resolve o
             fetch e entraria aqui como se o período não tivesse pedido nenhum. */
          elInfo.textContent = '⚠️ ' + ((d && (d.erro || d.error)) || 'não consegui carregar');
          elTab.innerHTML = '';
          botoes(true, false);
          return;
        }
        pagina = tentada;                            /* só agora a página vigente mudou */
        var ps = Array.isArray(d.pedidos) ? d.pedidos : (Array.isArray(d.itens) ? d.itens : []);
        var temProx = ps.length >= LIM;
        elInfo.textContent = 'página ' + pagina + ' · ' + ps.length + ' pedido(s)' +
          (d.total != null ? ' de ' + d.total : '') + ' · ' + p.de + ' a ' + p.ate;
        botoes(true, temProx);

        if (!ps.length) {
          elTab.innerHTML = '<div style="opacity:.75;font-size:13px">nenhum pedido neste período</div>';
          return;
        }
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:6px">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>pedido</th><th>data</th><th>canal</th>' +
          '<th style="text-align:right">valor</th><th style="text-align:right">custo</th>' +
          '<th style="text-align:right">margem</th></tr></thead><tbody>' +
          ps.map(function (o) {
            var v = brl(o.valor != null ? o.valor : o.total);
            var c = brl(o.custo);
            var m = pct(o.margem != null ? o.margem : o.margem_pct);
            var semCusto = (c == null);
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(o.numero || o.pedido || o.id || '—') + '</td>' +
              '<td>' + esc(String(o.data || o.data_venda || '').slice(0, 10)) + '</td>' +
              '<td>' + esc(o.canal || o.marketplace || '') + '</td>' +
              '<td style="text-align:right">' + (v ? esc(v) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right">' + (c ? esc(c) : '<span style="opacity:.6" title="sem custo: a margem deste pedido não dá pra calcular">—</span>') + '</td>' +
              '<td style="text-align:right">' + (semCusto ? '<span style="opacity:.6">—</span>' : esc(m || '—')) + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function (e) {
        if (meu !== seq) return;
        /* ⚠️ nunca deixar o catch vazio: a tela ficaria em "carregando" pra sempre (PR #131) */
        elInfo.textContent = '⚠️ ' + ((e && e.message) || e);
        botoes(true, false);
      });
  }

  btCarregar.addEventListener('click', function () { carregar(1); });
  btAnt.addEventListener('click', function () { carregar(pagina - 1); });
  btProx.addEventListener('click', function () { carregar(pagina + 1); });
})();`;
}

module.exports = { scriptDoHistorico };
