'use strict';
/* 24/11 — PLANO DE COMPRA: MARCAR VÁRIOS ITENS E BAIXAR O PEDIDO DO FORNECEDOR (pedido do dono: "dá pra selecionar
   vários itens ao mm tempo pra marcar e fazer isso mais rápido?"; o pedido ele monta com "o sku, o EAN, e a quantidade").

   O que se prova — o script de PRODUÇÃO da tela (lib/checkout/painel-plano-compra) num navegador de mentira:
   · marcar/desmarcar uma linha, todas as que estão na lista, e "os que têm compra"; a quantidade nasce com o sugerido;
   · a quantidade digitada: só inteiro maior que zero vale — o resto é "sem quantidade" e fica FORA do pedido (dito na tela);
   · digitar não remonta a tabela; a marca sobrevive ao filtro e ao recálculo (com a quantidade do dono) e cai quando o
     item sai do plano;
   · o pedido: só os marcados com quantidade, na ordem do plano, SKU · EAN (texto) · Produto · Foto · Quantidade (número);
     sem a peça do .xlsx, ou com erro, sai no formato antigo; a planilha do plano não muda. */
const assert = require('assert');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const ITENS = () => [
  { sku: 'A1', ean: '7891234567895', nome: 'Abajur', img: 'https://x/a.jpg', curva: 'A', un: 150, md: 4.8, saldo: 0, acaba_em: 0, precisa: 1326, comprar: 1326, custo_un: 2, investir: 2652, mc_un: 1, risco: 9 },
  { sku: 'B2', ean: null, nome: 'Bola azul', img: null, curva: 'A', un: 90, md: 1, saldo: 500, acaba_em: 500, precisa: 274, comprar: 0, custo_un: 1, investir: 0, mc_un: 1, risco: 0 },
  { sku: 'C3', ean: '12345678', nome: 'Cubo', img: 'https://x/c.jpg', curva: 'B', un: 18, md: 0.5, saldo: null, sem_saldo: true, acaba_em: null, precisa: 137, comprar: null, custo_un: null, investir: null, mc_un: 1, risco: 0 },
  { sku: 'PT 06/Ç"<', ean: '0789123456789', nome: 'Kit azul', img: 'https://x/k.jpg', curva: 'B', un: 31, md: 1, saldo: 7, acaba_em: 7, precisa: 274, comprar: 267.4, custo_un: 1, investir: 267, mc_un: 1, risco: 3 }];

const cena = async (op) => {
  op = op || {};
  const els = {}; const obs = { urls: [], montar: [], fotos: [], salvar: [], blobs: [], baixados: [], plano: op.itens || ITENS() };
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
  els.planoCompraAqui = novo('planoCompraAqui');
  const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() { obs.baixados.push(this.download); }, href: '', download: '' }) };
  const jan = {};
  if (op.comPeca !== false) {
    jan.createImageBitmap = () => {};
    jan.PlanilhaXlsxFotos = {
      baixarFotos: (ends, o) => { obs.fotos.push(ends.slice()); if (o && o.aoAvancar) o.aoAvancar(1, ends.length); obs.noMeio = { texto: els.pcPedido.textContent, travado: els.pcPedido.disabled }; return Promise.resolve(ends.map((e, n) => (e && !(op.semFoto || []).includes(n) ? { bytes: new Uint8Array(2), w: 10, h: 10 } : null))); },
      montar: (a) => { obs.montar.push(a); if (op.montarEstoura) throw new Error('xlsx'); return new Uint8Array([1, 2, 3]); },
      salvar: (bytes, nome) => obs.salvar.push(nome) };
  }
  const Blob = function (partes) { this.texto = partes.join(''); };
  new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, jan,
    async (u) => { obs.urls.push(u); return { json: async () => (obs.falha ? { ok: false, erro: 'caiu' } : { ok: true, lead: 4, cob: 5, horizonte_dias: 274, de: '2026-05-24', ate: '2026-11-20', periodo: { tipo: 'dias', dias: 180, mistura: true }, ritmo: 'estoque', skus: obs.plano.length, totais: { investir: 1, risco: 1, skus_a_comprar: 2 }, itens: obs.plano }) }; },
    { createObjectURL: (b) => { obs.blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} }, Blob, (f) => setImmediate(f));
  return { els, obs };
};
const fim = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const alvo = (attr, valor, mais) => Object.assign({ getAttribute: (n) => (n === attr ? valor : null) }, mais || {});

(async () => {
  const c = await cena(); const { els, obs } = c;
  const tab = () => els.pcTab.innerHTML;
  const linha = (nomeProd) => { const t = tab(); const f = t.indexOf('>' + nomeProd + '</td>'); const i = t.lastIndexOf('<tr', f); return t.slice(i, t.indexOf('</tr>', f)); };
  const marca = (sku, ligado) => els.pcTab._ev.change({ target: alvo('data-pc-marca', sku, { checked: ligado }) });
  const digita = (sku, v, ev) => els.pcTab._ev[ev || 'input']({ target: alvo('data-pc-qtd', sku, { value: v }) });
  const estado = () => [els.pcSel.textContent, els.pcPedido.disabled, els.pcPedido.textContent];

  /* ── a barra nasce desligada; mexer antes do cálculo não faz nada ── */
  const h0 = els.planoCompraAqui.innerHTML;
  assert.ok(/<button id="pcMarcarCompra" type="button"[^>]*>marcar os que têm compra<\/button><button id="pcLimparMarcas" type="button">desmarcar todos<\/button><span id="pcSel"[^>]*>nenhum item marcado<\/span><button id="pcPedido" type="button" disabled[^>]*>baixar pedido do fornecedor<\/button>/.test(h0), 'a barra dos marcados: ' + h0.slice(h0.indexOf('pcMarcarCompra') - 30, h0.indexOf('pcPedInfo')));
  marca('A1', true); els.pcMarcarCompra.click(); els.pcLimparMarcas.click(); await els.pcPedido.click();
  assert.deepStrictEqual([tab(), els.pcSel.textContent, obs.montar.length, obs.blobs.length], ['', 'nenhum item marcado', 0, 0], 'sem plano calculado, nada é marcado nem baixado');

  els.pcCalc.click(); await fim();
  /* ── a tabela: uma caixa por linha (SKU escapado), a de cima desmarcada, o "comprar" como sempre ── */
  assert.ok(/<th style="width:26px"><input type="checkbox" data-pc-todos="1" title=/.test(tab()), 'a caixa de marcar todos, desmarcada');
  assert.deepStrictEqual([...tab().matchAll(/<input type="checkbox" data-pc-marca="([^"]*)"( checked)?/g)].map((m) => m[1] + (m[2] || '')), ['A1', 'B2', 'C3', 'PT 06/Ç&quot;&lt;'], 'uma caixa por linha, com o SKU escapado');
  assert.ok(/<b>1\.326<\/b>/.test(linha('Abajur')) && !/data-pc-qtd/.test(tab()), 'sem marca, o comprar aparece como sempre');
  assert.deepStrictEqual(estado(), ['nenhum item marcado', true, 'baixar pedido do fornecedor']);

  /* ── marcar uma linha: a caixa da quantidade nasce com o sugerido ── */
  marca('A1', true);
  assert.ok(/data-pc-marca="A1" checked/.test(linha('Abajur')) && /<input type="number" min="1" step="1" data-pc-qtd="A1" value="1326"[^>]*><div[^>]*>sugerido 1\.326<\/div>/.test(linha('Abajur')) && !/<b>1\.326<\/b>/.test(linha('Abajur')), linha('Abajur'));
  assert.deepStrictEqual(estado(), ['1 item(ns) marcado(s) · 1.326 unidade(s)', false, 'baixar pedido do fornecedor (1)']);
  /* sugestão quebrada arredonda; zero e "sem saldo" nascem SEM quantidade (não zero) e ficam fora do pedido */
  marca('PT 06/Ç"<', true); marca('B2', true); marca('C3', true);
  assert.ok(/data-pc-qtd="PT 06\/Ç&quot;&lt;" value="267"/.test(linha('Kit azul')) && /data-pc-qtd="B2" value=""[^>]*><div[^>]*>sugerido 0</.test(linha('Bola azul')) && /data-pc-qtd="C3" value=""[^>]*><div[^>]*>sugerido —</.test(linha('Cubo')), tab());
  assert.deepStrictEqual(estado(), ['4 item(ns) marcado(s) · 1.593 unidade(s) · 2 sem quantidade (fica fora do pedido)', false, 'baixar pedido do fornecedor (2)']);
  assert.ok(/data-pc-todos="1" checked/.test(tab()), 'todos da lista marcados: a caixa de cima fica marcada');
  /* SKU que não existe, alvo sem atributo e evento vazio não fazem nada */
  const antes = tab(); marca('NAO-EXISTE', true); els.pcTab._ev.change({ target: {} }); els.pcTab._ev.change({}); els.pcTab._ev.change({ target: alvo('outro', 'x') });
  assert.strictEqual(tab(), antes);

  /* ── digitar a quantidade: vale inteiro maior que zero; não remonta a tabela ── */
  els.pcTab.innerHTML = 'MARCA-DE-NAO-REMONTOU';
  digita('A1', '500');
  assert.deepStrictEqual([tab(), els.pcSel.textContent], ['MARCA-DE-NAO-REMONTOU', '4 item(ns) marcado(s) · 767 unidade(s) · 2 sem quantidade (fica fora do pedido)'], 'digitar atualiza o resumo sem remontar a tabela');
  for (const [v, un] of [['', 267], ['0', 267], ['-3', 267], ['1.5', 267], ['1,5', 267], ['abc', 267], ['12345678', 267], [' 40 ', 307], [7, 274], ['0007', 274], ['9999999', 10000266]]) {
    digita('A1', v, v === '0007' ? 'change' : 'input');
    assert.ok(els.pcSel.textContent.includes(' · ' + un.toLocaleString('pt-BR') + ' unidade(s)'), JSON.stringify(v) + ' → ' + els.pcSel.textContent);
  }
  digita('A1', ''); digita('PT 06/Ç"<', '0');
  assert.deepStrictEqual(estado(), ['4 item(ns) marcado(s) · 0 unidade(s) · 4 sem quantidade (fica fora do pedido)', true, 'baixar pedido do fornecedor'], 'ninguém com quantidade: o pedido desliga');
  digita('NAO-MARCADO', '5'); els.pcTab._ev.input({ target: alvo('data-pc-marca', 'A1', { checked: false }) });
  assert.ok(els.pcSel.textContent.startsWith('4 item(ns)'), 'quantidade de quem não está marcado é ignorada; o "input" só serve à caixa da quantidade');
  digita('A1', '500'); digita('B2', '12'); digita('PT 06/Ç"<', '30');
  els.pcTab.innerHTML = ''; els.pcFiltro._ev.input({ target: { value: '' } });   /* remonta */
  assert.ok(/data-pc-qtd="A1" value="500"/.test(linha('Abajur')) && /data-pc-qtd="B2" value="12"/.test(linha('Bola azul')), 'ao remontar, a caixa mostra o que o dono digitou');

  /* ── desmarcar uma; a marca sobrevive ao FILTRO; "todos" vale só pra quem está na lista ── */
  marca('B2', false);
  assert.ok(!/data-pc-marca="B2" checked/.test(tab()) && /<b>0<\/b>/.test(linha('Bola azul')) && !/data-pc-todos="1" checked/.test(tab()));
  /* quantidade que chega pra linha DESMARCADA (evento atrasado) não a marca de volta */
  digita('B2', '77'); els.pcFiltro._ev.input({ target: { value: '' } });
  assert.ok(!/data-pc-marca="B2" checked/.test(tab()) && els.pcSel.textContent.startsWith('3 item(ns) marcado(s) · 530 unidade(s)'), els.pcSel.textContent);
  els.pcFiltro._ev.input({ target: { value: 'azul' } });
  assert.deepStrictEqual([[...tab().matchAll(/data-pc-marca="([^"]*)"( checked)?/g)].map((m) => m[1] + (m[2] || '')), els.pcSel.textContent], [['B2', 'PT 06/Ç&quot;&lt; checked'], '3 item(ns) marcado(s) · 530 unidade(s) · 1 sem quantidade (fica fora do pedido)'], 'filtrado: a lista mostra dois, o resumo conta os três marcados');
  els.pcTab._ev.change({ target: alvo('data-pc-todos', '1', { checked: false }) });
  assert.strictEqual(els.pcSel.textContent, '2 item(ns) marcado(s) · 500 unidade(s) · 1 sem quantidade (fica fora do pedido)', 'desmarcar todos DA LISTA não mexe em quem o filtro escondeu');
  els.pcTab._ev.change({ target: alvo('data-pc-todos', '1', { checked: true }) });
  assert.ok(/data-pc-todos="1" checked/.test(tab()) && /data-pc-qtd="PT 06\/Ç&quot;&lt;" value="267"/.test(tab()) && els.pcSel.textContent.startsWith('4 item(ns) marcado(s) · 767 unidade(s)'), 'marcar todos da lista: quem entra nasce com o sugerido');
  /* "marcar os que têm compra": só quem tem sugestão, só da lista, sem trocar a quantidade de quem já estava */
  els.pcFiltro._ev.input({ target: { value: '' } }); els.pcLimparMarcas.click();
  assert.deepStrictEqual([estado(), /checked/.test(tab())], [['nenhum item marcado', true, 'baixar pedido do fornecedor'], false]);
  marca('A1', true); digita('A1', '9'); els.pcFiltro._ev.input({ target: { value: 'a' } });   /* Abajur, Bola azul, Kit azul */
  els.pcMarcarCompra.click();
  assert.deepStrictEqual([[...tab().matchAll(/data-pc-marca="([^"]*)" checked/g)].map((m) => m[1]), els.pcSel.textContent], [['A1', 'PT 06/Ç&quot;&lt;'], '2 item(ns) marcado(s) · 276 unidade(s)'], 'marca quem tem compra; o 9 que o dono digitou fica');
  /* e com o filtro escondendo um item que TEM compra (o Abajur): ele não é marcado */
  els.pcLimparMarcas.click(); els.pcFiltro._ev.input({ target: { value: 'azul' } }); els.pcMarcarCompra.click();
  assert.strictEqual(els.pcSel.textContent, '1 item(ns) marcado(s) · 267 unidade(s)', 'só o Kit (o Abajur está fora da lista)');
  els.pcLimparMarcas.click(); els.pcFiltro._ev.input({ target: { value: 'a' } }); marca('A1', true); digita('A1', '9'); els.pcMarcarCompra.click();
  els.pcFiltro._ev.input({ target: { value: '' } });

  /* ── o RECÁLCULO: a marca e a quantidade do dono ficam; quem saiu do plano cai ── */
  marca('C3', true);
  obs.plano = ITENS().filter((i) => i.sku !== 'PT 06/Ç"<').map((i) => (i.sku === 'A1' ? Object.assign(i, { comprar: 2000 }) : i));
  els.pcCalc.click(); await fim();
  assert.ok(/data-pc-qtd="A1" value="9"[^>]*><div[^>]*>sugerido 2\.000</.test(linha('Abajur')), 'a quantidade do dono não é trocada pela sugestão nova: ' + linha('Abajur'));
  assert.strictEqual(els.pcSel.textContent, '2 item(ns) marcado(s) · 9 unidade(s) · 1 sem quantidade (fica fora do pedido)', 'o Kit saiu do plano: a marca dele caiu');
  obs.plano = ITENS(); els.pcCalc.click(); await fim();
  assert.ok(!/data-pc-marca="PT 06\/Ç&quot;&lt;" checked/.test(tab()), 'voltou ao plano: volta desmarcado');
  /* falha no cálculo: o resumo zera junto com a tabela (as marcas voltam com o próximo plano) */
  obs.falha = true; els.pcCalc.click(); await fim();
  assert.deepStrictEqual([tab(), ...estado()], ['', 'nenhum item marcado', true, 'baixar pedido do fornecedor']);
  await els.pcPedido.click(); assert.strictEqual(obs.montar.length, 0);
  obs.falha = false; els.pcCalc.click(); await fim();
  assert.strictEqual(els.pcSel.textContent, '2 item(ns) marcado(s) · 9 unidade(s) · 1 sem quantidade (fica fora do pedido)');

  /* ── O PEDIDO, com a peça do .xlsx: só os marcados COM quantidade, na ordem do plano ── */
  marca('PT 06/Ç"<', true); digita('PT 06/Ç"<', '30'); marca('B2', true); digita('B2', '12');
  const p1 = els.pcPedido.click(); await fim(); await p1;
  assert.deepStrictEqual(obs.fotos, [['/emp/plano-compra/foto?sku=A1', '', '/emp/plano-compra/foto?sku=PT%2006%2F%C3%87%22%3C']], 'foto só de quem está no pedido (o C3, sem quantidade, fica fora)');
  const m = obs.montar[0];
  assert.deepStrictEqual([m.cab, m.linhas, m.colFoto, m.cab[m.colFoto], m.lado, m.larguras, m.alturaTitulo, m.alturaLinha, m.destaque.map((k) => m.cab[k]), m.fotos.map((f) => !!f), m.link, m.moeda, m.semaforo],
    [['SKU', 'EAN', 'Produto', 'Foto', 'Quantidade'], [['A1', '7891234567895', 'Abajur', '', 9], ['B2', '', 'Bola azul', '', 12], ['PT 06/Ç"<', '0789123456789', 'Kit azul', '', 30]], 3, 'Foto', 300, [25.77, 16.5, 67.07, 30.07, 14], 43.75, 102, ['Quantidade'], [true, false, true], undefined, undefined, undefined],
    'SKU · EAN como TEXTO (o zero da frente fica) · Produto · Foto · Quantidade como NÚMERO: ' + JSON.stringify(m.linhas));
  assert.ok(obs.salvar.length === 1 && /^pedido-fornecedor-\d{4}-\d{2}-\d{2}\.xlsx$/.test(obs.salvar[0]) && obs.blobs.length === 0, JSON.stringify(obs.salvar));
  assert.deepStrictEqual([obs.noMeio, els.pcPedInfo.textContent, ...estado().slice(1)], [{ texto: 'buscando fotos 1/3…', travado: true }, 'pedido baixado com 3 item(ns)', false, 'baixar pedido do fornecedor (3)'], 'trava e mostra o andamento no meio; devolve o botão no fim');
  /* a planilha do PLANO não muda com as marcas: todos os itens, o nome de sempre */
  await els.pcCsv.click(); await fim();
  assert.deepStrictEqual([obs.montar[1].linhas.length, obs.montar[1].cab.length, obs.salvar[1].startsWith('plano-de-compra-')], [4, 18, true]);

  /* foto que não veio diz isso na célula; erro ao montar cai no formato antigo; sem a peça, direto no antigo */
  const c2 = await cena({ semFoto: [0] }); c2.els.pcCalc.click(); await fim();
  c2.els.pcTab._ev.change({ target: alvo('data-pc-marca', 'A1', { checked: true }) }); await c2.els.pcPedido.click(); await fim();
  assert.deepStrictEqual(c2.obs.montar[0].linhas, [['A1', '7891234567895', 'Abajur', 'foto não veio', 1326]]);
  const c3 = await cena({ montarEstoura: true }); c3.els.pcCalc.click(); await fim();
  c3.els.pcTab._ev.change({ target: alvo('data-pc-marca', 'A1', { checked: true }) }); await c3.els.pcPedido.click(); await fim();
  const x3 = c3.obs.blobs[0].texto;
  assert.ok(c3.obs.baixados.length === 1 && /^pedido-fornecedor-\d{4}-\d{2}-\d{2}\.xls$/.test(c3.obs.baixados[0]) && /sem imagem/.test(c3.els.pcPedInfo.textContent) && c3.els.pcPedido.disabled === false, c3.els.pcPedInfo.textContent);
  assert.ok(/<Row ss:StyleID="cab">(<Cell ss:StyleID="cab"><Data ss:Type="String">(SKU|EAN|Produto|Quantidade)<\/Data><\/Cell>){4}<\/Row><Row><Cell><Data ss:Type="String">A1<\/Data><\/Cell><Cell><Data ss:Type="String">7891234567895<\/Data><\/Cell><Cell><Data ss:Type="String">Abajur<\/Data><\/Cell><Cell><Data ss:Type="Number">1326<\/Data><\/Cell><\/Row><\/Table>/.test(x3), 'o formato antigo: EAN texto, quantidade número: ' + x3.slice(x3.indexOf('<Row'), x3.indexOf('</Table>')));
  const c4 = await cena({ comPeca: false }); c4.els.pcCalc.click(); await fim();
  c4.els.pcTab._ev.change({ target: alvo('data-pc-marca', 'PT 06/Ç"<', { checked: true }) }); await c4.els.pcPedido.click(); await fim();
  assert.ok(c4.obs.baixados.length === 1 && /^pedido-fornecedor-/.test(c4.obs.baixados[0]) && c4.els.pcPedInfo.textContent === 'pedido baixado com 1 item(ns), sem fotos' && /PT 06\/Ç&quot;&lt;<\/Data>/.test(c4.obs.blobs[0].texto) && /<Data ss:Type="Number">267<\/Data>/.test(c4.obs.blobs[0].texto));
  /* e a planilha do plano, no formato antigo, segue com o nome e as colunas dela */
  await c4.els.pcCsv.click(); await fim();
  assert.ok(/^plano-de-compra-\d{4}-\d{2}-\d{2}\.xls$/.test(c4.obs.baixados[1]) && /COMPRAR<\/Data>/.test(c4.obs.blobs[1].texto) && !/Quantidade<\/Data>/.test(c4.obs.blobs[1].texto));

  /* clique dobrado no pedido enquanto busca as fotos: um arquivo só */
  const c5 = await cena(); c5.els.pcCalc.click(); await fim();
  c5.els.pcTab._ev.change({ target: alvo('data-pc-marca', 'A1', { checked: true }) });
  const a1 = c5.els.pcPedido.click(), a2 = c5.els.pcPedido.click(); await fim(); await a1; await a2;
  assert.deepStrictEqual([c5.obs.fotos.length, c5.obs.montar.length, c5.obs.salvar.length], [1, 1, 1]);

  terminou = true; process.exitCode = 0;
  console.log('ok — Plano de Compra, marcar itens e o pedido do fornecedor: marca uma linha, todas da lista ou as que têm compra; a quantidade nasce com o sugerido e só inteiro maior que zero vale (o resto fica fora do pedido, dito na tela); digitar não remonta a tabela; a marca sobrevive ao filtro e ao recálculo e cai com o item; o pedido sai só com os marcados com quantidade (SKU, EAN texto, Produto, Foto, Quantidade), no .xlsx ou no formato antigo; a planilha do plano não muda');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
