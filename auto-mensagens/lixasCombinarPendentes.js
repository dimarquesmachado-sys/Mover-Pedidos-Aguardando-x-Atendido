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
async function listarPendentes({ dias = 7, status = null, limit = 100, offset = 0, antesDe = null } = {}) {
  if (!configurado()) return { ok: false, erro: 'supabase_nao_configurado' };

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  // Janela por data_venda (sempre preenchido). Antes era msg_inicial_enviada_em,
  // que fica VAZIO em vendas registradas via recuperar (cliente ja tinha respondido,
  // nao recebeu msg inicial) — essas sumiam do painel E da recuperacao.
  // PAGINACAO POR CHAVE (keyset), nao por offset. Com offset, uma venda nova inserida
  // entre duas paginas desloca todas as seguintes: uma linha vem duplicada e outra
  // some da varredura — justamente o tipo de buraco que a paginacao veio corrigir.
  // O desempate por order_id garante ordem total quando ha data_venda repetida.
  // `antesDe` = ultima linha da pagina anterior: { data_venda, order_id }.
  let query = `${TABELA}?data_venda=gte.${desde}&order=data_venda.desc,order_id.desc&limit=${limit}`;
  if (antesDe && antesDe.data_venda) {
    const dv = encodeURIComponent(antesDe.data_venda);
    const oid = encodeURIComponent(antesDe.order_id || '');
    // (data_venda < X) OU (data_venda = X E order_id < Y)
    query += `&or=(data_venda.lt.${dv},and(data_venda.eq.${dv},order_id.lt.${oid}))`;
  } else if (offset > 0) {
    query += `&offset=${offset}`;   // compat: chamadas antigas que ainda usam offset
  }
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
  const r = await supabaseFetch(`${TABELA}?order_id=eq.${encodeURIComponent(orderId)}${extra}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },   // devolve as linhas afetadas
    body: JSON.stringify(campos)
  });
  // BLOQUEADA != sucesso. PostgREST devolve ok:true com data vazio quando o predicado
  // nao casa, e quem nao inspeciona `data` seguia como se tivesse gravado — no caso do
  // marcarRespostaCliente, ate mandando mensagem automatica pra cliente cuja compra
  // acabou de ser cancelada. A flag `bloqueada` torna isso visivel sem quebrar quem
  // so olha `ok`.
  if (r && r.ok && extra && Array.isArray(r.data) && r.data.length === 0) {
    return Object.assign({}, r, { bloqueada: true, motivo: 'estado_mudou' });
  }
  return r;
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

// ── RESERVA DE EMISSAO (lease) ───────────────────────────────────────────────
// Um so lugar pra reservar/liberar, usado por TODOS os caminhos que emitem NF:
// /emitir-nf, /recuperar-nf, processarAutoEmissao e a escada. Antes cada rota
// montava o predicado por conta, e os emissores automaticos ficaram sem nenhum.
const NF_LEASE_MIN = Number(process.env.LIXAS_NF_LEASE_MIN) || 10;

function _leaseLimite() {
  return new Date(Date.now() - NF_LEASE_MIN * 60 * 1000).toISOString();
}

/** Predicado "sem reserva ativa", pros escritores de cancelamento. */
function semReservaAtiva() {
  return `or=(nf_emitindo_em.is.null,nf_emitindo_em.lt.${_leaseLimite()})`;
}

/**
 * Tenta reservar a venda pra emitir. FAIL CLOSED: so devolve true com 1 linha
 * afetada — {ok:false} (banco fora, coluna nao migrada) NAO autoriza emitir.
 * @returns {{ ok:boolean, motivo?:string }}
 */
async function reservarEmissao(orderId) {
  // TOKEN unico por reserva. Sem dono, um worker cuja chamada ao Bling passou do lease
  // liberaria, ao terminar, a reserva FRESCA de outro que ja assumiu a venda — e o cron
  // voltaria a poder gravar cancelamento no meio da segunda emissao.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const pred = 'venda_cancelada_em=is.null&nf_emitida_em=is.null&ml_etiqueta_em=is.null'
             + '&processado_manual_em=is.null'
             + '&status=not.in.(venda_cancelada,cancelado,cancelada_quarentena)'
             + `&or=(nf_emitindo_em.is.null,nf_emitindo_em.lt.${_leaseLimite()})`
             // ENVIO INDETERMINADO barra a escrita no Bling: se a ultima leitura do
             // shipment falhou, ml_etiqueta_em pode estar nulo so por falta de
             // informacao — e uma etiqueta ja impressa passaria despercebida.
             + '&ml_envio_indeterminado_em=is.null';
  const r = await atualizarVenda(orderId,
    { nf_emitindo_em: new Date().toISOString(), nf_emitindo_por: token }, { somenteSe: pred });
  if (r.ok && Array.isArray(r.data) && r.data.length === 1) return { ok: true, token };
  if (r.ok && Array.isArray(r.data) && r.data.length === 0) return { ok: false, motivo: 'estado_mudou' };
  return { ok: false, motivo: 'reserva_falhou' };
}

/**
 * Libera a reserva — SO se ela ainda for deste worker (token bate). Best-effort.
 * Sem token, mantem o comportamento antigo (compat com chamadas que ainda nao passam).
 */
async function liberarEmissao(orderId, token) {
  try {
    const opts = token ? { somenteSe: `nf_emitindo_por=eq.${encodeURIComponent(token)}` } : undefined;
    await atualizarVenda(orderId, { nf_emitindo_em: null, nf_emitindo_por: null }, opts);
  } catch (_) {}
}

/**
 * Campos pra gravar o desfecho TERMINAL junto com a liberacao do lease, so se a
 * reserva ainda for deste worker. Usado pelos 4 emissores.
 */
function fecharLease(token) {
  return token ? { somenteSe: `nf_emitindo_por=eq.${encodeURIComponent(token)}` } : undefined;
}

/**
 * RECHECA o ML depois de adquirir o lease, imediatamente antes da 1a escrita no Bling.
 * Precisa existir em TODO caminho que reserva: uma vez com o lease ativo, o cron de
 * cancelamento ADIA sua gravacao, entao os marcadores locais congelam e nenhum
 * predicado consegue mais parar o worker — so perguntando ao ML de novo.
 * Grava o terminal encontrado (com alerta quando ha etiqueta) e fecha o lease.
 * @returns {{ ok:true } | { ok:false, motivo:string, cancelada?:boolean, etiqueta?:boolean, mensagem:string }}
 */
async function recheckAposReserva(orderId, token) {
  const ml = require('./mlApi');
  let env = null, st = null;
  try {
    // ENVIO primeiro, STATUS por ultimo (o getEnvioResumo faz seu proprio /orders).
    env = await ml.getEnvioResumo(String(orderId));
    st = await ml.getOrderStatusResumo(String(orderId));
  } catch (e) {
    return { ok: false, motivo: 'estado_indeterminado',
             mensagem: `Nao consegui reconfirmar o estado da venda (${e.message}). NADA foi alterado no Bling.` };
  }
  if (!st || !st.ok || !env || !env.ok) {
    return { ok: false, motivo: 'estado_indeterminado',
             mensagem: 'Nao consegui reconfirmar no Mercado Livre o estado da venda. NADA foi alterado no Bling. Tente de novo em instantes.' };
  }
  if (!st.cancelada && !env.temEtiqueta) return { ok: true };

  const campos = env.temEtiqueta
    ? { ml_etiqueta_em: new Date().toISOString(), ml_shipment_status: env.status || null,
        ml_shipment_substatus: env.substatus || null, ml_envio_indeterminado_em: null }
    : {};
  if (st.cancelada) {
    campos.status = 'venda_cancelada';
    campos.ml_status = st.status;
    campos.ml_status_atualizado_em = new Date().toISOString();
    campos.venda_cancelada_em = new Date().toISOString();
    if (env.temEtiqueta) {
      campos.alerta_pos_venda = (`CANCELADA NO ML com etiqueta ja gerada (${env.status || '?'}). ` +
        `NAO DESPACHAR. Conferir devolucao/estorno no ML e a NF/pedido no Bling.`).slice(0, 500);
    }
  }
  campos.nf_emitindo_em = null; campos.nf_emitindo_por = null;
  const u = await atualizarVenda(orderId, campos, Object.assign({ forcar: true }, fecharLease(token) || {}));
  const gravou = !!(u && u.ok && (!Array.isArray(u.data) || u.data.length === 1));
  return {
    ok: false,
    motivo: !gravou ? 'estado_nao_gravado' : (st.cancelada ? 'venda_cancelada' : 'etiqueta_ja_gerada'),
    cancelada: !!st.cancelada, etiqueta: !!env.temEtiqueta, gravou,
    mensagem: !gravou
      ? `A venda ${st.cancelada ? 'foi CANCELADA' : 'ja tem etiqueta'} no Mercado Livre, mas nao consegui registrar. NADA foi alterado no Bling. ${st.cancelada ? 'NAO DESPACHE e tente' : 'Tente'} de novo em instantes.`
      : (st.cancelada
        ? 'Esta venda foi CANCELADA no Mercado Livre. NADA foi alterado no Bling.'
        : `Esta venda ja tem etiqueta no ML (${env.status || '?'}). NADA foi alterado no Bling.`)
  };
}

module.exports = {
  recheckAposReserva,
  semReservaAtiva,
  reservarEmissao,
  liberarEmissao,
  fecharLease,
  configurado,
  upsertPendente,
  listarPendentes,
  atualizarVenda,
  marcarRespostaCliente,
  buscar,
  TABELA
};
