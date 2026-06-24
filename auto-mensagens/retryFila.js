'use strict';

/**
 * FILA DE RETRY DE EMISSÃO + RECONCILIAÇÃO + RE-ENGAJAMENTO — lixas A COMBINAR.
 *
 * Extraído de fluxos.js (modularização). É o DONO do Map _retryBling (fila em
 * memória de vendas aguardando o Bling importar o pedido do ML).
 *
 * Dependência circular com processarAutoEmissao (que fica no fluxos.js):
 *   - retentarEmissoesBling precisa de processarAutoEmissao -> chega por INJEÇÃO.
 *   - processarAutoEmissao precisa mexer na fila -> usa removerDaFila() e
 *     agendarOuEscalarRetry() expostos aqui (em vez de tocar o Map direto).
 *
 * lcp é require lazy interno (passado como argumento nas funções). _tsMensagemML
 * é duplicado aqui (helper puro, sem estado) pra manter o módulo autocontido.
 */

const ml = require('./mlApi');

const AUTO_EMITIR_HABILITADO = (process.env.LIXAS_AUTO_EMITIR_NF_HABILITADO || 'false').toLowerCase() === 'true';
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 95);

// Helper puro duplicado de fluxos.js (extrai timestamp de uma mensagem do ML).
function _tsMensagemML(m) {
  if (!m) return 0;
  const md = m.message_date || {};
  const d = md.received || md.created || md.available || md.notified
    || m.date_created || m.date || m.created_at || null;
  const t = d ? new Date(d).getTime() : 0;
  return isNaN(t) ? 0 : t;
}

module.exports = function criarRetryFila({ processarAutoEmissao }) {

// ─────────────────────────────────────────────────────────────────────
// RETRY de emissao + RECONCILIACAO com Bling + RE-ENGAJAMENTO
// ─────────────────────────────────────────────────────────────────────

// (Feature 2) RETRY quando o pedido ainda nao foi importado no Bling.
// Caso real: cliente responde poucos minutos apos a venda, antes do Bling
// importar o pedido do ML. Em vez de jogar pra atencao humana na hora, guarda
// os dados (a MESMA classificacao ja confirmada ao cliente — NAO re-roda a IA)
// e tenta de novo nos proximos ciclos. A importacao costuma resolver em minutos.
// Janela de paciencia pro Bling importar o pedido do ML. A ancora de idade e a
// ultima_resposta_em (PERSISTENTE no banco), entao sobrevive a restart/deploy:
// a fila e RELIDA DO BANCO a cada ciclo e a idade conta o tempo real de espera.
const AGUARDANDO_BLING_MAX_MIN = Number(process.env.LIXAS_AGUARDANDO_BLING_MAX_MIN || 180); // 3h: tolera atraso/queda do Bling
const _retryBling = new Map(); // cache em memoria: orderId -> { venda, iaResult, graosResult, attempts, since }

// Idade (min) desde que comecamos a esperar o Bling — ancorada num timestamp do banco.
function _idadeEsperaBlingMin(venda, fallbackSince) {
  const ancora = (venda && (venda.ultima_resposta_em || venda.data_venda)) || null;
  const t = ancora ? new Date(ancora).getTime() : (fallbackSince || Date.now());
  return (Date.now() - t) / 60000;
}

async function _agendarOuEscalarRetry({ orderId, venda, iaResult, graosResult, lcp, erro }) {
  const k = String(orderId);
  const ex = _retryBling.get(k);
  const since = ex ? ex.since : Date.now();
  const idadeMin = _idadeEsperaBlingMin(venda, since);

  if (idadeMin >= AGUARDANDO_BLING_MAX_MIN) {
    _retryBling.delete(k);
    await lcp.atualizarVenda(orderId, {
      status: 'precisa_atencao_humano',
      bling_erro: `auto: pedido nao encontrado no Bling apos ${Math.round(idadeMin)} min de espera (${(erro || '').slice(0, 130)})`
    });
    console.warn(`[retry-bling] order ${orderId} desistiu apos ${Math.round(idadeMin)} min — humano`);
    return { falha: true, motivo: 'pedido_nao_encontrado_max' };
  }

  const attempts = ex ? ex.attempts + 1 : 1;
  _retryBling.set(k, { venda, iaResult, graosResult, attempts, since });
  await lcp.atualizarVenda(orderId, {
    status: 'aguardando_bling',
    bling_erro: `auto: aguardando Bling importar o pedido (${Math.round(idadeMin)} min de espera, tentativa ${attempts})`
  });
  console.log(`[retry-bling] order ${orderId} aguardando Bling (${Math.round(idadeMin)}min / max ${AGUARDANDO_BLING_MAX_MIN})`);
  return { retry: true, motivo: 'pedido_nao_encontrado' };
}

// Reidrata a fila a partir do BANCO. Faz a fila SOBREVIVER a restart/deploy:
// os dados ja confirmados ao cliente (ia_pedido_estruturado) ficam salvos, entao
// reconstruimos iaResult e re-buscamos o estoque — sem re-rodar a IA.
//   (1) status 'aguardando_bling': re-tenta normal.
//   (2) status 'precisa_atencao_humano': REPESCA so os que escalaram por TIMING do
//       Bling (erro "nao encontrado no Bling"), ainda NAO montados e dentro da janela.
//       Estoque/soma/IA escalonada NAO sao repescados (sao problema real, precisam de humano).
async function _rehidratarFilaDoBanco({ lcp }) {
  await _rehidratarStatus({ lcp, status: 'aguardando_bling', modo: 'normal' });
  await _rehidratarStatus({ lcp, status: 'precisa_atencao_humano', modo: 'humano-timing' });
  // SO repesca 'cliente_confirmou_pedido' se a auto-emissao estiver LIGADA. Com ela
  // DESLIGADA, esse status eh o terminal esperado (voce monta na mao) e nao devemos mexer.
  if (AUTO_EMITIR_HABILITADO) {
    await _rehidratarStatus({ lcp, status: 'cliente_confirmou_pedido', modo: 'confirmou-strand' });
  }
}

async function _rehidratarStatus({ lcp, status, modo }) {
  let lista;
  // confirmou-strand pode ser BACKLOG (dias atras), entao janela maior; os demais
  // (aguardando_bling, humano-timing) sao recentes, 2 dias basta.
  const diasJanela = (modo === 'confirmou-strand') ? (Number(process.env.LIXAS_REPESCA_CONFIRMOU_DIAS) || 7) : 2;
  try { lista = await lcp.listarPendentes({ dias: diasJanela, status, limit: 50 }); }
  catch (e) { console.warn(`[retry-bling] erro lendo ${status} do banco: ${e.message}`); return; }
  if (!lista || !lista.ok || !Array.isArray(lista.data) || lista.data.length === 0) return;

  const lixasService = require('../lixas-combinar/lixasService');
  for (const v of lista.data) {
    const k = String(v.order_id);
    if (_retryBling.has(k)) continue; // ja esta na fila em memoria

    if (modo === 'humano-timing') {
      // GUARDAS pra repescar de atencao humana so o que faz sentido:
      const erroFoiTiming = String(v.bling_erro || '').includes('encontrado no Bling'); // pegou old + new format
      if (!erroFoiTiming) continue;                                     // 1) so timing do Bling
      if (v.bling_editado_em) continue;                                 // 2) ja montado: nao mexe
      if (_idadeEsperaBlingMin(v) >= AGUARDANDO_BLING_MAX_MIN) continue; // 3) velho demais: deixa pro humano
    } else if (modo === 'confirmou-strand') {
      // Pedido que CONFIRMOU com o cliente mas ficou preso sem montar/emitir
      // (auto-emissao estourou antes da blindagem, ou edge case). Repesca SO se:
      if (String(v.ia_categoria || '') !== 'claro') continue;            // 1) claro (ambiguo nao auto-emite)
      if (Number(v.ia_confianca || 0) < LIMIAR_CONFIANCA_AUTO) continue; // 2) confianca >= limiar
      if (v.bling_editado_em) continue;                                  // 3) ainda nao montado
      // 4) parado ha >5min: evita pegar pedido recem-confirmado que ainda vai
      //    emitir no mesmo ciclo (in-flight).
      const tConfirm = v.ia_processado_em || v.ultima_resposta_em || v.data_venda;
      const minDesdeConfirm = tConfirm ? (Date.now() - new Date(tConfirm).getTime()) / 60000 : 9999;
      if (minDesdeConfirm < 5) continue;
    }

    let pedido_estruturado = null;
    try { pedido_estruturado = v.ia_pedido_estruturado ? JSON.parse(v.ia_pedido_estruturado) : null; } catch (_) {}
    if (!Array.isArray(pedido_estruturado) || pedido_estruturado.length === 0) continue; // sem estrutura: nao da pra auto

    const iaResult = {
      categoria: v.ia_categoria || 'claro',
      confianca: Number(v.ia_confianca || 0),
      pedido_estruturado,
      interpretacao: v.ia_interpretacao || null,
      msg_pra_cliente: v.ia_msg_enviada || null
    };

    let graosResult;
    try { graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar); }
    catch (e) { console.warn(`[retry-bling] rehidratar order ${k}: erro estoque ${e.message}`); continue; }
    if (!graosResult || !graosResult.ok) continue;

    const ancora = v.ultima_resposta_em || v.data_venda || null;
    const since = ancora ? new Date(ancora).getTime() : Date.now();
    _retryBling.set(k, { venda: v, iaResult, graosResult, attempts: 0, since });

    if (modo === 'humano-timing') {
      // devolve pro status de espera, pra ficar coerente (e nao ser re-listado como humano)
      await lcp.atualizarVenda(k, { status: 'aguardando_bling', bling_erro: 'auto: repescado de atencao humana (timing Bling) — re-tentando' });
      console.log(`[retry-bling] order ${k} REPESCADO de atencao humana (timing Bling, ${Math.round(_idadeEsperaBlingMin(v, since))}min) -> aguardando_bling`);
    } else if (modo === 'confirmou-strand') {
      await lcp.atualizarVenda(k, { status: 'aguardando_bling', bling_erro: 'auto: repescado de confirmou-sem-emitir — re-tentando montar+NF' });
      console.log(`[retry-bling] order ${k} REPESCADO de cliente_confirmou_pedido (preso sem emitir) -> aguardando_bling`);
    } else {
      console.log(`[retry-bling] order ${k} re-hidratado do banco (aguardando_bling, ${Math.round(_idadeEsperaBlingMin(v, since))}min de espera)`);
    }
  }
}

// Processa a fila de retry: re-tenta editar+emitir com os MESMOS dados ja
// confirmados ao cliente. Roda no inicio de cada ciclo de leitura.
async function retentarEmissoesBling({ lcp }) {
  await _rehidratarFilaDoBanco({ lcp }); // pega orfaos deixados por restart/deploy
  if (_retryBling.size === 0) return;
  console.log(`[retry-bling] ${_retryBling.size} venda(s) na fila de retry`);
  for (const [orderId, entry] of Array.from(_retryBling.entries())) {
    try {
      await processarAutoEmissao({ venda: entry.venda, iaResult: entry.iaResult, graosResult: entry.graosResult, lcp });
    } catch (e) {
      console.error(`[retry-bling] order ${orderId} erro no retry: ${e.message}`);
    }
  }
}

// (Features 1 + 3) Revisa vendas em 'precisa_atencao_humano':
//  1) RECONCILIA com o Bling: se o pedido ja foi faturado/despachado (situacao
//     concluida) ou cancelado la, fecha aqui — mata o desencontro do painel.
//  2) RE-ENGAJA: se o cliente mandou mensagem NOVA depois de cair em atencao
//     humana, devolve a venda pra fila normal pra IA tratar (sem deixar no vacuo).
async function revisarAtencaoHumana({ lcp }) {
  const bp = require('../lixas-combinar/blingPedidos');
  const SIT_CONCLUIDAS = String(process.env.LIXAS_BLING_SITUACOES_CONCLUIDAS || '9')
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  const SIT_CANCELADAS = String(process.env.LIXAS_BLING_SITUACOES_CANCELADAS || '12')
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));

  let lista;
  try { lista = await lcp.listarPendentes({ dias: 7, status: 'precisa_atencao_humano', limit: 50 }); }
  catch (e) { console.error(`[revisar] erro listando atencao humana: ${e.message}`); return; }
  const vendas = (lista && lista.ok && Array.isArray(lista.data)) ? lista.data : [];
  if (vendas.length === 0) return;

  const sellerId = String(require('./mlTokenManager').getUserId() || '');

  for (const venda of vendas) {
    try {
      // (1) Reconciliar com o Bling
      const idBusca = venda.pack_id || venda.order_id;
      const dataVenda = venda.data_venda ? String(venda.data_venda).split('T')[0] : null;
      let dIni, dFim;
      if (dataVenda) {
        const d = new Date(dataVenda);
        const a = new Date(d); a.setDate(a.getDate() - 3);
        const b = new Date(d); b.setDate(b.getDate() + 3);
        dIni = a.toISOString().split('T')[0];
        dFim = b.toISOString().split('T')[0];
      }
      const busca = await bp.buscarPedidoPorOrderId(idBusca, dIni, dFim);
      if (busca.ok) {
        const sit = Number(busca.situacaoId);
        if (SIT_CANCELADAS.includes(sit)) {
          await lcp.atualizarVenda(venda.order_id, { status: 'cancelado', bling_erro: null, nf_erro: null });
          console.log(`[revisar] order ${venda.order_id} cancelado no Bling (situacao ${sit}) — reconciliado`);
          continue;
        }
        if (SIT_CONCLUIDAS.includes(sit)) {
          // So fecha como 'processado' se houver NF DE VERDADE no Bling. A
          // integracao nativa bounceia o pedido pra situacao 9 (Atendido) MESMO
          // sem NF — marcar processado aqui mascarava a NF faltante (casos
          // Rangel/Danieli: ficavam "prontos" sem nota). Agora checa a NF real.
          let temNF = false;
          try {
            const det = await bp.obterPedidoCompleto(busca.pedidoId);
            const nf = (det && det.ok) ? det.pedido?.notaFiscal : null;
            const nfId = (nf && typeof nf === 'object') ? nf.id : nf;
            temNF = Number(nfId) > 0;
          } catch (_) { /* na duvida, NAO fecha como processado */ }

          if (temNF) {
            await lcp.atualizarVenda(venda.order_id, {
              status: 'processado', bling_pedido_id: String(busca.pedidoId), bling_erro: null, nf_erro: null
            });
            console.log(`[revisar] order ${venda.order_id} concluido COM NF (situacao ${sit}) — reconciliado p/ processado`);
            continue;
          }

          // Situacao 9 mas SEM NF: NAO fecha. Se o pedido esta claro+estruturado, a
          // auto-emissao esta ligada, e NAO falhou antes (sem bling_erro), manda pra
          // 'cliente_confirmou_pedido' (a repesca monta+emite sozinha). Se ja tem
          // bling_erro (ex.: grao indisponivel — falha PERMANENTE), NAO re-roteia: isso
          // criaria loop (humano<->confirmou). Deixa em atencao humana pro painel resolver.
          const claroEstrut = String(venda.ia_categoria || '') === 'claro'
            && !!venda.ia_pedido_estruturado
            && Number(venda.ia_confianca || 0) >= LIMIAR_CONFIANCA_AUTO
            && !venda.bling_editado_em
            && !venda.bling_erro;
          if (claroEstrut && AUTO_EMITIR_HABILITADO) {
            await lcp.atualizarVenda(venda.order_id, {
              status: 'cliente_confirmou_pedido', bling_pedido_id: String(busca.pedidoId)
            });
            console.log(`[revisar] order ${venda.order_id} situacao ${sit} SEM NF — claro/estruturado, mandado p/ auto-emissao (repesca)`);
          } else {
            await lcp.atualizarVenda(venda.order_id, { bling_pedido_id: String(busca.pedidoId) });
            console.log(`[revisar] order ${venda.order_id} situacao ${sit} SEM NF (erro=${venda.bling_erro || 'nenhum'}) — mantido p/ revisao humana (painel)`);
          }
          continue;
        }
      }

      // (2) Re-engajar se o cliente respondeu de novo
      const conv = await ml.consultarConversa({ packId: venda.pack_id, orderId: venda.order_id, markAsRead: false });
      if (conv && conv.ok && conv.totalCliente > 0 && conv.ultimaCliente) {
        let ultLoja = 0, ultCli = 0;
        for (const m of (conv.messages || [])) {
          const ts = _tsMensagemML(m);
          if (String(m.from_user_id) === sellerId) ultLoja = Math.max(ultLoja, ts);
          else ultCli = Math.max(ultCli, ts);
        }
        const tsCli = _tsMensagemML(conv.ultimaCliente);
        if (ultCli > ultLoja && !msgJaProcessada(venda.order_id, tsCli)) {
          await lcp.atualizarVenda(venda.order_id, { status: 'aguardando_resposta' });
          console.log(`[revisar] order ${venda.order_id} cliente respondeu apos atencao humana — re-engajado`);
        }
      }
    } catch (e) {
      console.error(`[revisar] order ${venda.order_id} erro: ${e.message}`);
    }
  }
}

  // ── API exposta pro fluxos.js (processarAutoEmissao mexe na fila por aqui) ──
  function removerDaFila(orderId) { return _retryBling.delete(String(orderId)); }

  return {
    retentarEmissoesBling,
    revisarAtencaoHumana,
    agendarOuEscalarRetry: _agendarOuEscalarRetry,
    removerDaFila,
  };
};
