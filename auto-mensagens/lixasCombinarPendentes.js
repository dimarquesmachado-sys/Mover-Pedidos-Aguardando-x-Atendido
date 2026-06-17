'use strict';

/**
 * lixasCombinarPendentes.js
 *
 * Modulo de tracking das vendas A COMBINAR Girassol pendentes (Sessao 3).
 * Usa MESMA Supabase do auto-mensagens (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *
 * Tabela: lixas_combinar_pendentes (criar no Supabase Studio - SQL no setup)
 *
 * Esta tabela é a "fonte da verdade" do painel /lixas-combinar/painel.
 * O log historico continua em auto_mensagens_enviadas (imutavel).
 */

const SUPABASE_URL = process.env.AUTO_MSG_GIRASSOL_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.AUTO_MSG_GIRASSOL_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABELA = process.env.LIXAS_COMBINAR_TABELA || 'lixas_combinar_pendentes';

function configurado() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function supabaseFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...(opts.headers || {})
  };
  const r = await fetch(url, { ...opts, headers });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

/**
 * UPSERT (insert ou update) na tabela.
 * Chave: order_id
 */
async function upsertPendente(p) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };

  const row = {
    order_id: String(p.orderId),
    pack_id: p.packId ? String(p.packId) : null,
    buyer_id: p.buyerId ? String(p.buyerId) : null,
    buyer_nome: p.buyerNome || null,
    sku_a_combinar: p.skuACombinar || null,
    descricao_produto: p.descricaoProduto || null,
    quantidade_lixas: p.quantidadeLixas || null,
    data_venda: p.dataVenda || null,
    msg_inicial_enviada: p.msgInicialEnviada || null,
    msg_inicial_enviada_em: p.msgInicialEnviadaEm || null,
    cliente_respondeu: !!p.clienteRespondeu,
    ultima_resposta_cliente: p.ultimaRespostaCliente || null,
    ultima_resposta_em: p.ultimaRespostaEm || null,
    total_msgs_cliente: p.totalMsgsCliente || 0,
    status: p.status || 'aguardando_resposta',
    via_endpoint: p.viaEndpoint || null,
    atualizado_em: new Date().toISOString()
  };

  const r = await supabaseFetch(TABELA, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  });
  return r;
}

/**
 * Lista pendentes dos ultimos N dias (default 7).
 * Filtra por status opcional.
 */
async function listarPendentes({ dias = 7, status = null, limit = 100 } = {}) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  // Janela por data_venda (sempre preenchido). Antes era msg_inicial_enviada_em,
  // que fica VAZIO em vendas registradas via recuperar (cliente ja tinha respondido,
  // nao recebeu msg inicial) — essas sumiam do painel E da recuperacao.
  let query = `${TABELA}?data_venda=gte.${desde}&order=data_venda.desc&limit=${limit}`;
  if (status) query += `&status=eq.${encodeURIComponent(status)}`;

  return supabaseFetch(query, { method: 'GET' });
}

/**
 * Atualiza UMA venda (pra quando cliente responde, ou Diego marca como processado).
 */
async function atualizarVenda(orderId, campos) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };
  campos.atualizado_em = new Date().toISOString();
  return supabaseFetch(`${TABELA}?order_id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(campos)
  });
}

/**
 * Marca como cliente_respondeu (quando cron de leitura detecta nova msg)
 */
async function marcarRespostaCliente(orderId, { texto, dataResposta, totalMsgsCliente }) {
  return atualizarVenda(orderId, {
    cliente_respondeu: true,
    ultima_resposta_cliente: texto,
    ultima_resposta_em: dataResposta,
    total_msgs_cliente: totalMsgsCliente || 1,
    status: 'cliente_respondeu'
  });
}

/**
 * Busca uma venda especifica
 */
async function buscar(orderId) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };
  const r = await supabaseFetch(`${TABELA}?order_id=eq.${encodeURIComponent(orderId)}`, { method: 'GET' });
  if (!r.ok) return r;
  return { ok: true, data: Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null };
}

module.exports = {
  configurado,
  upsertPendente,
  listarPendentes,
  atualizarVenda,
  marcarRespostaCliente,
  buscar,
  TABELA
};
