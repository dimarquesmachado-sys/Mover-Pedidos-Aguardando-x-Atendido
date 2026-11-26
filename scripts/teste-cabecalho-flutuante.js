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
const ini = html.indexOf('let _barraCab = null, _tabAtual = null;'), fimF = html.indexOf('function montarNavCards(){');
assert.ok(ini > 0 && fimF > ini, 'achei a função no dashboard.html');
const fonte = html.slice(ini, fimF);

function mundo(largura) {
  const m = { largura, hdr: 100, lista: [], criados: [], seletores: [] };
  const barra = { style: {}, innerHTML: '', _inner: { scrollLeft: 0 }, querySelector: (s) => (s === '.cabInner' ? barra._inner : null) };
  m.barra = barra;
  const document = { querySelector: (s) => (s === '.hdr' ? { offsetHeight: m.hdr } : null), querySelectorAll: (s) => { m.seletores.push(s); return m.lista.filter((t) => (s.includes('.tw') ? true : t.cabflut)); },
    createElement: () => { m.criados.push(1); return barra; }, body: { appendChild: () => {} } };
  const window = { get innerWidth() { return m.largura; } };
  m.rodar = new Function('document', 'window', fonte + '\nreturn function(){ atualizarCabecalhoFlutuante(); };')(document, window);
  return m;
}
const th = (texto, w, alinhamento) => ({ innerHTML: texto, style: { textAlign: alinhamento || '' }, getBoundingClientRect: () => ({ width: w }) });
const area = (o) => { const tr = { children: o.ths }; const tb = { querySelector: (s) => (s === 'tr' ? tr : null) };
  return { cabflut: !!o.cabflut, offsetParent: o.escondida ? null : {}, scrollLeft: o.scrollLeft || 0, tb, querySelector: (s) => (s === 'table' ? (o.semTabela ? null : tb) : null), getBoundingClientRect: () => ({ top: o.top, bottom: o.bottom, left: o.left == null ? 40 : o.left, width: o.width || 900 }) }; };

/* ── tela grande ── */
{
  const m = mundo(1400);
  /* nenhuma área marcada: nada acontece, nem a barra é criada */
  m.lista = [area({ ths: [th('a', 10)], top: -500, bottom: 900 })];
  m.rodar(); assert.deepStrictEqual([m.criados.length, m.seletores], [0, ['[data-cabflut]']], 'tela grande só olha as marcadas');
  /* o plano (marcado) passou do topo: a barra aparece, com os títulos, as larguras e o alinhamento */
  const plano = area({ cabflut: true, ths: [th('<input type="checkbox">', 26), th('SKU', 120), th('saldo', 80, 'right'), th('curva', 50, 'center'), th('x', 10, 'justify')], top: -300, bottom: 800, left: 60, width: 1200, scrollLeft: 35 });
  m.lista = [area({ ths: [th('outra', 10)], top: -500, bottom: 900 }), plano];
  m.rodar();
  assert.deepStrictEqual([m.barra.style.display, m.barra.style.top, m.barra.style.left, m.barra.style.width, m.barra._inner.scrollLeft], ['block', '100px', '60px', '1200px', 35], JSON.stringify(m.barra.style));
  assert.strictEqual(m.barra.innerHTML, '<div class="cabInner"><table><tr><th style="width:26px;min-width:26px"><input type="checkbox"></th><th style="width:120px;min-width:120px">SKU</th><th style="width:80px;min-width:80px;text-align:right">saldo</th><th style="width:50px;min-width:50px;text-align:center">curva</th><th style="width:10px;min-width:10px">x</th></tr></table></div>');
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
console.log('ok — o cabeçalho flutuante: na tela grande só as áreas com rolagem própria (data-cabflut — o Plano de Compra) ganham a barra, no celular todas; aparece quando a tabela passa do topo e some quando ela sai; copia títulos, larguras e alinhamento; acompanha a rolagem lateral; recopia quando a tabela é redesenhada');
