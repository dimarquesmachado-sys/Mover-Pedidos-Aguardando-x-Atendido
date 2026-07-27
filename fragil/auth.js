'use strict';

/**
 * Fragil — autenticação
 *
 * Os usuários vêm da env var FRAGIL_USUARIOS (fonte única, no Render).
 *
 *   FRAGIL_USUARIOS = diego:MinhaSenha123,lucas:OutraSenha456
 *
 * - Separador ENTRE usuários: vírgula (,) ou ponto-e-vírgula (;)
 * - Separador login/senha: o PRIMEIRO dois-pontos (:) da entrada
 * - A senha pode conter ":" (só o primeiro separa), mas NÃO pode conter "," nem ";"
 * - Espaços em volta são ignorados
 *
 * Não existe mais usuarios.json em disco nem chave-mestra "admin".
 * Pra dar/tirar acesso: Render → Mover-Pedidos-Aguardando-x-Atendido →
 * Environment → editar FRAGIL_USUARIOS (o serviço reinicia sozinho).
 */

const crypto = require('crypto');

const SESSAO_HORAS = 8;

// ── Parse da env var ──────────────────────────────────────────────────
function parseUsuarios(raw) {
  const out = [];
  if (!raw) return out;
  const partes = String(raw).split(/[,;]/);
  for (const parte of partes) {
    const t = parte.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 0) continue;                       // sem senha → ignora a entrada
    const usuario = t.slice(0, i).trim();
    const senha   = t.slice(i + 1).trim();
    if (!usuario || !senha) continue;
    // Se o mesmo login aparecer duas vezes, vale o primeiro
    if (out.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) continue;
    out.push({ usuario, senha, nome: usuario, perfil: 'admin' });
  }
  return out;
}

// Lista pública (sem senha nunca sai daqui pra fora — quem chama decide o que expor)
function listarUsuarios() {
  return parseUsuarios(process.env.FRAGIL_USUARIOS);
}

// ── Comparação resistente a timing attack ─────────────────────────────
function comparar(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

// ── Autenticação ──────────────────────────────────────────────────────
function autenticar(usuario, senha) {
  const lista = listarUsuarios();
  if (lista.length === 0) {
    return {
      ok: false,
      erro: 'Nenhum usuário configurado. Defina FRAGIL_USUARIOS nas variáveis de ambiente do Render (formato usuario:senha).'
    };
  }
  const login = String(usuario || '').trim().toLowerCase();
  const u = lista.find(x => x.usuario.toLowerCase() === login);
  if (!u) return { ok: false, erro: 'Usuário ou senha incorretos.' };
  if (!comparar(u.senha, String(senha || ''))) return { ok: false, erro: 'Usuário ou senha incorretos.' };
  return { ok: true, usuario: u.usuario, perfil: u.perfil, nome: u.nome };
}

// ── Sessões (em memória) ──────────────────────────────────────────────
const sessoes = new Map();

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
  if (s.expiraEm < Date.now()) { sessoes.delete(token); return null; }
  // Se o usuário foi removido da env var, a sessão dele cai na hora
  const lista = listarUsuarios();
  const aindaExiste = lista.some(u => u.usuario.toLowerCase() === s.usuario.toLowerCase());
  if (!aindaExiste) { sessoes.delete(token); return null; }
  return s.usuario;
}

function removerSessao(token) {
  if (token) sessoes.delete(token);
}

// Limpeza periódica das sessões expiradas (1x por hora)
const _limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [t, s] of sessoes) {
    if (s.expiraEm < agora) sessoes.delete(t);
  }
}, 60 * 60 * 1000);
if (_limpeza && typeof _limpeza.unref === 'function') _limpeza.unref();

// ── Compat com a versão anterior deste arquivo ────────────────────────
// hashSenha/verificarSenha não são mais usados no login (as senhas vêm da
// env var), mas continuam exportados porque outros pontos podem importá-los.
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

// Mantido só pra não quebrar quem importe `auth.ADMIN_PASSWORD`.
// Não participa mais de nenhuma decisão de login.
const ADMIN_PASSWORD = process.env.FRAGIL_ADMIN_PASSWORD || null;

module.exports = {
  hashSenha, verificarSenha,
  criarSessao, validarSessao, removerSessao,
  SESSAO_HORAS,
  autenticar,
  listarUsuarios,
  ADMIN_PASSWORD
};
