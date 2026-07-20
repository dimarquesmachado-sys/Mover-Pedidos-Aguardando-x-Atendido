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
  //
  // PAGINA ate cobrir a janela inteira. ANTES pegava so as 50 mais recentes (limit=50
  // sem offset) — entao num seller com >50 vendas/janela, os pedidos A COMBINAR mais
  // ANTIGOS nunca eram alcancados (recuperar achava 0, como aconteceu). O teto do
  // /orders/search do ML e offset+limit <= 1000, entao paramos em 1000 (ou antes, na
  // ultima pagina).
  const LIMIT = 50;
  const MAX_OFFSET = 1000;
  const base = `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(dateFrom)}&order.status=paid&sort=date_desc&limit=${LIMIT}`;
  let offset = 0;
  let total = Infinity;
  const todas = [];

  while (offset < total && offset < MAX_OFFSET) {
    const r = await mlFetch('GET', `${base}&offset=${offset}`);
    if (!r.ok) {
      if (todas.length > 0) break; // ja peguei algumas paginas: retorna o que tem
      throw new Error(`ML buscar vendas ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    const pagina = Array.isArray(r.data?.results) ? r.data.results : [];
    todas.push(...pagina);
    const t = Number(r.data?.paging?.total);
    total = Number.isFinite(t) ? t : todas.length; // sem paging: para
    if (pagina.length < LIMIT) break;               // ultima pagina
    offset += LIMIT;
  }
  return todas;
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
 * SESSAO 8 — status do pedido no ML, versao LEVE e que NUNCA joga excecao.
 *
 * Por que nao usar o getOrderDetalhe: ele joga Error em qualquer falha. Esta
 * funcao roda em LOTE dentro do cron rotinaChecarCanceladasML — se um pedido
 * der 404/500/timeout, os outros 39 da rodada nao podem morrer junto. Entao
 * aqui todo erro vira { ok:false } e o chamador decide.
 *
 * status possiveis do ML:
 *   confirmed | payment_required | payment_in_process | partially_paid
 *   paid | cancelled | invalid
 */
function _txtStatusDetail(sd) {
  if (!sd) return null;
  if (typeof sd === 'string') return sd;
  if (typeof sd === 'object') return sd.description || sd.code || JSON.stringify(sd).slice(0, 120);
  return String(sd);
}

async function getOrderStatusResumo(orderId) {
  try {
    const r = await mlFetch('GET', `/orders/${orderId}`);
    if (!r.ok) {
      return {
        ok: false,
        httpStatus: r.status,
        erro: `ML ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`
      };
    }
    const d = r.data || {};
    const st = String(d.status || '').toLowerCase();
    return {
      ok: true,
      httpStatus: r.status,
      status: d.status || null,
      statusDetail: _txtStatusDetail(d.status_detail),
      // 'invalid' tambem conta como morta: o ML usa pra pedido fraudulento/anulado.
      cancelada: st === 'cancelled' || st === 'invalid',
      tags: Array.isArray(d.tags) ? d.tags : [],
      packId: d.pack_id ? String(d.pack_id) : null,
      dataFechamento: d.date_closed || null
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

/**
 * Detecta se o pedido tem variação "A COMBINAR" em qualquer item
 * Procura em:
 *   - order_items[].item.variation_attributes[].value_name
 *   - order_items[].item.title (fallback)
 */
// Normaliza pra comparacao: maiusculas + REMOVE ACENTOS.
// Necessario porque ha anuncios com a variacao grafada "À COMBINAR" (com crase),
// e 'À' !== 'A' — sem normalizar, a deteccao pulava a venda (bug 10/06).
function _normalizarACombinar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

function temVariacaoACombinar(order) {
  if (!order?.order_items) return false;
  const ALVO = 'A COMBINAR';
  for (const item of order.order_items) {
    // 1) Atributos de variação
    const attrs = item.item?.variation_attributes || [];
    for (const a of attrs) {
      const val = _normalizarACombinar(a.value_name);
      if (val === ALVO || val.includes(ALVO)) return true;
    }
    // 2) Fallback: título do item (caso ML retorne a variação no título)
    const titulo = _normalizarACombinar(item.item?.title);
    if (titulo.includes(ALVO)) return true;
    // 3) Fallback: SKU do vendedor (anuncios de catalogo podem vir SEM
    //    variation_attributes no pedido; o SKU "A-COMBINAR-..." denuncia)
    const sku = _normalizarACombinar(item.item?.seller_sku || item.item?.seller_custom_field);
    if (sku.includes('COMBINAR')) return true;
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
    let ehACombinar = attrs.some(a => {
      const val = _normalizarACombinar(a.value_name);
      return val === ALVO || val.includes(ALVO);
    });
    if (!ehACombinar) {
      const skuNorm = _normalizarACombinar(item.item?.seller_sku || item.item?.seller_custom_field);
      if (skuNorm.includes('COMBINAR')) ehACombinar = true;
    }
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
 * MULTI-KIT: extrai TODOS os itens A COMBINAR da venda (carrinho com 2+
 * anuncios A COMBINAR diferentes, ex: kit 5pol lisa + kit 7pol furos).
 * Retorna ARRAY de { sku, quantidade, titulo } (vazio se nenhum).
 * Aditivo: nao altera o comportamento de extrairSkuACombinar (que segue
 * retornando o primeiro, pra compatibilidade com o fluxo atual).
 */
function extrairSkusACombinar(order) {
  if (!order?.order_items) return [];
  const ALVO = 'A COMBINAR';
  const out = [];
  for (const item of order.order_items) {
    const attrs = item.item?.variation_attributes || [];
    let ehACombinar = attrs.some(a => {
      const val = _normalizarACombinar(a.value_name);
      return val === ALVO || val.includes(ALVO);
    });
    // fallback: titulo (mesma logica do temVariacaoACombinar)
    if (!ehACombinar) {
      const titulo = _normalizarACombinar(item.item?.title);
      if (titulo.includes(ALVO)) ehACombinar = true;
    }
    // fallback: SKU (anuncios de catalogo podem vir sem variation_attributes)
    if (!ehACombinar) {
      const skuNorm = _normalizarACombinar(item.item?.seller_sku || item.item?.seller_custom_field);
      if (skuNorm.includes('COMBINAR')) ehACombinar = true;
    }
    if (!ehACombinar) continue;
    out.push({
      sku: item.item?.seller_sku || item.item?.seller_custom_field || null,
      quantidade: Number(item.quantity) || 1,
      titulo: item.item?.title
    });
  }
  return out;
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

  // Documentacao oficial ML: GET /messages/packs/{PACK_ID}/sellers/{SELLER_ID}?tag=post_sale
  // (mark_as_read=false nao existe nessa rota, removido)
  const path = `/messages/packs/${id}/sellers/${sId}?tag=post_sale`;

  try {
    const r = await mlFetch('GET', path);
    if (!r.ok) {
      // 404 = conversa virgem (NUNCA teve msg) - é caso normal
      if (r.status === 404) {
        return {
          ok: true,
          messages: [],
          totalCliente: 0,
          totalLoja: 0,
          ultimaCliente: null,
          conversaVirgem: true,
          aviso: 'endpoint_404_pode_ser_virgem'
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
      conversaVirgem: messages.length === 0,
      conversation_status: r.data?.conversation_status || null
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

  const r = await mlFetch('POST', path, body);

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
 * Faz isso simplesmente CONSULTANDO a conversa (consulta marca como lida por default).
 */
async function marcarConversaLida({ packId, orderId, sellerId }) {
  return consultarConversa({ packId, orderId, sellerId, markAsRead: true });
}

/**
 * SONDA (read-only) — descobre o prazo limite de POSTAGEM do pedido no ML.
 *
 * O handling limit (data ate quando o vendedor precisa postar) NAO vem no
 * /orders/{id} — mora no SHIPMENT. Esta funcao busca o pedido, acha o
 * shipping.id e puxa /shipments/{id}, devolvendo TANTO os campos candidatos
 * mais provaveis QUANTO o objeto bruto, pra travarmos o nome real do campo.
 *
 * Uso so de diagnostico (rota GET /auto-mensagens/debug/prazo/:orderId).
 * NAO altera, NAO envia, NAO emite nada.
 */
async function getPrazoPostagem(orderId) {
  const order = await getOrderDetalhe(orderId);
  const shippingId = order?.shipping?.id || order?.shipping_id || null;

  const out = {
    _sonda_versao: 'prazo-v2 (dedicado+derivado)',
    order_id: orderId,
    pack_id: order?.pack_id || null,
    order_status: order?.status || null,
    order_date_created: order?.date_created || null,
    order_date_closed: order?.date_closed || null,
    shipping_do_order: order?.shipping || null,   // o que vem dentro do /orders/{id}
    shipping_id: shippingId
  };

  if (!shippingId) {
    out.aviso = 'order sem shipping.id — pode ser pack (carrinho) ou retirada. Veja shipping_do_order, ou tente passar o pack_id.';
    return out;
  }

  const r = await mlFetch('GET', `/shipments/${shippingId}`);
  out.shipment_http_status = r.status;
  if (!r.ok) {
    out.erro_shipment = typeof r.data === 'string' ? r.data.slice(0, 300) : r.data;
    if (r.status === 401 || r.status === 403) {
      out.dica = 'Token sem permissao de leitura de shipments — pode precisar de scope/reautorizacao do app ML.';
    }
    return out;
  }

  const s  = r.data || {};
  let lt = s.lead_time || {};

  // O lead_time embutido no shipment AS VEZES vem vazio ({}). O endpoint dedicado
  // /shipments/{id}/lead_time costuma trazer o estimated_handling_limit mesmo assim.
  if (!lt || Object.keys(lt).length === 0) {
    const rl = await mlFetch('GET', `/shipments/${shippingId}/lead_time`);
    out.lead_time_http_status = rl.status;
    if (rl.ok && rl.data && typeof rl.data === 'object') {
      lt = rl.data;
      out.lead_time_via_endpoint_dedicado = true;
    } else {
      out.lead_time_erro = typeof rl.data === 'string' ? rl.data.slice(0, 200) : rl.data;
    }
  }

  const so  = s.shipping_option || {};
  const edt = so.estimated_delivery_time || {};

  // Campos candidatos pro "ate quando postar" (handling limit):
  out.candidatos_handling_limit = {
    'lead_time.estimated_handling_limit.date':       lt?.estimated_handling_limit?.date || null,
    'lead_time.estimated_handling_time.date':        lt?.estimated_handling_time?.date || null,
    'lead_time.estimated_delivery_limit.date':       lt?.estimated_delivery_limit?.date || null,
    'shipping_option.estimated_handling_limit.date': so?.estimated_handling_limit?.date || null,
    'shipping_option.estimated_schedule_limit.date': so?.estimated_schedule_limit?.date || null,
    'estimated_delivery_time.pay_before':            edt?.pay_before || null,
    'date_first_printed':                            s?.date_first_printed || null
  };

  // Fallback DERIVADO: quando nao ha data explicita de handling, estimamos a partir de
  // quando o pedido entrou em handling + a janela de handling (em horas).
  const dateHandling  = s?.status_history?.date_handling || s?.date_created || null;
  const handlingHoras = Number(edt?.handling) || null;
  if (dateHandling && handlingHoras) {
    const base = new Date(dateHandling);
    if (!isNaN(base.getTime())) {
      out.handling_limit_DERIVADO = {
        base_date_handling: dateHandling,
        handling_horas:     handlingHoras,
        limite_estimado:    new Date(base.getTime() + handlingHoras * 3600 * 1000).toISOString()
      };
    }
  }

  out.shipment_resumo = {
    status:        s.status || null,
    substatus:     s.substatus || null,
    mode:          s.mode || null,
    logistic_type: s.logistic_type || so?.shipping_method_type || null,
    date_created:  s.date_created || null,
    date_handling: dateHandling,
    last_updated:  s.last_updated || null,
    lead_time:     lt,   // objeto inteiro (embutido OU do endpoint dedicado)
    estimated_delivery_limit: so?.estimated_delivery_limit?.date || null,
    estimated_delivery_time_resumo: {
      date:       edt?.date || null,
      handling:   edt?.handling || null,
      shipping:   edt?.shipping || null,
      pay_before: edt?.pay_before || null
    }
  };
  out.shipment_bruto = s;   // tudo, pra nao perder nada

  return out;
}

module.exports = {
  buscarVendasPagas,
  getOrderDetalhe,
  getOrderStatusResumo,
  getPrazoPostagem,
  getPackInfo,
  temVariacaoACombinar,
  extrairSkuACombinar,
  extrairSkusACombinar,
  enviarMensagem,
  consultarConversa,
  enviarMensagemDireta,
  marcarConversaLida
};
