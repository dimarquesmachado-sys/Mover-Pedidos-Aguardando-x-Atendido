'use strict';

// ──────────────────────────────────────────────────────────────────────
// TRAVA POR MENSAGEM (memória local) — estado COMPARTILHADO.
//
// Versão em memória da trava do banco (ia_processado_em): guarda o timestamp
// da ÚLTIMA msg do cliente que a IA JÁ respondeu. Msg nova passa na hora (zero
// atraso); a mesma msg nunca é respondida duas vezes.
//
// Precisa ser COMPARTILHADO entre dois módulos:
//   - lerRespostas.js  -> REGISTRA (quando a IA responde) e LÊ.
//   - retryFila.js (revisarAtencaoHumana) -> LÊ, pra não re-engajar um cliente
//     com uma mensagem que a IA já tratou neste ciclo.
//
// Por isso o Map mora aqui (módulo é singleton no cache do Node): os dois lados
// enxergam a MESMA instância. Antes da modularização os dois ficavam no mesmo
// arquivo e dividiam o Map naturalmente; isto restaura esse compartilhamento.
// ──────────────────────────────────────────────────────────────────────

const _ultimaMsgProcessadaPorOrder = new Map();

function registrarMsgProcessada(orderId, tsMsgCliente) {
  _ultimaMsgProcessadaPorOrder.set(String(orderId), tsMsgCliente);
}

function msgJaProcessada(orderId, tsMsgCliente) {
  const t = _ultimaMsgProcessadaPorOrder.get(String(orderId));
  return !!t && tsMsgCliente <= t;
}

module.exports = { registrarMsgProcessada, msgJaProcessada };
