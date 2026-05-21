'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnviosPorLoja,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga,
  getNFeDetalhe
} = require('./blingApi');
const { getShipmentInfo, getShipmentSubstatus } = require('./mlApi');

const MAX_F1 = parseInt(process.env.AMB_MAX_PEDIDOS_F1 || '40');
const MAX_F2 = parseInt(process.env.AMB_MAX_PEDIDOS_F2 || '60');

// Anti vai-e-vem: tempo mínimo (min) desde a emissão da NF antes do F1 mover.
// Enquanto a NF está "fresca", a integração nativa Bling↔ML ainda mexe no
// pedido e reverte AGUARDANDO→Atendido. Esperamos a NF maturar.
const NF_MIN_MINUTOS = parseInt(process.env.AMB_F1_NF_MIN_MINUTOS || process.env.F1_NF_MIN_MINUTOS || '6');

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
    if (status === 'ready_to_ship') return true;
    if (substatus === 'buffered') return false;
    return true;
  } catch (e) {
    console.warn(`[AMB ML] Erro ao consultar ${numeroLoja}: ${e.message} — assumindo sem etiqueta`);
    return false;
  }
}

/**
 * Anti vai-e-vem: retorna true se a NF do pedido ainda está "fresca"
 * (emitida há menos de NF_MIN_MINUTOS). Nesse caso o F1 NÃO deve mover.
 * Em caso de erro de rede ou ausência de NF, retorna false (não bloqueia).
 */
async function nfAindaFresca(token, pDetalhe, idPedido) {
  const nfId = pDetalhe?.notaFiscal?.id;
  if (!nfId) return false; // sem NF → não bloqueia
  try {
    const nf = await getNFeDetalhe(token, nfId);
    const dataEmissaoStr = nf?.dataEmissao;
    if (!dataEmissaoStr) return false; // sem data → não bloqueia
    // Formato Bling: "2026-05-21 11:19:31" (horário de Brasília, sem TZ)
    const emissao = new Date(String(dataEmissaoStr).replace(' ', 'T') + '-03:00');
    if (isNaN(emissao.getTime())) return false; // data inválida → não bloqueia
    const minutos = (Date.now() - emissao.getTime()) / 60000;
    if (minutos < NF_MIN_MINUTOS) {
      console.log(`[AMB F1] Pedido ${idPedido} NF ${nfId} tem ${minutos.toFixed(1)} min — aguardando maturar, NÃO move`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`[AMB F1] Erro ao checar maturidade NF do pedido ${idPedido}: ${e.message} — não bloqueia`);
    return false;
  }
}

// ── Fluxo 1 — ATENDIDO → AGUARDANDO ──────────────────────────────────
async function _fluxo1(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_ATENDIDO, inicial, final);
  const batch = lista.slice(0, MAX_F1);
  console.log(`[AMB F1] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[AMB F1] Sem token ML:', e.message);
  }
  let movidos = 0, pulados = 0, ignorados = 0;
  for (const p of batch) {
    if (jaProcessado('F1', p.id)) { pulados++; continue; }
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
    // ANTI VAI-E-VEM: se a NF está fresca, pula SEM marcar processado
    // (reavalia na próxima rodada, quando a NF já tiver maturado)
    if (await nfAindaFresca(token, pDetalhe, p.id)) {
      ignorados++;
      continue;
    }
    // Sem etiqueta e NF madura → move para AGUARDANDO
    try {
      await alterarSituacao(token, p.id, SITUACAO_AGUARDANDO);
      movidos++;
      marcarProcessado('F1', p.id);
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
