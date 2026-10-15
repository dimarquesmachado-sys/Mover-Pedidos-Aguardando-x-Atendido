'use strict';

/**
 * Supabase Tracker — controla quais vendas já receberam auto-mensagem
 *
 * Tabela: auto_mensagens_enviadas
 *   - id (uuid, default uuid_generate_v4())
 *   - order_id (text, unique)
 *   - pack_id (text, nullable)
 *   - buyer_id (text)
 *   - tipo (text) — 'a_combinar'
 *   - texto_enviado (text)
 *   - message_id_ml (text, nullable)
 *   - status (text) — 'enviando' (marcador pre-POST) | 'enviado' | 'moderado' | 'erro' | 'pulado'
 *   - erro_detalhe (text, nullable)
 *   - data_envio (timestamptz, default now())
 *   - loja (text) — 'GIRASSOL' (preparado pra multi-loja futuro)
 */

const SUPABASE_URL = process.env.AUTO_MSG_GIRASSOL_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.AUTO_MSG_GIRASSOL_SUPABASE_KEY || '';

function configurado() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function supabaseRequest(method, path, body) {
  if (!configurado()) {
    throw new Error('Supabase não configurado (AUTO_MSG_GIRASSOL_SUPABASE_URL/KEY)');
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`Supabase ${method} ${path} → ${r.status}: ${txt}`);
  }
  return txt ? JSON.parse(txt) : null;
}

/**
 * Verifica se uma venda já teve mensagem enviada
 * @returns {Promise<boolean>}
 */
async function jaEnviou(orderId) {
  try {
    const r = await supabaseRequest(
      'GET',
      `auto_mensagens_enviadas?order_id=eq.${encodeURIComponent(orderId)}&select=order_id&limit=1`
    );
    return Array.isArray(r) && r.length > 0;
  } catch (e) {
    console.error(`[auto-mensagens supabase] jaEnviou erro: ${e.message}`);
    // Em caso de erro, é mais seguro ASSUMIR que já enviou pra não duplicar
    return true;
  }
}

/**
 * Registra uma mensagem enviada (ou tentativa)
 */
async function registrar({ orderId, packId, buyerId, tipo, textoEnviado, messageIdMl, status, erroDetalhe, loja }) {
  try {
    const row = {
      order_id: String(orderId),
      pack_id: packId ? String(packId) : null,
      buyer_id: String(buyerId),
      tipo: tipo || 'a_combinar',
      texto_enviado: textoEnviado || null,
      message_id_ml: messageIdMl || null,
      status: status || 'enviado',
      erro_detalhe: erroDetalhe || null,
      loja: loja || 'GIRASSOL'
    };
    await supabaseRequest('POST', 'auto_mensagens_enviadas', row);
    return true;
  } catch (e) {
    console.error(`[auto-mensagens supabase] registrar erro: ${e.message}`);
    return false;
  }
}

/**
 * Atualiza a linha JA existente do pedido (o marcador 'enviando' gravado antes do POST).
 * order_id e unique, entao um segundo registrar() (POST) sempre conflita — o resultado
 * do envio tem que ir por PATCH.
 * @returns {Promise<boolean>} true so se alguma linha foi de fato atualizada
 */
async function atualizar(orderId, { packId, textoEnviado, messageIdMl, status, erroDetalhe }) {
  try {
    const campos = {
      texto_enviado: textoEnviado || null,
      message_id_ml: messageIdMl || null,
      status,
      erro_detalhe: erroDetalhe || null
    };
    if (packId) campos.pack_id = String(packId);
    const r = await supabaseRequest(
      'PATCH',
      `auto_mensagens_enviadas?order_id=eq.${encodeURIComponent(orderId)}`,
      campos
    );
    return Array.isArray(r) && r.length > 0;
  } catch (e) {
    console.error(`[auto-mensagens supabase] atualizar erro: ${e.message}`);
    return false;
  }
}

/**
 * Solta o marcador 'enviando' quando o POST ao ML nao chegou a acontecer (excecao antes
 * da resposta). So apaga linha ainda em 'enviando' — nunca um 'enviado'/'erro' real.
 */
async function liberarMarcador(orderId) {
  try {
    await supabaseRequest(
      'DELETE',
      `auto_mensagens_enviadas?order_id=eq.${encodeURIComponent(orderId)}&status=eq.enviando`
    );
    return true;
  } catch (e) {
    console.error(`[auto-mensagens supabase] liberarMarcador erro: ${e.message}`);
    return false;
  }
}

/**
 * Estatísticas pra debug
 */
async function stats() {
  try {
    const ult = await supabaseRequest(
      'GET',
      'auto_mensagens_enviadas?order=data_envio.desc&limit=10&select=order_id,status,data_envio,erro_detalhe'
    );
    return { ok: true, ultimas: ult, configurado: configurado() };
  } catch (e) {
    return { ok: false, erro: e.message, configurado: configurado() };
  }
}

module.exports = { jaEnviou, registrar, atualizar, liberarMarcador, stats, configurado };
