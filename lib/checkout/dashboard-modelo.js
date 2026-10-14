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
/* Codex #695 r2: valor que entra numa STRING JavaScript de aspas simples (o cabeçalho é montado em
   JS): escapa barra, aspas, quebra de linha e o "<" (que fecharia o script) — "D'Casa" não quebra a tela */
const _js = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n').replace(/</g, '\\x3c');

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
  /* Codex #695 (P1): a tela da AMB HERDA o último mês conhecido quando falta um mês; o backend da
     empresa pode usar um PADRÃO (GOOD: 15%). Com `aliqPadrao`, todo mês de janeiro do primeiro ano
     conhecido até dezembro do ano seguinte ao atual sai explícito — o mesmo número que o backend usa. */
  const _aliq = Object.assign({}, c.defaultAliq);
  if (c.aliqPadrao != null) {
    const anos = Object.keys(_aliq).map(k => Number(String(k).slice(0, 4))).filter(Number.isFinite);
    const a0 = anos.length ? Math.min.apply(null, anos) : new Date().getFullYear();
    const a1 = new Date().getFullYear() + 1;
    for (let a = a0; a <= a1; a++) for (let m = 1; m <= 12; m++) { const k = a + '-' + String(m).padStart(2, '0'); if (_aliq[k] == null) _aliq[k] = Number(c.aliqPadrao); }
  }
  s = s.replace(reAliq, () => 'const DEFAULT_ALIQ = ' + JSON.stringify(_aliq) + ';   /* da empresa: o MESMO DEFAULT_ALIQ_BK do backend' + (c.aliqPadrao != null ? ', mês sem apuração = ' + c.aliqPadrao + '%' : '') + ' */');
  s = _uma(s, `<img class="logo" src="icone.png?v='+DASH_BUILD+'" alt="AMBTotal" style="object-fit:cover"> Inteligência de Vendas · AMBTotal`,
           `<span class="logo">${_js(_esc(c.logoEmoji))}</span> Inteligência de Vendas · ${_js(_esc(c.nome))}`, 'cabeçalho');
  s = _uma(s, "'/magalu/ir/amb?n='", "'/magalu/ir/" + c.slugMagalu + "?n='", 'link do Magalu');

  /* Codex #695 (P1): CAPACIDADES. A tela da AMB tem seções cujo backend a empresa pode ainda não
     ter (hoje na GOOD: o resumo da Shopee e a venda do dia). Sem isto ela mostraria uma seção que
     falha pra sempre e um botão que recarrega sem atualizar nada. `window.__CAPAC` diz o que existe;
     o que não existe vira um aviso honesto no lugar — e some sozinho quando a capacidade for ligada. */
  const cap = Object.assign({ vendasSync: true, shopeeResumo: true, freteMagalu: true }, c.capacidades || {});
  s = _uma(s, "const MOD = '" + PREFIXO_MODELO + "';", "const MOD = '" + PREFIXO_MODELO + "';\nwindow.__CAPAC = " + JSON.stringify(cap) + ";", 'MOD');
  s = _uma(s, "async function sincVendas(btn){\n", "async function sincVendas(btn){\n  if (window.__CAPAC && window.__CAPAC.vendasSync === false) { if(btn){ btn.disabled=true; btn.textContent='venda do dia ainda não ligada nesta empresa'; } return; }\n", 'venda do dia');
  s = _uma(s, "async function carregarDespesasShopee(){\n", "async function carregarDespesasShopee(){\n  if (window.__CAPAC && window.__CAPAC.shopeeResumo === false) { const _e0 = document.getElementById('shpCards'); if (_e0) _e0.innerHTML = '<span class=\"dim\">o financeiro da Shopee ainda não é coletado nesta empresa</span>'; return; }\n", 'despesas da Shopee');
  s = _uma(s, "['dsScript', 'despesas-shopee', '?v=3']]\n    .forEach(function (par) {", "['dsScript', 'despesas-shopee', '?v=3']]\n    .filter(function (par) { return !(window.__CAPAC && window.__CAPAC.shopeeResumo === false && par[0] === 'dsScript'); })\n    .forEach(function (par) {", 'peças injetadas');

  /* Codex #695 r2: frete do Magalu (nível de desconto) — sem a capacidade, o seletor fica escondido com
     um aviso no lugar, e nem a leitura nem o POST da /config-frete-magalu acontecem */
  s = _uma(s, "    try{ const rm = await fetch(MOD+'/config-frete-magalu',{credentials:'same-origin'});",
              "    if (!(window.__CAPAC && window.__CAPAC.freteMagalu === false)) try{ const rm = await fetch(MOD+'/config-frete-magalu',{credentials:'same-origin'});", 'leitura do frete Magalu');
  s = _uma(s, "      '<div style=\"font-size:12px;color:var(--mut);margin:14px 0 6px\">📦 Nível de desconto do frete Magalu",
              "      ((window.__CAPAC && window.__CAPAC.freteMagalu === false) ? '<div style=\"display:none\">' : '')+'<div style=\"font-size:12px;color:var(--mut);margin:14px 0 6px\">📦 Nível de desconto do frete Magalu", 'bloco do frete Magalu');
  s = _uma(s, "      '</select></label>'+\n    '</div>'+",
              "      '</select></label>'+\n    '</div>'+((window.__CAPAC && window.__CAPAC.freteMagalu === false) ? '</div><div class=\"dim\" style=\"font-size:12px;margin:14px 0 6px\">📦 Frete do Magalu: a previsão do frete ainda não está ligada nesta empresa</div>' : '')+", 'fim do bloco do frete Magalu');
  s = _uma(s, "if(magSel){ try{ await fetch(MOD+'/config-frete-magalu',", "if(magSel && !(window.__CAPAC && window.__CAPAC.freteMagalu === false)){ try{ await fetch(MOD+'/config-frete-magalu',", 'salvar frete Magalu');

  /* Codex #695 (P2): o manifesto do app é por empresa; quem não tem rota de manifesto não anuncia um */
  if (c.manifesto === false) s = _uma(s, '<link rel="manifest" href="manifest.webmanifest">', '', 'manifesto');

  /* Codex #695 (P2): peça da projeção do mês (a da GOOD, que usa dias FECHADOS) — a tela da AMB tem
     a dela embutida; quem já usava a peça não perde a função */
  if (c.projecaoMes) s = _uma(s, '</body>', '<div id="projecaoMesAqui" style="margin:12px"></div>\n<script src="' + PREFIXO_MODELO + '/js/projecao-mes.js" defer></script>\n</body>', 'fim do corpo');
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
