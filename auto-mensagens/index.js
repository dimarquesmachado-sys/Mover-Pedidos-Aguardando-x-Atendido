'use strict';

/**
 * Módulo /auto-mensagens — Auto-mensagens pós-venda Mercado Livre
 *
 * Hoje: Girassol "A COMBINAR" → manda mensagem automática 1x por venda
 *
 * Env vars:
 *   AUTO_MSG_GIRASSOL_ML_CLIENT_ID
 *   AUTO_MSG_GIRASSOL_ML_CLIENT_SECRET
 *   AUTO_MSG_GIRASSOL_HABILITADO       = 'true' | 'false'
 *   AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR (max 350 chars)
 *   AUTO_MSG_GIRASSOL_SUPABASE_URL
 *   AUTO_MSG_GIRASSOL_SUPABASE_KEY     (service_role)
 *   AUTO_MSG_JANELA_MIN                (opcional, default 30)
 *   AUTO_MSG_DATA_DIR                  (opcional, default /data/auto-mensagens)
 *
 * Rotas:
 *   GET  /auto-mensagens/health         → status do módulo
 *   GET  /auto-mensagens/setup          → URL de autorização ML
 *   GET  /auto-mensagens/oauth/callback → recebe code do ML e gera token
 *   POST /auto-mensagens/setup          → recebe { auth_code } e gera token
 *   POST /auto-mensagens/run/girassol   → roda fluxo manualmente
 *   GET  /auto-mensagens/stats          → últimas mensagens enviadas (Supabase)
 *
 * Cron:
 *   girassol-a-combinar: a cada 5 min (6h-23h)
 */

const tokenMgr = require('./mlTokenManager');
const tracker  = require('./supabaseTracker');
const { rotinaACombinar } = require('./fluxos');

// ── Helpers HTTP ──────────────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ── Crons ─────────────────────────────────────────────────────────────
const crons = {
  girassolACombinar: '*/5 * * * *'   // a cada 5 min, 24h por dia
};

// ── Rotas ─────────────────────────────────────────────────────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (p !== '/auto-mensagens' && !p.startsWith('/auto-mensagens/')) return false;

    // Health
    if (method === 'GET' && p === '/auto-mensagens/health') {
      const t = tokenMgr.temTokens();
      json(res, 200, {
        ok: true,
        modulo: 'auto-mensagens',
        girassol: {
          habilitado: (process.env.AUTO_MSG_GIRASSOL_HABILITADO || 'false').toLowerCase() === 'true',
          ml_client_configurado: tokenMgr.configurado(),
          ml_tokens_ok: t,
          supabase_configurado: tracker.configurado(),
          texto_configurado: !!process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR,
          texto_tamanho: (process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '').length
        },
        ts: Date.now()
      });
      return true;
    }

    // OAuth - GET /setup → gera URL e mostra
    if (method === 'GET' && p === '/auto-mensagens/setup') {
      if (!tokenMgr.configurado()) {
        html(res, 400, '<h2>❌ Client ID/Secret não configurados nas env vars</h2>');
        return true;
      }
      const url = tokenMgr.gerarUrlAutorizacao();
      html(res, 200, `
        <html><body style="font-family:sans-serif;max-width:680px;margin:40px auto;padding:20px;">
        <h2>🔐 Autorização ML — Auto Mensagens Girassol</h2>
        <p>Clique no link abaixo (já logado na conta <b>MAGAZINEGIRASSOL</b>):</p>
        <p><a href="${url}" target="_blank" style="background:#2563eb;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Autorizar app</a></p>
        <p>Após autorizar, o ML vai redirecionar pra esta página automaticamente — o token será salvo no servidor.</p>
        <hr>
        <p><small>Se não funcionar, copie a URL manualmente:</small></p>
        <code style="word-break:break-all;background:#f5f5f5;padding:8px;display:block;">${url}</code>
        </body></html>
      `);
      return true;
    }

    // OAuth - GET /oauth/callback (ML redireciona aqui após autorização)
    if (method === 'GET' && p === '/auto-mensagens/oauth/callback') {
      const code = urlObj.searchParams.get('code');
      if (!code) {
        html(res, 400, '<h2>❌ Código não encontrado na URL</h2>');
        return true;
      }
      try {
        const t = await tokenMgr.trocarCodigoPorToken(code);
        html(res, 200, `
          <html><body style="font-family:sans-serif;max-width:680px;margin:40px auto;padding:20px;">
          <h2>✅ Token ML obtido com sucesso!</h2>
          <p>Seller user_id: <code>${t.user_id}</code></p>
          <p>Você pode fechar esta aba.</p>
          <hr>
          <p>Próximos passos:</p>
          <ol>
            <li>Conferir status: <a href="/auto-mensagens/health">/auto-mensagens/health</a></li>
            <li>Testar manual: POST /auto-mensagens/run/girassol</li>
            <li>Ligar produção: alterar AUTO_MSG_GIRASSOL_HABILITADO=true no Render</li>
          </ol>
          </body></html>
        `);
      } catch (e) {
        html(res, 500, `<h2>❌ Erro: ${e.message}</h2>`);
      }
      return true;
    }

    // OAuth - POST /setup (alternativa via JSON)
    if (method === 'POST' && p === '/auto-mensagens/setup') {
      const body = await readBody(req);
      try {
        const t = await tokenMgr.trocarCodigoPorToken(body.auth_code);
        json(res, 200, { ok: true, user_id: t.user_id });
      } catch (e) {
        json(res, 400, { ok: false, erro: e.message });
      }
      return true;
    }

    // Run manual — dispara rotina imediata
    if (method === 'POST' && p === '/auto-mensagens/run/girassol') {
      rotinaACombinar()
        .then(r => console.log('[auto-mensagens] run manual:', JSON.stringify(r)))
        .catch(e => console.error('[auto-mensagens] run manual erro:', e.message));
      json(res, 202, { queued: 'rotinaACombinar Girassol' });
      return true;
    }

    // GET /run/girassol também aceito (pra testar pelo browser)
    if (method === 'GET' && p === '/auto-mensagens/run/girassol') {
      try {
        const r = await rotinaACombinar();
        json(res, 200, r);
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // Stats (últimas mensagens enviadas, do Supabase)
    if (method === 'GET' && p === '/auto-mensagens/stats') {
      const s = await tracker.stats();
      json(res, 200, s);
      return true;
    }

    // Debug token (só pra inspeção)
    if (method === 'GET' && p === '/auto-mensagens/debug/token') {
      try {
        const tok = await tokenMgr.garantirTokenML();
        json(res, 200, { ok: true, prefixo: tok.slice(0, 20) + '...', user_id: tokenMgr.getUserId() });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    return false;
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────
function bootstrap() {
  setTimeout(() => {
    const habilitado = (process.env.AUTO_MSG_GIRASSOL_HABILITADO || 'false').toLowerCase() === 'true';
    console.log(`[auto-mensagens] Pronto. Girassol habilitado=${habilitado}, client=${tokenMgr.configurado()}, tokens=${tokenMgr.temTokens()}, supabase=${tracker.configurado()}`);
    if (!tokenMgr.configurado()) console.warn('[auto-mensagens] ⚠️ AUTO_MSG_GIRASSOL_ML_CLIENT_ID/SECRET não configurados');
    if (!tracker.configurado()) console.warn('[auto-mensagens] ⚠️ Supabase não configurado');
    if (habilitado && !tokenMgr.temTokens()) console.warn('[auto-mensagens] ⚠️ HABILITADO=true mas SEM TOKEN ML — acesse /auto-mensagens/setup');
  }, 3000);
}

// ── Exporta ───────────────────────────────────────────────────────────
module.exports = {
  id: 'auto-mensagens',
  nome: 'Auto Mensagens ML',
  rotinas: {
    girassolACombinar: rotinaACombinar
  },
  routes,
  crons,
  bootstrap
};
