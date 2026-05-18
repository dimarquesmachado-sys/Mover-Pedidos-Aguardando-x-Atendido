'use strict';

// ──────────────────────────────────────────────────────────────────────
// Gerenciador de tokens do app Bling NF da GOOD Import (Corrigir-NFs)
// Usa variáveis com prefixo GOOD_NF_
// ──────────────────────────────────────────────────────────────────────

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const NF_TOKEN_FILE = process.env.GOOD_NF_TOKEN_FILE || '/data/good/nf-tokens.json';

function lerTokensNF() {
  try {
    if (!fs.existsSync(NF_TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(NF_TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[GOOD nfTokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokensNF(access_token, refresh_token) {
  const dir = path.dirname(NF_TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NF_TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[GOOD nfTokenManager] Tokens NF salvos em disco ✓');
}

function basicAuthNF() {
  const id  = process.env.GOOD_NF_BLING_CLIENT_ID;
  const sec = process.env.GOOD_NF_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('GOOD_NF_BLING_CLIENT_ID / GOOD_NF_BLING_CLIENT_SECRET não definidos');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuthNF(body) {
  const resp = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthNF(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'enable-jwt': '1'
    },
    body: new URLSearchParams(body)
  });
  const data = await resp.json();
  if (data.error) throw new Error(`GOOD NF OAuth error: ${JSON.stringify(data)}`);
  return data;
}

async function gerarTokenInicialNF(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.GOOD_NF_BLING_REDIRECT_URI || '';
  const data = await postOAuthNF({ grant_type: 'authorization_code', code: auth_code, redirect_uri });
  salvarTokensNF(data.access_token, data.refresh_token);
  return { ok: true };
}

let _renovandoNF = false;

async function renovarTokenNF() {
  if (_renovandoNF) {
    await new Promise(r => setTimeout(r, 2000));
    return lerTokensNF().access_token;
  }
  _renovandoNF = true;
  try {
    console.log('[GOOD nfTokenManager] Renovando token NF...');
    const { refresh_token } = lerTokensNF();
    if (!refresh_token) throw new Error('GOOD NF: refresh_token ausente — rode /good/setup-nf primeiro');
    const redirect_uri = process.env.GOOD_NF_BLING_REDIRECT_URI || '';
    const data = await postOAuthNF({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokensNF(data.access_token, data.refresh_token);
    console.log('[GOOD nfTokenManager] Token NF renovado ✓');
    return data.access_token;
  } finally {
    _renovandoNF = false;
  }
}

async function garantirTokenNF() {
  const { access_token } = lerTokensNF();

  if (!access_token || access_token.length < 10) {
    console.log('[GOOD nfTokenManager] Token NF ausente — renovando');
    return renovarTokenNF();
  }

  // Valida usando /nfe (mesmo scope do app) em vez de /produtos
  const resp = await fetch('https://api.bling.com.br/Api/v3/nfe?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (resp.status === 401) {
    console.log('[GOOD nfTokenManager] Token NF expirado (401) — renovando');
    return renovarTokenNF();
  }

  return access_token;
}

module.exports = { garantirTokenNF, renovarTokenNF, gerarTokenInicialNF };
