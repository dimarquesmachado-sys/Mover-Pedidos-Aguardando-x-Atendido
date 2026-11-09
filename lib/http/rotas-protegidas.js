'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS PROTEGIDAS — a REGRA ÚNICA de "que caminho é rota central de admin" e "que caminho é callback de OAuth"
   (01/11/2026, auditoria do Codex no SHA 208fdb7d, achado F01).

   O defeito: o porteiro de sessão de cada empresa pulava a sessão pra caminhos que CONTINHAM "/callback", "debug",
   "/run", "/setup", "/robo" ou "/forcar" — contando que o porteiro central do servidor (index.js) exigiria a chave de
   admin nesses caminhos. Só que as duas regras eram DIFERENTES: o central exigia a chave pra "/debug/", "/debug-",
   ".../debug", "/run/", ".../run"…, e o da empresa pulava a sessão pra QUALQUER "debug" ou "/run". Resultado, nas três
   empresas: /<empresa>/pedido/debugging/123, /pedido/callback/123 ou /pedido/runner/123 passavam pelos dois porteiros
   sem credencial nenhuma e a rota do pedido devolvia o pedido 123 (ela usava o ÚLTIMO pedaço do caminho como número).

   A correção: os DOIS porteiros usam ESTA regra. O que o porteiro da empresa deixa passar sem sessão é exatamente o que
   o central tranca com a chave — não sobra caminho que escape dos dois. Callback é só caminho que TERMINA em /callback
   (todas as rotas de OAuth do repositório terminam assim). */

/* rota central de admin: o porteiro do servidor exige a chave de admin; o da empresa não pede sessão (a chave basta) */
function ehRotaCentralAdmin(p) {
  const s = String(p || '');
  return s.includes('/run/') || s.endsWith('/run') ||
    s.includes('/robo/') ||
    s.includes('/forcar/') ||
    s.includes('/setup') ||
    s.includes('/debug/') || s.includes('/debug-') || s.endsWith('/debug');
}

/* callback de OAuth: só o caminho que TERMINA em /callback (nunca um pedaço no meio do caminho) */
function ehCallbackOAuth(p) {
  return /\/callback$/.test(String(p || ''));
}

/* 09/11 — rota com AUTENTICAÇÃO PRÓPRIA que não pode passar pela trava de sessão do checkout: /ml-codigo-coleta
   (POST só com a chave da Toolbox, a env TOOLBOX_KEY; GET só admin). Uma regra só, pras três empresas e as futuras:
   o caminho TERMINA em /ml-codigo-coleta logo depois do prefixo do checkout. */
function ehRotaChaveToolbox(p) {
  return typeof p === 'string' && /^\/[a-z0-9-]+\/ml-codigo-coleta$/.test(p);
}

module.exports = { ehRotaCentralAdmin, ehCallbackOAuth, ehRotaChaveToolbox };
