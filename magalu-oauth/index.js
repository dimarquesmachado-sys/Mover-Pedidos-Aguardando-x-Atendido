'use strict';
// ════════════════════════════════════════════════════════════════════════
//  MAGALU OAUTH — conecta cada empresa à API oficial do Magalu Marketplace
//  e mantém um refresh_token vivo por empresa. (Mover-Pedidos)
//
//  POR QUÊ: o ↗ do Magalu precisa do UUID interno do pacote, que só a API
//  oficial dá. Diferente da Shopee (cookie), o Magalu usa OAuth 2.0 com
//  refresh_token — que NÃO expira sozinho como o cookie. Uma vez conectado,
//  o servidor renova o access_token (2h) pra sempre, sem intervenção.
//
//  FLUXO (uma vez por empresa):
//   1. admin abre  /magalu/conectar?empresa=girassol&k=ADMIN_KEY  (logado na
//      conta Magalu daquela empresa no navegador)
//   2. redireciona pro consentimento do id.magalu.com; o seller aprova
//   3. Magalu volta em /magalu/callback?code=...&state=girassol
//   4. trocamos o code por tokens e gravamos o refresh_token em
//      /data/magalu/<empresa>.json
//
//  DEPOIS: getAccessToken('girassol') devolve um access_token válido, usando
//  o refresh_token do disco e cacheando o access por ~110 min.
//
//  Este módulo NÃO mexe nos outros. É um handler global pendurado na raiz.
// ════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { json, html } = require('../lib/http');

const VERSAO = 'magalu-oauth v1 b3';

const DATA_DIR = process.env.MAGALU_DATA_DIR || '/data/magalu';

// Endpoints do ID Magalu (OAuth) e da API pública.
// A tela de consentimento é /login (NÃO /oauth/authorize — esse devolve JSON
// de pre-authorization em vez de renderizar a tela). choose_tenants=true faz o
// Magalu perguntar QUAL loja autorizar — essencial pra conta que vê várias.
const OAUTH_AUTHORIZE = 'https://id.magalu.com/login';
const OAUTH_TOKEN     = 'https://id.magalu.com/oauth/token';

// Precisa BATER com o --redirect-uris usado na criação do client no idm.
const REDIRECT_URI = process.env.MAGALU_REDIRECT_URI
  || 'https://mover-pedidos-aguardando-x-atendido.onrender.com/magalu/callback';

// Escopos que o client foi criado com (leitura de pedidos e afins).
const SCOPES = (process.env.MAGALU_SCOPES
  || 'open:order-order-seller:read open:order-delivery-seller:read open:order-invoice-seller:read open:order-logistics-seller:read'
).trim();

const EMPRESAS_VALIDAS = ['girassol', 'good', 'amb'];

// ── util de disco ────────────────────────────────────────────────────
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function lerJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function gravarJson(p, o) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function arqEmpresa(emp) { return path.join(DATA_DIR, emp + '.json'); }

function creds() {
  return {
    id:     String(process.env.MAGALU_CLIENT_ID || '').trim(),
    secret: String(process.env.MAGALU_CLIENT_SECRET || '').trim(),
    uuid:   String(process.env.MAGALU_CLIENT_UUID || '').trim()   // só p/ gerenciar o client na CLI (add-scope/update)
  };
}

// ── troca de code/refresh por tokens ─────────────────────────────────
// authorization_code: a doc do Magalu usa Content-Type application/json.
// refresh_token: a doc usa application/x-www-form-urlencoded.
// Mandamos cada um no formato que a doc especifica.
async function trocarToken(params) {
  const { id, secret } = creds();
  const ehCode = params.grant_type === 'authorization_code';
  let headers, body;
  if (ehCode) {
    headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    body = JSON.stringify(Object.assign({ client_id: id, client_secret: secret }, params));
  } else {
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
    body = new URLSearchParams(Object.assign({ client_id: id, client_secret: secret }, params)).toString();
  }
  const r = await fetch(OAUTH_TOKEN, { method: 'POST', headers, body });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j, corpo: txt.slice(0, 500) };
}

// Devolve um access_token válido pra empresa, renovando via refresh_token se preciso.
// Guarda o access em cache no próprio arquivo da empresa (com validade).
async function getAccessToken(emp) {
  const arq = arqEmpresa(emp);
  const st = lerJson(arq, null);
  if (!st || !st.refresh_token) throw new Error('empresa ' + emp + ' não conectada (sem refresh_token)');

  const agora = Date.now();
  if (st.access_token && st.access_exp && agora < st.access_exp - 60000) {
    return st.access_token; // cache ainda válido (margem de 1 min)
  }

  const res = await trocarToken({ grant_type: 'refresh_token', refresh_token: st.refresh_token });
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error('falha ao renovar token de ' + emp + ': HTTP ' + res.status + ' ' + res.corpo);
  }
  const j = res.json;
  st.access_token = j.access_token;
  st.access_exp   = agora + (Number(j.expires_in || 7200) * 1000);
  if (j.refresh_token) st.refresh_token = j.refresh_token; // refresh rotativo, se vier
  st.atualizado = new Date().toISOString();
  gravarJson(arq, st);
  return st.access_token;
}

// ── rotas ────────────────────────────────────────────────────────────
// São chamadas pelo handler global só quando o path começa com /magalu/.
async function tratar(req, res, urlObj) {
  const { method } = req;
  const p = urlObj.pathname;
  const q = urlObj.searchParams;

  // /magalu/conectar?empresa=girassol  → manda o admin pro consentimento
  if (method === 'GET' && p === '/magalu/conectar') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) {
      json(res, 400, { ok: false, erro: 'empresa inválida', validas: EMPRESAS_VALIDAS });
      return true;
    }
    const { id, secret } = creds();
    if (!id || !secret) {
      json(res, 500, { ok: false, erro: 'faltam env MAGALU_CLIENT_ID / MAGALU_CLIENT_SECRET no Render' });
      return true;
    }
    const auth = OAUTH_AUTHORIZE
      + '?response_type=code'
      + '&client_id=' + encodeURIComponent(id)
      + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
      + '&scope=' + encodeURIComponent(SCOPES)
      + '&choose_tenants=true'   // deixa o seller escolher QUAL loja está autorizando
      + '&state=' + encodeURIComponent(emp);
    res.writeHead(302, { Location: auth, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  // /magalu/callback?code=...&state=girassol  → troca o code por tokens
  if (method === 'GET' && p === '/magalu/callback') {
    const code = String(q.get('code') || '').trim();
    const emp  = String(q.get('state') || '').toLowerCase().trim();
    const erroOAuth = q.get('error');

    if (erroOAuth) {
      html(res, 400, paginaSimples('Consentimento negado', 'O Magalu retornou: ' + esc(erroOAuth) + '. Tente de novo em /magalu/conectar?empresa=' + esc(emp)));
      return true;
    }
    if (!code || !EMPRESAS_VALIDAS.includes(emp)) {
      html(res, 400, paginaSimples('Callback inválido', 'Faltou code ou state válido. Recomece por /magalu/conectar?empresa=girassol'));
      return true;
    }

    const res2 = await trocarToken({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    });
    if (!res2.ok || !res2.json || !res2.json.refresh_token) {
      html(res, 502, paginaSimples('Falha ao obter token',
        'HTTP ' + res2.status + '<br><pre style="white-space:pre-wrap">' + esc(res2.corpo) + '</pre>'));
      return true;
    }
    const j = res2.json;
    gravarJson(arqEmpresa(emp), {
      empresa: emp,
      refresh_token: j.refresh_token,
      access_token: j.access_token || null,
      access_exp: j.access_token ? (Date.now() + Number(j.expires_in || 7200) * 1000) : 0,
      escopo: j.scope || SCOPES,
      conectado_em: new Date().toISOString(),
      atualizado: new Date().toISOString()
    });
    html(res, 200, paginaSimples('✅ ' + emp.toUpperCase() + ' conectada',
      'Refresh token guardado. Essa empresa não precisa mais consentir.<br><br>'
      + 'Confira em <a href="/magalu/status?k=' + esc(q.get('k') || '') + '">/magalu/status</a> '
      + '(precisa da ADMIN_KEY).'));
    return true;
  }

  // /magalu/status  → o que já está conectado (admin)
  if (method === 'GET' && p === '/magalu/status') {
    const out = {};
    for (const emp of EMPRESAS_VALIDAS) {
      const st = lerJson(arqEmpresa(emp), null);
      out[emp] = st
        ? { conectado: true, conectado_em: st.conectado_em || null, atualizado: st.atualizado || null,
            tem_refresh: !!st.refresh_token, escopo: st.escopo || null }
        : { conectado: false };
    }
    const c = creds();
    const mask = s => !s ? null : (s.length <= 8 ? '…' : s.slice(0, 4) + '…' + s.slice(-4));
    json(res, 200, { ok: true, versao: VERSAO, client_configurado: !!(c.id && c.secret),
      client_uuid: mask(c.uuid), redirect_uri: REDIRECT_URI, escopos: SCOPES, empresas: out });
    return true;
  }

  // /magalu/teste?empresa=girassol  → tira um access token a limpo (admin), sem chamar a API de pedidos ainda
  if (method === 'GET' && p === '/magalu/teste') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    try {
      const tok = await getAccessToken(emp);
      json(res, 200, { ok: true, empresa: emp, access_token_len: tok.length,
        preview: tok.slice(0, 12) + '…', versao: VERSAO });
    } catch (e) {
      json(res, 502, { ok: false, empresa: emp, erro: String(e.message || e) });
    }
    return true;
  }

  // /magalu/sonda?empresa=girassol[&n=NUMERO_DO_PEDIDO]  → exploração (admin).
  // Descobre o tenant_id da empresa e busca pedidos, mostrando os campos crus
  // que a API devolve — pra achar onde vem o UUID do pacote antes de montar o ↗.
  if (method === 'GET' && p === '/magalu/sonda') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const numero = String(q.get('n') || '').trim();
    const passos = [];
    const API = 'https://api.magalu.com';

    async function chamar(nome, url, headers) {
      try {
        const r = await fetch(url, { headers });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        passos.push({ passo: nome, url, status: r.status, corpo: j ? undefined : t.slice(0, 400),
          amostra: j ? podar(j) : undefined });
        return { r, j, t };
      } catch (e) {
        passos.push({ passo: nome, url, erro: String(e.message || e).slice(0, 200) });
        return {};
      }
    }
    // encurta objetos grandes pra caber na resposta: mostra chaves e um pouco de cada
    function podar(o, prof) {
      prof = prof || 0;
      if (Array.isArray(o)) return { _array: o.length, _amostra: o.slice(0, 2).map(x => podar(x, prof + 1)) };
      if (o && typeof o === 'object') {
        if (prof > 3) return { _chaves: Object.keys(o) };
        const out = {};
        for (const k of Object.keys(o).slice(0, 40)) out[k] = podar(o[k], prof + 1);
        return out;
      }
      if (typeof o === 'string' && o.length > 120) return o.slice(0, 120) + '…';
      return o;
    }

    try {
      const tok = await getAccessToken(emp);
      const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };

      // 1) quem sou eu / tenants — pra achar o tenant_id do seller
      const who = await chamar('whoami/tenants', API + '/account/v1/whoami/tenants', H);
      let tenant = '';
      try {
        const arr = Array.isArray(who.j) ? who.j : (who.j && (who.j.tenants || who.j.results || who.j.data));
        const sel = (arr || []).find(t => /seller/i.test(JSON.stringify(t))) || (arr || [])[0];
        tenant = sel && (sel.uuid || sel.id || sel.tenant_id) || '';
        passos.push({ passo: 'tenant_escolhido', tenant_id: tenant || '(não achei)' });
      } catch (e) { passos.push({ passo: 'tenant_escolhido', erro: String(e.message) }); }

      const HT = tenant ? Object.assign({ 'X-Tenant-Id': tenant }, H) : H;

      // 2) listar pedidos (poucos) — ver a estrutura e onde está o UUID do pacote
      await chamar('orders (lista)', API + '/maestro/v1/orders?_limit=2', HT);

      // 3) se passou um número, tentar achar por ele
      if (numero) {
        await chamar('orders?q=numero', API + '/maestro/v1/orders?_limit=5&q=' + encodeURIComponent(numero), HT);
      }
    } catch (e) {
      passos.push({ passo: 'ERRO', erro: String(e.message || e) });
    }

    json(res, 200, { ok: true, empresa: emp, versao: VERSAO, passos });
    return true;
  }

  return false; // não é rota nossa
}

// ── páginas simples ──────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function paginaSimples(titulo, corpoHtml) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(titulo) + '</title>'
    + '<div style="max-width:640px;margin:40px auto;font:16px/1.5 system-ui,sans-serif;padding:0 16px">'
    + '<h2>' + esc(titulo) + '</h2><p>' + corpoHtml + '</p></div>';
}

module.exports = { tratar, getAccessToken, VERSAO, EMPRESAS_VALIDAS };
