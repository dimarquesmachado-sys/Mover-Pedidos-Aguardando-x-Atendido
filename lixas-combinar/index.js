'use strict';

/**
 * Módulo /lixas-combinar — Consulta estoque de grãos disponíveis pra vendas A COMBINAR
 *
 * Sessão 1 do projeto Lixas A COMBINAR: catalogar e listar variações filhas
 * de 10 lixas com estoque, a partir de um SKU A COMBINAR de 100 lixas.
 *
 * Não envia mensagens nem edita pedidos — só consulta.
 *
 * Rotas:
 *   GET  /lixas-combinar/health                 → status do módulo
 *   GET  /lixas-combinar/catalogo               → mostra o JSON catalogo
 *   GET  /lixas-combinar/setup                  → página com botão "Autorizar Bling"
 *   GET  /lixas-combinar/oauth/callback         → recebe code Bling e troca por tokens
 *   GET  /lixas-combinar/graos/:sku             → função principal: lista grãos disponíveis
 *   GET  /lixas-combinar/debug/produto/:codigo  → debug: busca produto Bling pelo código
 */

const tokenMgr = require('./tokenManager');
const lixasService = require('./lixasService');

// ── Helpers HTTP ─────────────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ── Router (interface esperada pelo orquestrador raiz) ───────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    const method = req.method;

    // Filtro: só responde rotas do módulo
    if (p !== '/lixas-combinar' && !p.startsWith('/lixas-combinar/')) return false;

    // health
    if (method === 'GET' && p === '/lixas-combinar/health') {
      json(res, 200, {
        ok: true,
        modulo: 'lixas-combinar',
        bling: tokenMgr.getStatus(),
        catalogo_skus: Object.keys(lixasService.listarCatalogo()),
        ts: Date.now()
      });
      return true;
    }

    // catalogo
    if (method === 'GET' && p === '/lixas-combinar/catalogo') {
      json(res, 200, { ok: true, catalogo: lixasService.listarCatalogo() });
      return true;
    }

    // setup (OAuth start)
    if (method === 'GET' && p === '/lixas-combinar/setup') {
      const clientId = process.env.LIXAS_BLING_CLIENT_ID;
      if (!clientId) {
        html(res, 500, '<h1>Erro</h1><p>LIXAS_BLING_CLIENT_ID não configurado no Render.</p>');
        return true;
      }
      const redirect = encodeURIComponent(tokenMgr.getRedirectUri());
      const state = Math.random().toString(36).slice(2, 15);
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&state=${state}&redirect_uri=${redirect}`;
      html(res, 200, `
        <!doctype html>
        <html><head><meta charset="utf-8"><title>Setup Lixas A COMBINAR</title></head>
        <body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
          <h2>🪨 Setup — Lixas A COMBINAR (Bling)</h2>
          <p>Clique no botão abaixo para autorizar este app no Bling.</p>
          <p>⚠️ Faça login na conta <b>Magazine Girassol</b> antes de clicar.</p>
          <p><a href="${authUrl}" style="display:inline-block;padding:12px 24px;background:#3490dc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Autorizar no Bling</a></p>
          <hr>
          <p style="font-size:13px;color:#666;">Redirect URI configurado: <code>${tokenMgr.getRedirectUri()}</code></p>
        </body></html>
      `);
      return true;
    }

    // oauth callback
    if (method === 'GET' && p === '/lixas-combinar/oauth/callback') {
      const code = urlObj.searchParams.get('code');
      if (!code) {
        html(res, 400, '<h1>Erro</h1><p>Code não recebido na callback.</p>');
        return true;
      }
      try {
        await tokenMgr.trocarCodePorTokens(code);
        html(res, 200, `
          <!doctype html>
          <html><head><meta charset="utf-8"><title>Sucesso</title></head>
          <body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
            <h2>✅ Token Bling obtido com sucesso!</h2>
            <p>Pode fechar esta aba.</p>
            <p><strong>Próximos passos:</strong></p>
            <ol>
              <li>Conferir status: <a href="/lixas-combinar/health">/lixas-combinar/health</a></li>
              <li>Testar: <a href="/lixas-combinar/graos/A-COMBINAR-100-lisa-125mm">/lixas-combinar/graos/A-COMBINAR-100-lisa-125mm</a></li>
            </ol>
          </body></html>
        `);
      } catch (e) {
        html(res, 500, `<h1>Erro</h1><pre>${e.message}</pre>`);
      }
      return true;
    }

    // graos/:sku — função principal
    if (method === 'GET' && p.startsWith('/lixas-combinar/graos/')) {
      const sku = decodeURIComponent(p.replace('/lixas-combinar/graos/', ''));
      try {
        const r = await lixasService.getGraosDisponiveisPorSkuACombinar(sku);
        json(res, r.ok ? 200 : 400, r);
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // debug — produto por codigo
    if (method === 'GET' && p.startsWith('/lixas-combinar/debug/produto/')) {
      const codigo = decodeURIComponent(p.replace('/lixas-combinar/debug/produto/', ''));
      try {
        const blingProdutos = require('./blingProdutos');
        const produto = await blingProdutos.buscarProdutoPorCodigo(codigo);
        if (!produto) {
          json(res, 404, { ok: false, erro: 'Produto não encontrado', codigo });
          return true;
        }
        const detalhe = await blingProdutos.buscarProdutoPorId(produto.id);
        json(res, 200, {
          ok: true,
          codigo,
          produto_basico: produto,
          detalhe_completo: detalhe
        });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // Rota /lixas-combinar (raiz) → redireciona pra setup
    if (method === 'GET' && p === '/lixas-combinar') {
      res.writeHead(302, { Location: '/lixas-combinar/setup' });
      res.end();
      return true;
    }

    return false;
  };
}

// ── Bootstrap ────────────────────────────────────────────────────────
function bootstrap() {
  setTimeout(() => {
    const st = tokenMgr.getStatus();
    console.log(`[lixas-combinar] Pronto. Bling configurado=${st.configurado} tokens_ok=${st.tokens_ok}`);
    if (!st.configurado) {
      console.warn('[lixas-combinar] ⚠️ Defina LIXAS_BLING_CLIENT_ID e LIXAS_BLING_CLIENT_SECRET no Render');
    } else if (!st.tokens_ok) {
      console.warn('[lixas-combinar] ⚠️ Tokens Bling não obtidos — acessar /lixas-combinar/setup');
    }
  }, 3000);
}

// ── Exporta (interface igual respostas-rapidas) ──────────────────────
module.exports = {
  id: 'lixas-combinar',
  nome: 'Lixas A COMBINAR',
  rotinas: {},
  routes,
  crons: {},
  bootstrap
};
