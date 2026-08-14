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
async function listarPendentes({ dias = 7, status = null, limit = 100, offset = 0 } = {}) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  // Janela por data_venda (sempre preenchido). Antes era msg_inicial_enviada_em,
  // que fica VAZIO em vendas registradas via recuperar (cliente ja tinha respondido,
  // nao recebeu msg inicial) — essas sumiam do painel E da recuperacao.
  // offset: permite paginar a janela inteira. Sem ele, um limit unico devolve so as
  // N mais novas (data_venda DESC) e as vendas antigas ficam invisiveis pra quem varre.
  let query = `${TABELA}?data_venda=gte.${desde}&order=data_venda.desc&limit=${limit}`;
  if (offset > 0) query += `&offset=${offset}`;
  if (status) query += `&status=eq.${encodeURIComponent(status)}`;

  return supabaseFetch(query, { method: 'GET' });
}

/**
 * Atualiza UMA venda (pra quando cliente responde, ou Diego marca como processado).
 */
// Estados TERMINAIS de cancelamento. Uma vez que a venda entra num deles, nenhuma
// escrita de status "normal" pode tira-la de la — so as proprias rotinas de
// cancelamento (que escrevem um destes, e portanto passam livres).
const STATUS_TERMINAIS = ['venda_cancelada', 'cancelado', 'cancelada_quarentena'];

async function atualizarVenda(orderId, campos, opts) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };
  campos.atualizado_em = new Date().toISOString();

  // ── GUARDA AUTOMATICA CONTRA RESSURREICAO ────────────────────────────────
  // Havia ~36 escritas de status espalhadas por 6 arquivos (cron, escada, retry,
  // recuperacao, lerRespostas, rotas do painel). Blindar uma a uma so descobria o
  // proximo esquecido a cada revisao — a lição que o Codex repetiu neste PR e que
  // CHECAR ANTES NAO SERIALIZA: a condicao precisa viajar no proprio PATCH.
  //
  // Entao a protecao vive AQUI, no unico ponto por onde todas passam: qualquer
  // escrita que mude o status pra um estado NAO-terminal ganha automaticamente o
  // predicado "a venda ainda nao foi cancelada". Se o cancelamento chegou no meio,
  // o PATCH afeta zero linhas e o estado terminal permanece — em vez de a venda ser
  // ressuscitada pro fluxo automatico e eventualmente faturada.
  //
  // Escapes deliberados:
  //   - status terminal (as proprias rotinas de cancelamento) passam livres
  //   - opts.forcar: para o caso raro de precisar sobrescrever de propósito
  if (campos.status && !STATUS_TERMINAIS.includes(campos.status) && !(opts && opts.forcar)) {
    const guarda = `venda_cancelada_em=is.null&status=not.in.(${STATUS_TERMINAIS.join(',')})`;
    opts = Object.assign({}, opts);
    opts.somenteSe = opts.somenteSe ? `${opts.somenteSe}&${guarda}` : guarda;
  }
  // opts.somenteSe: filtros PostgREST extras no MESMO PATCH — o update vira
  // condicional de verdade (checagem e escrita numa operacao so), fechando corridas
  // que um "ler antes, gravar depois" apenas estreita.
  // Ex: { somenteSe: 'venda_cancelada_em=is.null' } => so grava se ainda nao finalizou.
  const extra = (opts && opts.somenteSe) ? `&${opts.somenteSe}` : '';
  return supabaseFetch(`${TABELA}?order_id=eq.${encodeURIComponent(orderId)}${extra}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },   // devolve as linhas afetadas
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
