'use strict';
// ════════════════════════════════════════════════════════════════════════
//  SHOPEE · API OFICIAL (Open Platform v2) — 05/08/2026
// ════════════════════════════════════════════════════════════════════════
//  POR QUE: hoje a Shopee entra no dashboard pela taxa que o BLING importa —
//  e quando não vem, ninguém completa. Foi isso que deixou a pílula "tarifa
//  real" travada: a pesca de tarifas só olha canal ML.
//
//  A API oficial resolve melhor que no ML. O `v2.payment.get_escrow_detail`
//  é POR PEDIDO e traz de uma vez: commission_fee, service_fee,
//  transaction_fee, actual_shipping_fee, buyer_paid_shipping_fee, vouchers,
//  vat e o escrow_amount (o que de fato cai na conta).
//
//  ⚠️ ESTE ARQUIVO NÃO INTERPRETA NADA AINDA. Ele conecta, autentica e
//  devolve a resposta CRUA. É de propósito: no ML eu errei o formato cinco
//  vezes seguidas por supor a estrutura antes de olhar uma amostra. Aqui a
//  ordem é: conectar → sondar → ver o JPEG cru → só então escrever o parser.
//
//  ENV NECESSÁRIAS (Render → Mover-Pedidos-Aguardando-x-Atendido → Environment):
//    SHOPEE_PARTNER_ID   — App Management → App List, na Shopee Open Platform
//    SHOPEE_PARTNER_KEY  — a Live Key da mesma tela
//    SHOPEE_REDIRECT_URI — https://mover-pedidos-aguardando-x-atendido.onrender.com/girassol-backup-offline/shopee/callback
//    SHOPEE_HOST         — opcional. Padrão https://partner.shopeemobile.com
// ════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch');

const base = require('./base');
const { json, ehAdmin, CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson } = base;

const HOST = (process.env.SHOPEE_HOST || 'https://partner.shopeemobile.com').replace(/\/+$/, '');
const PARTNER_ID = String(process.env.SHOPEE_PARTNER_ID || '').trim();
const PARTNER_KEY = String(process.env.SHOPEE_PARTNER_KEY || '').trim();
const REDIRECT = String(process.env.SHOPEE_REDIRECT_URI || '').trim();
const TOKEN_FILE = () => path.join(CACHE_DIR, '_shopee_token.json');

// base string do sign: partner_id + path + timestamp [+ access_token + shop_id]
// (público = só os três primeiros; shop-level = os cinco). Confere com a doc da
// Open Platform: "concatenate the API path and the common parameters, in order".
function assinar(caminho, ts, token, shopId) {
  const bs = PARTNER_ID + caminho + ts + (token || '') + (shopId || '');
  return crypto.createHmac('sha256', PARTNER_KEY).update(bs).digest('hex');
}

function lerToken() { return readJson(TOKEN_FILE(), null); }
function salvarToken(t) { writeJson(TOKEN_FILE(), t); return t; }

async function trocarCodigo(code, shopId) {
  const caminho = '/api/v2/auth/token/get';
  const ts = Math.floor(Date.now() / 1000);
  const url = HOST + caminho + '?partner_id=' + PARTNER_ID + '&timestamp=' + ts + '&sign=' + assinar(caminho, ts);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(PARTNER_ID) })
  });
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch (e) {}
  if (!d || !d.access_token) return { ok: false, status: r.status, cru: txt.slice(0, 500) };
  return { ok: true, dados: salvarToken({ shop_id: Number(shopId), access_token: d.access_token, refresh_token: d.refresh_token, expire_in: d.expire_in || 14400, obtido_em: Date.now() }) };
}

// access_token vale 4h; refresh_token vale 30 dias. Renova com 30 min de folga.
async function tokenValido() {
  const t = lerToken();
  if (!t || !t.access_token) return { ok: false, erro: 'a loja ainda não foi conectada — abra /shopee/conectar' };
  const idade = (Date.now() - (t.obtido_em || 0)) / 1000;
  if (idade < (t.expire_in || 14400) - 1800) return { ok: true, t };
  const caminho = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const url = HOST + caminho + '?partner_id=' + PARTNER_ID + '&timestamp=' + ts + '&sign=' + assinar(caminho, ts);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: t.refresh_token, shop_id: Number(t.shop_id), partner_id: Number(PARTNER_ID) })
  });
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch (e) {}
  if (!d || !d.access_token) return { ok: false, erro: 'não consegui renovar o token', status: r.status, cru: txt.slice(0, 400) };
  return { ok: true, t: salvarToken(Object.assign({}, t, { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expire_in: d.expire_in || 14400, obtido_em: Date.now() })) };
}

// chamada shop-level genérica. Devolve SEMPRE o cru junto — instrumentação.
async function chamar(caminho, query, metodo, corpo) {
  if (!PARTNER_ID || !PARTNER_KEY) return { ok: false, erro: 'faltam SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY nas env vars' };
  const v = await tokenValido();
  if (!v.ok) return v;
  const ts = Math.floor(Date.now() / 1000);
  const sign = assinar(caminho, ts, v.t.access_token, v.t.shop_id);
  const q = new URLSearchParams(Object.assign({
    partner_id: PARTNER_ID, timestamp: String(ts), access_token: v.t.access_token,
    shop_id: String(v.t.shop_id), sign
  }, query || {}));
  const url = HOST + caminho + '?' + q.toString();
  const opts = { method: metodo || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (corpo) opts.body = JSON.stringify(corpo);
  const r = await fetch(url, opts);
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch (e) {}
  return { ok: r.ok && d && !d.error, status: r.status, dados: d, cru: txt.slice(0, 2000) };
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

    // ── 1. o link que a loja abre pra autorizar o app ──────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/conectar') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      if (!PARTNER_ID || !PARTNER_KEY) { json(res, 500, { ok: false, erro: 'faltam SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY nas env vars do Render' }); return true; }
      if (!REDIRECT) { json(res, 500, { ok: false, erro: 'falta SHOPEE_REDIRECT_URI nas env vars (aponte pro /shopee/callback deste serviço)' }); return true; }
      const caminho = '/api/v2/shop/auth_partner';
      const ts = Math.floor(Date.now() / 1000);
      const url = HOST + caminho + '?partner_id=' + PARTNER_ID + '&timestamp=' + ts +
        '&sign=' + assinar(caminho, ts) + '&redirect=' + encodeURIComponent(REDIRECT);
      json(res, 200, {
        ok: true, abra_este_link: url,
        instrucao: 'abra o link logado na conta da Shopee que é dona da loja, autorize, e a Shopee te devolve pro /shopee/callback já conectado'
      });
      return true;
    }

    // ── 2. a Shopee volta aqui com ?code=&shop_id= ─────────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/callback') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const code = String(q.get('code') || '');
      const shopId = String(q.get('shop_id') || '');
      if (!code || !shopId) { json(res, 400, { ok: false, erro: 'vieram sem code/shop_id — refaça pelo /shopee/conectar', recebido: urlObj.search }); return true; }
      const r = await trocarCodigo(code, shopId);
      if (!r.ok) { json(res, 502, { ok: false, erro: 'a Shopee não devolveu access_token', status: r.status, resposta_crua: r.cru }); return true; }
      json(res, 200, { ok: true, msg: 'loja conectada', shop_id: r.dados.shop_id, validade_horas: Math.round((r.dados.expire_in || 14400) / 3600) });
      return true;
    }

    // ── 3. estado da conexão ───────────────────────────────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/status') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const t = lerToken();
      json(res, 200, {
        ok: true, host: HOST,
        partner_id: PARTNER_ID ? 'configurado' : 'FALTANDO',
        partner_key: PARTNER_KEY ? 'configurado' : 'FALTANDO',
        redirect_uri: REDIRECT || 'FALTANDO',
        conectada: !!(t && t.access_token),
        shop_id: t && t.shop_id,
        token_com_horas: t ? Math.round((Date.now() - (t.obtido_em || 0)) / 36e5 * 10) / 10 : null,
        validade_horas: t ? Math.round((t.expire_in || 14400) / 3600) : null
      });
      return true;
    }

    // ── 4. SONDA: o escrow de um pedido, CRU ───────────────────────────────
    // Sem &pedido=, ele pega sozinho a venda de Shopee mais recente do cache.
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/sonda') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let sn = String(q.get('pedido') || '').trim();
      let veioDe = 'parâmetro';
      if (!sn) {
        const conf = readJson(CONFERIDOS_FILE, {});
        const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
        const cand = linhas.filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
          .sort((a, b) => String(b.conferido_em || b.cacheado_em || '').localeCompare(String(a.conferido_em || a.cacheado_em || '')));
        if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache — passe &pedido=ORDER_SN' }); return true; }
        sn = String(cand[0].numero_loja); veioDe = 'cache dos bipados';
      }
      const r = await chamar('/api/v2/payment/get_escrow_detail', { order_sn: sn }, 'GET');
      json(res, 200, {
        ok: !!r.ok, pedido: sn, de_onde_veio_o_pedido: veioDe,
        erro: r.erro || null, status_http: r.status || null,
        resposta_crua: r.cru || null,
        leia: 'ainda NÃO interpreto nada — é a resposta como a Shopee mandou. Com ela na mão eu escrevo o parser sem chutar formato.'
      });
      return true;
    }

    return false;   // não é rota da Shopee
  };
}

module.exports = { rotasShopee, chamar, tokenValido };
