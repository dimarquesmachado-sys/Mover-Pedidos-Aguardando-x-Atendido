'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  SUPABASE — acesso ao histórico de vendas, código único (22/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Estava duplicado em amb-checkout-offline/index.js e girassol-backup-offline/gbo-app.js.
//  supaReq e supaCount eram BYTE-A-BYTE idênticas; a supaCfg só mudava no padrão
//  ('amb' × 'girassol'), então esse padrão virou parâmetro.
//
//  As envs continuam por empresa e com o mesmo nome de sempre:
//     SUPABASE_URL_VENDAS_<EMPRESA>  ·  SUPABASE_KEY_VENDAS_<EMPRESA>
//  (AMB, GIRASSOL, GOOD… — a empresa entra em MAIÚSCULA no nome da variável)
//
//  Uso: const supa = require('../lib/supabase').para('amb');
//       await supa.req('GET', 'vendas_historico?...');

function cfg(empresa, padrao) {
  const E = String(empresa || padrao || '').toUpperCase();
  return { url: process.env['SUPABASE_URL_VENDAS_' + E], key: process.env['SUPABASE_KEY_VENDAS_' + E] };
}

async function req(empresa, padrao, metodo, pathQuery, body) {
  const { url, key } = cfg(empresa, padrao);
  const E = String(empresa || padrao || '').toUpperCase();
  if (!url || !key) return { ok: false, status: 0, erro: 'faltam SUPABASE_URL_VENDAS_' + E + ' / SUPABASE_KEY_VENDAS_' + E };
  const h = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
  if (metodo === 'POST') h['Prefer'] = 'return=minimal';
  // 18/08 (Codex #123): no PATCH precisamos SABER se alguma linha foi afetada — PATCH que casa
  // zero linhas volta 200 do mesmo jeito. Com representation o corpo traz as linhas mexidas.
  if (metodo === 'PATCH') h['Prefer'] = 'return=representation';
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/' + pathQuery, { method: metodo, headers: h, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: txt };
  } catch (e) { return { ok: false, status: 0, erro: String(e.message || e) }; }
}

async function count(empresa, padrao, filtro) {
  const { url, key } = cfg(empresa, padrao);
  if (!url || !key) return null;
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + (filtro ? ('&' + filtro) : '') + '&select=id',
      { method: 'HEAD', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Prefer': 'count=exact', 'Range': '0-0' } });
    const cr = (r.headers.get('content-range') || '').split('/')[1];
    return cr != null ? Number(cr) : null;
  } catch (e) { return null; }
}

/* Devolve as 3 funções já amarradas ao padrão da empresa, pra chamada continuar
   idêntica à de antes (supaReq('amb','GET',…) segue valendo, e supaReq(null,…)
   também — cai no padrão de quem montou). */
function para(padrao) {
  return {
    cfg:   (empresa)                       => cfg(empresa, padrao),
    req:   (empresa, metodo, pathQuery, b) => req(empresa, padrao, metodo, pathQuery, b),
    count: (empresa, filtro)               => count(empresa, padrao, filtro)
  };
}

module.exports = { para, cfg, req, count };
