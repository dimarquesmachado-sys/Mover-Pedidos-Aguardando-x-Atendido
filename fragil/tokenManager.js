'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = process.env.FRAGIL_TOKEN_FILE || '/data/fragil/bling-tokens.json';

// ── I/O ───────────────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[fragil tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokens(access_token, refresh_token) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[fragil tokenManager] Tokens Bling salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.FRAGIL_BLING_CLIENT_ID;
  const sec = process.env.FRAGIL_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('FRAGIL_BLING_CLIENT_ID / FRAGIL_BLING_CLIENT_SECRET não definidos');
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
  if (data.error) throw new Error(`Fragil OAuth error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez) ─────────────────────────────────────

async function gerarTokenInicial(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.FRAGIL_BLING_REDIRECT_URI || '';
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
    console.log('[fragil tokenManager] Renovando token Bling...');
    const { refresh_token } = lerTokens();
    if (!refresh_token) throw new Error('refresh_token ausente — rode /fragil/auth/bling primeiro');
    const redirect_uri = process.env.FRAGIL_BLING_REDIRECT_URI || '';
    const data = await postOAuth({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokens(data.access_token, data.refresh_token);
    console.log('[fragil tokenManager] Token Bling renovado ✓');
    return data.access_token;
  } finally {
    _renovando = false;
  }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirToken() {
  const { access_token } = lerTokens();

  if (!access_token || access_token.length < 10) {
    console.log('[fragil tokenManager] Token Bling ausente — renovando');
    return renovarToken();
  }

  // Bling JWT tokens são bem longos. Não vamos validar via GET aqui
  // (gastaria 1 chamada por request). Vamos retornar e deixar o caller
  // fazer retry em caso de 401.
  return access_token;
}

module.exports = { garantirToken, renovarToken, gerarTokenInicial, lerTokens };
