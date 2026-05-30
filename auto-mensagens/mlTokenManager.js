'use strict';

/**
 * ML Token Manager — Auto Mensagens Girassol
 *
 * Gerencia OAuth do app ML "Auto Mensagens Girassol x MLivre" (Client ID 5813...).
 *
 * Token salvo em /data/auto-mensagens/ml-tokens.json
 *
 * Env vars:
 *   AUTO_MSG_GIRASSOL_ML_CLIENT_ID
 *   AUTO_MSG_GIRASSOL_ML_CLIENT_SECRET
 */

const fs = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.AUTO_MSG_GIRASSOL_ML_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AUTO_MSG_GIRASSOL_ML_CLIENT_SECRET || '';
const REDIRECT_URI  = 'https://mover-pedidos-aguardando-x-atendido.onrender.com/auto-mensagens/oauth/callback';

const DATA_DIR  = process.env.AUTO_MSG_DATA_DIR || '/data/auto-mensagens';
const TOKENS_FILE = path.join(DATA_DIR, 'ml-tokens.json');

function garantirDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function lerTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (e) {
    console.error('[auto-mensagens ml-token] erro lendo tokens:', e.message);
    return null;
  }
}

function salvarTokens(t) {
  garantirDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
}

function configurado() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function temTokens() {
  const t = lerTokens();
  return !!(t && t.access_token);
}

/**
 * Gera URL de autorização (Diego cola no navegador, loga, autoriza, copia code)
 */
function gerarUrlAutorizacao() {
  return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
}

/**
 * Troca o auth_code pelos access_token + refresh_token
 */
async function trocarCodigoPorToken(authCode) {
  if (!configurado()) throw new Error('Client ID/Secret não configurados nas env vars');
  if (!authCode) throw new Error('auth_code é obrigatório');

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: authCode,
      redirect_uri: REDIRECT_URI
    }).toString()
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OAuth ML erro ${r.status}: ${txt}`);
  const data = JSON.parse(txt);

  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    user_id:       data.user_id,
    expires_in:    data.expires_in,
    obtained_at:   Date.now()
  };
  salvarTokens(tokens);
  console.log(`[auto-mensagens ml-token] ✅ Token inicial salvo. user_id=${data.user_id}`);
  return tokens;
}

/**
 * Renova access_token usando refresh_token
 */
async function refreshToken() {
  const t = lerTokens();
  if (!t || !t.refresh_token) throw new Error('Nenhum refresh_token salvo. Refaça autorização.');

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: t.refresh_token
    }).toString()
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Refresh ML erro ${r.status}: ${txt}`);
  const data = JSON.parse(txt);

  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || t.refresh_token,
    user_id:       data.user_id || t.user_id,
    expires_in:    data.expires_in,
    obtained_at:   Date.now()
  };
  salvarTokens(tokens);
  console.log('[auto-mensagens ml-token] 🔄 Token renovado');
  return tokens;
}

/**
 * Retorna access_token válido (renova se necessário)
 * Margem de segurança: renova se faltam menos de 30 min pra expirar
 */
async function garantirTokenML() {
  let t = lerTokens();
  if (!t || !t.access_token) {
    throw new Error('Nenhum token. Faça autorização inicial em /auto-mensagens/setup');
  }
  const idade = (Date.now() - (t.obtained_at || 0)) / 1000; // em segundos
  const margem = 30 * 60; // 30 min
  const expiraEm = (t.expires_in || 21600) - idade;
  if (expiraEm < margem) {
    t = await refreshToken();
  }
  return t.access_token;
}

function getUserId() {
  const t = lerTokens();
  return t?.user_id || null;
}

module.exports = {
  configurado,
  temTokens,
  gerarUrlAutorizacao,
  trocarCodigoPorToken,
  refreshToken,
  garantirTokenML,
  getUserId,
  CLIENT_ID,
  REDIRECT_URI
};
