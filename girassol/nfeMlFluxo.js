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
 * IMPORTANTE (fix jun/2026): quando o ML responde "não é invoice_pending",
 * NÃO marcamos a NF como processada de primeira. Vendas cross-docking/agência
 * ficam um tempo em estados anteriores (ex: buffered) e só DEPOIS viram
 * invoice_pending — se marcássemos logo, o F3 nunca mais tentaria e a venda
 * ficava eternamente "pendente de dados fiscais" no ML. Agora damos até
 * MAX_CHECAGENS_PENDENCIA tentativas (~3h de ciclos de 10min) antes de
 * desistir e marcar como ok (caso em que os dados já foram preenchidos por
 * outra via). Estado em memória — zera no restart, sem problema.
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

// Quantas vezes re-checar uma NF cujo shipment "não está invoice_pending"
// antes de desistir e marcar como processada. 18 ciclos de 10min ≈ 3h.
const MAX_CHECAGENS_PENDENCIA = parseInt(process.env.F3_MAX_CHECAGENS || '18');

// nfeId -> nº de checagens "sem pendência" (em memória)
const _semPendenciaCount = new Map();

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
      _semPendenciaCount.delete(nfeId);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('não é invoice_pending') || msg.includes('invoice_pending')) {
        // Shipment não está aguardando NF AGORA — mas pode estar a caminho
        // (cross-docking fica em buffered antes de virar invoice_pending).
        // Re-checa nos próximos ciclos até MAX_CHECAGENS_PENDENCIA.
        const tent = (_semPendenciaCount.get(nfeId) || 0) + 1;
        _semPendenciaCount.set(nfeId, tent);
        if (tent >= MAX_CHECAGENS_PENDENCIA) {
          console.log(`[F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — sem pendência após ${tent} checagens, marcando como ok`);
          marcarProcessado('F3', nfeId);
          _semPendenciaCount.delete(nfeId);
        } else {
          console.log(`[F3-NFeML] NF ${nf.numero} (pedido ML ${numeroPedidoLoja}) — ML não está pendente (checagem ${tent}/${MAX_CHECAGENS_PENDENCIA}), re-checa no próximo ciclo`);
        }
        semPendencia++;
      } else {
        console.error(`[F3-NFeML] Erro ao enviar NF ${nf.numero} (pedido ML ${numeroPedidoLoja}):`, msg);
        erros++;
      }
    }
  }

  console.log(
    `[F3-NFeML] enviadas=${enviadas} | sem-pendência=${semPendencia} | ignoradas=${ignoradas} ` +
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
    _semPendenciaCount.delete(nfeId);
    return { ok: true, nfeId, numero: nf.numero, numeroPedidoLoja: nf.numeroPedidoLoja, result };
  });
}

module.exports = { rotinaNFeML, enviarNFeUnica };
