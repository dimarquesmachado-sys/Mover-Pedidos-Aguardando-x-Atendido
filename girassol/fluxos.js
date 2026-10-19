'use strict';

const { garantirToken, renovarToken } = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');
const nfTokenManager = require('./nfTokenManager');   // fallback do gerar-nfe (403 = app comum sem o escopo de notas)
const {
  SITUACAO_ATENDIDO, SITUACAO_AGUARDANDO,
  getPeriodo,
  getPedidosPorStatus, getPedidoDetalhe,
  getCodigoRastreio, isMercadoEnviosPorLoja,
  alterarSituacao, gerarNFeDoPedido,
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
/* Codex #712: o estado não pode viver além do pedido (2 h sem ser visto no invoice_pending: a espera recomeça; "gerada" cai com a trava de 6 h). */
function _podarEstadoNF(agora) {
  for (const [k, v] of _mlPediuNF) if (agora - v.visto > 2 * 3600000) _mlPediuNF.delete(k);
  for (const [k, t] of _nfGeradaPorNos) if (agora - t >= 6 * 3600000) _nfGeradaPorNos.delete(k);
}
/* Codex #712: 403 (app comum sem o escopo de notas) → repete com o token do app NF; só nele, que não é ambíguo. */
async function _gerarNFeComFallback(token, idPedido) {
  let r = await gerarNFeDoPedido(token, idPedido);
  if (r && !r.ok && r.status === 403 && nfTokenManager) {
    try { r = await gerarNFeDoPedido(await nfTokenManager.garantirTokenNF(), idPedido); }
    catch (e) { r = { ok: false, erro: 'token NF: ' + String((e && e.message) || e).slice(0, 160) }; }
  }
  return r;
}
async function _emitirNFQuandoMLPede(token, p, pDet) {
  if (String(process.env['GIRASSOL' + '_EMITIR_NF_QUANDO_ML_PEDIR'] || '1') === '0') return;
  const id = String(p.id), agora = Date.now();
  _podarEstadoNF(agora);
  if (pDet && pDet.notaFiscal && pDet.notaFiscal.id) { _mlPediuNF.delete(id); return; }   // já tem nota
  const itens = (pDet && pDet.itens) || [];
  if (itens.some(it => /^A-COMBINAR/i.test(String((it && (it.codigo || (it.produto && it.produto.codigo))) || '')))) return;
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
  console.log(`[GIRASSOL F2] Pedido ${p.id} — o ML pediu a nota e o Bling não tinha: ` + (r && r.ok ? 'NF gerada' + (r.nfId ? ' (' + r.nfId + ')' : '') + ' — o Corrigir-NFs transmite' : (r && r.ambiguo ? 'resposta ambígua (confiro no próximo ciclo)' : 'falhou: ' + (r && r.erro))));
}

async function temEtiquetaML(mlToken, numeroLoja, saida) {   /* saida (opcional): recebe status/substatus do envio */
  try {
    const shipmentId = await getShipmentInfo(mlToken, numeroLoja);
    const { status, substatus } = await getShipmentSubstatus(mlToken, shipmentId);
    if (saida) { saida.status = status; saida.substatus = substatus; }
    console.log(`[ML] numeroLoja=${numeroLoja} shipment=${shipmentId} status=${status} substatus=${substatus}`);
    // 27/07 — CORREÇÃO: 'ready_to_ship' NÃO significa que a etiqueta existe.
    // O substatus 'invoice_pending' quer dizer que o ML ainda não fechou a etapa dele (a etiqueta
    // NÃO é imprimível — a API responde NOT_PRINTABLE_STATUS). Antes esses pedidos eram tratados
    // como "tem etiqueta" e ficavam parados em ATENDIDO, entupindo a lista do galpão com pedido
    // que ninguém consegue despachar. Agora eles voltam pra AGUARDANDO e retornam sozinhos quando
    // a etiqueta liberar.
    const SEM_ETIQUETA_AINDA = ['invoice_pending', 'buffered', 'ready_to_print_pending', 'regenerating'];
    /* 17/10 — VENDA COM PRAZO DE DISPONIBILIDADE ("Aguardando disponibilidade de estoque" no ML): substatus
       manufacturing, em pending OU handling (doc oficial de envios do ML). Não há etiqueta até o vendedor clicar
       "Já estou com o produto" — e o dono vende assim de propósito, pra faturar depois. Antes caía no "return true"
       lá embaixo: o F1 deixava o pedido no ATENDIDO (o checkout mostrava como "sem etiqueta") e o F2 o puxava de
       volta pra lá. Agora conta como sem etiqueta: o F1 leva pro AGUARDANDO e o F2 só devolve ao ATENDIDO quando o ML
       liberar a etiqueta (o envio programado — buffered — já seguia essa regra). Caso: pedido 123875. */
    if (/manufacturing/i.test(String(substatus || ''))) {
      console.log(`[ML] numeroLoja=${numeroLoja} substatus=${substatus} — aguardando disponibilidade de estoque no ML, sem etiqueta`);
      return false;
    }
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
      const _envF1 = {};
      const temEtiqueta = await temEtiquetaML(mlToken, numeroLoja, _envF1);
      /* 17/10 (Codex #712): adiado pelo ML (aguardando estoque / coleta programada) entra na lista — o F2 o acompanha além da janela */
      if (!temEtiqueta && _adiados.adiado(_envF1.substatus)) _adiados.registrar('girassol', p.id, { substatus: _envF1.substatus });
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
const _adiados = require('../lib/fiscal/f2-adiados');   /* 17/10: pedidos adiados pelo ML (ver lib/fiscal/f2-adiados.js) */
let _cursorF2 = 0;
async function _fluxo2(token) {
  /* 17/10 (Codex #712): a janela do F2 vai até F2_JANELA_ADIADOS_DIAS (60) — mas, do que passa da janela curta, só entra
     quem está na lista de ADIADOS pelo ML (o resto do AGUARDANDO antigo não é tocado) */
  const { inicial: _iniCurta } = getPeriodo();
  const { inicial, final } = getPeriodo(Number(process.env.F2_JANELA_ADIADOS_DIAS || 60));
  const _adiadosF2 = _adiados.podar('girassol');
  const lista = await getPedidosPorStatus(token, SITUACAO_AGUARDANDO, inicial, final);
  const _lista2 = lista.filter(p => { const d = String((p && p.data) || '').slice(0, 10); return !d || d >= _iniCurta || !!_adiadosF2[String(p && p.id)]; });   /* sem data = trata como da janela curta (não some ninguém) */
  /* lote em rodízio: com mais pedidos que MAX_F2, cada rodada pega a próxima fatia (nenhum fica sempre de fora) */
  const _ini2 = _lista2.length > MAX_F2 ? (_cursorF2 % _lista2.length) : 0;
  const batch = _lista2.length > MAX_F2 ? _lista2.slice(_ini2, _ini2 + MAX_F2).concat(_lista2.slice(0, Math.max(0, _ini2 + MAX_F2 - _lista2.length))) : _lista2;
  _cursorF2 += MAX_F2;
  console.log(`[F2] ${lista.length} encontrados | processando ${batch.length}`);
  let mlToken = null;
  try { mlToken = await garantirTokenML(); } catch (e) {
    console.warn('[F2] Sem token ML:', e.message);
  }
  let movidos = 0;
  for (const p of batch) {
    if (jaProcessado('F2', p.id)) { continue; }
    if (!isMercadoEnviosPorLoja(p)) continue;
    let pDetalhe = p, detalheOk = false;   // Codex #712: sem o detalhe (nota, itens) não dá pra gerar nota com segurança
    try {
      const _det = await getPedidoDetalhe(token, p.id);
      if (_det) { pDetalhe = _det; detalheOk = true; }
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
        const _envF2 = {};
        deveAtender = await temEtiquetaML(mlToken, numeroLoja, _envF2);
        /* 17/10: o ML pede a nota e o Bling não tem — gera (ver _emitirNFQuandoMLPede) */
        if (!deveAtender && detalheOk && String(_envF2.substatus || '') === 'invoice_pending') await _emitirNFQuandoMLPede(token, p, pDetalhe);
        if (!deveAtender && _adiados.adiado(_envF2.substatus)) _adiados.registrar('girassol', p.id, { substatus: _envF2.substatus });
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
      _adiados.remover('girassol', p.id);   /* voltou pro ATENDIDO: sai da lista de adiados */
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
