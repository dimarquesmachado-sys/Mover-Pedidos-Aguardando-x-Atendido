'use strict';

/**
 * Módulo /good-mm-diag — DIAGNÓSTICO da API do Madeira Madeira (GOOD Import)
 * v4: VARREDURA sistemática. Dispara uma bateria de endpoints candidatos nos
 *     hosts "envios" e público, todos GET (só leitura), com o TOKENMM, e
 *     resume o veredito de cada um. Inclui sondagem das rotas de GERAR via GET:
 *     se a rota responder 405 (Method Not Allowed), ela EXISTE e espera POST —
 *     ouro, sem precisar postar nada de verdade.
 *     Também corrige o falso-positivo: o MM responde HTTP 200 com
 *     {"status":false} quando recusa; agora isso NÃO conta como sucesso.
 *
 * Mapa confirmado nas capturas do Portal (F12):
 *  - GERAR  (sessão): POST painelmarketplace.../painel/v2/api/mm-envios/lote/etiquetas
 *      corpo: {etiqueta_tipo:1, lote_tipo:1, pedidos:{"<pedido>":[["<item>"],...]}, transportadora:null}
 *      resposta: {"success":true,"message":"Lote criado com sucesso"}  (NÃO devolve o batch)
 *  - LISTAR (sessão): GET  painelmarketplace.../painel/v2/api/mm-envios/lotes
 *      -> [{batch, orders:[{order_id,status}], objects:[SRO], file:"<url pdf>", status:1|2, expiration_date}]
 *      (usa COOKIE de sessão -> recusa o token no Render)
 *  - BAIXAR (token):  GET  envios.../api/v1/lote/<batch>/imprimir-pdf   ✅ funciona com TOKENMM
 *
 * Falta achar: LISTAR e GERAR no host "envios" (que aceita token). É o que a
 * varredura procura.
 *
 * TEMPORÁRIO. Não toca na integração do Bling.
 *
 * Env: GOOD_MM_TOKEN (obrigatório), GOOD_MM_BASE (opcional),
 *      GOOD_MM_SELLER (opcional, default 25379), GOOD_MM_DIAG_KEY (opcional)
 */

const https = require('https');

const VERSAO = 'good-mm-diag v27/06 a5';

const MM_BASE = (process.env.GOOD_MM_BASE || 'https://marketplace.madeiramadeira.com.br').replace(/\/+$/, '');
const MM_VERSAO = '/v1';
const SELLER = (process.env.GOOD_MM_SELLER || '25379').trim();

// Host de logística (aceita TOKENMM no download confirmado)
const ENVIOS = 'https://envios.madeiramadeira.com.br';

// URLs internas descobertas na captura (host do Portal)
const URL_LOTES = 'https://painelmarketplace.madeiramadeira.com.br/painel/v2/api/mm-envios/lotes';
const URL_PDF_288348 = ENVIOS + '/api/v1/lote/288348/imprimir-pdf';

// Valores do pedido de teste (já confirmados): MM 9768374 / lote 288348 / SRO AP115902313BR
const TESTE_BATCH = '288348';
const TESTE_SRO = 'AP115902313BR';
const TESTE_PEDIDO = '9768374';

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
    const headers = { 'TOKENMM': token, 'Accept': '*/*', 'User-Agent': 'good-mm-diag/4.0' };
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
          // MM devolve HTTP 200 com {status:false} OU {success:false} quando recusa.
          const jsonFalhou = parsed && (parsed.success === false || parsed.status === false);
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
  if (r.statusCode === 405) return '🎯 405 — a ROTA EXISTE mas espera POST (não GET). Forte candidata a GERAR.';
  if (r.statusCode === 401 || r.statusCode === 403) return '🔒 ' + r.statusCode + ' — a API interna NÃO aceita o TOKENMM (precisa da sessão de login). Esse caminho não serve pro Render.';
  if (r.json && (r.json.status === false || r.json.success === false)) return '❌ HTTP ' + r.statusCode + ' mas corpo {status:false} — token aceito no host, mas SEM permissão ou rota errada. Mensagem: "' + (r.json.message || '') + '".';
  return 'Resposta ' + r.statusCode + ' — veja o corpo. (Não é o 200 esperado nem o 401/403 claro.)';
}

// ── Varredura sistemática (todas GET, só leitura) ────────────────────
// Bateria de URLs candidatas. Em "gerar?" mandamos GET de propósito: se vier
// 405, a rota existe e espera POST (= provável endpoint de gerar).
function montarBateria({ batch, sro, pedidoMM }) {
  const E = ENVIOS;
  const P = MM_BASE; // marketplace.madeiramadeira.com.br
  return [
    // CONTROLES (sabidamente OK) — confirmam que o token + a varredura funcionam
    { grupo: 'controle', alvo: 'baixar PDF do lote (sabemos que funciona)', url: `${E}/api/v1/lote/${batch}/imprimir-pdf` },
    { grupo: 'controle', alvo: 'pedido público por id', url: `${P}/v1/pedido/id/${pedidoMM}` },

    // LISTAR no host envios — achar como descobrir o batch sem sessão
    { grupo: 'listar', alvo: 'lotes', url: `${E}/api/v1/lotes` },
    { grupo: 'listar', alvo: 'lotes?seller', url: `${E}/api/v1/lotes?seller=${SELLER}` },
    { grupo: 'listar', alvo: 'lotes?id_seller', url: `${E}/api/v1/lotes?id_seller=${SELLER}` },
    { grupo: 'listar', alvo: 'mm-envios/lotes', url: `${E}/api/v1/mm-envios/lotes` },
    { grupo: 'listar', alvo: 'seller/{id}/lotes', url: `${E}/api/v1/seller/${SELLER}/lotes` },

    // DETALHE — batch a partir do pedido
    { grupo: 'detalhe', alvo: 'lote?order_id', url: `${E}/api/v1/lote?order_id=${pedidoMM}` },
    { grupo: 'detalhe', alvo: 'lote?pedido', url: `${E}/api/v1/lote?pedido=${pedidoMM}` },
    { grupo: 'detalhe', alvo: 'lote/{batch}', url: `${E}/api/v1/lote/${batch}` },
    { grupo: 'detalhe', alvo: 'lote/{batch}/objetos', url: `${E}/api/v1/lote/${batch}/objetos` },
    { grupo: 'detalhe', alvo: 'pedido/{id}', url: `${E}/api/v1/pedido/${pedidoMM}` },
    { grupo: 'detalhe', alvo: 'pedido/id/{id}', url: `${E}/api/v1/pedido/id/${pedidoMM}` },

    // BAIXAR por SRO (alternativa: baixar sem saber o batch)
    { grupo: 'baixar-sro', alvo: 'etiqueta/{sro}', url: `${E}/api/v1/etiqueta/${sro}` },
    { grupo: 'baixar-sro', alvo: 'etiqueta/{sro}/imprimir-pdf', url: `${E}/api/v1/etiqueta/${sro}/imprimir-pdf` },
    { grupo: 'baixar-sro', alvo: 'objeto/{sro}/imprimir-pdf', url: `${E}/api/v1/objeto/${sro}/imprimir-pdf` },

    // GERAR sondado via GET (405 = a rota existe e quer POST = OURO)
    { grupo: 'gerar?', alvo: 'lote/etiquetas (sonda GET)', url: `${E}/api/v1/lote/etiquetas` },
    { grupo: 'gerar?', alvo: 'lote (sonda GET)', url: `${E}/api/v1/lote` },
    { grupo: 'gerar?', alvo: 'etiquetas (sonda GET)', url: `${E}/api/v1/etiquetas` },
    { grupo: 'gerar?', alvo: 'mm-envios/lote/etiquetas (sonda GET)', url: `${E}/api/v1/mm-envios/lote/etiquetas` },

    // Host público — família madeiraenvios
    { grupo: 'publico', alvo: 'madeiraenvios/lotes', url: `${P}/v1/madeiraenvios/lotes` },
    { grupo: 'publico', alvo: 'madeiraenvios/lote/{batch}', url: `${P}/v1/madeiraenvios/lote/${batch}` }
  ];
}

function veredito(r) {
  if (r.erro) return { txt: '⚠️ rede: ' + r.erro, prom: false, tag: 'rede' };
  if (r.parece_PDF) return { txt: '✅✅ PDF — baixou de verdade!', prom: true, tag: 'pdf' };
  if (r.parece_ZPL) return { txt: '✅✅ ZPL — baixou de verdade!', prom: true, tag: 'zpl' };
  const sc = r.statusCode;
  const j = r.json;
  const statusFalse = j && (j.status === false || j.success === false);
  if (sc === 405) return { txt: '🎯 405 — ROTA EXISTE, espera POST (provável GERAR!)', prom: true, tag: '405' };
  const msg = (j && j.message) || '';
  if (/method is not supported|supported methods/i.test(msg)) return { txt: '🎯 ROTA EXISTE — só aceita POST: "' + msg + '"', prom: true, tag: '405' };
  if (statusFalse) return { txt: '❌ status:false — "' + (msg || 'sem msg') + '"', prom: false, tag: 'false' };
  if (sc === 401 || sc === 403) return { txt: '🔒 ' + sc + ' — token recusado (precisa sessão)', prom: false, tag: 'auth' };
  if (sc === 404) return { txt: '— 404 (rota não existe)', prom: false, tag: '404' };
  if (sc >= 200 && sc < 300) {
    if (Array.isArray(j)) return { txt: '✅ LISTA com ' + j.length + ' item(ns)' + (j.length ? ' — PROMISSOR!' : ' (vazia)'), prom: j.length > 0, tag: 'lista' };
    if (j && typeof j === 'object') return { txt: '✅ JSON ok (chaves: ' + Object.keys(j).slice(0, 6).join(', ') + ') — olhar', prom: true, tag: 'json' };
    return { txt: '200 mas corpo estranho', prom: false, tag: '2xx' };
  }
  return { txt: '? status ' + sc, prom: false, tag: 'outro' };
}

// ── Página HTML ──────────────────────────────────────────────────────
function paginaHtml() {
  const temToken = !!process.env.GOOD_MM_TOKEN;
  const temKey = !!process.env.GOOD_MM_DIAG_KEY;
  const ks = temKey ? '&k=SUA_CHAVE' : '';
  const ks1 = temKey ? '?k=SUA_CHAVE' : '';
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
  a.btn.blue{background:#1677ff}a.btn.green{background:#157347}a.btn.danger{background:#c0392b}
  .hi{background:#eef6ff;border-color:#9cc3f5}.star{background:#f0fff4;border-color:#86d99e}.danger-box{background:#fdecea;border-color:#e6736a}
  .ok{color:#157347;font-weight:600}.no{color:#b02a37;font-weight:600}
  input{padding:8px;border:1px solid #ccc;border-radius:6px;width:200px}label{font-size:13px;color:#444}
</style></head><body>
<h1>🩺 Diagnóstico Madeira Madeira — GOOD Import</h1>
<div class="v">${VERSAO} · pública <code>${MM_BASE}${MM_VERSAO}</code> · seller <code>${SELLER}</code></div>

<div class="card ${temToken ? '' : 'danger-box'}">
  Token: ${temToken ? '<span class="ok">configurado</span>' : '<span class="no">FALTA</span>'} · Chave: ${temKey ? '<span class="ok">ativa</span>' : 'desativada'}
</div>

<div class="card star">
  <b>★★ VARREDURA completa — 1 clique</b> &nbsp;[só leitura / GET]<br>
  Dispara ~22 endpoints candidatos nos hosts <code>envios</code> e público com o token e resume tudo.
  Procura o "listar" e o "gerar" que aceitem token. <b>405</b> numa rota de gerar = ela existe e quer POST.
  <div style="margin-top:8px">
    <a class="btn green" href="/good-mm-diag/varredura${ks1}">▶ Rodar varredura</a>
    <span style="font-size:12px;color:#666">usa o pedido-teste 9768374 / lote 288348 / SRO AP115902313BR</span>
  </div>
  <div style="margin-top:8px">
    <a class="btn blue" href="/good-mm-diag/sonda-post${ks1}">▶ Sonda POST /api/v1/lote (segura)</a>
    <span style="font-size:12px;color:#666">descobre o schema do POST sem gerar nada</span>
  </div>
</div>

<div class="card hi">
  <b>Testes pontuais</b> &nbsp;[só leitura]<br>
  <div style="margin-top:8px">
    <a class="btn blue" href="/good-mm-diag/raw?url=${enc(URL_LOTES)}${ks}">Interna: listar lotes (sessão)</a>
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
      json(res, 200, { ok: true, modulo: 'good-mm-diag', versao: VERSAO, base: MM_BASE + MM_VERSAO, seller: SELLER,
        tokenConfigurado: !!process.env.GOOD_MM_TOKEN, chaveExigida: !!process.env.GOOD_MM_DIAG_KEY, ts: Date.now() });
      return true;
    }

    if (!chaveOk(urlObj)) { json(res, 401, { erro: 'chave inválida ou ausente (?k=)' }); return true; }

    // ★★ VARREDURA sistemática (todas GET, read-only)
    if (p === '/good-mm-diag/varredura') {
      const batch = (urlObj.searchParams.get('batch') || TESTE_BATCH).trim();
      const sro = (urlObj.searchParams.get('sro') || TESTE_SRO).trim();
      const pedidoMM = (urlObj.searchParams.get('pedido') || TESTE_PEDIDO).trim();
      const bateria = montarBateria({ batch, sro, pedidoMM });
      const linhas = [];
      for (const item of bateria) {
        const r = await reqRaw('GET', item.url);
        const v = veredito(r);
        const mostrarCorpo = (v.tag === 'json' || v.tag === 'lista' || v.tag === 'false');
        linhas.push({
          grupo: item.grupo, alvo: item.alvo, url: item.url,
          status: r.statusCode ?? null, tipo: r.contentType || null, bytes: r.length ?? null,
          veredito: v.txt, promissor: v.prom,
          corpo: mostrarCorpo ? (r.json ?? (r.text ? r.text.slice(0, 400) : null)) : null
        });
        await sleep(350);
      }
      const promissores = linhas.filter(l => l.promissor);
      json(res, 200, {
        varredura: VERSAO,
        parametros: { batch, sro, pedidoMM, seller: SELLER },
        aviso: 'Tudo GET (só leitura). 405 numa rota de GERAR = ela existe e quer POST. Os "controle" devem dar ✅ (provam que token+varredura funcionam).',
        PROMISSORES: promissores.length ? promissores : '(nenhum endpoint promissor — reforça que o gerar/listar via token talvez só venha pelo suporte)',
        todos: linhas
      });
      return true;
    }

    // ★ SONDA POST (segura) — descobre o que é o POST /api/v1/lote.
    // IMPORTANTE: nenhum corpo aqui contém "pedidos:{...}", então o endpoint de
    // GERAR NÃO consegue criar etiqueta — ele só pode devolver erro de validação
    // (que revela os campos exigidos) ou, se for rota de CONSULTA, os dados do lote.
    if (p === '/good-mm-diag/sonda-post') {
      const alvo = (urlObj.searchParams.get('url') || (ENVIOS + '/api/v1/lote')).trim();
      if (!/^https?:\/\//i.test(alvo)) { json(res, 400, { erro: 'url inválida' }); return true; }
      const pedidoMM = (urlObj.searchParams.get('pedido') || TESTE_PEDIDO).trim();
      const batch = (urlObj.searchParams.get('batch') || TESTE_BATCH).trim();
      const corpos = [
        { rotulo: 'vazio {}', body: {} },
        { rotulo: 'por batch', body: { batch: Number(batch) || batch } },
        { rotulo: 'por order_id', body: { order_id: pedidoMM } },
        { rotulo: 'por pedido', body: { pedido: pedidoMM } }
      ];
      const resultados = [];
      for (const c of corpos) {
        const r = await reqRaw('POST', alvo, { body: c.body });
        resultados.push({
          corpo_enviado: c.rotulo, body: c.body,
          status: r.statusCode ?? null, tipo: r.contentType || null, bytes: r.length ?? null,
          parece_PDF: r.parece_PDF ?? null,
          resposta: r.json ?? (r.text ? r.text.slice(0, 700) : null), erro: r.erro || null
        });
        await sleep(350);
      }
      json(res, 200, {
        sonda_post: VERSAO, alvo,
        seguranca: 'Nenhum corpo contém pedidos:{...}; logo NÃO há como gerar etiqueta aqui. No máximo: erro de validação (revela os campos) ou dados de consulta.',
        objetivo: 'Descobrir se POST /api/v1/lote é GERAR (e quais campos exige) ou CONSULTA (e devolve o lote/batch/file).',
        resultados
      });
      return true;
    }

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
