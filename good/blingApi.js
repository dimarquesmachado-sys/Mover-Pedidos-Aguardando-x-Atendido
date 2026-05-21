'use strict';

const fetch = require('node-fetch');

const BLING_API = 'https://api.bling.com.br/Api/v3';

// IDs da GOOD Import (7259 AGUARDANDO, 9 Atendido)
const SITUACAO_ATENDIDO   = 9;
const SITUACAO_AGUARDANDO = parseInt(process.env.GOOD_SITUACAO_AGUARDANDO || '353459');
const ME_LOJA_IDS = (process.env.GOOD_ME_LOJA_IDS || '203296034').split(',').map(Number);
const JANELA_DIAS = parseInt(process.env.GOOD_JANELA_ULTIMOS_DIAS || '20');
const MAX_PAGINAS = parseInt(process.env.GOOD_MAX_PAGINAS || '5');
const PAUSA_MS    = parseInt(process.env.GOOD_PAUSA_MS || '700');
const GET_PAUSA_MS = parseInt(process.env.GOOD_GET_PAUSA_MS || '500');

let _ultimaReq = 0;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function esperarSlot(minMs) {
  const agora = Date.now();
  const espera = Math.max(0, _ultimaReq + minMs - agora);
  if (espera > 0) await sleep(espera);
  _ultimaReq = Date.now();
}

function getPeriodo() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fim = new Date(hoje);
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - (JANELA_DIAS - 1));
  const fmt = d => d.toISOString().split('T')[0];
  return { inicial: fmt(ini), final: fmt(fim) };
}

async function fetchComRetry(url, options, ctx, tentativas = 6) {
  let ultimoErro = null;
  for (let t = 1; t <= tentativas; t++) {
    await esperarSlot(options.method === 'PATCH' ? PAUSA_MS : GET_PAUSA_MS);
    let resp;
    try {
      resp = await fetch(url, options);
    } catch (e) {
      ultimoErro = e;
      console.error(`[GOOD blingApi] Erro de rede em ${ctx} (tentativa ${t}/${tentativas}):`, e.message);
      if (t === tentativas) throw new Error(`API Bling GOOD (${ctx}) erro de rede: ${e.message}`);
      await sleep(1000 * t);
      continue;
    }
    if (resp.status >= 200 && resp.status < 300) return resp;
    if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
    if (resp.status === 429) {
      console.warn(`[GOOD blingApi] HTTP 429 em ${ctx} (tentativa ${t}/${tentativas}) — aguardando`);
      if (t === tentativas) throw new Error(`API Bling GOOD (${ctx}) HTTP 429 após ${tentativas} tentativas`);
      await sleep(2000 * t);
      continue;
    }
    const txt = await resp.text();
    console.error(`[GOOD blingApi] HTTP ${resp.status} em ${ctx}:`, txt.slice(0, 300));
    if (t === tentativas) throw new Error(`API Bling GOOD (${ctx}) HTTP ${resp.status}`);
    await sleep(1000 * t);
  }
  throw new Error(`API Bling GOOD (${ctx}) falhou após ${tentativas} tentativas${ultimoErro ? ': ' + ultimoErro.message : ''}`);
}

async function getPedidoDetalhe(token, idPedido) {
  const url = `${BLING_API}/pedidos/vendas/${idPedido}`;
  const resp = await fetchComRetry(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    `detalhe pedido=${idPedido}`
  );
  const data = await resp.json();
  return data.data || null;
}

/**
 * Busca pedidos por situação.
 * API Bling v3 ignora o filtro de situação — fazemos filtro LOCAL.
 */
async function getPedidosPorStatus(token, statusId, dataInicial, dataFinal) {
  const todos = [];
  let totalBruto = 0;
  for (let pag = 1; pag <= MAX_PAGINAS; pag++) {
    const url =
      `${BLING_API}/pedidos/vendas?idsSituacoes=${statusId}` +
      `&dataEmissaoInicial=${dataInicial}&dataEmissaoFinal=${dataFinal}` +
      `&limite=100&pagina=${pag}`;
    const resp = await fetchComRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      `lista status=${statusId} pag=${pag}`
    );
    const data = await resp.json();
    const bruto = data.data || [];
    totalBruto += bruto.length;
    const lista = bruto.filter(p => p.situacao?.id === statusId);
    console.log(`[GOOD blingApi] Status ${statusId} pag=${pag} → API=${bruto.length} filtrado=${lista.length}`);
    todos.push(...lista);
    if (bruto.length < 100) break;
  }
  if (totalBruto !== todos.length) {
    console.log(`[GOOD blingApi] Filtro local protegeu: API trouxe ${totalBruto}, válidos=${todos.length}`);
  }
  return todos;
}

function getCodigoRastreio(p) {
  const v = p?.transporte?.volumes?.[0];
  const codigo =
    v?.codigoRastreamento ||
    v?.codigoRastreio ||
    v?.tracking ||
    v?.codigo ||
    p?.transporte?.codigoRastreamento ||
    '';
  return String(codigo).trim();
}

function isMercadoEnviosPorLoja(p) {
  if (!p) return false;
  return ME_LOJA_IDS.includes(p.loja?.id);
}

async function alterarSituacao(token, idPedido, novaSituacao) {
  const url = `${BLING_API}/pedidos/vendas/${idPedido}/situacoes/${novaSituacao}`;
  await fetchComRetry(
    url,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    `PATCH pedido=${idPedido} → ${novaSituacao}`
  );
  console.log(`[GOOD blingApi] Pedido ${idPedido} → situação ${novaSituacao} ✓`);
}

// ─── F3: NF-e ────────────────────────────────────────────────────────────────
async function getNFesAutorizadas(token, dataInicial, dataFinal) {
  const todos = [];
  for (let pag = 1; pag <= MAX_PAGINAS; pag++) {
    const url =
      `${BLING_API}/nfe?situacao=5` +
      `&dataEmissaoInicial=${dataInicial}&dataEmissaoFinal=${dataFinal}` +
      `&limite=100&pagina=${pag}`;
    const resp = await fetchComRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      `lista NFs pag=${pag}`
    );
    const data = await resp.json();
    const lista = data.data || [];
    console.log(`[GOOD blingApi] NFs autorizadas pag=${pag} → ${lista.length}`);
    todos.push(...lista);
    if (lista.length < 100) break;
  }
  return todos;
}

async function getNFeDetalhe(token, nfeId) {
  const url = `${BLING_API}/nfe/${nfeId}`;
  const resp = await fetchComRetry(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    `detalhe NF=${nfeId}`
  );
  const data = await resp.json();
  return data.data || null;
}

// ─── Memória do dia ──────────────────────────────────────────────────
const _mem = new Map();
const hojeStr = () => new Date().toISOString().split('T')[0];
const chave = (f, id) => `${f}:${hojeStr()}:${id}`;
const jaProcessado = (f, id) => _mem.get(chave(f, id)) === true;
const marcarProcessado = (f, id) => _mem.set(chave(f, id), true);
function limparMemoriaAntiga() {
  const hoje = hojeStr();
  let n = 0;
  for (const k of _mem.keys()) {
    if (!k.includes(`:${hoje}:`)) { _mem.delete(k); n++; }
  }
  console.log(`[GOOD blingApi] Memória antiga limpa (${n} entradas)`);
}

module.exports = {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO, ME_LOJA_IDS,
  getPeriodo, sleep,
  getPedidosPorStatus, getPedidoDetalhe,
  isMercadoEnviosPorLoja,
  getCodigoRastreio,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga,
  getNFesAutorizadas, getNFeDetalhe
};
