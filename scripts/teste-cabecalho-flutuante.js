'use strict';
/* 26/11 — O CABEÇALHO DA TABELA ACOMPANHA A ROLAGEM também na tela grande, pras tabelas com rolagem própria (o Plano de
   Compra). O dono: "sempre q tiver um card e descer, tem q vir junto o menuzinho superior, pra eu saber o q significa
   cada coluna".

   O que se prova — a função de PRODUÇÃO `atualizarCabecalhoFlutuante`, tirada do dashboard.html e rodada num navegador de
   mentira:
   · tela grande: só as áreas marcadas com data-cabflut ganham a barra (as .tw comuns grudam sozinhas e não são tocadas);
   · celular: todas (.tw e as marcadas), como sempre;
   · a barra aparece quando a tabela passou do topo e ainda está em vista; some antes e depois;
   · copia os títulos com a largura e o alinhamento de cada coluna, e acompanha a rolagem lateral;
   · a tabela redesenhada (o plano remonta a cada mexida) tem o cabeçalho copiado de novo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'lib/checkout/painel/dashboard.html'), 'utf8');
const ini = html.indexOf('let _barraCab = null, _tabAtual = null, _trAtual = null;'), fimF = html.indexOf('function montarNavCards(){');
assert.ok(ini > 0 && fimF > ini, 'achei a função no dashboard.html');
const fonte = html.slice(ini, fimF);

function mundo(largura) {
  const m = { largura, hdr: 100, lista: [], criados: [], seletores: [] };
  const barra = { style: {}, innerHTML: '', _inner: { scrollLeft: 0 }, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, querySelector: (s) => (s === '.cabInner' ? barra._inner : null) };
  m.barra = barra;
  const document = { querySelector: (s) => (s === '.hdr' ? { offsetHeight: m.hdr } : null), querySelectorAll: (s) => { m.seletores.push(s); return m.lista.filter((t) => (s.includes('.tw') ? true : t.cabflut)); },
    createElement: () => { m.criados.push(1); return barra; }, body: { appendChild: () => {} } };
  const window = { get innerWidth() { return m.largura; } };
  m.rodar = new Function('document', 'window', fonte + '\nreturn function(){ atualizarCabecalhoFlutuante(); };')(document, window);
  return m;
}
const th = (texto, w, alinhamento, o) => { o = o || {}; const e = { innerHTML: texto, style: { textAlign: alinhamento || '' }, getBoundingClientRect: () => ({ width: w }), cliques: 0, click() { e.cliques++; },
  classList: { contains: (c) => c === 'sort' && !!o.sort }, caixa: o.caixa ? { cliques: 0, click() { e.caixa.cliques++; } } : null, querySelector: (s) => (s === 'input' ? e.caixa : null) }; return e; };
/* um clique na cópia: o alvo é o <th> nº i da barra (ou uma caixa dentro dele) */
const clicaNaBarra = (m, i, n, tag) => { const irmaos = Array.from({ length: n }, () => ({})); const pai = { children: irmaos }; irmaos.forEach((x) => { x.parentNode = pai; });
  m.barra._ev.click({ target: { tagName: tag || 'TH', closest: (s) => (s === 'th' ? irmaos[i] : null) } }); };
const area = (o) => { const tr = { children: o.ths }; const tb = { querySelector: (s) => (s === 'tr' ? tr : null) };
  return { cabflut: !!o.cabflut, offsetParent: o.escondida ? null : {}, scrollLeft: o.scrollLeft || 0, tb, querySelector: (s) => (s === 'table' ? (o.semTabela ? null : tb) : null), getBoundingClientRect: () => ({ top: o.top, bottom: o.bottom, left: o.left == null ? 40 : o.left, width: o.width || 900 }) }; };

/* ── tela grande ── */
{
  const m = mundo(1400);
  /* nenhuma área marcada: nada acontece, nem a barra é criada */
  m.lista = [area({ ths: [th('a', 10)], top: -500, bottom: 900 })];
  m.rodar(); assert.deepStrictEqual([m.criados.length, m.seletores], [0, ['[data-cabflut]']], 'tela grande só olha as marcadas');
  /* o plano (marcado) passou do topo: a barra aparece, com os títulos, as larguras e o alinhamento */
  const plano = area({ cabflut: true, ths: [th('<input type="checkbox">', 26, '', { caixa: true }), th('SKU', 120, '', { sort: true }), th('saldo', 80, 'right'), th('curva', 50, 'center'), th('x', 10, 'justify')], top: -300, bottom: 800, left: 60, width: 1200, scrollLeft: 35 });
  m.lista = [area({ ths: [th('outra', 10)], top: -500, bottom: 900 }), plano];
  m.rodar();
  assert.deepStrictEqual([m.barra.style.display, m.barra.style.top, m.barra.style.left, m.barra.style.width, m.barra._inner.scrollLeft], ['block', '100px', '60px', '1200px', 35], JSON.stringify(m.barra.style));
  assert.strictEqual(m.barra.innerHTML, '<div class="cabInner"><table><tr><th class="clica" style="width:26px;min-width:26px"><input type="checkbox"></th><th class="clica" style="width:120px;min-width:120px">SKU</th><th style="width:80px;min-width:80px;text-align:right">saldo</th><th style="width:50px;min-width:50px;text-align:center">curva</th><th style="width:10px;min-width:10px">x</th></tr></table></div>');
  /* clicar na cópia vale como clicar no título de verdade, e a cópia é refeita (a seta mudou); a caixa de marcar todos
     da cópia clica a caixa de verdade, não o título */
  { const P = plano.tb.querySelector('tr').children;
    m.barra.innerHTML = 'VELHA'; clicaNaBarra(m, 1, 5);
    assert.deepStrictEqual([P.map((x) => x.cliques), /SKU/.test(m.barra.innerHTML)], [[0, 1, 0, 0, 0], true], 'clique no 2º título da cópia = clique no 2º título da tabela; cópia refeita');
    clicaNaBarra(m, 2, 5);
    assert.deepStrictEqual(P.map((x) => x.cliques), [0, 1, 1, 0, 0], 'cada título da cópia leva ao título da mesma posição');
    clicaNaBarra(m, 0, 5, 'INPUT');
    assert.deepStrictEqual([P[0].cliques, P[0].caixa.cliques], [0, 1], 'a caixa da cópia clica a caixa de verdade');
    clicaNaBarra(m, 0, 5);
    assert.deepStrictEqual([P[0].cliques, P[0].caixa.cliques], [1, 1], 'clique no título (fora da caixa) vai pro título');
    clicaNaBarra(m, 1, 5, 'INPUT');
    assert.deepStrictEqual([P[1].cliques], [2], 'título sem caixa: o clique vai pro título mesmo vindo de um input');
    /* alvo fora de título, posição que não existe, alvo sem closest, evento vazio: nada acontece e nada estoura */
    m.barra.innerHTML = 'QUIETA';
    clicaNaBarra(m, 7, 9); m.barra._ev.click({ target: { closest: () => null } }); m.barra._ev.click({ target: {} }); m.barra._ev.click({}); m.barra._ev.click();
    assert.deepStrictEqual([P.map((x) => x.cliques), m.barra.innerHTML], [[1, 2, 1, 0, 0], 'QUIETA']);
    m.rodar(); }
  /* a rolagem lateral do card é acompanhada; a largura não passa da tela */
  plano.scrollLeft = 210; plano.getBoundingClientRect = () => ({ top: -300, bottom: 800, left: -20, width: 3000 }); m.rodar();
  assert.deepStrictEqual([m.barra._inner.scrollLeft, m.barra.style.left, m.barra.style.width], [210, '0px', '1400px']);
  /* a tabela redesenhada (outro elemento) tem o cabeçalho copiado de novo; a mesma tabela não é recopiada à toa */
  m.barra.innerHTML = 'MARCA'; m.rodar(); assert.strictEqual(m.barra.innerHTML, 'MARCA', 'mesma tabela: não recopia');
  const novo = area({ cabflut: true, ths: [th('NOVO', 33)], top: -300, bottom: 800 }); m.lista = [novo]; m.rodar();
  assert.ok(/NOVO/.test(m.barra.innerHTML), 'tabela nova: cabeçalho novo');
  /* ainda não passou do topo / já foi embora / escondida / sem tabela: a barra some */
  for (const [o, nome] of [[{ top: 105, bottom: 900 }, 'ainda abaixo do topo'], [{ top: 104, bottom: 900 }, 'no limite'], [{ top: -900, bottom: 160 }, 'quase toda fora'], [{ top: -900, bottom: 50 }, 'já passou'], [{ top: -300, bottom: 800, escondida: true }, 'escondida'], [{ top: -300, bottom: 800, semTabela: true }, 'sem tabela']]) {
    m.lista = [area(Object.assign({ cabflut: true, ths: [th('a', 10)] }, o))]; m.rodar();
    assert.strictEqual(m.barra.style.display, 'none', nome);
    m.lista = [novo]; m.rodar(); assert.strictEqual(m.barra.style.display, 'block');
  }
  m.lista = [area({ cabflut: true, ths: [th('a', 10)], top: 103, bottom: 161 })]; m.rodar(); assert.strictEqual(m.barra.style.display, 'block', 'um ponto depois do limite já aparece');
  /* a área marcada sumiu da página: a barra some */
  m.lista = []; m.rodar(); assert.strictEqual(m.barra.style.display, 'none');
}
/* ── celular: todas as tabelas, marcadas ou não (o comportamento de sempre) ── */
{
  const m = mundo(700);
  m.lista = [area({ ths: [th('comum', 44)], top: -300, bottom: 800 })];
  m.rodar();
  assert.deepStrictEqual([m.seletores, m.barra.style.display, /comum/.test(m.barra.innerHTML)], [['.tw, [data-cabflut]'], 'block', true]);
  m.largura = 720; m.rodar(); assert.strictEqual(m.seletores[1], '.tw, [data-cabflut]', '720 ainda é celular');
  m.largura = 721; m.rodar(); assert.deepStrictEqual([m.seletores[2], m.barra.style.display], ['[data-cabflut]', 'none'], '721 é tela grande: a tabela comum não ganha a barra');
}
/* ── a ordenação clicável dos cards de lista simples (Por Canal, Vendas por Estado): as funções de PRODUÇÃO ── */
{
  const i2 = html.indexOf('function proximaOrdem('), f2 = html.indexOf('function setSortCanal(');
  assert.ok(i2 > 0 && f2 > i2, 'achei as funções de ordenação no dashboard.html');
  const { proximaOrdem, ordenarChaves } = new Function(html.slice(i2, f2) + '\nreturn { proximaOrdem, ordenarChaves };')();
  /* 1º clique: número do maior, texto do começo; de novo na mesma coluna inverte; trocar de coluna recomeça */
  assert.deepStrictEqual(proximaOrdem({ col: 'ped', dir: -1 }, 'fat', false), { col: 'fat', dir: -1 });
  assert.deepStrictEqual(proximaOrdem({ col: 'fat', dir: -1 }, 'fat', false), { col: 'fat', dir: 1 });
  assert.deepStrictEqual(proximaOrdem({ col: 'fat', dir: 1 }, 'fat', false), { col: 'fat', dir: -1 });
  assert.deepStrictEqual(proximaOrdem({ col: 'fat', dir: 1 }, 'nome', true), { col: 'nome', dir: 1 });
  assert.deepStrictEqual(proximaOrdem({ col: 'nome', dir: 1 }, 'nome', true), { col: 'nome', dir: -1 });
  assert.deepStrictEqual(proximaOrdem({ col: 'nome', dir: -1 }, 'ped', false), { col: 'ped', dir: -1 });
  const D = { ml: { nome: 'Mercado Livre', ped: 50, fat: 900, t: 18 }, sh: { nome: 'shopee', ped: 80, fat: null, t: null }, am: { nome: 'Amazon', ped: 50, fat: 100, t: NaN }, ou: { nome: 'Érico', ped: 3, fat: 2000, t: '' }, mg: { nome: 'Magalu', ped: 0, fat: 0, t: 5 } };
  const chaves = ['sh', 'ml', 'am', 'ou', 'mg'];
  const ord = (col, dir) => ordenarChaves(chaves, (k, c) => D[k][c], { col, dir }).join(' ');
  assert.strictEqual(ord('ped', -1), 'sh ml am ou mg', 'maior primeiro; ml e am empatam e seguem a ordem de chegada');
  assert.strictEqual(ord('ped', 1), 'mg ou ml am sh', 'menor primeiro; o empate continua na ordem de chegada; zero é número, não "sem dado"');
  assert.strictEqual(ord('fat', -1), 'ou ml am mg sh', 'sem faturamento (null) no fim');
  assert.strictEqual(ord('fat', 1), 'mg am ml ou sh', 'invertido: o sem dado segue no fim');
  assert.strictEqual(ord('t', -1), 'ml mg sh am ou', 'null, NaN e vazio no fim, na ordem de chegada');
  assert.strictEqual(ord('t', 1), 'mg ml sh am ou');
  assert.strictEqual(ord('nome', 1), 'am ou mg ml sh', 'texto: sem acento nem caixa atrapalhando');
  assert.strictEqual(ord('nome', -1), 'sh ml mg ou am');
  assert.deepStrictEqual(chaves, ['sh', 'ml', 'am', 'ou', 'mg'], 'a lista de entrada não é mexida');
  /* os dois cards usam: título clicável com a seta, e a lista passa pela ordenação */
  for (const [nome, st, cols] of [['Canal', 'sortCanal', ['nome', 'ped', 'fat', 'ticket', 'flex']], ['UF', 'sortUF', ['uf', 'ped', 'fat']]]) {
    for (const c of cols) assert.ok(html.includes('class="' + (c === 'nome' || c === 'uf' ? '' : 'num ') + 'sort" onclick="setSort' + nome + "(\\'" + c + "\\')\"") && html.includes("'+seta(" + st + ",'" + c + "')+'"), nome + ': a coluna ' + c + ' é clicável e mostra a seta');
    assert.ok(new RegExp('= ordenarChaves\\(Object\\.keys\\([^)]*\\)\\.sort\\([^\\n]*\\n[^\\n]*, ' + st + '\\);').test(html), nome + ': a lista passa pela ordenação');
  }
  assert.ok(/function setSortCanal\(c\)\{ sortCanal = proximaOrdem\(sortCanal, c, c==='nome'\); render\(\); \}\nfunction setSortUF\(c\)\{ sortUF = proximaOrdem\(sortUF, c, c==='uf'\); render\(\); \}/.test(html), 'o clique troca a ordem e redesenha');
  assert.ok(/let sortCanal = \{ col: 'ped', dir: -1 \}, sortUF = \{ col: 'ped', dir: -1 \};/.test(html), 'os dois nascem como sempre foram: mais pedidos em cima');
}
console.log('ok — o cabeçalho flutuante: na tela grande só as áreas com rolagem própria (data-cabflut — o Plano de Compra) ganham a barra, no celular todas; aparece quando a tabela passa do topo e some quando ela sai; copia títulos, larguras e alinhamento; acompanha a rolagem lateral; recopia quando a tabela é redesenhada');
