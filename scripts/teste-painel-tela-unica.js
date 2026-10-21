'use strict';
/* 20/10 — TELA ÚNICA do painel de vendas na LIB (lib/checkout/painel/dashboard.html). O dono: "pq as 3 não tão usando a
   mesma tela? cadê o lib?". Antes: o modelo morava na pasta da AMB (a GOOD saía dele pelo gerador) e a Girassol tinha
   cópia própria — 141 linhas de código diferentes. Este passo leva o modelo pra lib, serve a AMB pelo MESMO gerador e
   nivela por cima com o que só a Girassol tinha:
   · aviso do canário (venda que não chega ao Bling) — por capacidade (/canario-estado; sem a rota, nem consulta);
   · depois de lançar custo, refaz o cálculo NA TELA (sem recarregar a página, sem perder o período — Codex #670) e
     consulta de novo a projeção de compra (SKUINFO), que o recarregar da AMB atualizava.
   Prova com o gerador DE PRODUÇÃO e as funções tiradas da página gerada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { gerarPainel, MODELO } = require('../lib/checkout/dashboard-modelo');

// 1) o modelo mora na lib, sem cópia na pasta da AMB; a AMB e a GOOD saem do gerador
assert.strictEqual(path.relative(raiz, MODELO).split(path.sep).join('/'), 'lib/checkout/painel/dashboard.html', 'o modelo não está na lib');
assert.ok(!fs.existsSync(path.join(raiz, 'amb-checkout-offline', 'amb-dashboard.html')), 'sobrou a cópia do modelo na pasta da AMB');
const ambIdx = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
assert.ok(/gerarPainel\(\{ prefixo: '\/amb-checkout-offline', identidadeDoModelo: true,/.test(ambIdx), 'a AMB não sai do gerador');
assert.ok(!/path\.join\(__dirname, 'amb-dashboard\.html'\)/.test(ambIdx), 'a AMB ainda lê o arquivo antigo');
assert.ok(/require\('\.\.\/lib\/checkout\/dashboard-modelo'\)\.gerarPainel\(\{/.test(fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8')), 'a GOOD não sai do gerador');

// 2) AMB: a tela dela, só com as capacidades; o modo identidade não serve pra outro prefixo
const hAmb = gerarPainel({ prefixo: '/amb-checkout-offline', identidadeDoModelo: true, capacidades: { canario: false } });
assert.ok(/const MOD = '\/amb-checkout-offline';\nwindow\.__CAPAC = \{"vendasSync":true,"shopeeResumo":true,"freteMagalu":true,"canario":false\};/.test(hAmb), 'AMB: capacidades não injetadas');
assert.ok(/<title>Inteligência de Vendas · AMBTotal<\/title>/.test(hAmb) || /AMBTotal<\/title>/.test(hAmb), 'AMB: perdeu a identidade');
assert.throws(() => gerarPainel({ prefixo: '/good-checkout-offline', identidadeDoModelo: true }), /identidadeDoModelo só vale/);

// funções tiradas da PÁGINA GERADA (não de cópia)
const pegar = (h, nome) => { const i = h.indexOf((nome.startsWith('async ') ? '' : '') + nome); assert.ok(i >= 0, 'sem ' + nome); const j = h.indexOf('\n}\n', i); return h.slice(i, j + 2); };

(async () => {
  // 3) canário: sem a capacidade, nem consulta; com ela, consulta a rota da empresa e mostra o aviso
  const srcCan = pegar(hAmb, 'async function checarCanario(){');
  for (const [cap, espera] of [[false, 0], [true, 1]]) {
    const urls = []; const el = { style: { display: 'none' }, innerHTML: '' };
    const fn = new Function('window', 'document', 'fetch', 'MOD', srcCan + '\nreturn checarCanario;')(
      { __CAPAC: { canario: cap } }, { getElementById: () => el },
      async (u) => { urls.push(u); return { json: async () => ({ ok: true, precisa_de_voce: true, aviso: { titulo: 'T', detalhe: 'D', o_que_fazer: 'F' } }) }; }, '/x');
    await fn();
    assert.strictEqual(urls.length, espera, 'canário com capacidade ' + cap + ': consultas ' + urls.length);
    if (cap) assert.ok(urls[0] === '/x/canario-estado' && el.style.display === '' && /O que fazer/.test(el.innerHTML), 'canário ligado não mostrou o aviso');
  }
  assert.ok(/try\{ checarCanario\(\); \}catch\(e\)\{\}/.test(hAmb) && /<div id="canarioAviso"/.test(hAmb), 'o canário não é chamado ou não tem onde aparecer');

  // 4) lançar custo: refaz na tela (sem recarregar) em QUALQUER período e reconsulta a projeção já carregada
  const srcAt = pegar(hAmb, 'async function atualizarDados(motivo){');
  const ctx = { periodo: 'mes', HIST: { velho: 1 }, DADOS: [], chamadas: [] };
  const atualizar = new Function('ctx', 'fetch', 'MOD', 'prepararVendas', 'render', 'renderAnalise', 'restaurarAncora', 'document',
    'let periodo = ctx.periodo, HIST = ctx.HIST, DADOS = ctx.DADOS, VENDAS = [], _ultAtualiz = 0, _recarregando = false, _histFalhou = { de: "a", ate: "b" }, _histFresh = false;\n' + srcAt +
    '\nreturn async (m) => { const r = await atualizarDados(m); ctx.HIST = HIST; ctx.DADOS = DADOS; ctx.falhou = _histFalhou; ctx.fresh = _histFresh; return r; };')(
    ctx, async (u) => { ctx.chamadas.push(u); return { json: async () => ({ itens: [{ id: 1 }], vendas_bling: [] }) }; }, '/x',
    () => {}, () => { ctx.chamadas.push('render'); }, () => {}, () => {}, { getElementById: () => null });
  await atualizar('auto');
  assert.strictEqual(ctx.chamadas.length, 0, 'fora do Hoje, o refresh automático não pode buscar');
  assert.strictEqual(await atualizar('custo'), true, 'atualizarDados deve devolver true quando refez');
  assert.ok(ctx.falhou === null && ctx.fresh === true, 'lançar custo não limpou a falha do histórico nem pediu fresh=1 (Codex #723)');
  assert.ok(ctx.chamadas[0] === '/x/historico' && ctx.HIST === null && ctx.DADOS.length === 1 && ctx.chamadas.includes('render'), 'lançar custo não refez o cálculo na tela: ' + JSON.stringify(ctx.chamadas));
  const iR = hAmb.indexOf('window.ferramentasCustoRecarregar = async function(){'); const srcR = hAmb.slice(iR, hAmb.indexOf('\n};', iR) + 3);
  const reg = []; const g = { skuInfoCarregado: true };
  const montaGancho = (okAtualiza) => new Function('window', 'atualizarDados', 'carregarSkuInfo', 'location', 'setTimeout', 'g', srcR.replace(/skuInfoCarregado/g, 'g.skuInfoCarregado'))(
    g, async (m) => { reg.push('atualizarDados:' + m); return okAtualiza; }, async (f) => { reg.push('carregarSkuInfo:' + f); }, { reload: () => reg.push('reload') }, (fn) => fn(), g);
  montaGancho(true);
  await g.ferramentasCustoRecarregar();
  assert.deepStrictEqual(reg, ['atualizarDados:custo', 'carregarSkuInfo:true'], 'o gancho do custo não refez a tela e a projeção: ' + JSON.stringify(reg));
  // Codex #723: as chamadas são assíncronas -- refresh que NÃO aconteceu (falhou/já rodando) cai no recarregar da página
  reg.length = 0; g.skuInfoCarregado = true; montaGancho(false);
  await g.ferramentasCustoRecarregar();
  assert.deepStrictEqual(reg, ['atualizarDados:custo', 'reload'], 'refresh que falhou não caiu no recarregar: ' + JSON.stringify(reg));
  // e o carregarHistorico pede fresh=1 uma vez só depois do custo
  const srcH = pegar(hAmb, 'async function carregarHistorico(de, ate){');
  const urlsH = [];
  const hist = new Function('fetch', 'MOD', 'document', 'render', 'renderAnalise', 'restaurarAncora', 'setTimeout',
    'let HIST = null, _histCarregando = false, _histFalhou = null, _histFresh = true;\n' + srcH + '\nreturn async (a, b) => { HIST = null; await carregarHistorico(a, b); };')(
    async (u) => { urlsH.push(u); return { json: async () => ({ ok: true, de: 'a', ate: 'b' }) }; }, '/x', { getElementById: () => null }, () => {}, () => {}, () => {}, () => {});
  await hist('a', 'b'); await hist('a', 'b');
  assert.ok(/&fresh=1$/.test(urlsH[0]) && !/fresh/.test(urlsH[1]), 'o histórico após o custo não furou o cache uma única vez: ' + JSON.stringify(urlsH));
  assert.ok(!/setTimeout\(function\(\)\{ location\.reload\(\); \}, 900\); \};\n/.test(hAmb), 'voltou o recarregar a página inteira como primeira opção');

  console.log('ok — tela única na lib: AMB e GOOD pelo mesmo gerador; canário por capacidade; custo refaz na tela e a projeção (o que só a Girassol tinha, agora nas três)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
