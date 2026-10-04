/* ════════════════════════════════════════════════════════════════════════════════════════
   FICHA DO PRODUTO — peça compartilhada do painel (04/10).

   Busca um SKU e mostra o HISTÓRICO DE CUSTO dele: as faixas de vigência (de quando até quando
   cada custo valeu), o custo que está no Bling hoje, o custo manual (se houver) e qual deles
   está valendo AGORA.

   Por que importa: a margem de um pedido antigo é calculada com o custo que valia NAQUELA data,
   não com o de hoje. Quando um número do painel parece errado, é aqui que se confere — e sem
   esta tela só dava pra conferir na AMB.

   ⚠️ MEDI ANTES DE ESCREVER, na GOOD: `/sku-info` NÃO É TRATADA, `/produto-fotos` exige sessão
   (não funciona pra quem abre por `?k=`) e `/config-frete-magalu` RECUSA por falta de peça.
   Nenhuma entrou — seção que nasce mostrando erro é pior que seção ausente.

   ⚠️ E uma regra de leitura que o painel inteiro segue: custo AUSENTE não vira "R$ 0,00".
   Zero diria que o produto não custa nada, e a margem sairia inflada.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaFicha(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('fichaProdutoAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function brl(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function dia(d) { return d ? String(d).slice(0, 10) : null; }

  function hojeISO() {
    /* ⚠️ Codex #612 (P2): MESMA data de negócio do backend (_hojeISO de lib/custo.js: UTC−3).
       O relógio local do navegador pode estar noutro fuso e rotular de "hoje" uma faixa que
       pro servidor ainda é amanhã — 'vigente_hoje' e o rótulo discordariam na mesma tela. */
    return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🔎 Ficha do produto ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">custo que valia em cada período</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<input id="fpSku" placeholder="SKU ou código" style="width:190px">' +
        '<button id="fpBuscar" type="button">buscar</button>' +
        '<span id="fpInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="fpTab" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('fpInfo');
  var elTab = document.getElementById('fpTab');
  var bt = document.getElementById('fpBuscar');
  var inp = document.getElementById('fpSku');
  var seq = 0;

  function buscar() {
    var sku = (inp.value || '').trim();
    if (!sku) { elInfo.textContent = '⚠️ digite o SKU'; elTab.innerHTML = ''; return; }

    var meu = ++seq;              /* clique novo descarta a resposta do anterior */
    var skuPedido = sku;          /* qual SKU esta resposta responde */
    bt.disabled = true;
    elInfo.textContent = 'buscando…';
    elTab.innerHTML = '';

    fetch(BASE + '/custo-historico?sku=' + encodeURIComponent(sku) + chave(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;   /* chegou atrasado */
        /* ⚠️ Codex #612 (P2): EDITAR O CAMPO durante a busca também invalida. Sem clicar de novo
           o 'seq' não muda, então a resposta do SKU A era desenhada embaixo de um campo que já
           diz B — e o dono atribuiria aquele custo ao produto errado, na tela que existe pra
           CONFERIR número. */
        if ((inp.value || '').trim() !== skuPedido) {
          bt.disabled = false;
          elInfo.textContent = 'o campo mudou — clique em buscar pra ver ' + esc((inp.value || '').trim());
          elTab.innerHTML = '';
          return;
        }
        bt.disabled = false;
        /* ⚠️ Codex #612 (P2): EXIGIR 'ok === true'. Com sessão não-admin ou 'k' vencida a rota
           responde 404 com '{error:'not found'}' — o 'fetch' RESOLVE, 'd.ok' é 'undefined' (não
           'false'), e a tela desenhava "sem custo"/"sem histórico" como se o SKU não tivesse
           custo. O dono concluiria que falta cadastro quando o que falta é permissão. */
        if (!d || d.ok !== true) {
          elInfo.textContent = '⚠️ ' + ((d && (d.erro || d.error)) || 'não consegui consultar — confira se a sessão/chave ainda vale');
          elTab.innerHTML = '';
          return;
        }

        var atual = brl(d.custo_atual_bling);
        var manual = brl(d.custo_manual);
        var vig = brl(d.vigente_hoje);

        elInfo.innerHTML =
          'vigente hoje: ' + (vig ? '<b>' + esc(vig) + '</b>' : '<span style="opacity:.6">sem custo</span>') +
          ' · Bling: ' + (atual ? esc(atual) : '<span style="opacity:.6">—</span>') +
          (manual ? ' · manual: ' + esc(manual) : '') +
          (d.leia ? '<div style="opacity:.7;font-size:12px;margin-top:2px">' + esc(d.leia) + '</div>' : '');

        var faixas = Array.isArray(d.faixas) ? d.faixas : [];
        if (!faixas.length) {
          /* ⚠️ sem histórico NÃO é custo zero: a margem de pedido antigo fica sem base */
          elTab.innerHTML = '<div style="opacity:.75;font-size:13px">sem histórico de custo pra este SKU — ' +
            'a margem de pedidos antigos dele fica sem base de cálculo</div>';
          return;
        }
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:6px">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>de</th><th>até</th>' +
          '<th style="text-align:right">custo</th><th>origem</th></tr></thead><tbody>' +
          faixas.map(function (f) {
            var c = brl(f.custo);
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(dia(f.de) || '—') + '</td>' +
              /* ⚠️ Codex #612 (P2): faixa ABERTA que começa no FUTURO não é "hoje" — custo manual
                 agendado era rotulado como vigente, e o dono leria um custo que ainda não vale. */
              '<td>' + (dia(f.ate) ? esc(dia(f.ate))
                        : (dia(f.de) && dia(f.de) > hojeISO() ? 'a partir de ' + esc(dia(f.de)) : 'hoje')) + '</td>' +
              '<td style="text-align:right">' + (c ? esc(c) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="opacity:.7">' + esc(f.origem || f.fonte || '') + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function (e) {
        if (meu !== seq) return;
        bt.disabled = false;
        elInfo.textContent = '⚠️ ' + ((e && e.message) || e);
      });
  }

  bt.addEventListener('click', buscar);
  inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') buscar(); });
})();`;
}

module.exports = { scriptDaFicha };
