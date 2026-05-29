'use strict';

/**
 * Autenticação do módulo /respostas-rapidas
 *
 * Usuários são lidos da env var RESPOSTAS_USUARIOS no formato:
 *   RESPOSTAS_USUARIOS=Diego:senha1,Lucas:senha2,Ygor:senha3
 *
 * O primeiro usuário da lista é "admin", os demais "funcionario".
 * Pode-se forçar perfil usando ":admin" ou ":func" no final:
 *   RESPOSTAS_USUARIOS=Diego:senha1:admin,Lucas:senha2:func
 *
 * Padrão idêntico ao /estoque (mesmo formato, mesmo comportamento).
 */

const crypto = require('crypto');

// ── Parse de usuários da env var ──────────────────────────────────────

function parseUsuarios() {
  const raw = process.env.RESPOSTAS_USUARIOS || '';
  if (!raw.trim()) return [];
  const lista = [];
  const partes = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i].split(':');
    const usuario = (p[0] || '').trim();
    const senha   = (p[1] || '').trim();
    let   perfil  = (p[2] || '').trim().toLowerCase();
    if (!usuario || !senha) continue;
    if (!['admin', 'func', 'funcionario'].includes(perfil)) {
      perfil = (i === 0) ? 'admin' : 'funcionario';
    }
    if (perfil === 'func') perfil = 'funcionario';
    lista.push({ usuario, senha, perfil });
  }
  return lista;
}

const USUARIOS = parseUsuarios();

// ── Sessões em memória ───────────────────────────────────────────────

const sessoes = new Map(); // token -> { usuario, perfil, criadoEm, expiraEm }
const SESSAO_HORAS = 12;

function criarSessao(usuario, perfil) {
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  sessoes.set(token, {
    usuario,
    perfil,
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
  return { usuario: s.usuario, perfil: s.perfil };
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
  if (USUARIOS.length === 0) {
    return { ok: false, erro: 'Nenhum usuário cadastrado. Configure RESPOSTAS_USUARIOS no Render.' };
  }
  const u = USUARIOS.find(x => x.usuario.toLowerCase() === String(usuario || '').toLowerCase());
  if (!u) return { ok: false, erro: 'Usuário ou senha inválidos' };
  if (u.senha !== String(senha || '')) {
    return { ok: false, erro: 'Usuário ou senha inválidos' };
  }
  return { ok: true, usuario: u.usuario, perfil: u.perfil };
}

function listarUsuarios() {
  return USUARIOS.map(u => ({ usuario: u.usuario, perfil: u.perfil }));
}

module.exports = {
  autenticar,
  criarSessao, validarSessao, removerSessao,
  listarUsuarios,
  SESSAO_HORAS,
  totalUsuarios: USUARIOS.length
};
