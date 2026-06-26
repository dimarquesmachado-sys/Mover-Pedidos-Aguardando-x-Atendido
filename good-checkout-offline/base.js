'use strict';
// base.js — fundação compartilhada: configs, helpers, leitura de arquivos, auth e chamadas ao Bling.
// Todos os outros módulos importam daqui. NÃO depende de nenhum módulo do projeto (evita import circular).

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { garantirToken } = require('../good/tokenManager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

const CACHE_DIR     = process.env.GOODBKP_CACHE_DIR    || '/data/cache-offline/good';
const SIT_ATENDIDO  = Number(process.env.GOODBKP_SIT_ATENDIDO  || 9);              // ATENDIDO
const SIT_VERIFICADO = Number(process.env.GOODBKP_SIT_VERIFICADO || 24);           // VERIFICADO (destino do sync Fase 3)
const SYNC_ON       = process.env.GOODBKP_SYNC_ON === '1';                          // liga o sync automático no cron (Fase 3)
const JANELA_DIAS   = Number(process.env.GOODBKP_JANELA_DIAS   || 5);
const PAUSA_MS      = Number(process.env.GOODBKP_PAUSA_MS      || 350);            // ~3 req/s
const RETENCAO_DIAS = Number(process.env.GOODBKP_RETENCAO_DIAS || 7);
const ETIQ_FORMATO  = (process.env.GOODBKP_ETIQ_FORMATO || 'ZPL').toUpperCase();   // ZPL | PDF
const CRON_EXPR     = process.env.GOODBKP_CRON || '5,15,25,35,45,55 6-23 * * *';   // off do F3

const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SKU_EAN_FILE  = path.join(CACHE_DIR, 'sku-ean.json');
const CONFERIDOS_FILE = path.join(CACHE_DIR, 'conferidos.json');
const RESERVAS_FILE   = path.join(CACHE_DIR, 'reservas.json');
const RESERVA_TTL_MS  = 8 * 60 * 1000;   // reserva expira em 8 min sem heartbeat (PC largado libera o pedido sozinho)
const KIT_CACHE_FILE  = path.join(CACHE_DIR, 'kit-estrutura.json');  // kits já resolvidos
const LOC_FILE        = path.join(CACHE_DIR, 'sku-localizacao.json'); // localização (depósito) por SKU
const LOC_LOG_FILE    = path.join(CACHE_DIR, 'localizacao-log.json'); // auditoria: quem editou localização, de→para, quando
const EAN_INDEX_FILE  = path.join(CACHE_DIR, 'ean-indice.json');      // índice EAN→{sku,nome,id} que cresce sozinho + indexação total
const ARQUIVO_DIR   = process.env.GOODBKP_ARQUIVO_DIR  || '/data/arquivo-good';   // etiqueta+meta dos FINALIZADOS (reimprimir/reenviar) — separado do cache, NÃO é limpo pela reconciliação
const ARQUIVO_DIAS  = parseInt(process.env.GOODBKP_ARQUIVO_DIAS || '45', 10);          // retenção do arquivo (dias)
const SMTP_HOST  = process.env.GOODBKP_SMTP_HOST || '';
const SMTP_PORT  = parseInt(process.env.GOODBKP_SMTP_PORT || '465', 10);
const EMAIL_USER = process.env.GOODBKP_EMAIL_USER || '';   // conta da GOOD que ENVIA (login)
const EMAIL_PASS = process.env.GOODBKP_EMAIL_PASS || '';   // senha normal dessa conta
const EMAIL_DEST = process.env.GOODBKP_EMAIL_DEST || '';   // destino (estoquista)
const SCHEMA = 4;  // versão do snapshot — bump força re-cache dos pedidos antigos (b36: re-explode composições/variações)

// loja → marketplace (GOOD Import). Lojas confirmadas via diagnostico.
// Pode adicionar/sobrescrever por env GOODBKP_LOJA_MKT no formato "idLoja:mkt,idLoja:mkt".
const LOJA_MKT = (function () {
  const map = {
    '203296034': 'ml',
    '203583539': 'shopee',
    '203764162': 'amazon',
    '203381869': 'magalu',
    '205773174': 'tiktok',
    '205557785': 'madeira',
    '205594320': 'leroy',
    '203344795': 'carrefour',
    '203402885': 'olist',
    '203345742': 'b2w',
    '204349867': 'mercadoshops'
  };
  (process.env.GOODBKP_LOJA_MKT || '').split(',').forEach(function (par) {
    const kv = par.split(':');
    const id = (kv[0] || '').trim(), mkt = (kv[1] || '').trim().toLowerCase();
    if (id && mkt) map[id] = mkt;
  });
  return map;
})();
const MKT_NOME = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', magalu: 'Magalu', tiktok: 'TikTok Shop', madeira: 'Madeira Madeira', leroy: 'Leroy Merlin', carrefour: 'Carrefour', olist: 'Olist', b2w: 'Americanas', mercadoshops: 'MercadoShops', outro: 'Outro' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; } }

function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('[GOODBKP] write', file, e.message); }
}

function dataISO(d) { return d.toISOString().slice(0, 10); }

function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

function html(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }); res.end(body); }


// acessores de cache em disco
const manifest       = () => readJson(MANIFEST_FILE, {});
const salvarManifest = (m) => writeJson(MANIFEST_FILE, m);
const skuEanCache    = () => readJson(SKU_EAN_FILE, {});
const locCache       = () => readJson(LOC_FILE, {});
const salvarLoc      = (m) => writeJson(LOC_FILE, m);
const salvarSkuEan   = (m) => writeJson(SKU_EAN_FILE, m);
const lerIndiceEan = () => readJson(EAN_INDEX_FILE, {});

function lerReservas() {
  const r = readJson(RESERVAS_FILE, {});
  const agora = Date.now();
  let mudou = false;
  for (const id of Object.keys(r)) {
    const t = Date.parse(r[id] && r[id].em) || 0;
    if (!t || agora - t > RESERVA_TTL_MS) { delete r[id]; mudou = true; }
  }
  if (mudou) writeJson(RESERVAS_FILE, r);
  return r;
}

function lerOperadores() {
  const raw = process.env.GOODBKP_OPERADORES || '';
  const map = {};
  raw.split(',').forEach(par => {
    const i = par.indexOf(':');
    if (i > 0) {
      const nome = par.slice(0, i).trim();
      const senha = par.slice(i + 1).trim();
      if (nome) map[nome] = senha;
    }
  });
  return map;
}

function lerAdmins() {
  return (process.env.GOODBKP_ADMIN || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function ehAdmin(nome) {
  const a = lerAdmins();
  return a.length === 0 || a.includes(String(nome || '').trim().toLowerCase());
}

async function blingGet(pathUrl, tentativas = 3) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  for (let t = 0; t < tentativas; t++) {
    let r;
    try {
      r = await fetch(BLING_BASE + pathUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (e) { await sleep(800); continue; }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  return { ok: false, status: 429, data: null };
}

async function blingWrite(method, pathUrl, body) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  for (let t = 0; t < 3; t++) {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
    if (body !== undefined && body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BLING_BASE + pathUrl, opts); }
    catch (e) { await sleep(800); continue; }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data, raw: (txt || '').slice(0, 300) };
  }
  return { ok: false, status: 429, data: null };
}

async function moverSituacao(blingId, idSituacao) {
  return await blingWrite('PATCH', `/pedidos/vendas/${blingId}/situacoes/${idSituacao}`, null);
}


module.exports = {
  fs, path, fetch, garantirToken, BLING_BASE,
  CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS,
  KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE, ARQUIVO_DIR, ARQUIVO_DIAS,
  SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html,
  manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan,
  lerReservas, lerOperadores, lerAdmins, ehAdmin,
  blingGet, blingWrite, moverSituacao,
};
