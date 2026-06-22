'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, 'data', 'tokens.json');

// ── I/O ───────────────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

// guarda também QUANDO o token vence (expira_em), p/ renovar proativo sem gastar chamada-teste a cada uso
function salvarTokens(access_token, refresh_token, expires_in) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj = { access_token, refresh_token };
  if (expires_in) obj.expira_em = Date.now() + (Number(expires_in) * 1000);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
  console.log('[tokenManager] Tokens salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.BLING_CLIENT_ID;
  const sec = process.env.BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('BLING_CLIENT_ID / BLING_CLIENT_SECRET não definidos nas env vars');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuth(body) {
  const resp = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'enable-jwt': '1'
    },
    body: new URLSearchParams(body)
  });
  const data = await resp.json();
  if (data.error) throw new Error(`OAuth error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez) ─────────────────────────────────────

async function gerarTokenInicial(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.BLING_REDIRECT_URI || '';
  const data = await postOAuth({ grant_type: 'authorization_code', code: auth_code, redirect_uri });
  salvarTokens(data.access_token, data.refresh_token, data.expires_in);
  return { ok: true };
}

// ── Renovar token (com retry em falha transitória) ───────────────────

let _renovando = false; // evita refresh duplo simultâneo

async function renovarToken() {
  if (_renovando) {
    // aguarda o refresh em andamento terminar (até ~10s) e devolve o token já renovado
    for (let i = 0; i < 20 && _renovando; i++) await new Promise(r => setTimeout(r, 500));
    return lerTokens().access_token;
  }
  _renovando = true;
  try {
    console.log('[tokenManager] Renovando token...');
    const { refresh_token } = lerTokens();
    if (!refresh_token) throw new Error('refresh_token ausente — rode /setup primeiro');
    const redirect_uri = process.env.BLING_REDIRECT_URI || '';

    // só a CHAMADA é repetida; assim que ela vinga, salvamos e saímos
    // (nunca reusa um refresh_token já consumido por uma tentativa que deu certo)
    let data, ultimoErro;
    for (let tent = 1; tent <= 3; tent++) {
      try {
        data = await postOAuth({ grant_type: 'refresh_token', refresh_token, redirect_uri });
        break;
      } catch (e) {
        ultimoErro = e;
        if (tent < 3) {
          console.warn(`[tokenManager] refresh tentativa ${tent} falhou (${e.message}) — retry`);
          await new Promise(r => setTimeout(r, 1500 * tent));
        }
      }
    }
    if (!data) throw ultimoErro;

    salvarTokens(data.access_token, data.refresh_token, data.expires_in);
    console.log('[tokenManager] Token renovado ✓');
    return data.access_token;
  } finally {
    _renovando = false;
  }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirToken() {
  const t = lerTokens();
  const access_token = t.access_token;

  if (!access_token || access_token.length < 10) {
    console.log('[tokenManager] Token ausente — renovando');
    return renovarToken();
  }

  // se sabemos a validade: renova ANTES de vencer e devolve direto quando fresco
  // (sem gastar 1 chamada no Bling a cada operação — economia + menos pontos de falha)
  if (t.expira_em) {
    const MARGEM = 5 * 60 * 1000;                 // renova 5 min antes de expirar
    if (Date.now() >= (t.expira_em - MARGEM)) {
      console.log('[tokenManager] Token perto de vencer — renovando proativo');
      return renovarToken();
    }
    return access_token;
  }

  // token salvo por versão antiga (sem expira_em): valida com 1 chamada; se 401, renova.
  // Na 1ª renovação o expira_em passa a existir e daí em diante cai no caminho rápido acima.
  const resp = await fetch('https://api.bling.com.br/Api/v3/produtos?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  if (resp.status === 401) {
    console.log('[tokenManager] Token expirado (401) — renovando');
    return renovarToken();
  }
  return access_token;
}

module.exports = { garantirToken, renovarToken, gerarTokenInicial };
