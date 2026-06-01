'use strict';
// ──────────────────────────────────────────────────────────────────────
// PROBE (somente leitura) — testa se o Render consegue chamar a API
// interna do Bling (vendas.lojas.virtuais) usando o cookie de sessão.
//
// O cookie é colado pela página /cookie-setup (cola o cURL inteiro que o
// servidor extrai sozinho) e fica salvo em disco. Fallback: env BLING_COOKIE.
// ──────────────────────────────────────────────────────────────────────

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, 'data', 'bling_cookie.txt');

const URL_BLING = 'https://www.bling.com.br/services/vendas.lojas.virtuais.server.php?f=obterListaDePedidos';
const ID_INTEGRACAO   = process.env.STAGING_ID_INTEGRACAO || '5237';
const ID_LOJA         = process.env.STAGING_ID_LOJA       || '203146903';
const TIPO_INTEGRACAO = 'MercadoLivre';
const JANELA_DIAS     = parseInt(process.env.STAGING_JANELA_DIAS || '15');

// ── Cookie: extrair / salvar / ler ────────────────────────────────────

// Aceita: cURL bash (-b '...'), cURL cmd (-b ^"..^"), header (-H 'cookie: ..'),
// ou o cookie cru colado direto.
function extrairCookie(texto) {
  if (!texto) return '';
  let t = String(texto).trim();
  const tryMatch = (s) => {
    let m =
      s.match(/-b\s+'([^']+)'/) || s.match(/-b\s+"([^"]+)"/) ||
      s.match(/--cookie\s+'([^']+)'/) || s.match(/--cookie\s+"([^"]+)"/);
    if (m) return m[1];
    m = s.match(/-H\s+'cookie:\s*([^']+)'/i) || s.match(/-H\s+"cookie:\s*([^"]+)"/i);
    if (m) return m[1];
    m = s.match(/(?:^|\n)\s*cookie:\s*([^\n'"]+)/i);
    if (m) return m[1];
    return null;
  };
  let achado = tryMatch(t);
  if (!achado) achado = tryMatch(t.replace(/\^/g, '')); // cURL do cmd usa ^"
  if (achado) return achado.trim();
  // já é o cookie cru?
  if (t.includes('=') && t.includes(';')) return t.replace(/^cookie:\s*/i, '').trim();
  return t;
}

function salvarCookie(cookie) {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, cookie, 'utf8');
}

function lerCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch (e) { /* ignore */ }
  return process.env.BLING_COOKIE || '';
}

// ── Montagem do payload xajax ─────────────────────────────────────────
function periodoBR() {
  const fim = new Date();
  const ini = new Date();
  ini.setDate(ini.getDate() - JANELA_DIAS);
  const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return { dataInicial: fmt(ini), dataFinal: fmt(fim) };
}

function montarFiltro(dataInicial, dataFinal) {
  const e = (k, v) => `<e><k>${k}</k><v>${v}</v></e>`;
  return '<xjxobj>'
    + e('numero', '') + e('situacao', '') + e('situacaoVenda', 'todas')
    + e('dataInicial', dataInicial) + e('dataFinal', dataFinal)
    + e('ordemVenda', 'date_desc') + e('ordemVenda2', '') + e('ordemVenda3', '')
    + e('apelido', 'undefined') + e('shipmentType', 'undefined')
    + e('pedidosImportados', 'S') + e('ordem', 'date_desc')
    + e('page', '0') + e('paginacao', '') + e('idFormaPagamento', 'undefined')
    + '</xjxobj>';
}

// ── PROBE de leitura ──────────────────────────────────────────────────
async function listarStaging() {
  const cookie = lerCookie();
  if (!cookie) return { erro: 'Cookie não configurado — abra /cookie-setup e cole o cURL' };

  const { dataInicial, dataFinal } = periodoBR();
  const filtro = montarFiltro(dataInicial, dataFinal);

  const params = new URLSearchParams();
  params.append('xajax', 'obterListaDePedidos');
  params.append('xajaxr', Date.now().toString());
  params.append('xajaxargs[]', ID_INTEGRACAO);
  params.append('xajaxargs[]', ID_LOJA);
  params.append('xajaxargs[]', TIPO_INTEGRACAO);
  params.append('xajaxargs[]', filtro);
  params.append('xajaxargs[]', 'P');

  const resp = await fetch(URL_BLING, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.bling.com.br',
      'Referer': 'https://www.bling.com.br/vendas.lojas.virtuais.php',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9'
    },
    body: params.toString()
  });

  const texto = await resp.text();
  const contentType = resp.headers.get('content-type') || '';
  let json = null;
  try { json = JSON.parse(texto); } catch (e) { /* não é JSON */ }

  const txtLower = texto.toLowerCase();
  const pareceBloqueio =
    !json ||
    txtLower.includes('cloudflare') ||
    txtLower.includes('<!doctype html') ||
    txtLower.includes('cf-') ||
    txtLower.includes('faça login') ||
    txtLower.includes('vendas.php#login');

  let pendentes = null, exemplos = null;
  if (json && Array.isArray(json.data)) {
    const naoImportados = json.data.filter(d => String(d.idImportado) === '0');
    pendentes = naoImportados.length;
    exemplos = naoImportados.slice(0, 5).map(d => ({ numero: d.numero, idImportado: d.idImportado, dataPedido: d.dataPedido }));
  }

  return {
    veredicto: pareceBloqueio
      ? '❌ PARECE BLOQUEADO/SEM SESSÃO — caminho A pode não funcionar do Render'
      : '✅ PASSOU — o Render falou com a API interna do Bling!',
    httpStatus: resp.status,
    contentType,
    pareceBloqueio,
    totalNaLista: json && Array.isArray(json.data) ? json.data.length : null,
    pedidosNaoImportados: pendentes,
    exemplos,
    amostraResposta: texto.slice(0, 500)
  };
}


// headers de navegador usados nas chamadas internas
function headersBling(cookie) {
  return {
    'Cookie': cookie,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.bling.com.br',
    'Referer': 'https://www.bling.com.br/vendas.lojas.virtuais.php',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9'
  };
}

// Importa UM pedido (dispara o "Importar Pedido para Vendas" nativo do Bling)
async function importarUm(numero) {
  const cookie = lerCookie();
  if (!cookie) return { ok: false, erro: 'Cookie não configurado — abra /cookie-setup' };

  const params = new URLSearchParams();
  params.append('xajax', 'importarPedidoSelecionado');
  params.append('xajaxr', Date.now().toString());
  params.append('xajaxargs[]', TIPO_INTEGRACAO);
  params.append('xajaxargs[]', ID_INTEGRACAO);
  params.append('xajaxargs[]', String(numero));
  params.append('xajaxargs[]', ID_LOJA);
  params.append('xajaxargs[]', 'P');
  params.append('xajaxargs[]', '');
  params.append('xajaxargs[]', '0');

  const resp = await fetch('https://www.bling.com.br/services/vendas.lojas.virtuais.server.php?f=importarPedidoSelecionado', {
    method: 'POST', headers: headersBling(cookie), body: params.toString()
  });
  const texto = await resp.text();
  const low = texto.toLowerCase();

  if (low.includes('login?r=') || low.includes('window.location.href')) {
    return { ok: false, motivo: 'SESSAO_EXPIRADA — recole o cookie', httpStatus: resp.status, amostra: texto.slice(0, 200) };
  }
  const m = texto.match(/vendas\.php#edit\/(\d+)/);
  const jaImportado = /j(á|a) importado/i.test(texto) || !!m;
  return {
    ok: jaImportado,
    numero,
    pedidoBlingId: m ? m[1] : null,
    veredicto: jaImportado
      ? '✅ IMPORTADO pelo Bling (nativo) — confira no vendas.lojas.virtuais e veja se gerou NF/endereço'
      : '⚠️ Resposta inesperada — veja a amostra',
    httpStatus: resp.status,
    amostra: texto.slice(0, 500)
  };
}

// ── Página HTML pra colar o cURL ──────────────────────────────────────
function paginaSetup(msg) {
  const cookieAtual = lerCookie();
  const status = cookieAtual
    ? `<p style="color:green">✓ Já existe um cookie salvo (${cookieAtual.length} caracteres). Cole de novo pra atualizar.</p>`
    : `<p style="color:#b00">Nenhum cookie salvo ainda.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cookie Bling</title>
  <style>body{font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 16px}
  textarea{width:100%;height:200px;font-family:monospace;font-size:12px}
  button{padding:10px 20px;font-size:15px;cursor:pointer;margin-top:10px}
  .ok{color:green}.err{color:#b00}</style></head><body>
  <h2>Cookie do Bling (Girassol)</h2>
  ${status}
  ${msg || ''}
  <ol>
    <li>No Bling logado, F12 → aba <b>Rede</b> → dá um refresh</li>
    <li>Botão direito numa requisição <b>vendas.server.php</b> → Copiar → <b>Copiar como cURL (bash)</b></li>
    <li>Cola <b>tudo</b> na caixa abaixo (não precisa achar o cookie — eu extraio)</li>
    <li>Clica em Salvar</li>
  </ol>
  <textarea id="curl" placeholder="cola aqui o cURL inteiro..."></textarea><br>
  <button onclick="salvar()">Salvar cookie</button>
  <p id="res"></p>
  <script>
  async function salvar(){
    const t=document.getElementById('curl').value;
    const r=await fetch('/cookie-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({curl:t})});
    const d=await r.json();
    document.getElementById('res').innerHTML = d.ok
      ? '<span class=ok>✓ Cookie salvo ('+d.tamanho+' caracteres). Agora abra <a href=/debug/staging-list>/debug/staging-list</a></span>'
      : '<span class=err>✗ '+(d.erro||'erro')+'</span>';
  }
  </script>
  </body></html>`;
}

module.exports = { listarStaging, importarUm, extrairCookie, salvarCookie, lerCookie, paginaSetup };
