'use strict';
/**
 * prazoPostagem.js — calcula o PRAZO-LIMITE DE POSTAGEM (ship-by) de um pedido ML.
 *
 * Descoberta (via sonda /auto-mensagens/debug/prazo): o ML NAO expoe uma data de
 * "handling limit" direta — nem no shipment, nem no endpoint dedicado de lead_time
 * (estimated_handling_limit.date sempre veio null). O que da pra usar:
 *
 *   - estimated_delivery_time.handling : janela de manuseio em HORAS (ex.: 24 no Expresso, 0 no Normal)
 *   - estimated_delivery_time.shipping : transito em HORAS (ex.: 24 Expresso, 96 Normal)
 *   - status_history.date_handling     : quando o pedido entrou em manuseio
 *   - estimated_delivery_limit.date    : data-limite de ENTREGA
 *   - buffering.date                   : quando o buffer (coleta agrupada) libera
 *
 * Regra (em ordem de preferencia):
 *   1) handling > 0  -> ship_by = date_handling + handling horas        (Expresso/rapido)
 *   2) handling 0/ausente, mas tem delivery_limit + shipping
 *                    -> ship_by = delivery_limit - shipping horas       (Normal/buffered)
 *   3) so tem buffering.date -> ship_by = buffering.date
 *   4) fallback conservador -> date_handling + 48h
 *
 * Recebe o objeto shipment (o `shipment_bruto` da sonda serve: tem shipping_option
 * com estimated_delivery_time mesmo quando o lead_time embutido vem vazio).
 */

function _data(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function calcularPrazoPostagem(shipment) {
  if (!shipment || typeof shipment !== 'object') {
    return { ok: false, motivo: 'shipment_vazio' };
  }

  const lt  = shipment.lead_time || {};
  const so  = shipment.shipping_option || {};
  const sh  = shipment.status_history || {};
  // estimated_delivery_time pode estar no lead_time (endpoint dedicado) OU no shipping_option
  const edt = (lt.estimated_delivery_time && Object.keys(lt.estimated_delivery_time).length)
    ? lt.estimated_delivery_time
    : (so.estimated_delivery_time || {});

  const dateHandling  = _data(sh.date_handling) || _data(shipment.date_created);
  const handlingHoras = Number(edt.handling);           // 0 eh valido (NAO tratar como ausente)
  const shippingHoras = Number(edt.shipping) || null;
  const deliveryLimit = _data(lt?.estimated_delivery_limit?.date || so?.estimated_delivery_limit?.date);
  const bufferingDate = _data(lt?.buffering?.date || so?.buffering?.date);

  const out = {
    ok: true,
    metodo:     so.shipping_method?.name || lt.shipping_method?.name || null,
    tipo_envio: so.shipping_method?.type || lt.shipping_method?.type || null,
    status:     shipment.status || null,
    substatus:  shipment.substatus || null,
    buffered:   shipment.substatus === 'buffered' || !!bufferingDate,
    base: {
      date_handling:  dateHandling  ? dateHandling.toISOString()  : null,
      handling_horas: Number.isFinite(handlingHoras) ? handlingHoras : null,
      shipping_horas: shippingHoras,
      delivery_limit: deliveryLimit ? deliveryLimit.toISOString() : null,
      buffering_date: bufferingDate ? bufferingDate.toISOString() : null
    }
  };

  // 1) Janela de handling positiva -> Expresso/rapido
  if (dateHandling && Number.isFinite(handlingHoras) && handlingHoras > 0) {
    out.prazo_postagem = new Date(dateHandling.getTime() + handlingHoras * 3600e3).toISOString();
    out.origem = 'handling (date_handling + handling horas)';
    return out;
  }

  // 2) handling 0/ausente -> trabalha de tras pra frente do delivery limit
  if (deliveryLimit && shippingHoras) {
    out.prazo_postagem = new Date(deliveryLimit.getTime() - shippingHoras * 3600e3).toISOString();
    out.origem = 'delivery_limit - shipping horas';
    return out;
  }

  // 2b) so buffering
  if (bufferingDate) {
    out.prazo_postagem = bufferingDate.toISOString();
    out.origem = 'buffering.date';
    return out;
  }

  // 3) fallback conservador
  if (dateHandling) {
    out.prazo_postagem = new Date(dateHandling.getTime() + 48 * 3600e3).toISOString();
    out.origem = 'fallback (date_handling + 48h)';
    return out;
  }

  out.ok = false;
  out.motivo = 'sem_dados_suficientes';
  return out;
}

/**
 * Quantas horas FALTAM ate o prazo de postagem (a partir de agora).
 * Negativo = ja passou. null = sem prazo calculavel.
 */
function horasAtePrazo(shipment, agora = new Date()) {
  const r = calcularPrazoPostagem(shipment);
  if (!r.ok || !r.prazo_postagem) return null;
  return (new Date(r.prazo_postagem).getTime() - agora.getTime()) / 3600e3;
}

module.exports = { calcularPrazoPostagem, horasAtePrazo };
