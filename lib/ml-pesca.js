'use strict';

/**
 * lib/ml-pesca.js — "pesca" dos dados do Mercado Livre por número de venda (01/09).
 *
 * Dívida nº 3 do docs/paridade-empresas.md. Aqui a medição mostrou algo pior do que cópia
 * simples: eram TRÊS cópias e elas JÁ DIVERGIRAM — a do gbo-app tinha 81 linhas, a da AMB
 * 85 (com o conserto de 25/08 do crédito Flex, que a Girassol não tinha) e a do
 * girassol-backup-offline/index.js apenas 72, atrasada em duas correções.
 *
 * A base desta lib é a versão da AMB, a mais nova — ela contém o conserto do ship_ok que
 * evita apagar crédito Flex quando só o /costs falha com 429, e o do bônus por envio medido
 * com a rota ml-flex-debug. Conferido: a função só usa os próprios parâmetros
 * (nlRaw, tokenML, dorme), então não precisa de contexto — foi por isso que ela pôde ser
 * copiada três vezes sem ninguém notar.
 */

async function pescarDadosML(nlRaw, tokenML, dorme) {
  const nl = String(nlRaw || '').replace(/\D/g, '');
  if (!nl || !tokenML) return null;
  const H = { headers: { Authorization: 'Bearer ' + tokenML } };
  let r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
  let d = await r.json().catch(() => null);
  let ords = null;
  if (r.ok && d) ords = [d];
  else if (r.status === 404) {   // id 2000... que dá 404 é PACK (carrinho): abre o pack e pega as orders
    try {
      const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
      const dp = await rp.json().catch(() => null);
      if (rp.ok && dp && Array.isArray(dp.orders) && dp.orders.length) {
        ords = [];
        for (const oq of dp.orders) {
          try { const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H); const doo = await ro.json().catch(() => null); if (ro.ok && doo) ords.push(doo); } catch (e3) {}
          await dorme(150);
        }
        if (!ords.length) ords = null;
      }
    } catch (e2) {}
  }
  if (!ords || !ords.length) return null;
  let fee = 0, venda = null, shipId = null;
  for (const od of ords) {
    for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1); const sf = Number(it.sale_fee || 0); if (isFinite(sf)) fee += sf * q; }
    if (!venda && od.date_created) venda = od.date_created;
    if (!shipId && od.shipping && od.shipping.id) shipId = od.shipping.id;
  }
  const _ord0 = (ords[0] && ords[0].id != null) ? String(ords[0].id) : null;
  const _viaPack = !!(_ord0 && _ord0 !== nl);
  const _packId = _viaPack ? nl : ((ords[0] && ords[0].pack_id != null) ? String(ords[0].pack_id) : null);
  const reg = { fee: Math.round(fee * 100) / 100, frete: null, venda: venda, _orders: ords.length, pack: _packId, order: _ord0 };
  if (shipId) {
    let ehFlex = false, baseCost = null;
    try {
      const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H);
      const ds = await rs.json().catch(() => null);
      if (rs.ok && ds) {
        const logi = (ds.logistic && ds.logistic.type) || ds.logistic_type || null;
        if (logi) reg.logistica = logi;
        reg.ship_ok = true;   /* 25/08: prova que /shipments respondeu. A Girassol já gravava
                                 (Codex PR#48) e a AMB não — sem isso o merge lá embaixo apaga
                                 crédito Flex quando só o /costs falha (429). */
        ehFlex = (logi === 'self_service');
        const bc = Number(ds.base_cost); if (isFinite(bc) && bc > 0) baseCost = bc;
        const so = ds.shipping_option || {};
        const lc = Number(so.list_cost != null ? so.list_cost : ds.list_cost);
        const cc = Number(so.cost != null ? so.cost : ds.cost);
        if (!ehFlex && isFinite(lc) && isFinite(cc) && lc > cc) reg.frete = Math.round((lc - cc) * 100) / 100;
      }
    } catch (e) {}
    await dorme(200);
    try {
      const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', H);
      const dc = await rc.json().catch(() => null);
      if (rc.ok && dc) {
        reg.costs_ok = true;
        const sd0 = Array.isArray(dc.senders) ? dc.senders[0] : null;
        const scost = Number(sd0 && sd0.cost);
        const scOk = isFinite(scost) && scost > 0;
        let cred = 0, fonte = null;
        if (sd0) {
          const c1 = Number(sd0.compensation); if (isFinite(c1) && c1 > 0) { cred += c1; fonte = 'compensation'; }
          for (const cx of (sd0.compensations || [])) { const c2 = Number(cx && cx.amount); if (isFinite(c2) && c2 > 0) { cred += c2; fonte = 'compensation'; } }
        }
        // 13/08 — DIAGNOSTICO REAL (rota ml-flex-debug na venda 2000014472881525, entregue):
        //   compensation: 0 · compensations: [] · sender_cost: 0 · base_cost: 0
        //   gross_amount: 8.90  ← exatamente o "Estorno / Bonus por envio" da tela do ML
        // No Flex (self_service) o ML paga ao vendedor o BRUTO do frete que ele nao cobrou do
        // comprador: o credito e o gross_amount, desde que o vendedor nao tenha pago nada
        // (sender_cost = 0). O billing nao serve pra isso — 504 creditos, zero bonus de envio.
        if (cred === 0 && ehFlex && !scOk) {
          const ga = Number(dc.gross_amount);
          if (isFinite(ga) && ga > 0) { cred = Math.round(ga * 100) / 100; fonte = 'costs_gross'; }
        }
        if (cred === 0 && ehFlex && baseCost != null) { cred = Math.round((baseCost - (scOk ? scost : 0)) * 100) / 100; fonte = 'flex_liquido'; }
        if (cred !== 0) { reg.credito = Math.round(cred * 100) / 100; reg.credito_fonte = fonte; }
        if (!ehFlex && scOk) reg.frete = Math.round(scost * 100) / 100;
      }
    } catch (e) {}
    await dorme(200);
  }
  return reg;
}

module.exports = { pescarDadosML };
