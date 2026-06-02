'use strict';

/**
 * Token Manager do módulo /good-drive-imagens
 *
 * Gerencia tokens OAuth do Bling para o app "GOOD Imagens x SKU".
 * Tokens salvos em /data/good-drive-imagens/bling-tokens.json (disco persistente Render).
 *
 * Env vars necessárias:
 *   GOODIMG_BLING_CLIENT_ID
 *   GOODIMG_BLING_CLIENT_SECRET
 *   GOODIMG_BLING_REDIRECT_URI  (default: https://mover-pedidos-aguardando-x-atendido.onrender.com/good-drive-imagens/oauth/callback)
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = process.env.GOODIMG_TOKEN_FILE || '/data/good-drive-imagens/bling-tokens.json';

const REDIRECT_URI = process.env.GOODIMG_BLING_REDIRECT_URI
  || 'https://mover-pedidos-aguardando-x-atendido.onrender.com/good-drive-imagens/oauth/callback';

// ── I/O em disco ─────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[good-drive-imagens tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokens(access_token, refresh_token) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[good-drive-imagens tokenManager] Tokens Bling salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.GOODIMG_BLING_CLIENT_ID;
  const sec = process.env.GOODIMG_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('GOODIMG_BLING_CLIENT_ID / GOODIMG_BLING_CLIENT_SECRET não definidos');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuth(body) {
  const r = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': basicAuth(),
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { _raw: txt }; }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Troca o code de autorização por access_token + refresh_token. Salva em disco.
 */
async function trocarCodePorTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  }).toString();

  const r = await postOAuth(body);
  if (!r.ok || !r.data?.access_token) {
    throw new Error(`Bling OAuth erro ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  salvarTokens(r.data.access_token, r.data.refresh_token);
  return r.data;
}

/**
 * Refresh do access_token usando refresh_token salvo.
 */
async function refreshTokens() {
  const tk = lerTokens();
  if (!tk.refresh_token) throw new Error('refresh_token não disponível — autorizar via /good-drive-imagens/setup');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tk.refresh_token
  }).toString();

  const r = await postOAuth(body);
  if (!r.ok || !r.data?.access_token) {
    throw new Error(`Bling refresh erro ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  salvarTokens(r.data.access_token, r.data.refresh_token || tk.refresh_token);
  return r.data;
}

/**
 * Retorna access_token válido.
 */
async function garantirAccessToken() {
  const tk = lerTokens();
  if (!tk.access_token) throw new Error('access_token Bling não disponível — autorizar via /good-drive-imagens/setup');
  return tk.access_token;
}

/**
 * Wrapper que faz uma chamada e, se der 401, tenta refresh e refaz a chamada uma vez.
 */
async function fetchComRetry(url, opts = {}) {
  let token = await garantirAccessToken();
  let headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  let r = await fetch(url, { ...opts, headers });

  if (r.status === 401) {
    console.log('[good-drive-imagens tokenManager] 401 — tentando refresh…');
    await refreshTokens();
    token = await garantirAccessToken();
    headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    r = await fetch(url, { ...opts, headers });
  }
  return r;
}

function getRedirectUri() { return REDIRECT_URI; }

function getStatus() {
  const tk = lerTokens();
  return {
    configurado: !!process.env.GOODIMG_BLING_CLIENT_ID && !!process.env.GOODIMG_BLING_CLIENT_SECRET,
    tokens_ok: !!tk.access_token,
    refresh_ok: !!tk.refresh_token,
    redirect_uri: REDIRECT_URI
  };
}

module.exports = {
  trocarCodePorTokens,
  refreshTokens,
  garantirAccessToken,
  fetchComRetry,
  getRedirectUri,
  getStatus
};
