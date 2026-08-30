'use strict';

/**
 * lib/tiktok-eventos.js — linha do tempo da devolução (29/08).
 *
 * DESCOBERTO POR SONDA, com dois casos reais do pedido 585110624384091852 (as duas caixas):
 * o endpoint /return_refund/202309/returns/{id}/records responde 200 e traz os eventos com
 * data. Nenhum campo da busca traz isso — era o que faltava pra conversa do Devoluções.
 *
 * Eventos vistos no dado real:
 *   ORDER_RETURN                              cliente abriu
 *   SELLER_AGGREE_RETURN                      aprovado (auto pela política)
 *   BUYER_SHIPPED                             CLIENTE POSTOU o pacote  ← o que faltava
 *   REFUND_SUCCESS                            reembolso concluído
 *   SELLER_REJECT_RECEIVE_DELIVERED_TIMEOUT   "aprovado porque não foi analisado no prazo"
 *
 * O último é o evento da REVELIA — e o nome carrega DELIVERED: o pacote chegou e o prazo
 * correu sem resposta. Nos 2 casos reais, o timeout caiu 6 e 7 dias depois da postagem.
 * É esse intervalo que dá pra vigiar pra avisar ANTES de perder.
 */

const EV = {
  ABRIU: 'ORDER_RETURN',
  APROVOU: 'SELLER_AGGREE_RETURN',
  POSTOU: 'BUYER_SHIPPED',
  REEMBOLSOU: 'REFUND_SUCCESS',
};
/* 30/08 — CORREÇÃO IMPORTANTE: /TIMEOUT/ pegava demais. Os dados reais trouxeram TRÊS
   eventos com TIMEOUT no nome, e só um é culpa da loja:
     SELLER_REJECT_RECEIVE_DELIVERED_TIMEOUT  → REVELIA: a loja não analisou no prazo
     BUYER_RETURN_SHIPPED_TIMEOUT             → o CLIENTE não postou; pedido fechado (a favor)
     BUYER_APPLY_ARBITRATION_TIMEOUT_REFUND   → o cliente não contestou (também a favor)
   Contar os três como revelia inflava o número e apontava culpa errada. */
const RX_REVELIA = /^SELLER_REJECT_RECEIVE.*TIMEOUT$/i;
const RX_FECHADO_A_FAVOR = /^BUYER_.*TIMEOUT/i;
const RX_ENTREGUE = /DELIVERED|RECEIVED/i;  // o nome do evento carrega o estado do pacote

function resumirEventos(records) {
  const lista = Array.isArray(records) ? records : [];
  const r = { eventos: lista.length, abriu_em: null, aprovado_em: null, postado_em: null,
              reembolsado_em: null, revelia_em: null, entregue_indicado: false,
              fechado_por_inacao_do_cliente: false, fechado_em: null, ultimo: null };
  for (const e of lista) {
    if (!e || typeof e !== 'object') continue;
    const ev = String(e.event || '');
    const t = Number(e.create_time) || null;
    if (ev === EV.ABRIU && !r.abriu_em) r.abriu_em = t;
    if (ev === EV.APROVOU) r.aprovado_em = t;
    if (ev === EV.POSTOU) r.postado_em = t;
    if (ev === EV.REEMBOLSOU) r.reembolsado_em = t;
    if (RX_REVELIA.test(ev)) r.revelia_em = t;
    if (RX_FECHADO_A_FAVOR.test(ev)) { r.fechado_por_inacao_do_cliente = true; r.fechado_em = t; }
    if (RX_ENTREGUE.test(ev)) r.entregue_indicado = true;
    if (!r.ultimo || (t && t > r.ultimo.em)) r.ultimo = { evento: ev, em: t, descricao: e.description || null };
  }
  /* dias entre postar e a revelia. Com 99 devoluções o intervalo real observado foi de
     4 a 9 dias — o PIOR caso é 4, então um alerta útil precisa avisar em 2 ou 3 dias. */
  r.dias_postagem_ate_revelia = (r.postado_em && r.revelia_em)
    ? Math.round((r.revelia_em - r.postado_em) / 86400) : null;
  /* PERDA POR REVELIA: não foi julgamento, foi falta de resposta no prazo */
  r.perdeu_por_revelia = !!r.revelia_em;
  /* AGUARDANDO: postou e ainda não houve revelia nem conclusão — é aqui que o alerta vale */
  r.aguardando_analise = !!(r.postado_em && !r.revelia_em);
  return r;
}

module.exports = { resumirEventos, EV };
