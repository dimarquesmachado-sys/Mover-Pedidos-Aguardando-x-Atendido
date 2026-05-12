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

const MAX_F1 = parseInt(process.env.MAX_PEDIDOS_F1 || '40');
const MAX_F2 = parseInt(process.env.MAX_PEDIDOS_F2 || '60');

const _rodando = { F1: false, F2: false };

async function comGuard(fluxo, fn) {
  if (_rodando[fluxo]) {
    console.log(`[fluxos] ${fluxo} já em execução — pulando`);
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
    console.log(`[ML] numeroLoja=${numeroLoja} shipment=${shipmentId} status=${status} substatus=${substatus}`);
    if (substatus === 'buffered') return false;
    return true;
  } catch (e) {
    console.warn(`[ML] Erro ao consultar ${numeroLoja}: ${e.message} — assumindo sem etiqueta`);
    return false;
  }
}

// ── Fluxo 1 — ATENDIDO → AGUARDANDO ──────────────────────────────────
async function _fluxo1(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_ATENDIDO, inicial, final);
  const batch = lista.slice(0, MAX_F1);

  console.log(`[F1] ${lista.length} encontrados | processando ${batch.length}`);

  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[F1] Sem token ML:', e.message);
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
      console.error(`[F1] Erro detalhe ${p.id}:`, e.message);
    }

    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);

    if (isFlex) { ignorados++; continue; }
    if (rastreio !== '') { ignorados++; continue; }

    // Sem rastreio no Bling → confirma no ML
    const numeroLoja = pDetalhe?.numeroLoja || p?.numeroLoja;
    if (mlToken && numeroLoja) {
      const temEtiqueta = await temEtiquetaML(mlToken, numeroLoja);
      if (temEtiqueta) {
        console.log(`[F1] Pedido ${p.id} tem etiqueta no ML — não move`);
        ignorados++;
        continue;
      }
    }

    // Sem etiqueta → move para AGUARDANDO
    try {
      await alterarSituacao(token, p.id, SITUACAO_AGUARDANDO);
      movidos++;
      marcarProcessado('F1', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F1] Erro ao mover ${p.id}:`, e.message);
    }
  }

  console.log(`[F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}`);
}

// ── Fluxo 2 — AGUARDANDO → ATENDIDO ──────────────────────────────────
async function _fluxo2(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const batch = lista.slice(0, MAX_F2);

  console.log(`[F2] ${lista.length} encontrados | processando ${batch.length}`);

  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[F2] Sem token ML:', e.message);
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
      console.error(`[F2] Erro detalhe ${p.id}:`, e.message);
    }

    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);

    if (p.situacao?.id !== SITUACAO_AGUARDANDO) continue;

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
        if (deveAtender) console.log(`[F2] Pedido ${p.id} tem etiqueta no ML → move para ATENDIDO`);
      }
    }

    if (!deveAtender) continue;

    try {
      await alterarSituacao(token, p.id, SITUACAO_ATENDIDO);
      movidos++;
      marcarProcessado('F2', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F2] Erro ao mover ${p.id}:`, e.message);
    }
  }

  console.log(`[F2] movidos=${movidos}`);
}

async function rotinaExpediente() {
  await comGuard('F1', () => comTokenRenewable(_fluxo1));
}

async function rotinaVirada() {
  console.log('[rotinas] === VIRADA ===');
  limparMemoriaAntiga();
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
}

async function rotinaManha() {
  console.log('[rotinas] === MANHÃ ===');
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
}

module.exports = { rotinaExpediente, rotinaVirada, rotinaManha };
