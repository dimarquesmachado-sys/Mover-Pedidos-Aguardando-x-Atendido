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

// Rotina da ESCADA (auto-substituicao de grao indisponivel + trava de prazo de coleta)
// foi extraida pra ./escada.js (modularizacao). Reexportada no module.exports abaixo.
const { rotinaEscadaIndisponivel } = require('./escada');

// Mensagem inicial inteligente (usada por rotinaACombinar e por forcarOrder) e a rotina
// forcarOrder (debug) foram extraidas pra modulos proprios (modularizacao).
const { montarMensagemInteligente } = require('./mensagemInicial');
const { forcarOrder } = require('./forcarOrder');

// Fila de RETRY de emissao + reconciliacao + re-engajamento extraida pra ./retryFila.js.
// E a DONA do Map _retryBling; processarAutoEmissao mexe na fila via _retry.removerDaFila()
// e _retry.agendarOuEscalarRetry() (em vez de tocar o Map direto). retentarEmissoesBling
// precisa de processarAutoEmissao -> injetado (function declaration, hoisted).
const _retry = require('./retryFila')({ processarAutoEmissao });
const { retentarEmissoesBling, revisarAtencaoHumana } = _retry;

// Rotinas de RECUPERAÇÃO (recuperarFalsosProcessados + recuperarPendentes) extraidas pra
// ./recuperacao.js. Dependem de processarAutoEmissao (hoisted) e de retentarEmissoesBling/
// revisarAtencaoHumana (const logo acima, ja definidas). Tambem por injecao.
const { recuperarFalsosProcessados, recuperarPendentes } = require('./recuperacao')({
  processarAutoEmissao, retentarEmissoesBling, revisarAtencaoHumana,
});

// rotinaLerRespostas (o coração do fluxo automático) extraida pra ./lerRespostas.js — é um
// subsistema com estado próprio (lock, cooldowns, contador do dia). Depende de
// processarAutoEmissao (hoisted) + retentarEmissoesBling/revisarAtencaoHumana (const acima),
// que chegam por injecao.
const { rotinaLerRespostas } = require('./lerRespostas')({
  processarAutoEmissao, retentarEmissoesBling, revisarAtencaoHumana,
});

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

// FREIO DO LOOP: se o cliente ja mandou MUITAS mensagens e a IA ainda nao fechou o pedido
// (categoria != 'claro'), para de responder automatico e ESCALA pra humano — evita o
// cliente ficar preso num vai-e-volta infinito com a IA. Default 5 mensagens do cliente.
const IA_MAX_RODADAS = Number(process.env.LIXAS_IA_MAX_RODADAS || 5);
const IA_MSG_ESCALA_LOOP = process.env.LIXAS_IA_MSG_ESCALA_LOOP ||
  'Olá! Vou verificar seu pedido pessoalmente com a equipe e retorno aqui em breve com a confirmação. Obrigado pela paciência! 😊';

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


// ── FIX 22/07/2026 (caso PAULO_BASSO) ────────────────────────────────
// "Tentativa de pedido" = mensagem em que o cliente informa grao/quantidade.
// O sinal barato e confiavel disso e ter NUMERO no texto. "Ola", "boa tarde",
// "vou mudar entao" nao sao tentativa de pedido — sao ruido de conversa.
function _temNumero(texto) {
  return /\d/.test(String(texto || ''));
}


let _executando = false;

async function rotinaACombinar() {
  if (_executando) {
    console.log('[auto-mensagens] já em execução, pulando');
    return { skipped: 'em_execucao' };
  }
  _executando = true;

  const inicio = Date.now();
  const stats = { lidos: 0, jaEnviados: 0, semACombinar: 0, enviados: 0, erros: 0, moderados: 0, puladosClienteJaEspecificou: 0 };

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
        // 4. Dados basicos da venda
        const buyerId = detalhe.buyer?.id;
        const packId = detalhe.pack_id;

        // 4.5. Consulta a conversa ANTES de montar/enviar qualquer coisa.
        //      - virgem  → action_guide OTHER (1 uso, gasta o cap)
        //      - tem msg → POST direto (preserva o cap pra outra situacao)
        const conv = await ml.consultarConversa({ packId, orderId });

        // ════════════════════════════════════════════════════════════════
        // FIX 22/07/2026 (caso PAULO_BASSO order 2000017546667040)
        //
        // Se o cliente JA ESPECIFICOU o pedido antes da nossa msg inicial sair,
        // NAO manda o menu de graos por cima. O que acontecia sem isso:
        //   1. cliente compra e ja escreve "quero 20 do 80, 40 do 120..."
        //   2. o cron (ate 5 min depois) manda o menu generico mesmo assim
        //   3. o cliente acha que ninguem leu e REPETE o pedido
        //   4. cada repeticao dessas queima uma "rodada" do freio de loop do
        //      lerRespostas -> estoura o limite -> cai no painel com o texto
        //      generico de escalada, sem pedido montado e sem NF.
        //
        // CRITERIO — cliente mandou NUMERO em alguma mensagem:
        //   Quem so mandou "Ola"/"boa tarde" AINDA PRECISA do menu; se pulassemos
        //   tambem nesse caso, a IA receberia um "Ola" sem contexto nenhum,
        //   classificaria como fora_escopo e escalaria pra humano de cara.
        //   Por isso o corte e "tem numero", nao "falou alguma coisa".
        //
        // AO PULAR, registra a venda com status 'cliente_respondeu' — status que
        // o lerRespostas TAMBEM pesca (ele lista 'aguardando_resposta' E
        // 'cliente_respondeu' e deduplica), entao a IA processa na passada
        // seguinte, em ate 2 min. Mesmo caminho que o recuperarPendentes ja usa.
        // ════════════════════════════════════════════════════════════════
        {
          const _txtsCliente = [];
          if (Array.isArray(conv.messages) && conv.messages.length > 0) {
            let _sellerId = '';
            try { _sellerId = String(require('./mlTokenManager').getUserId() || ''); } catch (_) {}
            for (const m of conv.messages) {
              const from = String(m.from_user_id || m.from?.user_id || '');
              if (_sellerId && from === _sellerId) continue;   // msg da loja, ignora
              _txtsCliente.push(m.text || m.message || '');
            }
          }
          // Fallback: se nao deu pra separar por remetente, olha ao menos a ultima do cliente
          if (_txtsCliente.length === 0 && conv.ultimaCliente) {
            _txtsCliente.push(conv.ultimaCliente.text || conv.ultimaCliente.message || '');
          }
          const clienteJaEspecificou = _txtsCliente.some(_temNumero);

          if (conv.ok && conv.totalCliente > 0 && clienteJaEspecificou) {
            stats.puladosClienteJaEspecificou++;
            console.log(`[auto-mensagens] ⏭️  Order ${orderId} cliente JA especificou o pedido antes do menu (${conv.totalCliente} msg) — NAO envia msg inicial, deixa a IA responder`);

            // Tracker: marca como pulado (mesmo padrao do "sem A COMBINAR" acima)
            await tracker.registrar({
              orderId, packId, buyerId,
              tipo: 'a_combinar', textoEnviado: null, messageIdMl: null,
              status: 'pulado', erroDetalhe: 'cliente_ja_especificou_antes_do_menu',
              loja: 'GIRASSOL'
            });

            // Tabela de pendentes: SO cria se ainda nao existir. Sem esse buscar,
            // uma segunda passada da rotina (a venda continua na janela de 30min)
            // sobrescreveria o status de uma venda que a IA ja fez avancar — ex.:
            // regredir 'cliente_confirmou_pedido' de volta pra 'cliente_respondeu'.
            // Mesma protecao que o recuperarPendentes usa.
            try {
              const lcp = require('./lixasCombinarPendentes');
              if (lcp.configurado()) {
                const existente = await lcp.buscar(orderId);
                if (existente.ok && existente.data) {
                  console.log(`[auto-mensagens] order ${orderId} ja esta na tabela de pendentes — nao mexo no status`);
                } else {
                  const sku = ml.extrairSkuACombinar(detalhe);
                  await lcp.upsertPendente({
                    orderId, packId, buyerId,
                    buyerNome: detalhe.buyer?.nickname || `${detalhe.buyer?.first_name || ''} ${detalhe.buyer?.last_name || ''}`.trim(),
                    skuACombinar: sku?.sku || null,
                    descricaoProduto: sku?.titulo || null,
                    quantidadeLixas: null,
                    dataVenda: detalhe.date_created || new Date().toISOString(),
                    msgInicialEnviada: null,        // nao enviamos menu nenhum
                    msgInicialEnviadaEm: null,
                    clienteRespondeu: true,
                    ultimaRespostaCliente: conv.ultimaCliente?.text || null,
                    ultimaRespostaEm: conv.ultimaCliente?.date_created || null,
                    totalMsgsCliente: conv.totalCliente || 0,
                    status: 'cliente_respondeu',
                    viaEndpoint: 'pulado_cliente_ja_especificou'
                  });
                }
              }
            } catch (e) {
              console.error(`[auto-mensagens] erro upsert pendente (pulado): ${e.message}`);
            }

            continue;   // proxima venda — nada foi enviado ao cliente
          }
        }

        // 5. Monta a mensagem inicial (inteligente se SKU mapeado, senão genérica)
        const textoFinal = await montarMensagemInteligente(detalhe);

        let r;
        let viaEndpoint;
        let respostasCliente = null;

        if (conv.ok && !conv.conversaVirgem && conv.totalCliente > 0) {
          // Cliente ja mandou msg (mas SEM numero — ex.: so "Ola"). Ainda faz
          // sentido mandar o menu; envia direto pra preservar o cap do OTHER.
          viaEndpoint = 'direto';
          respostasCliente = conv.ultimaCliente;
          console.log(`[auto-mensagens] 💬 Order ${orderId} ja tem ${conv.totalCliente} msg(s) do cliente (sem pedido) — enviando DIRETO (preserva OTHER)`);
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

// ════════════════════════════════════════════════════════════════════════════
// SESSAO 8 — CHECAGEM DE VENDA CANCELADA NO ML
//
// Problema real: o cliente cancela a compra no ML DEPOIS que a gente ja montou
// o pedido no Bling e/ou emitiu a NF. Sem essa checagem o robo continua
// conversando com ele, a venda segue no painel como se estivesse viva, e o
// pacote chega a ser preparado e levado ao posto — onde a etiqueta nao passa.
//
// De hora em hora pega um LOTE de vendas ainda vivas e pergunta pro ML "esse
// pedido ainda esta pago?". Se voltou 'cancelled' (ou 'invalid'):
//   - grava venda_cancelada_em + status 'venda_cancelada'
//   - se a venda JA tinha bling_editado_em ou nf_emitida_em -> grava tambem
//     alerta_pos_venda, e o painel mostra a faixa vermelha gritante.
//
// POR QUE O STATUS 'venda_cancelada' JA BASTA PRA PARAR TUDO:
// rotinaLerRespostas, rotinaEscadaIndisponivel e recuperarFalsosProcessados
// filtram por status EXPLICITO ('aguardando_resposta' / 'cliente_respondeu' /
// 'precisa_atencao_humano' / 'processado'). Assim que a venda vira
// 'venda_cancelada' ela some de todas — nao recebe mais mensagem, nao entra na
// escada, nao ganha NF automatica. E recuperarPendentes nao ressuscita: ele pula
// qualquer order que ja exista na tabela (lcp.buscar antes do upsert),
// independente do status. Ou seja: nao precisei mexer em nenhuma outra rotina.
//
// ANTI-SPAM no ML (2 travas, as duas ajustaveis por env):
//   1. so olha venda com mais de LIXAS_CANCELADAS_IDADE_MIN_HORAS de vida (24h).
//   2. cada venda so e reconsultada a cada LIXAS_CANCELADAS_REPESCAR_HORAS (6h).
//      Com cron de 1h isso dilui a carga: cada rodada pega so quem "venceu", em
//      ordem de ml_status_atualizado_em ASC (nunca-checado primeiro).
// ════════════════════════════════════════════════════════════════════════════

const CANCELADAS_STATUS = (
  process.env.LIXAS_CANCELADAS_STATUS ||
  'aguardando_resposta,cliente_respondeu,cliente_confirmou_pedido,aguardando_bling,cancelada_quarentena,precisa_atencao_humano,processado'
).split(',').map(s => s.trim()).filter(Boolean);
// 'cancelada_quarentena' e status INTERNO desta rotina — ela mesma o escreve e so ela
// o resolve. Um deploy com LIXAS_CANCELADAS_STATUS antigo/custom substituiria o default
// inteiro e deixaria a linha quarentenada pra sempre, sem nunca reconferir a etiqueta.
// Por isso entra sempre, depois do parse do override.
// Os dois status ATIVOS internos entram sempre, mesmo com LIXAS_CANCELADAS_STATUS
// setada com um default antigo (o override substitui a lista inteira):
//  - cancelada_quarentena: escrito e resolvido por esta rotina
//  - aguardando_bling: fica de fora do polling de envio se ausente, e uma etiqueta que
//    surja durante o retry nao seria registrada — a Guarda 1.6 deixaria o retry montar
//    e emitir NF de um pedido ja etiquetado
for (const _st of ['cancelada_quarentena', 'aguardando_bling']) {
  if (!CANCELADAS_STATUS.includes(_st)) CANCELADAS_STATUS.push(_st);
}
// Acompanha a janela do leitor (LIXAS_JANELA_DIAS, default 30). Se ficasse em 7
// enquanto o lerRespostas processa ate 30 dias, existiria uma faixa de 8-30 dias em
// que uma venda CANCELADA no ML seguiria sendo processada — montando pedido no Bling
// e emitindo NF (irreversivel) de algo que o cliente ja cancelou.
const CANCELADAS_DIAS        = Number(process.env.LIXAS_CANCELADAS_DIAS)
  || Number(process.env.LIXAS_JANELA_DIAS) || 30;
const CANCELADAS_IDADE_MIN_H = Number(process.env.LIXAS_CANCELADAS_IDADE_MIN_HORAS) || 24;
// Idade minima pra checar o ENVIO. Separada da de cancelamento de proposito: a etiqueta
// costuma sair no MESMO dia da venda, e se herdasse as 24h do cancelamento uma venda ja
// tratada ficaria presa em Pendentes o primeiro dia inteiro. Default 0 = checa desde ja.
const ENVIO_IDADE_MIN_H = Number(process.env.LIXAS_ENVIO_IDADE_MIN_HORAS) || 0;
// Intervalo de RE-consulta do envio. Separado do de cancelamento (6h) porque o cron
// e horario: reusando as 6h, uma etiqueta gerada logo apos a consulta so seria vista
// 6h depois — contra a promessa de "sai na proxima hora".
const ENVIO_REPESCAR_H = Number(process.env.LIXAS_ENVIO_REPESCAR_HORAS) || 1;
const CANCELADAS_REPESCAR_H  = Number(process.env.LIXAS_CANCELADAS_REPESCAR_HORAS) || 6;
const CANCELADAS_MAX         = Number(process.env.LIXAS_CANCELADAS_MAX_POR_RODADA) || 40;
const CANCELADAS_PAUSA_MS    = Number(process.env.LIXAS_CANCELADAS_PAUSA_MS) || 350;
// LEASE da emissao: janela em que o cron respeita uma reserva de NF em curso. Tem que
// ser MAIOR que o pior caso de uma chamada ao Bling — o fetch do tokenManager nao tem
// timeout, e uma requisicao lenta que passasse do lease deixaria o cron gravar
// cancelamento com o gerarNFe ainda rodando. 10 min cobre com folga; o endpoint limpa
// a reserva ao terminar, entao o valor alto nao trava nada no caminho normal.
const NF_LEASE_MIN = Number(process.env.LIXAS_NF_LEASE_MIN) || 10;
function _semReservaAtiva() {
  const limite = new Date(Date.now() - NF_LEASE_MIN * 60 * 1000).toISOString();
  return `or=(nf_emitindo_em.is.null,nf_emitindo_em.lt.${limite})`;
}

function _fmtBR(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
  catch (e) { return String(iso); }
}

/**
 * @param {object} opts
 *   { orderId }  -> checa UMA venda so, ignorando idade/repescagem (botao do painel)
 *   { dias, max, idadeMinHoras, repescarHoras } -> sobrescreve os defaults do cron
 */
async function rotinaChecarCanceladasML(opts = {}) {
  const lcp = require('./lixasCombinarPendentes');
  const out = { checadas: 0, canceladas: 0, alertas: 0, candidatas: 0, erros: [], detalhes: [] };

  if (!lcp.configurado()) { out.erro = 'supabase_nao_configurado'; return out; }

  // ── Monta a lista de alvos ────────────────────────────────────────────
  // Idade minima EFETIVA do cancelamento: o override ?idadeMinHoras da rota manual
  // vale tambem na decisao de consultar o ML la embaixo — senao idadeMinHoras=0
  // selecionava a venda nova e depois pulava a checagem dela mesmo assim.
  let _idadeMinCancelH = CANCELADAS_IDADE_MIN_H;
  if (opts.idadeMinHoras !== undefined && !Number.isNaN(Number(opts.idadeMinHoras))) {
    _idadeMinCancelH = Number(opts.idadeMinHoras);
  }
  let alvos = [];

  if (opts.orderId) {
    // Modo "1 venda" (botao 🔄 Verificar ML). Sem filtro de idade/repescagem:
    // voce clicou, entao consulta o ML agora.
    const r = await lcp.buscar(String(opts.orderId));
    if (!r.ok || !r.data) { out.erro = 'venda_nao_encontrada'; return out; }
    alvos = [r.data];
  } else {
    const dias = Number(opts.dias) || CANCELADAS_DIAS;
    // Pagina a janela toda: com limit unico, listarPendentes devolve as 500 MAIS NOVAS
    // (data_venda DESC) e as vendas antigas nunca entram na ordenacao — ficariam em
    // Pendentes mesmo depois de etiquetadas/postadas. Linhas ja resolvidas ocupam essa
    // cota, entao o teto e atingido mais rapido do que parece.
    const PAG = 500;
    let lista = [];
    for (let pg = 0; pg < 20; pg++) {
      const r = await lcp.listarPendentes({ dias, limit: PAG, offset: pg * PAG });
      // Pagina que falha e indistinguivel de fim de dados se virar array vazio: a
      // rodada terminaria "com sucesso" varrendo so as mais novas, e cancelamentos
      // antigos ficariam invisiveis indefinidamente se a falha persistisse.
      if (!r.ok || !Array.isArray(r.data)) {
        out.erro = `falha lendo a pagina ${pg + 1} das vendas — rodada abortada pra nao varrer parcial`;
        out.erros.push({ erro: out.erro });
        console.error(`[canceladas] 🚨 ${out.erro}`);
        return out;
      }
      lista = lista.concat(r.data);
      if (r.data.length < PAG) break;
    }

    const agora = Date.now();
    // Checagem explicita de undefined (e nao `||`) pra que ?idadeMinHoras=0 e
    // ?repescarHoras=0 funcionem de verdade: 0 significa "sem trava, checa tudo
    // agora". Com `||` o zero cairia no default e a rota nao obedeceria.
    const idadeMinMs = _idadeMinCancelH * 3600 * 1000;
    const repescarMs = (opts.repescarHoras !== undefined && !Number.isNaN(Number(opts.repescarHoras))
      ? Number(opts.repescarHoras) : CANCELADAS_REPESCAR_H) * 3600 * 1000;

    alvos = lista.filter(v => {
      if (v.venda_cancelada_em) return false;                                  // ja sabemos que morreu
      if (!CANCELADAS_STATUS.includes(String(v.status || ''))) return false;
      const nasceu = v.data_venda ? new Date(v.data_venda).getTime() : 0;
      // Entra na rodada se ja passou do limiar de QUALQUER uma das duas checagens
      // (cancelamento ou envio). Dentro do loop cada uma decide se roda.
      const limiarMin = Math.min(idadeMinMs, ENVIO_IDADE_MIN_H * 3600 * 1000);
      if (!nasceu || (agora - nasceu) < limiarMin) return false;               // nova demais pra tudo
      // Repescagem AVALIADA POR TIPO: cada checagem tem seu proprio timestamp.
      // Basta uma das duas estar "vencida" pra venda entrar na rodada.
      const idadeMs2 = agora - nasceu;
      const tCancel = v.ml_status_atualizado_em ? new Date(v.ml_status_atualizado_em).getTime() : 0;
      const tEnvio  = v.ml_envio_checado_em ? new Date(v.ml_envio_checado_em).getTime() : 0;
      const cancelVencido = (idadeMs2 >= idadeMinMs) && (!tCancel || (agora - tCancel) >= repescarMs);
      const envioVencido  = (idadeMs2 >= ENVIO_IDADE_MIN_H * 3600 * 1000)
                            && !v.processado_manual_em && !v.nf_emitida_em
                            // Etiqueta detectada NAO encerra o acompanhamento: o envio
                            // ainda evolui pra shipped/delivered, e sem isso o card
                            // ficaria em "Etiqueta gerada" pra sempre e um alerta
                            // posterior diria "nao despachar" num pacote ja postado.
                            // Para so num status terminal.
                            && !['shipped','delivered','not_delivered','cancelled']
                                 .includes(String(v.ml_shipment_status || '').toLowerCase())
                            && (!tEnvio || (agora - tEnvio) >= ENVIO_REPESCAR_H * 3600 * 1000);
      // Guarda quais checagens estao vencidas: a ordenacao usa SO o relogio delas.
      v._dueCancel = cancelVencido;
      v._dueEnvio  = envioVencido;
      return cancelVencido || envioVencido;
    });

    // Nunca-checado primeiro; depois o checado ha mais tempo. Considera os DOIS
    // relogios: olhando so o de cancelamento, venda nova (que tem os dois nulos)
    // empatava com as demais e a ordem da fonte (mais nova primeiro) decidia — as
    // mais antigas nunca chegavam a ser consultadas quando havia mais candidatas
    // que CANCELADAS_MAX.
    // Considera SO o relogio das checagens que estao vencidas pra esta venda. Olhar
    // um relogio que nunca vai rodar dava prioridade maxima indevida: venda com NF
    // nao faz poll de envio, entao ml_envio_checado_em fica null pra sempre e ela
    // furava a fila das que realmente precisam do envio conferido.
    const _relogio = (v) => {
      const ts = [];
      if (v._dueCancel) ts.push(v.ml_status_atualizado_em ? new Date(v.ml_status_atualizado_em).getTime() : 0);
      if (v._dueEnvio)  ts.push(v.ml_envio_checado_em ? new Date(v.ml_envio_checado_em).getTime() : 0);
      if (ts.length === 0) return 0;
      if (ts.some(t => !t)) return 0;    // checagem devida que nunca rodou -> prioridade
      return Math.min(...ts);            // senao, a mais atrasada das devidas manda
    };
    alvos.sort((a, b) => {
      const d = _relogio(a) - _relogio(b);
      // Desempate entre nunca-checados: venda mais ANTIGA primeiro (a mais proxima
      // de vencer o prazo de postagem).
      if (d !== 0) return d;
      const na = a.data_venda ? new Date(a.data_venda).getTime() : 0;
      const nb = b.data_venda ? new Date(b.data_venda).getTime() : 0;
      return na - nb;
    });

    // COTA SEPARADA. Os dois tipos de checagem competiam pela mesma fatia: um backlog
    // de vendas so-de-cancelamento (todas com relogio zero) empurrava as etiquetas novas
    // pro fim da fila por varias horas, matando a promessa de refresh horario.
    // Reserva metade do lote pro envio; o que sobrar volta pro cancelamento.
    const _max = Number(opts.max) || CANCELADAS_MAX;
    // Com _max=1 (env ou ?max=1), reservar a unica vaga pro envio zerava a fila de
    // cancelamento — e um backlog de envio esconderia indefinidamente um cancelamento
    // pos-NF. Nesse caso as duas alternam por rodada.
    const _alternaEnvio = (new Date().getHours() % 2) === 0;
    const cotaEnvio = _max <= 1 ? (_alternaEnvio ? 1 : 0) : Math.max(1, Math.floor(_max / 2));
    const filaEnvio  = alvos.filter(v => v._dueEnvio).slice(0, cotaEnvio);
    const setEnvio   = new Set(filaEnvio.map(v => String(v.order_id)));
    // Exige _dueCancel: sem isso, um backlog de candidatos so-de-envio ocupava tambem
    // a metade reservada ao cancelamento (e o loop pulava getOrderStatusResumo em todos
    // eles, porque _dueCancel e false), atrasando a deteccao de vendas canceladas.
    const filaCancel = alvos.filter(v => v._dueCancel && !setEnvio.has(String(v.order_id)))
                            .slice(0, _max - filaEnvio.length);
    // Sobra da cota de cancelamento volta pro envio: sem isso, um backlog so-de-envio
    // usava metade do lote e deixava as outras vagas ociosas — etiqueta e postagem
    // levariam varios ciclos horarios a mais por pura contabilidade.
    let selecionados = filaEnvio.concat(filaCancel);
    const sobra = _max - selecionados.length;
    if (sobra > 0) {
      const jaSel = new Set(selecionados.map(v => String(v.order_id)));
      const extras = alvos.filter(v => v._dueEnvio && !jaSel.has(String(v.order_id))).slice(0, sobra);
      selecionados = selecionados.concat(extras);
    }
    alvos = selecionados;
  }

  out.candidatas = alvos.length;
  if (alvos.length === 0) return out;

  // ── Consulta o ML, uma venda por vez ──────────────────────────────────
  for (const v of alvos) {
    const oid = String(v.order_id);
    const agoraIso = new Date().toISOString();

    // getOrderStatusResumo ja e a prova de excecao; o try aqui e cinto+suspensorio
    // pra garantir que UMA venda problematica nunca derrube a rodada inteira.
    const idadeMs = v.data_venda ? (Date.now() - new Date(v.data_venda).getTime()) : Infinity;
    // Respeita a flag de "vencida" calculada no filtro. Sem isso, uma venda escolhida
    // SO porque o envio venceu ainda consultava o cancelamento (a idade dela passa das
    // 24h de qualquer jeito) e carimbava ml_status_atualizado_em toda hora — anulando o
    // intervalo de 6h e dobrando o trafego no ML. Vale o inverso tambem.
    // No modo 1-venda (botao Verificar ML) segue incondicional: voce clicou, checa tudo.
    const podeCancelamento = !!opts.orderId || (v._dueCancel && idadeMs >= (_idadeMinCancelH * 3600 * 1000));
    const podeEnvio        = !!opts.orderId || (v._dueEnvio  && idadeMs >= (ENVIO_IDADE_MIN_H * 3600 * 1000));

    let st;
    if (podeCancelamento) {
      try { st = await ml.getOrderStatusResumo(oid); }
      catch (e) { st = { ok: false, erro: e.message }; }
    } else {
      // Venda nova demais pra checagem de cancelamento, mas o envio pode ser olhado:
      // segue como "viva" e cai no ramo de baixo, que so mexe no shipment.
      st = { ok: true, status: null, cancelada: false, _soEnvio: true };
    }

    out.checadas++;

    if (!st.ok) {
      // NAO abandona a venda: carimba o relogio do cancelamento (senao ela volta com
      // prioridade maxima toda hora e ocupa as vagas reservadas ao envio pra sempre) e
      // segue como "viva" pra que a checagem de ENVIO ainda aconteca nesta rodada.
      out.erros.push({ order_id: oid, erro: st.erro });
      console.warn(`[canceladas] order ${oid} nao consegui checar o cancelamento: ${st.erro} — sigo so com o envio`);
      try { await lcp.atualizarVenda(oid, { ml_status_atualizado_em: agoraIso }); } catch (_) {}
      st = { ok: true, status: v.ml_status || null, cancelada: false, _soEnvio: true, _statusIndeterminado: st.erro || 'falha lendo status' };
      await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
    }

    if (!st.cancelada) {
      // Viva. Carimba a checagem (sai da fila pelas proximas 6h) e, de quebra,
      // atualiza o ENVIO — e o que o painel usa pra tirar da frente o que ja tem
      // etiqueta/foi postado. So consulta quando ainda vale a pena:
      //   - ja detectamos etiqueta antes -> nao pergunta mais (nao volta atras)
      //   - ja tem NF emitida -> o painel ja considera resolvida por outro caminho
      // Assim o custo extra fica so nas vendas que realmente estao em aberto.
      // So carimba o timestamp do CANCELAMENTO quando ele foi realmente consultado.
      // Carimbar numa passada so-de-envio fazia a repescagem achar que o
      // cancelamento tinha sido conferido, adiando a 1a checagem real.
      const campos = {};
      if (!st._soEnvio) {
        campos.ml_status = st.status;
        campos.ml_status_atualizado_em = agoraIso;
      }
      // Alinhado com a selecao: etiqueta em cache NAO encerra o poll (o envio ainda
      // evolui pra shipped/delivered). Antes, a selecao escolhia a linha toda hora e a
      // execucao pulava — ml_shipment_status congelava em ready_to_ship pra sempre.
      const _stEnv = String(v.ml_shipment_status || '').toLowerCase();
      const _envTerminal = ['shipped','delivered','not_delivered','cancelled'].includes(_stEnv);
      if (podeEnvio && !v.nf_emitida_em && !v.processado_manual_em && !_envTerminal) {
        try {
          const env = await ml.getEnvioResumo(oid);
          campos.ml_envio_checado_em = agoraIso;
          if (env && env.ok) {
            campos.ml_shipment_status = env.status || null;
            campos.ml_shipment_substatus = env.substatus || null;
            if (env.temEtiqueta) {
              // preserva o carimbo ORIGINAL: quando a etiqueta saiu importa mais que
              // quando a gente reconferiu.
              if (!v.ml_etiqueta_em) campos.ml_etiqueta_em = agoraIso;
              // TIRA dos status automaticos. So o marcador nao basta: o painel ja
              // mostrava a venda como resolvida, mas o lerRespostas continuava
              // processando mensagem nova e podia reescrever o pedido e emitir NF de
              // algo ja etiquetado/postado. 'processado' e terminal pra essas rotinas.
              if (['aguardando_resposta','cliente_respondeu','cliente_confirmou_pedido','aguardando_bling'].includes(String(v.status || ''))) {
                campos.status = 'processado';
                console.log(`[canceladas] order ${oid} etiqueta detectada — status ${v.status} -> processado (sai do automatico)`);
              }
              // QUARENTENA que descobre etiqueta: fecha o cancelamento e cria o alerta
              // AGORA. Antes ficava esperando o relogio do cancelamento vencer (ate 6h)
              // mostrando so o card generico, sem botao de reconhecer.
              if (String(v.status || '') === 'cancelada_quarentena') {
                campos.status = 'venda_cancelada';
                campos.venda_cancelada_em = agoraIso;
                campos.alerta_pos_venda = (
                  `CANCELADA NO ML com etiqueta ja gerada (${env.status || '?'}). NAO DESPACHAR. ` +
                  `Conferir devolucao/estorno no ML e a NF/pedido no Bling.`
                ).slice(0, 500);
                console.error(`[canceladas] 🚨🚨 order ${oid} quarentena resolvida: CANCELADA COM ETIQUETA — alerta criado`);
              }
              console.log(`[canceladas] order ${oid} ja tem etiqueta no ML (${env.status}/${env.substatus || '-'}) — sai do bolsao de pendentes`);
            }
            // Quarentena com envio agora CONHECIDO e SEM etiqueta: o cancelamento ja
            // estava confirmado, so faltava saber da etiqueta. Finaliza aqui em vez de
            // deixar a venda no balde urgente ate o relogio do cancelamento vencer (6h+).
            if (!env.temEtiqueta && String(v.status || '') === 'cancelada_quarentena') {
              campos.status = 'venda_cancelada';
              campos.venda_cancelada_em = agoraIso;
              console.log(`[canceladas] order ${oid} quarentena resolvida: cancelada SEM etiqueta — finalizada sem alerta`);
            }
          } else {
            // getEnvioResumo NAO lanca: devolve { ok:false }. Sem tratar aqui, um token
            // sem permissao de shipments falharia em silencio e as vendas ficariam em
            // Pendentes pra sempre sem ninguem saber por que.
            const msg = (env && (env.dica || env.erro)) || 'falha desconhecida lendo envio';
            out.erros.push({ order_id: oid, erro: `envio: ${msg}` });
            console.warn(`[canceladas] order ${oid} nao consegui ler o envio: ${msg}`);
          }
        } catch (e) {
          out.erros.push({ order_id: oid, erro: `envio: ${e.message}` });
          console.warn(`[canceladas] order ${oid} excecao lendo o envio: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
      }
      if (Object.keys(campos).length === 0) { await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS)); continue; }
      // atualizarVenda devolve { ok:false } em vez de lancar. Sem conferir, uma coluna
      // nao migrada ou falha transiente do REST passaria batida: a rodada diria que a
      // etiqueta foi detectada, mas nada teria sido gravado e a venda seguiria pendente.
      const updV = await lcp.atualizarVenda(oid, campos);
      if (!updV.ok) {
        out.erros.push({ order_id: oid, erro: 'falhou gravar o status de envio/checagem no Supabase' });
        console.error(`[canceladas] order ${oid} NAO consegui gravar ${Object.keys(campos).join(',')} no Supabase`);
      }
      out.detalhes.push({ order_id: oid, ml_status: st.status, cancelada: false,
                          shipment: campos.ml_shipment_status || null, etiqueta: !!campos.ml_etiqueta_em,
                          gravado: !!updV.ok,
                          // indeterminado: NAO da pra dizer "venda ativa" — o status do
                          // pedido nem chegou a ser lido. O painel usa isso pra avisar
                          // em vez de liberar o processamento.
                          indeterminado: !!st._statusIndeterminado,
                          aviso: st._statusIndeterminado
                            ? `Nao consegui ler o status do pedido no ML (${st._statusIndeterminado}). O envio foi conferido, mas NAO da pra afirmar que a venda esta ativa.`
                            : undefined });
      await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
      continue;
    }

    // ── CANCELADA ───────────────────────────────────────────────────────
    // Se a etiqueta ficou imprimivel DEPOIS do ultimo poll e o cliente cancelou antes
    // do proximo, o marcador em cache estaria vazio e o alerta nao sairia — mesmo com o
    // pacote possivelmente ja impresso. Como o ramo de cima (!st.cancelada) nao roda
    // aqui, confere o envio agora, uma vez, antes de montar o jaFeito.
    // processado_manual_em ja e evidencia suficiente pro jaFeito: nao adia o
    // cancelamento esperando um envio que pode nao existir (pedido sem shipping
    // resolvivel adiaria a linha em TODA rodada, e o aviso de cancelar a NF emitida
    // por fora nunca sairia).
    if (!v.ml_etiqueta_em && !v.nf_emitida_em && !v.bling_editado_em && !v.processado_manual_em) {
      let envFalhou = null;
      try {
        const envC = await ml.getEnvioResumo(oid);
        if (envC && envC.ok) {
          if (envC.temEtiqueta) {
            v.ml_etiqueta_em = agoraIso;
            v.ml_shipment_status = envC.status || null;
            console.warn(`[canceladas] order ${oid} cancelada, mas a etiqueta JA existia (${envC.status}) — vai gerar alerta`);
          }
        } else {
          envFalhou = (envC && (envC.dica || envC.erro)) || 'falha lendo envio';
        }
      } catch (e) {
        envFalhou = e.message;
      }
      await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));

      // NAO finaliza como cancelamento sem alerta enquanto o envio for desconhecido:
      // gravar venda_cancelada_em tiraria a venda das proximas rodadas PARA SEMPRE, e se
      // a etiqueta ja tivesse sido impressa ninguem seria avisado de parar o despacho.
      // Deixa pra proxima passada (o cancelamento nao vai embora sozinho).
      if (envFalhou) {
        // QUARENTENA: grava status + ml_status AGORA (tira a venda do fluxo automatico
        // — a escada, que roda a cada 30 min, ainda selecionava a linha e podia montar
        // e emitir NF de um pedido cancelado). Mas NAO grava venda_cancelada_em: e ele
        // que exclui a linha das proximas rodadas, e ainda falta determinar o alerta.
        let quarentenaOk = false;
        try {
          // Releitura antes de gravar: o cron e o botao "Verificar ML" podem estar
          // rodando na mesma venda. Se o outro ja finalizou o cancelamento, sobrescrever
          // com quarentena deixaria a linha num estado impossivel — venda_cancelada_em
          // preenchido (exclui do filtro pra sempre) com status de quarentena (o painel
          // segue mostrando como pendente de conferencia).
          const _relido = await lcp.buscar(oid);
          if (_relido && _relido.ok && _relido.data && _relido.data.venda_cancelada_em) {
            console.log(`[canceladas] order ${oid} cancelamento ja finalizado por outra execucao — nao sobrescrevo com quarentena`);
            await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
            continue;
          }
          const rq = await lcp.atualizarVenda(oid, {
            // Status PROPRIO de quarentena: 'venda_cancelada' sairia do CANCELADAS_STATUS
            // e a linha nunca voltaria pra tentar o envio de novo — o alerta de nao
            // despachar nunca sairia. 'cancelada_quarentena' esta na lista e o
            // classificador trata como pendente humano.
            status: 'cancelada_quarentena',
            ml_status: st.status,
            ml_status_atualizado_em: agoraIso
          }, { somenteSe: `venda_cancelada_em=is.null&${_semReservaAtiva()}` });
          // PostgREST devolve ok:true com data vazio quando o predicado nao casa (lease
          // fresco). Exigir 1 linha: senao a rota diria "saiu do fluxo automatico" com o
          // status intacto e o emissor reservado seguindo pro gerarNFe.
          quarentenaOk = !!(rq && rq.ok && Array.isArray(rq.data) && rq.data.length === 1);
          if (rq && rq.ok && Array.isArray(rq.data) && rq.data.length === 0) {
            console.warn(`[canceladas] order ${oid} quarentena NAO aplicada: ha emissao de NF em curso — adiado`);
          }
        } catch (e) {
          console.error(`[canceladas] order ${oid} falhei ate na quarentena: ${e.message}`);
        }
        // atualizarVenda devolve {ok:false} em vez de lancar. Sem conferir, a rodada
        // diria "em quarentena" com a linha ainda no status original — e a escada
        // poderia montar e faturar um pedido ja cancelado.
        if (!quarentenaOk) {
          console.error(`[canceladas] order ${oid} 🚨 CANCELADA e a QUARENTENA NAO GRAVOU — venda segue elegivel ao automatico`);
          out.erros.push({ order_id: oid, erro: `cancelada no ML e FALHOU gravar a quarentena — venda ainda no fluxo automatico, tratar na mao` });
        } else {
          out.erros.push({ order_id: oid, erro: `cancelada, mas nao confirmei o envio (${envFalhou}) — em quarentena, alerta pendente` });
        }
        console.error(`[canceladas] order ${oid} CANCELADA e envio desconhecido (${envFalhou}) — nao finalizo agora`);
        // PRECISA entrar em detalhes: o botao "Verificar ML" le detalhes[0] e, sem isso,
        // o painel mostraria "✅ Venda ativa" pra um pedido que o ML acabou de confirmar
        // como CANCELADO — o oposto do que a checagem descobriu.
        out.detalhes.push({ order_id: oid, ml_status: st.status, cancelada: true,
                            adiado: true, quarentena: quarentenaOk, alerta: null, buyer: v.buyer_nome || null,
                            aviso: quarentenaOk
                              ? `cancelada no ML. Envio nao confirmado (${envFalhou}) — venda posta em QUARENTENA: ja saiu do fluxo automatico e sera reconferida ate dar pra dizer se a etiqueta saiu.`
                              : `cancelada no ML, envio nao confirmado (${envFalhou}) e a quarentena NAO gravou — a venda continua no fluxo automatico. Tratar na mao.` });
        continue;
      }
    }
    const jaFeito = [];
    if (v.nf_emitida_em) jaFeito.push(`NF ${v.nf_numero || '?'}/${v.nf_serie || '?'} emitida em ${_fmtBR(v.nf_emitida_em)}`);
    if (v.bling_editado_em) jaFeito.push(`pedido Bling ${v.bling_pedido_id || '?'} montado em ${_fmtBR(v.bling_editado_em)}`);
    // Conclusao manual tambem e trabalho ja feito: o cenario tipico do botao
    // "✓ Processado" e NF emitida POR FORA do painel. Sem isso, um cancelamento
    // posterior no ML nao geraria alerta e a venda cairia calada no bolsao de
    // resolvidas — ninguem seria avisado pra parar o despacho e estornar a nota.
    if (!v.nf_emitida_em && !v.bling_editado_em && v.processado_manual_em) {
      jaFeito.push(`marcada como concluida na mao em ${_fmtBR(v.processado_manual_em)} (a NF pode ter saido por fora do painel)`);
    }
    // Etiqueta gerada/postado tambem e trabalho feito: o pacote pode ja estar montado
    // na bancada ou a caminho do posto. Se o cancelamento chegar depois disso e nao
    // gerar alerta, a venda cai calada no bolsao de resolvidas e o pacote sai.
    if (v.ml_etiqueta_em) {
      const stEnv = String(v.ml_shipment_status || '').toLowerCase();
      jaFeito.push(['shipped', 'delivered', 'not_delivered'].includes(stEnv)
        ? `pacote JA POSTADO no ML (${v.ml_shipment_status}) — conferir devolucao/estorno`
        : `etiqueta ja gerada no ML em ${_fmtBR(v.ml_etiqueta_em)}`);
    }

    const campos = {
      status: 'venda_cancelada',
      ml_status: st.status,
      ml_status_atualizado_em: agoraIso,
      venda_cancelada_em: agoraIso
    };

    if (jaFeito.length > 0) {
      campos.alerta_pos_venda = (
        `CANCELADA NO ML DEPOIS DE: ${jaFeito.join(' + ')}. NAO DESPACHAR. ` +
        `Conferir a NF (cancelar/estornar) e o pedido no Bling.` +
        (st.statusDetail ? ` Motivo ML: ${st.statusDetail}.` : '')
      ).slice(0, 500);
      out.alertas++;
      console.error(`[canceladas] 🚨🚨 order ${oid} CANCELADA APOS ${jaFeito.join(' + ')} — cliente ${v.buyer_nome || '?'}`);
    } else {
      console.log(`[canceladas] order ${oid} cancelada no ML (nada montado/emitido ainda) — cliente ${v.buyer_nome || '?'}`);
    }

    // EXCLUSAO MUTUA NO PROPRIO PATCH. Checar `v.nf_emitindo_em` nao bastava: esse
    // valor vem do snapshot lido ao montar `alvos`, ANTES das chamadas ao ML — se a
    // emissao reservar a linha nesse intervalo, o cron veria null e gravaria por cima
    // com o gerarNFe em curso. O filtro abaixo faz o Postgres decidir: so grava se nao
    // houver reserva nos ultimos 2 min.
    const upd = await lcp.atualizarVenda(oid, campos, { somenteSe: _semReservaAtiva() });
    if (upd.ok && Array.isArray(upd.data) && upd.data.length === 0) {
      console.warn(`[canceladas] order ${oid} cancelada, mas ha emissao de NF em curso — adio o registro pra proxima rodada`);
      out.erros.push({ order_id: oid, erro: 'cancelada durante emissao de NF em curso — adiado' });
      // (4) precisa entrar em detalhes: o "Verificar ML" le detalhes[0] e, sem entrada,
      // responde cancelada:false — o painel diria "venda ativa" logo apos o ML confirmar
      // o cancelamento.
      out.detalhes.push({ order_id: oid, ml_status: st.status, cancelada: true,
                          adiado: true, gravado: false, quarentena: false, buyer: v.buyer_nome || null,
                          aviso: 'cancelada no ML, mas ha uma emissao de NF em curso — o registro foi adiado pra proxima rodada. NAO despache.' });
      await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
      continue;
    }
    if (!upd.ok) {
      // Fail closed: sem gravar, a linha segue no status original e pode ser faturada.
      // Nao conta como cancelada nesta rodada — a proxima tenta de novo.
      out.erros.push({ order_id: oid, erro: 'FALHOU gravar o cancelamento no Supabase — venda ainda no fluxo automatico, tratar na mao' });
      console.error(`[canceladas] order ${oid} 🚨 cancelamento NAO gravou — venda segue elegivel ao automatico`);
      // PRECISA aparecer em detalhes: o "Verificar ML" le detalhes[0] e, sem entrada,
      // cai em {} e responde cancelada:false — o painel diria "Venda ativa" logo depois
      // de o ML confirmar o cancelamento, convidando a despachar.
      out.detalhes.push({ order_id: oid, ml_status: st.status, cancelada: true,
                          gravado: false, quarentena: false, adiado: true, buyer: v.buyer_nome || null,
                          aviso: 'cancelada no ML, mas a gravacao no banco FALHOU — a venda continua no fluxo automatico. Tratar na mao.' });
      await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
      continue;
    }

    out.canceladas++;
    out.detalhes.push({
      order_id: oid,
      ml_status: st.status,
      cancelada: true,
      alerta: campos.alerta_pos_venda || null,
      buyer: v.buyer_nome || null
    });

    await new Promise(r => setTimeout(r, CANCELADAS_PAUSA_MS));
  }

  if (out.canceladas > 0 || out.alertas > 0 || out.erros.length > 0) {
    console.log(`[canceladas] rodada: ${out.checadas} checadas · ${out.canceladas} canceladas · ${out.alertas} COM ALERTA · ${out.erros.length} erro(s)`);
  }
  return out;
}


module.exports = { rotinaACombinar, rotinaLerRespostas, forcarOrder, processarAutoEmissao, recuperarPendentes, recuperarFalsosProcessados, rotinaEscadaIndisponivel, rotinaChecarCanceladasML, HABILITADO, TEXTO };


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
  if (!r || !r.retry) _retry.removerDaFila(orderIdW);
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

  // Guarda 1.5 — VENDA AINDA VIVA NO ML (fecha a corrida com o cron de cancelamento).
  // O leitor roda a cada 2 min; a varredura de cancelamento, de hora em hora. Numa
  // janela de 30 dias existe backlog que o leitor ve ANTES da primeira passada de
  // cancelamento — e uma venda ja cancelada viraria NF irreversivel. Ampliar a janela
  // do cron so descobre isso depois; a unica guarda que fecha a corrida e perguntar
  // ao ML agora, logo antes de emitir. Custo: 1 chamada por emissao.
  // Falha de consulta NAO bloqueia (nao inventa problema onde talvez nao haja):
  // so bloqueia quando o ML confirma que a venda morreu.
  try {
    const st = await ml.getOrderStatusResumo(String(orderId));
    if (st && st.ok && st.cancelada) {
      // Antes de gravar venda_cancelada_em (que exclui a linha das proximas rodadas
      // PARA SEMPRE), confere o envio: etiqueta impressa desde o ultimo poll precisa
      // virar alerta de nao despachar. Mesma logica ja aplicada no cron — este escritor
      // olhava so o status do pedido.
      const campos = {
        status: 'venda_cancelada',
        ml_status: st.status,
        ml_status_atualizado_em: new Date().toISOString(),
        venda_cancelada_em: new Date().toISOString()
      };
      // processado_manual_em ja prova que houve trabalho (NF pode ter saido por fora),
      // e o marcador exclui a venda da repescagem de envio — consultar o shipment aqui
      // so cria a chance de cair na quarentena e ADIAR o alerta que ja e devido.
      if (venda.processado_manual_em) {
        campos.venda_cancelada_em = new Date().toISOString();
        campos.alerta_pos_venda = (
          `CANCELADA NO ML apos conclusao manual (${_fmtBR(venda.processado_manual_em)}). NAO DESPACHAR. ` +
          `A NF pode ter sido emitida por fora do painel — conferir e cancelar/estornar no Bling.`
        ).slice(0, 500);
        console.error(`[auto-emissao] 🚨 order ${orderId} cancelada apos conclusao manual — alerta gravado`);
      } else if (!venda.ml_etiqueta_em && !venda.nf_emitida_em && !venda.bling_editado_em) {
        try {
          const envG = await ml.getEnvioResumo(String(orderId));
          if (envG && envG.ok && envG.temEtiqueta) {
            campos.ml_etiqueta_em = new Date().toISOString();
            campos.ml_shipment_status = envG.status || null;
            campos.alerta_pos_venda = (`CANCELADA NO ML com etiqueta ja gerada (${envG.status}). NAO DESPACHAR. ` +
              `Conferir devolucao/estorno no ML e o pedido no Bling.`).slice(0, 500);
            console.error(`[auto-emissao] 🚨 order ${orderId} cancelada COM etiqueta ja gerada — alerta gravado`);
          } else if (envG && !envG.ok) {
            // Envio indeterminado: NAO finaliza agora. Sem gravar venda_cancelada_em a
            // linha volta na proxima rodada; gravar cego perderia o alerta pra sempre.
            console.error(`[auto-emissao] order ${orderId} cancelada mas envio indeterminado (${envG.erro}) — quarentena`);
            // Persiste a quarentena ANTES de sair: deixar em cliente_confirmou_pedido
            // permitiria a recuperacao do confirmou-strand pegar a venda de novo e,
            // com uma falha transiente na consulta de status, montar e emitir NF de um
            // pedido ja cancelado.
            // Confere o retorno: atualizarVenda devolve {ok:false} sem lancar. Se a
            // quarentena nao gravou, a linha segue em cliente_confirmou_pedido/
            // aguardando_bling e volta pela rehidratacao — pede RETRY em vez de sair.
            let qOk = false;
            try {
              const _relA = await lcp.buscar(orderId);
              if (_relA && _relA.ok && _relA.data && _relA.data.venda_cancelada_em) {
                console.log(`[auto-emissao] order ${orderId} cancelamento ja finalizado por outra execucao — nao sobrescrevo`);
                return { falha: true, motivo: 'venda_cancelada_no_ml' };
              }
              const rq = await lcp.atualizarVenda(orderId, {
                status: 'cancelada_quarentena',
                ml_status: st.status,
                ml_status_atualizado_em: new Date().toISOString()
              }, { somenteSe: `venda_cancelada_em=is.null&${_semReservaAtiva()}` });
              qOk = !!(rq && rq.ok && Array.isArray(rq.data) && rq.data.length === 1);
            } catch (e2) { console.error(`[auto-emissao] order ${orderId} falhei na quarentena: ${e2.message}`); }
            if (!qOk) console.error(`[auto-emissao] order ${orderId} 🚨 quarentena NAO gravou — mantendo na fila`);
            return { falha: true, retry: !qOk, motivo: 'venda_cancelada_no_ml_envio_indeterminado' };
          }
        } catch (e) {
          console.error(`[auto-emissao] order ${orderId} cancelada e falhei ao conferir envio (${e.message}) — quarentena`);
          let qOk2 = false;
          try {
            const _relB = await lcp.buscar(orderId);
            if (_relB && _relB.ok && _relB.data && _relB.data.venda_cancelada_em) {
              console.log(`[auto-emissao] order ${orderId} cancelamento ja finalizado por outra execucao — nao sobrescrevo`);
              return { falha: true, motivo: 'venda_cancelada_no_ml' };
            }
            const rq2 = await lcp.atualizarVenda(orderId, {
              status: 'cancelada_quarentena',
              ml_status: st.status,
              ml_status_atualizado_em: new Date().toISOString()
            }, { somenteSe: `venda_cancelada_em=is.null&${_semReservaAtiva()}` });
            qOk2 = !!(rq2 && rq2.ok && Array.isArray(rq2.data) && rq2.data.length === 1);
          } catch (e2) { console.error(`[auto-emissao] order ${orderId} falhei na quarentena: ${e2.message}`); }
          if (!qOk2) console.error(`[auto-emissao] order ${orderId} 🚨 quarentena NAO gravou — mantendo na fila`);
          return { falha: true, retry: !qOk2, motivo: 'venda_cancelada_no_ml_envio_indeterminado' };
        }
      }
      // Respeita a reserva, como os ramos de quarentena acima: sem isso, este PATCH
      // gravava o cancelamento com uma emissao ja autorizada em curso — e a rota
      // reservada seguia direto pro gerarNFe.
      const updG = await lcp.atualizarVenda(orderId, campos, { somenteSe: _semReservaAtiva() });
      if (updG && updG.ok && Array.isArray(updG.data) && updG.data.length === 0) {
        console.warn(`[auto-emissao] order ${orderId} cancelada, mas ha emissao de NF em curso — nao gravo agora`);
        return { falha: true, retry: true, motivo: 'venda_cancelada_no_ml_emissao_em_curso' };
      }
      if (!updG || !updG.ok) {
        // Nao gravou: a linha segue em cliente_confirmou_pedido/aguardando_bling e
        // volta pela rehidratacao. Pede RETRY pra nao sumir da fila achando resolvido.
        console.error(`[auto-emissao] order ${orderId} 🚨 cancelamento NAO gravou — mantendo na fila`);
        return { falha: true, retry: true, motivo: 'venda_cancelada_no_ml_gravacao_falhou' };
      }
      console.warn(`[auto-emissao] order ${orderId} CANCELADA no ML (${st.status}) — emissao abortada antes de montar/emitir`);
      return { falha: true, motivo: 'venda_cancelada_no_ml' };
    }
  } catch (e) {
    console.warn(`[auto-emissao] order ${orderId} nao consegui checar status ML antes de emitir (segue): ${e.message}`);
  }

  // Guarda 1.6 — ETIQUETA JA GERADA. Mover o status pra 'processado' na deteccao nao
  // basta: a fase 2 do lerRespostas varre 'processado', e uma mensagem nova do cliente
  // devolve a linha pra precisa_atencao_humano -> revisarAtencaoHumana -> de volta ao
  // fluxo. O marcador tem que valer como terminal aqui tambem.
  // processado_manual_em entra junto: a fase 2 do lerRespostas devolve linha
  // 'processado' pra atencao humana quando o cliente escreve, e o revisarAtencaoHumana
  // pode reengajar — chegando aqui com NF ja emitida POR FORA.
  if (venda.ml_etiqueta_em || venda.processado_manual_em) {
    const motivo = venda.ml_etiqueta_em ? 'etiqueta_ja_gerada' : 'conclusao_manual';
    // Confere o retorno: atualizarVenda devolve {ok:false} sem lancar. Sem isso, o
    // wrapper apagaria a entrada da fila com a linha ainda em aguardando_resposta/
    // cliente_confirmou_pedido/precisa_atencao_humano — e como classificarVenda so
    // reconhece a conclusao manual quando o status e 'processado', a venda ficaria
    // presa em Pendentes pra sempre, sem nada agendado pra consertar.
    let okTerm = false;
    try {
      const rt = await lcp.atualizarVenda(orderId, { status: 'processado' });
      okTerm = !!(rt && rt.ok);
    } catch (e) { console.error(`[auto-emissao] order ${orderId} excecao gravando status terminal: ${e.message}`); }
    if (!okTerm) {
      // retry:true so IMPEDE o wrapper de apagar uma entrada existente — se a chamada
      // veio direto do lerRespostas (sem entrada na fila), nada seria agendado e a
      // venda ficaria no status ativo indefinidamente. Enfileira explicitamente.
      console.error(`[auto-emissao] order ${orderId} 🚨 nao gravou o status terminal (${motivo}) — enfileirando restauracao`);
      try { _retry.enfileirarRestauracao({ orderId, venda, iaResult, graosResult }); }
      catch (e) { console.error(`[auto-emissao] order ${orderId} falhei ao enfileirar: ${e.message}`); }
    }
    console.warn(`[auto-emissao] order ${orderId} terminal (${motivo}) — nao monto nem emito`);
    return { falha: true, retry: !okTerm, motivo };
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
      return await _retry.agendarOuEscalarRetry({ orderId, venda, iaResult, graosResult, lcp, erro: busca.erro });
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
