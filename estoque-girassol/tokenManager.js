'use strict';

/**
 * Token Manager do módulo /estoque
 *
 * Gerencia tokens OAuth do Bling para o app "estoque" (separado dos outros).
 * Os tokens são salvos em /data/estoque-girassol/bling-tokens.json (disco persistente).
 *
 * Env vars necessárias:
 *   ESTOQUE_GIRASSOL_BLING_CLIENT_ID
 *   ESTOQUE_GIRASSOL_BLING_CLIENT_SECRET
 *   ESTOQUE_GIRASSOL_BLING_REDIRECT_URI
 *   ESTOQUE_GIRASSOL_TOKEN_FILE  (opcional, default /data/estoque-girassol/bling-tokens.json)
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = process.env.ESTOQUE_GIRASSOL_TOKEN_FILE || '/data/estoque-girassol/bling-tokens.json';

// ── I/O ───────────────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[estoque-girassol tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokens(access_token, refresh_token) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[estoque-girassol tokenManager] Tokens Bling salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.ESTOQUE_GIRASSOL_BLING_CLIENT_ID;
  const sec = process.env.ESTOQUE_GIRASSOL_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('ESTOQUE_GIRASSOL_BLING_CLIENT_ID / ESTOQUE_GIRASSOL_BLING_CLIENT_SECRET não definidos');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuth(body) {
  const resp = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'enable-jwt': '1'   // Migração JWT obrigatória até 30/06/2026
    },
    body: new URLSearchParams(body)
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Estoque OAuth error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez) ─────────────────────────────────────

async function gerarTokenInicial(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.ESTOQUE_GIRASSOL_BLING_REDIRECT_URI || '';
  const data = await postOAuth({ grant_type: 'authorization_code', code: auth_code, redirect_uri });
  salvarTokens(data.access_token, data.refresh_token);
  return { ok: true };
}

// ── Renovar token ─────────────────────────────────────────────────────

let _renovando = false;

async function renovarToken() {
  if (_renovando) {
    await new Promise(r => setTimeout(r, 2000));
    return lerTokens().access_token;
  }
  _renovando = true;
  try {
    console.log('[estoque-girassol tokenManager] Renovando token Bling...');
    const { refresh_token } = lerTokens();
    if (!refresh_token) throw new Error('refresh_token ausente — rode /estoque-girassol/auth/bling primeiro');
    const redirect_uri = process.env.ESTOQUE_GIRASSOL_BLING_REDIRECT_URI || '';
    const data = await postOAuth({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokens(data.access_token, data.refresh_token);
    console.log('[estoque-girassol tokenManager] Token Bling renovado ✓');
    return data.access_token;
  } finally {
    _renovando = false;
  }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirToken() {
  const { access_token } = lerTokens();
  if (!access_token || access_token.length < 10) {
    console.log('[estoque-girassol tokenManager] Token Bling ausente — renovando');
    return renovarToken();
  }
  return access_token;
}

module.exports = { garantirToken, renovarToken, gerarTokenInicial, lerTokens };
