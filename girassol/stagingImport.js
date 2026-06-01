'use strict';
// ──────────────────────────────────────────────────────────────────────
// Importador automático de pedidos parados no staging do Bling (MLIVRE).
//
// Dispara a importação NATIVA do Bling (importarPedidoSelecionado), via
// cookie de sessão, a partir do Render. Roda em cron a cada 30min.
//
// • Só importa pedidos que ficaram parados por >X min (dá tempo do Bling
//   tentar sozinho primeiro). Default 20 min (IMPORT_MIN_IDADE_MIN).
// • Detecta cookie vencido e alerta (Telegram, se configurado).
// • Alerta se um pedido falhar 3x (provável produto sem vínculo).
//
// Cookie: colado pela página /cookie-setup. Fallback: env BLING_COOKIE.
// ──────────────────────────────────────────────────────────────────────

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, 'data', 'bling_cookie.txt');

const BASE = 'https://www.bling.com.br/services/vendas.lojas.virtuais.server.php';
const ID_INTEGRACAO   = process.env.STAGING_ID_INTEGRACAO || '5237';
const ID_LOJA         = process.env.STAGING_ID_LOJA       || '203146903';
const TIPO_INTEGRACAO = 'MercadoLivre';
const JANELA_DIAS     = parseInt(process.env.STAGING_JANELA_DIAS || '15');
const MIN_IDADE_MS    = parseInt(process.env.IMPORT_MIN_IDADE_MIN || '20') * 60000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// estado em memória
const _primeiraVez = new Map(); // numero -> timestamp 1ª vez visto parado
const _falhas      = new Map(); // numero -> nº de tentativas falhas
let _cookieAvisado = false;     // pra não spammar alerta de cookie

// ── Cookie ────────────────────────────────────────────────────────────
function extrairCookie(texto) {
  if (!texto) return '';
  let t = String(texto).trim();
  const tryMatch = (s) => {
    let m = s.match(/-b\s+'([^']+)'/) || s.match(/-b\s+"([^"]+)"/) ||
            s.match(/--cookie\s+'([^']+)'/) || s.match(/--cookie\s+"([^"]+)"/);
    if (m) return m[1];
    m = s.match(/-H\s+'cookie:\s*([^']+)'/i) || s.match(/-H\s+"cookie:\s*([^"]+)"/i);
    if (m) return m[1];
    m = s.match(/(?:^|\n)\s*cookie:\s*([^\n'"]+)/i);
    if (m) return m[1];
    return null;
  };
  let achado = tryMatch(t) || tryMatch(t.replace(/\^/g, ''));
  if (achado) return achado.trim();
  if (t.includes('=') && t.includes(';')) return t.replace(/^cookie:\s*/i, '').trim();
  return t;
}
function salvarCookie(cookie) {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, cookie, 'utf8');
  _cookieAvisado = false; // resetou: cookie novo
}
function lerCookie() {
  try { if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, 'utf8').trim(); }
  catch (e) { /* */ }
  return process.env.BLING_COOKIE || '';
}

// ── Alerta (Telegram opcional) ────────────────────────────────────────
async function sendAlerta(msg) {
  console.log('[ALERTA]', msg);
  // WhatsApp via CallMeBot
  const waPhone = process.env.WHATSAPP_PHONE, waKey = process.env.CALLMEBOT_APIKEY;
  if (waPhone && waKey) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(waPhone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(waKey)}`;
      await fetch(url);
    } catch (e) { console.error('[ALERTA] whatsapp falhou:', e.message); }
  }
  // Telegram (se configurado)
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: msg })
      });
    } catch (e) { console.error('[ALERTA] falha telegram:', e.message); }
  }
}

// Manda uma mensagem de teste e devolve o que o CallMeBot respondeu (debug)
async function testarAlerta() {
  const waPhone = process.env.WHATSAPP_PHONE, waKey = process.env.CALLMEBOT_APIKEY;
  const out = { whatsappConfigurado: !!(waPhone && waKey) };
  if (waPhone && waKey) {
    try {
      const txt = '🟢 Teste do importador Girassol — se chegou isso, o alerta no WhatsApp está OK!';
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(waPhone)}&text=${encodeURIComponent(txt)}&apikey=${encodeURIComponent(waKey)}`;
      const r = await fetch(url);
      out.httpStatus = r.status;
      out.respostaCallMeBot = (await r.text()).replace(/<[^>]+>/g, ' ').slice(0, 300);
    } catch (e) { out.erro = e.message; }
  } else {
    out.aviso = 'WHATSAPP_PHONE e/ou CALLMEBOT_APIKEY não estão nas env vars do Render';
  }
  return out;
}

// ── headers de navegador ──────────────────────────────────────────────
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
const ehLogin = txt => /login\?r=|window\.location\.href/.test(String(txt).toLowerCase());

// ── Período + filtro xajax ────────────────────────────────────────────
function periodoBR() {
  const fim = new Date(), ini = new Date();
  ini.setDate(ini.getDate() - JANELA_DIAS);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  return { dataInicial: fmt(ini), dataFinal: fmt(fim) };
}
function montarFiltro(di, df) {
  const e = (k, v) => `<e><k>${k}</k><v>${v}</v></e>`;
  return '<xjxobj>' + e('numero','') + e('situacao','') + e('situacaoVenda','todas')
    + e('dataInicial',di) + e('dataFinal',df) + e('ordemVenda','date_desc')
    + e('ordemVenda2','') + e('ordemVenda3','') + e('apelido','undefined')
    + e('shipmentType','undefined') + e('pedidosImportados','S') + e('ordem','date_desc')
    + e('page','0') + e('paginacao','') + e('idFormaPagamento','undefined') + '</xjxobj>';
}

// ── Núcleo: obter pendentes (idImportado=0) ───────────────────────────
async function obterPendentes() {
  const cookie = lerCookie();
  if (!cookie) return { ok: false, semCookie: true };
  const { dataInicial, dataFinal } = periodoBR();
  const params = new URLSearchParams();
  params.append('xajax', 'obterListaDePedidos');
  params.append('xajaxr', Date.now().toString());
  params.append('xajaxargs[]', ID_INTEGRACAO);
  params.append('xajaxargs[]', ID_LOJA);
  params.append('xajaxargs[]', TIPO_INTEGRACAO);
  params.append('xajaxargs[]', montarFiltro(dataInicial, dataFinal));
  params.append('xajaxargs[]', 'P');

  const resp = await fetch(`${BASE}?f=obterListaDePedidos`, { method: 'POST', headers: headersBling(cookie), body: params.toString() });
  const texto = await resp.text();
  if (ehLogin(texto)) return { ok: false, sessaoExpirada: true };
  let json = null; try { json = JSON.parse(texto); } catch (e) {}
  if (!json || !Array.isArray(json.data)) return { ok: false, respInesperada: texto.slice(0, 200) };
  const pendentes = json.data.filter(d => String(d.idImportado) === '0').map(d => String(d.numero));
  return { ok: true, total: json.data.length, pendentes };
}

// ── Importa UM pedido (nativo) ────────────────────────────────────────
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

  const resp = await fetch(`${BASE}?f=importarPedidoSelecionado`, { method: 'POST', headers: headersBling(cookie), body: params.toString() });
  const texto = await resp.text();
  if (ehLogin(texto)) return { ok: false, motivo: 'SESSAO_EXPIRADA', amostra: texto.slice(0, 200) };
  const m = texto.match(/vendas\.php#edit\/(\d+)/);
  const jaImportado = /j(á|a) importado/i.test(texto) || !!m;
  return {
    ok: jaImportado, numero, pedidoBlingId: m ? m[1] : null, httpStatus: resp.status,
    veredicto: jaImportado ? '✅ IMPORTADO pelo Bling (nativo)' : '⚠️ Resposta inesperada',
    amostra: texto.slice(0, 400)
  };
}

// ── Rotina do cron ────────────────────────────────────────────────────
async function rotinaImportStaging(opts = {}) {
  const r = await obterPendentes();
  if (r.semCookie) {
    if (!_cookieAvisado) { await sendAlerta('🔴 Importador Girassol: nenhum cookie salvo. Abra /cookie-setup.'); _cookieAvisado = true; }
    return { ok: false, motivo: 'sem cookie' };
  }
  if (r.sessaoExpirada) {
    if (!_cookieAvisado) { await sendAlerta('🔴 Cookie do Bling (Girassol) venceu. Recole em /cookie-setup pra voltar a importar sozinho.'); _cookieAvisado = true; }
    return { ok: false, motivo: 'sessão expirada' };
  }
  if (!r.ok) { console.warn('[importStaging] lista falhou:', r); return { ok: false, motivo: 'lista falhou' }; }
  _cookieAvisado = false;

  const agora = Date.now();
  const importados = [], adiados = [], falhados = [];

  for (const numero of r.pendentes) {
    // marca a 1ª vez que vejo o pedido parado; só importa após MIN_IDADE
    // (forcarAgora pula a trava — usado no disparo manual de teste)
    if (!opts.forcarAgora) {
      if (!_primeiraVez.has(numero)) { _primeiraVez.set(numero, agora); adiados.push(numero); continue; }
      if (agora - _primeiraVez.get(numero) < MIN_IDADE_MS) { adiados.push(numero); continue; }
    }

    const res = await importarUm(numero);
    if (res.motivo === 'SESSAO_EXPIRADA') {
      await sendAlerta('🔴 Cookie venceu no meio da importação. Recole em /cookie-setup.');
      _cookieAvisado = true;
      break;
    }
    if (res.ok) {
      importados.push(numero);
      _primeiraVez.delete(numero);
      _falhas.delete(numero);
      console.log(`[importStaging] ✅ ${numero} → pedido ${res.pedidoBlingId}`);
    } else {
      const n = (_falhas.get(numero) || 0) + 1;
      _falhas.set(numero, n);
      falhados.push(numero);
      console.warn(`[importStaging] ⚠️ ${numero} falhou (${n}x)`);
      if (n === 3) await sendAlerta(`⚠️ Pedido ${numero} não importa há 3 tentativas (provável produto sem vínculo no Bling). Importa na mão.`);
    }
    await sleep(1500);
  }

  // limpa pedidos que já saíram da lista (foram importados por fora)
  for (const num of _primeiraVez.keys()) if (!r.pendentes.includes(num)) _primeiraVez.delete(num);

  const resumo = { ok: true, parados: r.pendentes.length, importados, adiados: adiados.length, falhados };
  console.log('[importStaging] resumo:', JSON.stringify(resumo));
  return resumo;
}

// ── Página /cookie-setup ──────────────────────────────────────────────
function paginaSetup(msg) {
  const c = lerCookie();
  const st = c ? `<p style="color:green">✓ Cookie salvo (${c.length} caracteres). Cole de novo pra atualizar.</p>`
               : `<p style="color:#b00">Nenhum cookie salvo ainda.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cookie Bling</title>
  <style>body{font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 16px}
  textarea{width:100%;height:200px;font-family:monospace;font-size:12px}
  button{padding:10px 20px;font-size:15px;cursor:pointer;margin-top:10px}.ok{color:green}.err{color:#b00}</style></head><body>
  <h2>Cookie do Bling (Girassol)</h2>${st}${msg||''}
  <ol><li>No Bling logado, F12 → aba <b>Rede</b> → refresh</li>
  <li>Botão direito numa <b>vendas.server.php</b> → Copiar → <b>Copiar como cURL (bash)</b></li>
  <li>Cola <b>tudo</b> abaixo (eu extraio o cookie sozinho)</li><li>Salvar</li></ol>
  <textarea id="curl" placeholder="cola o cURL inteiro aqui..."></textarea><br>
  <button onclick="salvar()">Salvar cookie</button><p id="res"></p>
  <script>async function salvar(){const t=document.getElementById('curl').value;
  const r=await fetch('/cookie-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({curl:t})});
  const d=await r.json();document.getElementById('res').innerHTML=d.ok?
  '<span class=ok>✓ Cookie salvo ('+d.tamanho+' chars). <a href=/debug/staging-list>testar leitura</a></span>':
  '<span class=err>✗ '+(d.erro||'erro')+'</span>';}</script></body></html>`;
}

// ── Relatório de leitura (debug) ──────────────────────────────────────
async function listarStaging() {
  const r = await obterPendentes();
  if (r.semCookie)      return { veredicto: '❌ sem cookie — abra /cookie-setup' };
  if (r.sessaoExpirada) return { veredicto: '❌ sessão expirada — recole o cookie em /cookie-setup' };
  if (!r.ok)            return { veredicto: '❌ resposta inesperada', detalhe: r };
  return { veredicto: '✅ PASSOU', totalNaLista: r.total, pedidosNaoImportados: r.pendentes.length, exemplos: r.pendentes.slice(0, 8) };
}

module.exports = {
  listarStaging, importarUm, rotinaImportStaging,
  extrairCookie, salvarCookie, lerCookie, paginaSetup, testarAlerta
};
