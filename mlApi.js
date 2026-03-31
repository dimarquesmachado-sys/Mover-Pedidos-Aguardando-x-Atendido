'use strict';

const fetch = require('node-fetch');

const ML_API  = 'https://api.mercadolibre.com';
const SITE_ID = 'MLB';

// Busca o shipment_id e substatus a partir do número do pedido ML
async function getShipmentInfo(token, numeroPedidoLoja) {
  const resp = await fetch(
    `${ML_API}/orders/${numeroPedidoLoja}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ML busca pedido ${numeroPedidoLoja} erro ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const shipmentId = data?.shipping?.id;
  if (!shipmentId) throw new Error(`ML: pedido ${numeroPedidoLoja} sem shipment_id`);

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
    throw new Error(`ML shipment ${shipmentId} erro ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    status:    data?.status,
    substatus: data?.substatus
  };
}

// Baixa o XML da NF-e direto do link do Bling
async function baixarXmlNFe(xmlUrl) {
  const resp = await fetch(xmlUrl);
  if (!resp.ok) throw new Error(`Erro ao baixar XML da NF: ${resp.status}`);
  return await resp.text();
}

// Envia a NF-e para o ML via XML
async function enviarNFeParaML(token, numeroPedidoLoja, nfDetalhe) {
  // 1. Buscar shipment_id
  const shipmentId = await getShipmentInfo(token, numeroPedidoLoja);
  console.log(`[mlApi] Pedido ML ${numeroPedidoLoja} → shipment_id=${shipmentId}`);

  // 2. Verificar substatus
  const { status, substatus } = await getShipmentSubstatus(token, shipmentId);
  console.log(`[mlApi] Shipment ${shipmentId} → status=${status} substatus=${substatus}`);

  if (substatus !== 'invoice_pending') {
    throw new Error(`Shipment ${shipmentId} substatus=${substatus} (não é invoice_pending) — NF não pode ser enviada agora`);
  }

  // 3. Baixar XML da NF-e
  if (!nfDetalhe.xml) throw new Error(`NF ${nfDetalhe.id} sem URL de XML`);
  console.log(`[mlApi] Baixando XML da NF...`);
  const xmlContent = await baixarXmlNFe(nfDetalhe.xml);

  // 4. Enviar XML para o ML
  console.log(`[mlApi] Enviando XML para shipment ${shipmentId}...`);
  const resp = await fetch(
    `${ML_API}/shipments/${shipmentId}/invoice_data/?siteId=${SITE_ID}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/xml'
      },
      body: xmlContent
    }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ML envio NF shipment=${shipmentId} erro ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const result = await resp.json().catch(() => ({}));
  console.log(`[mlApi] ✅ NF enviada para shipment ${shipmentId}:`, JSON.stringify(result));
  return result;
}

module.exports = { enviarNFeParaML };
