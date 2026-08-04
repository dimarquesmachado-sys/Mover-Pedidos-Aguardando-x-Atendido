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
    // 27/07 — CORREÇÃO: 'ready_to_ship' NÃO significa que a etiqueta existe.
    // O substatus 'invoice_pending' quer dizer que o ML ainda não fechou a etapa dele (a etiqueta
    // NÃO é imprimível — a API responde NOT_PRINTABLE_STATUS). Antes esses pedidos eram tratados
    // como "tem etiqueta" e ficavam parados em ATENDIDO, entupindo a lista do galpão com pedido
    // que ninguém consegue despachar. Agora eles voltam pra AGUARDANDO e retornam sozinhos quando
    // a etiqueta liberar.
    const SEM_ETIQUETA_AINDA = ['invoice_pending', 'buffered', 'ready_to_print_pending', 'regenerating'];
    if (SEM_ETIQUETA_AINDA.includes(String(substatus || ''))) {
      console.log(`[ML] numeroLoja=${numeroLoja} substatus=${substatus} — etiqueta AINDA não imprimível, pode mover`);
      return false;
    }
    if (status === 'ready_to_ship') return true;
    return true;
  } catch (e) {
    console.warn(`[ML] Erro ao consultar ${numeroLoja}: ${e.message} — assumindo sem etiqueta`);
    return false;
  }
}

// ── Fluxo 1 — ATENDIDO → AGUARDANDO ────────────────────────────────────────────
// 30/07: memória do que MOVEMOS, pra detectar quando o Bling desfaz. Vive em memória:
// um deploy zera o mapa, mas as linhas já escritas no log do Render permanecem — e é o log
// que serve de prova.
const _movidosPorNos = new Map();

// ── 04/08: FREIO + RE-MOVE ────────────────────────────────────────────────────
// A Girassol já detectava o desfeito e já conferia se o PATCH pegou de verdade (bloco de
// 30/07 mais abaixo). Faltavam duas coisas:
//  (a) quando o Bling ACEITA e não aplica (ou não dá pra conferir), o pedido não é marcado
//      como feito — então o F1 reinsistia A CADA 3 MINUTOS, sem teto, o dia inteiro;
//  (b) quando o Bling DESFAZ um move já confirmado, o pedido voltava pra ATENDIDO mas o
//      `jaProcessado` daquele dia continuava valendo, então ele NÃO era movido de novo e
//      passava o resto do dia na fila do estoquista.
// Agora o desfeito DESTRAVA o pedido (move de novo, igual GOOD e AMBTotal) e toda tentativa
// passa por um freio — cada uma custa chamada no Bling (que já trabalha no teto do 429) e
// escreve uma ocorrência nova no histórico do pedido:
//   • espera F1_REMOVE_ESPERA_MIN minutos entre tentativas do MESMO pedido (padrão 15)
//   • no máximo F1_REMOVE_MAX tentativas por pedido por dia (padrão 8); depois desiste até
//     a virada, pra não ficar em ping-pong infinito com o Bling
const REMOVE_MAX       = parseInt(process.env.F1_REMOVE_MAX || '8');
const REMOVE_ESPERA_MS = parseInt(process.env.F1_REMOVE_ESPERA_MIN || '15') * 60000;
const _reMove = new Map();   // idPedido -> { dia, n, ultimo, destravado }
function _tentativas(id) {
  const hoje = new Date().toISOString().slice(0, 10);
  const r = _reMove.get(id);
  if (r && r.dia === hoje) return r;
  if (_reMove.size > 2000) { for (const [k, v] of _reMove) if (v.dia !== hoje) _reMove.delete(k); }
  const novo = { dia: hoje, n: 0, ultimo: 0, destravado: false, desistiu: false };
  _reMove.set(id, novo);
  return novo;
}

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
  console.log(`[F1] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[F1] Sem token ML:', e.message);
  }
  let movidos = 0, pulados = 0, ignorados = 0;
  let naoAplicados = 0, desfeitos = 0;   // 30/07: Bling aceitou mas não aplicou / desfez depois
  for (const p of batch) {
    const _rm = _tentativas(p.id);
    // 30/07: se ESTE pedido já foi movido por nós e está de volta na lista de ATENDIDO,
    // alguém desfez. Registramos com os dois horários — é a prova pro ticket do Bling.
    {
      const marca = _movidosPorNos.get(String(p.id));
      if (marca) {
        const min = Math.round((Date.now() - marca.em) / 60000);
        console.error(`[F1] \u21a9\ufe0f DESFEITO PELO BLING — pedido ${p.id}` +
          (marca.numero ? ` (nº ${marca.numero})` : '') +
          `: nós movemos pra AGUARDANDO em ${new Date(marca.em).toISOString()} e ele está em ATENDIDO de novo ` +
          `${min} min depois (agora ${new Date().toISOString()}). Não foi a nossa API — provável mapeamento automático do ML no Bling.`);
        _movidosPorNos.delete(String(p.id));
        desfeitos++;
        // 04/08: o pedido tinha sido marcado como feito quando o move foi confirmado; como o
        // Bling desfez, destrava pra ele voltar a ser movido (o freio abaixo segura o ritmo).
        // Se já desistimos deste pedido hoje (teto batido), NÃO destrava — senão o desfeito
        // reabria o pedido a cada ciclo e o teto nunca valia.
        if (!_rm.desistiu) _rm.destravado = true;
      }
    }
    if (!_rm.destravado && jaProcessado('F1', p.id)) { pulados++; continue; }
    // Já tentamos este pedido hoje: espera o intervalo antes de insistir. Fica ANTES do
    // detalhe de propósito — evita gastar chamada do Bling à toa.
    if (_rm.n > 0 && (Date.now() - _rm.ultimo) < REMOVE_ESPERA_MS) { pulados++; continue; }
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

    // PROTEÇÃO: só move se ainda estiver em ATENDIDO no detalhe atualizado
    // Defende contra pedidos que mudaram de situação entre a listagem e o detalhe
    if (pDetalhe?.situacao?.id !== SITUACAO_ATENDIDO) {
      console.log(`[F1] Pedido ${p.id} já não está em ATENDIDO (situação atual: ${pDetalhe?.situacao?.id}) — pulando`);
      ignorados++;
      continue;
    }

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
      // 04/08: conta a tentativa (toda chamada custa API e escreve ocorrência no pedido)
      _rm.n++; _rm.ultimo = Date.now();
      if (_rm.n > 1) console.log(`[F1] Pedido ${p.id} — nova tentativa de mover pra AGUARDANDO | ${_rm.n}/${REMOVE_MAX} hoje`);
      // ── 30/07: CONFERE SE PEGOU ─────────────────────────────────────────────────────────────
      // Caso real (pedidos 117517 e 117610): o Bling ACEITA a chamada, registra a ocorrência
      // "Situação alterada via API v3", responde sucesso — e depois o pedido volta pra ATENDIDO
      // por uma ocorrência SEM DESCRIÇÃO (o mapeamento automático do ML). Antes a gente confiava
      // na resposta e marcava como resolvido, então a falha ficava invisível.
      // Agora: relemos o pedido, e só marcamos como feito se a situação REALMENTE mudou.
      await new Promise(r => setTimeout(r, 1200));   // fôlego pro Bling aplicar
      let conferiu = null;
      try {
        const pv = await getPedidoDetalhe(token, p.id);
        conferiu = pv && pv.situacao ? Number(pv.situacao.id) : null;
      } catch (e2) { console.warn(`[F1] não consegui reler ${p.id} p/ conferir: ${e2.message}`); }

      if (conferiu === SITUACAO_AGUARDANDO) {
        movidos++;
        marcarProcessado('F1', p.id);
        _movidosPorNos.set(String(p.id), { em: Date.now(), numero: p.numero || null });
      } else if (conferiu === null) {
        // não deu pra conferir: conta como movido (a chamada foi aceita) mas NÃO marca,
        // pra o próximo ciclo verificar de novo
        movidos++;
        console.warn(`[F1] Pedido ${p.id} — chamada aceita, mas não consegui CONFERIR. Não vou marcar como feito; o próximo ciclo revê.`);
      } else {
        naoAplicados++;
        console.error(`[F1] ⚠️ BLING ACEITOU MAS NÃO APLICOU — pedido ${p.id}` +
          (p.numero ? ` (nº ${p.numero})` : '') +
          `: pedi situação ${SITUACAO_AGUARDANDO} (AGUARDANDO) e ao reler ele está em ${conferiu}. ` +
          `Sem marcar como feito — o próximo ciclo tenta de novo. ` +
          `Registrado em ${new Date().toISOString()}`);
      }
      if (_rm.n >= REMOVE_MAX && !_rm.desistiu) {
        console.log(`[F1] Pedido ${p.id} — ${_rm.n} tentativas hoje, desistindo até a virada. ` +
          `Se persistir, é configuração do Bling (mapeamento da integração do ML), não do nosso lado`);
        _rm.desistiu = true;
        _rm.destravado = false;
        marcarProcessado('F1', p.id);
      }
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F1] Erro ao mover ${p.id}:`, e.message);
    }
  }
  console.log(`[F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}` +
    (naoAplicados ? ` | \u26a0\ufe0f BLING N\u00c3O APLICOU=${naoAplicados}` : '') +
    (desfeitos ? ` | \u21a9\ufe0f DESFEITOS PELO BLING=${desfeitos}` : ''));
}

// ── Fluxo 2 — AGUARDANDO → ATENDIDO ────────────────────────────────────────────
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

    // FIX BUG (27/06/2026): usar pDetalhe (atualizado) em vez de p (lista inicial, dado velho)
    // Antes era: if (p.situacao?.id !== SITUACAO_AGUARDANDO) continue;
    // O dado da lista pode ter minutos de defasagem, e o pedido pode ter sido CANCELADO no Bling
    if (pDetalhe?.situacao?.id !== SITUACAO_AGUARDANDO) {
      console.log(`[F2] Pedido ${p.id} já não está em AGUARDANDO (situação atual: ${pDetalhe?.situacao?.id}) — pulando`);
      continue;
    }

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

    // PROTEÇÃO EXTRA: re-checa situação IMEDIATAMENTE antes do PATCH
    // Defende contra mudanças que aconteceram durante o temEtiquetaML (que demora 1-2s)
    try {
      const pFresh = await getPedidoDetalhe(token, p.id);
      if (pFresh?.situacao?.id !== SITUACAO_AGUARDANDO) {
        console.log(`[F2] ⚠️ Pedido ${p.id} mudou de situação durante processamento (agora ${pFresh?.situacao?.id}) — ABORTANDO move por segurança`);
        continue;
      }
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F2] Erro na re-checagem ${p.id}:`, e.message, '— por segurança NÃO vou mover');
      continue;
    }

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
