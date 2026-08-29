'use strict';

const fetch = require('node-fetch');
const { garantirToken, renovarToken } = require('./tokenManager');

const BLING_API = 'https://api.bling.com.br/Api/v3';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Caches ───────────────────────────────────────────────────────────

const cacheDetalhes = new Map();
const indiceSku     = new Map();
const indiceEan     = new Map();
let listagemCarregada = false;
let eansCarregados    = false;

// ── Helpers ──────────────────────────────────────────────────────────

function normalize(v) { return String(v || '').trim().toLowerCase(); }
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

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

function formatarProduto(p) {
  return {
    id: p.id,
    nome: p.nome || '',
    codigo: p.codigo || p.sku || '',
    imagem: extractImage(p),
    ean: getEans(p).find(Boolean) || ''
  };
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
  console.log('[fragil/produtos] Carregando EANs em background...');
  let total = 0;
  for (const [, id] of indiceSku) {
    if (cacheDetalhes.has(id)) { total++; continue; }
    try {
      await sleep(1000);
      await buscarDetalhe(id);
      total++;
      if (total % 50 === 0) console.log(`[fragil/produtos] ${total}/${indiceSku.size} EANs carregados...`);
    } catch (_) { /* ignora */ }
  }
  eansCarregados = true;
  console.log(`[fragil/produtos] ✅ EANs completos: ${indiceEan.size}`);
}

// ── Carregar índice de listagem ──────────────────────────────────────

async function carregarIndiceListagem() {
  const { lerTokens } = require('./tokenManager');
  const { access_token, refresh_token } = lerTokens();
  if (!access_token && !refresh_token) {
    console.warn('[fragil/produtos] Sem tokens Bling — pulando carregamento.');
    return;
  }
  console.log('[fragil/produtos] Carregando produtos do Bling...');
  let pagina = 1;
  let total = 0;
  while (true) {
    try {
      const { response, data } = await blingFetchComRetry(`${BLING_API}/produtos?pagina=${pagina}&limite=100`);
      if (!response.ok) { console.warn(`[fragil/produtos] página ${pagina}:`, response.status); break; }
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
    } catch (e) { console.error('[fragil/produtos] erro:', e.message); break; }
  }
  listagemCarregada = true;
  console.log(`[fragil/produtos] ✅ ${total} produtos indexados.`);
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
      if (novos > 0) console.log(`[fragil/produtos] Sync: ${novos} novos.`);
    } catch (_) { /* ignora */ }
  }, 5 * 60 * 1000);
}

// ── Buscar com filtro (autocomplete) ─────────────────────────────────

function buscar(termo, limite = 50) {
  const limiteResp = Math.min(parseInt(limite, 10) || 50, 200);
  const cacheStatus = {
    listagemCarregada, eansCarregados,
    skusIndexados: indiceSku.size,
    detalhesEmCache: cacheDetalhes.size
  };
  if (!termo) return { total: 0, resultados: [], cacheStatus };

  const termoNorm = normalize(termo);
  const termoDigits = onlyDigits(termo);
  const idsVistos = new Set();
  const resultados = [];

  function adicionar(item) {
    const id = String(item.id);
    if (idsVistos.has(id)) return;
    idsVistos.add(id);
    resultados.push(item);
  }

  for (const [skuNorm, id] of indiceSku) {
    if (resultados.length >= limiteResp) break;
    if (skuNorm.includes(termoNorm)) {
      const p = cacheDetalhes.get(String(id));
      if (p) adicionar(formatarProduto(p));
      else adicionar({ id, codigo: skuNorm.toUpperCase(), nome: '(carregando...)', imagem: '', ean: '' });
    }
  }
  if (termoDigits.length >= 8 && resultados.length < limiteResp) {
    for (const [ean, id] of indiceEan) {
      if (resultados.length >= limiteResp) break;
      if (ean.includes(termoDigits)) {
        const p = cacheDetalhes.get(String(id));
        if (p) adicionar(formatarProduto(p));
      }
    }
  }
  if (resultados.length < limiteResp) {
    for (const [, p] of cacheDetalhes) {
      if (resultados.length >= limiteResp) break;
      if (normalize(p.nome).includes(termoNorm)) adicionar(formatarProduto(p));
    }
  }
  resultados.sort((a, b) => {
    const aExact = normalize(a.codigo) === termoNorm ? 0 : 1;
    const bExact = normalize(b.codigo) === termoNorm ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return (a.codigo || '').localeCompare(b.codigo || '', 'pt-BR', { numeric: true });
  });
  return { total: resultados.length, resultados, cacheStatus };
}

function getCacheStatus() {
  return {
    listagemCarregada, eansCarregados,
    skusIndexados: indiceSku.size,
    eansIndexados: indiceEan.size,
    detalhesEmCache: cacheDetalhes.size
  };
}

module.exports = {
  carregarIndiceListagem,
  buscar,
  getCacheStatus
};

/* ── 29/08: busca POR EMPRESA (autocomplete) ──────────────────────────
   O índice acima vive de UMA conta Bling (a que autorizou /fragil/auth/bling), então o
   autocomplete sugeria só o catálogo dela — o dono cadastrava SKU da Girassol vendo
   produtos da GOOD. Cada empresa já tem tokenManager próprio (girassol/, good/,
   ambtotal/), usados pelos checkouts: reaproveitamos ESSES tokens em vez de criar mais
   um OAuth por empresa (mais token = mais coisa pra expirar sem ninguém ver).
   Aqui a busca é DIRETA na API, sem índice: autocomplete não precisa de cache, precisa
   de resposta certa da conta certa. */
const TM_POR_EMPRESA = {
  girassol: '../girassol/tokenManager',
  good:     '../good/tokenManager',
  ambtotal: '../ambtotal/tokenManager',
};

async function buscarNaEmpresa(empresa, termo, limite = 20) {
  const mod = TM_POR_EMPRESA[String(empresa || '').toLowerCase()];
  if (!mod) throw new Error('empresa inválida: ' + empresa);
  if (!termo || !String(termo).trim()) return { total: 0, resultados: [], empresa };
  const { garantirToken } = require(mod);
  const lim = Math.min(parseInt(limite, 10) || 20, 100);
  /* Codex #271 r3: o prazo começa ANTES de pegar o token — garantirToken pode renovar no
     Bling e travar lá, e o autocomplete ficaria pendurado antes mesmo da busca sair. */
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), 8000);
  let token;
  try {
    token = await Promise.race([
      garantirToken(),
      new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('Bling não respondeu em 8s (token)')))),
    ]);
  } catch (e) { clearTimeout(prazo); throw e; }
  /* Codex #271 r3: criterio=2 é 'contém no nome/código' e NÃO encontra por EAN — o dono
     cadastra SKU frágil bipando o código de barras. Termo só de dígitos e comprido tenta
     primeiro o GTIN, e cai na busca por texto se não achar. */
  const termoLimpo = String(termo).trim();
  const soDigitos = /^\d{8,14}$/.test(termoLimpo.replace(/\s/g, ''));
  const url = soDigitos
    ? 'https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=' + lim + '&gtin=' + encodeURIComponent(termoLimpo.replace(/\s/g, ''))
    : 'https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=' + lim + '&criterio=2&pesquisa=' + encodeURIComponent(termoLimpo);
  let r, d = {};
  try {
    r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('Bling respondeu ' + r.status + ' na busca de produtos');
    /* Codex #271 r2: o catch interno engolia o AbortError do CORPO e devolvia lista vazia —
       o timeout que acabei de pôr não chegava ao fallback. Abort sobe; JSON inválido, não. */
    try { d = await r.json(); }
    catch (e) { if (e && e.name === 'AbortError') throw e; d = {}; }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Bling não respondeu em 8s');
    throw e;
  } finally {
    clearTimeout(prazo);
  }
  let lista = Array.isArray(d.data) ? d.data : [];
  if (!lista.length && soDigitos) {
    /* EAN não achou: o número pode ser o próprio SKU. Tenta por texto no MESMO prazo. */
    try {
      const url2 = 'https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=' + lim + '&criterio=2&pesquisa=' + encodeURIComponent(termoLimpo);
      const r2 = await fetch(url2, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: ctrl.signal });
      if (r2.ok) { const d2 = await r2.json(); lista = Array.isArray(d2.data) ? d2.data : []; }
    } catch (e) { if (e && e.name === 'AbortError') throw new Error('Bling não respondeu em 8s'); }
  }
  const resultados = lista.map(p => ({
    id: String(p.id || ''),
    codigo: p.codigo || '',
    nome: p.nome || '',
    imagem: (p.imagemURL || (p.midia && p.midia.imagens && p.midia.imagens[0] && p.midia.imagens[0].link) || ''),
    ean: p.gtin || '',
  })).filter(p => p.codigo);   /* Codex #271 r2: a lista é de SKUs — produto sem codigo entraria e seria salvo com SKU vazio */
  return { total: resultados.length, resultados, empresa };
}

module.exports.buscarNaEmpresa = buscarNaEmpresa;
