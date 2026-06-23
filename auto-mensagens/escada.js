'use strict';

/**
 * Escada de reengajamento + trava de prazo — lixas A COMBINAR.
 *
 * Extraído de fluxos.js (modularização). Roda via cron (index.js chama
 * fluxos.rotinaEscadaIndisponivel, que reexporta esta função).
 *
 * Pra cada pedido travado em grão INDISPONÍVEL ainda sem NF: avisa a cliente
 * (escada de até MAX_AVISOS nudges) e, na hora do corte da coleta do dia,
 * troca pelo grão mais próximo + emite a NF.
 *
 * É autocontida: faz os requires pesados (lcp, blingPedidos, substituicao,
 * prazoPostagem, lixasService) lazy lá dentro. Do escopo do módulo usa só
 * ml, tracker e a flag AUTO_EMITIR_HABILITADO (reproduzidos abaixo).
 */

const ml = require('./mlApi');
const tracker = require('./supabaseTracker');

// a escada EMITE NF -> respeita o mesmo portao da auto-emissao (mesma leitura do fluxos.js)
const AUTO_EMITIR_HABILITADO = (process.env.LIXAS_AUTO_EMITIR_NF_HABILITADO || 'false').toLowerCase() === 'true';

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

module.exports = { rotinaEscadaIndisponivel };
