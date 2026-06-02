'use strict';

/**
 * Autenticação do módulo /good-drive-imagens
 *
 * Usuários lidos da env var GOODIMG_USUARIOS no formato:
 *   GOODIMG_USUARIOS=Diego:senha1,Fulano:senha2
 *
 * Primeiro usuário = admin, demais = funcionario (ou force com :admin / :func).
 * Senhas ficam só no Render (env vars criptografadas), o sistema compara strings.
 */

const crypto = require('crypto');

function parseUsuarios() {
  const raw = process.env.GOODIMG_USUARIOS || '';
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
const sessoes = new Map();
const SESSAO_HORAS = 12;

function criarSessao(usuario, perfil) {
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  sessoes.set(token, { usuario, perfil, criadoEm: agora, expiraEm: agora + SESSAO_HORAS * 3600 * 1000 });
  return token;
}

function validarSessao(token) {
  if (!token) return null;
  const s = sessoes.get(token);
  if (!s) return null;
  if (s.expiraEm < Date.now()) { sessoes.delete(token); return null; }
  return { usuario: s.usuario, perfil: s.perfil };
}

function removerSessao(token) { sessoes.delete(token); }

setInterval(() => {
  const agora = Date.now();
  for (const [token, s] of sessoes) {
    if (s.expiraEm < agora) sessoes.delete(token);
  }
}, 3600 * 1000);

function autenticar(usuario, senha) {
  if (USUARIOS.length === 0) {
    return { ok: false, erro: 'Nenhum usuário cadastrado. Configure GOODIMG_USUARIOS no Render.' };
  }
  const u = USUARIOS.find(x => x.usuario.toLowerCase() === String(usuario || '').toLowerCase());
  if (!u) return { ok: false, erro: 'Usuário ou senha inválidos' };
  if (u.senha !== String(senha || '')) return { ok: false, erro: 'Usuário ou senha inválidos' };
  return { ok: true, usuario: u.usuario, perfil: u.perfil };
}

module.exports = {
  autenticar,
  criarSessao, validarSessao, removerSessao,
  SESSAO_HORAS,
  totalUsuarios: USUARIOS.length
};
