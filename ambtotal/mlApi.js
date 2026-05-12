'use strict';

const fetch = require('node-fetch');

const ML_API = 'https://api.mercadolibre.com';

// Busca o shipment_id a partir do número do pedido ML
async function getShipmentInfo(token, numeroPedidoLoja) {
  const resp = await fetch(
    `${ML_API}/orders/${numeroPedidoLoja}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AMB ML busca pedido ${numeroPedidoLoja} erro ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const shipmentId = data?.shipping?.id;
  if (!shipmentId) throw new Error(`AMB ML: pedido ${numeroPedidoLoja} sem shipment_id`);

  return shipmentId;
}

// Verifica substatus do shipment
async function getShipmentSubstatus(token, shipmentId) {
  const resp = await fetch(
    `${ML_API}/shipments/${shipmentId}`,
    { headers: { Authorization: `Bearer ${token}`, 'x-format-new': 'true' } }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AMB ML shipment ${shipmentId} erro ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    status:    data?.status,
    substatus: data?.substatus
  };
}

module.exports = { getShipmentInfo, getShipmentSubstatus };
