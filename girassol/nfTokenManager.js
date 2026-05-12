'use strict';

// ──────────────────────────────────────────────────────────────────────
// Gerenciador de tokens do app Bling do Corrigir-NFs
// Usa variáveis com prefixo NF_ para não conflitar com o Mover-Pedidos
// ──────────────────────────────────────────────────────────────────────

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const NF_TOKEN_FILE = process.env.NF_TOKEN_FILE || path.join(__dirname, 'data', 'nf_tokens.json');

// ── I/O ──────────────────────────────────────────────────────────────

function lerTokensNF() {
  try {
    if (!fs.existsSync(NF_TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(NF_TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[nfTokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokensNF(access_token, refresh_token) {
  const dir = path.dirname(NF_TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NF_TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[nfTokenManager] Tokens NF salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuthNF() {
  const id  = process.env.NF_BLING_CLIENT_ID;
  const sec = process.env.NF_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('NF_BLING_CLIENT_ID / NF_BLING_CLIENT_SECRET não definidos nas env vars');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuthNF(body) {
  const resp = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthNF(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(body)
  });
  const data = await resp.json();
  if (data.error) throw new Error(`OAuth NF error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez, via /setup-nf) ─────────────────────

async function gerarTokenInicialNF(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.NF_BLING_REDIRECT_URI || '';
  const data = await postOAuthNF({ grant_type: 'authorization_code', code: auth_code, redirect_uri });
  salvarTokensNF(data.access_token, data.refresh_token);
  return { ok: true };
}

// ── Renovar token ────────────────────────────────────────────────────

let _renovandoNF = false;

async function renovarTokenNF() {
  if (_renovandoNF) {
    await new Promise(r => setTimeout(r, 2000));
    return lerTokensNF().access_token;
  }
  _renovandoNF = true;
  try {
    console.log('[nfTokenManager] Renovando token NF...');
    const { refresh_token } = lerTokensNF();
    if (!refresh_token) throw new Error('refresh_token NF ausente — rode /setup-nf primeiro');
    const redirect_uri = process.env.NF_BLING_REDIRECT_URI || '';
    const data = await postOAuthNF({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokensNF(data.access_token, data.refresh_token);
    console.log('[nfTokenManager] Token NF renovado ✓');
    return data.access_token;
  } finally {
    _renovandoNF = false;
  }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirTokenNF() {
  const { access_token } = lerTokensNF();

  if (!access_token || access_token.length < 10) {
    console.log('[nfTokenManager] Token NF ausente — renovando');
    return renovarTokenNF();
  }

  const resp = await fetch('https://api.bling.com.br/Api/v3/produtos?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (resp.status === 401) {
    console.log('[nfTokenManager] Token NF expirado (401) — renovando');
    return renovarTokenNF();
  }

  return access_token;
}

module.exports = { garantirTokenNF, renovarTokenNF, gerarTokenInicialNF };
