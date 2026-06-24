'use strict';

/**
 * Rotinas de RECUPERAÇÃO — lixas A COMBINAR.
 *
 * Extraído de fluxos.js (modularização). Duas rotinas chamadas por crons (index.js):
 *   - recuperarFalsosProcessados: conserta vendas marcadas 'processado' na mão sem NF.
 *   - recuperarPendentes: re-registra vendas A COMBINAR que sumiram da tabela.
 *
 * Diferente da escada/forcarOrder, estas dependem de 3 funções internas do fluxos.js
 * (processarAutoEmissao, retentarEmissoesBling, revisarAtencaoHumana). Pra evitar
 * dependência circular, elas chegam por INJEÇÃO: o fluxos.js chama esta fábrica
 * passando as 3, e recebe de volta as rotinas prontas. lcp/lixasService/bp são
 * require lazy interno; do escopo usa só ml e LIMIAR_CONFIANCA_AUTO (abaixo).
 */

const ml = require('./mlApi');
const LIMIAR_CONFIANCA_AUTO = Number(process.env.LIXAS_AUTO_CONFIANCA_MIN || 95);

module.exports = function criarRecuperacao({ processarAutoEmissao, retentarEmissoesBling, revisarAtencaoHumana }) {

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

  return { recuperarFalsosProcessados, recuperarPendentes };
};
