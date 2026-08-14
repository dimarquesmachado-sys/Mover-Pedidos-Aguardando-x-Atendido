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
const { msgJaProcessada } = require('./travaMsgProcessada'); // mesma trava usada pelo lerRespostas (re-engajamento pós-atenção-humana)

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
    return {
    falha: true, motivo: 'pedido_nao_encontrado_max' };
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
  // confirmou-strand acompanha LIXAS_JANELA_DIAS: a reconciliacao pode empurrar venda
  // antiga (8-30 dias) pra 'cliente_confirmou_pedido', e se quem consome esse status
  // olhasse so 7 dias ela sumiria de todos os caminhos de emissao, encalhada sem NF.
  const diasJanela = (modo === 'confirmou-strand')
    ? (Number(process.env.LIXAS_REPESCA_CONFIRMOU_DIAS) || Number(process.env.LIXAS_JANELA_DIAS) || 30)
    : 2;
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
      // RELE o estado do banco antes de emitir. entry.venda e um retrato do momento em
      // que a venda entrou na fila; se voce concluiu na mao (NF por fora) ou o pedido
      // foi cancelado depois, o retrato nao sabe — e o retry editaria o pedido e
      // tentaria uma SEGUNDA nota.
      const atual = await lcp.buscar(orderId);
      const vAtual = (atual && atual.ok && atual.data) ? atual.data : null;
      // FAIL CLOSED: sem releitura confiavel nao da pra saber se voce concluiu na mao
      // ou se o pedido foi cancelado depois de entrar na fila. Emitir com o retrato
      // antigo arriscaria uma segunda NF — a fila fica pra proxima rodada.
      if (!vAtual) {
        console.warn(`[retry-bling] order ${orderId} nao consegui reler o estado — pulo esta rodada (nao emito com dado velho)`);
        continue;
      }
      // cancelada_quarentena tambem e terminal: o cancelamento JA foi confirmado no ML,
      // so falta saber da etiqueta. Sem isso o retry seguiria e, numa falha transiente
      // da consulta de status, editaria o pedido e emitiria NF de venda cancelada.
      // RESTAURACAO vem ANTES do descarte terminal: a entrada carrega uma NF ja emitida
      // cujo registro se perdeu. Se o cancelamento finalizar a linha primeiro, o ramo
      // terminal apagaria a entrada e a nota ficaria sem registro pra sempre.
      if (entry.soRestaurar) {
        const nfC = entry.nfConfirmada || {};
        const jaTem = !!vAtual.nf_emitida_em;
        if (!jaTem) {
          const campos = {
            nf_emitida_em: new Date().toISOString(),
            nf_id: nfC.nfeId || null, nf_numero: nfC.numero || null, nf_serie: nfC.serie || null,
            nf_chave: nfC.chave || null, nf_erro: null,
            bling_pedido_id: entry.pedidoId ? String(entry.pedidoId) : (vAtual.bling_pedido_id || null)
          };
          // Linha ja terminal (cancelada): grava SO a evidencia da NF, sem mexer no
          // status nem no lease de quem quer que seja — e monta o alerta, porque NF
          // emitida em venda cancelada e caso de nao despachar.
          const terminal = !!(vAtual.venda_cancelada_em
            || ['venda_cancelada','cancelado','cancelada_quarentena'].includes(String(vAtual.status || '')));
          if (terminal) {
            if (!vAtual.alerta_pos_venda && !vAtual.alerta_reconhecido_em) {
              campos.alerta_pos_venda = (`CANCELADA NO ML com NF ${nfC.numero || '?'} JA EMITIDA. ` +
                `NAO DESPACHAR. Conferir e cancelar/estornar a nota no Bling.`).slice(0, 500);
            }
          } else {
            // Nao terminal: fecha normalmente, mas so limpa o lease se ainda for nosso —
            // outro worker pode ter reservado a linha nesse meio tempo.
            campos.status = 'processado';
            if (vAtual.nf_emitindo_por && entry.token && vAtual.nf_emitindo_por === entry.token) {
              campos.nf_emitindo_em = null; campos.nf_emitindo_por = null;
            } else if (!vAtual.nf_emitindo_por) {
              campos.nf_emitindo_em = null; campos.nf_emitindo_por = null;
            }
          }
          // Condicional ao estado em que `terminal` e a decisao do lease foram tomados:
          // se um cancelamento ou uma reserva nova chegou depois da leitura, o PATCH nao
          // pode ressuscitar a venda nem limpar o lease de outro worker.
          const _predRest = terminal
            ? 'nf_emitida_em=is.null'
            : ('nf_emitida_em=is.null&venda_cancelada_em=is.null'
               + '&status=not.in.(venda_cancelada,cancelado,cancelada_quarentena)'
               + (vAtual.nf_emitindo_por
                  ? `&nf_emitindo_por=eq.${encodeURIComponent(vAtual.nf_emitindo_por)}`
                  : '&nf_emitindo_por=is.null'));
          const upd = await lcp.atualizarVenda(orderId, campos, { forcar: true, somenteSe: _predRest });
          if (upd && upd.ok && Array.isArray(upd.data) && upd.data.length === 0) {
            console.warn(`[retry-bling] order ${orderId} estado mudou durante a restauracao — tento na proxima rodada`);
            continue;
          }
          if (!(upd && upd.ok && (!Array.isArray(upd.data) || upd.data.length === 1))) {
            console.error(`[retry-bling] order ${orderId} restauracao da NF ${nfC.numero || '?'} FALHOU — mantendo na fila`);
            continue;
          }
          console.log(`[retry-bling] order ${orderId} restauracao concluida — NF ${nfC.numero || '?'} registrada${terminal ? ' (venda cancelada: alerta gravado)' : ''}`);
        }
        _retryBling.delete(orderId);
        continue;
      }
      if (vAtual.processado_manual_em || vAtual.nf_emitida_em || vAtual.venda_cancelada_em
          || vAtual.status === 'cancelada_quarentena' || vAtual.status === 'venda_cancelada'
          || vAtual.status === 'cancelado') {
        const motivo = vAtual.processado_manual_em ? 'concluida na mao'
                     : vAtual.nf_emitida_em ? 'NF ja emitida'
                     : vAtual.status === 'cancelada_quarentena' ? 'cancelada no ML (quarentena)'
                     : vAtual.status === 'cancelado' ? 'pedido cancelado no Bling'
                     : 'venda cancelada';
        console.log(`[retry-bling] order ${orderId} saiu da fila sem emitir — ${motivo}`);
        // A rehidratacao pode ter reescrito o status pra 'aguardando_bling' antes de
        // chegarmos aqui. Como o classificador so reconhece a conclusao manual quando o
        // status e 'processado', sem restaurar a venda ficaria presa em Pendentes como
        // "Re-tentando" pra sempre — sem retry nenhum acontecendo.
        if (vAtual.processado_manual_em && vAtual.status !== 'processado') {
          // atualizarVenda devolve {ok:false} em vez de lancar: sem conferir, um PATCH
          // que falhou deixaria a venda em 'aguardando_bling' pra sempre (o classificador
          // so reconhece a conclusao manual quando o status e 'processado') e a entrada
          // ja teria sido apagada da fila — card preso em "Re-tentando" sem retry algum.
          let restaurou = false;
          try {
            // Condicional: entre a leitura do inicio deste retry e este PATCH, o cron
            // pode ter gravado cancelada_quarentena. Restaurar 'processado' por cima
            // esconderia o cancelamento recem-confirmado (e o marcador manual ainda
            // suprime o polling de envio, adiando o alerta de nao despachar).
            const rr = await lcp.atualizarVenda(orderId, { status: 'processado' },
              { somenteSe: 'venda_cancelada_em=is.null&status=not.in.(venda_cancelada,cancelado,cancelada_quarentena)' });
            // 0 linhas = a venda foi cancelada nesse meio tempo. Nao e falha: o estado
            // certo agora e o do cancelamento, entao a entrada pode sair da fila.
            const semLinhas = rr && rr.ok && Array.isArray(rr.data) && rr.data.length === 0;
            restaurou = !!(rr && rr.ok);
            if (semLinhas) console.log(`[retry-bling] order ${orderId} nao restaurei o status: venda foi cancelada nesse meio tempo`);
          } catch (e2) { console.error(`[retry-bling] order ${orderId} falhei ao restaurar status: ${e2.message}`); }
          if (!restaurou) {
            console.error(`[retry-bling] order ${orderId} 🚨 nao consegui restaurar o status — MANTENHO na fila pra tentar de novo`);
            continue;   // entrada fica; a proxima rodada tenta restaurar outra vez
          }
        }
        _retryBling.delete(orderId);
        continue;
      }
      await processarAutoEmissao({ venda: vAtual, iaResult: entry.iaResult, graosResult: entry.graosResult, lcp });
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
  // Mesma janela do leitor (LIXAS_JANELA_DIAS, default 30): sem isso, venda que foi
  // pra atencao humana e cujo cliente volta depois do 7o dia nunca seria re-engajada.
  const _janelaDias = Number(process.env.LIXAS_JANELA_DIAS) || 30;
  try { lista = await lcp.listarPendentes({ dias: _janelaDias, status: 'precisa_atencao_humano', limit: 200 }); }
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
          const _uCanc = await lcp.atualizarVenda(venda.order_id, { status: 'cancelado', bling_erro: null, nf_erro: null }, { somenteSe: lcp.semReservaAtiva() });
            // Adia se ha emissao em curso: sem isso, o dono do lease termina no Bling e
            // sua escrita terminal (guardada por token) e rejeitada por este 'cancelado'
            // — NF emitida sem registro.
            if (_uCanc && _uCanc.ok && Array.isArray(_uCanc.data) && _uCanc.data.length === 0) {
              console.warn(`[revisar] order ${venda.order_id} cancelado no Bling, mas ha emissao em curso — adiado`);
              continue;
            }
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
            // ESCALACAO POS-NF: a fase 2 do lerRespostas poe a venda em
            // precisa_atencao_humano quando o cliente manda uma mensagem de verdade
            // DEPOIS da nota (troca, reclamacao). Como o revisarAtencaoHumana roda
            // antes e acha o pedido pronto no Bling, resetar o status pra 'processado'
            // mandaria o card pro bolsao fechado — escondendo o pedido do cliente
            // poucos minutos depois de ele ter sido escalado.
            // Neste caso grava so a evidencia da NF e PRESERVA o status humano.
            // A escalacao POS-NF (fase 2 do lerRespostas) parte de uma linha que JA tem
            // nf_emitida_em. Usar so "tem resposta do cliente" era largo demais: pegava
            // tambem escalacao tecnica/baixa confianca ANTERIOR a nota, e o painel
            // passaria a dizer que o cliente pediu algo apos a NF — exigindo resolucao
            // manual a toa em todo caso concluido por fora.
            // Conclusao concluida = nf_emitida_em OU processado_manual_em: o botao
            // "Processado" grava so o marcador manual (a NF saiu por fora), e a fase 2
            // varre essas linhas do mesmo jeito — exigir nf_emitida_em deixaria a
            // reclamacao do cliente ser escondida nesses casos.
            const _concluida = !!venda.nf_emitida_em || !!venda.processado_manual_em;
            const _escaladoPosNf = String(venda.status || '') === 'precisa_atencao_humano'
                                   && _concluida
                                   && !!venda.ultima_resposta_cliente;
            const _camposRec = {
              // A NF foi CONFIRMADA no Bling: grava o marcador. Sem ele, o classificador
              // ve 'processado' sem nf_emitida_em e mantem a venda em Pendentes como
              // "SEM NF" — e a reconciliacao de fundo nunca fecharia o caso.
              nf_emitida_em: new Date().toISOString(),
              bling_pedido_id: String(busca.pedidoId), bling_erro: null, nf_erro: null
            };
            if (!_escaladoPosNf) _camposRec.status = 'processado';
            else console.log(`[revisar] order ${venda.order_id} NF confirmada, mas mantendo em atencao humana (mensagem do cliente pos-NF)`);
            const _uRec = await lcp.atualizarVenda(venda.order_id, _camposRec);
            // BLOQUEADA: o cancelamento venceu a corrida e a guarda automatica recusou
            // o status 'processado'. A NF externa CONFIRMADA nao pode se perder — sem
            // ela, a linha vira uma cancelada comum e ninguem e avisado pra cancelar a
            // nota. Regrava sem o status (que o terminal protege) e monta o alerta.
            if (_uRec && _uRec.bloqueada) {
              const _rr = await lcp.buscar(venda.order_id);
              const _vv = (_rr && _rr.ok) ? _rr.data : null;
              if (_vv) {
                const _c2 = { nf_emitida_em: new Date().toISOString(), bling_pedido_id: String(busca.pedidoId) };
                if (!_vv.alerta_pos_venda && !_vv.alerta_reconhecido_em) {
                  _c2.alerta_pos_venda = ('CANCELADA NO ML com NF CONFIRMADA no Bling. NAO DESPACHAR. ' +
                    'Conferir e cancelar/estornar a nota.').slice(0, 500);
                }
                const _u2 = await lcp.atualizarVenda(venda.order_id, _c2, { forcar: true });
                console.error(`[revisar] order ${venda.order_id} 🚨 NF confirmada em venda CANCELADA — alerta ${(_u2 && _u2.ok) ? 'gravado' : 'FALHOU'}`);
              } else {
                console.error(`[revisar] order ${venda.order_id} 🚨 NF confirmada, escrita bloqueada e releitura falhou — conferir na mao`);
              }
            }
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
            // NAO da continue aqui: a venda segue em atencao humana, e se o cliente
            // mandou uma mensagem nova ela precisa chegar no re-engajamento abaixo —
            // justamente o caso que a janela ampliada quer recuperar. O continue
            // incondicional matava isso. So pula quando a linha foi re-roteada.
          }
          if (claroEstrut && AUTO_EMITIR_HABILITADO) continue;
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

  // Enfileira uma entrada SO pra tentar restaurar o status terminal depois. Usado
  // quando o PATCH de 'processado' falha numa chamada que veio direto do lerRespostas
  // (sem entrada previa na fila) — sem isso, retry:true nao agenda nada.
  function enfileirarRestauracao({ orderId, venda, iaResult, graosResult, nfConfirmada, pedidoId }) {
    const k = String(orderId);
    // PROMOVE entrada existente: se a NF ja saiu, uma entrada antiga com
    // soRestaurar:false faria o proximo ciclo reeditar o pedido faturado e tentar
    // emitir de novo. Atualiza no lugar em vez de ignorar.
    if (_retryBling.has(k)) {
      if (nfConfirmada) {
        const e = _retryBling.get(k);
        e.soRestaurar = true; e.nfConfirmada = nfConfirmada;
        e.pedidoId = pedidoId || e.pedidoId || null;
        console.log(`[retry-bling] order ${k} promovido a RESTAURACAO (NF ${nfConfirmada.numero || '?'} ja emitida)`);
      }
      return;
    }
    // nfConfirmada: a NF JA SAIU e so a gravacao falhou. Sem esse discriminador a
    // entrada era indistinguivel de um retry normal — o retentar reeditaria o pedido ja
    // faturado e tentaria emitir de novo, o code 74 viraria 'nf_falhou' e a entrada
    // sairia da fila com a nota ainda sem registro.
    _retryBling.set(k, { venda, iaResult, graosResult, desde: Date.now(), tentativas: 0,
                         soRestaurar: !!nfConfirmada, nfConfirmada: nfConfirmada || null, pedidoId: pedidoId || null });
    console.log(`[retry-bling] order ${k} enfileirado pra restaurar status terminal`);
  }

  return {
    retentarEmissoesBling,
    revisarAtencaoHumana,
    agendarOuEscalarRetry: _agendarOuEscalarRetry,
    removerDaFila,
    enfileirarRestauracao,
  };
};
