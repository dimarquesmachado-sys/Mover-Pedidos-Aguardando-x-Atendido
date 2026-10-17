'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   NOTAS QUE O ML ESTÁ SEGURANDO (17/10/2026) — lista durável, por empresa, pro F3.

   O F3 manda a nota pro ML só quando o envio está em invoice_pending, olha só notas dos últimos
   dias (janela curta) e desiste depois de ~3 h de "o ML ainda não pede". Venda que o ML SEGURA —
   envio programado (pending/buffered, "a etiqueta estará pronta no dia 5 de novembro") ou prazo de
   disponibilidade (status qualquer + substatus manufacturing) — só pede a nota semanas depois: a nota emitida antes disso caía
   fora da janela e nunca chegava ao ML; a etiqueta não saía no dia da coleta.

   Esta lista guarda essas notas até o ML pedir. Quem registra: o próprio F3 (quando o ML responde
   que está segurando) e o checkout (pedido "aguardando o ML liberar" que já tem nota — é assim que
   as notas de antes deste conserto entram). Quem consome: o F3, que reconfere de tempos em tempos,
   fora da janela, e envia quando o ML pedir. Um arquivo por empresa em CACHE_DIR (o mesmo processo
   do Mover-Pedidos), gravado de forma atômica.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const { gravarAtomico } = require('../escrita-atomica');

function _chave(empresa) { return String(empresa || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function arquivo(empresa) { return path.join(process.env.CACHE_DIR || '/data', 'f3-aguardando-ml-' + _chave(empresa) + '.json'); }
function ler(empresa) {
  try { const m = JSON.parse(fs.readFileSync(arquivo(empresa), 'utf8')); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
}
function gravar(empresa, mapa) {
  try { gravarAtomico(arquivo(empresa), JSON.stringify(mapa || {})); return true; } catch (e) { return false; }
}
/* registra (ou atualiza) uma nota; devolve true se gravou */
function registrar(empresa, nfeId, info) {
  if (nfeId == null || nfeId === '') return false;
  const m = ler(empresa); const k = String(nfeId);
  if (!m[k]) m[k] = { desde: new Date().toISOString() };
  Object.assign(m[k], info || {});
  return gravar(empresa, m);
}
/* o envio está retido pelo ML (programado ou aguardando estoque)? */
function mlSegurando(status, substatus) {
  const st = String(status || ''), sub = String(substatus || '');
  return /manufacturing/i.test(sub) || (st === 'pending' && /^buffered$/i.test(sub));
}

module.exports = { arquivo, ler, gravar, registrar, mlSegurando };
