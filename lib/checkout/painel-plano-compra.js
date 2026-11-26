/* ════════════════════════════════════════════════════════════════════════════
   PLANO DE COMPRA DO PAINEL — peça compartilhada (02/10), versão 2.

   ⚠️ A VERSÃO 1 (#581) FOI FECHADA E A CAUSA VALE REGISTRAR: eu tentei EXTRAIR o bloco do
   painel da AMB, e ele monta a tela concatenando strings DENTRO do JavaScript
   (`'<div…>'+\n '<div…>'+`). Não existe markup pra recortar: o que fui jogar no `innerHTML`
   era código-fonte, com `'+`, quebras de linha e `//` no meio. A tela mostraria fragmentos.
   Antes disso, colar o bloco direto no painel da GOOD falhou três vezes (onclick sem função,
   função em outro <script>, variável fantasma).

   Então esta versão NÃO EXTRAI NADA: a seção é escrita aqui, contra a resposta REAL da rota
   `/plano-compra`, com os campos que ela devolve de verdade — sku, nome, img, curva, un, un30,
   tendencia, md, saldo, acaba_em, custo_un, mc_un, risco, sem_saldo, investir.

   Sem estado solto, sem helper de fora, sem `onclick` inline: tudo vive dentro da própria peça.
   A empresa entra como PARÂMETRO, igual à fábrica de rotas.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDoPlano(base, opcoes) {
  const BASE = JSON.stringify(String(base || ''));
  /* ⚠️ Codex #648 (P2): a curva PADRÃO é da empresa. A AMB e a Girassol abrem em A (e caem em A
     quando o campo some); a GOOD abre em A+B. Um padrão único trocaria, na migração, o conjunto de
     SKUs que entra nas recomendações e nos totais sem o dono mexer em nada. */
  const _cp = String((opcoes && opcoes.curvaPadrao) || 'AB');
  const CURVA_PADRAO = JSON.stringify(['A', 'AB', 'B', 'C', 'todas'].indexOf(_cp) >= 0 ? _cp : 'AB');
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var CURVA_PADRAO = ${CURVA_PADRAO};
  var alvo = document.getElementById('planoCompraAqui');
  var _leadDias = 0;   /* dias ate a reposicao chegar — pinta a ruptura antes dela */
  if (!alvo) return;   /* empresa que ainda não abriu espaço: não faz nada, e a tela segue */

  var PLANO = null, carregando = false, filtro = '';
  /* 24/11 (o dono): "dá pra selecionar vários itens ao mm tempo pra marcar e fazer isso mais rápido?" — e o pedido ao
     fornecedor ele monta com "o sku, o EAN, e a quantidade". Os itens MARCADOS e a quantidade de cada um (SKU → { q }):
     nasce com o "comprar" sugerido e o dono ajusta. A marca sobrevive ao filtro e ao recálculo (a quantidade que ele
     digitou não é trocada pela sugestão nova); some o que deixou de estar no plano. Fica só nesta tela aberta. */
  var MARC = {};
  function marcado(sku) { return Object.prototype.hasOwnProperty.call(MARC, String(sku)); }
  function qtdSugerida(i) { var n = Number(i && i.comprar); return (i && i.comprar != null && isFinite(n) && n > 0) ? Math.round(n) : null; }
  /* a quantidade digitada: inteiro maior que zero; vazio, zero, negativo, quebrado ou texto = SEM quantidade (null) */
  function qtdDigitada(v) { var t = String(v == null ? '' : v).trim(); if (!/^\\d{1,7}$/.test(t)) return null; var n = Number(t); return n > 0 ? n : null; }
  function itensMarcados() { return (PLANO && PLANO.itens ? PLANO.itens : []).filter(function (i) { return marcado(i.sku); }); }
  function itensDoPedido() { return itensMarcados().filter(function (i) { return MARC[String(i.sku)].q != null; }); }

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  /* 'AAAA-MM-DD' → 'DD/MM/AAAA' (o que não for data vira vazio) */
  function dataBR(t) { var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(t == null ? '' : t)); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  /* a hora (de São Paulo) de um instante ISO: 'HH:MM'; no dia de hoje só a hora, em outro dia com a data; torto → '' */
  function horaSP(t) {
    var d = new Date(t == null || t === '' ? NaN : t); if (isNaN(d.getTime())) return '';
    var h = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    var dia = d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }), hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    return dia === hoje ? h : h + ' de ' + dataBR(dia);
  }
  function brl(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function norm(x) { return String(x == null ? '' : x).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase(); }
  function num(v) { return (Number(v) || 0).toLocaleString('pt-BR'); }

  /* a seção inteira, montada por elemento — nada de innerHTML com fonte serializada */
  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🧮 Plano de Compra ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">quanto comprar pra não faltar · ordenado pelo LUCRO EM RISCO</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        /* Codex #582 (P1): A ROTA LÊ MESES, NÃO DIAS. Eu tinha posto 30/45/15 com teto de
           180/365/120 e mandado direto — a rota cortava em 24+24+6 MESES e devolvia número
           absurdo. Agora o rótulo diz "meses" e os padrões/limites são os da rota (4, 5, 0;
           máx 24/24/6). */
        '<label style="font-size:13px">reposição <input id="pcLead" type="number" value="4" min="0" max="24" style="width:58px"> meses</label>' +
        '<label style="font-size:13px">cobertura <input id="pcCob" type="number" value="5" min="0.5" max="24" step="0.5" style="width:58px"> meses</label>' +
        '<label style="font-size:13px">segurança <input id="pcSeg" type="number" value="0" min="0" max="6" style="width:58px"> meses</label>' +
        /* Codex #582 (P2): a rota só busca saldo dos 260 primeiros SKUs do recorte e devolve todos;
           com 'todas' e mais de 260 SKUs, o resto vinha "sem saldo" pra sempre. Por isso a tela
           oferece a curva (A+B por padrão) e manda ela. */
        '<label style="font-size:13px">curva <select id="pcCurva"><option value="AB">A+B</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="todas">todas</option></select></label>' +
        /* 20/11 (o dono): "acho legal ter um filtro... últimos 30 dias, últimos 60 dias, últimos 90 dias, 180, ano 2026.
           e um período pra eu escolher... de tal data até tal data". O padrão segue os 180 dias de sempre. */
        '<label style="font-size:13px">ritmo medido em <select id="pcBase"><option value="30">últimos 30 dias</option><option value="60">últimos 60 dias</option>' +
          '<option value="90">últimos 90 dias</option><option value="180" selected>últimos 180 dias</option><option value="ano">ano ' + esc(hojeSP().slice(0, 4)) + '</option>' +
          '<option value="datas">escolher datas</option></select></label>' +
        '<span id="pcDatas" style="display:none;font-size:13px">de <input id="pcDe" type="date"> até <input id="pcAte" type="date"></span>' +
        /* 23/11 (o dono): "contar o período em que teve venda... pode ter 1 coluna só disso". A coluna "Ritmo Vendas c/ Estoque" (24/11: o nome que o dono escolheu — e é o PADRÃO da conta: "é mais real saber o q preciso durante o tempo q vendeu") sai
           sempre; aqui se escolhe qual dos dois ritmos manda na conta (padrão: o do período, como sempre foi) */
        '<label style="font-size:13px" title="Ritmo Vendas c/ Estoque: as vendas divididas só pelos dias em que o produto vendeu (o produto que ficou zerado não sai com ritmo baixo)">comprar pelo <select id="pcRitmo"><option value="estoque" selected>Ritmo Vendas c/ Estoque</option><option value="periodo">Ritmo do período</option></select></label>' +
        '<button id="pcCalc" type="button">calcular</button>' +
        '<input id="pcFiltro" placeholder="filtrar por SKU ou nome" style="flex:1;min-width:150px">' +
        '<button id="pcCsv" type="button">baixar planilha</button>' +
        '<span id="pcXlsInfo" style="font-size:12px;opacity:.75"></span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 6px;font-size:13px">' +
        '<button id="pcMarcarCompra" type="button" title="marca, entre os que estão na lista, os que têm quantidade a comprar">marcar os que têm compra</button>' +
        '<button id="pcLimparMarcas" type="button">desmarcar todos</button>' +
        '<span id="pcSel" style="opacity:.8">nenhum item marcado</span>' +
        '<button id="pcPedido" type="button" disabled title="planilha só com os itens marcados: SKU, EAN, produto, foto e a quantidade">baixar pedido do fornecedor</button>' +
        '<span id="pcPedInfo" style="font-size:12px;opacity:.75"></span>' +
      '</div>' +
      '<div id="pcHor" style="font-size:13px;margin-bottom:4px"></div>' +
      '<div id="pcInfo" style="font-size:13px;opacity:.75;margin-bottom:6px">clique em calcular</div>' +
      /* 26/11: data-cabflut = o dashboard repete o cabeçalho desta tabela numa barra flutuante quando ela passa do topo
         (esta área rola de lado, e aí o cabeçalho grudado do navegador não funciona) */
      '<div id="pcTab" data-cabflut="1" style="overflow:auto"></div>' +
    '</div>';

  var elInfo = document.getElementById('pcInfo');
  var elHor = document.getElementById('pcHor');
  (function () { var cv0 = document.getElementById('pcCurva'); if (cv0) cv0.value = CURVA_PADRAO; })();
  var elTab = document.getElementById('pcTab');

  function param() {
    /* Codex #582: 'seg' pode ser 0 de propósito — trocar 0 pelo padrão ignoraria a escolha */
    /* Codex #582 (P2): corta nos MESMOS limites da rota e devolve o valor usado pro campo, pra
       a tela nunca mostrar um número e calcular com outro (cob mínima da rota é 0.5). */
    var g = function (id, pad, min, max) {
      var e = document.getElementById(id); var n = Number(e && e.value);
      if (!(isFinite(n) && e && e.value !== '')) n = pad;
      n = Math.min(max, Math.max(min, n));
      if (e) e.value = n;
      return n;
    };
    var cv = document.getElementById('pcCurva');
    /* o período: vai na consulta do jeito que a rota lê (?base=N, ?periodo=ano ou ?de=&ate=). Datas pela metade ou
       invertidas NÃO viram pedido — a tela diz o que falta (e não calcula com outro período no lugar). */
    var pb = document.getElementById('pcBase'), tipo = String((pb && pb.value) || '180'), per = '&base=180', perErro = '';
    if (tipo === 'ano') per = '&periodo=ano';
    else if (tipo === 'datas') {
      var eDe = document.getElementById('pcDe'), eAte = document.getElementById('pcAte');
      var de = String((eDe && eDe.value) || ''), ate = String((eAte && eAte.value) || '');
      if (!de || !ate) perErro = 'escolha as duas datas do período (de e até)';
      else if (de > ate) perErro = 'a data inicial é depois da final';
      else per = '&de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate);
    }
    else if (tipo === '30' || tipo === '60' || tipo === '90') per = '&base=' + tipo;
    var pr = document.getElementById('pcRitmo');
    if (pr && pr.value === 'estoque') per += '&ritmo=estoque';   /* só os dois valores que existem; qualquer outro é o do período */
    return { lead: g('pcLead', 4, 0, 24), cob: g('pcCob', 5, 0.5, 24), seg: g('pcSeg', 0, 0, 6), curva: (cv && cv.value) || CURVA_PADRAO, per: per, perErro: perErro };
  }

  function linhas() {
    if (!PLANO || !PLANO.itens) return [];
    /* ⚠️ Codex #648 (P2): sem acento e sem caixa, como o casaBusca() da embutida — 'lampada'
       acha 'Lâmpada'; com várias palavras, todas têm de aparecer. */
    var q = norm(filtro).trim();
    if (!q) return PLANO.itens;
    var ps = q.split(/\\s+/);
    return PLANO.itens.filter(function (i) {
      var alvo = norm(String(i.sku || '') + ' ' + String(i.nome || ''));
      return ps.every(function (p) { return alvo.indexOf(p) >= 0; });
    });
  }

  /* 26/11 (o dono): "clicar tipo em Ritmo/Dia e conseguir ver do com mais ou daquele com menos… Se eu clicar no de Grupo
     A, B, C, daí mostrar dos A em diante, depois B, depois C. E se eu clicar de novo, o inverso". Clicou no nome da
     coluna, a lista se ordena por ela; clicou de novo, inverte. Número começa pelo MAIOR; texto e curva, pelo começo
     (A). Quem não tem o dado fica sempre no fim — "não sei" não é o menor nem o maior. Empate segue a ordem do plano. */
  var ORD = { col: null, dir: -1 };
  var ORD_TEXTO = { sku: 1, nome: 1 }, ORD_CURVA = { A: 1, B: 2, C: 3 };
  function valorDaColuna(i, col) {
    if (col === 'curva') return ORD_CURVA[String(i.curva || '').toUpperCase()] || null;
    if (ORD_TEXTO[col]) { var tx = norm(i[col]).trim(); return tx === '' ? null : tx; }
    if ((col === 'saldo' || col === 'risco') && i.sem_saldo) return null;   /* sem saldo: a tela mostra "—", não zero */
    var v = i[col];
    if (v == null || v === '') return null;
    v = Number(v);
    return isFinite(v) ? v : null;
  }
  function ordenar(its) {
    if (!ORD.col) return its;
    return its.map(function (i, n) { return { i: i, n: n, v: valorDaColuna(i, ORD.col) }; }).sort(function (a, b) {
      if (a.v == null || b.v == null) return (a.v == null && b.v == null) ? a.n - b.n : (a.v == null ? 1 : -1);
      var r = (typeof a.v === 'string') ? (a.v < b.v ? -1 : (a.v > b.v ? 1 : 0)) : a.v - b.v;
      return r ? r * ORD.dir : a.n - b.n;
    }).map(function (x) { return x.i; });
  }
  function ordenarPor(col) {
    var primeira = (ORD_TEXTO[col] || col === 'curva') ? 1 : -1;
    ORD = { col: col, dir: ORD.col === col ? -ORD.dir : primeira };
    render();
  }
  /* o título clicável de uma coluna: a seta diz por onde a lista está ordenada (↓ do maior pro menor, ↑ do menor pro maior) */
  function cab(col, rotulo, direita, dica) {
    return '<th class="sort" data-pc-ord="' + col + '" style="cursor:pointer;user-select:none' + (direita ? ';text-align:right' : '') + '" title="' +
      esc((dica ? dica + ' · ' : '') + 'clique pra ordenar; clique de novo pra inverter') + '">' + rotulo +
      (ORD.col === col ? (ORD.dir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
  }

  function render() {
    /* ⚠️ o lead vem do PLANO carregado, não de um 'd' solto: eu colei a linha dentro do 'render()',
       onde 'd' não existe — a função estourava na PRIMEIRA linha e a tabela simplesmente não
       aparecia, sem erro visível. Foi o teste da casa que pegou. */
    _leadDias = (PLANO && PLANO.lead != null && isFinite(Number(PLANO.lead)))
      ? Math.round(Number(PLANO.lead) * 30.4) : 0;
    /* ⚠️ Codex #648 (P1): horizonte e período de medição do ritmo, como na embutida — sem eles a
       recomendação não tem contexto para ser interpretada. */
    if (elHor) {
      elHor.innerHTML = (PLANO && PLANO.lead != null && PLANO.cob != null && PLANO.horizonte_dias != null)
        ? 'horizonte: <b>' + esc(PLANO.lead) + ' meses</b> de espera + <b>' + esc(PLANO.cob) + ' meses</b> de cobertura = <b>' +
          num(PLANO.horizonte_dias) + ' dias</b> de estoque a garantir' +
          (PLANO.de && PLANO.ate ? ' · ritmo medido em ' + esc(dataBR(PLANO.de) || PLANO.de) + ' → ' + esc(dataBR(PLANO.ate) || PLANO.ate) +
            (PLANO.periodo && PLANO.periodo.dias != null ? ' (' + num(PLANO.periodo.dias) + ' dias' +
              (PLANO.periodo.mistura === false ? ' · média pura do período, sem o peso do último mês' : '') + ')' : '') : '') +
          (PLANO.ritmo === 'estoque' ? ' · conta pelo <b>Ritmo Vendas c/ Estoque</b> (quem não tem dias de venda pra medir fica no do período)' : '')
        : '';
    }
    var its = ordenar(linhas());
    resumoDaSelecao();
    if (!its.length) { elTab.innerHTML = '<div style="opacity:.7;font-size:13px">nenhum item</div>'; return; }
    var todosMarcados = its.every(function (i) { return marcado(i.sku); });
    elTab.innerHTML =
      '<table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr style="text-align:left;opacity:.7">' +
        '<th style="width:26px"><input type="checkbox" data-pc-todos="1"' + (todosMarcados ? ' checked' : '') + ' title="marcar ou desmarcar todos os que estão na lista"></th>' +
        '<th></th>' + cab('sku', 'SKU') + cab('curva', 'curva', false, 'curva ABC do produto pelo lucro no período') + cab('nome', 'produto') +
        cab('md', 'ritmo/dia', true, 'unidades por dia — o ritmo usado na conta') +
        cab('md_estoque', 'Ritmo Vendas c/ Estoque', true, 'vendas divididas só pelos dias em que o produto vendeu (da 1ª à última venda do período, ou até hoje se ainda tem saldo)') +
        cab('saldo', 'saldo', true) +
        cab('a_caminho', 'a caminho', true, 'Pedidos de Compra em aberto no Bling (ainda não chegou). Já está descontado do comprar.') +
        cab('precisa', 'precisa', true, 'quanto voce precisa ter pra cobrir todo o horizonte') +
        cab('un30', '30d', true) + cab('acaba_em', 'acaba', true) +
        cab('comprar', 'comprar', true) + cab('investir', 'investir', true) +
        cab('risco', 'lucro em risco', true) + '</tr></thead><tbody>' +
      its.map(function (i) {
        /* ⚠️ Codex #648 (P2): a LINHA inteira avisa, como na embutida — numa tabela estreita com
           rolagem lateral a coluna 'acaba' sai da vista e o texto vermelho some junto com ela. */
        var _an = Number(i.acaba_em);
        var falta = i.acaba_em != null && isFinite(_an) && _leadDias && _an < _leadDias;
        return '<tr style="border-top:1px solid rgba(128,128,128,.25)' + (falta ? ';background:linear-gradient(90deg,rgba(239,68,68,.10),transparent 60%)' : '') + '">' +
          /* ⚠️ 06/10 — FOTO e RITMO/DIA vinham do produtor ('img' e 'md') e a peça ignorava; a tela
             embutida da AMB mostra as duas. Migrar sem elas seria entregar menos: a foto é como o
             dono reconhece o produto na lista, e o ritmo é a conta que explica o "comprar". */
          '<td style="padding:4px 0"><input type="checkbox" data-pc-marca="' + esc(i.sku) + '"' + (marcado(i.sku) ? ' checked' : '') + ' title="marcar pra o pedido do fornecedor"></td>' +
          '<td style="padding:4px 0">' + (i.img
            /* ⚠️ Codex #646: 'loading=lazy', como a embutida já faz. Sem isso, abrir ou filtrar a
               tabela puxa TODAS as fotos de uma vez — a rota devolve até 260 produtos, e a maioria
               está fora da tela. */
            ? '<img src="' + esc(i.img) + '" alt="" loading="lazy" style="width:38px;height:38px;object-fit:cover;border-radius:6px;background:rgba(128,128,128,.15);display:block" />'
            : '<span style="display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:6px;background:rgba(128,128,128,.15);font-size:15px">📦</span>') + '</td>' +
          /* 26/11 (o dono): a curva saiu de dentro da célula do SKU — "quando eu dou duplo clique ou copio rápido, pode acabar
             pegando o A escrito". A célula do SKU tem SÓ o SKU; a curva tem coluna própria. */
          '<td style="padding:4px 0;white-space:nowrap">' + esc(i.sku) + '</td>' +
          '<td style="opacity:.75;text-align:center">' + esc(i.curva || '') + '</td>' +
          '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.nome) + '</td>' +
          /* ⚠️ "sem dado" não vira 0: ritmo 0 diria "não vende", e md ausente diria outra coisa */
          /* ⚠️ Codex #646: TRÊS casas, não duas. Em produto de giro baixo o produtor devolve
             0,006/dia; arredondar pra 0,01 mostra um ritmo que NÃO é o usado pra calcular o
             comprar — número da tela discordando da conta.
             ⚠️ E a TENDÊNCIA vem junto, como na embutida: o ritmo sozinho não diz se está subindo
             ou caindo, e é isso que muda a decisão de comprar. */
          '<td style="text-align:right">' + (i.md == null || !isFinite(Number(i.md))
            ? '<span style="opacity:.6">—</span>'
            : (esc(Number(i.md).toLocaleString('pt-BR', { maximumFractionDigits: 3 })) +
               (i.tendencia == null || !isFinite(Number(i.tendencia)) ? ''
                 : '<div style="opacity:.6;font-size:10px">' +
                   (Number(i.tendencia) >= 25 ? '▲' : (Number(i.tendencia) <= -25 ? '▼' : '≈')) + ' ' +
                   esc(Number(i.tendencia)) + '%</div>'))) + '</td>' +
          /* 23/11: o ritmo com estoque e em quantos dias ele foi medido; sem janela que meça (menos de 14 dias de venda), "—" */
          '<td style="text-align:right">' + (i.md_estoque == null || !isFinite(Number(i.md_estoque))
            ? '<span style="opacity:.6" title="poucos dias de venda pra medir">—</span>'
            : ((i.ritmo_usado === 'estoque' ? '<b>' : '') + esc(Number(i.md_estoque).toLocaleString('pt-BR', { maximumFractionDigits: 3 })) + (i.ritmo_usado === 'estoque' ? '</b>' : '') +
               (i.dias_com_venda != null ? '<div style="opacity:.6;font-size:10px">em ' + num(i.dias_com_venda) + ' dias</div>' : ''))) + '</td>' +
          '<td style="text-align:right">' + (i.sem_saldo ? '<span style="opacity:.6">sem saldo</span>' : num(i.saldo)) +
            /* produto zerado: a data da última venda — "assim consigo ter noção se acabou faz mto tempo ou não" */
            (i.ultima_venda && dataBR(i.ultima_venda) ? '<div style="opacity:.6;font-size:10px;white-space:nowrap" title="produto zerado: data da última venda">últ. venda ' + esc(dataBR(i.ultima_venda)) + '</div>' : '') + '</td>' +
          /* 24/11 — A CAMINHO: o que os Pedidos de Compra em aberto no Bling ainda vão entregar deste SKU, e quando.
             null = não consegui ler os pedidos ("?", não zero); 0 = nada a caminho ("—"). */
          '<td style="text-align:right;white-space:nowrap">' + (i.a_caminho == null
            ? '<span style="opacity:.6" title="não consegui ler os pedidos de compra do Bling">?</span>'
            : (!(Number(i.a_caminho) > 0) ? '<span style="opacity:.6">—</span>'
              : '<b>' + num(i.a_caminho) + '</b>' +
                (i.a_caminho_atrasado && dataBR(i.chega) ? '<div style="color:#f87171;font-size:10px" title="a data prevista do pedido de compra já passou">atrasado · era ' + esc(dataBR(i.chega)) + '</div>'
                  : (dataBR(i.chega) ? '<div style="opacity:.6;font-size:10px">chega ' + esc(dataBR(i.chega)) + '</div>'
                    : '<div style="opacity:.6;font-size:10px">sem data prevista</div>')) +
                /* Codex #978: parte do que vem não tem data (pedido sem previsão) — avisa mesmo havendo uma data conhecida */
                (i.a_caminho_sem_data && dataBR(i.chega) ? '<div style="color:#fbbf24;font-size:10px" title="parte do que está a caminho vem de pedido sem data prevista">parte sem data prevista</div>' : '') +
                (i.vai_faltar ? '<div style="color:#f87171;font-size:10px" title="o saldo acaba antes da data prevista de chegada">acaba antes de chegar</div>' : ''))) + '</td>' +
          /* ⚠️ Codex #646: coluna PRECISA — quanto o estoque tem de ter pra cobrir o horizonte
             inteiro. Sem ela o "comprar" aparece sem a referencia que o explica. */
          '<td style="text-align:right">' + (i.precisa == null ? '<span style="opacity:.6">—</span>' : esc(num(i.precisa))) + '</td>' +
          /* período que não termina hoje: "últimos 30 dias" não faz parte dele — sem valor, não zero */
          '<td style="text-align:right">' + (i.un30 == null ? '<span style="opacity:.6">—</span>' : num(i.un30)) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + /* P1: 0 dias = JÁ ACABOU, o caso mais urgente — '||' escondia justamente ele */
          /* ⚠️ Codex #646: a embutida pinta de VERMELHO quando o estoque acaba ANTES de a reposicao
             chegar ('acaba_em < lead*30.4') — e e esse o aviso que faz o dono comprar hoje em vez
             de semana que vem. Marcar so o que ja acabou avisa tarde demais. */
          /* ⚠️ 'acaba_em' pode vir como NÚMERO de dias ou como DATA ('12/10') — o teste da casa usa
             as duas formas. Só comparo com o lead quando for número; com data, mostro como veio.
             Tratar texto como número daria NaN e a comparação sumiria calada. */
          (i.acaba_em == null ? '—' : (function () {
            var _n = Number(i.acaba_em);
            if (!isFinite(_n)) return esc(i.acaba_em);
            if (_n <= 0) return '<b style="color:#f87171">acabou</b>';
            if (_leadDias && _n < _leadDias) {
              return '<b style="color:#f87171" title="acaba ANTES de a reposicao chegar">' + esc(i.acaba_em) + 'd ⚠</b>';
            }
            return esc(i.acaba_em);
          })()) + '</td>' +
          /* Codex #582 (P1): 'un' é o VENDIDO no histórico; a quantidade recomendada é 'comprar'.
             Mostrar 'un' sob o título "comprar" mandaria o dono pedir o número errado. */
          /* 24/11: item MARCADO troca o número pela caixa da quantidade do pedido (nasce com a sugestão; o dono ajusta) */
          '<td style="text-align:right">' + (marcado(i.sku)
            ? '<input type="number" min="1" step="1" data-pc-qtd="' + esc(i.sku) + '" value="' + (MARC[String(i.sku)].q == null ? '' : esc(MARC[String(i.sku)].q)) + '" title="quantidade do pedido" style="width:78px;text-align:right">' +
              '<div style="opacity:.6;font-size:10px">sugerido ' + (i.comprar == null ? '—' : num(i.comprar)) + '</div>'
            : (i.comprar == null ? '<span style="opacity:.6" title="sem saldo: não dá pra calcular">—</span>' : '<b>' + num(i.comprar) + '</b>')) + '</td>' +
          /* P1: 'investir: null' quer dizer NÃO SEI (sem custo ou sem saldo) — mostrar R$ 0,00
             faria aprovar compra sem contar o desembolso */
          '<td style="text-align:right">' + (i.investir == null ? '<span style="opacity:.6">—</span>' : esc(brl(i.investir))) + '</td>' +
          /* Codex #582 r3 (P2): sem saldo, a rota não calcula a data de ruptura e o risco sai 0 —
             mostrar "R$ 0,00" faz o item parecer SEGURO e empurra o dono pras outras linhas,
             quando ele pode já estar faltando. Sem saldo = risco desconhecido. */
          '<td style="text-align:right">' + (i.sem_saldo ? '<span style="opacity:.6" title="sem saldo: não dá pra avaliar o risco">—</span>' : esc(brl(i.risco))) + '</td></tr>';
      }).join('') + '</tbody></table>';
    /* a tabela é nova a cada render: a barra flutuante do dashboard recopia o cabeçalho (a seta da ordem vai junto) */
    try { if (typeof JANELA.atualizarCabecalhoFlutuante === 'function') JANELA.atualizarCabecalhoFlutuante(); } catch (e) {}
  }

  /* 24/11 — a linha de resumo dos marcados e o botão do pedido (ligado só quando há item com quantidade) */
  function resumoDaSelecao() {
    var elSel = document.getElementById('pcSel'), bp = document.getElementById('pcPedido');
    var ms = itensMarcados(), ped = itensDoPedido();
    var un = ped.reduce(function (t, i) { return t + MARC[String(i.sku)].q; }, 0);
    var semQ = ms.length - ped.length;
    if (elSel) elSel.textContent = !ms.length ? 'nenhum item marcado'
      : num(ms.length) + ' item(ns) marcado(s) · ' + num(un) + ' unidade(s)' + (semQ ? ' · ' + num(semQ) + ' sem quantidade (fica fora do pedido)' : '');
    if (bp && !baixandoPedido) { bp.disabled = !ped.length; bp.textContent = ped.length ? 'baixar pedido do fornecedor (' + num(ped.length) + ')' : 'baixar pedido do fornecedor'; }
  }
  function marcar(i) { if (!marcado(i.sku)) MARC[String(i.sku)] = { q: qtdSugerida(i) }; }
  /* os cliques da tabela chegam por aqui (a tabela é remontada a cada render: o evento é ligado no elemento de fora) */
  function aoMexerNaTabela(ev) {
    var t = ev && ev.target; if (!t || typeof t.getAttribute !== 'function' || !PLANO) return;
    var sku = t.getAttribute('data-pc-marca');
    if (sku != null) {
      var it = PLANO.itens.filter(function (i) { return String(i.sku) === String(sku); })[0];
      if (!it) return;
      if (t.checked) marcar(it); else delete MARC[String(sku)];
      render(); return;
    }
    if (t.getAttribute('data-pc-todos') != null) {
      var vis = linhas();
      if (t.checked) vis.forEach(marcar); else vis.forEach(function (i) { delete MARC[String(i.sku)]; });
      render(); return;
    }
    var sq = t.getAttribute('data-pc-qtd');
    if (sq != null && marcado(sq)) { MARC[String(sq)].q = qtdDigitada(t.value); resumoDaSelecao(); }   /* sem remontar a tabela: o dono está digitando */
  }
  /* 26/11: ao rolar a tabela de lado, a barra do cabeçalho (do dashboard) acompanha na hora */
  elTab.addEventListener('scroll', function () { try { if (typeof JANELA.atualizarCabecalhoFlutuante === 'function') JANELA.atualizarCabecalhoFlutuante(); } catch (e) {} });
  elTab.addEventListener('change', aoMexerNaTabela);
  elTab.addEventListener('click', function (ev) {
    /* o clique pode cair num pedaço de dentro do título: sobe até achar a coluna */
    for (var n = ev && ev.target; n && n !== elTab; n = n.parentNode) {
      var col = (typeof n.getAttribute === 'function') ? n.getAttribute('data-pc-ord') : null;
      if (col) { if (PLANO) ordenarPor(col); return; }
    }
  });
  elTab.addEventListener('input', function (ev) { var t = ev && ev.target; if (t && typeof t.getAttribute === 'function' && t.getAttribute('data-pc-qtd') != null) aoMexerNaTabela(ev); });
  document.getElementById('pcMarcarCompra').addEventListener('click', function () { if (!PLANO) return; linhas().forEach(function (i) { if (qtdSugerida(i) != null) marcar(i); }); render(); });
  document.getElementById('pcLimparMarcas').addEventListener('click', function () { MARC = {}; if (PLANO) render(); else resumoDaSelecao(); });

  var seq = 0;   /* Codex #582 (P1): cada clique ganha um número */
  var jaPediu = false;   /* já houve um cálculo pedido: daí em diante, mudar o período recalcula */
  function carregar() {
    /* ⚠️ ANTES EU DESCARTAVA O CLIQUE enquanto uma carga estava em curso. A primeira demora
       (a rota busca saldo produto a produto no Bling), e se o dono mudasse reposição/cobertura
       e clicasse de novo, o clique sumia — e o resultado ANTIGO chegava depois, como se fosse
       dos parâmetros novos. Número errado é pior que número ausente.
       Agora todo clique vale: o pedido antigo é ignorado na volta pelo número de sequência. */
    /* Codex #582 (P1, acerto): ANTES OS DOIS PEDIDOS SAÍAM. Eu só ignorava o antigo na volta,
       mas ele já tinha ido — e esta rota busca saldo produto a produto no Bling, então dois
       cliques = o DOBRO de chamadas na cota da conta, que é justamente o que derruba a bipagem
       do galpão. Agora o clique novo marca o pedido anterior como descartado ANTES de sair, e
       o botão fica em espera enquanto há uma carga em curso. */
    var meu = ++seq;
    carregando = true;
    var bt = document.getElementById('pcCalc');
    /* Codex #583 (P1): travar SÓ o botão deixava os campos editáveis — o dono mexia durante a
       espera, não podia reenviar, e a resposta antiga aparecia ao lado dos parâmetros novos,
       como se tivesse sido calculada com eles. Lê os parâmetros ANTES e trava todos os
       controles que entram no cálculo até a resposta (ou o erro) voltar. */
    var p = param();
    jaPediu = true;
    if (p.perErro) { carregando = false; PLANO = null; elTab.innerHTML = ''; if (elHor) elHor.innerHTML = ''; elInfo.textContent = '⚠️ ' + p.perErro; return; }
    var ctrls = ['pcLead', 'pcCob', 'pcSeg', 'pcCurva'].concat(['pcBase', 'pcDe', 'pcAte', 'pcRitmo']).map(function (id) { return document.getElementById(id); });
    var trava = function (v) { ctrls.forEach(function (e) { if (e) e.disabled = v; }); };
    trava(true);
    if (bt) { bt.disabled = true; bt.textContent = 'calculando…'; }
    var solta = function () { trava(false); if (bt) { bt.disabled = false; bt.textContent = 'calcular'; } };
    elInfo.textContent = '⏳ calculando… lendo os saldos no Bling (produto novo no plano leva um pouco mais na primeira vez)';
    fetch(BASE + '/plano-compra?lead=' + p.lead + '&cob=' + p.cob + '&seg=' + p.seg + '&curva=' + encodeURIComponent(p.curva) + p.per, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (meu !== seq) return;   /* chegou atrasado: outro clique já mandou outro pedido */
        carregando = false; solta();
        /* ⚠️ a rota RECUSA EXPLICANDO quando a empresa não tem a peça ("primeiraImagem",
           "supaCfg") — mostrar o motivo é melhor que tabela vazia, que pareceria "não tem dado" */
        /* Codex #582 (P2): falha LIMPA o plano velho. Sem isso, digitar no filtro chamava o
           render e repintava os números da rodada anterior como se fossem destes parâmetros. */
        if (!d || !d.ok) { PLANO = null; elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui calcular'); elTab.innerHTML = ''; resumoDaSelecao(); return; }
        PLANO = d;
        /* 24/11: a marca de quem saiu do plano (outra curva, outro período) cai; a de quem ficou segue, com a quantidade dele */
        (function () { var tem = {}; (d.itens || []).forEach(function (i) { tem[String(i.sku)] = 1; }); Object.keys(MARC).forEach(function (k) { if (!tem[k]) delete MARC[k]; }); })();
        var t = d.totais || {};
        /* Codex #582 r3 (P1): O TOTAL A INVESTIR PODE ESTAR INCOMPLETO. A rota soma com
           (c.investir || 0), então SKU sem custo em cache entra como zero — o total sai MENOR
           que o desembolso real, e é justamente o número que o dono olha pra decidir quanto
           vai gastar. Agora, se alguma linha está sem custo, o resumo diz "no mínimo" e conta
           quantas ficaram de fora. Número incompleto anunciado é melhor que número redondo
           mentiroso. */
        /* Codex #582 (P2, acerto): SEM SALDO ≠ SEM CUSTO, e o dono age diferente em cada um.
           Sem saldo é problema de leitura do Bling (ou produto zerado); sem custo é cadastro
           faltando, que ele resolve no Bling e some. Contar os dois juntos como "sem custo"
           mandaria procurar no lugar errado. */
        /* Codex #583 (P2): separar "sem custo" de "sem saldo" na CONTAGEM foi certo, mas eu
           também tirei o sem-saldo do AVISO de total incompleto — e ele fica de fora da soma
           igual. O total voltava a parecer definitivo. Agora: conta os dois pra saber se o
           total está incompleto, e diz cada um pelo nome, porque o dono resolve em lugares
           diferentes (saldo é leitura do Bling; custo é cadastro). */
        var itens = d.itens || [];
        var semCusto = itens.filter(function (i) { return i.investir == null && !i.sem_saldo; }).length;
        var semSaldo = itens.filter(function (i) { return i.sem_saldo; }).length;
        var faltam = semCusto + semSaldo;
        var porQue = [semCusto ? num(semCusto) + ' sem custo' : '', semSaldo ? num(semSaldo) + ' sem saldo' : ''].filter(Boolean).join(', ');
        elInfo.textContent = num(d.skus) + ' SKU(s) · comprar ' + num(t.skus_a_comprar) +
          ' · investir ' + (faltam ? 'no mínimo ' : '') + brl(t.investir) +
          (faltam ? ' (' + porQue + ', fora da soma)' : '') +
          /* Codex #582 (P2, acerto): o total de RISCO tem o mesmo furo do de investir — item
             sem saldo entra como 0 na soma. Mesmo tratamento: diz que é no mínimo. */
          ' · lucro em risco ' + (d.skus_sem_saldo ? 'no mínimo ' : '') + brl(t.risco) +
          (d.skus_sem_saldo ? ' · ' + num(d.skus_sem_saldo) + ' sem saldo no Bling' : '') +
          /* 25/11: de quando é o saldo (o mais antigo entre os usados) — e se alguma leitura do Bling falhou neste cálculo */
          (horaSP(d.saldo_lido_em) ? ' · saldos do Bling lidos às ' + horaSP(d.saldo_lido_em) : '') +
          (d.saldos_com_falha ? ' · ⚠️ ' + num(d.saldos_com_falha) + ' leitura(s) de saldo falharam (calcule de novo daqui a pouco)' : '') +
          /* 24/11: o que o plano sabe do "a caminho" — e, quando não conseguiu ler, que o comprar NÃO descontou nada */
          (function (c) {
            if (!c) return '';
            if (!c.ok) return ' · ⚠️ não consegui ler os pedidos de compra do Bling (' + (c.motivo || 'sem resposta') + '): o comprar NÃO desconta o que está a caminho';
            return ' · ' + (c.pedidos ? num(c.pedidos) + ' pedido(s) de compra em aberto no Bling, já descontado(s) do comprar' : 'nenhum pedido de compra em aberto no Bling') +
              (c.incompleto ? ' (⚠️ lista incompleta: há mais pedidos do que consegui ler)' : '') +
              (c.skus_fora_do_plano ? ' · ' + num(c.skus_fora_do_plano) + ' produto(s) a caminho fora desta lista' : '') +
              (c.itens_sem_codigo ? ' · ⚠️ ' + num(c.itens_sem_codigo) + ' item(ns) de pedido sem código de produto (não contado)' : '');
          })(d.a_caminho);
        render();
      })
      .catch(function (e) { if (meu !== seq) return; carregando = false; solta(); PLANO = null; elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  }

  /* ⚠️ nada de onclick inline: foi um dos furos da v1 (o HTML chamava função que não existia
     no escopo). Aqui o próprio script liga os eventos nos elementos que ele mesmo criou. */
  document.getElementById('pcCalc').addEventListener('click', carregar);
  /* ⚠️ Codex #648 (P1): mexer em reposição/cobertura/segurança/curva recalcula, como na embutida.
     Sem isso o resultado antigo ficava ao lado dos parâmetros novos. Só depois de haver um
     resultado: o primeiro cálculo continua sendo clique (busca saldo no Bling, é pesado). */
  ['pcLead', 'pcCob', 'pcSeg', 'pcCurva'].forEach(function (id) {
    var e = document.getElementById(id);
    if (e) e.addEventListener('change', function () { if (PLANO) carregar(); });
  });
  /* o período: escolher "escolher datas" mostra os dois campos; mudar o período recalcula (depois do 1º cálculo), menos
     quando faltam datas — aí só espera o dono terminar de escolher */
  ['pcBase', 'pcDe', 'pcAte', 'pcRitmo'].forEach(function (id) {   /* 23/11: trocar o ritmo também recalcula */
    var e = document.getElementById(id);
    if (e) e.addEventListener('change', function () {
      var pb = document.getElementById('pcBase'), cx = document.getElementById('pcDatas');
      var porDatas = !!pb && pb.value === 'datas';
      if (cx) cx.style.display = porDatas ? '' : 'none';
      if (!jaPediu) return;
      var eDe = document.getElementById('pcDe'), eAte = document.getElementById('pcAte');
      if (porDatas && !(eDe && eDe.value && eAte && eAte.value)) return;
      carregar();
    });
  });
  document.getElementById('pcFiltro').addEventListener('input', function (ev) { filtro = ev.target.value || ''; render(); });
  /* 20/11 (pedido do dono): "podia deixar a planilha igual é hoje, mas adicionar uma imagemzinha, algo de 300x300px em
     cada linha... colocar entre B e C coluna a imagem". A planilha passa a ser .xlsx de verdade (o único formato que
     carrega imagem — e que abre sem o aviso de "formato e extensão não correspondem" que o .xls antigo dava), com a FOTO
     na coluna C e as 14 colunas de sempre, na mesma ordem, em volta dela. As fotos vêm pelo servidor
     (BASE/plano-compra/foto?sku=), que o navegador não lê imagem de outro site; foto que não vier fica em branco e a
     planilha sai assim mesmo. Sem a peça do .xlsx (ou navegador sem createImageBitmap), ou se der erro no meio, cai na
     planilha antiga — nunca fica sem planilha. */
  /* 20/11, mais tarde: o dono arrumou as primeiras linhas no Excel "pra ficar no melhor jeito" e mandou o arquivo:
     "tenta deixar igual... pra qdo baixar, já vir igualzinho assim pra todos produtos e lojas". As medidas e os destaques
     abaixo são os do arquivo dele (a Foto era a C; com o EAN de 24/11 passou pra D; a coluna da última venda, que entrou depois, é a J): foto DENTRO da célula, tudo centralizado, endereço da imagem
     clicável, "Saldo hoje" vermelho/verde, COMPRAR com fundo, valores em R$, títulos com acento. A foto vai com 300 px
     (o tamanho na tela quem dá é a célula — sobra nitidez se ele aumentar a linha). */
  var LADO_FOTO = 300;
  var MODELO = { larguras: [25.77, 16.5, 67.07, 30.07, 7.46, 10.46, 10.46, 10.46, 11.5, 10.46, 10.46, 18, 10.46, 13.5, 10.46, 10.46, 9.77, 12.3, 9.77, 12.3],
                 alturaTitulo: 43.75, alturaLinha: 102, link: [4], semaforo: [9], destaque: [15], moeda: [16, 17, 18, 19] };
  var JANELA = (typeof window !== 'undefined') ? window : {};
  var baixando = false, baixandoPedido = false;
  /* 25/11 — a planilha leva o que a tela mostra do "a caminho": a quantidade (vazia quando não deu pra ler os pedidos de
     compra — "não sei" não vira zero) e a chegada prevista, com os mesmos avisos da tela escritos por extenso */
  function chegadaNaPlanilha(i) {
    if (!(Number(i.a_caminho) > 0)) return '';
    var d = dataBR(i.chega);
    if (!d) return 'sem data prevista';
    return d + (i.a_caminho_atrasado ? ' (atrasado)' : '') + (i.a_caminho_sem_data ? ' (parte sem data)' : '') + (i.vai_faltar ? ' (acaba antes de chegar)' : '');
  }
  function linhaDaPlanilha(i) {
    /* ⚠️ Codex #646: as colunas de sempre, na mesma ordem e com os mesmos nomes — quem guarda os arquivos antigos confere
       um contra o outro. 20/11: entrou UMA, ao lado do "Acaba em (dias)" (o dono: "quem sabe fazer 1 coluna do lado...
       se tiver saldo 0, mostrando estoque zerado em e aí a data"): a data da última venda do produto ZERADO. O dia em
       que o saldo zerou ninguém guarda; a última venda é o que existe de verdade, e o título diz isso. */
    /* 23/11: e o ritmo com estoque, ao lado da média (vazio quando não há dias de venda pra medir) */
    /* 24/11: o EAN ao lado do SKU (o dono manda ao fornecedor "o sku, o EAN, e a quantidade") — como TEXTO, pra o Excel
       não transformar 13 dígitos em notação científica; vazio quando o checkout não conhece */
    return [i.sku, (i.ean ? String(i.ean) : ''), i.nome || '', i.img || '', i.curva, i.un, i.md, (i.md_estoque != null ? i.md_estoque : ''),
            (i.saldo != null ? i.saldo : ''), (i.a_caminho != null ? i.a_caminho : ''), chegadaNaPlanilha(i),
            (i.acaba_em != null ? i.acaba_em : ''), dataBR(i.ultima_venda),
            i.precisa, i.comprar, (i.custo_un != null ? i.custo_un : ''),
            (i.investir != null ? i.investir : ''), i.mc_un, i.risco];
  }
  var CAB_PLANILHA = ['SKU', 'EAN', 'Produto', 'Imagem (URL)', 'Curva', 'Vendidas na base', 'Média por dia', 'Ritmo Vendas c/ Estoque (por dia)',
                      'Saldo hoje', 'A caminho', 'Chegada prevista', 'Acaba em (dias)', 'Sem estoque desde (última venda)', 'Precisa até o próximo ciclo', 'COMPRAR',
                      'Custo unitário', 'Investimento', 'Margem por unidade', 'Lucro em risco'];
  function hojeSP() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); }
  /* 24/11: o endereço da foto no servidor e o andamento no botão valem pra planilha do plano E pro pedido do fornecedor */
  function enderecoDaFoto(i) { return i.img ? BASE + '/plano-compra/foto?sku=' + encodeURIComponent(i.sku) : ''; }
  function andamentoDasFotos(btn) { return function (f, t) { btn.textContent = 'buscando fotos ' + f + '/' + t + '…'; }; }
  function baixarComFotos(its) {
    var X = JANELA.PlanilhaXlsxFotos, btn = document.getElementById('pcCsv'), nota = document.getElementById('pcXlsInfo');
    var rotulo = btn.textContent;
    baixando = true; btn.disabled = true; nota.textContent = '';
    var ends = its.map(enderecoDaFoto);
    var comFoto = ends.filter(function (e) { return !!e; }).length;
    return X.baixarFotos(ends, { lado: LADO_FOTO, aoAvancar: andamentoDasFotos(btn) })
      .then(function (fotos) {
        var cab = CAB_PLANILHA.slice(0, 3).concat(['Foto'], CAB_PLANILHA.slice(3));
        /* a linha que TEM endereço de foto mas a foto não veio diz isso na célula (em vez de ficar um buraco mudo) */
        var ls = its.map(function (i, n) { var l = linhaDaPlanilha(i); return l.slice(0, 3).concat([(i.img && !fotos[n]) ? 'foto não veio' : ''], l.slice(3)); });
        X.salvar(X.montar({ cab: cab, linhas: ls, colFoto: 3, fotos: fotos, lado: LADO_FOTO, larguras: MODELO.larguras, alturaTitulo: MODELO.alturaTitulo, alturaLinha: MODELO.alturaLinha,
          link: MODELO.link, semaforo: MODELO.semaforo, destaque: MODELO.destaque, moeda: MODELO.moeda }), 'plano-de-compra-' + hojeSP() + '.xlsx');
        var vieram = fotos.filter(function (f) { return !!f; }).length;
        nota.textContent = vieram === comFoto ? 'planilha baixada com ' + num(vieram) + ' foto(s)'
          : 'planilha baixada — ' + num(comFoto - vieram) + ' de ' + num(comFoto) + ' foto(s) não vieram (essas linhas ficaram sem imagem)';
      })
      .catch(function () { baixarSemFotos(its); nota.textContent = 'não consegui montar a planilha com fotos — baixei no formato antigo, sem imagem'; })
      .then(function () { baixando = false; btn.disabled = false; btn.textContent = rotulo; });
  }
  document.getElementById('pcCsv').addEventListener('click', function () {
    var its = linhas();
    if (!its.length || baixando) return;
    if (JANELA.PlanilhaXlsxFotos && typeof JANELA.createImageBitmap === 'function') return baixarComFotos(its);
    baixarSemFotos(its);
  });
  /* 24/11 — O PEDIDO DO FORNECEDOR: só os itens marcados que têm quantidade, na ordem do plano, com o que o dono manda
     ao fornecedor ("o sku, o EAN, e a quantidade") mais o nome e a foto. Mesmo modelo da planilha do plano (foto dentro da
     célula); sem a peça do .xlsx, ou se der erro, sai no formato antigo — nunca fica sem o arquivo. */
  var CAB_PEDIDO = ['SKU', 'EAN', 'Produto', 'Quantidade'];
  var MODELO_PEDIDO = { larguras: MODELO.larguras.slice(0, 4).concat([14]),   /* SKU, EAN, Produto e Foto com a largura da planilha do plano */
                         foto: 3, destaque: [4], titulo: MODELO.alturaTitulo, linha: MODELO.alturaLinha };
  /* o SKU e o EAN saem IGUAIS aos da planilha do plano (as duas primeiras células dela: o EAN como texto) */
  function linhaDoPedido(i) { return linhaDaPlanilha(i).slice(0, 2).concat([i.nome || '', MARC[String(i.sku)].q]); }
  function baixarPedido() {
    var its = itensDoPedido();
    if (!its.length || baixandoPedido) return;
    var X = JANELA.PlanilhaXlsxFotos, btn = document.getElementById('pcPedido'), nota = document.getElementById('pcPedInfo');
    var ls = its.map(linhaDoPedido), nome = 'pedido-fornecedor-';
    var antiga = function () { baixarSemFotos(its, { cab: CAB_PEDIDO, linhas: ls, nome: nome }); };
    if (nota) nota.textContent = '';
    if (!(X && typeof JANELA.createImageBitmap === 'function')) { antiga(); if (nota) nota.textContent = 'pedido baixado com ' + num(its.length) + ' item(ns), sem fotos'; return; }
    baixandoPedido = true; btn.disabled = true;
    var ends = its.map(enderecoDaFoto);
    return X.baixarFotos(ends, { lado: LADO_FOTO, aoAvancar: andamentoDasFotos(btn) })
      .then(function (fotos) {
        var cab = CAB_PEDIDO.slice(0, 3).concat(['Foto'], CAB_PEDIDO.slice(3));
        var lf = ls.map(function (l, n) { return l.slice(0, 3).concat([(its[n].img && !fotos[n]) ? 'foto não veio' : ''], l.slice(3)); });
        X.salvar(X.montar({ cab: cab, linhas: lf, colFoto: MODELO_PEDIDO.foto, fotos: fotos, lado: LADO_FOTO, larguras: MODELO_PEDIDO.larguras,
          alturaTitulo: MODELO_PEDIDO.titulo, alturaLinha: MODELO_PEDIDO.linha, destaque: MODELO_PEDIDO.destaque }), nome + hojeSP() + '.xlsx');
        if (nota) nota.textContent = 'pedido baixado com ' + num(its.length) + ' item(ns)';
      })
      .catch(function () { antiga(); if (nota) nota.textContent = 'não consegui montar o pedido com fotos — baixei no formato antigo, sem imagem'; })
      .then(function () { baixandoPedido = false; resumoDaSelecao(); });
  }
  document.getElementById('pcPedido').addEventListener('click', baixarPedido);
  function baixarSemFotos(its, outra) {
    var cab = outra ? outra.cab : CAB_PLANILHA;
    var linhasXls = outra ? outra.linhas : its.map(linhaDaPlanilha);
    /* ⚠️ Codex #648 (P1): .xls de verdade (SpreadsheetML), igual ao baixarPlanilha() da embutida e
       ao da previsão — número vai como NÚMERO (soma/ordena sem depender do separador decimal do
       Windows). Texto é tipo String, então '=CMD' nunca vira fórmula: a proteção de prefixo do
       CSV deixa de ser necessária. */
    var xe = function (t) {
      return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, '');
    };
    var cel = function (v) {
      return (typeof v === 'number' && isFinite(v))
        ? '<Cell><Data ss:Type="Number">' + v + '</Data></Cell>'
        : '<Cell><Data ss:Type="String">' + xe(v) + '</Data></Cell>';
    };
    var larguras = cab.map(function (c, k) {
      var m = String(c).length;
      linhasXls.forEach(function (l) { var t = String(l[k] == null ? '' : l[k]); if (t.length > m) m = t.length; });
      return '<Column ss:AutoFitWidth="0" ss:Width="' + Math.min(320, Math.max(58, m * 6.6)) + '"/>';
    }).join('');
    var NL = String.fromCharCode(10);
    var xml =
      '<?xml version="1.0" encoding="UTF-8"?>' + NL + '<?mso-application progid="Excel.Sheet"?>' + NL +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles><Style ss:ID="cab"><Font ss:Bold="1" ss:Color="#1F3864"/><Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>' +
        '<Alignment ss:Vertical="Center"/></Style></Styles>' +
      '<Worksheet ss:Name="Dados"><Table>' + larguras +
        '<Row ss:StyleID="cab">' + cab.map(function (c) { return '<Cell ss:StyleID="cab"><Data ss:Type="String">' + xe(c) + '</Data></Cell>'; }).join('') + '</Row>' +
        linhasXls.map(function (l) { return '<Row>' + l.map(cel).join('') + '</Row>'; }).join('') +
      '</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/>' +
        '<SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>' +
      '</Worksheet></Workbook>';
    var hoje = hojeSP();
    var url = URL.createObjectURL(new Blob([String.fromCharCode(65279) + xml], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = (outra ? outra.nome : 'plano-de-compra-') + hoje + '.xls';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
})();`;
}

module.exports = { scriptDoPlano };
