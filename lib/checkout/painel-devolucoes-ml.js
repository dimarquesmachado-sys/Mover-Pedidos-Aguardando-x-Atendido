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
  var _timer = null;

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
  function solta() { if (bt) { bt.disabled = false; bt.textContent = 'carregar'; } }

  /* usa o MESMO período que o resto do painel já escolheu, em vez de inventar outro. O estado
     do painel da GOOD é PERIODO + janela() (e P_DE/P_ATE no "custom"); o da AMB e da Girassol é
     intervalo() (minúsculo, lê o periodo delas). Não existem campos #de/#ate. Tudo vive em
     script clássico, então enxerga-se daqui. */
  function periodo() {
    try {
      if (typeof janela === 'function' && typeof PERIODO !== 'undefined') {
        var j = janela(PERIODO);
        if (j && j.de && j.ate) return { de: j.de, ate: j.ate };
      }
    } catch (e) {}
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

  /* "SKU que mais voltou": a tela embutida da AMB/Girassol mostra os 10 primeiros com unidades,
     valor e % do total — sem isto a troca esconderia a pergunta "o que está voltando?" */
  function blocoSku(d) {
    var sk = (d.por_sku || []).slice(0, 10);
    if (!sk.length) return '';
    var tot = Number(d.valor_devolvido || 0) || 1;
    return '<div style="margin-top:10px"><b style="font-size:13px">SKU que mais voltou</b>' +
      '<table style="width:100%;font-size:13px;margin-top:4px"><thead><tr>' +
      '<th style="text-align:left">SKU</th><th style="text-align:right">un.</th>' +
      '<th style="text-align:right">R$ que voltou</th><th style="text-align:right">% do total</th></tr></thead><tbody>' +
      sk.map(function (s) {
        return '<tr><td style="padding:2px 0" title="' + esc(s.nome) + '">' + esc(s.sku) + '</td>' +
          '<td style="text-align:right">' + num(s.qtd) + '</td>' +
          '<td style="text-align:right">' + brl(s.valor) + '</td>' +
          '<td style="text-align:right;opacity:.7">' + (Math.round((Number(s.valor) || 0) / tot * 1000) / 10) + '%</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  var _cache = {};   /* por 'de|ate', como a embutida faz com '_dmlCache' */
  function carregar(forcar) {
    var meu = ++seq;
    carregando = true;
    if (bt) { bt.disabled = true; bt.textContent = 'carregando…'; }
    var p = periodo();
    /* sem período a rota recusa (400) — melhor dizer do que pedir sem datas */
    if (!p.de || !p.ate) {
      carregando = false; solta();
      elTab.innerHTML = ''; elInfo.textContent = '⚠️ não consegui ler o período do painel';
      return;
    }
    /* cache por período: trocar e voltar não refaz a consulta. 'forcar' (o botão) sempre refaz,
       porque é o jeito do dono pedir dado fresco. */
    var _ck = p.de + '|' + p.ate;
    if (!forcar && _cache[_ck]) {
      carregando = false; solta();
      _desenhar(_cache[_ck], p);
      return;
    }
    elInfo.textContent = '⏳ consultando as reclamações do ML…';
    fetch(BASE + '/ml-devolucoes?de=' + encodeURIComponent(p.de) + '&ate=' + encodeURIComponent(p.ate), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        carregando = false; solta();
        if (!d || d.ok !== true) { elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + ((d && (d.erro || d.error)) || 'não consegui carregar as devoluções do ML'); return; }
        _cache[_ck] = d;
        _desenhar(d, p);
      })
      .catch(function (e) { if (meu !== seq) return; carregando = false; solta(); elTab.innerHTML = '';
        elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  }

  bt.addEventListener('click', function () { carregar(true); });

  /* ⚠️ 09/10 — CACHE POR PERÍODO e CARGA AUTOMÁTICA, pra não entregar menos que a tela embutida
     da AMB/Girassol (medido em docs/paridade-pecas.md). Lá a seção carrega SOZINHA ao trocar o
     período e guarda o resultado por 'de|ate'; aqui o dono tinha de clicar "carregar" toda vez e
     esperar de novo pelo mesmo período. Isso é mais lento de USAR do que hoje — regressão que
     ninguém chamaria de regressão, porque "a função continua existindo".
     Vigio o período em vez de depender de um evento: cada tela chama o seu (PERIODO, janela(),
     P_DE/P_ATE), e amarrar num deles quebraria nas outras. */
  /* o desenho vive numa função só, pra o cache mostrar exatamente o mesmo que a consulta */
  function _desenhar(d, p) {
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
          (d.nao_concretizadas ? ' · ' + num(d.nao_concretizadas) + ' não concretizada(s) (expirada/cancelada: o ML devolveu o dinheiro, ficam fora do total)' : '') + aviso;
        elTab.innerHTML = bloco('por motivo', d.por_motivo) + bloco('por status', d.por_status) + blocoSku(d);
  }

  var _ultimoPeriodo = '';
  function _vigiar() {
    /* a seção saiu da tela (painel remontado): para de vigiar, senão o timer vive pra sempre */
    if (alvo.isConnected === false) { clearInterval(_timer); return; }
    var iv = periodo();
    var ck = String(iv && iv.de) + '|' + String(iv && iv.ate);
    if (ck === _ultimoPeriodo) return;
    _ultimoPeriodo = ck;
    carregar(false);   /* false: aproveita o cache se já vi este período */
  }
  _vigiar();
  _timer = setInterval(_vigiar, 1500);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();   /* não segura um processo Node que exercite o script */
})();`;
}

module.exports = { scriptDasDevolucoes };
