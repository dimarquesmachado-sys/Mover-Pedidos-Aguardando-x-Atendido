'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SEM SEGREDOS (01/11/2026 — auditoria do Codex no SHA 208fdb7d, achado F13). Mensagem de erro de OAuth não pode carregar
   pedaço de credencial: o gerenciador de token das NFs copiava os primeiros 120 caracteres do corpo CRU da resposta pra
   mensagem do erro (e o JSON inteiro quando vinha `error`), e o callback mostrava essa mensagem na TELA — uma resposta
   parcial com access_token aparecia lá. semSegredos(texto) troca o VALOR de access_token, refresh_token, id_token,
   client_secret, code, password e Bearer por "[oculto]" — em JSON (inclusive cortado no meio do valor) e em formulário/URL.
   O resto da mensagem (status, o tipo do erro) continua pra diagnóstico. */
const CHAVES = 'access_token|refresh_token|id_token|client_secret|code|password|senha|token';
const RE_JSON = new RegExp('("(?:' + CHAVES + ')"\\s*:\\s*")([^"]*)("?)', 'gi');
const RE_FORM = new RegExp('\\b(' + CHAVES + ')=([^&\\s"\']+)', 'gi');
const RE_BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/g;

function semSegredos(x) {
  let s = (typeof x === 'string') ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })();
  s = String(s == null ? '' : s);
  s = s.replace(RE_JSON, (m, ini, valor, fim) => ini + '[oculto]' + (fim || ''));
  s = s.replace(RE_FORM, (m, k) => k + '=[oculto]');
  s = s.replace(RE_BEARER, '$1 [oculto]');
  return s;
}

module.exports = { semSegredos };
