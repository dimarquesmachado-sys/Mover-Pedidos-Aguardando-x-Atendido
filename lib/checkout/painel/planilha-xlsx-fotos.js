/* ─────────────────────────────────────────────────────────────────────────────
   PLANILHA .XLSX COM A FOTO DO PRODUTO EM CADA LINHA (20/11/2026 — pedido do dono, pro Plano de Compra):
   "podia deixar a planilha igual é hoje, mas adicionar uma imagemzinha, algo de 300x300px em cada linha, facilitando pra
   visualizar o produto. colocar entre B e C coluna a imagem."

   E o aviso que o Excel dava em toda abertura ("O formato de arquivo e a extensão de 'plano-de-compra-….xls' não
   correspondem"): a planilha antiga era um XML salvo com nome .xls. XML de planilha não carrega imagem; quem carrega é o
   .xlsx de verdade — que é o que esta peça escreve, e que abre sem aviso.

   Roda no NAVEGADOR (é servida junto com o script do Plano de Compra) e também carrega no Node, pros testes. Sem
   biblioteca: um .xlsx é um zip de XMLs; aqui o zip sai sem compressão (as fotos já são JPEG).

     montar({ cab, linhas, colFoto, fotos, lado, larguras, alturaTitulo, alturaLinha, moeda, link, destaque, semaforo })
        → Uint8Array com o .xlsx
        cab      — os títulos das colunas, JÁ com a coluna da foto no lugar;
        linhas   — as linhas (mesma largura do cab); número vai como número, o resto como texto (texto nunca vira
                   fórmula); na coluna da foto, a linha COM foto leva a imagem e a SEM foto leva o que a linha trouxer;
        colFoto  — o índice (0 = A) da coluna da foto;
        fotos    — por linha: { bytes: Uint8Array (JPEG), w, h } ou null (linha sem foto — fica sem, não quebra);
        lado     — o lado do quadrado da foto, em pixels (padrão 300): dá a largura da coluna e a altura da linha quando
                   quem chama não informa as suas;
        larguras — por coluna, a largura (na unidade do Excel); sem ela, a coluna se ajusta ao texto;
        alturaTitulo, alturaLinha — em pontos;
        moeda, link, destaque, semaforo — listas de índices de coluna: valor em R$; endereço clicável; coluna em
                   negrito com fundo; número em negrito, vermelho se zero ou menos e verde se acima de zero.
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

  var CABX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var MAX_LINKS = 65000;   /* o Excel aceita pouco mais que isso de endereços clicáveis por planilha */
  /* endereço que pode virar link: http(s), sem espaço, e dentro do tamanho que o Excel aceita */
  function enderecoDeLink(v) { var t = String(v == null ? '' : v); return (/^https?:\/\/[^\s<>"]+$/i.test(t) && t.length <= 2000) ? t : ''; }
  function indices(lista, n) { var m = {}; (Array.isArray(lista) ? lista : []).forEach(function (k) { if (Number.isInteger(k) && k >= 0 && k < n) m[k] = true; }); return m; }

  /* 20/11 — O MODELO DO DONO. Ele abriu a planilha, arrumou as primeiras linhas "pra ficar no melhor jeito" e pediu:
     "tenta deixar igual... pra qdo baixar, já vir igualzinho assim pra todos produtos e lojas". O que o arquivo dele tem,
     e que esta peça passou a escrever:
       · a FOTO DENTRO DA CÉLULA ("colocar na célula" do Excel — a imagem é o valor da célula): acompanha a linha em
         qualquer edição e se ajusta sozinha quando a linha ou a coluna muda de tamanho. É o que ele tinha pedido antes
         ("colocar na célula as imagens... sem que percam sua referência com a linha do produto"). As partes do arquivo
         (metadata, richData) seguem as que o próprio Excel dele gravou;
       · tudo centralizado (na horizontal e na vertical), com quebra de texto e borda fina;
       · o endereço da imagem clicável; valores em R$; a coluna COMPRAR em negrito com fundo; o "Saldo hoje" em negrito,
         vermelho quando zero e verde quando tem saldo; título mais alto; larguras e alturas dele.
     Estilos (cellXfs): 1 título · 2 vazia (sem borda) · 3 com conteúdo · 4 link · 5 moeda · 6 destaque · 7 semáforo sem
     cor (o valor não é número) · 8 semáforo vermelho · 9 semáforo verde. */
  function montar(op) {
    var cab = (op && op.cab) || [], linhas = (op && op.linhas) || [], fotos = (op && op.fotos) || [];
    var colFoto = Number(op && op.colFoto), temColFoto = Number.isInteger(colFoto) && colFoto >= 0 && colFoto < cab.length;
    var lado = Number(op && op.lado) > 0 ? Math.round(Number(op.lado)) : 300;
    var pos = function (v) { return Number(v) > 0 && isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0; };
    var larguras = Array.isArray(op && op.larguras) ? op.larguras : [];
    var eMoeda = indices(op && op.moeda, cab.length), eLink = indices(op && op.link, cab.length), eDestaque = indices(op && op.destaque, cab.length), eSemaforo = indices(op && op.semaforo, cab.length);
    /* só entra foto que é foto: bytes de verdade e medidas de verdade */
    var comFoto = [], fotoDaLinha = {};
    if (temColFoto) linhas.forEach(function (l, i) {
      var f = fotos[i];
      if (f && f.bytes && f.bytes.length > 0 && Number(f.w) > 0 && Number(f.h) > 0) { fotoDaLinha[i] = comFoto.length; comFoto.push({ linha: i, bytes: f.bytes }); }
    });
    var temFotos = comFoto.length > 0;

    /* larguras: a que veio; senão, a da foto é o quadrado e as outras vão pelo texto mais comprido (com teto) */
    var cols = cab.map(function (c, k) {
      var w = pos(larguras[k]);
      if (!w) {
        if (temColFoto && k === colFoto) w = temFotos ? (lado + 8) / 7 : 10;
        else { var m = String(c).length; linhas.forEach(function (l) { var t = String(l[k] == null ? '' : l[k]); if (t.length > m) m = t.length; }); w = Math.min(60, Math.max(9, m + 2)); }
      }
      return '<col min="' + (k + 1) + '" max="' + (k + 1) + '" width="' + (Math.round(w * 100) / 100) + '" customWidth="1"/>';
    }).join('');
    var links = [];   /* { ref, url } */
    var celula = function (v, col, lin, titulo) {
      var r = letra(col) + lin;
      /* a foto É o valor da célula: o Excel lê o "valor rico" nº vm (contado a partir de 1) e desenha a imagem dentro
         da célula. O "#VALUE!" é o que o próprio Excel grava ali — só aparece em programa que não conhece imagem em célula */
      if (!titulo && temColFoto && col === colFoto && fotoDaLinha[lin - 2] != null) return '<c r="' + r + '" s="3" t="e" vm="' + (fotoDaLinha[lin - 2] + 1) + '"><v>#VALUE!</v></c>';
      var num = typeof v === 'number' && isFinite(v);
      if (!num && (v == null || v === '')) return '<c r="' + r + '" s="' + (titulo ? 1 : 2) + '"/>';
      var s = 3;
      if (titulo) s = 1;
      else if (eSemaforo[col]) s = num ? (v > 0 ? 9 : 8) : 7;
      else if (eDestaque[col]) s = 6;
      else if (eMoeda[col] && num) s = 5;
      else if (eLink[col] && !num && enderecoDeLink(v) && links.length < MAX_LINKS) { s = 4; links.push({ ref: r, url: enderecoDeLink(v) }); }
      if (num) return '<c r="' + r + '" s="' + s + '"><v>' + v + '</v></c>';
      return '<c r="' + r + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
    };
    var altTitulo = pos(op && op.alturaTitulo) || 24;
    var altLinha = pos(op && op.alturaLinha) || (temFotos ? Math.round((lado + 8) * 0.75 * 100) / 100 : 0);   /* sem a de quem chama: a altura da foto (pixel → ponto) */
    var dados = '<row r="1" ht="' + altTitulo + '" customHeight="1">' + cab.map(function (c, k) { return celula(String(c), k, 1, true); }).join('') + '</row>' +
      linhas.map(function (l, i) {
        return '<row r="' + (i + 2) + '"' + (altLinha ? ' ht="' + altLinha + '" customHeight="1"' : '') + '>' + cab.map(function (_, k) { return celula(l[k], k, i + 2, false); }).join('') + '</row>';
      }).join('');
    var folha = CABX + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL + '">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/><cols>' + cols + '</cols><sheetData>' + dados + '</sheetData>' +
      (links.length ? '<hyperlinks>' + links.map(function (k, n) { return '<hyperlink ref="' + k.ref + '" r:id="rId' + (n + 1) + '"/>'; }).join('') + '</hyperlinks>' : '') + '</worksheet>';

    var borda = '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>';
    var centro = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
    var xf = function (fmt, fonte, fundo, comBorda, alinhamento) {
      return '<xf numFmtId="' + fmt + '" fontId="' + fonte + '" fillId="' + fundo + '" borderId="' + (comBorda ? 1 : 0) + '" xfId="0"' + (fmt ? ' applyNumberFormat="1"' : '') + (fonte ? ' applyFont="1"' : '') + (fundo ? ' applyFill="1"' : '') + (comBorda ? ' applyBorder="1"' : '') + ' applyAlignment="1">' + alinhamento + '</xf>';
    };
    var estilos = CABX + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00;\\-&quot;R$&quot;\\ #,##0.00"/></numFmts>' +
      '<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/></font>' +
        '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF00B050"/><name val="Calibri"/></font></fonts>' +
      '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4E5"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + borda + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        xf(0, 1, 2, true, centro) + xf(0, 0, 0, false, centro) + xf(0, 0, 0, true, centro) +
        xf(0, 2, 0, true, '<alignment horizontal="center" vertical="center"/>') +   /* o link não quebra: no modelo a coluna é estreita e o endereço fica numa linha só */
        xf(164, 0, 0, true, centro) + xf(0, 3, 3, true, centro) + xf(0, 3, 0, true, centro) + xf(0, 4, 0, true, centro) + xf(0, 5, 0, true, centro) + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    var RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
    var arqs = [];
    var poe = function (nome, texto) { arqs.push({ nome: nome, bytes: utf8(texto) }); };
    poe('[Content_Types].xml', CABX + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      (temFotos ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      (temFotos ? '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>' +
        '<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/>' +
        '<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>' +
        '<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>' +
        '<Override PartName="/xl/richData/rdRichValueTypes.xml" ContentType="application/vnd.ms-excel.rdrichvaluetypes+xml"/>' : '') + '</Types>');
    poe('_rels/.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    poe('xl/workbook.xml', CABX + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL + '"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>');
    poe('xl/_rels/workbook.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + REL + '/styles" Target="styles.xml"/>' +
      (temFotos ? '<Relationship Id="rId3" Type="' + REL + '/sheetMetadata" Target="metadata.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2022/10/relationships/richValueRel" Target="richData/richValueRel.xml"/>' +
        '<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue" Target="richData/rdrichvalue.xml"/>' +
        '<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure" Target="richData/rdrichvaluestructure.xml"/>' +
        '<Relationship Id="rId7" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueTypes" Target="richData/rdRichValueTypes.xml"/>' : '') + '</Relationships>');
    poe('xl/styles.xml', estilos);
    poe('xl/worksheets/sheet1.xml', folha);
    if (links.length) poe('xl/worksheets/_rels/sheet1.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links.map(function (k, n) { return '<Relationship Id="rId' + (n + 1) + '" Type="' + REL + '/hyperlink" Target="' + xe(k.url) + '" TargetMode="External"/>'; }).join('') + '</Relationships>');
    if (temFotos) {
      /* a imagem em célula, parte por parte como o Excel grava: a célula aponta (vm) pra um registro do metadata, que
         aponta pro "valor rico" de mesmo número, que aponta pra imagem de mesmo número. Tudo na ordem das fotos. */
      var cada = function (f) { return comFoto.map(f).join(''); };
      poe('xl/metadata.xml', CABX + '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="' + RD + '">' +
        '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>' +
        '<futureMetadata name="XLRICHVALUE" count="' + comFoto.length + '">' + cada(function (f, n) { return '<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="' + n + '"/></ext></extLst></bk>'; }) + '</futureMetadata>' +
        '<valueMetadata count="' + comFoto.length + '">' + cada(function (f, n) { return '<bk><rc t="1" v="' + n + '"/></bk>'; }) + '</valueMetadata></metadata>');
      poe('xl/richData/rdrichvalue.xml', CABX + '<rvData xmlns="' + RD + '" count="' + comFoto.length + '">' + cada(function (f, n) { return '<rv s="0"><v>' + n + '</v><v>5</v></rv>'; }) + '</rvData>');
      poe('xl/richData/rdrichvaluestructure.xml', CABX + '<rvStructures xmlns="' + RD + '" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>');
      poe('xl/richData/rdRichValueTypes.xml', CABX + '<rvTypesInfo xmlns="' + RD + '2" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><global><keyFlags>' +
        '<key name="_Self"><flag name="ExcludeFromFile" value="1"/><flag name="ExcludeFromCalcComparison" value="1"/></key>' +
        ['_DisplayString', '_Flags', '_Format', '_SubLabel', '_Attribution', '_Icon', '_Display', '_CanonicalPropertyNames', '_ClassificationId'].map(function (k) { return '<key name="' + k + '"><flag name="ExcludeFromCalcComparison" value="1"/></key>'; }).join('') +
        '</keyFlags></global></rvTypesInfo>');
      poe('xl/richData/richValueRel.xml', CABX + '<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="' + REL + '">' + cada(function (f, n) { return '<rel r:id="rId' + (n + 1) + '"/>'; }) + '</richValueRels>');
      poe('xl/richData/_rels/richValueRel.xml.rels', CABX + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        cada(function (f, n) { return '<Relationship Id="rId' + (n + 1) + '" Type="' + REL + '/image" Target="../media/image' + (n + 1) + '.jpeg"/>'; }) + '</Relationships>');
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

  var api = { montar: montar, baixarFotos: baixarFotos, salvar: salvar, zip: zip, crc32: crc32, letra: letra, xe: xe, enderecoDeLink: enderecoDeLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.PlanilhaXlsxFotos = api;
})(typeof window !== 'undefined' ? window : this);
