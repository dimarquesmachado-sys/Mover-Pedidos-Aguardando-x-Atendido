'use strict';

const fetch = require('node-fetch');

const ML_API = 'https://api.mercadolibre.com';
const SITE_ID = 'MLB';

// Busca o shipment_id e substatus a partir do número do pedido ML
async function getShipmentInfo(token, numeroPedidoLoja) {
  const resp = await fetch(
    `${ML_API}/orders/${numeroPedidoLoja}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  // Caso PACK (venda multi-item / carrinho): o Bling grava o pack_id como
  // "número do pedido na loja", e /orders/{pack_id} responde 404 —
  // comportamento documentado do ML. Aí o shipment vem do /packs/{pack_id}
  // (todas as ordens do pack compartilham o mesmo shipment).
  if (resp.status === 404) {
    const packResp = await fetch(
      `${ML_API}/packs/${numeroPedidoLoja}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (packResp.ok) {
      const pack = await packResp.json();
      const shipmentIdPack = pack?.shipment?.id;
      if (shipmentIdPack) {
        console.log(`[mlApi] ${numeroPedidoLoja} é PACK (carrinho) → shipment_id=${shipmentIdPack} via /packs`);
        return shipmentIdPack;
      }
      throw new Error(`ML: pack ${numeroPedidoLoja} sem shipment_id ainda (orders=${(pack?.orders || []).map(o => o.id).join(',') || '—'})`);
    }
  }

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
    status: data?.status,
    substatus: data?.substatus
  };
}

// DEBUG TEMPORÁRIO: retorna o shipment CRU do ML (todos os campos)
async function getShipmentRaw(token, shipmentId) {
  const resp = await fetch(
    `${ML_API}/shipments/${shipmentId}`,
    { headers: { Authorization: `Bearer ${token}`, 'x-format-new': 'true' } }
  );
  const data = await resp.json().catch(() => ({}));
  return { httpStatus: resp.status, data };
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
    // Anexa status/substatus ao erro para o F3 decidir se ainda vale re-checar.
    // Pedido em estado final (shipped/delivered/cancelled) nunca mais vai pedir
    // NF — com essa informação o F3 marca como resolvido já na 1ª passada, em
    // vez de re-checar 18x à toa (principal fonte de HTTP 429 na janela de 30d).
    throw Object.assign(
      new Error(`Shipment ${shipmentId} status=${status} substatus=${substatus} (não é invoice_pending) — NF não pode ser enviada agora`),
      { mlStatus: status, mlSubstatus: substatus }
    );
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
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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

module.exports = { enviarNFeParaML, getShipmentInfo, getShipmentSubstatus, getShipmentRaw };
