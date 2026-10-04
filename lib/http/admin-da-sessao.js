'use strict';

/* Quem é admin NESTA requisição — decidido pela identidade AUTENTICADA, nunca por `op` da URL/body.

   Achado A da auditoria do Codex (P1): as rotas administrativas decidiam com `ehAdmin(op)` e `op`
   vinha da query/body, então qualquer operador logado passava o nome de um admin (públicos em
   /operadores) e virava admin.

   Duas fontes legítimas, e só duas:
   1. `req._admKey === true` — a guarda confirmou a ADMIN_KEY. É um FLAG separado de propósito: antes
      usava-se `req._op === 'admin-key'`, e um operador comum chamado literalmente "admin-key"
      herdaria poder de admin (Codex, P2).
   2. a sessão assinada: `req._op` (posto pela guarda) ou, nas rotas que a guarda isenta (debug),
      o cookie validado aqui mesmo. `ehAdmin` é conferido no NOME da sessão. */
function souAdmin(req, ehAdmin, validarSessao) {
  if (req && req._admKey === true) return true;
  let nome = req && req._op;
  if (!nome && typeof validarSessao === 'function') nome = validarSessao(req && req.headers && req.headers['cookie']);
  return !!nome && !!ehAdmin(String(nome));
}

module.exports = { souAdmin };
