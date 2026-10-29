'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CONTAGEM DE ESTOQUE — a TELA, peça única (27/10/2026). Era girassol-backup-offline/contagem.html (só a Girassol tinha;
   as rotas já eram a peça lib/checkout/rotas-contagem). O modelo (lib/checkout/painel/contagem.html) tem marcadores só no
   que é da empresa, e reaproveita a MARCA do painel do galpão dela (painel-marca.js): LOGO, PREFIXO e NOME.
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const CAMPOS = ['LOGO', 'PREFIXO', 'NOME'];
let _modelo = null;
function renderizar(marca) {
  const m = marca || {};
  const faltam = CAMPOS.filter((k) => typeof m[k] !== 'string' || !m[k]);
  if (faltam.length) throw new Error('contagem: a marca da empresa não tem ' + faltam.join(', '));
  if (_modelo == null) _modelo = fs.readFileSync(path.join(__dirname, 'contagem.html'), 'utf8');
  let html = _modelo;
  for (const k of CAMPOS) html = html.split('{{' + k + '}}').join(m[k]);
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('contagem: sobrou marcador sem valor');
  return html;
}
module.exports = { renderizar, CAMPOS };
