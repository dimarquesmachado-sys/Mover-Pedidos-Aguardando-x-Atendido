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
