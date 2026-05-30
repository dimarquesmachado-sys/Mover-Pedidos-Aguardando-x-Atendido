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

    // ════════════════════════════════════════════════════════════════
    // SESSAO 3: PAINEL PENDENTES
    // ════════════════════════════════════════════════════════════════

    // GET /lixas-combinar/painel → serve o painel.html
    if (method === 'GET' && p === '/lixas-combinar/painel') {
      try {
        const fs = require('fs');
        const path = require('path');
        const htmlContent = fs.readFileSync(path.join(__dirname, 'painel.html'), 'utf8');
        html(res, 200, htmlContent);
      } catch (e) {
        json(res, 500, { ok: false, erro: 'erro lendo painel.html: ' + e.message });
      }
      return true;
    }

    // POST /lixas-combinar/login → JWT login
    if (method === 'POST' && p === '/lixas-combinar/login') {
      try {
        const body = await readBody(req);
        const { usuario, senha } = body || {};
        const auth = require('./auth');

        // 1) Autentica usuario+senha
        const autR = auth.autenticar(usuario, senha);
        if (!autR.ok) { json(res, 401, autR); return true; }

        // 2) Cria sessao e retorna token
        const token = auth.criarSessao(autR.usuario, autR.perfil);
        console.log(`[lixas-combinar LOGIN] ${autR.usuario} (${autR.perfil})`);

        json(res, 200, {
          ok: true,
          token,
          usuario: autR.usuario,
          perfil: autR.perfil
        });
      } catch (e) {
        console.error(`[lixas-combinar LOGIN] erro: ${e.message}`);
        json(res, 400, { ok: false, erro: e.message });
      }
      return true;
    }

    // ── A partir daqui, todas rotas exigem token ────────────────────
    function requerAuth() {
      const auth = require('./auth');
      const token = req.headers['x-session-token'] || '';
      const sess = auth.validarSessao(token);
      return sess ? { ok: true, sessao: sess } : { ok: false };
    }

    // GET /lixas-combinar/api/pendentes → lista vendas pendentes
    if (method === 'GET' && p === '/lixas-combinar/api/pendentes') {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        if (!lcp.configurado()) {
          json(res, 200, { ok: true, pendentes: [], stats: {}, aviso: 'supabase_nao_configurado' });
          return true;
        }
        const status = urlObj.searchParams.get('status') || null;
        const r = await lcp.listarPendentes({ dias: 7, status, limit: 100 });
        if (!r.ok) { json(res, 500, { ok: false, erro: 'erro_listar', data: r.data }); return true; }

        const pendentes = Array.isArray(r.data) ? r.data : [];

        // Stats (busca tudo p contagem global, sem filtro de status)
        const todosR = await lcp.listarPendentes({ dias: 7, limit: 500 });
        const todos = todosR.ok && Array.isArray(todosR.data) ? todosR.data : [];
        const stats = {
          total: todos.length,
          aguardando: todos.filter(v => v.status === 'aguardando_resposta').length,
          respondeu: todos.filter(v => v.status === 'cliente_respondeu' || v.status === 'cliente_confirmou_pedido').length,
          atencao: todos.filter(v => v.status === 'precisa_atencao_humano' || v.ia_escalou_humano).length,
          processado: todos.filter(v => v.status === 'processado').length
        };

        json(res, 200, { ok: true, pendentes, stats });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // POST /lixas-combinar/api/pendentes/:orderId/marcar-processado
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pendentes/') && p.endsWith('/marcar-processado')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pendentes/', '').replace('/marcar-processado', '');
      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const r = await lcp.atualizarVenda(orderId, { status: 'processado' });
        if (!r.ok) { json(res, 500, { ok: false, erro: 'erro_atualizar', data: r.data }); return true; }
        json(res, 200, { ok: true, orderId });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // POST /lixas-combinar/api/pedido/:orderId/editar-bling  → edita pedido Bling
    //   Body: { graos: [{grao:"24", quantidade:20}, ...], dryRun?: true }
    //   Aceita query ?dryRun=1 pra so previsualizar sem enviar
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/editar-bling')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/editar-bling', '');
      try {
        const corpo = await readBody(req);
        let payload = {};
        try { payload = JSON.parse(corpo || '{}'); } catch (_) { payload = {}; }

        const dryRun = urlObj.searchParams.get('dryRun') === '1' || !!payload.dryRun;
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const venda = await lcp.buscar(orderId);

        if (!venda.ok || !venda.data) {
          json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId });
          return true;
        }

        const v = venda.data;
        let graosEscolhidos = payload.graos;

        // Se nao veio body, tenta usar o pedido_estruturado que IA salvou
        if (!Array.isArray(graosEscolhidos) || graosEscolhidos.length === 0) {
          if (v.ia_pedido_estruturado) {
            try {
              graosEscolhidos = JSON.parse(v.ia_pedido_estruturado);
            } catch (_) {
              json(res, 400, { ok: false, erro: 'ia_pedido_estruturado invalido na tabela' });
              return true;
            }
          } else {
            json(res, 400, { ok: false, erro: 'precisa fornecer graos no body OU venda precisa ter ia_pedido_estruturado' });
            return true;
          }
        }

        // Consulta graos disponiveis no Bling
        const lixasService = require('./lixasService');
        const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar);
        if (!graosResult.ok) {
          json(res, 500, { ok: false, erro: 'erro_consultar_graos_bling', detalhe: graosResult.erro });
          return true;
        }

        // Edita pedido
        const bp = require('./blingPedidos');
        const r = await bp.editarPedidoComGraos({
          orderId,
          graosEscolhidos,
          graosDisponiveis: graosResult.graos,
          unidadesPorPacote: graosResult.unidades_por_pacote,
          descricaoBase: graosResult.descricao,
          dryRun
        });

        if (!r.ok) {
          // Atualiza tabela com erro
          await lcp.atualizarVenda(orderId, {
            bling_erro: `${r.etapa}: ${r.erro || JSON.stringify(r).slice(0,200)}`.slice(0, 500)
          });
          json(res, 500, { ok: false, ...r });
          return true;
        }

        // Sucesso (ou dryRun)
        if (!dryRun) {
          await lcp.atualizarVenda(orderId, {
            bling_pedido_id: String(r.pedidoId),
            bling_editado_em: new Date().toISOString(),
            bling_erro: null,
            status: 'processado'
          });
        }

        json(res, 200, { ok: true, ...r });
      } catch (e) {
        console.error('[lixas-combinar editar-bling]', e);
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // ════════════════════════════════════════════════════════════════

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
