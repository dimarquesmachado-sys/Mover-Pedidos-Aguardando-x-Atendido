'use strict';

/**
 * Módulo /respostas-rapidas — Respostas Rápidas para Mercado Livre
 *
 * - Painel web em /respostas-rapidas/painel (login com env var RESPOSTAS_USUARIOS)
 * - Extensão Chrome consome /respostas-rapidas/api/respostas (auth via X-API-Key)
 * - Multi-loja: AMBTOTAL, GIRASSOL, GIMPO
 * - Dados em /data/respostas-rapidas/respostas.json
 *
 * Env vars:
 *   RESPOSTAS_USUARIOS   = "Diego:senha1,Lucas:senha2"
 *   RESPOSTAS_API_KEY    = "string-aleatoria-pra-extensao"
 *
 * Rotas:
 *   GET  /respostas-rapidas                → redirect /respostas-rapidas/painel
 *   GET  /respostas-rapidas/painel         → serve painel.html
 *   GET  /respostas-rapidas/health         → status
 *   POST /respostas-rapidas/api/login      → autentica (X-Session-Token)
 *   POST /respostas-rapidas/api/logout     → encerra sessão
 *   GET  /respostas-rapidas/api/admin/list → lista todas (JWT/sessão)
 *   POST /respostas-rapidas/api/admin/criar
 *   PUT  /respostas-rapidas/api/admin/editar/:id
 *   POST /respostas-rapidas/api/admin/excluir/:id
 *   GET  /respostas-rapidas/api/respostas  → consumida pela extensão (X-API-Key)
 *
 * Categorias válidas:
 *   - mensagens   (URL /vendas/novo/mensagens/ sem reclamação)
 *   - reclamacoes (URL com /reclamacao/ ou /mediacao/)
 *   - ambos       (aparece em mensagens E reclamações)
 */

const fs   = require('fs');
const path = require('path');

const auth = require('./auth');

const API_KEY  = process.env.RESPOSTAS_API_KEY || '';
const DATA_DIR = process.env.RESPOSTAS_DATA_DIR || '/data/respostas-rapidas';
const DATA_FILE = path.join(DATA_DIR, 'respostas.json');

const LOJAS_VALIDAS = ['AMBTOTAL', 'GIRASSOL', 'GIMPO'];
// Aceita 'geral' como sinônimo de 'ambos' (compatibilidade com respostas antigas)
const CATEGORIAS_VALIDAS = ['mensagens', 'reclamacoes', 'ambos'];
const CATEGORIA_AMBOS = 'ambos';
function normalizarCategoria(c) {
  if (c === 'geral') return 'ambos';
  return c;
}

// ── Helpers HTTP ─────────────────────────────────────────────────────

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function notFound(res) { return json(res, 404, { error: 'not found' }); }

// CORS — extensão Chrome consome de mercadolivre.com.br
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token, X-API-Key');
}

// Servir arquivo estático
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'respostas-rapidas');

function servirArquivo(res, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon'
  }[ext] || 'application/octet-stream';
  const fullPath = path.join(PUBLIC_DIR, relPath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return notFound(res);
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(fullPath).pipe(res);
}

// Serve arquivos da subpasta da loja: public/respostas-rapidas/{loja}/{arquivo}
// Fallback: se o arquivo não existir na subpasta, tenta na raiz public/respostas-rapidas/
// (útil pro painel.html que é único pra todas as lojas)
function servirArquivoSubpasta(res, loja, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon'
  }[ext] || 'application/octet-stream';
  const lojaDir = path.join(PUBLIC_DIR, loja);
  const fullPath = path.join(lojaDir, relPath);
  if (!fullPath.startsWith(lojaDir)) return notFound(res);
  // Tenta primeiro na subpasta da loja
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    res.writeHead(200, { 'Content-Type': mime });
    return fs.createReadStream(fullPath).pipe(res);
  }
  // Fallback: arquivo único na raiz (ex: painel.html)
  const fallbackPath = path.join(PUBLIC_DIR, relPath);
  if (fallbackPath.startsWith(PUBLIC_DIR) && fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isFile()) {
    res.writeHead(200, { 'Content-Type': mime });
    return fs.createReadStream(fallbackPath).pipe(res);
  }
  return notFound(res);
}

// ── Persistência ─────────────────────────────────────────────────────

function garantirDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function lerRespostas() {
  try {
    garantirDir();
    if (!fs.existsSync(DATA_FILE)) {
      const inicial = { respostas: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(inicial, null, 2));
      return inicial;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('[respostas-rapidas] erro ao ler:', e.message);
    return { respostas: [] };
  }
}

function salvarRespostas(dados) {
  garantirDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2));
}

// ── Autenticação de requisição ───────────────────────────────────────

function autenticarSessao(req) {
  const token = req.headers['x-session-token'] || '';
  if (!token) return { ok: false, erro: 'Não autenticado. Faça login.' };
  const sess = auth.validarSessao(token);
  if (!sess) return { ok: false, erro: 'Sessão expirada. Faça login novamente.' };
  return { ok: true, usuario: sess.usuario, perfil: sess.perfil };
}

function autenticarApiKey(req) {
  const key = req.headers['x-api-key'] || '';
  if (!API_KEY) return { ok: false, erro: 'RESPOSTAS_API_KEY não configurada no servidor' };
  if (key !== API_KEY) return { ok: false, erro: 'API key inválida' };
  return { ok: true };
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleLogin(req, res, body) {
  const { usuario, senha } = body || {};
  const r = auth.autenticar(usuario, senha);
  if (!r.ok) {
    return json(res, 401, { ok: false, erro: r.erro });
  }
  const token = auth.criarSessao(r.usuario, r.perfil);
  console.log(`[respostas-rapidas LOGIN] ${r.usuario} (${r.perfil})`);
  return json(res, 200, {
    ok: true,
    token,
    usuario: r.usuario,
    perfil: r.perfil,
    expiraHoras: auth.SESSAO_HORAS
  });
}

async function handleListar(req, res) {
  const a = autenticarSessao(req);
  if (!a.ok) return json(res, 401, { ok: false, erro: a.erro });
  const { respostas } = lerRespostas();
  return json(res, 200, { ok: true, respostas });
}

async function handleCriar(req, res, body) {
  const a = autenticarSessao(req);
  if (!a.ok) return json(res, 401, { ok: false, erro: a.erro });

  let { loja, categoria, titulo, texto } = body || {};
  categoria = normalizarCategoria(categoria);
  if (!loja || !categoria || !titulo || !texto) {
    return json(res, 400, { ok: false, erro: 'loja, categoria, titulo e texto são obrigatórios' });
  }
  if (!LOJAS_VALIDAS.includes(loja)) {
    return json(res, 400, { ok: false, erro: `Loja inválida. Use: ${LOJAS_VALIDAS.join(', ')}` });
  }
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return json(res, 400, { ok: false, erro: `Categoria inválida. Use: ${CATEGORIAS_VALIDAS.join(', ')}` });
  }

  const dados = lerRespostas();
  const novaOrdem = dados.respostas.filter(r => r.loja === loja && r.categoria === categoria).length;
  const nova = {
    id: Date.now().toString(),
    loja,
    categoria,
    titulo: String(titulo).trim(),
    texto: String(texto).trim(),
    ordem: novaOrdem,
    criadoEm: new Date().toISOString(),
    criadoPor: a.usuario
  };
  dados.respostas.push(nova);
  salvarRespostas(dados);
  console.log(`[respostas-rapidas] ${a.usuario} criou: ${loja}/${categoria}/${titulo}`);
  return json(res, 200, { ok: true, resposta: nova });
}

async function handleEditar(req, res, body, id) {
  const a = autenticarSessao(req);
  if (!a.ok) return json(res, 401, { ok: false, erro: a.erro });

  const dados = lerRespostas();
  const idx = dados.respostas.findIndex(r => r.id === id);
  if (idx === -1) return json(res, 404, { ok: false, erro: 'Resposta não encontrada' });

  const { loja, titulo, texto, ordem } = body || {};
  let categoria = normalizarCategoria(body?.categoria);
  if (loja !== undefined) {
    if (!LOJAS_VALIDAS.includes(loja)) return json(res, 400, { ok: false, erro: 'Loja inválida' });
    dados.respostas[idx].loja = loja;
  }
  if (categoria !== undefined) {
    if (!CATEGORIAS_VALIDAS.includes(categoria)) return json(res, 400, { ok: false, erro: 'Categoria inválida' });
    dados.respostas[idx].categoria = categoria;
  }
  if (titulo !== undefined) dados.respostas[idx].titulo = String(titulo).trim();
  if (texto !== undefined) dados.respostas[idx].texto = String(texto).trim();
  if (ordem !== undefined) dados.respostas[idx].ordem = Number(ordem);
  dados.respostas[idx].editadoEm = new Date().toISOString();
  dados.respostas[idx].editadoPor = a.usuario;

  salvarRespostas(dados);
  return json(res, 200, { ok: true, resposta: dados.respostas[idx] });
}

async function handleExcluir(req, res, id) {
  const a = autenticarSessao(req);
  if (!a.ok) return json(res, 401, { ok: false, erro: a.erro });

  const dados = lerRespostas();
  const tamanhoAntes = dados.respostas.length;
  dados.respostas = dados.respostas.filter(r => r.id !== id);
  if (dados.respostas.length === tamanhoAntes) {
    return json(res, 404, { ok: false, erro: 'Resposta não encontrada' });
  }
  salvarRespostas(dados);
  console.log(`[respostas-rapidas] ${a.usuario} excluiu: ${id}`);
  return json(res, 200, { ok: true });
}

async function handleApiPublica(req, res, urlObj) {
  const a = autenticarApiKey(req);
  if (!a.ok) return json(res, 401, { ok: false, erro: a.erro });

  const loja = urlObj.searchParams.get('loja');
  const categoria = urlObj.searchParams.get('categoria');
  if (!loja) return json(res, 400, { ok: false, erro: 'parâmetro loja obrigatório' });

  const { respostas } = lerRespostas();
  let filtradas = respostas.filter(r => r.loja === loja);
  if (categoria) {
    filtradas = filtradas.filter(r => {
      const cat = normalizarCategoria(r.categoria);
      return cat === categoria || cat === CATEGORIA_AMBOS;
    });
  }
  filtradas.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  return json(res, 200, { ok: true, respostas: filtradas });
}

// ── Rotas ────────────────────────────────────────────────────────────

function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (p !== '/respostas-rapidas' && !p.startsWith('/respostas-rapidas/')) return false;

    setCors(res);
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    // ─ Frontend estático ─
    if (method === 'GET' && p === '/respostas-rapidas') {
      res.writeHead(302, { Location: '/respostas-rapidas/painel' });
      res.end();
      return true;
    }

    // Lojas: rotas /respostas-rapidas/{loja}/painel e /respostas-rapidas/{loja}/{arquivo}
    // Lojas válidas pra paths estáticos
    const matchLoja = p.match(/^\/respostas-rapidas\/(ambtotal|girassol|gimpo)(\/.*)?$/i);
    if (method === 'GET' && matchLoja) {
      const loja = matchLoja[1].toLowerCase();
      const sub = (matchLoja[2] || '').replace(/^\//, '');
      // /respostas-rapidas/{loja}  ou  /respostas-rapidas/{loja}/painel  → serve painel.html
      if (sub === '' || sub === 'painel') {
        servirArquivoSubpasta(res, loja, 'painel.html');
        return true;
      }
      // Outros arquivos: favicon.ico, favicon-32.png, manifest.json, etc.
      if (/\.(ico|png|jpg|svg|json|css|js|html)$/i.test(sub)) {
        servirArquivoSubpasta(res, loja, sub);
        return true;
      }
    }

    // Rota genérica (sem loja) — ainda funciona pra compatibilidade
    if (method === 'GET' && p === '/respostas-rapidas/painel') {
      servirArquivo(res, 'painel.html');
      return true;
    }
    if (method === 'GET' && p.startsWith('/respostas-rapidas/static/')) {
      const rel = p.replace('/respostas-rapidas/static/', '');
      servirArquivo(res, rel);
      return true;
    }
    if (method === 'GET' && /\.(ico|png|jpg|svg|json|css|js)$/i.test(p)) {
      const rel = p.replace('/respostas-rapidas/', '');
      servirArquivo(res, rel);
      return true;
    }

    // ─ Health ─
    if (method === 'GET' && p === '/respostas-rapidas/health') {
      return json(res, 200, {
        ok: true,
        modulo: 'respostas-rapidas',
        usuariosCadastrados: auth.totalUsuarios,
        apiKeyConfigurada: !!API_KEY,
        totalRespostas: lerRespostas().respostas.length,
        ts: Date.now()
      }), true;
    }

    // ─ LOGIN ─
    if (method === 'POST' && p === '/respostas-rapidas/api/login') {
      const body = await readBody(req);
      await handleLogin(req, res, body);
      return true;
    }

    // ─ LOGOUT ─
    if (method === 'POST' && p === '/respostas-rapidas/api/logout') {
      const token = req.headers['x-session-token'] || '';
      if (token) auth.removerSessao(token);
      return json(res, 200, { ok: true }), true;
    }

    // ─ ADMIN: listar todas (sessão) ─
    if (method === 'GET' && p === '/respostas-rapidas/api/admin/list') {
      await handleListar(req, res);
      return true;
    }

    // ─ ADMIN: criar (sessão) ─
    if (method === 'POST' && p === '/respostas-rapidas/api/admin/criar') {
      const body = await readBody(req);
      await handleCriar(req, res, body);
      return true;
    }

    // ─ ADMIN: editar (sessão) ─
    if (method === 'PUT' && p.startsWith('/respostas-rapidas/api/admin/editar/')) {
      const id = p.replace('/respostas-rapidas/api/admin/editar/', '');
      const body = await readBody(req);
      await handleEditar(req, res, body, id);
      return true;
    }

    // ─ ADMIN: excluir (sessão) ─
    if (method === 'POST' && p.startsWith('/respostas-rapidas/api/admin/excluir/')) {
      const id = p.replace('/respostas-rapidas/api/admin/excluir/', '');
      await handleExcluir(req, res, id);
      return true;
    }

    // ─ API PÚBLICA: extensão Chrome (API_KEY) ─
    if (method === 'GET' && p === '/respostas-rapidas/api/respostas') {
      await handleApiPublica(req, res, urlObj);
      return true;
    }

    return false; // /respostas-rapidas/* desconhecido — cai pro 404 global
  };
}

// ── Bootstrap ────────────────────────────────────────────────────────

function bootstrap() {
  setTimeout(() => {
    garantirDir();
    const total = lerRespostas().respostas.length;
    console.log(`[respostas-rapidas] Pronto. ${total} respostas carregadas. ${auth.totalUsuarios} usuário(s).`);
    if (!API_KEY) console.warn('[respostas-rapidas] ⚠️  RESPOSTAS_API_KEY não configurada — extensão não funcionará');
    if (auth.totalUsuarios === 0) console.warn('[respostas-rapidas] ⚠️  RESPOSTAS_USUARIOS não configurada — painel sem login');
  }, 3000);
}

// ── Exporta interface compatível com config/empresas ─────────────────

module.exports = {
  id: 'respostas-rapidas',
  nome: 'Respostas Rápidas ML',
  rotinas: {},
  routes,
  crons: {},
  bootstrap
};
