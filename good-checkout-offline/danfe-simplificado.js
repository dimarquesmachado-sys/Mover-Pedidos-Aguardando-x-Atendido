// danfe-simplificado.js — gera o DANFE Simplificado 10x15cm (igual ao que o Bling cospe na Zebra)
// Sem dependências além do pdf-lib (já no projeto). Renderização própria a partir dos dados da NF.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ─── Code128 (tabela de padrões: 6 larguras por símbolo, somando 11 módulos) ───
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];

// codifica string de dígitos (comprimento par) em Code128-C → array de larguras (módulos), alternando barra/espaço começando por barra
function code128c(digitos) {
  const vals = [105]; // Start C
  for (let i = 0; i < digitos.length; i += 2) vals.push(parseInt(digitos.substr(i, 2), 10));
  let soma = 105;
  for (let i = 1; i < vals.length; i++) soma += vals[i] * i;
  vals.push(soma % 103);   // dígito verificador
  vals.push(106);          // Stop
  const larg = [];
  for (const v of vals) for (const ch of C128[v]) larg.push(parseInt(ch, 10));
  return larg;
}

function desenharCode128(page, x, y, largura, altura, digitos) {
  const larg = code128c(digitos);
  const totalMod = larg.reduce((s, w) => s + w, 0);
  const mod = largura / totalMod;
  let cx = x, barra = true;
  for (const w of larg) {
    if (barra) page.drawRectangle({ x: cx, y, width: w * mod, height: altura, color: rgb(0, 0, 0) });
    cx += w * mod;
    barra = !barra;
  }
}

// ─── helpers ───
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
function fmtMoeda(v) { const n = Number(v || 0); return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtChave(ch) { const d = onlyDigits(ch); return d.replace(/(\d{4})(?=\d)/g, '$1 ').trim(); }
function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10).split('-').reverse().join('/');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtCpfCnpj(doc) {
  const d = onlyDigits(doc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc || '';
}
function fmtIE(ie) { const d = onlyDigits(ie); if (d.length === 12) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, '$1.$2.$3.$4'); return ie || ''; }

// quebra texto em linhas que cabem na largura (fonte monospace)
function wrap(texto, maxChars) {
  const palavras = String(texto || '').split(/\s+/);
  const linhas = []; let atual = '';
  for (const p of palavras) {
    if (!atual) { atual = p; }
    else if ((atual + ' ' + p).length <= maxChars) { atual += ' ' + p; }
    else { linhas.push(atual); atual = p; }
    while (atual.length > maxChars) { linhas.push(atual.slice(0, maxChars)); atual = atual.slice(maxChars); }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

// igual ao wrap, mas a 1ª linha usa largura menor (deixa espaço pro valor à direita) e as demais a largura cheia
function wrapItem(texto, larguraCheia, largura1a) {
  const palavras = String(texto || '').split(/\s+/);
  const linhas = []; let atual = '';
  const lim = () => (linhas.length === 0 ? largura1a : larguraCheia);
  for (const p of palavras) {
    if (!atual) { atual = p; }
    else if ((atual + ' ' + p).length <= lim()) { atual += ' ' + p; }
    else { linhas.push(atual); atual = p; }
    while (atual.length > lim()) { linhas.push(atual.slice(0, lim())); atual = atual.slice(lim()); }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

// ─── gera o PDF (Buffer) ───
// dados = { emitente:{razao,cnpj,ie,endereco}, chave, protocolo, dataProtocolo, tipo, numero, serie,
//           dataEmissao, itens:[{codigo,descricao,qtd,valorUnit,valorTotal,detalhe}], qtdTotal,
//           consumidor:{doc,nome,endereco}, numeroPedido, numeroPedidoLoja, tributos }
async function gerarDanfeSimplificado(dados) {
  const W = 283.46, H = 425.20;     // 10x15 cm em pt
  const ML = 10, MR = 10, MB = 14;  // margens (MB = rodapé mínimo)
  const cw = W - ML - MR;           // largura útil
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const fontB = await pdf.embedFont(StandardFonts.CourierBold);
  const preto = rgb(0, 0, 0);
  const charW = font.widthOfTextAtSize('0', 6.5);   // largura real de 1 caractere (Courier é monoespaçada)
  const CPL = Math.floor(cw / charW) - 1;            // chars na largura cheia (com folga de 1)

  let page, y;
  const txt = (s, opt = {}) => {
    const size = opt.size || 7;
    const f = opt.bold ? fontB : font;
    let x = ML;
    const tw = f.widthOfTextAtSize(String(s), size);
    if (opt.center) x = ML + (cw - tw) / 2;
    else if (opt.right) x = W - MR - tw;
    else if (opt.x != null) x = opt.x;
    page.drawText(String(s), { x, y, size, font: f, color: preto });
  };
  const nl = (gap) => { y -= (gap || 9); };
  const linha = () => { y -= 4; page.drawLine({ start: { x: ML, y }, end: { x: W - MR, y }, thickness: 0.6, color: preto }); y -= 11; };

  // cabeçalho de cada página (na continuação, repete o nº da NFe pra identificar a etiqueta)
  function cabecalho(cont) {
    txt('DANFE Simplificado - Etiqueta' + (cont ? ' (cont.)' : ''), { size: 8, bold: true, center: true }); nl(11);
    if (cont) { txt('NFe: ' + dados.numero + '   SERIE: ' + (dados.serie || '1'), { size: 6.5, center: true }); nl(7); linha(); }
  }
  function novaPagina(cont) { page = pdf.addPage([W, H]); y = H - 12; cabecalho(cont); }
  const espaco = (h) => { if (y - h < MB) novaPagina(true); };  // garante espaço; senão abre nova etiqueta

  // ── PÁGINA 1: emitente + chave + protocolo ──
  novaPagina(false);
  txt(dados.emitente.razao, { size: 7, bold: true }); nl(8);
  txt('CNPJ: ' + fmtCpfCnpj(dados.emitente.cnpj) + '   IE: ' + fmtIE(dados.emitente.ie), { size: 6.5 }); nl(8);
  for (const l of wrap(dados.emitente.endereco, CPL)) { txt(l, { size: 6.5 }); nl(8); }
  nl(2);
  desenharCode128(page, ML + 8, y - 26, cw - 16, 26, onlyDigits(dados.chave));
  y -= 30;
  txt(fmtChave(dados.chave), { size: 6, center: true }); nl(9);
  linha();
  if (dados.protocolo) { txt('Protocolo: ' + dados.protocolo + '  ' + fmtData(dados.dataProtocolo), { size: 6.5, center: true }); nl(8); }
  txt('TIPO: ' + (String(dados.tipo) === '0' ? '0-Entrada' : '1-Saida') + '   NFe: ' + dados.numero + '   SERIE: ' + (dados.serie || '1'), { size: 6.5, center: true }); nl(8);
  txt('Emissao: ' + fmtData(dados.dataEmissao), { size: 6.5, center: true }); nl(6);
  linha();

  // ── ITENS (paginados — quebra em nova etiqueta quando enche) ──
  txt('ITEM', { size: 6.5, bold: true });
  txt('VL. ITEM', { size: 6.5, bold: true, right: true }); nl(9);
  for (const it of (dados.itens || [])) {
    const desc = (it.codigo ? it.codigo + ' - ' : '') + (it.descricao || '');
    const valTxt = fmtMoeda(it.valorTotal != null ? it.valorTotal : it.valorUnit);
    const linhasDesc = wrapItem(desc, CPL, CPL - (valTxt.length + 2));   // 1ª linha deixa espaço pro valor
    const altura = 8 + Math.max(0, linhasDesc.length - 1) * 7 + (it.detalhe ? 7 : 0) + 1;
    espaco(altura + 4);
    txt(linhasDesc[0] || '', { size: 6.5 });
    txt(valTxt, { size: 6.5, right: true }); nl(8);
    for (let i = 1; i < linhasDesc.length; i++) { txt(linhasDesc[i], { size: 6.5 }); nl(7); }
    if (it.detalhe) { txt('  ' + it.detalhe, { size: 6 }); nl(7); }
    nl(1);
  }

  // ── bloco final (mantém junto: não quebra QTD/consumidor no meio) ──
  espaco(100);
  linha();
  txt('QTD. TOTAL DE ITENS', { size: 6.5, bold: true });
  txt(String(dados.qtdTotal != null ? dados.qtdTotal : (dados.itens || []).length), { size: 6.5, bold: true, right: true }); nl(8);
  linha();
  txt('CONSUMIDOR', { size: 7, bold: true, center: true }); nl(8);
  if (dados.consumidor) {
    const nome = (dados.consumidor.nome || '').replace(/\s*\([^)]*\)\s*$/, '');  // tira "(nick do marketplace)"
    const doc = dados.consumidor.doc ? fmtCpfCnpj(dados.consumidor.doc) + '  ' : '';
    for (const l of wrap(doc + nome, CPL)) { txt(l, { size: 6.5 }); nl(8); }
    for (const l of wrap(dados.consumidor.endereco, CPL)) { txt(l, { size: 6 }); nl(7); }
  }
  linha();

  // ── informações adicionais ──
  txt('INFORMACOES ADICIONAIS', { size: 6.5, bold: true, center: true }); nl(8);
  if (dados.numeroPedido) { txt('Numero do Pedido: ' + dados.numeroPedido, { size: 6 }); nl(7); }
  if (dados.tributos) { for (const l of wrap(dados.tributos, CPL)) { txt(l, { size: 5.8 }); nl(6.5); } }
  if (dados.numeroPedidoLoja) { txt('NF Pedido Loja: ' + dados.numeroPedidoLoja, { size: 6 }); nl(7); }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// ═══ DANFE simplificado em ZPL NATIVO (texto + ^BC) p/ Zebra 8 dots/mm (203dpi) ═══
//  Mesmo conteúdo do PDF, mas em comandos ZPL → imprime CRU (igual a etiqueta), instantâneo.
//  Coordenadas em dots: etiqueta 10x15cm = 800 x 1200 dots.
function gerarDanfeSimplificadoZPL(dados) {
  const W = 800, ML = 16, MR = 16, BOT = 1150;   // dots; BOT = limite antes de quebrar p/ nova etiqueta
  const cw = W - ML - MR;                          // 768
  const z = [];
  let y = 16;

  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, ' ').replace(/\^/g, ' ').replace(/~/g, '-');
  const cpl = (h) => Math.max(8, Math.floor(cw / (h * 0.60)));   // chars/linha p/ altura h (conservador, fonte proporcional)

  // texto numa linha (just: L/C/R) — já pré-quebrado, não deve estourar a largura
  function lin(s, h, just) {
    h = h || 22; just = just || 'L';
    z.push('^FO' + ML + ',' + y + '^A0N,' + h + ',' + h + '^FB' + cw + ',1,0,' + just + ',0^FD' + esc(s) + '^FS');
  }
  // esquerda + direita na MESMA linha (esq. encostada à esquerda, dir. à direita)
  function linLR(sL, sR, h) {
    h = h || 22;
    z.push('^FO' + ML + ',' + y + '^A0N,' + h + ',' + h + '^FD' + esc(sL) + '^FS');
    z.push('^FO' + ML + ',' + y + '^A0N,' + h + ',' + h + '^FB' + cw + ',1,0,R,0^FD' + esc(sR) + '^FS');
  }
  const nl = (g) => { y += (g || 28); };
  function hr() { y += 4; z.push('^FO' + ML + ',' + y + '^GB' + cw + ',2,2^FS'); y += 12; }

  function abrir(cont) {
    z.push('^XA', '^CI28', '^PW' + W, '^LH0,0', '^LT0');
    y = 16;
    lin('DANFE Simplificado' + (cont ? ' (cont.)' : ''), 30, 'C'); nl(38);
    if (cont) { lin('NFe ' + dados.numero + '   Serie ' + (dados.serie || '1'), 20, 'C'); nl(26); hr(); }
  }
  function fechar() { z.push('^XZ'); }
  function espaco(h) { if (y + h > BOT) { fechar(); abrir(true); } }   // sem espaço → fecha e abre nova etiqueta

  // bloco multi-linha (quebra por palavra) — avança y por linha, paginando se precisar
  function bloco(s, h, just) {
    h = h || 20; just = just || 'L';
    for (const ln of wrap(s, cpl(h))) { espaco(h + 8); lin(ln, h, just); nl(h + 8); }
  }

  // ─── PÁGINA 1: emitente + chave + protocolo ───
  abrir(false);
  lin(dados.emitente.razao, 26, 'L'); nl(34);
  lin('CNPJ ' + fmtCpfCnpj(dados.emitente.cnpj) + '   IE ' + fmtIE(dados.emitente.ie), 20, 'L'); nl(28);
  bloco(dados.emitente.endereco, 20, 'L');
  nl(8);

  // código de barras Code128 da chave (centralizado)
  const chaveDig = onlyDigits(dados.chave);
  if (chaveDig.length >= 2) {
    const byW = 2;
    const nPares = Math.ceil(chaveDig.length / 2);
    const modulos = 11 * (nPares + 2) + 13;        // start + dados + check (11 cada) + stop (13)
    const bcW = modulos * byW;
    const bcX = Math.max(ML, Math.round(ML + (cw - bcW) / 2));
    espaco(130);
    z.push('^FO' + bcX + ',' + y + '^BY' + byW + '^BCN,90,N,N,N,A^FD' + chaveDig + '^FS');
    y += 98;
    lin(fmtChave(dados.chave), 18, 'C'); nl(26);
  }
  hr();
  if (dados.protocolo) { lin('Protocolo ' + dados.protocolo + '  ' + fmtData(dados.dataProtocolo), 18, 'C'); nl(24); }
  lin('TIPO ' + (String(dados.tipo) === '0' ? '0-Entrada' : '1-Saida') + '   NFe ' + dados.numero + '   Serie ' + (dados.serie || '1'), 18, 'C'); nl(24);
  lin('Emissao ' + fmtData(dados.dataEmissao), 18, 'C'); nl(22);
  hr();

  // ─── ITENS ───
  linLR('ITEM', 'VL. ITEM', 20); nl(28);
  for (const it of (dados.itens || [])) {
    const desc = (it.codigo ? it.codigo + ' - ' : '') + (it.descricao || '');
    const valTxt = fmtMoeda(it.valorTotal != null ? it.valorTotal : it.valorUnit);
    const linhas = wrapItem(desc, cpl(20), cpl(20) - (valTxt.length + 2));   // 1ª linha deixa espaço pro valor
    espaco(64);
    // 1ª linha: descrição (1º trecho) + valor à direita
    z.push('^FO' + ML + ',' + y + '^A0N,20,20^FD' + esc(linhas[0] || '') + '^FS');
    z.push('^FO' + ML + ',' + y + '^A0N,20,20^FB' + cw + ',1,0,R,0^FD' + esc(valTxt) + '^FS');
    nl(26);
    for (let i = 1; i < linhas.length; i++) { espaco(26); lin(linhas[i], 20, 'L'); nl(26); }
    if (it.detalhe) { espaco(24); lin('  ' + it.detalhe, 18, 'L'); nl(24); }
    nl(4);
  }

  // ─── bloco final (QTD + consumidor + info) ───
  espaco(70); hr();
  linLR('QTD. TOTAL DE ITENS', String(dados.qtdTotal != null ? dados.qtdTotal : (dados.itens || []).length), 20); nl(28);
  hr();
  lin('CONSUMIDOR', 24, 'C'); nl(32);
  if (dados.consumidor) {
    const nome = (dados.consumidor.nome || '').replace(/\s*\([^)]*\)\s*$/, '');   // tira "(nick do marketplace)"
    const doc = dados.consumidor.doc ? fmtCpfCnpj(dados.consumidor.doc) + '  ' : '';
    bloco(doc + nome, 20, 'L');
    bloco(dados.consumidor.endereco, 18, 'L');
  }
  hr();
  lin('INFORMACOES ADICIONAIS', 20, 'C'); nl(26);
  if (dados.numeroPedido) { espaco(24); lin('Numero do Pedido: ' + dados.numeroPedido, 18, 'L'); nl(24); }
  if (dados.tributos) bloco(dados.tributos, 17, 'L');
  if (dados.numeroPedidoLoja) { espaco(24); lin('NF Pedido Loja: ' + dados.numeroPedidoLoja, 18, 'L'); nl(24); }

  fechar();
  return z.join('\n');
}

// tira COMPACTA da NF (só o essencial: cabeçalho + NF-e/Série/data/natureza + barcode + chave)
// é o que vai EMBAIXO da etiqueta Melhor Envio (não a DANFE inteira)
async function gerarTiraNF(dados) {
  const W = 283.46;                 // 10 cm em pt
  const ML = 10, MR = 10;
  const cw = W - ML - MR;
  const pdf = await PDFDocument.create();
  const font  = await pdf.embedFont(StandardFonts.Courier);
  const fontB = await pdf.embedFont(StandardFonts.CourierBold);
  const preto = rgb(0, 0, 0);
  const H = 82;
  const page = pdf.addPage([W, H]);
  let y = H - 12;
  const put = (s, size, bold) => {
    const f = bold ? fontB : font;
    const tw = f.widthOfTextAtSize(String(s), size);
    page.drawText(String(s), { x: ML + (cw - tw) / 2, y, size, font: f, color: preto });
  };
  const nat = (typeof dados.natureza === 'object')
    ? (dados.natureza.descricao || dados.natureza.nome || 'Venda')
    : (String(dados.natureza || '').trim() || 'Venda');
  put('DANFE Simplificado - Etiqueta', 8, true); y -= 13;
  put('NF-e ' + dados.numero + '   Serie ' + (dados.serie || '1') + '   ' + fmtData(dados.dataEmissao) + '   ' + nat, 6.5, false); y -= 10;
  desenharCode128(page, ML + 8, y - 26, cw - 16, 26, onlyDigits(dados.chave)); y -= 30;
  put(fmtChave(dados.chave), 6, false);
  return Buffer.from(await pdf.save());
}

module.exports = { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, code128c, gerarTiraNF };
