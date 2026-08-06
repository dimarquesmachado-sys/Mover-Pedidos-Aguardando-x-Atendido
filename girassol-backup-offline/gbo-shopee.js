'use strict';
// ════════════════════════════════════════════════════════════════════════
//  SHOPEE · FINANCEIRO POR PEDIDO — 05/08/2026 (v2)
// ════════════════════════════════════════════════════════════════════════
//  MUDANÇA DE ROTA, e o motivo importa:
//  A primeira versão deste arquivo falava DIRETO com a API da Shopee, com
//  partner_id/partner_key próprios. Ao tentar autorizar, o console mostrou que
//  o app JÁ TEM dono: o serviço `girassol-shopee-sync-organizar-envio`
//  (repo ambtotal-shopee-nf-sync-x-bling), que guarda tokens por loja em
//  data/<loja>/tokens-shopee.json e é quem organiza envio e coleta.
//
//  ⚠️ O PERIGO QUE ISSO EVITOU: o refresh_token da Shopee ROTACIONA a cada
//  renovação. Dois serviços renovando o mesmo par se invalidam — e quem cairia
//  seria a etiqueta/coleta da Shopee, operação crítica de todo dia.
//
//  Então: UM DONO SÓ do token (aquele serviço) e este módulo é só CLIENTE.
//  Nenhuma credencial da Shopee mora aqui. Também não precisa mexer no
//  Redirect URL Domain do console — ele continua apontando pro dono.
//
//  ENV: SHOPEE_SYNC_KEY (a mesma que o checkout já usa pra pedir etiqueta) e,
//  opcional, SHOPEE_SYNC_URL (padrão: o serviço de sempre).
//
//  Ainda NÃO interpreta o escrow — devolve cru de propósito. No ML eu errei o
//  formato cinco vezes por supor a estrutura antes de olhar uma amostra.
// ════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const base = require('./base');
const { json, ehAdmin, CONFERIDOS_FILE, readJson } = base;

const SYNC_URL = (process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com').replace(/\/+$/, '');
const SYNC_KEY = String(process.env.SHOPEE_SYNC_KEY || '').trim();
const LOJA = process.env.SHOPEE_SYNC_LOJA || 'girassol';

// Busca o escrow de um pedido no serviço que é dono do token.
// Devolve SEMPRE o cru junto: se o formato mudar, a gente vê na hora.
async function escrowDoPedido(orderSn) {
  if (!SYNC_KEY) return { ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste serviço' };
  const url = SYNC_URL + '/' + LOJA + '/interno/escrow/' + encodeURIComponent(String(orderSn).trim()) +
    '?k=' + encodeURIComponent(SYNC_KEY);
  try {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok && d && d.ok !== false, status: r.status, dados: d, cru: txt.slice(0, 4000) };
  } catch (e) {
    return { ok: false, erro: String((e && e.message) || e) };
  }
}

// ── 06/08: A FORMULA, tirada da resposta REAL (pedido 260806K85EPVXY) ─────────
// A sonda mostrou que a conta fecha exatamente assim:
//    produtos 49,90 − comissao 8,98 − servico 5,00 = escrow 35,92  ✓
// O frete NAO entrou: actual_shipping_fee era 26,30, o comprador pagou 6,30 e o
// final_shipping_fee veio -6,30 (negativo = a Shopee bancou, o vendedor nao paga).
// Por isso frete do vendedor = max(0, final_shipping_fee): so conta quando SOBRA
// custo pra loja.
// Os campos "net_" sao os que valem — vem depois de rebate/ajuste. Uso eles com
// os antigos como reserva.
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
function contasDoEscrow(resp) {
  const oi = (resp && resp.response && resp.response.order_income) || null;
  if (!oi) return null;
  const produtos = num(oi.order_discounted_price) || num(oi.cost_of_goods_sold) || num(oi.order_selling_price);
  const comissao = num(oi.net_commission_fee !== undefined ? oi.net_commission_fee : oi.commission_fee);
  const servico  = num(oi.net_service_fee !== undefined ? oi.net_service_fee : oi.service_fee);
  const transacao = num(oi.credit_card_transaction_fee);   // o buyer_transaction_fee quem paga e o comprador
  const campanha  = num(oi.campaign_fee);
  const processa  = num(oi.seller_order_processing_fee);
  const tarifa   = Math.round((comissao + servico + transacao + campanha + processa) * 100) / 100;
  const frete    = Math.round(Math.max(0, num(oi.final_shipping_fee)) * 100) / 100;
  const escrow   = num(oi.escrow_amount_after_adjustment !== undefined ? oi.escrow_amount_after_adjustment : oi.escrow_amount);
  // se a formula estiver certa, isto tem que dar ~0 em todo pedido
  const sobra = Math.round((produtos - tarifa - frete - escrow) * 100) / 100;
  return {
    produtos, comissao, servico, transacao, campanha, processa, tarifa, frete, escrow, sobra,
    pct_tarifa: produtos > 0 ? Math.round(tarifa / produtos * 1000) / 10 : null,
    pagamento: oi.buyer_payment_method || null,
    frete_real_da_shopee: num(oi.actual_shipping_fee), frete_pago_pelo_comprador: num(oi.buyer_paid_shipping_fee)
  };
}

function rotasShopee(ctx) {
  const { validarSessao } = ctx;

  function admOk(req, urlObj) {
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  return async function handleShopee(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;
    const q = urlObj.searchParams;

    // ── estado da ligação com o serviço dono do token ──────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/status') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let saude = null;
      try {
        const r = await fetch(SYNC_URL + '/health');
        saude = r.ok ? 'respondendo' : ('HTTP ' + r.status);
      } catch (e) { saude = 'sem resposta: ' + String((e && e.message) || e); }
      json(res, 200, {
        ok: true,
        quem_tem_o_token: SYNC_URL + ' (loja "' + LOJA + '")',
        chave_interna: SYNC_KEY ? 'configurada (SHOPEE_SYNC_KEY)' : 'FALTANDO — crie SHOPEE_SYNC_KEY neste serviço',
        servico: saude,
        nota: 'as credenciais da Shopee NÃO ficam aqui: quem guarda partner_key e tokens é o serviço acima. Isso evita dois donos do mesmo refresh_token.'
      });
      return true;
    }

    // ── SONDA: o escrow de um pedido, CRU ──────────────────────────────────
    // Sem &pedido=, pega sozinho a venda de Shopee mais recente do cache.
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/sonda') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let sn = String(q.get('pedido') || '').trim();
      let veioDe = 'parâmetro';
      if (!sn) {
        const conf = readJson(CONFERIDOS_FILE, {});
        const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
        const cand = linhas
          .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
          .sort((a, b) => String(b.conferido_em || b.cacheado_em || '').localeCompare(String(a.conferido_em || a.cacheado_em || '')));
        if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache — passe &pedido=ORDER_SN' }); return true; }
        sn = String(cand[0].numero_loja); veioDe = 'cache dos bipados';
      }
      const r = await escrowDoPedido(sn);
      json(res, 200, {
        ok: !!r.ok, pedido: sn, de_onde_veio_o_pedido: veioDe,
        via: SYNC_URL + '/' + LOJA + '/interno/escrow/' + sn,
        erro: r.erro || null, status_http: r.status || null,
        resposta_crua: r.cru || null,
        leia: 'ainda NÃO interpreto nada — é a resposta como a Shopee mandou, repassada pelo serviço que tem o token. Com ela na mão eu escrevo o parser sem chutar formato.'
      });
      return true;
    }

    // ── CONFERIR EM LOTE: a fórmula bate em quantos pedidos? ───────────────
    // Só leitura. Roda a conta em N pedidos de Shopee do cache e mostra onde
    // NÃO fecha. É o passo antes de gravar qualquer coisa no histórico.
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/conferir') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const max = Math.min(200, Math.max(1, parseInt(q.get('max') || '20', 10) || 20));
      const conf = readJson(CONFERIDOS_FILE, {});
      const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
      const cand = linhas
        .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
        .sort((a2, b2) => String(b2.conferido_em || b2.cacheado_em || '').localeCompare(String(a2.conferido_em || a2.cacheado_em || '')))
        .slice(0, max);
      if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache' }); return true; }
      const fecharam = [], nao_fecharam = [], falhas = [];
      let somaTarifa = 0, somaProdutos = 0;
      for (const c of cand) {
        const sn = String(c.numero_loja);
        const r = await escrowDoPedido(sn);
        const contas = r.ok && r.dados ? contasDoEscrow(r.dados.resposta) : null;
        if (!contas) { falhas.push({ pedido: sn, status: r.status || null, erro: r.erro || (r.dados && r.dados.erro) || 'sem order_income' }); }
        else {
          somaTarifa += contas.tarifa; somaProdutos += contas.produtos;
          const reg = Object.assign({ pedido: sn, pedido_bling: c.numero || null }, contas);
          if (Math.abs(contas.sobra) <= 0.02) fecharam.push(reg); else nao_fecharam.push(reg);
        }
        await new Promise(r2 => setTimeout(r2, 350));
      }
      json(res, 200, {
        ok: true, so_leitura: true, conferidos: cand.length,
        fecharam: fecharam.length, nao_fecharam: nao_fecharam.length, falhas: falhas.length,
        taxa_media_pct: somaProdutos > 0 ? Math.round(somaTarifa / somaProdutos * 1000) / 10 : null,
        formula: 'tarifa = comissao + servico + transacao_cartao + campanha + processamento · frete_vendedor = max(0, final_shipping_fee) · confere se produtos − tarifa − frete − escrow ≈ 0',
        exemplos_que_fecharam: fecharam.slice(0, 3),
        os_que_nao_fecharam: nao_fecharam.slice(0, 10),
        falhas_detalhe: falhas.slice(0, 5)
      });
      return true;
    }

    return false;   // não é rota da Shopee
  };
}

module.exports = { rotasShopee, escrowDoPedido };
