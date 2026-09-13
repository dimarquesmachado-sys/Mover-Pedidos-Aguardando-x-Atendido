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
  /* Codex #210 (P1): devolver o resp cru reabria o hang pela porta dos fundos — o node-fetch
     resolve assim que os CABEÇALHOS chegam, o finally desarmava o timer, e um corpo mudo
     pendurava o resp.json() de fora com _renovando preso pra sempre (e a sonda nem consumia
     o corpo, deixando soquete parado vivo). Agora o CORPO é lido AQUI, ainda dentro do
     prazo, e o chamador recebe o já-lido: status + json() síncrono sobre texto em memória. */
  const ac = new AbortController();
  const tt = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
    const corpo = await resp.text();                       // consome dentro do prazo; abort derruba a leitura
    return {
      status: resp.status,
      ok: resp.ok,
      json: () => {
        try { return JSON.parse(corpo); }
        catch (e2) { throw new Error(rotulo + ': resposta não é JSON (' + String(corpo).slice(0, 80) + ')'); }
      }
    };
  } catch (e) {
    if (ac.signal.aborted) throw new Error(rotulo + ': prazo de ' + Math.round(ms / 1000) + 's estourado (Bling mudo)');
    throw e;
  } finally { clearTimeout(tt); }
};


const TOKEN_FILE = process.env.GOOD_TOKEN_FILE || '/data/good/bling-tokens.json';

// ── I/O ───────────────────────────────────────────────────────────────

function lerTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error('[GOOD tokenManager] Erro ao ler tokens:', e.message);
    return {};
  }
}

/* 13/09 — PORTE DA GIRASSOL (decisão do dono: "uma tem, outra não; agora ambas têm").
   Guardar QUANDO o token vence permite renovar proativo e devolver o token direto enquanto
   ele está fresco, em vez de gastar uma chamada de sonda no Bling a CADA operação. Numa casa
   onde a cota do Bling já derrubou bipagem de galpão, isso não é elegância: é chamada que
   deixa de ser feita o dia inteiro. */
function salvarTokens(access_token, refresh_token, expires_in) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj = { access_token, refresh_token };
  if (expires_in) obj.expira_em = Date.now() + (Number(expires_in) * 1000);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
  console.log('[GOOD tokenManager] Tokens Bling salvos em disco ✓');
}

// ── OAuth helpers ────────────────────────────────────────────────────

function basicAuth() {
  const id  = process.env.GOOD_BLING_CLIENT_ID;
  const sec = process.env.GOOD_BLING_CLIENT_SECRET;
  if (!id || !sec) throw new Error('GOOD_BLING_CLIENT_ID / GOOD_BLING_CLIENT_SECRET não definidos');
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
  if (data.error) throw new Error(`GOOD OAuth error: ${JSON.stringify(data)}`);
  return data;
}

// ── Gerar token inicial (uma vez) ─────────────────────────────────────

async function gerarTokenInicial(auth_code) {
  if (!auth_code) throw new Error('auth_code obrigatório');
  const redirect_uri = process.env.GOOD_BLING_REDIRECT_URI || '';
  const data = await postOAuth({ grant_type: 'authorization_code', code: auth_code, redirect_uri });
  salvarTokens(data.access_token, data.refresh_token, data.expires_in);   /* expires_in: sem ele o vencimento não é guardado e a economia de chamada não acontece */
  return { ok: true };
}

// ── Renovar token ─────────────────────────────────────────────────────

let _renovacaoEmVoo = null;

/* Codex #355 r3: a espera cega pelo refresh em curso lia o arquivo podendo devolver
   token EXPIRADO ao chamador (F3, cron, rota de leitura). Agora todo chamador espera
   a MESMA promessa — sem sono cego, sem token velho. O refresh do Bling também
   rotaciona, então a promessa única ainda evita refresh queimado. */

function renovarToken() {
  if (!_renovacaoEmVoo) {
    _renovacaoEmVoo = _renovarTokenDeVerdade().finally(() => { _renovacaoEmVoo = null; });
    _renovacaoEmVoo.catch(() => {});
  }
  return _renovacaoEmVoo;
}

async function _renovarTokenDeVerdade() {
  try {
    console.log('[GOOD tokenManager] Renovando token Bling...');
    const { refresh_token } = lerTokens();
    if (!refresh_token) throw new Error('refresh_token ausente — rode /good/setup primeiro');
    const redirect_uri = process.env.GOOD_BLING_REDIRECT_URI || '';
    const data = await postOAuth({ grant_type: 'refresh_token', refresh_token, redirect_uri });
    salvarTokens(data.access_token, data.refresh_token, data.expires_in);   /* expires_in: sem ele o vencimento não é guardado e a economia de chamada não acontece */
    console.log('[GOOD tokenManager] Token Bling renovado ✓');
    return data.access_token;
  } finally { /* o wrapper de promessa única limpa o em-voo */ }
}

// ── Garantir token válido ────────────────────────────────────────────

async function garantirToken() {
  const _tok = lerTokens();                     /* 13/09: o objeto inteiro, pra ler o expira_em */
  const { access_token } = _tok;

  if (!access_token || access_token.length < 10) {
    console.log('[GOOD tokenManager] Token Bling ausente — renovando');
    return renovarToken();
  }

  /* 13/09 — PORTE DA GIRASSOL: se sabemos a validade, renova ANTES de vencer e devolve o
     token direto enquanto está fresco. A sonda abaixo (1 chamada ao Bling por operação) só
     roda pra token gravado por versão antiga, sem expira_em; na 1ª renovação o campo passa a
     existir e daí em diante o caminho rápido assume. */
  if (_tok.expira_em) {
    const MARGEM = 5 * 60 * 1000;                 // renova 5 min antes de expirar
    if (Date.now() >= (_tok.expira_em - MARGEM)) {
      console.log('[GOOD tokenManager] Token perto de vencer — renovando proativo');
      return renovarToken();
    }
    return access_token;
  }

  const resp = await fetchComPrazo(20000, 'sonda de token', 'https://api.bling.com.br/Api/v3/produtos?limite=1', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (resp.status === 401) {
    console.log('[GOOD tokenManager] Token Bling expirado (401) — renovando');
    return renovarToken();
  }

  return access_token;
}

module.exports = { garantirToken, renovarToken, gerarTokenInicial };
