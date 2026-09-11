'use strict';
/* Trava a CLASSE de erro que custou 4 PRs em 10/09: quem decide o custo quando há
   mais de uma fonte. Exercita a função DE PRODUÇÃO (lib/custo-composicao.js), com o
   Bling simulado só na injeção — nada de cópia da lógica. */
const assert = require('assert');
const { decidirCustoDoProduto, somarComposicaoOffline, custoDoBanco } = require('../lib/custo-composicao');

let falhas = 0;
const teste = async (nome, fn) => { try { await fn(); console.log('  ✓ ' + nome); } catch (e) { falhas++; console.log('  ✗ ' + nome + ' — ' + e.message); } };

(async () => {
  // ── o bug de 10/09, na veia ────────────────────────────────────────────────
  await teste('kit: a COMPOSIÇÃO manda sobre o fornecedor (o bug do 2xE14)', async () => {
    const kit = {
      id: 16638636162,
      fornecedor: { precoCusto: 6.8 },           // retrato velho que decidia antes
      estrutura: { componentes: [{ produto: { id: 16632923552 }, quantidade: 2, precoCusto: 3.4 }] },
    };
    const banco = { 'E14-5W-3000K-BIV': { id: 16632923552, custo: 4 } };   // o valor CERTO
    const r = await decidirCustoDoProduto(kit, { banco, memo: new Map() });
    assert.strictEqual(r.custo, 8, 'devia somar 2 × 4,00 do banco, não aceitar 6,80 do fornecedor');
    assert.strictEqual(r.via, 'composicao');
  });

  await teste('componente resolvido por ID (a estrutura não traz o código)', async () => {
    assert.strictEqual(custoDoBanco({ 'X': { id: 99, custo: 7 } }, '', 99), 7);
    assert.strictEqual(custoDoBanco({ 'X': { id: 99, custo: 7 } }, '', 100), null);
  });

  await teste('banco ganha do retrato embutido na estrutura', async () => {
    const kit = { estrutura: { componentes: [{ produto: { id: 5 }, quantidade: 1, precoCusto: 3.4 }] }, fornecedor: {} };
    const r = await decidirCustoDoProduto(kit, { banco: { 'A': { id: 5, custo: 4 } }, memo: new Map() });
    assert.strictEqual(r.custo, 4, 'o embutido (3,40) não pode ganhar do banco (4,00)');
  });

  await teste('composição acima do teto NÃO vira custo (soma parcial é pior que reserva)', async () => {
    const comps = Array.from({ length: 31 }, (_, i) => ({ produto: { id: i }, quantidade: 1, precoCusto: 1 }));
    const r = await decidirCustoDoProduto({ estrutura: { componentes: comps }, fornecedor: { precoCusto: 50 } }, { banco: {}, memo: new Map() });
    assert.strictEqual(r.completo, false);
    assert.strictEqual(r.custo, 50, 'acima do teto vale a reserva declarada, nunca a soma dos 30 primeiros');
    assert.ok(/teto/.test(r.via + ' ' + (r.motivo || '')));
  });

  await teste('kit dentro de kit: soma a composição do componente, não o fornecedor dele', async () => {
    const kitDeFora = { estrutura: { componentes: [{ produto: { id: 70 }, quantidade: 1 }] }, fornecedor: {} };
    const consultarProduto = async (id) => {
      assert.strictEqual(id, 70);
      return { ok: true, produto: {
        id: 70,
        fornecedor: { precoCusto: 99 },                                   // retrato velho do aninhado
        estrutura: { componentes: [{ produto: { id: 71 }, quantidade: 3, precoCusto: 2 }] },
      } };
    };
    const r = await decidirCustoDoProduto(kitDeFora, { banco: { 'N': { id: 71, custo: 5 } }, memo: new Map(), consultarProduto });
    assert.strictEqual(r.custo, 15, 'devia somar 3 × 5,00 (banco) do neto, não os 99,00 do fornecedor do kit interno');
  });

  await teste('sem composição: campos do produto decidem, fornecedores é fallback', async () => {
    const r1 = await decidirCustoDoProduto({ precoCusto: 12 }, { banco: {}, memo: new Map() });
    assert.strictEqual(r1.custo, 12);
    let chamou = 0;
    const r2 = await decidirCustoDoProduto({}, { banco: {}, memo: new Map(), consultarFornecedores: async () => { chamou++; return 9; } });
    assert.strictEqual(r2.custo, 9);
    assert.strictEqual(chamou, 1);
  });

  await teste('produto COM composição não consulta fornecedores antes de somar', async () => {
    let chamou = 0;
    const kit = { estrutura: { componentes: [{ produto: { id: 5 }, quantidade: 1 }] }, fornecedor: { precoCusto: 6.8 } };
    const r = await decidirCustoDoProduto(kit, { banco: { 'A': { id: 5, custo: 4 } }, memo: new Map(), consultarFornecedores: async () => { chamou++; return 6.8; } });
    assert.strictEqual(chamou, 0, 'o endpoint de fornecedores não pode rodar antes da composição — foi assim que o bug nasceu');
    assert.strictEqual(r.custo, 4);
  });

  await teste('componente sem custo nenhum: composição não fecha e a reserva assume', async () => {
    const kit = { estrutura: { componentes: [{ produto: { id: 9 }, quantidade: 1 }] }, fornecedor: { precoCusto: 20 } };
    const r = await decidirCustoDoProduto(kit, { banco: {}, memo: new Map(), consultarProduto: async () => ({ ok: true, produto: { id: 9 } }) });
    assert.strictEqual(r.completo, false);
    assert.strictEqual(r.custo, 20);
  });

  await teste('composição incompleta sem campos do produto ainda cai no endpoint de fornecedores', async () => {
    let chamou = 0;
    const kit = { estrutura: { componentes: [{ produto: { id: 9 }, quantidade: 1 }] } };   // sem fornecedor.precoCusto nem custo
    const r = await decidirCustoDoProduto(kit, {
      banco: {}, memo: new Map(),
      consultarProduto: async () => ({ ok: true, produto: { id: 9 } }),
      consultarFornecedores: async () => { chamou++; return 20; },
    });
    assert.strictEqual(chamou, 1, 'campos do produto não fecharam — o fornecedor é a ÚLTIMA reserva, não pode ser pulado');
    assert.strictEqual(r.custo, 20);
    assert.strictEqual(r.completo, false);
  });

  await teste('consulta falhada marca falhaConsulta (429 ≠ veredito)', async () => {
    const kit = { estrutura: { componentes: [{ produto: { id: 9 }, quantidade: 1 }] }, fornecedor: { precoCusto: 20 } };
    const r = await decidirCustoDoProduto(kit, { banco: {}, memo: new Map(), consultarProduto: async () => ({ ok: false }) });
    assert.strictEqual(r.falhaConsulta, true, 'sem isso, um 429 viraria "produto sem custo" e apagaria custo bom');
  });

  await teste('memo evita consulta repetida do mesmo componente', async () => {
    let consultas = 0;
    const memo = new Map();
    const ctx = { banco: {}, memo, consultarProduto: async (id) => { consultas++; return { ok: true, produto: { id, fornecedor: { precoCusto: 3 } } }; } };
    const kit = { estrutura: { componentes: [{ produto: { id: 42 }, quantidade: 1 }] }, fornecedor: {} };
    await decidirCustoDoProduto(kit, ctx);
    await decidirCustoDoProduto(kit, ctx);
    assert.strictEqual(consultas, 1, 'o segundo kit devia reaproveitar o memo');
  });

  await teste('soma offline devolve null quando um neto não tem custo', async () => {
    assert.strictEqual(somarComposicaoOffline([{ produto: { id: 1 }, quantidade: 1 }], { banco: {}, memo: new Map() }), null);
  });

  console.log(falhas ? '\n✗ ' + falhas + ' falha(s)' : '\nOK: decisão de custo — composição manda, banco ganha do retrato, teto não vira soma, kit aninhado soma, 429 não é veredito');
  process.exit(falhas ? 1 : 0);
})();
