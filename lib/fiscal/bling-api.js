'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CLIENTE DA API DO BLING — as três empresas (13/09/2026).

   Passo 2.7. Depois dos portes de hoje (envio nativo, renovação proativa), o que
   sobrava entre as cópias era rótulo de log e nome de env — a Girassol não
   prefixa nada, porque foi a primeira empresa do repositório.

   As pausas entre chamadas continuam POR EMPRESA: elas existem pra não estourar
   a cota do Bling, e a cota é da conta, não do código. Empresa que vende mais
   pode precisar de ritmo diferente da que vende menos.
   ──────────────────────────────────────────────────────────────────────────── */

function criarBlingApi(cfg) {
  for (const nome of ['rotulo', 'envPausaMs', 'envGetPausaMs', 'envMaxPaginas', 'envMaxPaginasNfe',
                      'envJanelaUltimosDias', 'envMeLojaIds', 'envSituacaoAguardando']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/bling-api: falta ' + nome);
  }
  const { rotulo } = cfg;

  const fetch = require('node-fetch');

  const BLING_API = 'https://api.bling.com.br/Api/v3';

  // IDs da AMBTotal (745122 AGUARDANDO, 745123 DESPACHADOS, 9 Atendido)
  const SITUACAO_ATENDIDO   = 9;
  const SITUACAO_AGUARDANDO = parseInt(process.env[cfg.envSituacaoAguardando] || '745122');
  /* 16/09 — O ID HERDADO SAIU. Ele decidia quais pedidos o F1 considera do Mercado Livre, e
     o padrão era '206017293' — o canal da AMB. Qualquer empresa sem a env própria julgava os
     pedidos DELA pelo canal de OUTRA, sem erro nenhum aparecer: o F1 simplesmente ignorava
     tudo. Mantive o padrão em 15/09 porque não dava pra ver o Render daqui e removê-lo
     poderia quebrar quem dependesse dele.

     Agora a evidência existe, e veio de produção: a rota /descobrir-ids provou o canal de
     cada empresa contra a própria conta do ML e conferiu contra o Render — as três apareceram
     com a env presente e o valor CERTO (AMB 206017293, Girassol 203146903, GOOD 203296034).
     Ninguém depende do herdado.

     Sem a env, agora falha alto. A alternativa é o silêncio, que é pior: a empresa sobe,
     responde 200 em tudo e não move um pedido — e ninguém liga uma coisa à outra. */
  const _lojaIdsBrutos = String(process.env[cfg.envMeLojaIds] || '').trim();
  if (!_lojaIdsBrutos) {
    throw new Error('[' + rotulo + '] falta ' + cfg.envMeLojaIds + ': sem ela o F1 não sabe quais ' +
      'canais de venda são do Mercado Livre. Rode /<empresa>/descobrir-ids — ele prova o canal ' +
      'contra a conta do ML e devolve o valor pronto pra colar.');
  }
  const ME_LOJA_IDS = _lojaIdsBrutos.split(',').map(x => Number(String(x).trim())).filter(n => n && !isNaN(n));
  if (!ME_LOJA_IDS.length) {
    throw new Error('[' + rotulo + '] ' + cfg.envMeLojaIds + ' não tem nenhum id válido: "' + _lojaIdsBrutos + '"');
  }
  console.log('[' + rotulo + ' blingApi] canais do ML: ' + ME_LOJA_IDS.join(', ') + ' (de ' + cfg.envMeLojaIds + ')');
  const JANELA_DIAS = parseInt(process.env[cfg.envJanelaUltimosDias] || '15');
  const MAX_PAGINAS = parseInt(process.env[cfg.envMaxPaginas] || '5');
  const MAX_PAGINAS_NFE = parseInt(process.env[cfg.envMaxPaginasNfe] || '8');
  const PAUSA_MS    = parseInt(process.env[cfg.envPausaMs] || '700');
  const GET_PAUSA_MS = parseInt(process.env[cfg.envGetPausaMs] || '500');

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
      console.error(`[${rotulo} blingApi] Erro de rede em ${ctx} (tentativa ${t}/${tentativas}):`, e.message);
      if (t === tentativas) throw new Error(`API Bling ${rotulo} (${ctx}) erro de rede: ${e.message}`);
      await sleep(1000 * t);
      continue;
    }
    if (resp.status >= 200 && resp.status < 300) return resp;
    if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
    if (resp.status === 429) {
      console.warn(`[${rotulo} blingApi] HTTP 429 em ${ctx} (tentativa ${t}/${tentativas}) — aguardando`);
      if (t === tentativas) throw new Error(`API Bling ${rotulo} (${ctx}) HTTP 429 após ${tentativas} tentativas`);
      await sleep(2000 * t);
      continue;
    }
    const txt = await resp.text();
    console.error(`[${rotulo} blingApi] HTTP ${resp.status} em ${ctx}:`, txt.slice(0, 300));
    if (t === tentativas) throw new Error(`API Bling ${rotulo} (${ctx}) HTTP ${resp.status}`);
    await sleep(1000 * t);
  }
  throw new Error(`API Bling ${rotulo} (${ctx}) falhou após ${tentativas} tentativas${ultimoErro ? ': ' + ultimoErro.message : ''}`);
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
      // 🐛 28/07 — os parâmetros CERTOS da API v3 do Bling para PEDIDOS são dataInicial/dataFinal.
      // Com "dataEmissaoInicial/Final" (que não existem aqui) o Bling IGNORAVA o filtro e devolvia
      // TODOS os pedidos naquela situação, de todos os tempos. Como o F1 processa só os primeiros
      // MAX_F1 da lista, ele mastigava os mais ANTIGOS e nunca chegava nos pedidos do dia.
      // (O endpoint /nfe mais abaixo usa dataEmissaoInicial de verdade — aquele está certo.)
      `${BLING_API}/pedidos/vendas?idsSituacoes=${statusId}` +
      `&dataInicial=${dataInicial}&dataFinal=${dataFinal}` +
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
    console.log(`[${rotulo} blingApi] Status ${statusId} pag=${pag} → API=${bruto.length} filtrado=${lista.length}`);
    todos.push(...lista);
    if (bruto.length < 100) break;
  }
  if (totalBruto !== todos.length) {
    console.log(`[${rotulo} blingApi] Filtro local protegeu: API trouxe ${totalBruto}, válidos=${todos.length}`);
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
  console.log(`[${rotulo} blingApi] Pedido ${idPedido} → situação ${novaSituacao} ✓`);
  }

  // ─── F3: NF-e ────────────────────────────────────────────────────────────────
  async function getNFesAutorizadas(token, dataInicial, dataFinal) {
  const todos = [];
  let truncado = true;
  for (let pag = 1; pag <= MAX_PAGINAS_NFE; pag++) {
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
    console.log(`[${rotulo} blingApi] NFs autorizadas pag=${pag} → ${lista.length}`);
    todos.push(...lista);
    if (lista.length < 100) { truncado = false; break; }
  }
  if (truncado) {
    console.warn(`[${rotulo} blingApi] ⚠️ getNFesAutorizadas parou no teto de ${MAX_PAGINAS_NFE} páginas (${todos.length} NFs) — pode haver NF recente FORA do fetch. Reduza AMB_NF_JANELA_DIAS ou aumente AMB_MAX_PAGINAS_NFE.`);
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

  /* 13/09 — PORTE DA GIRASSOL (decisão do dono: "uma tem, agora ambas têm"). Envio NATIVO
   Bling → marketplace: o Bling é integrador oficial do ML e faz o handshake fiscal que o
   push cru de XML não faz. A Girassol usa isso como 1ª tentativa no reenvio MANUAL — que é
   justamente quando o automático já falhou —, e aqui não existia: a AMB/GOOD só repetiam o
   mesmo push que não tinha funcionado. */
  async function enviarNFeParaLojaVirtual(token, nfeId) {
  const url = `${BLING_API}/nfe/${nfeId}/enviar-loja-virtual`;
  await esperarSlot(PAUSA_MS);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }
  });
  const data = await resp.json().catch(() => ({}));
  console.log(`[${rotulo} blingApi] NF ${nfeId} → enviar-loja-virtual HTTP ${resp.status} ${JSON.stringify(data).slice(0, 400)}`);
  if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
  if (!(resp.status >= 200 && resp.status < 300)) {
    throw new Error(`Bling enviar-loja-virtual NF=${nfeId} HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { httpStatus: resp.status, data };
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
  console.log(`[${rotulo} blingApi] Memória antiga limpa (${n} entradas)`);
  }

  return {
  enviarNFeParaLojaVirtual,
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO, ME_LOJA_IDS,
  getPeriodo, sleep,
  getPedidosPorStatus, getPedidoDetalhe,
  isMercadoEnviosPorLoja,
  getCodigoRastreio,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga,
  getNFesAutorizadas, getNFeDetalhe
  };

}

module.exports = { criarBlingApi };
