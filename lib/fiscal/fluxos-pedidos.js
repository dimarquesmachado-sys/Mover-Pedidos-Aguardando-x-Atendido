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
  const nfTokenManager = cfg.pecas.nfTokenManager || null;   // opcional: fallback do gerar-nfe quando o app comum não tem o escopo de notas
  const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnviosPorLoja,
  alterarSituacao, gerarNFeDoPedido,
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

  /* 20/10: trava e estado do F1/F2 vêm da peça única lib/fiscal/trava-fluxos (a trava solta sozinha se uma rodada
     ficar presa; o estado de cada rodada sai em /diagnostico/fluxos) */
  const _trava = require('./trava-fluxos').criarTravaFluxos(rotulo);
  const comGuard = _trava.comGuard;

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
  /* 17/10 — A NOTA QUANDO O ML PEDE. A emissão automática do Bling pode estar desligada (Girassol, out/2026: o dono vende
     com prazo de disponibilidade pra faturar no mês seguinte). Pedido do ML parado no AGUARDANDO com o envio em
     invoice_pending ("Pronta para emitir NF-e") e SEM nota no Bling: o sistema GERA a nota do pedido. É o clique do dono
     em "Já tenho os produtos" (o ML passa a pedir a nota) ou o dia da coleta programada chegando. A nota nasce pendente;
     o Corrigir-NFs transmite e o F3 manda pro ML; com a etiqueta, este F2 leva pro ATENDIDO.
       · espera EMITIR_NF_ESPERA_MIN (30) desde a 1ª vez que viu o ML pedindo — a emissão automática do Bling, se ligada,
         chega antes e aí não há o que fazer;
       · pedido das LIXAS A-COMBINAR fica de fora (o módulo das lixas emite depois de acertar o grão);
       · gerada (ou resposta ambígua), não tenta de novo por 6 h — o Bling mostra a nota no pedido nesse meio-tempo;
       · <EMPRESA>_EMITIR_NF_QUANDO_ML_PEDIR=0 desliga. */
  const _mlPediuNF = new Map();   // id -> { desde, visto }
  const _nfGeradaPorNos = new Map();
  /* Codex #712: o estado não pode viver além do pedido. Quem some do invoice_pending (a emissão automática andou o envio,
     ou o pedido saiu da lista) deixa de ser visto: passadas 2 h sem aparecer, o registro cai e a espera recomeça do zero
     se ele voltar; o "gerada" cai junto com a trava de 6 h. Poda a cada chamada (os mapas são pequenos). */
  function _podarEstadoNF(agora) {
    for (const [k, v] of _mlPediuNF) if (agora - v.visto > 12 * 3600000) _mlPediuNF.delete(k);   /* 12 h: mais que uma volta inteira do rodízio do F2 (Codex #712) */
    for (const [k, t] of _nfGeradaPorNos) if (agora - t >= 6 * 3600000) _nfGeradaPorNos.delete(k);
  }
  /* Codex #712: o gerar-nfe pode exigir o escopo de notas, que o app comum do Bling nem sempre tem (403). Nesse caso — e só
     nele, que não é ambíguo e por isso é seguro repetir — tenta com o token do app NF (o mesmo do Corrigir-NFs). */
  async function _gerarNFeComFallback(token, idPedido) {
    let r = await gerarNFeDoPedido(token, idPedido);
    if (r && !r.ok && r.status === 403 && nfTokenManager) {
      try { r = await gerarNFeDoPedido(await nfTokenManager.garantirTokenNF(), idPedido); }
      catch (e) { r = { ok: false, erro: 'token NF: ' + String((e && e.message) || e).slice(0, 160) }; }
    }
    return r;
  }
  async function _emitirNFQuandoMLPede(token, p, pDet) {
    if (String(process.env[cfg.envEmitirNfMl || (rotulo + '_EMITIR_NF_QUANDO_ML_PEDIR')] || '1') === '0') return;
    const id = String(p.id), agora = Date.now();
    _podarEstadoNF(agora);
    /* Codex #712: o Bling pode mandar notaFiscal como { id } OU direto o id */
    const _nfRef = (pDet && pDet.notaFiscal != null) ? (typeof pDet.notaFiscal === 'object' ? pDet.notaFiscal.id : pDet.notaFiscal) : null;
    if (_nfRef && String(_nfRef) !== '0') { _mlPediuNF.delete(id); return; }   // já tem nota
    const itens = (pDet && pDet.itens) || [];
    if (require('./lixas-a-combinar').temLixaACombinar(itens) !== false) return;   /* Codex #712: catálogo das lixas é a fonte (marcador fora do prefixo, SKU sem marcador); não deu pra saber = não gera */
    const ger = _nfGeradaPorNos.get(id);
    if (ger && agora - ger < 6 * 3600000) return;
    const visto = _mlPediuNF.get(id);
    if (!visto) { _mlPediuNF.set(id, { desde: agora, visto: agora }); return; }
    visto.visto = agora;
    if (agora - visto.desde < Number(process.env.EMITIR_NF_ESPERA_MIN || 30) * 60000) return;
    let r = null;
    try { r = await _gerarNFeComFallback(token, p.id); }
    catch (e) { if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e; r = { ok: false, erro: e.message }; }
    if (r && (r.ok || r.ambiguo)) { _nfGeradaPorNos.set(id, agora); _mlPediuNF.delete(id); }
    console.log(`[${rotulo} F2] Pedido ${p.id} — o ML pediu a nota e o Bling não tinha: ` + (r && r.ok ? 'NF gerada' + (r.nfId ? ' (' + r.nfId + ')' : '') + ' — o Corrigir-NFs transmite' : (r && r.ambiguo ? 'resposta ambígua (confiro no próximo ciclo)' : 'falhou: ' + (r && r.erro))));
  }

  async function temEtiquetaML(mlToken, numeroLoja, saida) {   /* saida (opcional): recebe status/substatus do envio */
  try {
    const shipmentId = await getShipmentInfo(mlToken, numeroLoja);
    const { status, substatus } = await getShipmentSubstatus(mlToken, shipmentId);
      if (saida) { saida.status = status; saida.substatus = substatus; }
    console.log(`[${rotulo} ML] numeroLoja=${numeroLoja} shipment=${shipmentId} status=${status} substatus=${substatus}`);
    // Proteção caso de borda: status pronto p/ envio → tem etiqueta (mesmo se substatus='buffered')
    // 28/07 — 'ready_to_ship' NÃO garante etiqueta: com substatus 'invoice_pending' o ML ainda não
    // fechou a etapa dele e a etiqueta NÃO é imprimível (a API responde NOT_PRINTABLE_STATUS).
    // Esses pedidos ficavam presos em ATENDIDO entupindo a lista do galpão.
    const SEM_ETIQUETA_AINDA = ['invoice_pending', 'buffered', 'ready_to_print_pending', 'regenerating'];
    /* 17/10 — VENDA COM PRAZO DE DISPONIBILIDADE ("Aguardando disponibilidade de estoque" no ML): substatus
       manufacturing, em pending OU handling (doc oficial de envios do ML). Não há etiqueta até o vendedor clicar
       "Já estou com o produto" — e o dono vende assim de propósito, pra faturar depois. Antes caía no "return true"
       lá embaixo: o F1 deixava o pedido no ATENDIDO (o checkout mostrava como "sem etiqueta") e o F2 o puxava de
       volta pra lá. Agora conta como sem etiqueta: o F1 leva pro AGUARDANDO e o F2 só devolve ao ATENDIDO quando o ML
       liberar a etiqueta (o envio programado — buffered — já seguia essa regra). */
    if (/manufacturing/i.test(String(substatus || ''))) {
      console.log(`[ML] numeroLoja=${numeroLoja} substatus=${substatus} — aguardando disponibilidade de estoque no ML, sem etiqueta`);
      return false;
    }
    if (SEM_ETIQUETA_AINDA.includes(String(substatus || ''))) {
      console.log(`[ML] numeroLoja=${numeroLoja} substatus=${substatus} — etiqueta AINDA não imprimível, pode mover`);
      return false;
    }
    if (status === 'ready_to_ship') return true;
    if (substatus === 'buffered') return false;
    return true;
  } catch (e) {
    if (saida && (e.name === 'FetchError' || e.name === 'AbortError' || /erro (429|5\d\d)\b/.test(String(e.message)))) saida.indeterminado = true;   /* prazo/rede/5xx: NÃO é 'sem etiqueta' — o F1 não move (Codex #722) */
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
  /* 19/10 (Codex #712): pedido já resolvido hoje (processado, sem marca de "desfeito pelo Bling") vai pro FIM da fila —
     senão os MAX_F1 mais novos ocupavam o lote toda rodada e um mais antigo (ex.: venda adiada pelo ML) nunca era visto */
  const _pendF1 = _ord.filter(p => !jaProcessado('F1', p.id) || _movidosPorNos.has(String(p.id)));
  const _feitosF1 = _ord.filter(p => jaProcessado('F1', p.id) && !_movidosPorNos.has(String(p.id)));
  const batch = _pendF1.concat(_feitosF1).slice(0, MAX_F1);
  console.log(`[${rotulo} F1] ${lista.length} encontrados | processando ${batch.length}`);
  _trava.anotar('F1', { encontrados: lista.length, processando: batch.length });
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    _trava.anotar('F1', { semTokenML: String((e && e.message) || e).slice(0, 160) });
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
      const _envF1 = {};
        const temEtiqueta = await temEtiquetaML(mlToken, numeroLoja, _envF1);
      if (_envF1.indeterminado) { console.warn(`[F1] Pedido ${p.id}: ML sem resposta (prazo/rede) — não sei se tem etiqueta, não movo; vejo na próxima rodada`); ignorados++; continue; }
        /* 17/10 (Codex #712): adiado pelo ML (aguardando estoque / coleta programada) entra na lista — o F2 o acompanha além da janela */
        if (!temEtiqueta && _adiados.adiado(_envF1.substatus) && !_adiados.registrar(String(rotulo).toLowerCase(), p.id, { substatus: _envF1.substatus })) console.warn(`[F1] pedido ${p.id} adiado pelo ML, mas a lista de adiados não gravou (disco) — o F2 registra de novo na próxima rodada`);
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
  _trava.anotar('F1', { movidos, ignorados, pulados });
  console.log(`[${rotulo} F1] movidos=${movidos} | ignorados=${ignorados} | já processados=${pulados}` +
    /* o desfeito só aparece quando acontece: linha limpa no dia normal, e bem visível no dia em que o Bling desfaz */
    (desfeitos ? ` | \u21a9\ufe0f DESFEITOS PELO BLING=${desfeitos}` : '') +
    /* o 'aceitou e não aplicou' também só aparece quando acontece — e quando aparece,
       é a diferença entre um pedido dormindo em ATENDIDO e alguém sabendo disso */
    (naoAplicados ? ` | \u26a0\ufe0f ACEITOS E NÃO APLICADOS=${naoAplicados}` : ''));
  }

  // ── Fluxo 2 — AGUARDANDO → ATENDIDO ──────────────────────────────────
  const _adiados = require('./f2-adiados');   /* 17/10: pedidos adiados pelo ML (ver lib/fiscal/f2-adiados.js) */
  let _cursorF2 = 0;
  async function _fluxo2(token) {
  const { inicial, final } = getPeriodo();
  const _adiadosF2 = _adiados.podar(String(rotulo).toLowerCase());
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const _lista2 = lista;
  /* lote em rodízio: com mais pedidos que MAX_F2, cada rodada pega a próxima fatia (nenhum fica sempre de fora) */
  const _ini2 = _lista2.length > MAX_F2 ? (_cursorF2 % _lista2.length) : 0;
  const batch = _lista2.length > MAX_F2 ? _lista2.slice(_ini2, _ini2 + MAX_F2).concat(_lista2.slice(0, Math.max(0, _ini2 + MAX_F2 - _lista2.length))) : _lista2;
  _cursorF2 += MAX_F2;
  /* 19/10 (Codex #712): pedido ADIADO pelo ML que já saiu da janela de 15 dias não vem na lista (e a lista é paginada) —
     busca pelo id: no máximo a cada 30 min por pedido e até 20 por rodada. Só sai da lista de adiados quando o detalhe
     CONFIRMA que não está mais no AGUARDANDO (foi pro ATENDIDO, cancelou...) — nunca só porque o PATCH respondeu. */
  { const _naLista = new Set(lista.map(x => String(x && x.id)));
    let _extra = 0;
    /* Codex #712: fila pela hora marcada (quem nunca foi conferido primeiro, depois o mais atrasado) — sem isso, com
       mais de 40 adiados, os do fim do mapa nunca chegavam a vez */
    const _filaA = Object.entries(_adiadosF2).sort((a, b) => (Number(a[1] && a[1].proxima) || 0) - (Number(b[1] && b[1].proxima) || 0));
    for (const [idA, regA] of _filaA) {
      if (_extra >= 20) break;
      if (_naLista.has(idA)) continue;
      if (regA && regA.proxima && Date.now() < Number(regA.proxima)) continue;
      _extra++;
      let detA = null;
      try { detA = await getPedidoDetalhe(token, idA); }
      catch (e) { if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e; detA = null; }
      if (detA && detA.situacao && Number(detA.situacao.id) !== Number(SITUACAO_AGUARDANDO)) { _adiados.remover(String(rotulo).toLowerCase(), idA); continue; }
      _adiados.agendar(String(rotulo).toLowerCase(), idA, Date.now() + 30 * 60000);
      if (detA && detA.situacao) batch.push(detA);
    } }
  console.log(`[${rotulo} F2] ${lista.length} encontrados | processando ${batch.length}`);
  _trava.anotar('F2', { encontrados: lista.length, processando: batch.length });
  let _naoME = 0, _comEtq = 0, _semEtq = 0;
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    _trava.anotar('F2', { semTokenML: String((e && e.message) || e).slice(0, 160) });
    console.warn(`[${rotulo} F2] Sem token ML:`, e.message);
  }
  let movidos = 0;
  for (const p of batch) {
    if (jaProcessado('F2', p.id)) { continue; }
    if (!isMercadoEnviosPorLoja(p)) { _naoME++; _trava.decidiu('F2', { id: p.id, numero: p.numero, loja: p.loja && p.loja.id, decisao: 'loja fora do Mercado Envios' }); continue; }
    let pDetalhe = p, detalheOk = false;   // Codex #712: sem o detalhe (nota, itens) não dá pra gerar nota com segurança
    try {
      const _det = await getPedidoDetalhe(token, p.id);
      if (_det) { pDetalhe = _det; detalheOk = true; }
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
    let _envF2Ult = null;   /* o que o ML disse do envio (status/substatus) — vai pra amostra */
    if (isFlex) {
      deveAtender = true;
    } else if (rastreio !== '') {
      deveAtender = true;
    } else {
      // Sem rastreio → verifica no ML
      const numeroLoja = pDetalhe?.numeroLoja || p?.numeroLoja;
      if (mlToken && numeroLoja) {
        const _envF2 = {};
        _envF2Ult = _envF2;
        deveAtender = await temEtiquetaML(mlToken, numeroLoja, _envF2);
        /* 17/10: o ML pede a nota e o Bling não tem — gera (ver _emitirNFQuandoMLPede) */
        if (!deveAtender && detalheOk && String(_envF2.substatus || '') === 'invoice_pending') await _emitirNFQuandoMLPede(token, p, pDetalhe);
        if (!deveAtender && _adiados.adiado(_envF2.substatus) && !_adiados.registrar(String(rotulo).toLowerCase(), p.id, { substatus: _envF2.substatus })) console.warn(`[F2] pedido ${p.id} adiado pelo ML, mas a lista de adiados não gravou (disco) — tento de novo na próxima rodada`);
        if (deveAtender) console.log(`[${rotulo} F2] Pedido ${p.id} tem etiqueta no ML → move para ATENDIDO`);
      }
    }
    _trava.decidiu('F2', { id: p.id, numero: p.numero, flex: isFlex, rastreio: !!rastreio, ml: (typeof _envF2Ult !== 'undefined' && _envF2Ult) || null, decisao: deveAtender ? 'mover pro ATENDIDO' : 'fica (sem etiqueta no ML)' });
    if (deveAtender) _comEtq++; else _semEtq++;
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
  _trava.anotar('F2', { movidos, foraDoMercadoEnvios: _naoME, comEtiqueta: _comEtq, semEtiqueta: _semEtq });
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

  return { rotinaExpediente, rotinaVirada, rotinaManha, estadoFluxos: () => _trava.estado() };

}

module.exports = { criarFluxosPedidos };
