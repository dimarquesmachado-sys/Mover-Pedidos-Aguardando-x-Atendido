/* =========================================================
   ESTEIRA BLING - EXPORTADOR MULTILOJA v0.4.0
   ---------------------------------------------------------
   - Fica recolhida num botao flutuante ("Esteira") na tela
     de produtos do Bling. Clicou, abre o quadro completo.
   - Quadro maior, com log detalhado: erros aparecem POR
     EXTENSO no log (alem do relatorio JSON).
   - Da pra minimizar enquanto roda: o botao mostra o
     progresso (ex: "Esteira 2/5...").
   Fluxo por marketplace: abre modal -> escolhe plataforma
   pelo NOME -> deposito GERAL fixo -> exporta -> vigia o
   resultado (sem tempo fixo) -> registra -> OK -> proximo.
   ========================================================= */

(function () {
  'use strict';

  var VERSAO = 'esteira v0.24.2';
  var TIMEOUT_RESULTADO_MS = 240000;
  var TIMEOUT_MODAL_MS = 20000;
  var PAUSA_ENTRE_MS = 1500;
  var POLL_MS = 500;

  var SEL_BTN_ABRIR = '#exportarProdutosLojasVirtuais';
  var SEL_LOJAS = '#listaLojasAtivasModalExport';
  var SEL_DEPOSITO = '#listaDeposistosProduct';
  var DEPOSITO_PADRAO = 'geral';

  var RX_SUCESSO = /Conclu[i\u00ed]do com sucesso/i;
  var RX_PARCIAL = /conclu[i\u00ed]dos com erro/i;
  var RX_ERRO_GERAL = /Ocorreu um erro durante a exporta/i;
  var RX_N_SUCESSO = /(\d+)\s*Exporta[\u00e7c][\u00e3a]o com sucesso/i;
  var RX_N_ERRO = /(\d+)\s*Exporta[\u00e7c][\u00e3a]o com erro/i;

  var rodando = false;
  var ocupado = false;
  var produtosRun = [];
  var hookAtivo = false;
  var ultimoVinculoAberto = { id: '', t: 0 };
  var ultimoSalvamento = { t: 0 };

  window.addEventListener('message', function (ev) {
    if (!ev || ev.source !== window || !ev.data) return;
    if (ev.data.__esteiraHookOk === true) hookAtivo = true;
    if (ev.data.__esteiraVinculoAberto === true) {
      ultimoVinculoAberto = { id: String(ev.data.idProduto || ''), t: ev.data.t || Date.now() };
    }
    if (ev.data.__esteiraSalvou === true) {
      ultimoSalvamento = { t: ev.data.t || Date.now() };
    }
  });

  function pingarHook() {
    try { window.postMessage({ __esteiraHookPing: true }, '*'); } catch (e) {}
  } // [{id, rotulo, nome}] da ultima pre-checagem
  var pararPedido = false;
  var resultados = [];
  var cacheLojas = [];

  /* ---------------- helpers ---------------- */

  function visivel(el) {
    if (!el) return false;
    var r = el.getClientRects();
    return !!(r && r.length && r[0].width > 0);
  }

  function txt(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function dialogoVisivelContendo(seletorInterno) {
    var dialogos = document.querySelectorAll('body > .ui-dialog');
    for (var i = 0; i < dialogos.length; i++) {
      if (visivel(dialogos[i]) && dialogos[i].querySelector(seletorInterno)) return dialogos[i];
    }
    return null;
  }

  function dialogoVisivelComTexto(rx) {
    var dialogos = document.querySelectorAll('body > .ui-dialog');
    for (var i = 0; i < dialogos.length; i++) {
      if (visivel(dialogos[i]) && rx.test(txt(dialogos[i]))) return dialogos[i];
    }
    return null;
  }

  function botaoNoDialogo(dialogo, textoBotao) {
    if (!dialogo) return null;
    var botoes = dialogo.querySelectorAll('.ui-dialog-buttonpane button, button');
    var alvo = textoBotao.toLowerCase();
    for (var i = 0; i < botoes.length; i++) {
      if (txt(botoes[i]).toLowerCase() === alvo && visivel(botoes[i])) return botoes[i];
    }
    return null;
  }

  function setSelect(sel, valor) {
    sel.value = valor;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function espera(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function esperarPor(fnCheque, timeoutMs, descricao) {
    var inicio = Date.now();
    return new Promise(function (res, rej) {
      (function tenta() {
        if (pararPedido && rodando) return rej(new Error('interrompido'));
        var v = null;
        try { v = fnCheque(); } catch (e) {}
        if (v) return res(v);
        if (Date.now() - inicio > timeoutMs) return rej(new Error('timeout: ' + descricao));
        setTimeout(tenta, POLL_MS);
      })();
    });
  }

  function contarSelecionados() {
    return document.querySelectorAll('input[id^="marcadodatatable"]:checked').length;
  }

  /* ---------------- leitura de marketplaces ---------------- */

  function lerLojasDoSelectVivo() {
    var sel = document.querySelector(SEL_LOJAS);
    if (!sel || !sel.options || sel.options.length < 2) return null;
    return Array.prototype.slice.call(sel.options)
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) { return { texto: txt(o), valor: o.value }; });
  }

  function salvarCacheLojas(lojas) {
    cacheLojas = lojas;
    chrome.storage.local.set({ esteira_lojas_cache: lojas });
  }

  async function lerMarketplacesDoBling() {
    if (rodando) return;
    if (contarSelecionados() === 0) {
      log('Selecione pelo menos 1 SKU na listagem antes de ler os marketplaces (o Bling exige).', 'aviso');
      return;
    }
    var btn = document.querySelector(SEL_BTN_ABRIR);
    if (!btn) {
      log('Botao "Exportar produtos multiloja" nao encontrado nesta tela.', 'erro');
      return;
    }
    log('Abrindo janela de exportacao para ler os marketplaces...');
    btn.click();
    try {
      await esperarPor(function () {
        var l = lerLojasDoSelectVivo();
        return (l && l.length) ? l : null;
      }, TIMEOUT_MODAL_MS, 'janela de exportacao abrir');
      var lojas = lerLojasDoSelectVivo();
      fecharDialogoDoSelect();
      salvarCacheLojas(lojas);
      renderizarLista();
      log('Lista atualizada: ' + lojas.length + ' marketplaces encontrados.', 'ok');
    } catch (e) {
      fecharDialogoDoSelect();
      log('Nao consegui ler: ' + (e && e.message || e), 'erro');
    }
  }

  function fecharDialogoDoSelect() {
    var dlg = dialogoVisivelContendo(SEL_LOJAS);
    if (!dlg) return;
    var cancelar = botaoNoDialogo(dlg, 'cancelar');
    var fechar = dlg.querySelector('.ui-dialog-titlebar-close');
    if (cancelar) cancelar.click();
    else if (fechar) fechar.click();
  }

  setInterval(function () {
    if (rodando) return;
    var lojas = lerLojasDoSelectVivo();
    if (lojas && lojas.length && JSON.stringify(lojas) !== JSON.stringify(cacheLojas)) {
      salvarCacheLojas(lojas);
      renderizarLista();
    }
  }, 1500);

  /* ---------------- pre-checagem de vinculos multiloja ---------------- */

  var URL_VINCULOS = 'https://www.bling.com.br/services/produtos.server.php?f=obterVinculoProdutosMultilojas';

  function idsProdutosSelecionados() {
    var out = [];
    document.querySelectorAll('input[id^="marcadodatatable"]:checked').forEach(function (c) {
      var id = c.id.replace('marcadodatatable', '');
      if (/^\d+$/.test(id)) out.push(id);
    });
    return out;
  }

  function idLojaDoNome(nome) {
    var alvo = nome.trim().toLowerCase();
    for (var i = 0; i < (cacheLojas || []).length; i++) {
      if ((cacheLojas[i].texto || '').trim().toLowerCase() === alvo) {
        var v = String(cacheLojas[i].valor || '').split(';')[0];
        if (/^\d+$/.test(v)) return v;
      }
    }
    return null;
  }

  function vinculoReal(v) {
    var id = String(v && v.id != null ? v.id : '');
    var ipl = String(v && v.idProdutoLoja != null ? v.idProdutoLoja : '');
    return (id !== '' && id !== '0') || (ipl !== '' && ipl !== '0');
  }

  async function buscarVinculos(idProduto) {
    var corpo = 'xajax=obterVinculoProdutosMultilojas&xajaxr=' + Date.now() +
      '&xajaxargs[]=' + encodeURIComponent(idProduto);
    var r = await fetch(URL_VINCULOS, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: corpo
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json(); // { nomeProduto, vinculosLojas: [{ idLoja, nomeLoja, sku, ... }] }
  }

  async function mapaComLimite(itens, limite, fn) {
    var resultados = new Array(itens.length);
    var indice = 0;
    async function operario() {
      while (indice < itens.length) {
        if (pararPedido) throw new Error('interrompido');
        var i = indice++;
        resultados[i] = await fn(itens[i], i);
      }
    }
    var operarios = [];
    for (var k = 0; k < Math.min(limite, itens.length); k++) operarios.push(operario());
    await Promise.all(operarios);
    return resultados;
  }

  // Retorna dados por produto (matriz) e por marketplace
  async function preChecarVinculos(marcadas) {
    var ids = idsProdutosSelecionados();
    if (!ids.length) return { falhou: true };
    log('Pre-checando vinculos multiloja de ' + ids.length + ' SKU(s)...');
    atualizarPill('\uD83D\uDD0D Checando vinculos...');
    var dados;
    try {
      dados = await mapaComLimite(ids, 4, function (id) { return buscarVinculos(id); });
    } catch (e) {
      if (/interrompido/.test(String(e))) throw e;
      log('Pre-checagem indisponivel (' + (e && e.message || e) + '). Exportando sem checar.', 'aviso');
      return { falhou: true };
    }
    var produtos = ids.map(function (id, i) {
      var d = dados[i] || {};
      var vinculos = d.vinculosLojas || [];
      var rotulo = (vinculos[0] && vinculos[0].sku) || (d.nomeProduto || ('produto ' + id)).slice(0, 40);
      return { id: id, rotulo: rotulo, nome: d.nomeProduto || '', vinculos: vinculos, tem: {} };
    });
    var porMarketplace = {};
    marcadas.forEach(function (nomeMk) {
      var idLoja = idLojaDoNome(nomeMk);
      var info = { tem: 0, total: ids.length, faltando: [], idsFaltando: [] };
      produtos.forEach(function (p) {
        var achou = p.vinculos.some(function (v) {
          var mesmaLoja = (idLoja && String(v.idLoja) === idLoja) ||
            String(v.nomeLoja || '').trim().toLowerCase() === nomeMk.trim().toLowerCase();
          return mesmaLoja && vinculoReal(v);
        });
        p.tem[nomeMk] = achou;
        if (achou) info.tem++;
        else { info.faltando.push(p.rotulo); info.idsFaltando.push(p.id); }
      });
      porMarketplace[nomeMk] = info;
    });
    return { porMarketplace: porMarketplace, produtos: produtos, marcadas: marcadas.slice(), falhou: false };
  }

  function alternarSelecao(ids, marcar) {
    (ids || []).forEach(function (id) {
      var cb = document.getElementById('marcadodatatable' + id);
      if (cb && cb.checked !== marcar) cb.click();
    });
  }

  function exportarPlanilha(check) {
    if (!check || check.falhou || !(check.produtos || []).length) return;
    function campo(v) {
      v = String(v == null ? '' : v);
      return (v.indexOf(';') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1)
        ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var linhas = [];
    linhas.push(['SKU', 'Produto'].concat(check.marcadas).map(campo).join(';'));
    check.produtos.forEach(function (p) {
      var linha = [p.rotulo, p.nome];
      check.marcadas.forEach(function (mk) { linha.push(p.tem[mk] ? 'SIM' : 'NAO'); });
      linhas.push(linha.map(campo).join(';'));
    });
    var csv = '\uFEFF' + linhas.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vinculos-multiloja-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    log('Planilha baixada: ' + check.produtos.length + ' SKU(s) x ' + check.marcadas.length + ' marketplaces.', 'ok');
  }

  /* ========== FASE 2A: planilha de preenchimento multiloja ========== */

  function csvCampo(v) {
    v = String(v == null ? '' : v);
    return (v.indexOf(';') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1)
      ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function baixarCsv(nomeBase, linhas) {
    var csv = '\uFEFF' + linhas.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nomeBase + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // "1.099,9000000000" -> "1099,90"
  function fmtPrecoBr(s) {
    s = String(s == null ? '' : s).replace(/\./g, '');
    if (!s) return '';
    var partes = s.split(',');
    var dec = (partes[1] || '00').slice(0, 2);
    while (dec.length < 2) dec += '0';
    return partes[0] + ',' + dec;
  }

  /* ---- mini gerador de XLSX (sem bibliotecas) ---- */

  var tabelaCrc = (function () {
    var c, t = [];
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = tabelaCrc[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function numLE(v, nBytes) {
    var out = new Uint8Array(nBytes);
    for (var i = 0; i < nBytes; i++) { out[i] = v & 0xFF; v = Math.floor(v / 256); }
    return out;
  }

  function zipSemCompressao(arquivos) { // [{nome, texto}]
    var enc = new TextEncoder();
    var partes = [];
    var centrais = [];
    var offset = 0;
    arquivos.forEach(function (f) {
      var nome = enc.encode(f.nome);
      var dados = enc.encode(f.texto);
      var crc = crc32(dados);
      var cab = [];
      cab.push(numLE(0x04034b50, 4), numLE(20, 2), numLE(0x0800, 2), numLE(0, 2),
        numLE(0, 2), numLE(0, 2), numLE(crc, 4), numLE(dados.length, 4),
        numLE(dados.length, 4), numLE(nome.length, 2), numLE(0, 2));
      var cabecalho = concatBytes(cab);
      partes.push(cabecalho, nome, dados);
      centrais.push({ nome: nome, crc: crc, tam: dados.length, off: offset });
      offset += cabecalho.length + nome.length + dados.length;
    });
    var inicioCentral = offset;
    centrais.forEach(function (c) {
      var e = concatBytes([numLE(0x02014b50, 4), numLE(20, 2), numLE(20, 2), numLE(0x0800, 2),
        numLE(0, 2), numLE(0, 2), numLE(0, 2), numLE(c.crc, 4), numLE(c.tam, 4), numLE(c.tam, 4),
        numLE(c.nome.length, 2), numLE(0, 2), numLE(0, 2), numLE(0, 2), numLE(0, 2),
        numLE(0, 4), numLE(c.off, 4)]);
      partes.push(e, c.nome);
      offset += e.length + c.nome.length;
    });
    var fim = concatBytes([numLE(0x06054b50, 4), numLE(0, 2), numLE(0, 2),
      numLE(centrais.length, 2), numLE(centrais.length, 2),
      numLE(offset - inicioCentral, 4), numLE(inicioCentral, 4), numLE(0, 2)]);
    partes.push(fim);
    return new Blob(partes, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function concatBytes(lista) {
    var total = 0;
    lista.forEach(function (a) { total += a.length; });
    var out = new Uint8Array(total);
    var p = 0;
    lista.forEach(function (a) { out.set(a, p); p += a.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&apos;');
  }

  function colLetra(n) { // 0 -> A
    var s = '';
    n++;
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  function chaveMk(texto) {
    var limpo = String(texto || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return 'MK_' + (limpo || 'X');
  }

  function precoNum(s) {
    s = String(s == null ? '' : s).split('.').join('').split(',').join('.');
    var n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }

  function celTexto(ref, v) {
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
  }
  function celNum(ref, v) {
    return v == null ? '' : '<c r="' + ref + '"><v>' + v + '</v></c>';
  }

  function gerarXlsxPreenchimento(linhasDados, categorias) {
    // linhasDados: [{sku, prod, idp, mk, vinc, preco, promo, chave}]
    // categorias: { 'NOME MARKETPLACE': [{id, nome}] }
    var chaves = Object.keys(categorias || {});
    var mapaChave = {};
    chaves.forEach(function (nomeMk) { mapaChave[nomeMk] = chaveMk(nomeMk); });

    // ---- sheet2: Categorias (uma coluna por marketplace) ----
    var maxLin = 1;
    chaves.forEach(function (nomeMk) { maxLin = Math.max(maxLin, categorias[nomeMk].length + 1); });
    var linhas2 = [];
    for (var r = 0; r < maxLin; r++) {
      var cels = [];
      chaves.forEach(function (nomeMk, j) {
        var ref = colLetra(j) + (r + 1);
        if (r === 0) cels.push(celTexto(ref, nomeMk));
        else {
          var cat = categorias[nomeMk][r - 1];
          if (cat) cels.push(celTexto(ref, cat.nome));
        }
      });
      linhas2.push('<row r="' + (r + 1) + '">' + cels.join('') + '</row>');
    }
    var sheet2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + linhas2.join('') + '</sheetData></worksheet>';

    // ---- definedNames (um por marketplace com categorias) ----
    var nomesDef = chaves.map(function (nomeMk, j) {
      var qtd = categorias[nomeMk].length;
      var col = colLetra(j);
      var fim = Math.max(2, qtd + 1);
      return '<definedName name="' + mapaChave[nomeMk] + '">Categorias!$' + col + '$2:$' + col + '$' + fim + '</definedName>';
    }).join('');

    // ---- sheet1: Preenchimento ----
    var cab = ['SKU', 'Produto', 'IdProduto', 'Marketplace', 'Vinculado', 'Preco', 'PrecoPromocional', 'Categoria', 'chave'];
    var larguras = [20, 100, 15, 22, 11, 12, 18, 45, 6];
    var cols = '<cols>' + larguras.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"' + (i === 8 ? ' hidden="1"' : '') + '/>';
    }).join('') + '</cols>';

    var linhasXml = ['<row r="1">' + cab.map(function (h, i) { return celTexto(colLetra(i) + '1', h); }).join('') + '</row>'];
    linhasDados.forEach(function (d, i) {
      var r = i + 2;
      var cels = [
        celTexto('A' + r, d.sku),
        celTexto('B' + r, d.prod),
        celTexto('C' + r, d.idp),
        celTexto('D' + r, d.mk),
        celTexto('E' + r, d.vinc),
        celNum('F' + r, d.preco),
        celNum('G' + r, d.promo),
        celTexto('H' + r, d.cat || ''),
        celTexto('I' + r, d.chave || '')
      ].join('');
      linhasXml.push('<row r="' + r + '">' + cels + '</row>');
    });

    var ultimaLinha = linhasDados.length + 1;
    var validacao = chaves.length
      ? '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="H2:H' + ultimaLinha + '"><formula1>INDIRECT($I2)</formula1></dataValidation></dataValidations>'
      : '';

    var sheet1 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols +
      '<sheetData>' + linhasXml.join('') + '</sheetData>' +
      validacao +
      '</worksheet>';

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Preenchimento" sheetId="1" r:id="rId1"/><sheet name="Categorias" sheetId="2" r:id="rId2"/></sheets>' +
      (nomesDef ? '<definedNames>' + nomesDef + '</definedNames>' : '') +
      '</workbook>';

    var estilos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>';

    var tipos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    var relsRaiz = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

    var relsWb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    return zipSemCompressao([
      { nome: '[Content_Types].xml', texto: tipos },
      { nome: '_rels/.rels', texto: relsRaiz },
      { nome: 'xl/workbook.xml', texto: workbook },
      { nome: 'xl/_rels/workbook.xml.rels', texto: relsWb },
      { nome: 'xl/styles.xml', texto: estilos },
      { nome: 'xl/worksheets/sheet1.xml', texto: sheet1 },
      { nome: 'xl/worksheets/sheet2.xml', texto: sheet2 }
    ]);
  }

  function lerCategoriasSalvas() {
    return new Promise(function (res) {
      chrome.storage.local.get(['esteira_categorias'], function (r) {
        res(r.esteira_categorias || {});
      });
    });
  }

  async function baixarPlanilhaPreenchimento() {
    if (rodando || ocupado) return;
    var ids = idsProdutosSelecionados();
    if (!ids.length) { log('Selecione os SKUs na listagem primeiro.', 'aviso'); return; }
    if (!(cacheLojas || []).length) { log('Lista de marketplaces vazia. Clique em "Ler marketplaces do Bling".', 'aviso'); return; }
    var escolhidos = lojasEscolhidas();
    var lojasAlvo = cacheLojas.filter(function (l) { return escolhidos.indexOf(l.texto) !== -1; });
    if (!lojasAlvo.length) { log('Nenhum marketplace ticado. Marque na lista (ou "Marcar todos") os que quer na planilha.', 'aviso'); return; }
    ocupado = true;
    log('Montando planilha de preenchimento de ' + ids.length + ' SKU(s) x ' + lojasAlvo.length + ' marketplace(s) ticado(s)...');
    atualizarPill('\uD83D\uDCC4 Lendo vinculos...');
    try {
      var dados = await mapaComLimite(ids, 4, function (id) { return buscarVinculos(id); });

      // -------- categorias: arvore por loja + marcada por produto, direto da resposta --------
      function normalizaCats(item) {
        if (Array.isArray(item)) return item.filter(function (c) { return c && typeof c === 'object'; });
        if (item && typeof item === 'object') {
          return Object.keys(item).map(function (k) { return item[k]; })
            .filter(function (c) { return c && typeof c === 'object'; });
        }
        return [];
      }
      var arvorePorIdLoja = {};   // idLoja -> { idCategoria: nome }
      var marcadasPorProduto = []; // [i] -> { idLoja: nomeCategoria }
      dados.forEach(function (d, i) {
        var marc = {};
        ((d && d.vinculosCategoriasLojas) || []).forEach(function (item) {
          normalizaCats(item).forEach(function (c) {
            var idLoja = String(c.idLoja == null ? '' : c.idLoja);
            var nomeCat = c.descricao || '';
            if (!idLoja || !nomeCat) return;
            if (!arvorePorIdLoja[idLoja]) arvorePorIdLoja[idLoja] = {};
            arvorePorIdLoja[idLoja][String(c.idCategoria)] = nomeCat;
            var m = c.idCategoriaProdutoLoja;
            if (m && String(m) !== '0') marc[idLoja] = nomeCat;
          });
        });
        marcadasPorProduto[i] = marc;
      });
      // converte para { nomeMarketplace: [{id, nome}] } usando o cache de lojas
      var categorias = {};
      lojasAlvo.forEach(function (l) {
        var idLoja = String(l.valor || '').split(';')[0];
        var arv = arvorePorIdLoja[idLoja];
        if (!arv) return;
        var lista = Object.keys(arv).map(function (idc) { return { id: idc, nome: arv[idc] }; });
        lista.sort(function (a, b) { return a.nome.localeCompare(b.nome); });
        if (lista.length) categorias[l.texto] = lista;
      });
      var temCategorias = Object.keys(categorias).length > 0;
      var linhasDados = [];
      var pendentes = 0;
      ids.forEach(function (id, i) {
        var d = dados[i] || {};
        var vincs = d.vinculosLojas || [];
        var nomeProd = d.nomeProduto || '';
        var sku = '';
        for (var k = 0; k < vincs.length; k++) {
          if (vinculoReal(vincs[k]) && vincs[k].sku) { sku = vincs[k].sku; break; }
        }
        if (!sku) sku = (vincs[0] && vincs[0].sku) || '';
        lojasAlvo.forEach(function (l) {
          var idLoja = String(l.valor || '').split(';')[0];
          var v = null;
          for (var m = 0; m < vincs.length; m++) {
            if (String(vincs[m].idLoja) === idLoja) { v = vincs[m]; break; }
          }
          var vinculado = v && vinculoReal(v);
          if (!vinculado) pendentes++;
          linhasDados.push({
            sku: sku, prod: nomeProd, idp: String(id), mk: l.texto,
            vinc: vinculado ? 'SIM' : 'NAO',
            preco: vinculado ? precoNum(v.preco) : null,
            promo: vinculado ? precoNum(v.precoPromocional) : null,
            cat: (marcadasPorProduto[i] && marcadasPorProduto[i][idLoja]) || '',
            chave: (temCategorias && categorias[l.texto]) ? chaveMk(l.texto) : ''
          });
        });
      });

      var blob = gerarXlsxPreenchimento(linhasDados, categorias);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'preenchimento-multiloja-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.xlsx';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);

      log('Planilha Excel baixada: ' + ids.length + ' SKU(s), ' + pendentes + ' combinacao(oes) SEM vinculo (linhas NAO).', 'ok');
      if (temCategorias) log('Categoria: atual ja preenchida onde marcada + lista suspensa por marketplace em todas as linhas.', 'ok');
      log('Preencha Preco, PrecoPromocional e Categoria nas linhas NAO que quer vincular. Nao mexa em IdProduto.');
    } catch (e) {
      log('Falha ao montar planilha: ' + (e && e.message || e), 'erro');
    }
    ocupado = false;
    atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
  }

  // Le a arvore de categorias de cada loja no painel do produto ABERTO
  async function baixarCategorias() {
    if (rodando || ocupado) return;
    var container = document.querySelector('#produto_loja_container');
    if (!container) {
      log('Abra o painel de um produto primeiro (clique em qualquer produto da listagem) e tente de novo.', 'aviso');
      return;
    }
    ocupado = true;
    log('Lendo categorias das lojas no painel aberto...');
    try {
      // mapeia indice N -> nome da loja (pela linha que contem o checkbox de vincular)
      var lojasIdx = [];
      container.querySelectorAll('input[id^="vinculoProdutoLojaCheck"]').forEach(function (cb) {
        var n = cb.id.replace('vinculoProdutoLojaCheck', '');
        var linha = cb.closest('.js-store-link');
        var nome = linha ? txt(linha).split(/ver mais|ver menos/i)[0].trim() : ('loja ' + n);
        // normaliza pelo nome do cache, se bater
        (cacheLojas || []).forEach(function (l) {
          if (nome.toLowerCase().indexOf(l.texto.toLowerCase()) !== -1) nome = l.texto;
        });
        lojasIdx.push({ n: n, nome: nome, linha: linha });
      });

      // expande lojas cuja arvore ainda nao carregou
      for (var i = 0; i < lojasIdx.length; i++) {
        var lj = lojasIdx[i];
        if (!document.querySelector('#treeCategorias' + lj.n + ' input[type="checkbox"]') && lj.linha) {
          try { lj.linha.click(); } catch (e) {}
          await espera(500);
        }
      }
      await espera(400);

      var linhas = ['Marketplace;IdCategoria;Categoria'];
      var total = 0;
      lojasIdx.forEach(function (lj) {
        var arvore = document.querySelector('#treeCategorias' + lj.n);
        if (!arvore) return;
        arvore.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
          var idCat = String(cb.id || '').split('_store')[0];
          var li = cb.closest('li');
          var rotuloEl = li ? li.querySelector('label') : null;
          var nomeCat = rotuloEl ? txt(rotuloEl) : '';
          if (idCat && nomeCat) {
            linhas.push([lj.nome, idCat, nomeCat].map(csvCampo).join(';'));
            total++;
          }
        });
      });

      if (total === 0) {
        log('Nenhuma categoria encontrada. Expanda ("ver mais") as lojas no painel e tente de novo.', 'aviso');
      } else {
        // memoriza para a planilha gerar as listas suspensas
        var memoria = {};
        lojasIdx.forEach(function (lj) {
          var arvore2 = document.querySelector('#treeCategorias' + lj.n);
          if (!arvore2) return;
          var lista = [];
          arvore2.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
            var idCat = String(cb.id || '').split('_store')[0];
            var li = cb.closest('li');
            var rotuloEl = li ? li.querySelector('label') : null;
            var nomeCat = rotuloEl ? txt(rotuloEl) : '';
            if (idCat && nomeCat) lista.push({ id: idCat, nome: nomeCat });
          });
          if (lista.length) memoria[lj.nome] = lista;
        });
        chrome.storage.local.set({ esteira_categorias: memoria });
        baixarCsv('categorias-marketplaces', linhas);
        log('Categorias baixadas e MEMORIZADAS: ' + total + ' no total, de ' + Object.keys(memoria).length + ' lojas.', 'ok');
        log('Agora gere a "Planilha preenchimento": a coluna Categoria vem com lista suspensa.');
      }
    } catch (e) {
      log('Falha ao ler categorias: ' + (e && e.message || e), 'erro');
    }
    ocupado = false;
  }

  /* ========== FASE 2B: subir planilha + robo de preenchimento ========== */

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('navegador sem DecompressionStream (atualize o Chrome/Edge)');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function lerZip(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var u8 = new Uint8Array(arrayBuffer);
    var i = u8.length - 22;
    while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
    if (i < 0) throw new Error('arquivo nao e um .xlsx valido');
    var qtd = dv.getUint16(i + 10, true);
    var p = dv.getUint32(i + 16, true);
    var saida = {};
    var dec = new TextDecoder();
    for (var k = 0; k < qtd; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip corrompido');
      var metodo = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nlen = dv.getUint16(p + 28, true);
      var elen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var offLocal = dv.getUint32(p + 42, true);
      var nome = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      var lnlen = dv.getUint16(offLocal + 26, true);
      var lelen = dv.getUint16(offLocal + 28, true);
      var ini = offLocal + 30 + lnlen + lelen;
      var comp = u8.subarray(ini, ini + csize);
      var dados;
      if (metodo === 0) dados = comp;
      else if (metodo === 8) dados = await inflateRaw(comp);
      else throw new Error('compressao nao suportada no zip: ' + metodo);
      saida[nome] = dados;
      p += 46 + nlen + elen + clen;
    }
    return saida;
  }

  function xmlDoc(u8) {
    return new DOMParser().parseFromString(new TextDecoder().decode(u8), 'application/xml');
  }

  function tagsXml(no, nome) {
    var out = [];
    var todos = no.getElementsByTagName('*');
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].localName === nome) out.push(todos[i]);
    }
    return out;
  }

  function textoDe(no) {
    return no ? (no.textContent || '') : '';
  }

  function numeroDePlanilha(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (s.indexOf(',') !== -1) s = s.split('.').join('').split(',').join('.');
    var n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }

  async function lerPlanilhaXlsx(buf) {
    var arqs = await lerZip(buf);
    function doc(nome) { return arqs[nome] ? xmlDoc(arqs[nome]) : null; }

    var wb = doc('xl/workbook.xml');
    if (!wb) throw new Error('workbook.xml ausente (arquivo nao parece um xlsx)');
    var ridAlvo = null;
    tagsXml(wb, 'sheet').forEach(function (s) {
      if ((s.getAttribute('name') || '').toLowerCase() === 'preenchimento') {
        ridAlvo = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      }
    });
    if (!ridAlvo) throw new Error('aba "Preenchimento" nao encontrada no arquivo');

    var rels = doc('xl/_rels/workbook.xml.rels');
    var alvoPath = null;
    if (rels) {
      tagsXml(rels, 'Relationship').forEach(function (r) {
        if (r.getAttribute('Id') === ridAlvo) alvoPath = r.getAttribute('Target');
      });
    }
    if (!alvoPath) throw new Error('caminho da aba nao encontrado');
    alvoPath = alvoPath.replace(/^[.]?[\/]+/, '');
    if (alvoPath.indexOf('xl/') !== 0) alvoPath = 'xl/' + alvoPath;

    var compartilhadas = [];
    var ss = doc('xl/sharedStrings.xml');
    if (ss) {
      tagsXml(ss, 'si').forEach(function (si) {
        var partes = tagsXml(si, 't').map(textoDe);
        compartilhadas.push(partes.join(''));
      });
    }

    var sh = doc(alvoPath);
    if (!sh) throw new Error('aba de dados nao encontrada no zip');

    var linhasBrutas = [];
    tagsXml(sh, 'row').forEach(function (row) {
      var mapa = {};
      tagsXml(row, 'c').forEach(function (c) {
        var ref = c.getAttribute('r') || '';
        var m = ref.match(/[A-Z]+/);
        if (!m) return;
        var col = m[0];
        var t = c.getAttribute('t') || '';
        var valor = '';
        if (t === 'inlineStr') {
          valor = tagsXml(c, 't').map(textoDe).join('');
        } else {
          var vNo = tagsXml(c, 'v')[0];
          var vTxt = textoDe(vNo);
          if (t === 's') valor = compartilhadas[parseInt(vTxt, 10)] || '';
          else valor = vTxt;
        }
        mapa[col] = valor;
      });
      linhasBrutas.push(mapa);
    });
    if (linhasBrutas.length < 2) throw new Error('planilha sem linhas de dados');

    // header -> letra da coluna
    var cab = linhasBrutas[0];
    var colDe = {};
    Object.keys(cab).forEach(function (col) {
      colDe[String(cab[col]).trim().toLowerCase()] = col;
    });
    var precisa = ['sku', 'idproduto', 'marketplace', 'vinculado', 'preco', 'precopromocional', 'categoria'];
    for (var i = 0; i < precisa.length; i++) {
      if (!colDe[precisa[i]]) throw new Error('coluna "' + precisa[i] + '" nao encontrada no cabecalho');
    }

    var saida = [];
    for (var r = 1; r < linhasBrutas.length; r++) {
      var lm = linhasBrutas[r];
      var idp = String(lm[colDe.idproduto] || '').trim();
      if (!idp) continue;
      saida.push({
        sku: String(lm[colDe.sku] || '').trim(),
        prod: String(lm[colDe.produto] || '').trim(),
        idp: idp,
        mk: String(lm[colDe.marketplace] || '').trim(),
        vinc: String(lm[colDe.vinculado] || '').trim(),
        preco: numeroDePlanilha(lm[colDe.preco]),
        promo: numeroDePlanilha(lm[colDe.precopromocional]),
        cat: String(lm[colDe.categoria] || '').trim()
      });
    }
    return saida;
  }

  /* ---- robo de preenchimento ---- */

  function brPreco(n) {
    return Number(n).toFixed(2).split('.').join(',');
  }

  function setCampo(el, valor) {
    try { el.focus(); } catch (e) {}
    el.value = valor;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function painelDoProdutoCerto(assinatura) {
    var c = document.querySelector('#produto_loja_container');
    if (!c || !document.querySelector('input[id^="vinculoProdutoLojaCheck"]')) return false;
    if (!assinatura) return true;
    var no = c;
    var nivel = 0;
    while (no && nivel < 9) {
      if (txt(no).indexOf(assinatura) !== -1) return true;
      no = no.parentElement;
      nivel++;
    }
    return false;
  }

  function aindaNaListagem() {
    return /produtos[.]php/.test(location.href);
  }

  async function abrirPainelProduto(idp, sku, nome) {
    var tr = document.getElementById(String(idp));
    if (!tr) throw new Error('produto nao visivel na listagem (mesma pagina/filtro da geracao)');

    var marcaClique = Date.now();

    // quem abre o painel e um ICONE no fim da linha; o de "estoque" NAVEGA pra fora (proibido)
    var candidatos = [];
    var tdIcones = tr.querySelector('td.col-estoque-markers');
    if (tdIcones) {
      var icones = tdIcones.querySelectorAll('a, i, svg, span, div, img, button');
      for (var i = 0; i < icones.length; i++) {
        var el = icones[i];
        var rot = '';
        try {
          rot = (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('data-original-title') || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
        } catch (e) {}
        if (/estoque/i.test(rot)) continue; // proibido: navega pra fora
        if (/loja|anunc|v[i\u00ed]ncul|multi|cart|shopping|store/i.test(rot)) candidatos.push(el);
      }
    }
    // fallback: celula da descricao (maior texto da linha)
    var tds = tr.querySelectorAll('td');
    var alvoTd = null;
    var maior = -1;
    for (var j = 0; j < tds.length; j++) {
      var t = txt(tds[j]);
      if (t.length > maior) { maior = t.length; alvoTd = tds[j]; }
    }
    if (alvoTd) candidatos.push(alvoTd);
    if (!candidatos.length) candidatos.push(tr);

    var inicio = Date.now();
    var tent = 0;
    while (Date.now() - inicio < 25000) {
      if (pararPedido) throw new Error('interrompido');
      if (!aindaNaListagem()) throw new Error('a pagina saiu da listagem de produtos - volte para Produtos e rode novamente');
      var alvo = candidatos[tent % candidatos.length];
      try { alvo.click(); } catch (e) {}
      tent++;
      try {
        await esperarPor(function () {
          if (!painelDoProdutoCerto('')) return null; // estrutura do painel presente
          return (ultimoVinculoAberto.id === String(idp) && ultimoVinculoAberto.t >= marcaClique) ? true : null;
        }, 5000, 'painel abrir');
        await espera(900);
        return;
      } catch (e) { /* tenta de novo */ }
      if (!aindaNaListagem()) throw new Error('a pagina saiu da listagem de produtos - volte para Produtos e rode novamente');
    }
    throw new Error('painel do produto (IdProduto ' + idp + ') nao confirmou abertura');
  }

  function mapearLojasPainel() {
    var mapa = {};
    document.querySelectorAll('#produto_loja_container input[id^="vinculoProdutoLojaCheck"]').forEach(function (cb) {
      var n = cb.id.replace('vinculoProdutoLojaCheck', '');
      var linha = cb.closest('.js-store-link');
      var nome = linha ? txt(linha).split(/ver mais|ver menos/i)[0].trim() : '';
      if (nome) mapa[nome.toLowerCase()] = { n: n, linha: linha, nome: nome };
    });
    return mapa;
  }

  function acharLojaNoMapa(mapa, mk) {
    var alvo = mk.trim().toLowerCase();
    if (mapa[alvo]) return mapa[alvo];
    var achado = null;
    Object.keys(mapa).forEach(function (k) {
      if (!achado && (k.indexOf(alvo) !== -1 || alvo.indexOf(k) !== -1)) achado = mapa[k];
    });
    return achado;
  }

  async function preencherLojaNoPainel(item, mapa) {
    var ent = acharLojaNoMapa(mapa, item.mk);
    if (!ent) throw new Error('loja "' + item.mk + '" nao encontrada no painel');
    var N = ent.n;

    var precoEl = document.getElementById('vinculoLoja[' + N + '][preco]');
    if (!precoEl || !visivel(precoEl)) {
      // o gatilho de expandir fica no NOME da loja dentro da linha
      var alvos = [];
      if (ent.linha) {
        var folhas = ent.linha.querySelectorAll('span, div');
        for (var f = 0; f < folhas.length; f++) {
          var el = folhas[f];
          if (el.children.length === 0 && txt(el).length > 2 && alvos.length < 2) alvos.push(el);
        }
        alvos.push(ent.linha);
      }
      for (var a = 0; a < alvos.length && (!precoEl || !visivel(precoEl)); a++) {
        try { alvos[a].click(); } catch (e) {}
        try {
          precoEl = await esperarPor(function () {
            var e2 = document.getElementById('vinculoLoja[' + N + '][preco]');
            return (e2 && visivel(e2)) ? e2 : null;
          }, 3000, 'expandir ' + item.mk);
        } catch (e) { precoEl = null; }
      }
      if (!precoEl || !visivel(precoEl)) {
        throw new Error('nao consegui expandir a loja ' + item.mk + ' no painel');
      }
    }

    var cb = document.getElementById('vinculoProdutoLojaCheck' + N);
    if (cb && !cb.checked) cb.click();
    await espera(200);

    setCampo(precoEl, brPreco(item.preco));
    var promoEl = document.getElementById('vinculoLoja[' + N + '][precoPromocional]');
    if (promoEl && item.promo != null) setCampo(promoEl, brPreco(item.promo));

    var motivo = document.getElementById('vinculoLojaMotivoAlteracaoPrecoShein' + N);
    if (motivo && !motivo.value) {
      motivo.value = '2';
      motivo.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (item.catId) {
      var catCb = document.getElementById(item.catId + '_store' + N);
      if (!catCb) {
        await espera(800);
        catCb = document.getElementById(item.catId + '_store' + N);
      }
      if (!catCb) throw new Error('categoria "' + item.catNome + '" nao apareceu no painel (' + item.mk + ')');
      if (!catCb.checked) catCb.click();
    }
  }

  async function salvarPainelProduto() {
    var btn = document.getElementById('saveProductStore');
    if (!btn) throw new Error('botao Salvar nao encontrado no painel');
    var marca = Date.now();
    btn.click();
    // sucesso = o servidor respondeu 200 ao salvarProdutoLoja (o painel pode ficar aberto)
    await esperarPor(function () {
      if (ultimoSalvamento.t >= marca) return true;
      if (!document.querySelector('#produto_loja_container')) return true; // fechou = tambem salvo
      return null;
    }, 30000, 'confirmacao do salvamento');
    await espera(1000);
  }

  function confirmarRobo(mensagem) {
    return new Promise(function (res) {
      var caixa = document.createElement('div');
      caixa.style.cssText = 'background:#123b1f;border:1px solid #2ea043;border-radius:6px;padding:8px;font-size:12px;display:flex;flex-direction:column;gap:6px;';
      var texto = document.createElement('div');
      texto.textContent = mensagem;
      var botoes = document.createElement('div');
      botoes.style.cssText = 'display:flex;gap:6px;';
      var btnSim = document.createElement('button');
      btnSim.textContent = '\uD83E\uDD16 Iniciar robo';
      btnSim.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:5px;padding:7px;background:#2ea043;color:#fff;font-weight:bold;';
      var btnNao = document.createElement('button');
      btnNao.textContent = 'Cancelar';
      btnNao.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:5px;padding:7px;background:#e5534b;color:#fff;font-weight:bold;';
      function fechar(v) { caixa.remove(); res(v); }
      btnSim.addEventListener('click', function () { fechar(true); });
      btnNao.addEventListener('click', function () { fechar(false); });
      botoes.appendChild(btnSim);
      botoes.appendChild(btnNao);
      caixa.appendChild(texto);
      caixa.appendChild(botoes);
      painel.insertBefore(caixa, logEl);
    });
  }

  async function rodarRoboPreenchimento(plano) {
    pingarHook();
    await espera(400);
    if (!hookAtivo) {
      pingarHook();
      await espera(600);
    }
    if (!hookAtivo) {
      log('ERRO: page-hook.js nao detectado. A esteira agora tem 3 ARQUIVOS - adicione o page-hook.js na pasta, recarregue a extensao e de F5.', 'erro');
      return;
    }
    rodando = true;
    pararPedido = false;
    atualizarBotoes();
    var okT = 0, falhaT = 0;
    log('=== ROBO DE PREENCHIMENTO: ' + plano.length + ' produto(s) ===');
    for (var i = 0; i < plano.length; i++) {
      if (pararPedido) { log('Robo interrompido pelo usuario.', 'aviso'); break; }
      var p = plano[i];
      atualizarPill('\uD83E\uDD16 ' + (i + 1) + '/' + plano.length + ' ' + p.sku);
      log('-> ' + p.sku + ' (' + p.itens.map(function (it) { return it.mk; }).join(', ') + ')');
      try {
        await abrirPainelProduto(p.idp, p.sku, p.nome);
        var mapa = mapearLojasPainel();
        for (var k = 0; k < p.itens.length; k++) {
          if (pararPedido) throw new Error('interrompido');
          await preencherLojaNoPainel(p.itens[k], mapa);
          await espera(350);
        }
        await salvarPainelProduto();
        // verificacao pos-salvar: o vinculo realmente existe agora?
        var d = await buscarVinculos(p.idp);
        var vincs = (d && d.vinculosLojas) || [];
        p.itens.forEach(function (it) {
          var v = null;
          for (var m = 0; m < vincs.length; m++) {
            if (String(vincs[m].idLoja) === it.idLoja) { v = vincs[m]; break; }
          }
          var pLido = v ? precoNum(v.preco) : null;
          var acao = it.atualizacao ? 'atualizado' : 'vinculado';
          if (v && vinculoReal(v) && pLido != null && Math.abs(pLido - it.preco) < 0.011) {
            okT++;
            log('   [OK] ' + p.sku + ' x ' + it.mk + ' ' + acao + ' (' + brPreco(it.preco) + ')', 'ok');
          } else if (v && vinculoReal(v)) {
            falhaT++;
            log('   [FALHOU] ' + p.sku + ' x ' + it.mk + ' - preco nao confirmou (Bling mostra ' + (pLido == null ? '?' : brPreco(pLido)) + ')', 'erro');
          } else {
            falhaT++;
            log('   [FALHOU] ' + p.sku + ' x ' + it.mk + ' - vinculo nao confirmado apos salvar', 'erro');
          }
        });
      } catch (e) {
        falhaT += p.itens.length;
        log('   [FALHA] ' + p.sku + ': ' + (e && e.message || e), 'erro');
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e2) {}
        await espera(900);
        if (/interrompido/.test(String(e))) break;
        if (/saiu da listagem/.test(String(e))) { log('Robo abortado: a pagina mudou. Volte para a listagem de Produtos.', 'erro'); break; }
      }
      await espera(800);
    }
    log('=== ROBO FIM: ' + okT + ' vinculado(s), ' + falhaT + ' falha(s) ===', falhaT ? 'aviso' : 'ok');
    atualizarPill(falhaT ? '\u26A0 Robo: ' + okT + ' ok, ' + falhaT + ' falha' : '\u2713 Robo: tudo ok');
    rodando = false;
    atualizarBotoes();
  }

  async function processarPlanilhaSubida(arquivo) {
    if (rodando || ocupado) return;
    ocupado = true;
    try {
      log('Lendo planilha "' + arquivo.name + '"...');
      var buf = await arquivo.arrayBuffer();
      var linhas = await lerPlanilhaXlsx(buf);
      log('Planilha lida: ' + linhas.length + ' linha(s).');

      var candidatos = [];
      var meioPreenchidas = [];
      linhas.forEach(function (l) {
        var temP = l.preco != null;
        var temPr = l.promo != null;
        if (temP && temPr) candidatos.push(l);
        else if (temP !== temPr) meioPreenchidas.push(l.sku + ' x ' + l.mk + ': faltou ' + (temP ? 'PrecoPromocional' : 'Preco'));
        // os 2 em branco: ignorada em silencio (nao mexe no marketplace)
      });
      meioPreenchidas.forEach(function (m) { log('   \u26A0 ' + m + ' (linha ignorada - arrume e suba de novo)', 'aviso'); });
      if (!candidatos.length) {
        log('Nenhuma linha com os 2 precos preenchidos. Nada a fazer.', 'aviso');
        ocupado = false;
        return;
      }

      var idLojaPorMk = {};
      (cacheLojas || []).forEach(function (l) {
        idLojaPorMk[l.texto.toLowerCase()] = String(l.valor || '').split(';')[0];
      });

      var problemas = [];
      var porProduto = {};
      var ordem = [];
      candidatos.forEach(function (l) {
        var idLoja = idLojaPorMk[String(l.mk || '').toLowerCase()];
        if (!idLoja) { problemas.push(l.sku + ' x ' + l.mk + ': marketplace desconhecido nesta conta'); return; }
        if (!porProduto[l.idp]) { porProduto[l.idp] = { idp: l.idp, sku: l.sku, nome: l.prod || '', itens: [] }; ordem.push(l.idp); }
        porProduto[l.idp].itens.push({ mk: l.mk, idLoja: idLoja, preco: l.preco, promo: l.promo, catNome: l.cat || '', catId: '' });
      });
      var plano = ordem.map(function (id) { return porProduto[id]; });

      var semMudanca = 0;
      log('Validando com o Bling (' + plano.length + ' produto(s))...');
      atualizarPill('\uD83D\uDD0D Validando planilha...');
      var dados = await mapaComLimite(plano, 3, function (p) { return buscarVinculos(p.idp); });

      dados.forEach(function (d, i) {
        var p = plano[i];
        var vincs = (d && d.vinculosLojas) || [];
        var arv = {};
        var marcada = {};
        ((d && d.vinculosCategoriasLojas) || []).forEach(function (item) {
          var lista = Array.isArray(item) ? item
            : (item && typeof item === 'object' ? Object.keys(item).map(function (k) { return item[k]; }) : []);
          lista.forEach(function (c) {
            if (!c || typeof c !== 'object') return;
            var il = String(c.idLoja == null ? '' : c.idLoja);
            if (!arv[il]) arv[il] = {};
            if (c.descricao) arv[il][String(c.descricao).trim().toLowerCase()] = String(c.idCategoria);
            var mm = c.idCategoriaProdutoLoja;
            if (mm && String(mm) !== '0' && c.descricao) marcada[il] = String(c.descricao).trim().toLowerCase();
          });
        });
        p.itens = p.itens.filter(function (it) {
          var v = null;
          for (var m = 0; m < vincs.length; m++) {
            if (String(vincs[m].idLoja) === it.idLoja) { v = vincs[m]; break; }
          }
          if (it.catNome) {
            var idCat = (arv[it.idLoja] || {})[it.catNome.trim().toLowerCase()];
            if (!idCat) { problemas.push(p.sku + ' x ' + it.mk + ': categoria "' + it.catNome + '" nao existe nessa loja (pulado)'); return false; }
            it.catId = idCat;
          }
          var jaVinc = v && vinculoReal(v);
          if (jaVinc) {
            var pAtual = precoNum(v.preco);
            var prAtual = precoNum(v.precoPromocional);
            var mesmoPreco = pAtual != null && prAtual != null &&
              Math.abs(pAtual - it.preco) < 0.011 && Math.abs(prAtual - it.promo) < 0.011;
            var mesmaCat = !it.catNome || marcada[it.idLoja] === it.catNome.trim().toLowerCase();
            if (mesmoPreco && mesmaCat) { semMudanca++; return false; }
            it.atualizacao = true;
          }
          return true;
        });
      });
      plano = plano.filter(function (p) { return p.itens.length; });

      problemas.forEach(function (m) { log('   \u26A0 ' + m, 'aviso'); });
      if (semMudanca) log(semMudanca + ' linha(s) identicas ao Bling (sem mudanca) ignoradas.');
      var totalItens = 0;
      plano.forEach(function (p) { totalItens += p.itens.length; });
      if (!totalItens) {
        log('Nada restou para preencher apos a validacao.', 'aviso');
        ocupado = false;
        atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
        return;
      }
      var novos = 0, atualiz = 0;
      plano.forEach(function (p) { p.itens.forEach(function (it) { if (it.atualizacao) atualiz++; else novos++; }); });
      log('Validado: ' + novos + ' vinculo(s) novo(s) + ' + atualiz + ' atualizacao(oes) de preco/categoria.', 'ok');
      var okUser = await confirmarRobo('Preencher/atualizar ' + totalItens + ' vinculo(s) em ' + plano.length + ' produto(s)? O robo abre cada produto, preenche e salva. Os produtos precisam estar visiveis na listagem atual.');
      ocupado = false;
      if (!okUser) {
        log('Cancelado por voce.', 'aviso');
        atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
        return;
      }
      await rodarRoboPreenchimento(plano);
    } catch (e) {
      ocupado = false;
      log('Erro ao processar planilha: ' + (e && e.message || e), 'erro');
      atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
    }
  }

  function mostrarMatriz(check, contexto) {
    if (!matrizEl || check.falhou) return;
    matrizEl.innerHTML = '';
    matrizEl.style.display = 'block';

    var topo = document.createElement('div');
    topo.style.cssText = 'display:flex;align-items:center;margin-bottom:4px;';
    var tituloM = document.createElement('span');
    tituloM.textContent = 'V\u00ednculos \u00b7 ' + (contexto || 'SKU x marketplace');
    tituloM.style.cssText = 'flex:1;font-weight:bold;font-size:11px;opacity:.85;';
    var btnSoVinculados = document.createElement('button');
    btnSoVinculados.textContent = '\u2714 Marcar s\u00f3 com v\u00ednculo';
    btnSoVinculados.title = 'Deixa ticados apenas os marketplaces onde pelo menos 1 SKU selecionado tem vinculo';
    btnSoVinculados.style.cssText = 'cursor:pointer;border:0;border-radius:4px;background:#2ea043;color:#fff;padding:2px 8px;font-size:10px;font-weight:bold;margin-right:6px;';
    btnSoVinculados.addEventListener('click', function () {
      var comVinculo = {};
      Object.keys(check.porMarketplace || {}).forEach(function (nomeMk) {
        if (check.porMarketplace[nomeMk].tem > 0) comVinculo[nomeMk] = true;
      });
      var marcados = [];
      listaEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = !!comVinculo[cb.dataset.texto];
        if (cb.checked) marcados.push(cb.dataset.texto);
      });
      salvarEscolhas();
      log('Pre-selecao ajustada para os com vinculo (' + marcados.length + '): ' + marcados.join(', '), 'ok');
    });
    var btnPlanilha = document.createElement('button');
    btnPlanilha.textContent = '\u2B07 Planilha';
    btnPlanilha.title = 'Baixa a matriz em planilha (abre direto no Excel): SKU x marketplace, SIM/NAO';
    btnPlanilha.style.cssText = 'cursor:pointer;border:0;border-radius:4px;background:#1f6feb;color:#fff;padding:2px 8px;font-size:10px;font-weight:bold;margin-right:6px;';
    btnPlanilha.addEventListener('click', function () { exportarPlanilha(check); });
    topo.appendChild(btnPlanilha);
    var btnFecharM = document.createElement('button');
    btnFecharM.textContent = '\u00d7';
    btnFecharM.title = 'Fechar matriz';
    btnFecharM.style.cssText = 'cursor:pointer;border:0;border-radius:4px;background:#30363d;color:#fff;padding:0 8px;font-weight:bold;';
    btnFecharM.addEventListener('click', function () { matrizEl.style.display = 'none'; });
    topo.appendChild(tituloM);
    topo.appendChild(btnSoVinculados);
    topo.appendChild(btnFecharM);
    matrizEl.appendChild(topo);

    var rolagem = document.createElement('div');
    rolagem.style.cssText = 'max-height:260px;overflow:auto;';
    var tabela = document.createElement('table');
    tabela.style.cssText = 'border-collapse:collapse;font-size:10px;width:100%;';

    var trCab = document.createElement('tr');
    var thSku = document.createElement('th');
    thSku.textContent = 'SKU';
    thSku.style.cssText = 'text-align:left;padding:2px 6px;position:sticky;top:0;background:#161622;';
    trCab.appendChild(thSku);
    check.marcadas.forEach(function (nomeMk) {
      var th = document.createElement('th');
      th.textContent = nomeMk.length > 9 ? nomeMk.slice(0, 8) + '.' : nomeMk;
      th.title = nomeMk;
      th.style.cssText = 'padding:2px 4px;position:sticky;top:0;background:#161622;white-space:nowrap;text-align:center;';
      trCab.appendChild(th);
    });
    tabela.appendChild(trCab);

    check.produtos.forEach(function (p) {
      var tr = document.createElement('tr');
      var tdSku = document.createElement('td');
      tdSku.textContent = p.rotulo;
      tdSku.title = p.nome;
      tdSku.style.cssText = 'padding:2px 6px;border-top:1px solid #262636;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;';
      tr.appendChild(tdSku);
      check.marcadas.forEach(function (nomeMk) {
        var td = document.createElement('td');
        var ok = !!p.tem[nomeMk];
        td.textContent = ok ? '\u2714' : '\u2716';
        td.title = p.rotulo + (ok ? ' tem ' : ' NAO tem ') + nomeMk;
        td.style.cssText = 'padding:2px 4px;text-align:center;border-top:1px solid #262636;color:' + (ok ? '#7ee787' : '#ff7b72') + ';font-weight:bold;';
        tr.appendChild(td);
      });
      tabela.appendChild(tr);
    });
    rolagem.appendChild(tabela);
    matrizEl.appendChild(rolagem);
  }

  async function conferirVinculos() {
    if (rodando || ocupado) return;
    var marcadas = (cacheLojas || []).map(function (l) { return l.texto; });
    if (!marcadas.length) { log('Lista de marketplaces vazia. Clique em "Ler marketplaces do Bling" primeiro.', 'aviso'); return; }
    if (contarSelecionados() === 0) { log('Selecione os SKUs na listagem primeiro.', 'aviso'); return; }
    log('Conferindo vinculos em TODOS os ' + marcadas.length + ' marketplaces...');
    ocupado = true;
    try {
      var check = await preChecarVinculos(marcadas);
      if (!check.falhou) {
        mostrarMatriz(check, 'TODOS os marketplaces');
        marcadas.forEach(function (nomeMk) {
          var info = check.porMarketplace[nomeMk];
          var tipo = info.tem === info.total ? 'ok' : (info.tem === 0 ? 'erro' : 'aviso');
          var tag = info.tem === info.total ? '[OK] ' : (info.tem === 0 ? '[SEM VINCULO] ' : '[PARCIAL] ');
          log(tag + nomeMk + ' - ' + info.tem + '/' + info.total + ' SKU(s) com vinculo', tipo);
        });
      }
    } catch (e) {
      log('Conferencia interrompida.', 'aviso');
    }
    ocupado = false;
    atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
  }

  /* ---------------- nucleo da esteira ---------------- */

  function resolverLojaNoSelect(selLojas, nome) {
    var alvo = nome.trim().toLowerCase();
    for (var i = 0; i < selLojas.options.length; i++) {
      var o = selLojas.options[i];
      if (txt(o).trim().toLowerCase() === alvo) return o.value;
    }
    return null;
  }

  function resolverDeposito(selDep) {
    if (!selDep) return null;
    for (var i = 0; i < selDep.options.length; i++) {
      if (txt(selDep.options[i]).trim().toLowerCase() === DEPOSITO_PADRAO) {
        return selDep.options[i].value;
      }
    }
    return null;
  }

  // Limpa o texto do modal de resultado pra mostrar so o que importa
  function limparDetalhe(texto) {
    return texto
      .replace(/Exporta[\u00e7c][\u00e3a]o de produtos/gi, '')
      .replace(/Conclu[i\u00ed]do com sucesso\./gi, '')
      .replace(/Alguns itens foram conclu[i\u00ed]dos com erro\./gi, '')
      .replace(/\d+\s*Exporta[\u00e7c][\u00e3a]o com sucesso\./gi, '')
      .replace(/\d+\s*Exporta[\u00e7c][\u00e3a]o com erro\./gi, '')
      .replace(/Detalhes/gi, '')
      .replace(/\bOK\b\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extrai do dialogo de resultado a lista de erros por item: [{sku, motivo}]
  var RX_ITEM_ERRO = /erro|falha|failed|error|indispon|invalid|n\u00e3o foi/i;

  function extrairItensErro(dlg, textoResultado, produtos) {
    produtos = produtos || [];
    var rotulos = produtos.map(function (p) { return p.rotulo; }).filter(Boolean);
    var brutos = [];

    // 1) itens estruturados do modal de progresso (um elemento = um produto)
    dlg.querySelectorAll('.card-list-item').forEach(function (li) {
      var t = txt(li);
      if (t && RX_ITEM_ERRO.test(t)) brutos.push(t);
    });

    // 2) fallback: dialogo de erro corrido ("... Erro : SKU X motivo ...").
    // O motivo de um SKU termina onde comeca o NOME do proximo produto
    // (usamos os nomes reais vindos da pre-checagem como tesoura).
    if (!brutos.length && /Erro\s*:/.test(textoResultado)) {
      var tesouras = ['Cancelar', 'Erro :', 'Erro:'];
      produtos.forEach(function (p) {
        if (p.nome && p.nome.length > 8) tesouras.push(p.nome.slice(0, 25));
      });
      var rx = /Erro\s*:\s*(?:SKU\s+)?(\S+)/g;
      var m;
      while ((m = rx.exec(textoResultado)) !== null) {
        var inicio = m.index + m[0].length;
        var fimSeg = textoResultado.length;
        tesouras.forEach(function (n) {
          var p = textoResultado.indexOf(n, inicio + 1);
          if (p !== -1 && p < fimSeg) fimSeg = p;
        });
        var motivo = textoResultado.slice(inicio, fimSeg);
        brutos.push('SKU ' + m[1] + ' ' + motivo);
      }
    }

    var vistos = {};
    var saida = [];
    brutos.forEach(function (t) {
      var sku = null;
      for (var i = 0; i < rotulos.length; i++) {
        if (rotulos[i] && t.indexOf(rotulos[i]) !== -1) { sku = rotulos[i]; break; }
      }
      var motivo = t;
      var pos = t.search(/Erro\s*:/);
      if (pos !== -1) motivo = t.slice(pos).replace(/^Erro\s*:\s*/, '');
      else if (t.indexOf(' - ') !== -1) motivo = t.slice(t.indexOf(' - ') + 3);
      if (sku) {
        motivo = motivo.replace(/^SKU\s+\S+\s*/, '');
      } else {
        motivo = motivo.replace(/^SKU\s+\S+\s*/, '');
      }
      motivo = motivo.replace(/\s*(Cancelar|OK)\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 180);
      var chave = (sku || '?') + '|' + motivo;
      if (!vistos[chave] && motivo) {
        vistos[chave] = true;
        saida.push({ sku: sku || '?', motivo: motivo });
      }
    });
    return saida;
  }

  async function exportarPara(nomeLoja) {
    var item = { marketplace: nomeLoja, status: '?', sucesso: 0, erro: 0, detalhe: '', inicio: Date.now() };

    var btn = document.querySelector(SEL_BTN_ABRIR);
    if (!btn) throw new Error('Botao de exportar multiloja sumiu da tela.');
    btn.click();
    var selLojas = await esperarPor(function () {
      var s = document.querySelector(SEL_LOJAS);
      return (s && visivel(s) && s.options.length > 1) ? s : null;
    }, TIMEOUT_MODAL_MS, 'janela de exportacao abrir');

    var valorLoja = resolverLojaNoSelect(selLojas, nomeLoja);
    if (!valorLoja) {
      fecharDialogoDoSelect();
      throw new Error('Marketplace "' + nomeLoja + '" nao existe no dropdown desta empresa.');
    }
    setSelect(selLojas, valorLoja);
    await espera(400);

    var selDep = document.querySelector(SEL_DEPOSITO);
    var valorDep = resolverDeposito(selDep);
    if (selDep && valorDep) {
      setSelect(selDep, valorDep);
      await espera(300);
    } else {
      log('Aviso: deposito "Geral" nao encontrado; mantendo o padrao do Bling.', 'aviso');
    }

    var dlg = dialogoVisivelContendo(SEL_LOJAS);
    var btnExp = botaoNoDialogo(dlg, 'exportar produtos');
    if (!btnExp) throw new Error('Botao "Exportar produtos" nao encontrado no modal.');
    log('-> ' + nomeLoja + '... aguardando resultado');
    btnExp.click();

    var resultadoDlg = await esperarPor(function () {
      var d1 = dialogoVisivelComTexto(RX_SUCESSO);
      if (d1 && d1.querySelector('.ActionProgress')) return d1;
      var d2 = dialogoVisivelComTexto(RX_PARCIAL);
      if (d2) return d2;
      var d3 = dialogoVisivelComTexto(RX_ERRO_GERAL);
      if (d3) return d3;
      return null;
    }, TIMEOUT_RESULTADO_MS, 'resultado da exportacao ' + nomeLoja);

    var acordeons = resultadoDlg.querySelectorAll('.bling-accordion');
    for (var i = 0; i < acordeons.length; i++) {
      if (/detalhes/i.test(txt(acordeons[i]))) {
        try { acordeons[i].click(); } catch (e) {}
      }
    }
    await espera(300);
    var textoResultado = txt(resultadoDlg);

    if (RX_ERRO_GERAL.test(textoResultado)) {
      item.status = 'ERRO';
      item.erro = 1;
    } else {
      var mS = textoResultado.match(RX_N_SUCESSO);
      var mE = textoResultado.match(RX_N_ERRO);
      item.sucesso = mS ? parseInt(mS[1], 10) : 0;
      item.erro = mE ? parseInt(mE[1], 10) : 0;
      item.status = item.erro > 0 ? (item.sucesso > 0 ? 'PARCIAL' : 'ERRO') : 'OK';
    }
    item.detalhe = textoResultado.slice(0, 2000);
    item.detalheLimpo = limparDetalhe(textoResultado).slice(0, 800);
    item.itensErro = (item.status === 'OK') ? [] : extrairItensErro(resultadoDlg, textoResultado, produtosRun);
    item.duracaoSeg = Math.round((Date.now() - item.inicio) / 1000);

    var btnOk = botaoNoDialogo(resultadoDlg, 'ok');
    if (btnOk) btnOk.click();
    await espera(600);

    return item;
  }

  async function rodarEsteira() {
    if (rodando) return;
    var marcadas = lojasEscolhidas();
    if (!marcadas.length) {
      log('Nenhum marketplace pre-selecionado. Marque na lista abaixo.', 'aviso');
      configBox.style.display = 'flex';
      return;
    }
    var qtdSku = contarSelecionados();
    if (qtdSku === 0) {
      log('ATENCAO: nenhum produto selecionado na listagem. Marque os SKUs primeiro.', 'aviso');
      return;
    }

    rodando = true;
    pararPedido = false;
    resultados = [];
    atualizarBotoes();

    // ---- PRE-CHECAGEM DE VINCULOS ----
    var check;
    try {
      check = await preChecarVinculos(marcadas);
    } catch (e) {
      log('Pre-checagem interrompida.', 'aviso');
      rodando = false;
      atualizarBotoes();
      atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
      return;
    }
    produtosRun = check.falhou ? [] : check.produtos;
    if (!check.falhou) {
      mostrarMatriz(check, 'somente os marcados p/ exportar');
      var manter = [];
      marcadas.forEach(function (nome) {
        var info = check.porMarketplace[nome];
        if (!info) { manter.push(nome); return; }
        if (info.tem === 0) {
          log('[PULADO] ' + nome + ' - nenhum dos ' + info.total + ' SKU(s) tem vinculo multiloja.', 'erro');
          resultados.push({ marketplace: nome, status: 'PULADO', detalhe: 'Nenhum SKU com vinculo multiloja.' });
        } else {
          if (info.tem < info.total) {
            log('[AJUSTE] ' + nome + ': ' + info.idsFaltando.length + ' SKU(s) sem vinculo serao desmarcados so nessa exportacao:', 'aviso');
            info.faltando.forEach(function (n) { log('   - ' + n, 'detalhe'); });
          } else {
            log('[OK] ' + nome + ' - vinculo em ' + info.tem + '/' + info.total + ' SKU(s).', 'ok');
          }
          manter.push(nome);
        }
      });
      if (!manter.length) {
        log('Nada para exportar: nenhum marketplace com vinculo. Confira na matriz acima quem falta e vincule no multiloja.', 'erro');
        rodando = false;
        atualizarBotoes();
        atualizarPill('\u26A0 Sem vinculos');
        return;
      }
      marcadas = manter;
    }

    log('=== Iniciando: ' + qtdSku + ' SKU(s) x ' + marcadas.length + ' marketplace(s), deposito Geral ===');

    var idsOriginais = idsProdutosSelecionados();

    for (var i = 0; i < marcadas.length; i++) {
      if (pararPedido) { log('Esteira interrompida pelo usuario.', 'aviso'); break; }
      var nome = marcadas[i];
      atualizarPill('\u23F3 ' + (i + 1) + '/' + marcadas.length + ' ' + nome);
      var idsDesmarcar = (!check.falhou && check.porMarketplace[nome]) ? check.porMarketplace[nome].idsFaltando : [];
      var skusEnviados = check.falhou ? [] : check.produtos.filter(function (p) { return p.tem[nome]; }).map(function (p) { return p.rotulo; });
      try {
        if (idsDesmarcar.length) {
          alternarSelecao(idsDesmarcar, false);
          await espera(600);
          log('   (' + nome + ': exportando ' + contarSelecionados() + ' SKU(s) vinculados)');
        }
        var r = await exportarPara(nome);
        r.skusEnviados = skusEnviados;
        resultados.push(r);
        if (r.status === 'OK') {
          log('[OK] ' + r.marketplace + ' - ' + r.sucesso + ' sucesso (' + r.duracaoSeg + 's)', 'ok');
        } else {
          var rotulo = r.status === 'PARCIAL' ? '[PARCIAL]' : '[ERRO]';
          log(rotulo + ' ' + r.marketplace + ' - ' + r.sucesso + ' sucesso, ' + r.erro + ' erro (' + r.duracaoSeg + 's)', 'erro');
          var itensR = r.itensErro || [];
          if (itensR.length) {
            itensR.forEach(function (it) {
              log('     \u2716 ' + it.sku + ': ' + it.motivo, 'detalhe');
            });
          } else if (r.detalheLimpo) {
            log('     ' + r.detalheLimpo, 'detalhe');
          }
        }
      } catch (e) {
        var msg = String(e && e.message || e);
        resultados.push({ marketplace: nome, status: 'FALHA', detalhe: msg });
        log('[FALHA] ' + nome + ' - ' + msg, 'erro');
        try {
          fecharDialogoDoSelect();
          var dlgErro = dialogoVisivelComTexto(/./);
          var ok = botaoNoDialogo(dlgErro, 'ok');
          if (ok) ok.click();
        } catch (e2) {}
        if (/interrompido/.test(msg)) {
          alternarSelecao(idsDesmarcar, true);
          break;
        }
      }
      if (idsDesmarcar.length) {
        alternarSelecao(idsDesmarcar, true);
        await espera(400);
      }
      await espera(PAUSA_ENTRE_MS);
    }

    alternarSelecao(idsOriginais, true);

    rodando = false;
    atualizarBotoes();
    resumoFinal();
  }

  function listaCurta(arr, max) {
    arr = arr || [];
    max = max || 10;
    if (!arr.length) return '';
    if (arr.length <= max) return arr.join(', ');
    return arr.slice(0, max).join(', ') + ' +' + (arr.length - max);
  }

  function resumoFinal() {
    var ok = 0, parcial = 0, erro = 0, pulado = 0;
    resultados.forEach(function (r) {
      if (r.status === 'OK') ok++;
      else if (r.status === 'PARCIAL') parcial++;
      else if (r.status === 'PULADO') pulado++;
      else erro++;
    });

    log('');
    log('========== RESUMO FINAL ==========');
    resultados.forEach(function (r) {
      if (r.status === 'OK') {
        var lista = listaCurta(r.skusEnviados);
        log('\u2714 ' + r.marketplace + ' \u2014 ' + r.sucesso + ' SKU(s) exportado(s) com sucesso' + (lista ? ': ' + lista : ''), 'ok');
      } else if (r.status === 'PULADO') {
        log('\u2298 ' + r.marketplace + ' \u2014 pulado (nenhum SKU com vinculo multiloja)', 'aviso');
      } else if (r.status === 'FALHA') {
        log('\u2716 ' + r.marketplace + ' \u2014 falha da esteira: ' + String(r.detalhe || '').slice(0, 140), 'erro');
      } else {
        var tipo = r.status === 'PARCIAL' ? 'aviso' : 'erro';
        var icone = r.status === 'PARCIAL' ? '\u26A0' : '\u2716';
        log(icone + ' ' + r.marketplace + ' \u2014 ' + r.sucesso + ' com sucesso, ' + r.erro + ' com erro:', tipo);
        var itens = r.itensErro || [];
        if (itens.length) {
          itens.forEach(function (it) {
            log('     \u2716 ' + it.sku + ': ' + it.motivo, 'detalhe');
          });
          if (r.sucesso > 0 && (r.skusEnviados || []).length) {
            var comErro = {};
            itens.forEach(function (it) { comErro[it.sku] = true; });
            var okSkus = r.skusEnviados.filter(function (s) { return !comErro[s]; });
            if (okSkus.length) log('     \u2714 com sucesso: ' + listaCurta(okSkus), 'ok');
          }
        } else if (r.detalheLimpo) {
          log('     ' + r.detalheLimpo, 'detalhe');
        }
        if (r.detalhe) {
          log('     texto completo: ' + r.detalhe, 'bruto');
        }
      }
    });
    log('==================================');
    log('Totais: ' + ok + ' ok \u00b7 ' + parcial + ' parcial \u00b7 ' + erro + ' com erro \u00b7 ' + pulado + ' pulado(s)', erro + parcial > 0 ? 'aviso' : 'ok');
    atualizarPill(erro + parcial > 0 ? '\u26A0 Esteira: ' + ok + ' ok, ' + (erro + parcial) + ' com erro' : '\u2713 Esteira: tudo ok');
  }

  function baixarRelatorio() {
    var pacote = {
      versao: VERSAO,
      geradoEm: new Date().toISOString(),
      url: location.href,
      resultados: resultados
    };
    var blob = new Blob([JSON.stringify(pacote, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'esteira-relatorio-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  /* ---------------- interface ---------------- */

  var pill, painel, listaEl, logEl, btnIniciar, btnParar, contadorSkuEl, resumoEl, configBox, matrizEl;

  function log(m, tipo) {
    if (!logEl) return;
    var linha = document.createElement('div');
    linha.textContent = m;
    if (tipo === 'erro') linha.style.color = '#ff7b72';
    else if (tipo === 'aviso') linha.style.color = '#f0b429';
    else if (tipo === 'ok') linha.style.color = '#7ee787';
    else if (tipo === 'detalhe') { linha.style.color = '#ffa657'; linha.style.paddingLeft = '8px'; }
    else if (tipo === 'bruto') { linha.style.color = '#9da5b0'; linha.style.paddingLeft = '8px'; }
    logEl.appendChild(linha);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function lojasEscolhidas() {
    var out = [];
    if (!listaEl) return out;
    listaEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) {
      out.push(c.dataset.texto);
    });
    return out;
  }

  function atualizarResumo() {
    if (!resumoEl) return;
    var nomes = lojasEscolhidas();
    resumoEl.textContent = nomes.length
      ? 'Pre-selecionados (' + nomes.length + '): ' + nomes.join(', ')
      : 'Nenhum marketplace escolhido - marque na lista abaixo';
    resumoEl.style.color = nomes.length ? '#7ee787' : '#f0b429';
  }

  function marcarTodos(v) {
    if (!listaEl) return;
    listaEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = v; });
    salvarEscolhas();
  }

  function salvarEscolhas() {
    chrome.storage.local.set({ esteira_marketplaces: lojasEscolhidas() });
    atualizarResumo();
  }

  function renderizarLista() {
    if (!listaEl) return;
    chrome.storage.local.get(['esteira_marketplaces'], function (r) {
      var marcadosAntes = r.esteira_marketplaces || [];
      listaEl.innerHTML = '';
      var lojasVisiveis = cacheLojas || [];
      if (!lojasVisiveis.length) {
        listaEl.textContent = 'Lista vazia. Selecione 1 SKU na listagem e clique em "Ler marketplaces".';
        atualizarResumo();
        return;
      }
      lojasVisiveis.forEach(function (l) {
        var linha = document.createElement('label');
        linha.style.cssText = 'display:flex;gap:7px;align-items:center;cursor:pointer;font-size:12px;padding:2px 0;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.texto = l.texto;
        cb.checked = marcadosAntes.indexOf(l.texto) !== -1;
        cb.addEventListener('change', salvarEscolhas);
        var sp = document.createElement('span');
        sp.textContent = l.texto;
        linha.appendChild(cb);
        linha.appendChild(sp);
        listaEl.appendChild(linha);
      });
      atualizarResumo();
    });
  }

  function atualizarPill(texto) {
    if (pill) pill.textContent = texto || '\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs';
  }

  function abrirPainel() {
    if (painel) painel.style.display = 'flex';
    if (pill) pill.style.display = 'none';
  }

  function minimizarPainel() {
    if (painel) painel.style.display = 'none';
    if (pill) pill.style.display = 'block';
    if (!rodando) atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
  }

  function montarInterface() {
    if (document.getElementById('esteiraPill')) return;

    // barras de rolagem visiveis no painel escuro
    if (!document.getElementById('esteiraScrollCss')) {
      var css = document.createElement('style');
      css.id = 'esteiraScrollCss';
      css.textContent = [
        '#esteiraPainel ::-webkit-scrollbar{width:10px;height:10px;}',
        '#esteiraPainel ::-webkit-scrollbar-track{background:#0d1117;border-radius:5px;}',
        '#esteiraPainel ::-webkit-scrollbar-thumb{background:#4a4a5e;border-radius:5px;}',
        '#esteiraPainel ::-webkit-scrollbar-thumb:hover{background:#6a6a7e;}',
        '#esteiraPainel *{scrollbar-color:#4a4a5e #0d1117;scrollbar-width:auto;overscroll-behavior:contain;}'
      ].join('');
      (document.head || document.documentElement).appendChild(css);
    }

    // ---- botao flutuante (estado recolhido) ----
    pill = document.createElement('button');
    pill.id = 'esteiraPill';
    pill.textContent = '\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs';
    pill.title = 'Abrir a Esteira de exportacao multiloja (' + VERSAO + ') - arraste para mover';
    pill.style.cssText = [
      'position:fixed', 'bottom:14px', 'left:14px', 'z-index:2147483647',
      'background:#1e1e2e', 'color:#fff', 'border:1px solid #3a3a4e', 'border-radius:20px',
      'padding:8px 14px', 'font:bold 12px Arial,sans-serif', 'cursor:pointer',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)'
    ].join(';');
    tornarArrastavel(pill, pill, 'esteira_pos_pill', function () { abrirPainel(); });
    (document.body || document.documentElement).appendChild(pill);

    // ---- painel completo ----
    painel = document.createElement('div');
    painel.id = 'esteiraPainel';
    painel.style.cssText = [
      'position:fixed', 'bottom:14px', 'left:14px', 'z-index:2147483647',
      'background:#1e1e2e', 'color:#fff', 'padding:12px 14px', 'border-radius:10px',
      'font:13px/1.4 Arial,sans-serif', 'box-shadow:0 4px 18px rgba(0,0,0,.45)',
      'display:none', 'flex-direction:column', 'gap:8px', 'width:420px',
      'overflow:hidden', 'max-width:98vw', 'max-height:98vh'
    ].join(';');

    var cabecalho = document.createElement('div');
    cabecalho.style.cssText = 'display:flex;align-items:center;gap:8px;';
    var titulo = document.createElement('div');
    titulo.textContent = '\u2261 Esteira Bling \u00b7 ' + VERSAO;
    titulo.title = 'Segure e arraste para mover';
    titulo.style.cssText = 'flex:1;font-weight:bold;opacity:.85;font-size:12px;cursor:move;user-select:none;';
    tornarArrastavel(titulo, null, 'esteira_pos', null);
    var btnMin = document.createElement('button');
    btnMin.textContent = '\u2014';
    btnMin.title = 'Minimizar (a esteira continua rodando)';
    btnMin.style.cssText = 'cursor:pointer;border:0;border-radius:5px;background:#30363d;color:#fff;padding:2px 10px;font-weight:bold;';
    btnMin.addEventListener('click', minimizarPainel);
    var btnRelTopo = document.createElement('button');
    btnRelTopo.textContent = 'Resultado JSON';
    btnRelTopo.title = 'Baixa o resultado integral da ultima esteira em arquivo JSON';
    btnRelTopo.style.cssText = 'cursor:pointer;border:0;border-radius:5px;background:#30363d;color:#fff;padding:2px 8px;font-size:10px;';
    btnRelTopo.addEventListener('click', baixarRelatorio);
    cabecalho.appendChild(titulo);
    cabecalho.appendChild(btnRelTopo);
    cabecalho.appendChild(btnMin);

    contadorSkuEl = document.createElement('div');
    contadorSkuEl.style.cssText = 'font-size:12px;opacity:.85;';

    resumoEl = document.createElement('div');
    resumoEl.style.cssText = 'font-size:12px;color:#7ee787;min-height:15px;';

    var linhaAcao = document.createElement('div');
    linhaAcao.style.cssText = 'display:flex;gap:8px;';
    btnIniciar = document.createElement('button');
    btnIniciar.textContent = '\u25B6 EXPORTAR MARKETPLACES';
    btnIniciar.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:11px;font-weight:bold;font-size:14px;background:#2ea043;color:#fff;';
    btnIniciar.addEventListener('click', rodarEsteira);
    btnParar = document.createElement('button');
    btnParar.textContent = '\u25A0 PARAR';
    btnParar.title = 'Trava a esteira: interrompe a espera atual e nao exporta os proximos';
    btnParar.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:11px;font-weight:bold;font-size:14px;background:#5a2b28;color:#caa;opacity:.5;';
    btnParar.disabled = true;
    btnParar.addEventListener('click', function () {
      if (!rodando) return;
      pararPedido = true;
      log('PARAR acionado: travando a esteira (o export ja enviado ao Bling nao tem como desfazer).', 'aviso');
    });
    linhaAcao.appendChild(btnIniciar);
    linhaAcao.appendChild(btnParar);

    configBox = document.createElement('div');
    configBox.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    listaEl = document.createElement('div');
    listaEl.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:200px;overflow:auto;background:#161622;border-radius:6px;padding:8px;';

    var linhaMarcar = document.createElement('div');
    linhaMarcar.style.cssText = 'display:flex;gap:6px;';
    var btnTodos = document.createElement('button');
    btnTodos.textContent = '\u2611 Marcar todos';
    btnTodos.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:5px;background:#30363d;color:#fff;font-size:11px;';
    btnTodos.addEventListener('click', function () { marcarTodos(true); });
    var btnNenhum = document.createElement('button');
    btnNenhum.textContent = '\u2610 Desmarcar todos';
    btnNenhum.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:5px;background:#30363d;color:#fff;font-size:11px;';
    btnNenhum.addEventListener('click', function () { marcarTodos(false); });
    linhaMarcar.appendChild(btnTodos);
    linhaMarcar.appendChild(btnNenhum);

    var btnLer = document.createElement('button');
    btnLer.textContent = '\u21BB Ler marketplaces do Bling';
    btnLer.title = 'Abre e fecha a janela de exportacao para atualizar a lista (precisa de 1 SKU selecionado)';
    btnLer.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:6px;background:#1f6feb;color:#fff;font-size:11px;';
    btnLer.addEventListener('click', lerMarketplacesDoBling);
    configBox.appendChild(linhaMarcar);
    configBox.appendChild(listaEl);
    configBox.appendChild(btnLer);

    var linhaBtns2 = document.createElement('div');
    linhaBtns2.style.cssText = 'display:flex;gap:6px;';
    var btnConferir = document.createElement('button');
    btnConferir.textContent = '\uD83D\uDD0D Conferir v\u00ednculos';
    btnConferir.title = 'Checa quais SKUs selecionados tem vinculo em cada marketplace, SEM exportar nada';
    btnConferir.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:6px;background:#6e40c9;color:#fff;font-size:11px;';
    btnConferir.addEventListener('click', conferirVinculos);
    linhaBtns2.appendChild(btnConferir);

    var linhaBtns3 = document.createElement('div');
    linhaBtns3.style.cssText = 'display:flex;gap:6px;';
    var btnPlanPre = document.createElement('button');
    btnPlanPre.textContent = '\u2B07 Planilha preenchimento';
    btnPlanPre.title = 'Baixa planilha SKU x marketplace com Preco/Promocional/Categoria para preencher os vinculos que faltam';
    btnPlanPre.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:6px;background:#1f6feb;color:#fff;font-size:11px;';
    btnPlanPre.addEventListener('click', baixarPlanilhaPreenchimento);
    linhaBtns3.appendChild(btnPlanPre);

    var inputArquivo = document.createElement('input');
    inputArquivo.type = 'file';
    inputArquivo.accept = '.xlsx';
    inputArquivo.style.display = 'none';
    inputArquivo.addEventListener('change', function () {
      var f = inputArquivo.files && inputArquivo.files[0];
      inputArquivo.value = '';
      if (f) processarPlanilhaSubida(f);
    });

    var btnSubir = document.createElement('button');
    btnSubir.textContent = '\u2B06 Subir planilha preenchida';
    btnSubir.title = 'Le a planilha preenchida (.xlsx), valida e o robo preenche os vinculos no Bling';
    btnSubir.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:6px;background:#d29922;color:#1e1e2e;font-weight:bold;font-size:11px;';
    btnSubir.addEventListener('click', function () {
      if (rodando || ocupado) return;
      inputArquivo.click();
    });
    linhaBtns3.appendChild(btnSubir);
    painel.appendChild(inputArquivo);

    var linhaBtns4 = document.createElement('div');
    linhaBtns4.style.cssText = 'display:flex;gap:6px;';
    var btnGrade = document.createElement('button');
    btnGrade.textContent = '\uD83D\uDCCA Grade de precos (beta)';
    btnGrade.title = 'Abre a grade de precificacao: custo x preco por marketplace numa tela so';
    btnGrade.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:8px;background:#6e40c9;color:#fff;font-weight:bold;font-size:12px;';
    btnGrade.addEventListener('click', abrirGrade);
    linhaBtns4.appendChild(btnGrade);

    var btnSyncPreco = document.createElement('button');
    btnSyncPreco.textContent = '\uD83D\uDD04 Sincronizar pre\u00e7os';
    btnSyncPreco.title = 'Empurra os precos JA salvos no Bling para os marketplaces ticados (dos SKUs selecionados). Nao reexporta imagens/atributos.';
    btnSyncPreco.style.cssText = 'flex:1;cursor:pointer;border:0;border-radius:6px;padding:8px;background:#1f6feb;color:#fff;font-weight:bold;font-size:12px;';
    btnSyncPreco.addEventListener('click', sincronizarPrecosSelecionados);
    linhaBtns4.appendChild(btnSyncPreco);

    logEl = document.createElement('div');
    logEl.style.cssText = 'flex:1 1 230px;min-height:100px;font:11px/1.6 Consolas,monospace;background:#0d1117;border-radius:6px;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;';

    painel.appendChild(cabecalho);
    painel.appendChild(contadorSkuEl);
    painel.appendChild(resumoEl);
    painel.appendChild(linhaAcao);
    painel.appendChild(configBox);
    painel.appendChild(linhaBtns2);
    painel.appendChild(linhaBtns3);
    painel.appendChild(linhaBtns4);
    matrizEl = document.createElement('div');
    matrizEl.style.cssText = 'display:none;background:#161622;border-radius:6px;padding:6px;';
    painel.appendChild(matrizEl);
    painel.appendChild(logEl);
    criarAlcasResize();
    // rolagem do mouse sobre o painel NUNCA vaza para a pagina do Bling
    painel.addEventListener('wheel', function (e) {
      var alvo = e.target;
      var rolavel = null;
      while (alvo && alvo !== painel) {
        if (alvo.scrollHeight > alvo.clientHeight + 2 || alvo.scrollWidth > alvo.clientWidth + 2) { rolavel = alvo; break; }
        alvo = alvo.parentElement;
      }
      if (!rolavel) e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    (document.body || document.documentElement).appendChild(painel);
    restaurarPosicoes();
    observarTamanho();

    setInterval(function () {
      if (contadorSkuEl) contadorSkuEl.textContent = 'SKUs selecionados na listagem: ' + contarSelecionados();
    }, 1000);
  }

  function atualizarBotoes() {
    if (!btnIniciar) return;
    btnIniciar.disabled = rodando;
    btnIniciar.style.opacity = rodando ? '.5' : '1';
    btnIniciar.style.cursor = rodando ? 'default' : 'pointer';
    btnParar.disabled = !rodando;
    btnParar.style.opacity = rodando ? '1' : '.5';
    btnParar.style.background = rodando ? '#e5534b' : '#5a2b28';
    btnParar.style.color = rodando ? '#fff' : '#caa';
    btnParar.style.cursor = rodando ? 'pointer' : 'default';
  }

  /* ---- arrastar (pill e painel) ---- */

  function aplicarPosicao(el, left, top) {
    var maxLeft = Math.max(0, window.innerWidth - el.offsetWidth - 4);
    var maxTop = Math.max(0, window.innerHeight - el.offsetHeight - 4);
    left = Math.min(Math.max(0, left), maxLeft);
    top = Math.min(Math.max(0, top), maxTop);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function restaurarPosicoes() {
    chrome.storage.local.get(['esteira_pos', 'esteira_pos_pill', 'esteira_tam'], function (r) {
      if (r.esteira_tam && typeof r.esteira_tam.w === 'number') {
        painel.style.width = r.esteira_tam.w + 'px';
        painel.style.height = r.esteira_tam.h + 'px';
      }
      if (r.esteira_pos && typeof r.esteira_pos.left === 'number') {
        aplicarPosicao(painel, r.esteira_pos.left, r.esteira_pos.top);
      }
      if (r.esteira_pos_pill && typeof r.esteira_pos_pill.left === 'number') {
        aplicarPosicao(pill, r.esteira_pos_pill.left, r.esteira_pos_pill.top);
      }
    });
  }

  var timerTam = null;
  function observarTamanho() {
    if (typeof ResizeObserver === 'undefined') return;
    var ro = new ResizeObserver(function () {
      if (painel.style.display === 'none') return;
      if (timerTam) clearTimeout(timerTam);
      timerTam = setTimeout(function () {
        var rect = painel.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          chrome.storage.local.set({ esteira_tam: { w: Math.round(rect.width), h: Math.round(rect.height) } });
        }
      }, 500);
    });
    ro.observe(painel);
  }

  /* ---- redimensionar por qualquer borda/canto ---- */

  var MIN_W = 320, MIN_H = 340;

  function criarAlcasResize() {
    var alcas = {
      n:  { css: 'top:0;left:12px;right:12px;height:7px;cursor:ns-resize;' },
      s:  { css: 'bottom:0;left:12px;right:12px;height:7px;cursor:ns-resize;' },
      e:  { css: 'right:0;top:12px;bottom:12px;width:7px;cursor:ew-resize;' },
      w:  { css: 'left:0;top:12px;bottom:12px;width:7px;cursor:ew-resize;' },
      ne: { css: 'top:0;right:0;width:14px;height:14px;cursor:nesw-resize;' },
      nw: { css: 'top:0;left:0;width:14px;height:14px;cursor:nwse-resize;' },
      se: { css: 'bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;' },
      sw: { css: 'bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize;' }
    };
    Object.keys(alcas).forEach(function (dir) {
      var a = document.createElement('div');
      a.style.cssText = 'position:absolute;z-index:5;' + alcas[dir].css;
      a.addEventListener('mousedown', function (e) { iniciarResize(e, dir); });
      painel.appendChild(a);
    });
  }

  var rz = null; // estado do resize em andamento

  function iniciarResize(e, dir) {
    var rect = painel.getBoundingClientRect();
    // fixa a posicao em left/top antes de mexer
    painel.style.left = rect.left + 'px';
    painel.style.top = rect.top + 'px';
    painel.style.right = 'auto';
    painel.style.bottom = 'auto';
    rz = { dir: dir, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height };
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener('mousemove', function (e) {
    if (!rz) return;
    var dx = e.clientX - rz.x;
    var dy = e.clientY - rz.y;
    var maxW = Math.round(window.innerWidth * 0.98);
    var maxH = Math.round(window.innerHeight * 0.98);
    var w = rz.w, h = rz.h, l = rz.left, t = rz.top;

    if (rz.dir.indexOf('e') !== -1) w = rz.w + dx;
    if (rz.dir.indexOf('s') !== -1) h = rz.h + dy;
    if (rz.dir.indexOf('w') !== -1) { w = rz.w - dx; }
    if (rz.dir.indexOf('n') !== -1) { h = rz.h - dy; }

    w = Math.min(Math.max(MIN_W, w), maxW);
    h = Math.min(Math.max(MIN_H, h), maxH);

    // bordas oeste/norte movem a janela junto (ancoradas no lado oposto)
    if (rz.dir.indexOf('w') !== -1) l = rz.left + rz.w - w;
    if (rz.dir.indexOf('n') !== -1) t = rz.top + rz.h - h;
    l = Math.max(0, l);
    t = Math.max(0, t);

    painel.style.width = w + 'px';
    painel.style.height = h + 'px';
    painel.style.left = l + 'px';
    painel.style.top = t + 'px';
  }, true);

  document.addEventListener('mouseup', function () {
    if (!rz) return;
    rz = null;
    var rect = painel.getBoundingClientRect();
    chrome.storage.local.set({
      esteira_tam: { w: Math.round(rect.width), h: Math.round(rect.height) },
      esteira_pos: { left: Math.round(rect.left), top: Math.round(rect.top) }
    });
  }, true);

  // alca: onde clica pra arrastar; alvo: o que se move (null = painel); aoClicarSemArrastar: acao de clique
  function tornarArrastavel(alca, alvo, chavePos, aoClicarSemArrastar) {
    var arrastando = false, moveu = false, offX = 0, offY = 0;
    function elemento() { return alvo || painel; }
    alca.addEventListener('mousedown', function (e) {
      arrastando = true;
      moveu = false;
      var rect = elemento().getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!arrastando) return;
      moveu = true;
      aplicarPosicao(elemento(), e.clientX - offX, e.clientY - offY);
    }, true);
    document.addEventListener('mouseup', function () {
      if (!arrastando) return;
      arrastando = false;
      if (moveu) {
        var rect = elemento().getBoundingClientRect();
        var obj = {};
        obj[chavePos] = { left: rect.left, top: rect.top };
        chrome.storage.local.set(obj);
      } else if (aoClicarSemArrastar) {
        aoClicarSemArrastar();
      }
    }, true);
  }

  /* ---------------- init ---------------- */

  /* ================= ESTEIRA GRADE (Fase A) =================
     Tela cheia sobreposta ao Bling. Le em massa preco/promocional/
     categoria/vinculo (obterVinculoProdutosMultilojas). Custo: simples
     via cache; kit sob demanda (readonly). Fase A e READ-ONLY.
     ========================================================= */

  var gradeOverlay = null;
  var gradeDados = [];        // [{idp, sku, nome, kit, custo, custoFonte, p:{mk:{preco,promo,cat,vinc}}}]
  var GRADE_MK = [];          // nomes de marketplaces exibidos na grade
  var GRADE_MK_TODOS = [];    // todos os marketplaces disponiveis (menos ML/MercadoShops)
  var gradeMkOcultos = {};    // {mkNome: true} marketplaces desligados pelo usuario
  var gradeCats = {};         // {mk: [{id, nome}]} arvore de categorias por marketplace
  var gradeOrigemRi = null;   // linha definida como origem da copia (clique na linha)
  var gradeMarcados = {};     // {ri: true} linhas marcadas com checkbox (destinos/alvo do reajuste)
  var gradeMkAlvo = {};       // {mk: true} marketplaces alvo das acoes; vazio = todos
  var gradeSnapshot = null;   // copia dos dados originais (para desfazer)
  var gradeModoOrigem = false; // true quando o usuario ativou "definir origem"
  var gradeBaseIgualar = {};  // {ri: mk} ultima celula focada em cada linha (base do igualar)

  var RX_MK_FORA_GRADE = /mercado\s*shops|^\s*mlivre\s*$|mercado\s*livre/i; // ML e MercadoShops: gestao de anuncios a parte (fase futura)

  function fmtBRL(n) {
    return n == null ? '—' : 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(n) {
    return n == null ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---- cache de custo no storage (por idProduto) ----
  function lerCacheCusto() {
    return new Promise(function (res) {
      chrome.storage.local.get(['esteira_custo_cache'], function (r) { res(r.esteira_custo_cache || {}); });
    });
  }
  function salvarCacheCusto(mapa) {
    chrome.storage.local.set({ esteira_custo_cache: mapa });
  }

  async function abrirGrade() {
    if (rodando || ocupado) { log('Aguarde a operacao atual terminar para abrir a grade.', 'aviso'); return; }
    var ids = idsProdutosSelecionados();
    if (!ids.length) { log('Selecione os SKUs na listagem antes de abrir a grade.', 'aviso'); return; }
    if (!(cacheLojas || []).length) { log('Clique em "Ler marketplaces do Bling" antes de abrir a grade.', 'aviso'); return; }

    GRADE_MK_TODOS = cacheLojas.filter(function (l) { return !RX_MK_FORA_GRADE.test(l.texto); }).map(function (l) { return l.texto; });
    gradeMkOcultos = await lerMkOcultos();
    gradeOrigemRi = null;
    gradeMarcados = {};
    gradeMkAlvo = {};
    gradeBaseIgualar = {};
    aplicarMkVisiveis();
    montarOverlayGrade();
    gradeStatus('Lendo precos, categorias e vinculos de ' + ids.length + ' SKU(s)...');

    try {
      var dados = await mapaComLimite(ids, 4, function (id) { return buscarVinculos(id); });
      var cacheCusto = await lerCacheCusto();

      // arvore de categorias por marketplace (para os dropdowns)
      gradeCats = {};
      var arvorePorIdLoja = {};
      dados.forEach(function (d) {
        ((d && d.vinculosCategoriasLojas) || []).forEach(function (item) {
          var lista = Array.isArray(item) ? item : (item && typeof item === 'object' ? Object.keys(item).map(function (kk) { return item[kk]; }) : []);
          lista.forEach(function (cc) {
            if (!cc || typeof cc !== 'object') return;
            var il = String(cc.idLoja == null ? '' : cc.idLoja);
            if (!cc.descricao) return;
            if (!arvorePorIdLoja[il]) arvorePorIdLoja[il] = {};
            arvorePorIdLoja[il][String(cc.idCategoria)] = cc.descricao;
          });
        });
      });
      GRADE_MK.forEach(function (mkNome) {
        var loja = null;
        for (var j = 0; j < cacheLojas.length; j++) { if (cacheLojas[j].texto === mkNome) { loja = cacheLojas[j]; break; } }
        var idLoja = loja ? String(loja.valor || '').split(';')[0] : '';
        var arv = arvorePorIdLoja[idLoja];
        if (!arv) return;
        var listaCat = Object.keys(arv).map(function (idc) { return { id: idc, nome: arv[idc] }; });
        listaCat.sort(function (a, b) { return a.nome.localeCompare(b.nome); });
        if (listaCat.length) gradeCats[mkNome] = listaCat;
      });

      gradeDados = ids.map(function (id, i) {
        var d = dados[i] || {};
        var vincs = d.vinculosLojas || [];
        var nome = d.nomeProduto || ('produto ' + id);
        var sku = '';
        var isKit = false;
        for (var k = 0; k < vincs.length; k++) {
          if (vincs[k].sku && !sku) sku = vincs[k].sku;
          if (String(vincs[k].formato || '').toUpperCase() === 'E') isKit = true;
        }
        // categoria marcada por idLoja
        var marc = {};
        ((d && d.vinculosCategoriasLojas) || []).forEach(function (item) {
          var lista = Array.isArray(item) ? item : (item && typeof item === 'object' ? Object.keys(item).map(function (kk) { return item[kk]; }) : []);
          lista.forEach(function (c) {
            if (!c || typeof c !== 'object') return;
            var il = String(c.idLoja == null ? '' : c.idLoja);
            if (c.idCategoriaProdutoLoja && String(c.idCategoriaProdutoLoja) !== '0' && c.descricao) marc[il] = c.descricao;
          });
        });
        var pmap = {};
        GRADE_MK.forEach(function (mkNome) {
          var loja = null;
          for (var j = 0; j < cacheLojas.length; j++) { if (cacheLojas[j].texto === mkNome) { loja = cacheLojas[j]; break; } }
          var idLoja = loja ? String(loja.valor || '').split(';')[0] : '';
          var v = null;
          for (var m = 0; m < vincs.length; m++) { if (String(vincs[m].idLoja) === idLoja) { v = vincs[m]; break; } }
          var vinc = v && vinculoReal(v);
          pmap[mkNome] = {
            vinc: !!vinc,
            preco: vinc ? precoNum(v.preco) : null,
            promo: vinc ? precoNum(v.precoPromocional) : null,
            cat: marc[idLoja] || ''
          };
        });
        var cc = cacheCusto[String(id)];
        return {
          idp: String(id), sku: sku, nome: nome, kit: isKit,
          custo: (cc && typeof cc.v === 'number') ? cc.v : null,
          custoFonte: cc ? (cc.fonte || 'cache') : null,
          p: pmap
        };
      });

      renderGrade();
      gradeSnapshot = JSON.parse(JSON.stringify(gradeDados)); // para desfazer
      gradeStatus('');
      // custo carrega automaticamente (rapido via API v3, cacheado)
      var faltamCusto = gradeDados.filter(function (r) { return r.custo == null; }).length;
      if (faltamCusto) {
        carregarCustosGrade();
      } else {
        var btn = document.getElementById('gradeBtnCustos');
        if (btn) { btn.textContent = 'Custos (cache) \u2713'; }
      }
    } catch (e) {
      gradeStatus('Erro ao ler dados: ' + (e && e.message || e));
    }
  }

  function lerMkOcultos() {
    return new Promise(function (res) {
      chrome.storage.local.get(['esteira_grade_mk_ocultos'], function (r) {
        if (r && r.esteira_grade_mk_ocultos) { res(r.esteira_grade_mk_ocultos); }
        else { res({ 'OLIST': true }); } // padrao inicial: OLIST desligado
      });
    });
  }
  function salvarMkOcultos() {
    chrome.storage.local.set({ esteira_grade_mk_ocultos: gradeMkOcultos });
  }
  function aplicarMkVisiveis() {
    GRADE_MK = GRADE_MK_TODOS.filter(function (mk) { return !gradeMkOcultos[mk]; });
  }

  function abrirConfigMk() {
    var painelCfg = document.getElementById('gradeCfgMk');
    if (painelCfg) { painelCfg.remove(); return; } // toggle
    painelCfg = document.createElement('div');
    painelCfg.id = 'gradeCfgMk';
    painelCfg.style.cssText = 'position:absolute;top:52px;right:180px;z-index:10;background:#1e222c;border:1px solid #363c4a;border-radius:8px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:200px';
    var titulo = document.createElement('div');
    titulo.textContent = 'Marketplaces na grade';
    titulo.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:8px;color:#e7e9ee';
    painelCfg.appendChild(titulo);
    GRADE_MK_TODOS.forEach(function (mk) {
      var lin = document.createElement('label');
      lin.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#c9cdd6;cursor:pointer';
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !gradeMkOcultos[mk];
      chk.addEventListener('change', function () {
        if (chk.checked) delete gradeMkOcultos[mk]; else gradeMkOcultos[mk] = true;
        salvarMkOcultos();
        aplicarMkVisiveis();
        renderGrade();
      });
      lin.appendChild(chk);
      lin.appendChild(document.createTextNode(mk));
      painelCfg.appendChild(lin);
    });
    var nota = document.createElement('div');
    nota.textContent = 'Fica salvo. ML e MercadoShops ficam fora (gestao de anuncios a parte).';
    nota.style.cssText = 'font-size:10px;color:#6b7280;margin-top:8px;max-width:200px';
    painelCfg.appendChild(nota);
    gradeOverlay.appendChild(painelCfg);
  }

  function montarOverlayGrade() {
    if (gradeOverlay) { gradeOverlay.remove(); gradeOverlay = null; }
    gradeOverlay = document.createElement('div');
    gradeOverlay.id = 'esteiraGradeOverlay';
    gradeOverlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646', 'background:#0f1117', 'color:#e7e9ee',
      'font:13px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif', 'display:flex', 'flex-direction:column', 'overflow:hidden'
    ].join(';');

    var topo = document.createElement('div');
    topo.style.cssText = 'display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid #2a2f3a;background:#171a22';
    var titulo = document.createElement('div');
    titulo.innerHTML = '<b style="font-size:15px">\uD83D\uDCCA Esteira Grade</b> <span style="font-size:10px;background:#1e222c;border:1px solid #2a2f3a;border-radius:20px;padding:2px 8px;color:#9aa2b1">' + VERSAO + ' \u00b7 Fase A</span>';
    var status = document.createElement('div');
    status.id = 'gradeStatus';
    status.style.cssText = 'flex:1;color:#9aa2b1;font-size:12px';
    var btnCustos = document.createElement('button');
    btnCustos.id = 'gradeBtnCustos';
    btnCustos.textContent = 'Carregar custos';
    btnCustos.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:7px 12px;background:#1f6feb;color:#fff;font-weight:600;font-size:12px';
    btnCustos.addEventListener('click', carregarCustosGrade);
    var btnCfg = document.createElement('button');
    btnCfg.textContent = '\u2699';
    btnCfg.title = 'Escolher quais marketplaces aparecem na grade';
    btnCfg.style.cssText = 'cursor:pointer;border:1px solid #363c4a;border-radius:6px;padding:7px 11px;background:#1e222c;color:#e7e9ee;font-size:14px';
    btnCfg.addEventListener('click', abrirConfigMk);
    // container de salvar com 3 modos (dropdown)
    var salvarBox = document.createElement('div');
    salvarBox.id = 'gradeSalvarBox';
    salvarBox.style.cssText = 'display:none;position:relative';
    var btnSalvar = document.createElement('button');
    btnSalvar.id = 'gradeBtnSalvar';
    btnSalvar.textContent = '\uD83D\uDCBE Salvar \u25be';
    btnSalvar.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:7px 14px;background:#2ea043;color:#fff;font-weight:700;font-size:12px';
    btnSalvar.title = 'Escolha como salvar: so no Bling, sincronizando precos, ou reexportando o SKU completo.';
    var menuSalvar = document.createElement('div');
    menuSalvar.id = 'gradeMenuSalvar';
    menuSalvar.style.cssText = 'display:none;position:absolute;top:38px;right:0;z-index:20;background:#1e222c;border:1px solid #363c4a;border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:250px';
    menuSalvar.innerHTML =
      '<button class="gSalvOpt" data-modo="salvar" style="display:block;width:100%;text-align:left;cursor:pointer;border:0;border-radius:5px;background:transparent;color:#e7e9ee;padding:8px 10px;font-size:12px">\uD83D\uDCBE <b>Salvar</b><br><span style="color:#9aa2b1;font-size:10px">Grava preco/categoria no Bling (nao envia ao marketplace)</span></button>' +
      '<button class="gSalvOpt" data-modo="sincronizar" style="display:block;width:100%;text-align:left;cursor:pointer;border:0;border-radius:5px;background:transparent;color:#e7e9ee;padding:8px 10px;font-size:12px">\uD83D\uDD04 <b>Salvar + Sincronizar Pre\u00e7os</b><br><span style="color:#9aa2b1;font-size:10px">Grava e empurra SO o preco para o marketplace (rapido)</span></button>' +
      '<button class="gSalvOpt" data-modo="exportar" style="display:block;width:100%;text-align:left;cursor:pointer;border:0;border-radius:5px;background:transparent;color:#e7e9ee;padding:8px 10px;font-size:12px">\uD83D\uDCE6 <b>Salvar + Exportar SKU</b><br><span style="color:#9aa2b1;font-size:10px">Grava e reexporta o produto todo (preco, estoque, imagens, atributos)</span></button>';
    btnSalvar.addEventListener('click', function (e) {
      e.stopPropagation();
      menuSalvar.style.display = (menuSalvar.style.display === 'none') ? 'block' : 'none';
    });
    menuSalvar.querySelectorAll('.gSalvOpt').forEach(function (opt) {
      opt.addEventListener('mouseenter', function () { this.style.background = '#2a2f3a'; });
      opt.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });
      opt.addEventListener('click', function () {
        menuSalvar.style.display = 'none';
        salvarGrade(this.dataset.modo);
      });
    });
    document.addEventListener('click', function () { if (menuSalvar) menuSalvar.style.display = 'none'; });
    salvarBox.appendChild(btnSalvar);
    salvarBox.appendChild(menuSalvar);
    var btnFechar = document.createElement('button');
    btnFechar.textContent = '\u2715 Fechar';
    btnFechar.style.cssText = 'cursor:pointer;border:1px solid #363c4a;border-radius:6px;padding:7px 12px;background:#1e222c;color:#e7e9ee;font-size:12px';
    btnFechar.addEventListener('click', function () { if (gradeOverlay) { gradeOverlay.remove(); gradeOverlay = null; } });
    topo.appendChild(titulo);
    topo.appendChild(status);
    topo.appendChild(btnCfg);
    topo.appendChild(salvarBox);
    topo.appendChild(btnCustos);
    topo.appendChild(btnFechar);

    var avisoBar = document.createElement('div');
    avisoBar.id = 'gradeAviso';
    avisoBar.style.cssText = 'display:none;padding:8px 18px;background:#2b2410;border-bottom:1px solid #4a3d17;color:#f0d48a;font-size:12px';

    // ---- barra de acoes em massa (blocos organizados) ----
    var acoesBar = document.createElement('div');
    acoesBar.id = 'gradeAcoes';
    acoesBar.style.cssText = 'display:flex;align-items:stretch;gap:10px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid #2a2f3a;background:#0d1117';
    var estiloBloco = 'display:flex;flex-direction:column;gap:6px;background:#171a22;border:1px solid #2a2f3a;border-radius:8px;padding:8px 12px';
    var estiloTitBloco = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280';
    var estiloLinBloco = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
    var inpStyle = 'background:#0d1117;border:1px solid #363c4a;border-radius:5px;padding:5px 7px;color:#e7e9ee;font-size:12px';
    acoesBar.innerHTML =
      // bloco seleção
      '<div style="' + estiloBloco + ';justify-content:center;min-width:96px">' +
        '<div style="' + estiloTitBloco + '">Sele\u00e7\u00e3o</div>' +
        '<div style="' + estiloLinBloco + '"><span id="gAcSel" style="color:#c9cdd6;font-weight:600">0 marcados</span></div>' +
      '</div>' +
      // bloco 1: reajuste
      '<div style="' + estiloBloco + '">' +
        '<div style="' + estiloTitBloco + '">1 \u00b7 Reajustar pre\u00e7o dos marcados</div>' +
        '<div style="' + estiloLinBloco + '">' +
          '<input id="gAcVal" type="number" step="0.5" value="5" style="' + inpStyle + ';width:62px">' +
          '<select id="gAcTipo" style="' + inpStyle + '"><option value="pct-up">\u25b2 %</option><option value="pct-dn">\u25bc %</option><option value="rs-up">\u25b2 R$</option><option value="rs-dn">\u25bc R$</option></select>' +
          '<select id="gAcAlvoPreco" style="' + inpStyle + '"><option value="ambos">Pre\u00e7o+Promo</option><option value="preco">S\u00f3 Pre\u00e7o</option><option value="promo">S\u00f3 Promo</option></select>' +
          '<button id="gAcAplicar" style="cursor:pointer;border:1px solid #1f6feb;border-radius:5px;background:#1f6feb;color:#fff;font-weight:600;padding:5px 12px;font-size:12px">aplicar</button>' +
        '</div>' +
      '</div>' +
      // bloco 2: copiar
      '<div style="' + estiloBloco + '">' +
        '<div style="' + estiloTitBloco + '">2 \u00b7 Copiar um produto para os marcados</div>' +
        '<div style="' + estiloLinBloco + '">' +
          '<button id="gAcDefOrigem" style="cursor:pointer;border:1px solid #3b82f6;border-radius:5px;background:#132a4a;color:#7fb2ff;padding:5px 10px;font-size:12px">\u25c9 definir origem</button>' +
          '<span id="gAcOrigem" style="color:#8fb3ff;font-size:12px">nenhuma</span>' +
          '<button id="gAcColar" disabled style="cursor:pointer;border:1px solid #2ea043;border-radius:5px;background:#2ea043;color:#fff;font-weight:600;padding:5px 12px;font-size:12px;opacity:.4">\u2b07 colar nos marcados</button>' +
        '</div>' +
      '</div>' +
      // bloco extras: marketplaces alvo + voltar
      '<div style="' + estiloBloco + ';justify-content:center">' +
        '<div style="' + estiloTitBloco + '">Op\u00e7\u00f5es</div>' +
        '<div style="' + estiloLinBloco + '">' +
          '<button id="gAcMk" style="cursor:pointer;border:1px solid #363c4a;border-radius:5px;background:#1e222c;color:#c9cdd6;padding:5px 10px;font-size:12px">marketplaces: todos \u25be</button>' +
          '<button id="gAcVoltar" style="cursor:pointer;border:1px solid #d29922;border-radius:5px;background:#2b2410;color:#f0b429;padding:5px 10px;font-size:12px">\u21b6 desfazer</button>' +
        '</div>' +
      '</div>';

    var wrap = document.createElement('div');
    wrap.id = 'gradeWrap';
    wrap.style.cssText = 'flex:1;overflow:auto;padding:0';

    gradeOverlay.appendChild(topo);
    gradeOverlay.appendChild(acoesBar);
    gradeOverlay.appendChild(avisoBar);
    gradeOverlay.appendChild(wrap);
    document.body.appendChild(gradeOverlay);

    // ligar acoes
    document.getElementById('gAcColar').addEventListener('click', colarOrigemNosMarcados);
    document.getElementById('gAcAplicar').addEventListener('click', aplicarReajusteMarcados);
    document.getElementById('gAcMk').addEventListener('click', abrirSeletorMkAlvo);
    document.getElementById('gAcDefOrigem').addEventListener('click', function () {
      gradeModoOrigem = !gradeModoOrigem;
      this.style.background = gradeModoOrigem ? '#1f6feb' : '#132a4a';
      this.style.color = gradeModoOrigem ? '#fff' : '#7fb2ff';
      this.textContent = gradeModoOrigem ? '\u25c9 clique numa linha...' : '\u25c9 definir origem';
      if (gradeModoOrigem) gradeAviso('Modo origem: clique na linha do produto que serve de modelo.');
    });
    document.getElementById('gAcVoltar').addEventListener('click', desfazerGrade);
  }

  function gradeStatus(txtStr) {
    var el = document.getElementById('gradeStatus');
    if (el) el.textContent = txtStr || '';
  }
  function gradeAviso(txtStr) {
    var el = document.getElementById('gradeAviso');
    if (!el) return;
    if (txtStr) { el.textContent = '\u26A0 ' + txtStr; el.style.display = 'block'; }
    else el.style.display = 'none';
  }

  function classeMargem(custo, preco) {
    if (preco == null) return '';
    if (custo == null) return 'semcusto';
    if (preco < custo * 1.10) return 'below';
    var m = (preco - custo) / preco;
    if (m < 0.25) return 'thin';
    return 'ok';
  }
  function textoMargem(custo, preco) {
    if (preco == null || custo == null) return '';
    var m = (preco - custo) / preco * 100;
    return (m >= 0 ? '+' : '') + m.toFixed(0) + '%';
  }

  function renderGrade() {
    var wrap = document.getElementById('gradeWrap');
    if (!wrap) return;
    var estilo = '<style>' +
      '#gradeTbl{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}' +
      '#gradeTbl th,#gradeTbl td{white-space:nowrap;border-bottom:1px solid #10141c}' +
      '#gradeTbl thead th{position:sticky;top:0;background:#1e222c;z-index:3;font-size:11px;font-weight:600;color:#9aa2b1;padding:9px 10px;border-bottom:1px solid #363c4a}' +
      '#gradeTbl thead th.mk{text-align:center;border-left:1px solid #2a2f3a}' +
      '#gradeTbl tbody tr{background:#141821}' +
      '#gradeTbl tbody tr:nth-child(even){background:#1b202b}' +
      '#gradeTbl tbody td{border-top:2px solid #0b0d13;padding:8px 10px}' +
      '#gradeTbl tbody tr:hover{background:#233049}' +
      '#gradeTbl tbody tr:hover td{border-top-color:#3b82f6;border-bottom-color:#3b82f6}' +
      '.g-sku{position:sticky;left:36px;background:inherit;z-index:2;font-weight:600;font-size:12px;border-right:1px solid #363c4a}' +
      '.g-chk{position:sticky;left:0;background:inherit;z-index:2;width:36px;text-align:center;border-right:1px solid #2a2f3a}' +
      '.g-linha{cursor:pointer}' +
      '.g-linha.g-origem td{background:#132a4a !important}' +
      '.g-tag-origem{font-size:8px;font-weight:700;background:#132a4a;color:#7fb2ff;border:1px solid #3b82f6;border-radius:3px;padding:0 4px;margin-right:4px}' +
      '.g-prod{color:#9aa2b1;max-width:240px;overflow:hidden;text-overflow:ellipsis;font-size:12px}' +
      '.g-kit{font-size:9.5px;background:#20283a;color:#8fb3ff;padding:1px 5px;border-radius:4px;margin-left:5px}' +
      '.g-custo{text-align:right;font-weight:600;color:#d7dae2;border-right:1px solid #363c4a;background:inherit}' +
      '.g-custo small{display:block;font-size:9px;color:#6b7280;font-weight:400}' +
      '.g-cell{display:flex;flex-direction:column;align-items:center;gap:2px}' +
      '.g-preco{font-weight:600}' +
      '.g-marg{font-size:9.5px;color:#6b7280;height:12px}' +
      '.g-cell.ok .g-marg{color:#22c55e}.g-cell.thin .g-marg{color:#f0b429}.g-cell.below .g-marg{color:#ef4444;font-weight:700}.g-cell.below .g-preco-inp{border-color:#ef4444;background:#2a1414;color:#ffb4b4}.g-cell.semcusto .g-marg{color:#6b7280}' +
      '.g-preco-inp{width:74px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;background:#0d1117;border:1px solid #363c4a;border-radius:5px;padding:3px 5px;color:#e7e9ee;font-size:12px}' +
      '.g-preco-inp:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.25)}' +
      '.g-preco-linha{display:flex;align-items:center;gap:4px;justify-content:center}' +
      '.g-preco-lbl{font-size:8px;color:#6b7280;width:14px;text-align:right}' +
      '.g-promo-lbl{color:#f0b429}' +
      '.g-promo-inp{border-color:#4a3d17}' +
      '.g-cell.below .g-promo-inp{border-color:#ef4444;background:#2a1414;color:#ffb4b4}' +
      '.g-catsel{width:120px;background:#0d1117;border:1px solid #363c4a;border-radius:5px;padding:3px 5px;font-size:10px;color:#c9cdd6}' +
      '.g-catsel:focus{outline:none;border-color:#3b82f6}' +
      '.g-catsel.vazia{border-color:#f0b429;color:#f0b429}' +
      '.g-copiar{cursor:pointer;border:1px solid #363c4a;border-radius:5px;background:#1e222c;color:#c9cdd6;font-size:11px;padding:5px 9px}' +
      '.g-copiar:hover{background:#2a2f3a}' +
      '.g-ativar{cursor:pointer;border:1px dashed #2ea043;border-radius:5px;background:#0f2a1a;color:#4ade80;font-size:10px;padding:4px 10px}' +
      '.g-ativar:hover{background:#123b1f}' +
      '.g-cell.g-novo{outline:1px solid #2ea043;outline-offset:-1px;border-radius:6px;padding:2px}' +
      '.g-cell.g-mexido{background:#1a2333;border-radius:6px;box-shadow:inset 0 0 0 1px #2a4a6a}' +
      '.g-cell.g-base{box-shadow:inset 0 0 0 2px #f0b429 !important;border-radius:6px}' +
      '.g-badge-novo{font-size:8px;font-weight:700;background:#0f2a1a;color:#4ade80;border:1px solid #2ea043;border-radius:3px;padding:0 4px;margin-bottom:1px}' +
      '.g-cat{font-size:9.5px;color:#8b93a3;max-width:120px;overflow:hidden;text-overflow:ellipsis}' +
      '.g-cat.vazia{color:#f0b429}' +
      '.g-novin{display:inline-block;border:1px dashed #363c4a;border-radius:5px;background:#22283a;color:#6b7280;font-size:10px;padding:3px 8px}' +
      '</style>';

    var thead = '<tr><th class="g-chk"><input type="checkbox" id="gChkTodos" title="Marcar/desmarcar todos"></th><th class="g-sku">SKU</th><th class="g-prod">Produto</th><th class="g-custo">Custo</th>';
    GRADE_MK.forEach(function (mk) { thead += '<th class="mk">' + mk + '<br><span style="font-weight:400;color:#6b7280;font-size:10px">pre\u00e7o \u00b7 margem \u00b7 categoria</span></th>'; });
    thead += '<th style="text-align:center">Copiar interno</th></tr>';

    var rows = '';
    gradeDados.forEach(function (row, ri) {
      var ehOrigem = (gradeOrigemRi === ri);
      var marcado = !!gradeMarcados[ri];
      rows += '<tr class="g-linha' + (ehOrigem ? ' g-origem' : '') + '" data-linha="' + ri + '">';
      rows += '<td class="g-chk"><input type="checkbox" class="g-rowchk" data-r="' + ri + '"' + (marcado ? ' checked' : '') + '></td>';
      rows += '<td class="g-sku">' + (ehOrigem ? '<span class="g-tag-origem">ORIGEM</span> ' : '') + (row.sku || '<span style="color:#6b7280">(sem SKU)</span>') + '</td>';
      rows += '<td class="g-prod" title="' + escId(row.nome) + '">' + escId(row.nome) + (row.kit ? '<span class="g-kit">KIT</span>' : '') + '</td>';
      var custoCell;
      if (row.custoErro) {
        custoCell = '<td class="g-custo" style="color:#ef4444;background:#2a1414"><span title="Tem fornecedor mas custo zerado/vazio - corrija no cadastro">\u26A0 SEM CUSTO</span><small style="color:#ef4444">erro cadastro</small></td>';
      } else if (row.custo == null) {
        custoCell = '<td class="g-custo"><span style="color:#6b7280">—</span></td>';
      } else {
        custoCell = '<td class="g-custo">' + fmtBRL(row.custo) + '<small>' + (row.custoFonte === 'kit' ? 'kit' : 'simples') + '</small></td>';
      }
      rows += custoCell;
      GRADE_MK.forEach(function (mk) {
        var c = row.p[mk] || {};
        if (!c.vinc && !c.ativar) {
          rows += '<td class="mk" style="text-align:center"><button class="g-ativar" data-r="' + ri + '" data-mk="' + escId(mk) + '">+ ativar</button></td>';
        } else {
          var novo = (!c.vinc && c.ativar);
          // margem calculada sobre o preco promocional (preco de venda real); se nao tiver, usa o preco
          var precoVenda = (c.promo != null) ? c.promo : c.preco;
          var cl = classeMargem(row.custo, precoVenda);
          var opcoesCat = (gradeCats[mk] || []);
          var catAtual = c.cat || '';
          var selHtml = '<select class="g-catsel ' + (catAtual ? '' : 'vazia') + '" data-r="' + ri + '" data-mk="' + escId(mk) + '">';
          selHtml += '<option value="">— categoria —</option>';
          var achouCat = false;
          opcoesCat.forEach(function (cat) {
            var sel = (cat.nome === catAtual) ? ' selected' : '';
            if (sel) achouCat = true;
            selHtml += '<option' + sel + '>' + escId(cat.nome) + '</option>';
          });
          if (catAtual && !achouCat) selHtml += '<option selected>' + escId(catAtual) + '</option>';
          selHtml += '</select>';

          var badgeNovo = novo ? '<span class="g-badge-novo" title="Vinculo novo - sera criado ao salvar">NOVO</span>' : '';
          var mexido = (c.alterado || c.catAlterada || (novo && c.preco != null)) ? ' g-mexido' : '';
          var valPreco = (c.preco != null) ? fmtNum(c.preco) : '';
          var valPromo = (c.promo != null) ? fmtNum(c.promo) : '';
          rows += '<td class="mk"><div class="g-cell ' + cl + (novo ? ' g-novo' : '') + mexido + '" data-cellr="' + ri + '" data-cellmk="' + escId(mk) + '">' +
            badgeNovo +
            '<div class="g-preco-linha"><span class="g-preco-lbl">P</span><input class="g-preco-inp" data-r="' + ri + '" data-mk="' + escId(mk) + '" data-campo="preco" value="' + valPreco + '" placeholder="pre\u00e7o" inputmode="decimal"></div>' +
            '<div class="g-preco-linha"><span class="g-preco-lbl g-promo-lbl">Pr</span><input class="g-preco-inp g-promo-inp" data-r="' + ri + '" data-mk="' + escId(mk) + '" data-campo="promo" value="' + valPromo + '" placeholder="promo" inputmode="decimal"></div>' +
            '<span class="g-marg">' + textoMargem(row.custo, precoVenda) + '</span>' +
            selHtml +
            '</div></td>';
        }
      });
      rows += '<td style="text-align:center;white-space:nowrap">' +
        '<button class="g-copiar" data-r="' + ri + '" title="Clique no preco do marketplace-base primeiro, depois aqui para copiar esse preco/categoria para os demais marketplaces deste produto">\u21c4 igualar</button>' +
        '</td>';
      rows += '</tr>';
    });

    wrap.innerHTML = estilo + '<table id="gradeTbl"><thead>' + thead + '</thead><tbody>' + rows + '</tbody></table>';
    ligarEdicaoGrade();
    atualizarContadorAcoes();
  }

  // ---- eventos de edicao inline ----
  function ligarEdicaoGrade() {
    var wrap = document.getElementById('gradeWrap');
    if (!wrap) return;
    // preco
    wrap.querySelectorAll('.g-preco-inp').forEach(function (inp) {
      inp.addEventListener('focus', function () {
        this.select();
        var ri = parseInt(this.dataset.r, 10);
        gradeBaseIgualar[ri] = this.dataset.mk; // esta celula vira a base do igualar desta linha
        destacarBaseIgualar(ri, this.dataset.mk);
      });
      inp.addEventListener('input', function () { onEditPreco(this); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });
    });
    // categoria
    wrap.querySelectorAll('.g-catsel').forEach(function (sel) {
      sel.addEventListener('change', function () { onEditCat(this); });
    });
    // copiar
    wrap.querySelectorAll('.g-copiar').forEach(function (btn) {
      btn.addEventListener('click', function () { copiarProdutoGrade(parseInt(this.dataset.r, 10)); });
    });
    // ativar vinculo novo
    wrap.querySelectorAll('.g-ativar').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var ri = parseInt(this.dataset.r, 10);
        var mk = this.dataset.mk;
        var row = gradeDados[ri];
        if (!row) return;
        if (!row.p[mk]) row.p[mk] = { vinc: false };
        row.p[mk].ativar = true;
        if (row.p[mk].preco == null) row.p[mk].preco = null;
        marcarAlteracaoGrade();
        renderGrade();
        atualizarBtnSalvarGrade();
      });
    });
    // marcar como modelo
    // (substituido por checkbox/origem na barra de acoes)
    // checkbox de linha (destino/alvo)
    wrap.querySelectorAll('.g-rowchk').forEach(function (chk) {
      chk.addEventListener('click', function (e) {
        e.stopPropagation();
        var ri = parseInt(this.dataset.r, 10);
        if (this.checked) gradeMarcados[ri] = true; else delete gradeMarcados[ri];
        atualizarContadorAcoes();
      });
    });
    // clique na LINHA define a origem SOMENTE no modo origem (menos em inputs/botoes)
    wrap.querySelectorAll('.g-linha').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (!gradeModoOrigem) return;
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'button' || tag === 'option') return;
        var ri = parseInt(this.dataset.linha, 10);
        gradeOrigemRi = ri;
        gradeModoOrigem = false;
        var btnDef = document.getElementById('gAcDefOrigem');
        if (btnDef) { btnDef.style.background = '#132a4a'; btnDef.style.color = '#7fb2ff'; btnDef.textContent = '\u25c9 definir origem'; }
        renderGrade();
        atualizarContadorAcoes();
      });
    });
    var chkTodos = document.getElementById('gChkTodos');
    if (chkTodos) {
      // sincroniza o estado do mestre com os marcados atuais
      var totalLinhas = gradeDados.length;
      var nMarc = Object.keys(gradeMarcados).filter(function (k) { return gradeMarcados[k]; }).length;
      chkTodos.checked = (totalLinhas > 0 && nMarc === totalLinhas);
      chkTodos.addEventListener('click', function () {
        if (chkTodos.checked) { gradeDados.forEach(function (_, ri) { gradeMarcados[ri] = true; }); }
        else { gradeMarcados = {}; }
        renderGrade();
        atualizarContadorAcoes();
      });
    }
  }

  function onEditPreco(inp) {
    var ri = parseInt(inp.dataset.r, 10);
    var mk = inp.dataset.mk;
    var campo = inp.dataset.campo || 'preco';
    var v = precoNum(inp.value);
    var row = gradeDados[ri];
    if (!row || !row.p[mk]) return;
    if (campo === 'promo') row.p[mk].promo = v;
    else row.p[mk].preco = v;
    if (row.p[mk].vinc) row.p[mk].alterado = true;
    marcarAlteracaoGrade();
    // margem sobre o preco de venda real (promo, ou preco se nao houver promo)
    var precoVenda = (row.p[mk].promo != null) ? row.p[mk].promo : row.p[mk].preco;
    var cell = inp.closest('.g-cell');
    var cl = classeMargem(row.custo, precoVenda);
    cell.classList.remove('ok', 'thin', 'below', 'semcusto');
    if (cl) cell.classList.add(cl);
    var marg = cell.querySelector('.g-marg');
    if (marg) marg.textContent = textoMargem(row.custo, precoVenda);
    atualizarBtnSalvarGrade();
  }

  function onEditCat(sel) {
    var ri = parseInt(sel.dataset.r, 10);
    var mk = sel.dataset.mk;
    var row = gradeDados[ri];
    if (!row || !row.p[mk]) return;
    row.p[mk].cat = sel.value;
    row.p[mk].catAlterada = true;
    sel.classList.toggle('vazia', !sel.value);
    marcarAlteracaoGrade();
  }

  function destacarBaseIgualar(ri, mk) {
    var wrap = document.getElementById('gradeWrap');
    if (!wrap) return;
    // remove destaque anterior da mesma linha
    wrap.querySelectorAll('.g-cell.g-base[data-cellr="' + ri + '"]').forEach(function (el) { el.classList.remove('g-base'); });
    var cell = wrap.querySelector('.g-cell[data-cellr="' + ri + '"][data-cellmk="' + escId(mk) + '"]');
    if (cell) cell.classList.add('g-base');
    // atualiza o rotulo do botao igualar dessa linha
    var btn = wrap.querySelector('.g-copiar[data-r="' + ri + '"]');
    if (btn) btn.textContent = '\u21c4 igualar de ' + mk.slice(0, 6);
  }

  function copiarProdutoGrade(ri) {
    var row = gradeDados[ri];
    if (!row) return;
    var basePreco = null, basePromo = null, baseCat = null, baseMk = null;
    // 1) usa o marketplace da ultima celula focada nesta linha, se tiver preco
    var mkEscolhido = gradeBaseIgualar[ri];
    if (mkEscolhido && row.p[mkEscolhido] && row.p[mkEscolhido].preco != null) {
      var cb = row.p[mkEscolhido];
      basePreco = cb.preco; basePromo = cb.promo; baseCat = cb.cat; baseMk = mkEscolhido;
    } else {
      // 2) fallback: primeira coluna com preco
      for (var i = 0; i < GRADE_MK.length; i++) {
        var c = row.p[GRADE_MK[i]];
        if (c && (c.vinc || c.ativar) && c.preco != null) { basePreco = c.preco; basePromo = c.promo; baseCat = c.cat; baseMk = GRADE_MK[i]; break; }
      }
    }
    if (basePreco == null) { gradeAviso('Clique no preco do marketplace que sera a base e preencha, depois clique igualar.'); return; }
    GRADE_MK.forEach(function (mk) {
      var c = row.p[mk];
      if (c && (c.vinc || c.ativar)) {
        c.preco = basePreco;
        if (basePromo != null) c.promo = basePromo;
        if (c.vinc) c.alterado = true;
        if (baseCat && (gradeCats[mk] || []).some(function (x) { return x.nome === baseCat; })) {
          c.cat = baseCat; c.catAlterada = true;
        }
      }
    });
    marcarAlteracaoGrade();
    renderGrade();
    atualizarBtnSalvarGrade();
    gradeAviso('Igualado a partir de ' + (baseMk || 'base') + ' (R$ ' + fmtNum(basePreco) + ') em "' + (row.sku || 'produto') + '".');
  }

  function desfazerGrade() {
    if (!gradeSnapshot) return;
    if (gradeTemAlteracao && !confirm('Desfazer TODAS as alteracoes nao salvas e voltar aos valores originais do Bling?')) return;
    gradeDados = JSON.parse(JSON.stringify(gradeSnapshot));
    gradeTemAlteracao = false;
    gradeOrigemRi = null;
    gradeModoOrigem = false;
    gradeMarcados = {};
    renderGrade();
    atualizarBtnSalvarGrade();
    atualizarContadorAcoes();
    gradeAviso('Alteracoes desfeitas. Grade voltou aos valores originais.');
  }

  function mkAlvoLista() {
    // se nenhum marketplace escolhido, usa todos os visiveis
    var escolhidos = Object.keys(gradeMkAlvo).filter(function (k) { return gradeMkAlvo[k]; });
    return escolhidos.length ? GRADE_MK.filter(function (mk) { return gradeMkAlvo[mk]; }) : GRADE_MK.slice();
  }

  function atualizarContadorAcoes() {
    var n = Object.keys(gradeMarcados).filter(function (k) { return gradeMarcados[k]; }).length;
    var sel = document.getElementById('gAcSel');
    if (sel) sel.textContent = n + ' marcados';
    var org = document.getElementById('gAcOrigem');
    if (org) {
      if (gradeOrigemRi != null && gradeDados[gradeOrigemRi]) org.textContent = 'origem: ' + (gradeDados[gradeOrigemRi].sku || 'linha ' + (gradeOrigemRi + 1));
      else org.textContent = 'origem: (clique numa linha)';
    }
    var btnColar = document.getElementById('gAcColar');
    if (btnColar) {
      var pode = (gradeOrigemRi != null && n > 0);
      btnColar.disabled = !pode;
      btnColar.style.opacity = pode ? '1' : '.5';
      btnColar.style.cursor = pode ? 'pointer' : 'default';
    }
    var btnMk = document.getElementById('gAcMk');
    if (btnMk) {
      var escolhidos = Object.keys(gradeMkAlvo).filter(function (k) { return gradeMkAlvo[k]; });
      btnMk.textContent = 'marketplaces: ' + (escolhidos.length ? escolhidos.length + ' escolhido(s)' : 'todos') + ' \u25be';
    }
  }

  function colarOrigemNosMarcados() {
    if (gradeOrigemRi == null) { gradeAviso('Defina a origem: clique numa linha primeiro.'); return; }
    var marcados = Object.keys(gradeMarcados).filter(function (k) { return gradeMarcados[k]; }).map(Number);
    if (!marcados.length) { gradeAviso('Marque os produtos destino (checkbox) antes de colar.'); return; }
    var modelo = gradeDados[gradeOrigemRi];
    var alvos = mkAlvoLista();
    var totalCop = 0, totalAtiv = 0, nDest = 0;
    marcados.forEach(function (destinoRi) {
      if (destinoRi === gradeOrigemRi) return;
      var destino = gradeDados[destinoRi];
      if (!destino) return;
      nDest++;
      alvos.forEach(function (mk) {
        var cm = modelo.p[mk];
        if (!cm || (!cm.vinc && !cm.ativar)) return;
        if (cm.preco == null && cm.promo == null && !cm.cat) return;
        if (!destino.p[mk]) destino.p[mk] = { vinc: false };
        var cd = destino.p[mk];
        if (!cd.vinc) { cd.ativar = true; totalAtiv++; }
        if (cm.preco != null) cd.preco = cm.preco;
        if (cm.promo != null) cd.promo = cm.promo;
        if (cm.cat && (gradeCats[mk] || []).some(function (x) { return x.nome === cm.cat; })) {
          cd.cat = cm.cat; cd.catAlterada = true;
        }
        if (cd.vinc) cd.alterado = true;
        totalCop++;
      });
    });
    if (!totalCop) { gradeAviso('Nada copiado (origem sem precos/categorias nos marketplaces alvo).'); return; }
    marcarAlteracaoGrade();
    renderGrade();
    atualizarBtnSalvarGrade();
    atualizarContadorAcoes();
    gradeAviso('Copiado de "' + (modelo.sku || 'origem') + '" para ' + nDest + ' produto(s): ' + totalCop + ' celula(s)' + (totalAtiv ? ', ' + totalAtiv + ' vinculo(s) novo(s)' : '') + '. Revise e salve.');
  }

  function aplicarReajusteMarcados() {
    var marcados = Object.keys(gradeMarcados).filter(function (k) { return gradeMarcados[k]; }).map(Number);
    if (!marcados.length) { gradeAviso('Marque os produtos (checkbox) para aplicar o reajuste.'); return; }
    var val = parseFloat(document.getElementById('gAcVal').value) || 0;
    var tipo = document.getElementById('gAcTipo').value;
    var alvoPreco = document.getElementById('gAcAlvoPreco').value; // ambos|preco|promo
    var alvos = mkAlvoLista();
    if (val === 0) { gradeAviso('Informe um valor de reajuste diferente de zero.'); return; }

    function reaj(v) {
      if (v == null) return null;
      if (tipo === 'pct-up') v = v * (1 + val / 100);
      else if (tipo === 'pct-dn') v = v * (1 - val / 100);
      else if (tipo === 'rs-up') v = v + val;
      else if (tipo === 'rs-dn') v = v - val;
      return Math.round(v * 100) / 100;
    }

    var n = 0;
    marcados.forEach(function (ri) {
      var row = gradeDados[ri];
      if (!row) return;
      alvos.forEach(function (mk) {
        var c = row.p[mk];
        if (!c || (!c.vinc && !c.ativar)) return;
        if (alvoPreco === 'ambos' || alvoPreco === 'preco') { if (c.preco != null) { c.preco = reaj(c.preco); if (c.vinc) c.alterado = true; n++; } }
        if (alvoPreco === 'ambos' || alvoPreco === 'promo') { if (c.promo != null) { c.promo = reaj(c.promo); if (c.vinc) c.alterado = true; } }
      });
    });
    if (!n) { gradeAviso('Nenhum preco para reajustar nos marcados/marketplaces alvo.'); return; }
    marcarAlteracaoGrade();
    renderGrade();
    atualizarBtnSalvarGrade();
    atualizarContadorAcoes();
    var sinal = (tipo.indexOf('up') !== -1) ? '+' : '-';
    var unid = (tipo.indexOf('pct') !== -1) ? '%' : ' R$';
    gradeAviso('Reajuste ' + sinal + val + unid + ' aplicado em ' + marcados.length + ' produto(s) (' + alvoPreco + '). Revise as margens e salve.');
  }

  function abrirSeletorMkAlvo() {
    var painelCfg = document.getElementById('gradeMkAlvoBox');
    if (painelCfg) { painelCfg.remove(); return; }
    painelCfg = document.createElement('div');
    painelCfg.id = 'gradeMkAlvoBox';
    painelCfg.style.cssText = 'position:absolute;top:96px;right:18px;z-index:11;background:#1e222c;border:1px solid #363c4a;border-radius:8px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:200px';
    var titulo = document.createElement('div');
    titulo.textContent = 'Aplicar copia/reajuste em:';
    titulo.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:8px;color:#e7e9ee';
    painelCfg.appendChild(titulo);
    var linTodos = document.createElement('label');
    linTodos.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#8fb3ff;cursor:pointer;border-bottom:1px solid #2a2f3a;margin-bottom:4px';
    var chkTodos = document.createElement('input');
    chkTodos.type = 'checkbox';
    chkTodos.checked = Object.keys(gradeMkAlvo).filter(function (k) { return gradeMkAlvo[k]; }).length === 0;
    chkTodos.addEventListener('change', function () {
      if (chkTodos.checked) { gradeMkAlvo = {}; abrirSeletorMkAlvo(); abrirSeletorMkAlvo(); atualizarContadorAcoes(); }
    });
    linTodos.appendChild(chkTodos);
    linTodos.appendChild(document.createTextNode('TODOS os marketplaces'));
    painelCfg.appendChild(linTodos);
    GRADE_MK.forEach(function (mk) {
      var lin = document.createElement('label');
      lin.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#c9cdd6;cursor:pointer';
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!gradeMkAlvo[mk];
      chk.addEventListener('change', function () {
        if (chk.checked) gradeMkAlvo[mk] = true; else delete gradeMkAlvo[mk];
        atualizarContadorAcoes();
      });
      lin.appendChild(chk);
      lin.appendChild(document.createTextNode(mk));
      painelCfg.appendChild(lin);
    });
    var nota = document.createElement('div');
    nota.textContent = 'Marque marketplaces especificos, ou deixe "TODOS".';
    nota.style.cssText = 'font-size:10px;color:#6b7280;margin-top:8px';
    painelCfg.appendChild(nota);
    gradeOverlay.appendChild(painelCfg);
  }

  var gradeTemAlteracao = false;
  function marcarAlteracaoGrade() { gradeTemAlteracao = true; }
  function atualizarBtnSalvarGrade() {
    var btn = document.getElementById('gradeBtnSalvar');
    if (!btn) return;
    // conta alteracoes e abaixo-do-piso
    var nAlt = 0, nBelow = 0, nNovo = 0;
    gradeDados.forEach(function (row) {
      GRADE_MK.forEach(function (mk) {
        var c = row.p[mk];
        if (!c) return;
        var ehNovo = (!c.vinc && c.ativar);
        var ehEdicao = (c.vinc && (c.alterado || c.catAlterada));
        if (ehNovo) { nNovo++; nAlt++; }
        else if (ehEdicao) nAlt++;
        var precoVenda = (c.promo != null) ? c.promo : c.preco;
        if ((ehNovo || c.alterado) && precoVenda != null && classeMargem(row.custo, precoVenda) === 'below') nBelow++;
      });
    });
    var box = document.getElementById('gradeSalvarBox');
    if (box) box.style.display = gradeTemAlteracao ? 'block' : 'none';
    if (nBelow > 0) {
      btn.disabled = true; btn.style.opacity = '.5'; btn.style.cursor = 'default';
      btn.textContent = '\u26A0 ' + nBelow + ' abaixo do piso';
      btn.style.background = '#7f1d1d';
    } else {
      btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer';
      var txt = '\uD83D\uDCBE Salvar ' + nAlt + (nNovo > 0 ? ' (' + nNovo + ' novo)' : '') + ' \u25be';
      btn.textContent = txt;
      btn.style.background = '#2ea043';
    }
  }

  function escId(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Carregar custos: GET /Api/v3/produtos/{id} -> fornecedores[padrao].precoCusto ----
  async function buscarCustoProduto(idp) {
    var r = await fetch('https://www.bling.com.br/Api/v3/produtos/' + idp, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var data = (j && j.data) ? j.data : j;
    var forns = (data && data.fornecedores) || [];
    if (!forns.length) return { custo: null, temFornecedor: false, erro: false };
    var escolhido = null;
    for (var i = 0; i < forns.length; i++) { if (forns[i].padrao) { escolhido = forns[i]; break; } }
    if (!escolhido) escolhido = forns[0];
    var c = escolhido.precoCusto;
    var num = (typeof c === 'number') ? c : precoNum(c);
    // tem fornecedor mas custo zerado/vazio = ERRO de cadastro
    var custoErro = (num == null || num === 0);
    return { custo: (num != null && num !== 0 ? Math.round(num * 100) / 100 : null), temFornecedor: true, erro: custoErro };
  }

  async function carregarCustosGrade() {
    var btn = document.getElementById('gradeBtnCustos');
    var pendentes = gradeDados.filter(function (r) { return r.custo == null; });
    if (!pendentes.length) { gradeAviso('Todos os custos j\u00e1 carregados.'); return; }
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.style.cursor = 'default'; }
    gradeAviso('');
    var total = pendentes.length, feitos = 0, semForn = 0, custoErro = 0;
    var cacheCusto = await lerCacheCusto();

    await mapaComLimite(pendentes, 4, async function (row) {
      if (btn) btn.textContent = 'Carregando custos ' + (++feitos) + '/' + total + '...';
      try {
        var res = await buscarCustoProduto(row.idp);
        row.custo = res.custo;
        row.custoErro = res.erro;
        row.temFornecedor = res.temFornecedor;
        row.custoFonte = row.kit ? 'kit' : 'simples';
        if (res.erro) custoErro++;
        else if (!res.temFornecedor) semForn++;
        if (res.temFornecedor && res.custo != null) {
          cacheCusto[String(row.idp)] = { v: res.custo, fonte: row.custoFonte, t: Date.now() };
        }
      } catch (e) {
        row.custoFonte = 'erro';
      }
      atualizarLinhaCusto(row);
    });

    salvarCacheCusto(cacheCusto);
    renderGrade();
    if (btn) { btn.textContent = 'Custos carregados \u2713'; }
    var avisos = [];
    if (custoErro) avisos.push(custoErro + ' SKU(s) com FORNECEDOR mas SEM custo (erro de cadastro - vermelho na coluna Custo)');
    if (semForn) avisos.push(semForn + ' sem fornecedor (custo em branco - normal p/ pai de varia\u00e7\u00e3o)');
    gradeAviso(avisos.join(' \u00b7 '));
  }

  // atualiza so a celula de custo + recalcula margens da linha (durante o carregamento)
  function atualizarLinhaCusto(row) {
    // durante o loop, o mais simples e re-render no fim; aqui so guardamos.
    // (mantido leve; renderGrade no fim redesenha tudo com margens)
  }

  // sincroniza precos direto do painel: SKUs selecionados x marketplaces ticados
  async function sincronizarPrecosSelecionados() {
    if (rodando || ocupado) { log('Aguarde a operacao atual terminar.', 'aviso'); return; }
    var ids = idsProdutosSelecionados();
    if (!ids.length) { log('Selecione os SKUs na listagem primeiro.', 'aviso'); return; }
    var marcadas = lojasEscolhidas();
    if (!marcadas.length) { log('Marque os marketplaces (na lista) para sincronizar o preco.', 'aviso'); return; }
    // remove ML/MercadoShops (gestao de anuncios a parte) do sync direto
    marcadas = marcadas.filter(function (mk) { return !/mercado\s*shops|^\s*mlivre\s*$|mercado\s*livre/i.test(mk); });
    if (!marcadas.length) { log('Os marketplaces marcados (ML/MercadoShops) nao entram no sync direto de preco.', 'aviso'); return; }

    ocupado = true;
    atualizarPill('\uD83D\uDD04 Sincronizando precos...');
    log('=== SINCRONIZAR PRECOS: ' + ids.length + ' SKU(s) x ' + marcadas.length + ' marketplace(s) ===');
    log('(empurra o preco JA salvo no Bling; nao reexporta imagens/atributos)');
    try {
      var lojas = await obterLojasSync();
      var okT = 0, erroT = 0;
      for (var i = 0; i < marcadas.length; i++) {
        var mk = marcadas[i];
        var loja = acharLojaSync(lojas, mk);
        if (!loja) { log('   [pular] ' + mk + ': loja nao encontrada', 'aviso'); continue; }
        try {
          var res = await sincronizarPrecoLoja(loja, ids);
          if (res.ok) { okT++; log('   [OK] ' + mk + ' - ' + ids.length + ' produto(s)' + (res.async ? ' (assincrono, confira a area de gestao)' : ''), 'ok'); }
          else { erroT++; log('   [ERRO] ' + mk + ': ' + (res.msg || 'falha'), 'erro'); }
        } catch (e) {
          erroT++; log('   [ERRO] ' + mk + ': ' + (e && e.message || e), 'erro');
        }
        await espera(400);
      }
      log('=== SINCRONIZACAO: ' + okT + ' loja(s) OK, ' + erroT + ' com erro ===', erroT ? 'aviso' : 'ok');
    } catch (e) {
      log('Falha na sincronizacao: ' + (e && e.message || e), 'erro');
    }
    ocupado = false;
    atualizarPill('\uD83D\uDE80 EXPORTA\u00c7\u00c3O SKUs');
  }

  // ---- Sincronizar precos pro marketplace (empurra preco ja salvo no Bling) ----
  // reusa listarLojasVirtuaisAtivas para obter idLoja+idIntegracao por marketplace
  var gradeLojasSync = null;

  async function obterLojasSync() {
    if (gradeLojasSync) return gradeLojasSync;
    var r = await fetch('https://www.bling.com.br/services/produtos.server.php?f=listarLojasVirtuaisAtivas', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: 'xajax=listarLojasVirtuaisAtivas&xajaxr=' + Date.now() +
        '&xajaxargs[]=' + encodeURIComponent('<xjxobj></xjxobj>') +
        '&xajaxargs[]=listaLojasAtivasGeneralPrice' +
        '&xajaxargs[]=' + encodeURIComponent('Selecione a plataforma')
    });
    var txt = await r.text();
    gradeLojasSync = {};

    // estrategia 1: array dentro de montarListaLojasAtivasAvancado([...])
    var arr = null;
    var m = txt.match(/montarListaLojasAtivasAvancado\((\[[\s\S]*?\])\s*,/);
    if (m) { try { arr = JSON.parse(m[1]); } catch (e) { arr = null; } }

    // estrategia 2: primeiro array JSON que contenha "idIntegracao"
    if (!arr) {
      var m2 = txt.match(/(\[\s*\{[\s\S]*?idIntegracao[\s\S]*?\}\s*\])/);
      if (m2) { try { arr = JSON.parse(m2[1]); } catch (e) { arr = null; } }
    }

    // estrategia 3: extrair cada objeto {..."idIntegracao"...} individualmente
    if (!arr) {
      arr = [];
      var rx = /\{[^{}]*?"idIntegracao"[^{}]*?\}/g, mm;
      while ((mm = rx.exec(txt)) !== null) {
        try { arr.push(JSON.parse(mm[0])); } catch (e) {}
      }
      if (!arr.length) arr = null;
    }

    if (arr && arr.length) {
      arr.forEach(function (l) {
        var chave = String(l.nomeLoja || '').trim().toLowerCase();
        if (chave) gradeLojasSync[chave] = { id: l.id, idIntegracao: l.idIntegracao, tipoIntegracao: l.tipoIntegracao, nomeLoja: l.nomeLoja };
      });
      log('   (lista de lojas lida: ' + Object.keys(gradeLojasSync).length + ' loja(s))');
    } else {
      // diagnostico: mostra o inicio da resposta para entender o formato
      var amostra = String(txt || '').replace(/\s+/g, ' ').slice(0, 200);
      log('   (aviso: nao encontrei a lista de lojas. Resposta comeca com: ' + amostra + ')', 'aviso');
    }
    return gradeLojasSync;
  }

  function acharLojaSync(lojas, nomeMk) {
    var chave = String(nomeMk || '').trim().toLowerCase();
    if (lojas[chave]) return lojas[chave];
    // match tolerante: primeira loja cujo nome contenha ou esteja contido
    var achado = null;
    Object.keys(lojas).forEach(function (k) {
      if (!achado && (k.indexOf(chave) !== -1 || chave.indexOf(k) !== -1)) achado = lojas[k];
    });
    return achado;
  }

  function xjxProdutos(ids) {
    var itens = ids.map(function (id, i) { return '<e><k>' + i + '</k><v>' + id + '</v></e>'; }).join('');
    return '<xjxobj>' + itens + '</xjxobj>';
  }

  async function sincronizarPrecoLoja(loja, idsProdutos) {
    var arg = '<xjxobj>' +
      '<e><k>idLoja</k><v>' + loja.id + '</v></e>' +
      '<e><k>idIntegracao</k><v>' + loja.idIntegracao + '</v></e>' +
      '<e><k>integrationType</k><v>' + loja.tipoIntegracao + '</v></e>' +
      '<e><k>formvalues</k><v>' + xjxProdutos(idsProdutos) + '</v></e>' +
      '</xjxobj>';
    var body = 'xajax=sincronizarPrecosEmMassa&xajaxr=' + Date.now() + '&xajaxargs[]=' + encodeURIComponent(arg);
    var r = await fetch('https://www.bling.com.br/services/produtos.server.php?f=sincronizarPrecosEmMassa', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: body
    });
    var txt = await r.text();
    // respostas: {"error":false,"isAsync":true,...} ok assincrono | [] ou "" ok | {"error":true,"msg":...} erro
    if (!txt || txt === '[]') return { ok: true, async: false };
    try {
      var j = JSON.parse(txt);
      if (j.error === false) return { ok: true, async: !!j.isAsync };
      if (j.error === true) return { ok: false, msg: (j.msg || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
    } catch (e) {}
    return { ok: true, async: false };
  }

  // sincroniza preco dos produtos alterados, por marketplace afetado
  async function sincronizarPrecosGrade(plano) {
    var lojas = await obterLojasSync();
    // agrupa: por marketplace -> lista de idProduto que tiveram preco tocado
    var porMk = {};
    plano.forEach(function (p) {
      p.itens.forEach(function (it) {
        if (!porMk[it.mk]) porMk[it.mk] = {};
        porMk[it.mk][p.idp] = true;
      });
    });
    log('--- Sincronizando precos para os marketplaces ---');
    var okT = 0, erroT = 0;
    for (var mk in porMk) {
      if (!porMk.hasOwnProperty(mk)) continue;
      var loja = acharLojaSync(lojas, mk);
      if (!loja) { log('   [pular] ' + mk + ': loja nao encontrada para sincronizar', 'aviso'); continue; }
      var ids = Object.keys(porMk[mk]);
      try {
        var res = await sincronizarPrecoLoja(loja, ids);
        if (res.ok) { okT++; log('   [OK] ' + mk + ' - ' + ids.length + ' produto(s)' + (res.async ? ' (assincrono, confira a area de gestao do Bling)' : ''), 'ok'); }
        else { erroT++; log('   [ERRO] ' + mk + ': ' + (res.msg || 'falha'), 'erro'); }
      } catch (e) {
        erroT++; log('   [ERRO] ' + mk + ': ' + (e && e.message || e), 'erro');
      }
      await espera(400);
    }
    log('--- Sincronizacao de precos: ' + okT + ' loja(s) OK, ' + erroT + ' com erro ---', erroT ? 'aviso' : 'ok');
  }

  // ---- Salvar alteracoes da grade via robo (reusa o preenchimento do painel) ----
  async function salvarGrade(modo) {
    // monta plano so com o que mudou
    var idLojaPorMk = {};
    (cacheLojas || []).forEach(function (l) { idLojaPorMk[l.texto] = String(l.valor || '').split(';')[0]; });

    var porProduto = {}; var ordem = [];
    var below = 0; var novoSemPreco = 0;
    gradeDados.forEach(function (row) {
      GRADE_MK.forEach(function (mk) {
        var c = row.p[mk];
        if (!c) return;
        var ehNovo = (!c.vinc && c.ativar);
        var ehEdicao = (c.vinc && (c.alterado || c.catAlterada));
        if (!ehNovo && !ehEdicao) return;
        if (ehNovo && (c.preco == null)) { novoSemPreco++; return; }
        if (c.preco == null) return;
        var precoVenda = (c.promo != null) ? c.promo : c.preco;
        if (classeMargem(row.custo, precoVenda) === 'below') { below++; return; }
        if (!porProduto[row.idp]) { porProduto[row.idp] = { idp: row.idp, sku: row.sku, nome: row.nome, itens: [] }; ordem.push(row.idp); }
        var catId = '';
        if (c.cat) {
          var lista = gradeCats[mk] || [];
          for (var i = 0; i < lista.length; i++) { if (lista[i].nome === c.cat) { catId = lista[i].id; break; } }
        }
        porProduto[row.idp].itens.push({
          mk: mk, idLoja: idLojaPorMk[mk], preco: c.preco, promo: c.promo != null ? c.promo : c.preco,
          catNome: c.cat || '', catId: catId, atualizacao: !ehNovo
        });
      });
    });

    if (novoSemPreco > 0) { gradeAviso(novoSemPreco + ' v\u00ednculo(s) novo(s) sem pre\u00e7o - preencha o pre\u00e7o para ativar.'); return; }
    if (below > 0) { gradeAviso(below + ' altera\u00e7\u00e3o(oes) abaixo do piso custo+10% - corrija antes de salvar.'); return; }
    var plano = ordem.map(function (id) { return porProduto[id]; });
    var totalItens = 0; plano.forEach(function (p) { totalItens += p.itens.length; });
    if (!totalItens) { gradeAviso('Nada alterado para salvar.'); return; }

    modo = modo || 'salvar';
    // guarda os ids afetados para exportar depois, se preciso
    var idsAfetados = plano.map(function (p) { return p.idp; });

    if (gradeOverlay) { gradeOverlay.remove(); gradeOverlay = null; }
    if (typeof abrirPainel === 'function') abrirPainel();
    log('=== SALVANDO ALTERACOES DA GRADE (' + totalItens + ' item(ns) em ' + plano.length + ' produto(s)) ===');
    await rodarRoboPreenchimento(plano);
    log('Precos/categorias gravados no Bling.', 'ok');

    if (modo === 'sincronizar') {
      await sincronizarPrecosGrade(plano);
    } else if (modo === 'exportar') {
      log('--- Exportando SKUs completos para os marketplaces ---');
      log('Selecione os SKUs na listagem e use "EXPORTAR MARKETPLACES" para reexportar tudo (imagens, atributos, estoque).', 'aviso');
      // exportacao completa reusa o fluxo da esteira; disparamos aviso pois exige selecao na listagem
    }
    log('=== FIM: alteracoes da grade aplicadas. Reabra a grade para conferir. ===', 'ok');
  }

  function iniciar() {
    montarInterface();
    chrome.storage.local.get(['esteira_lojas_cache'], function (r) {
      cacheLojas = r.esteira_lojas_cache || [];
      renderizarLista();
      if (!cacheLojas.length) {
        log('Primeira vez: selecione 1 SKU e clique em "Ler marketplaces do Bling".', 'aviso');
      } else {
        log('Pronto. ' + VERSAO);
      }
    });
  }

  /* Toolbox 2.0: a Esteira e ferramenta da GIRASSOL — noutra instancia o script nao acorda
     (nem botao flutuante, nem listeners). Codigo original da bling-esteira-recorder v0.24.2,
     byte a byte acima desta linha; o gate e o unico acrescimo. */
  function _bootEsteira() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(iniciar, 1200); });
    } else {
      setTimeout(iniciar, 1200);
    }
  }
  try {
    chrome.storage.local.get(['tb_empresa'], function (v) {
      if (!v || v.tb_empresa === 'girassol' || !v.tb_empresa) _bootEsteira();   // sem escolha ainda: comporta como sempre
    });
  } catch (e) { _bootEsteira(); }
})();
