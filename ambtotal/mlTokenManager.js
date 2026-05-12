'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const ML_TOKEN_FILE = process.env.AMB_ML_TOKEN_FILE || '/data/ambtotal/ml-tokens.json';
const ML_CLIENT_ID     = process.env.AMB_ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.AMB_ML_CLIENT_SECRET;
const ML_REDIRECT_URI  = process.env.AMB_ML_REDIRECT_URI;

function lerTokens() {
  try {
    if (!fs.existsSync(ML_TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(ML_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function salvarTokens(tokens) {
  const dir = path.dirname(ML_TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ML_TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function trocarCodigoPorToken(code) {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
    throw new Error('AMB_ML_CLIENT_ID / AMB_ML_CLIENT_SECRET não definidos');
  }
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri:  ML_REDIRECT_URI
    })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AMB ML OAuth erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[AMB mlToken] Token ML inicial obtido e salvo ✓');
  return data.access_token;
}

async function renovarTokenML() {
  const tokens = lerTokens();
  if (!tokens?.refresh_token) throw new Error('AMB ML: sem refresh_token salvo');
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: tokens.refresh_token
    })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AMB ML refresh erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[AMB mlToken] Token ML renovado ✓');
  return data.access_token;
}

async function garantirTokenML() {
  const tokens = lerTokens();
  if (!tokens?.access_token) throw new Error('AMB ML: token não configurado. Acesse /amb/setup-ml.');
  const resp = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  if (resp.ok) return tokens.access_token;
  console.log('[AMB mlToken] Token ML expirado, renovando...');
  return await renovarTokenML();
}

function gerarUrlAutorizacao() {
  if (!ML_CLIENT_ID || !ML_REDIRECT_URI) {
    throw new Error('AMB_ML_CLIENT_ID / AMB_ML_REDIRECT_URI não definidos');
  }
  return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
}

module.exports = { garantirTokenML, renovarTokenML, trocarCodigoPorToken, gerarUrlAutorizacao };
