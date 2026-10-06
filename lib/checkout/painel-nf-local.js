/* ════════════════════════════════════════════════════════════════════════════════════════
   PEDIDOS QUE GANHAM DADOS DA NOTA — peça compartilhada do painel (05/10).

   Lê as notas já baixadas em disco e preenche produtos e frete EXATOS nos pedidos que estão sem
   esses dados. Sem isso, a margem desses pedidos sai de estimativa, não da nota.

   ⚠️ LEITURA LOCAL, SEM API: o próprio handler diz — "leitura local, sem API". Por isso esta
   seção pode rodar a qualquer hora, inclusive com o galpão operando: não consome cota do Bling.
   É a diferença entre ela e as rotinas de sync, que ficam fora do painel de propósito.

   ⚠️ O BOTÃO É EXPLÍCITO, NÃO AUTOMÁTICO: a rota ALTERA dados (preenche pedidos). Seção que
   dispara escrita sozinha ao abrir a tela é o tipo de coisa que ninguém pede e todo mundo
   descobre tarde. Aqui o dono clica.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaNfLocal(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('nfLocalAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🧾 Completar pedidos pela nota ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">produtos e frete EXATOS, lendo as notas já baixadas</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<span style="font-size:13px;opacity:.75">últimos</span>' +
        '<select id="nfDias">' +
          '<option value="15">15 dias</option>' +
          '<option value="45" selected>45 dias</option>' +
          '<option value="90">90 dias</option>' +
        '</select>' +
        '<button id="nfRodar" type="button">conferir e completar</button>' +
      '</div>' +
      '<div id="nfInfo" style="font-size:13px;opacity:.85">' +
        'lê as notas que já estão em disco — <b>não consulta o Bling</b>, então pode rodar a qualquer hora' +
      '</div>' +
    '</div>';

  var sel = document.getElementById('nfDias');
  var bt = document.getElementById('nfRodar');
  var elInfo = document.getElementById('nfInfo');
  var seq = 0;

  bt.addEventListener('click', function () {
    var meu = ++seq;
    var dias = Number(sel.value) || 45;
    bt.disabled = true;
    elInfo.textContent = 'conferindo os últimos ' + dias + ' dias…';

    fetch(BASE + '/backfill-nf?dias=' + encodeURIComponent(dias) + chave(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        bt.disabled = false;
        /* ⚠️ 'ok' ausente é FALHA, não 'nada a fazer': 404 por chave vencida resolveria o fetch e
           viraria 'nada novo a preencher' — o dono acharia que conferiu e não conferiu nada. */
        if (!d || d.ok !== true) {
          elInfo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui conferir — veja se a sessão/chave ainda vale');
          return;
        }

        var preenchidos = Number(d.preenchidos_pela_nf || 0);
        var candidatos = Number(d.candidatos || 0);

        if (preenchidos > 0) {
          elInfo.innerHTML = '<div style="padding:8px 10px;border:1px solid rgba(46,125,50,.45);' +
            'background:rgba(46,125,50,.10);border-radius:8px">' +
            '<b>' + preenchidos + ' pedido(s)</b> ganharam produtos e frete EXATOS da nota' +
            '<div style="opacity:.8;margin-top:3px">a margem deles deixa de ser estimativa</div></div>';
          return;
        }

        /* ⚠️ 'nada preenchido' tem DOIS significados muito diferentes, e dizer só "nada novo"
           esconde o segundo: ou está tudo completo, ou não havia nota em disco pra ler. */
        if (candidatos > 0) {
          elInfo.innerHTML = '<div style="padding:8px 10px;border:1px solid rgba(220,160,40,.45);' +
            'background:rgba(220,160,40,.10);border-radius:8px">' +
            '⚠️ ' + candidatos + ' pedido(s) ainda sem produtos/frete da nota, e NENHUM foi preenchido' +
            '<div style="opacity:.8;margin-top:3px">a nota desses pedidos ainda não está em disco — ' +
            'a margem deles segue por estimativa</div></div>';
          return;
        }
        elInfo.textContent = '✓ nenhum pedido pendente nos últimos ' + dias + ' dias';
      })
      .catch(function (e) {
        if (meu !== seq) return;
        bt.disabled = false;
        elInfo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  });
})();`;
}

module.exports = { scriptDaNfLocal };
