// ═══════════════════════════════════════════════════════════════════════════
//  fusao-etiqueta.js  —  funde ETIQUETA (ZPL) + tira da DANFE numa etiqueta só
//
//  Pra quê: ML/Amazon/Magalu/TikTok mandam etiqueta de postagem e DANFE
//  SEPARADAS pela API → 2 etiquetas por pedido. Aqui a gente cola uma tira
//  compacta da DANFE (igual Amazon/Shopee fazem) no rodapé da etiqueta de
//  postagem, gerando UMA etiqueta só → economiza papel e adesivo.
//  (Shopee NÃO precisa — já vem fundida nativa pela própria API.)
//
//  Cabe na 10x15: a função ENCOLHE a etiqueta só o necessário pra abrir
//  espaço, e cola a tira embaixo. Se a etiqueta for leve, NÃO encolhe.
//  Funciona nos 2 tipos de etiqueta ML: Flex (QR grande) e Coletas/Mercado
//  Envios (destino gigante + código de barras do envio).
//
//  Tudo nativo em ZPL (não vira imagem) → nítido e instantâneo na Zebra.
//  Módulo STANDALONE: funções puras, sem require de nada.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ─── helpers de formatação (mesma lógica do danfe-simplificado.js, inline) ───
const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
function fmtChave(ch) { return onlyDigits(ch).replace(/(\d{4})(?=\d)/g, '$1 ').trim(); }
function fmtData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10).split('-').reverse().join('/');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── parâmetros da etiqueta 10x15 @ 203 dpi ───
const ALT_ETIQUETA = 1200;   // dots de altura da 10x15 (15cm * 8 dots/mm)
const FUNDO_SEGURO = 1170;   // limite com margem de segurança no rodapé
const CONTENT_MAX  = 1185;   // conteúdo NUNCA passa disso (trava: 1200 - offset ^LH)
const GAP = 16;              // folga entre o fim da etiqueta e a tira

// nº de módulos do QR conforme o tamanho do dado (capacidade byte, EC-M, v1..10)
function qrModulos(nb) {
  const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let i = 0; i < cap.length; i++) if (nb <= cap[i]) return 17 + 4 * (i + 1);
  return 17 + 4 * cap.length;
}

// estima quantas LINHAS um campo ^FB realmente usa (não o máximo declarado)
function linhasReais(texto, fbW, fontH, maxLin) {
  const tl = String(texto || '').replace(/_[0-9A-Fa-f]{2}/g, 'x').length; // hex → ~1 char
  const cpl = Math.max(1, Math.floor(fbW / (fontH * 0.58)));              // chars por linha
  return Math.min(maxLin, Math.max(1, Math.ceil(tl / cpl)));
}

// ═══ 1) mede até onde vai o conteúdo do 1º label ^XA..^XZ (y relativo ao ^LH) ═══
function medirAlturaZPL(zpl) {
  const m = String(zpl).match(/\^XA[\s\S]*?\^XZ/);
  const corpo = m ? m[0] : String(zpl);
  let maxY = 0;
  const re = /\^FO(\d+),(\d+)([\s\S]*?)(?=\^FO|\^XZ|$)/g;
  let g;
  while ((g = re.exec(corpo))) {
    const y = parseInt(g[2], 10);
    const bloco = g[3];
    let alt = 0;
    const fd = bloco.match(/\^FD([\s\S]*?)\^FS/);
    // texto ^A0N,h,w  (× linhas REAIS do ^FB, se houver)
    const fa = bloco.match(/\^A0N,(\d+),\d+/);
    if (fa) {
      const h = parseInt(fa[1], 10);
      let nlin = 1;
      const fb = bloco.match(/\^FB(\d+),(\d+)/);
      if (fb) nlin = linhasReais(fd ? fd[1] : '', parseInt(fb[1], 10), h, parseInt(fb[2], 10) || 1);
      alt = h * nlin;
    }
    // logo ^GFA,bytes,total,rowbytes  → altura = total/rowbytes
    const gf = bloco.match(/\^GFA,\d+,(\d+),(\d+)/);
    if (gf) alt = Math.floor(parseInt(gf[1], 10) / parseInt(gf[2], 10));
    // QR ^BQN,model,mag  → mede pelo tamanho REAL do dado (corrige QR pequeno)
    const q = bloco.match(/\^BQN,\d+,(\d+)/);
    if (q) {
      const mag = parseInt(q[1], 10);
      const nb = fd ? fd[1].length : 0;
      alt = qrModulos(nb) * mag;
    }
    // código de barras Code128 ^BCN,h,...  → altura = h
    const bc = bloco.match(/\^BCN,(\d+)/);
    if (bc) alt = parseInt(bc[1], 10);
    // caixa/linha ^GB w,h,t
    const gb = bloco.match(/\^GB(\d+),(\d+)/);
    if (gb) alt = Math.max(parseInt(gb[2], 10), 2);
    if (y + alt > maxY) maxY = y + alt;
  }
  return maxY;
}

// ═══ 2) escala posições/fontes/QR/Code128/caixas do 1º label por um fator ═══
//     (mantém o logo ^GFA no tamanho nativo — bitmap não escala bem; fica no
//      topo e o resto flui abaixo). ^BY (largura das barras) NÃO escala → barras
//      continuam grossas o suficiente pra bipar.
function escalarEtiquetaZPL(zpl, f) {
  const m = String(zpl).match(/([\s\S]*?\^XA[\s\S]*?\^XZ)([\s\S]*)/);
  let label = m ? m[1] : String(zpl);
  const resto = m ? m[2] : '';
  const r = (n) => Math.round(parseInt(n, 10) * f);
  // ^FO x,y → escala só o y (mantém x; largura segue 800)
  label = label.replace(/\^FO(\d+),(\d+)/g, (s, x, y) => '^FO' + x + ',' + r(y));
  // ^A0N,h,w → escala ambos proporcional (mín 14 p/ legibilidade)
  label = label.replace(/\^A0N,(\d+),(\d+)/g, (s, h, w) =>
    '^A0N,' + Math.max(14, r(h)) + ',' + Math.max(14, r(w)));
  // ^BQN,model,mag → escala a magnitude do QR (mín 5 p/ continuar bipável)
  label = label.replace(/\^BQN,(\d+),(\d+)/g, (s, mo, mg) =>
    '^BQN,' + mo + ',' + Math.max(5, r(mg)));
  // ^BCN,h,... → escala a ALTURA do Code128 (mín 50; senão sobrepõe o de baixo)
  label = label.replace(/\^BCN,(\d+)/g, (s, h) => '^BCN,' + Math.max(50, r(h)));
  // ^GB w,h,t → escala a altura h (mantém largura e espessura)
  label = label.replace(/\^GB(\d+),(\d+),(\d+)/g, (s, w, h, t) =>
    '^GB' + w + ',' + r(h) + ',' + t);
  return label + resto;
}

// ═══ 3) tira compacta da DANFE (fragmento ZPL, sem ^XA/^XZ) começando em yBase ═══
function tiraDanfeZPL(d, yBase) {
  const W = 800, ML = 16, cw = W - 32;       // margem 16 de cada lado → 768 úteis
  const z = [];
  let y = yBase;
  const esc = (s) => String(s == null ? '' : s).replace(/[\\^~]/g, ' ');
  const lin = (s, h, j) => {
    z.push('^FO' + ML + ',' + y + '^A0N,' + h + ',' + h +
      '^FB' + cw + ',1,0,' + (j || 'C') + ',0^FD' + esc(s) + '^FS');
  };
  z.push('^FO' + ML + ',' + y + '^GB' + cw + ',3,3^FS'); y += 12;     // separador
  lin('DANFE SIMPLIFICADO - ETIQUETA', 28, 'C'); y += 34;             // cabeçalho
  const tipo = String(d.tipo) === '0' ? '0-Entrada' : '1-Saida';
  lin(tipo + '   NFe ' + (d.numero || '') + '   Serie ' + (d.serie || '1') +
    '   ' + fmtData(d.dataEmissao), 22, 'C'); y += 28;                // TIPO/NF/Série/Emissão
  const chave = onlyDigits(d.chave);
  if (chave.length >= 40) {                                          // barcode + chave
    const byW = 2;
    const nPares = Math.ceil(chave.length / 2);
    const modulos = 11 * (nPares + 2) + 13;
    const bcW = modulos * byW;
    const bcX = Math.max(ML, Math.round(ML + (cw - bcW) / 2));
    z.push('^FO' + bcX + ',' + y + '^BY' + byW + '^BCN,80,N,N,N,A^FD' + chave + '^FS'); y += 88;
    lin(fmtChave(chave), 18, 'C'); y += 24;
  }
  return { zpl: z.join('\n'), alturaTotal: y - yBase };
}

// ═══ 4) FUNDE: encolhe a etiqueta só o necessário e cola a tira embaixo ═══
function fundirEtiquetaComDanfe(zplEtiqueta, dados) {
  const amostra = tiraDanfeZPL(dados, 0);
  const stripH = amostra.alturaTotal;
  // ROBUSTEZ: se a etiqueta é uma IMAGEM grande (^GFA raster — ex: TikTok),
  // não dá pra encolher via ZPL → DECLINA a fusão (o chamador mantém 2 etiquetas).
  // Pega qualquer marketplace que mande etiqueta como figura, hoje ou no futuro.
  let maxGfaH = 0;
  for (const gm of String(zplEtiqueta).matchAll(/\^GFA,\d+,(\d+),(\d+)/g)) {
    const h = Math.floor(parseInt(gm[1], 10) / parseInt(gm[2], 10));
    if (h > maxGfaH) maxGfaH = h;
  }
  if (maxGfaH + GAP + stripH > CONTENT_MAX) {
    return { raster: true, zpl: String(zplEtiqueta), maxGfaH,
      motivo: 'etiqueta é imagem (raster) — não dá pra fundir sem perder qualidade; manter as 2 etiquetas' };
  }
  let maxY = medirAlturaZPL(zplEtiqueta);                  // relativo ao ^LH
  maxY = Math.min(maxY, CONTENT_MAX);                      // TRAVA: nunca além da etiqueta física
  const mLH = String(zplEtiqueta).match(/\^LH\d+,(\d+)/);
  const LH_Y = mLH ? parseInt(mLH[1], 10) : 0;
  const espacoNecessario = LH_Y + maxY + GAP + stripH;
  let fator = 1;
  if (espacoNecessario > FUNDO_SEGURO) {
    fator = (FUNDO_SEGURO - LH_Y - GAP - stripH) / maxY;
  }
  if (!(fator > 0.05 && fator <= 1)) fator = Math.min(1, Math.max(0.5, fator)); // sanidade
  const etqEscalada = fator < 1 ? escalarEtiquetaZPL(zplEtiqueta, fator) : String(zplEtiqueta);
  const novoMaxY = Math.round(maxY * fator);
  const tira = tiraDanfeZPL(dados, novoMaxY + GAP);        // tira logo abaixo do conteúdo
  const fundida = etqEscalada.replace(/\^XZ/, tira.zpl + '\n^XZ');  // injeta antes do 1º ^XZ
  return {
    zpl: fundida, fator, maxY, novoMaxY, stripH,
    fundoFinal: LH_Y + novoMaxY + GAP + stripH,
  };
}

module.exports = {
  fundirEtiquetaComDanfe,
  medirAlturaZPL,
  escalarEtiquetaZPL,
  tiraDanfeZPL,
};
