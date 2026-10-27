'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PAINEL DO GALPÃO — PEÇA ÚNICA (27/10/2026). Eram três cópias de ~2.300 linhas (girassol-backup-offline/painel.html,
   amb-checkout-offline/painel.html, good-checkout-offline/painel.html), ~96% iguais. O modelo
   (lib/checkout/painel/painel-galpao.html) tem tudo; o que é de cada empresa vem do painel-marca.js dela:
     FAVICON (a linha do ícone), LOGO (o data URL do logo), TITULO (<title>), TITULO_H1 (o título da barra),
     UI_BUILD (a versão cravada no painel — o servidor compara pra saber se o navegador está com o painel velho),
     PREFIXO (das rotas), EMPRESA (a chave: frágil, Magalu), TAG (o prefixo das variáveis, só em comentário).
   renderizar(marca) — troca os {{…}}; recusa marca incompleta (melhor erro na subida que painel com {{…}} na tela).
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const CAMPOS = ['FAVICON', 'LOGO', 'TITULO', 'TITULO_H1', 'UI_BUILD', 'PREFIXO', 'EMPRESA', 'TAG'];
/* opcionais (vazios quando a empresa não tem): BOTOES_EXTRA — botões de admin só dela (a GOOD: 📎 etiquetas em massa,
   que só ela tem no servidor) */
const OPCIONAIS = ['BOTOES_EXTRA'];
let _modelo = null;
function modelo() { if (_modelo == null) _modelo = fs.readFileSync(path.join(__dirname, 'painel-galpao.html'), 'utf8'); return _modelo; }

function renderizar(marca) {
  const m = marca || {};
  const faltam = CAMPOS.filter((k) => typeof m[k] !== 'string' || !m[k]);
  if (faltam.length) throw new Error('painel-galpao: a marca da empresa não tem ' + faltam.join(', '));
  let html = modelo();
  for (const k of CAMPOS) html = html.split('{{' + k + '}}').join(m[k]);
  for (const k of OPCIONAIS) html = html.split('{{' + k + '}}').join(typeof m[k] === 'string' ? m[k] : '');
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('painel-galpao: sobrou marcador sem valor: ' + html.match(/\{\{[A-Z_]+\}\}/)[0]);
  return html;
}

/* o painel da empresa, montado UMA vez por processo (a marca não muda sem deploy) */
const _cache = new Map();
function painelDaEmpresa(marca) {
  const k = marca && marca.PREFIXO;
  if (!_cache.has(k)) _cache.set(k, renderizar(marca));
  return _cache.get(k);
}

module.exports = { renderizar, painelDaEmpresa, CAMPOS, OPCIONAIS };
