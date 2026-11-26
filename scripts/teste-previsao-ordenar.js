'use strict';
/* 26/11 — PREVISÃO DE VENDAS: O CABEÇALHO GRUDA AO ROLAR E AS COLUNAS ORDENAM NO CLIQUE (pedidos do dono: "mesmo esquema
   de grudar o menuzinho qdo rolo pra baixo no card de Previsão de vendas por produto"; e, sobre os cards com tabela,
   "clicar… e conseguir ver do com mais ou daquele com menos… e replicar isso nos demais menus").

   O que se prova — o script de PRODUÇÃO da tela (lib/checkout/painel-previsao-vendas) num navegador de mentira:
   · sem clicar, a ordem que veio do servidor; cada coluna de dado tem o título clicável (a numeração não);
   · número: 1º clique do MAIOR pro menor, 2º inverte; produto (SKU): do começo, e inverte;
   · quem não tem o dado fica no FIM nas duas direções; empate segue a ordem do servidor; a numeração acompanha a tela;
   · a seta fica só na coluna ordenada; clique num pedaço de dentro do título vale; fora de título não faz nada;
   · base menor que 60 dias: a tendência não ordena (a coluna é toda "—");
   · a ordem sobrevive ao filtro; a planilha sai na ordem da tela; o cabeçalho flutuante é avisado a cada desenho;
   · o estilo do dashboard gruda o cabeçalho desta tabela ABAIXO do topo do dashboard (não no topo zero da janela). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scriptDaPrevisao } = require('../lib/checkout/painel-previsao-vendas');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const PRODUTOS = () => [
  { sku: 'S3', desc: 'érico', un: 20, tendencia: 10, p7: 5, p30: 20, p90: 60, p180: 120, p365: 240 },
  { sku: 's1', desc: 'banana', un: 90, tendencia: null, p7: null, p30: null, p90: null, p180: null, p365: null },
  { sku: 'S10', desc: 'Abacate', un: 0, tendencia: -40, p7: 0, p30: 0, p90: 0, p180: 0, p365: 0 },
  { sku: 'S2', desc: 'damasco', un: 20, tendencia: 80, p7: 9, p30: 35, p90: 100, p180: 500, p365: 300 },
  { sku: '', desc: 'sem código', un: null, tendencia: 'x', p7: 1, p30: 2, p90: 3, p180: 4, p365: '' }];

function montar() {
  const els = {}; const obs = { avisos: 0, blobs: [], urls: [] };
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
  els.previsaoVendasAqui = novo('previsaoVendasAqui');
  const doc = { getElementById: (id) => (id === 'pvEstilo' ? {} : (els[id] || (els[id] = novo(id)))), createElement: () => ({ click() {}, href: '', download: '' }), head: { appendChild: () => {} } };
  const jan = { location: { search: '' }, atualizarCabecalhoFlutuante: () => { obs.avisos++; } };
  const Blob = function (partes) { this.texto = partes.join(''); };
  new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', 'URLSearchParams', scriptDaPrevisao('/emp'))(doc, jan,
    async (u) => { obs.urls.push(u); return { json: async () => ({ ok: true, de: '2026-05-30', ate: '2026-11-26', linhas: 9, skus: 5, produtos: PRODUTOS() }) }; },
    { createObjectURL: (b) => { obs.blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} }, Blob, (f) => setImmediate(f), URLSearchParams);
  return { els, obs };
}
const fim = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const no = (attrs, pai) => ({ getAttribute: (n) => (attrs && n in attrs ? attrs[n] : null), parentNode: pai || null });

(async () => {
  const { els, obs } = montar();
  const tab = () => els.pvTab.innerHTML;
  const linhas = () => tab().split('<tr style="border-top').slice(1);
  /* a ordem da tela: a descrição de cada linha (todas têm), e a numeração da 1ª coluna */
  const ordem = () => linhas().map((l) => (l.match(/<span style="opacity:\.7">([^<]*)<\/span>/) || [0, '?'])[1].slice(0, 3)).join(' ');
  const numeros = () => linhas().map((l) => (l.match(/opacity:\.6">(\d+)<\/td>/) || [0, '?'])[1]).join('');
  const ths = () => tab().slice(0, tab().indexOf('</tr>')).split(/<th(?=[ >])/).slice(1).map((x) => '<th' + x);
  const setas = () => ths().filter((h) => /[↓↑]<\/th>/.test(h)).map((h) => h.replace(/^.*data-pv-ord="([^"]*)".*( [↓↑])<\/th>.*$/, '$1$2'));
  const clica = (col) => els.pvTab._ev.click({ target: no({ 'data-pv-ord': col }, els.pvTab) });

  /* ── antes de a resposta chegar, clicar não faz nada ── */
  clica('un');
  assert.strictEqual(tab(), '', 'sem resposta do servidor, o clique não desenha nada');
  await fim();
  assert.deepStrictEqual([ordem(), numeros(), setas()], ['éri ban Aba dam sem', '12345', []], 'sem clicar: a ordem do servidor, sem seta');
  assert.deepStrictEqual(ths().map((h) => (h.match(/data-pv-ord="([^"]*)"/) || [0, '-'])[1]), ['-', 'sku', 'un', 'tendencia', 'p7', 'p30', 'p90', 'p180', 'p365'], 'toda coluna de dado é clicável; a numeração não');
  assert.ok(/^<th class="sort" data-pv-ord="un" style="cursor:pointer;user-select:none;text-align:right" title="clique pra ordenar; clique de novo pra inverter">vendidas<\/th>$/.test(ths()[2]), ths()[2]);
  assert.ok(/^<th class="sort" data-pv-ord="sku" style="cursor:pointer;user-select:none" title="clique pra ordenar; clique de novo pra inverter">produto<\/th>$/.test(ths()[1]), ths()[1]);
  assert.ok(/^<th class="sort" data-pv-ord="tendencia" style="cursor:pointer;user-select:none;text-align:right" title="últimos 30 dias contra os 30 anteriores · clique pra ordenar; clique de novo pra inverter">tendência<\/th>$/.test(ths()[3]), ths()[3]);

  /* ── número: maior primeiro; de novo, menor primeiro; sem dado no fim; empate na ordem do servidor ── */
  const avisos = obs.avisos;
  clica('un');
  assert.deepStrictEqual([ordem(), numeros(), setas(), obs.avisos], ['ban éri dam Aba sem', '12345', ['un ↓'], avisos + 1], 'vendidas: 90, 20, 20 (empate na ordem do servidor), 0; sem dado no fim; a numeração é a da tela; o cabeçalho flutuante é avisado');
  clica('un');
  assert.deepStrictEqual([ordem(), setas()], ['Aba éri dam ban sem', ['un ↑']], 'invertido: o zero primeiro, o empate na mesma ordem, o sem dado segue no fim');
  clica('un');
  assert.strictEqual(ordem(), 'ban éri dam Aba sem', '3º clique: volta');
  /* trocar de coluna recomeça pelo maior */
  clica('un'); clica('p180');
  assert.deepStrictEqual([ordem(), setas()], ['dam éri sem Aba ban', ['p180 ↓']], '6 meses: 500, 120, 4, 0; sem dado no fim');
  const par = (col) => { clica(col); const a = ordem(); clica(col); return [a, ordem()]; };
  assert.deepStrictEqual(par('tendencia'), ['dam éri Aba ban sem', 'Aba éri dam ban sem'], 'tendência: 80, 10, −40; vazio e texto torto no fim');
  assert.deepStrictEqual(par('p7'), ['dam éri sem Aba ban', 'Aba sem éri dam ban'], '1 semana');
  assert.deepStrictEqual(par('p30'), ['dam éri sem Aba ban', 'Aba sem éri dam ban'], '1 mês');
  assert.deepStrictEqual(par('p90'), ['dam éri sem Aba ban', 'Aba sem éri dam ban'], '3 meses');
  assert.deepStrictEqual(par('p365'), ['dam éri Aba ban sem', 'Aba éri dam ban sem'], '1 ano: o vazio conta como sem dado');
  /* produto: pelo SKU, do começo, sem caixa atrapalhando; sem código no fim */
  clica('sku');
  assert.deepStrictEqual([ordem(), setas()], ['ban Aba dam éri sem', ['sku ↑']], 'SKU: s1, S10, S2, S3; sem código no fim');
  clica('sku');
  assert.strictEqual(ordem(), 'éri dam Aba ban sem', 'SKU invertido; sem código segue no fim');

  /* ── clique num filho do título vale; fora de título, nada ── */
  els.pvTab._ev.click({ target: no(null, no({ 'data-pv-ord': 'un' }, els.pvTab)) });
  assert.strictEqual(ordem(), 'ban éri dam Aba sem');
  const antes = tab();
  els.pvTab._ev.click({ target: no({ outra: 'x' }, no(null, els.pvTab)) }); els.pvTab._ev.click({ target: els.pvTab }); els.pvTab._ev.click({});
  assert.strictEqual(tab(), antes, 'clique numa linha, na área vazia ou sem alvo não mexe na ordem');

  /* ── sobrevive ao filtro; a planilha sai na ordem da tela ── */
  els.pvBusca.value = 'a'; els.pvBusca._ev.input();
  assert.deepStrictEqual([ordem(), numeros()], ['ban dam Aba', '123'], 'filtrado, ainda pelas vendidas');
  els.pvPlanilha.click();
  const xml = obs.blobs[obs.blobs.length - 1].texto;
  const pos = ['banana', 'damasco', 'Abacate'].map((d) => xml.indexOf('>' + d + '</Data>'));
  assert.ok(pos.every((x) => x > 0) && pos[0] < pos[1] && pos[1] < pos[2] && xml.indexOf('>érico</Data>') < 0, 'a planilha: só o filtrado, na ordem da tela ' + JSON.stringify(pos));
  els.pvBusca.value = ''; els.pvBusca._ev.input();

  /* ── base menor que 60 dias: a tendência é toda "—" e não ordena ── */
  els.pvDias.value = '45'; els.pvDias._ev.change(); await fim();
  assert.ok(/base=45/.test(obs.urls[obs.urls.length - 1]));
  assert.deepStrictEqual([ths().map((h) => (h.match(/data-pv-ord="([^"]*)"/) || [0, '-'])[1]).join(' '), ths()[3]], ['- sku un - p7 p30 p90 p180 p365', '<th style="text-align:right" title="últimos 30 dias contra os 30 anteriores">tendência</th>']);
  assert.deepStrictEqual([ordem(), setas()], ['ban éri dam Aba sem', ['un ↓']], 'trocar a base mantém a ordenação escolhida');

  /* estava ordenado pela tendência e a base caiu pra menos de 60 dias: a ordem volta à do servidor (sem seta escondida) */
  els.pvDias.value = '90'; els.pvDias._ev.change(); await fim();
  clica('tendencia');
  assert.deepStrictEqual([ordem(), setas()], ['dam éri Aba ban sem', ['tendencia ↓']]);
  els.pvDias.value = '60'; els.pvDias._ev.change(); await fim();
  assert.deepStrictEqual([ordem(), setas()], ['dam éri Aba ban sem', ['tendencia ↓']], 'com 60 dias a tendência existe: a ordem fica');
  els.pvDias.value = '59'; els.pvDias._ev.change(); await fim();
  assert.deepStrictEqual([ordem(), setas()], ['éri ban Aba dam sem', []], 'sem tendência pra ordenar: a ordem do servidor');
  els.pvDias.value = '61'; els.pvDias._ev.change(); await fim();
  assert.deepStrictEqual([ordem(), setas(), ths()[3].includes('data-pv-ord="tendencia"')], ['éri ban Aba dam sem', [], true], 'de volta acima de 60 dias a tendência volta a ordenar (e a ordem antiga não ressuscita sozinha)');

  /* ── o estilo do dashboard: o cabeçalho desta tabela gruda abaixo do topo do dashboard ── */
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib/checkout/painel/dashboard.html'), 'utf8');
  const regraGeral = css.indexOf('.tw thead th{top:0}'), regra = css.indexOf('#pvTab thead th{top:var(--hdrH,104px)}');
  assert.ok(regraGeral > 0 && regra > regraGeral && regra < css.indexOf('</style>'), 'a regra da Previsão existe e vem depois da geral');
  assert.ok(/<div id="pvTab" class="tw twFit"><\/div>/.test(els.previsaoVendasAqui.innerHTML), 'a área da tabela segue .tw (é ela que dá o cabeçalho grudado), sem rolagem própria');

  terminou = true; process.exitCode = 0;
  console.log('ok — Previsão de vendas, ordenar pela coluna: número do maior pro menor e o inverso; produto pelo SKU; quem não tem o dado no fim; empate na ordem do servidor; a numeração e a planilha seguem a tela; a seta na coluna ordenada; sobrevive ao filtro e à troca de base; sem 60 dias a tendência não ordena; o cabeçalho gruda abaixo do topo do dashboard');
})().catch((e) => { console.log('FALHOU:', e && e.stack || e); process.exitCode = 1; });
