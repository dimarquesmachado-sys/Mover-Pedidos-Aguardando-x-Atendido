/* ════════════════════════════════════════════════════════════════════════════════════════
   MANUTENÇÃO DO HISTÓRICO — peça compartilhada do painel (04/10).

   Reúne as três rotinas que mantêm o painel PRECISO, e que hoje só a AMB enxerga:

     · CUSTO (`/custo-sync?status=1`)        — quantos SKUs ainda estão sem custo. Sem custo, a
                                               margem do produto sai errada ou vazia;
     · IMPOSTO (`/reaplicar-status`)         — se a correção de alíquota já passou pelo histórico.
                                               Alíquota nova sem reaplicar = margem do mês errada;
     · DETALHES (`/completar-detalhes`)      — pedidos sem item/valor detalhado.

   Mostra o ESTADO; não dispara nada sozinho. Disparar rotina pesada é decisão do dono (cota do
   Bling é da conta, e em dia de galpão a operação perde primeiro) — por isso aqui há botão de
   atualizar, e o disparo fica onde já estava.

   Mesma forma das outras peças: gera o markup, empresa como PARÂMETRO, sem onclick inline, sem
   estado global solto. Serve às três empresas e à quarta.

   ⚠️ `/vendas-sync` NÃO entra: a GOOD não tem a peça `vendasSync`, e a rota da fábrica RECUSA
   com "esta empresa ainda não expõe". Seção que nasce mostrando recusa é pior que seção ausente.
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDaManutencao(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('manutencaoAqui');
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
      '<div class="card-tit">🧰 Manutenção do histórico ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que mantém a margem correta</span>' +
        '<button id="mtAtualizar" type="button" style="float:right">↻ atualizar</button></div>' +
      '<div id="mtCorpo" style="display:grid;gap:10px;margin-top:8px"></div>' +
    '</div>';

  var elCorpo = document.getElementById('mtCorpo');
  var bt = document.getElementById('mtAtualizar');

  /* cada linha: rótulo, rota, e como LER a resposta — o texto diz o que fazer, não só o número */
  var LINHAS = [
    { id: 'custo', rotulo: '💰 Custo dos produtos', rota: '/custo-sync?status=1',
      leia: function (d) {
        if (!d || d.ok === false) return { aviso: true, txt: (d && d.erro) || 'não consegui consultar' };
        if (d.rodando) return { txt: 'rodando agora — ' + esc(d.progresso || '') };
        /* ⚠️ o status do custo-sync NÃO conta SKU sem custo: "falhas" são consultas que falharam, e
           produto achado no Bling sem custo positivo entra em "ok". Só afirmo "sem custo" se a rota
           trouxer sem_custo; senão digo só o que sei — nunca "todos com custo". (Sem crase aqui: isto
           mora dentro de um template literal.) */
        if (d.sem_custo != null && isFinite(Number(d.sem_custo)) && Number(d.sem_custo) > 0) {
          return { aviso: true, txt: Number(d.sem_custo) + ' SKU(s) ainda sem custo — a margem deles sai errada ou vazia' };
        }
        var fl = Number(d.falhas || 0);
        if (fl > 0) return { aviso: true, txt: fl + ' consulta(s) de custo falharam na última rodada — a margem desses SKUs pode estar incompleta' };
        return { txt: 'última rodada sem falhas (a contagem de SKU sem custo no Bling não é exposta aqui)' };
      } },
    { id: 'imposto', rotulo: '🧾 Imposto reaplicado', rota: '/reaplicar-status',
      leia: function (d) {
        var s = (d && d.status) || {};
        if (!d || d.ok === false) return { aviso: true, txt: (d && d.erro) || 'não consegui consultar' };
        /* msg/erros são como a rotina conta que NÃO conseguiu (ex.: Supabase não configurado):
           mostrar "nada pendente" aí esconde margem do mês ainda com o imposto antigo */
        var nErr = Number(s.erros || 0);
        if (!s.rodando && (nErr > 0 || (s.msg && String(s.msg).trim()))) {
          return { aviso: true, txt: (nErr > 0 ? nErr + ' erro(s) ao reaplicar' : 'reaplicação com problema') +
            (s.msg ? ' — ' + esc(s.msg) : '') + (Array.isArray(s.meses) && s.meses.length ? ' (meses: ' + esc(s.meses.join(', ')) + ')' : '') };
        }
        if (s.rodando) return { txt: 'reaplicando agora' + (s.mesAtual ? ' — ' + esc(s.mesAtual) : '') };
        if (Array.isArray(s.fila) && s.fila.length) {
          return { aviso: true, txt: s.fila.length + ' mês(es) na fila: ' + esc(s.fila.join(', ')) };
        }
        if (Array.isArray(s.meses) && s.meses.length) return { txt: 'último: ' + esc(s.meses.join(', ')) };
        return { txt: 'nada pendente' };
      } },
    /* /completar-detalhes NÃO tem modo status: exige de/ate e responde 400 sem eles. Sem fonte real
       de estado, a linha é só orientação (rota: null → não faz fetch nem inventa "sem pendência"). */
    { id: 'detalhes', rotulo: '📦 Detalhes dos pedidos', rota: null,
      leia: function () { return { txt: 'sem status próprio — complete pelo período no card de backfill' }; } },
  ];

  function pinta(id, rotulo, estado) {
    var cor = estado.aviso ? 'rgba(220,160,40,.45)' : 'rgba(128,128,128,.3)';
    var fundo = estado.aviso ? 'rgba(220,160,40,.10)' : 'transparent';
    return '<div id="mt-' + id + '" style="display:flex;justify-content:space-between;gap:10px;' +
      'align-items:center;padding:8px 10px;border:1px solid ' + cor + ';border-radius:8px;background:' + fundo + '">' +
      '<b style="font-size:13px">' + rotulo + '</b>' +
      '<span style="font-size:13px;opacity:.85;text-align:right">' + estado.txt + '</span></div>';
  }

  function carregar() {
    bt.disabled = true;
    elCorpo.innerHTML = LINHAS.map(function (l) {
      return pinta(l.id, l.rotulo, { txt: 'carregando…' });
    }).join('');

    var pendentes = LINHAS.length;
    LINHAS.forEach(function (l) {
      if (!l.rota) {
        var e0 = document.getElementById('mt-' + l.id);
        if (e0) e0.outerHTML = pinta(l.id, l.rotulo, l.leia(null));
        if (--pendentes <= 0) bt.disabled = false;
        return;
      }
      /* UM delimitador só: '&' se a rota já tem query, '?' se não (antes saía "??k=" e o guard dava 401) */
      var k = chave();
      var url = BASE + l.rota + (k ? (l.rota.indexOf('?') >= 0 ? '&' : '?') + k.slice(1) : '');
      fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var el = document.getElementById('mt-' + l.id);
          if (el) el.outerHTML = pinta(l.id, l.rotulo, l.leia(d));
        })
        .catch(function (e) {
          var el = document.getElementById('mt-' + l.id);
          if (el) el.outerHTML = pinta(l.id, l.rotulo, { aviso: true, txt: 'não consegui falar com o servidor' });
        })
        .then(function () { if (--pendentes <= 0) bt.disabled = false; });
    });
  }

  bt.addEventListener('click', carregar);
  carregar();
})();`;
}

module.exports = { scriptDaManutencao };
