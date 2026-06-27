'use strict';

/**
 * Módulo /good-mm-etiquetas — ponte das etiquetas do Madeira Madeira (GOOD Import).
 *
 * FLUXO:
 *  1) Diego gera a etiqueta no Portal MM (manual, raro — resolve captcha/login).
 *  2) Uma extensão no Chrome dele lê a lista de lotes prontos (batch + arquivo +
 *     pedido) e faz POST em /good-mm-etiquetas/sync (este módulo guarda o mapa).
 *  3) Na bipagem, o checkout pede a etiqueta -> este módulo baixa o PDF pelo
 *     batch direto do host "envios" com o TOKENMM (confirmado: funciona no Render).
 *
 * O que é guardado: mapa pedidoMM(order_id) -> { batch, sro, file, status, ts }.
 * O PDF NÃO é guardado; é baixado fresco a cada bipagem (sempre atual).
 *
 * Endpoints (todos exigem a chave GOOD_MM_SYNC_KEY):
 *   POST /good-mm-etiquetas/sync            (extensão -> Render) corpo: { lotes:[...] }
 *   GET  /good-mm-etiquetas/mapa            ver o mapa guardado
 *   GET  /good-mm-etiquetas/teste-pdf?batch=288348   baixa o PDF (teste no navegador)
 *   GET  /good-mm-etiquetas/health
 *
 * Exporta p/ o checkout: pdfPorBatch(batch), acharLote(chaveBusca), etiquetaMmPdf(pedido).
 *
 * Env: GOOD_MM_TOKEN (obrigatório p/ baixar), GOOD_MM_SYNC_KEY (obrigatório p/ os endpoints),
 *      GOOD_MM_DATA (opcional, caminho do JSON do mapa).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSAO = 'good-mm-etiquetas v27/06 b1';

const ENVIOS = 'https://envios.madeiramadeira.com.br';
const agent = new https.Agent({ family: 4, keepAlive: false });

const DATA_FILE = (process.env.GOOD_MM_DATA || path.join(os.tmpdir(), 'good-mm-mapa.json'));

// ── Helpers HTTP locais ──────────────────────────────────────────────
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body, null, 2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-MM-Key'
  };
}

// ── Armazenamento do mapa (JSON simples) ─────────────────────────────
function lerMapa() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { byOrder: {}, updatedAt: null, total: 0 }; }
}
function salvarMapa(m) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(m)); return true; }
  catch (e) { return false; }
}

// Recebe a lista de lotes da extensão e atualiza o mapa.
// Cada lote esperado: { batch, status, order_id|orders:[{order_id}], objects:[sro], file, nf? }
// Só guarda lotes PRONTOS (status 2 e com batch).
function aplicarLotes(lotes) {
  const m = lerMapa();
  if (!m.byOrder) m.byOrder = {};
  let novos = 0, atualizados = 0;
  for (const lote of (Array.isArray(lotes) ? lotes : [])) {
    if (!lote) continue;
    const batch = lote.batch ?? lote.lote ?? null;
    const status = lote.status ?? null;
    if (!batch) continue;
    if (status !== undefined && status !== null && Number(status) !== 2) continue; // só prontos
    const file = lote.file || (ENVIOS + '/api/v1/lote/' + batch + '/imprimir-pdf');
    const sros = Array.isArray(lote.objects) ? lote.objects : (lote.sro ? [lote.sro] : []);
    // order_ids do lote
    let orderIds = [];
    if (Array.isArray(lote.orders)) orderIds = lote.orders.map(o => String(o.order_id ?? o.id ?? o)).filter(Boolean);
    else if (lote.order_id != null) orderIds = [String(lote.order_id)];
    for (let i = 0; i < orderIds.length; i++) {
      const oid = orderIds[i];
      const reg = { batch: String(batch), sro: sros[i] || sros[0] || null, file, status: 2,
        nf: lote.nf != null ? String(lote.nf) : (m.byOrder[oid] && m.byOrder[oid].nf) || null, ts: Date.now() };
      if (m.byOrder[oid]) atualizados++; else novos++;
      m.byOrder[oid] = reg;
    }
  }
  m.updatedAt = Date.now();
  m.total = Object.keys(m.byOrder).length;
  salvarMapa(m);
  return { novos, atualizados, total: m.total };
}

// ── Download do PDF pelo batch (host envios + TOKENMM) ────────────────
function baixarPorUrl(fullUrl) {
  return new Promise((resolve) => {
    const token = process.env.GOOD_MM_TOKEN || '';
    if (!token) return resolve({ ok: false, erro: 'GOOD_MM_TOKEN não configurado' });
    const headers = { 'TOKENMM': token, 'Accept': '*/*', 'User-Agent': 'good-mm-etiquetas/1.0' };
    let req;
    try {
      req = https.request(fullUrl, { method: 'GET', agent, headers, timeout: 30000 }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ehPDF = buf.slice(0, 5).toString('latin1') === '%PDF-';
          resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300 && ehPDF,
            statusCode: resp.statusCode, contentType: resp.headers['content-type'] || null,
            ehPDF, length: buf.length, buf, url: fullUrl });
        });
      });
    } catch (e) { return resolve({ ok: false, erro: 'URL inválida: ' + e.message }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, erro: 'timeout (30s)' }); });
    req.on('error', (e) => resolve({ ok: false, erro: e.message }));
    req.end();
  });
}

// Baixa o PDF de um batch, com 1 retentativa.
async function pdfPorBatch(batch) {
  if (!batch) return null;
  const url = ENVIOS + '/api/v1/lote/' + encodeURIComponent(batch) + '/imprimir-pdf';
  for (let t = 0; t < 2; t++) {
    const r = await baixarPorUrl(url);
    if (r.ok && r.buf) return r.buf;
    await sleep(600);
  }
  return null;
}

// Acha o registro do lote no mapa por uma chave de busca (order_id MM, ou NF).
// chave pode ser string/number; testa byOrder direto e por NF.
function acharLote(chave) {
  if (chave == null) return null;
  const k = String(chave).trim();
  const m = lerMapa();
  if (m.byOrder && m.byOrder[k]) return m.byOrder[k];
  // tenta por NF
  if (m.byOrder) {
    for (const oid of Object.keys(m.byOrder)) {
      const r = m.byOrder[oid];
      if (r && r.nf && String(r.nf) === k) return r;
    }
  }
  return null;
}

// Função p/ o checkout: dado o pedido (objeto Bling), tenta achar e baixar a etiqueta MM.
// Procura o batch pelo número do pedido na loja (numeroLoja) e pela NF.
async function etiquetaMmPdf(pedido) {
  if (!pedido) return null;
  // candidatos de chave que ligam o pedido Bling ao pedido MM
  const candidatos = [];
  for (const campo of ['numeroLoja', 'numeroPedidoLoja', 'numeroPedidoCompra', 'numero']) {
    if (pedido[campo] != null) candidatos.push(String(pedido[campo]));
  }
  if (pedido.loja && pedido.loja.numero != null) candidatos.push(String(pedido.loja.numero));
  // NF (número), se vier no pedido
  if (pedido.nfNumero != null) candidatos.push(String(pedido.nfNumero));
  let reg = null;
  for (const c of candidatos) { reg = acharLote(c); if (reg) break; }
  if (!reg || !reg.batch) return null;
  return await pdfPorBatch(reg.batch);
}

// ── Auth dos endpoints ───────────────────────────────────────────────
function chave(req, urlObj) {
  return (req.headers['x-mm-key'] || urlObj.searchParams.get('k') || '').trim();
}
function autorizado(req, urlObj, bodyKey) {
  const esperado = process.env.GOOD_MM_SYNC_KEY || '';
  if (!esperado) return false; // sem chave configurada, nega tudo
  const dada = chave(req, urlObj) || (bodyKey || '');
  return dada === esperado;
}

function lerBodyJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let tam = 0;
    req.on('data', c => { chunks.push(c); tam += c.length; if (tam > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ── Router ───────────────────────────────────────────────────────────
function routes(/* readBody */) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    if (p !== '/good-mm-etiquetas' && !p.startsWith('/good-mm-etiquetas/')) return false;

    // Preflight CORS (a extensão/bookmarklet pode mandar OPTIONS antes do POST)
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return true; }

    // Health (não exige chave)
    if (p === '/good-mm-etiquetas/health' && req.method === 'GET') {
      const m = lerMapa();
      json(res, 200, { ok: true, modulo: 'good-mm-etiquetas', versao: VERSAO,
        tokenConfigurado: !!process.env.GOOD_MM_TOKEN, chaveConfigurada: !!process.env.GOOD_MM_SYNC_KEY,
        pedidos_no_mapa: m.total || 0, atualizado_em: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
        arquivo: DATA_FILE });
      return true;
    }

    // SYNC — extensão manda os lotes prontos
    if (p === '/good-mm-etiquetas/sync' && req.method === 'POST') {
      const body = await lerBodyJson(req);
      if (!autorizado(req, urlObj, body && body.key)) { res.writeHead(401, corsHeaders()); res.end(JSON.stringify({ erro: 'chave inválida (X-MM-Key / ?k= / body.key)' })); return true; }
      if (!body) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ erro: 'JSON inválido' })); return true; }
      const lotes = body.lotes || body.data || (Array.isArray(body) ? body : []);
      const r = aplicarLotes(lotes);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()));
      res.end(JSON.stringify({ ok: true, recebidos: Array.isArray(lotes) ? lotes.length : 0, novos: r.novos, atualizados: r.atualizados, total_no_mapa: r.total }, null, 2));
      return true;
    }

    // Daqui pra baixo exige chave
    if (!autorizado(req, urlObj)) { json(res, 401, { erro: 'chave inválida ou ausente (?k=)' }); return true; }

    // Ver o mapa
    if (p === '/good-mm-etiquetas/mapa' && req.method === 'GET') {
      const m = lerMapa();
      json(res, 200, { versao: VERSAO, total: m.total || 0, atualizado_em: m.updatedAt ? new Date(m.updatedAt).toISOString() : null, byOrder: m.byOrder || {} });
      return true;
    }

    // Teste de download por batch (abre o PDF no navegador)
    if (p === '/good-mm-etiquetas/teste-pdf' && req.method === 'GET') {
      const batch = (urlObj.searchParams.get('batch') || '').trim();
      const order = (urlObj.searchParams.get('order') || '').trim();
      let usarBatch = batch;
      if (!usarBatch && order) { const reg = acharLote(order); usarBatch = reg && reg.batch; }
      if (!usarBatch) { json(res, 400, { erro: 'informe ?batch= ou ?order= (que exista no mapa)' }); return true; }
      const url = ENVIOS + '/api/v1/lote/' + encodeURIComponent(usarBatch) + '/imprimir-pdf';
      const r = await baixarPorUrl(url);
      if (urlObj.searchParams.get('info')) { json(res, 200, { batch: usarBatch, ok: r.ok, statusCode: r.statusCode, contentType: r.contentType, bytes: r.length ?? null, erro: r.erro || null }); return true; }
      if (r.ok && r.buf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="mm-' + usarBatch + '.pdf"' }); res.end(r.buf); return true; }
      json(res, 502, { erro: 'não baixou', batch: usarBatch, statusCode: r.statusCode, detalhe: r.erro || null });
      return true;
    }

    json(res, 404, { erro: 'rota não encontrada', path: p });
    return true;
  };
}

module.exports = {
  id: 'good-mm-etiquetas',
  nome: 'GOOD Madeira Madeira (etiquetas)',
  rotinas: {},
  crons: {},
  routes,
  // exportado p/ o checkout usar no passo 3 do etiquetaPdf:
  pdfPorBatch,
  acharLote,
  etiquetaMmPdf
};
