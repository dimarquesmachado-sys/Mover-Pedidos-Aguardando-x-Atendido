'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnviosPorLoja,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga
} = require('./blingApi');
const { getShipmentInfo, getShipmentSubstatus } = require('./mlApi');

const MAX_F1 = parseInt(process.env.AMB_MAX_PEDIDOS_F1 || '40');

// ── 04/08: RE-MOVE (o Bling desfaz o nosso movimento) ─────────────────────────
// Portado da GOOD, onde o caso foi provado no pedido 74493 (Bling 26501022094): o ML diz
// status=pending/substatus=buffered (etiqueta só sai no dia da coleta), o F1 decide mover,
// o PATCH volta com sucesso ("→ situação ... ✓") e o Bling registra a ocorrência — mas o
// pedido reaparece em ATENDIDO. Antes disso o F1 marcava o pedido como "já processado" no
// sucesso e não tentava mais naquele dia, então ele passava o dia entupindo a fila do
// estoquista. Agora RETENTA — com freio, porque cada tentativa é uma chamada no Bling (que
// já trabalha no teto do 429) e uma ocorrência nova no histórico do pedido:
//   • espera AMB_F1_REMOVE_ESPERA_MIN minutos entre tentativas do MESMO pedido (padrão 15)
//   • no máximo AMB_F1_REMOVE_MAX tentativas por pedido por dia (padrão 8); depois desiste
//     até a virada, pra não ficar em ping-pong infinito com o Bling
// O freio natural continua sendo a própria regra: no ciclo em que o ML liberar a etiqueta,
// temEtiquetaML passa a devolver true e o F1 simplesmente para de mover.
const REMOVE_MAX       = parseInt(process.env.AMB_F1_REMOVE_MAX || '8');
const REMOVE_ESPERA_MS = parseInt(process.env.AMB_F1_REMOVE_ESPERA_MIN || '15') * 60000;
const _reMove = new Map();   // idPedido -> { dia, n, ultimo }
function _tentativas(id) {
  const hoje = new Date().toISOString().slice(0, 10);
  const r = _reMove.get(id);
  if (r && r.dia === hoje) return r;
  if (_reMove.size > 2000) { for (const [k, v] of _reMove) if (v.dia !== hoje) _reMove.delete(k); }
  const novo = { dia: hoje, n: 0, ultimo: 0 };
  _reMove.set(id, novo);
  return novo;
}
const MAX_F2 = parseInt(process.env.AMB_MAX_PEDIDOS_F2 || '60');

const _rodando = { F1: false, F2: false };

async function comGuard(fluxo, fn) {
  if (_rodando[fluxo]) {
    console.log(`[AMB fluxos] ${fluxo} já em execução — pulando`);
    return;
  }
  _rodando[fluxo] = true;
  try { await fn(); } finally { _rodando[fluxo] = false; }
}

async function comTokenRenewable(fn) {
  try {
    return await fn(await garantirToken());
  } catch (e) {
    if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') {
      const token = await renovarToken();
      return await fn(token);
    }
    throw e;
  }
}

// Verifica via API do ML se pedido tem etiqueta disponível
// Retorna true = tem etiqueta, false = buffered (sem etiqueta)
async function temEtiquetaML(mlToken, numeroLoja) {
  try {
    const shipmentId = await getShipmentInfo(mlToken, numeroLoja);
    const { status, substatus } = await getShipmentSubstatus(mlToken, shipmentId);
    console.log(`[AMB ML] numeroLoja=${numeroLoja} shipment=${shipmentId} status=${status} substatus=${substatus}`);
    // Proteção caso de borda: status pronto p/ envio → tem etiqueta (mesmo se substatus='buffered')
    // 28/07 — 'ready_to_ship' NÃO garante etiqueta: com substatus 'invoice_pending' o ML ainda não
    // fechou a etapa dele e a etiqueta NÃO é imprimível (a API responde NOT_PRINTABLE_STATUS).
    // Esses pedidos ficavam presos em ATENDIDO entupindo a lista do galpão.
    const SEM_ETIQUETA_AINDA = ['invoice_pending', 'buffered', 'ready_to_print_pending', 'regenerating'];
    if (SEM_ETIQUETA_AINDA.includes(String(substatus || ''))) {
      console.log(`[ML] numeroLoja=${numeroLoja} substatus=${substatus} — etiqueta AINDA não imprimível, pode mover`);
      return false;
    }
    if (status === 'ready_to_ship') return true;
    if (substatus === 'buffered') return false;
    return true;
  } catch (e) {
    console.warn(`[AMB ML] Erro ao consultar ${numeroLoja}: ${e.message} — assumindo sem etiqueta`);
    return false;
  }
}

// ── Fluxo 1 — ATENDIDO → AGUARDANDO ──────────────────────────────────
async function _fluxo1(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_ATENDIDO, inicial, final);
  // 28/07: processa os MAIS RECENTES primeiro. Antes pegava os primeiros da lista (os mais
  // antigos) — se houvesse mais pedidos que o limite do lote, os do dia nunca eram avaliados.
  const _ord = lista.slice().sort((a, b) => {
    const da = String(a.data || ''), db = String(b.data || '');
    if (da !== db) return db.localeCompare(da);
    return Number(b.id || 0) - Number(a.id || 0);
  });
  const batch = _ord.slice(0, MAX_F1);
  console.log(`[AMB F1] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[AMB F1] Sem token ML:', e.message);
  }
  let movidos = 0, pulados = 0, ignorados = 0;
  for (const p of batch) {
    if (jaProcessado('F1', p.id)) { pulados++; continue; }
    // Ja movemos este pedido hoje e ele voltou pra ATENDIDO: espera o intervalo antes de
    // insistir. Fica ANTES do detalhe de proposito — evita gastar chamada do Bling a toa.
    const _rm = _tentativas(p.id);
    if (_rm.n > 0 && (Date.now() - _rm.ultimo) < REMOVE_ESPERA_MS) { pulados++; continue; }
    if (!isMercadoEnviosPorLoja(p)) { ignorados++; continue; }
    let pDetalhe = p;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id) || p;
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[AMB F1] Erro detalhe ${p.id}:`, e.message);
    }
    // PROTEÇÃO: confirma que ainda está em ATENDIDO no momento do processamento
    if (pDetalhe?.situacao?.id !== SITUACAO_ATENDIDO) {
      console.log(`[AMB F1] Pedido ${p.id} situação=${pDetalhe?.situacao?.id} — não é mais ATENDIDO, ignorando`);
      marcarProcessado('F1', p.id);
      ignorados++; continue;
    }
    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[AMB F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);
    if (isFlex) { marcarProcessado('F1', p.id); ignorados++; continue; }
    if (rastreio !== '') { marcarProcessado('F1', p.id); ignorados++; continue; }
    // Sem rastreio no Bling → confirma no ML
    const numeroLoja = pDetalhe?.numeroLoja || p?.numeroLoja;
    if (mlToken && numeroLoja) {
      const temEtiqueta = await temEtiquetaML(mlToken, numeroLoja);
      if (temEtiqueta) {
        console.log(`[AMB F1] Pedido ${p.id} tem etiqueta no ML — não move`);
        marcarProcessado('F1', p.id);
        ignorados++;
        continue;
      }
    }
    // Sem etiqueta → move para AGUARDANDO
    try {
      await alterarSituacao(token, p.id, SITUACAO_AGUARDANDO);
      movidos++;
      _rm.n++; _rm.ultimo = Date.now();
      if (_rm.n > 1) console.log(`[AMB F1] Pedido ${p.id} tinha VOLTADO pra ATENDIDO (o Bling desfez) — movido de novo | tentativa ${_rm.n}/${REMOVE_MAX} hoje`);
      if (_rm.n >= REMOVE_MAX) {
        console.log(`[AMB F1] Pedido ${p.id} voltou ${_rm.n}x hoje — desistindo ate a virada. Se persistir, e configuracao do Bling (mapeamento da integracao do ML), nao do nosso lado`);
        marcarProcessado('F1', p.id);
      }
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[AMB F1] Erro ao mover ${p.id}:`, e.message);
    }
  }
  console.log(`[AMB F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}`);
}

// ── Fluxo 2 — AGUARDANDO → ATENDIDO ──────────────────────────────────
async function _fluxo2(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const batch = lista.slice(0, MAX_F2);
  console.log(`[AMB F2] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[AMB F2] Sem token ML:', e.message);
  }
  let movidos = 0;
  for (const p of batch) {
    if (jaProcessado('F2', p.id)) { continue; }
    if (!isMercadoEnviosPorLoja(p)) continue;
    let pDetalhe = p;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id) || p;
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[AMB F2] Erro detalhe ${p.id}:`, e.message);
    }
    // PROTEÇÃO CRÍTICA: só move se ainda está em AGUARDANDO.
    // Isso impede que pedidos em DESPACHADOS (745123), Cancelado, etc.
    // sejam alterados por engano.
    if (pDetalhe?.situacao?.id !== SITUACAO_AGUARDANDO) {
      console.log(`[AMB F2] Pedido ${p.id} situação=${pDetalhe?.situacao?.id} — não é AGUARDANDO, ignorando`);
      continue;
    }
    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[AMB F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);
    let deveAtender = false;
    if (isFlex) {
      deveAtender = true;
    } else if (rastreio !== '') {
      deveAtender = true;
    } else {
      // Sem rastreio → verifica no ML
      const numeroLoja = pDetalhe?.numeroLoja || p?.numeroLoja;
      if (mlToken && numeroLoja) {
        deveAtender = await temEtiquetaML(mlToken, numeroLoja);
        if (deveAtender) console.log(`[AMB F2] Pedido ${p.id} tem etiqueta no ML → move para ATENDIDO`);
      }
    }
    if (!deveAtender) continue;
    try {
      await alterarSituacao(token, p.id, SITUACAO_ATENDIDO);
      movidos++;
      marcarProcessado('F2', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[AMB F2] Erro ao mover ${p.id}:`, e.message);
    }
  }
  console.log(`[AMB F2] movidos=${movidos}`);
}

async function rotinaExpediente() {
  await comGuard('F1', () => comTokenRenewable(_fluxo1));
}

async function rotinaVirada() {
  console.log('[AMB rotinas] === VIRADA ===');
  limparMemoriaAntiga();
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
}

async function rotinaManha() {
  console.log('[AMB rotinas] === MANHÃ ===');
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
}

module.exports = { rotinaExpediente, rotinaVirada, rotinaManha };
