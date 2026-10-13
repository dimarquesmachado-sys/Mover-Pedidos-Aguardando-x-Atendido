'use strict';
// 13/10 — contexto de FUNDO das chamadas ao Bling: as rotinas AGENDADAS rodam dentro dele e o blingGet/blingWrite
// (lib/checkout/base-funcoes) pede a vez ao porteiro so ai — a tela do galpao, fora do contexto, nao muda.
// Modulo (e nao global): o require e o mesmo pra todos, entao a instancia e uma so no processo — sem estado global
// (scripts/teste-estado-sem-global.js: as tres empresas rodam no mesmo processo).
const { AsyncLocalStorage } = require('async_hooks');
const contexto = new AsyncLocalStorage();
// roda `fn` como FUNDO, com o nome que aparece no por_servico do porteiro
function emFundo(servico, fn) { return contexto.run({ fundo: true, servico: String(servico || 'mp') }, fn); }
// embrulha um callback de temporizador pra rodar como FUNDO
function comoFundo(servico, fn) { return () => emFundo(servico, fn); }
// 13/10 (dono: 'rotina pesada so fora do horario do galpao') — o deploy de meio-dia disparava a pesca de tarifas de 14
// dias e a sincronizacao de custos EM PLENO GALPAO (o porteiro mostrou girassol.agendador com 106 liberadas e 203
// esperas as 12h). Atraso de uma rotina de POS-DEPLOY: se agora (Sao Paulo) e horario do galpao (7h-18h), espera ate as
// 18h05; fora disso, o atraso original. `agoraFn` so pra teste.
function adiarForaDoGalpao(msOriginal, agoraFn) {
  const agora = agoraFn ? agoraFn() : new Date();
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(agora);
  const h = Number((partes.find((x) => x.type === 'hour') || {}).value || 0) % 24;
  const m = Number((partes.find((x) => x.type === 'minute') || {}).value || 0);
  // Codex #677: vale a hora em que a rotina VAI RODAR (agora + atraso), nao a de agora — deploy as 6h50 com atraso de
  // 15 min cairia as 7h05, ja com o galpao aberto
  const minAgora = h * 60 + m;
  const minRoda = (minAgora + Math.ceil(msOriginal / 60000)) % (24 * 60);
  if (minRoda < 7 * 60 || minRoda >= 18 * 60) return msOriginal;
  const ateAs1805 = ((18 * 60 + 5) - minAgora) * 60 * 1000;
  return Math.max(msOriginal, ateAs1805);
}
module.exports = { contexto, emFundo, comoFundo, adiarForaDoGalpao };
