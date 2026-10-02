/* ════════════════════════════════════════════════════════════════════════════
   PLANO DE COMPRA DO PAINEL — peça compartilhada (02/10).

   O dono: "segue criando os cards todos e acessos, botões todos multiloja e que funcione pra
   GOOD" — e o alvo de sempre: "pra amanhã qdo ligar outra, fique mais fácil".

   ⚠️ POR QUE UMA PEÇA, E NÃO CÓPIA ENTRE PAINÉIS: tentei portar este bloco da AMB pro painel da
   GOOD colando o HTML e as funções. Falhou TRÊS vezes seguidas, cada uma por um motivo
   diferente que só o teste pegou:
     1. `onclick="baixarPlano()"` sem a função — o teste `onclick-existe` acusou;
     2. a função caiu num SEGUNDO bloco <script>, e o teste procura no mesmo bloco do onclick;
     3. `renderPlano` usa `_planoFiltrado`, `PLANO` e `_planoCarregando`, que ficaram pra trás —
        variável fantasma, e três testes da GOOD vermelhos de uma vez.
   Cada remendo criava o furo seguinte. O bloco não é solto: arrasta HTML, estado e funções que
   se chamam entre si. Em cópia, isso vira três chances de divergir; aqui, é um arquivo só.

   A empresa entra como PARÂMETRO (`base`), igual à fábrica de rotas. A tela de cada empresa
   abre `<div id="planoCompraAqui">` e inclui o script servido em `PREFIXO/js/plano-compra.js`.

   Revisão do Codex (#581): a primeira versão guardava o código do cliente como TEXTO extraído
   de um trecho copiado — o HTML saiu com a fonte da concatenação dentro (`'+`, comentários,
   `[1,2,..].map`), faltavam estado e helpers (`PLANO`, `N`, `dBR`, `baixarPlanilha`), o
   `renderPlano` não era alcançável pelo `oninput` e ninguém chamava `carregarPlano()`.
   Agora o cliente é uma FUNÇÃO de verdade, autossuficiente, e o teste EXECUTA o script num DOM
   falso — não basta compilar.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* Roda no NAVEGADOR: o servidor só a serializa com `.toString()`. Não depende de nenhum helper
   do painel que a hospeda (a GOOD não tem `N`, `dBR`, `baixarPlanilha`) — dependência de fora é
   variável fantasma. Não pode referenciar nada deste módulo fora dela. */
function clientePlano(BASE) {
  var alvo = document.getElementById('planoCompraAqui');
  if (!alvo) return;   /* empresa que ainda não abriu espaço pra seção: não faz nada */

  var PLANO = null, _planoCarregando = false;

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var BRL = function (v) { return 'R$ ' + (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var N = function (v) { return Number(v).toLocaleString('pt-BR'); };
  var dBR = function (d) { var m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(d || ''); };
  var norm = function (t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
  var casaBusca = function (termo, a, b) {
    var t = norm(termo).trim();
    if (!t) return true;
    var alvoT = norm(a) + ' ' + norm(b);
    return t.split(/\s+/).every(function (p) { return alvoT.indexOf(p) >= 0; });
  };

  /* seletor de meses: rótulo que diz o que é dentro da opção (no celular números soltos não diziam nada) */
  function seletor(id, rotulo, padrao, titulo) {
    return '<select id="' + id + '" class="cpSel" title="' + titulo + '">' +
      [1, 2, 3, 4, 5, 6, 8, 10, 12].map(function (m) {
        return '<option value="' + m + '"' + (m === padrao ? ' selected' : '') + '>' + rotulo + m + (m > 1 ? ' meses' : ' mês') + '</option>';
      }).join('') + '</select>';
  }

  alvo.innerHTML =
    '<div class="sec" id="secCompra"><h2>🧮 Plano de Compra <span class="hint">quanto comprar de cada produto pra não faltar até o próximo ciclo · ordenado pelo LUCRO EM RISCO, não pelo volume</span></h2>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        seletor('cpLead', '⏳ Espera: ', 4, 'lead time: tempo entre fazer o pedido e a mercadoria chegar') +
        seletor('cpCob', '📦 Cobrir: ', 5, 'quantos meses de estoque você quer ter DEPOIS que a mercadoria chegar') +
        '<select id="cpCurva" class="cpSel" title="curva ABC calculada no período do histórico">' +
          '<option value="A">🏆 Só curva A</option><option value="AB">🏆 Curva A + B</option><option value="todas">🏆 Todos os produtos</option>' +
        '</select>' +
        '<div class="grpBusca">' +
          '<input id="qCompra" class="campoBusca" placeholder="🔎 filtrar por SKU ou nome" style="background:var(--bg2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px 10px;font-size:12.5px">' +
          '<button class="chip btFiltro" id="btCpXls">⬇︎<span class="soDesk"> Excel</span></button>' +
          '<button class="chip btFiltro" id="btCpRecalc"><span class="soDesk">↻ recalcular</span><span class="soCel">↻</span></button>' +
        '</div>' +
      '</div>' +
      '<div id="cpResumo" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>' +
      '<div id="cpInfo" class="mut" style="font-size:12px;margin-bottom:6px"></div>' +
      '<div class="tw twFit"><table id="tCompra"></table></div>' +
    '</div>';

  function _cpParam() {
    var v = function (id) { var e = document.getElementById(id); return e ? e.value : null; };
    /* o campo "segurança" saiu: quem cobre 5 meses já tem o colchão embutido; quer mais folga, cobre 6 */
    return { lead: Number(v('cpLead')) || 4, cob: Number(v('cpCob')) || 5, seg: 0, curva: v('cpCurva') || 'A' };
  }

  async function carregarPlano(forcar) {
    if (_planoCarregando) return;
    var p = _cpParam();
    if (PLANO && !forcar && PLANO.lead === p.lead && PLANO.cob === p.cob && PLANO.seg === p.seg && String(PLANO.curva).toUpperCase() === p.curva.toUpperCase()) return;
    _planoCarregando = true;
    var inf = document.getElementById('cpInfo');
    if (inf) inf.textContent = '⏳ calculando… (na primeira vez ele busca saldo e imagem de cada produto no Bling, leva um pouco)';
    try {
      var r = await fetch(BASE + '/plano-compra?lead=' + p.lead + '&cob=' + p.cob + '&seg=' + p.seg + '&curva=' + p.curva + '&base=180', { credentials: 'same-origin' });
      var d = await r.json().catch(function () { return null; });
      if (d && d.ok) { PLANO = d; renderPlano(); }
      else if (inf) inf.innerHTML = '<span class="warn">não consegui calcular' + ((d && d.erro) ? (': ' + esc(d.erro)) : '') + '</span>';
    } catch (e) { if (inf) inf.innerHTML = '<span class="warn">' + esc(e.message || e) + '</span>'; }
    _planoCarregando = false;
  }

  function _planoFiltrado() {
    if (!PLANO || !PLANO.itens) return [];
    var el = document.getElementById('qCompra'), t = el ? el.value : '';
    return PLANO.itens.filter(function (x) { return casaBusca(t, x.sku, x.nome); });
  }

  function renderPlano() {
    var tb = document.getElementById('tCompra'), inf = document.getElementById('cpInfo'), rs = document.getElementById('cpResumo');
    if (!tb || !PLANO) return;
    var L = _planoFiltrado();
    var T = PLANO.totais || {};
    if (rs) rs.innerHTML =
      '<div class="vcB" style="min-width:150px"><i>investimento necessário</i><b>' + BRL(T.investir || 0) + '</b></div>' +
      '<div class="vcB" style="min-width:150px"><i>⚠ lucro em risco se não comprar</i><b class="bad">' + BRL(T.risco || 0) + '</b></div>' +
      '<div class="vcB" style="min-width:120px"><i>SKUs a comprar</i><b>' + N(T.skus_a_comprar || 0) + '</b></div>';
    if (inf) inf.innerHTML = 'horizonte: <b>' + PLANO.lead + ' meses</b> de espera + <b>' + PLANO.cob + ' meses</b> de cobertura = <b>' + N(PLANO.horizonte_dias) + ' dias</b> de estoque a garantir' +
      ' · ritmo medido em ' + dBR(PLANO.de) + ' → ' + dBR(PLANO.ate) + ' · ' + N(PLANO.skus) + ' SKUs na curva selecionada';
    tb.innerHTML =
      '<tr><th title="primeira imagem do produto no Bling — a mesma que você manda pro fornecedor">Foto</th>' +
      '<th title="código e nome do produto">Produto</th>' +
      '<th title="curva ABC do período: A concentra 80% do faturamento">Curva</th>' +
      '<th class="num" title="média de unidades por dia, já ajustada pela tendência dos últimos 30 dias">Ritmo/dia</th>' +
      '<th class="num" title="saldo em estoque hoje, direto do Bling">Saldo</th>' +
      '<th class="num" title="em quantos dias o estoque acaba nesse ritmo — se for MENOS que o lead time, vai faltar">Acaba em</th>' +
      '<th class="num" title="quanto você precisa ter pra cobrir todo o horizonte">Precisa</th>' +
      '<th class="num" title="o que comprar agora: precisa − saldo">COMPRAR</th>' +
      '<th class="num" title="quanto custa essa compra (custo do Bling × quantidade)">Investir</th>' +
      '<th class="num" title="lucro que você deixa de ganhar nos dias em que o produto ficar em falta">⚠ Lucro em risco</th></tr>' +
      (L.length ? L.map(function (x) {
        var falta = (x.acaba_em != null && x.acaba_em < Math.round(PLANO.lead * 30.4));
        return '<tr' + (falta ? ' style="background:linear-gradient(90deg,rgba(239,68,68,.10),transparent 60%)"' : '') + '>' +
          '<td>' + (x.img ? ('<img src="' + esc(x.img) + '" alt="" loading="lazy" style="width:42px;height:42px;object-fit:cover;border-radius:6px;background:#0d1326">') : '<span class="dim" style="font-size:10px">sem foto</span>') + '</td>' +
          '<td><b>' + esc(x.sku) + '</b><div class="desc" style="max-width:320px">' + esc(x.nome || '') + '</div></td>' +
          '<td><span class="st ' + (x.curva === 'A' ? 'ok' : (x.curva === 'B' ? '' : 'dim')) + '">' + esc(x.curva) + '</span></td>' +
          '<td class="num">' + String(x.md).replace('.', ',') + '<div class="mut" style="font-size:10px">' + (x.tendencia >= 25 ? '▲' : (x.tendencia <= -25 ? '▼' : '≈')) + ' ' + esc(x.tendencia) + '%</div></td>' +
          '<td class="num">' + (x.saldo != null ? N(x.saldo) : '<span class="warn" title="não consegui ler o saldo no Bling">?</span>') + '</td>' +
          '<td class="num' + (falta ? ' bad' : '') + '">' + (x.acaba_em != null ? (N(x.acaba_em) + 'd') : '—') + '</td>' +
          '<td class="num dim">' + N(x.precisa) + '</td>' +
          '<td class="num" style="font-weight:800;font-size:14px">' + (x.comprar > 0 ? N(x.comprar) : '<span class="dim">—</span>') + '</td>' +
          '<td class="num">' + (x.investir != null ? BRL(x.investir) : '<span class="warn" title="sem custo cadastrado no Bling">sem custo</span>') + '</td>' +
          '<td class="num ' + (x.risco > 0 ? 'bad' : 'dim') + '">' + (x.risco > 0 ? BRL(x.risco) : '—') + '</td>' +
        '</tr>';
      }).join('') : '<tr><td class="dim" colspan="10" style="padding:14px">' + ((document.getElementById('qCompra') || {}).value ? 'nenhum SKU com esse filtro' : 'nada a comprar com esses parâmetros') + '</td></tr>');
  }

  /* XLS de verdade (XML do Excel): número vai como NÚMERO, abre com dois cliques */
  function baixarPlanilha(nomeArq, cabecalho, linhas) {
    if (!linhas || !linhas.length) { alert('não há linhas para baixar com o filtro atual'); return; }
    var x = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); };
    var cel = function (v) { return (typeof v === 'number' && isFinite(v)) ? '<Cell><Data ss:Type="Number">' + v + '</Data></Cell>' : '<Cell><Data ss:Type="String">' + x(v) + '</Data></Cell>'; };
    var larguras = cabecalho.map(function (c, i) {
      var m = String(c).length;
      linhas.forEach(function (l) { var t = String(l[i] == null ? '' : l[i]); if (t.length > m) m = t.length; });
      return '<Column ss:AutoFitWidth="0" ss:Width="' + Math.min(320, Math.max(58, m * 6.6)) + '"/>';
    }).join('');
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles><Style ss:ID="cab"><Font ss:Bold="1" ss:Color="#1F3864"/><Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/></Style></Styles>' +
      '<Worksheet ss:Name="Dados"><Table>' + larguras +
        '<Row ss:StyleID="cab">' + cabecalho.map(function (c) { return '<Cell ss:StyleID="cab"><Data ss:Type="String">' + x(c) + '</Data></Cell>'; }).join('') + '</Row>' +
        linhas.map(function (l) { return '<Row>' + l.map(cel).join('') + '</Row>'; }).join('') +
      '</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>' +
      '</Worksheet></Workbook>';
    var hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + xml], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    a.download = nomeArq + '-' + hoje + '.xls';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function baixarPlano() {
    var L = _planoFiltrado();
    baixarPlanilha('plano-de-compra',
      ['SKU', 'Produto', 'Imagem (URL)', 'Curva', 'Vendidas na base', 'Media por dia', 'Saldo hoje', 'Acaba em (dias)', 'Precisa ate o proximo ciclo', 'COMPRAR', 'Custo unitario', 'Investimento', 'Margem por unidade', 'Lucro em risco'],
      L.map(function (x) {
        return [x.sku, x.nome || '', x.img || '', x.curva, x.un, x.md, (x.saldo != null ? x.saldo : ''), (x.acaba_em != null ? x.acaba_em : ''),
                x.precisa, x.comprar, (x.custo_un != null ? x.custo_un : ''), (x.investir != null ? x.investir : ''), x.mc_un, x.risco];
      }));
  }

  /* listeners ligados aqui dentro, no fechamento: nada de onclick inline dependendo de global */
  ['cpLead', 'cpCob', 'cpCurva'].forEach(function (id) { document.getElementById(id).addEventListener('change', function () { carregarPlano(true); }); });
  document.getElementById('qCompra').addEventListener('input', renderPlano);
  document.getElementById('btCpXls').addEventListener('click', baixarPlano);
  document.getElementById('btCpRecalc').addEventListener('click', function () { carregarPlano(true); });
  window.carregarPlano = carregarPlano; window.baixarPlano = baixarPlano; window.renderPlano = renderPlano;

  carregarPlano();   /* primeira carga: sem isso a seção ficava em branco até mexer num seletor */
}

/* o script que a tela carrega: a peça inteira, com a empresa já embutida */
function scriptDoPlano(base) {
  return '(' + clientePlano.toString() + ')(' + JSON.stringify(base) + ');';
}

module.exports = { scriptDoPlano };
