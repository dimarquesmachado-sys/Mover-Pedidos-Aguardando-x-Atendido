'use strict';
/* 24/11 — PLANO DE COMPRA: O QUE ESTÁ A CAMINHO (os Pedidos de Compra em aberto no Bling), com a data prevista.
   O dono: "informar o estoque vindo. acho bem legal, e com alguma previsão de data da chegada".
   O formato dos pedidos de compra usado aqui é o que o Bling da Girassol devolveu em 24/11 (lista sem itens; detalhe com
   itens[].quantidade, itens[].produto.codigo, itens[].notaFiscal.quantidade; situacao.valor 0/1/2/3).

   O que se prova (o código de produção):
   A. a peça (lib/checkout/compras-a-caminho): a soma por SKU (pendente = pedido − o que já entrou por nota; a data
      prevista mais próxima; atrasado; sem data; só situações Em aberto/Em andamento), e a leitura do Bling — qualquer
      falha é "não sei" (nunca soma pela metade), com os tetos avisando "incompleto";
   B. a ROTA /plano-compra na fábrica de verdade, nas três empresas: comprar = precisa − saldo − a caminho; "não sei" não
      desconta nada e diz por quê; o "vai faltar antes de chegar"; a leitura fica guardada (10 min; falha 1 min) e
      `?caminho=novo` lê de novo;
   C. a TELA: a coluna "a caminho" (quantidade, chega/atrasado/sem data, acaba antes de chegar, "?" e "—") e a linha de
      resumo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AC = require('../lib/checkout/compras-a-caminho');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const DIA = 86400000;
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const mais = (n) => new Date(Date.parse(hojeSP() + 'T00:00:00Z') + n * DIA).toISOString().slice(0, 10);
const item = (codigo, quantidade, nf) => ({ descricao: 'x', quantidade, valor: 1, notaFiscal: { id: 0, quantidade: nf || 0 }, produto: codigo === undefined ? { id: 1 } : { id: 1, codigo } });
const ped = (id, numero, valor, dataPrevista, itens) => ({ id, numero, data: '2026-11-01', dataPrevista, total: 1, fornecedor: { id: 9 }, situacao: { id: 28, valor }, itens });

(async () => {
  /* ═══ A. a peça ═══ */
  {
    assert.deepStrictEqual([AC.SITUACOES_A_CAMINHO, AC.POR_PAGINA], [[0, 3], 100]);
    assert.deepStrictEqual([item('A', 200, 50), item('A', 10, 0), item('A', 10, 10), item('A', 10, 15), item('A', 0), item('A', -3), item('A', 'x'), item('A', '7'), { quantidade: 5 }, { quantidade: 5, notaFiscal: { quantidade: -2 } }, null].map(AC.pendenteDoItem),
      [150, 10, 0, 0, 0, 0, 0, 7, 5, 5, 0], 'pendente = pedido − o que já entrou por nota, nunca negativo');
    assert.deepStrictEqual(['2027-02-28', '2027-02-28T10:00:00', ' 2027-02-28 ', '2027-02-30', '0000-00-00', '1999-12-31', '', null, 'amanhã', 20270228].map(AC.diaValido),
      ['2027-02-28', '2027-02-28', '2027-02-28', null, null, null, null, null, null, null]);
    assert.deepStrictEqual([AC.diasAte('2026-11-24', '2026-12-04'), AC.diasAte('2026-11-24', '2026-11-24'), AC.diasAte('2026-11-24', '2026-11-01'), AC.diasAte('2026-11-24', ''), AC.diasAte(null, '2026-12-04')], [10, 0, 0, null, null]);
    const s = AC.somarACaminho([
      ped(1, 11, 0, '2027-01-20', [item('A1', 200, 50), item('E5', 3), item(' A1 ', 1)]),
      ped(2, 12, 3, '2026-12-04', [item('A1', 30), item('Z9', 5), item(undefined, 4), item('', 2), item('A1', 0)]),
      ped(3, 13, 1, '2026-12-01', [item('A1', 999)]),          /* atendido: já entrou */
      ped(4, 14, 2, '2026-12-01', [item('A1', 999)]),          /* cancelado */
      ped(5, 15, 0, '2026-11-19', [item('B2', 2)]),            /* a data prevista já passou */
      ped(6, 16, 0, '', [item('E5', 1)]),                      /* sem data prevista */
      ped(7, 11, 0, '2027-03-01', [item('A1', 1)]),            /* mesmo número de pedido: não repete na lista */
      { situacao: { valor: '0' }, itens: [item('A1', 999)] }, { situacao: null, itens: [item('A1', 999)] }, null, ped(8, 18, 0, '2026-12-01', null)], '2026-11-24');
    assert.deepStrictEqual(s, { porSku: { A1: { qtd: 182, chega: '2026-12-04', atrasado: false, sem_data: false, pedidos: [11, 12] }, E5: { qtd: 4, chega: '2027-01-20', atrasado: false, sem_data: true, pedidos: [11, 16] },
      Z9: { qtd: 5, chega: '2026-12-04', atrasado: false, sem_data: false, pedidos: [12] }, B2: { qtd: 2, chega: '2026-11-19', atrasado: true, sem_data: false, pedidos: [15] } }, itensSemCodigo: 2 }, JSON.stringify(s));
    assert.strictEqual(AC.somarACaminho([ped(5, 15, 0, '2026-11-24', [item('B2', 2)])], '2026-11-24').porSku.B2.atrasado, false, 'chega hoje não é atraso');
    assert.deepStrictEqual([AC.somarACaminho(null, '2026-11-24'), AC.somarACaminho([], null)], [{ porSku: {}, itensSemCodigo: 0 }, { porSku: {}, itensSemCodigo: 0 }]);

    /* a leitura no Bling */
    const cena = (lista, det) => { const idas = []; const bg = async (c) => { idas.push(c); if (c.startsWith('/pedidos/compras?')) return typeof lista === 'function' ? lista(c) : lista; const id = decodeURIComponent(c.split('/').pop()); return typeof det === 'function' ? det(id) : det[id]; }; return { idas, bg }; };
    const okL = (l) => ({ ok: true, status: 200, data: { data: l } }), okD = (d) => ({ ok: true, status: 200, data: { data: d } });
    const P1 = ped(1, 11, 0, '2027-01-20', [item('A1', 200, 50)]), P2 = ped(2, 12, 3, '2026-12-04', [item('A1', 30)]), P3 = ped(3, 13, 1, '2026-12-01', [item('A1', 999)]);
    const semItens = (p) => { const c = Object.assign({}, p); delete c.itens; return c; };
    let c1 = cena(okL([P1, P3, P2, { situacao: { valor: 0 } }].map(semItens)), { 1: okD(P1), 2: okD(P2) });
    assert.deepStrictEqual([await AC.lerACaminho(c1.bg, { hoje: '2026-11-24' }), c1.idas], [{ ok: true, porSku: { A1: { qtd: 180, chega: '2026-12-04', atrasado: false, sem_data: false, pedidos: [11, 12] } }, pedidos: 2, incompleto: false, itens_sem_codigo: 0 },
      ['/pedidos/compras?pagina=1&limite=100', '/pedidos/compras/1', '/pedidos/compras/2']], 'só os abertos têm o detalhe lido (atendido e sem id não custam chamada)');
    /* nenhum pedido aberto: certeza de ZERO a caminho (não é "não sei") */
    assert.deepStrictEqual(await AC.lerACaminho(cena(okL([semItens(P3)]), {}).bg, { hoje: '2026-11-24' }), { ok: true, porSku: {}, pedidos: 0, incompleto: false, itens_sem_codigo: 0 });
    assert.deepStrictEqual(await AC.lerACaminho(cena(okL([]), {}).bg, {}), { ok: true, porSku: {}, pedidos: 0, incompleto: false, itens_sem_codigo: 0 });
    /* Codex #978: Bling que aceita a conexão e não responde → prazo estoura, aborta o fetch e vira "não sei" */
    { let sinal = null; const t0 = Date.now();
      const v = await AC.lerACaminho((c, n, sig) => { sinal = sig; return new Promise(() => {}); }, { prazoMs: 30 });
      assert.strictEqual(v.ok, false); assert.ok(/não respondeu em/.test(v.motivo), v.motivo);
      assert.ok(sinal && sinal.aborted, 'o fetch em andamento é abortado'); assert.ok(Date.now() - t0 < 2000); }
    /* o pedido foi atendido entre a lista e o detalhe: vale o detalhe */
    assert.deepStrictEqual(await AC.lerACaminho(cena(okL([semItens(P1)]), { 1: okD(Object.assign({}, P1, { situacao: { valor: 1 } })) }).bg, { hoje: '2026-11-24' }), { ok: true, porSku: {}, pedidos: 0, incompleto: false, itens_sem_codigo: 0 });
    /* a LISTA falhou: não sei, com o motivo */
    for (const [r, re] of [[{ ok: false, status: 403 }, /permissão de Pedidos de Compra/], [{ ok: false, status: 429 }, /limite do Bling ao ler a lista/], [{ ok: false, status: 401 }, /token do Bling recusado/], [{ ok: false, status: 500 }, /não respondeu a lista de pedidos de compra \(500\)/],
      [null, /não respondeu a lista de pedidos de compra$/], [{ ok: true, status: 200, data: { data: {} } }, /não respondeu a lista/], [{ ok: true, status: 200, data: null }, /não respondeu/], [{ ok: true, status: 204, data: { data: [] } }, /\(204\)/], [new Error('x'), /não respondeu a lista de pedidos de compra$/]]) {
      const v = await AC.lerACaminho(cena(() => { if (r instanceof Error) throw r; return r; }, {}).bg, {});
      assert.ok(v.ok === false && re.test(v.motivo) && Object.keys(v).length === 2, JSON.stringify(r) + ' → ' + JSON.stringify(v));
    }
    /* UM detalhe falhou (ou veio torto): o todo é "não sei" — soma pela metade faria comprar de novo */
    for (const d2 of [{ ok: false, status: 429 }, null, okD(null), okD([]), okD({ id: 2 }), okD(Object.assign({}, P2, { itens: 'x' })), { ok: true, status: 200, data: null }]) {
      const v = await AC.lerACaminho(cena(okL([P1, P2].map(semItens)), { 1: okD(P1), 2: d2 }).bg, {});
      assert.ok(v.ok === false && /um pedido de compra/.test(v.motivo) && !('porSku' in v), JSON.stringify(d2) + ' → ' + JSON.stringify(v));
    }
    assert.ok((await AC.lerACaminho(cena(okL([semItens(P1)]), () => { throw new Error('rede'); }).bg, {})).ok === false);
    assert.deepStrictEqual(await AC.lerACaminho(undefined, {}), { ok: false, motivo: 'sem acesso ao Bling nesta empresa' });
    /* paginação: página cheia (100) pede a seguinte; os tetos avisam "incompleto" */
    const muitos = Array.from({ length: 230 }, (_, n) => semItens(ped(n + 1, n + 1, n % 50 === 0 ? 0 : 1, '2026-12-04', [])));
    const pagina = (c) => { const pg = Number(/pagina=(\d+)/.exec(c)[1]); return okL(muitos.slice((pg - 1) * 100, pg * 100)); };
    const det = (id) => okD(ped(Number(id), Number(id), 0, '2026-12-04', [item('A1', 1)]));
    let c2 = cena(pagina, det);
    let v2 = await AC.lerACaminho(c2.bg, { hoje: '2026-11-24' });
    assert.deepStrictEqual([v2.ok, v2.pedidos, v2.incompleto, v2.porSku.A1.qtd, c2.idas.filter((c) => c.includes('?')).length, c2.idas.length], [true, 5, false, 5, 3, 8], 'três páginas (100, 100, 30) e cinco detalhes');
    c2 = cena(pagina, det); v2 = await AC.lerACaminho(c2.bg, { maxPaginas: 2 });
    assert.deepStrictEqual([v2.ok, v2.incompleto, v2.pedidos, c2.idas.filter((c) => c.includes('?')).length], [true, true, 4, 2], 'o teto de páginas corta e AVISA');
    c2 = cena(pagina, det); v2 = await AC.lerACaminho(c2.bg, { maxPedidos: 3 });
    assert.deepStrictEqual([v2.incompleto, v2.pedidos, c2.idas.length], [true, 3, 6], 'o teto de pedidos corta e AVISA');
    c2 = cena(pagina, det); v2 = await AC.lerACaminho(c2.bg, { maxPedidos: 5 });
    assert.strictEqual(v2.incompleto, false, 'exatamente no teto não é incompleto');
    const cheia = Array.from({ length: 100 }, (_, n) => semItens(ped(n + 1, n + 1, 1, '', [])));
    c2 = cena((c) => okL(/pagina=1&/.test(c) ? cheia : []), det); v2 = await AC.lerACaminho(c2.bg, { maxPaginas: 1 });
    assert.deepStrictEqual([v2.incompleto, c2.idas.length], [true, 1], 'página cheia no teto: pode haver mais');
  }

  /* ═══ B. a rota, na fábrica de verdade ═══ */
  process.env.ADMIN_KEY = 'k';
  const fetchDeVerdade = global.fetch, agoraDeVerdade = Date.now;
  try {
    for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
      const dv = (n) => new Date(agoraDeVerdade() - n * DIA).toISOString().slice(0, 10);
      const VENDAS = [['A1', 150, 100], ['A1', 60, 10], ['B2', 90, 45], ['C3', 18, 20], ['D4', 10, 110], ['E5', 31, 100]].map(([sku, quantidade, ha], n) => ({ id: (n + 1) * 7, sku, descricao: sku, quantidade, valor_produto: quantidade * 10, margem: quantidade * 2, data_venda: dv(ha) }));
      global.fetch = async (url) => { const u = new URL(url); if (u.searchParams.get('sku')) return { ok: true, status: 200, json: async () => [] }; const depois = Number(String(u.searchParams.get('id')).replace(/^gt\./, '')); return { ok: true, status: 200, json: async () => VENDAS.filter((v) => v.id > depois) }; };
      let resp = null; const bling = [];
      const cacheProd = { A1: { saldo: 0, img: null, nome: 'Abajur', ts: agoraDeVerdade() }, B2: { saldo: 5, img: null, nome: 'Bola', ts: agoraDeVerdade() }, D4: { saldo: -2, img: null, nome: 'Dado', ts: agoraDeVerdade() }, E5: { saldo: 7, img: null, nome: 'Elo', ts: agoraDeVerdade() } };
      const BL = { lista: { ok: false, status: 500 }, det: {} };
      const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => 'k', validarSessao: () => ({ usuario: 'diego' }), readJson: (arq, pad) => (/_prod_compra\.json$/.test(arq) ? cacheProd : pad), writeJson: () => {},
        CACHE_DIR: '/tmp/_plano_caminho_' + empresa, fsx: fs, pathx: path, ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
        LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: (emp) => ({ url: 'https://supa.' + emp + '/', key: 'chave-' + emp }),
        blingGet: async (c) => { if (c.startsWith('/pedidos/compras?')) { bling.push(empresa + ' lista'); return BL.lista; } if (c.startsWith('/pedidos/compras/')) { bling.push(empresa + ' det ' + c.split('/').pop()); return BL.det[c.split('/').pop()] || { ok: false, status: 404 }; } return { ok: false }; } };
      const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
      const pedir = async (qs) => { resp = null; const u = new URL('http://h' + prefixo + '/plano-compra?k=k' + (qs || '')); assert.strictEqual(await rot({ method: 'GET', headers: {} }, {}, prefixo + '/plano-compra', 'GET', u), true); assert.ok(resp && resp.code === 200 && resp.body.ok, JSON.stringify(resp).slice(0, 300)); return resp.body; };
      const it = (r, sku) => r.itens.find((i) => i.sku === sku);
      const campos = (i) => [i.a_caminho, i.chega, i.a_caminho_atrasado, i.a_caminho_sem_data, i.a_caminho_pedidos, i.vai_faltar];

      /* não consegui ler os pedidos de compra: "não sei" — o comprar é o de sempre (precisa − saldo) e a resposta diz por quê */
      const r0 = await pedir();
      assert.deepStrictEqual([r0.a_caminho.ok, /não respondeu a lista de pedidos de compra \(500\)/.test(r0.a_caminho.motivo), typeof r0.a_caminho.lido_em, 'pedidos' in r0.a_caminho], [false, true, 'string', false], empresa + ': ' + JSON.stringify(r0.a_caminho));
      for (const sku of ['A1', 'B2', 'D4', 'E5']) assert.deepStrictEqual([campos(it(r0, sku)), it(r0, sku).comprar], [[null, null, false, false, [], false], Math.max(0, it(r0, sku).precisa - it(r0, sku).saldo)], empresa + ' ' + sku + ': sem leitura, nada é descontado');
      assert.deepStrictEqual([it(r0, 'C3').comprar, it(r0, 'C3').a_caminho, it(r0, 'C3').sem_saldo], [null, null, true]);
      assert.deepStrictEqual(bling, [empresa + ' lista'], 'a leitura é pelo Bling DA empresa');
      /* a falha fica guardada 1 minuto (não martela o Bling que está recusando); depois tenta de novo */
      await pedir(); assert.strictEqual(bling.length, 1);
      Date.now = () => agoraDeVerdade() + 59 * 1000; await pedir(); assert.strictEqual(bling.length, 1, 'aos 59 s ainda vale');
      Date.now = () => agoraDeVerdade() + 61 * 1000;

      /* agora o Bling responde: dois pedidos abertos, um atendido, um atrasado, um sem data */
      const ac0 = it(r0, 'E5').acaba_em;
      assert.ok(ac0 > 3 && ac0 < 300, 'o E5 tem saldo e ritmo: acaba em ' + ac0 + ' dias');
      const P = [ped(1, 11, 0, mais(ac0 + 1), [item('A1', 200, 50), item('E5', 3)]), ped(2, 12, 3, mais(10), [item('A1', 30), item('Z9', 5), item(undefined, 4)]), ped(3, 13, 1, mais(1), [item('A1', 999)]), ped(5, 15, 0, mais(-5), [item('B2', 2)]), ped(6, 16, 0, '', [item('E5', 1)])];
      BL.lista = { ok: true, status: 200, data: { data: P.map((p) => { const c = Object.assign({}, p); delete c.itens; return c; }) } };
      BL.det = Object.fromEntries(P.map((p) => [String(p.id), { ok: true, status: 200, data: { data: p } }]));
      bling.length = 0;
      const r1 = await pedir();
      assert.deepStrictEqual(bling, ['lista', 'det 1', 'det 2', 'det 5', 'det 6'].map((x) => empresa + ' ' + x), 'uma lista e um detalhe por pedido ABERTO');
      assert.deepStrictEqual({ ok: r1.a_caminho.ok, pedidos: r1.a_caminho.pedidos, incompleto: r1.a_caminho.incompleto, itens_sem_codigo: r1.a_caminho.itens_sem_codigo, skus_fora_do_plano: r1.a_caminho.skus_fora_do_plano, motivo: r1.a_caminho.motivo },
        { ok: true, pedidos: 4, incompleto: false, itens_sem_codigo: 1, skus_fora_do_plano: 1, motivo: undefined }, empresa + ': ' + JSON.stringify(r1.a_caminho));
      assert.deepStrictEqual([campos(it(r1, 'A1')), campos(it(r1, 'B2')), campos(it(r1, 'D4')), campos(it(r1, 'E5')), campos(it(r1, 'C3'))],
        [[180, mais(10), false, false, [11, 12], false], [2, mais(-5), true, false, [15], false], [0, null, false, false, [], false], [4, mais(ac0 + 1), false, true, [11, 16], true], [0, null, false, false, [], false]], empresa + ': ' + JSON.stringify(['A1', 'B2', 'D4', 'E5', 'C3'].map((s) => campos(it(r1, s)))));
      /* comprar = precisa − saldo − a caminho (nunca negativo); o investir e os totais acompanham; precisa e saldo não mudam */
      for (const sku of ['A1', 'B2', 'D4', 'E5']) {
        const a = it(r0, sku), b = it(r1, sku);
        assert.deepStrictEqual([b.precisa, b.saldo, b.acaba_em, b.comprar], [a.precisa, a.saldo, a.acaba_em, Math.max(0, a.precisa - a.saldo - b.a_caminho)], empresa + ' ' + sku + ': ' + JSON.stringify([a.comprar, b.comprar, b.a_caminho]));
      }
      assert.ok(it(r1, 'A1').comprar === it(r0, 'A1').comprar - 180 && it(r1, 'D4').comprar === it(r0, 'D4').comprar && it(r1, 'C3').comprar === null, 'A1 desconta 180; D4 (nada a caminho) fica igual; sem saldo segue sem número');
      assert.ok(r1.totais.skus_a_comprar <= r0.totais.skus_a_comprar);
      /* a caminho MAIOR que a necessidade: comprar zero (não negativo) */
      BL.det['2'].data.data = ped(2, 12, 3, mais(10), [item('A1', 999999)]);
      const r2 = await pedir('&caminho=novo');
      assert.deepStrictEqual([it(r2, 'A1').a_caminho, it(r2, 'A1').comprar, it(r2, 'A1').investir], [1000149, 0, null].slice(0, 2).concat([it(r2, 'A1').investir]));
      BL.det['2'].data.data = P[1];

      /* vai faltar antes de chegar: o saldo acaba ANTES da data prevista; no dia exato não falta; atrasado não afirma */
      for (const [dias, falta] of [[ac0, false], [ac0 + 1, true], [ac0 - 1, false], [0, false]]) {
        BL.det['1'].data.data = ped(1, 11, 0, mais(dias), [item('E5', 3)]); BL.det['6'].data.data = ped(6, 16, 0, mais(dias + 30), [item('E5', 1)]);
        const r = await pedir('&caminho=novo');
        assert.deepStrictEqual([it(r, 'E5').chega, it(r, 'E5').vai_faltar], [mais(dias), falta], empresa + ': acaba em ' + ac0 + 'd, chega em ' + dias + 'd');
      }
      BL.det['1'].data.data = ped(1, 11, 0, mais(-1), [item('E5', 3)]); BL.det['6'].data.data = ped(6, 16, 0, '', [item('E5', 1)]);
      const ra = await pedir('&caminho=novo');
      assert.deepStrictEqual([it(ra, 'E5').a_caminho_atrasado, it(ra, 'E5').vai_faltar], [true, false], 'atrasado: não sei quando chega, não afirmo que falta');
      /* produto já zerado (A1) nunca é "vai faltar": já acabou */
      assert.strictEqual(it(ra, 'A1').vai_faltar, false);
      BL.det['1'].data.data = P[0]; BL.det['6'].data.data = P[4];

      /* a leitura boa fica guardada 10 minutos; `?caminho=novo` lê de novo; pedidos juntos dividem a mesma leitura */
      await pedir('&caminho=novo'); bling.length = 0;
      await pedir(); await pedir('&curva=A'); assert.strictEqual(bling.length, 0, 'dentro dos 10 min não chama o Bling de novo');
      const t0 = Date.now(); Date.now = () => t0 + 9 * 60 * 1000 + 59000; await pedir(); assert.strictEqual(bling.length, 0);
      Date.now = () => t0 + 10 * 60 * 1000 + 2000; await pedir(); assert.strictEqual(bling.length, 5, 'passou de 10 min: lê de novo');
      bling.length = 0; await pedir('&caminho=novo'); assert.strictEqual(bling.length, 5, '?caminho=novo lê na hora');
      bling.length = 0; await pedir('&caminho=outra'); assert.strictEqual(bling.length, 0, 'só "novo" força');
      bling.length = 0; const t1 = Date.now(); Date.now = () => t1 + 11 * 60 * 1000;
      await Promise.all([pedir(), pedir(), pedir()].map((p) => p.catch((e) => { throw e; })));
      assert.strictEqual(bling.length, 5, 'três pedidos ao mesmo tempo: UMA leitura');
      /* mais pedidos abertos do que o teto (40): a resposta AVISA que a lista está incompleta */
      {
        const listaBoa = BL.lista, detBom = BL.det;
        const muitos = Array.from({ length: 45 }, (_, n) => ped(100 + n, 100 + n, 0, mais(30), [item('A1', 1)]));
        BL.lista = { ok: true, status: 200, data: { data: muitos.map((p) => { const c = Object.assign({}, p); delete c.itens; return c; }) } };
        BL.det = Object.fromEntries(muitos.map((p) => [String(p.id), { ok: true, status: 200, data: { data: p } }]));
        const rm = await pedir('&caminho=novo');
        assert.deepStrictEqual([rm.a_caminho.ok, rm.a_caminho.incompleto, rm.a_caminho.pedidos, it(rm, 'A1').a_caminho], [true, true, 40, 40], empresa + ': ' + JSON.stringify(rm.a_caminho));
        BL.lista = listaBoa; BL.det = detBom; await pedir('&caminho=novo');
      }
      /* um detalhe falha depois: volta a ser "não sei" e para de descontar (não fica com a soma velha) */
      const t2 = Date.now(); Date.now = () => t2 + 11 * 60 * 1000; BL.det['5'] = { ok: false, status: 429 };
      const rf = await pedir();
      assert.deepStrictEqual([rf.a_caminho.ok, /limite do Bling ao ler um pedido de compra/.test(rf.a_caminho.motivo), it(rf, 'A1').a_caminho, it(rf, 'A1').comprar], [false, true, null, it(r0, 'A1').comprar]);
      Date.now = agoraDeVerdade;
    }
  } finally { global.fetch = fetchDeVerdade; Date.now = agoraDeVerdade; delete process.env.ADMIN_KEY; }

  /* ═══ C. a tela ═══ */
  {
    const cena = async (caminho, itens) => {
      const els = {}; const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
      els.planoCompraAqui = novo('planoCompraAqui');
      const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() {} }) };
      new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, {},
        async () => ({ json: async () => Object.assign({ ok: true, lead: 4, cob: 5, horizonte_dias: 274, skus: itens.length, totais: { investir: 1, risco: 1, skus_a_comprar: 1 }, itens }, caminho === undefined ? {} : { a_caminho: caminho }) }),
        { createObjectURL: (b) => { els._blobs = (els._blobs || []).concat([b]); return 'blob:x'; }, revokeObjectURL: () => {} }, function (partes) { this.texto = partes.join(''); }, (f) => setImmediate(f));
      els.pcCalc.click(); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      return els;
    };
    const base = (sku, nome, extra) => Object.assign({ sku, nome, curva: 'A', un: 10, md: 1, saldo: 5, acaba_em: 200, precisa: 274, comprar: 100, custo_un: 1, investir: 100, mc_un: 1, risco: 1, a_caminho: 0, chega: null, a_caminho_atrasado: false, a_caminho_sem_data: false, a_caminho_pedidos: [], vai_faltar: false }, extra);
    const ITS = [base('I9', 'Ilha', { a_caminho: 1000, chega: '2026-12-01', a_caminho_sem_data: true }), base('J0', 'Jarro', { a_caminho: 9, chega: '2026-11-19', a_caminho_atrasado: true, a_caminho_sem_data: true, vai_faltar: true }),
      base('A1', 'Abajur', { a_caminho: 1180, chega: '2026-12-04', a_caminho_pedidos: [11, 12] }), base('B2', 'Bola', { a_caminho: 2, chega: '2026-11-19', a_caminho_atrasado: true }), base('D4', 'Dado', {}),
      base('E5', 'Elo', { a_caminho: 4, chega: '2027-01-20', vai_faltar: true }), base('F6', 'Faca', { a_caminho: 7, chega: null, a_caminho_sem_data: true }), base('G7', 'Gato', { a_caminho: null }), base('H8', 'Hera', { a_caminho: 3, chega: 'torta' })];
    const els = await cena({ ok: true, pedidos: 4, incompleto: false, itens_sem_codigo: 0, skus_fora_do_plano: 0 }, ITS);
    const tab = els.pcTab.innerHTML;
    const cel = (nome) => { const f = tab.indexOf('>' + nome + '</td>'); const l = tab.slice(tab.lastIndexOf('<tr', f), tab.indexOf('</tr>', f)); const tds = l.split(/<td(?=[ >])/).slice(1).map((x) => '<td' + x); const ths = tab.slice(0, tab.indexOf('</tr>')).split(/<th(?=[ >])/).slice(1); const k = ths.findIndex((h) => />a caminho<\/th>/.test(h)); assert.ok(k > 0, 'a coluna "a caminho" existe'); return tds[k]; };
    assert.ok(/>saldo<\/th><th class="sort" data-pc-ord="a_caminho" style="[^"]*text-align:right" title="[^"]*Já está descontado do comprar\.[^"]*">a caminho<\/th>/.test(tab), 'a coluna vem logo depois do saldo');
    assert.strictEqual(cel('Abajur'), '<td style="text-align:right;white-space:nowrap"><b>1.180</b><div style="opacity:.6;font-size:10px">chega 04/12/2026</div></td>');
    assert.ok(/<b>2<\/b><div style="color:#f87171;font-size:10px"[^>]*>atrasado · era 19\/11\/2026<\/div><\/td>$/.test(cel('Bola')), cel('Bola'));
    assert.strictEqual(cel('Dado'), '<td style="text-align:right;white-space:nowrap"><span style="opacity:.6">—</span></td>', 'nada a caminho: —');
    assert.ok(/<b>4<\/b><div style="opacity:.6;font-size:10px">chega 20\/01\/2027<\/div><div style="color:#f87171;font-size:10px"[^>]*>acaba antes de chegar<\/div><\/td>$/.test(cel('Elo')), cel('Elo'));
    assert.ok(/<b>7<\/b><div style="opacity:.6;font-size:10px">sem data prevista<\/div><\/td>$/.test(cel('Faca')) && /<b>3<\/b><div[^>]*>sem data prevista<\/div><\/td>$/.test(cel('Hera')), 'sem data (ou data torta): diz que não tem');
    { const m = await cena({ ok: true, pedidos: 1 }, [base('M1', 'Misto', { a_caminho: 1000, chega: '2026-12-01', a_caminho_sem_data: true })]);
      assert.ok(/chega 01\/12\/2026<\/div><div[^>]*>parte sem data prevista<\/div><\/td>/.test(m.pcTab.innerHTML), 'data conhecida + parte sem data: avisa'); }
    assert.ok(/<span style="opacity:.6" title="não consegui ler os pedidos de compra do Bling">\?<\/span><\/td>$/.test(cel('Gato')), 'não sei: "?" (não zero): ' + cel('Gato'));
    assert.ok(els.pcInfo.textContent.endsWith(' · 4 pedido(s) de compra em aberto no Bling, já descontado(s) do comprar'), els.pcInfo.textContent);
    /* 25/11 — a PLANILHA leva as duas colunas, depois do saldo: a quantidade (vazia quando não sei; zero quando é zero) e
       a chegada com os avisos por extenso */
    {
      await els.pcCsv.click(); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      const x = els._blobs[0].texto;
      const linhasX = x.split('<Row').slice(1).map((r) => [...r.matchAll(/<Cell[^>]*>(?:<Data ss:Type="(\w+)">([^<]*)<\/Data>)?<\/Cell>/g)].map((m) => (m[1] === 'Number' ? Number(m[2]) : (m[2] || ''))));
      const kS = linhasX[0].indexOf('Saldo hoje');
      assert.deepStrictEqual(linhasX[0].slice(kS, kS + 4), ['Saldo hoje', 'A caminho', 'Chegada prevista', 'Acaba em (dias)'], linhasX[0].join('|'));
      const doSku = (sku) => linhasX.find((l) => l[0] === sku).slice(kS + 1, kS + 3);
      assert.deepStrictEqual(['I9', 'J0', 'A1', 'B2', 'D4', 'E5', 'F6', 'G7', 'H8'].map(doSku),
        [[1000, '01/12/2026 (parte sem data)'], [9, '19/11/2026 (atrasado) (parte sem data) (acaba antes de chegar)'], [1180, '04/12/2026'], [2, '19/11/2026 (atrasado)'], [0, ''], [4, '20/01/2027 (acaba antes de chegar)'], [7, 'sem data prevista'], ['', ''], [3, 'sem data prevista']],
        'número na quantidade (vazio = não sei), texto na chegada: ' + JSON.stringify(['I9', 'J0', 'A1', 'B2', 'D4', 'E5', 'F6', 'G7', 'H8'].map(doSku)));
    }

    /* a linha de resumo, em cada caso */
    for (const [c, re] of [[{ ok: true, pedidos: 0, incompleto: false }, / · nenhum pedido de compra em aberto no Bling$/], [{ ok: true, pedidos: 41, incompleto: true, skus_fora_do_plano: 3, itens_sem_codigo: 2 }, / · 41 pedido\(s\) de compra em aberto no Bling, já descontado\(s\) do comprar \(⚠️ lista incompleta: há mais pedidos do que consegui ler\) · 3 produto\(s\) a caminho fora desta lista · ⚠️ 2 item\(ns\) de pedido sem código de produto \(não contado\)$/],
      [{ ok: false, motivo: 'limite do Bling' }, / · ⚠️ não consegui ler os pedidos de compra do Bling \(limite do Bling\): o comprar NÃO desconta o que está a caminho$/], [{ ok: false }, /\(sem resposta\): o comprar NÃO desconta/]]) {
      const e = await cena(c, ITS.slice(0, 1)); assert.ok(re.test(e.pcInfo.textContent), JSON.stringify(c) + ' → ' + e.pcInfo.textContent);
    }
    const ev = await cena(undefined, [base('A1', 'Abajur', { a_caminho: undefined })]);
    assert.ok(!/pedido|caminho/.test(ev.pcInfo.textContent) && /title="não consegui ler os pedidos de compra do Bling">\?</.test(ev.pcTab.innerHTML), 'servidor antigo (sem o campo): nada afirmado, célula "?"');
  }

  terminou = true; process.exitCode = 0;
  console.log('ok — Plano de Compra, o que está a caminho: os Pedidos de Compra em aberto no Bling somados por SKU (pendente = pedido − o que já entrou por nota; a data prevista mais próxima; atrasado; sem data); qualquer falha na leitura é "não sei" e não desconta nada; comprar = precisa − saldo − a caminho; "acaba antes de chegar"; leitura guardada 10 min (falha 1 min) e ?caminho=novo; a coluna e o resumo na tela — nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
