'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   "ESTE PEDIDO DO MERCADO LIVRE É FULL?" (15/10/2026) — uma peça só, pras três empresas e as futuras.

   Usado pelo Corrigir-NFs antes de transmitir nota série 1: no Full quem emite a nota é o ML (série 2), e
   o Bling às vezes gera uma série 1 duplicada na importação (caso real: AMB, pedido 5692, NF 004905).
   Devolve true (Full confirmado) · false (não é Full) · null (não deu pra saber).
   - Prazo (Codex #699): o fetch do ML não tem timeout; uma chamada pendurada seguraria o Corrigir-NFs
     inteiro da empresa ("já em execução" pra sempre). Estourou o prazo ⇒ rejeita ⇒ quem chama trata como
     "não sei".
   - Token (Codex #699): garantirTokenML faz um /users/me a cada chamada; numa rodada com várias notas,
     o token é reaproveitado por alguns minutos. Erro descarta o token guardado.
   As chamadas ao ML usam a mesma peça de API de todos (lib/fiscal/ml-api.js); o que muda por empresa é
   só o gerenciador de token. */

function criarClassificadorFullML(cfg) {
  const c = cfg || {};
  if (!c.mlTokenManager || typeof c.mlTokenManager.garantirTokenML !== 'function') throw new Error('classificar-full-ml: falta mlTokenManager');
  const api = c.mlApi || require('./ml-api').criarMlApi({ rotulo: c.rotulo || 'FULL' });
  const prazoMs = c.prazoMs != null ? Number(c.prazoMs) : 15000;
  const tokenTtlMs = c.tokenTtlMs != null ? Number(c.tokenTtlMs) : 5 * 60000;
  const agora = c.agora || Date.now;
  let _tk = null, _tkEm = 0;
  async function _token() {
    if (_tk && (agora() - _tkEm) < tokenTtlMs) return _tk;
    _tk = await c.mlTokenManager.garantirTokenML(); _tkEm = agora();
    return _tk;
  }
  function _comPrazo(p) {
    let t;
    const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('o ML não respondeu em ' + prazoMs + ' ms')), prazoMs); if (t && t.unref) t.unref(); });
    return Promise.race([p, limite]).finally(() => clearTimeout(t));
  }
  /* Codex #699 r3: token guardado que o ML recusou (401/403) não pode virar "não sei" — o chamador
     transmitiria a série 1. Descarta, pega token novo e tenta UMA vez mais. */
  const _recusado = (e) => /\b(401|403)\b/.test(String((e && e.message) || ''));
  async function _uma(numeroPedidoLoja) {
    const tk = await _token();
    const sid = await api.getShipmentInfo(tk, numeroPedidoLoja);
    if (!sid) return null;
    const raw = await api.getShipmentRaw(tk, sid);
    if (raw && (raw.httpStatus === 401 || raw.httpStatus === 403)) { const e = new Error('ML recusou o token (' + raw.httpStatus + ')'); throw e; }
    if (!raw || raw.httpStatus !== 200 || !raw.data) return null;
    const tipo = (raw.data.logistic && raw.data.logistic.type) || raw.data.logistic_type || null;
    return tipo ? tipo === 'fulfillment' : null;
  }
  return async function ehVendaFullML(numeroPedidoLoja) {
    try {
      return await _comPrazo((async () => {
        try { return await _uma(numeroPedidoLoja); }
        catch (e) { if (!_recusado(e)) throw e; _tk = null; return await _uma(numeroPedidoLoja); }
      })());
    } catch (e) { _tk = null; throw e; }
  };
}

module.exports = { criarClassificadorFullML };
