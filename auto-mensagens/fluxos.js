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
 *
 * SESSAO 7 (auto-emissao NF): ver bloco "PROCESSAR AUTO EMISSAO" abaixo.
 * 3 melhorias aplicadas:
 *   - Limiar default 95% (era 100%, IA quase nunca da 100 cravado)
 *   - Guarda 3 le quantidade de kits comprada do ML (evita NF errada em 2+ kits)
 *   - Limite diario opcional (LIXAS_AUTO_MAX_POR_DIA) pra dormir tranquilo
 */

const ml = require('./mlApi');
const tracker = require('./supabaseTracker');

// Integração opcional com módulo /lixas-combinar
let lixasService = null;
try {
  lixasService = require('../lixas-combinar/lixasService');
} catch (e) {
  console.log('[auto-mensagens] modulo lixas-combinar nao disponivel — usando msg generica');
}

const HABILITADO = (process.env.AUTO_MSG_GIRASSOL_HABILITADO || 'false').toLowerCase() === 'true';
const TEXTO = process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '';
const JANELA_MIN = Number(process.env.AUTO_MSG_JANELA_MIN || 30);
const LIMITE_CHARS = 350;

// ════════════════════════════════════════════════════════════════
// SESSAO 7: AUTO-EMISSAO DE NF NO FLUXO IA
// ════════════════════════════════════════════════════════════════
// Liga/desliga a auto-emissao. NASCE DESLIGADA — Diego liga quando quiser.
const AUTO_EMITIR_HABILITADO = (process.env.LIXAS_AUTO_EMITIR_NF_HABILITADO || 'false').toLowerCase() === 'true';
// Confianca minima da IA pra auto-executar. Default 95 (IA quase nunca da 100 cravado).
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 95);
// Limite diario de NFs auto-emitidas (safety na primeira semana). 999 = sem limite efetivo.
const AUTO_MAX_POR_DIA = Number(process.env.LIXAS_AUTO_MAX_POR_DIA || 999);

// Contador in-memory de auto-emissoes do dia (reseta ao virar o dia ou reiniciar Render)
let _autoEmitidasHoje = { data: '', count: 0 };

function podeAutoEmitir() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (_autoEmitidasHoje.data !== hoje) {
    _autoEmitidasHoje = { data: hoje, count: 0 };
  }
  return _autoEmitidasHoje.count < AUTO_MAX_POR_DIA;
}

function incrementarAutoEmitida() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (_autoEmitidasHoje.data !== hoje) _autoEmitidasHoje = { data: hoje, count: 0 };
  _autoEmitidasHoje.count++;
  return _autoEmitidasHoje.count;
}

/**
 * Tenta montar mensagem inteligente com grãos disponíveis.
 * Se falhar (SKU nao mapeado, Bling fora, etc), retorna o TEXTO genérico.
 */
async function montarMensagemInteligente(detalhe) {
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

    const totalLixas = r.lixas_por_kit * info.quantidade;
    const unidades = r.unidades_por_pacote || 10;

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

    if (msg.length > LIMITE_CHARS) {
      while (graosArr.length > 3 && msg.length > LIMITE_CHARS) {
        graosArr.pop();
        msg = montar(graosArr);
      }
      if (msg.length <= LIMITE_CHARS) {
        graosArr[graosArr.length - 1] = graosArr[graosArr.length - 1] + ' ...';
        msg = montar(graosArr);
      }
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
        if (await tracker.jaEnviou(orderId)) {
          stats.jaEnviados++;
          continue;
        }
        const detalhe = await ml.getOrderDetalhe(orderId);
        if (!ml.temVariacaoACombinar(detalhe)) {
          stats.semACombinar++;
          await tracker.registrar({
            orderId, packId: detalhe.pack_id, buyerId: detalhe.buyer?.id,
            tipo: 'a_combinar', textoEnviado: null, messageIdMl: null,
            status: 'pulado', erroDetalhe: 'sem_variacao_a_combinar',
            loja: 'GIRASSOL'
          });
          continue;
        }
        const buyerId = detalhe.buyer?.id;
        const packId = detalhe.pack_id;
        const textoFinal = await montarMensagemInteligente(detalhe);

        const conv = await ml.consultarConversa({ packId, orderId });
        let r;
        let viaEndpoint;
        let respostasCliente = null;

        if (conv.ok && !conv.conversaVirgem && conv.totalCliente > 0) {
          viaEndpoint = 'direto';
          respostasCliente = conv.ultimaCliente;
          console.log(`[auto-mensagens] 💬 Order ${orderId} ja tem ${conv.totalCliente} msg(s) do cliente — enviando DIRETO (preserva OTHER)`);
          r = await ml.enviarMensagemDireta({ packId, orderId, buyerId, texto: textoFinal });
        } else {
          viaEndpoint = 'action_guide';
          console.log(`[auto-mensagens] 📨 Order ${orderId} conversa virgem — enviando via ACTION_GUIDE OTHER (buyer ${buyerId}, pack ${packId || 'null'}, ${textoFinal.length} chars)`);
          r = await ml.enviarMensagem({ packId, orderId, buyerId, texto: textoFinal });
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
 * Sessao 3: rotinaLerRespostas
 * Roda a cada 2 min (cron). Le respostas dos clientes no ML e processa via IA.
 */
let _lendoRespostas = false;

async function rotinaLerRespostas() {
  if (_lendoRespostas) {
    console.log('[lixas-combinar lerRespostas] já em execução, pulando');
    return { skipped: 'em_execucao' };
  }
  _lendoRespostas = true;

  const inicio = Date.now();
  const stats = { lidas: 0, novasRespostas: 0, semNovidade: 0, erros: 0, iaProcessadas: 0, iaEscalonadas: 0, iaErros: 0, autoEmitidas: 0, autoPuladasConfianca: 0, autoFalhas: 0, autoLimiteDiario: 0 };

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
          markAsRead: true
        });

        if (!conv.ok) {
          stats.erros++;
          console.error(`[lixas-combinar lerRespostas] erro conversa order ${venda.order_id}: ${conv.erro}`);
          continue;
        }

        if (conv.totalCliente > 0 && conv.ultimaCliente) {
          const textoCliente = conv.ultimaCliente.text || conv.ultimaCliente.message || '';
          const dataResposta = conv.ultimaCliente.date_created || conv.ultimaCliente.date || new Date().toISOString();

          // ANTI-DUPLICACAO
          if (venda.ia_processado_em && venda.ultima_resposta_em) {
            const tIa = new Date(venda.ia_processado_em).getTime();
            const tRespAtual = new Date(dataResposta).getTime();
            if (tIa >= tRespAtual - 1000) {
              console.log(`[lixas-combinar lerRespostas] ⏭️  Order ${venda.order_id} ja processada pela IA (msg cliente nao mudou) - pulando`);
              stats.semNovidade++;
              continue;
            }
          }

          await lcp.marcarRespostaCliente(venda.order_id, {
            texto: textoCliente,
            dataResposta,
            totalMsgsCliente: conv.totalCliente
          });
          stats.novasRespostas++;
          console.log(`[lixas-combinar lerRespostas] 💬 Order ${venda.order_id} cliente respondeu (${conv.totalCliente} msg) - "${textoCliente.slice(0, 60)}..."`);

          // PROCESSAMENTO IA
          if (ia && ia.configurado() && venda.sku_a_combinar) {
            try {
              const lixasService = require('../lixas-combinar/lixasService');
              const graosResult = await lixasService.getGraosDisponiveisPorSkuACombinar(venda.sku_a_combinar);

              if (!graosResult.ok || !graosResult.graos || graosResult.graos.length === 0) {
                console.log(`[ia] sem graos disponiveis pra ${venda.sku_a_combinar} - pulando IA`);
                continue;
              }

              const graosDisponiveis = graosResult.graos.map(g => g.grao);
              const totalLixas = graosResult.lixas_por_kit;
              const unidadesPorPacote = graosResult.unidades_por_pacote || 10;

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

              if (iaResult.categoria === 'fora_escopo') {
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
                const msgIA = iaResult.msg_pra_cliente;

                const envR = await ml.enviarMensagemDireta({
                  packId: venda.pack_id,
                  orderId: venda.order_id,
                  buyerId: venda.buyer_id,
                  texto: msgIA
                });

                if (envR.ok) {
                  stats.iaProcessadas++;

                  const ehClaro = iaResult.categoria === 'claro';
                  const confOk = Number(iaResult.confianca) >= LIMIAR_CONFIANCA_AUTO;
                  let statusInicial;
                  if (ehClaro) {
                    statusInicial = (AUTO_EMITIR_HABILITADO && !confOk)
                      ? 'precisa_atencao_humano'
                      : 'cliente_confirmou_pedido';
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
                    // SAFETY: limite diario
                    if (!podeAutoEmitir()) {
                      console.warn(`[auto-emissao] 🛑 LIMITE DIARIO ${AUTO_MAX_POR_DIA} atingido — venda ${venda.order_id} vai pro painel humano`);
                      await lcp.atualizarVenda(venda.order_id, {
                        status: 'precisa_atencao_humano',
                        bling_erro: `auto: limite diario ${AUTO_MAX_POR_DIA} atingido`
                      });
                      stats.autoLimiteDiario++;
                    } else {
                      const auto = await processarAutoEmissao({ venda, iaResult, graosResult, lcp });
                      if (auto.emitida) {
                        stats.autoEmitidas++;
                        const total = incrementarAutoEmitida();
                        console.log(`[auto-emissao] 📊 ${total}/${AUTO_MAX_POR_DIA} NFs auto-emitidas hoje`);
                      }
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
 *   Guarda 3  QUANTIDADE DE KITS COMPRADA (le do ML order_items.quantity)
 *             CRITICO: se cliente comprou 2+ kits, total = lixas_por_kit × qtdKits.
 *             Sem isso, venda de 2 kits = 200 lixas viraria NF errada de 100 lixas.
 *             Se nao conseguir determinar a qtdKits, vai pra humano por seguranca.
 *   Guarda 4  soma das quantidades == total real (lixas_por_kit × qtdKits)
 *   Guarda 5  cada grao existe nos disponiveis E tem estoque suficiente
 *   Edita pedido no Bling (mesma funcao do botao "Editar Bling") — o rateio
 *             fiscal entra aqui: sobra de centavo vai pro DESCONTO/OUTRAS
 *             DESPESAS do pedido, total sempre bate exato.
 *   Emite NF (mesma funcao do botao laranja "Emitir NF")
 *   Marca 'processado' + flag auto_emitida=true (pro painel diferenciar)
 *
 * Qualquer falha grava bling_erro/nf_erro e poe a venda em 'precisa_atencao_humano'.
 *
 * @returns {object} { emitida? , puladaConfianca? , falha? , motivo? }
 */
async function processarAutoEmissao({ venda, iaResult, graosResult, lcp }) {
  const orderId = venda.order_id;
  const bp = require('../lixas-combinar/blingPedidos');

  // Guarda 1 — confianca (defesa em profundidade)
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

  // Guarda 3 — QUANTIDADE DE KITS COMPRADA (CRITICO!)
  // Le do ML order_items[].quantity. Se nao conseguir, manda pra humano.
  // SEM essa guarda, venda de 2 kits = 200 lixas seria editada como 100 lixas (NF errada irreversivel).
  let qtdKits = null;
  try {
    const det = await ml.getOrderDetalhe(orderId);
    const items = det?.order_items || [];

    // Tenta usar helper do mlApi se existir
    let itemAcombinar = null;
    if (typeof ml.itemTemVariacaoACombinar === 'function') {
      itemAcombinar = items.find(it => ml.itemTemVariacaoACombinar(it));
    }
    // Fallback 1: busca "A COMBINAR" em qualquer campo do item
    if (!itemAcombinar) {
      itemAcombinar = items.find(it => JSON.stringify(it || {}).toUpperCase().includes('A COMBINAR'));
    }
    // Fallback 2: se so tem 1 item, assume que eh ele (mais comum)
    if (!itemAcombinar && items.length === 1) {
      itemAcombinar = items[0];
    }

    if (itemAcombinar && Number(itemAcombinar.quantity) > 0) {
      qtdKits = Number(itemAcombinar.quantity);
    }
  } catch (e) {
    console.warn(`[auto-emissao] order ${orderId} erro lendo quantity do ML: ${e.message}`);
  }
  if (!qtdKits || qtdKits < 1) {
    await lcp.atualizarVenda(orderId, {
      status: 'precisa_atencao_humano',
      bling_erro: 'auto: nao consegui determinar quantidade de kits comprada (campo order_items.quantity)'
    });
    console.warn(`[auto-emissao] order ${orderId} qtdKits indefinida — humano por seguranca`);
    return { falha: true, motivo: 'qtd_kits_indefinida' };
  }

  // Guarda 4 — soma confere o total real (lixas_por_kit × qtdKits)
  const totalLixas = Number(graosResult.lixas_por_kit) * qtdKits;
  const somaPedido = graosEscolhidos.reduce((s, g) => s + Number(g.quantidade || 0), 0);
  if (somaPedido !== totalLixas) {
    await lcp.atualizarVenda(orderId, {
      status: 'precisa_atencao_humano',
      bling_erro: `auto: soma ${somaPedido} != total ${totalLixas} (${qtdKits} kit${qtdKits>1?'s':''} × ${graosResult.lixas_por_kit})`
    });
    console.warn(`[auto-emissao] order ${orderId} qtdKits=${qtdKits} soma=${somaPedido} != total=${totalLixas} — humano`);
    return { falha: true, motivo: 'soma_diverge' };
  }
  console.log(`[auto-emissao] order ${orderId} qtdKits=${qtdKits} total_lixas=${totalLixas} OK`);

  // Guarda 5 — cada grao existe nos disponiveis e tem estoque suficiente
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

  // Args comuns pro blingPedidos (Bling guarda pack_id em numeroLoja)
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

  // Edita o pedido no Bling
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
    bling_erro: null,
    auto_emitida: true  // flag pro painel mostrar badge "🤖 Auto"
  });

  // Emite a NF (IRREVERSIVEL — vai pra SEFAZ)
  const nf = await bp.gerarNFe(edit.pedidoId);
  if (!nf.ok) {
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
  console.log(`[auto-emissao] ✅ order ${orderId} → pedido ${edit.pedidoId} editado + NF ${nf.numero}/${nf.serie} emitida (auto, ${qtdKits} kit${qtdKits>1?'s':''}=${totalLixas} lixas)`);
  return { emitida: true, pedidoId: edit.pedidoId, nfNumero: nf.numero, qtdKits };
}

/**
 * Força processamento de UMA venda específica (ignora janela de tempo)
 * Aceita TANTO order_id quanto pack_id.
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

    stats.etapa = 'detectar_tipo';
    let orderId = idEntrada;
    let detalhe = null;
    let packIdDescoberto = null;

    try {
      detalhe = await ml.getOrderDetalhe(idEntrada);
      stats.tipo_id = 'order';
    } catch (e) {
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

    stats.etapa = 'checar_duplicado';
    if (await tracker.jaEnviou(orderId)) {
      return { ok: false, erro: `Ja enviou pra esta venda (order ${orderId}) anteriormente`, stats };
    }

    stats.status_venda = detalhe.status;
    stats.buyer_id = detalhe.buyer?.id;
    stats.pack_id = detalhe.pack_id || packIdDescoberto;

    stats.etapa = 'verificar_a_combinar';
    const temACombinar = ml.temVariacaoACombinar(detalhe);
    stats.tem_a_combinar = temACombinar;
    if (!temACombinar) {
      return { ok: false, erro: 'Venda NAO tem variacao A COMBINAR', stats };
    }

    stats.etapa = 'enviar';
    const buyerId = detalhe.buyer?.id;
    const packId = detalhe.pack_id || packIdDescoberto;
    const textoFinal = await montarMensagemInteligente(detalhe);
    stats.texto_chars = textoFinal.length;

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
      viaEndpoint = 'direto_sem_resposta';
      console.log(`[auto-mensagens FORCAR] 📨 order=${orderId} loja ja enviou mas cliente nao respondeu — tentando DIRETO (chars=${textoFinal.length})`);
      r = await ml.enviarMensagemDireta({ packId, orderId, buyerId, texto: textoFinal });
    } else {
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
