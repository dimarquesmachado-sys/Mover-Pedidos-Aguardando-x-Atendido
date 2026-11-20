/* ─────────────────────────────────────────────────────────────────────────────
   PLANILHA .XLSX COM A FOTO DO PRODUTO EM CADA LINHA (20/11/2026 — pedido do dono, pro Plano de Compra):
   "podia deixar a planilha igual é hoje, mas adicionar uma imagemzinha, algo de 300x300px em cada linha, facilitando pra
   visualizar o produto. colocar entre B e C coluna a imagem."

   E o aviso que o Excel dava em toda abertura ("O formato de arquivo e a extensão de 'plano-de-compra-….xls' não
   correspondem"): a planilha antiga era um XML salvo com nome .xls. XML de planilha não carrega imagem; quem carrega é o
   .xlsx de verdade — que é o que esta peça escreve, e que abre sem aviso.

   Roda no NAVEGADOR (é servida junto com o script do Plano de Compra) e também carrega no Node, pros testes. Sem
   biblioteca: um .xlsx é um zip de XMLs; aqui o zip sai sem compressão (as fotos já são JPEG).

     montar({ cab, linhas, colFoto, fotos, lado })  → Uint8Array com o .xlsx
        cab      — os títulos das colunas, JÁ com a coluna da foto no lugar;
        linhas   — as linhas (mesma largura do cab); número vai como número, o resto como texto (texto nunca vira
                   fórmula); a célula da coluna da foto fica vazia — a imagem vai por cima;
        colFoto  — o índice (0 = A) da coluna da foto;
        fotos    — por linha: { bytes: Uint8Array (JPEG), w, h } ou null (linha sem foto — fica sem, não quebra);
        lado     — o lado do quadrado da foto, em pixels (padrão 300).
     baixarFotos(enderecos, opcoes) → Promise<fotos[]>   busca e encolhe cada foto pra caber no quadrado; foto que não
                   veio vira null. Poucas por vez. `opcoes.aoAvancar(feitas, total)` pra mostrar o andamento.
     salvar(bytes, nome)            → entrega o arquivo pro navegador baixar.
   ───────────────────────────────────────────────────────────────────────────── */
/* global window, document, fetch, createImageBitmap, URL, Blob, TextEncoder, unescape */
(function (raiz) {
  'use strict';

  /* ── texto → bytes UTF-8 ── */
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    var b = unescape(encodeURIComponent(String(s))), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  /* o que não pode ir num XML: os três de sempre, aspas, e os caracteres de controle que o XML 1.0 proíbe */
  function xe(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  }
  /* 0 → A, 25 → Z, 26 → AA */
  function letra(n) { var s = ''; n = Number(n) + 1; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

  /* ── zip sem compressão ── */
  var _tab = null;
  function crc32(u) {
    if (!_tab) { _tab = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _tab[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u.length; i++) crc = _tab[(crc ^ u[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(arquivos) {   /* [{ nome, bytes }] → Uint8Array */
    var partes = [], central = [], pos = 0;
    var le16 = function (a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); };
    var le32 = function (a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); };
    arquivos.forEach(function (f) {
      var nome = utf8(f.nome), dados = f.bytes, crc = crc32(dados);
      var cab = []; le32(cab, 0x04034b50); le16(cab, 20); le16(cab, 0x0800); le16(cab, 0); le16(cab, 0); le16(cab, 0x21);
      le32(cab, crc); le32(cab, dados.length); le32(cab, dados.length); le16(cab, nome.length); le16(cab, 0);
      var c = []; le32(c, 0x02014b50); le16(c, 20); le16(c, 20); le16(c, 0x0800); le16(c, 0); le16(c, 0); le16(c, 0x21);
      le32(c, crc); le32(c, dados.length); le32(c, dados.length); le16(c, nome.length); le16(c, 0); le16(c, 0); le16(c, 0); le16(c, 0); le32(c, 0); le32(c, pos);
      partes.push(new Uint8Array(cab), nome, dados);
      central.push(new Uint8Array(c), nome);
      pos += cab.length + nome.length + dados.length;
    });
    var tamCentral = central.reduce(function (t, p) { return t + p.length; }, 0);
    var fim = []; le32(fim, 0x06054b50); le16(fim, 0); le16(fim, 0); le16(fim, arquivos.length); le16(fim, arquivos.length); le32(fim, tamCentral); le32(fim, pos); le16(fim, 0);
    var tudo = partes.concat(central, [new Uint8Array(fim)]);
    var saida = new Uint8Array(tudo.reduce(function (t, p) { return t + p.length; }, 0)), o = 0;
    tudo.forEach(function (p) { saida.set(p, o); o += p.length; });
    return saida;
  }

  var EMU = 9525;   /* unidades do desenho do Excel por pixel */
  var CABX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function montar(op) {
    var cab = (op && op.cab) || [], linhas = (op && op.linhas) || [], fotos = (op && op.fotos) || [];
    var colFoto = Number(op && op.colFoto), temColFoto = Number.isInteger(colFoto) && colFoto >= 0 && colFoto < cab.length;
    var lado = Number(op && op.lado) > 0 ? Math.round(Number(op.lado)) : 300;
    /* só entra foto que é foto: bytes de verdade e tamanho que caiba no quadrado */
    var comFoto = [];
    if (temColFoto) linhas.forEach(function (l, i) {
      var f = fotos[i];
      if (f && f.bytes && f.bytes.length > 0 && Number(f.w) > 0 && Number(f.h) > 0) comFoto.push({ linha: i, bytes: f.bytes, w: Math.min(lado, Math.round(f.w)), h: Math.min(lado, Math.round(f.h)) });
    });
    var temFotos = comFoto.length > 0;

    /* larguras: a da foto é o quadrado; as outras, pelo texto mais comprido (com teto) */
    var cols = cab.map(function (c, k) {
      var w;
      if (temColFoto && k === colFoto) w = temFotos ? (lado + 8) / 7 : 10;
      else { var m = String(c).length; linhas.forEach(function (l) { var t = String(l[k] == null ? '' : l[k]); if (t.length > m) m = t.length; }); w = Math.min(60, Math.max(9, m + 2)); }
      return '<col min="' + (k + 1) + '" max="' + (k + 1) + '" width="' + (Math.round(w * 100) / 100) + '" customWidth="1"/>';
    }).join('');
    /* 20/11 (o dono, depois de abrir a 1ª planilha com fotos): "deixa os textos da planilha com quebrar texto
       automaticamente" e "em bordas, coloca TODAS AS BORDAS pras células trazidas que tenham algum resultado".
       Estilos: 1 = título (com borda), 2 = célula VAZIA (sem borda), 3 = célula COM conteúdo (todas as bordas). Os três
       quebram o texto. A célula da foto conta como "com conteúdo" quando a linha tem foto. */
    var linhaTemFoto = {}; comFoto.forEach(function (f) { linhaTemFoto[f.linha] = true; });
    var celula = function (v, col, lin, titulo) {
      var r = letra(col) + lin;
      if (temColFoto && col === colFoto && lin > 1) return '<c r="' + r + '" s="' + (linhaTemFoto[lin - 2] ? 3 : 2) + '"/>';
      if (typeof v === 'number' && isFinite(v)) return '<c r="' + r + '" s="' + (titulo ? 1 : 3) + '"><v>' + v + '</v></c>';
      if (v == null || v === '') return '<c r="' + r + '" s="' + (titulo ? 1 : 2) + '"/>';
      return '<c r="' + r + '" s="' + (titulo ? 1 : 3) + '" t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
    };
    var alturaPt = Math.round((lado + 8) * 0.75 * 100) / 100;   /* a linha na altura da foto (pixel → ponto) */
    var dados = '<row r="1" ht="24" customHeight="1">' + cab.map(function (c, k) { return celula(String(c), k, 1, true); }).join('') + '</row>' +
      linhas.map(function (l, i) {
        return '<row r="' + (i + 2) + '"' + (temFotos ? ' ht="' + alturaPt + '" customHeight="1"' : '') + '>' + cab.map(function (_, k) { return celula(l[k], k, i + 2, false); }).join('') + '</row>';
      }).join('');
    var folha = CABX + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/><cols>' + cols + '</cols><sheetData>' + dados + '</sheetData>' +
      (temFotos ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';

    var estilos = CABX + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    var arqs = [];
    var poe = function (nome, texto) { arqs.push({ nome: nome, bytes: utf8(texto) }); };
    poe('[Content_Types].xml', CABX + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      (temFotos ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      (temFotos ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') + '</Types>');
    poe('_rels/.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    poe('xl/workbook.xml', CABX + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>');
    poe('xl/_rels/workbook.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    poe('xl/styles.xml', estilos);
    poe('xl/worksheets/sheet1.xml', folha);
    if (temFotos) {
      poe('xl/worksheets/_rels/sheet1.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
      /* cada foto presa à célula da linha dela, centrada no quadrado */
      poe('xl/drawings/drawing1.xml', CABX + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        comFoto.map(function (f, n) {
          var dx = Math.round((lado + 8 - f.w) / 2) * EMU, dy = Math.round((lado + 8 - f.h) / 2) * EMU;
          /* 20/11 (o dono): "colocar na célula as imagens... assim consigo editar as linhas aumentando mais ou menos sem
             que as imagens percam sua referência com a linha do produto". A foto fica presa aos DOIS cantos da célula dela
             ("mover e dimensionar com as células"): acompanha a linha ao inserir, apagar, ordenar e filtrar, e muda de
             tamanho junto quando a linha ou a coluna muda. */
          return '<xdr:twoCellAnchor editAs="twoCell"><xdr:from><xdr:col>' + colFoto + '</xdr:col><xdr:colOff>' + dx + '</xdr:colOff><xdr:row>' + (f.linha + 1) + '</xdr:row><xdr:rowOff>' + dy + '</xdr:rowOff></xdr:from>' +
            '<xdr:to><xdr:col>' + colFoto + '</xdr:col><xdr:colOff>' + (dx + f.w * EMU) + '</xdr:colOff><xdr:row>' + (f.linha + 1) + '</xdr:row><xdr:rowOff>' + (dy + f.h * EMU) + '</xdr:rowOff></xdr:to>' +
            '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (n + 2) + '" name="Foto ' + (n + 1) + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
            '<xdr:blipFill><a:blip r:embed="rId' + (n + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
            '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + (f.w * EMU) + '" cy="' + (f.h * EMU) + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>';
        }).join('') + '</xdr:wsDr>');
      poe('xl/drawings/_rels/drawing1.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        comFoto.map(function (f, n) { return '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image' + (n + 1) + '.jpeg"/>'; }).join('') + '</Relationships>');
      comFoto.forEach(function (f, n) { arqs.push({ nome: 'xl/media/image' + (n + 1) + '.jpeg', bytes: f.bytes }); });
    }
    return zip(arqs);
  }

  /* ── no navegador: encolher uma foto pra caber no quadrado, em JPEG com fundo branco ── */
  function encolherNoNavegador(blob, lado) {
    return createImageBitmap(blob).then(function (bmp) {
      var esc = Math.min(1, lado / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * esc)), h = Math.max(1, Math.round(bmp.height * esc));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var cx = cv.getContext('2d'); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h); cx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return new Promise(function (ok, erro) {
        cv.toBlob(function (b) { if (!b) return erro(new Error('não consegui converter a foto')); b.arrayBuffer().then(function (ab) { ok({ bytes: new Uint8Array(ab), w: w, h: h }); }, erro); }, 'image/jpeg', 0.85);
      });
    });
  }

  /* busca e encolhe as fotos, poucas por vez. Endereço vazio e foto que falhou viram null — a planilha sai mesmo assim. */
  function baixarFotos(enderecos, op) {
    op = op || {};
    var lado = Number(op.lado) > 0 ? Number(op.lado) : 300;
    var buscar = op.fetch || function (u) { return fetch(u, { credentials: 'same-origin' }); };
    var encolher = op.encolher || encolherNoNavegador;
    var juntas = Math.max(1, Math.min(8, Number(op.simultaneas) || 4));
    var saida = enderecos.map(function () { return null; }), prox = 0, feitas = 0;
    var avisa = function () { feitas++; if (op.aoAvancar) { try { op.aoAvancar(feitas, enderecos.length); } catch (e) {} } };
    /* Codex #959: as linhas SEM foto são puladas num laço, não chamando `uma()` de novo — um plano com milhares de produtos
       sem imagem em sequência estourava a pilha ("Maximum call stack size exceeded") antes de a promessa existir, e a
       planilha não saía (nem a antiga). Só a espera de uma foto de verdade encadeia a próxima, e isso não empilha. */
    function uma() {
      while (prox < enderecos.length) {
        var i = prox++, u = enderecos[i];
        if (!u) { avisa(); continue; }
        return buscaUma(i, u).then(uma);
      }
      return Promise.resolve();
    }
    function buscaUma(i, u) {
      return Promise.resolve().then(function () { return buscar(u); })
        .then(function (r) { if (!r || !r.ok) throw new Error('foto não veio'); return r.blob(); })
        .then(function (b) { return encolher(b, lado); })
        .then(function (f) { saida[i] = (f && f.bytes && f.bytes.length && f.w > 0 && f.h > 0) ? f : null; }, function () { saida[i] = null; })
        .then(function () { avisa(); });
    }
    var filas = []; for (var k = 0; k < juntas; k++) filas.push(uma());
    return Promise.all(filas).then(function () { return saida; });
  }

  function salvar(bytes, nome) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    var a = document.createElement('a'); a.href = url; a.download = nome; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var api = { montar: montar, baixarFotos: baixarFotos, salvar: salvar, zip: zip, crc32: crc32, letra: letra, xe: xe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.PlanilhaXlsxFotos = api;
})(typeof window !== 'undefined' ? window : this);
