'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnvios,
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
  try {
    await fn();
  } finally {
    _rodando[fluxo] = false;
  }
}

async function comTokenRenewable(fn) {
  try {
    return await fn(await garantirToken());
  } catch (e) {
    if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') {
      console.log('[fluxos] Token expirado mid-flight — renovando e retentando...');
      const token = await renovarToken();
      return await fn(token);
    }
    throw e;
  }
}

async function _fluxo1(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_ATENDIDO, inicial, final);
  const batch = lista.slice(0, MAX_F1);

  console.log(`[F1] ${lista.length} encontrados | processando ${batch.length}`);

  let movidos = 0, pulados = 0, ignorados = 0;

  for (const p of batch) {
    if (jaProcessado('F1', p.id)) { pulados++; continue; }

    if (!isMercadoEnvios(p)) {
      marcarProcessado('F1', p.id);
      ignorados++;
      continue;
    }

    let pDetalhe = p;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id) || p;
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F1] Erro ao buscar detalhe ${p.id}:`, e.message);
    }

    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);

    // FLEX = entrega por motoboy, etiqueta sempre disponível → não move
    if (isFlex) {
      marcarProcessado('F1', p.id);
      ignorados++;
      continue;
    }

    if (rastreio !== '') {
      marcarProcessado('F1', p.id);
      ignorados++;
      continue;
    }

    try {
      await alterarSituacao(token, p.id, SITUACAO_AGUARDANDO);
      movidos++;
      marcarProcessado('F1', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F1] Erro pedido ${p.id}:`, e.message);
    }
  }

  console.log(`[F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}`);
}

async function _fluxo2(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const batch = lista.slice(0, MAX_F2);

  console.log(`[F2] ${lista.length} encontrados | processando ${batch.length}`);

  let movidos = 0;

  for (const p of batch) {
    if (jaProcessado('F2', p.id)) { console.log(`[F2] Pedido ${p.id} já processado hoje — pulando`); continue; }

    let pDetalhe = p;
    try {
      pDetalhe = await getPedidoDetalhe(token, p.id) || p;
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F2] Erro ao buscar detalhe ${p.id}:`, e.message);
    }

    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);

    if (p.situacao?.id !== SITUACAO_AGUARDANDO) continue;

    // FLEX sempre tem etiqueta disponível → move de volta para ATENDIDO
    // Pedido normal sem rastreio → deixa em AGUARDANDO
    if (!isFlex && rastreio === '') continue;

    try {
      await alterarSituacao(token, p.id, SITUACAO_ATENDIDO);
      movidos++;
      marcarProcessado('F2', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F2] Erro pedido ${p.id}:`, e.message);
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
