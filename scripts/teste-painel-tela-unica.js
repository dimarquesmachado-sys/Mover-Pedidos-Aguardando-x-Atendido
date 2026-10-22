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
assert.ok(/require\('\.\.\/lib\/checkout\/painel\/empresas'\)\.painelDaEmpresa\('ambtotal'\)/.test(ambIdx), 'a AMB não sai do gerador');
assert.ok(!/path\.join\(__dirname, 'amb-dashboard\.html'\)/.test(ambIdx), 'a AMB ainda lê o arquivo antigo');
assert.ok(/require\('\.\.\/lib\/checkout\/painel\/empresas'\)\.painelDaEmpresa\('good', \{ defaultAliq: DEFAULT_ALIQ_BK_GOOD \}\)/.test(fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8')), 'a GOOD não sai do gerador');
/* 21/10 (passo final): a GIRASSOL também — a cópia dela sumiu e a rota gera a tela com as alíquotas do backend */
assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'dashboard.html')), 'sobrou a cópia da tela na pasta da Girassol');
{ const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/painel\/empresas'\)\.painelDaEmpresa\('girassol', \{ defaultAliq: DEFAULT_ALIQ_BK \}\)/.test(gbo), 'a Girassol não sai do gerador');
  const { telaDaEmpresa, aliqDoBackend } = require('./_tela-empresa');
  const hG = telaDaEmpresa('girassol');
  assert.ok(/const MOD = '\/girassol-backup-offline';\nwindow\.__CAPAC = \{"vendasSync":true,"shopeeResumo":true,"freteMagalu":true,"canario":true\};/.test(hG), 'Girassol: prefixo/capacidades errados (o canário é dela)');
  assert.ok(/<title>Inteligência de Vendas · Girassol<\/title>/.test(hG) && /<span class="logo">🌻<\/span> Inteligência de Vendas · Girassol/.test(hG), 'Girassol: nome/logo');
  assert.ok(/h1 \.logo\{width:30px;height:30px;border-radius:9px;background:linear-gradient\(135deg,#fbbf24,#f59e0b\);/.test(hG), 'Girassol: perdeu o fundo amarelo do logo');
  assert.ok(/<link rel="icon" type="image\/png" sizes="32x32" href="data:image\/png;base64,/.test(hG) && /<link rel="apple-touch-icon" sizes="180x180" href="icone\.png">/.test(hG), 'Girassol: perdeu os ícones dela');
  assert.ok(/'\/magalu\/ir\/girassol\?n='/.test(hG) && !/amb-checkout-offline|AMBTotal/.test(hG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'Girassol: sobrou referência da AMB');
  const aliqG = JSON.parse(hG.match(/^const DEFAULT_ALIQ = (\{[^\n]*?\});/m)[1]);
  assert.deepStrictEqual(aliqG, aliqDoBackend('girassol-backup-offline/gbo-app.js', 'DEFAULT_ALIQ_BK'), 'Girassol: as alíquotas de fábrica da tela não são as do backend'); }

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
    'let periodo = ctx.periodo, HIST = ctx.HIST, DADOS = ctx.DADOS, VENDAS = [], _ultAtualiz = 0, _recarregando = false, _histFalhou = { de: "a", ate: "b" }, _histFresh = false, HLIN = { velha: 1 }, _hlErro = { de: "a" }, _hlCarregando = false, _hlRefazer = false;\n' + srcAt +
    '\nreturn async (m) => { const r = await atualizarDados(m); ctx.HIST = HIST; ctx.DADOS = DADOS; ctx.falhou = _histFalhou; ctx.fresh = _histFresh; ctx.hlin = HLIN; ctx.hlErro = _hlErro; return r; };')(
    ctx, async (u) => { ctx.chamadas.push(u); return { json: async () => ({ itens: [{ id: 1 }], vendas_bling: [] }) }; }, '/x',
    () => {}, () => { ctx.chamadas.push('render'); }, () => {}, () => {}, { getElementById: () => null });
  await atualizar('auto');
  assert.strictEqual(ctx.chamadas.length, 0, 'fora do Hoje, o refresh automático não pode buscar');
  assert.strictEqual(await atualizar('custo'), true, 'atualizarDados deve devolver true quando refez');
  assert.ok(ctx.falhou === null && ctx.fresh === true, 'lançar custo não limpou a falha do histórico nem pediu fresh=1 (Codex #723)');
  assert.ok(ctx.chamadas[0] === '/x/historico' && ctx.HIST === null && ctx.DADOS.length === 1 && ctx.chamadas.includes('render'), 'lançar custo não refez o cálculo na tela: ' + JSON.stringify(ctx.chamadas));
  const iR = hAmb.indexOf('window.ferramentasCustoRecarregar = async function(){'); const srcR = hAmb.slice(iR, hAmb.indexOf('\n};', iR) + 3);
  const reg = []; const g = { skuInfoCarregado: true, _skuLoading: false, _skuRefazer: false };
  const mkHook = () => { const w = {}; new Function('window', 'atualizarDados', 'carregarSkuInfo', 'location', 'g', srcR.replace(/skuInfoCarregado/g, 'g.skuInfoCarregado').replace(/_skuLoading/g, 'g._skuLoading').replace(/_skuRefazer/g, 'g._skuRefazer'))(
    w, async (m) => { reg.push('atualizarDados:' + m); return true; }, async (f) => { reg.push('carregarSkuInfo:' + f); }, { reload: () => reg.push('reload') }, g); return w.ferramentasCustoRecarregar; };
  await mkHook()();
  assert.deepStrictEqual(reg, ['atualizarDados:custo', 'carregarSkuInfo:true'], 'o gancho do custo não refez a tela e a projeção: ' + JSON.stringify(reg));
  /* a projeção estava CARREGANDO quando o custo foi lançado: não chama de novo agora, marca pra refazer ao terminar */
  reg.length = 0; g._skuLoading = true; g.skuInfoCarregado = false;
  await mkHook()();
  assert.ok(reg.length === 1 && g._skuRefazer === true, 'com a projeção em voo, o custo não ficou marcado pra refazer: ' + JSON.stringify(reg));
  assert.ok(/if\(_skuRefazer\)\{ _skuRefazer = false; skuInfoCarregado = false; _skuLoading = false; setTimeout\(function\(\)\{ carregarSkuInfo\(true\); \}, 0\); return; \}/.test(hAmb), 'a carga da projeção não refaz ao terminar quando o custo chegou no meio');
  /* refresh não feito (já havia um em andamento) => recarrega a página como antes */
  reg.length = 0; g._skuLoading = false; g.skuInfoCarregado = true;
  { const w = {}; new Function('window', 'atualizarDados', 'carregarSkuInfo', 'location', 'g', 'setTimeout', srcR.replace(/skuInfoCarregado/g, 'g.skuInfoCarregado').replace(/_skuLoading/g, 'g._skuLoading').replace(/_skuRefazer/g, 'g._skuRefazer'))(
      w, async () => false, async () => { reg.push('sku'); }, { reload: () => reg.push('reload') }, g, (fn) => fn());
    await w.ferramentasCustoRecarregar();
    assert.deepStrictEqual(reg, ['reload'], 'refresh não feito e não recarregou a página: ' + JSON.stringify(reg)); }
  assert.ok(!/setTimeout\(function\(\)\{ location\.reload\(\); \}, 900\); \};\n/.test(hAmb), 'voltou o recarregar a página inteira como primeira opção');

  /* Codex #723 (r3): custo lançado com o agregado de Mês/Ano JÁ carregando — o resultado em voo (cache velho) é
     descartado e a tela pede de novo com fresh=1 */
  { const srcH = pegar(hAmb, 'async function carregarHistorico(de, ate){');
    const urls = []; let soltar; const st = { renders: 0 };
    const H = new Function('st', 'fetch', 'MOD', 'document', 'render', 'renderAnalise', 'restaurarAncora',
      'let HIST = null, _histCarregando = false, _histFresh = false, _histFalhou = null;\n' + srcH +
      '\nreturn { carregar: (a, b) => carregarHistorico(a, b), custo: () => { HIST = null; _histFalhou = null; _histFresh = true; }, hist: () => HIST };')(
      st, (u) => { urls.push(u); return urls.length === 1 ? new Promise(r => { soltar = () => r({ json: async () => ({ ok: true, de: 'a', ate: 'b', velho: true }) }); }) : Promise.resolve({ json: async () => ({ ok: true, de: 'a', ate: 'b', novo: true }) }); },
      '/x', { getElementById: () => null }, () => { st.renders++; if (st.renders === 1) H.carregar('a', 'b'); }, () => {}, () => {});
    const p1 = H.carregar('a', 'b');           // a busca de Mês/Ano em voo…
    H.custo();                                 // …o dono lança custo no meio
    soltar(); await p1; await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.ok(urls.length === 2 && /fresh=1/.test(urls[1]) && !/fresh=1/.test(urls[0]), 'a busca em voo não foi refeita com fresh=1: ' + JSON.stringify(urls));
    assert.ok(H.hist() && H.hist().novo === true, 'ficou o agregado de ANTES do custo: ' + JSON.stringify(H.hist())); }

  assert.ok(ctx.hlin === null && ctx.hlErro === null, 'lançar custo não derrubou a lista paginada (HLIN) nem a falha dela (Codex #723 r4)');

  /* Codex #723 (r4): custo lançado com a lista paginada (HLIN) JÁ carregando — o resultado em voo é descartado
     e a Análise repinta pra pedir a página 1 de novo; sem carga em voo, só derruba */
  { const srcL = pegar(hAmb, 'async function carregarLinhasHist(de, ate, pagina){');
    const urls = []; let soltar; let rep = 0;
    const L = new Function('fetch', 'MOD', 'renderAnalise', 'restaurarAncora', 'garantirNomes', 'avisoHistFalhou', 'pedirLinhasHist', 'anSku', 'anCanal',
      'let HLIN = null, _hlCarregando = false, _hlRefazer = false, _hlErro = null, _hlUltima = null;\n' + srcL +
      '\nreturn { carregar: () => carregarLinhasHist("a", "b", 1), custo: () => { HLIN = null; _hlErro = null; if(_hlCarregando) _hlRefazer=true; }, hlin: () => HLIN, trava: () => _hlCarregando };')(
      (u) => { urls.push(u); return new Promise(r => { soltar = () => r({ json: async () => ({ ok: true, pedidos: [], velha: true }) }); }); },
      '/x', () => { rep++; }, () => {}, () => {}, () => {}, () => {}, '', '');
    const p1 = L.carregar(); L.custo(); soltar(); await p1;
    assert.ok(L.hlin() === null && rep === 1 && L.trava() === false, 'a lista em voo (de antes do custo) foi aceita ou a trava ficou: ' + JSON.stringify([L.hlin(), rep, L.trava()]));
    const p2 = L.carregar(); soltar(); await p2;
    assert.ok(L.hlin() && L.hlin().velha === true, 'sem custo no meio, a lista deveria ser aceita'); }
  assert.ok(/HLIN=null; _hlErro=null; if\(_hlCarregando\) _hlRefazer=true;/.test(hAmb), 'o refresh do custo não derruba a lista paginada');

  console.log('ok — tela única na lib: AMB e GOOD pelo mesmo gerador; canário por capacidade; custo refaz na tela e a projeção (o que só a Girassol tinha, agora nas três)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
