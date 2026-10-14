'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   TELA ÚNICA DO PAINEL DE VENDAS (14/10/2026).

   Pedido do dono: o painel da GOOD "operacional 100%", igual ao da Girassol e da AMB. As duas
   telas maduras são quase a mesma (medido: 38 linhas de código só da Girassol e 71 só da AMB, em
   ~3.900), e a da GOOD era uma tela à parte com 3 seções próprias. Em vez de fazer uma TERCEIRA
   cópia, a GOOD passa a ser servida a partir da tela da AMB (a mais completa — regra do dono:
   "a que tem mais funções é espelho pras outras"), trocando só o que é da empresa: nome, logo,
   prefixo das rotas, alíquotas de fábrica, link do Magalu e o selo de versão.

   Cada troca é EXATA e CONFERIDA: se o arquivo da AMB mudar e uma troca não achar o alvo (ou
   achar duas vezes), a geração LANÇA — quem serve cai na tela antiga da empresa e loga o motivo,
   e o teste teste-painel-modelo-good.js fica vermelho no CI. Nunca sai uma tela meio-trocada
   chamando rota de outra empresa.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const MODELO = path.join(__dirname, '..', '..', 'amb-checkout-offline', 'amb-dashboard.html');
const PREFIXO_MODELO = '/amb-checkout-offline';

const _esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function _uma(s, de, para, rotulo) {
  const n = s.split(de).length - 1;
  if (n !== 1) throw new Error('o modelo do painel mudou: "' + rotulo + '" achado ' + n + 'x (esperado 1)');
  return s.replace(de, () => para);
}

/* código sem comentário: blocos barra-asterisco, blocos HTML e barra-barra de fim de linha */
function _soCodigo(s) {
  const semBloco = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  return semBloco.split('\n').map(l => l.replace(/(?<![:'"\\])\/\/.*$/, '')).join('\n');
}

function gerarPainel(cfg) {
  const c = cfg || {};
  for (const k of ['prefixo', 'nome', 'slugMagalu', 'defaultAliq', 'logoEmoji']) {
    if (c[k] == null || c[k] === '') throw new Error('gerarPainel: falta ' + k);
  }
  if (!/^\/[a-z0-9-]+$/.test(c.prefixo)) throw new Error('gerarPainel: prefixo inválido ' + c.prefixo);
  /* sem cache de propósito: a tela é aberta poucas vezes por hora, e gerar de novo a cada pedido
     garante que um modelo alterado nunca seja servido com a troca velha */
  let s = fs.readFileSync(MODELO, 'utf8');
  const build = (s.match(/^const DASH_BUILD = '([^']+)';/m) || [])[1];
  if (!build) throw new Error('o modelo do painel mudou: DASH_BUILD não achado');

  s = _uma(s, '<title>Inteligência de Vendas · AMBTotal</title>', '<title>Inteligência de Vendas · ' + _esc(c.nome) + '</title>', 'título');
  s = _uma(s, '<meta name="apple-mobile-web-app-title" content="AMBTotal">', '<meta name="apple-mobile-web-app-title" content="' + _esc(c.nome) + '">', 'título do atalho');
  s = _uma(s, "const DASH_BUILD = '" + build + "';", "const DASH_BUILD = '" + (c.selo || 'G') + '-' + build + "';", 'selo de versão');
  const reAliq = /^const DEFAULT_ALIQ = \{[^\n]*\};/m;
  const nAliq = (s.match(new RegExp(reAliq.source, 'gm')) || []).length;
  if (nAliq !== 1) throw new Error('o modelo do painel mudou: DEFAULT_ALIQ achado ' + nAliq + 'x (esperado 1)');
  s = s.replace(reAliq, () => 'const DEFAULT_ALIQ = ' + JSON.stringify(c.defaultAliq) + ';   /* da empresa: o MESMO DEFAULT_ALIQ_BK do backend */');
  s = _uma(s, `<img class="logo" src="icone.png?v='+DASH_BUILD+'" alt="AMBTotal" style="object-fit:cover"> Inteligência de Vendas · AMBTotal`,
           `<span class="logo">${c.logoEmoji}</span> Inteligência de Vendas · ${_esc(c.nome)}`, 'cabeçalho');
  s = _uma(s, "'/magalu/ir/amb?n='", "'/magalu/ir/" + c.slugMagalu + "?n='", 'link do Magalu');
  /* ícones: o da AMB é a lâmpada dela; a empresa usa o emoji dela (SVG embutido) */
  const reIcone = /<link rel="icon"[^>]*>/;
  const nIcone = (s.match(/<link rel="icon"[^>]*>/g) || []).length;
  if (nIcone !== 1) throw new Error('o modelo do painel mudou: ícone achado ' + nIcone + 'x (esperado 1)');
  const svg = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>" + c.logoEmoji + '</text></svg>');
  s = s.replace(reIcone, () => '<link rel="icon" href="' + svg + '">');
  s = s.replace(/<link rel="apple-touch-icon"[^>]*>/g, () => '<link rel="apple-touch-icon" href="' + svg + '">');
  /* prefixo das rotas: TODAS as ocorrências (inclusive comentários) */
  s = s.split(PREFIXO_MODELO).join(c.prefixo);

  const resto = _soCodigo(s).match(/amb-checkout-offline|AMBTotal|'\/magalu\/ir\/amb\?/g);
  if (resto) throw new Error('sobrou referência da AMB no código do painel: ' + resto.join(', '));
  return s;
}

module.exports = { gerarPainel, MODELO };
