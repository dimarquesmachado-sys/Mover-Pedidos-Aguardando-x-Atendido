'use strict';
/* 15/11 — A BUSCA DO TOP PRODUTOS (a tela única das três empresas + o /historico-longo de produção).

   O dono: "esse campo de busca acho que não tá funcionando. Pesquisei plantadeira e nada de vir resultado… se eu clico em
   um dos submenus, tipo lucro bruto, quantidade, aí meio que funciona como um ENTER. Tinha que funcionar à medida que eu
   digito."

   O QUE ERA (reproduzido num navegador de verdade): o campo chamava `renderTopProdutos`, uma função que nunca existiu. O
   navegador parava ali com erro e o `render()` que vinha depois não rodava — 6 teclas, 0 redesenhos. E, lendo o código,
   um segundo defeito no mesmo campo: no período LONGO a tabela recebe só o topo de cada ordem, e a busca procurava só
   nesse pedaço — produto que vendeu e não está entre os primeiros dava "nada".

   O QUE SE PROVA (o código de produção: a tela gerada de cada empresa e a rota da GOOD):
   A. NAS TRÊS EMPRESAS, toda função chamada por um manipulador embutido da tela (onclick="…", oninput="…") EXISTE na
      tela — é a guarda que teria pego este defeito, e pega o próximo do mesmo tipo.
   B. O campo chama `filtrarTop()`; digitar redesenha a tela (uma vez, depois de uma pausa curta que junta as teclas).
   C. No período longo de lista PARCIAL, a busca pede a lista INTEIRA do período (uma vez por período carregado, sem
      cache); enquanto não chega e se falhar, a tela DIZ; digitar de novo tenta outra vez; resposta de um período que já
      não é o da tela é ignorada; período curto, lista já inteira ou termo de 1 letra não pedem nada.
   D. O trecho de produção do TOP Produtos filtra na lista inteira quando ela chegou (acha o produto que estava FORA do
      pedaço) sem mudar a base dos percentuais.
   E. A nota da tabela: procurando / não consegui / nenhum produto casa — e o termo digitado nunca vira HTML.
   F. No servidor, a lista inteira (`&skus=todos`) é só leitura: não dispara a busca de custo no Bling (abrir o período,
      sim, como sempre). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let roteiro = [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
  exports: async () => { const r = roteiro.length ? roteiro.shift() : []; return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }; } };
process.env.ADMIN_KEY = 'chave-teste';

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const T = require('./_tela-empresa');
const scriptDe = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

(async () => {
  /* ═══ A. toda função chamada por um manipulador embutido existe ═══ */
  const NAO_SAO_DA_TELA = new Set(['if', 'for', 'while', 'function', 'return', 'typeof', 'switch', 'catch', 'new', 'void', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'alert', 'confirm', 'prompt',
    'setTimeout', 'clearTimeout', 'encodeURIComponent', 'decodeURIComponent', 'isNaN', 'isFinite', 'Date', 'Math', 'JSON', 'Array', 'Object', 'event', 'open', 'fetch', 'var', 'let', 'const']);
  const chamadasDosManipuladores = (html) => {
    const achadas = new Map();
    const re = /\bon(?:click|input|change|keyup|keydown|keypress|submit|blur|focus|mouseover|mouseout|load|error)\s*=\s*(\\?["'])([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(html))) {
      const corpo = m[2].replace(/\\'/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const r2 = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?=\(|&&)/g; let k;   /* `nome(` e também `nome&&…` (o jeito que escondia o defeito) */
      while ((k = r2.exec(corpo))) if (!NAO_SAO_DA_TELA.has(k[2]) && !achadas.has(k[2])) achadas.set(k[2], corpo.slice(0, 80));
    }
    return achadas;
  };
  const definida = (js, n) => { const e = n.replace(/\$/g, '\\$'); return new RegExp('(?:function\\s+' + e + '\\s*\\(|(?:const|let|var)\\s+' + e + '\\s*=|window\\.' + e + '\\s*=)').test(js); };
  /* a guarda enxerga o defeito: a mesma tela com o campo de ANTES acusa a função que não existe */
  {
    const html = T.telaDaEmpresa('good');
    const antes = html.replace('oninput="filtrarTop()"', 'oninput="renderTopProdutos&&renderTopProdutos();render()"');
    assert.notStrictEqual(antes, html, 'o campo da busca do TOP Produtos não chama filtrarTop()');
    const f = [...chamadasDosManipuladores(antes)].filter(([n]) => !definida(scriptDe(antes), n)).map(([n]) => n);
    assert.deepStrictEqual(f, ['renderTopProdutos'], 'a guarda dos manipuladores não acusou a função que não existe');
  }
  for (const emp of ['girassol', 'good', 'ambtotal']) {
    const html = T.telaDaEmpresa(emp), js = scriptDe(html);
    const ch = chamadasDosManipuladores(html);
    assert.ok(ch.size >= 25 && ch.has('filtrarTop') && ch.has('setSortProd') && ch.has('renderProjecao'), emp + ': a guarda não está lendo os manipuladores da tela (' + ch.size + ')');
    const faltam = [...ch].filter(([n]) => !definida(js, n)).map(([n, c]) => n + ' ← ' + c);
    assert.deepStrictEqual(faltam, [], emp + ': manipulador da tela chama função que NÃO EXISTE (o navegador para ali com erro e o resto do manipulador não roda)');
    assert.ok(/<input id="qTop"[^>]*oninput="filtrarTop\(\)"/.test(html), emp + ': o campo da busca do TOP Produtos não filtra ao digitar');
  }

  /* ═══ B e C. as funções de produção da busca, recortadas da tela ═══ */
  const js = scriptDe(T.telaDaEmpresa('good'));
  const i0 = js.indexOf('let _qTopT = null;'), i1 = js.indexOf('async function carregarHistorico(', i0);
  assert.ok(i0 > 0 && i1 > i0, 'não achei as funções da busca do TOP Produtos na tela');
  const montar = () => {
    const amb = { renders: 0, pedidos: [], respostas: [], relogios: [], limpos: [] };
    const fetchFalso = (url, opts) => { amb.pedidos.push([url, opts]); const r = amb.respostas.shift(); return r === 'cai' ? Promise.reject(new Error('rede')) : Promise.resolve({ json: () => (r === 'lixo' ? Promise.reject(new Error('não é JSON')) : Promise.resolve(r)) }); };
    const api = new Function('render', 'fetch', 'MOD', 'setTimeout', 'clearTimeout', 'esc', 'N',
      js.slice(i0, i1) + '\nreturn { filtrarTop, buscaNoPeriodoInteiro, notaDaBuscaTop, estado: () => _topTodos };')(
      () => { amb.renders++; }, fetchFalso, '/loja', (fn, ms) => { amb.relogios.push({ fn, ms }); return amb.relogios.length; }, (id) => { amb.limpos.push(id); },
      (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), (v) => Number(v).toLocaleString('pt-BR'));
    return Object.assign(amb, api);
  };
  const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const PARCIAL = () => ({ de: '2026-10-01', ate: '2026-10-31', skus: [{ sku: 'TOPO' }], skus_total: 900 });

  /* B. digitar redesenha — uma vez, depois da pausa */
  {
    const a = montar();
    a.filtrarTop(); a.filtrarTop(); a.filtrarTop();
    assert.deepStrictEqual([a.renders, a.relogios.length, a.limpos.slice(1), a.relogios.every((r) => r.ms > 0 && r.ms <= 300)], [0, 3, [1, 2], true], 'cada tecla tinha que adiar o redesenho (e cancelar o da tecla anterior)');
    a.relogios[2].fn();
    assert.strictEqual(a.renders, 1, 'digitar no campo do TOP Produtos não redesenhou a tela');
  }

  /* C. período longo de lista parcial: a lista inteira do período */
  {
    const a = montar();
    const hist = PARCIAL();
    /* não pede nada: período curto, lista que já é a inteira, termo vazio ou de 1 letra */
    assert.deepStrictEqual([a.buscaNoPeriodoInteiro(null, 'planta'), a.buscaNoPeriodoInteiro({ de: 'a', ate: 'b', skus: [{}, {}], skus_total: 2 }, 'planta'), a.buscaNoPeriodoInteiro({ de: 'a', ate: 'b', skus: [{}] }, 'planta'),
      a.buscaNoPeriodoInteiro(hist, ''), a.buscaNoPeriodoInteiro(hist, ' p '), a.buscaNoPeriodoInteiro(hist, null), a.pedidos.length], [null, null, null, null, null, null, 0]);
    /* pede UMA vez, sem cache, com a sessão — e diz que está procurando */
    a.respostas = [{ ok: true, skus: [{ sku: 'TOPO' }, { sku: 'PLANTADEIRA' }] }];
    const b1 = a.buscaNoPeriodoInteiro(hist, 'planta'), b2 = a.buscaNoPeriodoInteiro(hist, 'plantad');
    assert.deepStrictEqual([b1.carregando, b1 === b2, a.pedidos], [true, true, [['/loja/historico-longo?de=2026-10-01&ate=2026-10-31&skus=todos&fresh=1', { credentials: 'same-origin' }]]], 'a lista inteira do período tinha que ser pedida uma vez só');
    await esperar();
    const b3 = a.buscaNoPeriodoInteiro(hist, 'plantadeira');
    assert.deepStrictEqual([a.renders, b3.skus.map((x) => x.sku), b3.carregando, a.pedidos.length], [1, ['TOPO', 'PLANTADEIRA'], undefined, 1], 'chegou a lista inteira: a tela é redesenhada e a busca passa a usá-la (sem pedir de novo)');
    /* o período foi RECARREGADO (outro objeto): a lista antiga não serve — pede de novo */
    const hist2 = PARCIAL();
    a.respostas = [{ ok: false, erro: 'x' }];
    assert.strictEqual(a.buscaNoPeriodoInteiro(hist2, 'planta').carregando, true);
    await esperar();
    assert.deepStrictEqual([a.pedidos.length, a.buscaNoPeriodoInteiro(hist2, 'planta').falhou, a.renders, a.pedidos.length], [2, true, 2, 2], 'a busca que falhou tem que DIZER que falhou (e não ficar pedindo sozinha)');
    /* digitar de novo tenta outra vez */
    a.respostas = [{ ok: true, skus: [] }];
    a.filtrarTop(); a.relogios[a.relogios.length - 1].fn();
    assert.deepStrictEqual([a.estado(), a.buscaNoPeriodoInteiro(hist2, 'planta').carregando, a.pedidos.length], [null, true, 3], 'depois da falha, digitar de novo tinha que tentar outra vez');
    await esperar();
    assert.deepStrictEqual(a.buscaNoPeriodoInteiro(hist2, 'planta').skus, []);
    /* …mas digitar NÃO joga fora a lista que chegou bem */
    a.filtrarTop(); a.relogios[a.relogios.length - 1].fn();
    assert.deepStrictEqual([a.buscaNoPeriodoInteiro(hist2, 'planta').skus, a.pedidos.length], [[], 3]);
  }
  /* as outras formas de falhar: a rede cai, a resposta não é JSON, vem sem a lista, vem com erro (mesmo trazendo uma lista) */
  for (const ruim of ['cai', 'lixo', { ok: true }, null, { ok: false, skus: [{ sku: 'X' }] }, { ok: true, skus: 'nao-e-lista' }]) {
    const a = montar(); const hist = PARCIAL();
    a.respostas = [ruim];
    a.buscaNoPeriodoInteiro(hist, 'planta'); await esperar();
    assert.deepStrictEqual([a.buscaNoPeriodoInteiro(hist, 'planta').falhou, a.renders], [true, 1], 'falha da busca no período inteiro não virou "não consegui": ' + JSON.stringify(ruim));
  }
  /* trocou de período no meio: a resposta do período de antes NÃO passa por cima */
  {
    const a = montar(); const h1 = PARCIAL(), h2 = Object.assign(PARCIAL(), { de: '2026-09-01', ate: '2026-09-30' });
    let soltar = null;
    const fetchLento = new Promise((r) => { soltar = r; });
    a.respostas = [];   /* a 1ª fica presa: troca-se o `fetch` do recorte por uma promessa que só resolve depois */
    const api2 = new Function('render', 'fetch', 'MOD', 'setTimeout', 'clearTimeout', 'esc', 'N', js.slice(i0, i1) + '\nreturn { buscaNoPeriodoInteiro };')(
      () => { a.renders++; }, (url) => { a.pedidos.push(url); return a.pedidos.length === 1 ? fetchLento : Promise.resolve({ json: () => Promise.resolve({ ok: true, skus: [{ sku: 'DE-SETEMBRO' }] }) }); }, '/loja', () => 0, () => {}, String, String);
    api2.buscaNoPeriodoInteiro(h1, 'planta');
    api2.buscaNoPeriodoInteiro(h2, 'planta'); await esperar();
    assert.deepStrictEqual(api2.buscaNoPeriodoInteiro(h2, 'planta').skus.map((x) => x.sku), ['DE-SETEMBRO']);
    soltar({ json: () => Promise.resolve({ ok: true, skus: [{ sku: 'DE-OUTUBRO' }] }) }); await esperar();
    assert.deepStrictEqual([api2.buscaNoPeriodoInteiro(h2, 'planta').skus.map((x) => x.sku), a.renders, a.pedidos.length], [['DE-SETEMBRO'], 1, 2], 'a resposta atrasada do período de antes passou por cima da lista do período da tela');
  }

  /* ═══ D. o trecho de produção do TOP Produtos procura na lista inteira ═══ */
  {
    const j0 = js.indexOf('  const _todosProds = usaHist'), j1 = js.indexOf('  _topProds = prods;', j0);
    assert.ok(j0 > 0 && j1 > j0 && js.slice(j0 - 400, j0).includes('const _buscaTop = buscaNoPeriodoInteiro(usaHist ? HIST : null, _qT ? _qT.value : \'\');'), 'o render não pergunta pela lista inteira do período antes de filtrar');
    const roda = new Function('usaHist', 'HIST', 'porProd', '_qT', 'casaBusca', 'sortProd', 'cmpNull', '_buscaTop', js.slice(j0, j1) + '\nreturn { prods, fatTot, mcTot };');
    const casaBusca = new Function('_norm', js.slice(js.indexOf('function casaBusca('), js.indexOf('}', js.indexOf('return t.split', js.indexOf('function casaBusca('))) + 1) + '\nreturn casaBusca;')((s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
    const cmpNull = (x, y, d) => ((x == null ? -Infinity : x) - (y == null ? -Infinity : y)) * (d === -1 ? -1 : 1);
    const HIST = { skus: [{ sku: 'KP18', desc: 'Kit polimento', un: 82, fat: 3567.8, cus: 1141.44, mar: 1160.73, curva: 'A' }], totais: { produtos: 90000, margem: 20000 }, skus_total: 900 };
    const INTEIRA = HIST.skus.concat([{ sku: 'PL-7', desc: 'Plantadeira manual de milho', un: 3, fat: 420, cus: 200, mar: 90, curva: 'C' }]);
    const campo = { value: 'plantadeira' };
    /* sem a lista inteira (ainda procurando): só o pedaço — nada casa */
    assert.deepStrictEqual(roda(true, HIST, {}, campo, casaBusca, { col: 'qtd', dir: -1 }, cmpNull, { hist: HIST, carregando: true }).prods, []);
    /* com a lista inteira: acha o que estava FORA do pedaço, com os números do servidor — e a base dos % não muda */
    const r = roda(true, HIST, {}, campo, casaBusca, { col: 'qtd', dir: -1 }, cmpNull, { hist: HIST, skus: INTEIRA });
    assert.deepStrictEqual([r.prods.map((p) => [p.sku, p.qtd, p.fat, p.mc, p.curva]), r.fatTot, r.mcTot], [[['PL-7', 3, 420, 90, 'C']], 90000, 20000], 'a busca no período longo não achou o produto que estava fora do topo');
    /* sem busca (ou no período curto) nada muda */
    assert.deepStrictEqual(roda(true, HIST, {}, { value: '' }, casaBusca, { col: 'qtd', dir: -1 }, cmpNull, null).prods.map((p) => p.sku), ['KP18']);
    assert.deepStrictEqual(roda(false, null, { A: { sku: 'PL-7', desc: 'Plantadeira', fat: 10, mc: 1, qtd: 1 }, B: { sku: 'KP18', desc: 'Kit', fat: 90, mc: 9, qtd: 9 } }, campo, casaBusca, { col: 'qtd', dir: -1 }, cmpNull, null).prods.map((p) => p.sku), ['PL-7']);
  }

  /* ═══ E. a nota da tabela ═══ */
  {
    const a = montar(); const hist = PARCIAL();
    assert.deepStrictEqual([a.notaDaBuscaTop(null, '', 0, hist), a.notaDaBuscaTop({ carregando: true }, '  ', 0, hist), a.notaDaBuscaTop(null, 'kp', 3, null)], [{ topo: '', vazio: '' }, { topo: '', vazio: '' }, { topo: '', vazio: '' }], 'sem busca (ou com produto achado) a tabela não diz nada');
    const indo = a.notaDaBuscaTop({ carregando: true }, 'planta', 0, hist);
    assert.ok(/procurando “planta” no período inteiro \(900 SKUs\)/.test(indo.topo) && /só o que casa entre os 1 primeiros/.test(indo.topo) && indo.vazio === '', 'enquanto procura no período inteiro a tabela tem que dizer (e não "nenhum produto"): ' + JSON.stringify(indo));
    const falhou = a.notaDaBuscaTop({ falhou: true }, 'planta', 0, hist);
    assert.ok(/não consegui procurar “planta” no período inteiro/.test(falhou.topo) && /o período tem 900 SKUs/.test(falhou.topo) && /Digite de novo/.test(falhou.topo) && falhou.vazio === '', JSON.stringify(falhou));
    assert.deepStrictEqual([a.notaDaBuscaTop({ skus: [] }, 'planta', 0, hist), a.notaDaBuscaTop(null, 'planta', 0, null), a.notaDaBuscaTop({ skus: [] }, 'planta', 2, hist)],
      [{ topo: '', vazio: 'nenhum produto vendido no período casa com “planta”' }, { topo: '', vazio: 'nenhum produto vendido no período casa com “planta”' }, { topo: '', vazio: '' }]);
    /* o que foi digitado nunca vira HTML */
    for (const n of [a.notaDaBuscaTop({ carregando: true }, '<img src=x onerror=alert(1)>', 0, hist), a.notaDaBuscaTop({ falhou: true }, '<img src=x onerror=alert(1)>', 0, hist), a.notaDaBuscaTop(null, '<img src=x onerror=alert(1)>', 0, null)])
      assert.ok(!/<img/.test(n.topo + n.vazio) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(n.topo + n.vazio), 'o termo digitado foi pra tela como HTML: ' + JSON.stringify(n));
    /* o render ESCREVE a nota no lugar dela (o trecho de produção, com um documento de mentira) — e a apaga quando não há */
    {
      const k0 = js.indexOf('  const _notaBusca = notaDaBuscaTop('), k1 = js.indexOf("  $('tProd').innerHTML = _notaTop", k0);
      assert.ok(k0 > 0 && k1 > k0, 'não achei onde o render escreve a nota da busca');
      const lugar = { innerHTML: 'velho', style: { marginBottom: 'x' } };
      const escreve = new Function('notaDaBuscaTop', '_buscaTop', '_qT', 'prods', 'HIST', 'document', js.slice(k0, k1) + '\nreturn _notaBusca;');
      const doc = { getElementById: (i) => (i === 'topBuscaNota' ? lugar : null) };
      escreve(a.notaDaBuscaTop, { carregando: true }, { value: 'planta' }, [], hist, doc);
      assert.ok(/procurando “planta” no período inteiro/.test(lugar.innerHTML) && lugar.style.marginBottom === '6px', 'o render não escreveu a nota da busca na tela: ' + lugar.innerHTML);
      const comProduto = escreve(a.notaDaBuscaTop, { skus: [] }, { value: 'planta' }, [{}], hist, doc);
      assert.deepStrictEqual([lugar.innerHTML, lugar.style.marginBottom], ['', '0'], 'a nota de antes ficou na tela depois que a busca terminou');
      /* "nenhum produto" só quando a tabela filtrada está mesmo vazia */
      assert.deepStrictEqual([comProduto.vazio, /nenhum produto vendido no período casa com “planta”/.test(escreve(a.notaDaBuscaTop, { skus: [] }, { value: 'planta' }, [], hist, doc).vazio)], ['', true], 'a tabela diria "nenhum produto" com produto na lista (ou não diria com a lista vazia)');
      escreve(a.notaDaBuscaTop, null, null, [], null, { getElementById: () => null });   /* sem o campo e sem o lugar: não quebra */
    }
    /* a tela tem o lugar da nota e a linha de "nenhum produto" */
    assert.ok(js.includes('<div id="topBuscaNota"') && js.includes("document.getElementById('topBuscaNota')") && js.includes("(_notaBusca.vazio ? '<tr><td colspan=\"13\""), 'a tabela do TOP Produtos não mostra a nota da busca');
  }

  /* ═══ F. no servidor, a lista inteira é só leitura ═══ */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'busca-top-'));
    fs.writeFileSync(path.join(tmp, '_custos.json'), '{}');
    let resp = null, gatilhos = 0;
    const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: tmp, json: (res, st, o) => { resp = o; },
      aoPublicarSkusSemCusto: () => { gatilhos++; } });
    const linhas = [{ numero_pedido: '1', numero_loja: 'L1', canal: 'ml', data_venda: '2026-10-05', sku: 'SEM-CUSTO', descricao: 'Plantadeira', quantidade: 1, valor_produto: 100, valor_nota: 100, custo: null /* sem custo = custo AUSENTE */, comissao: 10, frete_vendedor: 0, imposto: 0, margem: 90, uf: 'SP' }];
    const pedir = async (q) => { roteiro = [linhas]; resp = null; await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline/historico-longo?k=chave-teste&de=2026-10-01&ate=2026-10-13' + q)); return resp; };
    const abrir = await pedir('&fresh=1');
    assert.ok(abrir && abrir.ok && gatilhos === 1, 'o teste supõe que ABRIR o período dispara a busca de custo do item sem custo (gatilhos=' + gatilhos + ')');
    const inteira = await pedir('&skus=todos&fresh=1');
    assert.ok(inteira && inteira.ok && inteira.skus.some((x) => x.sku === 'SEM-CUSTO'), 'a lista inteira não veio: ' + JSON.stringify(inteira).slice(0, 160));
    assert.strictEqual(gatilhos, 1, 'pedir a lista inteira do período (a busca do TOP Produtos) disparou a busca de custo no Bling de novo');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  _chegouAoFim = true;
  console.log('ok — busca do TOP Produtos: toda função chamada por manipulador da tela existe (as três empresas); digitar redesenha; no período longo de lista parcial a busca pede a lista inteira (uma vez, sem cache), diz quando está procurando ou falhou, ignora resposta de outro período; a tabela acha o produto fora do topo sem mudar a base dos %; a lista inteira é só leitura no servidor');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
