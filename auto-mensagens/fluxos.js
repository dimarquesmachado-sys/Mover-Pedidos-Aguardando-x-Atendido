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
  'Obrigado! Seu pedido está confirmado e será postado em breve — todo acompanhamento e rastreamento da entrega você acompanha dentro da sua compra no MercadoLivre. 😊';
const FECHAMENTO_DIAS = Number(process.env.LIXAS_FECHAMENTO_DIAS || 3); // janela de vendas processadas a vigiar

const AFIRMACOES_SIMPLES = ['sim', 'ok', 'okay', 'blz', 'beleza', 'obrigado', 'obrigada', 'obg', 'valeu', 'vlw',
  'perfeito', 'isso', 'isso mesmo', 'certo', 'correto', 'pode ser', 'show', 'top', 'joia', 'jóia',
  '👍', '👍🏻', 'ta bom', 'tá bom', 'tudo certo', 'confirmado', 'fechado', 'fechou', 'sim!', 'ok!'];
function ehAfirmacaoSimples(texto) {
  const t = String(texto || '').trim().toLowerCase().replace(/[!.…\s]+$/g, '').trim();
  if (!t) return false;
  return AFIRMACOES_SIMPLES.includes(t);
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

module.exports = { rotinaACombinar, rotinaLerRespostas, forcarOrder, processarAutoEmissao, HABILITADO, TEXTO };

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

    // Lista pendentes aguardando resposta (ultimos 7 dias)
    const lista = await lcp.listarPendentes({
      dias: 7,
      status: 'aguardando_resposta',
      limit: 50
    });
    if (!lista.ok) {
      console.error(`[lixas-combinar lerRespostas] erro listando: ${JSON.stringify(lista.data).slice(0,200)}`);
      return { ok: false, erro: 'erro_listar', stats };
    }

    const pendentes = Array.isArray(lista.data) ? lista.data : [];
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
          const dataResposta = conv.ultimaCliente.date_created || conv.ultimaCliente.date || new Date().toISOString();

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
            const _ts = (m) => new Date(m.date_created || m.date || 0).getTime();
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
              if (REENVIO_HABILITADO && _ultCliente > 0 && horasDesdeLoja >= REENVIO_HORAS && lembretesFeitos < REENVIO_MAX) {
                const textoLembrete = (lojaAposCliente[0]?.text || '').slice(0, 350) || REENVIO_TEXTO;
                const lemb = await ml.enviarMensagemDireta({
                  packId: venda.pack_id, orderId: venda.order_id, buyerId: venda.buyer_id, texto: textoLembrete
                });
                if (lemb.ok) {
                  stats.lembretesEnviados++;
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
                      const auto = await processarAutoEmissao({ venda, iaResult, graosResult, lcp });
                      if (auto.emitida) { stats.autoEmitidas++; incrementarAutoEmitida(); }
                      else if (auto.puladaConfianca) stats.autoPuladasConfianca++;
                      else stats.autoFalhas++;
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
              const conv = await ml.consultarConversa({ packId: venda.pack_id, orderId: venda.order_id, markAsRead: true });
              if (!conv.ok) continue;
              const msgs = Array.isArray(conv.messages) ? conv.messages : [];
              const ehLoja = (m) => String(m.from_user_id || m.from?.user_id || '') === sellerIdF;
              const tsF = (m) => new Date(m.date_created || m.date || 0).getTime();
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
                    dataResposta: ultCli.date_created || ultCli.date || new Date().toISOString(),
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
async function processarAutoEmissao({ venda, iaResult, graosResult, lcp }) {
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
    dataVenda
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
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: pedido nao encontrado no Bling (${(busca.erro || '').slice(0, 200)})` });
      console.warn(`[auto-emissao] order ${orderId} pedido nao achado no Bling — humano`);
      return { falha: true, motivo: 'pedido_nao_encontrado' };
    }
    if (busca.aviso) {
      // duplicidade = mais de um pedido com o mesmo numeroLoja (carrinho)
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: carrinho detectado (${busca.aviso}) — varios pedidos no mesmo pack, tratar manual` });
      console.warn(`[auto-emissao] order ${orderId} CARRINHO (duplicidade de pedido) — humano`);
      return { falha: true, motivo: 'carrinho_multi_pedido' };
    }
    const det = await bp.obterPedidoCompleto(busca.pedidoId);
    const nItens = (det.ok && Array.isArray(det.pedido?.itens)) ? det.pedido.itens.length : null;
    if (nItens !== 1) {
      await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: carrinho/pedido multi-item (${nItens} itens) — auto-emissao so trata 1 item, tratar manual` });
      console.warn(`[auto-emissao] order ${orderId} pedido com ${nItens} itens (carrinho?) — humano`);
      return { falha: true, motivo: 'carrinho_multi_item' };
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
          orderId = String(packInfo.orders[0].id);
          packIdDescoberto = idEntrada;
          stats.tipo_id = 'pack';
          stats.order_id_real = orderId;
          stats.pack_id_real = packIdDescoberto;
          detalhe = await ml.getOrderDetalhe(orderId);
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
