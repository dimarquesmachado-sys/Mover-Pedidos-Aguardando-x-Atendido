'use strict';
/* 15/11 — A TARIFA DO MERCADO LIVRE "LEVE" (norte C: rotinas idênticas nas empresas → peça).

   Soma a `sale_fee` dos itens de uma venda do ML (ou do pack dela) pelo token da empresa — é o que o backfill usa quando o
   Bling não trouxe a comissão. Era a mesma função em girassol-backup-offline/gbo-app.js e em amb-checkout-offline/index.js
   (a da AMB já não era chamada: o motor único usava a da Girassol, pra TODAS as empresas). Sem resposta/erro devolve 0 — quem
   chama trata zero como "não achei", como sempre. */
const fetch = require('node-fetch');

async function feeMLLeve(nl, tk) {
  const id = String(nl || '').replace(/\D/g, '');
  if (!id || !tk) return 0;
  const H = { headers: { Authorization: 'Bearer ' + tk } };   /* Codex #343 r4: objeto REUSADO em várias requisições — sinal aqui abortaria todas as seguintes junto com a primeira; timeout é por requisição, em quem chama */
  const soma = ords => { let f = 0; for (const od of ords) for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1), sf = Number(it.sale_fee || 0); if (isFinite(sf)) f += sf * q; } return Math.round(f * 100) / 100; };
  try {
    const r = await fetch('https://api.mercadolibre.com/orders/' + id, H);
    if (r.ok) { const d = await r.json().catch(() => null); return d ? soma([d]) : 0; }
    if (r.status !== 404) return 0;
    const rp = await fetch('https://api.mercadolibre.com/packs/' + id, H);
    if (!rp.ok) return 0;
    const dp = await rp.json().catch(() => null);
    const ords = [];
    for (const oq of ((dp && dp.orders) || [])) {
      const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H);
      if (ro.ok) { const doo = await ro.json().catch(() => null); if (doo) ords.push(doo); }
    }
    return ords.length ? soma(ords) : 0;
  } catch (e) { return 0; }
}

module.exports = { feeMLLeve };
