'use strict';

/**
 * Mensagem inicial inteligente — lixas A COMBINAR.
 *
 * Extraído de fluxos.js (modularização). Usado por rotinaACombinar (no fluxos.js)
 * e por forcarOrder (em forcarOrder.js) — ambos importam montarMensagemInteligente
 * daqui, sem duplicação.
 *
 * Monta a mensagem com os grãos disponíveis (via lixasService). Se o lixas-combinar
 * não estiver carregado ou o SKU não mapear, cai pro TEXTO genérico.
 */

const ml = require('./mlApi');

// Integração opcional com o módulo /lixas-combinar (mesma lógica do fluxos.js):
// se não carregar, montarMensagemInteligente cai pro TEXTO genérico.
let lixasService = null;
try {
  lixasService = require('../lixas-combinar/lixasService');
} catch (e) {
  /* modulo lixas-combinar indisponivel — usa msg generica */
}

const TEXTO = process.env.AUTO_MSG_GIRASSOL_TEXTO_A_COMBINAR || '';
const LIMITE_CHARS = 350;

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
      if (graosArr.length === 0) return `Ex: ${total}un do grão desejado.`;
      if (graosArr.length === 1) return `Ex: ${total}un de g${graosArr[0]}.`;
      const grao1 = graosArr[0];
      const idx2 = Math.min(2, graosArr.length - 1);
      const grao2 = graosArr[idx2];
      const parte1 = Math.round(total * 0.3 / unidades) * unidades;
      const parte2 = total - parte1;
      return `Ex: ${parte1}un de g${grao1}; ${parte2}un de g${grao2}.`;
    }

    // Monta mensagem desenhada (com acentos, MAIUSCULO nos pontos chave)
    function montar(graosArr) {
      const graosStr = graosArr.map(g => 'g' + g).join(', ');
      const exemplo = gerarExemplo(totalLixas, unidades, graosArr);
      return `Olá! INFORME a combinação de lixas e grãos do seu pedido.

GRÃOS DISPONÍVEIS: ${graosStr}.

⚠️ ATENÇÃO: responda QUANTIDADE + GRÃO (múltiplos de ${unidades}, total ${totalLixas}).
${exemplo}

Quanto antes responder, mais rápido postaremos!`;
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

module.exports = { montarMensagemInteligente };
