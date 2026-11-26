'use strict';
/* 26/11 — PLANO DE COMPRA: CLICAR NO NOME DA COLUNA ORDENA A LISTA (pedido do dono: "clicar tipo em Ritmo/Dia e conseguir
   ver do com mais ou daquele com menos resultado… Se eu clicar no de Grupo A, B, C, daí mostrar dos A em diante, depois
   B, depois C. E se eu clicar de novo, o inverso").

   O que se prova — o script de PRODUÇÃO da tela (lib/checkout/painel-plano-compra) num navegador de mentira:
   · sem clicar, a lista vem na ordem do plano; cada coluna de dado tem o título clicável;
   · número: 1º clique do MAIOR pro menor, 2º inverte; texto e curva: 1º clique do começo (A), 2º inverte;
   · quem não tem o dado fica no FIM nas duas direções; empate segue a ordem do plano;
   · a seta fica só na coluna ordenada; o clique num pedaço de dentro do título vale; fora de título não faz nada;
   · a ordem sobrevive ao filtro, à marcação e ao recálculo; a barra flutuante é avisada a cada desenho;
   · a planilha e o pedido do fornecedor saem na ordem da tela ("é melhor q siga a ordem da tela sim"). */
const assert = require('assert');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const it = (sku, nome, curva, o) => Object.assign({ sku, ean: null, nome, img: null, curva, un: 1, md: 1, md_estoque: null, saldo: 1, a_caminho: 0, precisa: 1, un30: 1, acaba_em: 1, comprar: 1, custo_un: 1, investir: 1, mc_un: 1, risco: 1 }, o || {});
const ITENS = () => [
  it('S3', 'Érico', 'B', { md: 2, md_estoque: 0.5, saldo: 10, a_caminho: 5, precisa: 30, un30: 9, acaba_em: 40, comprar: 20, investir: 200, risco: 7 }),
  it('S1', 'banana', 'A', { md: 9, md_estoque: null, saldo: 5000, sem_saldo: true, a_caminho: null, precisa: null, un30: null, acaba_em: null, comprar: null, investir: null, risco: 999 }),
  it('S10', 'Abacate', 'C', { md: 0, md_estoque: 3, saldo: 0, a_caminho: 0, precisa: 5, un30: 0, acaba_em: 0, comprar: 5, investir: 50, risco: 0 }),
  it('S2', 'damasco', 'A', { md: 2, md_estoque: 1, saldo: 300, a_caminho: 12, precisa: 90, un30: 30, acaba_em: '12/10', comprar: 0, investir: 0, risco: 2 }),
  it('S4', 'Caju', '', { md: null, md_estoque: 2, saldo: 7, a_caminho: 1, precisa: 8, un30: 2, acaba_em: 15, comprar: 3, investir: 30, risco: 1 })];

const cena = async () => {
  const els = {}; const obs = { urls: [], avisos: 0, blobs: [], plano: ITENS() };
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
  els.planoCompraAqui = novo('planoCompraAqui');
  const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() {}, href: '', download: '' }) };
  const jan = { atualizarCabecalhoFlutuante: () => { obs.avisos++; } };
  const Blob = function (partes) { this.texto = partes.join(''); };
  new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, jan,
    async (u) => { obs.urls.push(u); return { json: async () => ({ ok: true, lead: 4, cob: 5, horizonte_dias: 274, de: '2026-05-24', ate: '2026-11-20', periodo: { tipo: 'dias', dias: 180, mistura: true }, skus: obs.plano.length, totais: { investir: 1, risco: 1, skus_a_comprar: 1 }, itens: obs.plano }) }; },
    { createObjectURL: (b) => { obs.blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} }, Blob, (f) => setImmediate(f));
  return { els, obs };
};
const fim = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const no = (attrs, pai) => ({ getAttribute: (n) => (attrs && n in attrs ? attrs[n] : null), parentNode: pai || null });

(async () => {
  const { els, obs } = await cena();
  const tab = () => els.pcTab.innerHTML;
  /* a ordem da tela = os SKUs das caixas de marcar, de cima pra baixo */
  const ordem = () => (tab().match(/data-pc-marca="[^"]*"/g) || []).map((x) => x.slice(15, -1)).join(' ');
  const ths = () => tab().slice(0, tab().indexOf('</tr>')).split(/<th(?=[ >])/).slice(1).map((x) => '<th' + x);
  const setas = () => ths().filter((h) => /[↓↑]<\/th>/.test(h)).map((h) => h.replace(/^.*data-pc-ord="([^"]*)".*( [↓↑])<\/th>.*$/, '$1$2'));
  /* o clique chega no elemento de fora (a tabela é remontada); o alvo é o <th>, filho do elTab */
  const clica = (col) => els.pcTab._ev.click({ target: no({ 'data-pc-ord': col }, els.pcTab) });

  /* ── antes do cálculo, clicar não faz nada ── */
  clica('md');
  assert.strictEqual(tab(), '', 'sem plano calculado, o clique não desenha nada');

  els.pcCalc.click(); await fim();
  assert.strictEqual(ordem(), 'S3 S1 S10 S2 S4', 'sem clicar: a ordem do plano');
  assert.deepStrictEqual(setas(), [], 'sem clicar: nenhuma seta');
  assert.deepStrictEqual(ths().map((h) => (h.match(/data-pc-ord="([^"]*)"/) || [0, '-'])[1]),
    ['-', '-', 'sku', 'curva', 'nome', 'md', 'md_estoque', 'saldo', 'a_caminho', 'precisa', 'un30', 'acaba_em', 'comprar', 'investir', 'risco'], 'toda coluna de dado tem o título clicável, na ordem da tabela');
  assert.ok(ths().slice(2).every((h) => /style="cursor:pointer;user-select:none(;text-align:right)?" title="[^"]*clique pra ordenar; clique de novo pra inverter"/.test(h)), 'o título mostra que é clicável e explica');
  assert.ok(/^<th class="sort" data-pc-ord="md" style="cursor:pointer;user-select:none;text-align:right" title="unidades por dia — o ritmo usado na conta · clique pra ordenar; clique de novo pra inverter">ritmo\/dia<\/th>$/.test(ths()[5]), 'número à direita, com a explicação da coluna antes');
  assert.ok(/^<th class="sort" data-pc-ord="sku" style="cursor:pointer;user-select:none" title="clique pra ordenar; clique de novo pra inverter">SKU<\/th>$/.test(ths()[2]), 'texto à esquerda');

  /* ── número: maior primeiro; de novo, menor primeiro; sem dado sempre no fim; empate na ordem do plano ── */
  const avisosAntes = obs.avisos;
  clica('md');
  assert.strictEqual(ordem(), 'S1 S3 S2 S10 S4', 'ritmo/dia, 1º clique: do maior pro menor; S3 e S2 empatam e seguem o plano; S4 (sem ritmo) no fim');
  assert.deepStrictEqual(setas(), ['md ↓'], 'a seta pra baixo na coluna ordenada');
  assert.strictEqual(obs.avisos, avisosAntes + 1, 'a barra flutuante é avisada do desenho novo');
  clica('md');
  assert.strictEqual(ordem(), 'S10 S3 S2 S1 S4', 'ritmo/dia, 2º clique: do menor pro maior; o empate continua na ordem do plano; S4 segue no fim');
  assert.deepStrictEqual(setas(), ['md ↑']);
  clica('md');
  assert.strictEqual(ordem(), 'S1 S3 S2 S10 S4', '3º clique: volta ao maior primeiro');

  /* ── trocar de coluna recomeça pelo maior (não herda a direção da anterior) ── */
  clica('md'); clica('saldo');
  assert.strictEqual(ordem(), 'S2 S3 S4 S10 S1', 'saldo: 300, 10, 7, 0; o "sem saldo" no fim (não é zero)');
  assert.deepStrictEqual(setas(), ['saldo ↓'], 'só uma seta, na coluna nova');
  clica('saldo');
  assert.strictEqual(ordem(), 'S10 S4 S3 S2 S1', 'saldo invertido: o zero é o primeiro, o "sem saldo" segue no fim');

  /* ── cada coluna numérica pelo dado dela ── */
  const primeiro = (col) => { clica(col); const a = ordem(); clica(col); return [a, ordem()]; };
  assert.deepStrictEqual(primeiro('md_estoque'), ['S10 S4 S2 S3 S1', 'S3 S2 S4 S10 S1'], 'ritmo com estoque');
  assert.deepStrictEqual(primeiro('a_caminho'), ['S2 S3 S4 S10 S1', 'S10 S4 S3 S2 S1'], 'a caminho: o "não consegui ler" no fim');
  assert.deepStrictEqual(primeiro('precisa'), ['S2 S3 S4 S10 S1', 'S10 S4 S3 S2 S1'], 'precisa');
  assert.deepStrictEqual(primeiro('un30'), ['S2 S3 S4 S10 S1', 'S10 S4 S3 S2 S1'], '30d');
  assert.deepStrictEqual(primeiro('acaba_em'), ['S3 S4 S10 S1 S2', 'S10 S4 S3 S1 S2'], 'acaba: dias; a data em texto e o vazio ficam no fim');
  assert.deepStrictEqual(primeiro('comprar'), ['S3 S10 S4 S2 S1', 'S2 S4 S10 S3 S1'], 'comprar');
  assert.deepStrictEqual(primeiro('investir'), ['S3 S10 S4 S2 S1', 'S2 S4 S10 S3 S1'], 'investir');
  assert.deepStrictEqual(primeiro('risco'), ['S3 S2 S4 S10 S1', 'S10 S4 S2 S3 S1'], 'lucro em risco: quem está sem saldo mostra "—" e fica no fim, mesmo com número guardado');

  /* ── curva: A, B, C; de novo C, B, A; sem curva no fim ── */
  clica('curva');
  assert.strictEqual(ordem(), 'S1 S2 S3 S10 S4', 'curva, 1º clique: os A (na ordem do plano), depois B, depois C; sem curva no fim');
  assert.deepStrictEqual(setas(), ['curva ↑']);
  clica('curva');
  assert.strictEqual(ordem(), 'S10 S3 S1 S2 S4', 'curva, 2º clique: C, B, A; sem curva segue no fim');

  /* ── texto: do começo, sem acento nem caixa atrapalhando ── */
  clica('nome');
  assert.strictEqual(ordem(), 'S10 S1 S4 S2 S3', 'produto: Abacate, banana, Caju, damasco, Érico');
  clica('nome');
  assert.strictEqual(ordem(), 'S3 S2 S4 S1 S10', 'produto invertido');
  clica('sku');
  assert.strictEqual(ordem(), 'S1 S10 S2 S3 S4', 'SKU: ordem de texto');
  assert.deepStrictEqual(setas(), ['sku ↑']);

  /* ── o clique num pedaço de dentro do título vale; fora de título não faz nada ── */
  els.pcTab._ev.click({ target: no(null, no({ 'data-pc-ord': 'md' }, els.pcTab)) });
  assert.strictEqual(ordem(), 'S1 S3 S2 S10 S4', 'clique num filho do título ordena pela coluna dele');
  const antes = tab();
  els.pcTab._ev.click({ target: no({ 'data-pc-marca': 'S1' }, no(null, els.pcTab)) });
  els.pcTab._ev.click({ target: els.pcTab });
  els.pcTab._ev.click({});
  assert.strictEqual(tab(), antes, 'clique numa linha, na área vazia ou sem alvo não mexe na ordem');

  /* ── a ordem sobrevive ao filtro, à marcação e ao recálculo ── */
  els.pcFiltro._ev.input({ target: { value: 'a' } });
  assert.strictEqual(ordem(), 'S1 S2 S10 S4', 'filtrado (os que têm "a"), ainda pelo ritmo');
  els.pcFiltro._ev.input({ target: { value: '' } });
  els.pcTab._ev.change({ target: Object.assign(no({ 'data-pc-marca': 'S10' }), { checked: true }) });
  assert.strictEqual(ordem(), 'S1 S3 S2 S10 S4', 'marcar um item redesenha na mesma ordem');
  assert.deepStrictEqual(setas(), ['md ↓']);
  obs.plano = ITENS().reverse();
  els.pcCalc.click(); await fim();
  assert.strictEqual(ordem(), 'S1 S2 S3 S10 S4', 'recalculou: segue pelo ritmo (o empate S2/S3 agora na ordem do plano novo)');

  /* ── a planilha e o pedido do fornecedor saem na ordem da tela (formato antigo: sem a peça do .xlsx) ── */
  const naOrdem = (texto, skus) => { const pos = skus.map((k) => texto.indexOf('>' + k + '</Data>')); return pos.every((x) => x > 0) && pos.every((x, n) => !n || x > pos[n - 1]) ? 'ok' : JSON.stringify(pos); };
  const ultimo = () => obs.blobs[obs.blobs.length - 1].texto;
  els.pcCsv.click(); await fim();
  assert.strictEqual(naOrdem(ultimo(), ['S1', 'S2', 'S3', 'S10', 'S4']), 'ok', 'a planilha na ordem da tela (ritmo, maior primeiro)');
  els.pcMarcarCompra.click();
  const nb = obs.blobs.length; await els.pcPedido.click(); await fim();
  assert.strictEqual(obs.blobs.length, nb + 1, 'o pedido foi baixado');
  assert.strictEqual(naOrdem(ultimo(), ['S3', 'S10', 'S4']), 'ok', 'o pedido (os marcados com quantidade) na ordem da tela');
  clica('comprar'); clica('comprar');
  assert.strictEqual(ordem(), 'S2 S4 S10 S3 S1', 'tela: comprar do menor pro maior');
  els.pcCsv.click(); await fim();
  assert.strictEqual(naOrdem(ultimo(), ['S2', 'S4', 'S10', 'S3', 'S1']), 'ok', 'a planilha acompanha a ordem nova');
  await els.pcPedido.click(); await fim();
  assert.strictEqual(naOrdem(ultimo(), ['S4', 'S10', 'S3']), 'ok', 'o pedido acompanha a ordem nova');
  /* filtrado: a planilha leva só o que está na lista, na ordem dela */
  els.pcFiltro._ev.input({ target: { value: 'a' } }); els.pcCsv.click(); await fim();
  assert.strictEqual(naOrdem(ultimo(), ['S2', 'S4', 'S10', 'S1']), 'ok'); assert.ok(ultimo().indexOf('>S3</Data>') < 0, 'o filtrado fora da planilha');

  terminou = true; process.exitCode = 0;
  console.log('ok — Plano de Compra, ordenar pela coluna: número do maior pro menor e o inverso; curva A·B·C e o inverso; texto do começo; quem não tem o dado no fim; empate na ordem do plano; a seta na coluna ordenada; sobrevive a filtro, marcação e recálculo; a planilha e o pedido do fornecedor saem na ordem da tela');
})().catch((e) => { console.log('FALHOU:', e && e.stack || e); process.exitCode = 1; });
