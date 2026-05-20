'use strict';

/**
 * Módulo /estoque — Sistema de localização e estoque para warehouse
 *
 * - PWA mobile em /estoque/celular (leitor de código de barras)
 * - Extensão Chrome consome /estoque/buscar e /estoque/salvar
 * - Login via env var ESTOQUE_USUARIOS
 * - OAuth Bling próprio (env vars ESTOQUE_BLING_*)
 *
 * Rotas:
 *   GET  /estoque                     → redirect /estoque/celular
 *   GET  /estoque/celular             → serve celular.html
 *   GET  /estoque/health              → status
 *   GET  /estoque/cache-status        → debug cache
 *   POST /estoque/login               → autentica (compat com PWA atual)
 *   POST /estoque/api/login           → autentica (padrão novo)
 *   POST /estoque/api/logout          → encerra sessão
 *   GET  /estoque/buscar              → busca produto (compat com extensão)
 *   GET  /estoque/api/buscar          → busca produto (padrão novo)
 *   POST /estoque/salvar              → atualiza localização (compat com extensão)
 *   POST /estoque/api/salvar          → atualiza localização (padrão novo)
 *   GET  /estoque/auth/bling          → inicia OAuth Bling
 *   GET  /estoque/bling/callback      → recebe code do OAuth
 */

const fs   = require('fs');
const path = require('path');

const auth          = require('./auth');
const tokenManager  = require('./tokenManager');
const blingProdutos = require('./blingProdutos');

const API_KEY = process.env.ESTOQUE_API_KEY || '';

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

// CORS — extensão Chrome consome de domínio bling.com.br
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
}

// Servir arquivo estático
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'estoque');

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

// ── AUTENTICAÇÃO (v2) ────────────────────────────────────────────────
// Aceita JWT (X-Session-Token) OU API_KEY (fallback)
function autenticarRequest(req, urlObj, bodyKey) {
  const token = req.headers['x-session-token'] || '';
  if (token) {
    const sess = auth.validarSessao(token);
    if (sess) return { ok: true, via: 'jwt', usuario: sess.usuario, perfil: sess.perfil };
    return { ok: false, erro: 'Sessão expirada. Faça login novamente.' };
  }
  const key = (urlObj && urlObj.searchParams.get('key')) || bodyKey || (req.headers['x-api-key'] || '');
  if (key && API_KEY && key === API_KEY) {
    console.log('[estoque] ⚠️  Autenticação via API_KEY (deprecated). Migre para JWT.');
    return { ok: true, via: 'apikey' };
  }
  return { ok: false, erro: 'Não autenticado. Faça login.' };
}

// Pega usuário da sessão (header X-Session-Token)
function pegarUsuario(req) {
  const token = req.headers['x-session-token'] || '';
  return auth.validarSessao(token);
}

// ── Handlers compartilhados (compat + api) ───────────────────────────

async function handleBuscar(req, res, urlObj) {
  const a = autenticarRequest(req, urlObj, null);
  if (!a.ok) {
    return json(res, 401, { ok: false, erro: a.erro || 'API key inválida' });
  }
  try {
    const tipo = String(urlObj.searchParams.get('tipo') || '').toUpperCase();
    const codigo = urlObj.searchParams.get('codigo') || '';
    const forcar = urlObj.searchParams.get('forcar') === '1';
    if (!['SKU', 'EAN'].includes(tipo)) {
      return json(res, 200, { ok: false, erro: 'Tipo inválido' });
    }
    const resultado = await blingProdutos.resolverProduto(tipo, codigo, forcar);
    if (!resultado.ok || !resultado.produto) {
      return json(res, 200, { ok: false, erro: resultado.erro || 'Produto não encontrado' });
    }
    return json(res, 200, { ok: true, produto: blingProdutos.formatarProduto(resultado.produto) });
  } catch (e) {
    console.error('[estoque /buscar] ERRO:', e.message);
    return json(res, 200, { ok: false, erro: blingProdutos.traduzirErroBling(e.message) });
  }
}

async function handleSalvar(req, res, body, urlObj) {
  const { key, codigo, tipo, novaLocalizacao } = body || {};
  const a = autenticarRequest(req, urlObj, key);
  if (!a.ok) {
    return json(res, 401, { ok: false, erro: a.erro || 'API key inválida' });
  }
  try {
    const localizacaoFinal = String(novaLocalizacao ?? '');

    let resultado = null;
    if (tipo && String(tipo).toUpperCase() === 'EAN') {
      resultado = await blingProdutos.resolverProduto('EAN', codigo);
    } else {
      resultado = await blingProdutos.resolverProduto('SKU', codigo);
      if (!resultado.ok) resultado = await blingProdutos.resolverProduto('EAN', codigo);
    }

    if (!resultado.ok || !resultado.produto?.id) {
      return json(res, 200, { ok: false, erro: 'Produto não encontrado' });
    }

    const r = await blingProdutos.atualizarLocalizacao(resultado.produto, localizacaoFinal);
    if (!r.ok) return json(res, 200, { ok: false, erro: r.erro });

    return json(res, 200, {
      ok: true,
      produto: {
        id: resultado.produto.id,
        codigo: resultado.produto.codigo || '',
        nome: resultado.produto.nome || '',
        localizacao: localizacaoFinal
      }
    });
  } catch (e) {
    console.error('[estoque /salvar] ERRO:', e.message);
    return json(res, 200, { ok: false, erro: blingProdutos.traduzirErroBling(e.message) });
  }
}

async function handleLogin(req, res, body) {
  const { usuario, senha } = body || {};
  const r = auth.autenticar(usuario, senha);
  if (!r.ok) {
    // Compat com PWA atual: retorna { sucesso: false, mensagem }
    return json(res, 401, { ok: false, sucesso: false, erro: r.erro, mensagem: r.erro });
  }
  const token = auth.criarSessao(r.usuario, r.perfil);
  console.log(`[estoque LOGIN] ${r.usuario} (${r.perfil})`);
  // Compat: retorna ambos formatos
  return json(res, 200, {
    ok: true,
    sucesso: true,
    token,
    usuario: r.usuario,
    perfil: r.perfil,
    expiraHoras: auth.SESSAO_HORAS
  });
}

// ── Rotas ────────────────────────────────────────────────────────────

function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (p !== '/estoque' && !p.startsWith('/estoque/')) return false;

    setCors(res);
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    // ─ Frontend estático ─
    if (method === 'GET' && p === '/estoque') {
      res.writeHead(302, { Location: '/estoque/celular' });
      res.end();
      return true;
    }
    if (method === 'GET' && p === '/estoque/celular') {
      servirArquivo(res, 'celular.html');
      return true;
    }
    if (method === 'GET' && p.startsWith('/estoque/static/')) {
      const rel = p.replace('/estoque/static/', '');
      servirArquivo(res, rel);
      return true;
    }

    // Servir favicon, manifest, e outros arquivos diretamente em /estoque/{arquivo}
    if (method === 'GET' && /\.(ico|png|jpg|svg|json|css|js)$/i.test(p)) {
      const rel = p.replace('/estoque/', '');
      servirArquivo(res, rel);
      return true;
    }

    // ─ Health ─
    if (method === 'GET' && p === '/estoque/health') {
      const tokens = tokenManager.lerTokens();
      return json(res, 200, {
        ok: true,
        usuariosCadastrados: auth.totalUsuarios,
        apiKeyConfigurada: !!API_KEY,
        blingConfigurado: !!process.env.ESTOQUE_BLING_CLIENT_ID && !!process.env.ESTOQUE_BLING_CLIENT_SECRET,
        blingLogado: !!(tokens.access_token || tokens.refresh_token),
        ...blingProdutos.getCacheStatus()
      }), true;
    }

    if (method === 'GET' && p === '/estoque/cache-status') {
      return json(res, 200, blingProdutos.getCacheStatus()), true;
    }

    // ─ LOGIN (compat + api) ─
    if (method === 'POST' && (p === '/estoque/login' || p === '/estoque/api/login')) {
      const body = await readBody(req);
      await handleLogin(req, res, body);
      return true;
    }

    // ─ LOGOUT ─
    if (method === 'POST' && p === '/estoque/api/logout') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      auth.removerSessao(req.headers['x-session-token']);
      json(res, 200, { ok: true });
      return true;
    }

    // ─ BUSCAR (compat + api) ─
    if (method === 'GET' && (p === '/estoque/buscar' || p === '/estoque/api/buscar')) {
      await handleBuscar(req, res, urlObj);
      return true;
    }

    // ─ SALVAR (compat + api) ─
    if (method === 'POST' && (p === '/estoque/salvar' || p === '/estoque/api/salvar')) {
      const body = await readBody(req);
await handleSalvar(req, res, body, urlObj);
      return true;
    }

    // ─ OAuth Bling ─
    if (method === 'GET' && p === '/estoque/auth/bling') {
      const cid = process.env.ESTOQUE_BLING_CLIENT_ID;
      if (!cid) { json(res, 500, { erro: 'ESTOQUE_BLING_CLIENT_ID não configurado' }); return true; }
      const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${encodeURIComponent(cid)}&state=${Date.now()}`;
      res.writeHead(302, { Location: url });
      res.end();
      return true;
    }

    if (method === 'GET' && p === '/estoque/bling/callback') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ Estoque: Código não recebido</h2>'); return true; }
      try {
        await tokenManager.gerarTokenInicial(code);
        // Dispara carregamento dos produtos em background
        setTimeout(() => blingProdutos.carregarIndiceListagem().catch(e => console.error(e)), 1500);
        html(res, 200, `
          <html><body style="font-family:Arial;padding:40px;text-align:center;">
            <h1 style="color:#28a745;">✅ Login Bling Estoque concluído!</h1>
            <p>Tokens salvos. Carregamento dos produtos iniciado em background.</p>
            <p><a href="/estoque/celular">Abrir PWA mobile</a></p>
          </body></html>
        `);
      } catch (e) {
        console.error('[estoque OAUTH]', e);
        html(res, 500, `<h2>❌ Erro OAuth: ${e.message}</h2>`);
      }
      return true;
    }

    return false; // /estoque/* desconhecido — deixa cair pro 404 global
  };
}

// ── Bootstrap ────────────────────────────────────────────────────────
// Dispara carregamento do índice de produtos no startup (se tiver tokens)

function bootstrap() {
  setTimeout(() => {
    const tokens = tokenManager.lerTokens();
    if (tokens.access_token || tokens.refresh_token) {
      blingProdutos.carregarIndiceListagem().catch(e => console.error('[estoque bootstrap]', e));
    } else {
      console.log('[estoque] Sem tokens Bling — acesse /estoque/auth/bling pra autorizar');
    }
  }, 7000); // 7s — depois do fragil (5s) pra não competir por API rate-limit
}

// ── Exporta interface compatível com config/empresas ─────────────────

module.exports = {
  id: 'estoque',
  nome: 'Estoque (Localização Warehouse)',
  rotinas: {},
  routes,
  crons: {},
  bootstrap
};
