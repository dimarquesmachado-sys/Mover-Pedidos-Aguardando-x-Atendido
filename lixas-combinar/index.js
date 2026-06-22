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

// Envia ao cliente a confirmacao do pedido (formato g/un, sem somas) apos a NF emitir.
// REGRAS:
//  - so dispara em pedido CLARO (ia_categoria === 'claro'). No caso de substituicao a
//    categoria nao e 'claro' e a msg de substituicao JA confirma o pedido final — entao
//    aqui nao manda nada (evita confirmar com os graos antigos por cima).
//  - idempotente: se a ULTIMA msg enviada ao cliente JA e exatamente esta confirmacao,
//    nao reenvia (evita duplicar quando clica emitir/recuperar de novo, code 74 etc).
//  - best-effort: NUNCA lanca. A NF ja saiu; confirmar o cliente nao pode quebrar a rota.
async function enviarConfirmacaoPedido(v, orderId) {
  try {
    if (!v || v.ia_categoria !== 'claro') return { ok: false, motivo: 'nao_claro_sem_confirmacao' };

    let itens = [];
    try { itens = JSON.parse(v.ia_pedido_estruturado || '[]'); } catch (_) { itens = []; }
    if (!Array.isArray(itens) || itens.length === 0) return { ok: false, motivo: 'sem_pedido_estruturado' };

    const totalLixas = itens.reduce((s, g) => s + (Number(g.quantidade) || 0), 0);
    const ia = require('./iaCliente');
    const texto = ia._montarMsgConfirmacao(itens, totalLixas);

    // idempotencia: ja enviamos exatamente esta confirmacao? nao repete.
    if ((v.ia_msg_enviada || '').trim() === texto.trim()) {
      return { ok: true, jaConfirmado: true, texto };
    }

    const ml = require('../auto-mensagens/mlApi');
    let buyerId = null;
    try { const od = await ml.getOrderDetalhe(orderId); buyerId = od && od.buyer ? od.buyer.id : null; } catch (_) {}

    let r = buyerId
      ? await ml.enviarMensagemDireta({ packId: v.pack_id, orderId, buyerId, texto })
      : { ok: false, erro: 'sem_buyerId' };
    let via = 'direta';
    if (!r || !r.ok) {
      const r2 = await ml.enviarMensagem({ packId: v.pack_id, orderId, buyerId, texto });
      if (r2 && r2.ok) { r = r2; via = 'action_guide'; }
      else return { ok: false, motivo: 'falha_envio_ml', direta: r, action_guide: r2 };
    }

    // marca a confirmacao enviada (pra idempotencia futura)
    try {
      const lcp = require('../auto-mensagens/lixasCombinarPendentes');
      await lcp.atualizarVenda(orderId, { ia_msg_enviada: texto });
    } catch (_) {}

    return { ok: true, via, texto, message_id: r.message_id, moderation_status: r.moderation_status };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
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

        // Busca TODOS uma vez so e filtra em memoria (evita 2 chamadas Supabase)
        const todosR = await lcp.listarPendentes({ dias: 7, limit: 500 });
        const todos = todosR.ok && Array.isArray(todosR.data) ? todosR.data : [];

        // Aplica filtro - "cliente_respondeu" cobre ambos os status (respondeu E confirmou)
        let pendentes = todos;
        if (status === 'cliente_respondeu') {
          pendentes = todos.filter(v => v.status === 'cliente_respondeu' || v.status === 'cliente_confirmou_pedido');
        } else if (status) {
          pendentes = todos.filter(v => v.status === status);
        }
        pendentes = pendentes.slice(0, 100);

        // Confere a NF REAL no Bling pros cards que mostrariam o botao "Emitir/Recuperar
        // NF" mas tem nf_emitida_em vazio (campo desatualizado). Se a nota existe no
        // Bling, cura o campo aqui -> o botao some sozinho. Limitado a 20 checagens pra
        // nao pesar a listagem (so os poucos com campo desatualizado entram nisso).
        try {
          const bp = require('./blingPedidos');
          let _checados = 0;
          for (const v of pendentes) {
            if (_checados >= 20) break;
            const mostrariaBotaoNF = (v.bling_editado_em || v.status === 'processado') && !v.nf_emitida_em && v.bling_pedido_id;
            if (!mostrariaBotaoNF) continue;
            _checados++;
            try {
              const det = await bp.obterPedidoCompleto(v.bling_pedido_id);
              const nf = (det && det.ok) ? det.pedido?.notaFiscal : null;
              const nfId = (nf && typeof nf === 'object') ? nf.id : nf;
              if (Number(nfId) > 0) {
                const quando = new Date().toISOString();
                await lcp.atualizarVenda(v.order_id, { nf_emitida_em: quando });
                v.nf_emitida_em = quando; // reflete ja nesta resposta (botao some)
              }
            } catch (_) { /* checagem falhou: mantem o botao (melhor pecar por mostrar) */ }
          }
        } catch (_) { /* sem bp disponivel: segue sem curar */ }

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

    // GET /lixas-combinar/api/debug-buscar-bling?orderId=XXX&data=YYYY-MM-DD  → busca pedido
    // SEM AUTH - so leitura, util pra diagnostico via navegador direto
    if (method === 'GET' && p === '/lixas-combinar/api/debug-buscar-bling') {
      const orderId = urlObj.searchParams.get('orderId');
      const dataParam = urlObj.searchParams.get('data');
      if (!orderId) { json(res, 400, { ok: false, erro: 'orderId obrigatorio' }); return true; }

      try {
        const bp = require('./blingPedidos');
        // Define janela de busca - se data informada, ±15 dias dela (mais ampla pra debug)
        let dataInicial, dataFinal;
        if (dataParam) {
          const d = new Date(dataParam);
          const iniD = new Date(d); iniD.setDate(iniD.getDate() - 15);
          const fimD = new Date(d); fimD.setDate(fimD.getDate() + 15);
          dataInicial = iniD.toISOString().split('T')[0];
          dataFinal = fimD.toISOString().split('T')[0];
        }

        const r = await bp.buscarPedidoPorOrderId(orderId, dataInicial, dataFinal);
        json(res, 200, {
          orderId_buscado: orderId,
          janela: { dataInicial: dataInicial || '(default -30d)', dataFinal: dataFinal || '(default hoje+1)' },
          resultado: r
        });
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

    // POST /lixas-combinar/api/pedido/:orderId/ia-instrucao
    //   Body: { instrucao: "manda 20 do 150 e 10 do 180 pra completar" }
    //   A IA rele a conversa do cliente + sua instrucao e devolve o pedido
    //   estruturado (NAO monta ainda). Salva em ia_pedido_estruturado pra o
    //   botao "Pedido OK + Emitir NF" usar. NAO manda nada pro cliente no ML.
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/ia-instrucao')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/ia-instrucao', '');
      try {
        const corpo = await readBody(req);
        let payload;
        if (corpo && typeof corpo === 'object') {
          payload = corpo;                                  // readBody ja devolve objeto parseado (mesmo formato do login)
        } else {
          try { payload = JSON.parse(corpo || '{}'); } catch (_) { payload = {}; }
        }
        if (!payload || typeof payload !== 'object') payload = {};
        const instrucao = String(payload.instrucao || '').trim();
        if (!instrucao) { json(res, 400, { ok: false, erro: 'instrucao_vazia' }); return true; }

        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const venda = await lcp.buscar(orderId);
        if (!venda.ok || !venda.data) { json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId }); return true; }
        const v = venda.data;

        // graos disponiveis do SKU
        const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar);
        if (!graosResult.ok || !graosResult.graos || graosResult.graos.length === 0) {
          json(res, 500, { ok: false, erro: 'erro_consultar_graos_bling', detalhe: graosResult.erro }); return true;
        }
        const graosDisponiveis = graosResult.graos.map(g => g.grao);
        const unidadesPorPacote = graosResult.unidades_por_pacote || 10;
        const ml = require('../auto-mensagens/mlApi');
        // total REAL = lixas_por_kit x quantidade comprada (multi-kit: 4 kits de 100 = 400)
        let qtdKits = 1;
        try {
          const det = await ml.getOrderDetalhe(orderId);
          const info = ml.extrairSkuACombinar(det);
          if (info && Number(info.quantidade) > 0) qtdKits = Number(info.quantidade);
        } catch (e) {
          console.warn(`[ia-instrucao] order ${orderId} nao li a quantidade do ML — assumindo 1 kit: ${e.message}`);
        }
        const totalLixas = Number(graosResult.lixas_por_kit) * qtdKits;

        // rele a conversa do ML (mesma fonte do automatico)
        let historicoConversa = [];
        try {
          const conv = await ml.consultarConversa({ packId: v.pack_id, orderId, markAsRead: false });
          const sellerId = String(require('../auto-mensagens/mlTokenManager').getUserId() || '');
          historicoConversa = (conv.messages || []).slice(-10).map(m => {
            const fromId = String(m.from?.user_id || m.from_user_id || '');
            return { role: fromId === sellerId ? 'seller' : 'buyer', text: m.text || m.message || '' };
          }).filter(m => m.text);
        } catch (e) {
          console.warn(`[ia-instrucao] nao consegui ler conversa (segue so com a instrucao): ${e.message}`);
        }

        // Modo vendedor: a instrucao e uma ORDEM autoritativa do vendedor (nao mensagem
        // de cliente). O classificador entra em modoVendedor — nunca cai em fora_escopo;
        // a palavra do vendedor prevalece sobre a conversa do cliente (que vira so contexto).
        const ia = require('./iaCliente');
        const iaResult = await ia.interpretarRespostaCliente({
          mensagemCliente: instrucao,
          descricaoProduto: graosResult.descricao,
          totalLixas,
          unidadesPorPacote,
          graosDisponiveis,
          historicoConversa,
          modoVendedor: true,
          lixasPorKit: graosResult.lixas_por_kit,
          qtdKits
        });

        if (!iaResult.ok) { json(res, 502, { ok: false, erro: 'ia_falhou', detalhe: iaResult.erro }); return true; }

        // Se a IA entendeu claro, salva o pedido estruturado pra o botao montar usar.
        let salvo = false;
        if (iaResult.categoria === 'claro' && Array.isArray(iaResult.pedido_estruturado) && iaResult.pedido_estruturado.length > 0) {
          await lcp.atualizarVenda(orderId, {
            ia_categoria: 'claro',
            ia_confianca: iaResult.confianca,
            ia_interpretacao: (iaResult.interpretacao || '').slice(0, 300),
            ia_pedido_estruturado: JSON.stringify(iaResult.pedido_estruturado),
            ia_processado_em: new Date().toISOString()
          });
          salvo = true;
        }

        json(res, 200, {
          ok: true,
          categoria: iaResult.categoria,
          confianca: iaResult.confianca,
          interpretacao: iaResult.interpretacao || '',
          pedido_estruturado: iaResult.pedido_estruturado || null,
          msg_ia: iaResult.msg_pra_cliente || null,
          pronto_pra_montar: salvo,
          total_interpretado: Array.isArray(iaResult.pedido_estruturado)
            ? iaResult.pedido_estruturado.reduce((s, g) => s + (Number(g.quantidade) || 0), 0)
            : null
        });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // POST /lixas-combinar/api/pedido/:orderId/substituir-preview
    //   Lê o pedido LITERAL do cliente (ultima_resposta_cliente, ou body.texto se o
    //   admin quiser sobrescrever), troca grãos SEM estoque pelo mais próximo DISPONÍVEL
    //   (motor determinístico, sem IA), funde repetidos e valida o total.
    //   NÃO monta no Bling, NÃO emite NF. Só devolve o preview + as trocas.
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/substituir-preview')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/substituir-preview', '');
      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const venda = await lcp.buscar(orderId);
        if (!venda.ok || !venda.data) { json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId }); return true; }
        const v = venda.data;

        // Body opcional: admin pode mandar { texto } pra sobrescrever (palavra do vendedor vale)
        const corpo = await readBody(req);
        let payload;
        if (corpo && typeof corpo === 'object') { payload = corpo; }
        else { try { payload = JSON.parse(corpo || '{}'); } catch (_) { payload = {}; } }
        if (!payload || typeof payload !== 'object') payload = {};

        const textoCliente = String(payload.texto || v.ultima_resposta_cliente || '').trim();

        const sub = require('./substituicao');
        const parsed = sub.parsePedidoLiteral(textoCliente);
        if (!parsed.ok) {
          json(res, 422, { ok: false, erro: 'nao_consegui_ler_pedido', texto: textoCliente, motivo: parsed.motivo });
          return true;
        }

        const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar);
        if (!graosResult.ok || !Array.isArray(graosResult.graos) || graosResult.graos.length === 0) {
          json(res, 500, { ok: false, erro: 'erro_consultar_graos_bling', detalhe: graosResult.erro });
          return true;
        }

        const resolvido = sub.resolverPedidoComSubstituicao(
          parsed.itens,
          graosResult.graos,
          graosResult.lixas_por_kit,
          graosResult.unidades_por_pacote || 10
        );

        json(res, 200, {
          ok: resolvido.ok,
          pedidoCliente: parsed.itens,
          trocas: resolvido.trocas,
          pedidoFinal: resolvido.pedidoFinal,
          total: resolvido.total,
          totalEsperado: resolvido.totalEsperado,
          multiplosOk: resolvido.multiplosOk,
          avisos: resolvido.avisos,
          msgCliente: sub.montarMsgSubstituicao(resolvido.trocas, resolvido.pedidoFinal, resolvido.total),
          graosDisponiveis: graosResult.graos.map(g => ({ grao: g.grao, estoque: g.estoque_pacotes }))
        });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message, stack: e.stack });
      }
      return true;
    }

    // POST /lixas-combinar/api/pedido/:orderId/avisar-substituicao
    //   Manda a mensagem de FECHAMENTO pro cliente avisando a substituição feita.
    //   Body: { msg } — o texto que o admin viu/aprovou no preview.
    //   Usa enviarMensagemDireta (conversa já iniciada); fallback action_guide OTHER.
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/avisar-substituicao')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/avisar-substituicao', '');
      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const venda = await lcp.buscar(orderId);
        if (!venda.ok || !venda.data) { json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId }); return true; }
        const v = venda.data;

        const corpo = await readBody(req);
        let payload;
        if (corpo && typeof corpo === 'object') { payload = corpo; }
        else { try { payload = JSON.parse(corpo || '{}'); } catch (_) { payload = {}; } }
        if (!payload || typeof payload !== 'object') payload = {};

        const texto = String(payload.msg || '').trim();
        if (!texto) { json(res, 400, { ok: false, erro: 'msg_vazia' }); return true; }
        if (texto.length > 350) { json(res, 400, { ok: false, erro: 'msg_muito_longa', tamanho: texto.length }); return true; }

        const ml = require('../auto-mensagens/mlApi');
        // enviarMensagemDireta precisa do buyerId — pega do detalhe do pedido
        let buyerId = null;
        try { const od = await ml.getOrderDetalhe(orderId); buyerId = od?.buyer?.id || null; } catch (_) {}

        let r = buyerId
          ? await ml.enviarMensagemDireta({ packId: v.pack_id, orderId, buyerId, texto })
          : { ok: false, erro: 'sem_buyerId' };

        if (!r || !r.ok) {
          // fallback: conversa virgem / falha na direta → action_guide OTHER
          const r2 = await ml.enviarMensagem({ packId: v.pack_id, orderId, buyerId, texto });
          if (r2 && r2.ok) {
            json(res, 200, { ok: true, via: 'action_guide', message_id: r2.message_id, moderation_status: r2.moderation_status });
          } else {
            json(res, 502, { ok: false, erro: 'falha_envio_ml', direta: r, action_guide: r2 });
          }
          return true;
        }
        json(res, 200, { ok: true, via: 'direta', message_id: r.message_id, moderation_status: r.moderation_status });
      } catch (e) {
        json(res, 500, { ok: false, erro: e.message, stack: e.stack });
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
        let payload;
        if (corpo && typeof corpo === 'object') {
          payload = corpo;                                  // readBody ja devolve objeto parseado (mesmo formato do login)
        } else {
          try { payload = JSON.parse(corpo || '{}'); } catch (_) { payload = {}; }
        }
        if (!payload || typeof payload !== 'object') payload = {};

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
        // Extrai data da venda (formato YYYY-MM-DD) do timestamp
        let dataVenda = null;
        if (v.data_venda) {
          dataVenda = String(v.data_venda).split('T')[0];
        }
        // IMPORTANTE: Bling armazena pack_id em numeroLoja (nao order_id).
        // Se a venda tem pack_id, usa ele pra buscar no Bling. Fallback pro order_id.
        const idBuscaBling = v.pack_id || orderId;
        console.log(`[lixas-combinar editar-bling] buscando Bling com numeroLoja=${idBuscaBling} (pack_id=${v.pack_id || 'null'}, order_id=${orderId})`);

        const r = await bp.editarPedidoComGraos({
          orderId: idBuscaBling,
          graosEscolhidos,
          graosDisponiveis: graosResult.graos,
          unidadesPorPacote: graosResult.unidades_por_pacote,
          descricaoBase: graosResult.descricao,
          dataVenda,
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
        // IMPORTANTE: montar NAO fecha o pedido. So gravamos que foi editado no Bling.
        // O status 'processado' so e setado quando a NF for REALMENTE emitida (rota emitir-nf).
        // Assim o card continua na lista de pendentes com o botao "Emitir NF" visivel.
        if (!dryRun) {
          await lcp.atualizarVenda(orderId, {
            bling_pedido_id: String(r.pedidoId),
            bling_editado_em: new Date().toISOString(),
            bling_erro: null
          });
        }

        json(res, 200, { ok: true, ...r });
      } catch (e) {
        console.error('[lixas-combinar editar-bling]', e);
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // POST /lixas-combinar/api/pedido/:orderId/emitir-nf  → gera NF-e do pedido
    // Pode ser chamado manualmente (botao painel) ou automaticamente apos edicao OK
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/emitir-nf')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/emitir-nf', '');
      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const venda = await lcp.buscar(orderId);
        if (!venda.ok || !venda.data) {
          json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId });
          return true;
        }

        const v = venda.data;
        if (!v.bling_pedido_id) {
          json(res, 400, {
            ok: false,
            erro: 'pedido_bling_nao_identificado',
            mensagem: 'Edite o pedido no Bling primeiro (botao Editar Bling) - precisamos do bling_pedido_id salvo.'
          });
          return true;
        }

        const bp = require('./blingPedidos');
        console.log(`[lixas-combinar emitir-nf] orderId=${orderId} pedidoBling=${v.bling_pedido_id}`);
        const r = await bp.gerarNFe(v.bling_pedido_id);

        if (!r.ok) {
          // Bling code 74 = "Esta venda possui nota fiscal referenciada" → a NF JA EXISTE
          // (saiu por fora do painel: emissao direta no Bling, F3, etc). Trata como
          // JA-EMITIDA (idempotente): grava nf_emitida_em pra o botao sumir, em vez de
          // mostrar erro ou tentar emitir de novo (o Bling nunca deixaria duplicar mesmo).
          const campos = (r.detalhe && r.detalhe.error && r.detalhe.error.fields) || [];
          const jaTemNF = Array.isArray(campos) && campos.some(f =>
            Number(f.code) === 74 || /nota fiscal referenciada/i.test(String(f.msg || ''))
          );
          if (jaTemNF) {
            await lcp.atualizarVenda(orderId, {
              nf_emitida_em: new Date().toISOString(),
              nf_erro: null,
              status: 'processado'
            });
            console.log(`[lixas-combinar emitir-nf] orderId=${orderId} JA possuia NF referenciada (code 74) — marcado como emitida`);
            const confJa = await enviarConfirmacaoPedido(v, orderId);
            json(res, 200, { ok: true, jaEmitida: true, mensagem: 'Esta venda ja possui NF-e referenciada no Bling. Registrado como emitida.', confirmacao_cliente: confJa });
            return true;
          }
          await lcp.atualizarVenda(orderId, {
            nf_erro: `${r.status || ''}: ${r.erro || JSON.stringify(r.detalhe || {}).slice(0,200)}`.slice(0,500)
          });
          json(res, 200, { ok: false, ...r });
          return true;
        }

        // Sucesso - grava na Supabase. NF emitida = pedido REALMENTE concluido.
        await lcp.atualizarVenda(orderId, {
          nf_emitida_em: new Date().toISOString(),
          nf_id: r.nfeId,
          nf_numero: r.numero,
          nf_serie: r.serie,
          nf_chave: r.chave || null,
          nf_erro: null,
          status: 'processado'
        });

        const conf = await enviarConfirmacaoPedido(v, orderId);
        json(res, 200, { ok: true, ...r, confirmacao_cliente: conf });
      } catch (e) {
        console.error('[lixas-combinar emitir-nf]', e);
        json(res, 500, { ok: false, erro: e.message });
      }
      return true;
    }

    // ════════════════════════════════════════════════════════════════
    // POST /lixas-combinar/api/pedido/:orderId/recuperar-nf
    //   RECUPERACAO: pedidos que ficaram presos em 'processado' SEM NF
    //   (marcados na mao pelo botao "Processado", ou pelo bug antigo do montar).
    //   Monta (se ainda nao montou) + emite a NF, e so fecha como processado
    //   quando a NF sair de verdade. Idempotente (code 74 = ja tem NF → fecha).
    if (method === 'POST' && p.startsWith('/lixas-combinar/api/pedido/') && p.endsWith('/recuperar-nf')) {
      const sessao = requerAuth();
      if (!sessao.ok) { json(res, 401, { ok: false, erro: 'nao_autenticado' }); return true; }

      const orderId = p.replace('/lixas-combinar/api/pedido/', '').replace('/recuperar-nf', '');
      try {
        const lcp = require('../auto-mensagens/lixasCombinarPendentes');
        const bp = require('./blingPedidos');
        const venda = await lcp.buscar(orderId);
        if (!venda.ok || !venda.data) {
          json(res, 404, { ok: false, erro: 'venda_nao_encontrada', orderId });
          return true;
        }
        const v = venda.data;

        // Ja tem NF? nada a fazer.
        if (v.nf_emitida_em) {
          json(res, 200, { ok: true, jaEmitida: true, mensagem: 'Pedido ja tem NF emitida.' });
          return true;
        }

        let pedidoBlingId = v.bling_pedido_id;

        // ETAPA 1 — montar, se ainda nao foi montado
        if (!v.bling_editado_em) {
          let graosEscolhidos;
          if (v.ia_pedido_estruturado) {
            try { graosEscolhidos = JSON.parse(v.ia_pedido_estruturado); }
            catch (_) { json(res, 400, { ok: false, etapa: 'montar', erro: 'ia_pedido_estruturado invalido — trate manual' }); return true; }
          }
          if (!Array.isArray(graosEscolhidos) || graosEscolhidos.length === 0) {
            json(res, 400, { ok: false, etapa: 'montar', erro: 'sem graos estruturados — trate manual' });
            return true;
          }
          const lixasService = require('./lixasService');
          const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar);
          if (!graosResult.ok) {
            json(res, 500, { ok: false, etapa: 'montar', erro: 'erro_consultar_graos_bling', detalhe: graosResult.erro });
            return true;
          }
          let dataVenda = null;
          if (v.data_venda) dataVenda = String(v.data_venda).split('T')[0];
          const idBuscaBling = v.pack_id || orderId;

          const edit = await bp.editarPedidoComGraos({
            orderId: idBuscaBling,
            graosEscolhidos,
            graosDisponiveis: graosResult.graos,
            unidadesPorPacote: graosResult.unidades_por_pacote,
            descricaoBase: graosResult.descricao,
            dataVenda,
            dryRun: false
          });
          if (!edit.ok) {
            await lcp.atualizarVenda(orderId, {
              status: 'precisa_atencao_humano',
              bling_erro: `recuperar montar ${edit.etapa || ''}: ${edit.erro || ''}`.slice(0, 500)
            });
            json(res, 500, { ok: false, etapa: 'montar', ...edit });
            return true;
          }
          pedidoBlingId = edit.pedidoId;
          await lcp.atualizarVenda(orderId, {
            bling_pedido_id: String(edit.pedidoId),
            bling_editado_em: new Date().toISOString(),
            bling_erro: null
          });
        }

        // ETAPA 2 — emitir a NF
        if (!pedidoBlingId) {
          json(res, 400, { ok: false, etapa: 'nf', erro: 'sem bling_pedido_id apos montar' });
          return true;
        }
        const nf = await bp.gerarNFe(pedidoBlingId);
        if (!nf.ok) {
          const campos = (nf.detalhe && nf.detalhe.error && nf.detalhe.error.fields) || [];
          const jaTemNF = Array.isArray(campos) && campos.some(f =>
            Number(f.code) === 74 || /nota fiscal referenciada/i.test(String(f.msg || ''))
          );
          if (jaTemNF) {
            await lcp.atualizarVenda(orderId, {
              nf_emitida_em: new Date().toISOString(), nf_erro: null, status: 'processado'
            });
            const confR1 = await enviarConfirmacaoPedido(v, orderId);
            json(res, 200, { ok: true, jaEmitida: true, mensagem: 'Bling ja tinha NF referenciada — registrado como emitida.', confirmacao_cliente: confR1 });
            return true;
          }
          await lcp.atualizarVenda(orderId, {
            status: 'precisa_atencao_humano',
            nf_erro: `recuperar nf ${nf.status || ''}: ${nf.erro || JSON.stringify(nf.detalhe || {}).slice(0,200)}`.slice(0, 500)
          });
          json(res, 200, { ok: false, etapa: 'nf', ...nf });
          return true;
        }

        // Sucesso total
        await lcp.atualizarVenda(orderId, {
          nf_emitida_em: new Date().toISOString(),
          nf_id: nf.nfeId, nf_numero: nf.numero, nf_serie: nf.serie,
          nf_chave: nf.chave || null, nf_erro: null,
          status: 'processado'
        });
        const confR2 = await enviarConfirmacaoPedido(v, orderId);
        json(res, 200, { ok: true, recuperado: true, pedidoId: pedidoBlingId, nfNumero: nf.numero, nfSerie: nf.serie, confirmacao_cliente: confR2 });
      } catch (e) {
        console.error('[lixas-combinar recuperar-nf]', e);
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
