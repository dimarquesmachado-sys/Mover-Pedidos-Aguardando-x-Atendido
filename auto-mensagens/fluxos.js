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

const HABILITADO = (process.env.AUTO_MSG_GIRASSOL_HABILITADO || 'false').toLowerCase() === 'true';
const TEXTO = process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '';

// Janela de busca de vendas: 30 min pra trás (pega vendas dos últimos minutos)
const JANELA_MIN = Number(process.env.AUTO_MSG_JANELA_MIN || 30);

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
        // 4. Envia mensagem
        const buyerId = detalhe.buyer?.id;
        const packId = detalhe.pack_id;
        console.log(`[auto-mensagens] 📨 Enviando msg pra order ${orderId} (buyer ${buyerId}, pack ${packId || 'null'})`);

        const r = await ml.enviarMensagem({
          packId, orderId, buyerId, texto: TEXTO
        });
        if (r.ok) {
          const modStatus = r.moderation_status || 'unknown';
          const foiModerado = ['IN_MODERATION', 'rejected', 'REJECTED'].includes(modStatus);
          if (foiModerado) stats.moderados++;
          else stats.enviados++;

          await tracker.registrar({
            orderId, packId, buyerId,
            tipo: 'a_combinar', textoEnviado: TEXTO,
            messageIdMl: r.message_id, status: foiModerado ? 'moderado' : 'enviado',
            erroDetalhe: foiModerado ? `moderation=${modStatus}` : null,
            loja: 'GIRASSOL'
          });
          console.log(`[auto-mensagens] ✅ Order ${orderId} → status=${foiModerado ? 'moderado' : 'enviado'} (msg_id=${r.message_id})`);
        } else {
          stats.erros++;
          await tracker.registrar({
            orderId, packId, buyerId,
            tipo: 'a_combinar', textoEnviado: TEXTO,
            messageIdMl: null, status: 'erro', erroDetalhe: `${r.status}: ${r.erro}`.slice(0, 500),
            loja: 'GIRASSOL'
          });
          console.error(`[auto-mensagens] ❌ Order ${orderId} → erro ${r.status}: ${r.erro}`);
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

module.exports = { rotinaACombinar, forcarOrder, HABILITADO, TEXTO };

/**
 * Força processamento de UMA venda específica (ignora janela de tempo)
 * Usa pra mandar mensagem em vendas antigas ou de teste.
 */
async function forcarOrder(orderId) {
  const stats = { orderId, etapa: 'inicio' };
  try {
    if (!TEXTO) {
      return { ok: false, erro: 'AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR vazio', stats };
    }
    if (!tracker.configurado()) {
      return { ok: false, erro: 'Supabase nao configurado', stats };
    }

    // 1. Já enviou?
    stats.etapa = 'checar_duplicado';
    if (await tracker.jaEnviou(orderId)) {
      return { ok: false, erro: 'Ja enviou pra esta venda anteriormente', stats };
    }

    // 2. Busca detalhe completo
    stats.etapa = 'buscar_detalhe';
    const detalhe = await ml.getOrderDetalhe(orderId);
    stats.status_venda = detalhe.status;
    stats.buyer_id = detalhe.buyer?.id;
    stats.pack_id = detalhe.pack_id;

    // 3. Tem A COMBINAR?
    stats.etapa = 'verificar_a_combinar';
    const temACombinar = ml.temVariacaoACombinar(detalhe);
    stats.tem_a_combinar = temACombinar;
    if (!temACombinar) {
      return { ok: false, erro: 'Venda NAO tem variacao A COMBINAR', stats };
    }

    // 4. Envia
    stats.etapa = 'enviar';
    const buyerId = detalhe.buyer?.id;
    const packId = detalhe.pack_id;
    console.log(`[auto-mensagens FORCAR] order=${orderId} buyer=${buyerId} pack=${packId || 'null'}`);

    const r = await ml.enviarMensagem({ packId, orderId, buyerId, texto: TEXTO });
    stats.etapa = 'gravar';

    if (r.ok) {
      const modStatus = r.moderation_status || 'unknown';
      const foiModerado = ['IN_MODERATION', 'rejected', 'REJECTED'].includes(modStatus);
      await tracker.registrar({
        orderId, packId, buyerId,
        tipo: 'a_combinar', textoEnviado: TEXTO,
        messageIdMl: r.message_id, status: foiModerado ? 'moderado' : 'enviado',
        erroDetalhe: foiModerado ? `moderation=${modStatus}` : null,
        loja: 'GIRASSOL'
      });
      stats.message_id = r.message_id;
      stats.moderation = modStatus;
      console.log(`[auto-mensagens FORCAR] ✅ order=${orderId} status=${foiModerado ? 'moderado' : 'enviado'}`);
      return { ok: true, enviado: !foiModerado, moderado: foiModerado, stats };
    } else {
      await tracker.registrar({
        orderId, packId, buyerId,
        tipo: 'a_combinar', textoEnviado: TEXTO,
        messageIdMl: null, status: 'erro', erroDetalhe: `${r.status}: ${r.erro}`.slice(0, 500),
        loja: 'GIRASSOL'
      });
      stats.ml_erro = r.erro;
      stats.ml_status = r.status;
      return { ok: false, erro: `ML retornou ${r.status}: ${r.erro}`, stats };
    }
  } catch (e) {
    return { ok: false, erro: e.message, stats };
  }
}
