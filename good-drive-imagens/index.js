'use strict';

/**
 * Módulo /good-drive-imagens — Sincroniza imagens do Google Drive → Bling (GOOD Import)
 *
 * Rotas:
 *   GET  /good-drive-imagens                       → redirect /good-drive-imagens/
 *   GET  /good-drive-imagens/                       → frontend (login + app)
 *   GET  /good-drive-imagens/health                 → status do módulo
 *   GET  /good-drive-imagens/setup                  → página "Autorizar Bling" (aberta)
 *   GET  /good-drive-imagens/oauth/callback         → recebe code Bling e salva tokens
 *   POST /good-drive-imagens/login                  → autentica (JWT)
 *   POST /good-drive-imagens/logout                 → encerra sessão
 *   GET  /good-drive-imagens/api/status             → status Drive + Bling   [auth]
 *   GET  /good-drive-imagens/api/pastas             → lista pastas Drive     [auth]
 *   POST /good-drive-imagens/api/verificar-bling    → verifica SKUs no Bling [auth]
 *   POST /good-drive-imagens/api/processar          → processa imagens       [auth]
 *   POST /good-drive-imagens/api/enviar-bling        → envia URLs pro Bling   [auth]
 *   POST /good-drive-imagens/api/processar-e-enviar  → tudo de uma vez        [auth]
 *   GET  /good-drive-imagens/api/debug-produto/:cod  → debug produto Bling    [auth]
 */

const fs   = require('fs');
const path = require('path');

const tokenMgr = require('./tokenManager');
const auth     = require('./auth');
const drive    = require('./driveApi');
const blingProdutos  = require('./blingProdutos');
const imagensService = require('./imagensService');

const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'good-drive-imagens');

// ── Helpers HTTP ─────────────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function servirArquivo(res, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  const fullPath = path.join(PUBLIC_DIR, relPath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return json(res, 404, { erro: 'not found' });
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return json(res, 404, { erro: 'not found' });
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(fullPath).pipe(res);
}

// Auth: valida X-Session-Token. Retorna sessão ou null.
function pegarSessao(req) {
  const token = req.headers['x-session-token'] || '';
  return auth.validarSessao(token);
}

// ── Router ───────────────────────────────────────────────────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    const method = req.method;

    if (p !== '/good-drive-imagens' && !p.startsWith('/good-drive-imagens/')) return false;

    // ── Raiz → frontend ──
    if (method === 'GET' && p === '/good-drive-imagens') {
      res.writeHead(302, { Location: '/good-drive-imagens/' });
      res.end();
      return true;
    }
    if (method === 'GET' && (p === '/good-drive-imagens/' || p === '/good-drive-imagens/index.html')) {
      servirArquivo(res, 'index.html');
      return true;
    }

    // ── Health (aberto) ──
    if (method === 'GET' && p === '/good-drive-imagens/health') {
      json(res, 200, {
        ok: true, modulo: 'good-drive-imagens',
        bling: tokenMgr.getStatus(),
        drive: drive.estaConfigurado(),
        usuariosCadastrados: auth.totalUsuarios,
        ts: Date.now()
      });
      return true;
    }

    // ── Setup OAuth (aberto) ──
    if (method === 'GET' && p === '/good-drive-imagens/setup') {
      const clientId = process.env.GOODIMG_BLING_CLIENT_ID;
      if (!clientId) { html(res, 500, '<h1>Erro</h1><p>GOODIMG_BLING_CLIENT_ID não configurado no Render.</p>'); return true; }
      const redirect = encodeURIComponent(tokenMgr.getRedirectUri());
      const state = Math.random().toString(36).slice(2, 15);
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&state=${state}&redirect_uri=${redirect}`;
      html(res, 200, `
        <!doctype html><html><head><meta charset="utf-8"><title>Setup GOOD Imagens</title></head>
        <body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
          <h2>🖼️ Setup — GOOD Imagens (Bling)</h2>
          <p>Clique no botão para autorizar este app no Bling.</p>
          <p>⚠️ Faça login na conta <b>GOOD Import</b> antes de clicar.</p>
          <p><a href="${authUrl}" style="display:inline-block;padding:12px 24px;background:#0d47a1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Autorizar no Bling</a></p>
          <hr>
          <p style="font-size:13px;color:#666;">Redirect URI: <code>${tokenMgr.getRedirectUri()}</code></p>
        </body></html>
      `);
      return true;
    }

    // ── OAuth callback (aberto - recebe redirect do Bling) ──
    if (method === 'GET' && p === '/good-drive-imagens/oauth/callback') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h1>Erro</h1><p>Code não recebido na callback.</p>'); return true; }
      try {
        await tokenMgr.trocarCodePorTokens(code);
        html(res, 200, `
          <!doctype html><html><head><meta charset="utf-8"><title>Sucesso</title></head>
          <body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
            <h2>✅ Bling autorizado com sucesso!</h2>
            <p>Tokens salvos em disco. <a href="/good-drive-imagens/">← Abrir o sistema</a></p>
          </body></html>
        `);
      } catch (e) {
        html(res, 500, `<h1>Erro</h1><pre>${e.message}</pre>`);
      }
      return true;
    }

    // ── LOGIN ──
    if (method === 'POST' && p === '/good-drive-imagens/login') {
      const body = await readBody(req);
      const { usuario, senha } = body || {};
      const r = auth.autenticar(usuario, senha);
      if (!r.ok) { json(res, 401, { ok: false, erro: r.erro }); return true; }
      const token = auth.criarSessao(r.usuario, r.perfil);
      console.log(`[good-drive-imagens LOGIN] ${r.usuario} (${r.perfil})`);
      json(res, 200, { ok: true, token, usuario: r.usuario, perfil: r.perfil, expiraHoras: auth.SESSAO_HORAS });
      return true;
    }

    // ── LOGOUT ──
    if (method === 'POST' && p === '/good-drive-imagens/logout') {
      auth.removerSessao(req.headers['x-session-token']);
      json(res, 200, { ok: true });
      return true;
    }

    // ════════════════════════════════════════════════════════════════
    // A PARTIR DAQUI: todas as rotas /api/* exigem login
    // ════════════════════════════════════════════════════════════════
    if (p.startsWith('/good-drive-imagens/api/')) {
      const sessao = pegarSessao(req);
      if (!sessao) { json(res, 401, { ok: false, erro: 'Não autenticado. Faça login.' }); return true; }
      const quem = sessao.usuario;

      // ── status ──
      if (method === 'GET' && p === '/good-drive-imagens/api/status') {
        const st = tokenMgr.getStatus();
        json(res, 200, {
          bling: st.tokens_ok,
          drive: drive.estaConfigurado(),
          pastaMae: drive.pastaMae()
        });
        return true;
      }

      // ── pastas ──
      if (method === 'GET' && p === '/good-drive-imagens/api/pastas') {
        try {
          const pastas = await imagensService.listarPastas();
          json(res, 200, { total: pastas.length, pastas });
        } catch (e) { json(res, 500, { erro: e.message }); }
        return true;
      }

      // ── verificar-bling ──
      if (method === 'POST' && p === '/good-drive-imagens/api/verificar-bling') {
        const body = await readBody(req);
        const skus = body && body.skus;
        if (!Array.isArray(skus) || skus.length === 0) { json(res, 400, { erro: 'Envie array de SKUs' }); return true; }
        const resultados = {};
        for (let i = 0; i < skus.length; i += 5) {
          const lote = skus.slice(i, i + 5);
          await Promise.all(lote.map(async (sku) => {
            try { resultados[sku] = await blingProdutos.buscarProdutoPorCodigo(sku); }
            catch (e) { resultados[sku] = { erro: e.message }; }
          }));
        }
        json(res, 200, { resultados });
        return true;
      }

      // ── processar ──
      if (method === 'POST' && p === '/good-drive-imagens/api/processar') {
        const body = await readBody(req);
        const items = body && body.items;
        if (!Array.isArray(items) || items.length === 0) { json(res, 400, { erro: 'Envie array items' }); return true; }
        const resultados = {};
        for (const item of items) resultados[item.sku || '(sem nome)'] = await imagensService.processarUm(item);
        console.log(`[good-drive-imagens PROCESSAR] ${quem}: ${items.length} item(s)`);
        json(res, 200, { resultados });
        return true;
      }

      // ── enviar-bling ──
      if (method === 'POST' && p === '/good-drive-imagens/api/enviar-bling') {
        const body = await readBody(req);
        const items = body && body.items;
        if (!Array.isArray(items) || items.length === 0) { json(res, 400, { erro: 'Envie array items' }); return true; }
        const resultados = {};
        for (const it of items) resultados[it.sku] = await imagensService.enviarUm(it);
        console.log(`[good-drive-imagens ENVIAR] ${quem}: ${items.length} item(s)`);
        json(res, 200, { resultados });
        return true;
      }

      // ── processar-e-enviar ──
      if (method === 'POST' && p === '/good-drive-imagens/api/processar-e-enviar') {
        const body = await readBody(req);
        const items = body && body.items;
        if (!Array.isArray(items) || items.length === 0) { json(res, 400, { erro: 'Envie array items' }); return true; }
        const resultados = {};
        for (const item of items) {
          try { resultados[item.sku] = await imagensService.processarEEnviarUm(item); }
          catch (e) { resultados[item.sku] = { erro: e.message }; }
        }
        console.log(`[good-drive-imagens DIRETO] ${quem}: ${items.length} item(s)`);
        json(res, 200, { resultados });
        return true;
      }

      // ── debug-produto ──
      if (method === 'GET' && p.startsWith('/good-drive-imagens/api/debug-produto/')) {
        const codigo = decodeURIComponent(p.replace('/good-drive-imagens/api/debug-produto/', ''));
        try {
          const resumo = await blingProdutos.buscarProdutoPorCodigo(codigo);
          if (!resumo.encontrado) { json(res, 200, { encontrado: false }); return true; }
          const completo = await blingProdutos.buscarProdutoPorId(resumo.id);
          json(res, 200, { encontrado: true, id: resumo.id, codigo: resumo.codigo, nome: resumo.nome, produtoCompleto: completo });
        } catch (e) { json(res, 500, { erro: e.message }); }
        return true;
      }

      json(res, 404, { erro: 'rota /api desconhecida' });
      return true;
    }

    // ── Arquivos estáticos (favicon etc) em /good-drive-imagens/{arquivo} ──
    if (method === 'GET' && /\.(ico|png|jpg|svg|json|css|js)$/i.test(p)) {
      const rel = p.replace('/good-drive-imagens/', '');
      servirArquivo(res, rel);
      return true;
    }

    return false;
  };
}

// ── Renovação proativa do token Bling ────────────────────────────────
// O refresh token do Bling expira após ~30 dias SEM USO. Este cron renova
// o token diariamente, mantendo o refresh token sempre "fresco" — assim o
// sistema nunca pede reautorização, mesmo ficando meses sem ninguém usar.
async function renovarTokenBling() {
  const st = tokenMgr.getStatus();
  if (!st.configurado) {
    console.log('[good-drive-imagens] renovarTokenBling: Bling não configurado — pulando');
    return;
  }
  if (!st.refresh_ok) {
    console.warn('[good-drive-imagens] renovarTokenBling: sem refresh_token — autorize em /good-drive-imagens/setup');
    return;
  }
  try {
    await tokenMgr.refreshTokens();
    console.log('[good-drive-imagens] renovarTokenBling: token renovado proativamente ✓');
  } catch (e) {
    console.error('[good-drive-imagens] renovarTokenBling: falha —', e.message);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────
function bootstrap() {
  setTimeout(() => {
    const st = tokenMgr.getStatus();
    console.log(`[good-drive-imagens] Pronto. Bling configurado=${st.configurado} tokens_ok=${st.tokens_ok} | Drive=${drive.estaConfigurado()} | usuários=${auth.totalUsuarios}`);
    if (!st.configurado) console.warn('[good-drive-imagens] ⚠️ Defina GOODIMG_BLING_CLIENT_ID e GOODIMG_BLING_CLIENT_SECRET no Render');
    else if (!st.tokens_ok) console.warn('[good-drive-imagens] ⚠️ Tokens Bling não obtidos — acesse /good-drive-imagens/setup');
  }, 4000);
}

module.exports = {
  id: 'good-drive-imagens',
  nome: 'GOOD Imagens (Drive x Bling)',
  rotinas: { renovarTokenBling },
  routes,
  crons: { renovarTokenBling: '17 3 * * *' },
  bootstrap
};
