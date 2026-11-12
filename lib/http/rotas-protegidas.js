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

/* 12/11 — as DUAS rotas do "Consultar situação" que a Toolbox usa (a lista das notas paradas e a devolução do resultado)
   aceitam, além da chave de admin, a CHAVE DA TOOLBOX (header X-Toolbox-Key = env TOOLBOX_KEY). Motivo: pra as notas não
   dependerem do dono abrir o Bling, a Toolbox roda nos computadores do galpão — e a chave de admin não pode morar lá
   ("jamais dar acesso ao dashboard pro estoquista"). A chave da Toolbox só alcança estas duas rotas (e o código da
   coleta): lista número/id de nota parada e recebe o resultado da consulta. Vale com o prefixo de qualquer empresa.
   O resto de /robo/ continua só admin. */
function ehRotaRoboToolbox(p) {
  return typeof p === 'string' && /^(\/[a-z0-9-]+)?\/robo\/nfs-consultar-situacao(\/resultado)?$/.test(p);
}
/* a chave da Toolbox confere? (tempo constante; sem a env configurada, ninguém passa) */
function chaveToolboxConfere(recebida, esperada) {
  const a = Buffer.from(String(recebida || '')), b = Buffer.from(String(esperada || ''));
  if (!b.length || a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

module.exports = { ehRotaCentralAdmin, ehCallbackOAuth, ehRotaChaveToolbox, ehRotaRoboToolbox, chaveToolboxConfere };
