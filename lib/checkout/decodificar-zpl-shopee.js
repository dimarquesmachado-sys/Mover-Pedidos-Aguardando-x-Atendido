'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DECODIFICADOR DAS ETIQUETAS ZPL DA SHOPEE — PEÇA ÚNICA (30/10/2026; era da GOOD, good-checkout-offline/index.js).
   O ZPL da Shopee é imagem: a chave da NF-e (CODE128) e o tracking (QR) moram DENTRO do bitmap. decodificarZplShopee(txt)
   → [{ nf, tracking, zpl }] (zxing-wasm, carregado na 1ª chamada). Usado pelas etiquetas em massa (lib/checkout/rotas-lote).
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

// ─── DECODIFICADOR DAS ETIQUETAS RASTER DA SHOPEE (b18) ─────────────────────────────
// O ZPL da Shopee é 100% imagem (par ~DG + ^XA^XG por etiqueta, zero ^FD). A identidade
// de cada etiqueta vem dos códigos DENTRO do bitmap: chave da NF-e (CODE128 da DANFE,
// 44 dígitos — o nº da NF são os dígitos 26–34) e tracking BR no QR. Decodificação por
// zxing-wasm, validada 31/31 no lote real de 11/08. Carregamento LAZY (o wasm só sobe
// à primeira chamada; se o pacote faltar no deploy, o erro volta claro na resposta).
let _zx = null;
async function _zxReader() {
  if (_zx) return _zx;
  const { prepareZXingModule, readBarcodes } = require('zxing-wasm/reader');
  // o require.resolve aponta pro build cjs (dist/cjs/reader/…); o .wasm mora em dist/reader/.
  // Procuramos nos candidatos e usamos o primeiro que existir — falha vira erro claro na rota.
  const _base = path.dirname(require.resolve('zxing-wasm/reader'));
  const _cands = [
    path.join(_base, 'zxing_reader.wasm'),
    path.join(_base, '..', '..', 'reader', 'zxing_reader.wasm'),
    path.join(_base, '..', 'reader', 'zxing_reader.wasm')
  ];
  const wasmPath = _cands.find(c => { try { return fs.existsSync(c); } catch (e) { return false; } });
  if (!wasmPath) throw new Error('zxing_reader.wasm não encontrado (candidatos: ' + _cands.join(' | ') + ')');
  const wb = fs.readFileSync(wasmPath);
  prepareZXingModule({ overrides: { wasmBinary: wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength) }, fireImmediately: true });
  _zx = readBarcodes;
  return _zx;
}
async function decodificarZplShopee(txt) {
  const readBarcodes = await _zxReader();
  const zlibD = require('zlib');
  const ms = [...String(txt).matchAll(/~DG[A-Z]:[A-Z0-9_.]+,(\d+),(\d+),:Z64:([A-Za-z0-9+\/=]+)/g)];
  const cortes = ms.map(m => m.index);
  const saida = [];
  for (let k = 0; k < ms.length; k++) {
    const fatia = txt.slice(cortes[k], k + 1 < cortes.length ? cortes[k + 1] : txt.length);
    const item = { zpl: fatia, nf: null, chave: null, tracking: null };
    try {
      const total = Number(ms[k][1]), rb = Number(ms[k][2]);
      const raw = zlibD.inflateSync(Buffer.from(ms[k][3], 'base64'));
      const w = rb * 8, h = Math.floor(total / rb);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < raw.length && i < rb * h; i++) {
        const b = raw[i];
        for (let bit = 0; bit < 8; bit++) { const v = ((b >> (7 - bit)) & 1) ? 0 : 255; const o = (i * 8 + bit) * 4; rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255; }
      }
      const res = await readBarcodes({ data: rgba, width: w, height: h }, { formats: ['Code128', 'QRCode'], tryHarder: true, maxNumberOfSymbols: 8 });
      for (const r of res) {
        const s = String(r.text || '');
        if (!item.chave && /^\d{44}$/.test(s)) { item.chave = s; item.nf = Number(s.slice(25, 34)); }
        if (!item.tracking && /^BR[0-9A-Z]{10,}$/.test(s)) item.tracking = s;
      }
    } catch (e) {}
    saida.push(item);
  }
  return saida;
}

module.exports = { decodificarZplShopee };
