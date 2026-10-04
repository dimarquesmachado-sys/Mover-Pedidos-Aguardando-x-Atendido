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

  /* Codex #614 (P1): o período é o que o dashboard ESTÁ mostrando — janela(PERIODO), que cobre
     Hoje/Ontem/7d/Ano/Escolher. Cair no "mês corrente" quando não acho isso atribuiria o resultado
     à janela errada; sem período legível, recuso (null) em vez de adivinhar. */
  function periodo() {
    try {
      if (typeof janela === 'function' && typeof PERIODO !== 'undefined') {
        var j = janela(PERIODO);
        if (j && /^\\d{4}-\\d{2}-\\d{2}$/.test(j.de) && /^\\d{4}-\\d{2}-\\d{2}$/.test(j.ate)) return { de: j.de, ate: j.ate };
      }
    } catch (e) {}
    var de = document.getElementById('de'), ate = document.getElementById('ate');
    if (de && ate && de.value && ate.value) return { de: de.value, ate: ate.value };
    return null;
  }
  function chavePeriodo(p) { return p ? (p.de + '|' + p.ate) : ''; }

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
  var checado = '';   // período a que o resultado na tela se refere

  /* Codex #614 (P2): trocar o período do dashboard recarrega os cards mas não passa por aqui; sem
     isto, o aviso (ou o "limpo") de um intervalo ficaria ao lado dos totais de outro. Invalida
     também a conferência em voo, cuja resposta seria de outra janela. */
  setInterval(function () {
    if (checado && chavePeriodo(periodo()) !== checado) {
      checado = ''; seq++; bt.disabled = false;
      elCorpo.innerHTML = 'período mudou — clique em conferir';
    }
  }, 400);

  bt.addEventListener('click', function () {
    var p = periodo();
    if (!p) {
      elCorpo.innerHTML = '⚠️ não consegui ler o período da tela — nada foi conferido';
      return;
    }
    var meu = ++seq;
    checado = chavePeriodo(p);
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
        var jaMarc = Array.isArray(d.ja_marcados) ? d.ja_marcados : [];
        /* Codex #614 (P2): o total é cancelados_agora; numeros vem cortado em 30 pelo servidor */
        var totalAchados = Math.max(Number(d.cancelados_agora || 0), achados.length);
        var totalJa = Math.max(Number(d.ja_marcados_total || 0), jaMarc.length);
        var partes = [];
        partes.push('<div style="opacity:.7;margin-bottom:6px">período conferido: ' + esc(p.de) + ' a ' + esc(p.ate) + '</div>');

        if (totalAchados) {
          partes.push('<div style="padding:8px 10px;border:1px solid rgba(220,70,70,.45);' +
            'background:rgba(220,70,70,.10);border-radius:8px">' +
            '<b>' + totalAchados + ' pedido(s) cancelado(s) no marketplace</b> e ainda contados como venda: ' +
            esc(achados.slice(0, 40).join(', ')) + (totalAchados > achados.length ? ' … (lista parcial: mostrando ' + achados.length + ' de ' + totalAchados + ')' : '') +
            '<div style="opacity:.8;margin-top:3px">enquanto não forem abatidos, o faturamento e a ' +
            'margem do período estão INFLADOS</div></div>');
        }
        /* Codex #614 (P1): cancelamento achado numa conferência anterior continua aparecendo — os
           cards vêm do Supabase (/historico-longo), que não lê esta marca; sumir daqui seria
           declarar o período limpo com o total ainda inflado. */
        if (totalJa) {
          partes.push('<div style="margin-top:6px;padding:8px 10px;border:1px solid rgba(220,70,70,.45);' +
            'background:rgba(220,70,70,.10);border-radius:8px">' +
            '<b>' + totalJa + ' cancelamento(s) já detectado(s) antes</b>: ' + esc(jaMarc.join(', ')) +
            (totalJa > jaMarc.length ? ' …' : '') +
            '<div style="opacity:.8;margin-top:3px">os totais dos cards vêm do histórico e podem ainda contá-los</div></div>');
        }
        if (!totalAchados && !totalJa) {
          /* ⚠️ Zero candidatos NÃO é "limpo": a varredura parte do índice local de vendas, e a GOOD
             pode não ter nenhum. Sem isto o painel anunciaria limpeza sem ter olhado pedido algum. */
          if (Number(d.candidatos || 0) === 0) {
            partes.push('<div style="padding:7px 10px;border:1px solid rgba(220,160,40,.45);' +
              'background:rgba(220,160,40,.10);border-radius:8px">⚠️ nenhum pedido deste período estava no ' +
              'índice local de vendas — <b>nada foi conferido</b>. Isto não quer dizer que não há cancelamento.</div>');
          } else {
            partes.push('<div>nenhum cancelamento pendente nos canais conferidos</div>');
          }
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
