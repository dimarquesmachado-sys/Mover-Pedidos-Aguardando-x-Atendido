'use strict';
/* 18/11 — O CARD TAXAS E FRETES NÃO CONTA COMO TAXA A VENDA DOS PEDIDOS FORA DA CONTA.

   O card é apurado por diferença (faturamento − impostos − custo − margem). O pedido cuja margem NÃO entra no total (sem
   custo fechado, sem taxa ou alíquota — o "⚠ N pedido(s) fora da conta" do Lucro Bruto) segue no Faturamento e nos
   Impostos: a venda dele, menos o imposto, caía inteira no card como se fosse taxa de plataforma. Achado ao escrever no
   card de onde vêm as taxas (#940): com uma venda de R$ 200 ainda sem custo, o card dizia R$ 195 de taxas num dia em que
   as plataformas ficaram com R$ 15.

   Agora esses pedidos saem da conta do card (nos dois caminhos: o período curto, calculado na tela, e o longo, que vem do
   histórico — o servidor passa a dizer quanto as linhas sem margem somaram em cada parcela) e o card avisa quantos são.
   Nenhum outro número muda.

   O QUE SE PROVA (as funções de PRODUÇÃO, recortadas da tela gerada de cada empresa, e a rota real do histórico):
   A. período curto: o cálculo dos cards (MC) separa a venda e o imposto do pedido fora da conta; o card mostra só o que
      ficou com as plataformas (taxa | frete) e avisa "1 pedido(s) fora da conta"; sem ninguém de fora, nada muda;
   B. período longo: o card tira o que o histórico diz que ficou fora (venda − imposto − custo conhecido; o frete dessas
      linhas sai da metade "fretes") e avisa; histórico de antes desta mudança (sem o campo) segue como era;
   C. o servidor: a linha sem margem (sem custo; ou com custo e sem comissão) entra em `totais.fora_da_conta` com o que
      somou em cada parcela — e os totais de sempre não mudam. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let roteiro = [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
  exports: async () => { const r = roteiro.length ? roteiro.shift() : []; return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }; } };
process.env.ADMIN_KEY = 'chave-teste';
const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'fora-conta-'));
for (const [tag, emp] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, emp); fs.mkdirSync(path.join(PASTAS, emp), { recursive: true }); }
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim'); process.exitCode = 1; } });

const T = require('./_tela-empresa');
const scriptDe = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const recorte = (js, ini, fim, oQue) => { const a = js.indexOf(ini), b = js.indexOf(fim, a + 1); assert.ok(a >= 0 && b > a, 'não achei ' + oQue + ' na tela'); return js.slice(a, b); };
const linha = (js, re, oQue) => { const m = re.exec(js); assert.ok(m, 'não achei ' + oQue + ' na tela'); return m[0]; };

(async () => {
  for (const emp of ['girassol', 'good', 'ambtotal']) {
    const js = scriptDe(T.telaDaEmpresa(emp));
    const BASICO = [linha(js, /^const BRL = [^\n]+$/m, 'o BRL'), linha(js, /^const N = [^\n]+$/m, 'o N')].join('\n');
    const util = new Function(BASICO + '\n' + recorte(js, 'function brlMeio(v){', '/* o render pede quando', 'a partição e a linha das taxas') + '\nreturn { BRL, N, brlMeio, separarTaxaFrete, deOndeVemTaxa };')();
    const card = recorte(js, '(function(){\n      const iv3=intervalo();', '\n    })() +', 'o card Taxas e Fretes') + '\n    })()';
    const rodar = (usaHist, HIST, MC, fat) => new Function('intervalo', 'MLB_PER', 'MLB_CK', 'despesasSHPper', 'usaHist', 'HIST', 'MC', 'fat', 'BRL', 'N', 'separarTaxaFrete', 'brlMeio', 'deOndeVemTaxa',
      'return ' + card + ';')(() => ({ de: 'a', ate: 'b' }), null, '', () => 0, usaHist, HIST, MC, fat, util.BRL, util.N, util.separarTaxaFrete, util.brlMeio, util.deOndeVemTaxa);
    const metades = (h) => { const m = /<i>taxas<\/i><b><small>R\$<\/small> ([^<]+)<\/b>[\s\S]*?<i>fretes<\/i><b><small>R\$<\/small> ([^<]+)<\/b>/.exec(h); return m ? [m[1], m[2]] : null; };

    /* ═══ A. período curto: o cálculo de produção dos cards + o card ═══ */
    const mcSrc = recorte(js, '  const MC = (function(){', '\n  })();', 'o cálculo dos cards (MC)') + '\n  })();';
    const pecasMC = [linha(js, /^const DEFAULT_FLEX = [^\n]+$/m, 'o DEFAULT_FLEX'), linha(js, /^const flexDe = [^\n]+(?:\n[^\n]+)*?\n};$/m, 'o flexDe'),
      linha(js, /^const CANAIS_CFG = [^\n]+$/m, 'os canais'), linha(js, /^const canalKey = [^\n]+$/m, 'o canalKey')].join('\n');
    const rodaMC = (pedidos, taxas) => new Function('TODOS', 'SKUINFO', 'CFG', 'aliqDe', 'diaVenda', 'tarifaEstimadaTikTok', 'nomeCanal',
      pecasMC + '\n' + mcSrc + '\nreturn MC;')(pedidos, {}, { taxas: taxas || { ml: 14 }, aliquotas: {}, flex: {} }, () => 10, () => '2026-11-10', () => null, (k) => k);
    const fechado = { numero: 1, marketplace: 'mercadolivre', valor: 100, vprod_nf: 100, tarifa_ml: 10, frete_ml: 5, itens: [{ sku: 'A', qtd: 1, custo: 40, valor_total: 100 }] };
    const semCusto = { numero: 2, marketplace: 'mercadolivre', valor: 200, vprod_nf: 200, tarifa_ml: 22, frete_ml: 9, itens: [{ sku: 'B', qtd: 1, valor_total: 200 }] };
    const semTaxa = { numero: 3, marketplace: 'canalnovo', valor: 50, vprod_nf: 50, itens: [{ sku: 'C', qtd: 1, custo: 10, valor_total: 50 }] };
    {
      const MC = rodaMC([fechado]);
      assert.deepStrictEqual([MC.mc, MC.imp, MC.cus, MC.foraFat, MC.foraImp, MC.foraPed], [35, 10, 40, 0, 0, 0], emp + ': o cálculo dos cards mudou sem ninguém fora da conta: ' + JSON.stringify(MC).slice(0, 200));
      const h = rodar(false, null, MC, 100);
      assert.ok(h.includes('>R$ 15,00') && String(metades(h)) === '10,00,5,00' && !h.includes('fora da conta'), emp + ': sem pedido fora da conta o card não pode mudar: ' + h);
    }
    {
      const MC = rodaMC([fechado, semCusto, semTaxa]);
      assert.deepStrictEqual([MC.mc, MC.imp, MC.cus, MC.semDados, MC.semCfg], [35, 35, 40, 1, 1], emp + ': o exemplo mudou: ' + JSON.stringify(MC).slice(0, 240));
      assert.deepStrictEqual([MC.foraFat, MC.foraImp, MC.foraPed], [250, 25, 2], emp + ': o cálculo dos cards não separou a venda e o imposto dos pedidos fora da conta');
      const h = rodar(false, null, MC, 350);
      assert.ok(h.includes('<div class="v bad"') && h.includes('>R$ 15,00<'), emp + ': a venda do pedido fora da conta entrou como taxa (o total tinha que ser R$ 15,00): ' + h);
      assert.strictEqual(String(metades(h)), '10,00,5,00', emp + ': as metades não são só o que ficou com as plataformas');
      assert.ok(h.includes('<div class="tfDe"><span class="warn">⚠ 2 pedido(s) fora da conta</span> (sem custo ou taxa fechados) — a venda deles não entra aqui</div></div>'), emp + ': o card não avisa quantos pedidos ficaram fora da conta: ' + h);
      assert.ok(h.includes('(sem os pedidos fora da conta)'), emp + ': a explicação do total não diz que os pedidos fora da conta saíram');
    }

    /* ═══ B. período longo: o que o histórico diz que ficou fora ═══ */
    {
      const tot = { faturamento: 2000, imposto: 160, custo: 800, margem: 600, frete: 200, comissao: 220 };
      const antigo = rodar(true, { totais: tot }, { tar: 1, frV: 2, fRecP: 0, credML: 0, foraFat: 999, foraImp: 9, foraPed: 9 }, 0);
      assert.ok(antigo.includes('>R$ 440,00') && String(metades(antigo)) === '240,00,200,00' && !antigo.includes('fora da conta'), emp + ': histórico sem o campo (resposta de antes) tem que seguir como era — e o que é da tela curta não vale no longo: ' + antigo);
      const novo = rodar(true, { totais: Object.assign({}, tot, { fora_da_conta: { faturamento: 300, imposto: 24, custo: 50, frete: 15, linhas: 3, pedidos: 2 } }) }, { tar: 1, frV: 2, fRecP: 0, credML: 0 }, 0);
      assert.ok(novo.includes('>R$ 214,00<'), emp + ': o período longo não tirou da conta o que ficou fora (2000 − 160 − 800 − 600 − (300 − 24 − 50) = 214): ' + novo);
      assert.strictEqual(String(metades(novo)), '29,00,185,00', emp + ': o frete das linhas fora da conta tem que sair da metade "fretes" (200 − 15), e a taxa é o resto');
      assert.ok(novo.includes('⚠ 2 pedido(s) fora da conta'), emp + ': o card do período longo não avisa os pedidos fora da conta');
      const zero = rodar(true, { totais: Object.assign({}, tot, { fora_da_conta: { faturamento: 0, imposto: 0, custo: 0, frete: 0, linhas: 0, pedidos: 0 } }) }, {}, 0);
      assert.ok(zero.includes('>R$ 440,00') && !zero.includes('fora da conta'), emp + ': ninguém fora da conta = card igual');
    }
  }

  /* ═══ C. o servidor (a rota real do histórico) ═══ */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fora-rota-'));
    fs.writeFileSync(path.join(tmp, '_custos.json'), '{}');
    const base = { canal: 'ml', data_venda: '2026-10-05', quantidade: 1, uf: 'SP', comissao_fonte: 'real', frete_fonte: 'real' };
    const ok = Object.assign({}, base, { numero_pedido: '1', sku: 'A', valor_produto: 100, valor_nota: 100, custo: 40, comissao: 10, frete_vendedor: 10, imposto: 10, margem: 30 });
    const semCusto = Object.assign({}, base, { numero_pedido: '2', sku: 'B', valor_produto: 200, valor_nota: 200, custo: null, comissao: 20, frete_vendedor: 15, imposto: 16, margem: null });
    const semComissao = Object.assign({}, base, { numero_pedido: '3', sku: 'C', valor_produto: 80, valor_nota: 80, custo: 50, comissao: null, frete_vendedor: 4, imposto: 6, margem: null });
    const pedir = async (linhas) => { let resp = null;
      const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: tmp, json: (res, st, o) => { resp = o; }, aoPublicarSkusSemCusto: () => {} });
      roteiro = [linhas];
      await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline/historico-longo?k=chave-teste&de=2026-10-01&ate=2026-10-31&so_leitura=1&fresh=1'));
      return resp; };
    const so = await pedir([ok]);
    assert.ok(so && so.ok, 'a rota do histórico não respondeu: ' + JSON.stringify(so).slice(0, 200));
    assert.deepStrictEqual(so.totais.fora_da_conta, { faturamento: 0, imposto: 0, custo: 0, frete: 0, linhas: 0, pedidos: 0 }, 'linha com margem não é "fora da conta"');
    const r = await pedir([ok, semCusto, semComissao]);
    assert.ok(r && r.ok, 'a rota do histórico não respondeu: ' + JSON.stringify(r).slice(0, 200));
    const impFora = Math.round((r.totais.imposto - so.totais.imposto) * 100) / 100;
    assert.ok(impFora > 0, 'o exemplo supõe imposto nas linhas sem margem');
    assert.deepStrictEqual(r.totais.fora_da_conta, { faturamento: 280, imposto: impFora, custo: 50, frete: 19, linhas: 2, pedidos: 2 }, 'o servidor não disse quanto as linhas sem margem somaram: ' + JSON.stringify(r.totais.fora_da_conta));
    assert.deepStrictEqual([r.totais.faturamento, r.totais.custo, r.totais.frete, r.totais.margem], [380, 90, 29, so.totais.margem], 'os totais de sempre mudaram: ' + JSON.stringify(r.totais).slice(0, 240));
    /* por diferença, sem o que ficou fora, sobra só o que as plataformas tiraram da linha fechada */
    const f = r.totais.fora_da_conta;
    const total = Math.round((r.totais.faturamento - r.totais.imposto - r.totais.custo - r.totais.margem - (f.faturamento - f.imposto - f.custo)) * 100) / 100;
    assert.strictEqual(total, Math.round((so.totais.faturamento - so.totais.imposto - so.totais.custo - so.totais.margem) * 100) / 100, 'com os pedidos fora da conta o card tem que dar o mesmo que sem eles');
  }
  _chegouAoFim = true;
  console.log('ok — Taxas e Fretes sem a venda dos pedidos fora da conta (as três empresas): período curto (cálculo dos cards + card), período longo (o card lê o que o histórico diz) e a rota real do histórico (`totais.fora_da_conta`)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
