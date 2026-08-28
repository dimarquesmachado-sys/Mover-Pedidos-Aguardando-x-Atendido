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
 * LOGIN: os usuários vêm da env var FRAGIL_USUARIOS (fonte única).
 *        Formato: usuario:senha,usuario2:senha2
 *        Não existe mais usuarios.json em disco nem chave-mestra "admin".
 *
 * Cron único: carregar índice de produtos no startup (chama uma vez ao iniciar).
 */

const fs   = require('fs');
const path = require('path');

const dataMod = require('./data');
const { lerDados, salvarDados } = dataMod;
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

// Pega a sessao (header X-Session-Token) → { usuario, empresas } ou null
function pegarUsuario(req) {
  const token = req.headers['x-session-token'] || '';
  return auth.validarSessao(token);
}

// 28/08: resolve e AUTORIZA a empresa da requisicao (?empresa= contra as da sessao)
function empresaDaSessao(urlObj, sess) {
  const pedida = (urlObj.searchParams.get('empresa') || '').toLowerCase();
  const permitidas = (sess && sess.empresas) || [];
  if (pedida) {
    if (!dataMod.EMPRESAS.includes(pedida)) return { erro: 'Empresa desconhecida: ' + pedida };
    if (!permitidas.includes(pedida)) return { erro: 'Sem acesso à empresa ' + pedida };
    return { empresa: pedida };
  }
  if (permitidas.length === 1) return { empresa: permitidas[0] };
  return { erro: 'Informe ?empresa= (você tem acesso a: ' + (permitidas.join(', ') || 'nenhuma') + ')' };
}

// Mensagem usada nas rotas de escrita de usuário (agora gerenciados no Render)
const MSG_USUARIOS_ENV =
  'Usuários são gerenciados na variável de ambiente FRAGIL_USUARIOS, no painel do Render ' +
  '(serviço Mover-Pedidos-Aguardando-x-Atendido → aba Environment). ' +
  'Formato: usuario:senha,usuario2:senha2';

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
      const usuarios = auth.listarUsuarios();
      const tokens = tokenManager.lerTokens();
      json(res, 200, {
        ok: true,
        skusFrageis: Object.keys(dados.skus).length,
        atualizadoEm: dados.atualizadoEm,
        atualizadoPor: dados.atualizadoPor,
        usuariosCadastrados: usuarios.length,
        usuariosViaEnv: true,
        chaveMestraAtiva: false,
        blingConfigurado: !!process.env.FRAGIL_BLING_CLIENT_ID && !!process.env.FRAGIL_BLING_CLIENT_SECRET,
        blingLogado: !!(tokens.access_token || tokens.refresh_token)
      });
      return true;
    }

    // ─ LOGIN ─
    if (method === 'POST' && p === '/fragil/api/login') {
      const body = await readBody(req);
      const { usuario, senha } = body || {};
      const r = auth.autenticar(usuario, senha);
      if (!r.ok) { json(res, 401, { ok: false, erro: r.erro }); return true; }
      if (!r.empresas || !r.empresas.length) { json(res, 403, { ok: false, erro: 'Usuário sem empresa atribuída — confira as envs FRAGIL_USUARIOS_*.' }); return true; }
      const token = auth.criarSessao(r.usuario, r.empresas);
      console.log(`[fragil LOGIN] ${r.usuario} (${r.empresas.join(',')})`);
      json(res, 200, {
        ok: true, token,
        usuario: r.usuario, perfil: r.perfil, nome: r.nome,
        empresas: r.empresas,
        chaveMestra: false,
        expiraHoras: auth.SESSAO_HORAS
      });
      return true;
    }

    // ─ LOGOUT ─
    if (method === 'POST' && p === '/fragil/api/logout') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      auth.removerSessao(req.headers['x-session-token']);
      json(res, 200, { ok: true });
      return true;
    }

    // ─ ME ─
    if (method === 'GET' && p === '/fragil/api/me') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const lista = auth.listarUsuarios();
      const u = lista.find(x => (x.usuario || '').toLowerCase() === sess.usuario.toLowerCase());
      json(res, 200, {
        ok: true, usuario: sess.usuario,
        nome: u?.nome || sess.usuario,
        perfil: u?.perfil || 'admin',
        empresas: sess.empresas,
        chaveMestra: false
      });
      return true;
    }

    // ─ USUÁRIOS (somente leitura — gerenciados na env var FRAGIL_USUARIOS) ─
    if (method === 'GET' && p === '/fragil/api/usuarios') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      // NUNCA devolve senha — e o diretorio e ESCOPADO (Codex #240): cada um ve so os
      // colegas que compartilham empresa com ele, e so as empresas em comum.
      const minhas = sess.empresas || [];
      const lista = auth.listarUsuarios()
        .map(u => ({ usuario: u.usuario, nome: u.nome, perfil: u.perfil, empresas: (u.empresas || []).filter(e => minhas.includes(e)) }))
        .filter(u => u.empresas.length > 0);
      json(res, 200, {
        ok: true,
        usuarios: lista,
        somenteLeitura: true,
        origem: 'env:FRAGIL_USUARIOS',
        aviso: MSG_USUARIOS_ENV
      });
      return true;
    }

    // Criar / excluir / trocar senha: bloqueado, agora é no Render
    if (method === 'POST' && p === '/fragil/api/usuarios') {
      json(res, 400, { erro: MSG_USUARIOS_ENV });
      return true;
    }

    if (method === 'DELETE' && p.startsWith('/fragil/api/usuarios/')) {
      json(res, 400, { erro: MSG_USUARIOS_ENV });
      return true;
    }

    if (method === 'POST' && p.match(/^\/fragil\/api\/usuarios\/[^/]+\/senha$/)) {
      json(res, 400, { erro: MSG_USUARIOS_ENV });
      return true;
    }

    // ─ SKUs frágeis (GET público — extensão consulta aqui) ─
    if (method === 'GET' && p === '/fragil/api/skus') {
      /* GET continua PUBLICO (o alerta do checkout nao tem login).
         ?empresa=girassol|good|ambtotal → a lista daquela empresa;
         sem ?empresa (extensao antiga) → a UNIAO das 3, como era a lista unica. */
      const emp = (urlObj.searchParams.get('empresa') || '').toLowerCase();
      if (emp && !dataMod.EMPRESAS.includes(emp)) { json(res, 400, { erro: 'Empresa desconhecida: ' + emp }); return true; }
      json(res, 200, lerDados(emp || null));
      return true;
    }

    if (method === 'POST' && p === '/fragil/api/skus') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const rEmp = empresaDaSessao(urlObj, sess);
      if (rEmp.erro) { json(res, 403, { erro: rEmp.erro }); return true; }
      const usuario = sess.usuario;
      try {
        const body = await readBody(req);
        const atual = lerDados(rEmp.empresa);
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
        /* AUDITORIA (28/08): diff antes → depois, uma linha por mudanca */
        const ts = new Date().toISOString();
        const audit = [];
        const antigos = atual.skus || {}, novos = novo.skus || {};
        for (const sku of Object.keys(novos)) {
          if (!(sku in antigos)) audit.push({ ts, usuario, acao: 'adicionou', sku, depois: novos[sku] });
          else if (JSON.stringify(antigos[sku]) !== JSON.stringify(novos[sku])) audit.push({ ts, usuario, acao: 'editou', sku, antes: antigos[sku], depois: novos[sku] });
        }
        for (const sku of Object.keys(antigos)) {
          if (!(sku in novos)) audit.push({ ts, usuario, acao: 'excluiu', sku, antes: antigos[sku] });
        }
        if (JSON.stringify(atual.config) !== JSON.stringify(novo.config)) {
          audit.push({ ts, usuario, acao: 'config', antes: atual.config, depois: novo.config });
        }
        /* Codex #240: registrar SO depois do save dar certo — senao a trilha afirma
           mudancas que um 500 desfez. */
        const salvo = salvarDados(novo, usuario, rEmp.empresa);
        dataMod.registrarAuditoria(rEmp.empresa, audit);
        console.log(`[fragil SAVE ${rEmp.empresa}] ${usuario} salvou ${Object.keys(salvo.skus).length} SKUs (${audit.length} mudança(s) auditada(s))`);
        json(res, 200, salvo);
      } catch (e) {
        console.error('[fragil] POST /api/skus:', e);
        json(res, 500, { erro: e.message });
      }
      return true;
    }

    // ─ Auditoria (quem mudou o que — 28/08) ─
    if (method === 'GET' && p === '/fragil/api/auditoria') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const rEmp = empresaDaSessao(urlObj, sess);
      if (rEmp.erro) { json(res, 403, { erro: rEmp.erro }); return true; }
      json(res, 200, { ok: true, empresa: rEmp.empresa, eventos: dataMod.lerAuditoria(rEmp.empresa, urlObj.searchParams.get('limite')) });
      return true;
    }

    // ─ Buscar produtos (autocomplete) ─
    if (method === 'GET' && p === '/fragil/api/buscar') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
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

    // ─ Migração de dados (rota de admin, importa skus externos) ─
    // Usuários NÃO são mais importados aqui — vivem na env var FRAGIL_USUARIOS.
    if (method === 'POST' && p === '/fragil/admin/importar') {
      const sess = pegarUsuario(req);
      if (!sess) { json(res, 401, { erro: 'Sessão inválida' }); return true; }
      const rEmp = empresaDaSessao(urlObj, sess);
      if (rEmp.erro) { json(res, 403, { erro: rEmp.erro }); return true; }
      const body = await readBody(req);
      try {
        if (body.skus && typeof body.skus === 'object') {
          salvarDados(body.skus, sess.usuario, rEmp.empresa);
          dataMod.registrarAuditoria(rEmp.empresa, [{ ts: new Date().toISOString(), usuario: sess.usuario, acao: 'importou', depois: { skus: Object.keys(body.skus.skus || {}).length } }]);
          console.log(`[fragil IMPORTAR ${rEmp.empresa}] ${sess.usuario} importou skus.json (${Object.keys(body.skus.skus || {}).length} SKUs)`);
        }
        json(res, 200, {
          ok: true,
          usuariosIgnorados: Array.isArray(body.usuarios) ? body.usuarios.length : 0,
          aviso: Array.isArray(body.usuarios) ? MSG_USUARIOS_ENV : undefined
        });
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
  const nUsuarios = auth.listarUsuarios().length;
  if (nUsuarios === 0) {
    console.warn('[fragil] ⚠️  FRAGIL_USUARIOS vazia — ninguém consegue logar no painel. ' +
                 'Defina no Render: FRAGIL_USUARIOS=usuario:senha');
  } else {
    console.log(`[fragil] ${nUsuarios} usuário(s) carregado(s) da env var FRAGIL_USUARIOS`);
  }
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
