'use strict';

/**
 * Fluxo Auto-Mensagens Girassol
 *
 * A cada 5 min (cron):
 *   1. Busca vendas pagas Girassol das últimas 30 min
 *   2. Pra cada venda:
 *      a) Checa se já enviou (Supabase)  → pula
 *      b) Busca detalhe (variation_attributes)
 *      c) Tem "A COMBINAR"?  → envia mensagem  +  grava Supabase
 *      d) Não tem?  → registra como 'pulado' (opcional)
 */

const ml = require('./mlApi');
const tracker = require('./supabaseTracker');

// Integração opcional com módulo /lixas-combinar
// Se falhar (modulo nao disponivel), cai pro texto generico
let lixasService = null;
try {
  lixasService = require('../lixas-combinar/lixasService');
} catch (e) {
  console.log('[auto-mensagens] modulo lixas-combinar nao disponivel — usando msg generica');
}

const HABILITADO = (process.env.AUTO_MSG_GIRASSOL_HABILITADO || 'false').toLowerCase() === 'true';
const TEXTO = process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '';

// Janela de busca de vendas: 30 min pra trás (pega vendas dos últimos minutos)
const JANELA_MIN = Number(process.env.AUTO_MSG_JANELA_MIN || 30);

// Limite de chars da mensagem ML (action_guide aceita até 350)
const LIMITE_CHARS = 350;

// ════════════════════════════════════════════════════════════════
// SESSAO 7: AUTO-EMISSAO DE NF NO FLUXO IA
// ════════════════════════════════════════════════════════════════
// Liga/desliga a auto-emissao. NASCE DESLIGADA — Diego liga quando quiser.
const AUTO_EMITIR_HABILITADO = (process.env.LIXAS_AUTO_EMITIR_NF_HABILITADO || 'false').toLowerCase() === 'true';
// Confianca minima da IA pra auto-executar. Default 95 (o modelo raramente crava
// 100 mesmo em pedido claro). Ajuste via env conforme os ia_confianca reais.
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 95);
// Teto de auto-emissoes por dia (rede de seguranca p/ as primeiras semanas).
// Default 999 = praticamente sem limite. Sugestao: LIXAS_AUTO_MAX_POR_DIA=5 na 1a semana.
const AUTO_MAX_POR_DIA = Number(process.env.LIXAS_AUTO_MAX_POR_DIA || 999);

// ── LEMBRETE controlado (reenvio apos X horas de silencio) ──────────
// So age em conversa que o cliente JA abriu (ML so permite enviar nesses casos).
// NASCE DESLIGADO. Manda no MAXIMO REENVIO_MAX lembretes, espacados de REENVIO_HORAS.
const REENVIO_HABILITADO = (process.env.LIXAS_REENVIO_HABILITADO || 'false').toLowerCase() === 'true';
const REENVIO_HORAS = Number(process.env.LIXAS_REENVIO_HORAS || 6);   // silencio do cliente antes de lembrar
const REENVIO_MAX = Number(process.env.LIXAS_REENVIO_MAX || 1);       // quantos lembretes no maximo (alem da pergunta original)
const REENVIO_TEXTO = process.env.LIXAS_REENVIO_TEXTO ||              // fallback se nao der pra reenviar a pergunta original
  'Olá! Ainda precisamos da sua resposta (quantidades e grãos) para fechar e enviar seu pedido. Pode nos responder por aqui? Obrigado!';

// ── FECHAMENTO pos-processado ────────────────────────────────────────
// Quando o cliente manda msg DEPOIS do pedido ja processado (ex: "Sim", "ok"),
// responde UMA unica vez com o texto de fechamento e encerra — sem convidar
// mais conversa. Mensagem que NAO for simples confirmacao/agradecimento vai
// pro painel (humano), pois com NF emitida qualquer mudanca precisa de gente.
const FECHAMENTO_HABILITADO = (process.env.LIXAS_FECHAMENTO_HABILITADO || 'true').toLowerCase() === 'true';
const FECHAMENTO_TEXTO = process.env.LIXAS_FECHAMENTO_TEXTO ||
  'Obrigado! Seu pedido está confirmado e será postado em breve — todo rastreamento da entrega você acompanha dentro da sua compra no MercadoLivre. 😊';
const FECHAMENTO_DIAS = Number(process.env.LIXAS_FECHAMENTO_DIAS || 3); // janela de vendas processadas a vigiar

const AFIRMACOES_SIMPLES = ['sim', 'ok', 'okay', 'blz', 'beleza', 'obrigado', 'obrigada', 'obg', 'valeu', 'vlw',
  'perfeito', 'isso', 'isso mesmo', 'certo', 'correto', 'pode ser', 'show', 'top', 'joia', 'jóia',
  '👍', '👍🏻', 'ta bom', 'tá bom', 'tudo certo', 'confirmado', 'fechado', 'fechou', 'sim!', 'ok!'];
function ehAfirmacaoSimples(texto) {
  const t = String(texto || '').trim().toLowerCase().replace(/[!.…\s]+$/g, '').trim();
  if (!t) return false;
  return AFIRMACOES_SIMPLES.includes(t);
}

// ── COOLDOWN de envio (anti-duplicata por atraso do ML) ──────────────
// O ML demora alguns minutos pra "mostrar" na conversa uma msg recem-enviada
// (moderacao/indexacao). Nesse vao a trava por conversa fica cega e pode
// duplicar (caso 05/06 15:30->15:32). Solucao: memoria local do ultimo envio
// por order — bloqueia reavaliacao/envio pro mesmo order dentro da janela.
const ENVIO_COOLDOWN_MIN = Number(process.env.LIXAS_ENVIO_COOLDOWN_MIN || 5);
// Cooldown PERSISTENTE (banco) entre envios da IA pra mesma venda. Fecha o
// loop infinito que vivia no ponto cego de 2-4 min do ML refletir mensagens.
const IA_ENVIO_COOLDOWN_MIN = Number(process.env.LIXAS_IA_ENVIO_COOLDOWN_MIN || 8);
const _ultimoEnvioPorOrder = new Map();
function registrarEnvio(orderId) { _ultimoEnvioPorOrder.set(String(orderId), Date.now()); }
function emCooldownEnvio(orderId) {
  const t = _ultimoEnvioPorOrder.get(String(orderId));
  return !!t && (Date.now() - t) < ENVIO_COOLDOWN_MIN * 60 * 1000;
}

// ── DATA REAL de uma mensagem do ML ──────────────────────────────────
// A API de mensagens do ML traz a data em message_date (objeto:
// received/created/available/...), NAO em date_created (que vinha undefined).
// Antes o codigo usava `m.date_created || m.date || agora`, e o fallback "agora"
// fazia _tsRespAtual ficar sempre no presente -> as travas anti-loop (#2 e #4)
// achavam que sempre havia msg nova do cliente e a IA reenviava em loop.
// Retorna timestamp em ms, ou 0 se realmente nao houver data (fallback seguro:
// 0 faz a trava #2 segurar em vez de reenviar).
function _tsMensagemML(m) {
  if (!m) return 0;
  const md = m.message_date || {};
  const d = md.received || md.created || md.available || md.notified
    || m.date_created || m.date || m.created_at || null;
  const t = d ? new Date(d).getTime() : 0;
  return isNaN(t) ? 0 : t;
}

// ── TRAVA POR MENSAGEM (memoria local) ───────────────────────────────
// Versao em memoria da trava do banco (ia_processado_em): guarda o timestamp
// da ULTIMA msg do cliente que JA respondemos. Msg nova passa NA HORA (zero
// atraso); a mesma msg nunca eh respondida duas vezes.
const _ultimaMsgProcessadaPorOrder = new Map();
function registrarMsgProcessada(orderId, tsMsgCliente) { _ultimaMsgProcessadaPorOrder.set(String(orderId), tsMsgCliente); }
function msgJaProcessada(orderId, tsMsgCliente) {
  const t = _ultimaMsgProcessadaPorOrder.get(String(orderId));
  return !!t && tsMsgCliente <= t;
}

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

// Contador in-memory (zera a cada dia / a cada restart do Render — proposital,
// eh so um freio leve, nao precisa de persistencia).
let _autoEmitidasHoje = { data: '', count: 0 };
function _hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
}
function podeAutoEmitir() {
  const hoje = _hojeSP();
  if (_autoEmitidasHoje.data !== hoje) _autoEmitidasHoje = { data: hoje, count: 0 };
  return _autoEmitidasHoje.count < AUTO_MAX_POR_DIA;
}
function incrementarAutoEmitida() {
  const hoje = _hojeSP();
  if (_autoEmitidasHoje.data !== hoje) _autoEmitidasHoje = { data: hoje, count: 0 };
  _autoEmitidasHoje.count++;
}

/**
 * Tenta montar mensagem inteligente com grãos disponíveis.
 * Se falhar (SKU nao mapeado, Bling fora, etc), retorna o TEXTO genérico.
 *
 * Formato final (desenhado pra cliente entender):
 *   "Ola! Sua compra de {N} lixas {desc}.
 *
 *    GRAOS DISPONIVEIS: 24, 40, 60, ...
 *
 *    Responda com QUANTIDADE + GRAO. MULTIPLOS de {U}. Total {N} lixas.
 *    Ex: 30 do grao 24; 70 do grao 80."
 *
 * @param {object} detalhe - objeto order completo do ML
 * @returns {Promise<string>} texto da mensagem (max 350 chars)
 */
async function montarMensagemInteligente(detalhe) {
  // Se nao tem lixas-combinar carregado, usa generico
  if (!lixasService) {
    return TEXTO;
  }

  try {
    const info = ml.extrairSkuACombinar(detalhe);
    if (!info?.sku) {
      console.log('[auto-mensagens] sem SKU no item — usando msg generica');
      return TEXTO;
    }

    console.log(`[auto-mensagens] SKU A COMBINAR detectado: ${info.sku} (qtd=${info.quantidade})`);

    const r = await lixasService.getGraosDisponiveisPorSkuACombinar(info.sku);
    if (!r.ok || !r.graos || r.graos.length === 0) {
      console.log(`[auto-mensagens] sem graos disponiveis pra ${info.sku} (${r.erro || 'vazio'}) — usando msg generica`);
      return TEXTO;
    }

    // Calcula total de lixas que cliente comprou
    const totalLixas = r.lixas_por_kit * info.quantidade;
    const unidades = r.unidades_por_pacote || 10;

    // Gera exemplo DINÂMICO que SOMA até o total real
    function gerarExemplo(total, unidades, graosArr) {
      if (graosArr.length === 0) return `Ex: ${total} do grão desejado.`;
      if (graosArr.length === 1) return `Ex: ${total} do grão ${graosArr[0]}.`;
      const grao1 = graosArr[0];
      const idx2 = Math.min(2, graosArr.length - 1);
      const grao2 = graosArr[idx2];
      const parte1 = Math.round(total * 0.3 / unidades) * unidades;
      const parte2 = total - parte1;
      return `Ex: ${parte1} do grão ${grao1}; ${parte2} do grão ${grao2}.`;
    }

    // Monta mensagem desenhada (com acentos, MAIUSCULO nos pontos chave)
    function montar(graosArr) {
      const graosStr = graosArr.join(', ');
      const exemplo = gerarExemplo(totalLixas, unidades, graosArr);
      return `Olá! INFORME a combinação de lixas e grãos do seu pedido.

GRÃOS DISPONÍVEIS: ${graosStr}.

⚠️ ATENÇÃO: responda QUANTIDADE + GRÃO (múltiplos de ${unidades}, total ${totalLixas}).
${exemplo}

Quanto antes responder, mais rápido postaremos!`;
    }

    let graosArr = r.graos.map(g => g.grao);
    let msg = montar(graosArr);

    // Safety: se ultrapassar 350, vai removendo graos do fim (mais grossos)
    if (msg.length > LIMITE_CHARS) {
      while (graosArr.length > 3 && msg.length > LIMITE_CHARS) {
        graosArr.pop();
        msg = montar(graosArr);
      }
      // Sinaliza que cortou — adiciona "..." no ultimo grao
      if (msg.length <= LIMITE_CHARS) {
        graosArr[graosArr.length - 1] = graosArr[graosArr.length - 1] + ' ...';
        msg = montar(graosArr);
      }
      // Se MESMO assim passou, usa generico
      if (msg.length > LIMITE_CHARS) {
        console.log(`[auto-mensagens] msg inteligente impossivel < ${LIMITE_CHARS} (${msg.length}) — usando generica`);
        return TEXTO;
      }
    }

    console.log(`[auto-mensagens] msg inteligente montada (${msg.length} chars, ${graosArr.length} graos)`);
    return msg;
  } catch (e) {
    console.error(`[auto-mensagens] erro montando msg inteligente: ${e.message} — usando generica`);
    return TEXTO;
  }
}

let _executando = false;

async function rotinaACombinar() {
  if (_executando) {
    console.log('[auto-mensagens] já em execução, pulando');
    return { skipped: 'em_execucao' };
  }
  _executando = true;

  const inicio = Date.now();
  const stats = { lidos: 0, jaEnviados: 0, semACombinar: 0, enviados: 0, erros: 0, moderados: 0 };

  try {
    if (!HABILITADO) {
      console.log('[auto-mensagens] AUTO_MSG_GIRASSOL_HABILITADO=false → pulando');
      return { skipped: 'desligado', stats };
    }
    if (!TEXTO) {
      console.error('[auto-mensagens] ⚠️ AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR vazio - não enviando');
      return { erro: 'texto_vazio', stats };
    }
    if (!tracker.configurado()) {
      console.error('[auto-mensagens] ⚠️ Supabase não configurado - abortando pra não duplicar');
      return { erro: 'supabase_nao_configurado', stats };
    }

    const desde = new Date(Date.now() - JANELA_MIN * 60 * 1000);
    console.log(`[auto-mensagens] 🔍 Buscando vendas Girassol desde ${desde.toISOString()}`);

    const vendas = await ml.buscarVendasPagas(desde);
    stats.lidos = vendas.length;
    console.log(`[auto-mensagens] ${vendas.length} venda(s) paga(s) na janela`);

    for (const venda of vendas) {
      try {
        const orderId = venda.id;
        // 1. Já enviou?
        if (await tracker.jaEnviou(orderId)) {
          stats.jaEnviados++;
          continue;
        }
        // 2. Busca detalhe completo (variation_attributes)
        const detalhe = await ml.getOrderDetalhe(orderId);
        // 3. Tem "A COMBINAR"?
        if (!ml.temVariacaoACombinar(detalhe)) {
          stats.semACombinar++;
          // Registra como pulado pra não verificar de novo na próxima rodada
          await tracker.registrar({
            orderId, packId: detalhe.pack_id, buyerId: detalhe.buyer?.id,
            tipo: 'a_combinar', textoEnviado: null, messageIdMl: null,
            status: 'pulado', erroDetalhe: 'sem_variacao_a_combinar',
            loja: 'GIRASSOL'
          });
          continue;
        }
        // 4. Monta mensagem (inteligente se SKU mapeado, senão genérica)
        const buyerId = detalhe.buyer?.id;
        const packId = detalhe.pack_id;
        const textoFinal = await montarMensagemInteligente(detalhe);

        // 4.5. NOVO (Sessao 3 Etapa A): consulta conversa pra decidir endpoint
        //      - virgem  → action_guide OTHER (1 uso, gasta o cap)
        //      - tem msg → POST direto (preserva o cap pra outra situacao)
        const conv = await ml.consultarConversa({ packId, orderId });
        let r;
        let viaEndpoint;
        let respostasCliente = null;

        if (conv.ok && !conv.conversaVirgem && conv.totalCliente > 0) {
          // Cliente ja mandou msg - envia direto sem action_guide
          viaEndpoint = 'direto';
          respostasCliente = conv.ultimaCliente;
          console.log(`[auto-mensagens] 💬 Order ${orderId} ja tem ${conv.totalCliente} msg(s) do cliente — enviando DIRETO (preserva OTHER)`);
          r = await ml.enviarMensagemDireta({
            packId, orderId, buyerId, texto: textoFinal
          });
        } else {
          // Conversa virgem (ou erro consultando) - usa action_guide
          viaEndpoint = 'action_guide';
          console.log(`[auto-mensagens] 📨 Order ${orderId} conversa virgem — enviando via ACTION_GUIDE OTHER (buyer ${buyerId}, pack ${packId || 'null'}, ${textoFinal.length} chars)`);
          r = await ml.enviarMensagem({
            packId, orderId, buyerId, texto: textoFinal
          });
        }
        if (r.ok) {
          const modStatus = r.moderation_status || 'unknown';
          const foiModerado = ['IN_MODERATION', 'rejected', 'REJECTED'].includes(modStatus);
          if (foiModerado) stats.moderados++;
          else stats.enviados++;

          await tracker.registrar({
            orderId, packId, buyerId,
            tipo: 'a_combinar', textoEnviado: textoFinal,
            messageIdMl: r.message_id, status: foiModerado ? 'moderado' : 'enviado',
            erroDetalhe: foiModerado ? `moderation=${modStatus}` : (viaEndpoint === 'direto' ? 'enviado_direto_cliente_ja_respondeu' : null),
            loja: 'GIRASSOL'
          });

          // NOVO Sessao 3: registra na tabela lixas_combinar_pendentes
          try {
            const sku = ml.extrairSkuACombinar(detalhe);
            const lcp = require('./lixasCombinarPendentes');
            if (lcp.configurado()) {
              await lcp.upsertPendente({
                orderId, packId, buyerId,
                buyerNome: detalhe.buyer?.nickname || `${detalhe.buyer?.first_name || ''} ${detalhe.buyer?.last_name || ''}`.trim(),
                skuACombinar: sku?.sku || null,
                descricaoProduto: sku?.titulo || null,
                quantidadeLixas: null, // preenchido pelo painel
                dataVenda: detalhe.date_created || new Date().toISOString(),
                msgInicialEnviada: textoFinal,
                msgInicialEnviadaEm: new Date().toISOString(),
                clienteRespondeu: !!respostasCliente,
                ultimaRespostaCliente: respostasCliente?.text || null,
                ultimaRespostaEm: respostasCliente?.date_created || null,
                totalMsgsCliente: conv.totalCliente || 0,
                status: respostasCliente ? 'cliente_respondeu' : 'aguardando_resposta',
                viaEndpoint
              });
            }
          } catch (e) {
            console.error(`[auto-mensagens] erro upsert pendente: ${e.message}`);
          }

          console.log(`[auto-mensagens] ✅ Order ${orderId} → status=${foiModerado ? 'moderado' : 'enviado'} via=${viaEndpoint} (msg_id=${r.message_id})`);
        } else {
          stats.erros++;
          await tracker.registrar({
            orderId, packId, buyerId,
            tipo: 'a_combinar', textoEnviado: textoFinal,
            messageIdMl: null, status: 'erro', erroDetalhe: `${viaEndpoint} ${r.status}: ${r.erro}`.slice(0, 500),
            loja: 'GIRASSOL'
          });
          console.error(`[auto-mensagens] ❌ Order ${orderId} → erro ${r.status} via ${viaEndpoint}: ${r.erro}`);
        }
      } catch (e) {
        stats.erros++;
        console.error(`[auto-mensagens] erro processando order ${venda.id}: ${e.message}`);
      }
    }

    const dur = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[auto-mensagens] ✓ Fim em ${dur}s — ${JSON.stringify(stats)}`);
    return { ok: true, stats, duracao_s: Number(dur) };
  } catch (e) {
    console.error('[auto-mensagens] ❌ erro fatal:', e.message);
    return { ok: false, erro: e.message, stats };
  } finally {
    _executando = false;
  }
}

module.exports = { rotinaACombinar, rotinaLerRespostas, forcarOrder, processarAutoEmissao, recuperarPendentes, recuperarFalsosProcessados, rotinaEscadaIndisponivel, HABILITADO, TEXTO };

/**
 * RECUPERAR FALSOS PROCESSADOS — conserta vendas que foram marcadas como
 * 'processado' NA MAO (botao "✓ Processado" do painel) SEM nunca terem sido
 * montadas/emitidas. Sintoma: status=processado, bling_editado_em=null,
 * nf_emitida_em=null, pedido ABERTO no Bling, sem NF. (O botao manual so troca
 * o status — nao monta nem emite; se clicado por engano, esconde o card e o
 * pedido fica sem NF pra sempre porque 'processado' eh terminal.)
 *
 * Alvo (todas as condicoes): status=processado, bling_editado_em null,
 *   nf_emitida_em null, IA categoria 'claro', confianca >= LIMIAR, com
 *   pedido_estruturado valido salvo.
 *
 * TRAVA DE SEGURANCA: antes de re-emitir, confirma no Bling que o pedido ainda
 *   esta ABERTO (situacao NAO concluida e NAO cancelada). Assim nunca tocamos
 *   num pedido legitimamente finalizado (ex.: alguem que emitiu a NF por fora e
 *   marcou processado de propria — esse fica concluido no Bling e eh PULADO).
 *
 * Reusa processarAutoEmissao (mesma logica/guardas/rateio do fluxo normal); a
 * idempotencia do code-74 protege caso ja exista NF.
 *
 * @param {object} opts { dias = 30 } janela (por msg_inicial_enviada_em)
 * @returns {object} relatorio por pedido
 */
async function recuperarFalsosProcessados({ dias = 30 } = {}) {
  const lcp = require('./lixasCombinarPendentes');
  const lixasService = require('../lixas-combinar/lixasService');
  const bp = require('../lixas-combinar/blingPedidos');

  const SIT_CONCLUIDAS = String(process.env.LIXAS_BLING_SITUACOES_CONCLUIDAS || '9')
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  const SIT_CANCELADAS = String(process.env.LIXAS_BLING_SITUACOES_CANCELADAS || '12')
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  const PAUSA_MS = Number(process.env.LIXAS_RECUPERAR_PAUSA_MS) || 1500;

  const out = {
    ok: true, dias, analisados: 0, candidatos: 0, emitidos: 0,
    emitidosLista: [], pulados: [], erros: [], diag: []
  };

  let lista;
  try { lista = await lcp.listarPendentes({ dias, status: 'processado', limit: 200 }); }
  catch (e) { return { ok: false, erro: `listar processado: ${e.message}` }; }
  const vendas = (lista && lista.ok && Array.isArray(lista.data)) ? lista.data : [];
  out.analisados = vendas.length;

  for (const v of vendas) {
    const oid = String(v.order_id);
    const nome = v.buyer_nome || '';

    // (1) Filtro — so os FALSOS (marcados na mao, sem montar/emitir)
    if (v.bling_editado_em) continue;                                   // ja montado de verdade
    if (v.nf_emitida_em) continue;                                      // ja tem NF registrada
    if (String(v.ia_categoria || '') !== 'claro') continue;            // ambiguo: nao auto
    if (Number(v.ia_confianca || 0) < LIMIAR_CONFIANCA_AUTO) continue; // confianca baixa: nao auto

    let pedido_estruturado = null;
    try { pedido_estruturado = v.ia_pedido_estruturado ? JSON.parse(v.ia_pedido_estruturado) : null; } catch (_) {}
    if (!Array.isArray(pedido_estruturado) || pedido_estruturado.length === 0) continue;

    out.candidatos++;

    // (2) TRAVA — decide pela NF DE VERDADE, nao pela situacao. A integracao
    // nativa do Bling fica movendo o pedido entre "Em aberto" e "Atendido"
    // (bounce) quando a NF automatica falha, entao a situacao nao eh confiavel.
    // O que importa: TEM NF vinculada? Se sim, eh legitimo -> pula. Se nao (e nao
    // estiver cancelado), recupera — mesmo em situacao 9 (editarPedidoComGraos
    // ja sabe editar pedido "Atendido").
    let pedSituacao = null, pedNotaRaw;
    try {
      const idBusca = v.pack_id || v.order_id;
      const dataVenda = v.data_venda ? String(v.data_venda).split('T')[0] : null;
      let dIni, dFim;
      if (dataVenda) {
        const d = new Date(dataVenda);
        const a = new Date(d); a.setDate(a.getDate() - 3);
        const b = new Date(d); b.setDate(b.getDate() + 3);
        dIni = a.toISOString().split('T')[0];
        dFim = b.toISOString().split('T')[0];
      }
      const busca = await bp.buscarPedidoPorOrderId(idBusca, dIni, dFim);
      if (!busca || !busca.ok) {
        out.pulados.push({ order_id: oid, nome, motivo: 'nao achei o pedido no Bling — conferir na mao' });
        continue;
      }
      const det = await bp.obterPedidoCompleto(busca.pedidoId);
      if (!det || !det.ok) {
        out.pulados.push({ order_id: oid, nome, motivo: `nao li o detalhe do pedido ${busca.pedidoId} no Bling` });
        continue;
      }
      const ped = det.pedido || {};
      pedSituacao = Number(ped.situacao?.id);
      pedNotaRaw = ped.notaFiscal; // Bling v3: { id } quando ha NF vinculada
      const nfId = (pedNotaRaw && typeof pedNotaRaw === 'object') ? pedNotaRaw.id : pedNotaRaw;
      const temNF = Number(nfId) > 0;

      // diag: deixa visivel o que o Bling devolveu (pra eu confirmar o campo da NF)
      out.diag.push({ order_id: oid, nome, situacao: pedSituacao, notaFiscal: pedNotaRaw ?? null });

      if (SIT_CANCELADAS.includes(pedSituacao)) {
        out.pulados.push({ order_id: oid, nome, motivo: `Bling cancelado (situacao ${pedSituacao}) — ignorado` });
        continue;
      }
      if (temNF) {
        out.pulados.push({ order_id: oid, nome, motivo: `ja tem NF no Bling (id ${nfId}, situacao ${pedSituacao}) — legitimo, nao mexo` });
        continue;
      }
      // sem NF e nao cancelado -> recupera (segue pro montar+emitir abaixo)
    } catch (e) {
      out.pulados.push({ order_id: oid, nome, motivo: `erro checando Bling: ${e.message}` });
      continue;
    }

    // (3) Reconstroi contexto (mesmo padrao do retry) e re-emite montar + NF
    const iaResult = {
      categoria: v.ia_categoria || 'claro',
      confianca: Number(v.ia_confianca || 0),
      pedido_estruturado,
      interpretacao: v.ia_interpretacao || null,
      msg_pra_cliente: v.ia_msg_enviada || null
    };
    let graosResult;
    try { graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar); }
    catch (e) { out.erros.push({ order_id: oid, nome, erro: `estoque: ${e.message}` }); continue; }
    if (!graosResult || !graosResult.ok) { out.erros.push({ order_id: oid, nome, erro: 'estoque indisponivel no Bling' }); continue; }

    try {
      const r = await processarAutoEmissao({ venda: v, iaResult, graosResult, lcp });
      if (r && r.emitida) {
        out.emitidos++;
        out.emitidosLista.push({ order_id: oid, nome });
      } else {
        // processarAutoEmissao ja gravou o erro e pos em precisa_atencao_humano:
        // le de volta pra reportar o motivo exato.
        let motivo = (r && r.motivo) || 'falha — ver painel';
        try {
          const re = await lcp.buscar(oid);
          if (re && re.ok && re.data) motivo = re.data.nf_erro || re.data.bling_erro || motivo;
        } catch (_) {}
        out.erros.push({ order_id: oid, nome, erro: motivo });
      }
    } catch (e) {
      out.erros.push({ order_id: oid, nome, erro: e.message });
    }

    await new Promise(r => setTimeout(r, PAUSA_MS)); // respira: rate limit Bling
  }

  return out;
}

/**
 * RECUPERAR PENDENTES — re-registra na tabela lixas_combinar_pendentes todas
 * as vendas A COMBINAR de uma janela maior (default 7 dias), SEM reenviar
 * mensagem inicial (so recoloca no radar pra lerRespostas processar).
 * Util quando registros foram apagados da tabela ou ficaram pra tras da
 * janela de 30min da rotinaACombinar. Varre packs multi-order corretamente.
 *
 * @param {number} dias - quantos dias pra tras buscar (default 7)
 * @returns {object} stats
 */
async function recuperarPendentes(dias = 7) {
  const stats = { dias, vendasNaJanela: 0, aCombinar: 0, registradas: 0, jaTinham: 0, semACombinar: 0, erros: 0, detalhes: [] };
  const lcp = require('./lixasCombinarPendentes');
  if (!lcp.configurado()) return { ok: false, erro: 'supabase_nao_configurado', stats };

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  console.log(`[recuperar] buscando vendas A COMBINAR desde ${desde.toISOString()} (${dias} dias)`);

  let vendas;
  try {
    vendas = await ml.buscarVendasPagas(desde);
  } catch (e) {
    return { ok: false, erro: `buscarVendasPagas falhou: ${e.message}`, stats };
  }
  stats.vendasNaJanela = vendas.length;

  for (const venda of vendas) {
    try {
      const orderId = String(venda.id);
      const detalhe = await ml.getOrderDetalhe(orderId);
      if (!ml.temVariacaoACombinar(detalhe)) { stats.semACombinar++; continue; }
      stats.aCombinar++;

      // ja esta na tabela?
      const existente = await lcp.buscar(orderId);
      if (existente.ok && existente.data) { stats.jaTinham++; continue; }

      // le a conversa pra saber se o cliente ja respondeu (define status)
      const packId = detalhe.pack_id;
      const buyerId = detalhe.buyer?.id;
      let respostasCliente = null;
      let totalMsgsCliente = 0;
      try {
        const conv = await ml.consultarConversa({ packId, orderId, markAsRead: false });
        if (conv.ok) {
          totalMsgsCliente = conv.totalCliente || 0;
          respostasCliente = (conv.totalCliente > 0) ? conv.ultimaCliente : null;
        }
      } catch (_) { /* segue sem conversa */ }

      const sku = ml.extrairSkuACombinar(detalhe);
      await lcp.upsertPendente({
        orderId, packId, buyerId,
        buyerNome: detalhe.buyer?.nickname || `${detalhe.buyer?.first_name || ''} ${detalhe.buyer?.last_name || ''}`.trim(),
        skuACombinar: sku?.sku || null,
        descricaoProduto: sku?.titulo || null,
        quantidadeLixas: null,
        dataVenda: detalhe.date_created || new Date().toISOString(),
        msgInicialEnviada: null,           // NAO reenvia — so recupera
        msgInicialEnviadaEm: null,
        clienteRespondeu: !!respostasCliente,
        ultimaRespostaCliente: respostasCliente?.text || null,
        ultimaRespostaEm: respostasCliente?.date_created || null,
        totalMsgsCliente,
        status: respostasCliente ? 'cliente_respondeu' : 'aguardando_resposta',
        viaEndpoint: 'recuperado'
      });
      stats.registradas++;
      stats.detalhes.push({ orderId, buyer: detalhe.buyer?.nickname, sku: sku?.sku, respondeu: !!respostasCliente });
    } catch (e) {
      stats.erros++;
      console.error(`[recuperar] erro na venda ${venda.id}: ${e.message}`);
    }
  }

  console.log(`[recuperar] fim: ${stats.registradas} registradas, ${stats.jaTinham} ja tinham, ${stats.aCombinar} A COMBINAR de ${stats.vendasNaJanela} vendas`);
  return { ok: true, stats };
}

/**
 * NOVO (Sessao 3): rotinaLerRespostas
 *
 * Roda a cada 2 min (cron). Busca todas as vendas A COMBINAR dos ultimos 7 dias
 * que estao na tabela lixas_combinar_pendentes com status 'aguardando_resposta',
 * e pra cada uma consulta a conversa no ML. Se o cliente respondeu, atualiza
 * o Supabase com a mensagem dele E marca como lida no ML.
 */
let _lendoRespostas = false;

async function rotinaLerRespostas() {
  if (_lendoRespostas) {
    console.log('[lixas-combinar lerRespostas] já em execução, pulando');
    return { skipped: 'em_execucao' };
  }
  _lendoRespostas = true;

  const inicio = Date.now();
  const stats = { lidas: 0, novasRespostas: 0, semNovidade: 0, erros: 0, iaProcessadas: 0, iaEscalonadas: 0, iaErros: 0, lembretesEnviados: 0, fechamentosEnviados: 0, posProcessadoEscalados: 0, autoEmitidas: 0, autoPuladasConfianca: 0, autoFalhas: 0 };

  // IA opcional
  let ia = null;
  const IA_HABILITADO = (process.env.LIXAS_IA_HABILITADO || 'false').toLowerCase() === 'true';
  if (IA_HABILITADO) {
    try { ia = require('../lixas-combinar/iaCliente'); }
    catch (e) { console.log('[lixas-combinar lerRespostas] IA modulo nao carregavel:', e.message); }
  }

  try {
    const lcp = require('./lixasCombinarPendentes');
    if (!lcp.configurado()) {
      console.log('[lixas-combinar lerRespostas] supabase nao configurado, pulando');
      return { skipped: 'supabase_nao_configurado' };
    }

    // Passos previos (rodam SEMPRE, antes da fila principal):
    //  - retry de emissoes que falharam por "pedido ainda nao importado no Bling"
    //  - reconciliacao com Bling + re-engajamento de vendas em atencao humana
    try { await retentarEmissoesBling({ lcp }); } catch (e) { console.error('[retry-bling] falhou:', e.message); }
    try { await revisarAtencaoHumana({ lcp }); } catch (e) { console.error('[revisar] falhou:', e.message); }

    // Lista pendentes a processar (ultimos 7 dias).
    // IMPORTANTE: inclui TANTO 'aguardando_resposta' QUANTO 'cliente_respondeu'.
    // O 'cliente_respondeu' eh setado quando o cliente escreve ANTES da nossa msg
    // inicial sair (corrida). Sem isso, essas vendas ficavam orfas e a IA nunca rodava.
    const listaAg = await lcp.listarPendentes({ dias: 7, status: 'aguardando_resposta', limit: 50 });
    const listaResp = await lcp.listarPendentes({ dias: 7, status: 'cliente_respondeu', limit: 50 });
    if (!listaAg.ok && !listaResp.ok) {
      console.error(`[lixas-combinar lerRespostas] erro listando: ${JSON.stringify((listaAg.data || listaResp.data)).slice(0,200)}`);
      return { ok: false, erro: 'erro_listar', stats };
    }

    const _arrAg = (listaAg.ok && Array.isArray(listaAg.data)) ? listaAg.data : [];
    const _arrResp = (listaResp.ok && Array.isArray(listaResp.data)) ? listaResp.data : [];
    const _vistos = new Set();
    const pendentes = [];
    for (const v of [..._arrAg, ..._arrResp]) {
      const k = String(v.order_id);
      if (_vistos.has(k)) continue;
      _vistos.add(k);
      pendentes.push(v);
    }
    stats.lidas = pendentes.length;
    if (pendentes.length === 0) {
      console.log('[lixas-combinar lerRespostas] sem pendentes pra checar');
      return { ok: true, stats };
    }

    console.log(`[lixas-combinar lerRespostas] checando ${pendentes.length} venda(s) pendente(s)`);

    for (const venda of pendentes) {
      try {
        const conv = await ml.consultarConversa({
          packId: venda.pack_id,
          orderId: venda.order_id,
          markAsRead: true   // já marca como lida ao consultar (Diego pediu)
        });

        if (!conv.ok) {
          stats.erros++;
          console.error(`[lixas-combinar lerRespostas] erro conversa order ${venda.order_id}: ${conv.erro}`);
          continue;
        }

        if (conv.totalCliente > 0 && conv.ultimaCliente) {
          const textoCliente = conv.ultimaCliente.text || conv.ultimaCliente.message || '';
          const _tsRespAtual = _tsMensagemML(conv.ultimaCliente);
          const dataResposta = _tsRespAtual ? new Date(_tsRespAtual).toISOString() : new Date().toISOString();

          // ════════════════════════════════════════════════════════
          // TRAVA DE COOLDOWN PERSISTENTE (fix loop infinito 15/06)
          // Independe de memoria (Map zera em restart) E da conversa do ML
          // refletir o envio (ML demora 2-4 min, criando ponto cego onde a
          // IA reenviava infinitamente — caso kely anacleto 09:04/06/09/10).
          // Regra dura: se a IA gravou ia_processado_em ha menos de
          // IA_ENVIO_COOLDOWN_MIN, NAO faz NADA nesta venda neste ciclo.
          // O banco eh instantaneo e sobrevive a restart -> fecha o loop.
          // ════════════════════════════════════════════════════════
          if (venda.ia_processado_em) {
            const minDesdeIA = (Date.now() - new Date(venda.ia_processado_em).getTime()) / 60000;
            if (minDesdeIA < IA_ENVIO_COOLDOWN_MIN) {
              stats.semNovidade++;
              console.log(`[lixas-combinar lerRespostas] 🛑 order ${venda.order_id} cooldown persistente (${minDesdeIA.toFixed(1)}min < ${IA_ENVIO_COOLDOWN_MIN}min desde ultimo envio IA) — pula`);
              continue;
            }
          }

          // TRAVA "MESMA MENSAGEM" PERSISTENTE: se a IA ja tratou uma msg do
          // cliente com timestamp >= a atual, a bola esta com o cliente. So
          // volta a agir quando chegar msg ESTRITAMENTE mais nova. Usa
          // ultima_resposta_em (gravado no banco) — nao depende de memoria.
          if (venda.ia_processado_em && venda.ultima_resposta_em) {
            const tsTratada = new Date(venda.ultima_resposta_em).getTime();
            if (_tsRespAtual <= tsTratada) {
              stats.semNovidade++;
              console.log(`[lixas-combinar lerRespostas] 🔒 order ${venda.order_id} msg do cliente nao mudou desde ultimo tratamento IA — pula (anti-loop)`);
              continue;
            }
          }

          // TRAVA POR MENSAGEM: se ESTA msg do cliente ja foi respondida por
          // este processo, pula. Msg nova do cliente passa direto, sem atraso.
          if (msgJaProcessada(venda.order_id, _tsRespAtual)) {
            stats.semNovidade++;
            continue;
          }

          // ════════════════════════════════════════════════════════
          // ANTI-SPAM ROBUSTO (fix urgente 31/05) — NAO depende do banco.
          // Usa a propria conversa do ML: se a LOJA ja mandou uma mensagem
          // com data >= a ultima msg do cliente, entao a bola esta com o
          // cliente (ja respondemos) -> NAO reenvia. So volta a agir quando
          // o cliente mandar uma mensagem NOVA (mais recente que a da loja).
          // Isto cobre o caso em que ia_processado_em nao persiste no Supabase.
          // ════════════════════════════════════════════════════════
          {
            const _sellerId = String(require('./mlTokenManager').getUserId() || '');
            const _msgs = Array.isArray(conv.messages) ? conv.messages : [];
            const _ehLoja = (m) => String(m.from_user_id || m.from?.user_id || '') === _sellerId;
            const _ts = (m) => _tsMensagemML(m);
            const _ultCliente = _msgs.filter(m => !_ehLoja(m)).reduce((mx, m) => Math.max(mx, _ts(m)), 0);
            const _ultLoja = _msgs.filter(_ehLoja).reduce((mx, m) => Math.max(mx, _ts(m)), 0);
            if (_sellerId && _ultLoja && _ultLoja >= _ultCliente) {
              // A loja ja respondeu apos o cliente -> bola com o cliente.
              // EXCECAO: lembrete controlado. Se passou REENVIO_HORAS desde a
              // nossa ultima msg e ainda nao batemos o teto de lembretes,
              // reenvia a pergunta original UMA vez. Senao, nao reenvia (anti-spam).
              const horasDesdeLoja = (Date.now() - _ultLoja) / 3600000;
              const lojaAposCliente = _msgs.filter(m => _ehLoja(m) && _ts(m) > _ultCliente).sort((a, b) => _ts(a) - _ts(b));
              const lembretesFeitos = Math.max(0, lojaAposCliente.length - 1); // -1 = a pergunta original
              if (REENVIO_HABILITADO && _ultCliente > 0 && horasDesdeLoja >= REENVIO_HORAS && lembretesFeitos < REENVIO_MAX && !emCooldownEnvio(venda.order_id)) {
                const textoLembrete = (lojaAposCliente[0]?.text || '').slice(0, 350) || REENVIO_TEXTO;
                const lemb = await ml.enviarMensagemDireta({
                  packId: venda.pack_id, orderId: venda.order_id, buyerId: venda.buyer_id, texto: textoLembrete
                });
                if (lemb.ok) {
                  stats.lembretesEnviados++;
                  registrarEnvio(venda.order_id);
                  console.log(`[lixas-combinar lerRespostas] 🔔 Order ${venda.order_id} LEMBRETE #${lembretesFeitos + 1}/${REENVIO_MAX} enviado (silencio ${horasDesdeLoja.toFixed(1)}h)`);
                } else {
                  console.error(`[lixas-combinar lerRespostas] order ${venda.order_id} falhou lembrete: ${lemb.status} ${lemb.erro?.slice(0, 150)}`);
                }
                continue; // nao processa IA (nao ha msg nova do cliente)
              }
              // Sem lembrete a fazer agora -> nao reenvia (anti-spam normal)
              console.log(`[lixas-combinar lerRespostas] ⏭️  Order ${venda.order_id} loja ja respondeu apos o cliente — aguardando cliente (NAO reenvia)`);
              stats.semNovidade++;
              continue;
            }
          }

          // ════════════════════════════════════════════════════════
          // ANTI-DUPLICACAO (banco) — trava secundaria. Se ia_processado_em
          // estiver persistindo, reforca; se nao, a trava acima ja cobre.
          // ════════════════════════════════════════════════════════
          if (venda.ia_processado_em && venda.ultima_resposta_em) {
            const tIa = new Date(venda.ia_processado_em).getTime();
            const tRespAtual = new Date(dataResposta).getTime();
            // Se IA ja processou DEPOIS da resposta atual do cliente, eh duplicata
            if (tIa >= tRespAtual - 1000) {
              console.log(`[lixas-combinar lerRespostas] ⏭️  Order ${venda.order_id} ja processada pela IA (msg cliente nao mudou) - pulando`);
              stats.semNovidade++;
              continue;
            }
          }

          // Cliente respondeu - grava na tabela
          await lcp.marcarRespostaCliente(venda.order_id, {
            texto: textoCliente,
            dataResposta,
            totalMsgsCliente: conv.totalCliente
          });
          stats.novasRespostas++;
          console.log(`[lixas-combinar lerRespostas] 💬 Order ${venda.order_id} cliente respondeu (${conv.totalCliente} msg) - "${textoCliente.slice(0, 60)}..."`);

          // ════════════════════════════════════════════════════════
          // PROCESSAMENTO IA (Sessao 4)
          // ════════════════════════════════════════════════════════
          if (ia && ia.configurado() && venda.sku_a_combinar) {
            try {
              // Consulta graos disponiveis (lixasService)
              const lixasService = require('../lixas-combinar/lixasService');
              const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(venda.sku_a_combinar);

              if (!graosResult.ok || !graosResult.graos || graosResult.graos.length === 0) {
                console.log(`[ia] sem graos disponiveis pra ${venda.sku_a_combinar} - pulando IA`);
                continue;
              }

              const graosDisponiveis = graosResult.graos.map(g => g.grao);
              const totalLixas = graosResult.lixas_por_kit; // 100 por padrao (quantidade comprada armazenada na venda)
              const unidadesPorPacote = graosResult.unidades_por_pacote || 10;

              // Monta historico da conversa pro contexto (max 10 ultimas msgs)
              const sellerId = String(require('./mlTokenManager').getUserId() || '');
              const historicoConversa = (conv.messages || [])
                .slice(-10)
                .map(m => {
                  const fromId = String(m.from?.user_id || m.from_user_id || '');
                  return {
                    role: fromId === sellerId ? 'seller' : 'buyer',
                    text: m.text || m.message || ''
                  };
                })
                .filter(m => m.text);

              console.log(`[ia] processando order ${venda.order_id}: msg="${textoCliente.slice(0,50)}..." (historico=${historicoConversa.length} msgs)`);
              const iaResult = await ia.interpretarRespostaCliente({
                mensagemCliente: textoCliente,
                descricaoProduto: graosResult.descricao,
                totalLixas,
                unidadesPorPacote,
                graosDisponiveis,
                historicoConversa
              });

              if (!iaResult.ok) {
                stats.iaErros++;
                console.error(`[ia] order ${venda.order_id} erro IA: ${iaResult.erro}`);
                await lcp.atualizarVenda(venda.order_id, {
                  ia_categoria: 'erro_ia',
                  ia_confianca: 0,
                  ia_interpretacao: iaResult.erro?.slice(0, 200),
                  ia_processado_em: new Date().toISOString()
                });
                continue;
              }

              console.log(`[ia] order ${venda.order_id} categoria=${iaResult.categoria} confianca=${iaResult.confianca}`);

              // 4 categorias possiveis
              if (iaResult.categoria === 'fora_escopo') {
                // ESCALA PRA HUMANO - apenas marca, nao envia mensagem
                stats.iaEscalonadas++;
                await lcp.atualizarVenda(venda.order_id, {
                  ia_categoria: 'fora_escopo',
                  ia_confianca: iaResult.confianca,
                  ia_interpretacao: iaResult.interpretacao?.slice(0, 300),
                  ia_escalou_humano: true,
                  ia_processado_em: new Date().toISOString(),
                  status: 'precisa_atencao_humano'
                });
                console.log(`[ia] order ${venda.order_id} 🚨 ESCALADO pra humano: "${iaResult.interpretacao}"`);
              }
              else if (iaResult.msg_pra_cliente) {
                // ENVIA RESPOSTA AUTOMATICA (categorias claro/ambiguo/pergunta_graos)
                const msgIA = iaResult.msg_pra_cliente;

                // Envia via POST direto (conversa nao eh mais virgem)
                const envR = await ml.enviarMensagemDireta({
                  packId: venda.pack_id,
                  orderId: venda.order_id,
                  buyerId: venda.buyer_id,
                  texto: msgIA
                });

                if (envR.ok) {
                  stats.iaProcessadas++;
                  registrarMsgProcessada(venda.order_id, _tsRespAtual);
                  registrarEnvio(venda.order_id);

                  // SESSAO 7: define status conforme categoria + confianca.
                  // IMPORTANTE: com a auto-emissao DESLIGADA, o comportamento eh
                  // IDENTICO ao original (claro -> 'cliente_confirmou_pedido' sempre).
                  // So quando LIGADA o claro com confianca < LIMIAR vai pra humano.
                  const ehClaro = iaResult.categoria === 'claro';
                  const confOk = Number(iaResult.confianca) >= LIMIAR_CONFIANCA_AUTO;
                  let statusInicial;
                  if (ehClaro) {
                    statusInicial = (AUTO_EMITIR_HABILITADO && !confOk)
                      ? 'precisa_atencao_humano'   // so com feature ligada: claro de baixa confianca -> humano
                      : 'cliente_confirmou_pedido'; // original
                  } else {
                    statusInicial = 'aguardando_resposta';
                  }

                  await lcp.atualizarVenda(venda.order_id, {
                    ia_categoria: iaResult.categoria,
                    ia_confianca: iaResult.confianca,
                    ia_interpretacao: iaResult.interpretacao?.slice(0, 300),
                    ia_msg_enviada: msgIA,
                    ia_pedido_estruturado: iaResult.pedido_estruturado ? JSON.stringify(iaResult.pedido_estruturado) : null,
                    ia_processado_em: new Date().toISOString(),
                    // grava a msg do cliente que acabou de ser tratada, pra trava
                    // anti-loop saber que ja respondemos ESTA mensagem
                    ultima_resposta_em: new Date(_tsRespAtual).toISOString(),
                    status: statusInicial
                  });
                  console.log(`[ia] ✅ order ${venda.order_id} respondida auto: ${msgIA.length} chars, msg_id=${envR.message_id}`);

                  // ── SESSAO 7: auto-emissao (claro + confianca OK + habilitado) ──
                  if (ehClaro && confOk && AUTO_EMITIR_HABILITADO) {
                    if (!podeAutoEmitir()) {
                      console.warn(`[auto-emissao] LIMITE DIARIO ${AUTO_MAX_POR_DIA} atingido — order ${venda.order_id} vai pro painel humano`);
                      await lcp.atualizarVenda(venda.order_id, {
                        status: 'precisa_atencao_humano',
                        bling_erro: `auto: limite diario de ${AUTO_MAX_POR_DIA} auto-emissoes atingido`
                      });
                    } else {
                      // BLINDAGEM: sem este try/catch, uma excecao aqui dentro subia pro
                      // catch externo (que so faz console.error) e o pedido ficava PRESO em
                      // 'cliente_confirmou_pedido' (status setado na linha de cima, ANTES da
                      // emissao) — invisivel como falha. Agora qualquer excecao manda pra
                      // 'aguardando_bling': a fila de retry re-tenta sozinha (auto-cura erro
                      // transiente; se persistir, vira humano em 3h com o erro registrado).
                      try {
                        const auto = await processarAutoEmissao({ venda, iaResult, graosResult, lcp });
                        if (auto.emitida) { stats.autoEmitidas++; incrementarAutoEmitida(); }
                        else if (auto.puladaConfianca) stats.autoPuladasConfianca++;
                        else stats.autoFalhas++;
                      } catch (eAuto) {
                        stats.autoFalhas++;
                        console.error(`[auto-emissao] order ${venda.order_id} EXCECAO -> aguardando_bling pra retry: ${eAuto.message}`);
                        try {
                          await lcp.atualizarVenda(venda.order_id, {
                            status: 'aguardando_bling',
                            bling_erro: `auto: excecao na emissao (${String(eAuto.message || eAuto).slice(0,200)}) — re-tentando`
                          });
                        } catch (_) {}
                      }
                    }
                  } else if (ehClaro && AUTO_EMITIR_HABILITADO && !confOk) {
                    console.log(`[auto-emissao] order ${venda.order_id} claro mas confianca ${iaResult.confianca}% < ${LIMIAR_CONFIANCA_AUTO}% — humano (nao emite)`);
                  }
                } else {
                  stats.iaErros++;
                  console.error(`[ia] ❌ order ${venda.order_id} falhou envio: ${envR.status} ${envR.erro?.slice(0,200)}`);
                  await lcp.atualizarVenda(venda.order_id, {
                    ia_categoria: iaResult.categoria,
                    ia_confianca: iaResult.confianca,
                    ia_interpretacao: iaResult.interpretacao?.slice(0, 300),
                    ia_msg_enviada: msgIA + ' [FALHOU ENVIO]',
                    ia_erro_envio: `${envR.status}: ${envR.erro?.slice(0,200)}`,
                    ia_processado_em: new Date().toISOString()
                  });
                }
              }
            } catch (e) {
              stats.iaErros++;
              console.error(`[ia] order ${venda.order_id} excecao: ${e.message}`);
            }
          } else if (!IA_HABILITADO) {
            console.log(`[ia] desabilitado (LIXAS_IA_HABILITADO=false) - pulando processamento IA`);
          }
          // ════════════════════════════════════════════════════════
        } else {
          stats.semNovidade++;
        }
      } catch (e) {
        stats.erros++;
        console.error(`[lixas-combinar lerRespostas] erro order ${venda.order_id}: ${e.message}`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // FASE 2 — FECHAMENTO POS-PROCESSADO
    // Vendas ja 'processado' (NF emitida) onde o cliente mandou msg DEPOIS
    // da nossa ultima (ex: respondeu "Sim" a uma confirmacao antiga):
    //   - afirmacao simples ("sim","ok","obrigado"...) -> responde UMA vez
    //     com FECHAMENTO_TEXTO e encerra (nunca repete o fechamento)
    //   - qualquer outra coisa -> painel (humano), pois com NF emitida
    //     mudanca de pedido precisa de gente
    // ════════════════════════════════════════════════════════════════
    if (FECHAMENTO_HABILITADO) {
      try {
        const lcp = require('./lixasCombinarPendentes');
        const listaP = await lcp.listarPendentes({ dias: FECHAMENTO_DIAS, status: 'processado', limit: 50 });
        const processadas = (listaP.ok && Array.isArray(listaP.data)) ? listaP.data : [];
        if (processadas.length > 0) {
          const sellerIdF = String(require('./mlTokenManager').getUserId() || '');
          for (const venda of processadas) {
            try {
              if (emCooldownEnvio(venda.order_id)) continue; // espera ML refletir envio recente
              const conv = await ml.consultarConversa({ packId: venda.pack_id, orderId: venda.order_id, markAsRead: true });
              if (!conv.ok) continue;
              const msgs = Array.isArray(conv.messages) ? conv.messages : [];
              const ehLoja = (m) => String(m.from_user_id || m.from?.user_id || '') === sellerIdF;
              const tsF = (m) => _tsMensagemML(m);
              const cliMsgs = msgs.filter(m => !ehLoja(m)).sort((a, b) => tsF(b) - tsF(a));
              const ultCli = cliMsgs[0];
              const ultLojaTs = msgs.filter(ehLoja).reduce((mx, m) => Math.max(mx, tsF(m)), 0);
              // So age se a ULTIMA palavra eh do cliente (mandou depois da loja)
              if (!ultCli || tsF(ultCli) <= ultLojaTs) continue;

              const textoCli = ultCli.text || ultCli.message || '';
              const jaFechou = msgs.some(m => ehLoja(m) && String(m.text || '').startsWith(FECHAMENTO_TEXTO.slice(0, 40)));

              if (ehAfirmacaoSimples(textoCli)) {
                if (jaFechou) continue; // fechamento ja foi enviado uma vez — silencio
                const r = await ml.enviarMensagemDireta({
                  packId: venda.pack_id, orderId: venda.order_id, buyerId: venda.buyer_id, texto: FECHAMENTO_TEXTO
                });
                if (r.ok) {
                  stats.fechamentosEnviados++;
                  registrarEnvio(venda.order_id);
                  console.log(`[lixas-combinar fechamento] ✅ Order ${venda.order_id} cliente confirmou ("${textoCli.slice(0, 30)}") — fechamento enviado`);
                } else {
                  console.error(`[lixas-combinar fechamento] order ${venda.order_id} falhou envio: ${r.status} ${r.erro?.slice(0, 150)}`);
                }
              } else {
                // Msg real pos-NF -> humano (com a msg gravada pro painel)
                stats.posProcessadoEscalados++;
                try {
                  await lcp.marcarRespostaCliente(venda.order_id, {
                    texto: textoCli,
                    dataResposta: (() => { const t = _tsMensagemML(ultCli); return t ? new Date(t).toISOString() : new Date().toISOString(); })(),
                    totalMsgsCliente: conv.totalCliente || 0
                  });
                } catch (e2) { /* nao bloqueia a escalada */ }
                await lcp.atualizarVenda(venda.order_id, { status: 'precisa_atencao_humano' });
                console.log(`[lixas-combinar fechamento] 🚨 Order ${venda.order_id} msg POS-NF escalada pro painel: "${textoCli.slice(0, 60)}"`);
              }
            } catch (e) {
              console.error(`[lixas-combinar fechamento] erro order ${venda.order_id}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        console.error('[lixas-combinar fechamento] erro fase 2:', e.message);
      }
    }

    const dur = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`[lixas-combinar lerRespostas] ✓ Fim em ${dur}s — ${JSON.stringify(stats)}`);
    return { ok: true, stats, duracao_s: Number(dur) };
  } catch (e) {
    console.error('[lixas-combinar lerRespostas] ❌ erro fatal:', e.message);
    return { ok: false, erro: e.message, stats };
  } finally {
    _lendoRespostas = false;
  }
}

/**
 * SESSAO 7: processarAutoEmissao
 *
 * Chamada APENAS quando a IA classificou 'claro' com confianca >= LIMIAR e a
 * feature esta habilitada. Faz, na ordem (parando no primeiro problema):
 *
 *   Guarda 1  confianca (defesa extra)
 *   Guarda 2  pedido_estruturado valido
 *   Guarda 3  soma das quantidades == total que a IA usou (lixas_por_kit)
 *   Guarda 4  cada grao existe nos disponiveis E tem estoque suficiente
 *   Guarda 5  CARRINHO: se o pedido tem +1 item, ou ha +1 pedido no mesmo
 *             pack -> humano (a edicao automatica so trata 1 item A-COMBINAR)
 *   Edita pedido no Bling (mesma funcao do botao "Editar Bling") — o rateio
 *             fiscal entra aqui: sobra de centavo vai pro DESCONTO/OUTRAS
 *             DESPESAS do pedido, total sempre bate exato.
 *   Emite NF (mesma funcao do botao laranja "Emitir NF")
 *   Marca 'processado'
 *
 * Qualquer falha grava bling_erro/nf_erro e poe a venda em 'precisa_atencao_humano'
 * (o painel mostra o erro + os botoes manuais pra voce terminar na mao).
 *
 * Reusa blingPedidos.editarPedidoComGraos + gerarNFe (NAO reescreve a logica).
 *
 * @returns {object} { emitida? , puladaConfianca? , falha? , motivo? }
 */
// Wrapper: gerencia a fila de retry do Bling em volta da emissao.
// Se o desfecho NAO for "segura pra retry", limpa a entrada da fila.
async function processarAutoEmissao(args) {
  const orderIdW = String(args.venda.order_id);
  const r = await _processarAutoEmissaoInner(args);
  if (!r || !r.retry) _retryBling.delete(orderIdW);
  return r;
}

async function _processarAutoEmissaoInner({ venda, iaResult, graosResult, lcp }) {
  const orderId = venda.order_id;
  const bp = require('../lixas-combinar/blingPedidos');

  // Guarda 1 — confianca (defesa em profundidade; o chamador ja filtra)
  if (Number(iaResult.confianca) < LIMIAR_CONFIANCA_AUTO) {
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano' });
    console.log(`[auto-emissao] order ${orderId} confianca ${iaResult.confianca}% < ${LIMIAR_CONFIANCA_AUTO}% — humano`);
    return { puladaConfianca: true };
  }

  // Guarda 2 — pedido_estruturado valido
  const graosEscolhidos = Array.isArray(iaResult.pedido_estruturado) ? iaResult.pedido_estruturado : null;
  if (!graosEscolhidos || graosEscolhidos.length === 0) {
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: 'auto: pedido_estruturado vazio/invalido' });
    console.warn(`[auto-emissao] order ${orderId} pedido_estruturado invalido — humano`);
    return { falha: true, motivo: 'pedido_estruturado_invalido' };
  }

  // Guarda 3 — soma confere o total REAL (lixas_por_kit x quantidade comprada).
  // CRITICO: 1 unidade do anuncio A-COMBINAR = lixas_por_kit lixas. Se o cliente
  // comprou 2+ unidades (2 kits = 200 lixas) e nao multiplicarmos, a guarda passaria
  // achando que sao 100 e emitiria NF errada. Le a quantity do ML pelo MESMO helper
  // que a montarMensagemInteligente usa (extrairSkuACombinar -> { quantidade }).
  let qtdKits = 1;
  try {
    const detalhe = await ml.getOrderDetalhe(venda.order_id);
    const info = ml.extrairSkuACombinar(detalhe);
    if (info && Number(info.quantidade) > 0) qtdKits = Number(info.quantidade);
  } catch (e) {
    console.warn(`[auto-emissao] order ${orderId} nao li a quantidade do ML — assumindo 1 kit: ${e.message}`);
  }
  const totalLixas = Number(graosResult.lixas_por_kit) * qtdKits;
  if (qtdKits !== 1) console.log(`[auto-emissao] order ${orderId} qtd_kits=${qtdKits} -> total_lixas=${totalLixas}`);

  const somaPedido = graosEscolhidos.reduce((s, g) => s + Number(g.quantidade || 0), 0);
  if (somaPedido !== totalLixas) {
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: soma ${somaPedido} != total ${totalLixas} (qtd_kits=${qtdKits})` });
    console.warn(`[auto-emissao] order ${orderId} soma ${somaPedido} != total ${totalLixas} (kits=${qtdKits}) — humano`);
    return { falha: true, motivo: 'soma_diverge' };
  }

  // Guarda 4 — cada grao existe nos disponiveis e tem estoque suficiente
  for (const g of graosEscolhidos) {
    const disp = graosResult.graos.find(x => String(x.grao) === String(g.grao));
    if (!disp) {
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: grao ${g.grao} indisponivel no Bling` });
      console.warn(`[auto-emissao] order ${orderId} grao ${g.grao} indisponivel — humano`);
      return { falha: true, motivo: 'grao_indisponivel' };
    }
    if (Number(disp.estoque_lixas) < Number(g.quantidade)) {
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: estoque insuficiente grao ${g.grao} (tem ${disp.estoque_lixas}, pediu ${g.quantidade})` });
      console.warn(`[auto-emissao] order ${orderId} estoque insuficiente grao ${g.grao} — humano`);
      return { falha: true, motivo: 'estoque_insuficiente' };
    }
  }

  // Args comuns pro blingPedidos (mesma logica da rota /editar-bling:
  // Bling guarda pack_id em numeroLoja, entao usa pack_id se existir)
  const idBuscaBling = venda.pack_id || orderId;
  const dataVenda = venda.data_venda ? String(venda.data_venda).split('T')[0] : null;
  const baseArgs = {
    orderId: idBuscaBling,
    graosEscolhidos,
    graosDisponiveis: graosResult.graos,
    unidadesPorPacote: graosResult.unidades_por_pacote,
    descricaoBase: graosResult.descricao,
    dataVenda,
    skuACombinar: venda.sku_a_combinar || null
  };

  // ── Guarda 5 — CARRINHO / pedido multi-item ──────────────────────────
  // A edicao automatica SUBSTITUI todos os itens do pedido pelos graos de UM
  // sku. Isso so eh seguro quando o pedido tem exatamente 1 item A-COMBINAR.
  // Num carrinho (2+ anuncios A-COMBINAR), o Bling pode montar:
  //   (a) 1 pedido com varios itens   -> pega via itens.length != 1
  //   (b) varios pedidos no mesmo pack -> pega via "duplicidade" do buscar
  // Em qualquer dos casos -> manda pro humano (NAO emite NF errada).
  // Pre-check leve antes de escrever nada; mesma janela de data do editar.
  try {
    let dIni, dFim;
    if (dataVenda) {
      const d = new Date(dataVenda);
      const ini = new Date(d); ini.setDate(ini.getDate() - 2);
      const fim = new Date(d); fim.setDate(fim.getDate() + 2);
      dIni = ini.toISOString().split('T')[0];
      dFim = fim.toISOString().split('T')[0];
    }
    const busca = await bp.buscarPedidoPorOrderId(idBuscaBling, dIni, dFim);
    if (!busca.ok) {
      // Pode ser corrida: Bling ainda nao importou o pedido do ML. Agenda retry
      // (nos proximos ciclos) em vez de escalar na hora. Reusa a MESMA classificacao.
      return await _agendarOuEscalarRetry({ orderId, venda, iaResult, graosResult, lcp, erro: busca.erro });
    }
    if (busca.aviso) {
      // duplicidade = mais de um pedido com o mesmo numeroLoja (carrinho)
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: carrinho detectado (${busca.aviso}) — varios pedidos no mesmo pack, tratar manual` });
      console.warn(`[auto-emissao] order ${orderId} CARRINHO (duplicidade de pedido) — humano`);
      return { falha: true, motivo: 'carrinho_multi_pedido' };
    }
    const det = await bp.obterPedidoCompleto(busca.pedidoId);
    const itensPed = (det.ok && Array.isArray(det.pedido?.itens)) ? det.pedido.itens : null;
    if (!itensPed || itensPed.length === 0) {
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: 'auto: nao consegui ler os itens do pedido no Bling — tratar manual' });
      console.warn(`[auto-emissao] order ${orderId} sem itens legiveis — humano`);
      return { falha: true, motivo: 'itens_ilegiveis' };
    }
    if (itensPed.length > 1) {
      // CARRINHO com 1 linha A COMBINAR: o editarPedidoComGraos sabe tratar
      // (preserva os outros itens, rateia so a linha A COMBINAR e valida o
      // total no final). So escala pra humano se 0 ou 2+ linhas A COMBINAR.
      const rx = /A-?\s?COMBINAR/i;
      const alvos = itensPed.filter(it =>
        (venda.sku_a_combinar && String(it.codigo || '').trim() === String(venda.sku_a_combinar).trim())
        || rx.test(String(it.codigo || ''))
        || rx.test(String(it.descricao || ''))
      );
      if (alvos.length !== 1) {
        await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: carrinho com ${alvos.length} linha(s) A COMBINAR (esperado 1) — tratar manual` });
        console.warn(`[auto-emissao] order ${orderId} carrinho com ${alvos.length} linhas A COMBINAR — humano`);
        return { falha: true, motivo: 'carrinho_ambiguo' };
      }
      console.log(`[auto-emissao] order ${orderId} CARRINHO com 1 linha A COMBINAR (${itensPed.length} itens) — seguindo com edicao preservadora`);
    }
  } catch (e) {
    // Se o pre-check falhar por erro inesperado, NAO arrisca: manda pro humano.
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: erro no pre-check de carrinho: ${e.message}`.slice(0, 500) });
    console.error(`[auto-emissao] order ${orderId} erro pre-check carrinho: ${e.message} — humano`);
    return { falha: true, motivo: 'precheck_erro' };
  }

  // Edita o pedido no Bling. O rateio fiscal eh calculado dentro de
  // editarPedidoComGraos -> calcularRateio, e a sobra de centavos (se houver)
  // entra no campo DESCONTO ou OUTRAS DESPESAS do pedido, de modo que o TOTAL
  // sempre bate exato. Nao ha desvio pra humano por causa de centavo.
  const edit = await bp.editarPedidoComGraos({ ...baseArgs, dryRun: false });
  if (!edit.ok) {
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto edit ${edit.etapa || ''}: ${edit.erro || ''}`.slice(0, 500) });
    console.error(`[auto-emissao] order ${orderId} edit falhou (${edit.etapa}): ${edit.erro}`);
    return { falha: true, motivo: 'edit_falhou' };
  }
  if (edit.rateio?.ajuste) {
    const aj = edit.rateio.ajuste;
    console.log(`[auto-emissao] order ${orderId} rateio com ${aj.tipo} de R$${aj.valor} no rodape (total bate exato)`);
  }
  await lcp.atualizarVenda(orderId, {
    bling_pedido_id: String(edit.pedidoId),
    bling_editado_em: new Date().toISOString(),
    bling_erro: null
  });

  // Emite a NF (NF transmitida pra SEFAZ — irreversivel)
  const nf = await bp.gerarNFe(edit.pedidoId);
  if (!nf.ok) {
    // Pedido ja foi editado: deixa o bling_pedido_id salvo pro painel mostrar
    // o botao laranja e voce emitir na mao.
    await lcp.atualizarVenda(orderId, {
      status: 'precisa_atencao_humano',
      nf_erro: `${nf.status || ''}: ${nf.erro || JSON.stringify(nf.detalhe || {}).slice(0, 200)}`.slice(0, 500)
    });
    console.error(`[auto-emissao] order ${orderId} pedido ${edit.pedidoId} editado mas NF falhou: ${nf.status} ${nf.erro}`);
    return { falha: true, motivo: 'nf_falhou', pedidoId: edit.pedidoId };
  }

  // Sucesso total
  await lcp.atualizarVenda(orderId, {
    nf_emitida_em: new Date().toISOString(),
    nf_id: nf.nfeId,
    nf_numero: nf.numero,
    nf_serie: nf.serie,
    nf_chave: nf.chave || null,
    nf_erro: null,
    status: 'processado'
  });
  console.log(`[auto-emissao] ✅ order ${orderId} → pedido ${edit.pedidoId} editado + NF ${nf.numero}/${nf.serie} emitida (auto)`);
  return { emitida: true, pedidoId: edit.pedidoId, nfNumero: nf.numero };
}

/**
 * Força processamento de UMA venda específica (ignora janela de tempo)
 * Aceita TANTO order_id quanto pack_id (o que aparece na URL do ML).
 * Se for pack_id (carrinho), busca o order real automaticamente.
 */
async function forcarOrder(idEntrada) {
  const stats = { idEntrada, etapa: 'inicio' };
  try {
    if (!TEXTO) {
      return { ok: false, erro: 'AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR vazio', stats };
    }
    if (!tracker.configurado()) {
      return { ok: false, erro: 'Supabase nao configurado', stats };
    }

    // 0. Detectar se é pack_id ou order_id
    // Tenta como order primeiro (rota normal). Se 404, tenta como pack pra extrair order_id.
    stats.etapa = 'detectar_tipo';
    let orderId = idEntrada;
    let detalhe = null;
    let packIdDescoberto = null;

    try {
      detalhe = await ml.getOrderDetalhe(idEntrada);
      stats.tipo_id = 'order';
    } catch (e) {
      // Se der 404, tenta como pack
      if (e.message.includes('404') || e.message.includes('order_not_found')) {
        stats.tipo_id = 'pack_tentativa';
        const packInfo = await ml.getPackInfo(idEntrada);
        if (packInfo?.orders?.length > 0) {
          // CARRINHO: um pack pode ter VARIOS orders (um por anuncio).
          // Varre TODOS e escolhe o que tem A COMBINAR (antes pegava o
          // primeiro as cegas — podia cair no order do outro produto).
          packIdDescoberto = idEntrada;
          stats.tipo_id = 'pack';
          stats.orders_no_pack = packInfo.orders.length;
          let achou = null;
          for (const o of packInfo.orders) {
            const det = await ml.getOrderDetalhe(String(o.id));
            if (ml.temVariacaoACombinar(det)) { achou = { id: String(o.id), det }; break; }
            if (!achou) achou = null;
          }
          if (achou) {
            orderId = achou.id;
            detalhe = achou.det;
          } else {
            // nenhum order do pack tem A COMBINAR — usa o primeiro (vai falhar
            // na checagem adiante com o erro correto)
            orderId = String(packInfo.orders[0].id);
            detalhe = await ml.getOrderDetalhe(orderId);
          }
          stats.order_id_real = orderId;
          stats.pack_id_real = packIdDescoberto;
        } else {
          return { ok: false, erro: `Pack ${idEntrada} sem orders dentro`, stats };
        }
      } else {
        return { ok: false, erro: e.message, stats };
      }
    }

    // 1. Já enviou?
    stats.etapa = 'checar_duplicado';
    if (await tracker.jaEnviou(orderId)) {
      return { ok: false, erro: `Ja enviou pra esta venda (order ${orderId}) anteriormente`, stats };
    }

    stats.status_venda = detalhe.status;
    stats.buyer_id = detalhe.buyer?.id;
    stats.pack_id = detalhe.pack_id || packIdDescoberto;

    // 2. Tem A COMBINAR?
    stats.etapa = 'verificar_a_combinar';
    const temACombinar = ml.temVariacaoACombinar(detalhe);
    stats.tem_a_combinar = temACombinar;
    if (!temACombinar) {
      return { ok: false, erro: 'Venda NAO tem variacao A COMBINAR', stats };
    }

    // 3. Envia
    stats.etapa = 'enviar';
    const buyerId = detalhe.buyer?.id;
    const packId = detalhe.pack_id || packIdDescoberto;
    const textoFinal = await montarMensagemInteligente(detalhe);
    stats.texto_chars = textoFinal.length;

    // 3.5. NOVO: consulta conversa pra decidir endpoint (igual rotinaACombinar)
    //      - virgem  → action_guide OTHER (1 uso, gasta o cap)
    //      - tem msg → POST direto (preserva cap, permite mensagens livres)
    const conv = await ml.consultarConversa({ packId, orderId });
    let r;
    let viaEndpoint;
    let respostasCliente = null;

    if (conv.ok && !conv.conversaVirgem && conv.totalCliente > 0) {
      viaEndpoint = 'direto';
      respostasCliente = conv.ultimaCliente;
      console.log(`[auto-mensagens FORCAR] 💬 order=${orderId} ja tem ${conv.totalCliente} msg(s) cliente — DIRETO (chars=${textoFinal.length})`);
      r = await ml.enviarMensagemDireta({ packId, orderId, buyerId, texto: textoFinal });
    } else if (conv.ok && !conv.conversaVirgem && conv.totalLoja > 0) {
      // Loja ja mandou msg mas cliente nao respondeu - tenta direto tambem
      // (cap do OTHER provavelmente esgotado, e nao adianta repetir action_guide)
      viaEndpoint = 'direto_sem_resposta';
      console.log(`[auto-mensagens FORCAR] 📨 order=${orderId} loja ja enviou mas cliente nao respondeu — tentando DIRETO (chars=${textoFinal.length})`);
      r = await ml.enviarMensagemDireta({ packId, orderId, buyerId, texto: textoFinal });
    } else {
      // Conversa virgem (ou erro consultando) - usa action_guide
      viaEndpoint = 'action_guide';
      console.log(`[auto-mensagens FORCAR] 📨 order=${orderId} virgem — ACTION_GUIDE OTHER (chars=${textoFinal.length})`);
      r = await ml.enviarMensagem({ packId, orderId, buyerId, texto: textoFinal });
    }
    stats.via_endpoint = viaEndpoint;
    stats.etapa = 'gravar';

    if (r.ok) {
      const modStatus = r.moderation_status || 'unknown';
      const foiModerado = ['IN_MODERATION', 'rejected', 'REJECTED'].includes(modStatus);
      await tracker.registrar({
        orderId, packId, buyerId,
        tipo: 'a_combinar', textoEnviado: textoFinal,
        messageIdMl: r.message_id, status: foiModerado ? 'moderado' : 'enviado',
        erroDetalhe: foiModerado ? `moderation=${modStatus}` : (viaEndpoint !== 'action_guide' ? `via_${viaEndpoint}` : null),
        loja: 'GIRASSOL'
      });

      // Popula tabela lixas_combinar_pendentes (mesmo padrao da rotinaACombinar)
      try {
        const sku = ml.extrairSkuACombinar(detalhe);
        const lcp = require('./lixasCombinarPendentes');
        if (lcp.configurado()) {
          await lcp.upsertPendente({
            orderId, packId, buyerId,
            buyerNome: detalhe.buyer?.nickname || `${detalhe.buyer?.first_name || ''} ${detalhe.buyer?.last_name || ''}`.trim(),
            skuACombinar: sku?.sku || null,
            descricaoProduto: sku?.titulo || null,
            quantidadeLixas: null,
            dataVenda: detalhe.date_created || new Date().toISOString(),
            msgInicialEnviada: textoFinal,
            msgInicialEnviadaEm: new Date().toISOString(),
            clienteRespondeu: !!respostasCliente,
            ultimaRespostaCliente: respostasCliente?.text || null,
            ultimaRespostaEm: respostasCliente?.date_created || null,
            totalMsgsCliente: conv.totalCliente || 0,
            status: respostasCliente ? 'cliente_respondeu' : 'aguardando_resposta',
            viaEndpoint
          });
        }
      } catch (e) {
        console.error(`[auto-mensagens FORCAR] erro upsert pendente: ${e.message}`);
      }

      stats.message_id = r.message_id;
      stats.moderation = modStatus;
      console.log(`[auto-mensagens FORCAR] ✅ order=${orderId} status=${foiModerado ? 'moderado' : 'enviado'} via=${viaEndpoint}`);
      return { ok: true, enviado: !foiModerado, moderado: foiModerado, stats };
    } else {
      await tracker.registrar({
        orderId, packId, buyerId,
        tipo: 'a_combinar', textoEnviado: textoFinal,
        messageIdMl: null, status: 'erro', erroDetalhe: `${viaEndpoint} ${r.status}: ${r.erro}`.slice(0, 500),
        loja: 'GIRASSOL'
      });
      stats.ml_erro = r.erro;
      stats.ml_status = r.status;
      return { ok: false, erro: `ML retornou ${r.status} via ${viaEndpoint}: ${r.erro}`, stats };
    }
  } catch (e) {
    return { ok: false, erro: e.message, stats };
  }
}

/**
 * ════════════════════════════════════════════════════════════════════════
 * ESCADA — auto-substituicao de grao indisponivel com TRAVA DE PRAZO.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Problema: pedido A-COMBINAR cujo cliente escolheu um grao SEM estoque/inexistente
 * trava em precisa_atencao_humano (bling_erro "grao X indisponivel") e fica parado.
 * Se ninguem resolver, atrasa a postagem -> PENALIDADE no Mercado Livre.
 *
 * Esta rotina, a cada ciclo:
 *   1. Pega os pedidos travados nesse erro (precisa_atencao_humano/aguardando_resposta).
 *   2. Calcula o PRAZO-LIMITE DE POSTAGEM real do ML (prazoPostagem.calcular* sobre o
 *      shipment) e dele o CORTE DE COLETA: a ultima coleta (seg-sab, horario SP) que
 *      ainda cumpre o prazo, menos a folga de preparo. E quando a troca tem que sair.
 *   3. Enquanto NAO chegou no corte: vai AVISANDO a cliente (escada escalonada de ate
 *      MAX_AVISOS), espalhados pela janela ate o corte. Da a chance dela escolher.
 *   4. Ao chegar no corte (e sem resposta valida): TROCA o grao indisponivel pelo mais
 *      proximo COM estoque, MONTA + EMITE a NF (idempotente no code-74) e AVISA da troca.
 *      Nunca perde a coleta -> sem atraso -> sem penalidade.
 *
 * Coleta (SP): seg-sex CORTE_SEMANA_HORA (12h), sab CORTE_SABADO_HORA (9h), dom sem coleta.
 * Seguranca: so age no erro de indisponivel; preserva cupom/desconto (logica do
 * editarPedidoComGraos); se nao consegue resolver, deixa em atencao humana com nota.
 * dryRun=true => calcula e diz o que FARIA, sem montar/emitir/avisar nada.
 *
 * @param {Object} opts { dryRun?:boolean, margemHoras?:number, dias?:number }
 */
async function rotinaEscadaIndisponivel(opts = {}) {
  const dryRun = !!opts.dryRun;
  // CORTE = a hora da COLETA do dia (não "X h antes do prazo do ML"). A escada acha a
  // última coleta que ainda cumpre o prazo do ML e faz a troca+NF um pouco antes dela
  // (folga de preparo). Os avisos à cliente se espalham até esse corte. Coletas em SP:
  // seg–sex no CORTE_SEMANA_HORA, sáb no CORTE_SABADO_HORA, domingo sem coleta.
  const CORTE_SEMANA_HORA = Number(process.env.LIXAS_ESCADA_CORTE_SEMANA_HORA) || 12;  // seg–sex (meio-dia)
  const CORTE_SABADO_HORA = Number(process.env.LIXAS_ESCADA_CORTE_SABADO_HORA) || 9;   // sábado (9h)
  const COLETA_LEAD_MIN   = Number(process.env.LIXAS_ESCADA_COLETA_LEAD_MIN) || 60;    // folga de preparo antes da coleta (min)
  const TZ_OFFSET_H       = Number(process.env.LIXAS_ESCADA_TZ_OFFSET ?? -3);          // fuso SP
  const MARGEM_EXTRA_H    = Number(process.env.LIXAS_ESCADA_MARGEM_EXTRA_HORAS) || 0;  // colchão extra antes do corte (opcional)
  const MAX_AVISOS        = Number(process.env.LIXAS_ESCADA_MAX_AVISOS) || 3;
  const INTERVALO_MAX     = Number(process.env.LIXAS_ESCADA_AVISO_INTERVALO_HORAS) || 24;     // teto entre avisos (prazo longo)
  const INTERVALO_MIN     = Number(process.env.LIXAS_ESCADA_AVISO_INTERVALO_MIN_HORAS) || 1;  // piso entre avisos (prazo curto)
  const DIAS              = Number(opts.dias ?? process.env.LIXAS_ESCADA_DIAS) || 30;
  // ?margem=H (debug): troca quando faltam <= H horas pro corte (preview). Sem isso, usa MARGEM_EXTRA_H.
  const limiarCorteH = (opts.margemHoras != null && Number(opts.margemHoras) > 0) ? Number(opts.margemHoras) : MARGEM_EXTRA_H;
  const corteCfg = { corteSemanaHora: CORTE_SEMANA_HORA, corteSabadoHora: CORTE_SABADO_HORA, leadMin: COLETA_LEAD_MIN, tzOffsetH: TZ_OFFSET_H };

  const stats = { dryRun, corte_semana_hora: CORTE_SEMANA_HORA, corte_sabado_hora: CORTE_SABADO_HORA, limiar_corte_h: limiarCorteH, verificados: 0, avisados: 0, aguardando_prazo: 0, substituidos: 0, erros: 0, pulados: 0, lista: [] };
  if (!tracker.configurado()) { stats.desligada = 'supabase_nao_configurado'; return stats; }

  const ESCADA_HABILITADA = (process.env.LIXAS_ESCADA_HABILITADO || 'true').toLowerCase() === 'true';
  if (!ESCADA_HABILITADA) { stats.desligada = 'LIXAS_ESCADA_HABILITADO=false'; return stats; }
  // a escada EMITE NF -> respeita o mesmo portao da auto-emissao
  if (!AUTO_EMITIR_HABILITADO) { stats.desligada = 'AUTO_EMITIR_HABILITADO=false'; return stats; }

  const lcp = require('./lixasCombinarPendentes');
  const lixasService = require('../lixas-combinar/lixasService');
  const bp = require('../lixas-combinar/blingPedidos');
  const sub = require('../lixas-combinar/substituicao');
  const prazoMod = require('./prazoPostagem');

  // candidatos: travados no erro de INDISPONIVEL, ainda sem NF.
  // Busca em DOIS status: precisa_atencao_humano (acabou de travar, ainda nao avisado)
  // E aguardando_resposta (a escada ja avisou -> esperando a cliente escolher; o
  // lerRespostas trata a resposta dela, a escada so reforca o aviso e trava no prazo).
  const [listaHumano, listaAguard] = await Promise.all([
    lcp.listarPendentes({ dias: DIAS, status: 'precisa_atencao_humano', limit: 100 }),
    lcp.listarPendentes({ dias: DIAS, status: 'aguardando_resposta', limit: 100 })
  ]);
  const _vistos = new Set();
  const candidatos = [];
  for (const v of [
    ...(listaHumano.ok && Array.isArray(listaHumano.data) ? listaHumano.data : []),
    ...(listaAguard.ok && Array.isArray(listaAguard.data) ? listaAguard.data : [])
  ]) {
    if (!/indispon/i.test(String(v.bling_erro || '')) || v.nf_emitida_em) continue;
    const k = String(v.order_id);
    if (_vistos.has(k)) continue;
    _vistos.add(k);
    candidatos.push(v);
  }

  for (const v of candidatos) {
    const orderId = v.order_id;
    stats.verificados++;
    try {
      // 1. pedido estruturado (contem o grao indisponivel)
      let pedidoEstruturado = null;
      try { pedidoEstruturado = JSON.parse(v.ia_pedido_estruturado || 'null'); } catch (_) {}
      if (!Array.isArray(pedidoEstruturado) || pedidoEstruturado.length === 0) {
        stats.pulados++; stats.lista.push({ order_id: orderId, acao: 'pulado', motivo: 'sem_pedido_estruturado' }); continue;
      }

      // 2. graos disponiveis no Bling
      const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(v.sku_a_combinar);
      if (!graosResult.ok || !Array.isArray(graosResult.graos) || graosResult.graos.length === 0) {
        stats.pulados++; stats.lista.push({ order_id: orderId, acao: 'pulado', motivo: 'sem_graos_bling' }); continue;
      }

      // 3. PRAZO de postagem real (via shipment do ML)
      let prazo = null;
      try {
        const info = await ml.getPrazoPostagem(orderId);
        prazo = prazoMod.calcularPrazoPostagem(info && info.shipment_bruto ? info.shipment_bruto : {});
      } catch (e) {
        stats.pulados++; stats.lista.push({ order_id: orderId, acao: 'pulado', motivo: 'sem_prazo: ' + e.message }); continue;
      }
      if (!prazo || !prazo.ok || !prazo.prazo_postagem) {
        stats.pulados++; stats.lista.push({ order_id: orderId, acao: 'pulado', motivo: 'prazo_indeterminado' }); continue;
      }
      const horas = (new Date(prazo.prazo_postagem).getTime() - Date.now()) / 3600e3;

      // CORTE de coleta deste pedido: a última coleta (seg–sáb) que ainda cumpre o
      // prazo do ML, menos a folga de preparo. É QUANDO a troca+NF tem que estar pronta.
      const corte = prazoMod.calcularCorteColeta(prazo.prazo_postagem, corteCfg);
      if (!corte.ok) {
        stats.pulados++;
        stats.lista.push({ order_id: orderId, acao: 'pulado', motivo: 'corte_indeterminado: ' + (corte.motivo || ''), prazo_ml: prazo.prazo_postagem });
        continue;
      }
      const corteMs = new Date(corte.corte_iso).getTime();
      const horasAteCorte = (corteMs - Date.now()) / 3600e3;   // tempo até ter que trocar (negativo = já passou)
      // janela pra espalhar os avisos: da venda até o corte de coleta
      let janelaH = v.data_venda ? (corteMs - new Date(v.data_venda).getTime()) / 3600e3 : horasAteCorte;
      if (!Number.isFinite(janelaH) || janelaH <= 0) janelaH = Math.max(horasAteCorte, 1);
      const INTERVALO = Math.min(INTERVALO_MAX, Math.max(INTERVALO_MIN, janelaH / MAX_AVISOS));
      const _reg = { corte: corte.corte_iso, coleta: corte.coleta_iso, dia_coleta: corte.dia_coleta, faltam_corte_h: Math.round(horasAteCorte * 10) / 10, intervalo_h: Math.round(INTERVALO * 10) / 10 };

      // 4. ainda NÃO chegou no corte de coleta -> REENGAJA a cliente (escada de avisos)
      //    antes de trocar. Dá a chance dela escolher; só troca sozinha no corte.
      if (horasAteCorte > limiarCorteH) {
        // sem as colunas de controle (escada_avisado_em/escada_avisos) NAO avisa — sem
        // dedup viraria spam. Degrada pro v1 (so trava no prazo) e sinaliza pro Diego.
        const temColunasEscada = (v.escada_avisos !== undefined) || (v.escada_avisado_em !== undefined);
        if (!temColunasEscada) {
          stats.faltam_colunas_escada = true;
          stats.aguardando_prazo++;
          stats.lista.push({ order_id: orderId, acao: 'aguardando', motivo: 'colunas_escada_ausentes_so_trava', horas_ate_prazo: Math.round(horas * 10) / 10 });
          continue;
        }

        const avisos = Number(v.escada_avisos) || 0;
        // respeita TANTO o ultimo aviso da escada QUANTO o ultimo da IA (lerRespostas),
        // pra nunca mandar duas mensagens "escolha um grao" coladas.
        const ultimoAvisoTs = Math.max(
          v.escada_avisado_em ? new Date(v.escada_avisado_em).getTime() : 0,
          v.ia_processado_em  ? new Date(v.ia_processado_em).getTime()  : 0
        );
        const horasDesdeAviso = ultimoAvisoTs ? (Date.now() - ultimoAvisoTs) / 3600e3 : Infinity;
        const podeAvisar = avisos < MAX_AVISOS && horasDesdeAviso >= INTERVALO;

        if (!podeAvisar) {
          stats.aguardando_prazo++;
          stats.lista.push({ order_id: orderId, acao: 'aguardando', avisos, horas_ate_prazo: Math.round(horas * 10) / 10, ..._reg, prazo: prazo.prazo_postagem });
          continue;
        }

        // monta o aviso escalonado (nivel = avisos+1) com graos indisponiveis + sugestoes
        const indispo = sub.graosIndisponiveisDoPedido(pedidoEstruturado, graosResult.graos)
          .map(x => ({ grao: x.grao, sugestoes: sub.sugerirGraosProximos(x.grao, graosResult.graos, 2) }));
        const nivel = avisos + 1;
        const msg = sub.montarMsgReengajamento(indispo, nivel);
        if (!msg) {  // estoque do grao voltou -> nada a avisar; deixa o prazo decidir
          stats.aguardando_prazo++;
          stats.lista.push({ order_id: orderId, acao: 'aguardando', motivo: 'sem_grao_indisponivel_agora', horas_ate_prazo: Math.round(horas * 10) / 10 });
          continue;
        }

        if (dryRun) {
          stats.avisados++;
          stats.lista.push({ order_id: orderId, acao: 'avisaria', nivel, horas_ate_prazo: Math.round(horas * 10) / 10, ..._reg, indisponiveis: indispo, msg });
          continue;
        }

        // envia o aviso pra cliente
        let buyerId = null;
        try { const od = await ml.getOrderDetalhe(orderId); buyerId = od && od.buyer ? od.buyer.id : null; } catch (_) {}
        let r = buyerId ? await ml.enviarMensagemDireta({ packId: v.pack_id, orderId, buyerId, texto: msg }) : { ok: false };
        if (!r || !r.ok) r = await ml.enviarMensagem({ packId: v.pack_id, orderId, buyerId, texto: msg });

        if (!r || !r.ok) {
          stats.erros++;
          stats.lista.push({ order_id: orderId, acao: 'erro', motivo: 'falha_envio_aviso' });
          continue;
        }

        // aviso OK -> passa pra aguardando_resposta (lerRespostas trata a escolha da cliente)
        // e registra o aviso. Defensivo: se escada_* falhar na escrita, grava so o status.
        let upd = await lcp.atualizarVenda(orderId, {
          status: 'aguardando_resposta',
          escada_avisado_em: new Date().toISOString(),
          escada_avisos: avisos + 1
        });
        if (!upd || !upd.ok) {
          console.warn(`[escada] order ${orderId} aviso enviado mas nao gravei escada_* (colunas?). Gravando so status.`);
          await lcp.atualizarVenda(orderId, { status: 'aguardando_resposta' });
        }
        stats.avisados++;
        stats.lista.push({ order_id: orderId, acao: 'avisado', nivel, horas_ate_prazo: Math.round(horas * 10) / 10 });
        console.log(`[escada] order ${orderId} aviso nivel ${nivel} enviado (grãos ${indispo.map(i => i.grao).join(',')}), faltavam ${Math.round(horas)}h`);
        continue;
      }

      // 5. PRAZO CHEGANDO -> resolve por substituicao (total = soma do pedido do cliente)
      const totalLixas = pedidoEstruturado.reduce((s, g) => s + Number(g.quantidade || 0), 0);
      const resolvido = sub.resolverPedidoComSubstituicao(
        pedidoEstruturado, graosResult.graos, totalLixas, graosResult.unidades_por_pacote || 10
      );
      if (!resolvido.ok || !Array.isArray(resolvido.pedidoFinal) || resolvido.pedidoFinal.length === 0) {
        if (!dryRun) await lcp.atualizarVenda(orderId, { bling_erro: `escada: nao resolvi por substituicao (${resolvido.erro || 'total nao fecha'})`.slice(0, 500) });
        stats.erros++; stats.lista.push({ order_id: orderId, acao: 'erro', motivo: 'substituicao_nao_resolveu', detalhe: resolvido.erro || resolvido.avisos });
        continue;
      }

      // dryRun: so reporta o que FARIA
      if (dryRun) {
        stats.substituidos++;
        stats.lista.push({ order_id: orderId, acao: 'substituiria', horas_ate_prazo: Math.round(horas * 10) / 10, ..._reg, trocas: resolvido.trocas, pedido_final: resolvido.pedidoFinal });
        continue;
      }

      // 6. MONTA no Bling (preserva cupom/desconto)
      const idBuscaBling = v.pack_id || orderId;
      const dataVenda = v.data_venda ? String(v.data_venda).split('T')[0] : null;
      const edit = await bp.editarPedidoComGraos({
        orderId: idBuscaBling, graosEscolhidos: resolvido.pedidoFinal, graosDisponiveis: graosResult.graos,
        unidadesPorPacote: graosResult.unidades_por_pacote, descricaoBase: graosResult.descricao,
        dataVenda, skuACombinar: v.sku_a_combinar || null, dryRun: false
      });
      if (!edit.ok) {
        await lcp.atualizarVenda(orderId, { bling_erro: `escada edit ${edit.etapa || ''}: ${edit.erro || ''}`.slice(0, 500) });
        stats.erros++; stats.lista.push({ order_id: orderId, acao: 'erro', motivo: 'edit_falhou', etapa: edit.etapa }); continue;
      }
      await lcp.atualizarVenda(orderId, {
        bling_pedido_id: String(edit.pedidoId), bling_editado_em: new Date().toISOString(),
        ia_pedido_estruturado: JSON.stringify(resolvido.pedidoFinal), bling_erro: null
      });

      // 7. EMITE a NF (idempotente: code 74 = ja tem NF -> trata como emitida)
      const nf = await bp.gerarNFe(edit.pedidoId);
      let nfOk = nf.ok;
      if (!nf.ok) {
        const campos = (nf.detalhe && nf.detalhe.error && nf.detalhe.error.fields) || [];
        if (Array.isArray(campos) && campos.some(f => Number(f.code) === 74 || /nota fiscal referenciada/i.test(String(f.msg || '')))) nfOk = true;
      }
      if (!nfOk) {
        await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', nf_erro: `${nf.status || ''}: ${nf.erro || JSON.stringify(nf.detalhe || {}).slice(0, 200)}`.slice(0, 500) });
        stats.erros++; stats.lista.push({ order_id: orderId, acao: 'erro', motivo: 'nf_falhou', pedidoId: edit.pedidoId }); continue;
      }
      await lcp.atualizarVenda(orderId, {
        nf_emitida_em: new Date().toISOString(), nf_id: nf.nfeId || null, nf_numero: nf.numero || null,
        nf_serie: nf.serie || null, nf_chave: nf.chave || null, nf_erro: null, status: 'processado'
      });

      // 8. AVISA a cliente da troca (best-effort; NF ja emitida, nao reverte se falhar)
      let avisoEnviado = false;
      try {
        const texto = sub.montarMsgSubstituicao(resolvido.trocas, resolvido.pedidoFinal, totalLixas);
        if (texto) {
          let buyerId = null;
          try { const od = await ml.getOrderDetalhe(orderId); buyerId = od && od.buyer ? od.buyer.id : null; } catch (_) {}
          let r = buyerId ? await ml.enviarMensagemDireta({ packId: v.pack_id, orderId, buyerId, texto }) : { ok: false };
          if (!r || !r.ok) r = await ml.enviarMensagem({ packId: v.pack_id, orderId, buyerId, texto });
          avisoEnviado = !!(r && r.ok);
        }
      } catch (e) {
        console.warn(`[escada] order ${orderId} aviso ao cliente falhou (NF ja emitida): ${e.message}`);
      }

      stats.substituidos++;
      stats.lista.push({
        order_id: orderId, acao: 'substituido', horas_ate_prazo: Math.round(horas * 10) / 10,
        trocas: resolvido.trocas, pedido_final: resolvido.pedidoFinal,
        nf: nf.numero || 'ja_existia', aviso_cliente: avisoEnviado
      });
      console.log(`[escada] ✅ order ${orderId} substituido (${(resolvido.trocas || []).map(t => t.de + '→' + t.para).join(', ')}), NF ${nf.numero || 'ja existia'}, aviso=${avisoEnviado}, faltavam ${Math.round(horas * 10) / 10}h`);
    } catch (e) {
      stats.erros++; stats.lista.push({ order_id: orderId, acao: 'erro', motivo: e.message });
      console.error(`[escada] order ${orderId} erro: ${e.message}`);
    }
  }

  if (stats.verificados > 0) {
    console.log(`[escada]${dryRun ? ' (dryRun)' : ''} verificados=${stats.verificados} ${dryRun ? 'avisaria' : 'avisados'}=${stats.avisados} aguardando=${stats.aguardando_prazo} ${dryRun ? 'substituiria' : 'substituidos'}=${stats.substituidos} erros=${stats.erros} pulados=${stats.pulados}`);
  }
  return stats;
}
