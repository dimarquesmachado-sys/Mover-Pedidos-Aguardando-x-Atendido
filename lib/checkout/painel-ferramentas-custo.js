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
    tab.innerHTML =
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
