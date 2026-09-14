'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   F1 e F2 — MOVER PEDIDOS (14/09/2026). Última peça fiscal da fila.

   Medido por CONJUNTO de linhas (o diff posicional mentia por causa de ordem):
   AMB e GOOD são **idênticas**, zero diferença depois de normalizar o nome da
   empresa. Então estas duas nascem daqui.

   A Girassol fica de fora, e não por dívida: ela usa uma ESTRATÉGIA de retentativa
   diferente e coerente. Ela marca o pedido como feito assim que o move é
   confirmado, e por isso precisa de `destravado` pra reabri-lo quando o Bling
   desfaz; a AMB e a GOOD não marcam no sucesso (dependem de o pedido sair da lista
   de ATENDIDO), então não têm o que destravar. Unificar as três aqui significaria
   escolher uma das duas estratégias para todas — decisão de operação, não de
   refatoração, e sem sintoma que a justifique hoje.

   O que fica por empresa: os tetos (quantos pedidos por rodada, quantas vezes
   insistir num pedido que volta, quanto esperar entre tentativas). É ritmo de
   operação; igualar seria decidir o ritmo de uma pela outra.
   ──────────────────────────────────────────────────────────────────────────── */

function criarFluxosPedidos(cfg) {
  for (const nome of ['rotulo', 'pecas', 'envMaxPedidosF1', 'envMaxPedidosF2', 'envF1RemoveMax', 'envF1RemoveEsperaMin']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/fluxos-pedidos: falta ' + nome);
  }
  for (const p of ['blingApi', 'mlApi', 'mlTokenManager', 'tokenManager']) {
    if (!cfg.pecas || !cfg.pecas[p]) throw new Error('lib/fiscal/fluxos-pedidos: falta a peça ' + p);
  }
  const { rotulo } = cfg;

  const { garantirToken, renovarToken } = cfg.pecas.tokenManager;
  const { garantirTokenML } = cfg.pecas.mlTokenManager;
  const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnviosPorLoja,
  alterarSituacao,
  jaProcessado, marcarProcessado, limparMemoriaAntiga
  } = cfg.pecas.blingApi;
  const { getShipmentInfo, getShipmentSubstatus } = cfg.pecas.mlApi;

  const MAX_F1 = parseInt(process.env[cfg.envMaxPedidosF1] || '40');

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
  const REMOVE_MAX       = parseInt(process.env[cfg.envF1RemoveMax] || '8');
  const REMOVE_ESPERA_MS = parseInt(process.env[cfg.envF1RemoveEsperaMin] || '15') * 60000;
  /* 13/09 — memória do que MOVEMOS, pra detectar quando o Bling desfaz (porte da Girassol).
   Um deploy zera o mapa; o que permanece é o log, e é o log que serve de prova. */
  const _movidosPorNos = new Map();
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
  const MAX_F2 = parseInt(process.env[cfg.envMaxPedidosF2] || '60');

  const _rodando = { F1: false, F2: false };

  async function comGuard(fluxo, fn) {
  if (_rodando[fluxo]) {
    console.log(`[${rotulo} fluxos] ${fluxo} já em execução — pulando`);
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
    console.log(`[${rotulo} ML] numeroLoja=${numeroLoja} shipment=${shipmentId} status=${status} substatus=${substatus}`);
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
    console.warn(`[${rotulo} ML] Erro ao consultar ${numeroLoja}: ${e.message} — assumindo sem etiqueta`);
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
  console.log(`[${rotulo} F1] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn(`[${rotulo} F1] Sem token ML:`, e.message);
  }
  let movidos = 0, pulados = 0, ignorados = 0, desfeitos = 0, naoAplicados = 0;
  for (const p of batch) {
    /* 13/09 — PORTE DA GIRASSOL (decisão do dono: "uma tem, agora ambas têm"). Esta empresa
       já percebia que um pedido voltou pra ATENDIDO (o contador de re-move), mas sem a
       PROVA: não guardava a que horas NÓS movemos, então o log não permitia dizer ao
       suporte do Bling "movemos às X e vocês desfizeram Y minutos depois". Sem os dois
       horários, o ticket vira discussão de opinião. */
    {
      const marca = _movidosPorNos.get(String(p.id));
      if (marca) {
        const min = Math.round((Date.now() - marca.em) / 60000);
        console.error(`[${rotulo} F1] \u21a9\ufe0f DESFEITO PELO BLING — pedido ${p.id}` +
          (marca.numero ? ` (nº ${marca.numero})` : '') +
          `: nós movemos pra AGUARDANDO em ${new Date(marca.em).toISOString()} e ele está em ATENDIDO de novo ` +
          `${min} min depois (agora ${new Date().toISOString()}). Não foi a nossa API — provável mapeamento automático do ML no Bling.`);
        _movidosPorNos.delete(String(p.id));
        desfeitos++;
      }
    }
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
      console.error(`[${rotulo} F1] Erro detalhe ${p.id}:`, e.message);
    }
    // PROTEÇÃO: confirma que ainda está em ATENDIDO no momento do processamento
    if (pDetalhe?.situacao?.id !== SITUACAO_ATENDIDO) {
      console.log(`[${rotulo} F1] Pedido ${p.id} situação=${pDetalhe?.situacao?.id} — não é mais ATENDIDO, ignorando`);
      marcarProcessado('F1', p.id);
      ignorados++; continue;
    }
    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[${rotulo} F1] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);
    if (isFlex) { marcarProcessado('F1', p.id); ignorados++; continue; }
    if (rastreio !== '') { marcarProcessado('F1', p.id); ignorados++; continue; }
    // Sem rastreio no Bling → confirma no ML
    const numeroLoja = pDetalhe?.numeroLoja || p?.numeroLoja;
    if (mlToken && numeroLoja) {
      const temEtiqueta = await temEtiquetaML(mlToken, numeroLoja);
      if (temEtiqueta) {
        console.log(`[${rotulo} F1] Pedido ${p.id} tem etiqueta no ML — não move`);
        marcarProcessado('F1', p.id);
        ignorados++;
        continue;
      }
    }
    // Sem etiqueta → move para AGUARDANDO
    try {
      await alterarSituacao(token, p.id, SITUACAO_AGUARDANDO);
      /* 13/09 — PORTE DA GIRASSOL (decisão do dono: "uma tem, agora ambas têm"). O Bling
         responde 200 e NEM SEMPRE aplica: esta empresa marcava o pedido como resolvido em
         cima da resposta, então a falha ficava invisível e o pedido dormia em ATENDIDO.
         Agora relemos e só marcamos como feito se a situação mudou de verdade.
         Custo: 1 leitura por pedido movido. É cota do Bling gasta de propósito — bem mais
         barata que um pedido parado que ninguém vê. */
      await new Promise(r => setTimeout(r, 1200));   // fôlego pro Bling aplicar
      let conferiu = null;
      try {
        const pv = await getPedidoDetalhe(token, p.id);
        conferiu = pv && pv.situacao ? Number(pv.situacao.id) : null;
      } catch (e2) { console.warn(`[${rotulo} F1] não consegui reler ${p.id} p/ conferir: ${e2.message}`); }

      if (conferiu === SITUACAO_AGUARDANDO) {
        movidos++;
        /* guarda QUANDO movemos: é o outro lado do horário que prova o desfeito. Vive em
           memória — deploy zera o mapa, mas as linhas já escritas no log do Render ficam. */
        _movidosPorNos.set(String(p.id), { em: Date.now(), numero: p.numero || null });
      } else if (conferiu === null) {
        /* não deu pra conferir: conta como movido (a chamada foi aceita) mas NÃO marca como
           feito, pra o próximo ciclo verificar de novo */
        movidos++;
        console.warn(`[${rotulo} F1] Pedido ${p.id} — chamada aceita, mas não consegui CONFERIR. Não vou marcar como feito; o próximo ciclo revê.`);
      } else {
        naoAplicados++;
        console.error(`[${rotulo} F1] ⚠️ BLING ACEITOU MAS NÃO APLICOU — pedido ${p.id}` +
          (p.numero ? ` (nº ${p.numero})` : '') +
          `: pedi situação ${SITUACAO_AGUARDANDO} (AGUARDANDO) e ao reler ele está em ${conferiu}. ` +
          `Sem marcar como feito — o próximo ciclo tenta de novo. Registrado em ${new Date().toISOString()}`);
      }
      _rm.n++; _rm.ultimo = Date.now();
      if (_rm.n > 1) console.log(`[${rotulo} F1] Pedido ${p.id} tinha VOLTADO pra ATENDIDO (o Bling desfez) — movido de novo | tentativa ${_rm.n}/${REMOVE_MAX} hoje`);
      if (_rm.n >= REMOVE_MAX) {
        console.log(`[${rotulo} F1] Pedido ${p.id} voltou ${_rm.n}x hoje — desistindo ate a virada. Se persistir, e configuracao do Bling (mapeamento da integracao do ML), nao do nosso lado`);
        marcarProcessado('F1', p.id);
      }
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[${rotulo} F1] Erro ao mover ${p.id}:`, e.message);
    }
  }
  console.log(`[${rotulo} F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}` +
    /* o desfeito só aparece quando acontece: linha limpa no dia normal, e bem visível no dia em que o Bling desfaz */
    (desfeitos ? ` | \u21a9\ufe0f DESFEITOS PELO BLING=${desfeitos}` : '') +
    /* o 'aceitou e não aplicou' também só aparece quando acontece — e quando aparece,
       é a diferença entre um pedido dormindo em ATENDIDO e alguém sabendo disso */
    (naoAplicados ? ` | \u26a0\ufe0f ACEITOS E NÃO APLICADOS=${naoAplicados}` : ''));
  }

  // ── Fluxo 2 — AGUARDANDO → ATENDIDO ──────────────────────────────────
  async function _fluxo2(token) {
  const { inicial, final } = getPeriodo();
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const batch = lista.slice(0, MAX_F2);
  console.log(`[${rotulo} F2] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn(`[${rotulo} F2] Sem token ML:`, e.message);
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
      console.error(`[${rotulo} F2] Erro detalhe ${p.id}:`, e.message);
    }
    // PROTEÇÃO CRÍTICA: só move se ainda está em AGUARDANDO.
    // Isso impede que pedidos em DESPACHADOS (745123), Cancelado, etc.
    // sejam alterados por engano.
    if (pDetalhe?.situacao?.id !== SITUACAO_AGUARDANDO) {
      console.log(`[${rotulo} F2] Pedido ${p.id} situação=${pDetalhe?.situacao?.id} — não é AGUARDANDO, ignorando`);
      continue;
    }
    const rastreio = getCodigoRastreio(pDetalhe);
    const isFlex = String(pDetalhe?.transporte?.volumes?.[0]?.servico || '').toUpperCase().includes('FLEX');
    console.log(`[${rotulo} F2] Pedido ${p.id} | loja=${p.loja?.id} | rastreio="${rastreio}" | flex=${isFlex}`);
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
        if (deveAtender) console.log(`[${rotulo} F2] Pedido ${p.id} tem etiqueta no ML → move para ATENDIDO`);
      }
    }
    if (!deveAtender) continue;
    try {
      await alterarSituacao(token, p.id, SITUACAO_ATENDIDO);
      movidos++;
      marcarProcessado('F2', p.id);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[${rotulo} F2] Erro ao mover ${p.id}:`, e.message);
    }
  }
  console.log(`[${rotulo} F2] movidos=${movidos}`);
  }

  async function rotinaExpediente() {
  await comGuard('F1', () => comTokenRenewable(_fluxo1));
  }

  async function rotinaVirada() {
  console.log(`[${rotulo} rotinas] === VIRADA ===`);
  limparMemoriaAntiga();
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
  }

  async function rotinaManha() {
  console.log(`[${rotulo} rotinas] === MANHÃ ===`);
  await comGuard('F2', () => comTokenRenewable(_fluxo2));
  }

  return { rotinaExpediente, rotinaVirada, rotinaManha };

}

module.exports = { criarFluxosPedidos };
