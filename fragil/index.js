'use strict';

/**
 * Módulo Fragil — Painel de SKUs frágeis + extensão de checkout
 *
 * Diferente dos módulos de empresa (girassol/ambtotal/good), este módulo:
 * - NÃO tem F1/F2/CorrigirNFs (não interage com pedidos)
 * - Serve um frontend web em /fragil/
 * - Tem API de SKUs frágeis (GET público, POST autenticado)
 * - Tem login com sessão
 * - Tem OAuth Bling pra autocomplete de produtos
 * - Tem cache de produtos do Bling
 *
 * Cron único: carregar índice de produtos no startup (chama uma vez ao iniciar).
 */

const fs   = require('fs');
const path = require('path');

const { lerDados, salvarDados, lerUsuarios, salvarUsuarios } = require('./data');
const auth         = require('./auth');
const tokenManager = require('./tokenManager');
const blingProdutos = require('./blingProdutos');

// ── Helpers HTTP locais ───────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function notFound(res) { return json(res, 404, { error: 'not found' }); }

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// CORS — extensão precisa acessar /fragil/api/skus de outros domínios
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
}

// Pega usuário da sessão (header X-Session-Token)
function pegarUsuario(req) {
  const token = req.headers['x-session-token'] || '';
  return auth.validarSessao(token);
}

// Servir arquivo estático do public/fragil/
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'fragil');

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
  // Proteção contra path traversal
  if (!fullPath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return notFound(res);
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(fullPath).pipe(res);
}

// ── Rotas HTTP ───────────────────────────────────────────────────────

function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (!p.startsWith('/fragil')) return false; // não é meu

    setCors(res);
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    // ─ Frontend estático ─
    // /fragil sem barra → redirect pra /fragil/ (senão paths relativos quebram)
    if (method === 'GET' && p === '/fragil') {
      res.writeHead(301, { Location: '/fragil/' });
      res.end();
      return true;
    }
    if (method === 'GET' && p === '/fragil/') {
      servirArquivo(res, 'index.html');
      return true;
    }
    if (method === 'GET' && p.startsWith('/fragil/static/')) {
      const rel = p.replace('/fragil/static/', '');
      servirArquivo(res, rel);
      return true;
    }
    // Atalho: /fragil/app.js
    if (method === 'GET' && (p === '/fragil/app.js' || p === '/fragil/index.html')) {
      servirArquivo(res, p.replace('/fragil/', ''));
      return true;
    }

    // ─ Health ─
    if (method === 'GET' && p === '/fragil/health') {
      const dados = lerDados();
      const usuarios = lerUsuarios();
      const tokens = tokenManager.lerTokens();
      return json(res, 200, {
        ok: true,
        skusFrageis: Object.keys(dados.skus).length,
        atualizadoEm: dados.atualizadoEm,
        atualizadoPor: dados.atualizadoPor,
        usuariosCadastrados: usuarios.length,
        chaveMestraAtiva: usuarios.length === 0 && !!auth.ADMIN_PASSWORD,
        blingConfigurado: !!process.env.FRAGIL_BLING_CLIENT_ID && !!process.env.FRAGIL_BLING_CLIENT_SECRET,
        blingLogado: !!(tokens.access_token || tokens.refresh_token)
      }), true;
    }

    // ─ LOGIN ─
    if (method === 'POST' && p === '/fragil/api/login') {
      const body = await readBody(req);
      const { usuario, senha } = body || {};
      const r = auth.autenticar(usuario, senha);
      if (!r.ok) { json(res, 401, { ok: false, erro: r.erro }); return true; }
      const token = auth.criarSessao(r.usuario);
      console.log(`[fragil LOGIN] ${r.usuario}${r.chaveMestra ? ' (CHAVE-MESTRA)' : ''}`);
      json(res, 200, {
        ok: true, token,
        usuario: r.usuario, perfil: r.perfil, nome: r.nome,
        chaveMestra: !!r.chaveMestra,
        expiraHoras: auth.SESSAO_HORAS
      });
      return true;
    }

    // ─ LOGOUT ─
    if (method === 'POST' && p === '/fragil/api/logout') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      auth.removerSessao(req.headers['x-session-token']);
      json(res, 200, { ok: true });
      return true;
    }

    // ─ ME ─
    if (method === 'GET' && p === '/fragil/api/me') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const lista = lerUsuarios();
      const u = lista.find(x => (x.usuario || '').toLowerCase() === usuario.toLowerCase());
      json(res, 200, {
        ok: true, usuario,
        nome: u?.nome || usuario,
        perfil: u?.perfil || 'admin',
        chaveMestra: lista.length === 0
      });
      return true;
    }

    // ─ USUÁRIOS (gestão) ─
    if (method === 'GET' && p === '/fragil/api/usuarios') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const lista = lerUsuarios().map(u => ({
        usuario: u.usuario, nome: u.nome, perfil: u.perfil
      }));
      json(res, 200, { ok: true, usuarios: lista });
      return true;
    }

    if (method === 'POST' && p === '/fragil/api/usuarios') {
      const usuarioAtual = pegarUsuario(req);
      if (!usuarioAtual) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const body = await readBody(req);
      const { usuario, senha, nome, perfil } = body || {};
      if (!usuario || !senha) { json(res, 400, { erro: 'usuario e senha são obrigatórios' }); return true; }
      const lista = lerUsuarios();
      if (lista.find(u => (u.usuario || '').toLowerCase() === usuario.toLowerCase())) {
        json(res, 400, { erro: 'usuário já existe' });
        return true;
      }
      lista.push({
        usuario,
        senhaHash: auth.hashSenha(senha),
        nome: nome || usuario,
        perfil: perfil || 'admin'
      });
      salvarUsuarios(lista);
      console.log(`[fragil USUARIOS] ${usuarioAtual} criou: ${usuario}`);
      json(res, 200, { ok: true });
      return true;
    }

    if (method === 'DELETE' && p.startsWith('/fragil/api/usuarios/')) {
      const usuarioAtual = pegarUsuario(req);
      if (!usuarioAtual) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const alvo = decodeURIComponent(p.replace('/fragil/api/usuarios/', ''));
      let lista = lerUsuarios();
      const antes = lista.length;
      lista = lista.filter(u => (u.usuario || '').toLowerCase() !== alvo.toLowerCase());
      if (lista.length === antes) { json(res, 404, { erro: 'usuário não encontrado' }); return true; }
      salvarUsuarios(lista);
      console.log(`[fragil USUARIOS] ${usuarioAtual} excluiu: ${alvo}`);
      json(res, 200, { ok: true });
      return true;
    }

    if (method === 'POST' && p.match(/^\/fragil\/api\/usuarios\/[^/]+\/senha$/)) {
      const usuarioAtual = pegarUsuario(req);
      if (!usuarioAtual) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const alvo = decodeURIComponent(p.split('/')[4]);
      const body = await readBody(req);
      const { senha } = body || {};
      if (!senha) { json(res, 400, { erro: 'senha obrigatória' }); return true; }
      const lista = lerUsuarios();
      const u = lista.find(x => (x.usuario || '').toLowerCase() === alvo.toLowerCase());
      if (!u) { json(res, 404, { erro: 'usuário não encontrado' }); return true; }
      u.senhaHash = auth.hashSenha(senha);
      salvarUsuarios(lista);
      console.log(`[fragil USUARIOS] ${usuarioAtual} resetou senha de: ${alvo}`);
      json(res, 200, { ok: true });
      return true;
    }

    // ─ SKUs frágeis (GET público — extensão consulta aqui) ─
    if (method === 'GET' && p === '/fragil/api/skus') {
      json(res, 200, lerDados());
      return true;
    }

    if (method === 'POST' && p === '/fragil/api/skus') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      try {
        const body = await readBody(req);
        const atual = lerDados();
        const novo = {
          config: {
            tempoMinimoSegundos: clampInt(body?.config?.tempoMinimoSegundos, 0, 30, atual.config.tempoMinimoSegundos),
            mensagemPadrao: typeof body?.config?.mensagemPadrao === 'string'
              ? body.config.mensagemPadrao.slice(0, 500)
              : atual.config.mensagemPadrao,
            repetirVoz: !!(body?.config?.repetirVoz),
            velocidadeVoz: clampFloat(body?.config?.velocidadeVoz, 0.5, 2.0, atual.config.velocidadeVoz),
            nomeVoz: typeof body?.config?.nomeVoz === 'string'
              ? body.config.nomeVoz.slice(0, 200)
              : (atual.config.nomeVoz || '')
          },
          skus: typeof body.skus === 'object' && body.skus !== null ? body.skus : atual.skus
        };
        const salvo = salvarDados(novo, usuario);
        console.log(`[fragil SAVE] ${usuario} salvou ${Object.keys(salvo.skus).length} SKUs`);
        json(res, 200, salvo);
      } catch (e) {
        console.error('[fragil] POST /api/skus:', e);
        json(res, 500, { erro: e.message });
      }
      return true;
    }

    // ─ Buscar produtos (autocomplete) ─
    if (method === 'GET' && p === '/fragil/api/buscar') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const termo = urlObj.searchParams.get('q') || '';
      const limite = urlObj.searchParams.get('limite') || '50';
      const r = blingProdutos.buscar(termo, limite);
      json(res, 200, { ok: true, ...r });
      return true;
    }

    if (method === 'GET' && p === '/fragil/api/cache-status') {
      json(res, 200, blingProdutos.getCacheStatus());
      return true;
    }

    // ─ Migração de dados (rota de admin, importa skus/usuarios externos) ─
    if (method === 'POST' && p === '/fragil/admin/importar') {
      const usuario = pegarUsuario(req);
      if (!usuario) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const body = await readBody(req);
      try {
        if (body.skus && typeof body.skus === 'object') {
          salvarDados(body.skus, usuario);
          console.log(`[fragil IMPORTAR] ${usuario} importou skus.json (${Object.keys(body.skus.skus || {}).length} SKUs)`);
        }
        if (Array.isArray(body.usuarios)) {
          salvarUsuarios(body.usuarios);
          console.log(`[fragil IMPORTAR] ${usuario} importou usuarios.json (${body.usuarios.length} usuários)`);
        }
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 500, { erro: e.message });
      }
      return true;
    }

    // ─ OAuth Bling ─
    if (method === 'GET' && p === '/fragil/auth/bling') {
      const cid = process.env.FRAGIL_BLING_CLIENT_ID;
      if (!cid) { json(res, 500, { erro: 'FRAGIL_BLING_CLIENT_ID não configurado' }); return true; }
      const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${encodeURIComponent(cid)}&state=${Date.now()}`;
      res.writeHead(302, { Location: url });
      res.end();
      return true;
    }

    if (method === 'GET' && p === '/fragil/bling/callback') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ Fragil: Código não recebido</h2>'); return true; }
      try {
        await tokenManager.gerarTokenInicial(code);
        // Dispara carregamento dos produtos em background
        setTimeout(() => blingProdutos.carregarIndiceListagem().catch(e => console.error(e)), 1500);
        html(res, 200, `
          <html><body style="font-family:Arial;padding:40px;text-align:center;">
            <h1 style="color:#28a745;">✅ Login Bling Frágil concluído!</h1>
            <p>Tokens salvos. Carregamento dos produtos iniciado em background.</p>
            <p><a href="/fragil">Voltar ao painel</a></p>
          </body></html>
        `);
      } catch (e) {
        console.error('[fragil OAUTH]', e);
        html(res, 500, `<h2>❌ Erro OAuth: ${e.message}</h2>`);
      }
      return true;
    }

    return false; // /fragil/* desconhecido — deixa cair pro 404 global
  };
}

// ── Boot ─────────────────────────────────────────────────────────────
// Dispara carregamento do índice de produtos no startup (se tiver tokens)
function bootstrap() {
  setTimeout(() => {
    const tokens = tokenManager.lerTokens();
    if (tokens.access_token || tokens.refresh_token) {
      blingProdutos.carregarIndiceListagem().catch(e => console.error('[fragil bootstrap]', e));
    } else {
      console.log('[fragil] Sem tokens Bling — acesse /fragil/auth/bling pra autorizar');
    }
  }, 5000);
}

// ── Exporta interface compatível com config/empresas ─────────────────
module.exports = {
  id: 'fragil',
  nome: 'Fragil (Painel SKUs)',
  rotinas: {},   // não tem rotinas cron
  routes,
  crons: {},      // sem crons agendados
  bootstrap       // chamado uma vez no startup
};
