'use strict';
/* 15/11 — SESSÃO DE OPERADOR (cookie assinado HMAC), peça única (norte C: rotinas iguais nas três → peça).

   Eram as mesmas 21 linhas em girassol-backup-offline/gbo-app.js, amb-checkout-offline/index.js e
   good-checkout-offline/index.js: segredo estável entre restarts (ADMIN_KEY, já configurada no Render, como base),
   14 h de validade (cobre o turno), cookie `bkp_sess`. O cookie vale nas três empresas (mesmo segredo, mesmo nome) —
   é o mesmo operador andando entre os painéis no mesmo processo; isso já era assim, só não estava escrito num lugar só. */
const crypto = require('crypto');

const SESS_SECRET = process.env.ADMIN_KEY || process.env.SESSION_SECRET || 'bkp-sess-2026';
const SESS_TTL = 14 * 60 * 60 * 1000; // 14h (cobre o turno)
const SESS_COOKIE = 'bkp_sess';

function assinarSessao(nome) {
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + SESS_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESS_SECRET).update(pl).digest('base64url');
  return pl + '.' + sig;
}
function validarSessao(cookieHeader) {
  const m = new RegExp('(?:^|;\\s*)' + SESS_COOKIE + '=([^;]+)').exec(cookieHeader || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const esp = crypto.createHmac('sha256', SESS_SECRET).update(parts[0]).digest('base64url');
  if (parts[1] !== esp) return null;
  let pl; try { pl = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (e) { return null; }
  if (!pl.exp || Date.now() > pl.exp) return null;
  return pl.n;
}

module.exports = { SESS_SECRET, SESS_TTL, SESS_COOKIE, assinarSessao, validarSessao };
