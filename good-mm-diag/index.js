'use strict';

/**
 * Módulo /good-mm-diag — DIAGNÓSTICO da API do Madeira Madeira (GOOD Import)
 * v2: corrige a leitura do 202 ("arquivo ainda não disponível") e adiciona uma
 * AÇÃO GUARDADA de "gerar etiqueta" (POST) pra confirmar a cadeia completa.
 *
 * TEMPORÁRIO / ferramenta de teste. Não toca na integração do Bling.
 *
 * Rotas (GET):
 *   GET /good-mm-diag/                      → página com botões/instruções
 *   GET /good-mm-diag/health                → status do módulo (não chama a MM)
 *   GET /good-mm-diag/pedidos?status=invoiced&limit=5   → lista pedidos (cru + resumo)   [LEITURA]
 *   GET /good-mm-diag/pedido?id=XXXX        → 1 pedido (id_pedido_item + SRO)             [LEITURA]
 *   GET /good-mm-diag/etiqueta?ref=XXXX     → baixa /madeiraenvios/etiquetas/{ref}/arquivo [LEITURA]
 *                                             (ref pode ser SRO, lote ou nº do pedido — testamos qual a API aceita)
 *   GET /good-mm-diag/gerar?pedido=XXXX&confirmar=SIM   → POST que GERA a etiqueta de verdade  [AÇÃO!]
 *
 * Segurança (opcional): se GOOD_MM_DIAG_KEY existir, tudo (menos /health) exige ?k=<valor>.
 *
 * Env: GOOD_MM_TOKEN (obrigatório), GOOD_MM_BASE (opcional), GOOD_MM_DIAG_KEY (opcional)
 */

const https = require('https');

const VERSAO = 'good-mm-diag v27/06 a2';

const MM_BASE = (process.env.GOOD_MM_BASE || 'https://marketplace.madeiramadeira.com.br').replace(/\/+$/, '');
const MM_VERSAO = '/v1';

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Requisição genérica à API MM. Resolve sempre (nunca lança).
// Retorna { ok, statusCode, contentType, length, json, text, headBytesHex, parece_PDF, parece_ZPL, erro, url }
function mmReq(method, path, { body = null, binario = false } = {}) {
  return new Promise((resolve) => {
    const token = process.env.GOOD_MM_TOKEN || '';
    if (!token) return resolve({ ok: false, erro: 'GOOD_MM_TOKEN não configurado no Render' });

    const url = MM_BASE + MM_VERSAO + path;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {
      'TOKENMM': token,
      'Accept': '*/*',
      'User-Agent': 'good-mm-diag/2.0'
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }

    const req = https.request(url, { method, agent, headers, timeout: 30000 }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const out = {
          statusCode: resp.statusCode,
          contentType: resp.headers['content-type'] || null,
          length: buf.length,
          url
        };
        const ehPDF = buf.slice(0, 5).toString('latin1') === '%PDF-';
        const ehZPL = buf.slice(0, 3).toString('latin1') === '^XA';
        // tenta JSON
        let parsed = null;
        if (ct.includes('json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) {} }

        out.parece_PDF = ehPDF;
        out.parece_ZPL = ehZPL;
        // Sucesso REAL: 2xx E (não é um JSON com success:false)
        const jsonDizFalhou = parsed && parsed.success === false;
        out.ok = (resp.statusCode >= 200 && resp.statusCode < 300) && !jsonDizFalhou;

        if (binario) {
          out.headBytesHex = buf.slice(0, 16).toString('hex');
          if (ct.includes('json') || ct.includes('text') || buf.length < 600) out.text = buf.toString('utf8').slice(0, 2000);
        } else if (parsed) {
          out.json = parsed;
        } else {
          out.text = buf.toString('utf8').slice(0, 4000);
        }
        resolve(out);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, erro: 'timeout (30s) chamando a MM', url }); });
    req.on('error', (e) => resolve({ ok: false, erro: e.message, url }));
    if (payload) req.write(payload);
    req.end();
  });
}
const mmGet  = (path, opts) => mmReq('GET', path, opts);
const mmPost = (path, body) => mmReq('POST', path, { body });

// ── Extração / resumo ────────────────────────────────────────────────
function extrairPedidos(j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'pedidos', 'result', 'results', 'items', 'content']) {
    if (Array.isArray(j[k])) return j[k];
  }
  return null;
}
function pedidoUnico(j) {
  // /pedido/id retorna { meta, data: {…} } (objeto, não array)
  if (j && j.data && !Array.isArray(j.data) && typeof j.data === 'object') return j.data;
  const lista = extrairPedidos(j);
  return Array.isArray(lista) ? lista[0] : (j && typeof j === 'object' ? j : null);
}
function itensDoPedido(p) {
  const itens = (p && (p.skus || p.itens || p.items)) || [];
  return Array.isArray(itens) ? itens : [];
}
function srosDoPedido(p) {
  const envio = (p && (p.envio || (p.tracking && p.tracking.envio))) || [];
  return (Array.isArray(envio) ? envio : [])
    .map(e => e.codigo_rastreio ?? e.codigoRastreio)
    .filter(Boolean);
}
function resumoPedido(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id_pedido: p.id_pedido ?? p.idPedido ?? p.id ?? null,
    pedido_mm: p.pedido_mm ?? null,
    status: p.status ?? null,
    itens_resumo: itensDoPedido(p).map(it => ({
      id_pedido_item: it.id_pedido_item ?? it.idPedidoItem ?? it.id ?? null,
      sku: it.sku ?? null,
      skuseller: it.skuseller ?? null,
      quantidade: it.quantidade ?? null,
      madeira_envios: it.madeira_envios ?? null
    })),
    sros: srosDoPedido(p)
  };
}

function chaveOk(urlObj) {
  const exigida = process.env.GOOD_MM_DIAG_KEY || '';
  if (!exigida) return true;
  return urlObj.searchParams.get('k') === exigida;
}

// ── Página HTML ──────────────────────────────────────────────────────
function paginaHtml() {
  const temToken = !!process.env.GOOD_MM_TOKEN;
  const temKey = !!process.env.GOOD_MM_DIAG_KEY;
  const ksuffix = temKey ? '&k=SUA_CHAVE' : '';
  const askKey = temKey ? "var k=prompt('Chave do diagnóstico (k):','');if(k)url+='&k='+encodeURIComponent(k);else return;" : '';
  return `<!doctype html><html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico MM — GOOD</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;max-width:780px;margin:24px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}.v{color:#888;font-size:12px;margin-bottom:16px}
  .card{border:1px solid #e3e3e3;border-radius:10px;padding:14px 16px;margin:12px 0}
  code{background:#f4f4f5;padding:2px 6px;border-radius:5px;font-size:13px}
  a.btn{display:inline-block;margin:6px 8px 6px 0;padding:9px 14px;background:#EF5B25;color:#fff;text-decoration:none;border-radius:7px;font-weight:600;font-size:14px;cursor:pointer}
  a.btn.danger{background:#c0392b}
  .warn{background:#fff6e9;border-color:#f1c27d}.danger-box{background:#fdecea;border-color:#e6736a}
  .ok{color:#157347;font-weight:600}.no{color:#b02a37;font-weight:600}
  input{padding:8px;border:1px solid #ccc;border-radius:6px;width:170px}label{font-size:13px;color:#444}
</style></head><body>
<h1>🩺 Diagnóstico Madeira Madeira — GOOD Import</h1>
<div class="v">${VERSAO} · base <code>${MM_BASE}${MM_VERSAO}</code></div>

<div class="card ${temToken ? '' : 'warn'}">
  Token: ${temToken ? '<span class="ok">configurado</span>' : '<span class="no">FALTA</span> — defina <code>GOOD_MM_TOKEN</code>'} ·
  Chave: ${temKey ? '<span class="ok">ativa</span>' : 'desativada (modo teste)'}
</div>

<div class="card">
  <b>1) Listar pedidos</b> &nbsp;[só leitura]<br>
  <a class="btn" href="/good-mm-diag/pedidos?status=invoiced&limit=5${ksuffix}">NF emitida (status 6)</a>
  <a class="btn" href="/good-mm-diag/pedidos?status=shipped&limit=5${ksuffix}">Enviados (já têm SRO)</a>
</div>

<div class="card">
  <b>2) Abrir 1 pedido</b> &nbsp;[só leitura]<br>
  <label>nº do pedido (MM): <input id="pid" placeholder="ex: 9791508"></label>
  <a class="btn" onclick="go('pedido','id','pid')">Abrir</a>
</div>

<div class="card">
  <b>3) Baixar arquivo da etiqueta</b> &nbsp;[só leitura] — testa SRO, nº do lote OU nº do pedido:<br>
  <label>ref: <input id="ref" placeholder="SRO, lote ou pedido"></label>
  <a class="btn" onclick="go('etiqueta','ref','ref')">Baixar/testar</a>
  <p style="font-size:12px;color:#777">Só lê um arquivo já existente. Não gera etiqueta nem custa nada.</p>
</div>

<div class="card danger-box">
  <b>4) GERAR etiqueta via API</b> &nbsp;<span class="no">[AÇÃO REAL — gera etiqueta de postagem!]</span><br>
  Equivale a clicar "Gerar etiqueta" no Portal. Use só num pedido <b>sem etiqueta ainda</b> que você vai postar.
  <b>Não</b> gere também no Portal pro mesmo pedido (sairia etiqueta dobrada).<br>
  <label>nº do pedido (MM): <input id="gpid" placeholder="ex: 9791508"></label>
  <a class="btn danger" onclick="gerar()">Gerar etiqueta (de verdade)</a>
</div>

<script>
  function go(rota, param, inputId){
    var v=document.getElementById(inputId).value.trim();
    if(!v){alert('Preencha o valor');return;}
    var url='/good-mm-diag/'+rota+'?'+param+'='+encodeURIComponent(v);
    ${askKey}
    window.location.href=url;
  }
  function gerar(){
    var v=document.getElementById('gpid').value.trim();
    if(!v){alert('Preencha o nº do pedido');return;}
    if(!confirm('GERAR etiqueta de verdade pro pedido '+v+'?\\n\\nIsso emite a etiqueta de postagem na Madeira Envios (igual clicar Gerar no Portal). Não gere também no Portal pra esse pedido.'))return;
    var url='/good-mm-diag/gerar?pedido='+encodeURIComponent(v)+'&confirmar=SIM';
    ${askKey}
    window.location.href=url;
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

    if (p === '/good-mm-diag' || p === '/good-mm-diag/') { html(res, 200, paginaHtml()); return true; }

    if (p === '/good-mm-diag/health') {
      json(res, 200, {
        ok: true, modulo: 'good-mm-diag', versao: VERSAO, base: MM_BASE + MM_VERSAO,
        tokenConfigurado: !!process.env.GOOD_MM_TOKEN, chaveExigida: !!process.env.GOOD_MM_DIAG_KEY, ts: Date.now()
      });
      return true;
    }

    if (!chaveOk(urlObj)) { json(res, 401, { erro: 'chave inválida ou ausente (?k=)' }); return true; }

    // Lista de pedidos por status [LEITURA]
    if (p === '/good-mm-diag/pedidos') {
      const map = { new:'new', novo:'new', approved:'approved', aprovado:'approved', received:'received', recebido:'received',
        invoiced:'invoiced', nf:'invoiced', shipped:'shipped', enviado:'shipped', delivered:'delivered', entregue:'delivered',
        cancelled:'cancelled', cancelado:'cancelled' };
      const status = map[(urlObj.searchParams.get('status') || 'invoiced').toLowerCase()] || 'invoiced';
      let limit = parseInt(urlObj.searchParams.get('limit') || '5', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 5; if (limit > 20) limit = 20;
      const r = await mmGet(`/pedido/${status}/limit=${limit}&offset=0`);
      const pedidos = r.json ? extrairPedidos(r.json) : null;
      json(res, 200, {
        chamada: { status, limit, url: r.url },
        resposta: { ok: r.ok, statusCode: r.statusCode, erro: r.erro || null },
        resumo: Array.isArray(pedidos) ? pedidos.slice(0, limit).map(resumoPedido) : '(veja o cru)',
        cru: r.json ?? r.text ?? null
      });
      return true;
    }

    // 1 pedido por id [LEITURA]
    if (p === '/good-mm-diag/pedido') {
      const id = (urlObj.searchParams.get('id') || '').trim();
      if (!id) { json(res, 400, { erro: 'informe ?id=' }); return true; }
      const r = await mmGet(`/pedido/id/${encodeURIComponent(id)}`);
      const ped = r.json ? pedidoUnico(r.json) : null;
      json(res, 200, {
        chamada: { id, url: r.url },
        resposta: { ok: r.ok, statusCode: r.statusCode, erro: r.erro || null },
        resumo: resumoPedido(ped),
        cru: r.json ?? r.text ?? null
      });
      return true;
    }

    // Baixar arquivo da etiqueta por ref (SRO/lote/pedido) [LEITURA]
    if (p === '/good-mm-diag/etiqueta') {
      const ref = (urlObj.searchParams.get('ref') || urlObj.searchParams.get('sro') || '').trim();
      if (!ref) { json(res, 400, { erro: 'informe ?ref= (SRO, lote ou pedido)' }); return true; }
      const r = await mmGet(`/madeiraenvios/etiquetas/${encodeURIComponent(ref)}/arquivo`, { binario: true });
      const baixou = r.ok && (r.parece_PDF || r.parece_ZPL);
      json(res, 200, {
        chamada: { ref, url: r.url },
        resultado: {
          baixou_arquivo: baixou, statusCode: r.statusCode, contentType: r.contentType,
          tamanho_bytes: r.length ?? null, parece_PDF: r.parece_PDF ?? null, parece_ZPL: r.parece_ZPL ?? null,
          primeiros_bytes_hex: r.headBytesHex ?? null, corpo: r.text ?? null, erro: r.erro || null
        },
        interpretacao: baixou
          ? `✅ BAIXOU o arquivo (${r.parece_PDF ? 'PDF' : 'ZPL'}) usando ref="${ref}". É essa a chave de download. 🎉`
          : (r.statusCode === 202
              ? 'Status 202 = "ainda não disponível" por essa ref. Tente outra ref (lote/pedido) ou gere via API (item 4).'
              : 'Não baixou — veja statusCode/corpo. (401/403 = token/escopo; 404 = ref/endpoint errado.)')
      });
      return true;
    }

    // GERAR etiqueta (POST) [AÇÃO!]
    if (p === '/good-mm-diag/gerar') {
      const pedido = (urlObj.searchParams.get('pedido') || '').trim();
      const confirmar = (urlObj.searchParams.get('confirmar') || '').trim().toUpperCase();
      if (!pedido) { json(res, 400, { erro: 'informe ?pedido=' }); return true; }
      if (confirmar !== 'SIM') {
        json(res, 200, { aviso: 'Ação NÃO executada. Para gerar de verdade, inclua &confirmar=SIM. (Isso emite uma etiqueta real.)', pedido });
        return true;
      }

      // 1) lê o pedido p/ achar os itens
      const rp = await mmGet(`/pedido/id/${encodeURIComponent(pedido)}`);
      const ped = rp.json ? pedidoUnico(rp.json) : null;
      const itens = itensDoPedido(ped);
      const idsItens = itens.map(it => it.id_pedido_item ?? it.idPedidoItem ?? it.id).filter(Boolean);
      if (!idsItens.length) {
        json(res, 200, { erro: 'não achei itens (id_pedido_item) nesse pedido — confira o nº', pedido, leitura: { ok: rp.ok, statusCode: rp.statusCode, cru: rp.json ?? rp.text ?? null } });
        return true;
      }

      // 2) POST solicitando a etiqueta
      const body = { itens: idsItens.map(id => ({ id })) };
      const rpost = await mmPost('/madeiraenvios/etiquetas', body);

      // 3) espera um pouco e relê o pedido p/ ver se já apareceu SRO
      await sleep(6000);
      const rp2 = await mmGet(`/pedido/id/${encodeURIComponent(pedido)}`);
      const ped2 = rp2.json ? pedidoUnico(rp2.json) : null;
      const sros = srosDoPedido(ped2);

      json(res, 200, {
        pedido,
        itens_enviados: idsItens,
        corpo_enviado: body,
        post: {
          ok: rpost.ok, statusCode: rpost.statusCode, contentType: rpost.contentType,
          resposta: rpost.json ?? rpost.text ?? null, erro: rpost.erro || null
        },
        sros_apos_6s: sros,
        proximo_passo: sros.length
          ? `Apareceu SRO: ${sros.join(', ')}. Agora teste o download no item 3 com essa ref (e também com o nº do pedido/lote).`
          : 'Ainda sem SRO após 6s (normal — leva 30s a 2min). Espere 1-2 min, reabra o pedido no item 2 pra pegar o SRO, e baixe no item 3. Também deve aparecer um novo lote na aba "Baixar" do Portal.'
      });
      return true;
    }

    json(res, 404, { erro: 'rota de diagnóstico não encontrada', path: p });
    return true;
  };
}

module.exports = {
  id: 'good-mm-diag',
  nome: 'GOOD Madeira Madeira (diagnóstico read-only + gerar guardado)',
  rotinas: {},
  crons: {},
  routes
};
