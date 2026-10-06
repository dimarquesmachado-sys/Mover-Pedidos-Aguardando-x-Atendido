/* ════════════════════════════════════════════════════════════════════════════════════════
   PREVISÃO DE VENDAS POR PRODUTO — peça compartilhada do painel (05/10).

   Mostra, por SKU: quanto vendeu na base escolhida, a tendência (últimos 30 dias contra os 30
   anteriores) e quanto deve sair em 1 semana, 1 mês e 3 meses, mantido o ritmo.

   É a seção que responde "o que comprar e quanto" — e a GOOD era a única das três sem ela,
   embora a rota `/previsao-vendas` JÁ RESPONDA lá: vem de `rotasHistorico`, que a GOOD monta. O
   que faltava era só a tela.

   ⚠️ TENDÊNCIA SÓ COM BASE SUFICIENTE: comparar 30 dias contra os 30 anteriores exige pelo menos
   60 dias de histórico. Com base menor a comparação não existe — e mostrar uma seta de tendência
   calculada sobre meio período seria inventar informação de compra.

   ⚠️ E "SEM DADO" NÃO VIRA ZERO: SKU sem venda na base não aparece como "vai vender 0" — isso
   diria "não compre", quando o certo é "não há base pra dizer".
   ════════════════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ⚠️ A BASE PADRÃO É POR EMPRESA, não global. A AMB usa 180 dias (90 não cobre sazonalidade de
   compra); a GOOD nasceu com 90 e NINGUÉM pediu pra mudar. Quando a peça tinha um `baseDias`
   fixo, nivelar a AMB por cima mudou a GOOD em silêncio — e previsão de compra que muda sozinha
   é exatamente o tipo de alteração que ninguém procura, porque a tela continua funcionando.
   Quem chama escolhe; o padrão da peça (180) vale só pra quem não disser nada. */
function scriptDaPrevisao(base, opcoes) {
  const BASE = JSON.stringify(String(base || ''));
  /* ⚠️ a faixa é a mesma do campo livre (15 a 730): valor fora disso viraria consulta inútil */
  const _bp = Number((opcoes && opcoes.basePadrao) || 180);
  const BASE_PADRAO = (isFinite(_bp) && _bp >= 15 && _bp <= 730) ? Math.round(_bp) : 180;
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var BASE_PADRAO = ${BASE_PADRAO};
  var alvo = document.getElementById('previsaoVendasAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function num(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;   /* ausente NÃO é zero */
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  /* média por dia tem casa decimal (4,5/dia); 'num' arredondaria pra inteiro */
  function num2(v) {
    if (v == null || v === '' || !isFinite(Number(v))) return null;
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  }

  function chave() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('&k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  var OPCOES = [[30, '1 mês'], [60, '2 meses'], [90, '3 meses'], [180, '6 meses'], [365, '1 ano']];
  var baseDias = BASE_PADRAO;
  var seq = 0;
  var ULTIMA = null;

  function filtrados(lista) {
    var el = document.getElementById('pvBusca');
    var termos = semAcento((el && el.value) || '').trim().split(/\\s+/).filter(Boolean);
    if (!termos.length) return lista;
    /* como na AMB: sem acento e por termo — cada termo pode estar no SKU OU no nome */
    return lista.filter(function (x) {
      var alvoBusca = semAcento(String(x.sku || '') + ' ' + String(x.desc || ''));
      return termos.every(function (t) { return alvoBusca.indexOf(t) >= 0; });
    });
  }

  function semAcento(x) {
    return String(x == null ? '' : x).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
  }

  function buscando() {
    var el = document.getElementById('pvBusca');
    return !!String((el && el.value) || '').trim();
  }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">📈 Previsão de vendas por produto ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que deve sair, mantido o ritmo</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        '<span style="font-size:13px;opacity:.75">base de histórico:</span>' +
        '<select id="pvBase"></select>' +
        '<input id="pvBusca" placeholder="filtrar por SKU ou nome" style="width:180px">' +
        '<input id="pvDias" type="number" min="30" max="730" placeholder="dias" style="width:80px" ' +
          'title="qualquer período entre 30 e 730 dias">' +
        '<button id="pvPlanilha" type="button">⬇ planilha</button>' +
        '<button id="pvRecalcular" type="button" title="refaz o cálculo agora">↻ recalcular</button>' +
        '<span id="pvInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="pvTab" style="overflow:auto"></div>' +
    '</div>';

  var sel = document.getElementById('pvBase');
  var elInfo = document.getElementById('pvInfo');
  var elTab = document.getElementById('pvTab');

  var btnRecalc = document.getElementById('pvRecalcular');

  /* os dois controles mostram a MESMA base ativa: valor personalizado ganha uma opção temporária
     no select; opção fixa limpa o campo de dias */
  function sincronizarControles() {
    var fixa = OPCOES.some(function (o) { return o[0] === baseDias; });
    var ops = OPCOES.slice();
    if (!fixa) ops.push([baseDias, baseDias + ' dias']);
    sel.innerHTML = ops.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === baseDias ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    sel.value = String(baseDias);
    document.getElementById('pvDias').value = fixa ? '' : String(baseDias);
  }

  function tendencia(t) {
    if (t == null || !isFinite(Number(t))) {
      /* ⚠️ sem base pra comparar: NÃO desenha seta. Seta neutra seria lida como "estável". */
      return '<span style="opacity:.55" title="precisa de pelo menos 60 dias de base pra comparar">—</span>';
    }
    var n = Number(t);
    if (n >= 25) return '<span style="color:#2e7d32">▲ ' + n + '%</span>';
    if (n <= -25) return '<span style="color:#c62828">▼ ' + n + '%</span>';
    return '<span style="opacity:.7">≈ ' + (n > 0 ? '+' : '') + n + '%</span>';
  }

  function carregar(forcar) {
    var meu = ++seq;
    ULTIMA = null;   /* resposta da base anterior não pode ser redesenhada/exportada sob a nova */
    sel.disabled = true;
    document.getElementById('pvDias').disabled = true;
    btnRecalc.disabled = true;   /* sem fila de fresh=1: cada um repagina até 120 mil linhas no servidor */
    sincronizarControles();
    elInfo.textContent = 'calculando com ' + baseDias + ' dias de histórico…';
    elTab.innerHTML = '';

    fetch(BASE + '/previsao-vendas?base=' + encodeURIComponent(baseDias) + (forcar ? '&fresh=1' : '') + chave(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;
        sel.disabled = false;
        document.getElementById('pvDias').disabled = false;
        btnRecalc.disabled = false;
        /* ⚠️ 'ok' ausente é FALHA, não "nada a prever" */
        if (!d || d.ok !== true) {
          elInfo.innerHTML = '⚠️ ' + esc((d && (d.erro || d.error)) || 'não consegui calcular');
          return;
        }

        /* ⚠️ Codex #626 (P1): eu li o produtor ERRADO. 'lib/checkout/historico.js:366' devolve
           '{ skus: <CONTAGEM>, produtos: [...] }' — 'skus' é NÚMERO, não lista, e 'itens' não
           existe. Com os dois ramos errados, a seção dizia "sem vendas na base" SEMPRE, mesmo com
           histórico cheio: um "não tem o que comprar" falso, na tela que serve pra decidir compra.
           É a regra 12 de novo — ler o produtor antes de escrever o consumidor. */
        ULTIMA = d;
        desenhar(d);
      })
      .catch(function (e) {
        if (meu !== seq) return;
        sel.disabled = false;
        document.getElementById('pvDias').disabled = false;
        btnRecalc.disabled = false;
        elInfo.innerHTML = '⚠️ ' + esc((e && e.message) || e);
      });
  }

  function desenhar(d) {
        var itens = filtrados(Array.isArray(d.produtos) ? d.produtos : []);
        elInfo.innerHTML = 'base: ' + esc(String(d.de || '').slice(0, 10)) + ' → ' + esc(String(d.ate || '').slice(0, 10)) +
          (d.linhas != null ? ' · ' + esc(String(d.linhas)) + ' itens vendidos' : '') +
          (d.skus != null ? ' · ' + esc(String(d.skus)) + ' SKUs' : '') +
          (d.cache ? ' <span style="opacity:.6">(do cache — recalcula a cada 30 min)</span>' : '');

        if (!itens.length && buscando() && Array.isArray(d.produtos) && d.produtos.length) {
          elTab.innerHTML = '<div style="opacity:.75;font-size:13px">nenhum produto bate com o filtro — ' +
            'o histórico do período tem ' + d.produtos.length + ' produtos; ajuste a busca</div>';
          return;
        }
        if (!itens.length) {
          elTab.innerHTML = '<div style="opacity:.75;font-size:13px">sem vendas na base escolhida — ' +
            'isto NÃO quer dizer que os produtos não vendem: quer dizer que não há histórico nesse período</div>';
          return;
        }

        /* ⚠️ a tendência compara 30 dias com os 30 anteriores: com base < 60 dias ela não existe */
        var podeTendencia = baseDias >= 60;

        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>#</th><th>produto</th>' +
          '<th style="text-align:right">vendidas</th>' +
          '<th style="text-align:right" title="últimos 30 dias contra os 30 anteriores">tendência</th>' +
          '<th style="text-align:right">1 sem</th><th style="text-align:right">1 mês</th>' +
          '<th style="text-align:right">3 meses</th>' +
          /* ⚠️ 05/10 — 'p180' e 'p365' JÁ VÊM do produtor (historico.js:362) e a peça os ignorava.
             A tela embutida da AMB mostra as duas colunas; sem elas, migrar a AMB pra esta peça
             TIRARIA informação de compra de longo prazo — regressão disfarçada de unificação. */
          '<th style="text-align:right">6 meses</th><th style="text-align:right">1 ano</th>' +
          '</tr></thead><tbody>' +
          /* ⚠️ Codex #626 (P2): SEM corte de exibição. O produtor já limita a 400 e a seção não tem
             busca nem paginação — um slice(0, 50) escondia o resto sem caminho pra alcançá-lo. */
          itens.map(function (it, i) {
            /* o campo das unidades vendidas é 'un' (li em historico.js), não 'vendidas'/'qtd' */
            var vend = num(it.un);
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0;opacity:.6">' + (i + 1) + '</td>' +
              '<td>' + esc(it.sku || '—') +
                (it.desc ? ' <span style="opacity:.7">' + esc(it.desc) + '</span>' : '') + '</td>' +
              '<td style="text-align:right">' + (vend != null ? esc(vend) : '<span style="opacity:.6">—</span>') +
                (num2(it.media_dia) != null ? '<div style="opacity:.6;font-size:10px">' + esc(num2(it.media_dia)) + '/dia</div>' : '') + '</td>' +
              '<td style="text-align:right">' + (podeTendencia ? tendencia(it.tendencia) +
                (num(it.un30) != null && num(it.un_30_60) != null ?
                  '<div style="opacity:.6;font-size:10px">' + esc(num(it.un30)) + ' vs ' + esc(num(it.un_30_60)) + '</div>' : '') :
                '<span style="opacity:.55" title="base menor que 60 dias: não dá pra comparar 30 com 30">—</span>') + '</td>' +
              '<td style="text-align:right">' + (num(it.p7) != null ? esc(num(it.p7)) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right"><b>' + (num(it.p30) != null ? esc(num(it.p30)) : '<span style="opacity:.6">—</span>') + '</b></td>' +
              '<td style="text-align:right">' + (num(it.p90) != null ? esc(num(it.p90)) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right">' + (num(it.p180) != null ? esc(num(it.p180)) : '<span style="opacity:.6">—</span>') + '</td>' +
              '<td style="text-align:right;font-weight:700">' + (num(it.p365) != null ? esc(num(it.p365)) : '<span style="opacity:.6">—</span>') + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (podeTendencia ? '' :
            '<div style="opacity:.75;font-size:12px;margin-top:6px">⚠️ a tendência compara os últimos 30 dias ' +
            'com os 30 anteriores — com base de ' + baseDias + ' dias não há os dois períodos, então ela não é mostrada</div>');
  }

  document.getElementById('pvPlanilha').addEventListener('click', function () {
    var L = filtrados((ULTIMA && ULTIMA.produtos) || []);
    if (!L.length) { elInfo.textContent = 'nada pra baixar com o filtro atual'; return; }
    var cols = ['SKU', 'Produto', 'Vendidas na base', 'Media por dia', 'Ultimos 30d',
                '30d anteriores', 'Tendencia %', 'Previsao 1 semana', 'Previsao 1 mes',
                'Previsao 3 meses', 'Previsao 6 meses', 'Previsao 1 ano'];
    var linhas = L.map(function (x) {
      return [x.sku, x.desc || '', x.un, x.media_dia, x.un30, x.un_30_60, x.tendencia,
              x.p7, x.p30, x.p90, x.p180, x.p365];
    });
    /* ⚠️ Codex #636 (P2): .xls de verdade (SpreadsheetML), igual ao baixarPlanilha() da AMB —
       número vai como NÚMERO (soma/ordena sem converter), colunas ajustadas e cabeçalho congelado.
       O CSV que era gerado aqui obrigava o Excel a importar e converter números. Células de texto
       são tipo String, então "=CMD" nunca vira fórmula. */
    var xe = function (t) {
      return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, '');
    };
    var cel = function (v) {
      return (typeof v === 'number' && isFinite(v))
        ? '<Cell><Data ss:Type="Number">' + v + '</Data></Cell>'
        : '<Cell><Data ss:Type="String">' + xe(v) + '</Data></Cell>';
    };
    var larguras = cols.map(function (c, i) {
      var m = String(c).length;
      linhas.forEach(function (l) { var t = String(l[i] == null ? '' : l[i]); if (t.length > m) m = t.length; });
      return '<Column ss:AutoFitWidth="0" ss:Width="' + Math.min(320, Math.max(58, m * 6.6)) + '"/>';
    }).join('');
    var xml =
      '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + '<?mso-application progid="Excel.Sheet"?>' + String.fromCharCode(10) +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles><Style ss:ID="cab"><Font ss:Bold="1" ss:Color="#1F3864"/><Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>' +
        '<Alignment ss:Vertical="Center"/></Style></Styles>' +
      '<Worksheet ss:Name="Dados"><Table>' + larguras +
        '<Row ss:StyleID="cab">' + cols.map(function (c) { return '<Cell ss:StyleID="cab"><Data ss:Type="String">' + xe(c) + '</Data></Cell>'; }).join('') + '</Row>' +
        linhas.map(function (l) { return '<Row>' + l.map(cel).join('') + '</Row>'; }).join('') +
      '</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/>' +
        '<SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>' +
      '</Worksheet></Workbook>';
    var hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    var url = URL.createObjectURL(new Blob([String.fromCharCode(65279) + xml], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'previsao-vendas-' + hoje + '.xls';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  document.getElementById('pvBusca').addEventListener('input', function () {
    if (ULTIMA) desenhar(ULTIMA);
  });

  /* dias livre: qualquer período entre 30 e 730 (a rota do servidor trava em 30 no mínimo) —
     o seletor fixo não cobre quem quer olhar 45 ou 120 dias. Aplica no 'change' (Enter, tab/blur e
     setas do spinner disparam todos), não só no Enter; o campo fica desabilitado durante o
     carregamento, então não há fila de requisições */
  var campoDias = document.getElementById('pvDias');
  campoDias.addEventListener('change', function () {
    if (campoDias.disabled) return;
    var n = Number(campoDias.value);
    if (campoDias.value === '' || !isFinite(n) || n < 30 || n > 730) {
      sincronizarControles();   /* o campo volta a mostrar a base ATIVA */
      elInfo.textContent = 'use um período entre 30 e 730 dias';
      return;
    }
    n = Math.round(n);
    if (n === baseDias) { sincronizarControles(); return; }
    baseDias = n;
    carregar();
  });

  /* recalcular: a rota guarda o resultado por 30 min; sem forçar, o botão devolveria o mesmo */
  btnRecalc.addEventListener('click', function () { if (!btnRecalc.disabled) carregar(true); });

  sel.addEventListener('change', function () {
    baseDias = Number(sel.value) || 90;
    carregar();
  });
  carregar();
})();`;
}

module.exports = { scriptDaPrevisao };
