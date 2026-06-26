// ═══════════════════════════════════════════════════════════════════════════
//  fusao-etiqueta.js  —  funde ETIQUETA (ZPL) + DANFE numa etiqueta só
//
//  3 modos, escolhidos automático pelo tipo de etiqueta:
//   • 'fusao'        → etiqueta texto-ZPL (ML, Magalu): encolhe e cola a TIRA
//                      completa da DANFE (cabeçalho + NF/Série/Emissão +
//                      código de barras da chave + chave).
//   • 'linha-raster' → etiqueta IMAGEM (raster, ex: TikTok): a imagem não
//                      encolhe, mas a chave/barcode JÁ vêm nela → cola só 1
//                      LINHA de texto no rodapé (NF/Série/Emissão/Natureza),
//                      que cabe no espaço que sobra. 1 etiqueta, sem encolher.
//   • 'declinou'     → imagem enche a etiqueta inteira (sem espaço nem p/ 1
//                      linha) → mantém as 2 etiquetas (fallback seguro).
//
//  Robusto a mudanças: não conhece marketplaces; decide pelo formato do ZPL.
//  Tudo nativo (não vira imagem). Módulo STANDALONE: funções puras.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
function fmtChave(ch) { return onlyDigits(ch).replace(/(\d{4})(?=\d)/g, '$1 ').trim(); }
function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10).split('-').reverse().join('/');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const esc = (s) => String(s == null ? '' : s).replace(/[\\^~]/g, ' ');

const ALT_ETIQUETA = 1200;
const FUNDO_SEGURO = 1170;
const CONTENT_MAX  = 1185;   // conteúdo nunca passa disso (1200 - offset ^LH)
const GAP = 16;

function qrModulos(nb) {
  const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];  // byte EC-M, v1..10
  for (let i = 0; i < cap.length; i++) if (nb <= cap[i]) return 17 + 4 * (i + 1);
  return 17 + 4 * cap.length;
}
function linhasReais(texto, fbW, fontH, maxLin) {
  const tl = String(texto || '').replace(/_[0-9A-Fa-f]{2}/g, 'x').length;
  const cpl = Math.max(1, Math.floor(fbW / (fontH * 0.58)));
  return Math.min(maxLin, Math.max(1, Math.ceil(tl / cpl)));
}

// ═══ mede até onde vai o conteúdo do 1º label (y relativo ao ^LH) ═══
function medirAlturaZPL(zpl) {
  const m = String(zpl).match(/\^XA[\s\S]*?\^XZ/);
  const corpo = m ? m[0] : String(zpl);
  let maxY = 0;
  let curBY = 2;   // ^BY corrente (largura de módulo) — afeta o comprimento de barcode girado
  const re = /\^FO(\d+),(\d+)([\s\S]*?)(?=\^FO|\^XZ|$)/g;
  let g;
  while ((g = re.exec(corpo))) {
    const y = parseInt(g[2], 10);
    const bloco = g[3];
    let alt = 0;
    const fd = bloco.match(/\^FD([\s\S]*?)\^FS/);
    const fa = bloco.match(/\^A0N,(\d+),\d+/);
    if (fa) {
      const h = parseInt(fa[1], 10);
      let nlin = 1;
      const fb = bloco.match(/\^FB(\d+),(\d+)/);
      if (fb) nlin = linhasReais(fd ? fd[1] : '', parseInt(fb[1], 10), h, parseInt(fb[2], 10) || 1);
      alt = h * nlin;
    }
    const gf = bloco.match(/\^GFA,\d+,(\d+),(\d+)/);
    if (gf) alt = Math.floor(parseInt(gf[1], 10) / parseInt(gf[2], 10));
    const q = bloco.match(/\^BQN,\d+,(\d+)/);
    if (q) alt = qrModulos(fd ? fd[1].length : 0) * parseInt(q[1], 10);
    const bc = bloco.match(/\^BCN,(\d+)/);
    if (bc) alt = parseInt(bc[1], 10);
    const gb = bloco.match(/\^GB(\d+),(\d+)/);
    if (gb) alt = Math.max(parseInt(gb[2], 10), 2);
    // barcode GIRADO (vertical): a extensão p/ baixo é o COMPRIMENTO (dados × módulos × ^BY)
    const byB = bloco.match(/\^BY(\d+)/); if (byB) curBY = parseInt(byB[1], 10);
    if (/\^B3[RB]/.test(bloco) && fd) alt = Math.max(alt, (fd[1].replace(/\s/g, '').length + 2) * 16 * curBY);  // Code39 girado
    if (/\^BC[RB]/.test(bloco) && fd) alt = Math.max(alt, fd[1].replace(/\s/g, '').length * 11 * curBY + 35);    // Code128 girado
    if (y + alt > maxY) maxY = y + alt;
  }
  return maxY;
}

// ═══ escala posições/fontes/QR/Code128/caixas do 1º label por um fator ═══
function escalarEtiquetaZPL(zpl, f) {
  const m = String(zpl).match(/([\s\S]*?\^XA[\s\S]*?\^XZ)([\s\S]*)/);
  let label = m ? m[1] : String(zpl);
  const resto = m ? m[2] : '';
  const r = (n) => Math.round(parseInt(n, 10) * f);
  label = label.replace(/\^FO(\d+),(\d+)/g, (s, x, y) => '^FO' + x + ',' + r(y));
  label = label.replace(/\^A0N,(\d+),(\d+)/g, (s, h, w) =>
    '^A0N,' + Math.max(14, r(h)) + ',' + Math.max(14, r(w)));
  // QR: encolhe proporcional (acompanha o layout p/ não sobrepor), piso 3 p/ continuar bipável
  label = label.replace(/\^BQN,(\d+),(\d+)/g, (s, mo, mg) =>
    '^BQN,' + mo + ',' + Math.max(3, r(mg)));
  label = label.replace(/\^BCN,(\d+)/g, (s, h) => '^BCN,' + Math.max(50, r(h)));
  // ^BY (largura de módulo): encolher ENCURTA o barcode girado (vertical). Min 2 p/ não sumir.
  label = label.replace(/\^BY(\d+)/g, (s, w) => '^BY' + Math.max(2, r(w)));
  label = label.replace(/\^GB(\d+),(\d+),(\d+)/g, (s, w, h, t) =>
    '^GB' + w + ',' + r(h) + ',' + t);
  return label + resto;
}

// ═══ TIRA compacta da DANFE (texto-ZPL) começando em yBase ═══
function tiraDanfeZPL(d, yBase) {
  const W = 800, ML = 16, cw = W - 32;
  const z = [];
  let y = yBase;
  const lin = (s, h, j) => {
    z.push('^FO' + ML + ',' + y + '^A0N,' + h + ',' + h +
      '^FB' + cw + ',1,0,' + (j || 'C') + ',0^FD' + esc(s) + '^FS');
  };
  z.push('^FO' + ML + ',' + y + '^GB' + cw + ',3,3^FS'); y += 12;
  lin('DANFE SIMPLIFICADO - ETIQUETA', 28, 'C'); y += 34;
  const tipo = String(d.tipo) === '0' ? '0-Entrada' : '1-Saida';
  lin(tipo + '   NFe ' + (d.numero || '') + '   Serie ' + (d.serie || '1') +
    '   ' + fmtData(d.dataEmissao), 22, 'C'); y += 28;
  const chave = onlyDigits(d.chave);
  if (chave.length >= 40) {
    const byW = 2;
    const nPares = Math.ceil(chave.length / 2);
    const bcW = (11 * (nPares + 2) + 13) * byW;
    const bcX = Math.max(ML, Math.round(ML + (cw - bcW) / 2));
    z.push('^FO' + bcX + ',' + y + '^BY' + byW + '^BCN,80,N,N,N,A^FD' + chave + '^FS'); y += 88;
    lin(fmtChave(chave), 18, 'C'); y += 24;
  }
  return { zpl: z.join('\n'), alturaTotal: y - yBase };
}

// ═══ natureza pode vir como objeto {id,descricao} do Bling → extrai o texto ═══
function natTxt(n) {
  if (n == null) return 'Venda';
  if (typeof n === 'object') return n.descricao || n.nome || 'Venda';
  const s = String(n).trim();
  return s || 'Venda';
}

// ═══ LINHA da NF p/ etiqueta-imagem (raster) — cabeçalho + 1 linha, sem barcode ═══
//     (a chave + código de barras já vêm na imagem do TikTok)
function linhaNFRasterZPL(d, fimImagem) {
  const nat = esc(natTxt(d.natureza)).slice(0, 30);
  const info = 'NF-e ' + (d.numero || '') + '   Serie ' + (d.serie || '1') +
    '   ' + fmtData(d.dataEmissao) + '   ' + nat;
  return '^FO16,' + (fimImagem + 3)  + '^GB768,2,2^FS\n' +
    '^FO16,' + (fimImagem + 8)  + '^A0N,18,18^FB768,1,0,C,0^FDDANFE - NF-e SIMPLIFICADA^FS\n' +
    '^FO16,' + (fimImagem + 28) + '^A0N,16,16^FB768,1,0,C,0^FD' + esc(info) + '^FS';
}

// ═══ FUNDE — escolhe o modo automático pelo tipo da etiqueta ═══
function fundirEtiquetaComDanfe(zplEtiqueta, dados) {
  const z = String(zplEtiqueta);
  // PROTECAO: se a etiqueta JA traz a chave da NF (ex: Shopee vem fundida), nao funde de novo.
  const _chaveNF = onlyDigits(dados && dados.chave);
  if (_chaveNF.length === 44 && onlyDigits(z).includes(_chaveNF)) {
    return { modo: 'ja-fundida', zpl: z };
  }
  const amostra = tiraDanfeZPL(dados, 0);
  const stripH = amostra.alturaTotal;
  // maior imagem ^GFA (não encolhe via ZPL)
  let maxGfaH = 0;
  for (const gm of z.matchAll(/\^GFA,\d+,(\d+),(\d+)/g)) {
    const h = Math.floor(parseInt(gm[1], 10) / parseInt(gm[2], 10));
    if (h > maxGfaH) maxGfaH = h;
  }
  // RASTER: imagem grande não cabe a tira inteira
  if (maxGfaH + GAP + stripH > CONTENT_MAX) {
    const fimImagem = Math.min(medirAlturaZPL(z), CONTENT_MAX);
    const livre = CONTENT_MAX - fimImagem;
    if (livre >= 44) {   // cabe 1 linha (separador + até 2 linhas de texto)
      return { modo: 'linha-raster', raster: true, fimImagem, livre, maxGfaH,
        zpl: z.replace(/\^XZ/, linhaNFRasterZPL(dados, fimImagem) + '\n^XZ') };
    }
    return { modo: 'declinou', raster: true, maxGfaH, zpl: z,
      motivo: 'imagem enche a etiqueta — sem espaço nem pra 1 linha; manter as 2 etiquetas' };
  }
  // TEXTO-ZPL: fusão completa (encolhe + tira)
  let maxY = Math.min(medirAlturaZPL(z), CONTENT_MAX);
  const mLH = z.match(/\^LH\d+,(\d+)/);
  const LH_Y = mLH ? parseInt(mLH[1], 10) : 0;
  let fator = 1;
  if (LH_Y + maxY + GAP + stripH > FUNDO_SEGURO) {
    fator = (FUNDO_SEGURO - LH_Y - GAP - stripH) / maxY;
  }
  if (!(fator > 0.05 && fator <= 1)) fator = Math.min(1, Math.max(0.5, fator));
  const etqEscalada = fator < 1 ? escalarEtiquetaZPL(z, fator) : z;
  const novoMaxY = Math.round(maxY * fator);
  const tira = tiraDanfeZPL(dados, novoMaxY + GAP);
  return { modo: 'fusao', raster: false, fator, maxY, novoMaxY, stripH,
    fundoFinal: LH_Y + novoMaxY + GAP + stripH,
    zpl: etqEscalada.replace(/\^XZ/, tira.zpl + '\n^XZ') };
}

module.exports = {
  fundirEtiquetaComDanfe,
  medirAlturaZPL,
  escalarEtiquetaZPL,
  tiraDanfeZPL,
  linhaNFRasterZPL,
};
