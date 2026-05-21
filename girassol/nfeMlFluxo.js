'use strict';

/**
 * F3 — Envio automático de NF-e (dados fiscais) Bling → Mercado Livre.
 *
 * Problema que resolve:
 *   Às vezes o Bling não transmite os dados fiscais da NF-e para o ML.
 *   O pedido fica travado no ML com a mensagem "Adicione os dados fiscais
 *   para poder emitir a NF-e e entregar o pacote". Sem isso, o ML não gera
 *   a etiqueta de envio.
 *
 * Como funciona:
 *   1. Lista as NF-e AUTORIZADAS (situacao=5) dos últimos dias no Bling.
 *   2. Para cada NF da loja ML (loja.id em ME_LOJA_IDS) ainda não processada:
 *        - pega o detalhe (numeroPedidoLoja + link do XML);
 *        - envia para o ML SOMENTE se o shipment estiver "invoice_pending"
 *          (que é exatamente o estado "faltam dados fiscais");
 *        - se o ML já tiver os dados (não está pendente), pula sem erro.
 *   3. Marca como processada para não reenviar à toa.
 *
 * Trava de segurança: só NF com situacao=5 E com link de XML é enviada.
 * NF travada/rejeitada/com erro não tem situacao=5 nem XML → nunca é enviada.
 */

const { garantirToken, renovarToken } = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');
const {
  getPeriodo,
  getNFesAutorizadas,
  getNFeDetalhe,
  ME_LOJA_IDS,
  jaProcessado,
  marcarProcessado
} = require('./blingApi');
const { enviarNFeParaML } = require('./mlApi');

const MAX_NFE = parseInt(process.env.MAX_NFE_ML || '60');

// Guard para não rodar duas vezes ao mesmo tempo
let _rodando = false;

async function comTokenRenewable(fn) {
  try {
    return await fn(await garantirToken());
  } catch (e) {
    if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') {
      const token = await renovarToken();
      return await fn(token);
    }
    throw e;
  }
}

async function _fluxoNFeML(tokenBling) {
  const { inicial, final } = getPeriodo();
  const lista = await getNFesAutorizadas(tokenBling, inicial, final);
  const batch = lista.slice(0, MAX_NFE);
  console.log(`[F3-NFeML] ${lista.length} NF autorizadas | processando ${batch.length}`);

  let mlToken = null;
  try {
    mlToken = await garantirTokenML();
  } catch (e) {
    console.warn('[F3-NFeML] Sem token ML:', e.message, '— abortando rodada');
    return;
  }

  let enviadas = 0, puladas = 0, ignoradas = 0, semPendencia = 0, erros = 0;

  for (const nfResumo of batch) {
    const nfeId = nfResumo.id;

    // Já tratada hoje?
    if (jaProcessado('F3', nfeId)) { puladas++; continue; }

    // Pega o detalhe (a listagem resumida nem sempre traz loja.id / xml / numeroPedidoLoja)
    let nf = null;
    try {
      nf = await getNFeDetalhe(tokenBling, nfeId);
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') throw e;
      console.error(`[F3-NFeML] Erro ao buscar detalhe NF ${nfeId}:`, e.message);
      erros++;
      continue;
    }
    if (!nf) { ignoradas++; continue; }

    // Filtro 1: precisa ser da loja ML desta empresa
    const lojaId = nf?.loja?.id;
    if (!ME_LOJA_IDS.includes(lojaId)) { ignoradas++; continue; }

    // Filtro 2 (segurança): precisa ter link de XML (NF realmente autorizada)
    if (!nf.xml) {
      console.warn(`[F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem XML — pulando`);
      ignoradas++;
      continue;
    }

    // Filtro 3: precisa ter o número do pedido na loja (ML)
    const numeroPedidoLoja = nf.numeroPedidoLoja;
    if (!numeroPedidoLoja) {
      console.warn(`[F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem numeroPedidoLoja — pulando`);
      ignoradas++;
      continue;
    }

    // Tenta enviar. enviarNFeParaML já confere se o shipment está "invoice_pending".
    try {
      await enviarNFeParaML(mlToken, numeroPedidoLoja, nf);
      console.log(`[F3-NFeML] ✅ NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) enviada`);
      enviadas++;
      marcarProcessado('F3', nfeId);
    } catch (e) {
      const msg = e.message || '';
      // Caso esperado: o ML já tem os dados fiscais (não está pendente). Não é erro.
      if (msg.includes('não é invoice_pending') || msg.includes('invoice_pending')) {
        console.log(`[F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — ML não está pendente, nada a fazer`);
        semPendencia++;
        marcarProcessado('F3', nfeId); // já resolvido, não tentar de novo hoje
      } else {
        console.error(`[F3-NFeML] Erro ao enviar NF ${nf.numero} (pedido ML ${numeroPedidoLoja}):`, msg);
        erros++;
        // NÃO marca como processada → tenta de novo na próxima rodada
      }
    }
  }

  console.log(
    `[F3-NFeML] enviadas=${enviadas} | já-ok=${semPendencia} | ignoradas=${ignoradas} ` +
    `| já-processadas=${puladas} | erros=${erros}`
  );
}

/**
 * Rotina pública chamada pelo cron e pela rota manual.
 */
async function rotinaNFeML() {
  if (_rodando) {
    console.log('[F3-NFeML] já em execução — pulando');
    return;
  }
  _rodando = true;
  try {
    await comTokenRenewable(_fluxoNFeML);
  } finally {
    _rodando = false;
  }
}

/**
 * Envia UMA NF específica (uso manual / apaga-incêndio).
 * Não respeita o filtro de "já processada", pois é disparo intencional.
 */
async function enviarNFeUnica(nfeId) {
  return comTokenRenewable(async (tokenBling) => {
    const nf = await getNFeDetalhe(tokenBling, nfeId);
    if (!nf) throw new Error(`NF ${nfeId} não encontrada`);
    if (!nf.xml) throw new Error(`NF ${nfeId} (nº ${nf.numero}) sem XML — não está autorizada`);
    if (!nf.numeroPedidoLoja) throw new Error(`NF ${nfeId} (nº ${nf.numero}) sem numeroPedidoLoja`);

    const mlToken = await garantirTokenML();
    const result = await enviarNFeParaML(mlToken, nf.numeroPedidoLoja, nf);
    marcarProcessado('F3', nfeId);
    return { ok: true, nfeId, numero: nf.numero, numeroPedidoLoja: nf.numeroPedidoLoja, result };
  });
}

module.exports = { rotinaNFeML, enviarNFeUnica };
