// ════════════════════════════════════════════════════════════════════════
//  girassol-backup-offline · módulo separacao  (extraído do index.js — Lote 1)
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

function montarSeparacao(mktFiltro) {
  const man = manifest();
  const conf = readJson(CONFERIDOS_FILE, {});
  const loc = locCache();
  const mapa = {};       // sku -> { sku, descricao, ean, loc, qtd }
  const counts = {};     // marketplace -> nº de pedidos (não-finalizados)
  let pedidos = 0;
  for (const id of Object.keys(man)) {
    if (conf[id]) continue;                              // já finalizado → fora da separação
    if (!man[id].tem_etiqueta) continue;                 // sem etiqueta → fora da separação (não dá pra despachar)
    const snap = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
    if (!snap) continue;
    const mkt = snap.marketplace || 'outro';
    counts[mkt] = (counts[mkt] || 0) + 1;
    if (mktFiltro && mkt !== mktFiltro) continue;
    pedidos++;
    const add = (sku, ean, descricao, qtd) => {
      const k = sku || '(sem SKU)';
      if (!mapa[k]) mapa[k] = { sku: k, descricao: descricao || '', ean: ean || '', loc: loc[k] || '', qtd: 0 };
      mapa[k].qtd += Number(qtd || 0);
      if (!mapa[k].ean && ean) mapa[k].ean = ean;
      if (!mapa[k].descricao && descricao) mapa[k].descricao = descricao;
    };
    for (const it of (snap.itens || [])) {
      if (it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.length) {
        for (const c of it.componentes) add(c.sku, c.ean, c.descricao, c.qtd);
      } else {
        add(it.sku, it.ean, it.descricao, it.qtd);
      }
    }
  }
  // ordena por LOCALIZAÇÃO (ordem de picking; vazias por último), depois por SKU
  const linhas = Object.values(mapa).sort((a, b) => {
    const la = a.loc || '', lb = b.loc || '';
    if (!la && lb) return 1;
    if (la && !lb) return -1;
    if (la !== lb) return la.localeCompare(lb, 'pt', { numeric: true });
    return String(a.sku).localeCompare(String(b.sku));
  });
  const total_itens = linhas.reduce((s, l) => s + l.qtd, 0);
  return { ok: true, mkt: mktFiltro || null, pedidos, total_skus: linhas.length, total_itens, counts, linhas };
}

function montarSeparacaoPorPedido(mktFiltro) {
  const man = manifest();
  const conf = readJson(CONFERIDOS_FILE, {});
  const loc = locCache();
  const lista = [];
  const counts = {};
  for (const id of Object.keys(man)) {
    if (conf[id]) continue;                                // já finalizado → fora
    if (!man[id].tem_etiqueta) continue;                   // sem etiqueta → fora (não despacha)
    const snap = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
    if (!snap) continue;
    const mkt = snap.marketplace || 'outro';
    counts[mkt] = (counts[mkt] || 0) + 1;
    if (mktFiltro && mkt !== mktFiltro) continue;
    const itens = [];
    const add = (sku, ean, descricao, qtd) => itens.push({ sku: sku || '(sem SKU)', ean: ean || '', descricao: descricao || '', loc: loc[sku] || '', qtd: Number(qtd || 0) });
    for (const it of (snap.itens || [])) {
      if (it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.length) {
        for (const c of it.componentes) add(c.sku, c.ean, c.descricao, c.qtd);
      } else { add(it.sku, it.ean, it.descricao, it.qtd); }
    }
    itens.sort((a, b) => { const la = a.loc || '', lb = b.loc || ''; if (!la && lb) return 1; if (la && !lb) return -1; return la.localeCompare(lb, 'pt', { numeric: true }); });
    lista.push({ numero: snap.numero || id, marketplace: mkt, cliente: snap.cliente || '', nf: (snap.nf && snap.nf.numero) || '', tem_etiqueta: true, tem_nf: !!(snap.nf && snap.nf.numero), itens });
  }
  lista.sort((a, b) => String(a.numero).localeCompare(String(b.numero), 'pt', { numeric: true }));
  const total_itens = lista.reduce((s, p) => s + p.itens.reduce((ss, i) => ss + i.qtd, 0), 0);
  return { ok: true, mkt: mktFiltro || null, total_pedidos: lista.length, total_itens, counts, pedidos: lista };
}

module.exports = { montarSeparacao, montarSeparacaoPorPedido };
