'use strict';

/**
 * Módulo /good-mm-diag — DIAGNÓSTICO da API do Madeira Madeira (GOOD Import)
 * v3: adiciona teste de URL arbitrária com o TOKENMM, pra descobrir se a API
 * INTERNA do Portal (painelmarketplace / envios) aceita o token (e não só a
 * sessão de login). Tudo abaixo é LEITURA.
 *
 * Descobertas da captura do Portal:
 *  - GERAR (interna, sessão): POST painelmarketplace.../painel/v2/api/mm-envios/lote/etiquetas
 *      corpo: {etiqueta_tipo:1, lote_tipo:1, pedidos:{"<pedido>":[["<item>"],...]}, transportadora:null}
 *  - LISTAR lotes (interna): GET  painelmarketplace.../painel/v2/api/mm-envios/lotes
 *      retorna [{batch, orders, objects:[SRO], file:"<url pdf>", status:1|2, ...}]
 *  - BAIXAR pdf (interna):    GET  envios.../api/v1/lote/<batch>/imprimir-pdf
 *
 * TEMPORÁRIO. Não toca na integração do Bling.
 *
 * Env: GOOD_MM_TOKEN (obrigatório), GOOD_MM_BASE (opcional), GOOD_MM_DIAG_KEY (opcional)
 */

const https = require('https');

const VERSAO = 'good-mm-diag v27/06 a3';

const MM_BASE = (process.env.GOOD_MM_BASE || 'https://marketplace.madeiramadeira.com.br').replace(/\/+$/, '');
const MM_VERSAO = '/v1';

// URLs internas descobertas na captura (host do Portal)
const URL_LOTES = 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/api/mm-envios/lotes';
const URL_PDF_288348 = 'https://envios.madeiramadeira.com.br/api/v1/lote/288348/imprimir-pdf';

const agent = new https.Agent({ family: 4, keepAlive: false });

// ── Helpers HTTP locais ──────────────────────────────────────────────
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body, null, 2)); }
function html(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Requisição genérica. fullUrl = URL completa (qualquer host). Resolve sempre.
function reqRaw(method, fullUrl, { body = null } = {}) {
  return new Promise((resolve) => {
    const token = process.env.GOOD_MM_TOKEN || '';
    if (!token) return resolve({ ok: false, erro: 'GOOD_MM_TOKEN não configurado no Render' });
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'TOKENMM': token, 'Accept': '*/*', 'User-Agent': 'good-mm-diag/3.0' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    let req;
    try {
      req = https.request(fullUrl, { method, agent, headers, timeout: 30000 }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = (resp.headers['content-type'] || '').toLowerCase();
          const ehPDF = buf.slice(0, 5).toString('latin1') === '%PDF-';
          const ehZPL = buf.slice(0, 3).toString('latin1') === '^XA';
          let parsed = null;
          if (ct.includes('json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) {} }
          const jsonFalhou = parsed && parsed.success === false;
          const out = {
            ok: (resp.statusCode >= 200 && resp.statusCode < 300) && !jsonFalhou,
            statusCode: resp.statusCode, contentType: resp.headers['content-type'] || null,
            length: buf.length, parece_PDF: ehPDF, parece_ZPL: ehZPL, url: fullUrl
          };
          if (parsed) out.json = parsed;
          else if (!ehPDF && !ehZPL) out.text = buf.toString('utf8').slice(0, 3000);
          else out.headBytesHex = buf.slice(0, 16).toString('hex');
          resolve(out);
        });
      });
    } catch (e) { return resolve({ ok: false, erro: 'URL inválida: ' + e.message, url: fullUrl }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, erro: 'timeout (30s)', url: fullUrl }); });
    req.on('error', (e) => resolve({ ok: false, erro: e.message, url: fullUrl }));
    if (payload) req.write(payload);
    req.end();
  });
}
// Atalhos para a API pública (marketplace/v1)
const mmGet  = (path, opts) => reqRaw('GET',  MM_BASE + MM_VERSAO + path, opts);
const mmPost = (path, body) => reqRaw('POST', MM_BASE + MM_VERSAO + path, { body });

// ── Extração / resumo ────────────────────────────────────────────────
function extrairPedidos(j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'pedidos', 'result', 'results', 'items', 'content']) if (Array.isArray(j[k])) return j[k];
  return null;
}
function pedidoUnico(j) {
  if (j && j.data && !Array.isArray(j.data) && typeof j.data === 'object') return j.data;
  const lista = extrairPedidos(j);
  return Array.isArray(lista) ? lista[0] : (j && typeof j === 'object' ? j : null);
}
function itensDoPedido(p) { const i = (p && (p.skus || p.itens || p.items)) || []; return Array.isArray(i) ? i : []; }
function srosDoPedido(p) {
  const e = (p && (p.envio || (p.tracking && p.tracking.envio))) || [];
  return (Array.isArray(e) ? e : []).map(x => x.codigo_rastreio ?? x.codigoRastreio).filter(Boolean);
}
function resumoPedido(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id_pedido: p.id_pedido ?? p.id ?? null, pedido_mm: p.pedido_mm ?? null, status: p.status ?? null,
    itens_resumo: itensDoPedido(p).map(it => ({
      id_pedido_item: it.id_pedido_item ?? it.id ?? null, sku: it.sku ?? null,
      quantidade: it.quantidade ?? null, madeira_envios: it.madeira_envios ?? null
    })),
    sros: srosDoPedido(p)
  };
}
function chaveOk(urlObj) {
  const e = process.env.GOOD_MM_DIAG_KEY || ''; if (!e) return true; return urlObj.searchParams.get('k') === e;
}
function interpretaAuth(r) {
  if (r.erro) return 'Erro de rede: ' + r.erro;
  if (r.ok) return '✅ FUNCIONOU com o TOKENMM (status ' + r.statusCode + '). A API interna aceita o token — dá pra automatizar no Render! 🎉';
  if (r.statusCode === 401 || r.statusCode === 403) return '🔒 ' + r.statusCode + ' — a API interna NÃO aceita o TOKENMM (precisa da sessão de login). Esse caminho não serve pro Render.';
  return 'Resposta ' + r.statusCode + ' — veja o corpo. (Não é o 200 esperado nem o 401/403 claro.)';
}

// ── Página HTML ──────────────────────────────────────────────────────
function paginaHtml() {
  const temToken = !!process.env.GOOD_MM_TOKEN;
  const temKey = !!process.env.GOOD_MM_DIAG_KEY;
  const ks = temKey ? '&k=SUA_CHAVE' : '';
  const askKey = temKey ? "var k=prompt('Chave (k):','');if(k)url+='&k='+encodeURIComponent(k);else return;" : '';
  const enc = encodeURIComponent;
  return `<!doctype html><html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico MM — GOOD</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;max-width:820px;margin:24px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}.v{color:#888;font-size:12px;margin-bottom:16px}
  .card{border:1px solid #e3e3e3;border-radius:10px;padding:14px 16px;margin:12px 0}
  code{background:#f4f4f5;padding:2px 6px;border-radius:5px;font-size:12px;word-break:break-all}
  a.btn{display:inline-block;margin:6px 8px 6px 0;padding:9px 14px;background:#EF5B25;color:#fff;text-decoration:none;border-radius:7px;font-weight:600;font-size:14px;cursor:pointer}
  a.btn.blue{background:#1677ff}a.btn.danger{background:#c0392b}
  .hi{background:#eef6ff;border-color:#9cc3f5}.danger-box{background:#fdecea;border-color:#e6736a}
  .ok{color:#157347;font-weight:600}.no{color:#b02a37;font-weight:600}
  input{padding:8px;border:1px solid #ccc;border-radius:6px;width:220px}label{font-size:13px;color:#444}
</style></head><body>
<h1>🩺 Diagnóstico Madeira Madeira — GOOD Import</h1>
<div class="v">${VERSAO} · pública <code>${MM_BASE}${MM_VERSAO}</code></div>

<div class="card ${temToken ? '' : 'danger-box'}">
  Token: ${temToken ? '<span class="ok">configurado</span>' : '<span class="no">FALTA</span>'} · Chave: ${temKey ? '<span class="ok">ativa</span>' : 'desativada'}
</div>

<div class="card hi">
  <b>★ Teste decisivo — a API interna aceita o TOKENMM?</b> &nbsp;[só leitura]<br>
  Estes são os endpoints reais do Portal. Se responderem 200 com o token, dá pra automatizar tudo no Render.
  <div style="margin-top:8px">
    <a class="btn blue" href="/good-mm-diag/raw?url=${enc(URL_LOTES)}${ks}">Interna: listar lotes</a>
    <a class="btn blue" href="/good-mm-diag/raw?url=${enc(URL_PDF_288348)}${ks}">Interna: baixar PDF do lote 288348</a>
  </div>
  <div style="margin-top:8px">
    <label>URL livre p/ testar c/ token: <input id="rurl" placeholder="https://..."></label>
    <a class="btn blue" onclick="raw()">Testar URL</a>
  </div>
</div>

<div class="card">
  <b>1) Listar pedidos</b> &nbsp;[leitura] (API pública)<br>
  <a class="btn" href="/good-mm-diag/pedidos?status=invoiced&limit=5${ks}">NF emitida</a>
  <a class="btn" href="/good-mm-diag/pedidos?status=shipped&limit=5${ks}">Enviados</a>
</div>

<div class="card">
  <b>2) Abrir 1 pedido</b> &nbsp;[leitura]<br>
  <label>nº pedido (MM): <input id="pid" placeholder="ex: 9791508"></label>
  <a class="btn" onclick="go('pedido','id','pid')">Abrir</a>
</div>

<div class="card">
  <b>3) Baixar etiqueta (API pública)</b> &nbsp;[leitura] — SRO/lote/pedido:<br>
  <label>ref: <input id="ref" placeholder="SRO, lote ou pedido"></label>
  <a class="btn" onclick="go('etiqueta','ref','ref')">Baixar/testar</a>
</div>

<script>
  function go(rota,param,id){var v=document.getElementById(id).value.trim();if(!v){alert('Preencha');return;}var url='/good-mm-diag/'+rota+'?'+param+'='+encodeURIComponent(v);${askKey}window.location.href=url;}
  function raw(){var v=document.getElementById('rurl').value.trim();if(!v){alert('Cole a URL');return;}var url='/good-mm-diag/raw?url='+encodeURIComponent(v);${askKey}window.location.href=url;}
</script>
</body></html>`;
}

// ── Router ───────────────────────────────────────────────────────────
function routes(/* readBody */) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    if (p !== '/good-mm-diag' && !p.startsWith('/good-mm-diag/')) return false;
    if (req.method !== 'GET') { json(res, 405, { erro: 'somente GET' }); return true; }

    if (p === '/good-mm-diag' || p === '/good-mm-diag/') { html(res, 200, paginaHtml()); return true; }

    if (p === '/good-mm-diag/health') {
      json(res, 200, { ok: true, modulo: 'good-mm-diag', versao: VERSAO, base: MM_BASE + MM_VERSAO,
        tokenConfigurado: !!process.env.GOOD_MM_TOKEN, chaveExigida: !!process.env.GOOD_MM_DIAG_KEY, ts: Date.now() });
      return true;
    }

    if (!chaveOk(urlObj)) { json(res, 401, { erro: 'chave inválida ou ausente (?k=)' }); return true; }

    // ★ TESTE DE URL ARBITRÁRIA com TOKENMM (read-only) — só http(s)
    if (p === '/good-mm-diag/raw') {
      const alvo = (urlObj.searchParams.get('url') || '').trim();
      if (!/^https?:\/\//i.test(alvo)) { json(res, 400, { erro: 'informe ?url=https://...' }); return true; }
      const r = await reqRaw('GET', alvo);
      json(res, 200, {
        chamada: { url: alvo, metodo: 'GET', auth: 'header TOKENMM' },
        resultado: {
          ok: r.ok, statusCode: r.statusCode, contentType: r.contentType, tamanho_bytes: r.length ?? null,
          parece_PDF: r.parece_PDF ?? null, parece_ZPL: r.parece_ZPL ?? null,
          corpo: r.json ?? r.text ?? null, primeiros_bytes_hex: r.headBytesHex ?? null, erro: r.erro || null
        },
        interpretacao: interpretaAuth(r)
      });
      return true;
    }

    // Lista de pedidos (pública) [leitura]
    if (p === '/good-mm-diag/pedidos') {
      const map = { new:'new', approved:'approved', received:'received', invoiced:'invoiced', shipped:'shipped', delivered:'delivered', cancelled:'cancelled' };
      const status = map[(urlObj.searchParams.get('status') || 'invoiced').toLowerCase()] || 'invoiced';
      let limit = parseInt(urlObj.searchParams.get('limit') || '5', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 5; if (limit > 20) limit = 20;
      const r = await mmGet(`/pedido/${status}/limit=${limit}&offset=0`);
      const peds = r.json ? extrairPedidos(r.json) : null;
      json(res, 200, { chamada: { status, limit, url: r.url }, resposta: { ok: r.ok, statusCode: r.statusCode, erro: r.erro || null },
        resumo: Array.isArray(peds) ? peds.slice(0, limit).map(resumoPedido) : '(veja o cru)', cru: r.json ?? r.text ?? null });
      return true;
    }

    // 1 pedido (pública) [leitura]
    if (p === '/good-mm-diag/pedido') {
      const id = (urlObj.searchParams.get('id') || '').trim();
      if (!id) { json(res, 400, { erro: 'informe ?id=' }); return true; }
      const r = await mmGet(`/pedido/id/${encodeURIComponent(id)}`);
      const ped = r.json ? pedidoUnico(r.json) : null;
      json(res, 200, { chamada: { id, url: r.url }, resposta: { ok: r.ok, statusCode: r.statusCode, erro: r.erro || null },
        resumo: resumoPedido(ped), cru: r.json ?? r.text ?? null });
      return true;
    }

    // Baixar etiqueta pública por ref [leitura]
    if (p === '/good-mm-diag/etiqueta') {
      const ref = (urlObj.searchParams.get('ref') || urlObj.searchParams.get('sro') || '').trim();
      if (!ref) { json(res, 400, { erro: 'informe ?ref=' }); return true; }
      const r = await mmGet(`/madeiraenvios/etiquetas/${encodeURIComponent(ref)}/arquivo`);
      const baixou = r.ok && (r.parece_PDF || r.parece_ZPL);
      json(res, 200, { chamada: { ref, url: r.url },
        resultado: { baixou_arquivo: baixou, statusCode: r.statusCode, contentType: r.contentType, tamanho_bytes: r.length ?? null,
          parece_PDF: r.parece_PDF ?? null, parece_ZPL: r.parece_ZPL ?? null, corpo: r.json ?? r.text ?? null, erro: r.erro || null },
        interpretacao: baixou ? `✅ BAIXOU (${r.parece_PDF ? 'PDF' : 'ZPL'}) com ref="${ref}".`
          : (r.statusCode === 202 ? 'Status 202 = ainda não disponível por essa ref.' : 'Não baixou — veja statusCode/corpo.') });
      return true;
    }

    json(res, 404, { erro: 'rota não encontrada', path: p });
    return true;
  };
}

module.exports = {
  id: 'good-mm-diag',
  nome: 'GOOD Madeira Madeira (diagnóstico)',
  rotinas: {},
  crons: {},
  routes
};
