'use strict';

const crypto = require('crypto');
const { lerUsuarios } = require('./data');

const ADMIN_PASSWORD = process.env.FRAGIL_ADMIN_PASSWORD || null;

// ── Hash de senha (PBKDF2, Node nativo) ──────────────────────────────

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verificarSenha(senha, hashArmazenado) {
  try {
    if (!hashArmazenado || !hashArmazenado.includes(':')) return false;
    const [salt, hash] = hashArmazenado.split(':');
    const calc = crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (_) { return false; }
}

// ── Sessões em memória ───────────────────────────────────────────────

const sessoes = new Map(); // token -> { usuario, criadoEm, expiraEm }
const SESSAO_HORAS = 8;

function criarSessao(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  sessoes.set(token, {
    usuario,
    criadoEm: agora,
    expiraEm: agora + SESSAO_HORAS * 60 * 60 * 1000
  });
  return token;
}

function validarSessao(token) {
  if (!token) return null;
  const s = sessoes.get(token);
  if (!s) return null;
  if (s.expiraEm < Date.now()) {
    sessoes.delete(token);
    return null;
  }
  return s.usuario;
}

function removerSessao(token) {
  sessoes.delete(token);
}

// Limpa sessões expiradas a cada 1h
setInterval(() => {
  const agora = Date.now();
  for (const [token, s] of sessoes) {
    if (s.expiraEm < agora) sessoes.delete(token);
  }
}, 60 * 60 * 1000);

// ── Autenticação ─────────────────────────────────────────────────────

function autenticar(usuario, senha) {
  const lista = lerUsuarios();
  // Chave-mestra: se não há usuários, permite "admin" + FRAGIL_ADMIN_PASSWORD
  if (lista.length === 0) {
    if (usuario === 'admin' && ADMIN_PASSWORD && senha === ADMIN_PASSWORD) {
      return { ok: true, usuario: 'admin', perfil: 'admin', nome: 'Admin (chave-mestra)', chaveMestra: true };
    }
    return { ok: false, erro: 'Nenhum usuário cadastrado. Use o login admin com a senha mestra.' };
  }
  const u = lista.find(x => (x.usuario || '').toLowerCase() === (usuario || '').toLowerCase());
  if (!u) return { ok: false, erro: 'Usuário ou senha incorretos.' };
  if (!verificarSenha(senha, u.senhaHash)) return { ok: false, erro: 'Usuário ou senha incorretos.' };
  return { ok: true, usuario: u.usuario, perfil: u.perfil || 'admin', nome: u.nome || u.usuario };
}

module.exports = {
  hashSenha, verificarSenha,
  criarSessao, validarSessao, removerSessao,
  SESSAO_HORAS,
  autenticar,
  ADMIN_PASSWORD
};
