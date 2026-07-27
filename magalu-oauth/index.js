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

const VERSAO = 'magalu-oauth v1 b25';

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

  // ── NF-e FULFILLMENT: painel + download do ZIP ───────────────────────
  //  /magalu/nf-full?k=ADMIN_KEY                          → painel
  //  /magalu/nf-full/baixar?empresa=amb&de=X&ate=Y&k=...  → devolve o .zip
  //
  //  CONTRATO DA API (confirmado na sonda de 26-27/07, AMB e GOOD):
  //    GET /seller/v1/invoices/fulfillment?start_date=AAAA-MM-DD&end_date=AAAA-MM-DD
  //    → 200 {"expires_on":"...","signed_url":"https://storage.googleapis.com/...zip"}
  //    O link e assinado e vale ~30 min. O ZIP tem os XMLs do periodo.
  //  Outros status que a API devolve e o que significam:
  //    408 REQUEST_TIMEOUT  → "esta sendo processado, tente de novo" (geracao assincrona)
  //    429 TOO_MANY_REQUESTS→ chamou rapido demais; espacar alguns segundos resolve
  //    503                  → instabilidade momentanea do lado deles
  //  Por isso o pedirLinkZip abaixo REPETE em vez de desistir.
  //
  //  ⚠ TRAVA DE ADMIN: o index.js da RAIZ so exige ADMIN_KEY nos paths que
  //  estao na lista precisaAdmin dele, e /magalu/nf-full NAO esta nessa lista
  //  (de proposito — nao quis mexer no orquestrador). Entao a trava e feita
  //  AQUI DENTRO. Sem ela a rota ficaria publica e qualquer um baixaria as NFs.
  if (p === '/magalu/nf-full' || p === '/magalu/nf-full/baixar') {
    const CHAVE_ADMIN = process.env.ADMIN_KEY || '';
    if (!CHAVE_ADMIN || q.get('k') !== CHAVE_ADMIN) { json(res, 404, { error: 'not found', path: p }); return true; }

    const eData = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const fmtD  = d => d.toISOString().slice(0, 10);

    // ── PAINEL ──
    if (p === '/magalu/nf-full') {
      const hoje = new Date();
      const pad = fmtD(hoje), pde = fmtD(new Date(hoje.getTime() - 6 * 864e5));
      html(res, 200, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NF-e Fulfillment Magalu</title><style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;margin:0;padding:24px}
.wrap{max-width:620px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}
p.sub{color:#9aa0a6;margin:0 0 24px;font-size:13px}
.card{background:#181b21;border:1px solid #2a2f3a;border-radius:10px;padding:18px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa0a6;margin-bottom:5px}
input[type=date]{background:#0f1115;color:#e8eaed;border:1px solid #2a2f3a;border-radius:6px;padding:9px;font:inherit;width:100%}
.linha{display:flex;gap:12px;margin-bottom:16px}.linha>div{flex:1}
.btns{display:flex;gap:12px;flex-wrap:wrap}
a.btn{flex:1;min-width:170px;text-align:center;text-decoration:none;background:#1a73e8;color:#fff;padding:13px 16px;border-radius:8px;font-weight:600}
a.btn.good{background:#0f9d58}a.btn:hover{opacity:.9}
.aviso{font-size:12px;color:#9aa0a6;margin-top:14px;padding-top:14px;border-top:1px solid #2a2f3a}
.erro{color:#f28b82;font-size:13px;margin-top:10px;display:none}
</style></head><body><div class="wrap">
<h1>NF-e Fulfillment — Magalu</h1>
<p class="sub">Baixa o ZIP com os XMLs das notas que a Magalu emitiu no fulfillment. Depois é só importar no Bling em lote.</p>
<div class="card">
  <div class="linha">
    <div><label>De</label><input type="date" id="de" value="${pde}"></div>
    <div><label>Até</label><input type="date" id="ate" value="${pad}"></div>
  </div>
  <div class="btns">
    <a class="btn" id="bAmb" href="#">Baixar AMBTotal</a>
    <a class="btn good" id="bGood" href="#">Baixar GOOD Import</a>
  </div>
  <div class="erro" id="erro"></div>
  <div class="aviso">O período não pode passar de <b>31 dias</b> (regra da Magalu).<br>
  Pode demorar de 5 a 40 segundos: a Magalu gera o arquivo na hora, e se ela responder
  "estou processando" o servidor espera e tenta de novo sozinho.</div>
</div>
<div class="card" style="font-size:13px;color:#9aa0a6">
  <b style="color:#e8eaed">No Bling, depois:</b><br>
  Configurações → Importações de Dados → Importar Notas Fiscais em Lote → notas de <b>saída</b>.<br>
  Marcar lançar contas. <b>Não</b> marcar lançar estoque (o estoque do Full está no CD da Magalu).
</div>
</div><script>
var K = new URLSearchParams(location.search).get('k') || '';
function mont(emp){
  var de = document.getElementById('de').value, ate = document.getElementById('ate').value;
  var e = document.getElementById('erro'); e.style.display='none';
  if(!de || !ate){ e.textContent='Preencha as duas datas.'; e.style.display='block'; return null; }
  if(de > ate){ e.textContent='A data inicial está depois da final.'; e.style.display='block'; return null; }
  var dias = (new Date(ate) - new Date(de)) / 864e5;
  if(dias > 31){ e.textContent='O período tem '+Math.round(dias)+' dias. O máximo é 31.'; e.style.display='block'; return null; }
  return '/magalu/nf-full/baixar?empresa='+emp+'&de='+de+'&ate='+ate+'&k='+encodeURIComponent(K);
}
function liga(id, emp){
  document.getElementById(id).addEventListener('click', function(ev){
    ev.preventDefault(); var u = mont(emp); if(u) location.href = u;
  });
}
liga('bAmb','amb'); liga('bGood','good');
</script></body></html>`);
      return true;
    }

    // ── DOWNLOAD ──
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    const de  = String(q.get('de') || '').trim();
    const ate = String(q.get('ate') || '').trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida: ' + emp }); return true; }
    if (!eData(de) || !eData(ate))       { json(res, 400, { ok: false, erro: 'datas devem ser AAAA-MM-DD' }); return true; }
    if (de > ate)                        { json(res, 400, { ok: false, erro: 'data inicial depois da final' }); return true; }
    const dias = (new Date(ate) - new Date(de)) / 864e5;
    if (dias > 31)                       { json(res, 400, { ok: false, erro: 'período de ' + Math.round(dias) + ' dias; a Magalu aceita no máximo 31' }); return true; }

    // Pede o link, insistindo nos status que significam "espera um pouco".
    async function pedirLinkZip(empresa, dIni, dFim) {
      const tok = await getAccessToken(empresa);
      const alvo = 'https://api.magalu.com/seller/v1/invoices/fulfillment'
                 + '?start_date=' + encodeURIComponent(dIni) + '&end_date=' + encodeURIComponent(dFim);
      const esperas = [0, 5000, 10000, 20000];
      const historico = [];
      for (let i = 0; i < esperas.length; i++) {
        if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
        const r = await fetch(alvo, { headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' } });
        const txt = await r.text();
        historico.push(r.status);
        if (r.status === 200) {
          let j = null; try { j = JSON.parse(txt); } catch (e) {}
          if (j && j.signed_url) return { link: j.signed_url, expira: j.expires_on || null, historico };
          throw new Error('a Magalu respondeu 200 mas sem signed_url: ' + txt.slice(0, 200));
        }
        // 408 = gerando; 429 = chamou rápido demais; 503 = instabilidade → insiste
        if (r.status !== 408 && r.status !== 429 && r.status !== 503) {
          throw new Error('a Magalu respondeu ' + r.status + ': ' + txt.slice(0, 200));
        }
      }
      throw new Error('a Magalu não devolveu o link em ' + esperas.length + ' tentativas (status: ' + historico.join(', ') + '). Tente de novo em um minuto.');
    }

    let info;
    try { info = await pedirLinkZip(emp, de, ate); }
    catch (e) { json(res, 502, { ok: false, empresa: emp, periodo: { de, ate }, erro: String(e.message || e) }); return true; }

    let buf;
    try {
      const rz = await fetch(info.link);
      if (!rz.ok) { json(res, 502, { ok: false, erro: 'o link assinado devolveu HTTP ' + rz.status, link_expira_em: info.expira }); return true; }
      buf = Buffer.from(await rz.arrayBuffer());
    } catch (e) { json(res, 502, { ok: false, erro: 'falha ao baixar o zip: ' + String(e.message || e) }); return true; }

    // ZIP começa com PK — se não começar, veio outra coisa e é melhor avisar
    if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B)) {
      json(res, 502, { ok: false, erro: 'o arquivo não é um ZIP', bytes: buf.length, inicio: buf.toString('utf8').slice(0, 200) });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="NFs-' + emp + '-' + de + '_a_' + ate + '.zip"',
      'Content-Length': buf.length,
      'X-Magalu-Tentativas': info.historico.join(',')
    });
    res.end(buf);
    return true;
  }

  // ── SONDA NF-e FULFILLMENT (26/07) ──────────────────────────────────
  // /magalu/sonda?empresa=amb&nf=1[&de=2026-07-19&ate=2026-07-26][&delivery=UUID]
  //
  // POR QUE PENDURADA NO /magalu/sonda: esse path JÁ está na lista de rotas
  // admin do index.js da RAIZ. Criar /magalu/nf-full exigiria editar o
  // orquestrador da raiz — o arquivo que derrubou o serviço em 23/07. Não vale
  // o risco por uma sondagem.
  //
  // O QUE FAZ: chama GET /seller/v1/invoices/fulfillment PELADO (o 422 do
  // Magalu costuma listar os parâmetros obrigatórios pelo nome) e depois testa
  // uma matriz de nomes de parâmetro de período, porque a doc não renderiza os
  // parâmetros no HTML. Mostra status, content-type, tamanho e um pedaço do
  // corpo de cada tentativa. NÃO grava nada, NÃO importa nada.
  if (method === 'GET' && p === '/magalu/sonda' && q.get('nf')) {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }

    const fmt = d => d.toISOString().slice(0, 10);
    const hoje = new Date();
    const ate = String(q.get('ate') || fmt(hoje)).trim();
    const de  = String(q.get('de')  || fmt(new Date(hoje.getTime() - 7 * 864e5))).trim();

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };

    // Lê a resposta SEM assumir que é JSON: se vier ZIP (o portal devolve um
    // .zip de 526 KB) ou XML puro, mede e identifica em vez de despejar lixo.
    async function inspecionar(url) {
      const t0 = Date.now();
      let r;
      try { r = await fetch(url, { headers: H, redirect: 'manual' }); }
      catch (e) { return { url: url.replace('https://api.magalu.com', ''), erro: String(e.message || e).slice(0, 160) }; }

      const ct  = r.headers.get('content-type') || '';
      const loc = r.headers.get('location') || null;
      let buf;
      try { buf = Buffer.from(await r.arrayBuffer()); } catch (e) { buf = Buffer.alloc(0); }

      const out = {
        url: url.replace('https://api.magalu.com', ''),
        status: r.status, content_type: ct.slice(0, 60), bytes: buf.length, ms: Date.now() - t0
      };
      if (loc) out.REDIRECT_PARA = loc.slice(0, 300);
      try {
        const hs = {};
        r.headers.forEach((v, k) => { if (!/^(date|server|connection|content-length)$/i.test(k)) hs[k] = String(v).slice(0, 120); });
        out.headers = hs;
      } catch (e) {}

      // assinatura de ZIP = PK\x03\x04
      if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) { out.VEIO_ZIP = true; return out; }

      const txt = buf.toString('utf8');
      if (/^\s*<\?xml|<nfeProc|<NFe/i.test(txt)) { out.VEIO_XML = true; out.trecho = txt.slice(0, 300); return out; }

      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (!j) { out.corpo = txt.slice(0, 500); return out; }

      out.json_chaves = Object.keys(j).slice(0, 20);
      // caça qualquer campo que pareça link de download (o portal devolve URL
      // assinada do storage.googleapis.com)
      const links = [];
      (function caca(o, base) {
        if (!o || typeof o !== 'object' || links.length > 8) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          const cam = base ? base + '.' + k : k;
          if (typeof v === 'string' && /^https?:\/\//i.test(v)) links.push(cam + ' = ' + v.slice(0, 200));
          else if (v && typeof v === 'object') caca(v, cam);
        }
      })(j, '');
      if (links.length) out.LINKS_ENCONTRADOS = links;
      out.corpo = JSON.stringify(j).slice(0, 700);
      return out;
    }

    const BASE = 'https://api.magalu.com/seller/v1/invoices/fulfillment';
    const tentativas = [];

    // 1) pelado — é aqui que o 422 entrega o nome dos parâmetros
    tentativas.push(await inspecionar(BASE));

    // 2) FASE 2 (26/07): o 422 confirmou que os parametros sao start_date e
    //    end_date. Com eles a API passou da validacao e devolveu 503 — entao o
    //    que falta descobrir e o FORMATO da data (e se o 503 e transitorio).
    const dorme = ms => new Promise(r => setTimeout(r, ms));
    const qs = (a, b, extra) => BASE + '?start_date=' + encodeURIComponent(a) + '&end_date=' + encodeURIComponent(b) + (extra || '');

    // 2a) o formato que deu 503, repetido 3x — separa 503 transitorio de 503 sempre
    for (let i = 0; i < 3; i++) {
      const t = await inspecionar(qs(de, ate));
      t.nota = 'data simples, tentativa ' + (i + 1) + '/3';
      tentativas.push(t);
      if (i < 2) await dorme(1500);
    }

    // 2b) variacoes de formato de data/hora
    const formatos = [
      [de + 'T00:00:00Z',       ate + 'T23:59:59Z',       'ISO com Z'],
      [de + 'T00:00:00',        ate + 'T23:59:59',        'ISO sem timezone'],
      [de + 'T00:00:00-03:00',  ate + 'T23:59:59-03:00',  'ISO com offset BR'],
      [de + ' 00:00:00',        ate + ' 23:59:59',        'data e hora com espaco'],
      [de + 'T00:00:00.000Z',   ate + 'T23:59:59.999Z',   'ISO com milissegundos']
    ];
    for (const f of formatos) {
      const t = await inspecionar(qs(f[0], f[1]));
      t.nota = f[2];
      tentativas.push(t);
    }

    // 2c) janelas menores — talvez o 503 seja volume de dados
    const t1 = await inspecionar(qs(ate, ate));            t1.nota = 'janela de 1 dia (so a data final)';   tentativas.push(t1);
    // 2d) paginacao no padrao Magalu (_limit / _offset)
    const t2 = await inspecionar(qs(de, ate, '&_limit=5&_offset=0')); t2.nota = 'com _limit=5 e _offset=0';  tentativas.push(t2);

    // 3) se passar &delivery=UUID, testa também a NF por entrega
    const dlv = String(q.get('delivery') || '').trim();
    if (dlv) {
      const t3 = await inspecionar(BASE + '?delivery_id=' + encodeURIComponent(dlv));
      t3.nota = 'delivery_id na rota de fulfillment (a alternativa que o 422 ofereceu)';
      tentativas.push(t3);
      const t4 = await inspecionar('https://api.magalu.com/seller/v1/deliveries/' + encodeURIComponent(dlv) + '/invoices');
      t4.nota = 'rota de NF por entrega';
      tentativas.push(t4);
    }

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      periodo_testado: { de, ate },
      leia: 'FASE 2: start_date e end_date ja estao confirmados. Agora procure qualquer linha com status DIFERENTE de 503 e de 422 — e veja o campo nota de cada tentativa pra saber qual formato de data foi usado.',
      tentativas
    });
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
      base: BASE_FIN.replace('https://api.magalu.com', ''), como_achou: comoAchou,
      order_code: (alvo.extras && alvo.extras.order_code) || alvo.order_code || null,
      external_id: alvo.external_id || null,
      DEVOLUCAO: devolucao.length ? devolucao : 'nenhuma transação REFUND neste pedido',
      FRETE: frete.length ? frete : 'nenhuma transação SHIPPING_COST',
      saldo_liquido: Math.round(saldo * 100) / 100,
      TODAS_TRANSACOES: resumo
    });
    return true;
  }

  // SONDA de reputação REMOVIDA por segurança após cumprir o diagnóstico: testou 10
  // endpoints candidatos e TODOS deram 404 — não há endpoint público de nível/coparticipação
  // na API Magalu. O nível fica manual no ⚙️ do dashboard.

  // /magalu/financeiro-lote?empresa=good&codes=A,B,C[&dias=30]  → (admin)
  // Versão em LOTE do financeiro, pro coletor (vendasSync). Recebe vários order_codes
  // e devolve o financeiro de todos de uma vez. Aproveita que uma janela de 15 dias já
  // traz muitos pedidos: varre de trás pra frente (até &dias, default 45) montando um
  // índice code→transações, e casa os codes pedidos. Devolve por code: comissão real
  // (serviço+tech), MDR, tarifa fixa, frete, devolução (REFUND), saldo líquido.
  if (method === 'GET' && p === '/magalu/financeiro-lote') {
    const emp = String(q.get('empresa') || '').toLowerCase().trim();
    if (!EMPRESAS_VALIDAS.includes(emp)) { json(res, 400, { ok: false, erro: 'empresa inválida' }); return true; }
    const codesRaw = String(q.get('codes') || '').trim();
    if (!codesRaw) { json(res, 400, { ok: false, erro: 'passe &codes=A,B,C' }); return true; }
    // sanitização: só codes numéricos (order_code da Magalu é numérico), no máximo 50 por chamada (anti-DoS)
    const codesLimpos = codesRaw.split(',').map(s => s.trim()).filter(s => /^\d{1,25}$/.test(s));
    if (!codesLimpos.length) { json(res, 400, { ok: false, erro: 'nenhum code válido (devem ser numéricos)' }); return true; }
    if (codesLimpos.length > 50) { json(res, 400, { ok: false, erro: 'máximo 50 codes por chamada' }); return true; }
    const codesPedidos = new Set(codesLimpos);
    const dias = Math.min(180, Math.max(15, parseInt(q.get('dias') || '45', 10) || 45));

    let tok = '';
    try { tok = await getAccessToken(emp); }
    catch (e) { json(res, 502, { ok: false, erro: 'token: ' + String(e.message || e) }); return true; }
    const H = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
    const BASE_FIN = 'https://api.magalu.com/seller/v1/financial-analysis/orders';

    async function pega(url) {
      const r = await fetch(url, { headers: H });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, j, t };
    }

    // resume as transações de um pedido nos campos que o dashboard usa
    function resumir(alvo) {
      const txs = alvo.transactions || [];
      let comissao = 0, mdr = 0, tarifa = 0, freteDebito = 0, freteCredito = 0, refund = 0, sale = 0;
      for (const t of txs) {
        const v = (t.value || 0) / (t.normalizer || 100);
        const cat = t.category, sub = t.subcategory, tp = t.type;
        if (cat === 'SALE') sale += v;
        else if (cat === 'COMMISSION') comissao += v;   // SERVICE + TECHNOLOGY + FREIGHT
        else if (cat === 'FEES' && sub === 'PAYMENT_PROCESSING') mdr += v;
        else if (cat === 'FEES' && sub === 'PLATFORM') tarifa += v;
        else if (cat === 'SHIPPING_COST') { if (tp === 'DEBIT') freteDebito += v; else if (tp === 'CREDIT') freteCredito += v; }
        else if (cat === 'REFUND') refund += v;
      }
      const saldo = txs.reduce((a, t) => {
        const v = (t.value || 0) / (t.normalizer || 100);
        return t.type === 'CREDIT' ? a + v : (t.type === 'DEBIT' ? a - v : a);
      }, 0);
      return {
        sale: Math.round(sale * 100) / 100,
        comissao: Math.round(comissao * 100) / 100,   // comissão real total (serviço+tech)
        mdr: Math.round(mdr * 100) / 100,
        tarifa_fixa: Math.round(tarifa * 100) / 100,
        frete_debito: Math.round(freteDebito * 100) / 100,   // frete que a Magalu cobra (inclui reverso)
        frete_credito: Math.round(freteCredito * 100) / 100,
        refund: Math.round(refund * 100) / 100,   // estorno de devolução (0 = sem devolução financeira)
        saldo_liquido: Math.round(saldo * 100) / 100,
        tem_devolucao: refund !== 0
      };
    }

    const MS_DIA = 86400000;
    const agora = Date.now();
    const limite = agora - dias * MS_DIA;
    const achados = {};   // code → resumo
    let fimBloco = agora, janelas = 0;
    // varre em janelas de 15 dias até cobrir 'dias' OU achar todos os codes pedidos
    while (fimBloco > limite && janelas < 13 && Object.keys(achados).length < codesPedidos.size) {
      const iniBloco = Math.max(limite, fimBloco - 15 * MS_DIA);
      const gte = new Date(iniBloco).toISOString();
      const lte = new Date(fimBloco).toISOString();
      const JAN = 'purchased_at__gte=' + encodeURIComponent(gte) + '&purchased_at__lte=' + encodeURIComponent(lte);
      janelas++;
      let offset = 0;
      while (offset < 1000) {
        const r = await pega(BASE_FIN + '?' + JAN + '&_limit=50&_offset=' + offset);
        if (r.status !== 200) {
          json(res, 200, { ok: false, empresa: emp, versao: VERSAO,
            nota: 'janela retornou ' + r.status, corpo: r.j || (r.t || '').slice(0, 300) });
          return true;
        }
        const arr = r.j && (r.j.results || r.j.data || (Array.isArray(r.j) ? r.j : [])) || [];
        if (!arr.length) break;
        for (const o of arr) {
          const oc = String((o.extras && o.extras.order_code) || o.order_code || o.external_id || '');
          if (codesPedidos.has(oc) && !achados[oc]) {
            // &cru=1: devolve TODAS as transações sem agrupar (pra ver o frete/tudo cru)
            if (q.get('cru') === '1') {
              achados[oc] = (o.transactions || []).map(t => ({
                categoria: t.category, sub: t.subcategory, tipo: t.type,
                valor: (t.value || 0) / (t.normalizer || 100), desc: t.description
              }));
            } else {
              achados[oc] = resumir(o);
            }
          }
        }
        offset += 50;
        if (Object.keys(achados).length >= codesPedidos.size) break;
      }
      fimBloco = iniBloco - 1000;
    }

    json(res, 200, {
      ok: true, empresa: emp, versao: VERSAO,
      pedidos: achados,   // { code: {comissao, mdr, tarifa_fixa, frete_debito, refund, saldo_liquido, tem_devolucao} }
      achados: Object.keys(achados).length,
      pedidos_faltando: [...codesPedidos].filter(c => !achados[c]),
      janelas_varridas: janelas
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
