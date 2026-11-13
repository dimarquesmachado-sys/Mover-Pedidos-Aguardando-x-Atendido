'use strict';
/* 13/11 (plano multiloja, Fase 3 item 5 — os arquivos de entrada só compondo) — A PESCA DAS TARIFAS DO MERCADO LIVRE, PEÇA ÚNICA.

   O `mlSyncFees` (busca no ML a tarifa REAL, o frete do vendedor, a logística e os custos de cada pedido recente e grava no
   conferido) existia nas três empresas. Na Girassol e na AMB era o MESMO corpo — 133 de 136 linhas de código idênticas; o
   que mudava:
     · de onde vem o token do ML (o gerente de token de cada empresa)  → `garantirTokenML`, entregue por quem monta;
     · a VERSÃO do marcador de custos gravado em cada pedido (`ml_costs_v3`): a Girassol grava 2 e relê quem tem menos (foi
       assim que ela repescou tudo depois do conserto do PR #48); a AMB grava 1 e só relê quem não tem marca
       → `versaoCustos`, declarada por quem monta (com 1, a regra "menor que a versão" é exatamente a "não tem marca").
   O corpo é o que estava nos arquivos (scripts/teste-ml-sync-fees-peca.js compara com o de antes, das duas). O estado da
   pesca (`_mls`, que as rotas de status leem) continua sendo da empresa: a peça lê e devolve por acessor.

   A GOOD ainda tem a versão dela — mais antiga, sem os custos novos do ML (logística, Flex, pacote); junta depois,
   nivelando por cima. */
const fetch = require('node-fetch');

const PECAS = ['CONFERIDOS_FILE', '_mls', 'garantirTokenML', 'readJson', 'writeJson'];

function criar(G) {
  if (!G || !G.empresa) throw new Error('lib/checkout/ml-sync-fees: falta empresa');
  for (const n of PECAS) if (!(n in G)) throw new Error('lib/checkout/ml-sync-fees: falta ' + n);
  const VERSAO_CUSTOS = Number(G.versaoCustos);
  if (!(VERSAO_CUSTOS >= 1)) throw new Error('lib/checkout/ml-sync-fees: falta versaoCustos (1 ou mais)');
  return async function mlSyncFees(dias) {
    const { CONFERIDOS_FILE, readJson, writeJson } = G;
    let _mls = G._mls;
  dias = Math.max(1, Math.min(60, Number(dias || 14)));
  if (_mls.rodando) return _mls;
  const corte = Date.now() - dias * 86400000;
  const recheck = Date.now() - 3 * 86400000;
  const conf0 = readJson(CONFERIDOS_FILE, {});
  const alvos = Object.entries(conf0).filter(([cid, c]) => {
    if (!c || !c.conferido_em) return false;
    const t = new Date(c.conferido_em).getTime();
    if (t < corte) return false;
    const mk = String(c.marketplace || '').toLowerCase();
    if (mk !== 'ml' && mk !== 'mercadolivre') return false;
    if (!c.numero_loja) return false;
    return c.tarifa_ml == null || c.venda_em == null || Number(c.ml_costs_v3 || 0) < VERSAO_CUSTOS || c.ml_order == null || t >= recheck;   /* Codex PR#48: marcador versionado */   // ml_order==null: ainda sem o par pack/order — uma passada preenche   // !ml_costs_v2 = ainda nao passou pelo /costs (frete real + estorno) — vale uma passada
  }).map(([cid]) => cid);
  if (!alvos.length) { console.log('[ML-FEES] nada a pescar (' + dias + 'd)'); return { ok: true, nada: true }; }
  _mls = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString(), erros: {}, amostras: [] }; G._mls = _mls;
  console.log('[ML-FEES] pescando tarifas de ' + alvos.length + ' pedido(s) ML...');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  let tokenML = null;
  try { tokenML = await G.garantirTokenML(); }
  catch (e) { _mls.rodando = false; console.log('[ML-FEES] ✗ sem token ML: ' + e.message); return _mls; }
  const pend = {};
  const salvar = () => {
    if (!Object.keys(pend).length) return;
    const c2 = readJson(CONFERIDOS_FILE, {});
    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; if (d.credito != null) c2[cid].credito_ml = d.credito; if (d.credito_fonte) c2[cid].credito_fonte = d.credito_fonte; if (d.logistica) c2[cid].logistica_ml = d.logistica; if (d.pack) c2[cid].ml_pack = d.pack; if (d.order) c2[cid].ml_order = d.order; if (d.costs_ok && d.ship_ok) { c2[cid].ml_costs_v3 = VERSAO_CUSTOS; if (d.credito == null && c2[cid].credito_fonte !== 'billing') delete c2[cid].credito_ml;   /* 25/08: 'costs_gross' NÃO é exceção aqui — ele nasce da própria resposta do /costs, então uma leitura FRESCA e COMPLETA (costs_ok E ship_ok) que diz "sem crédito" desmente o valor velho. Protegê-lo seria blindar o dado contra a própria atualização, e o ml_costs_v3 avança logo abaixo: passada a rejanela de 3 dias, o crédito obsoleto pararia de ser reconferido e inflaria a margem pra sempre. Falha ou 429 já são barrados por costs_ok/ship_ok. 'billing' continua exceção: vem do relatório oficial de faturamento, outra fonte. */ /* Codex PR#48: /costs novo manda — resposta fresca com custo do vendedor derruba o gross antigo */ if (d.frete == null) delete c2[cid].frete_ml; } }
    writeJson(CONFERIDOS_FILE, c2);
    for (const cid of Object.keys(pend)) delete pend[cid];
  };
  for (const cid of alvos) {
    try {
      const nl = String((conf0[cid] && conf0[cid].numero_loja) || '').replace(/\D/g, '');
      const H = { headers: { Authorization: 'Bearer ' + tokenML } };
      let r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
      let d = await r.json().catch(() => null);
      let ords = null;   // 1 order normal; N orders quando o Bling gravou o PACK id (carrinho)
      if (r.ok && d) ords = [d];
      else if (r.status === 404) {
        // "Order do not exists" com id 2000...: é PACK (carrinho) — abre o pack e pega as orders de dentro
        try {
          const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
          const dp = await rp.json().catch(() => null);
          if (rp.ok && dp && Array.isArray(dp.orders) && dp.orders.length) {
            ords = [];
            for (const oq of dp.orders) {
              try {
                const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H);
                const doo = await ro.json().catch(() => null);
                if (ro.ok && doo) ords.push(doo);
              } catch (e3) {}
              await dorme(150);
            }
            if (!ords.length) ords = null;
          }
        } catch (e2) {}
      }
      if (ords && ords.length) {
        let fee = 0, venda = null, shipId = null;
        for (const od of ords) {
          for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1); const sf = Number(it.sale_fee || 0); if (isFinite(sf)) fee += sf * q; }
          if (!venda && od.date_created) venda = od.date_created;
          if (!shipId && od.shipping && od.shipping.id) shipId = od.shipping.id;
        }
        // PAR de números do ML: toda venda tem order_id; carrinho tem também pack_id (e a tela/NF do ML usam o pack).
        // Se o /orders respondeu direto, nl era a ORDER e o pack vem no payload; se caímos no /packs, nl era o PACK.
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
              reg.ship_ok = true;   /* Codex PR#48: /costs sozinho nao prova que sabemos se e Flex */
              ehFlex = (logi === 'self_service');   // self_service = Mercado Envios FLEX (quem entrega e o vendedor)
              const bc = Number(ds.base_cost);
              if (isFinite(bc) && bc > 0) baseCost = bc;   // bonificacao que o ML paga pela entrega Flex
              const so = ds.shipping_option || {};
              const lc = Number(so.list_cost != null ? so.list_cost : ds.list_cost);
              const cc = Number(so.cost != null ? so.cost : ds.cost);
              // SO grava frete quando o vendedor realmente paga algo. Gravar 0 fazia o painel achar que
              // "0 e o valor real" e ignorar o custo configurado do FLEX (o motoboy) -> margem inflada.
              if (!ehFlex && isFinite(lc) && isFinite(cc) && lc > cc) reg.frete = Math.round((lc - cc) * 100) / 100;
            }
          } catch (e) {}
          await dorme(200);
          // /shipments/{id}/costs + base_cost = o ESTORNO exatamente como o ML mostra na tela da venda.
          //  - senders[0].cost .... frete que o ML COBRA do vendedor
          //  - base_cost .......... bonificacao que o ML PAGA pela entrega Flex
          //  - FLEX: o ML nao mostra as duas pontas, mostra o LIQUIDO (base_cost - cost). Conferido:
          //      116454 -> 11,00 - 0,00 = 11,00   |   116462 -> 11,00 - 9,90 = 1,10
          //    Por isso, no Flex, o frete cobrado NAO entra como custo separado (ja esta liquido aqui);
          //    o custo real do Flex e o motoboy, configurado no painel por canal.
          try {
            const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', H);
            const dc = await rc.json().catch(() => null);
            if (rc.ok && dc) {
              reg.costs_ok = true;
              const sd0 = Array.isArray(dc.senders) ? dc.senders[0] : null;
              const scost = Number(sd0 && sd0.cost);
              const scOk = isFinite(scost) && scost > 0;
              let cred = 0, fonte = null;
              if (sd0) {   // compensacoes explicitas (avaria, dimensao errada...) vem primeiro
                const c1 = Number(sd0.compensation);
                if (isFinite(c1) && c1 > 0) { cred += c1; fonte = 'compensation'; }
                for (const cx of (sd0.compensations || [])) { const c2 = Number(cx && cx.amount); if (isFinite(c2) && c2 > 0) { cred += c2; fonte = 'compensation'; } }
              }
              // 13/08 (porte do b58 da AMB): o bonus do Flex e o gross_amount — ver comentario
              // na outra copia desta mesma logica (o arquivo tem as duas: pescarDadosML e este
              // bloco inline do mlSyncFees). Corrigir SEMPRE as duas.
              if (cred === 0 && ehFlex && !scOk) {
                const ga = Number(dc.gross_amount);
                if (isFinite(ga) && ga > 0) { cred = Math.round(ga * 100) / 100; fonte = 'costs_gross'; }
              }
              if (cred === 0 && ehFlex && baseCost != null) {
                cred = Math.round((baseCost - (scOk ? scost : 0)) * 100) / 100;   // LIQUIDO, igual a tela do ML
                fonte = 'flex_liquido';
              }
              if (cred !== 0) { reg.credito = Math.round(cred * 100) / 100; reg.credito_fonte = fonte; }
              if (!ehFlex && scOk) reg.frete = Math.round(scost * 100) / 100;   // fora do Flex o frete e custo de verdade
            }
          } catch (e) {}
          await dorme(200);
        }
        pend[cid] = reg; _mls.ok++;
      } else {
        _mls.falhas++;
        const stc = String(r.status), em = (((d && (d.message || d.error)) || '') + (r.status === 404 ? ' [nem order nem pack]' : '')).slice(0, 140);
        _mls.erros[stc] = (_mls.erros[stc] || 0) + 1;
        if (_mls.amostras.length < 3) { _mls.amostras.push({ pedido: cid, numero_loja: nl, status: r.status, msg: em }); }
        if ((_mls.erros[stc] || 0) === 1) console.log('[ML-FEES] falha ' + r.status + ' no pedido ' + cid + ' (venda ' + nl + '): ' + em);
      }
    } catch (e) {
      _mls.falhas++;
      _mls.erros.exc = (_mls.erros.exc || 0) + 1;
      if (_mls.amostras.length < 3) { _mls.amostras.push({ pedido: cid, status: 'exc', msg: String(e.message || e).slice(0, 140) }); }
      if (_mls.erros.exc === 1) console.log('[ML-FEES] exceção no pedido ' + cid + ': ' + (e.message || e));
    }
    _mls.feitos++;
    if (_mls.feitos % 15 === 0) { salvar(); console.log('[ML-FEES] ' + _mls.feitos + '/' + _mls.total); }
    await dorme(350);
  }
  salvar(); _mls.rodando = false;
  console.log('[ML-FEES] ✔ ' + _mls.ok + ' ok, ' + _mls.falhas + ' falha(s) de ' + _mls.total);
  return _mls;
};
}

module.exports = { criar, PECAS };
