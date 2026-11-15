'use strict';
/* 15/11 — O QUE O SERVIDOR ASSINA PRO QZ TRAY (auditoria do Codex de 15/11/2026, P2 nº 2).

   O QZ Tray (impressão silenciosa no PC do galpão) confia no certificado da empresa: cada chamada que o navegador faz a
   ele — imprimir, listar impressoras, mas também `file.write`, `file.remove`, `usb.*`, `serial.*`, `socket.*` — vai com uma
   assinatura da chave privada da empresa, que o navegador pede ao servidor (/qz-sign). Assinar o que pedirem é dar a chave:
   quem conseguir uma assinatura pra `file.write` escreve no PC do galpão com a confiança do nosso certificado.

   O qz-tray.js (2.2.x) NÃO manda o pedido pra assinar: manda o RESUMO (sha256 em hex) de
   `JSON.stringify({ call, params, timestamp })` — e o servidor não enxerga o que está assinando. Por isso o painel manda os
   DOIS: o resumo (o que a assinatura cobre) e o pedido (o texto que gerou o resumo); aqui se confere que o resumo é do
   pedido e que o pedido faz o que o painel faz — imprimir e olhar impressoras — com `timestamp` perto de agora. Qualquer
   outra coisa é recusada COM MOTIVO e nunca assinada. */
const crypto = require('crypto');

const MAX_BYTES = 6 * 1024 * 1024;      /* a etiqueta em PDF vai em base64 dentro de `params` */
const JANELA_MS = 24 * 3600 * 1000;      /* o relógio do PC do galpão pode estar errado em horas, não em dias */
/* os nomes são os do protocolo do QZ (qz-tray.js, `dataPromise('…')`): o painel imprime e procura impressora */
const CALLS = new Set(['print', 'printers.find', 'printers.getDefault', 'printers.detail']);
const RE_SHA256 = /^[0-9a-f]{64}$/;

function sha256Hex(texto) { return crypto.createHash('sha256').update(String(texto), 'utf8').digest('hex'); }

/* devolve o MOTIVO da recusa (string) ou null quando pode assinar `resumo` */
function recusarAssinatura(resumo, pedido, agoraMs) {
  if (typeof resumo !== 'string' || !RE_SHA256.test(resumo)) return 'resumo inválido (esperava o sha256 do pedido, em hex)';
  if (typeof pedido !== 'string' || !pedido) return 'pedido ausente (o painel manda resumo e pedido)';
  if (Buffer.byteLength(pedido, 'utf8') > MAX_BYTES) return 'pedido grande demais';
  if (sha256Hex(pedido) !== resumo) return 'o resumo não é deste pedido';
  let o; try { o = JSON.parse(pedido); } catch (e) { return 'não é o JSON de um pedido do QZ'; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'não é o JSON de um pedido do QZ';
  if (typeof o.call !== 'string') return 'pedido sem `call`';
  if (!CALLS.has(o.call)) return 'chamada não permitida: ' + o.call.slice(0, 40);
  const t = Number(o.timestamp);
  if (o.timestamp == null || !Number.isFinite(t) || Math.abs(t - Number(agoraMs)) > JANELA_MS) return 'timestamp ausente ou fora da janela';
  return null;
}

module.exports = { recusarAssinatura, sha256Hex, CALLS, MAX_BYTES, JANELA_MS, RE_SHA256 };
