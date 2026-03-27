'use strict';

const fetch = require('node-fetch');

const BLING_API = 'https://www.bling.com.br/Api/v3';

// ── Configurações via env ─────────────────────────────────────────────
const SITUACAO_ATENDIDO   = 9;
const SITUACAO_AGUARDANDO = parseInt(process.env.SITUACAO_AGUARDANDO || '7259');
const ME_LOJA_IDS         = (process.env.ME_LOJA_IDS || '203584107').split(',').map(Number);
const JANELA_DIAS         = parseInt(process.env.JANELA_ULTIMOS_DIAS || '15');
const MAX_PAGINAS         = parseInt(process.env.MAX_PAGINAS || '3');
const PAUSA_MS            = parseInt(process.env.PAUSA_MS || '700');

// ── Rate-limit bucket (Bling: ~30 req/min por endpoint) ───────────────
// Usamos uma fila simples com mínimo de 300ms entre requisições GET
// e 700ms entre PATCHes (que têm quota menor).
let _ultimaReq = 0;

async function esperarSlot(minMs) {
  const agora  = Date.now();
  const espera = Math.max(0, _ultimaReq + minMs - agora);
  if (espera > 0) await sleep(espera);
  _ultimaReq = Date.now();
}

// ── Utilitários ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPeriodo() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fim   = new Date(hoje);
  const ini   = new Date(hoje);
  ini.setDate(ini.getDate() - (JANELA_DIAS - 1));
  const fmt = d => d.toISOString().split('T')[0];
  return { inicial: fmt(ini), final: fmt(fim) };
}

async function fetchComRetry(url, options, ctx, tentativas = 4) {
  for (let t = 1; t <= tentativas; t++) {
    await esperarSlot(options.method === 'PATCH' ? PAUSA_MS : 300);
    const resp = await fetch(url, options);

    if (resp.status >= 200 && resp.status < 300) return resp;

    if (resp.status === 429) {
      const wait = 2000 * t;
      console.warn(`[blingApi] 429 rate-limit em ${ctx} — aguardando ${wait}ms (t${t})`);
      await sleep(wait);
      continue;
    }

    if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });

    const txt = await resp.text();
    console.error(`[blingApi] HTTP ${resp.status} em ${ctx}:`, txt.slice(0, 300));
    if (t === tentativas) throw new Error(`API Bling (${ctx}) HTTP ${resp.status}`);
    await sleep(1000 * t);
  }
}

// ── Buscar pedidos por status ─────────────────────────────────────────

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
  const todos = [];
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

    const data  = await resp.json();
    const lista = (data.data || []).filter(p => p.situacao?.id === statusId);
    console.log(`[blingApi] Status ${statusId} pag=${pag} → ${lista.length} pedidos`);
    todos.push(...lista);
    if ((data.data || []).length < 100) break;
  }
  return todos;
}

// ── Regras Mercado Envios ─────────────────────────────────────────────

function getCodigoRastreio(p) {
  const v = p?.transporte?.volumes?.[0];

  // Tenta o código de rastreamento direto
  const codigo =
    v?.codigoRastreamento ||
    v?.codigoRastreio ||
    v?.tracking ||
    v?.codigo ||
    p?.transporte?.codigoRastreamento ||
    '';

  if (String(codigo).trim() !== '') return String(codigo).trim();

  // Se não tem código mas tem objeto etiqueta preenchido,
  // considera como disponível (Bling às vezes não sincroniza o código na API)
  const etiqueta = v?.etiqueta;
  if (etiqueta && typeof etiqueta === 'object' && Object.keys(etiqueta).length > 0) {
    return 'ETIQUETA_DISPONIVEL';
  }

  return '';
}

function temEtiqueta(p) {
  // Verifica também pelo campo etiqueta e pelo serviço logístico
  const rastreio = getCodigoRastreio(p);
  if (rastreio !== '') return true;

  // Verifica se tem etiqueta pelo campo volumes
  const v = p?.transporte?.volumes?.[0];
  if (v?.etiqueta && String(v.etiqueta).trim() !== '') return true;

  return false;
}

function isMercadoEnvios(p) {
  if (!p) return false;
  const lojaId  = p.loja?.id;
  const nome    = String(p.transporte?.contato?.nome || '').toUpperCase();
  const servico = String(p.transporte?.volumes?.[0]?.servico || '').toUpperCase();
  if (servico.includes('FLEX')) return false;
  return ME_LOJA_IDS.includes(lojaId) || nome.includes('MERCADO ENVIOS');
}

const pedidoSemRastreio = p => isMercadoEnvios(p) && getCodigoRastreio(p) === '';
const pedidoComRastreio = p => isMercadoEnvios(p) && getCodigoRastreio(p) !== '';

// ── Alterar situação ──────────────────────────────────────────────────

async function alterarSituacao(token, idPedido, novaSituacao) {
  const url  = `${BLING_API}/pedidos/vendas/${idPedido}/situacoes/${novaSituacao}`;
  const resp = await fetchComRetry(
    url,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    `PATCH pedido=${idPedido} → ${novaSituacao}`
  );
  console.log(`[blingApi] Pedido ${idPedido} → situação ${novaSituacao} ✓`);
}

// ── Memória de processamento (em RAM, resetada à meia-noite) ──────────
const _mem = new Map();
const hojeStr = () => new Date().toISOString().split('T')[0];
const chave   = (f, id) => `${f}:${hojeStr()}:${id}`;

const jaProcessado   = (f, id) => _mem.get(chave(f, id)) === true;
const marcarProcessado = (f, id) => _mem.set(chave(f, id), true);

function limparMemoriaAntiga() {
  const hoje = hojeStr();
  let n = 0;
  for (const k of _mem.keys()) {
    if (!k.includes(`:${hoje}:`)) { _mem.delete(k); n++; }
  }
  console.log(`[blingApi] Memória antiga limpa (${n} entradas)`);
}

module.exports = {
  SITUACAO_ATENDIDO,
  SITUACAO_AGUARDANDO,
  getPeriodo,
  sleep,
  getPedidosPorStatus,
  getPedidoDetalhe,
  isMercadoEnvios,
  pedidoSemRastreio,
  pedidoComRastreio,
  getCodigoRastreio,
  alterarSituacao,
  jaProcessado,
  marcarProcessado,
  limparMemoriaAntiga
};
