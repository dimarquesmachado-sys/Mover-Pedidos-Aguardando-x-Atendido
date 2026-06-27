'use strict';

/**
 * Módulo /good-mm-diag — DIAGNÓSTICO (somente leitura) da API do Madeira Madeira
 * Objetivo: confirmar, com o TOKENMM da GOOD Import, se a API responde e se o
 * endpoint de etiqueta do Madeira Envios está ativo — ANTES de construir o
 * módulo definitivo. NÃO faz nenhuma ação que mude dados (só GET).
 *
 * IMPORTANTE: este módulo é TEMPORÁRIO (ferramenta de teste). Pode ser removido
 * depois. Não toca na integração do Bling, não dispara geração de etiqueta nova.
 *
 * Rotas (todas GET):
 *   GET /good-mm-diag/                      → página com botões/instruções
 *   GET /good-mm-diag/health                → status do módulo (sem chamar a MM)
 *   GET /good-mm-diag/pedidos?status=invoiced&limit=5   → lista pedidos (cru + resumo)
 *   GET /good-mm-diag/pedido?id=XXXX        → 1 pedido (cru + resumo: id_pedido_item, SRO)
 *   GET /good-mm-diag/etiqueta?sro=XXXX     → metadados do arquivo da etiqueta (NÃO baixa o binário)
 *
 * Status de pedido aceitos em ?status=:
 *   new, approved, received, invoiced (NF emitida=6), shipped (enviado=7),
 *   delivered, cancelled
 *
 * Segurança (opcional): se a env GOOD_MM_DIAG_KEY estiver definida, todas as
 * rotas (menos /health) exigem ?k=<valor>. Recomendado, pois os pedidos trazem
 * dados do cliente. Se a env não existir, funciona sem chave (modo teste rápido).
 *
 * Env vars:
 *   GOOD_MM_TOKEN     → o TOKENMM da GOOD (Portal MM → Administração > Integração)
 *   GOOD_MM_BASE      → (opcional) base da API. Default produção.
 *   GOOD_MM_DIAG_KEY  → (opcional) chave de acesso a este diagnóstico
 */

const https = require('https');

const VERSAO = 'good-mm-diag v27/06 a1';

// Base da API do Madeira Madeira (produção). Sandbox: war-machine-sandbox.madeiramadeira.com.br
const MM_BASE = (process.env.GOOD_MM_BASE || 'https://marketplace.madeiramadeira.com.br').replace(/\/+$/, '');
const MM_VERSAO = '/v1';

// Agente HTTPS forçando IPv4 (esta instância não tem rota IPv6) e sem keep-alive,
// mesmo padrão de hardening usado nos outros módulos (Shopee/Supabase) p/ evitar
// "Premature close".
const agent = new https.Agent({ family: 4, keepAlive: false });

// ── Helpers HTTP locais ──────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// Faz uma requisição GET na API MM. Resolve sempre (nunca lança) com um objeto
// { ok, statusCode, contentType, length, json, text, headBytesHex, erro }.
function mmGet(path, { binario = false } = {}) {
  return new Promise((resolve) => {
    const token = process.env.GOOD_MM_TOKEN || '';
    if (!token) {
      return resolve({ ok: false, erro: 'GOOD_MM_TOKEN não configurado no Render' });
    }
    const url = MM_BASE + MM_VERSAO + path;
    const opts = {
      method: 'GET',
      agent,
      headers: {
        'TOKENMM': token,
        'Accept': '*/*',
        'User-Agent': 'good-mm-diag/1.0'
      },
      timeout: 20000
    };
    const req = https.request(url, opts, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const out = {
          ok: resp.statusCode >= 200 && resp.statusCode < 300,
          statusCode: resp.statusCode,
          contentType: resp.headers['content-type'] || null,
          length: buf.length,
          url
        };
        if (binario) {
          // NÃO devolve o binário inteiro — só o suficiente p/ identificar o formato.
          out.headBytesHex = buf.slice(0, 16).toString('hex');
          out.pareceePDF = buf.slice(0, 5).toString('latin1') === '%PDF-';
          out.pareceZPL = buf.slice(0, 3).toString('latin1').startsWith('^XA') || buf.slice(0, 2).toString('latin1') === '^X';
          // Se vier JSON (erro), mostra o texto.
          if (ct.includes('json') || ct.includes('text')) out.text = buf.toString('utf8').slice(0, 2000);
        } else if (ct.includes('json')) {
          try { out.json = JSON.parse(buf.toString('utf8')); }
          catch { out.text = buf.toString('utf8').slice(0, 4000); }
        } else {
          out.text = buf.toString('utf8').slice(0, 4000);
        }
        resolve(out);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, erro: 'timeout (20s) chamando a MM', url }); });
    req.on('error', (e) => resolve({ ok: false, erro: e.message, url }));
    req.end();
  });
}

// Tenta extrair a lista de pedidos de uma resposta (formato não documentado;
// procura nas chaves mais prováveis).
function extrairPedidos(j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'pedidos', 'result', 'results', 'items', 'content']) {
    if (Array.isArray(j[k])) return j[k];
  }
  return null;
}

// Monta um resumo amigável de 1 pedido, destacando o que interessa pra etiqueta.
function resumoPedido(p) {
  if (!p || typeof p !== 'object') return null;
  const itens = p.skus || p.itens || p.items || [];
  const envio = p.envio || (p.tracking && p.tracking.envio) || [];
  return {
    id_pedido: p.id_pedido ?? p.idPedido ?? p.id ?? null,
    pedido_mm: p.pedido_mm ?? null,
    status: p.status ?? null,
    madeira_envios: p.madeira_envios ?? null,
    itens_resumo: (Array.isArray(itens) ? itens : []).map(it => ({
      id_pedido_item: it.id_pedido_item ?? it.idPedidoItem ?? it.id ?? null,
      sku: it.sku ?? null,
      skuseller: it.skuseller ?? it.sku_seller ?? null,
      quantidade: it.quantidade ?? null,
      madeira_envios: it.madeira_envios ?? null,
      transportadora: it.transportadora_nome ?? null
    })),
    envio_resumo: (Array.isArray(envio) ? envio : []).map(e => ({
      codigo_rastreio_SRO: e.codigo_rastreio ?? e.codigoRastreio ?? null,
      transportadora: e.nome_transportadora ?? e.nomeTransportadora ?? null,
      url_rastreio: e.url_rastreio ?? e.urlRastreio ?? null
    }))
  };
}

// Valida a chave de acesso opcional do diagnóstico.
function chaveOk(urlObj) {
  const exigida = process.env.GOOD_MM_DIAG_KEY || '';
  if (!exigida) return true; // sem chave configurada → libera (modo teste)
  return urlObj.searchParams.get('k') === exigida;
}

// ── Página HTML (instruções + botões) ────────────────────────────────
function paginaHtml() {
  const temToken = !!process.env.GOOD_MM_TOKEN;
  const temKey = !!process.env.GOOD_MM_DIAG_KEY;
  const ksuffix = temKey ? '&k=SUA_CHAVE' : '';
  return `<!doctype html><html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico MM — GOOD</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;max-width:760px;margin:24px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}
  .v{color:#888;font-size:12px;margin-bottom:16px}
  .card{border:1px solid #e3e3e3;border-radius:10px;padding:14px 16px;margin:12px 0}
  code{background:#f4f4f5;padding:2px 6px;border-radius:5px;font-size:13px}
  a.btn{display:inline-block;margin:6px 8px 6px 0;padding:9px 14px;background:#EF5B25;color:#fff;
        text-decoration:none;border-radius:7px;font-weight:600;font-size:14px}
  .warn{background:#fff6e9;border-color:#f1c27d}
  .ok{color:#157347;font-weight:600}.no{color:#b02a37;font-weight:600}
  input{padding:8px;border:1px solid #ccc;border-radius:6px;width:160px}
  label{font-size:13px;color:#444}
</style></head><body>
<h1>🩺 Diagnóstico Madeira Madeira — GOOD Import</h1>
<div class="v">${VERSAO} · base <code>${MM_BASE}${MM_VERSAO}</code></div>

<div class="card ${temToken ? '' : 'warn'}">
  Token configurado: ${temToken ? '<span class="ok">SIM</span>' : '<span class="no">NÃO</span> — defina <code>GOOD_MM_TOKEN</code> no Render'}<br>
  Chave do diagnóstico: ${temKey ? '<span class="ok">ATIVA</span> (use <code>&amp;k=...</code> nos links)' : 'desativada (modo teste — recomendo definir <code>GOOD_MM_DIAG_KEY</code>)'}
</div>

<div class="card">
  <b>1) Listar pedidos com NF emitida</b> (status 6 — onde a etiqueta libera):<br>
  <a class="btn" href="/good-mm-diag/pedidos?status=invoiced&limit=5${ksuffix}">Ver NF emitida</a>
  <a class="btn" href="/good-mm-diag/pedidos?status=shipped&limit=5${ksuffix}">Ver enviados (já têm SRO)</a>
</div>

<div class="card">
  <b>2) Abrir 1 pedido</b> (mostra <code>id_pedido_item</code> e o SRO):<br>
  <label>id do pedido: <input id="pid" placeholder="ex: 12345"></label>
  <a class="btn" href="#" onclick="g('pedido','id','pid');return false">Abrir pedido</a>
</div>

<div class="card">
  <b>3) Testar o arquivo da etiqueta</b> (read-only — só funciona em pedido que JÁ tem SRO):<br>
  <label>SRO/rastreio: <input id="sro" placeholder="ex: AA123456789BR"></label>
  <a class="btn" href="#" onclick="g('etiqueta','sro','sro');return false">Testar etiqueta</a>
  <p style="font-size:12px;color:#777">Isto só lê o arquivo de uma etiqueta que já existe. Não gera etiqueta nova nem custa nada.</p>
</div>

<script>
  var K = ${JSON.stringify(temKey ? '' : '')};
  function g(rota, param, inputId){
    var v = document.getElementById(inputId).value.trim();
    if(!v){ alert('Preencha o valor'); return; }
    var url = '/good-mm-diag/'+rota+'?'+param+'='+encodeURIComponent(v);
    ${temKey ? "var k=prompt('Chave do diagnóstico (k):','');if(k)url+='&k='+encodeURIComponent(k);" : ''}
    window.location.href = url;
  }
</script>
</body></html>`;
}

// ── Router ───────────────────────────────────────────────────────────
function routes(/* readBody */) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    const method = req.method;

    if (p !== '/good-mm-diag' && !p.startsWith('/good-mm-diag/')) return false;
    if (method !== 'GET') { json(res, 405, { erro: 'somente GET neste diagnóstico' }); return true; }

    // Raiz → página
    if (p === '/good-mm-diag' || p === '/good-mm-diag/') {
      html(res, 200, paginaHtml());
      return true;
    }

    // Health (aberto, não chama a MM)
    if (p === '/good-mm-diag/health') {
      json(res, 200, {
        ok: true,
        modulo: 'good-mm-diag',
        versao: VERSAO,
        base: MM_BASE + MM_VERSAO,
        tokenConfigurado: !!process.env.GOOD_MM_TOKEN,
        chaveExigida: !!process.env.GOOD_MM_DIAG_KEY,
        ts: Date.now()
      });
      return true;
    }

    // Daqui pra baixo, exige chave (se configurada)
    if (!chaveOk(urlObj)) { json(res, 401, { erro: 'chave inválida ou ausente (?k=)' }); return true; }

    // Lista de pedidos por status
    if (p === '/good-mm-diag/pedidos') {
      const statusMap = {
        new: 'new', novo: 'new',
        approved: 'approved', aprovado: 'approved',
        received: 'received', recebido: 'received',
        invoiced: 'invoiced', nf: 'invoiced', 'nf-emitida': 'invoiced',
        shipped: 'shipped', enviado: 'shipped',
        delivered: 'delivered', entregue: 'delivered',
        cancelled: 'cancelled', cancelado: 'cancelled'
      };
      const raw = (urlObj.searchParams.get('status') || 'invoiced').toLowerCase();
      const status = statusMap[raw] || 'invoiced';
      let limit = parseInt(urlObj.searchParams.get('limit') || '5', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 5;
      if (limit > 20) limit = 20;

      // Formato de path do SDK: /pedido/<status>/limit=X&offset=0
      const r = await mmGet(`/pedido/${status}/limit=${limit}&offset=0`);
      const pedidos = r.json ? extrairPedidos(r.json) : null;
      json(res, 200, {
        chamada: { status, limit, url: r.url },
        resposta: { ok: r.ok, statusCode: r.statusCode, contentType: r.contentType, erro: r.erro || null },
        resumo: Array.isArray(pedidos) ? pedidos.slice(0, limit).map(resumoPedido) : '(não consegui localizar a lista — veja o cru abaixo)',
        cru: r.json ?? r.text ?? null
      });
      return true;
    }

    // 1 pedido por id
    if (p === '/good-mm-diag/pedido') {
      const id = (urlObj.searchParams.get('id') || '').trim();
      if (!id) { json(res, 400, { erro: 'informe ?id=' }); return true; }
      const r = await mmGet(`/pedido/id/${encodeURIComponent(id)}`);
      let pedido = null;
      if (r.json) {
        const lista = extrairPedidos(r.json);
        pedido = Array.isArray(lista) ? lista[0] : r.json;
      }
      json(res, 200, {
        chamada: { id, url: r.url },
        resposta: { ok: r.ok, statusCode: r.statusCode, contentType: r.contentType, erro: r.erro || null },
        resumo: resumoPedido(pedido),
        cru: r.json ?? r.text ?? null
      });
      return true;
    }

    // Arquivo da etiqueta por SRO (read-only — só metadados)
    if (p === '/good-mm-diag/etiqueta') {
      const sro = (urlObj.searchParams.get('sro') || '').trim();
      if (!sro) { json(res, 400, { erro: 'informe ?sro=' }); return true; }
      const r = await mmGet(`/madeiraenvios/etiquetas/${encodeURIComponent(sro)}/arquivo`, { binario: true });
      json(res, 200, {
        chamada: { sro, url: r.url },
        resultado: {
          ok: r.ok,
          statusCode: r.statusCode,
          contentType: r.contentType,
          tamanho_bytes: r.length ?? null,
          parece_PDF: r.pareceePDF ?? null,
          parece_ZPL: r.pareceZPL ?? null,
          primeiros_bytes_hex: r.headBytesHex ?? null,
          texto_se_erro: r.text ?? null,
          erro: r.erro || null
        },
        interpretacao: r.ok
          ? 'SUCESSO: o endpoint de etiqueta respondeu com um arquivo. A automação é viável via API. 🎉'
          : 'Não retornou arquivo — veja statusCode/erro acima. (401/403 = token/escopo; 404 = endpoint/SRO; outro = confirmar com o suporte.)'
      });
      return true;
    }

    json(res, 404, { erro: 'rota de diagnóstico não encontrada', path: p });
    return true;
  };
}

module.exports = {
  id: 'good-mm-diag',
  nome: 'GOOD Madeira Madeira (diagnóstico read-only)',
  rotinas: {},
  crons: {},
  routes
};
