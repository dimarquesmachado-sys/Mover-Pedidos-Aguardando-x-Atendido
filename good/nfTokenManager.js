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

/* Codex #355 r4: fetch SEM teto — com a promessa única, UMA chamada travada pendurava
   TODOS os chamadores pra sempre (antes, o sono cego de 2s 'protegia' por acidente).
   Prazo de 20s com abort de verdade e corpo lido DENTRO do prazo (receita do
   tokenManager reformado). */
async function _nfFetch(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const resp = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
    const texto = await resp.text();
    return { status: resp.status, json: () => { try { return JSON.parse(texto); } catch (e) { return null; } } };
  } finally { clearTimeout(t); }
}

async function postOAuthNF(body) {
  /* Codex #355 r5: a TROCA do refresh ROTATIVO nunca é abortada — o servidor pode já
     ter rotacionado quando o prazo estourasse, e abortar a leitura perderia o token
     novo pra sempre (reautorização manual). Mesma decisão do mlTokenManager (#344):
     o teto é do CHAMADOR (rota/fluxo), e a promessa única segue viva em background
     até persistir. A VALIDAÇÃO (GET idempotente) continua com prazo no _nfFetch. */
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
  const cru = await resp.text();
  let data = null; try { data = JSON.parse(cru); } catch (e) { data = null; }
  /* Codex #355 r5: resposta não-JSON (HTML de 502, corpo truncado) virava {} sem
     data.error e o caminho salvava credencial undefined — APAGANDO o refresh ainda
     válido. Forma validada ANTES de qualquer salvamento. */
  if (!resp.ok || !data || !data.access_token || !data.refresh_token) {
    throw new Error('GOOD NF OAuth: resposta inválida (HTTP ' + resp.status + '): ' + String(cru).slice(0, 120));
  }
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

let _renovacaoEmVoo = null;

/* Codex #355 r3: a espera cega pelo refresh em curso lia o arquivo podendo devolver
   token EXPIRADO ao chamador (F3, cron, rota de leitura). Agora todo chamador espera
   a MESMA promessa — sem sono cego, sem token velho. O refresh do Bling também
   rotaciona, então a promessa única ainda evita refresh queimado. */

function renovarTokenNF() {
  if (!_renovacaoEmVoo) {
    _renovacaoEmVoo = _renovarTokenNFDeVerdade().finally(() => { _renovacaoEmVoo = null; });
    _renovacaoEmVoo.catch(() => {});
  }
  return _renovacaoEmVoo;
}

async function _renovarTokenNFDeVerdade() {
  try {
    console.log('[GOOD nfTokenManager] Renovando token NF...');
    const { refresh_token } = lerTokensNF();
    if (!refresh_token) throw new Error('GOOD NF: refresh_token ausente — rode /good/setup-nf primeiro');
    const redirect_uri = process.env.GOOD_NF_BLING_REDIRECT_URI || '';
    const data = await postOAuthNF({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokensNF(data.access_token, data.refresh_token);
    console.log('[GOOD nfTokenManager] Token NF renovado ✓');
    return data.access_token;
  } finally { /* o wrapper de promessa única limpa o em-voo */ }
}

async function garantirTokenNF() {
  const { access_token } = lerTokensNF();

  if (!access_token || access_token.length < 10) {
    console.log('[GOOD nfTokenManager] Token NF ausente — renovando');
    return renovarTokenNF();
  }

  // Valida usando /nfe (mesmo scope do app) em vez de /produtos
  const resp = await _nfFetch('https://api.bling.com.br/Api/v3/nfe?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  /* Codex #362 r1: o cenário-ALVO da sonda /nfe — token sem a permissão de notas —
     responde 403 insufficient_scope, e cair no caminho do "segue o token" devolvia
     um token inútil que falharia na emissão. Renovar não conserta escopo (o refresh
     preserva as permissões): o 403 LANÇA com instrução de reautorizar. */
  if (resp.status === 403) {
    throw new Error('token NF sem a permissão de notas fiscais (403 na sonda /nfe) — reautorize o app NF em /good/setup-nf');
  }
  if (resp.status === 401) {
    console.log('[GOOD nfTokenManager] Token NF expirado (401) — renovando');
    return renovarTokenNF();
  }

  return access_token;
}

module.exports = { garantirTokenNF, renovarTokenNF, gerarTokenInicialNF };
