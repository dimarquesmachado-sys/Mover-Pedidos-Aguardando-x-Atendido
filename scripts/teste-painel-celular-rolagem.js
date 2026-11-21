'use strict';
/* 21/11 — CHECKOUT NO CELULAR: A LISTA ROLA COM A PÁGINA INTEIRA (o dono, com o aviso das notas antigas aberto: "não
   consigo rolar pra baixo... só rola do busca pra baixo e toda parte de cima estática").

   A página tinha a altura exata da tela e só a lista rolava por dentro; a barra de painéis, o cabeçalho e os avisos
   ficavam parados ocupando quase a tela. No celular (até 720 px), na LISTA, a página inteira passa a rolar; o pedido
   aberto não muda; e ao fechar o pedido a lista volta pro ponto em que estava (antes, a lista guardava a posição sozinha).

   Prova, no painel de verdade das três empresas:
   A. as regras de celular: na lista a página cresce e rola (body sem altura presa, lista sem rolagem própria), DEPOIS
      da regra que a prendia (a cascata manda); o pedido aberto segue com o topo preso; o computador não muda;
   B. o código de abrir e fechar o pedido (o trecho do painel, rodado como o navegador roda): guarda a posição ao entrar,
      não a troca ao redesenhar o pedido aberto, e devolve ao fechar.
   (Num Chromium de verdade, com 35 pedidos, a barra de painéis e o aviso aberto: antes a página não rolava e a lista rolava
   numa faixa de 400 px; depois a página inteira rola, e abrir/fechar um pedido volta ao mesmo ponto — no PR.) */
const assert = require('assert');
const path = require('path');
const raiz = path.join(__dirname, '..');
const P = require(path.join(raiz, 'lib/checkout/painel/painel-galpao'));

for (const emp of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
  const html = P.renderizar(require(path.join(raiz, emp, 'painel-marca')));
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  /* os blocos de celular, na ordem */
  const blocos = []; const re = /@media\(max-width:720px\)\{/g; let m;
  while ((m = re.exec(css))) { let n = 1, i = re.lastIndex; while (n && i < css.length) { if (css[i] === '{') n++; else if (css[i] === '}') n--; i++; } blocos.push({ ini: m.index, txt: css.slice(re.lastIndex, i - 1) }); }
  const regra = (sel) => { const r = []; blocos.forEach((b, k) => { const rx = new RegExp('(^|\\n|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'g'); let x; while ((x = rx.exec(b.txt))) r.push({ bloco: k, pos: b.ini + x.index, corpo: x[2] }); }); return r; };
  const uma = (sel) => { const r = regra(sel); assert.strictEqual(r.length, 1, emp + ': ' + sel + ' aparece ' + r.length + ' vez(es) nas regras de celular'); return r[0]; };

  /* A. na lista, a página rola */
  const corpo = uma('body:not(.peddet)'), main = uma('body:not(.peddet) .main'), side = uma('body:not(.peddet) .sidebar'), presa = uma('.sidebar');
  assert.ok(/(^|;)height:auto(;|$)/.test(corpo.corpo) && /min-height:100%/.test(corpo.corpo), emp + ': na lista, o body não fica preso na altura da tela: ' + corpo.corpo);
  assert.ok(/flex:0 0 auto/.test(main.corpo), emp + ': a área principal cresce com a lista: ' + main.corpo);
  assert.ok(/flex:0 0 auto/.test(side.corpo) && /overflow:visible/.test(side.corpo), emp + ': a lista não rola por dentro (quem rola é a página): ' + side.corpo);
  assert.ok(/flex:1 1 auto/.test(presa.corpo) && side.pos > presa.pos && side.bloco === presa.bloco, emp + ': a regra nova vem DEPOIS da que prendia a lista, no mesmo bloco (senão a cascata volta pra antiga)');
  /* só no celular: fora dos blocos de 720 px, nada disso existe; e o computador segue com o body preso e a lista rolando por dentro */
  const fora = blocos.reduceRight((t, b) => t.slice(0, b.ini) + t.slice(b.ini + b.txt.length + 22), css);
  assert.ok(!/:not\(\.peddet\)/.test(fora) && /html,body\{height:100%\}/.test(fora) && /\.sidebar\{width:410px;[^}]*overflow-y:auto/.test(fora), emp + ': o computador não muda');
  /* o pedido aberto segue igual: as regras novas não pegam nele, e o topo e o bipe continuam presos */
  assert.ok(/position:sticky;top:0/.test(uma('body.peddet .dhead').corpo) && /position:sticky;top:54px/.test(uma('body.peddet .scanrow').corpo), emp + ': o topo do pedido aberto continua preso');
  assert.ok(/display:none/.test(uma('body.peddet .sidebar').corpo) && regra('body.peddet .detail').some((r) => /display:block/.test(r.corpo)));

  /* B. abrir e fechar o pedido: o trecho de verdade, rodado */
  const js = html.slice(html.indexOf('<script>', html.indexOf('</style>')));
  const iAbre = js.indexOf("  if (!document.body.classList.contains('peddet')) _rolagemDaLista = window.scrollY || 0;\n  document.body.classList.add('peddet');");
  assert.ok(iAbre > 0, emp + ': o pedido aberto tem que guardar a posição da lista ANTES de virar tela de pedido');
  assert.strictEqual(js.split("document.body.classList.add('peddet')").length - 1, 1, emp + ': um lugar só abre o pedido');
  assert.strictEqual(js.split("document.body.classList.remove('peddet')").length - 1, 1, emp + ': um lugar só fecha o pedido');
  const abre = js.slice(iAbre, js.indexOf('\n', js.indexOf("document.body.classList.add('peddet');", iAbre)) + 1);
  const iF = js.indexOf('let _rolagemDaLista = 0;\nfunction mostrarPlaceholder(){');
  assert.ok(iF > 0, emp + ': falta o fechar do pedido');
  const fecha = js.slice(iF, js.indexOf('\n}\n', iF) + 3);
  const classes = new Set(); const rolou = [];
  const janela = { scrollY: 0, scrollTo: (x, y) => { rolou.push(y); janela.scrollY = y; } };
  const docu = { body: { classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } };
  const el = { innerHTML: '' };
  const api = new Function('window', 'document', '$', fecha + '\nreturn { abrir: function(){ ' + abre + ' }, fechar: mostrarPlaceholder, guardado: function(){ return _rolagemDaLista; } };')(janela, docu, () => el);
  janela.scrollY = 2400; api.abrir();
  assert.deepStrictEqual([classes.has('peddet'), api.guardado()], [true, 2400], emp + ': ao abrir, guarda onde a lista estava');
  janela.scrollY = 0; api.abrir();   /* o pedido aberto é redesenhado (bipe, atualização): a página dele está no topo */
  assert.strictEqual(api.guardado(), 2400, emp + ': redesenhar o pedido aberto não troca a posição guardada');
  api.fechar();
  assert.deepStrictEqual([classes.has('peddet'), rolou, /selecione um pedido/.test(el.innerHTML)], [false, [2400], true], emp + ': ao fechar, a lista volta pro mesmo ponto');
  api.fechar();   /* fechar sem pedido aberto (troca de filtro, lista vazia): não mexe na rolagem */
  assert.deepStrictEqual(rolou, [2400], emp + ': fechar sem pedido aberto não mexe na rolagem');
  delete janela.scrollY; api.abrir(); assert.strictEqual(api.guardado(), 0, emp + ': sem posição conhecida, guarda o topo');
}
console.log('ok — checkout no celular: na lista a página inteira rola (o topo sobe junto), o pedido aberto não muda, e ao fechar o pedido a lista volta ao mesmo ponto — nas três empresas');
