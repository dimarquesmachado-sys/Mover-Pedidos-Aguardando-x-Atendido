'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const ML_TOKEN_FILE = process.env.GOOD_ML_TOKEN_FILE || '/data/good/ml-tokens.json';
const ML_CLIENT_ID     = process.env.GOOD_ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.GOOD_ML_CLIENT_SECRET;
const ML_REDIRECT_URI  = process.env.GOOD_ML_REDIRECT_URI;

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
    throw new Error('GOOD_ML_CLIENT_ID / GOOD_ML_CLIENT_SECRET não definidos');
  }
  /* Codex #344 r4: SEM teto aqui, DE PROPÓSITO — POST NÃO-idempotente. O ML
     rotaciona o refresh token (uso único) ao processar; abortar depois disso e
     antes de ler a resposta perderia o token novo pra sempre (só OAuth manual
     recupera). Quem chama limita a PRÓPRIA espera (ex.: comPrazo no ml-full) e
     esta promessa conclui em background, salvando o token rotacionado quando a
     resposta chegar. */
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
    throw new Error(`GOOD ML OAuth erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[GOOD mlToken] Token ML inicial obtido e salvo ✓');
  return data.access_token;
}

async function renovarTokenML() {
  const tokens = lerTokens();
  if (!tokens?.refresh_token) throw new Error('GOOD ML: sem refresh_token salvo');
  /* Codex #344 r4: SEM teto aqui, DE PROPÓSITO — POST NÃO-idempotente. O ML
     rotaciona o refresh token (uso único) ao processar; abortar depois disso e
     antes de ler a resposta perderia o token novo pra sempre (só OAuth manual
     recupera). Quem chama limita a PRÓPRIA espera (ex.: comPrazo no ml-full) e
     esta promessa conclui em background, salvando o token rotacionado quando a
     resposta chegar. */
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
    throw new Error(`GOOD ML refresh erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  salvarTokens(data);
  console.log('[GOOD mlToken] Token ML renovado ✓');
  return data.access_token;
}

/* Codex #355 (P1): o refresh do ML é de USO ÚNICO e este manager é chamado por
   MUITOS caminhos (F3, canário, motor ML Full, rota de leitura, crons) — dois
   chamadores cruzando a expiração ao mesmo tempo disparavam renovações
   concorrentes e uma queimava o refresh da outra. A RENOVAÇÃO agora é promessa
   ÚNICA module-level: todo chamador, de qualquer módulo, espera a MESMA. */
let _renovacaoEmVoo = null;
function _renovarUmaVez() {
  if (!_renovacaoEmVoo) {
    _renovacaoEmVoo = renovarTokenML().finally(() => { _renovacaoEmVoo = null; });
    _renovacaoEmVoo.catch(() => {});
  }
  return _renovacaoEmVoo;
}

async function garantirTokenML() {
  const tokens = lerTokens();
  if (!tokens?.access_token) throw new Error('GOOD ML: token não configurado. Acesse /good/setup-ml.');
  /* Codex #344 r4: sonda idempotente com ABORT de verdade — o timeout do
     node-fetch v2 é timer de corpo, e corpo nunca consumido (este fluxo só olha
     resp.ok) deixaria o socket vivo. O AbortController mata no prazo e o
     abort() final encerra o corpo não lido. */
  const acSonda = new AbortController();
  const tSonda = setTimeout(() => acSonda.abort(), 20000);
  let resp;
  try {
    resp = await fetch('https://api.mercadolibre.com/users/me', {
      signal: acSonda.signal, timeout: 20000,
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
  } finally { clearTimeout(tSonda); }
  acSonda.abort(); // corpo não consumido: encerra já, sem socket pendurado
  if (resp.ok) return tokens.access_token;
  /* Auditoria de 09/09 (Codex) + fato de campo do Devoluções (março): renovar em
     QUALQUER não-2xx queimava o refresh de USO ÚNICO por indisponibilidade
     transitória (429/5xx) — e na janela de sobreposição isso multiplica a chance
     dos dois serviços renovarem juntos. Mas o ML responde 403 com token VENCIDO
     (documentado em produção lá), então renovar só no 401 deixaria token morto.
     Vencimento provado = 401 OU 403 → renova; o resto é transitório → preserva. */
  if (resp.status !== 401 && resp.status !== 403) {
    throw new Error('GOOD ML: sonda inconclusiva (HTTP ' + resp.status + '); refresh preservado — transitório, tente de novo');
  }
  console.log('[GOOD mlToken] Token ML vencido (HTTP ' + resp.status + '), renovando...');
  return await _renovarUmaVez();
}

function gerarUrlAutorizacao() {
  if (!ML_CLIENT_ID || !ML_REDIRECT_URI) {
    throw new Error('GOOD_ML_CLIENT_ID / GOOD_ML_REDIRECT_URI não definidos');
  }
  return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
}

module.exports = { garantirTokenML, renovarTokenML, trocarCodigoPorToken, gerarUrlAutorizacao };
