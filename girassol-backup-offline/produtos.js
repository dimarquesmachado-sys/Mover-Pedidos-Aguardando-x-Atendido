// ════════════════════════════════════════════════════════════════════════
//  girassol-backup-offline · módulo produtos  (extraído do index.js — Lote 1)
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

let _prodCache = new Map();
function limparProdCache() { _prodCache = new Map(); }   // rodarCiclo chama p/ zerar o cache de produto por ciclo

function getPossiveisGtins(obj) {
  if (!obj) return [];
  const c = [
    obj.gtin, obj.ean, obj.codigoBarras, obj.gtinEan, obj.gtinTributario,
    obj.codigo_barras, obj.codigoDeBarras, obj.codBarras, obj.codigobarras,
    obj.gtinEmbalagem, obj.gtin_embalagem, obj.codigoBarrasTributario,
    obj.eanTributario, obj.gtinEanTributario,
    obj.tributavel && obj.tributavel.gtin, obj.tributavel && obj.tributavel.ean,
    obj.tributacao && obj.tributacao.gtin, obj.tributacao && obj.tributacao.ean,
    obj.tributario && obj.tributario.gtin, obj.tributario && obj.tributario.ean
  ];
  if (obj.tributacao) {
    Object.values(obj.tributacao).forEach(v => { if (typeof v === 'string' && v.length >= 8) c.push(v); });
  }
  return c.filter(Boolean).map(String);
}

function primeiroEan(produto) {
  const g = getPossiveisGtins(produto);
  return g.find(x => /^\d{8,14}$/.test(x)) || g[0] || null;
}

function primeiraImagem(prod) {
  if (!prod) return null;
  if (prod.imagemURL) return prod.imagemURL;
  const ext = prod.midia && prod.midia.imagens && prod.midia.imagens.externas;
  if (ext && ext[0] && ext[0].link) return ext[0].link;
  const url = prod.midia && prod.midia.imagens && prod.midia.imagens.imagensURL;
  if (url && url[0] && (url[0].link || url[0])) return url[0].link || url[0];
  return null;
}

function localizacaoDeProduto(prod) {
  if (!prod) return '';
  const e = prod.estoque || {};
  return String(e.localizacao || prod.localizacao || '').trim();
}

async function localizacaoPorSku(sku) {
  try {
    const { ok, data } = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
    const item = ok && data && data.data && data.data[0];
    if (!item) return '';
    let loc = localizacaoDeProduto(item);
    if (!loc && item.id) { const det = await produtoDetalhe(item.id); loc = localizacaoDeProduto(det); }
    return loc || '';
  } catch (e) { return ''; }
}

function salvarNoIndiceEan(prod) {
  try {
    if (!prod || !prod.id) return;
    const eans = getPossiveisGtins(prod).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8);
    if (!eans.length) return;
    const idx = lerIndiceEan();
    let mudou = false;
    for (const e of eans) {
      const novo = { sku: prod.codigo || '', nome: prod.nome || '', id: prod.id };
      if (JSON.stringify(idx[e]) !== JSON.stringify(novo)) { idx[e] = novo; mudou = true; }
    }
    if (mudou) writeJson(EAN_INDEX_FILE, idx);
  } catch (e) {}
}

async function eanDoItem(produtoId, sku, cacheEan) {
  if (sku && Object.prototype.hasOwnProperty.call(cacheEan, sku)) return cacheEan[sku];
  let ean = null;
  try {
    if (produtoId) {
      const { data } = await blingGet(`/produtos/${produtoId}`);
      ean = primeiroEan(data && data.data);
    }
    if (!ean && sku) {
      await sleep(PAUSA_MS);
      const { data } = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      ean = primeiroEan(data && data.data && data.data[0]);
    }
  } catch (e) { /* sem scope Produtos → ean=null */ }
  if (sku) cacheEan[sku] = ean;
  return ean;
}

async function produtoDetalhe(id) {
  if (!id) return null;
  if (_prodCache.has(id)) return _prodCache.get(id);
  let prod = null;
  for (let tent = 0; tent < 2 && !prod; tent++) {       // 2 tentativas: drible de rate-limit transitório
    if (tent) await sleep(PAUSA_MS * 3);
    try {
      const r = await blingGet(`/produtos/${id}`);
      prod = (r.ok && r.data && r.data.data) ? r.data.data : null;
    } catch (e) {}
  }
  if (prod) _prodCache.set(id, prod);                   // só cacheia SUCESSO — nunca fixa uma falha (vazio)
  return prod;
}

async function infoProduto(id, cacheEan) {
  const prod = await produtoDetalhe(id);
  await sleep(PAUSA_MS);
  const sku = (prod && prod.codigo) || '';
  let ean = prod ? primeiroEan(prod) : null;
  if (sku) { if (ean) cacheEan[sku] = ean; else if (cacheEan[sku]) ean = cacheEan[sku]; }
  return { sku, ean, descricao: (prod && prod.nome) || '', img: primeiraImagem(prod), loc: localizacaoDeProduto(prod) };
}

module.exports = { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache };
