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

const VERSAO = 'magalu-oauth v1 b17';

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
  || 'open:order-order-seller:read open:order-delivery-seller:read open:order-delivery-seller:write open:order-invoice-seller:read open:order-logistics-seller:read open:order-logistics-seller:write open:order-financial-report-seller:read open:portfolio-prices-seller:read open:portfolio-prices-seller:write open:portfolio-skus-seller:read open:portfolio-skus-seller:write open:portfolio-stocks-seller:read open:portfolio-stocks-seller:write open:logistic-carrier-shippings:read'
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
      + '&prompt=consent'   // FORÇA a tela de permissões mesmo se já consentiu antes — necessário pra puxar ESCOPOS NOVOS no refresh token (senão a Magalu pula a tela e o token sai com os escopos antigos)
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

  // /magalu/sonda?empresa=girassol[&code=NUMERO_LU]  → exploração (admin).
  // Achamos o endpoint: GET api.magalu.com/seller/v1/orders (200). O pedido traz
  // id (uuid do pedido), code (número LU visível) e deliveries[] (onde deve estar
  // o uuid do pacote que falta na URL /pedidos/<code>/<uuid>). Esta sonda pega 1
  // pedido (ou busca por code) e mostra TODOS os uuids candidatos, expandidos.
  if (method === 'GET' && p === '/magalu/sonda') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE = 'https://api.magalu.com/seller/v1/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // extrai todos os pares (caminho → uuid) de um objeto, pra achar qual uuid é o do pacote
    function uuids(o, base, acc) {
      acc = acc || {};
      base = base || '';
      const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const v = o[k];
          const cam = base ? base + '.' + k : k;
          if (typeof v === 'string' && RE.test(v)) acc[cam] = v;
          else if (v && typeof v === 'object') uuids(v, cam, acc);
        }
      }
      return acc;
    }

    try {
      let url = BASE + '?_limit=' + (code ? '10' : '1') + (code ? ('&code=' + encodeURIComponent(code)) : '');
      let out = await pega(url);
      // se busca por code não achou nada, tenta sem filtro e casa pelo campo code no cliente
      let lista = out.j && (out.j.results || out.j.data || (Array.isArray(out.j) ? out.j : []));
      if (code && (!lista || !lista.length)) {
        const alt = await pega(BASE + '?_limit=50');
        const arr = alt.j && (alt.j.results || alt.j.data || []);
        lista = (arr || []).filter(x => String(x.code || '') === code);
        out = { status: alt.status, via: 'filtro-cliente' };
      }

      const pedido = (lista && lista[0]) || null;
      if (!pedido) {
        json(res, 200, { ok: true, empresa: emp, versao: VERSAO, status: out.status,
          nota: code ? 'não achei pedido com esse code' : 'lista vazia',
          amostra_bruta: out.j ? JSON.stringify(out.j).slice(0, 400) : (out.t || '').slice(0, 400) });
        return true;
      }

      json(res, 200, {
        ok: true, empresa: emp, versao: VERSAO,
        pedido_code: pedido.code || null,
        pedido_id: pedido.id || null,
        status_pedido: pedido.status || null,
        deliveries_qtd: Array.isArray(pedido.deliveries) ? pedido.deliveries.length : 0,
        TODOS_OS_UUIDS: uuids(pedido),
        estrutura_deliveries: Array.isArray(pedido.deliveries)
          ? pedido.deliveries.map(d => ({ chaves: Object.keys(d), id: d.id || null,
              code: d.code || null, packages: d.packages ? 'sim' : 'não' }))
          : null
      });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e) });
    }
    return true;
  }

  // /magalu/valores?empresa=girassol[&code=NUMERO][&status=canceled]  → (admin)
  // Raio-X de VALORES pra montar a margem real: despeja amounts INTEIRO (comissão,
  // frete, taxa, desconto), a lista de invoices, e caça QUALQUER campo com "return"
  // /"devol"/"refund"/"reverse" no pedido (frete de retorno é o que o Diego mais quer).
  // Sem &code pega o pedido mais recente; &status filtra (ex.: canceled/returned)
  // pra tentar achar um pedido COM devolução e ver como ela aparece.
  if (method === 'GET' && p === '/magalu/valores') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();
    const status = String(q.get('status') || '').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE = 'https://api.magalu.com/seller/v1/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // acha TODOS os caminhos cujo nome sugere devolução/estorno/frete-de-volta
    function achaDevolucao(o, base, acc) {
      acc = acc || {}; base = base || '';
      const RE = /return|devol|refund|reverse|estorn|logistic.*reverse|reverse.*logistic/i;
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const cam = base ? base + '.' + k : k;
          if (RE.test(k)) acc[cam] = (o[k] && typeof o[k] === 'object') ? '(objeto: ' + Object.keys(o[k]).join(',') + ')' : o[k];
          if (o[k] && typeof o[k] === 'object') achaDevolucao(o[k], cam, acc);
        }
      }
      return acc;
    }

    try {
      // 1) achar o pedido certo. Se for por code, a API às vezes ignora o &code=
      //    (pedido antigo fora da janela default), então paginamos fundo procurando.
      let pedido = null;
      let paginasVarridas = 0;
      // &status= opcional pra mirar a categoria certa (ex.: cancelled — a API pagina
      // "normais" por padrão e um cancelado pode não vir; então filtramos por status).
      const desde = String(q.get('desde') || '').trim();
      const statusFiltro = String(q.get('status') || '').trim();
      const filtroData = desde ? ('&purchased_at_from=' + encodeURIComponent(desde + 'T00:00:00Z')) : '';
      const filtroStatus = statusFiltro ? ('&status=' + encodeURIComponent(statusFiltro)) : '';
      if (code) {
        // varre em VÁRIOS status conhecidos, porque a listagem default pode omitir cancelados
        const statusParaVarrer = statusFiltro ? [statusFiltro] : ['', 'cancelled', 'canceled', 'delivered', 'finished'];
        for (const st of statusParaVarrer) {
          if (pedido) break;
          const fs = st ? ('&status=' + encodeURIComponent(st)) : '';
          let offset = 0;
          while (offset < 600 && !pedido) {  // 600 por status (12 páginas)
            const r = await pega(BASE + '?_limit=50&_offset=' + offset + filtroData + fs);
            const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
            if (!arr.length) break;
            pedido = arr.find(x => String(x.code || '') === code) || null;
            paginasVarridas++;
            offset += 50;
          }
        }
        if (!pedido) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'não achei o code=' + code + ' varrendo ' + paginasVarridas + ' páginas em vários status. A API pode paginar diferente do portal. Tente &status=cancelled explícito, ou me diga a POSIÇÃO do pedido na lista do portal.' });
          return true;
        }
      } else {
        // sem code: usa status (se veio) ou o mais recente
        let url = BASE + '?_limit=' + (status ? '20' : '1');
        if (status) url += '&status=' + encodeURIComponent(status);
        const out = await pega(url);
        const lista = out.j && (out.j.results || out.j.data || (Array.isArray(out.j) ? out.j : [])) || [];
        pedido = lista[0] || null;
        if (!pedido) {
          json(res, 200, { ok: true, empresa: emp, versao: VERSAO, status_http: out.status,
            nota: 'nenhum pedido' + (status ? ' com status=' + status : ''),
            bruto: out.j ? JSON.stringify(out.j).slice(0, 500) : (out.t || '').slice(0, 500) });
          return true;
        }
      }

      const d0 = Array.isArray(pedido.deliveries) && pedido.deliveries[0] ? pedido.deliveries[0] : {};

      // se pediram para cavar mais fundo (&fundo=1), busca eventos/shipping/logística/RETURNS
      let extra = null;
      if (q.get('fundo') === '1') {
        extra = { pedido_id: pedido.id, delivery_id: d0.id };
        // eventos da delivery (histórico de status — cancelamento/devolução costuma vir aqui)
        extra.eventos = d0.events || null;
        // shipping da delivery (frete, transportadora, custo)
        extra.shipping = d0.shipping || null;
        // os external_id das devoluções deste pedido (o custo do frete reverso mora atrás deles)
        const rets = (d0.returns || pedido.returns || []);
        extra.returns_ids = rets.map(r => r.external_id || r.id).filter(Boolean);
        const oid = pedido.id, did = d0.id;
        const retId = extra.returns_ids[0] || null;
        // candidatos de endpoint — inclui os de RETURNS pelo external_id (onde deve estar o frete reverso)
        const tentativas = [
          'https://api.magalu.com/seller/v1/orders/' + oid,
          'https://api.magalu.com/seller/v1/orders/' + oid + '/deliveries/' + did,
          'https://api.magalu.com/seller/v1/orders/' + oid + '/returns',
          'https://api.magalu.com/seller/v1/orders/' + oid + '/deliveries/' + did + '/returns'
        ];
        if (retId) {
          tentativas.push('https://api.magalu.com/seller/v1/returns/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/orders/' + oid + '/returns/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/reverse-logistics/' + retId);
          tentativas.push('https://api.magalu.com/seller/v1/returns?_limit=5&order_id=' + oid);
        }
        extra.endpoints = {};
        for (const u of tentativas) {
          try {
            const rr = await pega(u);
            extra.endpoints[u.replace('https://api.magalu.com', '')] = {
              status: rr.status,
              // se respondeu 200, mostra a estrutura INTEIRA (é aqui que pode estar o frete reverso)
              corpo: rr.status === 200 ? rr.j : (rr.j ? JSON.stringify(rr.j).slice(0, 150) : undefined)
            };
          } catch (e) { extra.endpoints[u.replace('https://api.magalu.com', '')] = { erro: String(e.message).slice(0, 100) }; }
        }
      }

      json(res, 200, {
        ok: true, empresa: emp, versao: VERSAO,
        pedido_code: pedido.code || null,
        status_pedido: pedido.status || null,
        // AMOUNTS inteiro do pedido (comissão, frete, taxa, desconto) — sem podar
        amounts_pedido: pedido.amounts || null,
        // a delivery também tem amounts próprios (por pacote)
        amounts_delivery0: d0.amounts || null,
        delivery0_chaves: Object.keys(d0),
        delivery0_status: d0.status || null,
        // invoices (nota) — pode ter valor/imposto oficial
        invoices: (d0.invoices || pedido.invoices || null),
        // returns/devolução se existir no corpo
        returns_delivery0: d0.returns || null,
        // varredura por qualquer campo de devolução/estorno/retorno no pedido inteiro
        CAMPOS_DEVOLUCAO: achaDevolucao(pedido),
        // chaves de topo do pedido, pra ver o que mais existe
        chaves_topo: Object.keys(pedido),
        // cavação profunda (só com &fundo=1)
        EXTRA: extra
      });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e) });
    }
    return true;
  }

  // /magalu/financeiro?empresa=good[&code=NUMERO][&external_id=UUID]  → (admin)
  // Consulta a API de ANÁLISE FINANCEIRA (DRE) — a fonte oficial dos valores reais:
  // comissão, tarifa, MDR, frete real, e principalmente DEVOLUÇÃO (REFUND) + frete de
  // retorno. Só retorna pedidos Entregue/Cancelado a partir de 05/05/2026. Precisa do
  // escopo open:order-financial-report-seller:read (já autorizado nas 3 empresas).
  // Descobre o endpoint certo testando candidatos e mostra as transações cruas.
  if (method === 'GET' && p === '/magalu/financeiro') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const code = String(q.get('code') || '').trim();
    const extId = String(q.get('external_id') || '').trim();
    const desde = String(q.get('desde') || '2026-05-05').trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // candidatos de base da API financeira (o path exato não está 100% claro na doc)
    const BASE_FIN = 'https://api.magalu.com/seller/v1/financial-analysis/orders';
    // A API exige order_id OU par de datas purchased_at__gte/__lte, e a janela
    // não pode passar de 15 DIAS. Então varremos em janelas de 15 dias, do 'ate'
    // pra trás até o 'desde', procurando o pedido pelo order_code.
    const ateFull = String(q.get('ate') || '').trim() || new Date().toISOString().slice(0, 10);
    const desdeFull = desde;  // default 2026-05-05
    const MS_DIA = 86400000;
    const d0 = new Date(desdeFull + 'T00:00:00Z').getTime();
    const dN = new Date(ateFull + 'T23:59:59Z').getTime();

    let alvo = null, comoAchou = '', amostra = null;
    let janelasVarridas = 0, paginasTotal = 0;
    // do fim pro começo, blocos de 15 dias
    let fimBloco = dN;
    while (fimBloco > d0 && !alvo && janelasVarridas < 12) {  // até 12 janelas (180 dias)
      const iniBloco = Math.max(d0, fimBloco - 15 * MS_DIA);
      const gte = new Date(iniBloco).toISOString();
      const lte = new Date(fimBloco).toISOString();
      const JANELA = 'purchased_at__gte=' + encodeURIComponent(gte) + '&purchased_at__lte=' + encodeURIComponent(lte);
      janelasVarridas++;

      let offset = 0;
      while (offset < 500 && !alvo) {
        const r = await pega(BASE_FIN + '?' + JANELA + '&_limit=50&_offset=' + offset);
        if (r.status !== 200) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'a janela de datas retornou ' + r.status + ' — veja o corpo',
            janela: JANELA, corpo: r.j || (r.t || '').slice(0, 400) });
          return true;
        }
        const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
        if (!amostra && arr.length) amostra = arr[0];
        paginasTotal++;
        if (!arr.length) break;
        if (code) {
          alvo = arr.find(o => {
            const oc = (o.extras && o.extras.order_code) || o.order_code || o.external_id || '';
            return String(oc) === code;
          }) || null;
          if (alvo) comoAchou = 'janela ' + gte.slice(0, 10) + '→' + lte.slice(0, 10);
        } else {
          alvo = arr[0]; comoAchou = 'primeiro da janela mais recente';
        }
        offset += 50;
      }
      fimBloco = iniBloco - 1000;  // próximo bloco, 15 dias antes
    }

    if (!alvo) {
      json(res, 200, { ok: true, empresa: emp, versao: VERSAO, endpoint: '/seller/v1/financial-analysis/orders',
        nota: 'API financeira OK (200), mas não achei o pedido' + (code ? ' code=' + code : '') + ' em ' + janelasVarridas + ' janelas de 15 dias (' + desdeFull + ' a ' + ateFull + ')',
        paginas: paginasTotal,
        estrutura_de_um_pedido: amostra ? Object.keys(amostra) : 'janelas vazias',
        amostra_extras: amostra && amostra.extras ? amostra.extras : null });
      return true;
    }

    // resume as transações destacando REFUND (devolução) e SHIPPING_COST (frete)
    const txs = alvo.transactions || [];
    const resumo = txs.map(t => ({
      categoria: t.category, sub: t.subcategory, tipo: t.type,
      valor: (t.value != null && t.normalizer) ? (t.value / t.normalizer) : t.value,
      desc: t.description
    }));
    const devolucao = resumo.filter(r => r.categoria === 'REFUND' || /refund|penalt/i.test(String(r.sub || '')));
    const frete = resumo.filter(r => r.categoria === 'SHIPPING_COST');
    const saldo = txs.reduce((acc, t) => {
      if (t.type === 'CREDIT') return acc + (t.value / (t.normalizer || 100));
      if (t.type === 'DEBIT') return acc - (t.value / (t.normalizer || 100));
      return acc;
    }, 0);

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      base: baseOk.replace('https://api.magalu.com', ''), como_achou: comoAchou,
      order_code: (alvo.extras && alvo.extras.order_code) || alvo.order_code || null,
      external_id: alvo.external_id || null,
      DEVOLUCAO: devolucao.length ? devolucao : 'nenhuma transação REFUND neste pedido',
      FRETE: frete.length ? frete : 'nenhuma transação SHIPPING_COST',
      saldo_liquido: Math.round(saldo * 100) / 100,
      TODAS_TRANSACOES: resumo
    });
    return true;
  }

  // ── IR PRO PEDIDO NO PORTAL DO MAGALU ────────────────────────────────
  // O ↗ do Magalu apontava pra /pedidos/<numero>, que dá 404 — a URL que abre
  // exige o UUID do PACOTE: /pedidos/<numero>/<uuid>. Esse uuid é deliveries[0].id
  // (confirmado: deliveries[0].code = "LU-<numero>-1", o "Pacote #...-1" do portal).
  // Buscamos o pedido pela API oficial (seller/v1/orders?code=<numero>), pegamos o
  // uuid do pacote, guardamos em disco (nunca muda) e redirecionamos. O token
  // renova sozinho, então não tem manutenção. &diag=1 mostra o passo a passo.
  // empresa vem no path: /magalu/ir/<empresa>?n=<numero>
  if (method === 'GET' && p.startsWith('/magalu/ir/')) {
    const emp = p.slice('/magalu/ir/'.length).toLowerCase().trim();
    const numero = String(q.get('n') || '').replace(/\D/g, '').trim();  // só dígitos (tira o "LU-")
    const diag = q.get('diag') === '1';
    const portalBusca = 'https://seller.magalu.com/pedidos';  // fallback: lista de pedidos
    const vai = dest => { res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store' }); res.end(); };

    if (!EMPRESAS_VALIDAS.includes(emp)) {
      if (diag) json(res, 400, { ok: false, erro: 'empresa inválida', validas: EMPRESAS_VALIDAS });
      else vai(portalBusca);
      return true;
    }
    if (!numero) { if (diag) json(res, 400, { ok: false, erro: 'faltou ?n=' }); else vai(portalBusca); return true; }

    // cache: numero → uuid do pacote (nunca muda)
    const ARQ = path.join(DATA_DIR, emp + '-pacotes.json');
    const mapa = lerJson(ARQ, {}) || {};
    const urlPedido = uuid => 'https://seller.magalu.com/pedidos/' + numero + '/' + uuid;
    if (mapa[numero] && !diag) { vai(urlPedido(mapa[numero])); return true; }

    const passos = [];
    let uuid = mapa[numero] || null;
    if (uuid) passos.push({ passo: 'cache', uuid });

    try {
      const tok = await getAccessToken(emp);
      const r = await fetch('https://api.magalu.com/seller/v1/orders?_limit=5&code=' + encodeURIComponent(numero),
        { headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      let lista = j && (j.results || j.data || (Array.isArray(j) ? j : []));
      // fallback: se o filtro por code não bateu, casa no cliente
      let ped = (lista || []).find(x => String(x.code || '') === numero) || (lista || [])[0] || null;
      passos.push({ passo: 'consulta', status: r.status, achou_pedido: !!ped,
        corpo: ped ? undefined : (t || '').slice(0, 300) });

      if (ped && Array.isArray(ped.deliveries) && ped.deliveries[0] && ped.deliveries[0].id) {
        uuid = ped.deliveries[0].id;
        mapa[numero] = uuid;
        try { gravarJson(ARQ, mapa); } catch (e) {}
        passos.push({ passo: 'achou', uuid, delivery_code: ped.deliveries[0].code || null });
      } else if (ped) {
        passos.push({ passo: 'sem_delivery', chaves_pedido: Object.keys(ped) });
      }
    } catch (e) {
      passos.push({ passo: 'excecao', erro: String(e.message || e).slice(0, 250) });
    }

    if (diag) {
      json(res, 200, { ok: !!uuid, empresa: emp, numero, uuid,
        destino: uuid ? urlPedido(uuid) : portalBusca,
        pacotes_em_cache: Object.keys(mapa).length, versao: VERSAO, passos });
      return true;
    }
    vai(uuid ? urlPedido(uuid) : portalBusca);
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
