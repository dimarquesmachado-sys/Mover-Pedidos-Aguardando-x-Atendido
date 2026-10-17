'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   F3 — NF-e → MERCADO LIVRE, código único das três empresas (14/09/2026).

   Era o passo 2.4 do plano, que ficou pela metade: a CAPACIDADE (o envio nativo do
   Bling como 1ª tentativa no reenvio manual) já tinha sido portada no PR #414, mas
   a peça continuava triplicada. Medida hoje: AMB e GOOD são idênticas, e a Girassol
   difere só em nome de env e rótulo.

   O que fica por empresa, porque é operação e não regra: os tetos (quantas NFs por
   rodada, quantos dias de janela, quantas checagens de pendência antes de desistir).
   Empresa que emite mais precisa de teto diferente — igualar seria decidir o ritmo
   de uma pela outra.
   ──────────────────────────────────────────────────────────────────────────── */

function criarFluxoNFeML(cfg) {
  for (const nome of ['rotulo', 'pecas', 'envMaxNfeMl', 'envNfJanelaDias', 'envF3MaxChecagens']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/nfe-ml-fluxo: falta ' + nome);
  }
  for (const p of ['blingApi', 'mlApi', 'mlTokenManager', 'tokenManager']) {
    if (!cfg.pecas || !cfg.pecas[p]) throw new Error('lib/fiscal/nfe-ml-fluxo: falta a peça ' + p);
  }
  const { rotulo } = cfg;

  /**
   * F3 — Envio automático de NF-e (dados fiscais) Bling → Mercado Livre. (AMBTotal)
   *
   * 1. Lista NF-e AUTORIZADAS (situacao=5) dos ÚLTIMOS DIAS no Bling.
   *    >>> Usa JANELA PRÓPRIA E CURTA (AMB_NF_JANELA_DIAS, padrão 5 dias) <<<
   *    Motivo: uma NF que o Bling não enviou ao ML é sempre RECENTE. Olhar a
   *    janela longa do F1/F2 (15-20 dias) enchia a lista de centenas de NFs
   *    antigas (já resolvidas) e estourava o limite MAX_NFE — as NFs novas
   *    (que precisam de envio) ficavam fora do lote e nunca eram processadas.
   * 2. Para cada NF da loja ML (loja.id em ME_LOJA_IDS) ainda não processada:
   *      - pega o detalhe (numeroPedidoLoja + link do XML);
   *      - envia para o ML SOMENTE se o shipment estiver "invoice_pending";
   *      - se o ML já tiver os dados, pula sem erro.
   * 3. Marca como processada para não reenviar.
   *
   * IMPORTANTE (fix jun/2026): quando o ML responde "não é invoice_pending",
   * NÃO marcamos a NF como processada de primeira. Vendas cross-docking/agência
   * ficam um tempo em estados anteriores (ex: buffered) e só DEPOIS viram
   * invoice_pending — se marcássemos logo, o F3 nunca mais tentaria e a venda
   * ficava eternamente "pendente de dados fiscais" no ML. Agora damos até
   * MAX_CHECAGENS_PENDENCIA tentativas (~3h de ciclos de 10min) antes de
   * desistir e marcar como ok (caso em que os dados já foram preenchidos por
   * outra via). Estado em memória — zera no restart, sem problema.
   *
   * Trava de segurança: só NF com situacao=5 E com link de XML é enviada.
   */

  const { garantirToken, renovarToken } = cfg.pecas.tokenManager;
  const { garantirTokenML } = cfg.pecas.mlTokenManager;
  const {
  getNFesAutorizadas,
  getNFeDetalhe,
  ME_LOJA_IDS,
  jaProcessado,
  marcarProcessado,
  mensagemCanalFaltando,
  enviarNFeParaLojaVirtual
  } = cfg.pecas.blingApi;
  const { enviarNFeParaML } = cfg.pecas.mlApi;
  /* 04/09 — NFs que o ML recusa por erro PERMANENTE (CEP importado errado pelo Bling, doc
   inválido) não podem ser retransmitidas para sempre: nos logs de hoje a mesma NF apareceu
   de 04:22 a 08:31 batendo no ML a cada 10 min, e ninguém ficava sabendo. Agora registra e
   para; o checkout mostra a lista pra intervenção manual (cancelar, reemitir, subir XML). */
  const _travadas = require('../nf-travadas');
  /* 17/10: notas que o ML está segurando (coleta programada / aguardando estoque) — ver lib/fiscal/f3-aguardando-ml.js */
  const _aguarda = require('./f3-aguardando-ml');
  const _EMPRESA_AG = String(rotulo || '').toLowerCase();
  const AGUARDA_INTERVALO_MS = 6 * 3600000;          // reconfere a cada 6 h (o ML segura por dias/semanas)
  const AGUARDA_ERRO_MS = 30 * 60000;                 // erro passageiro: tenta de novo em 30 min
  const AGUARDA_MAX_DIAS = 60;                        // desiste (e loga) depois de 60 dias
  const _enviadasDaLista = new Set();   /* Codex #707: enviadas pela lista neste processo — não reenvia se a gravação falhou */
  /* 17/10 (Codex #707): a lista de travadas que o CHECKOUT mostra fica no cache da empresa — a fachada informa onde */
  const _CACHE_TRAV = cfg.dirTravadas || process.env.CACHE_DIR || '/data';

  const MAX_NFE = parseInt(process.env[cfg.envMaxNfeMl] || '60');

  // Janela PRÓPRIA do F3 — curta, porque NF travada no ML é sempre recente.
  // Não usa o getPeriodo() do blingApi (que é a janela longa do F1/F2).
  const NF_JANELA_DIAS = parseInt(process.env[cfg.envNfJanelaDias] || '5');

  // Quantas vezes re-checar uma NF cujo shipment "não está invoice_pending"
  // antes de desistir e marcar como processada. 18 ciclos de 10min ≈ 3h.
  const MAX_CHECAGENS_PENDENCIA = parseInt(process.env[cfg.envF3MaxChecagens] || '18');

  // Estados de envio em que o ML NUNCA mais vai pedir NF (já despachado, entregue
  // ou cancelado). Caindo num desses, não adianta re-checar MAX_CHECAGENS_PENDENCIA
  // vezes: marca como resolvido de primeira. Com janela de 30 dias a maioria das
  // NFs da fila está exatamente aqui — era o maior gasto de chamada de API.
  const ESTADOS_FINAIS = ['shipped', 'delivered', 'not_delivered', 'cancelled'];

  // nfeId -> nº de checagens "sem pendência" (em memória)
  const _semPendenciaCount = new Map();

  function getPeriodoNF() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fim = new Date(hoje);
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - (NF_JANELA_DIAS - 1));
  const fmt = d => d.toISOString().split('T')[0];
  return { inicial: fmt(ini), final: fmt(fim) };
  }

  let _rodando = false;

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

  async function _fluxoNFeML(tokenBling) {
    /* Codex #485 (P1): o guarda estava só no isMercadoEnviosPorLoja, e o F3 lê a lista
       EXPORTADA direto — com ME_LOJA_IDS vazio, o `includes` lá embaixo devolve false pra
       tudo e o F3 ignora TODA NF em silêncio. É o bug do id herdado voltando por outra porta,
       e com uma cara pior: o relatório diria "0 NFs enviadas", que parece dia fraco e não
       configuração faltando. Conferido UMA vez, aqui, em vez de a cada NF.
       16/09 (P2 do Codex): a mensagem tinha um molde de rota genérico que não existe e não
       dizia a env que falta — bypassava o mapa _EMPRESA_POR_ROTULO que o guarda do F1
       (isMercadoEnviosPorLoja) já usa. mensagemCanalFaltando() vem do próprio blingApi e traz
       a rota real e o nome da env; os dois guardas agora falam a mesma coisa. */
    if (!Array.isArray(ME_LOJA_IDS) || !ME_LOJA_IDS.length) {
      throw new Error(mensagemCanalFaltando());
    }

  const { inicial, final } = getPeriodoNF();
  const lista = await getNFesAutorizadas(tokenBling, inicial, final);

  // A lista vem da MAIS ANTIGA para a mais NOVA. Uma NF que o Bling não enviou
  // ao ML é SEMPRE recente. Por isso: (1) descartamos as já resolvidas hoje e
  // (2) priorizamos as MAIS NOVAS antes de cortar em MAX_NFE.
  // Antes era lista.slice(0, MAX_NFE) = as 60 mais ANTIGAS (já resolvidas);
  // as recentes ficavam fora do lote e o F3 automático nunca as pegava — só
  // funcionava o disparo manual por NF (/run/nfe-ml/:id).
  const _naEspera = _aguarda.ler(_EMPRESA_AG);   /* Codex #707: nota da lista de espera é da lista — fora ANTES do corte do lote */
  const pendentes = lista
    .filter(nf => !jaProcessado('F3', nf.id) && !_naEspera[String(nf.id)])
    .sort((a, b) => Number(b.id) - Number(a.id)); // id maior = mais recente
  const batch = pendentes.slice(0, MAX_NFE);

  console.log(`[${rotulo} F3-NFeML] janela ${NF_JANELA_DIAS}d (${inicial}→${final}) | ${lista.length} autorizadas | ${pendentes.length} pendentes | processando ${batch.length} (mais recentes)`);

  let mlToken = null;
  try {
    mlToken = await garantirTokenML();
  } catch (e) {
    console.warn(`[${rotulo} F3-NFeML] Sem token ML:`, e.message, '— abortando rodada');
    return;
  }

  let enviadas = 0, puladas = 0, ignoradas = 0, semPendencia = 0, erros = 0;

  for (const nfResumo of batch) {
    const nfeId = nfResumo.id;
    if (jaProcessado('F3', nfeId)) { puladas++; continue; }
    if (_naEspera[String(nfeId)]) { puladas++; continue; }

    let nf = null;
    try {
      nf = await getNFeDetalhe(tokenBling, nfeId);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[${rotulo} F3-NFeML] Erro ao buscar detalhe NF ${nfeId}:`, e.message);
      erros++;
      continue;
    }
    if (!nf) { ignoradas++; continue; }

    const lojaId = nf?.loja?.id;
    if (!ME_LOJA_IDS.includes(lojaId)) { ignoradas++; continue; }

    if (!nf.xml) {
      console.warn(`[${rotulo} F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem XML — pulando`);
      ignoradas++;
      continue;
    }

    const numeroPedidoLoja = nf.numeroPedidoLoja;
    if (!numeroPedidoLoja) {
      console.warn(`[${rotulo} F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem numeroPedidoLoja — pulando`);
      ignoradas++;
      continue;
    }

    try {
      await enviarNFeParaML(mlToken, numeroPedidoLoja, nf);
      console.log(`[${rotulo} F3-NFeML] ✅ NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) enviada`);
      enviadas++;
      marcarProcessado('F3', nfeId);
      _semPendenciaCount.delete(nfeId);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('não é invoice_pending') || msg.includes('invoice_pending')) {
        // Shipment não está aguardando NF AGORA — mas pode estar a caminho
        // (cross-docking fica em buffered antes de virar invoice_pending).
        // Re-checa nos próximos ciclos até MAX_CHECAGENS_PENDENCIA.
        if (_aguarda.mlSegurando(e.mlStatus, e.mlSubstatus)) {
          /* 17/10: o ML está SEGURANDO o envio (programado ou aguardando estoque) — vai pedir a nota daqui a
             dias/semanas, fora desta janela e muito depois das ~3 h de checagens. Vai pra lista durável, que
             reconfere a cada 6 h até o ML pedir; aqui na janela ela sai (senão batia no ML a cada 10 min). */
          const _gravou = _aguarda.registrar(_EMPRESA_AG, nfeId, { numero: nf.numero, pedido_ml: String(numeroPedidoLoja), status: e.mlStatus || null, substatus: e.mlSubstatus || null, proxima: Date.now() + AGUARDA_INTERVALO_MS, origem: 'f3' });
          if (_gravou) {
            console.log(`[${rotulo} F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — o ML está segurando o envio (${e.mlStatus}/${e.mlSubstatus}); fica na lista de espera e é enviada quando o ML pedir`);
            marcarProcessado('F3', nfeId);
            _semPendenciaCount.delete(nfeId);
          } else {
            /* Codex #707: a lista não gravou (disco) — NÃO marca como processada: a janela tenta de novo na próxima rodada */
            console.warn(`[${rotulo} F3-NFeML] NF ${nf.numero} — não consegui gravar a lista de espera; fica na janela pra próxima rodada`);
          }
        } else if (ESTADOS_FINAIS.includes(String(e.mlStatus || ''))) {
          // Envio já terminou: o ML não vai mais pedir NF pra esse pedido.
          console.log(`[${rotulo} F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — envio já em "${e.mlStatus}", não pede mais NF — marcando como ok`);
          marcarProcessado('F3', nfeId);
          _semPendenciaCount.delete(nfeId);
        } else {
          const tent = (_semPendenciaCount.get(nfeId) || 0) + 1;
          _semPendenciaCount.set(nfeId, tent);
          if (tent >= MAX_CHECAGENS_PENDENCIA) {
            console.log(`[${rotulo} F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — sem pendência após ${tent} checagens, marcando como ok`);
            marcarProcessado('F3', nfeId);
            _semPendenciaCount.delete(nfeId);
          } else {
            console.log(`[${rotulo} F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — ML não está pendente (checagem ${tent}/${MAX_CHECAGENS_PENDENCIA}), re-checa no próximo ciclo`);
          }
        }
        semPendencia++;
      } else {
        const _perm = _travadas.registrar(_CACHE_TRAV, { nfeId, numero: nf.numero, pedidoML: numeroPedidoLoja, shipment: nf.shipment || null, erro: msg });
        if (_perm.permanente && _perm.gravou !== false) {   /* acerto do #707: só larga a nota se o registro que o checkout mostra foi gravado */
          /* erro que só mão humana resolve: marca processada pra não tentar de novo e
             fica na lista de travadas, que o checkout mostra */
          marcarProcessado('F3', nfeId);
          console.error(`[${rotulo} F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) TRAVADA — ${_perm.registro.motivo}. Parei de tentar; resolva no Bling e ela sai da lista.`);
        } else {
          console.error(`[${rotulo} F3-NFeML] Erro ao enviar NF ${nf.numero} (pedido ML ${numeroPedidoLoja}):`, msg);
        }
        erros++;
      }
    }
  }

  /* 17/10 — A LISTA DE ESPERA: notas cujo envio o ML estava segurando. Reconfere cada uma no seu horário (fora da
     janela de dias): o ML pediu a nota → envia; envio terminou/cancelou ou a nota sumiu → sai da lista; ainda
     segurando → volta em 6 h; erro passageiro → 30 min; erro permanente → vai pra lista de travadas (checkout). */
  let agEnviadas = 0, agEsperando = 0;
  { const ag = _aguarda.ler(_EMPRESA_AG); const agora = Date.now();
    const mud = { remover: [], atualizar: {} };          // aplicadas no fim sobre o arquivo RELIDO (Codex #707)
    const tirar = (id) => mud.remover.push(String(id));
    const ajustar = (id, campos) => { mud.atualizar[String(id)] = Object.assign(mud.atualizar[String(id)] || {}, campos); };
    for (const id of Object.keys(ag)) {
      const reg = ag[id] || {};
      if (_enviadasDaLista.has(String(id))) { tirar(id); continue; }   // já enviada (a gravação anterior falhou) — não manda de novo
      if (agora - (Date.parse(reg.desde) || agora) > AGUARDA_MAX_DIAS * 86400000) {
        console.warn(`[${rotulo} F3-NFeML] NF ${reg.numero || id} — ${AGUARDA_MAX_DIAS} dias na espera sem o ML pedir; saiu da lista (confira a venda ${reg.pedido_ml || ''} no ML)`);
        tirar(id); continue;
      }
      if (reg.proxima && agora < Number(reg.proxima)) { agEsperando++; continue; }
      let nfA = null;
      try { nfA = await getNFeDetalhe(tokenBling, id); }
      catch (e) {
        if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') { _aguarda.aplicar(_EMPRESA_AG, mud); throw e; }
        /* 404 é definitivo (a nota não existe mais no Bling) — sai da lista em vez de voltar a cada 30 min */
        if (/HTTP 404\b/.test(String(e.message || ''))) { tirar(id); continue; }
        ajustar(id, { proxima: agora + AGUARDA_ERRO_MS }); continue;
      }
      /* Codex #707: o número do pedido do ML vem da nota OU do registro (a ponte do checkout guarda o pedido confirmado) */
      const pedidoA = String((nfA && nfA.numeroPedidoLoja) || reg.pedido_ml || '');
      if (!nfA || !pedidoA || Number(nfA.situacao) === 2 || Number(nfA.situacao) === 9) {   // sumiu, cancelada (2) ou denegada (9)
        tirar(id); continue;
      }
      /* Codex #707: a nota diz que é de OUTRO pedido do que o registrado — não manda (era um casamento errado) */
      if (nfA.numeroPedidoLoja && reg.pedido_ml && String(nfA.numeroPedidoLoja) !== String(reg.pedido_ml)) { tirar(id); continue; }
      /* Codex #707: só nota AUTORIZADA (5) vai pro ML — a mesma regra da janela. Pendente/rejeitada: espera (você pode
         autorizar depois) */
      if (Number(nfA.situacao) !== 5) { ajustar(id, { proxima: agora + AGUARDA_INTERVALO_MS, situacao_nf: nfA.situacao }); agEsperando++; continue; }
      if (!nfA.xml) { ajustar(id, { proxima: agora + AGUARDA_ERRO_MS }); continue; }   /* Codex #707: autorizada sem XML ainda — tenta de novo, não descarta */
      try {
        await enviarNFeParaML(mlToken, pedidoA, nfA);
        console.log(`[${rotulo} F3-NFeML] ✅ NF ${nfA.numero} (pedido ML ${pedidoA}) enviada — o ML liberou o envio que estava segurando`);
        _enviadasDaLista.add(String(id)); marcarProcessado('F3', id);   // Codex #707: a janela não manda de novo
        tirar(id); agEnviadas++; enviadas++;
      } catch (e) {
        const msgA = e.message || '';
        if (msgA.includes('invoice_pending')) {
          if (ESTADOS_FINAIS.includes(String(e.mlStatus || ''))) tirar(id);
          else if (_aguarda.mlSegurando(e.mlStatus, e.mlSubstatus)) { ajustar(id, { proxima: agora + AGUARDA_INTERVALO_MS, status: e.mlStatus || null, substatus: e.mlSubstatus || null }); agEsperando++; }
          else {
            /* saiu do "segurando" mas ainda não pede a nota: confere mais algumas vezes em intervalo curto e desiste */
            const n = (Number(reg.fora_do_segurando) || 0) + 1;
            if (n >= MAX_CHECAGENS_PENDENCIA) tirar(id); else ajustar(id, { fora_do_segurando: n, proxima: agora + AGUARDA_ERRO_MS });
          }
        } else {
          const _permA = _travadas.registrar(_CACHE_TRAV, { nfeId: id, numero: nfA.numero, pedidoML: pedidoA, shipment: nfA.shipment || null, erro: msgA });
          /* acerto do #707: só sai da lista se o registro de travada foi GRAVADO (é ele que o operador vê no checkout) */
          if (_permA.permanente && _permA.gravou !== false) { tirar(id); console.error(`[${rotulo} F3-NFeML] NF ${nfA.numero} (pedido ML ${pedidoA}) TRAVADA — ${_permA.registro.motivo}`); }
          else {
            if (_permA.permanente) console.error(`[${rotulo} F3-NFeML] NF ${nfA.numero} (pedido ML ${pedidoA}) TRAVADA, mas não consegui gravar a lista de travadas — fica na lista de espera e tento de novo`);
            ajustar(id, { proxima: agora + AGUARDA_ERRO_MS });
          }
          erros++;
        }
      }
    }
    if ((mud.remover.length || Object.keys(mud.atualizar).length) && !_aguarda.aplicar(_EMPRESA_AG, mud)) {
      /* Codex #707: não gravou (disco) — a transição NÃO está feita; o que foi enviado fica lembrado em memória
         (_enviadasDaLista + processada) pra não ir de novo, e a próxima rodada tenta gravar outra vez */
      console.warn(`[${rotulo} F3-NFeML] não consegui gravar a lista de espera — a próxima rodada tenta de novo`);
    }
  }

  console.log(
    `[${rotulo} F3-NFeML] enviadas=${enviadas} | sem-pendência=${semPendencia} | ignoradas=${ignoradas} ` +
    `| já-processadas=${puladas} | erros=${erros} | lista-de-espera: ${agEnviadas} enviada(s), ${agEsperando} aguardando o ML`
  );
  }

  async function rotinaNFeML() {
  if (_rodando) {
    console.log(`[${rotulo} F3-NFeML] já em execução — pulando`);
    return;
  }
  _rodando = true;
  try {
    await comTokenRenewable(_fluxoNFeML);
  } finally {
    _rodando = false;
  }
  }

  /* Codex #707: nota enviada por outro caminho (reenvio manual) sai da lista de espera — senão a lista mandaria de novo */
  function _tirarDaEspera(nfeId) {
    _enviadasDaLista.add(String(nfeId));   /* Codex #707: mesmo se a gravação falhar, a lista não manda de novo neste processo */
    try { _aguarda.aplicar(_EMPRESA_AG, { remover: [String(nfeId)] }); } catch (e) {}
  }
  async function enviarNFeUnica(nfeId) {
  return comTokenRenewable(async (tokenBling) => {
    const nf = await getNFeDetalhe(tokenBling, nfeId);
    if (!nf) throw new Error(`NF ${nfeId} não encontrada`);
    if (!nf.xml) throw new Error(`NF ${nfeId} (nº ${nf.numero}) sem XML — não está autorizada`);
    /* 13/09 — PORTE DA GIRASSOL (decisão do dono: "uma tem, agora ambas têm"). 1ª tentativa:
       envio NATIVO do Bling → marketplace. O Bling é integrador oficial do ML e faz o
       handshake fiscal que o push cru de XML não faz. Isto aqui é o REENVIO MANUAL, ou seja,
       o caso em que o automático já falhou — antes, esta empresa só repetia o mesmo push que
       não tinha funcionado. O push direto continua como reserva. */
    try {
      const result = await enviarNFeParaLojaVirtual(tokenBling, nfeId);
      marcarProcessado('F3', nfeId);
      _semPendenciaCount.delete(nfeId);
      _tirarDaEspera(nfeId);
      return { ok: true, via: 'bling-loja-virtual', nfeId, numero: nf.numero, result };
    } catch (eBling) {
      if (eBling.code === 401 || eBling.message === 'TOKEN_EXPIRADO') throw eBling;
      console.warn(`[${rotulo} F3-NFeML] envio nativo Bling falhou NF ${nfeId}: ${eBling.message} — tentando push direto no ML`);

      if (!nf.numeroPedidoLoja) {
        throw new Error(`Bling enviar-loja-virtual falhou (${eBling.message}) e NF sem numeroPedidoLoja pro fallback`);
      }
      const mlToken = await garantirTokenML();
      try {
        const result = await enviarNFeParaML(mlToken, nf.numeroPedidoLoja, nf);
        marcarProcessado('F3', nfeId);
        _semPendenciaCount.delete(nfeId);
        _tirarDaEspera(nfeId);
        return { ok: true, via: 'ml-direto (bling falhou)', nfeId, numero: nf.numero, numeroPedidoLoja: nf.numeroPedidoLoja, result };
      } catch (eML) {
        throw new Error(`Ambos falharam — Bling: [${eBling.message}] | ML: [${eML.message}]`);
      }
    }
  });
  }

  return { rotinaNFeML, enviarNFeUnica };

}

module.exports = { criarFluxoNFeML };
