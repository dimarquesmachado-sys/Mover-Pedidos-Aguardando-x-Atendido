'use strict';

const fetch = require('node-fetch');

const ML_API = 'https://api.mercadolibre.com';

async function enviarNFeParaML(token, numeroPedidoLoja, nfDetalhe) {
  // numeroPedidoLoja = ex: "2000015773375350"
  // Primeiro precisamos buscar o order_id interno do ML a partir do número do pedido
  const respBusca = await fetch(
    `${ML_API}/orders/search?seller=${process.env.ML_SELLER_ID}&q=${numeroPedidoLoja}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!respBusca.ok) {
    const txt = await respBusca.text();
    throw new Error(`ML busca pedido erro ${respBusca.status}: ${txt}`);
  }

  const dataBusca = await respBusca.json();
  const order = dataBusca?.results?.[0];
  if (!order) throw new Error(`ML: pedido ${numeroPedidoLoja} não encontrado`);

  const orderId = order.id;
  console.log(`[mlApi] Pedido ML ${numeroPedidoLoja} → order_id=${orderId}`);

  // Enviar dados fiscais
  const payload = {
    type:         'B',
    number:       String(nfDetalhe.numero),
    serie:        String(nfDetalhe.serie),
    access_key:   nfDetalhe.chaveAcesso,
    issue_date:   nfDetalhe.dataEmissao.split(' ')[0], // "2026-03-31"
    invoice_url:  nfDetalhe.linkDanfe || nfDetalhe.xml || ''
  };

  console.log(`[mlApi] Enviando NF para order ${orderId}:`, JSON.stringify(payload));

  const respEnvio = await fetch(
    `${ML_API}/packs/${orderId}/fiscal_data`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    }
  );

  if (!respEnvio.ok) {
    const txt = await respEnvio.text();
    // Tentar também pelo endpoint de orders direto
    const respEnvio2 = await fetch(
      `${ML_API}/orders/${orderId}/fiscal_data`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      }
    );
    if (!respEnvio2.ok) {
      const txt2 = await respEnvio2.text();
      throw new Error(`ML envio NF erro: packs=${respEnvio.status}(${txt}) | orders=${respEnvio2.status}(${txt2})`);
    }
  }

  console.log(`[mlApi] ✅ NF enviada para pedido ML ${numeroPedidoLoja} (order ${orderId})`);
}

module.exports = { enviarNFeParaML };
