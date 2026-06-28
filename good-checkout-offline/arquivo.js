// ════════════════════════════════════════════════════════════════════════
//  good-checkout-offline · módulo arquivo  (extraído do index.js — Lote 1)
// ════════════════════════════════════════════════════════════════════════
'use strict';
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const base  = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;

function purgar(man) {
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(man)) {
    const t = Date.parse(man[id].cacheado_em || 0) || 0;
    if (t && t < limite) {
      try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
      delete man[id];
    }
  }
}

function arquivarFinalizado(id) {
  try {
    const src = path.join(CACHE_DIR, String(id));
    const dst = path.join(ARQUIVO_DIR, String(id));
    ensureDir(dst);
    const fmt = ETIQ_FORMATO.toLowerCase();
    const etq = path.join(src, `etiqueta.${fmt}`);
    if (fs.existsSync(etq)) fs.copyFileSync(etq, path.join(dst, `etiqueta.${fmt}`));
    const etqPdf = path.join(src, 'etiqueta.pdf');   // etiqueta PDF (Amazon/Madeira) — capturada cedo; email usa mesmo após despacho
    if (fs.existsSync(etqPdf)) fs.copyFileSync(etqPdf, path.join(dst, 'etiqueta.pdf'));
    const ped = path.join(src, 'pedido.json');
    if (fs.existsSync(ped)) fs.copyFileSync(ped, path.join(dst, 'pedido.json'));
    const nfs = path.join(src, 'nf-simp.json');   // dados do DANFE simplificado (se já gerado) → email usa sem re-buscar
    if (fs.existsSync(nfs)) fs.copyFileSync(nfs, path.join(dst, 'nf-simp.json'));
  } catch (e) { console.log('[GOODBKP] falha ao arquivar', id, e.message); }
}

function purgarArquivo() {
  try {
    if (!fs.existsSync(ARQUIVO_DIR)) return;
    const limite = Date.now() - ARQUIVO_DIAS * 86400000;
    for (const d of fs.readdirSync(ARQUIVO_DIR)) {
      const dir = path.join(ARQUIVO_DIR, d);
      try { const st = fs.statSync(dir); if (st.isDirectory() && st.mtimeMs < limite) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
}

function purgarConferidos() {
  const conf = readJson(CONFERIDOS_FILE, {});
  const limite = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let mudou = false;
  for (const id of Object.keys(conf)) {
    const c = conf[id];
    const t = Date.parse((c && c.conferido_em) || 0) || 0;
    if (c && c.sincronizado && t && t < limite) { delete conf[id]; mudou = true; }
  }
  if (mudou) writeJson(CONFERIDOS_FILE, conf);
}

module.exports = { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos };
