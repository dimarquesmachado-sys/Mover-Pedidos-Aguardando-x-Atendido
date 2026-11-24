'use strict';
/* 20/11 — PLANO DE COMPRA: A PLANILHA COM A FOTO DO PRODUTO EM CADA LINHA (pedido do dono):
   "podia deixar a planilha igual é hoje, mas adicionar uma imagemzinha, algo de 300x300px em cada linha... colocar entre
   B e C coluna a imagem". E o aviso do Excel em toda abertura ("o formato de arquivo e a extensão... não correspondem"):
   a planilha era um XML com nome .xls; agora é .xlsx de verdade.

   O que se prova (o código de produção):
   A. a peça que escreve o .xlsx (lib/checkout/painel/planilha-xlsx-fotos): o arquivo é um zip íntegro com as partes que o
      Excel exige; número é número e texto é texto (nunca fórmula); a foto de cada linha fica DENTRO da célula DA LINHA
      DELA, na coluna pedida; linha sem foto não quebra nem desloca as outras; e o modelo do dono (centralizado, link
      clicável, R$, destaque, saldo em vermelho/verde, larguras e alturas dele);
   B. a busca das fotos: poucas por vez, na ordem, e foto que falha vira "sem foto" — não derruba a planilha;
   C. a rota que serve a foto (lib/checkout/rota-plano-foto): só admin, só pelo SKU, e só busca endereço https de máquina
      de verdade (nada de IP, localhost, nome interno — nem por redirecionamento), só imagem, com teto de tamanho;
   D. o botão "baixar planilha", com o script de produção num navegador de mentira: 15 colunas (as 14 de sempre + a Foto
      na C), arquivo .xlsx, e se a planilha com fotos falhar sai a antiga — nunca fica sem planilha;
   E. a fábrica entrega as duas peças no mesmo script, nas três empresas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const raiz = path.join(__dirname, '..');
const X = require('../lib/checkout/painel/planilha-xlsx-fotos');

const jpeg = (n) => { const b = new Uint8Array(40 + n); b[0] = 0xFF; b[1] = 0xD8; for (let i = 2; i < b.length; i++) b[i] = (i * 7 + n) & 0xFF; return b; };
const CAB = ['SKU', 'Produto', 'Foto', 'Imagem (URL)', 'Curva', 'Vendidas', 'Media'];
const LINHAS = [['KP5', 'Kit & <b>"aspas"</b>', '', 'https://x/a.jpg', 'A', 120, 1.33], ['=CMD()', 'parece fórmula\u0001', '', '', 'B', 40, ''], ['G12', 'Globo', '', 'https://x/c.jpg', 'A', 0, 0.9], ['SEM', null, '', '', 'C', -3, 2e-7]];

(async () => {
  /* ═══ A. o .xlsx ═══ */
  {
    const fotos = [{ bytes: jpeg(1), w: 300, h: 300 }, null, { bytes: jpeg(3), w: 140, h: 300 }, null];
    const bytes = X.montar({ cab: CAB, linhas: LINHAS, colFoto: 2, fotos, lado: 300 });
    assert.ok(bytes instanceof Uint8Array && bytes[0] === 0x50 && bytes[1] === 0x4B, 'não é um zip');
    const z = new AdmZip(Buffer.from(bytes));
    const nomes = z.getEntries().map((e) => e.entryName);
    const BASE6 = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'];
    const DA_FOTO = ['xl/metadata.xml', 'xl/richData/rdrichvalue.xml', 'xl/richData/rdrichvaluestructure.xml', 'xl/richData/rdRichValueTypes.xml', 'xl/richData/richValueRel.xml', 'xl/richData/_rels/richValueRel.xml.rels'];
    assert.deepStrictEqual(nomes, BASE6.concat(DA_FOTO, ['xl/media/image1.jpeg', 'xl/media/image2.jpeg']), 'as partes do .xlsx: ' + nomes.join(', '));
    const le = (n) => z.readAsText(n);   /* o adm-zip confere o CRC de cada parte ao ler */
    for (const n of nomes) assert.ok(z.getEntry(n).getData().length > 0, n + ' vazio ou com CRC errado');
    assert.deepStrictEqual([Buffer.compare(z.getEntry('xl/media/image1.jpeg').getData(), Buffer.from(jpeg(1))), Buffer.compare(z.getEntry('xl/media/image2.jpeg').getData(), Buffer.from(jpeg(3)))], [0, 0], 'os bytes da foto têm que chegar inteiros');
    const tipos = le('[Content_Types].xml');
    assert.ok(/Extension="jpeg" ContentType="image\/jpeg"/.test(tipos) && /spreadsheetml\.sheet\.main\+xml/.test(tipos) && /\/xl\/styles\.xml/.test(tipos));
    assert.ok(/<cellStyle name="Normal"/.test(le('xl/styles.xml')), 'sem o estilo Normal o Excel reclama do arquivo');
    const f = le('xl/worksheets/sheet1.xml');
    for (const n of nomes.filter((x) => /\.xml$|\.rels$/.test(x))) { const t = le(n); assert.ok(t.startsWith('<?xml version="1.0" encoding="UTF-8"') && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(t), n + ': cabeçalho ou caractere proibido'); }
    /* cabeçalho, congelado; número é número; texto é texto — inclusive o que parece fórmula */
    assert.ok(/<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/.test(f), 'a linha de títulos não fica presa');
    assert.ok(/<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">SKU<\/t>/.test(f) && /<c r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">Foto<\/t>/.test(f));
    assert.ok(/<c r="F2" s="3"><v>120<\/v><\/c><c r="G2" s="3"><v>1\.33<\/v><\/c>/.test(f), 'número tem que ir como número: ' + f.slice(f.indexOf('<row r="2"'), f.indexOf('<row r="3"')));
    assert.ok(/<c r="F4" s="3"><v>0<\/v><\/c>/.test(f) && /<c r="F5" s="3"><v>-3<\/v><\/c><c r="G5" s="3"><v>2e-7<\/v><\/c>/.test(f), 'zero e negativo são números (zero não é "vazio")');
    assert.ok(/<c r="A3" s="3" t="inlineStr"><is><t xml:space="preserve">=CMD\(\)<\/t>/.test(f) && !/<f>/.test(f), 'texto que parece fórmula vai como TEXTO');
    assert.ok(/Kit &amp; &lt;b&gt;&quot;aspas&quot;&lt;\/b&gt;/.test(f) && /parece fórmula<\/t>/.test(f), 'o texto vai escapado e sem caractere de controle');
    assert.ok(/<c r="G3" s="2"\/>/.test(f) && /<c r="B5" s="2"\/>/.test(f), 'vazio e nulo viram célula vazia');

    /* 20/11 (o modelo do dono): A FOTO DENTRO DA CÉLULA. A célula da linha com foto aponta (vm, contado de 1) pro "valor
       rico" da foto DELA; a linha sem foto fica vazia. Nada de desenho solto por cima da planilha. */
    assert.ok(/<c r="C2" s="3" t="e" vm="1"><v>#VALUE!<\/v><\/c>/.test(f) && /<c r="C4" s="3" t="e" vm="2"><v>#VALUE!<\/v><\/c>/.test(f), 'a foto da 1ª linha é a 1ª imagem e a da 3ª linha é a 2ª: ' + (f.match(/<c r="C\d"[^>]*>/g) || []).join(' '));
    assert.ok(/<c r="C3" s="2"\/>/.test(f) && /<c r="C5" s="2"\/>/.test(f) && (f.match(/ vm="/g) || []).length === 2, 'linha sem foto: célula vazia, sem imagem');
    assert.ok(!nomes.some((n) => /drawing/.test(n)) && !/<drawing/.test(f) && !/drawing/.test(tipos), 'a foto não é mais um desenho por cima da planilha');
    /* a corrente célula → metadata → valor rico → relação → arquivo da imagem, na ordem das fotos, como o Excel grava */
    const meta = le('xl/metadata.xml');
    assert.ok(/<metadataType name="XLRICHVALUE" minSupportedVersion="120000"/.test(meta) && /<futureMetadata name="XLRICHVALUE" count="2"><bk><extLst><ext uri="\{3e2802c4-a4d2-4d8b-9148-e3be6c30e623\}"><xlrd:rvb i="0"\/><\/ext><\/extLst><\/bk><bk><extLst><ext uri="\{3e2802c4-a4d2-4d8b-9148-e3be6c30e623\}"><xlrd:rvb i="1"\/><\/ext><\/extLst><\/bk><\/futureMetadata>/.test(meta) &&
      /<valueMetadata count="2"><bk><rc t="1" v="0"\/><\/bk><bk><rc t="1" v="1"\/><\/bk><\/valueMetadata>/.test(meta), 'metadata: ' + meta);
    assert.ok(/<rvData xmlns="http:\/\/schemas\.microsoft\.com\/office\/spreadsheetml\/2017\/richdata" count="2"><rv s="0"><v>0<\/v><v>5<\/v><\/rv><rv s="0"><v>1<\/v><v>5<\/v><\/rv><\/rvData>$/.test(le('xl/richData/rdrichvalue.xml')), 'cada valor rico aponta pra imagem de mesmo número');
    assert.ok(/<rvStructures [^>]*count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"\/><k n="CalcOrigin" t="i"\/><\/s><\/rvStructures>$/.test(le('xl/richData/rdrichvaluestructure.xml')));
    assert.ok(/<rvTypesInfo xmlns="http:\/\/schemas\.microsoft\.com\/office\/spreadsheetml\/2017\/richdata2"/.test(le('xl/richData/rdRichValueTypes.xml')) && (le('xl/richData/rdRichValueTypes.xml').match(/<key name="/g) || []).length === 10);
    assert.ok(/<richValueRels xmlns="http:\/\/schemas\.microsoft\.com\/office\/spreadsheetml\/2022\/richvaluerel"[^>]*><rel r:id="rId1"\/><rel r:id="rId2"\/><\/richValueRels>$/.test(le('xl/richData/richValueRel.xml')));
    const rr = le('xl/richData/_rels/richValueRel.xml.rels');
    assert.ok(/Id="rId1" Type="[^"]*\/image" Target="\.\.\/media\/image1\.jpeg"/.test(rr) && /Id="rId2" Type="[^"]*\/image" Target="\.\.\/media\/image2\.jpeg"/.test(rr) && (rr.match(/<Relationship /g) || []).length === 2);
    const partesDoTipo = [...tipos.matchAll(/<Override PartName="([^"]+)" ContentType="application\/([^"]+)"\/>/g)].map((m) => m[1] + ' ' + m[2]);
    assert.deepStrictEqual(partesDoTipo.slice(3), ['/xl/metadata.xml vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml', '/xl/richData/richValueRel.xml vnd.ms-excel.richvaluerel+xml', '/xl/richData/rdrichvalue.xml vnd.ms-excel.rdrichvalue+xml',
      '/xl/richData/rdrichvaluestructure.xml vnd.ms-excel.rdrichvaluestructure+xml', '/xl/richData/rdRichValueTypes.xml vnd.ms-excel.rdrichvaluetypes+xml'], 'o Excel só lê a imagem em célula se cada parte vier declarada com o tipo dela');
    const relsLivro = [...le('xl/_rels/workbook.xml.rels').matchAll(/Type="[^"]*\/([A-Za-z]+)" Target="([^"]+)"/g)].map((m) => m[1] + ' ' + m[2]);
    assert.deepStrictEqual(relsLivro, ['worksheet worksheets/sheet1.xml', 'styles styles.xml', 'sheetMetadata metadata.xml', 'richValueRel richData/richValueRel.xml', 'rdRichValue richData/rdrichvalue.xml', 'rdRichValueStructure richData/rdrichvaluestructure.xml', 'rdRichValueTypes richData/rdRichValueTypes.xml']);
    assert.ok(!/<hyperlinks/.test(f) && /<\/sheetData><\/worksheet>$/.test(f), 'sem coluna de link pedida, não há link');

    /* os estilos: tudo centralizado (horizontal e vertical) com quebra de texto; borda só onde há conteúdo */
    const est = le('xl/styles.xml');
    assert.ok(/<borders count="2">/.test(est) && /<border><left style="thin">.*?<right style="thin">.*?<top style="thin">.*?<bottom style="thin">/.test(est), 'falta a borda fina nos quatro lados');
    const xfs = [...est.slice(est.indexOf('<cellXfs'), est.indexOf('</cellXfs>')).matchAll(/<xf numFmtId="(\d+)" fontId="(\d)" fillId="(\d)" borderId="(\d)"[^>]*?(\/>|>(.*?)<\/xf>)/g)]
      .map((m) => [m[4], m[2], m[3], m[1]].join('') + (/horizontal="center" vertical="center"/.test(m[0]) ? 'c' : '-') + (/wrapText="1"/.test(m[0]) ? 'q' : '-'));
    /* borda·fonte·fundo·formato + centralizado + quebra */
    assert.deepStrictEqual(xfs, ['0000--', '1120cq', '1000cq', '1000cq', '1200c-', '100164cq', '1330cq', '1300cq', '1400cq', '1500cq'], 'os estilos: 1 título · 2 vazia (COM borda — o dono: "mesmo q um campo não tenha resultado... pra não ficar buracos") · 3 conteúdo · 4 link (sem quebra) · 5 R$ · 6 destaque · 7/8/9 semáforo: ' + JSON.stringify(xfs));
    const fontes = [...est.slice(est.indexOf('<fonts'), est.indexOf('</fonts>')).matchAll(/<font>(.*?)<\/font>/g)].map((m) => (/<b\/>/.test(m[1]) ? 'b' : '') + (/<u\/>/.test(m[1]) ? 'u' : '') + ((m[1].match(/rgb="([0-9A-F]+)"/) || [])[1] || ''));
    assert.deepStrictEqual(fontes, ['', 'bFF1F3864', 'uFF0563C1', 'b', 'bFFFF0000', 'bFF00B050'], 'as fontes: normal, título, link, negrito, vermelho, verde');
    assert.deepStrictEqual([...est.slice(est.indexOf('<fills'), est.indexOf('</fills>')).matchAll(/fgColor rgb="([0-9A-F]+)"/g)].map((m) => m[1]), ['FFDDEBF7', 'FFFFF4E5'], 'os fundos: o do título e o da coluna em destaque');
    assert.ok(/<numFmt numFmtId="164" formatCode="&quot;R\$&quot;\\ #,##0\.00;\\-&quot;R\$&quot;\\ #,##0\.00"\/>/.test(est), 'o formato de R$ do modelo: ' + est.slice(est.indexOf('<numFmts'), est.indexOf('</numFmts>')));
    const estilosDe = (ff, lin) => [...ff.slice(ff.indexOf('<row r="' + lin + '"'), ff.indexOf('</row>', ff.indexOf('<row r="' + lin + '"'))).matchAll(/<c r="([A-Z]+)\d+" s="(\d)"/g)].map((m) => m[1] + m[2]).join(' ');
    assert.deepStrictEqual([estilosDe(f, 1), estilosDe(f, 2), estilosDe(f, 3), estilosDe(f, 5)], ['A1 B1 C1 D1 E1 F1 G1', 'A3 B3 C3 D3 E3 F3 G3', 'A3 B3 C2 D2 E3 F3 G2', 'A3 B2 C2 D2 E3 F3 G3'], 'cada célula no estilo dela (zero é conteúdo; vazio e nulo vão no estilo da vazia)');
    /* a grade inteira: TODA célula de TODA linha (título e produtos) usa um estilo com borda — nenhuma fica no estilo 0, e nenhuma coluna falta */
    for (const ff of [f]) for (let lin = 1; lin <= 5; lin++) { const cs = [...ff.slice(ff.indexOf('<row r="' + lin + '"'), ff.indexOf('</row>', ff.indexOf('<row r="' + lin + '"'))).matchAll(/<c r="[A-Z]+\d+" s="(\d)"/g)].map((m) => xfs[Number(m[1])].charAt(0)); assert.deepStrictEqual(cs, ['1', '1', '1', '1', '1', '1', '1'], 'linha ' + lin + ': célula sem borda ou coluna faltando — ' + cs.join('')); }
    /* sem medidas de quem chama: a linha e a coluna da foto têm o tamanho do quadrado */
    assert.ok(/<row r="1" ht="24" customHeight="1">/.test(f) && /<row r="2" ht="231" customHeight="1">/.test(f) && /<row r="5" ht="231" customHeight="1">/.test(f) && /<col min="3" max="3" width="44" customWidth="1"\/>/.test(f), 'a linha e a coluna têm o tamanho da foto (300 px + folga)');
    const f100 = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS.slice(0, 1), colFoto: 2, fotos: [{ bytes: jpeg(1), w: 900, h: 450.4 }], lado: 100 }))).readAsText('xl/worksheets/sheet1.xml');
    assert.ok(/<row r="2" ht="81" customHeight="1">/.test(f100) && /<col min="3" max="3" width="15\.43" customWidth="1"\/>/.test(f100), 'lado diferente muda a linha e a coluna');

    /* ── O MODELO DO DONO: larguras e alturas dele, link, R$, destaque e o semáforo do saldo ── */
    const zm = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS, colFoto: 2, fotos, lado: 300, larguras: [20, null, 30.07, 7.46, 0, 'x', 12.3456], alturaTitulo: 43.75, alturaLinha: 102,
      link: [3, 99, -1, 'x', 1.5], destaque: [4], semaforo: [5], moeda: [6] })));
    const fm = zm.readAsText('xl/worksheets/sheet1.xml');
    assert.deepStrictEqual([...fm.matchAll(/<col min="(\d)" max="\d" width="([\d.]+)"/g)].map((m) => Number(m[2])), [20, 22, 30.07, 7.46, 9, 10, 12.35], 'a largura pedida vale; onde não veio (ou veio inválida), a coluna se ajusta ao texto');
    assert.ok(/<row r="1" ht="43\.75" customHeight="1">/.test(fm) && /<row r="2" ht="102" customHeight="1">/.test(fm) && /<row r="3" ht="102" customHeight="1">/.test(fm) && !/ht="231"/.test(fm), 'as alturas do modelo (título e linhas)');
    assert.deepStrictEqual([estilosDe(fm, 1), estilosDe(fm, 2), estilosDe(fm, 3), estilosDe(fm, 4), estilosDe(fm, 5)],
      ['A1 B1 C1 D1 E1 F1 G1', 'A3 B3 C3 D4 E6 F9 G5', 'A3 B3 C2 D2 E6 F9 G2', 'A3 B3 C3 D4 E6 F8 G5', 'A3 B2 C2 D2 E6 F8 G5'],
      'link na D (só onde há endereço); destaque na E; saldo VERDE acima de zero e VERMELHO em zero ou menos; R$ na G (vazio fica vazio); o título segue título');
    assert.ok(/<c r="F4" s="8"><v>0<\/v><\/c>/.test(fm) && /<c r="F2" s="9"><v>120<\/v><\/c>/.test(fm) && /<c r="G2" s="5"><v>1\.33<\/v><\/c>/.test(fm), 'o número continua número com o estilo novo');
    /* o link: a célula guarda o endereço como texto e a planilha aponta pra ele (por fora — nunca fórmula) */
    assert.ok(/<c r="D2" s="4" t="inlineStr"><is><t xml:space="preserve">https:\/\/x\/a\.jpg<\/t>/.test(fm) && /<\/sheetData><hyperlinks><hyperlink ref="D2" r:id="rId1"\/><hyperlink ref="D4" r:id="rId2"\/><\/hyperlinks><\/worksheet>$/.test(fm) && !/<f>|HYPERLINK/.test(fm), 'os links: ' + fm.slice(fm.indexOf('</sheetData>')));
    assert.deepStrictEqual(zm.getEntries().map((e) => e.entryName), BASE6.concat(['xl/worksheets/_rels/sheet1.xml.rels'], DA_FOTO, ['xl/media/image1.jpeg', 'xl/media/image2.jpeg']));
    assert.deepStrictEqual([...zm.readAsText('xl/worksheets/_rels/sheet1.xml.rels').matchAll(/<Relationship Id="(rId\d)" Type="[^"]*\/(\w+)" Target="([^"]+)" TargetMode="(\w+)"\/>/g)].map((m) => m.slice(1, 5).join(' ')),
      ['rId1 hyperlink https://x/a.jpg External', 'rId2 hyperlink https://x/c.jpg External']);
    /* só vira link o que é endereço http(s) inteiro; o resto fica texto comum. Semáforo e R$ com texto não inventam cor nem formato */
    const zl = new AdmZip(Buffer.from(X.montar({ cab: ['Link', 'Saldo', 'Valor'], linhas: [['javascript:alert(1)', 'n/d', 'sem custo'], ['https://x/a b', 1, 2], ['ftp://x/y', -1, 3], ['http://ok/a?b=1&c=2', 0.5, 4], [12345, 0, 0], ['https://x/' + 'a'.repeat(2000), '', ''], ['https://x/"aspas"', 3, 5]], link: [0], semaforo: [1], moeda: [2] })));
    const fl = zl.readAsText('xl/worksheets/sheet1.xml');
    assert.deepStrictEqual([2, 3, 4, 5, 6, 7, 8].map((n) => estilosDe(fl, n)), ['A3 B7 C3', 'A3 B9 C5', 'A3 B8 C5', 'A4 B9 C5', 'A3 B8 C5', 'A3 B2 C2', 'A3 B9 C5'], 'endereço que não é http(s) inteiro (ou comprido demais) não vira link: ' + [2, 3, 4, 5, 6, 7, 8].map((n) => estilosDe(fl, n)).join(' | '));
    assert.ok(/<hyperlinks><hyperlink ref="A5" r:id="rId1"\/><\/hyperlinks>/.test(fl) && /Target="http:\/\/ok\/a\?b=1&amp;c=2" TargetMode="External"/.test(zl.readAsText('xl/worksheets/_rels/sheet1.xml.rels')) && (zl.readAsText('xl/worksheets/_rels/sheet1.xml.rels').match(/<Relationship /g) || []).length === 1, 'um link só, com o & escapado');
    assert.ok(!zl.getEntries().some((e) => /richData|metadata|media/.test(e.entryName)) && /<row r="2">/.test(fl), 'sem foto e sem altura pedida: linhas na altura normal');
    assert.deepStrictEqual(['https://x/a.jpg', 'HTTP://X/a', 'http://x', ' https://x/a', 'https://x/a ', 'https://', 'javascript:x', '//x/a', '', null, 5, 'https://x/<a>'].map((v) => X.enderecoDeLink(v)), ['https://x/a.jpg', 'HTTP://X/a', 'http://x', '', '', '', '', '', '', '', '', '']);

    /* o Excel aceita pouco mais de 65 mil links por planilha: passou disso, o endereço segue como texto (o arquivo não pode sair quebrado) */
    const zMuitos = new AdmZip(Buffer.from(X.montar({ cab: ['Link'], linhas: Array.from({ length: 65003 }, (_, i) => ['https://x/' + i]), link: [0] })));
    const fMuitos = zMuitos.readAsText('xl/worksheets/sheet1.xml');
    assert.deepStrictEqual([(fMuitos.match(/<hyperlink /g) || []).length, (zMuitos.readAsText('xl/worksheets/_rels/sheet1.xml.rels').match(/<Relationship /g) || []).length, /<c r="A65001" s="4"/.test(fMuitos), /<c r="A65002" s="3" t="inlineStr"><is><t xml:space="preserve">https:\/\/x\/65000</.test(fMuitos)], [65000, 65000, true, true], 'no máximo 65 mil links; o resto fica texto');
    /* na coluna da foto: linha COM foto leva a imagem (o texto que vier ali não aparece); linha SEM foto mostra o texto */
    const fT = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: [['A', 'B', 'texto na coluna da foto', 'u', 'A', 1, 2], ['C', 'D', 'foto não veio', 'u', 'A', 1, 2]], colFoto: 2, fotos: [{ bytes: jpeg(1), w: 10, h: 10 }, null] }))).readAsText('xl/worksheets/sheet1.xml');
    assert.ok(/<c r="C2" s="3" t="e" vm="1"><v>#VALUE!<\/v><\/c>/.test(fT) && !/texto na coluna da foto/.test(fT) && /<c r="C3" s="3" t="inlineStr"><is><t xml:space="preserve">foto não veio<\/t>/.test(fT) && /<c r="C1" s="1" t="inlineStr">/.test(fT), 'a célula da foto é da imagem; sem foto, mostra o que a linha trouxe: ' + (fT.match(/<c r="C\d".*?(\/>|<\/c>)/g) || []).join(' '));
    /* coluna sem título: a célula do título continua com o estilo de título (a faixa do cabeçalho não fica com buraco) */
    assert.ok(/<c r="B1" s="1"\/>/.test(new AdmZip(Buffer.from(X.montar({ cab: ['A', '', 'C'], linhas: [[1, 2, 3]] }))).readAsText('xl/worksheets/sheet1.xml')));
    /* sem foto nenhuma: planilha normal, sem as partes da imagem e sem linhas altas */
    for (const semFotos of [[], [null, null, null, null], undefined, [{ bytes: new Uint8Array(0), w: 10, h: 10 }, { bytes: jpeg(1), w: 0, h: 10 }, { w: 10, h: 10 }, { bytes: jpeg(1), w: 10 }]]) {
      const z2 = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS, colFoto: 2, fotos: semFotos })));
      const n2 = z2.getEntries().map((e) => e.entryName);
      assert.deepStrictEqual(n2, BASE6, 'foto que não é foto não entra: ' + n2.join(', '));
      const f2 = z2.readAsText('xl/worksheets/sheet1.xml');
      assert.ok(!/ vm="/.test(f2) && /<row r="2">/.test(f2) && !/jpeg|richData|metadata/.test(z2.readAsText('[Content_Types].xml')) && !/richData|metadata/.test(z2.readAsText('xl/_rels/workbook.xml.rels')) && /<c r="F2" s="3"><v>120<\/v>/.test(f2) && /<c r="C2" s="2"\/>/.test(f2));
    }
    /* coluna da foto inválida: sai a planilha, sem foto */
    for (const col of [undefined, -1, 99, 1.5, 'x']) assert.ok(!new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS, colFoto: col, fotos }))).getEntries().some((e) => /media|richData/.test(e.entryName)), 'colFoto ' + col);
    assert.deepStrictEqual([X.letra(0), X.letra(25), X.letra(26), X.letra(27), X.letra(701), X.letra(702)], ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    assert.strictEqual(X.crc32(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57])), 0xCBF43926, 'CRC-32 de "123456789"');
    assert.deepStrictEqual(new AdmZip(Buffer.from(X.montar({ cab: [], linhas: [] }))).getEntries().map((e) => e.entryName), BASE6, 'planilha vazia ainda é um arquivo válido');
  }

  /* ═══ B. a busca das fotos ═══ */
  {
    let juntas = 0, pico = 0; const pedidas = []; const avancos = [];
    const buscar = async (u) => { pedidas.push(u); juntas++; pico = Math.max(pico, juntas); await new Promise((r) => setTimeout(r, 3)); juntas--;
      if (/erro/.test(u)) throw new Error('rede'); if (/404/.test(u)) return { ok: false, blob: async () => 'x' }; return { ok: true, blob: async () => 'blob:' + u }; };
    const encolher = async (b, lado) => { if (/quebra/.test(b)) throw new Error('não é imagem'); if (/lixo/.test(b)) return { bytes: new Uint8Array(0), w: 1, h: 1 }; return { bytes: jpeg(1), w: lado, h: lado - 1, de: b }; };
    const ends = ['a', '', 'erro1', '404x', 'quebra', 'lixo', 'b', 'c', 'd', 'e', 'f', 'g'];
    const fotos = await X.baixarFotos(ends, { fetch: buscar, encolher, lado: 300, simultaneas: 3, aoAvancar: (f, t) => avancos.push(f + '/' + t) });
    assert.deepStrictEqual(fotos.map((f) => (f ? f.de : null)), ['blob:a', null, null, null, null, null, 'blob:b', 'blob:c', 'blob:d', 'blob:e', 'blob:f', 'blob:g'], 'cada foto na posição da linha dela; a que falhou vira null');
    assert.deepStrictEqual([fotos[0].w, fotos[0].h], [300, 299]);
    assert.ok(!pedidas.includes('') && pedidas.length === 11, 'linha sem endereço de foto não vai ao servidor');
    assert.ok(pico <= 3 && pico >= 2, 'poucas por vez (pediu 3): pico ' + pico);
    assert.deepStrictEqual([avancos.length, avancos[avancos.length - 1]], [12, '12/12'], 'o andamento conta todas as linhas');
    assert.deepStrictEqual(await X.baixarFotos([], { fetch: buscar, encolher }), []);
    let p2 = 0, j2 = 0; await X.baixarFotos(Array(30).fill('z'), { fetch: async () => { j2++; p2 = Math.max(p2, j2); await new Promise((r) => setTimeout(r, 1)); j2--; return { ok: true, blob: async () => 'b' }; }, encolher, simultaneas: 99 });
    assert.ok(p2 <= 8, 'o pedido de simultâneas tem teto: ' + p2);
    /* Codex #959: milhares de linhas SEM foto em sequência (a rota do plano só busca foto dos 260 primeiros) não podem
       estourar a pilha — e a foto no meio delas ainda sai, no lugar dela */
    const muitas = Array(20000).fill(''); muitas[15000] = 'a'; let av = 0;
    const fm = await X.baixarFotos(muitas, { fetch: buscar, encolher, simultaneas: 4, aoAvancar: () => { av++; } });
    assert.deepStrictEqual([fm.length, fm.filter((f) => f).length, !!fm[15000], av], [20000, 1, true, 20000], '20 mil linhas, 1 com foto');
    assert.deepStrictEqual((await X.baixarFotos(Array(50000).fill(null), { fetch: buscar, encolher })).length, 50000);
    const estoura = await X.baixarFotos(['a'], { fetch: buscar, encolher, aoAvancar: () => { throw new Error('tela sumiu'); } });
    assert.ok(estoura[0], 'erro em quem mostra o andamento não derruba a busca');
  }

  /* ═══ C. a rota da foto ═══ */
  const chamadas = [];
  let roteiro = {};
  const nfetch = require.resolve('node-fetch');
  const fechados = []; const sinais = [];
  const resp = (st, tipo, corpo, extra) => ({ status: st, body: { destroy() { fechados.push(st + ' ' + (tipo || '-')); } }, headers: { get: (h) => Object.assign({ 'content-type': tipo, 'content-length': corpo ? String(corpo.length) : null }, extra || {})[h.toLowerCase()] || null }, arrayBuffer: async () => { const b = Buffer.from(corpo || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (url, opts) => { chamadas.push([String(url), opts && opts.redirect]); sinais.push(opts && opts.signal); const r = roteiro[String(url)]; if (!r) throw new Error('rede bloqueada no teste: ' + url); if (r === 'TRAVA') return new Promise((ok, erro) => { opts.signal.addEventListener('abort', () => erro(new Error('abortado'))); }); return typeof r === 'function' ? r() : r; } };
  for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
  global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
  const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-fotos-'));
  process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
  process.env.ADMIN_KEY = 'chave-foto';
  for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
  const F = require('../lib/checkout/rota-plano-foto');
  const CE = require('../lib/checkout/config-empresa');
  {
    for (const ok of ['https://img.exemplo.com.br/a.jpg', 'https://s3.amazonaws.com/b/c.png?x=1', 'https://LH3.googleusercontent.com/d', 'https://a.b:443/c', ' https://a.bc/d ']) assert.ok(F.enderecoPermitido(ok), 'devia poder: ' + ok);
    for (const nao of ['http://img.exemplo.com.br/a.jpg', 'ftp://a.bc/d', 'file:///etc/passwd', 'https://localhost/a', 'https://bling/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://169.254.169.254/latest', 'https://[::1]/a',
      'https://[fd00::1]/a', 'https://servico.internal/a', 'https://impressora.local/a', 'https://a.localhost/x', 'https://user:senha@a.bc/d', 'https://a.bc:8443/d', 'https://2130706433/a', 'https://0x7f000001/a', 'https://a.0x7f/b', 'https://a.b.123/c',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, undefined, 'não é endereço', '//a.bc/d', 'https://a.corp/x', 'https://x.test/y']) assert.strictEqual(F.enderecoPermitido(nao), null, 'NÃO devia poder: ' + nao);
  }
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const cache = { 'KP5': { img: 'https://img.exemplo.com.br/kp5.jpg', saldo: 3 }, 'SEM': { saldo: 1 }, 'RUIM': { img: 'http://10.0.0.1/a.jpg' }, 'A B/Ç': { img: 'https://img.exemplo.com.br/ab.png' }, 'VOLTA': { img: 'https://img.exemplo.com.br/vai' },
        'INTERNO': { img: 'https://img.exemplo.com.br/pra-dentro' }, 'HTML': { img: 'https://img.exemplo.com.br/pagina' }, 'SVG': { img: 'https://img.exemplo.com.br/desenho.svg' }, 'GRANDE': { img: 'https://img.exemplo.com.br/grande' }, 'MENTE': { img: 'https://img.exemplo.com.br/mente' },
        'CAIU': { img: 'https://img.exemplo.com.br/caiu' }, 'E500': { img: 'https://img.exemplo.com.br/e500' }, 'VAZIA': { img: 'https://img.exemplo.com.br/vazia' }, 'RODA': { img: 'https://img.exemplo.com.br/r0' }, 'LENTA': { img: 'https://img.exemplo.com.br/lenta' } };
      roteiro = { 'https://img.exemplo.com.br/kp5.jpg': resp(200, 'image/jpeg; charset=binary', Buffer.from(jpeg(5))), 'https://img.exemplo.com.br/ab.png': resp(200, 'IMAGE/PNG', Buffer.from('png!')),
        'https://img.exemplo.com.br/vai': resp(302, '', '', { location: '/final.jpg' }), 'https://img.exemplo.com.br/final.jpg': resp(301, '', '', { location: 'https://cdn.outro.com/f.webp' }), 'https://cdn.outro.com/f.webp': resp(200, 'image/webp', Buffer.from('webp')),
        'https://img.exemplo.com.br/pra-dentro': resp(302, '', '', { location: 'http://169.254.169.254/latest/meta-data' }), 'https://img.exemplo.com.br/pagina': resp(200, 'text/html', Buffer.from('<html>')), 'https://img.exemplo.com.br/desenho.svg': resp(200, 'image/svg+xml', Buffer.from('<svg/>')),
        'https://img.exemplo.com.br/grande': resp(200, 'image/jpeg', Buffer.from('x'), { 'content-length': '999999999' }), 'https://img.exemplo.com.br/mente': resp(200, 'image/jpeg', Buffer.alloc(300), { 'content-length': '10' }),
        'https://img.exemplo.com.br/e500': resp(500, 'image/jpeg', Buffer.from('x')), 'https://img.exemplo.com.br/vazia': resp(200, 'image/jpeg', Buffer.alloc(0)), 'https://img.exemplo.com.br/lenta': 'TRAVA',
        'https://img.exemplo.com.br/r0': resp(302, '', '', { location: '/r1' }), 'https://img.exemplo.com.br/r1': resp(302, '', '', { location: '/r2' }), 'https://img.exemplo.com.br/r2': resp(302, '', '', { location: '/r3' }), 'https://img.exemplo.com.br/r3': resp(302, '', '', { location: '/r4' }), 'https://img.exemplo.com.br/r4': resp(200, 'image/jpeg', Buffer.from('x')) };
      let leituras = 0;
      const rota = F.criar({ empresa: emp, tetoBytes: 200, prazoMs: 40, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
        lerCacheDeProdutos: () => { leituras++; return cache; } });
      const pedir = async (qs, cookie) => { const u = new URL('http://x' + pref + '/plano-compra/foto' + qs); const res = { _s: 0, _o: null, _h: null, _b: null, writeHead(s, h) { this._s = s; this._h = h; }, end(b) { this._b = b; } }; const t = await rota({ method: 'GET', headers: { cookie } }, res, u, 'GET', u.pathname); return Object.assign(res, { _t: t }); };
      assert.strictEqual(F.atende(pref, 'POST', pref + '/plano-compra/foto'), false); assert.strictEqual(F.atende(pref, 'GET', pref + '/plano-compra'), false);
      /* só admin (chave ou sessão); o estoquista logado não busca */
      chamadas.length = 0;
      for (const [qs, ck] of [['?sku=KP5', undefined], ['?sku=KP5&k=errada', undefined], ['?sku=KP5', 'est']]) { const r = await pedir(qs, ck); assert.deepStrictEqual([r._s, r._o], [404, { error: 'not found' }], emp + ': sem ser admin'); }
      assert.deepStrictEqual([chamadas.length, leituras], [0, 0], emp + ': sem credencial não lê o cache nem vai à rede');
      const r1 = await pedir('?sku=KP5', 'adm');
      assert.deepStrictEqual([r1._t, r1._s, r1._h['Content-Type'], r1._h['Content-Length'], r1._h['X-Content-Type-Options'], Buffer.compare(r1._b, Buffer.from(jpeg(5)))], [true, 200, 'image/jpeg', 45, 'nosniff', 0], emp + ': a foto, pelos bytes');
      assert.deepStrictEqual(chamadas, [['https://img.exemplo.com.br/kp5.jpg', 'manual']], emp + ': busca o endereço que o PLANO guardou, sem seguir redirecionamento sozinho');
      assert.strictEqual((await pedir('?k=chave-foto&sku=' + encodeURIComponent('A B/Ç')))._h['Content-Type'], 'image/png', emp + ': pela chave, SKU com espaço/barra/acento');
      /* o que não é foto pra buscar: cada um com a sua resposta, sem ir à rede */
      chamadas.length = 0;
      for (const [qs, st, re] of [['', 400, /use \?sku=/], ['?sku=', 400, /use \?sku=/], ['?sku=' + 'x'.repeat(121), 400, /use \?sku=/], ['?sku=NAOEXISTE', 404, /sem foto guardada/], ['?sku=SEM', 404, /sem foto guardada/],
        ['?sku=__proto__', 404, /sem foto guardada/], ['?sku=constructor', 404, /sem foto guardada/], ['?sku=RUIM', 422, /não pode ser buscado/]]) {
        const r = await pedir(qs, 'adm'); assert.ok(r._s === st && r._o.ok === false && re.test(r._o.erro), emp + ': ' + qs + ' → ' + r._s + ' ' + JSON.stringify(r._o));
      }
      assert.strictEqual(chamadas.length, 0, emp + ': SKU sem foto ou com endereço proibido não vai à rede');
      /* quem chama NÃO escolhe o endereço */
      const inj = await pedir('?sku=NAOEXISTE&u=https://img.exemplo.com.br/kp5.jpg&url=https://img.exemplo.com.br/kp5.jpg&img=https://img.exemplo.com.br/kp5.jpg', 'adm');
      assert.deepStrictEqual([inj._s, chamadas.length], [404, 0], emp + ': endereço passado por quem chama é ignorado');
      /* redirecionamento: seguido à mão, cada salto pelas mesmas regras */
      chamadas.length = 0;
      const rv = await pedir('?sku=VOLTA', 'adm');
      assert.deepStrictEqual([rv._s, rv._h['Content-Type'], chamadas.map((c) => c[0])], [200, 'image/webp', ['https://img.exemplo.com.br/vai', 'https://img.exemplo.com.br/final.jpg', 'https://cdn.outro.com/f.webp']]);
      chamadas.length = 0;
      const ri = await pedir('?sku=INTERNO', 'adm');
      assert.ok(ri._s === 502 && /redirecionamento/.test(ri._o.erro) && chamadas.length === 1, emp + ': redirecionamento pra dentro da rede NÃO é seguido: ' + JSON.stringify(chamadas));
      chamadas.length = 0;
      const rr = await pedir('?sku=RODA', 'adm');
      assert.ok(rr._s === 502 && /redirecionamentos demais/.test(rr._o.erro) && chamadas.length === 4, emp + ': no máximo 3 saltos: ' + chamadas.length);
      /* Codex #959: toda resposta que não vai ser lida tem o corpo fechado, e ao sair não fica pedido pendente */
      fechados.length = 0; sinais.length = 0;
      await pedir('?sku=VOLTA', 'adm'); await pedir('?sku=INTERNO', 'adm'); await pedir('?sku=HTML', 'adm'); await pedir('?sku=GRANDE', 'adm'); await pedir('?sku=E500', 'adm'); await pedir('?sku=RODA', 'adm'); await pedir('?sku=KP5', 'adm');
      assert.deepStrictEqual(fechados, ['302 -', '301 -', '302 -', '200 text/html', '200 image/jpeg', '500 image/jpeg', '302 -', '302 -', '302 -', '302 -'], emp + ': corpos fechados (os 2 saltos da foto que voltou; o salto pra dentro; a página; a grande; o 500; os 4 saltos da que roda) — e a foto servida NÃO: ' + JSON.stringify(fechados));
      assert.ok(sinais.length === 12 && sinais.every((sg) => sg && sg.aborted === true), emp + ': ao sair, todo pedido tem que estar encerrado: ' + sinais.map((sg) => sg && sg.aborted).join());
      /* só imagem, com teto; falha de rede e demora não derrubam */
      for (const [sku, re] of [['HTML', /não é imagem/], ['SVG', /não é imagem/], ['GRANDE', /grande demais/], ['MENTE', /grande demais/], ['E500', /respondeu 500/], ['VAZIA', /foto vazia/], ['CAIU', /não consegui buscar/], ['LENTA', /demorou demais/]]) {
        const r = await pedir('?sku=' + sku, 'adm'); assert.ok(r._s === 502 && r._o.ok === false && re.test(r._o.erro) && r._b == null, emp + ': ' + sku + ' → ' + r._s + ' ' + JSON.stringify(r._o));
      }
      const semCache = F.criar({ empresa: emp, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: () => 'chave-foto', validarSessao: () => null, ehAdmin: () => false, lerCacheDeProdutos: () => { throw new Error('disco'); } });
      const uS = new URL('http://x' + pref + '/plano-compra/foto?sku=KP5'); const resS = {}; await semCache({ method: 'GET', headers: {} }, resS, uS, 'GET', uS.pathname);
      assert.strictEqual(resS._s, 404, emp + ': cache ilegível é "sem foto", não erro');

      /* pelo routes REAL da empresa: a rota existe, pede credencial, e lê o cache do plano DESTA empresa */
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      fs.writeFileSync(path.join(PASTAS, emp, '_prod_compra.json'), JSON.stringify({ ['SKU-' + emp]: { img: 'https://img.exemplo.com.br/kp5.jpg' } }));
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs) => { const u = new URL('http://x' + pref + qs); const res = { _s: 0, _b: null, _h: null, writeHead(s, hd) { this._s = s; this._h = hd; }, setHeader() {}, end(b) { this._b = b; } }; await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return res; };
      chamadas.length = 0;
      const semK = await real('/plano-compra/foto?sku=SKU-' + emp);
      assert.ok((semK._s === 404 || semK._s === 401) && chamadas.length === 0, emp + ': sem credencial, o routes real respondeu ' + semK._s);
      const comK = await real('/plano-compra/foto?k=chave-foto&sku=SKU-' + emp);
      assert.ok(comK._s === 200 && Buffer.compare(Buffer.from(comK._b), Buffer.from(jpeg(5))) === 0, emp + ': o routes real não entregou a foto do cache do plano: ' + comK._s + ' ' + String(comK._b).slice(0, 120));
      const outra = await real('/plano-compra/foto?k=chave-foto&sku=SKU-' + (emp === 'amb' ? 'good' : 'amb'));
      assert.strictEqual(outra._s, 404, emp + ': SKU do cache de OUTRA empresa não pode responder aqui');

      /* ═══ E. a fábrica entrega a peça do .xlsx e o plano no MESMO script ═══ */
      const js = await real('/js/plano-compra.js');
      const corpo = String(js._b || '');
      assert.ok(js._s === 200 && corpo.indexOf('PlanilhaXlsxFotos') > 0 && corpo.indexOf('PlanilhaXlsxFotos') < corpo.indexOf('planoCompraAqui'), emp + ': a peça do .xlsx tem que vir antes do plano, no mesmo script');
      assert.ok(corpo.includes(pref + "'") || corpo.includes('"' + pref + '"'), emp + ': o script não leva o prefixo da empresa');
      assert.doesNotThrow(() => new Function('window', 'document', corpo.replace(/\(function \(\) \{\s*'use strict';\s*var BASE/, '(function () { return; var BASE')), emp + ': o script servido não compila');
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }

  /* ═══ D. o botão "baixar planilha" ═══ */
  {
    const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');
    const ITENS = [{ sku: 'PT 06/Ç', ean: '7891234567895', nome: 'Abajur', img: 'https://x/pt.jpg', curva: 'A', un: 42, md: 1.4, md_estoque: 2.1, saldo: 3, a_caminho: 1180, chega: '2026-12-04', a_caminho_atrasado: false, a_caminho_sem_data: true, vai_faltar: true, acaba_em: 12, precisa: 50, comprar: 47, custo_un: 10.5, investir: 493.5, mc_un: 4, risco: 700 },
      { sku: 'GLOBO12', ean: null, nome: 'Globo', img: null, curva: 'B', un: 0, md: 0, saldo: null, acaba_em: null, precisa: 0, comprar: 0, custo_un: null, investir: null, mc_un: 0, risco: 200 },
      { sku: 'KP5', nome: 'Kit', img: 'https://x/kp.jpg', curva: 'A', un: 5, md: 0.2, saldo: 0, acaba_em: 0, precisa: 9, comprar: 9, custo_un: 2, investir: 18, mc_un: 1, risco: 9 }];
    const cena = async (janela) => {
      const els = {}; const obs = { blobs: [], baixados: [], montar: [], salvar: [], fotos: [] };
      const novo = (id) => ({ id, innerHTML: '', textContent: id === 'pcCsv' ? 'baixar planilha' : '', value: '', disabled: false, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
      els.planoCompraAqui = novo('planoCompraAqui');
      const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() { obs.baixados.push(this.download); }, href: '', download: '' }) };
      const sandbox = new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'));
      sandbox(doc, janela, async () => ({ json: async () => ({ ok: true, skus: 3, totais: { investir: 1, risco: 1, skus_a_comprar: 2 }, itens: ITENS }) }),
        { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, function (partes, op) { obs.blobs.push([String(partes[0]).length, op && op.type]); }, (f) => setImmediate(f));
      els.pcCalc.click(); for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      assert.ok(/<table/.test(els.pcTab.innerHTML), 'o plano não desenhou');
      return { els, obs };
    };
    const falsoX = (obs, op) => ({
      baixarFotos: (ends, o) => { obs.fotos.push({ ends, lado: o.lado }); if (op && op.trava) return new Promise((ok) => { obs.soltar = () => ok(ends.map(() => null)); }); o.aoAvancar(1, ends.length); obs.rotuloNoMeio = obs.btn.textContent; obs.travadoNoMeio = obs.btn.disabled;
        if (op && op.estoura) return Promise.reject(new Error('sem memória')); return Promise.resolve(ends.map((e, i) => (e && !(op && op.falta === i) ? { bytes: jpeg(i), w: 300, h: 300 } : null))); },
      montar: (a) => { obs.montar.push(a); if (op && op.montarEstoura) throw new Error('xlsx'); return new Uint8Array([1, 2, 3]); },
      salvar: (bytes, nome) => obs.salvar.push([bytes.length, nome]) });
    const fim = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

    /* com a peça: .xlsx, 15 colunas, a Foto na C, as 14 de sempre em volta, fotos pedidas pelo SKU */
    const jan = { createImageBitmap() {} }; const c = await cena(jan); jan.PlanilhaXlsxFotos = falsoX(c.obs); c.obs.btn = c.els.pcCsv;
    await c.els.pcCsv.click(); await fim();
    assert.deepStrictEqual(c.obs.fotos, [{ ends: ['/emp/plano-compra/foto?sku=PT%2006%2F%C3%87', '', '/emp/plano-compra/foto?sku=KP5'], lado: 300 }], 'as fotos são pedidas ao servidor pelo SKU (codificado); item sem foto não pede');
    const m = c.obs.montar[0];
    assert.deepStrictEqual(m.cab, ['SKU', 'EAN', 'Produto', 'Foto', 'Imagem (URL)', 'Curva', 'Vendidas na base', 'Média por dia', 'Ritmo Vendas c/ Estoque (por dia)', 'Saldo hoje', 'A caminho', 'Chegada prevista', 'Acaba em (dias)', 'Sem estoque desde (última venda)', 'Precisa até o próximo ciclo', 'COMPRAR', 'Custo unitário', 'Investimento', 'Margem por unidade', 'Lucro em risco'], 'as colunas de sempre (com os acentos), a Foto entre a B e a antiga C, e a da última venda ao lado do "Acaba em"');
    /* 20/11 — o modelo do dono: as medidas do arquivo dele e os destaques, cada um na coluna CERTA (pelo título) */
    assert.deepStrictEqual([m.larguras, m.alturaTitulo, m.alturaLinha], [[25.77, 16.5, 67.07, 30.07, 7.46, 10.46, 10.46, 10.46, 11.5, 10.46, 10.46, 18, 10.46, 13.5, 10.46, 10.46, 9.77, 12.3, 9.77, 12.3], 43.75, 102], 'as larguras e alturas do arquivo que o dono arrumou');
    assert.deepStrictEqual([m.larguras.length, m.link.map((k) => m.cab[k]), m.semaforo.map((k) => m.cab[k]), m.destaque.map((k) => m.cab[k]), m.moeda.map((k) => m.cab[k])],
      [20, ['Imagem (URL)'], ['Saldo hoje'], ['COMPRAR'], ['Custo unitário', 'Investimento', 'Margem por unidade', 'Lucro em risco']], 'link no endereço da imagem, vermelho/verde no saldo, fundo no COMPRAR, R$ nos quatro valores');
    assert.deepStrictEqual([m.colFoto, m.cab[m.colFoto], m.lado, m.linhas.length, m.fotos.length, m.fotos.map((f) => !!f)], [3, 'Foto', 300, 3, 3, [true, false, true]], 'a foto vai com 300 px — o tamanho na tela quem dá é a célula');
    assert.deepStrictEqual(m.linhas[0], ['PT 06/Ç', '7891234567895', 'Abajur', '', 'https://x/pt.jpg', 'A', 42, 1.4, 2.1, 3, 1180, '04/12/2026 (parte sem data) (acaba antes de chegar)', 12, '', 50, 47, 10.5, 493.5, 4, 700]);
    assert.deepStrictEqual(m.linhas[1], ['GLOBO12', '', 'Globo', '', '', 'B', 0, 0, '', '', '', '', '', '', 0, 0, '', '', 0, 200], 'sem saldo/custo/a caminho fica VAZIO (não zero); zero de verdade fica zero');
    assert.ok(c.obs.salvar.length === 1 && c.obs.salvar[0][0] === 3 && /^plano-de-compra-\d{4}-\d{2}-\d{2}\.xlsx$/.test(c.obs.salvar[0][1]), 'o arquivo é .xlsx: ' + JSON.stringify(c.obs.salvar));
    assert.deepStrictEqual([c.obs.blobs.length, c.obs.baixados.length], [0, 0], 'com a planilha nova, a antiga (.xls) não é baixada junto');
    assert.deepStrictEqual([c.obs.rotuloNoMeio, c.obs.travadoNoMeio, c.els.pcCsv.textContent, c.els.pcCsv.disabled, c.els.pcXlsInfo.textContent], ['buscando fotos 1/3…', true, 'baixar planilha', false, 'planilha baixada com 2 foto(s)'], 'mostra o andamento, trava o botão no meio e devolve no fim');
    /* o filtro da tela vale pra planilha */
    c.els.pcFiltro._ev.input({ target: { value: 'kit' } }); await c.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c.obs.montar[1].linhas.length, c.obs.montar[1].linhas[0][0], c.obs.fotos[1].ends], [1, 'KP5', ['/emp/plano-compra/foto?sku=KP5']]);
    /* foto que não veio: a planilha sai, e a tela diz quantas faltaram */
    const j2 = { createImageBitmap() {} }; const c2 = await cena(j2); j2.PlanilhaXlsxFotos = falsoX(c2.obs, { falta: 2 }); c2.obs.btn = c2.els.pcCsv;
    await c2.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c2.obs.salvar.length, c2.els.pcXlsInfo.textContent], [1, 'planilha baixada — 1 de 2 foto(s) não vieram (essas linhas ficaram sem imagem)']);
    assert.deepStrictEqual(c2.obs.montar[0].linhas.map((l) => l[3]), ['', '', 'foto não veio'], 'a linha que TEM endereço de foto mas a foto não veio diz isso na célula; a que tem foto e a que nunca teve ficam em branco');
    /* dois cliques: uma planilha */
    const j3 = { createImageBitmap() {} }; const c3 = await cena(j3); j3.PlanilhaXlsxFotos = falsoX(c3.obs, { trava: true }); c3.obs.btn = c3.els.pcCsv;
    c3.els.pcCsv.click(); await fim(); c3.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c3.obs.fotos.length, c3.els.pcCsv.disabled], [1, true], 'o segundo clique, com a primeira em andamento, não começa outra');
    c3.obs.soltar(); await fim(); assert.deepStrictEqual([c3.obs.salvar.length, c3.els.pcCsv.disabled], [1, false]);
    /* a planilha com fotos falhou (na busca ou na montagem): sai a antiga, e a tela diz */
    for (const op of [{ estoura: true }, { montarEstoura: true }]) {
      const j4 = { createImageBitmap() {} }; const c4 = await cena(j4); j4.PlanilhaXlsxFotos = falsoX(c4.obs, op); c4.obs.btn = c4.els.pcCsv;
      await c4.els.pcCsv.click(); await fim();
      assert.deepStrictEqual([c4.obs.salvar.length, c4.obs.blobs.length, c4.obs.blobs[0][1], /\.xls$/.test(c4.obs.baixados[0]), c4.els.pcCsv.disabled, c4.els.pcCsv.textContent], [0, 1, 'application/vnd.ms-excel;charset=utf-8', true, false, 'baixar planilha'], 'falhou a nova → baixa a antiga: ' + JSON.stringify(op));
      assert.ok(/formato antigo, sem imagem/.test(c4.els.pcXlsInfo.textContent));
    }
    /* sem a peça, ou navegador que não sabe encolher imagem: a planilha antiga, como sempre foi */
    for (const jx of [{}, { createImageBitmap() {} }, { PlanilhaXlsxFotos: { baixarFotos() { throw new Error('não era pra chamar'); } } }]) {
      const c5 = await cena(jx); await c5.els.pcCsv.click(); await fim();
      assert.deepStrictEqual([c5.obs.blobs.length, /^plano-de-compra-\d{4}-\d{2}-\d{2}\.xls$/.test(c5.obs.baixados[0])], [1, true], 'sem a peça nova, baixa a planilha antiga');
    }
    /* sem linhas: não faz nada */
    const j6 = { createImageBitmap() {} }; const c6 = await cena(j6); j6.PlanilhaXlsxFotos = falsoX(c6.obs); c6.obs.btn = c6.els.pcCsv;
    c6.els.pcFiltro._ev.input({ target: { value: 'nada-casa-com-isso' } }); await c6.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c6.obs.fotos.length, c6.obs.blobs.length], [0, 0]);
  }
  console.log('ok — Plano de Compra, a planilha com a foto em cada linha: o .xlsx é íntegro (número é número, texto não vira fórmula, cada foto DENTRO da célula da linha dela, no modelo do dono: centralizado, link, R$, saldo em vermelho/verde), a busca das fotos não derruba a planilha, a rota da foto só busca o que o plano guardou (https, máquina de verdade, só imagem), e o botão baixa .xlsx com as 14 colunas + a Foto na C — ou a planilha antiga, se a nova falhar');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
