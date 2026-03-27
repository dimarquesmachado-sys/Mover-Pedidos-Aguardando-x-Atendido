'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  isMercadoEnviosPorLoja, getCodigoRastreio,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga
} = require('./blingApi');

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

// ── Fluxo 1 — ATENDIDO → AGUARDANDO ──────────────────────────────────
// Só atua em pedidos do Mercado Livre (por loja ID).
// Busca detalhe individual para verificar o rastreio real.
async function _fluxo1(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_ATENDIDO, inicial, final);
  const batch = lista.slice(0, MAX_F1);

  console.log(`[F1] ${lista.length} encontrados | processando ${batch.length}`);

  let movidos = 0, pulados = 0, ignorados = 0;

  for (const p of batch) {
    if (jaProcessado('F1', p.id)) { pulados++; continue; }

    // Ignora pedidos que não são do ML (verificação rápida por loja)
    if (!isMercadoEnviosPorLoja(p)) {
      marcarProcessado('F1', p.id);
      ignorados++;
      continue;
    }

    // Busca detalhe completo para ter o transporte/rastreio
    let pDetalhe = null;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F1] Erro detalhe ${p.id}:`, e.message);
    }

    if (!pDetalhe) {
      console.log(`[F1] Pedido ${p.id} — detalhe não obtido, pulando`);
      continue;
    }

    const rastreio = getCodigoRastreio(pDetalhe);
    console.log(`[F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}"`);

    // Tem rastreio → etiqueta OK, estoquista pode trabalhar. Não mexe.
    if (rastreio !== '') {
      marcarProcessado('F1', p.id);
      ignorados++;
      continue;
    }

    // Sem rastreio → move para AGUARDANDO e não verifica mais hoje
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

  let movidos = 0;

  for (const p of batch) {
    if (jaProcessado('F2', p.id)) { continue; }

    if (!isMercadoEnviosPorLoja(p)) continue;

    let pDetalhe = null;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F2] Erro detalhe ${p.id}:`, e.message);
    }

    if (!pDetalhe) continue;

    const rastreio = getCodigoRastreio(pDetalhe);
    console.log(`[F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}"`);

    if (rastreio === '') continue;

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
