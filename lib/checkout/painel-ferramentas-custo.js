/* ════════════════════════════════════════════════════════════════════════════
   FERRAMENTAS DE CUSTO DO PAINEL — peça compartilhada (02/10).

   Mesma forma do Plano de Compra (#582/#583): gera o markup, empresa como PARÂMETRO, sem
   onclick inline, sem estado solto. Não extrai nada do painel da AMB — aquele monta a tela
   concatenando strings dentro do JS, e tentar recortar de lá foi o que fechou o #581.

   Junta duas coisas que o dono usou hoje de verdade e que a GOOD não tinha na tela:
     · DE-PARA DE SKU  — `/sku-depara-manual` devolve `pares`; é o que liga o SKU renomeado no
       Bling ao do histórico, e sem isso o produto aparece "sem custo" pra sempre;
     · CUSTOS MANUAIS  — `/custos-manuais` já serve uma TELA própria, então aqui é só o acesso.
       Card que refaz uma tela que já existe é duplicação, e duplicação diverge.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function scriptDeCusto(base) {
  const BASE = JSON.stringify(String(base || ''));
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var alvo = document.getElementById('ferramentasCustoAqui');
  if (!alvo) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  alvo.innerHTML =
    '<div class="card" style="grid-column:1/-1;margin-top:14px">' +
      '<div class="card-tit">🔧 Ferramentas de custo ' +
        '<span style="opacity:.6;font-weight:400;font-size:12px">o que resolve SKU sem custo no painel</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">' +
        /* Codex #585 (P2): LEVA A CHAVE quando a página foi aberta por '?k='. Navegação não
           passa pelo wrapper de fetch do painel, e '/custos-manuais' exige sessão ou chave —
           sem isso o dono que entra por chave clica e cai num 401. */
        '<a href="' + BASE + '/custos-manuais' + _k() + '" target="_blank" rel="noopener" ' +
          'style="padding:6px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;text-decoration:none">' +
          '✏️ custos manuais</a>' +
        '<button id="fcDepara" type="button">🔗 ver de-para de SKU</button>' +
        /* Codex #585 (P2): SÓ LISTAR NÃO RESOLVIA NADA. O caso que motivou a seção é o
           '261'/'262' — códigos antigos SEM par cadastrado. Ver a lista vazia não conserta; o
           dono precisa CRIAR o par, e a rota já aceita '?de=&para=', com as travas (de = para,
           ciclo) no servidor. A tela só manda e mostra a resposta. */
        '<input id="fcDe" placeholder="SKU antigo" style="width:130px">' +
        '<span style="opacity:.6">vira</span>' +
        '<input id="fcPara" placeholder="SKU atual" style="width:130px">' +
        '<button id="fcLigar" type="button">ligar</button>' +
        '<span id="fcInfo" style="font-size:13px;opacity:.75"></span>' +
      '</div>' +
      '<div id="fcTab" style="overflow:auto"></div>' +
      '<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        /* 09/10 - BUSCA COM SUGESTAO, medida no #663. A embutida da AMB ja prefixa o melhor
           candidato pro SKU digitado; sem isso o dono tem de descobrir e digitar o SKU novo a
           mao. Caso que originou: o 464/465, SKU renomeado que o Bling nao liga sozinho. */
        '<input id="chSku" placeholder="SKU do historico (ex.: 464)" style="min-width:200px" />' +
        '<button id="chVer" type="button">procurar o SKU novo</button>' +
      '</div>' +
      '<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        /* 09/10 - HISTORICO DE CUSTO, 3a e ultima lacuna medida no #663. O resumo em cima diz
           as TRES coisas separadas: custo no Bling hoje, custo manual e o que VALE hoje. Sem
           isso o dono ve um numero so e nao sabe de onde veio - e quando o historico e curto,
           que e justamente quando ele olha, nao da pra deduzir. */
        '<input id="hcSku" placeholder="SKU pra ver o historico de custo" style="min-width:200px" />' +
        '<button id="hcVer" type="button">ver historico</button>' +
        /* 09/10 - LANCAR CUSTO COM VIGENCIA. A tela embutida da AMB permite corrigir o custo a
           partir de uma data; sem isto a peca so LE e o dono volta a depender de outra pagina. */
        '<input id="hcNovo" inputmode="decimal" placeholder="custo novo" style="width:110px" />' +
        '<input id="hcDe" type="date" style="width:150px" title="vale a partir de (vazio = hoje)" />' +
        '<button id="hcLancar" type="button">lancar custo</button>' +
      '</div>' +
      '<div id="hcBox" style="font-size:12px"></div>' +
      '<div id="chDP" style="font-size:12px"></div>' +
      '<div id="scBloco" style="display:none;margin-top:12px;border-top:1px solid rgba(128,128,128,.25);padding-top:10px">' +
        /* 09/10 - CARD VENDEU SEM CUSTO, medido em docs/paridade-pecas.md. Na tela embutida da AMB
           ele nao so LISTA: o dono digita o custo na propria linha e salva em lote. Pedido dele em
           21/08 - sem sair do dashboard, sem pagina extra. Migrar a peca sem isto devolveria o
           trabalho de copiar a lista e abrir outra pagina. */
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px">⚠️ Venderam SEM custo ' +
          '<span style="opacity:.6;font-weight:400;font-size:12px">digite o custo e salve aqui mesmo</span></div>' +
        '<div id="scTab" style="overflow:auto"></div>' +
        '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<button id="scSalvar" type="button">💾 salvar custos digitados</button>' +
          '<button id="scCopiar" type="button">📋 copiar a lista de SKUs</button>' +
          '<span id="scMsg" style="font-size:12px;opacity:.75"></span>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* a chave da página atual, se houver — repassada só pra links do MESMO serviço */
  function _k() {
    try {
      var v = new URLSearchParams(window.location.search).get('k');
      return v ? ('?k=' + encodeURIComponent(v)) : '';
    } catch (e) { return ''; }
  }

  var elInfo = document.getElementById('fcInfo');
  var elTab = document.getElementById('fcTab');
  var bt = document.getElementById('fcDepara');

  function listar(dizer) {
    bt.disabled = true;
    if (dizer !== false) elInfo.textContent = 'carregando…';
    return fetch(BASE + '/sku-depara-manual', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { bt.disabled = false; return d; })
      .catch(function (e) { bt.disabled = false; throw e; });
  }

  document.getElementById('fcLigar').addEventListener('click', function () {
    var de = (document.getElementById('fcDe').value || '').trim();
    var para = (document.getElementById('fcPara').value || '').trim();
    if (!de || !para) { elInfo.textContent = '⚠️ preencha os dois códigos'; return; }
    var bl = document.getElementById('fcLigar');
    bl.disabled = true;
    elInfo.textContent = 'ligando…';
    fetch(BASE + '/sku-depara-manual?de=' + encodeURIComponent(de) + '&para=' + encodeURIComponent(para),
          { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        bl.disabled = false;
        /* a rota recusa de = para e ciclo, e explica — mostro o motivo dela, sem repetir a
           regra aqui: duas cópias da mesma trava divergem */
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui ligar'); return; }
        document.getElementById('fcDe').value = '';
        document.getElementById('fcPara').value = '';
        elInfo.textContent = '✓ ' + esc(de) + ' → ' + esc(para) + (d.leia ? ' · ' + esc(d.leia) : '');
        bt.click();   /* relista pra ele ver o par entrando */
      })
      .catch(function (e) { bl.disabled = false; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  });

  bt.addEventListener('click', function () {
    _paresAbertos = true;
    bt.disabled = true;
    elInfo.textContent = 'carregando…';
    fetch(BASE + '/sku-depara-manual', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        bt.disabled = false;
        if (!d || !d.ok) { elInfo.textContent = '⚠️ ' + ((d && d.erro) || 'não consegui carregar'); elTab.innerHTML = ''; return; }
        /* Codex #585 (P2): 'pares' É UMA LISTA de {de, para, em}, não um mapa — eu inventei a
           forma em vez de ler o produtor, e 'Object.keys' devolveria 0,1,2…: a tabela mostraria
           ÍNDICES no lugar dos SKUs. Já vem ordenada da rota, então não reordeno. */
        var pares = Array.isArray(d.pares) ? d.pares : [];
        elInfo.textContent = pares.length ? (pares.length + ' par(es) cadastrado(s)') : 'nenhum par cadastrado';
        if (!pares.length) { elTab.innerHTML = ''; return; }
        elTab.innerHTML =
          '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:6px">' +
          '<thead><tr style="text-align:left;opacity:.7"><th>SKU antigo</th><th>vira</th><th>desde</th></tr></thead><tbody>' +
          pares.map(function (pr) {
            return '<tr style="border-top:1px solid rgba(128,128,128,.25)">' +
              '<td style="padding:4px 0">' + esc(pr && pr.de) + '</td>' +
              '<td>' + esc(pr && pr.para) + '</td>' +
              '<td style="opacity:.65">' + esc((pr && pr.em) ? String(pr.em).slice(0, 10) : '—') + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function (e) { bt.disabled = false; elTab.innerHTML = ''; elInfo.textContent = '⚠️ ' + (e && e.message ? e.message : e); });
  });
  /* a chave vai junto do parametro: _k() devolve '?k=...' ou '', entao aqui eu junto o
     'sugerir=' com o separador certo nos dois casos. */
  function _k2(qs) { var k = _k(); return k ? (k + '&' + qs) : ('?' + qs); }

  /* --- procurar o SKU novo, com sugestao ------------------------------------------- */
  var elSku = document.getElementById('chSku');
  var btVer = document.getElementById('chVer');
  var elDP = document.getElementById('chDP');

  var _seqDP = 0;
  function verDeParaSku() {
    /* Codex #665 (P1): buscar A e depois B fazia a resposta de A pintar DEPOIS da de B - lista de
       um SKU embaixo de um campo com outro. Numero de ordem: so a busca mais nova pinta. */
    var meu = ++_seqDP;
    var sku = String((elSku && elSku.value) || '').trim();
    if (!elDP) return;
    if (!sku) { elDP.innerHTML = ''; return; }
    elDP.innerHTML = '<div style="opacity:.7;margin-top:8px">procurando...</div>';
    fetch(BASE + '/sku-depara-manual' + _k2('sugerir=' + encodeURIComponent(sku)), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (meu !== _seqDP) return;
        /* Codex #665: exijo ok === true. Sessao invalida devolve { error: not found } SEM ok, e eu
           tratava como sucesso: dizia "nenhum candidato" e o dono concluia que o catalogo nao tem
           o SKU. Numero errado e pior que numero ausente. */
        if (!j || j.ok !== true) { elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((j && (j.erro || j.error)) || 'nao consegui consultar') + '</div>'; return; }
        var sug = j.sugestoes || [];
        /* o VINCULO ATUAL vem primeiro: sem ele o campo aparecia preenchido com a sugestao e
           PARECIA ligado sem estar - achado da revisao de 21/08 na tela embutida. */
        /* Codex #665 (P1): a rota devolve vinculo como { de, para, em } - .destino NUNCA existe.
           Eu escondia o vinculo REAL e ainda convidava a sobrescrever uma ligacao valida.
           Li a rota: lib/checkout/rota-depara-sku.js. */
        var vinc = j.vinculo || null;
        var jaPara = (vinc && (vinc.para || vinc.destino)) ? String(vinc.para || vinc.destino) : '';
        var h = '<div style="margin-top:8px">';
        if (jaPara) {
          h += '<div>\u2713 <b>' + _esc(sku) + '</b> ja esta ligado a <b>' + _esc(jaPara) + '</b>' +
               '<button id="chDesfaz" type="button" style="margin-left:8px">desfazer ligacao</button></div>';
        } else if (!sug.length) {
          h += '<div style="opacity:.7">nenhum candidato parecido no catalogo</div>';
        } else {
          h += '<div style="opacity:.7;margin-bottom:4px">SKUs do catalogo que CONTEM esse codigo ' +
            '(sem ordem de semelhanca - confira antes de ligar):</div>';
          h += sug.slice(0, 8).map(function (x) {
            /* Codex #665: sugerirDeParaSku devolve STRINGS, nao objetos - x.nome e x.custo nunca
               existiriam. Mostro o que realmente vem. */
            var alvo = (x && x.sku) ? x.sku : x;
            return '<div style="margin:2px 0"><b>' + _esc(alvo) + '</b>' +
                   (x.nome ? ' <span style="opacity:.65">' + _esc(String(x.nome).slice(0, 55)) + '</span>' : '') +
                   (x.custo != null ? ' <span style="opacity:.65">custo ' + _brl(x.custo) + '</span>' : '') +
                   ' <button type="button" class="chLig" data-de="' + _esc(sku) + '" data-para="' + _esc(alvo) + '">ligar</button></div>';
          }).join('');
        }
        elDP.innerHTML = h + '</div>';
      })
      .catch(function (e) { if (meu !== _seqDP) return; elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((e && e.message) || e) + '</div>'; });
  }

  if (btVer) btVer.addEventListener('click', verDeParaSku);
  /* editar o campo invalida o que esta na tela: resultado de outro SKU embaixo do campo novo
     parece resultado dele. */
  if (elSku) elSku.addEventListener('input', function () { _seqDP++; if (elDP) elDP.innerHTML = ''; });
  if (elSku) elSku.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') verDeParaSku(); });

  /* um ouvinte so, no container: as linhas sao redesenhadas a cada busca, e ouvinte por botao
     vazaria a cada redesenho. */
  if (elDP) elDP.addEventListener('click', function (ev) {
    var alvo = ev.target;
    if (!alvo || !alvo.getAttribute) return;
    if (alvo.id === 'chDesfaz') { _apagarDePara(String((elSku && elSku.value) || '').trim()); return; }
    if (alvo.className && String(alvo.className).indexOf('chLig') >= 0) {
      _gravarDePara(alvo.getAttribute('data-de'), alvo.getAttribute('data-para'));
    }
  });

  /* Codex #665: a TABELA de pares tambem reflete a mudanca. Reuso o caminho que o botao ligar ja
     usava (bt.click()), em vez de escrever um segundo jeito de listar - duas copias da mesma coisa
     divergem, licao do #585 neste mesmo arquivo. So relisto se a tabela JA foi aberta. */
  var _paresAbertos = false;
  function _recarregarPares() {
    /* Codex #665: olhar o innerHTML nao servia - quando NAO ha nenhum par, o listar deixa a
       tabela VAZIA de proposito. Quem abriu a tabela nesse estado e criou o primeiro par pela
       busca continuava vendo "nenhum par cadastrado". Marco que ela foi aberta, em vez de
       adivinhar pelo conteudo. */
    try { if (_paresAbertos && bt) bt.click(); } catch (e) {}
  }

  function _apagarDePara(de) {
    /* Codex #665: a rota so remove com { apagar: de } - { de, para: '' } tomava 400 informe de e
       para. O botao de desfazer que eu anunciava NUNCA funcionaria. Li a rota. */
    if (!de) return;
    /* Codex #665: PERGUNTA ANTES. Um clique torto apaga a ligacao e muda de onde vem o custo
       daquele SKU, sem volta - o destino anterior nao fica guardado em lugar nenhum. A tela
       embutida ja confirmava; eu tinha deixado passar. */
    if (!window.confirm('Desfazer a ligacao manual de ' + de + '?')) return;
    elDP.innerHTML = '<div style="opacity:.7;margin-top:8px">desfazendo...</div>';
    fetch(BASE + '/sku-depara-manual' + _k(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ apagar: de }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true) { elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((j && (j.erro || j.error)) || 'nao consegui desfazer') + '</div>'; return; }
        verDeParaSku();
        _recarregarPares();
      })
      .catch(function (e) { elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((e && e.message) || e) + '</div>'; });
  }

  function _gravarDePara(de, para) {
    if (!de) return;
    elDP.innerHTML = '<div style="opacity:.7;margin-top:8px">gravando...</div>';
    fetch(BASE + '/sku-depara-manual' + _k(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ de: de, para: para }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((j && (j.erro || j.error)) || 'nao consegui gravar') + '</div>'; return; }
        verDeParaSku();   /* mostra o estado NOVO, em vez de uma mensagem que o dono tem de acreditar */
        _recarregarPares();
      })
      .catch(function (e) { elDP.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((e && e.message) || e) + '</div>'; });
  }
  /* --- historico de custo, com o resumo das tres origens ---------------------------- */
  var elHcSku = document.getElementById('hcSku');
  var btHc = document.getElementById('hcVer');
  var elHc = document.getElementById('hcBox');
  var _seqHC = 0;

  function _dmy(d) { return String(d || '').slice(0, 10).split('-').reverse().join('/'); }
  /* Codex #667 (P2): MESMA data de negocio do backend (UTC-3), como o painel-ficha-produto -
     o relogio do navegador pode estar noutro fuso e rotular de "hoje" o que ainda e amanha. */
  function _hojeISO() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

  function verHistoricoCusto() {
    if (!elHc) return;
    var sku = String((elHcSku && elHcSku.value) || '').trim();
    if (!sku) { elHc.innerHTML = ''; return; }
    var meu = ++_seqHC;
    elHc.innerHTML = '<div style="opacity:.7;margin-top:8px">consultando...</div>';
    fetch(BASE + '/custo-historico' + _k2('sku=' + encodeURIComponent(sku)), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (meu !== _seqHC) return;
        if (!j || j.ok !== true) { elHc.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((j && (j.erro || j.error)) || 'nao consegui consultar') + '</div>'; return; }
        var f = Array.isArray(j.faixas) ? j.faixas : (Array.isArray(j.historico) ? j.historico : []);
        /* as TRES separadas: so assim o dono sabe se o numero que o painel usa veio do Bling ou
           de uma correcao manual dele. */
        var resumo = '<div style="opacity:.75;margin:8px 0 6px">' +
          'custo no Bling hoje: <b>' + (j.custo_atual_bling != null ? _brl(j.custo_atual_bling) : '\u2014') + '</b>' +
          (j.custo_manual != null ? (' \u00b7 manual: <b>' + _brl(j.custo_manual) + '</b>') : '') +
          (j.vigente_hoje != null ? (' \u00b7 vigente: <b>' + _brl(j.vigente_hoje) + '</b>') : '') +
        '</div>';
        var linhas = f.length
          ? f.map(function (x) {
              /* faixa agendada (de no futuro) NAO e o custo de hoje: vigente_hoje ainda e o anterior */
              var futura = x.de && String(x.de).slice(0, 10) > _hojeISO();
              var ate = x.ate ? _dmy(x.ate) : (futura ? 'a partir de ' + _dmy(x.de) : '<b>hoje</b>');
              return '<tr><td><b>' + _brl(x.custo) + '</b></td><td>' + _dmy(x.de) + '</td><td>' + ate + '</td>' +
                     '<td style="opacity:.7">' + (x.origem === 'manual' ? 'manual' : 'Bling') + '</td>' +
                     '<td style="text-align:right"><button type="button" class="hcDel" data-de="' + _esc(x.de) + '"' + (_gravando ? ' disabled' : '') + '>apagar</button></td></tr>';
            }).join('')
          : '<tr><td colspan="5" style="opacity:.7">sem historico ainda</td></tr>';
        elHc.innerHTML = resumo +
          '<table style="width:100%;font-size:12px"><thead><tr>' +
            '<th style="text-align:left">custo</th><th style="text-align:left">de</th>' +
            '<th style="text-align:left">ate</th><th style="text-align:left">origem</th><th></th>' +
          '</tr></thead><tbody>' + linhas + '</tbody></table>';
      })
      .catch(function (e) { if (meu !== _seqHC) return; elHc.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((e && e.message) || e) + '</div>'; });
  }

  var _gravando = false;
  /* Codex #668: numero de ordem SO da troca de SKU (editar o campo). Ver historico do MESMO SKU
     mexe no _seqHC mas nao muda o dono; se a escrita olhasse o _seqHC, a recarga pos-gravacao
     seria descartada e a tela ficaria com a linha velha. */
  var _seqSku = 0;
  /* Codex #668: em vez de engolir o clique em silencio, os controles de escrita ficam DESABILITADOS
     enquanto o POST esta em voo (e as linhas redesenhadas nascem desabilitadas). */
  function _travaEscrita(on) {
    var ids = ['hcLancar', 'hcNovo', 'hcDe'];
    for (var i = 0; i < ids.length; i++) { var e = document.getElementById(ids[i]); if (e) e.disabled = !!on; }
    if (elHc) {
      var bs = elHc.querySelectorAll('.hcDel');
      for (var k = 0; k < bs.length; k++) bs[k].disabled = !!on;
    }
  }
  function _gravarCusto(corpo, oQue) {
    /* Codex #668: UMA escrita por vez. Dois cliques rapidos em lancar (ou lancar com um apagar em
       voo) disparavam POSTs independentes, e a ordem de chegada decidia qual custo fica - podendo
       gravar o valor VELHO por cima do novo. */
    if (_gravando) return Promise.resolve(false);
    _gravando = true;
    _travaEscrita(true);
    /* Codex #668: o numero de ordem vale pra escrita tambem. Erro de uma gravacao do SKU A nao
       pode pintar por cima do historico do SKU B que o dono ja esta vendo. */
    var meuG = _seqSku;
    var solta = function () { _gravando = false; _travaEscrita(false); };
    return fetch(BASE + '/custo-historico' + _k(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(corpo),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        solta();
        if (meuG !== _seqSku) return false;   /* o dono ja trocou de SKU: nao pinto nada */
        if (!j || j.ok !== true) {
          elHc.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((j && (j.erro || j.error)) || ('nao consegui ' + oQue)) + '</div>';
          return false;
        }
        verHistoricoCusto();   /* mostra o estado NOVO em vez de uma mensagem pra acreditar */
        return true;
      })
      .catch(function (e) {
        solta();
        if (meuG !== _seqSku) return false;
        elHc.innerHTML = '<div style="margin-top:8px">\u26A0\uFE0F ' + _esc((e && e.message) || e) + '</div>';
        return false;
      });
  }

  var btLanc = document.getElementById('hcLancar');
  if (btLanc) btLanc.addEventListener('click', function () {
    var sku = String((elHcSku && elHcSku.value) || '').trim();
    var novo = String((document.getElementById('hcNovo') || {}).value || '').trim();
    var de = String((document.getElementById('hcDe') || {}).value || '').trim();
    if (!sku) { if (elHc) elHc.innerHTML = '<div style="margin-top:8px">digite o SKU</div>'; return; }
    if (!novo) { if (elHc) elHc.innerHTML = '<div style="margin-top:8px">digite o custo</div>'; return; }
    /* aceita 12,50 e R$ 12,50, como o card de sem custo */
    var v = Number(novo.replace(/[R$\\s]/gi, '').replace(',', '.'));
    if (!isFinite(v) || v <= 0) { if (elHc) elHc.innerHTML = '<div style="margin-top:8px">custo invalido</div>'; return; }
    if (_gravando) return;   /* nao pinto "lancando..." por cima de uma gravacao em voo */
    elHc.innerHTML = '<div style="opacity:.7;margin-top:8px">lancando...</div>';
    _gravarCusto({ sku: sku, custo: v, de: de || undefined }, 'lancar o custo');
  });

  /* um ouvinte no container: as linhas sao redesenhadas a cada consulta */
  if (elHc) elHc.addEventListener('click', function (ev) {
    var alvo = ev.target;
    if (!alvo || !alvo.className || String(alvo.className).indexOf('hcDel') < 0) return;
    var de = alvo.getAttribute('data-de');
    var sku = String((elHcSku && elHcSku.value) || '').trim();
    if (!de || !sku) return;
    /* PERGUNTA ANTES: apagar faixa muda o custo que o painel usa no periodo dela, sem volta. */
    if (!window.confirm('Apagar a faixa que comeca em ' + _dmy(de) + '?')) return;
    if (_gravando) return;
    elHc.innerHTML = '<div style="opacity:.7;margin-top:8px">apagando...</div>';
    _gravarCusto({ sku: sku, apagar: de }, 'apagar a faixa');
  });
  if (btHc) btHc.addEventListener('click', verHistoricoCusto);
  if (elHcSku) elHcSku.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') verHistoricoCusto(); });
  /* mesma regra da outra busca: editar o campo invalida o que esta na tela */
  if (elHcSku) elHcSku.addEventListener('input', function () {
    _seqHC++; _seqSku++;
    if (elHc) elHc.innerHTML = '';
    /* Codex #668 (P1): LIMPA custo e data tambem. Os campos ficam FORA da caixa do resultado,
       entao trocar de SKU deixava o valor do anterior ali - e um clique em lancar gravaria o
       custo do produto A no produto B. Numero errado e pior que numero ausente. */
    var cn = document.getElementById('hcNovo'); if (cn) cn.value = '';
    var cd = document.getElementById('hcDe'); if (cd) cd.value = '';
  });
  /* --- card vendeu sem custo ------------------------------------------------------- */
  function _esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function _n(v) { return (Number(v) || 0).toLocaleString('pt-BR'); }
  function _brl(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

  var _semCusto = [];
  function desenharSemCusto(lista, total) {
    /* Codex #664 (P1): o /historico-longo manda so a lista de SKUs (strings) - nome/un/valor
       existem apenas na tela embutida. Aceito os dois formatos e mostro traco no que faltar. */
    _semCusto = (lista || []).map(function (x) { return (x && typeof x === 'object') ? x : { sku: x }; });
    var totalReal = Math.max(Number(total) || 0, _semCusto.length);
    var bloco = document.getElementById('scBloco');
    var tab = document.getElementById('scTab');
    if (!bloco || !tab) return;
    /* sem SKU sem custo o card SOME, em vez de deixar um vazio dizendo nenhum - que vira ruido
       permanente no painel. Mesmo comportamento da tela embutida. */
    if (!_semCusto.length) { bloco.style.display = 'none'; return; }
    bloco.style.display = '';
    /* Codex #669 (P2): resumo do que fica FORA da margem (SKUs, unidades, faturamento). So aparece
       quando a lista traz un/valor (AMB); a GOOD manda SKUs em string e nao tem esses numeros. */
    var comNum = _semCusto.filter(function (x) { return x.un != null || x.valor != null; });
    var resumo = comNum.length
      ? '<div style="opacity:.75;font-size:12px;margin-bottom:6px"><b>' + _n(totalReal) + '</b> SKU(s) · ' +
        _n(comNum.reduce(function (s, x) { return s + (Number(x.un) || 0); }, 0)) + ' unidade(s) · ' +
        _brl(comNum.reduce(function (s, x) { return s + (Number(x.valor) || 0); }, 0)) + ' de faturamento fora da margem</div>'
      : '';
    tab.innerHTML = resumo +
      '<table style="width:100%;font-size:12px"><thead><tr>' +
        '<th style="text-align:left">SKU</th><th style="text-align:left">Produto</th>' +
        '<th style="text-align:right">un.</th><th style="text-align:right">pedidos</th>' +
        '<th style="text-align:right">R$ vendido</th><th style="text-align:right">custo/un. R$</th>' +
      '</tr></thead><tbody>' +
      _semCusto.slice(0, 60).map(function (x) {
        var tem = function (v) { return v != null && v !== ''; };
        return '<tr><td><b>' + _esc(x.sku) + '</b></td>' +
          '<td style="opacity:.75">' + _esc(String(x.nome || '').slice(0, 60)) + '</td>' +
          '<td style="text-align:right">' + (tem(x.un) ? _n(x.un) : '—') + '</td>' +
          '<td style="text-align:right">' + (tem(x.pedidos) ? _n(x.pedidos) : '—') + '</td>' +
          '<td style="text-align:right;color:#f87171">' + (tem(x.valor) ? _brl(x.valor) : '—') + '</td>' +
          '<td style="text-align:right"><input class="scIn" data-sku="' + _esc(x.sku) + '" ' +
            'inputmode="decimal" style="width:92px;text-align:right" placeholder="0,00" /></td></tr>';
      }).join('') + '</tbody></table>' +
      (totalReal > Math.min(_semCusto.length, 60)
        ? '<div style="opacity:.6;font-size:11px;margin-top:4px">mostrando ' + _n(Math.min(_semCusto.length, 60)) + ' de ' + _n(totalReal) + ' SKU(s) sem custo</div>'
        : '');
  }

  var btSalvar = document.getElementById('scSalvar');
  var btCopiar = document.getElementById('scCopiar');
  var msgSc = document.getElementById('scMsg');

  if (btSalvar) btSalvar.addEventListener('click', function () {
    var ins = Array.prototype.slice.call(document.querySelectorAll('#scTab input.scIn'));
    var itens = [];
    for (var i = 0; i < ins.length; i++) {
      /* aceita 12,50 / R$ 12,50 / 12.50 - o dono digita como esta acostumado */
      var bruto = String(ins[i].value || '').trim().replace(/[R$\\s]/gi, '').replace(',', '.');
      if (!bruto) continue;
      var v = Number(bruto);
      /* Codex #664 (P2): campo preenchido e invalido NAO pode ser descartado em silencio - o
         salvamento parcial parecia completo. Paro e aponto o SKU. */
      if (!isFinite(v) || v <= 0) {
        if (msgSc) msgSc.textContent = '⚠️ custo invalido em ' + ins[i].getAttribute('data-sku') + ' (' + ins[i].value + ') - corrija ou apague o campo';
        ins[i].focus();
        return;
      }
      itens.push({ sku: ins[i].getAttribute('data-sku'), custo: v });
    }
    if (!itens.length) { if (msgSc) msgSc.textContent = 'digite o custo de pelo menos um SKU'; return; }
    btSalvar.disabled = true; btSalvar.textContent = 'salvando...';
    var solta = function () { btSalvar.disabled = false; btSalvar.textContent = '\uD83D\uDCBE salvar custos digitados'; };
    fetch(BASE + '/custos-manuais' + _k(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ itens: itens }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        solta();
        if (!j || !j.ok) { if (msgSc) msgSc.textContent = '\u26A0\uFE0F ' + ((j && (j.erro || j.error)) || 'nao consegui salvar'); return; }
        /* Codex #664 (P2): o agregado do /historico-longo fica em cache; quem hospeda o painel
           registra a recarga com fresh=1. Sem ela, so aviso - nao prometo efeito imediato. */
        if (typeof window.ferramentasCustoRecarregar === 'function') {
          if (msgSc) msgSc.textContent = '\u2713 ' + itens.length + ' custo(s) salvo(s) - atualizando o painel...';
          window.ferramentasCustoRecarregar();
        } else if (msgSc) msgSc.textContent = '\u2713 ' + itens.length + ' custo(s) salvo(s) - recarregue o periodo com fresh=1 pra ver o efeito';
      })
      .catch(function (e) { solta(); if (msgSc) msgSc.textContent = '\u26A0\uFE0F ' + ((e && e.message) || e); });
  });

  if (btCopiar) btCopiar.addEventListener('click', function () {
    var txt = _semCusto.map(function (x) { return x.sku; }).join('\\n');
    var ok = function () { if (msgSc) msgSc.textContent = '\u2713 ' + _semCusto.length + ' SKU(s) copiado(s)'; };
    /* navegador sem clipboard, ou permissao negada (rejeicao ASSINCRONA, que try/catch nao
       pega - Codex #664): mostro a lista pra copiar a mao, em vez de falhar calado */
    var manual = function () { try { window.prompt('copie a lista:', txt); } catch (e) {} };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, manual);
      } else { manual(); ok(); }
    } catch (e) { manual(); }
  });

  /* quem monta o painel chama isto com a lista (SKUs em string ou {sku,nome,un,pedidos,valor}) e,
     opcionalmente, o total real; a GOOD passa totais.skus_sem_custo e skus_sem_custo_total */
  window.ferramentasCustoSemCusto = desenharSemCusto;
  if (window.__semCustoPend) desenharSemCusto(window.__semCustoPend[0], window.__semCustoPend[1]);
})();`;
}

module.exports = { scriptDeCusto };
