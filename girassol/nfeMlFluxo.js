'use strict';

/**
 * F3 — Envio automático de NF-e (dados fiscais) Bling → Mercado Livre. (Girassol)
 *
 * 1. Lista NF-e AUTORIZADAS (situacao=5) dos ÚLTIMOS DIAS no Bling.
 *    >>> Usa JANELA PRÓPRIA E CURTA (NF_JANELA_DIAS, padrão 5 dias) <<<
 *    Motivo: uma NF que o Bling não enviou ao ML é sempre RECENTE. Olhar a
 *    janela longa do F1/F2 (15-20 dias) enchia a lista de centenas de NFs
 *    antigas (já resolvidas) e estourava o limite MAX_NFE — as NFs novas
 *    (que precisam de envio) ficavam fora do lote e nunca eram processadas.
 * 2. Para cada NF da loja ML (loja.id em ME_LOJA_IDS) ainda não processada:
 *      - pega o detalhe (numeroPedidoLoja + link do XML);
 *      - envia para o ML SOMENTE se o shipment estiver "invoice_pending";
 *      - se o ML já tiver os dados, pula sem erro.
 * 3. Marca como processada para não reenviar.
 *
 * Trava de segurança: só NF com situacao=5 E com link de XML é enviada.
 */

const { garantirToken, renovarToken } = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');
const {
  getNFesAutorizadas,
  getNFeDetalhe,
  ME_LOJA_IDS,
  jaProcessado,
  marcarProcessado
} = require('./blingApi');
const { enviarNFeParaML } = require('./mlApi');

const MAX_NFE = parseInt(process.env.MAX_NFE_ML || '60');

// Janela PRÓPRIA do F3 — curta, porque NF travada no ML é sempre recente.
// Não usa o getPeriodo() do blingApi (que é a janela longa do F1/F2).
const NF_JANELA_DIAS = parseInt(process.env.NF_JANELA_DIAS || '5');

function getPeriodoNF() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fim = new Date(hoje);
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - (NF_JANELA_DIAS - 1));
  const fmt = d => d.toISOString().split('T')[0];
  return { inicial: fmt(ini), final: fmt(fim) };
}

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
  const { inicial, final } = getPeriodoNF();
  const lista = await getNFesAutorizadas(tokenBling, inicial, final);
  const batch = lista.slice(0, MAX_NFE);
  console.log(`[F3-NFeML] janela ${NF_JANELA_DIAS}d (${inicial}→${final}) | ${lista.length} NF autorizadas | processando ${batch.length}`);

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
    if (jaProcessado('F3', nfeId)) { puladas++; continue; }

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

    const lojaId = nf?.loja?.id;
    if (!ME_LOJA_IDS.includes(lojaId)) { ignoradas++; continue; }

    if (!nf.xml) {
      console.warn(`[F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem XML — pulando`);
      ignoradas++;
      continue;
    }

    const numeroPedidoLoja = nf.numeroPedidoLoja;
    if (!numeroPedidoLoja) {
      console.warn(`[F3-NFeML] NF ${nfeId} (nº ${nf.numero}) sem numeroPedidoLoja — pulando`);
      ignoradas++;
      continue;
    }

    try {
      await enviarNFeParaML(mlToken, numeroPedidoLoja, nf);
      console.log(`[F3-NFeML] ✅ NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) enviada`);
      enviadas++;
      marcarProcessado('F3', nfeId);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('não é invoice_pending') || msg.includes('invoice_pending')) {
        console.log(`[F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — ML não está pendente, nada a fazer`);
        semPendencia++;
        marcarProcessado('F3', nfeId);
      } else {
        console.error(`[F3-NFeML] Erro ao enviar NF ${nf.numero} (pedido ML ${numeroPedidoLoja}):`, msg);
        erros++;
      }
    }
  }

  console.log(
    `[F3-NFeML] enviadas=${enviadas} | já-ok=${semPendencia} | ignoradas=${ignoradas} ` +
    `| já-processadas=${puladas} | erros=${erros}`
  );
}

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
