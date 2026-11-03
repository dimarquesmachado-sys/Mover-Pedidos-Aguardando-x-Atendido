'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   AÇÃO QUE GRAVA, SÓ DE DENTRO DO SISTEMA (01/11/2026 — auditoria do Codex no SHA 208fdb7d, achado F10).
   O cookie de sessão é SameSite=Lax: ele VIAJA numa navegação de topo (um link, um redirecionamento) vinda de outro site.
   Uma rota que GRAVA aceitando GET (o reabrir do painel aceitava) pode ser disparada por um link noutro site com o admin
   logado — o pedido sairia dos finalizados e voltaria pra ATENDIDO no Bling sem ninguém clicar no botão.
   recusaCsrf(req, method) → null quando a ação pode seguir, senão o motivo da recusa:
   · autenticado pela ADMIN_KEY (req._admKey, posto pela guarda): segue — a chave não viaja sozinha como o cookie;
   · com a sessão (cookie): exige POST (navegação de outro site é GET; POST de outro site não leva o cookie Lax) e, como
     reforço, recusa `Sec-Fetch-Site: cross-site` e `Origin` de outro host. */
function recusaCsrf(req, method) {
  if (req && req._admKey === true) return null;
  if (String(method || '').toUpperCase() !== 'POST') return 'esta acao grava -- exige POST (o painel ja envia)';
  const h = (req && req.headers) || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'requisicao de outro site bloqueada (protecao contra CSRF)';
  const origem = h['origin'];
  if (origem && origem !== 'null') {
    let host = null;
    try { host = new URL(String(origem)).host; } catch (e) { return 'origem invalida bloqueada (protecao contra CSRF)'; }
    if (host !== String(h['host'] || '')) return 'requisicao de outra origem bloqueada (protecao contra CSRF)';
  } else if (origem === 'null') return 'origem opaca bloqueada (protecao contra CSRF)';
  return null;
}

module.exports = { recusaCsrf };
