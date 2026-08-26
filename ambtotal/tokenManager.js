'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

/* 26/08 (prometido no PR #205): fetch SEM prazo aqui pendurava qualquer blingGet pra sempre
   quando o Bling aceitava a conexão e emudecia — e cada ciclo novo empilhava mais um soquete
   (o Codex mediu: um por invocação). O prazo LANÇA erro, e todo chamador já trata: o blingGet
   embrulha garantirToken em try/catch e devolve {ok:false} — falha normal, tenta no próximo.
   O OAuth ganha 60s DE PROPÓSITO: abortar uma rotação de refresh que o Bling processou mas
   não respondeu perderia o refresh novo (empresa fora do ar até reautorizar na mão) — 60s só
   corta buraco-negro de verdade. A sonda, leitura pura, corta em 20s sem risco nenhum. */
const fetchComPrazo = async (ms, rotulo, url, opts) => {
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  catch (e) {
    if (ac.signal.aborted) throw new Error(rotulo + ': prazo de ' + Math.round(ms / 1000) + 's estourado (Bling mudo)');
    throw e;
  } finally { clearTimeout(tt); }
};


const TOKEN_FILE = process.env.AMB_TOKEN_FILE || '/data/ambtotal/bling-tokens.json';

// ── I/O ───────────────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[AMB tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

function salvarTokens(access_token, refresh_token) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }, null, 2));
  console.log('[AMB tokenManager] Tokens Bling salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.AMB_BLING_CLIENT_ID;
  const sec = process.env.AMB_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('AMB_BLING_CLIENT_ID / AMB_BLING_CLIENT_SECRET não definidos');
  return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
}

async function postOAuth(body) {
  const resp = await fetchComPrazo(60000, 'renovação OAuth', 'https://api.bling.com.br/Api/v3/oauth/token', {
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
  if (data.error) throw new Error(`AMB OAuth error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez) ─────────────────────────────────────

async function gerarTokenInicial(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.AMB_BLING_REDIRECT_URI || '';
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
    console.log('[AMB tokenManager] Renovando token Bling...');
    const { refresh_token } = lerTokens();
    if (!refresh_token) throw new Error('refresh_token ausente — rode /amb/setup primeiro');
    const redirect_uri = process.env.AMB_BLING_REDIRECT_URI || '';
    const data = await postOAuth({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokens(data.access_token, data.refresh_token);
    console.log('[AMB tokenManager] Token Bling renovado ✓');
    return data.access_token;
  } finally {
    _renovando = false;
  }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirToken() {
  const { access_token } = lerTokens();

  if (!access_token || access_token.length < 10) {
    console.log('[AMB tokenManager] Token Bling ausente — renovando');
    return renovarToken();
  }

  const resp = await fetchComPrazo(20000, 'sonda de token', 'https://api.bling.com.br/Api/v3/produtos?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (resp.status === 401) {
    console.log('[AMB tokenManager] Token Bling expirado (401) — renovando');
    return renovarToken();
  }

  return access_token;
}

module.exports = { garantirToken, renovarToken, gerarTokenInicial };
