// ════════════════════════════════════════════════════════════════════════
//  girassol-backup-offline · módulo comum  (extraído do index.js — Lote 1)
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

// ATENCAO — keywords diferem por empresa (nao sincronizar cegamente com a GOOD!):
// - GIRASSOL: Entrega Direta da Shopee chega do Bling como "Entrega Direta" → keyword abaixo cobre.
//   "Logistica Shopee" aqui = PONTO DE COLETA (retirada pelo comprador) → NAO e FLEX, nao incluir!
// - GOOD: la e o contrario — a integracao rotula a Entrega Direta como "Logistica Shopee",
//   por isso o comum.js da GOOD TEM a keyword 'logistica shopee' a mais.
const FLEX_KEYWORDS = ['mercado envios flex', 'entrega local', 'vapt', 'entrega direta'];

function servicoDoPedido(det) {
  if (!det) return '';
  const t = det.transporte || {};
  const vol = (t.volumes && t.volumes[0]) || {};
  return String(vol.servico || t.servico || '').trim();
}

function ehFlex(servico) {
  const s = String(servico || '').toLowerCase();
  return FLEX_KEYWORDS.some(k => s.includes(k));
}

function cronDeveriaTerRodado() {
  try {
    const horas = (CRON_EXPR.trim().split(/\s+/)[1] || '*');
    if (horas === '*') return true;
    const m = horas.match(/^(\d+)-(\d+)$/);
    if (!m) return true;                                 // formato inesperado → não bloqueia o check
    const ini = Number(m[1]), fim = Number(m[2]);
    const now = new Date(), h = now.getHours();
    if (h < ini || h > fim) return false;                // fora da janela → cron não roda
    if (h === ini && now.getMinutes() < 20) return false; // 1º slot do dia — dá folga até ini:20
    return true;
  } catch (e) { return true; }
}

function kitIncompletoNoCache(id) {
  const snap = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
  if (!snap || !Array.isArray(snap.itens)) return false;
  return snap.itens.some(it => it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.some(c => !c.sku));
}

function zplEscape(s) {
  return String(s == null ? '' : s).replace(/[\^~]/g, ' ').replace(/[\x00-\x1f]/g, '').trim();
}

function bannerVolumeZpl(vol, total, numero, cliente) {
  const c = zplEscape(cliente);
  return '^XA\n^CI28\n'
    + '^FO40,290^GB736,520,8^FS\n'
    + '^FO40,340^A0N,140,140^FB736,2,0,C^FDVOLUME ' + vol + '/' + total + '^FS\n'
    + '^FO40,650^A0N,50,50^FB736,1,0,C^FDPedido ' + zplEscape(numero) + '^FS\n'
    + (c ? '^FO40,720^A0N,40,40^FB736,1,0,C^FD' + c + '^FS\n' : '')
    + '^XZ\n';
}

module.exports = { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl };
