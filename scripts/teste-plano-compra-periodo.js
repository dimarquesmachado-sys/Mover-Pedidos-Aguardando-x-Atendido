'use strict';
/* 20/11 — PLANO DE COMPRA: O PERÍODO DO RITMO À ESCOLHA, E A ÚLTIMA VENDA DO PRODUTO ZERADO (pedidos do dono):
   "acho legal ter um filtro... últimos 30 dias, últimos 60 dias, últimos 90 dias, 180, ano 2026. e um período pra eu
   escolher... de tal data até tal data"; "adicionar 1 coluna no excel mostrando quando o estoque acabou... se tiver saldo
   0, mostrando estoque zerado em e aí a data".

   O que se prova (o código de produção):
   A. a peça (lib/checkout/plano-compra-periodo): que período sai de cada pedido, o que é recusado e por quê; a conta do
      ritmo (a de sempre, número por número) e a média pura do período que não termina hoje; a busca da última venda;
   B. a ROTA /plano-compra, na fábrica de verdade com banco e Bling de mentira, nas três empresas: o período pedido é o
      que vai ao banco; o padrão continua 180 dias com os mesmos números; período no passado é média pura e busca a
      última venda dos zerados (e só deles); pedido torto é recusado sem ir ao banco;
   C. a TELA (o script de produção num navegador de mentira): o seletor manda o período certo, datas pela metade não
      calculam, a tabela mostra a última venda e não inventa "0" nos 30 dias;
   D. a planilha leva a coluna nova ao lado do "Acaba em (dias)". */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PP = require('../lib/checkout/plano-compra-periodo');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

const DIA = 86400000;
const perto = (a, b) => Math.abs(a - b) < 1e-9;

(async () => {
  /* ═══ A. a peça ═══ */
  {
    const meioDia = Date.parse('2026-11-20T15:00:00Z');     /* 12h em São Paulo: o mesmo dia nos dois relógios */
    const noite = Date.parse('2026-11-21T01:30:00Z');       /* 22h30 do dia 20 em São Paulo; já dia 21 no UTC */
    assert.deepStrictEqual([PP.diaSP(meioDia), PP.diaSP(noite)], ['2026-11-20', '2026-11-20']);
    /* os últimos N dias: como sempre foi (padrão 180, de 30 a 730, datas do relógio UTC) */
    assert.deepStrictEqual(PP.periodo({}, meioDia), { ok: true, tipo: 'dias', de: '2026-05-24', ate: '2026-11-20', dias: 180, mistura: true });
    assert.deepStrictEqual(PP.periodo(undefined, meioDia).dias, 180);
    assert.deepStrictEqual([30, 60, 90, 180, 365].map((b) => { const r = PP.periodo({ base: b }, meioDia); return [r.dias, r.de, r.ate, r.mistura, r.tipo].join(' '); }),
      ['30 2026-10-21 2026-11-20 true dias', '60 2026-09-21 2026-11-20 true dias', '90 2026-08-22 2026-11-20 true dias', '180 2026-05-24 2026-11-20 true dias', '365 2025-11-20 2026-11-20 true dias']);
    assert.deepStrictEqual([0, NaN, 'x', '', null, -5, 7, 29, 731, 9999].map((b) => PP.periodo({ base: b }, meioDia).dias), [180, 180, 180, 180, 180, 30, 30, 30, 730, 730], 'fora da faixa é cortado; ausente ou inválido é o padrão');
    assert.deepStrictEqual([PP.periodo({ base: 30 }, noite).de, PP.periodo({ base: 30 }, noite).ate], ['2026-10-22', '2026-11-21']);
    /* o ano: de 1º de janeiro até hoje (o dia de São Paulo), as duas pontas contando */
    assert.deepStrictEqual(PP.periodo({ periodo: 'ano' }, meioDia), { ok: true, tipo: 'ano', de: '2026-01-01', ate: '2026-11-20', dias: 324, mistura: true });
    assert.deepStrictEqual(PP.periodo({ periodo: ' ANO ', base: 30 }, noite), { ok: true, tipo: 'ano', de: '2026-01-01', ate: '2026-11-20', dias: 324, mistura: true });
    assert.deepStrictEqual(PP.periodo({ periodo: 'ano' }, Date.parse('2027-01-10T15:00:00Z')), { ok: true, tipo: 'ano', de: '2027-01-01', ate: '2027-01-10', dias: 10, mistura: false }, 'ano que mal começou: média pura (não há 30 dias pra misturar)');
    assert.deepStrictEqual(PP.periodo({ periodo: 'mes' }, meioDia).tipo, 'dias', 'período que não conheço é o padrão de dias');
    /* as datas à escolha: as duas pontas contam; a mistura só quando termina HOJE e tem 30 dias ou mais */
    assert.deepStrictEqual(PP.periodo({ de: '2026-01-01', ate: '2026-01-31' }, meioDia), { ok: true, tipo: 'datas', de: '2026-01-01', ate: '2026-01-31', dias: 31, mistura: false });
    assert.deepStrictEqual(PP.periodo({ de: ' 2026-10-22 ', ate: '2026-11-20', periodo: 'ano', base: 60 }, meioDia), { ok: true, tipo: 'datas', de: '2026-10-22', ate: '2026-11-20', dias: 30, mistura: true }, 'as datas mandam sobre o resto');
    assert.deepStrictEqual([PP.periodo({ de: '2026-10-23', ate: '2026-11-20' }, meioDia).mistura, PP.periodo({ de: '2026-09-01', ate: '2026-11-19' }, meioDia).mistura, PP.periodo({ de: '2026-11-20', ate: '2026-11-20' }, meioDia).dias], [false, false, 1], '29 dias até hoje, ou período que acaba ontem: média pura');
    assert.deepStrictEqual(PP.periodo({ de: '2026-10-01', ate: '2026-11-20' }, noite).mistura, true, 'à noite, "hoje" ainda é o dia de São Paulo');
    assert.deepStrictEqual(PP.periodo({ de: '2024-11-21', ate: '2026-11-20' }, meioDia).dias, 730);
    for (const [q, re] of [[{ de: '2026-01-01' }, /informe as duas datas/], [{ ate: '2026-01-31' }, /informe as duas datas/], [{ de: '2026-02-31', ate: '2026-03-10' }, /data inválida/], [{ de: '01/01/2026', ate: '2026-01-31' }, /data inválida/],
      [{ de: '2026-01-01', ate: '2026-13-01' }, /data inválida/], [{ de: '2026-01-01T00:00', ate: '2026-01-31' }, /data inválida/], [{ de: '2026-02-01', ate: '2026-01-31' }, /inicial é depois da final/], [{ de: '2026-11-01', ate: '2026-11-21' }, /não pode ser depois de hoje/],
      [{ de: '2024-11-20', ate: '2026-11-20' }, /grande demais — o máximo são 730 dias/]]) {
      const r = PP.periodo(q, meioDia); assert.ok(r.ok === false && re.test(r.erro) && r.de === undefined, JSON.stringify(q) + ' → ' + JSON.stringify(r));
    }
    assert.strictEqual(PP.periodo({ de: '2026-11-01', ate: '2026-11-21' }, noite).ok, false, 'à noite, amanhã (que o UTC já chama de hoje) continua sendo depois de hoje');
    assert.deepStrictEqual(['2026-01-31', '2026-02-29', '2024-02-29', '2026-1-5', '', null, '2026-00-10', 'abc'].map((d) => PP.msDoDia(d) != null), [true, false, true, false, false, false, false, false]);

    /* o ritmo — a conta de sempre, número por número */
    const r = (un, un30, dias, hz, mistura) => PP.ritmo({ un, un30, dias, horizonteDias: hz, mistura });
    assert.ok(perto(r(180, 60, 180, 274, true), 1.25), 'subindo, horizonte longo: 25% do mês recente + 75% da média');
    assert.ok(perto(r(360, 30, 180, 274, true), 1), 'em QUEDA: nunca acima do ritmo do último mês');
    assert.deepStrictEqual([30, 31, 90, 91, 180, 181].map((hz) => Math.round(r(180, 60, 180, hz, true) * 1e6) / 1e6), [1.55, 1.4, 1.4, 1.3, 1.3, 1.25], 'o peso do mês recente cai conforme o horizonte cresce');
    assert.ok(perto(r(180, 0, 180, 274, true), 1), 'sem venda no último mês: a média do período');
    assert.ok(perto(r(60, 60, 30, 274, true), 2), '30 dias: o período É o mês recente');
    assert.ok(perto(r(62, 60, 31, 274, false), 2) && perto(r(150, 999, 31, 30, false), 150 / 31), 'sem mistura: média pura, o último mês não entra');
    assert.deepStrictEqual([r(10, 5, 0, 274, true), r(10, 5, NaN, 274, false), PP.ritmo(null), r(0, 0, 180, 274, true), r(-5, 0, 10, 0, false)], [0, 0, 0, 0, 0], 'sem dias não há ritmo; nunca negativo');

    /* a última venda de cada SKU: poucas por vez; o que falhou ou veio torto fica sem data */
    let juntas = 0, pico = 0; const pedidos = [];
    const u = await PP.ultimasVendas(['A', 'B', 'A', '', null, 'C', 'D', 'E', 'F', 'G', 'H', 'I'], async (sku) => { pedidos.push(sku); juntas++; pico = Math.max(pico, juntas); await new Promise((ok) => setTimeout(ok, 2)); juntas--;
      if (sku === 'B') throw new Error('caiu'); if (sku === 'C') return null; if (sku === 'D') return 'ontem'; if (sku === 'E') return '2026-02-31'; return sku === 'A' ? '2026-03-05T14:00:00-03:00' : '2026-01-0' + (pedidos.length % 9 + 1); }, 3);
    assert.deepStrictEqual([u.A, u.B, u.C, u.D, u.E, Object.keys(u).sort().join(''), pedidos.slice().sort().join(''), pico], ['2026-03-05', null, null, null, null, 'ABCDEFGHI', 'ABCDEFGHI', 3], 'cada SKU uma vez; falha, vazio e data que não existe ficam null');
    assert.deepStrictEqual([await PP.ultimasVendas([], async () => '2026-01-01'), await PP.ultimasVendas(null, async () => '2026-01-01')], [{}, {}]);
  }

  /* ═══ B. a rota, na fábrica de verdade ═══ */
  {
    process.env.ADMIN_KEY = 'k';
    const fetchDeVerdade = global.fetch;
    const dia = (n) => new Date(Date.now() - n * DIA).toISOString().slice(0, 10);
    try {
      for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
        const VENDAS = [{ sku: 'A1', descricao: 'Abajur', quantidade: 150, valor_produto: 1500, margem: 300, data_venda: dia(100) + 'T10:00:00' }, { sku: 'A1', descricao: 'Abajur', quantidade: 60, valor_produto: 600, margem: 120, data_venda: dia(10) },
          { sku: 'A1', descricao: 'Abajur', quantidade: 0, valor_produto: 0, margem: 0, data_venda: dia(2) },   /* linha sem unidade (estorno): não é "venda" pra data da última */
          { sku: 'B2', descricao: 'Bola', quantidade: 90, valor_produto: 900, margem: 90, data_venda: dia(45) }, { sku: 'C3', descricao: 'Cubo', quantidade: 18, valor_produto: 180, margem: 18, data_venda: dia(20) },
          { sku: 'D4', descricao: 'Dado', quantidade: 10, valor_produto: 100, margem: 10, data_venda: dia(110) }, { sku: 'E5', descricao: 'Elo', quantidade: 31, valor_produto: 310, margem: 31, data_venda: dia(100) }];
        VENDAS.forEach((v, n) => { v.id = (n + 1) * 7; });   /* a chave do banco: crescente, com buracos (linhas apagadas no passado) */
        const BANCO = { linhas: () => VENDAS, antes: null, torto: null };
        const idas = [], bling = [];
        global.fetch = async (url, op) => {
          const u = new URL(url); idas.push(u.pathname + u.search);
          assert.ok(u.origin === 'https://supa.' + empresa && op.headers.apikey === 'chave-' + empresa && u.searchParams.get('empresa') === 'eq.' + empresa, 'a consulta tem que ir ao banco DA empresa: ' + url);
          const sku = u.searchParams.get('sku');
          if (sku) {   /* a última venda de UM SKU */
            if (sku === 'eq.D4') return { ok: false, status: 500, json: async () => ({}) };
            assert.deepStrictEqual([u.searchParams.get('quantidade'), u.searchParams.get('order'), u.searchParams.get('limit'), u.searchParams.get('select')], ['gt.0', 'data_venda.desc', '1', 'data_venda']);
            const l = VENDAS.filter((v) => 'eq.' + v.sku === sku && v.quantidade > 0).sort((a, b) => (a.data_venda < b.data_venda ? 1 : -1));
            return { ok: true, status: 200, json: async () => l.slice(0, 1).map((v) => ({ data_venda: v.data_venda })) };
          }
          /* a leitura do período: por CHAVE (id > último lido, em ordem de id, 1000 por vez) — offset não existe mais */
          const [ge, le] = u.searchParams.getAll('data_venda').map((x) => x.replace(/^[a-z]+\./, ''));
          assert.ok(!u.searchParams.has('offset') && u.searchParams.get('order') === 'id.asc' && u.searchParams.get('limit') === '1000' && /^id,/.test(u.searchParams.get('select')), 'a leitura do período é por chave: ' + url);
          const depois = Number(String(u.searchParams.get('id')).replace(/^gt\./, ''));
          if (BANCO.antes) BANCO.antes(depois);
          const pg = BANCO.linhas().filter((v) => v.id > depois && v.data_venda.slice(0, 10) >= ge && v.data_venda.slice(0, 10) <= le).sort((a, b) => a.id - b.id).slice(0, 1000);
          return { ok: true, status: 200, json: async () => (BANCO.torto ? BANCO.torto(pg) : pg) };
        };
        let resp = null;
        const cacheProd = { A1: { saldo: 0, img: 'https://x/a.jpg', nome: 'Abajur', ts: Date.now() }, B2: { saldo: 5, img: null, nome: 'Bola', ts: Date.now() }, D4: { saldo: -2, img: null, nome: 'Dado', ts: Date.now() }, E5: { saldo: 7, img: null, nome: 'Elo', ts: Date.now() } };
        const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => 'k', validarSessao: () => ({ usuario: 'diego' }), readJson: (arq, pad) => (/_prod_compra\.json$/.test(arq) ? cacheProd : pad), writeJson: () => {},
          CACHE_DIR: '/tmp/_plano_periodo_' + empresa, fsx: fs, pathx: path, ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
          LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: (emp) => ({ url: 'https://supa.' + emp + '/', key: 'chave-' + emp }), blingGet: async (c) => { bling.push(c); return { ok: false }; } };
        const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
        const pedir = async (qs) => { resp = null; idas.length = 0; const u = new URL('http://h' + prefixo + '/plano-compra?k=k' + (qs || '')); const t = await rot({ method: 'GET', headers: {} }, {}, prefixo + '/plano-compra', 'GET', u); assert.strictEqual(t, true); return resp; };
        const item = (r, sku) => r.body.itens.find((i) => i.sku === sku);
        const noBanco = () => idas.map((x) => { const u = new URL('http://h' + x); return u.searchParams.get('sku') ? 'ultima ' + u.searchParams.get('sku').slice(3) : u.searchParams.getAll('data_venda').join(' '); });

        /* o padrão: 180 dias, com os números de sempre */
        const r0 = await pedir('');
        assert.deepStrictEqual([r0.code, r0.body.ok, r0.body.base, r0.body.de, r0.body.ate, r0.body.periodo, r0.body.horizonte_dias], [200, true, 180, dia(180), dia(0), { tipo: 'dias', dias: 180, mistura: true }, 274], empresa + ': ' + JSON.stringify(r0.body).slice(0, 300));
        assert.deepStrictEqual(noBanco(), ['gte.' + dia(180) + ' lte.' + dia(0)], empresa + ': uma leitura do período, e nenhuma busca de última venda (o período termina hoje)');
        assert.deepStrictEqual(r0.body.itens.map((i) => i.sku).sort(), ['A1', 'B2', 'C3', 'D4', 'E5']);
        assert.deepStrictEqual([item(r0, 'A1').un, item(r0, 'A1').un30, item(r0, 'A1').md, item(r0, 'A1').tendencia, item(r0, 'A1').precisa, item(r0, 'A1').comprar, item(r0, 'A1').acaba_em], [210, 60, 1.375, 100, 377, 377, 0], empresa + ': 25% de 2/dia (último mês) + 75% de 210/180: ' + JSON.stringify(item(r0, 'A1')));
        assert.deepStrictEqual([item(r0, 'B2').md, item(r0, 'B2').un30, item(r0, 'B2').un_30_60, item(r0, 'B2').tendencia, item(r0, 'D4').md], [0.5, 0, 90, -100, 0.056], empresa + ': sem venda no último mês, a média dos 180 dias');
        /* a última venda: só do ZERADO (saldo 0 ou negativo), e é a última com unidade vendida */
        assert.deepStrictEqual(['A1', 'B2', 'C3', 'D4', 'E5'].map((s) => item(r0, s).ultima_venda), [dia(10), null, null, dia(110), null], empresa + ': zerados A1 e D4 têm data; com saldo (B2, E5) e sem saldo conhecido (C3) ficam sem');
        assert.deepStrictEqual([item(r0, 'C3').sem_saldo, item(r0, 'C3').saldo, bling.length > 0], [true, null, true]);

        /* os atalhos de dias e o ano */
        for (const b of [30, 60, 90]) { const rb = await pedir('&base=' + b); assert.deepStrictEqual([rb.body.base, rb.body.de, noBanco(), rb.body.periodo], [b, dia(b), ['gte.' + dia(b) + ' lte.' + dia(0)], { tipo: 'dias', dias: b, mistura: true }], empresa + ': base ' + b); }
        const r30 = await pedir('&base=30');
        assert.deepStrictEqual([r30.body.itens.map((i) => i.sku).sort(), item(r30, 'A1').un, item(r30, 'A1').md, item(r30, 'A1').ultima_venda], [['A1', 'C3'], 60, 2, dia(10)], empresa + ': só o que vendeu nos 30 dias; o ritmo é o do mês');
        const hojeSP = PP.diaSP(Date.now()), ra = await pedir('&periodo=ano');
        assert.deepStrictEqual([ra.code, ra.body.de, ra.body.ate, ra.body.periodo.tipo, ra.body.base, noBanco()[0]], [200, hojeSP.slice(0, 4) + '-01-01', hojeSP, 'ano', ra.body.periodo.dias, 'gte.' + hojeSP.slice(0, 4) + '-01-01 lte.' + hojeSP], empresa + ': o ano');

        /* datas à escolha, no PASSADO: média pura do período; "30 dias" e tendência sem valor; busca a última venda dos zerados */
        const rp = await pedir('&de=' + dia(120) + '&ate=' + dia(90));
        assert.deepStrictEqual([rp.code, rp.body.de, rp.body.ate, rp.body.base, rp.body.periodo], [200, dia(120), dia(90), 31, { tipo: 'datas', dias: 31, mistura: false }], empresa + ': ' + JSON.stringify(rp.body).slice(0, 200));
        assert.deepStrictEqual(rp.body.itens.map((i) => i.sku).sort(), ['A1', 'D4', 'E5']);
        assert.deepStrictEqual([item(rp, 'A1').un, item(rp, 'A1').md, item(rp, 'A1').un30, item(rp, 'A1').un_30_60, item(rp, 'A1').tendencia, item(rp, 'E5').md], [150, 4.839, null, null, null, 1], empresa + ': 150 em 31 dias, sem o peso do último mês: ' + JSON.stringify(item(rp, 'A1')));
        assert.deepStrictEqual(noBanco().slice(0, 1).concat(noBanco().slice(1).sort()), ['gte.' + dia(120) + ' lte.' + dia(90), 'ultima A1', 'ultima D4'], empresa + ': pergunta a última venda só dos zerados (o E5 tem saldo)');
        assert.deepStrictEqual([item(rp, 'A1').ultima_venda, item(rp, 'D4').ultima_venda, item(rp, 'E5').ultima_venda], [dia(10), null, null], empresa + ': a última venda é a de DEPOIS do período (não a última dentro dele); a que o banco não respondeu fica sem data');
        /* período que pega os últimos dias mas termina ONTEM: continua média pura — o "último mês" não entra na conta */
        const ro = await pedir('&de=' + PP.diaSP(Date.now() - 40 * DIA) + '&ate=' + PP.diaSP(Date.now() - DIA));
        assert.deepStrictEqual([ro.body.periodo, item(ro, 'A1').un, item(ro, 'A1').md, item(ro, 'A1').un30], [{ tipo: 'datas', dias: 40, mistura: false }, 60, 1.5, null], empresa + ': 60 un. em 40 dias = 1,5/dia, sem puxar pro ritmo do mês: ' + JSON.stringify(item(ro, 'A1')));
        /* datas à escolha terminando HOJE (30 dias ou mais): a conta de sempre, sem busca extra */
        const rh = await pedir('&de=' + PP.diaSP(Date.now() - 59 * DIA) + '&ate=' + hojeSP);
        assert.deepStrictEqual([rh.body.periodo, noBanco().length, item(rh, 'A1').un30, item(rh, 'A1').md], [{ tipo: 'datas', dias: 60, mistura: true }, 1, 60, 1.25], empresa + ': 60 un. em 60 dias (1/dia) com o último mês a 2/dia: 25% de 2 + 75% de 1: ' + JSON.stringify(item(rh, 'A1')));

        /* ── a leitura por CHAVE (21/11): muitas páginas, linha apagada no meio da leitura, resposta sem a chave, o teto ── */
        {
          const MUITAS = []; for (let n = 0; n < 2500; n++) MUITAS.push({ id: 1000 + n * 3, sku: 'M' + (n % 5), descricao: 'Muitas', quantidade: 1, valor_produto: 10, margem: 1, data_venda: dia(n % 50 + 1) });
          BANCO.linhas = () => MUITAS;
          /* no meio da leitura (antes da 2ª página) o backfill apaga 40 linhas JÁ LIDAS: por offset, a leitura pularia 40
             vendas ainda não lidas; por chave, não pula nenhuma */
          let pg = 0; BANCO.antes = () => { if (++pg === 2) MUITAS.splice(0, 40); };
          const rm = await pedir('&base=60');
          const totalUn = rm.body.itens.reduce((a, i) => a + i.un, 0);
          assert.deepStrictEqual([rm.code, totalUn, noBanco().filter((x) => !/^ultima/.test(x)).length], [200, 2500, 3], empresa + ': 2.500 vendas em 3 páginas, nenhuma pulada mesmo com linhas apagadas no meio da leitura');
          assert.deepStrictEqual(idas.map((x) => new URL('http://h' + x).searchParams.get('id')), ['gt.0', 'gt.3997', 'gt.6997'], empresa + ': cada página começa depois do maior id da anterior');
          BANCO.antes = null;
          /* a chave tem que andar: sem id, id repetido ou fora de ordem é erro (não laço infinito, não leitura pela metade) */
          for (const estraga of [(l) => l.map((x, n) => (n === 5 ? Object.assign({}, x, { id: undefined }) : x)), (l) => l.map((x, n) => (n === 5 ? Object.assign({}, x, { id: 0 }) : x)), (l) => l.map((x, n) => (n === 5 ? Object.assign({}, x, { id: 'abc' }) : x))]) {
            BANCO.torto = estraga; const rt = await pedir('&base=60');
            assert.ok(rt.code === 500 && /sem a chave em ordem/.test(rt.body.erro) && idas.length === 1, empresa + ': ' + JSON.stringify(rt.body));
          }
          BANCO.torto = (l) => (l.length ? l.concat([]) : l);   /* página que volta a mesma coisa: a 2ª pergunta já pede depois do maior id → não repete */
          assert.strictEqual((await pedir('&base=60')).body.itens.reduce((a, i) => a + i.un, 0), 2460);
          BANCO.torto = null;
          /* o teto: 300 mil linhas lidas e ainda vem página cheia → erro dizendo o limite (plano pela metade não sai) */
          const GRANDE = { length: 300001 };
          BANCO.linhas = () => ({ filter: () => ({ sort: () => ({ slice: () => { const ini = Number(String(new URL('http://h' + idas[idas.length - 1]).searchParams.get('id')).slice(3)); return Array.from({ length: ini + 1000 < GRANDE.length ? 1000 : GRANDE.length - ini }, (_, k) => ({ id: ini + k + 1, sku: 'G', quantidade: 1, valor_produto: 1, margem: 0, data_venda: dia(3) })); } }) }) });
          const rg = await pedir('&base=60');
          assert.ok(rg.code === 500 && /passou do limite de 300 mil linhas — plano incompleto; escolha um período menor/.test(rg.body.erro) && idas.length === 300, empresa + ': ' + JSON.stringify(rg.body) + ' em ' + idas.length + ' páginas');
          GRANDE.length = 300000;   /* exatamente 300 mil: a última página cheia, e o teto bate — conservador, recusa */
          assert.strictEqual((await pedir('&base=60')).code, 500);
          GRANDE.length = 3000;   /* múltiplo de mil: três páginas cheias e a quarta vazia — a vazia é o fim, não erro */
          const r3k = await pedir('&base=60');
          assert.deepStrictEqual([r3k.code, r3k.body.itens[0] && r3k.body.itens[0].un, idas.length], [200, 3000, 4], empresa + ': 3.000 linhas, a 4ª página vem vazia: ' + JSON.stringify(r3k.body).slice(0, 200));
          GRANDE.length = 299500;   /* abaixo do teto: lê tudo e sai */
          const rok = await pedir('&base=60');
          assert.deepStrictEqual([rok.code, rok.body.itens[0].un, idas.length], [200, 299500, 300], empresa + ': 299.500 linhas em 300 páginas');
          BANCO.linhas = () => VENDAS;
        }

        /* pedido torto: recusado dizendo por quê, sem ir ao banco nem ao Bling — nunca troca calado pelo padrão */
        bling.length = 0;
        for (const [qs, re] of [['&de=2026-01-01', /informe as duas datas/], ['&ate=2026-01-31', /informe as duas datas/], ['&de=2026-02-31&ate=2026-03-01', /data inválida/], ['&de=2026-02-01&ate=2026-01-01', /inicial é depois da final/],
          ['&de=' + dia(5) + '&ate=' + dia(-3), /não pode ser depois de hoje/], ['&de=2020-01-01&ate=' + dia(1), /grande demais/]]) {
          const re2 = await pedir(qs); assert.ok(re2.code === 400 && re2.body.ok === false && re.test(re2.body.erro) && !re2.body.itens, empresa + ': ' + qs + ' → ' + JSON.stringify(re2));
          assert.deepStrictEqual([idas.length, bling.length], [0, 0], empresa + ': pedido recusado não consulta nada');
        }
      }
    } finally { global.fetch = fetchDeVerdade; }
  }

  /* ═══ C. a tela ═══ */
  {
    const ITENS = [{ sku: 'A1', nome: 'Abajur', img: null, curva: 'A', un: 150, un30: null, tendencia: null, md: 4.839, saldo: 0, acaba_em: 0, ultima_venda: '2026-11-10', precisa: 1326, comprar: 1326, custo_un: 2, investir: 2652, mc_un: 1, risco: 9 },
      { sku: 'E5', nome: 'Elo', img: null, curva: 'B', un: 31, un30: 0, tendencia: 0, md: 1, saldo: 7, acaba_em: 7, ultima_venda: null, precisa: 274, comprar: 267, custo_un: 1, investir: 267, mc_un: 1, risco: 3 }];
    const cena = async (resposta) => {
      const els = {}; const obs = { urls: [], montar: [], baixados: [] };
      const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
      els.planoCompraAqui = novo('planoCompraAqui');
      const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() { obs.baixados.push(this.download); }, href: '', download: '' }) };
      const janela = { createImageBitmap() {}, PlanilhaXlsxFotos: { baixarFotos: (ends) => Promise.resolve(ends.map(() => null)), montar: (a) => { obs.montar.push(a); return new Uint8Array(1); }, salvar: () => {} } };
      new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, janela, async (u) => { obs.urls.push(u); if (obs.segura) await new Promise((ok) => { obs.solta = ok; }); return { json: async () => resposta || { ok: true, lead: 4, cob: 5, horizonte_dias: 274, de: '2026-07-23', ate: '2026-08-22', periodo: { tipo: 'datas', dias: 31, mistura: false }, skus: 2, totais: { investir: 1, risco: 1, skus_a_comprar: 2 }, itens: ITENS } }; },
        { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, function () {}, (f) => setImmediate(f));
      return { els, obs };
    };
    const fim = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
    const c = await cena();
    /* o seletor existe, com as seis escolhas, e abre em 180 dias */
    const h = c.els.planoCompraAqui.innerHTML;
    assert.deepStrictEqual([...h.slice(h.indexOf('<select id="pcBase">'), h.indexOf('</select>', h.indexOf('<select id="pcBase">'))).matchAll(/<option value="([^"]+)"( selected)?>([^<]+)</g)].map((m) => m[1] + (m[2] ? '*' : '') + ' ' + m[3]),
      ['30 últimos 30 dias', '60 últimos 60 dias', '90 últimos 90 dias', '180* últimos 180 dias', 'ano ano ' + PP.diaSP(Date.now()).slice(0, 4), 'datas escolher datas'], 'as escolhas de período');
    assert.ok(/<span id="pcDatas" style="display:none[^>]*>de <input id="pcDe" type="date"> até <input id="pcAte" type="date"><\/span>/.test(h), 'os campos de data nascem escondidos');
    const ultima = () => c.obs.urls[c.obs.urls.length - 1];
    /* cada escolha manda o período do jeito que a rota lê */
    c.els.pcCalc.click(); await fim();
    assert.strictEqual(ultima(), '/emp/plano-compra?lead=4&cob=5&seg=0&curva=AB&base=180', 'sem escolher nada: os 180 dias de sempre');
    for (const [v, qs] of [['30', '&base=30'], ['60', '&base=60'], ['90', '&base=90'], ['180', '&base=180'], ['ano', '&periodo=ano'], ['qualquer', '&base=180'], ['', '&base=180']]) {
      c.els.pcBase.value = v; c.els.pcCalc.click(); await fim(); assert.ok(ultima().endsWith('&curva=AB' + qs), v + ' → ' + ultima());
    }
    /* mudar o período (depois do 1º cálculo) recalcula sozinho; e mostra/esconde as datas */
    let n = c.obs.urls.length;
    c.els.pcBase.value = '60'; c.els.pcBase._ev.change(); await fim();
    assert.deepStrictEqual([c.obs.urls.length, ultima().endsWith('&base=60'), c.els.pcDatas.style.display], [n + 1, true, 'none']);
    /* escolher datas: aparecem os campos; pela metade NÃO calcula (espera), completo calcula */
    n = c.obs.urls.length;
    c.els.pcBase.value = 'datas'; c.els.pcBase._ev.change(); await fim();
    assert.deepStrictEqual([c.obs.urls.length, c.els.pcDatas.style.display], [n, ''], 'escolheu "datas": mostra os campos e espera');
    c.els.pcDe.value = '2026-07-23'; c.els.pcDe._ev.change(); await fim();
    assert.ok(c.obs.urls.length === n && /<table/.test(c.els.pcTab.innerHTML) && !/escolha as duas datas/.test(c.els.pcInfo.textContent), 'com uma data só, espera: não calcula, não reclama e não apaga o plano que está na tela — ' + c.els.pcInfo.textContent);
    c.els.pcAte.value = '2026-08-22'; c.els.pcAte._ev.change(); await fim();
    assert.deepStrictEqual([c.obs.urls.length, ultima()], [n + 1, '/emp/plano-compra?lead=4&cob=5&seg=0&curva=AB&de=2026-07-23&ate=2026-08-22']);
    /* clicar em calcular com datas pela metade ou invertidas: diz o que falta, limpa o plano velho e não pede nada */
    for (const [de, ate, re] of [['', '2026-08-22', /escolha as duas datas/], ['2026-07-23', '', /escolha as duas datas/], ['2026-09-01', '2026-08-22', /inicial é depois da final/]]) {
      n = c.obs.urls.length; c.els.pcDe.value = de; c.els.pcAte.value = ate; c.els.pcCalc.click(); await fim();
      assert.ok(c.obs.urls.length === n && re.test(c.els.pcInfo.textContent) && c.els.pcTab.innerHTML === '' && c.els.pcHor.innerHTML === '' && c.els.pcCalc.disabled === false, de + '/' + ate + ' → ' + c.els.pcInfo.textContent);
      c.els.pcCsv.click(); await fim(); assert.strictEqual(c.obs.montar.length, 0, 'sem plano na tela não há planilha do plano velho');
    }
    /* a tela com a resposta de um período no passado */
    c.els.pcDe.value = '2026-07-23'; c.els.pcAte.value = '2026-08-22'; c.els.pcCalc.click(); await fim();
    assert.ok(/ritmo medido em 23\/07\/2026 → 22\/08\/2026 \(31 dias · média pura do período, sem o peso do último mês\)/.test(c.els.pcHor.innerHTML), c.els.pcHor.innerHTML);
    const tab = c.els.pcTab.innerHTML, lin = (sku) => tab.slice(tab.indexOf('>' + sku + ' '), tab.indexOf('</tr>', tab.indexOf('>' + sku + ' ')));
    assert.ok(/>0<div [^>]*title="produto zerado: data da última venda">últ\. venda 10\/11\/2026<\/div><\/td>/.test(lin('A1')), 'o zerado mostra a última venda: ' + lin('A1'));
    assert.ok(!/últ\. venda/.test(lin('E5')) && /<td style="text-align:right">7<\/td>/.test(lin('E5')), 'com saldo, sem data');
    assert.ok(/<td style="text-align:right"><span style="opacity:\.6">—<\/span><\/td><td style="text-align:right;white-space:nowrap">/.test(lin('A1')) && /<td style="text-align:right">0<\/td><td style="text-align:right;white-space:nowrap">/.test(lin('E5')), '"30d" sem valor mostra — (não 0); zero de verdade mostra 0');
    /* durante o cálculo, o período também trava */
    const c2 = await cena(); c2.obs.segura = true; c2.els.pcCalc.click(); await fim();
    assert.deepStrictEqual(['pcLead', 'pcCob', 'pcSeg', 'pcCurva', 'pcBase', 'pcDe', 'pcAte'].map((id) => c2.els[id].disabled), [true, true, true, true, true, true, true], 'os campos do período ficam editáveis durante o cálculo');
    c2.obs.solta(); await fim();
    assert.deepStrictEqual(['pcBase', 'pcDe', 'pcAte', 'pcCalc'].map((id) => c2.els[id].disabled), [false, false, false, false]);
    /* antes do 1º cálculo, mexer no período não dispara nada */
    const c3 = await cena(); c3.els.pcBase.value = '30'; c3.els.pcBase._ev.change(); await fim(); assert.strictEqual(c3.obs.urls.length, 0);
    /* resposta de período de dias (sem o campo novo, ou com mistura): o texto não fala em média pura */
    const c4 = await cena({ ok: true, lead: 4, cob: 5, horizonte_dias: 274, de: '2026-05-24', ate: '2026-11-20', periodo: { tipo: 'dias', dias: 180, mistura: true }, skus: 1, totais: {}, itens: ITENS.slice(1) }); c4.els.pcCalc.click(); await fim();
    assert.ok(/ritmo medido em 24\/05\/2026 → 20\/11\/2026 \(180 dias\)/.test(c4.els.pcHor.innerHTML) && !/média pura/.test(c4.els.pcHor.innerHTML), c4.els.pcHor.innerHTML);

    /* ═══ D. a planilha: a coluna nova ao lado do "Acaba em (dias)" ═══ */
    c.els.pcCsv.click(); await fim();
    const m = c.obs.montar[0];
    assert.deepStrictEqual(m.cab.slice(7, 12), ['Saldo hoje', 'Acaba em (dias)', 'Sem estoque desde (última venda)', 'Precisa até o próximo ciclo', 'COMPRAR']);
    assert.deepStrictEqual([m.linhas[0].slice(7, 12), m.linhas[1].slice(7, 12)], [[0, 0, '10/11/2026', 1326, 1326], [7, 7, '', 274, 267]], 'o zerado leva a data; o que tem saldo fica em branco');
    assert.deepStrictEqual([m.cab.length, m.larguras.length, m.linhas[0].length, m.larguras[9]], [16, 16, 16, 13.5]);
    assert.deepStrictEqual([m.link.map((k) => m.cab[k]), m.semaforo.map((k) => m.cab[k]), m.destaque.map((k) => m.cab[k]), m.moeda.map((k) => m.cab[k])],
      [['Imagem (URL)'], ['Saldo hoje'], ['COMPRAR'], ['Custo unitário', 'Investimento', 'Margem por unidade', 'Lucro em risco']], 'com a coluna nova no meio, cada destaque continua na coluna CERTA');
  }
  console.log('ok — Plano de Compra, período do ritmo à escolha: 30/60/90/180 dias, o ano e datas livres chegam ao banco como pedidos; o padrão segue os 180 dias com os números de sempre; período no passado é média pura; pedido torto é recusado; o produto zerado mostra a data da última venda (na tela e na planilha)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
