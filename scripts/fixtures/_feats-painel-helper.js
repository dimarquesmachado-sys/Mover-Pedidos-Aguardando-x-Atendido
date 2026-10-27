'use strict';
/* as funções, os elementos (id) e as rotas que um painel do galpão usa — a mesma conta que gerou painel-amb-good-antes.json */
function feats(s) {
  const fn = [...new Set([...s.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].sort();
  const ids = [...new Set([...s.matchAll(/id="([A-Za-z_][\w-]*)"/g)].map((m) => m[1]))].sort();
  const rotas = [...new Set([...s.matchAll(/['"](\/(?:girassol-backup-offline|amb-checkout-offline|good-checkout-offline)\/[a-z0-9\-/]+)/g)].map((m) => m[1].replace(/\/(girassol-backup-offline|amb-checkout-offline|good-checkout-offline)\//, '/EMP/')))].sort();
  return { funcoes: fn, ids, rotas };
}
module.exports = { feats };
