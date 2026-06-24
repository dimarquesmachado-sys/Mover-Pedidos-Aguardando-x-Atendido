'use strict';
// etiquetas.js — etiqueta de postagem: baixa do Bling (ZPL ou PDF nativo) e converte ZPL→PDF via Labelary.

const { fs, path, fetch, garantirToken, QZ_CERT, QZ_PRIVKEY, VERSAO, BLING_BASE,
  CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE,
  EAN_INDEX_FILE, ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = require('./base');

const AdmZip = require('adm-zip');
const https = require('https');

async function baixarEtiqueta(blingId) {
  const { ok, data } = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas[]=${blingId}`);
  const item = ok && data && data.data && data.data[0];
  const link = item && item.link;
  if (!link) return null;
  try {
    const r = await fetch(link);
    if (!r.ok) return null;
    const buf = await r.buffer();
    if (!buf || buf.length < 4) return null;
    // 'PK' (0x50 0x4B) = arquivo ZIP → descompacta e pega o conteúdo
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
      try {
        const zip = new AdmZip(buf);
        const entries = zip.getEntries();
        if (!entries.length) return null;
        const ent = entries.find(e => /\.(txt|zpl)$/i.test(e.entryName)) || entries[0];
        const conteudo = ent.getData().toString('utf8');
        return conteudo || null;
      } catch (e) { return null; }
    }
    // não-zip: assume conteúdo direto (ZPL/texto)
    const txt = buf.toString('utf8');
    if (!txt || /<html|not\s*found/i.test(txt.slice(0, 200))) return null;
    return txt;
  } catch (e) { return null; }
}

async function baixarEtiquetaPDF(blingId) {
  const { ok, data } = await blingGet(`/logisticas/etiquetas?formato=PDF&idsVendas[]=${blingId}`);
  const item = ok && data && data.data && data.data[0];
  const link = item && item.link;
  if (!link) return null;
  try {
    const r = await fetch(link);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return null;
    return buf;
  } catch (e) { return null; }
}

function labelaryPost(zpl) {
  return new Promise((resolve) => {
    let data;
    try { data = Buffer.from(zpl, 'utf8'); } catch (e) { return resolve({ status: 0, buf: null }); }
    const req = https.request({
      hostname: 'api.labelary.com',
      path: '/v1/printers/8dpmm/labels/4x6/0/',
      method: 'POST',
      headers: { 'Accept': 'application/pdf', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode || 0, buf: Buffer.concat(chunks) }));
      resp.on('error', () => resolve({ status: 0, buf: null }));
    });
    req.on('error', () => resolve({ status: 0, buf: null }));
    req.setTimeout(25000, () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, buf: null }); });
    req.write(data);
    req.end();
  });
}

async function zplParaPdf(zpl) {
  if (!zpl || zpl.indexOf('^XA') < 0) return null; // não parece ZPL
  for (let t = 0; t < 4; t++) {
    const r = await labelaryPost(zpl);
    if (r.status === 200 && r.buf && r.buf.slice(0, 4).toString('latin1') === '%PDF') return r.buf;
    if (r.status === 429) { await sleep(1500 + t * 1200); continue; }   // rate limit → espera mais
    await sleep(700 + t * 500);   // queda/resposta estranha → espera e retenta
  }
  return null;
}

async function etiquetaPdf(blingId, dir) {
  // 1) PDF nativo do Bling — o Bling gera o PDF da etiqueta de qualquer marketplace
  const direto = await baixarEtiquetaPDF(blingId);
  if (direto) return direto;
  // 2) fallback offline: ZPL cacheado → Labelary
  let zpl = null;
  if (dir) { try { zpl = fs.readFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8'); } catch (e) {} }
  if (!zpl) { try { zpl = await baixarEtiqueta(blingId); } catch (e) {} }
  if (zpl && zpl.indexOf('^XA') >= 0) return await zplParaPdf(zpl);
  return null;
}


module.exports = { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf };
