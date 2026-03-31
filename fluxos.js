'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnvios,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga,
  getNFesAutorizadas, getNFeDetalhe, enviarNFeParaLojaVirtual
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
    const volumes = pDetalhe?.transporte?.volumes || [];
    console.log(`[F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex} | volumes=${volumes.length}`);

    if (isFlex) { marcarProcessado('F1', p.id); ignorados++; continue; }
    if (rastreio !== '') { marcarProcessado('F1', p.id); ignorados++; continue; }
    if (volumes.length === 0) { marcarProcessado('F1', p.id); ignorados++; continue; }

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
    const volumes = pDetalhe?.transporte?.volumes || [];
    const dataEmissao = new Date(p.data);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const maisDeUmDia = dataEmissao < hoje;
    console.log(`[F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex} | volumes=${volumes.length}`);

    if (p.situacao?.id !== SITUACAO_AGUARDANDO) continue;

    const deveAtender = isFlex || rastreio !== '' || (volumes.length === 0 && maisDeUmDia);
    if (!deveAtender) continue;

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

// ─── F3: Sincronizar NF-e do Bling para o ML ─────────────────────────────────

async function _fluxo3(token) {
  const { inicial, final } = getPeriodo();
  const nfs = await getNFesAutorizadas(token, inicial, final);
  console.log(`[F3] ${nfs.length} NFs autorizadas encontradas`);

  let sincronizadas = 0, puladas = 0, ignoradas = 0;

  for (const nf of nfs) {
    const nfId = nf.id;

    if (jaProcessado('F3', nfId)) { puladas++; continue; }

    // Buscar detalhe da NF para pegar o pedido vinculado
    let nfDetalhe;
    try {
      nfDetalhe = await getNFeDetalhe(token, nfId);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F3] Erro detalhe NF ${nfId}:`, e.message);
      continue;
    }

    // Verificar se tem pedido de venda vinculado
    const pedidoVinculado = nfDetalhe?.pedidoVenda;
    if (!pedidoVinculado?.id) {
      console.log(`[F3] NF ${nfId} sem pedido vinculado — ignorando`);
      marcarProcessado('F3', nfId);
      ignoradas++;
      continue;
    }

    // Buscar detalhe do pedido para confirmar se é loja ML
    let pedido;
    try {
      pedido = await getPedidoDetalhe(token, pedidoVinculado.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F3] Erro detalhe pedido ${pedidoVinculado.id}:`, e.message);
      continue;
    }

    if (!isMercadoEnvios(pedido)) {
      marcarProcessado('F3', nfId);
      ignoradas++;
      continue;
    }

    console.log(`[F3] NF ${nfId} → Pedido ${pedidoVinculado.id} → ML. Enviando...`);

    try {
      await enviarNFeParaLojaVirtual(token, nfId);
      marcarProcessado('F3', nfId);
      sincronizadas++;
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F3] ❌ Erro ao enviar NF ${nfId}:`, e.message);
    }
  }

  console.log(`[F3] sincronizadas=${sincronizadas} | ignoradas=${ignoradas} | já feitas=${puladas}`);
}

// ─── Rotinas públicas ─────────────────────────────────────────────────────────

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

async function rotinaNFe() {
  console.log('[rotinas] === NF-e ML ===');
  await comGuard('F1', () => comTokenRenewable(_fluxo3));
}

module.exports = { rotinaExpediente, rotinaVirada, rotinaManha, rotinaNFe };
