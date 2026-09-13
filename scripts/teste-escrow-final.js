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
  // Codex #389: tem que ser os MESMOS campos que lib/shopee-escrow.js prioriza — senão a
  // identidade nunca fecha (ou fecha com o valor errado) num pedido com desconto ou com
  // ajuste pós-escrow. Ver os casos "com desconto" e "com ajuste" abaixo.
  const prod = nS2(es.order_discounted_price) || nS2(es.cost_of_goods_sold) || nS2(es.order_selling_price);
  const frCo = nS2(es.buyer_paid_shipping_fee);
  const ads = nS2(es.ads_escrow_top_up_fee_or_technical_support_fee);
  const fsf = nS2(es.final_shipping_fee);
  const esc = nS2(es.escrow_amount_after_adjustment != null ? es.escrow_amount_after_adjustment : es.escrow_amount);
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

// ── Codex #389 (P1): pedido COM DESCONTO — usar o preço CHEIO em vez do descontado
// nunca fecha a identidade (o Codex achou isto em amb-checkout-offline/index.js e no espelho
// da Girassol: a fórmula pegava order_selling_price, e lib/shopee-escrow.js pega
// order_discounted_price primeiro). Preço cheio 150, descontado 135 (o mesmo valor do 4407).
const comDesconto = Object.assign({}, real, { order_selling_price: 150, order_discounted_price: 135 });
const rd = avaliar(comDesconto);
assert.strictEqual(rd.sobra, 0, 'com o preço DESCONTADO a identidade fecha igual ao 4407 original');
assert.strictEqual(rd.final, 1, 'descontado: fechado');
// prova que o preço CHEIO (o bug) quebra a identidade neste mesmo pedido:
const prodCheio = 150, frCo0 = 0.53, ads0 = 2.7, fsf0 = 0, esc0 = 88.71;
const sobraComPrecoCheio = Math.round((prodCheio + frCo0 - 44.12 - ads0 + fsf0 - esc0) * 100) / 100;
assert.strictEqual(sobraComPrecoCheio, 15, 'o preço cheio erra em exatamente o valor do desconto — nunca fecharia (bug que o Codex apontou)');

// ── Codex #389 (P2): pedido com AJUSTE pós-escrow — usar o valor SEM ajuste nunca fecha.
// O repasse pré-ajuste (88,22) é o que a Shopee mandou antes de corrigir; o que caiu na
// conta de fato é o ajustado (88,71, o mesmo repasse do 4407 real).
const comAjuste = Object.assign({}, real, { escrow_amount: 88.22, escrow_amount_after_adjustment: 88.71 });
const ra = avaliar(comAjuste);
assert.strictEqual(ra.sobra, 0, 'com o repasse AJUSTADO a identidade fecha');
assert.strictEqual(ra.final, 1, 'ajustado: fechado');
assert.notStrictEqual(avaliar(Object.assign({}, real, { escrow_amount: 88.22, escrow_amount_after_adjustment: null })).final, 1, 'sem usar o ajuste, o repasse pré-ajuste deixa sobra e NUNCA fecha (bug que o Codex apontou)');

console.log('OK: escrow final — 4407 real fecha em 44,12/sobra 0; sem o seguro sobra 0,49 e NÃO fecha; sem repasse nunca fecha; preço descontado e repasse ajustado fecham, os valores pré-fix não fechariam');
