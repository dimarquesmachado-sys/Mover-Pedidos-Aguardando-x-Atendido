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
// Confianca minima da IA pra auto-executar. Diego: 100% exato. Abaixo disso -> humano.
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 100);

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
      return `Olá! Sua compra de ${totalLixas} lixas ${r.descricao}.

GRÃOS DISPONÍVEIS: ${graosStr}

Responda com QUANTIDADE + GRÃO. MÚLTIPLOS de ${unidades}. Total ${totalLixas} lixas.
${exemplo}`;
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
  const stats = { lidas: 0, novasRespostas: 0, semNovidade: 0, erros: 0, iaProcessadas: 0, iaEscalonadas: 0, iaErros: 0, autoEmitidas: 0, autoPuladasConfianca: 0, autoFalhas: 0 };

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
          // ANTI-DUPLICACAO (fix bug Diego 30/05): se a ultima resposta
          // ja foi processada pela IA (mesma data), nao processa de novo.
          // ════════════════════════════════════════════════════════
          if (venda.ia_processado_em && venda.ultima_resposta_em) {
            const tIa = new Date(venda.ia_processado_em).getTime();
            const tResp = new Date(venda.ultima_resposta_em).getTime();
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

                  // ── SESSAO 7: auto-emissao (claro + 100% + habilitado) ──
                  if (ehClaro && confOk && AUTO_EMITIR_HABILITADO) {
                    const auto = await processarAutoEmissao({ venda, iaResult, graosResult, lcp });
                    if (auto.emitida) stats.autoEmitidas++;
                    else if (auto.puladaConfianca) stats.autoPuladasConfianca++;
                    else stats.autoFalhas++;
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

  // Guarda 3 — soma confere o MESMO total que a IA usou (graosResult.lixas_por_kit)
  const totalLixas = Number(graosResult.lixas_por_kit);
  const somaPedido = graosEscolhidos.reduce((s, g) => s + Number(g.quantidade || 0), 0);
  if (somaPedido !== totalLixas) {
    await lcp.atualizarVenda(orderId, { status: 'precisa_atencao_humano', bling_erro: `auto: soma ${somaPedido} != total ${totalLixas}` });
    console.warn(`[auto-emissao] order ${orderId} soma ${somaPedido} != total ${totalLixas} — humano`);
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
