'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');

const ML_TOKEN_FILE   = process.env.ML_TOKEN_FILE || '/data/ml_tokens.json';
const ML_CLIENT_ID    = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET= process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://mover-pedidos-aguardando-x-atendido.onrender.com/callback-ml';

function lerTokens() {
  try {
    return JSON.parse(fs.readFileSync(ML_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function salvarTokens(tokens) {
  fs.writeFileSync(ML_TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function trocarCodigoPorToken(code) {
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
    throw new Error(`ML OAuth erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[mlToken] Token inicial obtido e salvo ✓');
  return data.access_token;
}

async function renovarTokenML() {
  const tokens = lerTokens();
  if (!tokens?.refresh_token) throw new Error('ML: sem refresh_token salvo');

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
    throw new Error(`ML refresh erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[mlToken] Token renovado ✓');
  return data.access_token;
}

async function garantirTokenML() {
  const tokens = lerTokens();
  if (!tokens?.access_token) throw new Error('ML: token não configurado. Acesse /setup-ml para autorizar.');

  // Testar se token ainda é válido
  const resp = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });

  if (resp.ok) return tokens.access_token;

  // Token expirado — renovar
  console.log('[mlToken] Token expirado, renovando...');
  return await renovarTokenML();
}

function gerarUrlAutorizacao() {
  return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
}

module.exports = { garantirTokenML, renovarTokenML, trocarCodigoPorToken, gerarUrlAutorizacao };
