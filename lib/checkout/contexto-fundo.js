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
module.exports = { contexto, emFundo, comoFundo };
