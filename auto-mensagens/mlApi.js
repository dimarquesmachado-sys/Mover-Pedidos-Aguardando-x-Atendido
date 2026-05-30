'use strict';

/**
 * ML API — Auto Mensagens Girassol
 *
 * Endpoints usados:
 *   GET  /orders/search?seller={seller_id}&order.date_created.from=...&order.status=paid
 *   GET  /orders/{order_id}    (detalhe com pack_id e variações)
 *   POST /messages/packs/{pack_id}/sellers/{user_id}    (enviar mensagem)
 */

const { garantirTokenML, getUserId } = require('./mlTokenManager');

const ML_BASE = 'https://api.mercadolibre.com';

async function mlFetch(method, path, body) {
  const token = await garantirTokenML();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${ML_BASE}${path}`, opts);
  const txt = await r.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Busca vendas pagas do seller numa janela de tempo
 * @param {Date} desde - busca vendas a partir desta data
 * @returns {Array} lista de orders (pode ser vazia)
 */
async function buscarVendasPagas(desde) {
  const sellerId = getUserId();
  if (!sellerId) throw new Error('user_id (seller) não disponível - faltou autorização inicial');

  const dateFrom = desde.toISOString();
  // ML aceita formato ISO sem ms: 2026-05-29T20:00:00.000-03:00 ou com Z
  // /orders/search documentado: order.date_created.from=DATE_FROM&order.date_created.to=DATE_TO
  const path = `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(dateFrom)}&order.status=paid&sort=date_desc&limit=50`;
  const r = await mlFetch('GET', path);
  if (!r.ok) {
    throw new Error(`ML buscar vendas ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return r.data?.results || [];
}

/**
 * Busca detalhe completo de um pedido (pra ver variation_attributes)
 */
async function getOrderDetalhe(orderId) {
  const r = await mlFetch('GET', `/orders/${orderId}`);
  if (!r.ok) {
    throw new Error(`ML detalhe pedido ${orderId} ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return r.data;
}

/**
 * Busca info de um pack (carrinho com 1+ orders dentro)
 * Útil quando o ID que aparece na URL do ML é pack_id, não order_id
 */
async function getPackInfo(packId) {
  const r = await mlFetch('GET', `/packs/${packId}`);
  if (!r.ok) {
    throw new Error(`ML pack ${packId} ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return r.data;
}

/**
 * Detecta se o pedido tem variação "A COMBINAR" em qualquer item
 * Procura em:
 *   - order_items[].item.variation_attributes[].value_name
 *   - order_items[].item.title (fallback)
 */
function temVariacaoACombinar(order) {
  if (!order?.order_items) return false;
  const ALVO = 'A COMBINAR';
  for (const item of order.order_items) {
    // 1) Atributos de variação
    const attrs = item.item?.variation_attributes || [];
    for (const a of attrs) {
      const val = String(a.value_name || '').toUpperCase().trim();
      if (val === ALVO || val.includes(ALVO)) return true;
    }
    // 2) Fallback: título do item (caso ML retorne a variação no título)
    const titulo = String(item.item?.title || '').toUpperCase();
    if (titulo.includes(ALVO)) return true;
  }
  return false;
}

/**
 * Extrai o SKU (seller_sku) do primeiro item com variação A COMBINAR.
 * Retorna { sku, quantidade } ou null.
 *
 * O SKU é usado pra cruzar com o catálogo do módulo /lixas-combinar.
 * Exemplo: "A-COMBINAR-100-lisa-180mm"
 */
function extrairSkuACombinar(order) {
  if (!order?.order_items) return null;
  const ALVO = 'A COMBINAR';
  for (const item of order.order_items) {
    const attrs = item.item?.variation_attributes || [];
    const ehACombinar = attrs.some(a => {
      const val = String(a.value_name || '').toUpperCase().trim();
      return val === ALVO || val.includes(ALVO);
    });
    if (!ehACombinar) continue;

    // Pegou um item A COMBINAR — extrai SKU
    // SKU pode vir em order_items[].item.seller_sku OU order_items[].item.seller_custom_field
    const sku = item.item?.seller_sku
             || item.item?.seller_custom_field
             || null;
    const quantidade = Number(item.quantity) || 1;
    return { sku, quantidade, titulo: item.item?.title };
  }
  return null;
}

/**
 * Envia mensagem pro comprador via API ML
 *
 * IMPORTANTE: ML BR exige que vendedor escolha um motivo (option_id) pra iniciar conversa
 * com cliente que ainda não mandou mensagem. Endpoint usado:
 *   POST /messages/action_guide/packs/{PACK_ID}/option?tag=post_sale
 *   Body: { "option_id": "OTHER", "text": "..." }
 *
 * @param {string|number} packId - pack_id (se null, usa order_id)
 * @param {string|number} orderId - usado como fallback se pack_id null
 * @param {string|number} buyerId - destinatário (não usado nesta API, mas mantido pra log)
 * @param {string} texto - mensagem (max 350 chars)
 * @returns {object} { ok, message_id, moderation_status, raw }
 */
async function enviarMensagem({ packId, orderId, buyerId, texto }) {
  if (!texto) throw new Error('texto obrigatório');

  // ML: se pack_id null, usar order_id mantendo /packs/ no path
  const packOrOrder = packId || orderId;

  const body = {
    option_id: 'OTHER',
    text: texto
  };

  const r = await mlFetch(
    'POST',
    `/messages/action_guide/packs/${packOrOrder}/option?tag=post_sale`,
    body
  );

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      erro: typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data)
    };
  }
  // Resposta esperada contém id da mensagem e moderation_status (pode vir IN_MODERATION)
  return {
    ok: true,
    message_id: r.data?.id || r.data?.message_id || null,
    moderation_status: r.data?.status || r.data?.message_moderation?.status || null,
    raw: r.data
  };
}

/**
 * Consulta TODA a conversa de uma venda (pack).
 * Retorna { ok, messages, totalCliente, totalLoja, ultimaCliente, conversaVirgem }
 *
 * messages = array de { from_user_id, to_user_id, text, date_created, message_id, status, read }
 * conversaVirgem = true se NÃO tem nenhuma mensagem ainda
 *
 * Endpoint: GET /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale
 * Param mark_as_read=false pra não marcar como lida só de consultar.
 *
 * Importante: se packId for null (venda Mercado Shop sem pack), usa orderId no lugar.
 */
async function consultarConversa({ packId, orderId, sellerId, markAsRead = false }) {
  const sId = sellerId || getUserId();
  if (!sId) {
    return { ok: false, erro: 'seller_id nao disponivel - faltou autorizacao inicial' };
  }
  const id = packId || orderId;
  if (!id) return { ok: false, erro: 'packId ou orderId obrigatorio' };

  const markParam = markAsRead ? '' : '&mark_as_read=false';
  const path = `/messages/packs/${id}/sellers/${sId}?tag=post_sale${markParam}`;

  try {
    const r = await mlFetch(path, { method: 'GET' });
    if (!r.ok) {
      // 404 = conversa virgem (NUNCA teve msg) - é caso normal
      if (r.status === 404) {
        return {
          ok: true,
          messages: [],
          totalCliente: 0,
          totalLoja: 0,
          ultimaCliente: null,
          conversaVirgem: true
        };
      }
      return { ok: false, status: r.status, erro: JSON.stringify(r.data).slice(0, 200) };
    }

    const messages = Array.isArray(r.data?.messages) ? r.data.messages
                   : Array.isArray(r.data?.results)  ? r.data.results
                   : [];

    const sellerIdNum = String(sId);
    const msgsCliente = messages.filter(m =>
      String(m.from?.user_id || m.from_user_id) !== sellerIdNum
    );
    const msgsLoja = messages.filter(m =>
      String(m.from?.user_id || m.from_user_id) === sellerIdNum
    );

    // Ultima msg do cliente (mais recente)
    const ultimaCliente = msgsCliente.length > 0
      ? msgsCliente.sort((a,b) => new Date(b.date_created || b.date) - new Date(a.date_created || a.date))[0]
      : null;

    return {
      ok: true,
      messages,
      totalCliente: msgsCliente.length,
      totalLoja: msgsLoja.length,
      ultimaCliente,
      conversaVirgem: messages.length === 0
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

/**
 * Envia mensagem DIRETA (sem action_guide), usada quando cliente já mandou msg
 * ou quando loja já usou o cap OTHER e quer mandar mais mensagens.
 *
 * Endpoint: POST /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale
 * Body: { from: { user_id: sellerId }, to: { user_id: buyerId }, text }
 */
async function enviarMensagemDireta({ packId, orderId, buyerId, sellerId, texto }) {
  const sId = sellerId || getUserId();
  if (!sId) return { ok: false, erro: 'seller_id nao disponivel' };
  if (!buyerId) return { ok: false, erro: 'buyerId obrigatorio' };
  if (!texto) return { ok: false, erro: 'texto obrigatorio' };

  const id = packId || orderId;
  const path = `/messages/packs/${id}/sellers/${sId}?tag=post_sale`;
  const body = {
    from: { user_id: Number(sId) },
    to:   { user_id: Number(buyerId) },
    text: texto
  };

  const r = await mlFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      erro: typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 300)
    };
  }

  return {
    ok: true,
    message_id: r.data?.id || r.data?.message_id || null,
    moderation_status: r.data?.status || r.data?.message_moderation?.status || null,
    raw: r.data
  };
}

/**
 * Marca todas mensagens não lidas de uma conversa como LIDAS.
 * Faz isso simplesmente CONSULTANDO a conversa sem mark_as_read=false.
 */
async function marcarConversaLida({ packId, orderId, sellerId }) {
  return consultarConversa({ packId, orderId, sellerId, markAsRead: true });
}

module.exports = {
  buscarVendasPagas,
  getOrderDetalhe,
  getPackInfo,
  temVariacaoACombinar,
  extrairSkuACombinar,
  enviarMensagem,
  consultarConversa,
  enviarMensagemDireta,
  marcarConversaLida
};
