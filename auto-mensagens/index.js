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
const { rotinaACombinar, rotinaLerRespostas, forcarOrder } = require('./fluxos');

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
  girassolACombinar: '*/2 * * * *',          // a cada 2 min - envio msg auto
  girassolLerRespostas: '*/2 * * * *'        // a cada 2 min - le respostas dos clientes (Sessao 3)
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

    // Debug: inspeciona status da conversação ML antes de enviar (sem enviar nada)
    if (method === 'GET' && p.startsWith('/auto-mensagens/debug/conversation/')) {
      const id = p.replace('/auto-mensagens/debug/conversation/', '');
      try {
        const token = await tokenMgr.garantirTokenML();
        const sellerId = tokenMgr.getUserId();

        const out = { id, seller_id_salvo: sellerId, tentativas: {} };

        // 1) Status da conversa /messages/packs/{id}/sellers/{seller_id}?mark_as_read=false
        const r1 = await fetch(
          `https://api.mercadolibre.com/messages/packs/${id}/sellers/${sellerId}?mark_as_read=false`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const txt1 = await r1.text();
        out.tentativas.conversa_status = {
          status: r1.status,
          body: txt1.slice(0, 1500)
        };

        // 2) Dados do seller atual (pra confirmar que o user_id está correto)
        const r2 = await fetch(
          `https://api.mercadolibre.com/users/me`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const txt2 = await r2.text();
        out.tentativas.users_me = {
          status: r2.status,
          body: txt2.slice(0, 800)
        };

        // 3) Detalhe do pack pra ver buyer e estado
        const r3 = await fetch(
          `https://api.mercadolibre.com/packs/${id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const txt3 = await r3.text();
        out.tentativas.pack = {
          status: r3.status,
          body: txt3.slice(0, 800)
        };

        json(res, 200, out);
      } catch (e) {
        json(res, 500, { erro: e.message });
      }
      return true;
    }

    // Debug: tenta acessar um ID como pack E como order, retorna o que achar
    if (method === 'GET' && p.startsWith('/auto-mensagens/debug/lookup/')) {
      const id = p.replace('/auto-mensagens/debug/lookup/', '');
      const resultados = { id, tentativas: {} };

      // Tenta como pack
      try {
        const ml = require('./mlApi');
        const token = await tokenMgr.garantirTokenML();
        // 1) Como pack
        const r1 = await fetch(`https://api.mercadolibre.com/packs/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const txt1 = await r1.text();
        resultados.tentativas.pack = {
          status: r1.status,
          body: txt1.slice(0, 500)
        };

        // 2) Como order direto
        const r2 = await fetch(`https://api.mercadolibre.com/orders/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const txt2 = await r2.text();
        resultados.tentativas.order = {
          status: r2.status,
          body: txt2.slice(0, 500)
        };

        // 3) Buscar via /orders/search com pack_id
        const sellerId = tokenMgr.getUserId();
        const r3 = await fetch(
          `https://api.mercadolibre.com/orders/search?seller=${sellerId}&pack_id=${id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const txt3 = await r3.text();
        resultados.tentativas.search_by_pack = {
          status: r3.status,
          body: txt3.slice(0, 800)
        };

        json(res, 200, resultados);
      } catch (e) {
        json(res, 500, { erro: e.message, parcial: resultados });
      }
      return true;
    }

    // Forçar envio de UMA venda específica (ignora janela de tempo)
    // GET ou POST /auto-mensagens/forcar/:orderId
    if ((method === 'GET' || method === 'POST') && p.startsWith('/auto-mensagens/forcar/')) {
      const orderId = p.replace('/auto-mensagens/forcar/', '');
      if (!orderId) {
        json(res, 400, { ok: false, erro: 'orderId obrigatorio' });
        return true;
      }
      try {
        const r = await forcarOrder(orderId);
        json(res, r.ok ? 200 : 400, r);
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // Debug: preview da mensagem que SERIA enviada (sem enviar nada)
    // GET /auto-mensagens/preview/:orderId  (aceita order_id OU pack_id)
    if (method === 'GET' && p.startsWith('/auto-mensagens/preview/')) {
      const idEntrada = p.replace('/auto-mensagens/preview/', '');
      try {
        const ml = require('./mlApi');
        // Resolver pack vs order (igual forcarOrder)
        let orderId = idEntrada;
        let detalhe = null;
        let packIdDescoberto = null;
        try {
          detalhe = await ml.getOrderDetalhe(idEntrada);
        } catch (e) {
          if (e.message.includes('404') || e.message.includes('order_not_found')) {
            const packInfo = await ml.getPackInfo(idEntrada);
            if (packInfo?.orders?.length > 0) {
              orderId = String(packInfo.orders[0].id);
              packIdDescoberto = idEntrada;
              detalhe = await ml.getOrderDetalhe(orderId);
            } else {
              json(res, 404, { ok: false, erro: 'pack sem orders dentro' });
              return true;
            }
          } else {
            json(res, 500, { ok: false, erro: e.message });
            return true;
          }
        }

        const temACombinar = ml.temVariacaoACombinar(detalhe);
        const skuInfo = ml.extrairSkuACombinar(detalhe);

        // Importa fluxos pra usar montarMensagemInteligente
        const fluxos = require('./fluxos');
        let textoFinal = null;
        // Truque: re-implementar so a parte de montar (nao expomos a funcao)
        // Em vez disso, vamos chamar via require do lixasService direto
        let lixasService = null;
        try { lixasService = require('../lixas-combinar/lixasService'); } catch {}

        const TEXTO_ENV = process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '';

        if (lixasService && skuInfo?.sku) {
          try {
            const r = await lixasService.getGraosDisponiveisPorSkuACombinar(skuInfo.sku);
            if (r.ok && r.graos && r.graos.length > 0) {
              const totalLixas = r.lixas_por_kit * (skuInfo.quantidade || 1);
              const unidades = r.unidades_por_pacote || 10;

              function gerarExemplo(total, unidades, graosArr) {
                if (graosArr.length === 0) return `Ex: ${total} do grão desejado.`;
                if (graosArr.length === 1) return `Ex: ${total} do grão ${graosArr[0]}.`;
                const grao1 = graosArr[0];
                const idx2 = Math.min(2, graosArr.length - 1);
                const grao2 = graosArr[idx2];
                const parte1 = Math.round(total * 0.3 / unidades) * unidades;
                const parte2 = total - parte1;
                return `Ex: ${parte1} do grão ${grao1}; ${parte2} do grão ${grao2}.`;
              }

              function montar(graosArr) {
                const graosStr = graosArr.join(', ');
                const exemplo = gerarExemplo(totalLixas, unidades, graosArr);
                return `Olá! Sua compra de ${totalLixas} lixas ${r.descricao}.\n\nGRÃOS DISPONÍVEIS: ${graosStr}\n\nResponda com QUANTIDADE + GRÃO. MÚLTIPLOS de ${unidades}. Total ${totalLixas} lixas.\n${exemplo}`;
              }

              let graosArr = r.graos.map(g => g.grao);
              let msg = montar(graosArr);

              if (msg.length > 350) {
                while (graosArr.length > 3 && msg.length > 350) {
                  graosArr.pop();
                  msg = montar(graosArr);
                }
                if (msg.length <= 350) {
                  graosArr[graosArr.length - 1] = graosArr[graosArr.length - 1] + ' ...';
                  msg = montar(graosArr);
                }
              }

              textoFinal = msg.length <= 350 ? msg : TEXTO_ENV;
            } else {
              textoFinal = TEXTO_ENV;
            }
          } catch (e) {
            textoFinal = TEXTO_ENV;
          }
        } else {
          textoFinal = TEXTO_ENV;
        }

        json(res, 200, {
          ok: true,
          id_entrada: idEntrada,
          tipo_id: packIdDescoberto ? 'pack' : 'order',
          order_id_real: orderId,
          tem_a_combinar: temACombinar,
          sku_detectado: skuInfo?.sku || null,
          quantidade: skuInfo?.quantidade || null,
          titulo_item: skuInfo?.titulo || null,
          mensagem_que_seria_enviada: textoFinal,
          mensagem_chars: textoFinal.length,
          eh_inteligente: lixasService && skuInfo?.sku ? 'tentou' : 'fallback'
        });
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
    girassolACombinar: rotinaACombinar,
    girassolLerRespostas: rotinaLerRespostas
  },
  routes,
  crons,
  bootstrap
};
