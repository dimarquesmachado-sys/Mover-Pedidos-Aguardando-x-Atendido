'use strict';
/* 17/11 — QUATRO PEDIDOS DO DONO NO DASHBOARD (a tela única das três empresas).

   1. "coloca lá nos cards de cima, ao lado do card de previsão do mês, um total acumulado faturado no Ano. No caso 2026.
      Quando for 2027, aí entre 1 de janeiro 2027 a 31 de dezembro 2027 … faturado aprovado total (sem os cancelados)."
   2. "Separa no cardzinho também o que é taxa e o que é frete. Lado a lado."
   3. "e no análise de vendas … coloca pra filtrar também por palavra. Ao invés de eu digitar o sku FR-HSD-1 que é de uma
      plantadeira, eu procuraria só pesquisando: plantadeira ou parte da palavra."
   4. (a largura da página — scripts/teste-painel-largura-e-botao-chat.js; o texto "1.008 linha(s)1.008 no total" do aviso
      da margem — scripts/teste-fonte-financeira.js)

   Medido num navegador de verdade (Chromium, a tela da Girassol com respostas de mentira, período "Mês anterior" e "Ano",
   telas 1920, 2194, 2560 e celular 390): os 9 cards numa linha só no computador, sem valor quebrando entre o "R$" e o
   número e sem uma metade do card de taxas invadindo a outra; no celular o card de taxas ocupa a linha inteira e a grade
   não deixa buraco.

   O QUE SE PROVA (as funções de PRODUÇÃO, recortadas da tela gerada de cada empresa, e a rota real do histórico):
   A. O card do ANO: pede o ano corrente de São Paulo (01/01 → hoje) SÓ LEITURA, uma busca por vez; mostra o faturado,
      os pedidos e até que dia o histórico tem venda; com o período "Ano" na tela lê o MESMO agregado dos outros cards; em
      2027 pede 2027 e não mostra o número de 2026; falhou, diz que não carregou e só tenta de novo depois de um respiro;
      histórico truncado = PARCIAL. Ele fica logo depois da Previsão do Mês, e o render o pede.
   B. A Previsão do Mês usa o dia de São Paulo (era o de UTC: no último dia do mês, das 21h em diante, previa ZERO).
   C. No servidor, `&so_leitura=1` não dispara a busca de custo no Bling (abrir o período, sim, como sempre).
   D. Taxas e Fretes: taxa + frete = o total, sempre; o frete é o do histórico no período longo e o da tela no curto; o
      card (o trecho de produção) mostra as duas metades lado a lado.
   E. A busca da Análise de Vendas casa o TÍTULO do produto (pedaço, sem acento, várias palavras em qualquer ordem, o nome
      do cadastro quando o item não traz descrição) e continua casando pedido, NF, venda e SKU. */
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
const raiz = path.join(__dirname, '..');
const scriptDe = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const recorte = (js, ini, fim, oQue) => { const a = js.indexOf(ini), b = js.indexOf(fim, a + 1); assert.ok(a >= 0 && b > a, 'não achei ' + oQue + ' na tela'); return js.slice(a, b); };
const linha = (js, re, oQue) => { const m = re.exec(js); assert.ok(m, 'não achei ' + oQue + ' na tela'); return m[0]; };
const espera = () => new Promise((r) => setImmediate(r));

(async () => {
  for (const emp of ['girassol', 'good', 'ambtotal']) {
    const html = T.telaDaEmpresa(emp), js = scriptDe(html);
    const BASICO = [linha(js, /^const BRL = [^\n]+$/m, 'o BRL'), linha(js, /^const N = [^\n]+$/m, 'o N'), recorte(js, 'function dBR(d){', '\n}', 'o dBR') + '\n}'].join('\n');
    const BLOCO = recorte(js, 'let PREV_MES = null;', 'let HIST = null;', 'a previsão do mês e o card do ano');

    /* ═══ A e B. as funções de produção, com o relógio, a rede e a tela de mentira ═══ */
    const montar = (hoje) => {
      const amb = { hoje, pedidos: [], respostas: [], renders: 0, soltar: null };
      const fetchFalso = (url, opts) => { amb.pedidos.push([url, opts]); const r = amb.respostas.shift();
        if (r === 'segura') return new Promise((ok) => { amb.soltar = (x) => ok({ json: () => Promise.resolve(x) }); });
        return r === 'cai' ? Promise.reject(new Error('rede')) : Promise.resolve({ json: () => Promise.resolve(r) }); };
      const f = new Function('MOD', 'fetch', 'hojeSP', 'render', BASICO + '\nlet HIST = null;\n' + BLOCO +
        '\nreturn { carregarFatAno, carregarPrevisaoMes, cardFatAno, fatAnoPrecisaBuscar, fatAnoDe, separarTaxaFrete, brlMeio,' +
        ' get FAT_ANO(){ return FAT_ANO; }, set FAT_ANO(v){ FAT_ANO = v; }, get PREV_MES(){ return PREV_MES; }, set HIST(v){ HIST = v; } };');
      amb.t = f('/loja', fetchFalso, () => amb.hoje, () => { amb.renders++; });
      return amb;
    };
    const ano = (fat, extra) => Object.assign({ ok: true, de: '2026-01-01', ate: '2026-11-17', truncado: false,
      dias: { '2026-11-16': { pedidos: 9, fat: 90 }, '2026-01-02': { pedidos: 3, fat: 30 } },
      totais: { faturamento: fat, pedidos: 31234 } }, extra || {});
    {
      const a = montar('2026-11-17');
      assert.strictEqual(a.t.fatAnoPrecisaBuscar(), true, emp + ': sem o ano carregado o render tinha que pedir');
      assert.ok(/calculando 2026/.test(a.t.cardFatAno(false)), emp + ': antes de chegar, o card diz que está calculando');
      a.respostas.push('segura');
      const p1 = a.t.carregarFatAno(); a.t.carregarFatAno(); a.t.carregarFatAno();
      await espera();
      assert.deepStrictEqual(a.pedidos, [['/loja/historico-longo?de=2026-01-01&ate=2026-11-17&so_leitura=1', { credentials: 'same-origin' }]], emp + ': o card do ano tem que pedir o ano corrente (01/01 → hoje), SÓ LEITURA, uma vez');
      a.soltar(ano(3876543.21)); await p1;
      assert.strictEqual(a.renders, 1, emp + ': chegou o ano e a tela não foi redesenhada');
      assert.deepStrictEqual(a.t.FAT_ANO, { ano: '2026', de: '2026-01-01', ate: '2026-11-17', fat: 3876543.21, pedidos: 31234, ateDia: '2026-11-16', truncado: false }, emp + ': o card leu o agregado errado');
      const c = a.t.cardFatAno(false);
      assert.ok(/Faturado no Ano/.test(c) && c.includes('R$ 3.876.543,21') && c.includes('<b>2026</b>') && c.includes('01/01 → 16/11') && c.includes('31.234 pedidos') && !/PARCIAL/.test(c),
        emp + ': o card do ano não mostra o faturado, o ano, até que dia o histórico tem venda e os pedidos: ' + c);
      assert.ok(/cancelado n\\u00e3o entra|cancelado não entra/.test(BLOCO) && /aprovado|APROVADO/.test(c), emp + ': o card tem que dizer que é o faturado APROVADO, sem os cancelados');
      assert.strictEqual(a.t.fatAnoPrecisaBuscar(), false, emp + ': com o ano do dia carregado o render não pede de novo');
      /* com o período "Ano" na tela, o card lê o MESMO agregado dos outros cards */
      a.t.HIST = { de: '2026-01-01', ate: '2026-11-17', totais: { faturamento: 3900000, pedidos: 31300 }, dias: { '2026-11-17': {} } };
      assert.ok(a.t.cardFatAno(true).includes('R$ 3.900.000,00') && a.t.cardFatAno(true).includes('01/01 → 17/11'), emp + ': com o período Ano na tela, o card tinha que ler o mesmo agregado dos outros cards');
      assert.ok(a.t.cardFatAno(false).includes('R$ 3.876.543,21'), emp + ': sem o histórico do período na tela (usaHist falso), vale o do card');
      a.t.HIST = { de: '2026-10-01', ate: '2026-10-31', totais: { faturamento: 1, pedidos: 1 }, dias: {} };
      assert.ok(a.t.cardFatAno(true).includes('R$ 3.876.543,21'), emp + ': o período na tela é outro: o card não pode ler o agregado dele');
      /* o dia virou: pede de novo; o ANO virou: pede o ano novo e não mostra o número do ano velho */
      a.hoje = '2026-11-18';
      assert.strictEqual(a.t.fatAnoPrecisaBuscar(), true, emp + ': o dia virou e o card não pediu de novo');
      a.hoje = '2027-01-01'; a.t.HIST = null;
      assert.ok(/calculando 2027/.test(a.t.cardFatAno(false)) && !a.t.cardFatAno(false).includes('3.876.543'), emp + ': em 2027 o card mostrou o número de 2026');
      a.respostas.push(ano(1234.5, { de: '2027-01-01', ate: '2027-01-01', dias: {} })); await a.t.carregarFatAno();
      assert.strictEqual(a.pedidos[1][0], '/loja/historico-longo?de=2027-01-01&ate=2027-01-01&so_leitura=1', emp + ': em 2027 a janela tem que ser 01/01/2027 em diante');
      assert.ok(a.t.cardFatAno(false).includes('R$ 1.234,50') && a.t.cardFatAno(false).includes('<b>2027</b>') && a.t.cardFatAno(false).includes('01/01 → 01/01'), emp + ': o card de 2027');
    }
    /* falhou: diz que não carregou, não martela (tenta de novo depois de 2 min); truncado = PARCIAL */
    for (const ruim of [{ ok: false, erro: 'x' }, null, 'cai']) {
      const a = montar('2026-11-17'); a.respostas.push(ruim); await a.t.carregarFatAno();
      assert.ok(a.t.FAT_ANO && a.t.FAT_ANO.erro && /não consegui carregar 2026/.test(a.t.cardFatAno(false)) && !/R\$ 0,00/.test(a.t.cardFatAno(false)), emp + ': a falha (' + JSON.stringify(ruim) + ') virou número no card');
      assert.strictEqual(a.t.fatAnoPrecisaBuscar(), false, emp + ': logo depois da falha o render pediu de novo (martelaria a rota a cada repintura)');
      a.t.FAT_ANO = Object.assign({}, a.t.FAT_ANO, { em: Date.now() - 121000 });
      assert.strictEqual(a.t.fatAnoPrecisaBuscar(), true, emp + ': depois do respiro o card tem que tentar de novo');
    }
    { const a = montar('2026-11-17'); a.respostas.push(ano(10, { truncado: true })); await a.t.carregarFatAno();
      assert.ok(/PARCIAL/.test(a.t.cardFatAno(false)), emp + ': o histórico truncado tem que aparecer como PARCIAL'); }
    /* o render pede o card e o card fica logo depois da Previsão do Mês */
    assert.ok(/try\{ if\(fatAnoPrecisaBuscar\(\)\) carregarFatAno\(\); \}catch\(e\)\{\}/.test(js), emp + ': o render não pede o card do ano');
    assert.ok(/m\\u00eas fechado<\/span>'\)\+'<\/div><\/div>';\n    \}\)\(\) \+\n    cardFatAno\(usaHist\) \+/.test(js), emp + ': o card do ano tem que vir logo depois da Previsão do Mês');

    /* B. a previsão do mês: o dia de São Paulo, uma busca por vez */
    {
      const a = montar('2026-11-30'); a.respostas.push('segura');
      const p = a.t.carregarPrevisaoMes(); a.t.carregarPrevisaoMes(); await espera();
      assert.deepStrictEqual(a.pedidos.map((x) => x[0]), ['/loja/historico-longo?de=2026-11-01&ate=2026-11-30'], emp + ': a previsão tem que pedir o mês de São Paulo, uma vez');
      a.soltar({ ok: true, totais: { faturamento: 600000 } }); await p;
      const P = a.t.PREV_MES;
      assert.deepStrictEqual([P.mes, P.ano, P.dia, P.diaAtual, P.diasNoMes, P.previsto], [10, 2026, '2026-11-30', 30, 30, 600000], emp + ': a previsão do mês: ' + JSON.stringify(P));
      assert.ok(/if\(!PREV_MES \|\| PREV_MES\.dia !== hojeSP\(\)\) carregarPrevisaoMes\(\);/.test(js), emp + ': o render tem que comparar o dia de São Paulo');
      assert.ok(!/const ini = hj\.toISOString\(\)/.test(BLOCO), emp + ': a previsão voltou a usar o dia de UTC');
    }

    /* ═══ D. Taxas e Fretes ═══ */
    {
      const { t } = montar('2026-11-17');
      assert.deepStrictEqual(t.separarTaxaFrete(350, false, null, { frV: 300, fRecP: 50 }), { frete: 250, taxa: 100 }, emp + ': no período curto o frete é o do vendedor menos o que o comprador pagou');
      assert.deepStrictEqual(t.separarTaxaFrete(440, true, { frete: 200, comissao: 220 }, { frV: 999, fRecP: 1 }), { frete: 200, taxa: 240 }, emp + ': no período longo o frete é o do histórico (não o da tela)');
      for (let i = 0; i < 300; i++) {
        const tot = Math.round(Math.random() * 1e8) / 100, fr = Math.round(Math.random() * 1e7) / 100;
        const r = t.separarTaxaFrete(tot, i % 2 === 0, { frete: fr }, { frV: fr, fRecP: 0 });
        assert.ok(Math.abs(r.taxa + r.frete - tot) < 0.005, emp + ': taxa + frete não fecha o total (' + tot + ' → ' + JSON.stringify(r) + ')');
      }
      assert.strictEqual(t.brlMeio(1234.5), '<small>R$</small> 1.234,50'); assert.strictEqual(t.brlMeio(-3), '<small>R$</small> -3,00');
      /* o card, pelo trecho de produção */
      const card = recorte(js, '(function(){\n      const iv3=intervalo();', '\n    })() +', 'o card Taxas e Fretes') + '\n    })()';
      const rodar = (usaHist, HIST, MC, fat) => new Function('intervalo', 'MLB_PER', 'MLB_CK', 'despesasSHPper', 'usaHist', 'HIST', 'MC', 'fat', 'BRL', 'separarTaxaFrete', 'brlMeio',
        'return ' + card + ';')(() => ({ de: 'a', ate: 'b' }), null, '', () => 0, usaHist, HIST, MC, fat, new Function(BASICO + '\nreturn BRL;')(), t.separarTaxaFrete, t.brlMeio);
      const curto = rodar(false, null, { imp: 80, cus: 400, mc: 170, tar: 100, frV: 300, fRecP: 50, credML: 0 }, 1000);
      assert.ok(/class="kpi kTF"/.test(curto) && curto.includes('>R$ 350,00') && /<div class="tf2"><div[^>]*><i>taxas<\/i><b><small>R\$<\/small> 100,00<\/b><span>10% do fat\.<\/span><\/div><div[^>]*><i>fretes<\/i><b><small>R\$<\/small> 250,00<\/b><span>25% do fat\.<\/span><\/div><\/div>/.test(curto),
        emp + ': o card não mostra taxa e frete lado a lado (período curto): ' + curto);
      const longo = rodar(true, { totais: { faturamento: 2000, imposto: 160, custo: 800, margem: 600, frete: 200, comissao: 220 } }, { tar: 1, frV: 2, fRecP: 0, credML: 0 }, 0);
      assert.ok(longo.includes('>R$ 440,00') && longo.includes('<i>taxas</i><b><small>R$</small> 240,00</b><span>12% do fat.</span>') && longo.includes('<i>fretes</i><b><small>R$</small> 200,00</b><span>10% do fat.</span>'),
        emp + ': o card não mostra taxa e frete lado a lado (período longo): ' + longo);
      assert.ok(longo.includes('comissão/tarifa R$ 220,00') && longo.includes('frete do vendedor R$ 200,00'), emp + ': no período longo o detalhe do card tem que ser o do histórico, não o dos últimos dias da tela');
    }

    /* ═══ E. a busca da Análise de Vendas ═══ */
    {
      const fonte = linha(js, /^const _norm = [^\n]+$/m, 'o _norm') + '\n' + recorte(js, 'function casaBusca(termo, ...campos){', '\n}', 'o casaBusca') + '\n}\n' +
        recorte(js, 'const anBuscaOk = q => h => {', '\n};', 'a busca da Análise') + '\n};';
      const SKUINFO = { CM1: { nome: 'Carrinho Ferramentas 3 Prateleiras' } };
      const ok = new Function('SKUINFO', fonte + '\nreturn anBuscaOk;')(SKUINFO);
      const h = { numero: '12345', nf_numero: '998877', numero_loja: '2000011112222', id: 555, itens: [{ sku: 'FR-HSD-1', descricao: 'Plantadeira Manual Matraca Dupla' }, { sku: 'CM1' }, { sku: 'MX-9', descricao: 'Carrinho Mecânico Oficina' }] };
      for (const q of ['plantadeira', 'planta', 'matraca plantadeira', 'dupla manual', 'mecanico', 'mecânico', 'ferramentas', 'prateleiras carrinho', 'fr-hsd', 'hsd', '12345', '9988', '2000011', '555'])
        assert.strictEqual(ok(q)(h), true, emp + ': a busca "' + q + '" não achou o pedido');
      for (const q of ['furadeira', 'plantadeira eletrica', 'zzz'])
        assert.strictEqual(ok(q)(h), false, emp + ': a busca "' + q + '" achou um pedido que não casa');
      assert.strictEqual(ok('plantadeira')({ numero: '1', itens: [] }), false);
      assert.ok(/placeholder="🔎 pedido, NF, venda, SKU ou nome do produto…"/.test(html), emp + ': o campo da busca tem que dizer que procura pelo nome do produto');
      assert.ok(/if\(q\) L=L\.filter\(anBuscaOk\(q\)\);/.test(js) && /\.filter\(h=>!q\|\|anBuscaOk\(q\)\(h\)\);/.test(js), emp + ': a lista da Análise (bipados e não bipados) tem que passar pela busca');
    }
  }
  /* o período longo: a lista vem do servidor, que já procura o termo no SKU e na DESCRIÇÃO (o título) */
  assert.ok(fs.readFileSync(path.join(raiz, 'lib/checkout/historico.js'), 'utf8').includes("junta(await puxaAlvos('&or=(sku.ilike.' + likeR + ',descricao.ilike.' + likeR + ')'));"), 'a busca do período longo deixou de procurar no título');

  /* ═══ C. no servidor, `&so_leitura=1` não dispara a busca de custo no Bling — e não CALA a abertura do período ═══ */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-leitura-'));
    fs.writeFileSync(path.join(tmp, '_custos.json'), '{}');
    const linhas = [{ numero_pedido: '1', numero_loja: 'L1', canal: 'ml', data_venda: '2026-10-05', sku: 'SEM-CUSTO', descricao: 'Plantadeira', quantidade: 1, valor_produto: 100, valor_nota: 100, custo: null, comissao: 10, frete_vendedor: 0, imposto: 0, margem: 90, uf: 'SP' }];
    const montarH = () => {
      const m = { resp: null, gatilhos: 0, cache: {} };
      const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: m.cache, CACHE_DIR: tmp, json: (res, st, o) => { m.resp = o; },
        aoPublicarSkusSemCusto: () => { m.gatilhos++; } });
      m.pedir = async (q, resExtra, ln) => { roteiro = [ln || linhas]; m.resp = null; await h({ method: 'GET', headers: {} }, Object.assign({}, resExtra || {}), new URL('http://x/good-checkout-offline/historico-longo?k=chave-teste&de=2026-01-01&ate=2026-11-17' + q)); return m.resp; };
      return m;
    };
    {
      const m = montarH();
      const abrir = await m.pedir('&fresh=1');
      assert.ok(abrir && abrir.ok && m.gatilhos === 1, 'o teste supõe que ABRIR o período dispara a busca de custo do item sem custo (gatilhos=' + m.gatilhos + ')');
      const soLer = await m.pedir('&so_leitura=1&fresh=1');
      assert.ok(soLer && soLer.ok && soLer.totais.faturamento === abrir.totais.faturamento, 'a leitura do card do ano não trouxe o mesmo agregado: ' + JSON.stringify(soLer).slice(0, 160));
      assert.strictEqual(m.gatilhos, 1, 'o card do ano (só leitura) disparou a busca de custo no Bling');
      await m.pedir('&so_leitura=0&fresh=1');
      assert.strictEqual(m.gatilhos, 2, 'só o valor 1 pede só leitura');
    }
    /* Codex #936 (reproduzido na rota real): o card do ano monta o agregado ANTES de o dono abrir o "Ano" — a abertura,
       dentro dos 10 min do cache, não pode voltar do cache sem disparar a busca de custo */
    {
      const quem = 'o card do ano', q = '&so_leitura=1', resExtra = null;
      const m = montarH();
      const r1 = await m.pedir(q, resExtra);
      assert.ok(r1 && r1.ok && m.gatilhos === 0, quem + ': a só leitura disparou a busca de custo');
      assert.ok(!('2026-01-01|2026-11-17' in m.cache), quem + ': a só leitura guardou o agregado na entrada da abertura do período (calaria o custo): ' + Object.keys(m.cache).join(', '));
      const r2 = await m.pedir('');
      assert.ok(r2 && r2.ok && !r2.cache && m.gatilhos === 1, quem + ' calou a busca de custo da abertura do período (cache=' + (r2 && r2.cache) + ', gatilhos=' + m.gatilhos + ')');
      /* e a só leitura APROVEITA o agregado da abertura (ler não dispara nada) */
      const r3 = await m.pedir(q, resExtra);
      assert.ok(r3 && r3.cache === true && m.gatilhos === 1, quem + ': a só leitura tinha que aproveitar o agregado da abertura que está no cache');
    }
    /* a abertura PRIMEIRO (o caso comum: o dono abre o "Ano" e o card vem junto), com tudo custeado (a abertura que
       dispara a busca de custo não fica no cache — Codex #564 —, então aqui não há o que buscar): a abertura segue no cache
       dela e o card aproveita, sem montar o ano de novo */
    {
      const m = montarH();
      const comCusto = linhas.map((l) => Object.assign({}, l, { sku: 'COM-CUSTO', custo: 40 }));
      await m.pedir('', null, comCusto);
      const r2 = await m.pedir('', null, comCusto);
      assert.ok(r2 && r2.cache === true && m.gatilhos === 0, 'a abertura do período deixou de ficar no cache dela (cache=' + (r2 && r2.cache) + ')');
      const r3 = await m.pedir('&so_leitura=1', null, comCusto);
      assert.ok(r3 && r3.cache === true && m.gatilhos === 0, 'o card do ano não aproveitou o agregado da abertura (montou o ano de novo)');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ═══ o CSS: o card de taxas mais largo no computador, de linha inteira no celular sem buraco; o valor encolhe no card estreito ═══ */
  {
    const css = /<style>([\s\S]*?)<\/style>/.exec(T.telaDaEmpresa('girassol'))[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const i21 = css.indexOf('.kpi .v{font-size:21px;'), iCq = css.indexOf('.kpi .v{font-size:min(21px,11.5cqi)}');
    assert.ok(i21 > 0 && iCq > i21 && css.includes('.kpi{container-type:inline-size}'), 'o valor do card tem que encolher com a largura do card (e os 21px ficarem antes, pro navegador sem cqi)');
    assert.ok(css.includes('.kpi.kTF{flex:1.4 1 210px;min-width:210px}') && css.includes('.kpi .tf2{display:grid;grid-template-columns:1fr 1fr;'), 'as duas metades do card de taxas, lado a lado');
    const cel = /@media\(max-width:720px\)\{([\s\S]*?)\n  \}/.exec(css);
    assert.ok(cel && cel[1].includes('.kpi.kTF{grid-column:span 2}') && /\.kpis\{display:grid;grid-template-columns:1fr 1fr;[^}]*grid-auto-flow:row dense\}/.test(cel[1]), 'no celular o card de taxas ocupa a linha inteira, sem buraco na grade');
  }

  _chegouAoFim = true;
  console.log('ok — dashboard (as três empresas): card Faturado no Ano (ano corrente de SP, só leitura, uma busca por vez, mesmo agregado do período Ano, falha honesta); previsão no dia de SP; Taxas e Fretes partido em taxa | frete somando o total; a busca da Análise acha pelo título do produto');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
