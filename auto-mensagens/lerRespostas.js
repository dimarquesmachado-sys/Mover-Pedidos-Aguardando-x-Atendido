'use strict';

/**
 * rotinaLerRespostas — o CORAÇÃO do fluxo automático de lixas A COMBINAR.
 *
 * Roda a cada 2 min (cron). Lê as conversas do ML das vendas aguardando resposta,
 * roda a IA, responde o cliente, e quando o pedido fecha dispara a auto-emissão.
 *
 * Extraído de fluxos.js (modularização, fase final). É um SUBSISTEMA COESO: leva
 * consigo todo o estado que só ele usa — o lock _lendoRespostas, os Maps de cooldown
 * de envio e de mensagem-já-processada, o contador de auto-emissões do dia, e os
 * helpers que mexem nesse estado (registrarEnvio, emCooldownEnvio, msgJaProcessada,
 * podeAutoEmitir, etc.). Nada disso é usado por outra função — confirmado.
 *
 * Depende de 3 funções internas do fluxos.js (processarAutoEmissao, retentarEmissoesBling,
 * revisarAtencaoHumana) -> chegam por INJEÇÃO (fábrica), evitando dependência circular.
 * lcp/lixasService/iaCliente/mlTokenManager são require lazy interno.
 */

const ml = require('./mlApi');

// ── Configs reproduzidas de fluxos.js (env vars; ler de novo é inócuo) ──
const AUTO_EMITIR_HABILITADO = (process.env.LIXAS_AUTO_EMITIR_NF_HABILITADO || 'false').toLowerCase() === 'true';
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 95);
const AUTO_MAX_POR_DIA = Number(process.env.LIXAS_AUTO_MAX_POR_DIA || 999);
const IA_MAX_RODADAS = Number(process.env.LIXAS_IA_MAX_RODADAS || 5);
const IA_MSG_ESCALA_LOOP = process.env.LIXAS_IA_MSG_ESCALA_LOOP ||
  'Olá! Vou verificar seu pedido pessoalmente com a equipe e retorno aqui em breve com a confirmação. Obrigado pela paciência! 😊';
const REENVIO_HABILITADO = (process.env.LIXAS_REENVIO_HABILITADO || 'false').toLowerCase() === 'true';
const REENVIO_HORAS = Number(process.env.LIXAS_REENVIO_HORAS || 6);
const REENVIO_MAX = Number(process.env.LIXAS_REENVIO_MAX || 1);
const REENVIO_TEXTO = process.env.LIXAS_REENVIO_TEXTO ||
  'Olá! Ainda precisamos da sua resposta (quantidades e grãos) para fechar e enviar seu pedido. Pode nos responder por aqui? Obrigado!';
const FECHAMENTO_HABILITADO = (process.env.LIXAS_FECHAMENTO_HABILITADO || 'true').toLowerCase() === 'true';
const FECHAMENTO_TEXTO = process.env.LIXAS_FECHAMENTO_TEXTO ||
  'Obrigado! Seu pedido está confirmado e será postado em breve — todo rastreamento da entrega você acompanha dentro da sua compra no MercadoLivre. 😊';
const FECHAMENTO_DIAS = Number(process.env.LIXAS_FECHAMENTO_DIAS || 3);

// ── Estado + helpers exclusivos deste subsistema (movidos de fluxos.js) ──
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
// COMPARTILHADO com retryFila.js (revisarAtencaoHumana lê o mesmo Map) -> lib própria.
const { registrarMsgProcessada, msgJaProcessada } = require('./travaMsgProcessada');


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

module.exports = function criarLerRespostas({ processarAutoEmissao, retentarEmissoesBling, revisarAtencaoHumana }) {

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
              // total REAL = lixas_por_kit x quantidade comprada (1 unidade do anuncio = 1 kit).
              // CRITICO p/ multi-kit: se a cliente comprou 4 kits de 100, o total e 400, nao 100.
              // Le a quantity do ML pelo MESMO helper da auto-emissao (extrairSkuACombinar).
              let qtdKitsResp = 1;
              try {
                const detResp = await ml.getOrderDetalhe(venda.order_id);
                const infoResp = ml.extrairSkuACombinar(detResp);
                if (infoResp && Number(infoResp.quantidade) > 0) qtdKitsResp = Number(infoResp.quantidade);
              } catch (e) {
                console.warn(`[ia] order ${venda.order_id} nao li a quantidade do ML — assumindo 1 kit: ${e.message}`);
              }
              const totalLixas = Number(graosResult.lixas_por_kit) * qtdKitsResp;
              if (qtdKitsResp !== 1) console.log(`[ia] order ${venda.order_id} qtd_kits=${qtdKitsResp} -> total_lixas=${totalLixas}`);
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
                historicoConversa,
                lixasPorKit: graosResult.lixas_por_kit,
                qtdKits: qtdKitsResp
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

              // ════════════════════════════════════════════════════════
              // FREIO DO LOOP: se o cliente ja mandou muitas mensagens e a IA AINDA nao
              // fechou (categoria != 'claro'), para de responder automatico e escala pra
              // humano. Evita o vai-e-volta infinito que faz o cliente desistir.
              // ════════════════════════════════════════════════════════
              if (iaResult.categoria !== 'claro' && Number(conv.totalCliente) >= IA_MAX_RODADAS) {
                console.warn(`[ia] order ${venda.order_id} 🔁 LOOP: ${conv.totalCliente} msgs do cliente sem fechar (categoria=${iaResult.categoria}) — ESCALANDO pra humano`);
                let avisouLoop = false;
                if ((venda.ia_msg_enviada || '').trim() !== IA_MSG_ESCALA_LOOP.trim()) {
                  try {
                    const envLoop = await ml.enviarMensagemDireta({
                      packId: venda.pack_id, orderId: venda.order_id, buyerId: venda.buyer_id, texto: IA_MSG_ESCALA_LOOP
                    });
                    avisouLoop = !!(envLoop && envLoop.ok);
                  } catch (_) {}
                }
                stats.iaEscalonadas++;
                await lcp.atualizarVenda(venda.order_id, {
                  ia_categoria: iaResult.categoria,
                  ia_confianca: iaResult.confianca,
                  ia_interpretacao: (`[loop ${conv.totalCliente} msgs do cliente] ` + (iaResult.interpretacao || '')).slice(0, 300),
                  ia_escalou_humano: true,
                  ia_msg_enviada: avisouLoop ? IA_MSG_ESCALA_LOOP : (venda.ia_msg_enviada || null),
                  ia_processado_em: new Date().toISOString(),
                  ultima_resposta_em: new Date(_tsRespAtual).toISOString(),
                  status: 'precisa_atencao_humano'
                });
                registrarMsgProcessada(venda.order_id, _tsRespAtual);
                continue;
              }

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

  return { rotinaLerRespostas };
};
