'use strict';
/* 27/10 — o PAINEL DO GALPÃO virou PEÇA ÚNICA (lib/checkout/painel/painel-galpao.html + .js): eram três cópias de ~2.300
   linhas, ~96% iguais. Passo 1 (este): a Girassol serve o painel da peça. Prova:
   · o painel renderizado com a marca da Girassol é BYTE A BYTE o painel.html dela de antes (sha256 de antes da troca);
   · marca incompleta não sobe (erro em vez de {{…}} na tela); não sobra marcador;
   · a rota do painel da Girassol entrega a peça, e a versão do painel (o servidor compara com a do navegador) vem da marca. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const P = require('../lib/checkout/painel/painel-galpao');

const SHA_GIRASSOL_ANTES = 'd74373c3987f97de10a77fad5db98c9be49cb47596db67cda5cc7f0719dd9eb0';   /* girassol-backup-offline/painel.html em 27/10, antes da troca */
const marca = require('../girassol-backup-offline/painel-marca');
/* 30/10: a Girassol ganhou o botão 📎 das etiquetas em massa (BOTOES_EXTRA) e o painel subiu de versão (b143) — mudanças
   DA MARCA, de propósito. O byte a byte abaixo confere o MODELO: renderizado com a marca como era (sem o botão, b142) */
assert.ok(P.renderizar(marca).includes("window.open('/girassol-backup-offline/etiquetas-massa'"), 'a Girassol não ganhou o botão 📎 das etiquetas em massa');
const _htmlComFoto = P.renderizar(Object.assign({}, marca, { BOTOES_EXTRA: '', UI_BUILD: 'b142' }));
/* 31/10: o modelo ganhou a FOTO do produto maior no item do pedido (pedido do dono) — mudança de propósito, nas três. O
   bloco do estilo novo tem que estar lá (uma vez); pro byte a byte da Girassol, sai do texto antes da conta */
const FOTO = _htmlComFoto.slice(_htmlComFoto.indexOf('  /* 31/10 (pedido do dono): a FOTO do produto'), _htmlComFoto.indexOf('  @keyframes shake'));
assert.ok(FOTO.includes('.item .thumb{width:120px;height:120px;flex:0 0 120px') && _htmlComFoto.split(FOTO).length === 2, 'a foto maior do produto não está no modelo (uma vez)');
/* 31/10: a LETRA da área dos itens ~2× — mudada nas próprias regras de BASE (Codex #783: num bloco antes delas, a cascata
   voltava pro tamanho antigo e o texto do estilo estava lá sem valer nada). Por isso a conferência é do tamanho QUE VALE:
   a ÚLTIMA regra de cada seletor fora dos @media, e o @media do celular DEPOIS delas. */
function _semMedia(css) { let out = '', i = 0; while (i < css.length) { const k = css.indexOf('@media', i); if (k < 0) { out += css.slice(i); break; } out += css.slice(i, k); let j = css.indexOf('{', k), n = 1; j++; while (j < css.length && n > 0) { if (css[j] === '{') n++; else if (css[j] === '}') n--; j++; } i = j; } return out; }
function _tamanhoQueVale(css, sel) { let v = null; for (const m of _semMedia(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) { const sels = m[1].split(',').map((x) => x.trim()); const fs2 = /font-size:\s*([^;]+)/.exec(m[2]); if (sels.includes(sel) && fs2) v = fs2[1].trim(); } return v; }
{ const css = _htmlComFoto.slice(_htmlComFoto.indexOf('<style>'), _htmlComFoto.indexOf('</style>'));
  for (const [sel, px] of [['.idesc .d', '28px'], ['.idesc .e', '22px'], ['.idesc .estoque', '20px'], ['.icount', '34px'], ['.kithead', '26px'], ['.ktag', '16px']]) {
    assert.strictEqual(_tamanhoQueVale(css, sel), px, 'o tamanho que VALE pra ' + sel + ' não é o novo (a cascata desfaz?)');
  }
  const iCel = css.lastIndexOf('@media(max-width:720px){ .idesc .d{font-size:20px}'), iBase = css.lastIndexOf('.idesc .estoque{margin-top:6px');
  assert.ok(iCel > iBase && iBase > 0, 'o ajuste do celular tem que vir DEPOIS das regras de base (senão não vale)'); }
const LETRA = [
  ['font-size:26px;border-bottom:1px solid var(--line)}', 'font-size:14px;border-bottom:1px solid var(--line)}'],
  ['  .ktag{display:inline-block;font-size:16px;', '  .ktag{display:inline-block;font-size:10px;'],
  ['  .icount{font-size:34px;font-weight:800;min-width:96px;', '  .icount{font-size:19px;font-weight:800;min-width:60px;'],
  ['  .idesc .d{font-size:28px;line-height:1.25}', '  .idesc .d{font-size:14px}'],
  ['  .idesc .e{font-size:22px;color:var(--mut);font-family:ui-monospace,monospace;margin-top:4px}', '  .idesc .e{font-size:12px;color:var(--mut);font-family:ui-monospace,monospace;margin-top:2px}'],
  ['  .idesc .estoque{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;font-size:20px}', '  .idesc .estoque{margin-top:3px;display:flex;flex-wrap:wrap;gap:5px}'],
];
let _semLetra = _htmlComFoto.replace(FOTO, '');
for (const [novo, velho] of LETRA) { assert.strictEqual(_semLetra.split(novo).length, 2, 'a mudança de letra não está no modelo (uma vez): ' + novo.slice(0, 40)); _semLetra = _semLetra.replace(novo, velho); }
const _iL = _semLetra.indexOf('  /* 31/10 (pedido do dono, com o print do 1º pedido real depois da reativação)'), _fimL = '{ .idesc .d{font-size:20px} .idesc .e{font-size:16px} .idesc .estoque{font-size:15px} .icount{font-size:26px;min-width:70px} .kithead{font-size:19px} }\n';
assert.ok(_iL > 0, 'o bloco da letra (celular) não está no modelo');
const html = _semLetra.slice(0, _iL) + _semLetra.slice(_semLetra.indexOf(_fimL, _iL) + _fimL.length);
/* passo 2 (27/10): o modelo ganhou o liga/desliga do botão de etiquetas em massa (só a GOOD tem o botão; sem ele, a linha
   não faz nada) — tirando ESSA linha, a Girassol continua byte a byte o painel de antes */
const B3 = " const b3=document.getElementById('btnEtqMassa'); if(b3) b3.style.display = souAdmin()? '' : 'none';";
assert.strictEqual(html.split(B3).length, 2, 'o liga/desliga do botão de etiquetas em massa não está no modelo (uma vez)');
/* Codex #758: o histórico ganhou o link da NF no Bling (o painel da GOOD tinha; agora as três) — a outra mudança de
   propósito na Girassol. Tirando as duas, byte a byte o de antes. */
const NF_HIST = "' '+linkBlingNF(h)+linksMkt(h)";
assert.strictEqual(html.split(NF_HIST).length, 2, 'o histórico não ganhou o link da NF (uma vez)');
/* 01/11 (auditoria do Codex, achado F10): o reabrir do histórico passou a ir por POST (a rota grava; GET de outro site com o
   admin logado disparava) -- a outra mudança de propósito; pro byte a byte, volta ao texto de antes */
/* 07/11: o card mostra o que pegar com a quantidade — a mudança de propósito; pro byte a byte, volta ao texto de antes */
const CARD_PICK_NOVO = "      /* 07/11 (pedido do dono): o card mostra o que o estoquista PEGA, com a quantidade — kit vira os componentes e o total\n         sai em unidades. O \"1 item(s)\" contava LINHAS do pedido: kit de 3 lixas e pendente ×2 apareciam \"1 item(s)\" e\n         confundiam. Pedido sem a lista (cache antigo, sem pedido.json) continua do jeito de antes. */\n      /* 08/11 (pedido do dono): a QUANTIDADE em destaque — estava escura e difícil de ver; mais de 1 ganha a etiqueta laranja */\n      (function(){\n        var pk=Array.isArray(p.pick)?p.pick:null, kt=(p.kits||[]).filter(Boolean);\n        if(pk){\n          if(pk.length<2 && !kt.length) return '';\n          return '<div class=\"sskus\">'+(kt.length?'<div style=\"opacity:.75\">🧩 kit '+kt.map(esc).join(', ')+'</div>':'')+pk.map(function(x){return '<div>📦 <b>'+esc(x.sku)+'</b> '+qtdHtml(x.qtd)+'</div>';}).join('')+'</div>';\n        }\n        var ss=(p.skus||[]).filter(Boolean);   // 2+ SKUs: um por linha\n        if(ss.length<2) return '';\n        return '<div class=\"sskus\">'+ss.map(function(x){return '<div>📦 <b>'+esc(x)+'</b></div>';}).join('')+'</div>';\n      })()+\n      '<div class=\"smeta\">'+(function(){\n        var pk=Array.isArray(p.pick)?p.pick:null, kt=(p.kits||[]).filter(Boolean);\n        if(pk) return ((pk.length===1&&!kt.length)?'📦 <b>'+esc(pk[0].sku)+'</b> '+qtdHtml(pk[0].qtd)+' · ':'')+'<b class=\"sun\">'+(p.unidades||0)+' un</b>';\n        return (((p.skus||[]).filter(Boolean).length===1)?'📦 <b>'+esc(p.skus[0])+'</b> · ':'')+(p.itens||0)+' item(s)';\n      })()+' · NF '";   /* 08/11: + a quantidade em destaque */
const CARD_PICK_VELHO = "      (function(){   // 2+ SKUs: um por linha\n        var ss=(p.skus||[]).filter(Boolean);\n        if(ss.length<2) return '';\n        return '<div class=\"sskus\">'+ss.map(function(x){return '<div>📦 <b>'+esc(x)+'</b></div>';}).join('')+'</div>';\n      })()+\n      '<div class=\"smeta\">'+(((p.skus||[]).filter(Boolean).length===1)?'📦 <b>'+esc(p.skus[0])+'</b> · ':'')+(p.itens||0)+' item(s) · NF '";
assert.strictEqual(html.split(CARD_PICK_NOVO).length, 2, 'o card da lista não mostra o que pegar (uma vez)');
/* 08/11: a quantidade em destaque — a função e o estilo novos, desfeitos pro byte a byte */
const QTD_JS = "\n/* 08/11: a quantidade do card da lista em destaque (pedido do dono) — ×1 claro e forte; mais de 1 numa etiqueta laranja */\nconst qtdHtml = q => '<span class=\"sqtd'+(Number(q)>1?' sqtd-mais':'')+'\">×'+esc(q)+'</span>';";
const QTD_CSS = "\n  /* 08/11: a quantidade em destaque (estava na cor apagada do texto) */\n  .sqtd{color:#fde68a;font-weight:800;font-size:1.12em;font-family:ui-monospace,monospace;margin-left:2px}\n  .sqtd-mais{background:#b45309;color:#fff;padding:0 6px;border-radius:6px}\n  .sun{color:#e5e7eb;font-weight:800}";
assert.strictEqual(html.split(QTD_JS).length, 2, 'a função da quantidade em destaque não está no painel (uma vez)');
assert.strictEqual(html.split(QTD_CSS).length, 2, 'o estilo da quantidade em destaque não está no painel (uma vez)');
/* 08/11: a proporção lista × pedido no computador (cards +10%, pedido −10%) — o estilo novo, desfeito pro byte a byte */
const LAYOUT_CSS = "\n  /* 08/11 (pedido do dono): no COMPUTADOR, os cards da lista ~10% maiores e a área do pedido ~10% menor — a lista ganha\n     10% de largura (410 → 451 px) e o conteúdo de cada card cresce 10%; o pedido aberto fica 10% menor. O celular (até\n     720 px) fica como estava. */\n  @media(min-width:721px){ .sidebar{width:451px;flex:0 0 451px} .sidebar .scard{zoom:1.1} .detail{zoom:.9} }";
assert.strictEqual(html.split(LAYOUT_CSS).length, 2, 'a proporção nova da lista e do pedido não está no painel (uma vez)');
const REABRIR_POST = ", {method:'POST'});   /* 01/11 (Codex F10): o reabrir grava -- so POST */";
assert.strictEqual(html.split(REABRIR_POST).length, 2, 'o reabrir do histórico não está indo por POST (uma vez)');
/* 11/11 (dono: "jamais pode dar acesso ao dashboard pro estoquista... vai que um dia apaga"): três mudanças de propósito
   — lista de admins vazia = NINGUÉM é admin (antes: todo mundo); a barra de cima escolhida pelo papel (admin: os painéis;
   estoquista: só o Estoque e as Devoluções da empresa dele); e a versão nova da barra. Pro byte a byte, voltam ao de antes. */
const ADM_NOVO = "/* 11/11: lista de admins vazia = NINGUÉM é admin (antes: todo mundo) — igual ao servidor */\nfunction souAdmin(){ const a = window.ADMINS || []; return a.includes(opAtual().toLowerCase()); }", ADM_VELHO = "function souAdmin(){ const a = window.ADMINS || []; return a.length===0 || a.includes(opAtual().toLowerCase()); }";
const BARRA_NOVO = " /* 11/11: admin vê a barra de painéis (com os avisos); o ESTOQUISTA vê no máximo o Estoque e as Devoluções DA EMPRESA DELE — nada de outros painéis nem avisos. Trocar de usuário sem recarregar refaz a barra (não sobra a do admin). */\n  if(souAdmin()){ if(window.navPaineisMostrar) window.navPaineisMostrar(); } else if(window.navPaineisEstoquista) window.navPaineisEstoquista();}", BARRA_VELHO = " if(souAdmin() && window.navPaineisMostrar) window.navPaineisMostrar();}";
const NAVV_NOVO = "<script src=\"/comum/nav.js?v=20261111\" data-so-admin></script>", NAVV_VELHO = "<script src=\"/comum/nav.js?v=20261027\" data-so-admin></script>";
for (const [n, oq] of [[ADM_NOVO, 'a regra do admin'], [BARRA_NOVO, 'a barra por papel'], [NAVV_NOVO, 'a versão da barra']]) assert.strictEqual(html.split(n).length, 2, oq + ' não está no painel (uma vez)');
/* 11/11 (dono: no celular o checkout estava "praticamente inutilizável"): o PEDIDO ABERTO no celular — um bloco de estilo só
   pra tela estreita (topo e bipe presos, cabeçalho geral escondido dentro do pedido, item com a descrição em cima, o
   conferido encolhido). Mudança de propósito; pro byte a byte, sai. O computador não muda (o bloco é todo @media ≤720px). */
const CEL_CSS = "  /* 11/11 (pedido do dono: no celular o checkout estava \"praticamente inutilizável... tem que ser fácil, simples pro\n     estoquista ver todo o pedido, bipar e zerar até o fim\") — O PEDIDO ABERTO NO CELULAR. Só até 720 px; o computador não\n     muda. A tela vira do pedido: somem o cabeçalho geral (título, botões, operador, contadores), a barra de atalhos e o\n     rodapé; o topo (Voltar · nº · progresso) e o campo de bipe ficam PRESOS no alto enquanto os itens rolam; o item deixa\n     de espremer a descrição ao lado da foto (ela quebrava em 7 linhas e um item ocupava a tela): descrição em cima, na\n     largura toda, e embaixo a foto pequena, SKU/EAN/local e o contador grande; o item CONFERIDO encolhe pra uma linha —\n     sobra na tela o que ainda falta. */\n  @media(max-width:720px){\n    body.peddet header, body.peddet .foot{display:none}\n    body.peddet #nav-paineis{display:none!important}   /* a barra nasce com display no próprio elemento */\n    body.peddet .detail{padding:0 12px 14px}\n    body.peddet .dhead{position:sticky;top:0;z-index:6;background:var(--bg);height:54px;box-sizing:border-box;margin:0;padding:6px 0;gap:8px}\n    body.peddet .dhead .prog{margin-left:auto}\n    body.peddet .scanrow{position:sticky;top:54px;z-index:6;background:var(--bg);margin:0;padding:6px 0 8px}\n    body.peddet .scanrow #scan{padding:12px;font-size:17px}\n    body.peddet .hint{display:none}\n    .item{display:grid;grid-template-columns:56px minmax(0,1fr) auto;grid-template-areas:\"d d d\" \"t e c\" \"t s c\";column-gap:10px;row-gap:4px;align-items:center;padding:10px}\n    .item .thumb,.item.comp .thumb{grid-area:t;width:56px;height:56px;flex:none;align-self:start}\n    .item .icount{grid-area:c;font-size:30px;min-width:62px}\n    .item .idesc{display:contents}\n    .item .idesc .d{grid-area:d;font-size:17px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n    .item .idesc .e{grid-area:e;font-size:13px;margin-top:0;overflow-wrap:anywhere}\n    .item .idesc .estoque{grid-area:s;font-size:13px;margin-top:0;gap:5px}\n    .item .miniok{grid-column:1 / -1;justify-self:end}\n    .item.full{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:\"d c\";padding:7px 10px}\n    .item.full .thumb,.item.full .idesc .e,.item.full .idesc .estoque{display:none}\n    .item.full .idesc .d{font-size:14px;-webkit-line-clamp:1}\n    .item.full .icount{font-size:20px;min-width:52px}\n  }\n";
assert.strictEqual(html.split(CEL_CSS).length, 2, 'o estilo do pedido aberto no celular não está no painel (uma vez)');
assert.ok(/^\s*\/\*[\s\S]*?\*\/\s*@media\(max-width:720px\)\{[\s\S]*\}\s*$/.test(CEL_CSS) && !/@media\(min-width/.test(CEL_CSS), 'o bloco do celular tem que estar TODO dentro do @media de tela estreita');
assert.strictEqual(crypto.createHash('sha256').update(html.replace(CEL_CSS, '').replace(ADM_NOVO, ADM_VELHO).replace(BARRA_NOVO, BARRA_VELHO).replace(NAVV_NOVO, NAVV_VELHO).replace(B3, '').replace(NF_HIST, "' '+linksMkt(h)").replace(REABRIR_POST, ');').replace(CARD_PICK_NOVO, CARD_PICK_VELHO).replace(QTD_JS, '').replace(QTD_CSS, '').replace(LAYOUT_CSS, ''), 'utf8').digest('hex'), SHA_GIRASSOL_ANTES, 'o painel da Girassol pela peça mudou além das duas mudanças de propósito (byte a byte)');
assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'sobrou marcador no painel');
let erro = null; try { P.renderizar(Object.assign({}, marca, { LOGO: '' })); } catch (e) { erro = e.message; }
assert.ok(erro && /não tem LOGO/.test(erro), 'marca incompleta tinha que recusar: ' + erro);
const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
/* 31/10: a rota do painel foi pra peça das rotas comuns, que entrega o painel com a marca DA EMPRESA (painelMarca) */
const _rcP = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
assert.ok(_rcP.includes("const htmlContent = require('./painel/painel-galpao').painelDaEmpresa(painelMarca());") && gbo.includes("painelMarca: () => require('./painel-marca'),"), 'a rota do painel da Girassol não entrega a peça');
assert.ok(gbo.includes("uiBuild: require('./painel-marca').UI_BUILD,"), 'a versão do painel da Girassol não vem da marca');
assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'painel.html')), 'sobrou a cópia do painel na pasta da Girassol');
assert.strictEqual(require('../lib/checkout/contexto-api').montar ? 'ok' : 'x', 'ok');
/* passo 2 (27/10) — a AMB e a GOOD servem a mesma peça, NIVELANDO POR CIMA: tudo o que o painel delas tinha (funções,
   elementos e rotas — a lista guardada antes de apagar as cópias) continua; e cada uma ganha o que faltava */
const antes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'painel-amb-good-antes.json'), 'utf8'));
const linhasAntes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'painel-amb-good-linhas.json'), 'utf8'));
const re = require('../scripts/fixtures/_feats-painel-helper.js');
for (const [pasta, emp] of [['amb-checkout-offline', 'amb'], ['good-checkout-offline', 'good']]) {
  const mk = require('../' + pasta + '/painel-marca');
  const h = P.renderizar(mk);
  const f = re.feats(h);
  for (const k of ['funcoes', 'ids', 'rotas']) {
    const perdeu = antes[pasta][k].filter((x) => !f[k].includes(x));
    assert.deepStrictEqual(perdeu, [], pasta + ': o painel único PERDEU ' + k + ' que ela tinha: ' + perdeu.join(', '));
  }
  /* Codex #758 — a conta FINA: TODA linha de código do painel de antes tem que estar no novo, a não ser as mudanças de
     propósito (listadas uma a uma na referência: versão, liga/desliga, os ganhos). A lista de funções não pegou a chave
     do /fragil/ da AMB nem o link da NF do histórico da GOOD; esta pega. */
  /* 30/10: a AMB ganhou o botão 📎 das etiquetas em massa (BOTOES_EXTRA, da marca) — a conta fina das linhas olha o MODELO
     com a marca como era (sem o botão); que o botão está lá é conferido à parte */
  if (emp === 'amb') assert.ok(h.includes("window.open('/amb-checkout-offline/etiquetas-massa'"), 'a AMB não ganhou o botão 📎 das etiquetas em massa');
  /* 31/10: a letra maior dos itens (mudança de propósito nas regras de base) — a conta fina das linhas olha o modelo com
     ela desfeita, como faz com o botão da AMB; que ela vale está conferido acima (o tamanho que VALE) */
  const _desfazLetra = (x) => { let y = x; for (const [novo, velho] of LETRA) y = y.replace(novo, velho); const i0 = y.indexOf('  /* 31/10 (pedido do dono, com o print do 1º pedido real depois da reativação)'); return i0 < 0 ? y : y.slice(0, i0) + y.slice(y.indexOf(_fimL, i0) + _fimL.length); };
  /* 01/11 (Codex F10): o reabrir por POST, desfeito do mesmo jeito (a mudança de propósito está conferida acima) */
  /* 11/11: a regra do admin, a barra por papel e a versão da barra, desfeitas do mesmo jeito (conferidas acima) */
  const nov = re.linhasCodigo(_desfazLetra(emp === 'amb' ? P.renderizar(Object.assign({}, mk, { BOTOES_EXTRA: '' })) : h).replace(CEL_CSS, '').replace(ADM_NOVO, ADM_VELHO).replace(BARRA_NOVO, BARRA_VELHO).replace(NAVV_NOVO, NAVV_VELHO).replace(REABRIR_POST, ');').replace(CARD_PICK_NOVO, CARD_PICK_VELHO).replace(QTD_JS, '').replace(QTD_CSS, '').replace(LAYOUT_CSS, ''));
  const perdidas = linhasAntes.linhas[pasta].filter((x) => !nov.has(x) && !(x in linhasAntes.permitidas[pasta]));
  assert.deepStrictEqual(perdidas, [], pasta + ': o painel único PERDEU linha(s) de código do painel de antes: ' + perdidas.join(', '));
  assert.ok(h.includes("/fragil/api/skus?empresa=" + (mk.EMPRESA_FRAGIL || mk.EMPRESA) + "'") && (emp !== 'amb' || h.includes("/fragil/api/skus?empresa=ambtotal'")), pasta + ': a lista de frágeis não é pedida com a chave da empresa no /fragil/');
  for (const [ganho, rx] of [['aviso do canário', /id="canarioAviso"/], ['checar o canário', /async function checarCanario\(\)/], ['📎 anexar NF', /async function anexarNF\(/],
                             ['agrupar por produto (maior grupo primeiro)', /GRUPOS MAIORES PRIMEIRO/], ['Shein', /shein:\{n:'Shein'/], ['📈 Dashboard', /id="btnDashboard"/]]) {
    assert.ok(rx.test(h), pasta + ': não ganhou ' + ganho);
  }
  assert.ok(h.includes("fetch('/" + pasta + "/canario-estado'") && h.includes('/magalu/ir/' + emp + '?n=') && h.includes('/fragil/api/skus?empresa=' + emp), pasta + ': rota de outra empresa no painel');
  for (const outra of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline'].filter((x) => x !== pasta)) assert.ok(!h.includes('/' + outra + '/'), pasta + ': o painel tem rota da ' + outra);
  assert.ok(h.includes("const UI_BUILD = '" + mk.UI_BUILD + "';") && h.includes('<title>' + mk.TITULO + '</title>'), pasta + ': versão ou título não são os da marca');
  /* 30/10: as rotas de lote viraram peça (lib/checkout/rotas-lote) e as TRÊS servem — o botão existe nas três, e cada um
     aponta pra rota da PRÓPRIA empresa (a regra de antes era: botão só onde o servidor tem a rota; continua valendo) */
  assert.ok(/id="btnEtqMassa"/.test(h) && h.includes("window.open('/" + pasta + "/etiquetas-massa'"), pasta + ': o botão de etiquetas em massa tem que existir e apontar pra rota DELA');
  const ix = fs.readFileSync(path.join(raiz, pasta, 'index.js'), 'utf8');
  /* 31/10: a rota do painel foi pra peça das rotas comuns, que entrega o painel com a marca DA EMPRESA (painelMarca) */
  assert.ok(_rcP.includes("const htmlContent = require('./painel/painel-galpao').painelDaEmpresa(painelMarca());") && ix.includes("painelMarca: () => require('./painel-marca'),") && ix.includes("uiBuild: require('./painel-marca').UI_BUILD,"), pasta + ': a rota não entrega a peça (ou a versão não vem da marca)');
  assert.ok(!fs.existsSync(path.join(raiz, pasta, 'painel.html')), pasta + ': sobrou a cópia do painel');
}
console.log('ok — painel do galpão em peça única nas três: a Girassol byte a byte (fora o liga/desliga inerte); AMB e GOOD com tudo o que tinham e mais o que faltava');
