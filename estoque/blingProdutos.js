'use strict';

/**
 * Cache de produtos do Bling para o módulo /estoque
 *
 * - Carrega listagem completa (1k+ SKUs) no startup, indexa por SKU
 * - Em background carrega detalhes de cada produto (1/seg) pra popular EANs
 * - Sync a cada 5 min pra pegar produtos novos
 * - Expõe resolverProduto() pra busca por SKU ou EAN
 * - Expõe atualizarLocalizacao() pra alterar localização no Bling
 */

const fetch = require('node-fetch');
const { garantirToken, renovarToken } = require('./tokenManager');

const BLING_API = 'https://api.bling.com.br/Api/v3';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Caches ───────────────────────────────────────────────────────────

const cacheDetalhes = new Map();   // id -> produto completo
const indiceSku     = new Map();   // sku_lower -> id
const indiceEan     = new Map();   // ean_digits -> id
let listagemCarregada = false;
let eansCarregados    = false;

// ── Helpers ──────────────────────────────────────────────────────────

function normalize(v) { return String(v || '').trim().toLowerCase(); }
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
function isExactCI(a, b) { return normalize(a) === normalize(b); }
function isExactDigits(a, b) {
  const aa = onlyDigits(a); const bb = onlyDigits(b);
  return aa && bb && aa === bb;
}

function getSkus(p) { return [p?.codigo, p?.sku, p?.codigoProduto].filter(Boolean); }
function getEans(p) {
  return [
    p?.gtin, p?.ean, p?.codigoBarras, p?.gtinEan, p?.gtinTributario,
    p?.codigo_barras, p?.codigoDeBarras, p?.codBarras,
    p?.tributavel?.gtin, p?.tributavel?.ean,
    p?.tributacao?.gtin, p?.tributacao?.ean
  ].filter(Boolean);
}

function extractImage(produto) {
  const vistos = new Set();
  function proc(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') {
      const v = obj.trim();
      if (/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(v)) return v;
      if (/^https?:\/\/lh3\.googleusercontent\.com\//i.test(v)) return v;
      return '';
    }
    if (typeof obj !== 'object' || vistos.has(obj)) return '';
    vistos.add(obj);
    if (Array.isArray(obj)) {
      for (const i of obj) { const a = proc(i); if (a) return a; }
      return '';
    }
    for (const k of Object.keys(obj)) { const a = proc(obj[k]); if (a) return a; }
    return '';
  }
  return proc(produto) || '';
}

function extractLocalizacao(p) {
  return p?.estoque?.localizacao || p?.localizacao || p?.depositos?.[0]?.localizacao || '';
}
function extractEstoque(p) {
  return p?.estoque?.saldoVirtualTotal ?? p?.estoque?.saldoVirtual ?? p?.saldoVirtualTotal ?? 0;
}

function formatarProduto(p) {
  return {
    id: p.id,
    nome: p.nome || '',
    codigo: p.codigo || p.sku || '',
    estoque: extractEstoque(p),
    localizacao: extractLocalizacao(p),
    imagem: extractImage(p),
    ean: getEans(p).find(Boolean) || ''
  };
}

function traduzirErroBling(msg) {
  const texto = String(msg || '').toLowerCase().trim();
  if (texto.includes('invalid refresh token')) return 'Token inválido. Reautorize em /estoque/auth/bling.';
  if (texto.includes('invalid_token')) return 'Token expirado.';
  return 'Erro de comunicação com o Bling.';
}

// ── Fetch Bling com retry e renovação automática ─────────────────────

async function blingFetch(url, options = {}) {
  let token = await garantirToken();
  async function doFetch(t) {
    const r = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(options.headers || {}) }
    });
    let d = {};
    try { d = await r.json(); } catch { d = {}; }
    return { response: r, data: d };
  }
  let result = await doFetch(token);
  if (result.response.status === 401 || /invalid_token/i.test(JSON.stringify(result.data || {}))) {
    token = await renovarToken();
    result = await doFetch(token);
  }
  return result;
}

async function blingFetchComRetry(url, options = {}) {
  for (let i = 0; i < 4; i++) {
    const result = await blingFetch(url, options);
    if (result.response.status === 429) { await sleep(1500 * (i + 1)); continue; }
    return result;
  }
  return await blingFetch(url, options);
}

// ── Buscar detalhe de produto ────────────────────────────────────────

async function buscarDetalhe(id) {
  const cached = cacheDetalhes.get(String(id));
  if (cached) return cached;
  const { response, data } = await blingFetchComRetry(`${BLING_API}/produtos/${id}`);
  if (!response.ok || !data?.data) return null;
  const p = data.data;
  cacheDetalhes.set(String(p.id), p);
  getEans(p).forEach(e => {
    const d = onlyDigits(e);
    if (d && d.length >= 8) indiceEan.set(d, String(p.id));
  });
  getSkus(p).forEach(s => { if (s) indiceSku.set(normalize(s), String(p.id)); });
  return p;
}

// ── Carregar EANs em background ──────────────────────────────────────

async function carregarEansBackground() {
  console.log('[estoque/produtos] Carregando EANs em background...');
  let total = 0;
  for (const [, id] of indiceSku) {
    if (cacheDetalhes.has(id)) { total++; continue; }
    try {
      await sleep(1000);
      await buscarDetalhe(id);
      total++;
      if (total % 50 === 0) console.log(`[estoque/produtos] ${total}/${indiceSku.size} EANs carregados...`);
    } catch (_) { /* ignora */ }
  }
  eansCarregados = true;
  console.log(`[estoque/produtos] ✅ EANs completos: ${indiceEan.size}`);
}

// ── Carregar índice de listagem ──────────────────────────────────────

async function carregarIndiceListagem() {
  const { lerTokens } = require('./tokenManager');
  const { access_token, refresh_token } = lerTokens();
  if (!access_token && !refresh_token) {
    console.warn('[estoque/produtos] Sem tokens Bling — pulando carregamento.');
    return;
  }
  console.log('[estoque/produtos] Carregando produtos do Bling...');
  let pagina = 1;
  let total = 0;
  while (true) {
    try {
      const { response, data } = await blingFetchComRetry(`${BLING_API}/produtos?pagina=${pagina}&limite=100`);
      if (!response.ok) { console.warn(`[estoque/produtos] página ${pagina}:`, response.status); break; }
      const lista = data?.data || [];
      if (!lista.length) break;
      for (const item of lista) {
        if (!item?.id || !item?.codigo) continue;
        const id = String(item.id);
        indiceSku.set(normalize(item.codigo), id);
        if (item.sku) indiceSku.set(normalize(item.sku), id);
        total++;
      }
      if (lista.length < 100) break;
      pagina++;
      await sleep(300);
    } catch (e) { console.error('[estoque/produtos] erro:', e.message); break; }
  }
  listagemCarregada = true;
  console.log(`[estoque/produtos] ✅ ${total} produtos indexados.`);
  carregarEansBackground();

  // Sync a cada 5 min — pega produtos novos
  setInterval(async () => {
    try {
      const { response, data } = await blingFetchComRetry(`${BLING_API}/produtos?pagina=1&limite=100`);
      if (!response.ok) return;
      const lista = data?.data || [];
      let novos = 0;
      for (const item of lista) {
        if (!item?.id || !item?.codigo) continue;
        const id = String(item.id);
        if (!indiceSku.has(normalize(item.codigo))) novos++;
        indiceSku.set(normalize(item.codigo), id);
        if (item.sku) indiceSku.set(normalize(item.sku), id);
      }
      if (novos > 0) console.log(`[estoque/produtos] Sync: ${novos} novos.`);
    } catch (_) { /* ignora */ }
  }, 5 * 60 * 1000);
}

// ── Resolver produto (SKU ou EAN) ────────────────────────────────────

async function resolverProduto(tipo, valor) {
  const tipoBusca = String(tipo || '').toUpperCase();
  const valorOriginal = String(valor || '').trim();
  if (!valorOriginal) return { ok: false, erro: 'Código não informado' };

  // ===== BUSCA POR SKU =====
  if (tipoBusca === 'SKU') {
    const id = indiceSku.get(normalize(valorOriginal));
    if (id) {
      const p = await buscarDetalhe(id);
      if (p && getSkus(p).some(s => isExactCI(s, valorOriginal))) {
        console.log(`[estoque SKU-HIT] ${valorOriginal} → ${p.codigo}`);
        return { ok: true, produto: p };
      }
    }
    // Fallback: busca direta na API
    const { response, data } = await blingFetchComRetry(
      `${BLING_API}/produtos?codigo=${encodeURIComponent(valorOriginal)}`
    );
    if (response.ok) {
      for (const item of (data?.data || [])) {
        if (!item?.id) continue;
        const p = await buscarDetalhe(item.id);
        if (p && getSkus(p).some(s => isExactCI(s, valorOriginal))) {
          return { ok: true, produto: p };
        }
      }
    }
    return { ok: false, erro: 'Produto não encontrado' };
  }

  // ===== BUSCA POR EAN =====
  const eanDigits = onlyDigits(valorOriginal);
  const idPorEan = indiceEan.get(eanDigits);
  if (idPorEan) {
    const p = await buscarDetalhe(idPorEan);
    if (p && getEans(p).some(e => isExactDigits(e, valorOriginal))) {
      console.log(`[estoque EAN-HIT] ${valorOriginal} → ${p.codigo}`);
      return { ok: true, produto: p };
    }
  }

  // Tenta parâmetros da API do Bling
  const urlsEan = [
    `${BLING_API}/produtos?gtin=${encodeURIComponent(valorOriginal)}`,
    `${BLING_API}/produtos?gtinTributario=${encodeURIComponent(valorOriginal)}`,
    `${BLING_API}/produtos?ean=${encodeURIComponent(valorOriginal)}`,
    `${BLING_API}/produtos?codigoBarras=${encodeURIComponent(valorOriginal)}`,
    `${BLING_API}/produtos?codigo=${encodeURIComponent(valorOriginal)}`
  ];
  for (const url of urlsEan) {
    const { response, data } = await blingFetchComRetry(url);
    if (!response.ok) continue;
    for (const item of (data?.data || [])) {
      if (!item?.id) continue;
      const p = await buscarDetalhe(item.id);
      if (p && getEans(p).some(e => isExactDigits(e, valorOriginal))) {
        console.log(`[estoque EAN-API] ${valorOriginal} → ${p.codigo}`);
        return { ok: true, produto: p };
      }
    }
  }

  // Varre cache de detalhes já carregados
  for (const [, p] of cacheDetalhes) {
    if (getEans(p).some(e => isExactDigits(e, valorOriginal))) {
      console.log(`[estoque EAN-CACHE] Encontrado em cache: ${p.codigo}`);
      indiceEan.set(eanDigits, String(p.id));
      return { ok: true, produto: p };
    }
  }

  if (eansCarregados) {
    console.log(`[estoque EAN] EAN ${valorOriginal} não existe no Bling.`);
    return { ok: false, erro: 'Produto não encontrado' };
  }

  return { ok: false, erro: 'Produto não encontrado' };
}

// ── Atualizar localização ────────────────────────────────────────────

async function atualizarLocalizacao(produto, novaLocalizacao) {
  const id = produto.id;
  const patch = await blingFetchComRetry(
    `${BLING_API}/produtos/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estoque: { localizacao: novaLocalizacao } })
    }
  );
  if (!patch.response.ok) {
    return { ok: false, erro: patch.data?.error?.description || 'Erro ao salvar' };
  }
  // Atualiza cache
  const pAtualizado = {
    ...produto,
    estoque: { ...(produto.estoque || {}), localizacao: novaLocalizacao }
  };
  cacheDetalhes.set(String(id), pAtualizado);
  return { ok: true, produto: pAtualizado };
}

// ── Status ───────────────────────────────────────────────────────────

function getCacheStatus() {
  return {
    listagemCarregada,
    eansCarregados,
    skusIndexados: indiceSku.size,
    eansIndexados: indiceEan.size,
    detalhesEmCache: cacheDetalhes.size,
    progresso: `${cacheDetalhes.size}/${indiceSku.size} produtos com detalhe`
  };
}

module.exports = {
  carregarIndiceListagem,
  resolverProduto,
  atualizarLocalizacao,
  formatarProduto,
  getCacheStatus,
  traduzirErroBling
};
