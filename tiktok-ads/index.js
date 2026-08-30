'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  TIKTOK ADS (API for Business) — conexão e sonda (18/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  POR QUE UM MÓDULO SEPARADO: o app do TikTok SHOP (6jj99q5hog1do) NÃO dá acesso a
//  anúncios — confirmado na documentação: dado de loja/pedido/finanças/devolução vem do
//  Partner API v2 (partner.tiktokshop.com), e gasto com anúncio vem da **API for Business**
//  (business-api.tiktok.com), que é outro portal, outro app e outra autorização. Não é
//  questão de marcar mais uma permissão no app que já existe.
//
//  ESTADO: o Diego ainda não criou o app no TikTok for Business. Este módulo já fica pronto
//  — quando ele criar e colar as duas variáveis, conecta e sonda. Enquanto isso, o /status
//  diz exatamente o que falta, em vez de dar erro obscuro.
//
//  MULTI-EMPRESA desde o nascimento (regra do Diego): token POR LOJA, `&loja=` em todas as
//  rotas, lista vinda de TIKTOK_LOJAS — igual ao tiktok-oauth do Shop.
//
//  ENV: TIKTOK_ADS_APP_ID · TIKTOK_ADS_SECRET · (opcional) TIKTOK_ADS_REDIRECT
const path = require('path');
const fs = require('fs');

const APP_ID = process.env.TIKTOK_ADS_APP_ID || '';
const SECRET = process.env.TIKTOK_ADS_SECRET || '';
const REDIRECT = process.env.TIKTOK_ADS_REDIRECT || '';
const BASE = process.env.TIKTOK_ADS_BASE || 'https://business-api.tiktok.com';
const LOJAS = String(process.env.TIKTOK_LOJAS || require('../lib/empresas').lista().join(','))   /* Codex #307: mesma lista do resto */
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LOJA_PADRAO = LOJAS[0] || 'girassol';
const lojaDe = q => {
  const l = String((q && q.get && q.get('loja')) || '').trim().toLowerCase();
  return LOJAS.indexOf(l) >= 0 ? l : LOJA_PADRAO;
};
const ARQ = loja => path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_ads_token_' + (loja || LOJA_PADRAO) + '.json');
function lerToken(loja) { try { return JSON.parse(fs.readFileSync(ARQ(loja), 'utf8')); } catch (e) { return null; } }
function salvarToken(loja, t) {
  try { fs.mkdirSync(path.dirname(ARQ(loja)), { recursive: true }); } catch (e) {}
  fs.writeFileSync(ARQ(loja), JSON.stringify(t, null, 2));
}

// A API for Business autentica por header, não por assinatura HMAC como o Shop.
async function chamar(caminho, params, loja) {
  const t = lerToken(loja);
  const qs = Object.keys(params || {}).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const r = await fetch(BASE + caminho + (qs ? '?' + qs : ''), {
    headers: { 'Access-Token': (t && t.access_token) || '', 'Content-Type': 'application/json' }
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { http: r.status, ok: r.ok, corpo: j, cru: j ? null : txt.slice(0, 600) };
}

async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;
  const q = urlObj.searchParams;
  const ADM = process.env.ADMIN_KEY || '';
  const admOk = () => ADM && q.get('k') === ADM;

  if (p === '/tiktok-ads/status') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const porLoja = {};
    for (const l of LOJAS) {
      const t = lerToken(l);
      porLoja[l] = { conectada: !!(t && t.access_token), anunciantes: (t && t.advertiser_ids) || null };
    }
    json(res, 200, {
      ok: true,
      pronto_para_conectar: !!(APP_ID && SECRET),
      falta_env: [!APP_ID && 'TIKTOK_ADS_APP_ID', !SECRET && 'TIKTOK_ADS_SECRET'].filter(Boolean),
      por_loja: porLoja, lojas: LOJAS,
      leia: !APP_ID || !SECRET
        ? 'Falta criar o app em business-api.tiktok.com/portal (TikTok for Business — é OUTRO portal, não o Partner Center do Shop). Depois cole TIKTOK_ADS_APP_ID e TIKTOK_ADS_SECRET no Render e volte aqui.'
        : 'Conecte cada loja em /tiktok-ads/conectar?loja=…&k=… e depois sonde o gasto com /tiktok-ads/sonda?caminho=…'
    });
    return true;
  }

  if (p === '/tiktok-ads/conectar') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    if (!APP_ID) { json(res, 400, { ok: false, erro: 'falta TIKTOK_ADS_APP_ID — crie o app em business-api.tiktok.com/portal' }); return true; }
    const loja = lojaDe(q);
    const url = 'https://business-api.tiktok.com/portal/auth?app_id=' + encodeURIComponent(APP_ID) +
                '&state=' + encodeURIComponent(loja) + (REDIRECT ? '&redirect_uri=' + encodeURIComponent(REDIRECT) : '');
    if (q.get('ir') === '1') { res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' }); res.end(); return true; }
    json(res, 200, { ok: true, loja, url, leia: 'abra logado na conta de anúncios dessa empresa; ao autorizar, o TikTok volta com ?auth_code=… — cole em /tiktok-ads/trocar-code?loja=' + loja + '&code=…&k=' });
    return true;
  }

  if (p === '/tiktok-ads/callback' || p === '/tiktok-ads/trocar-code') {
    const loja = (p === '/tiktok-ads/callback')
      ? (LOJAS.indexOf(String(q.get('state') || '').trim().toLowerCase()) >= 0 ? String(q.get('state')).trim().toLowerCase() : lojaDe(q))
      : lojaDe(q);
    if (p === '/tiktok-ads/trocar-code' && !admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const code = String(q.get('auth_code') || q.get('code') || '').trim();
    if (!code) { json(res, 400, { ok: false, erro: 'sem ?code=' }); return true; }
    try {
      const r = await fetch(BASE + '/open_api/v1.3/oauth2/access_token/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: APP_ID, secret: SECRET, auth_code: code })
      });
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || null;
      if (!d || !d.access_token) { json(res, 502, { ok: false, erro: 'o TikTok não devolveu token', resposta: j }); return true; }
      salvarToken(loja, {
        access_token: d.access_token,
        advertiser_ids: d.advertiser_ids || (d.advertiser_id ? [d.advertiser_id] : null),
        escopo: d.scope || null, obtido_em: new Date().toISOString()
      });
      json(res, 200, { ok: true, loja, anunciantes: d.advertiser_ids || null, msg: '✅ TikTok Ads conectado para ' + loja });
    } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
    return true;
  }

  // SONDA — mesma disciplina do Shop: ver o retorno CRU antes de escrever qualquer parser
  if (p === '/tiktok-ads/sonda') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    if (!lerToken(loja)) { json(res, 400, { ok: false, erro: 'loja ' + loja + ' ainda não conectada no TikTok Ads' }); return true; }
    const caminho = String(q.get('caminho') || '/open_api/v1.3/report/integrated/get/').trim();
    if (!/^\/[a-z0-9_\-\/\.]+$/i.test(caminho)) { json(res, 400, { ok: false, erro: 'caminho inválido' }); return true; }
    const extras = {};
    for (const [k, v] of q.entries()) { if (['k', 'caminho', 'loja'].indexOf(k) < 0) extras[k] = v; }
    const r = await chamar(caminho, extras, loja);
    json(res, 200, { ok: r.ok, http: r.http, loja, caminho, params: extras, resposta_crua: r.corpo || r.cru,
      leia: 'resposta CRUA — nada interpretado. O gasto costuma sair do relatório integrado (report/integrated/get) com métrica de spend por dia.' });
    return true;
  }

  return false;
}

module.exports = { tratar, chamar, lerToken, LOJAS };
