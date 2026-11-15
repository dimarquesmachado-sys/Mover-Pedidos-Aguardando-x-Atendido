'use strict';
/* 15/11 — O ID DE PEDIDO QUE VEM DE FORA (auditoria do Codex de 15/11/2026, P2 nº 1).

   Rotas do checkout montam caminhos no disco com o id do pedido (`<CACHE_DIR>/<id>/etiqueta.pdf`, `pedido.json`,
   `danfe.pdf`…). Quando o id vinha da URL ou do corpo sem conferência, `../` escapava do cache da empresa: com a chave de
   admin dava pra ESCREVER e APAGAR arquivo fora da pasta dela (medido pelo Codex no /etiqueta-anexar).

   O id de pedido do Bling é um número. Então: só dígitos (até 20), nada mais — o resto é inválido e a rota responde 400
   antes de qualquer caminho ser montado. Uma regra, pras três empresas e pra toda rota que receba id. */
const RE = /^\d{1,20}$/;

/* o id canônico (string de dígitos) ou null */
function idPedido(x) {
  const s = String(x == null ? '' : x).trim();
  return RE.test(s) ? s : null;
}

module.exports = { idPedido, RE };
