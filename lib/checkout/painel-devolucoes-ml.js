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

  /* usa o MESMO período que o resto do painel já escolheu, em vez de inventar outro. O estado
     do painel da GOOD é PERIODO + janela() (e P_DE/P_ATE no "custom"); não existem campos
     #de/#ate. Os dois vivem em script clássico, então enxergam-se daqui. */
  function periodo() {
    try {
      if (typeof janela === 'function' && typeof PERIODO !== 'undefined') {
        var j = janela(PERIODO);
        if (j && j.de && j.ate) return { de: j.de, ate: j.ate };
      }
    } catch (e) {}
    /* AMB e Girassol guardam o período em intervalo() (de/ate), não em janela(PERIODO) */
    try {
      if (typeof intervalo === 'function') {
        var i = intervalo();
        if (i && i.de && i.ate) return { de: i.de, ate: i.ate };
      }
    } catch (e) {}
    return { de: '', ate: '' };
  }
  function dmy(iso) { return String(iso || '').slice(0, 10).split('-').reverse().join('/'); }

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

  /* por SKU: a embutida da AMB/Girassol lista os 10 que mais voltaram — sem isso o dono perde
     de vista QUAL produto está puxando a devolução */
  function blocoSku(lista, total) {
    var sk = (lista || []).slice(0, 10);
    if (!sk.length) return '';
    var tot = Number(total || 0) || 1;
    return '<table style="width:100%;margin-top:10px;font-size:13px"><thead><tr>' +
      '<th style="text-align:left">SKU que mais voltou</th><th style="text-align:right">un.</th>' +
      '<th style="text-align:right">R$ que voltou</th><th style="text-align:right">% do total</th></tr></thead><tbody>' +
      sk.map(function (x) {
        return '<tr><td title="' + esc(x.nome) + '">' + esc(x.sku) + '</td>' +
          '<td style="text-align:right">' + num(x.qtd) + '</td>' +
          '<td style="text-align:right">' + brl(x.valor) + '</td>' +
          '<td style="text-align:right;opacity:.7">' + (Math.round((Number(x.valor) || 0) / tot * 1000) / 10) + '%</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* 09/10 — CACHE POR PERIODO e CARGA AUTOMATICA. A tela embutida da AMB/Girassol ja faz as
     duas (medido em docs/paridade-pecas.md): carrega sozinha ao trocar o periodo e guarda o que
     ja consultou. Sem isso a peca entregaria MENOS — o dono clicaria a cada troca e esperaria
     de novo pelo mesmo dado. */
  var cache = {};

  /* o desenho era INLINE no .then, entao o cache nao tinha como reusa-lo. Virou funcao: quem
     vem do cache e quem vem da rede desenham pelo MESMO caminho. */
  function aplicar(d, p) {
        /* a rota recusa explicando quando falta peça (token do ML) — mostrar o motivo é melhor
           que tabela vazia, que pareceria "não teve devolução" */
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui carregar'); elTab.innerHTML = ''; return; }
        /* cache nunca coletado: zero ali NÃO é "sem devolução"; coleta velha também merece aviso */
        var ok = d.coleta_ok_em ? new Date(d.coleta_ok_em) : null;
        if (!ok || isNaN(ok.getTime())) {
          elInfo.textContent = '⚠️ as devoluções do ML ainda não foram coletadas — zero aqui não significa que não houve devolução';
          elTab.innerHTML = ''; return;
        }
        var aviso = (Date.now() - ok.getTime()) > 36 * 3600 * 1000
          ? ' · ⚠️ última coleta com sucesso em ' + dmy(d.coleta_ok_em) + ' — pode estar desatualizado' : '';
        elInfo.textContent = dmy(p.de) + ' → ' + dmy(p.ate) + ': ' + num(d.quantidade) + ' devolução(ões) · ' + brl(d.valor_devolvido) + ' devolvidos' +
          (d.custo_retorno_informado ? ' · ' + brl(d.custo_retorno_informado) + ' de frete de retorno' : '') +
          (d.ainda_com_dinheiro_retido ? ' · ' + num(d.ainda_com_dinheiro_retido) + ' com dinheiro ainda retido' : '') +
          (d.reclamacoes_sem_devolucao ? ' · ' + num(d.reclamacoes_sem_devolucao) + ' reclamação(ões) sem retorno físico' : '') +
          (d.nao_concretizadas ? ' · ' + num(d.nao_concretizadas) + ' não concretizada(s) (expirada/cancelada: o ML devolveu o dinheiro, ficam fora do total)' : '') + aviso +
          /* como a embutida: a data da coleta aparece SEMPRE, não só quando passa de 36h */
          ' · ML atualizado em ' + dmy(d.atualizado || d.coleta_ok_em);
        elTab.innerHTML = bloco('por motivo', d.por_motivo) + bloco('por status', d.por_status) + blocoSku(d.por_sku, d.valor_devolvido);
  }

  /* devolve true quando tratou o período (pintou, pediu ou avisou) e false quando adiou por
     haver outra consulta em voo — o automático só marca o período como visto no true */
  function carregar(auto) {
    var p = periodo();
    var ck = String(p.de) + '|' + String(p.ate);
    if (cache[ck]) { pintar(cache[ck], p); return true; }
    if (auto && carregando) return false;
    var meu = ++seq;
    carregando = true;
    if (bt) { bt.disabled = true; bt.textContent = 'carregando…'; }
    var solta = function () { if (bt) { bt.disabled = false; bt.textContent = 'carregar'; } };
    /* sem período a rota recusa (400) — melhor dizer do que pedir sem datas */
    if (!p.de || !p.ate) {
      carregando = false; solta();
      elTab.innerHTML = ''; elInfo.textContent = '⚠️ não consegui ler o período do painel';
      return true;
    }
    elInfo.textContent = '⏳ consultando as reclamações do ML…';
    fetch(BASE + '/ml-devolucoes?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        carregando = false; solta();
        /* cache sob a chave do que foi PEDIDO: o painel pode ter trocado de período no meio */
        if (d && d.ok) cache[ck] = d;
        aplicar(d, p);
      })
      .catch(function (e) { if (meu !== seq) return; carregando = false; solta(); elTab.innerHTML = '';
        elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
    return true;
  }

  /* pintar: reaproveita o cache pelo MESMO caminho do desenho. ++seq invalida a consulta em voo,
     então também solta o botão — senão ficaria em "carregando…" pra sempre. */
  function pintar(d, p) {
    ++seq;
    carregando = false;
    if (bt) { bt.disabled = false; bt.textContent = 'carregar'; }
    aplicar(d, p);
  }

  bt.addEventListener('click', function () { carregar(false); });

  /* carrega sozinha ao abrir e quando o periodo do painel muda — e o que a tela embutida faz.
     O painel nao emite evento de periodo, entao observo o periodo num intervalo. ⚠️ Ele nao pode
     viver pra sempre (travou a bateria da casa e, em producao, seguiria consultando o ML depois
     de a secao sair da tela): se encerra sozinho quando o alvo sai do documento e fica quieto
     enquanto a aba esta oculta. */
  (function () {
    var visto = '';
    var timer = null;
    var olhar = function () {
      if (alvo.isConnected === false) { if (timer !== null) clearInterval(timer); return; }
      if (typeof document !== 'undefined' && document.hidden) return;
      var p = periodo();
      var ck = String(p.de) + '|' + String(p.ate);
      if (!p.de || !p.ate || ck === visto) return;
      if (carregar(true)) visto = ck;
    };
    olhar();
    timer = setInterval(olhar, 1500);
  })();
})();`;
}

module.exports = { scriptDasDevolucoes };
