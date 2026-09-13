'use strict';
/* 12/09 — o critério de "escrow FECHOU", nascido do pedido 4407 (260907DUQHVFRW), com os
   números REAIS que a Shopee devolveu. Enquanto não fecha, o pedido tem que voltar na fila:
   foi por não voltar que a tarifa ficou 43,63 (sem o seguro de envio de 0,49, lançado depois)
   e o frete do vendedor nunca chegou, deixando a linha em AGUARDANDO eterno. */
const assert = require('assert');

const nS2 = x => { const n = Number(x); return isFinite(n) ? n : 0; };
function avaliar(es) {
  const com = nS2(es.net_commission_fee != null ? es.net_commission_fee : es.commission_fee);
  const srv = nS2(es.net_service_fee != null ? es.net_service_fee : es.service_fee);
  const rbt = nS2(es.seller_product_rebate && es.seller_product_rebate.amount);
  const afi = nS2(es.order_ams_commission_fee);
  const cam = nS2(es.campaign_fee);
  const prc = nS2(es.seller_order_processing_fee);
  const seg = nS2(es.shipping_seller_protection_fee_amount);
  const tS = Math.round((com + srv + rbt + afi + seg + cam + prc) * 100) / 100;
  const prod = nS2(es.order_selling_price != null ? es.order_selling_price : es.cost_of_goods_sold);
  const frCo = nS2(es.buyer_paid_shipping_fee);
  const ads = nS2(es.ads_escrow_top_up_fee_or_technical_support_fee);
  const fsf = nS2(es.final_shipping_fee);
  const esc = nS2(es.escrow_amount);
  const sobra = Math.round((prod + frCo - tS - ads + fsf - esc) * 100) / 100;
  return { tarifa: tS, sobra, final: (esc > 0 && Math.abs(sobra) <= 0.02) ? 1 : 0 };
}

// ── o escrow REAL do 4407, já fechado ──────────────────────────────────────────
const real = {
  net_commission_fee: 10.15, net_service_fee: 19.97,
  seller_product_rebate: { amount: 13.51 },
  shipping_seller_protection_fee_amount: 0.49,
  ads_escrow_top_up_fee_or_technical_support_fee: 2.7,
  order_selling_price: 135, buyer_paid_shipping_fee: 0.53,
  final_shipping_fee: 0, escrow_amount: 88.71,
};
const r = avaliar(real);
assert.strictEqual(r.tarifa, 44.12, 'a tarifa com o seguro de envio é 44,12 — 43,63 era o retrato provisório');
assert.strictEqual(r.sobra, 0, 'a identidade fecha exatamente com o repasse de 88,71');
assert.strictEqual(r.final, 1, 'fechado: pode parar de reler e mostrar frete zero');

// ── o MESMO pedido antes de a Shopee lançar o seguro: NÃO pode ser dado como final ──
const provisorio = Object.assign({}, real, { shipping_seller_protection_fee_amount: 0 });
const p = avaliar(provisorio);
assert.strictEqual(p.tarifa, 43.63, 'sem o seguro, a tarifa é a que estava gravada');
assert.notStrictEqual(p.final, 1, 'com sobra de 0,49 o escrow NÃO fechou — tem que voltar na fila');
assert.strictEqual(p.sobra, 0.49, 'e a sobra aponta exatamente o que falta');

// ── sem repasse ainda: nunca final ─────────────────────────────────────────────
assert.strictEqual(avaliar(Object.assign({}, real, { escrow_amount: 0 })).final, 0);

console.log('OK: escrow final — 4407 real fecha em 44,12/sobra 0; sem o seguro sobra 0,49 e NÃO fecha; sem repasse nunca fecha');
