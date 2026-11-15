'use strict';
/* 14/11 — O DIA DA VENDA DO MERCADO LIVRE É O DE BRASÍLIA (lib/checkout/dia-venda-ml.js, ligada no motor do histórico).

   O CASO: na sexta 13/11 a AMB vendeu R$ 3.490,91 em 32 pedidos (card "Ontem"), e a base histórica — a do Mês/Ano e do chat —
   dizia R$ 3.158,22 em 30. Os 2 que faltavam eram do ML, vendidos 00:43 e 00:59, gravados na QUINTA: o relógio do ML é 1 h
   atrás de Brasília e o motor gravava o dia como o Bling/ML escrevem.

   O que se prova aqui, com o `backfillVendas` de PRODUÇÃO (o motor rodando pelo arquivo da Girassol, no contexto da GOOD) e
   só o Bling, o ML e o banco de mentira:
   A. as peças: a conversão da hora pro dia de Brasília, as janelas do ML, a tabela de decisão, a consulta da borda e o mapa.
   B. base já na regra nova: a venda da madrugada vai pro dia de Brasília; a da véspera que é do 1º dia ENTRA; a que é do
      dia seguinte fica de fora (já está lá); a venda direta do ML da 1ª hora, que antes era DESCARTADA, entra.
   C. TRANSIÇÃO (a base ainda na regra antiga em volta da janela): nada dobra e nada some.
   D. sem a lista do ML: vale o dia do Bling — e a borda continua protegida.
   E. não deu pra consultar a borda na base: ABORTA sem trocar nada (no caminho do Bling e no da venda direta).
   F. virada de mês: o imposto segue o mês do dia gravado. G. janela de um dia só. H. a trava do filtro do Bling continua.
   Os outros canais não mudam em nada: mesma data, nenhuma consulta. */
const assert = require('assert');
const fs = require('fs');
require('./_gbo-com-motor').instalar();
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'goo-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirGood, '_custos.json'), JSON.stringify({ X1: { custo: 20 } }));

/* ── o Mercado Livre de mentira: filtra pelas datas do pedido, como o de verdade ── */
const ml = { vendas: [], urls: [], falha: null };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url) => {
  const u = String(url);
  const r = (b, st) => ({ ok: !st || st < 300, status: st || 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (/api\.mercadolibre\.com\/users\/me/.test(u)) { ml.urls.push('me'); return ml.falha === 'me' ? r({ message: 'invalid token' }, 401) : r({ id: 999 }); }
  if (/api\.mercadolibre\.com\/orders\/search/.test(u)) {
    ml.urls.push(decodeURIComponent(u));
    if (ml.falha === 'search') return r({}, 500);
    const q = new URL(u).searchParams;
    const de = Date.parse(q.get('order.date_created.from')), ate = Date.parse(q.get('order.date_created.to')), off = Number(q.get('offset') || 0);
    /* venda sem data (`_sempre`) vem em toda resposta, na frente — pra provar que ela não derruba as outras */
    const todas = ml.vendas.filter((v) => v._sempre).concat(ml.vendas.filter((v) => { const t = Date.parse(v.date_created); return !v._sempre && t >= de && t <= ate; }).sort((a, b) => Date.parse(a.date_created) - Date.parse(b.date_created)));
    return r({ paging: { total: todas.length }, results: todas.slice(off, off + 50) });
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
} };
const vendaML = (oid, quando, extra) => Object.assign({ id: oid, status: 'paid', date_created: quando, total_amount: 150, order_items: [{ quantity: 1, unit_price: 150, item: { seller_sku: 'X1', title: 'produto do ML' } }] }, extra || {});

/* ── o Bling de mentira: a lista respeita dataInicial/dataFinal (menos quando o teste manda "furar o filtro") ── */
const bling = { pedidos: [], chamadas: [], furaFiltro: [] };
const blingGet = async (p) => {
  bling.chamadas.push(p);
  const m = /^\/pedidos\/vendas\?dataInicial=(\d{4}-\d{2}-\d{2})&dataFinal=(\d{4}-\d{2}-\d{2})&pagina=(\d+)/.exec(p);
  if (m) return { ok: true, status: 200, data: { data: m[3] === '1' ? bling.pedidos.filter((x) => (x.data >= m[1] && x.data <= m[2]) || bling.furaFiltro.includes(x.numero)).map((x) => ({ id: x.numero, numero: x.numero, numeroLoja: x.loja, data: x.data, situacao: { id: 9 }, loja: { id: x.lojaId } })) : [] } };
  const d = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
  if (d) { const x = bling.pedidos.find((y) => String(y.numero) === d[1]); if (!x) return { ok: false, status: 404 };
    return { ok: true, status: 200, data: { data: { id: x.numero, numero: x.numero, numeroPedidoLoja: x.loja, data: x.data, loja: { id: x.lojaId }, itens: [{ codigo: 'X1', descricao: 'p', quantidade: 1, valor: 100 }], total: 100, taxas: { taxaComissao: 10, custoFrete: 5 }, contato: { endereco: {} } } } }; }
  return { ok: true, status: 200, data: { data: [] } };
};
const ped = (numero, loja, data, canal) => ({ numero, loja, data, lojaId: canal === 'shopee' ? 702 : 701 });

/* ── o banco de mentira: responde a consulta da borda pelas linhas de `base.linhas`, e guarda o que a troca recebe ── */
const base = { linhas: [], consultas: [], gravadas: [], trocas: 0, falhaConsulta: null };
const supaReq = async (emp, met, q, body) => {
  if (met === 'GET' && /^vendas_historico\?/.test(q) && /=in\.\(/.test(q)) {
    base.consultas.push(decodeURIComponent(q));
    if (base.falhaConsulta && base.falhaConsulta(decodeURIComponent(q))) return { ok: false, status: 503, body: '' };
    const col = /&(numero_pedido|numero_loja)=in\.\(([^)]*)\)/.exec(decodeURIComponent(q));
    const de = /data_venda=gte\.(\d{4}-\d{2}-\d{2})/.exec(q)[1], ate = /data_venda=lte\.(\d{4}-\d{2}-\d{2})/.exec(q)[1];
    const lista = col[2].split(',');
    return { ok: true, status: 200, body: JSON.stringify(base.linhas.filter((l) => l.empresa === emp && l.data_venda >= de && l.data_venda <= ate && lista.includes(String(l[col[1]]))).map((l) => ({ numero_pedido: l.numero_pedido, numero_loja: l.numero_loja, data_venda: l.data_venda }))) };
  }
  if (met === 'POST' && Array.isArray(body)) { base.gravadas.push(...body); return { ok: true, status: 201, body: '[]' }; }
  /* a troca de verdade (a conferência "o banco está preparado?" chama a mesma função com p_esperadas = -1, e não troca nada) */
  if (met === 'POST' && /rpc\/trocar_periodo_historico/.test(q)) { if (body.p_esperadas >= 0) { base.trocas++; base.periodoTrocado = [body.p_de, body.p_ate]; } return { ok: true, status: 200, body: JSON.stringify({ apagadas: 0, inseridas: body.p_esperadas }) }; }
  return { ok: true, status: 200, body: '[]' };
};
const naBase = (numero_pedido, numero_loja, data_venda) => ({ empresa: 'good', numero_pedido: String(numero_pedido), numero_loja: String(numero_loja), data_venda });

const D = require('../lib/checkout/dia-venda-ml');
const rejeita = (f, re, msg) => { let e = null; try { f(); } catch (x) { e = x; } assert.ok(e && re.test(e.message), msg + ' — veio: ' + (e ? e.message : 'sem erro')); };

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    /* ═══ A. AS PEÇAS ═══ */
    {
      /* a hora real → o dia em Brasília. O ML escreve no relógio dele (-04:00): 23:43 de quinta LÁ é 00:43 de sexta AQUI */
      assert.deepStrictEqual(['2026-11-12T23:43:10.000-04:00', '2026-11-12T22:59:59.000-04:00', '2026-11-13T02:59:59Z', '2026-11-13T03:00:00Z', '2026-11-13T00:59:00.000-03:00', '2026-11-12T23:00:00.000-04:00'].map(D.diaSP),
        ['2026-11-13', '2026-11-12', '2026-11-12', '2026-11-13', '2026-11-13', '2026-11-13']);
      /* data solta, sem fuso ou ilegível: "não sei a hora real" (null) — nunca um dia chutado */
      assert.deepStrictEqual(['2026-11-12', '2026-11-12T23:43:10', '', 'lixo', null, undefined, 20261112].map(D.diaSP), [null, null, null, null, null, null, null]);
      assert.deepStrictEqual([D.diaAnterior('2026-11-01'), D.diaSeguinte('2026-12-31'), D.diaAnterior('2026-03-01')], ['2026-10-31', '2027-01-01', '2026-02-28']);
      /* as janelas de 5 dias, e só a ÚLTIMA entra 1 h no dia seguinte */
      assert.deepStrictEqual(D.janelasML('2026-11-10', '2026-11-21'), [['2026-11-10', '2026-11-14'], ['2026-11-15', '2026-11-19'], ['2026-11-20', '2026-11-21']]);
      assert.deepStrictEqual(D.janelasML('2026-11-13', '2026-11-13'), [['2026-11-13', '2026-11-13']]);
      assert.deepStrictEqual([D.fimDaJanelaML('2026-11-14', '2026-11-21'), D.fimDaJanelaML('2026-11-21', '2026-11-21')], ['2026-11-14T23:59:59.999-03:00', '2026-11-22T00:59:59.999-03:00']);

      /* A TABELA DE DECISÃO — janela 10 a 12. "Nunca crio uma segunda cópia; nunca apago a única." */
      const dec = (antigo, real, copias) => { const r = D.decidir({ antigo, real, de: '2026-11-10', ate: '2026-11-12', copias }); return r.incluir ? [r.dia, r.pelo_bling] : 'fora'; };
      /* no meio da janela não precisa consultar a base */
      assert.deepStrictEqual(dec('2026-11-11', '2026-11-11'), ['2026-11-11', false]);
      assert.deepStrictEqual(dec('2026-11-10', '2026-11-11'), ['2026-11-11', false], 'venda da madrugada: vai pro dia de Brasília');
      assert.deepStrictEqual(dec('2026-11-11', null), ['2026-11-11', true], 'sem a hora real: o dia do Bling');
      assert.deepStrictEqual(D.decidir({ antigo: '', real: null, de: '2026-11-10', ate: '2026-11-12' }), { incluir: true, dia: null, pelo_bling: true }, 'pedido sem data na lista: como sempre foi');
      /* começo da janela: o Bling diz 09, Brasília diz 10 */
      assert.deepStrictEqual(dec('2026-11-09', '2026-11-10', []), ['2026-11-10', false], 'a base não tem: é minha, no dia de Brasília');
      assert.deepStrictEqual(dec('2026-11-09', '2026-11-10', ['2026-11-10']), ['2026-11-10', false], 'a base já tem no dia certo (dentro): regravo lá');
      assert.strictEqual(dec('2026-11-09', '2026-11-10', ['2026-11-09']), 'fora', 'a base tem a cópia ANTIGA na véspera, que eu não reescrevo: gravar aqui DOBRARIA');
      assert.strictEqual(dec('2026-11-09', '2026-11-10', ['2026-11-09', '2026-11-10']), 'fora', 'já dobrada: a de dentro some na troca, a de fora fica — volta a ser uma');
      /* véspera de verdade (não sei a hora, ou é da véspera mesmo) */
      assert.strictEqual(dec('2026-11-09', null, ['2026-11-09']), 'fora');
      assert.strictEqual(dec('2026-11-09', null, []), 'fora', 'não é desta janela');
      assert.deepStrictEqual(dec('2026-11-09', null, ['2026-11-10']), ['2026-11-10', false], 'sem a hora real, mas a base a tinha AQUI dentro: a troca apagaria a única cópia — regravo onde estava');
      /* fim da janela: o Bling diz 12, Brasília diz 13 */
      assert.strictEqual(dec('2026-11-12', '2026-11-13', ['2026-11-13']), 'fora', 'já está no dia seguinte: gravar aqui DOBRARIA');
      assert.deepStrictEqual(dec('2026-11-12', '2026-11-13', ['2026-11-12']), ['2026-11-12', false], 'só existe a cópia antiga, que a troca apaga: fica no dia antigo pra não SUMIR');
      assert.deepStrictEqual(dec('2026-11-12', '2026-11-13', []), ['2026-11-12', false]);
      assert.deepStrictEqual(dec('2026-11-12', '2026-11-12', ['2026-11-12']), ['2026-11-12', false]);
      assert.strictEqual(dec('2026-11-12', null, ['2026-11-13']), 'fora', 'sem a hora real e a base a tem no dia seguinte: não dobro');
      assert.deepStrictEqual(dec('2026-11-12', null, []), ['2026-11-12', true]);
      /* na borda SEM a consulta à base: recusa decidir (é o que dobraria ou sumiria com a venda) */
      for (const [a, r] of [['2026-11-09', '2026-11-10'], ['2026-11-12', '2026-11-12'], ['2026-11-12', '2026-11-13'], ['2026-11-09', null], ['2026-11-12', null]])
        rejeita(() => dec(a, r, undefined), /na borda da janela sem a consulta à base/, 'borda sem consulta: ' + a + ' / ' + r);
      assert.deepStrictEqual([['2026-11-11', '2026-11-11'], ['2026-11-10', '2026-11-11'], ['2026-11-09', '2026-11-10'], ['2026-11-12', '2026-11-12'], ['2026-11-11', '2026-11-13'], ['', '2026-11-11'], ['', null]].map(([a, r]) => D.naBorda({ antigo: a, real: r }, '2026-11-10', '2026-11-12')),
        [false, false, true, true, true, false, false]);
      /* janela de um dia só */
      const um = (antigo, real, copias) => { const r = D.decidir({ antigo, real, de: '2026-11-11', ate: '2026-11-11', copias }); return r.incluir ? r.dia : 'fora'; };
      assert.deepStrictEqual([um('2026-11-10', '2026-11-11', ['2026-11-11']), um('2026-11-10', '2026-11-11', ['2026-11-10']), um('2026-11-11', '2026-11-12', ['2026-11-12']), um('2026-11-11', '2026-11-12', ['2026-11-11']), um('2026-11-11', '2026-11-11', [])],
        ['2026-11-11', 'fora', 'fora', '2026-11-11', '2026-11-11']);

      /* A CONSULTA DA BORDA: só quem encosta na borda vai ao banco; casa por nº do pedido OU da venda/carrinho */
      base.linhas = [naBase('103', '2000000000000103', '2026-11-10'), naBase('ML-2000000000000902', '2000000000009902', '2026-11-13'), naBase('777', '2000000000000777', '2026-11-11'), Object.assign(naBase('103', '2000000000000103', '2026-11-09'), { empresa: 'outra' })];
      base.consultas.length = 0;
      const vs = [{ antigo: '2026-11-09', real: '2026-11-10', numero: '103', lojas: ['2000000000000103'] }, { antigo: '2026-11-11', real: '2026-11-11', numero: '777', lojas: ['2000000000000777'] },
        { antigo: '2026-11-12', real: '2026-11-13', numero: '555', lojas: ['2000000000000902', '2000000000009902', null, ''] }, { antigo: '2026-11-12', real: '2026-11-12', numero: 'tem,vírgula', lojas: ['a(b)'] }];
      const c = await D.copiasNaBase({ supaReq, empresa: 'good', de: '2026-11-10', ate: '2026-11-12', vendas: vs });
      assert.deepStrictEqual([c.ok, c.consultadas, c.de(vs[0]), c.de(vs[1]), c.de(vs[2]), c.de(vs[3])], [true, 3, ['2026-11-10'], undefined, ['2026-11-13'], []], 'a do meio da janela não é consultada; a de outra empresa não conta; chave estranha não vai pra consulta');
      assert.deepStrictEqual(base.consultas, [
        'vendas_historico?empresa=eq.good&data_venda=gte.2026-11-09&data_venda=lte.2026-11-13&numero_pedido=in.(103,555)&select=numero_pedido,numero_loja,data_venda&limit=5000',
        'vendas_historico?empresa=eq.good&data_venda=gte.2026-11-09&data_venda=lte.2026-11-13&numero_loja=in.(2000000000000103,2000000000000902,2000000000009902)&select=numero_pedido,numero_loja,data_venda&limit=5000']);
      /* Codex (P2): pedidos DIRETOS irmãos no mesmo carrinho — a linha do irmão não é cópia desta */
      base.linhas = [naBase('ML-2000000000000010', '2000000000007000', '2026-11-10'), naBase('ML-2000000000000011', '2000000000007000', '2026-11-11'), naBase('999', '2000000000007000', '2026-11-11')];
      const irm = { antigo: '2026-11-10', real: '2026-11-10', numero: 'ML-2000000000000010', lojas: ['2000000000000010', '2000000000007000'] };
      const cirm = await D.copiasNaBase({ supaReq, empresa: 'good', de: '2026-11-10', ate: '2026-11-10', vendas: [irm] });
      assert.deepStrictEqual(cirm.de(irm), ['2026-11-10', '2026-11-11'], 'própria linha + linha de Bling do carrinho; a do irmão ML-…011 não conta');
      assert.deepStrictEqual(D.decidir({ antigo: '2026-11-10', real: '2026-11-10', de: '2026-11-10', ate: '2026-11-10', copias: cirm.de(irm) }).incluir, false, 'a linha de Bling do carrinho em 11/11 (fora da janela) segue valendo');
      base.linhas = [naBase('ML-2000000000000010', '2000000000007000', '2026-11-10'), naBase('ML-2000000000000011', '2000000000007000', '2026-11-11')];
      const cirm2 = await D.copiasNaBase({ supaReq, empresa: 'good', de: '2026-11-10', ate: '2026-11-10', vendas: [irm] });
      assert.deepStrictEqual(cirm2.de(irm), ['2026-11-10'], 'irmão direto em 11/11 não é cópia: a venda continua incluída');
      assert.strictEqual(D.decidir({ antigo: '2026-11-10', real: '2026-11-10', de: '2026-11-10', ate: '2026-11-10', copias: cirm2.de(irm) }).incluir, true);
      base.consultas.length = 0;
      assert.deepStrictEqual([(await D.copiasNaBase({ supaReq, empresa: 'good', de: '2026-11-10', ate: '2026-11-12', vendas: [vs[1]] })).ok, base.consultas.length], [true, 0], 'ninguém na borda: nenhuma ida ao banco');
      /* o banco falhou / devolveu lixo: diz que NÃO SABE (quem chama aborta) */
      const ruim = async (resp) => D.copiasNaBase({ supaReq: async () => resp, empresa: 'good', de: '2026-11-10', ate: '2026-11-12', vendas: [vs[0]] });
      assert.deepStrictEqual([(await ruim({ ok: false, status: 503 })).ok, (await ruim({ ok: true, body: '{' })).ok, (await ruim({ ok: true, body: '{}' })).ok, (await ruim(null)).ok, (await ruim({ ok: true, body: JSON.stringify(new Array(5000).fill({ numero_pedido: '103', data_venda: '2026-11-10' })) })).ok],
        [false, false, false, false, false]);
      assert.ok(/503/.test((await ruim({ ok: false, status: 503 })).erro));
      assert.strictEqual((await D.copiasNaBase({ supaReq: async () => { throw new Error('rede caiu'); }, empresa: 'good', de: '2026-11-10', ate: '2026-11-12', vendas: [vs[0]] })).ok, false);
      /* mais de 60 chaves: em lotes */
      base.consultas.length = 0;
      await D.copiasNaBase({ supaReq, empresa: 'good', de: '2026-11-10', ate: '2026-11-12', vendas: Array.from({ length: 130 }, (_, i) => ({ antigo: '2026-11-12', real: null, numero: String(9000 + i), lojas: [] })) });
      assert.deepStrictEqual(base.consultas.map((q) => /in\.\(([^)]*)\)/.exec(q)[1].split(',').length), [60, 60, 10]);

      /* O MAPA: pergunta de 5 em 5 dias, a última até 00:59 do dia seguinte; guarda o dia de Brasília por venda e por carrinho */
      ml.vendas = [vendaML(2000000000000001, '2026-11-09T23:40:00.000-04:00'), vendaML(2000000000000002, '2026-11-12T23:50:00.000-04:00', { pack_id: 2000000000007002 }), vendaML(2000000000000003, '2026-11-12T23:50:30.000-04:00', { pack_id: 2000000000007002 }),
        vendaML(2000000000000004, '2026-11-13T00:10:00.000-04:00'), vendaML(2000000000000005, '2026-11-09T22:59:00.000-04:00')];
      ml.urls.length = 0; ml.falha = null;
      const semDormir = async () => {};
      const mp = await D.mapaDosDias({ fetch: require('node-fetch'), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.deepStrictEqual([mp.lidas, mp.completo, mp.motivo, mp.diaDe('2000000000000001'), mp.diaDe(2000000000000002), mp.diaDe('2000000000007002'), mp.diaDe('2000000000000004'), mp.diaDe('2000000000000005'), mp.diaDe(''), mp.diaDe(null)],
        [3, true, null, '2026-11-10', '2026-11-13', '2026-11-13', null, null, null, null], 'a venda de 01:10 do dia seguinte e a de 23:59 da véspera ficam fora do mapa');
      assert.deepStrictEqual([mp.idsDe('2000000000000002').slice().sort(), mp.idsDe('2000000000007002').slice().sort(), mp.idsDe('nada')], [['2000000000000002', '2000000000007002'], ['2000000000000002', '2000000000000003', '2000000000007002'], []]);
      assert.ok(ml.urls.length === 2 && /order\.date_created\.from=2026-11-10T00:00:00\.000-03:00&order\.date_created\.to=2026-11-13T00:59:59\.999-03:00/.test(ml.urls[1]), ml.urls.join(' | '));
      /* carrinho com duas vendas que atravessam a meia-noite (23:59:50 e 00:00:10): o carrinho vale pelo PRIMEIRO instante — é
         quando a compra aconteceu; cada venda guarda o próprio dia */
      ml.vendas = [vendaML(2000000000000011, '2026-11-11T02:59:50Z', { pack_id: 2000000000007011 }), vendaML(2000000000000012, '2026-11-11T03:00:10Z', { pack_id: 2000000000007011 })];
      const mc = await D.mapaDosDias({ fetch: require('node-fetch'), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.deepStrictEqual([mc.diaDe('2000000000007011'), mc.diaDe('2000000000000011'), mc.diaDe('2000000000000012')], ['2026-11-10', '2026-11-10', '2026-11-11']);
      /* e na ordem contrária (a mais nova chega primeiro) dá o mesmo */
      ml.vendas = [vendaML(2000000000000012, '2026-11-11T03:00:10Z', { pack_id: 2000000000007011 })];
      const mc2 = await D.mapaDosDias({ fetch: async (u) => ({ ok: true, status: 200, json: async () => (/users\/me/.test(u) ? { id: 1 } : { paging: { total: 2 }, results: [vendaML(2000000000000012, '2026-11-11T03:00:10Z', { pack_id: 2000000000007011 }), vendaML(2000000000000011, '2026-11-11T02:59:50Z', { pack_id: 2000000000007011 })] }) }), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.strictEqual(mc2.diaDe('2000000000007011'), '2026-11-10');
      /* sem token, conta sem resposta, lista com erro: NÃO lança — diz que está incompleto e por quê (o motor segue pelo dia do Bling) */
      const m0 = await D.mapaDosDias({ fetch: require('node-fetch'), token: null, de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.deepStrictEqual([m0.lidas, m0.completo, /sem token/.test(m0.motivo), m0.diaDe('2000000000000001')], [0, false, true, null]);
      ml.falha = 'me';
      const m1 = await D.mapaDosDias({ fetch: require('node-fetch'), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.ok(m1.completo === false && /de quem é a conta \(HTTP 401\)/.test(m1.motivo), m1.motivo);
      ml.falha = 'search';
      const m2 = await D.mapaDosDias({ fetch: require('node-fetch'), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.ok(m2.completo === false && /respondeu HTTP 500 \(de 2026-11-10 a 2026-11-12\)/.test(m2.motivo), m2.motivo);
      const m3 = await D.mapaDosDias({ fetch: async () => { throw new Error('ECONNRESET'); }, token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.ok(m3.completo === false && /ECONNRESET/.test(m3.motivo));
      /* paginação (50 por vez) e o teto de 1.000 por janela */
      ml.falha = null; ml.urls.length = 0;
      ml.vendas = Array.from({ length: 120 }, (_, i) => vendaML(3000000000000000 + i, '2026-11-11T12:' + String(i % 60).padStart(2, '0') + ':00.000-03:00'));
      const m4 = await D.mapaDosDias({ fetch: require('node-fetch'), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.deepStrictEqual([m4.lidas, m4.completo, ml.urls.filter((u) => u !== 'me').map((u) => /offset=(\d+)/.exec(u)[1])], [120, true, ['0', '50', '100']]);
      const cheia = await D.mapaDosDias({ fetch: async (u) => ({ ok: true, status: 200, json: async () => (/users\/me/.test(u) ? { id: 1 } : { paging: { total: 1500 }, results: [] }) }), token: 'tk', de: '2026-11-10', ate: '2026-11-12', dorme: semDormir });
      assert.ok(cheia.completo === false && /passou de 1\.000 vendas/.test(cheia.motivo));
    }

    /* ═══ B–H. O MOTOR DE PRODUÇÃO ═══ */
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const escrowPedidos = [];
    const ctx = { blingGet, readJson, CACHE_DIR: dirGood, supaReq, supaCount: async () => null, DEFAULT_ALIQ_BK: { '2026-10': 8, '2026-11': 10 }, aliqReserva: 14.1,
      custoVigenteEm: () => 20, garantirTokenML: async () => 'tk-good', LOJA_MKT: { '701': 'ml', '702': 'shopee' }, mapasBilling: null,
      escrowEmLote: async (sns) => { escrowPedidos.push(...sns); return {}; }, escrowDoPedido: null, magaluFreteSkuLer: () => ({}) };
    const rodar = async (de, ate, c2) => {
      base.gravadas.length = 0; base.consultas.length = 0; base.trocas = 0; bling.chamadas.length = 0; ml.urls.length = 0; escrowPedidos.length = 0;
      const r = await gbo.backfillVendas(de, ate, 'good', c2 || ctx);
      const dias = {}; for (const l of base.gravadas) dias[l.numero_pedido] = l.data_venda;
      return { r, dias, detalhes: bling.chamadas.filter((p) => /^\/pedidos\/vendas\/\d+$/.test(p)).map((p) => p.split('/').pop()).sort() };
    };
    /* os pedidos — janela de 10 a 12/11 */
    const L = (n) => '20000000000' + String(n).padStart(5, '0');   /* nº da venda no ML (começa com 200) */
    bling.pedidos = [
      ped(101, L(101), '2026-11-11', 'ml'),      /* venda do meio do dia */
      ped(102, L(102), '2026-11-11', 'ml'),      /* 00:30 de 12/11 em Brasília — o Bling diz 11 */
      ped(103, L(103), '2026-11-09', 'ml'),      /* 00:40 de 10/11 em Brasília — o Bling diz 09 (a véspera da janela) */
      ped(104, L(104), '2026-11-09', 'ml'),      /* da véspera de verdade (15:00 de 09/11) */
      ped(105, 'SHP1ABCDEF1234', '2026-11-09', 'shopee'),
      ped(106, 'SHP2ABCDEF1234', '2026-11-12', 'shopee'),
      ped(107, L(107), '2026-11-12', 'ml'),      /* 00:50 de 13/11 em Brasília — o Bling diz 12 (o último dia) */
      ped(108, L(108), '2026-11-12', 'ml'),      /* 10:00 de 12/11 */
    ];
    const vendasDoPeriodo = () => [
      vendaML(L(101), '2026-11-11T14:00:00.000-03:00'), vendaML(L(102), '2026-11-11T23:30:00.000-04:00'), vendaML(L(103), '2026-11-09T23:40:00.000-04:00'), vendaML(L(104), '2026-11-09T14:00:00.000-04:00'),
      vendaML(L(107), '2026-11-12T23:50:00.000-04:00'), vendaML(L(108), '2026-11-12T09:00:00.000-04:00'),
      /* só no ML (o Bling não tem): */
      vendaML(L(901), '2026-11-09T23:10:00.000-04:00'),                          /* 00:10 de 10/11 em Brasília — antes era DESCARTADA */
      vendaML(L(902), '2026-11-12T23:20:00.000-04:00', { pack_id: L(9902) }),    /* 00:20 de 13/11 */
      vendaML(L(903), '2026-11-11T12:00:00.000-03:00'),
      vendaML(L(904), '2026-11-11T13:00:00.000-03:00', { pack_id: L(101) }),      /* o carrinho já veio pelo Bling: não entra de novo */
      vendaML(L(905), '2026-11-11T13:30:00.000-03:00', { status: 'cancelled' }),
      vendaML(L(906), null, { _sempre: true }),                                   /* sem data nenhuma: fica de fora (como sempre) e NÃO derruba as seguintes */
    ];

    /* ── B. a base JÁ na regra nova em volta da janela ── */
    ml.vendas = vendasDoPeriodo(); ml.falha = null;
    base.linhas = [naBase('103', L(103), '2026-11-10'), naBase('104', L(104), '2026-11-09'), naBase('107', L(107), '2026-11-13'), naBase('108', L(108), '2026-11-12'), naBase('ML-' + L(902), L(9902), '2026-11-13')];
    let x = await rodar('2026-11-10', '2026-11-12');
    assert.ok(x.r && x.r.ok && x.r.desfecho === 'ok' && base.trocas === 1, 'a rodada não fechou: ' + JSON.stringify({ d: x.r && x.r.desfecho, m: x.r && x.r.msg, ml: x.r && x.r.msg_ml, trocas: base.trocas }));
    assert.deepStrictEqual(base.periodoTrocado, ['2026-11-10', '2026-11-12'], 'o período trocado na base é o pedido — a véspera entra só na LISTA do Bling');
    assert.ok(base.gravadas.every((l) => l.data_venda >= '2026-11-10' && l.data_venda <= '2026-11-12'), 'toda linha gravada tem o dia DENTRO do período trocado (linha de fora ficaria dobrada na rodada seguinte)');
    assert.deepStrictEqual(x.dias, { 101: '2026-11-11', 102: '2026-11-12', 103: '2026-11-10', 106: '2026-11-12', 108: '2026-11-12', ['ML-' + L(901)]: '2026-11-10', ['ML-' + L(903)]: '2026-11-11' },
      'a da madrugada no dia de Brasília; a da véspera que é do 1º dia ENTRA; a do dia seguinte (107, ML-902) fica de fora; a direta da 1ª hora entra');
    assert.deepStrictEqual(x.detalhes, ['101', '102', '103', '106', '108'], 'quem fica de fora não gasta chamada de detalhe no Bling');
    assert.deepStrictEqual(bling.chamadas.filter((p) => /^\/pedidos\/vendas\?/.test(p)), ['/pedidos/vendas?dataInicial=2026-11-09&dataFinal=2026-11-12&pagina=1&limite=100'], 'a lista do Bling começa na véspera');
    assert.deepStrictEqual(escrowPedidos, ['SHP2ABCDEF1234'], 'o repasse da Shopee não é pedido pra véspera (ela só está na lista por causa do ML)');
    assert.deepStrictEqual([x.r.dia_ml.vendas_lidas_no_ml, x.r.dia_ml.lista_completa, x.r.dia_ml.mudaram_de_dia, x.r.dia_ml.ficaram_onde_estavam, x.r.dia_ml.sem_lista_porque, x.r.fora, x.r.msg_ml], [10, true, 2, 1, undefined, 0, undefined], 'a venda sem data não entra na conta nem derruba a parte do ML');
    assert.deepStrictEqual(x.r.do_marketplace && [x.r.do_marketplace.vendas, x.r.do_marketplace.linhas], [2, 2]);
    /* as duas idas ao ML (o mapa e as vendas diretas) pedem até 00:59 do dia seguinte */
    { const buscas = ml.urls.filter((u) => u !== 'me'); assert.ok(buscas.length === 2 && buscas.every((u) => /order\.date_created\.from=2026-11-10T00:00:00\.000-03:00&order\.date_created\.to=2026-11-13T00:59:59\.999-03:00/.test(u)), buscas.join(' | ')); }
    /* a consulta da borda: só venda do ML, só a véspera e o último dia — nunca a Shopee, nunca o meio da janela */
    { const tudo = base.consultas.join(' ');
      assert.ok(base.consultas.length === 4 && base.consultas.every((q) => /data_venda=gte\.2026-11-09&data_venda=lte\.2026-11-13/.test(q)), base.consultas.join(' | '));
      assert.ok(/numero_pedido=in\.\(103,104,107,108\)/.test(tudo) && !/SHP|\b10[1256]\b/.test(tudo.replace(/2000\d+/g, '')), tudo);
      assert.ok(new RegExp('numero_pedido=in\\.\\(ML-' + L(901) + ',ML-' + L(902) + '\\)').test(tudo) && new RegExp('numero_loja=in\\.\\(' + L(901) + ',' + L(902) + ',' + L(9902) + '\\)').test(tudo), tudo); }

    /* ── C. TRANSIÇÃO: em volta da janela a base ainda está na regra ANTIGA ── */
    base.linhas = [naBase('103', L(103), '2026-11-09'), naBase('104', L(104), '2026-11-09'), naBase('107', L(107), '2026-11-12'), naBase('102', L(102), '2026-11-11'), naBase('ML-' + L(901), L(901), '2026-11-09')];
    x = await rodar('2026-11-10', '2026-11-12');
    assert.ok(x.r.ok && base.trocas === 1);
    assert.deepStrictEqual(x.dias, { 101: '2026-11-11', 102: '2026-11-12', 106: '2026-11-12', 107: '2026-11-12', 108: '2026-11-12', ['ML-' + L(902)]: '2026-11-12', ['ML-' + L(903)]: '2026-11-11' },
      '103 e ML-901 têm a cópia antiga na véspera (fora da troca): NÃO regravo — dobraria; 107 e ML-902 só têm a cópia que a troca apaga: ficam no dia antigo — sumiriam');
    assert.deepStrictEqual(x.detalhes, ['101', '102', '106', '107', '108']);
    assert.deepStrictEqual([x.r.dia_ml.mudaram_de_dia, x.r.dia_ml.ficaram_onde_estavam], [1, 1]);

    /* ── D. SEM A LISTA DO ML (a conta não respondeu): vale o dia do Bling, e a borda continua protegida ── */
    ml.falha = 'me';
    base.linhas = [naBase('102', L(102), '2026-11-12'), naBase('103', L(103), '2026-11-10'), naBase('104', L(104), '2026-11-09'), naBase('107', L(107), '2026-11-13'), naBase('108', L(108), '2026-11-12')];
    x = await rodar('2026-11-10', '2026-11-12');
    assert.ok(x.r.ok && x.r.desfecho === 'ok' && base.trocas === 1, JSON.stringify({ d: x.r.desfecho, m: x.r.msg }));
    assert.deepStrictEqual(x.dias, { 101: '2026-11-11', 102: '2026-11-11', 103: '2026-11-10', 106: '2026-11-12', 108: '2026-11-12' },
      '102 volta pro dia do Bling (não sei a hora); 103 a base tinha DENTRO da janela: regravo onde estava (a troca apagaria a única cópia); 107 está no dia seguinte: não dobro');
    assert.deepStrictEqual([x.r.dia_ml.lista_completa, /de quem é a conta/.test(x.r.dia_ml.sem_lista_porque), x.r.dia_ml.mudaram_de_dia], [false, true, 1]);
    /* sem token nenhum: igual — e nenhuma chamada ao ML */
    ml.falha = null;
    x = await rodar('2026-11-10', '2026-11-12', Object.assign({}, ctx, { garantirTokenML: null }));
    assert.deepStrictEqual([x.r.ok, x.dias, ml.urls.length, /sem token/.test(x.r.dia_ml.sem_lista_porque)], [true, { 101: '2026-11-11', 102: '2026-11-11', 103: '2026-11-10', 106: '2026-11-12', 108: '2026-11-12' }, 0, true]);

    /* ── E. NÃO DEU PRA CONSULTAR A BORDA NA BASE: aborta, e a troca NÃO acontece ── */
    base.linhas = [];
    base.falhaConsulta = () => true;
    x = await rodar('2026-11-10', '2026-11-12');
    assert.deepStrictEqual([x.r.ok, x.r.desfecho, x.r.transitorio, base.trocas, base.gravadas.length, x.detalhes.length], [false, 'abortado', true, 0, 0, 0], JSON.stringify(x.r.msg));
    assert.ok(/não consegui conferir na base as vendas da borda da janela \(o banco respondeu 503\).*NADA foi apagado/.test(x.r.msg), x.r.msg);
    /* a consulta só falha na parte das vendas DIRETAS do ML: a coleta do Bling termina, e mesmo assim não troca */
    base.falhaConsulta = (q) => /ML-/.test(q);
    x = await rodar('2026-11-10', '2026-11-12');
    assert.deepStrictEqual([x.r.ok, x.r.desfecho, x.r.transitorio, base.trocas, base.gravadas.length], [false, 'abortado', true, 0, 0], JSON.stringify(x.r.msg));
    assert.ok(/vendas diretas do Mercado Livre da borda da janela.*nada foi apagado/.test(x.r.msg), x.r.msg);
    base.falhaConsulta = null;

    /* ── F. VIRADA DE MÊS: o imposto segue o mês do dia GRAVADO (31/10 23:30 no ML = 01/11 00:30 em Brasília) ── */
    bling.pedidos = [ped(201, L(201), '2026-10-31', 'ml'), ped(202, L(202), '2026-10-31', 'ml')];
    ml.vendas = [vendaML(L(201), '2026-10-31T23:30:00.000-04:00'), vendaML(L(202), '2026-10-31T10:00:00.000-04:00')];
    base.linhas = [];
    x = await rodar('2026-10-30', '2026-11-01');
    assert.deepStrictEqual(x.dias, { 201: '2026-11-01', 202: '2026-10-31' });
    assert.deepStrictEqual(base.gravadas.map((l) => [l.numero_pedido, Number(l.imposto)]).sort(), [['201', 10], ['202', 8]], 'alíquota de novembro (10%) pra venda que caiu em novembro, de outubro (8%) pra de outubro');

    /* ── G. JANELA DE UM DIA SÓ (o resgate e o "refazer dia da Shopee" rodam assim), base na regra nova ── */
    bling.pedidos = [ped(301, L(301), '2026-11-10', 'ml'), ped(302, L(302), '2026-11-11', 'ml'), ped(303, L(303), '2026-11-11', 'ml'), ped(304, 'SHP3ABCDEF1234', '2026-11-11', 'shopee')];
    ml.vendas = [vendaML(L(301), '2026-11-10T23:15:00.000-04:00'), vendaML(L(302), '2026-11-11T08:00:00.000-04:00'), vendaML(L(303), '2026-11-11T23:45:00.000-04:00')];
    base.linhas = [naBase('301', L(301), '2026-11-11'), naBase('302', L(302), '2026-11-11'), naBase('303', L(303), '2026-11-12')];
    x = await rodar('2026-11-11', '2026-11-11');
    assert.deepStrictEqual(x.dias, { 301: '2026-11-11', 302: '2026-11-11', 304: '2026-11-11' }, 'o dia leva a venda da madrugada dele (301) e deixa a da madrugada seguinte (303) onde está');
    /* a MESMA janela com a base antiga: nada muda de lugar, nada dobra, nada some */
    base.linhas = [naBase('301', L(301), '2026-11-10'), naBase('302', L(302), '2026-11-11'), naBase('303', L(303), '2026-11-11')];
    x = await rodar('2026-11-11', '2026-11-11');
    assert.deepStrictEqual(x.dias, { 302: '2026-11-11', 303: '2026-11-11', 304: '2026-11-11' });

    /* ── H. A TRAVA DO FILTRO DO BLING CONTINUA: pedido de fora da lista pedida não entra, e é contado ── */
    bling.pedidos = [ped(401, L(401), '2026-11-11', 'ml'), ped(402, L(402), '2026-11-05', 'ml'), ped(403, 'SHP4ABCDEF1234', '2026-11-20', 'shopee')];
    bling.furaFiltro = [402, 403];
    ml.vendas = [vendaML(L(401), '2026-11-11T08:00:00.000-04:00'), vendaML(L(402), '2026-11-11T09:00:00.000-04:00')];   /* mesmo que o ML diga que é do período */
    base.linhas = [];
    x = await rodar('2026-11-10', '2026-11-12');
    assert.deepStrictEqual([x.dias, x.r.fora, x.detalhes], [{ 401: '2026-11-11' }, 2, ['401']]);
    bling.furaFiltro = [];
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — o dia da venda do Mercado Livre é o de Brasília: a da madrugada vai pro dia certo (a direta do ML da 1ª hora deixou de ser descartada), a borda da janela não dobra nem some com venda (base nova, base antiga, sem a lista do ML), consulta que falha aborta sem trocar, imposto no mês do dia gravado, e os outros canais não mudam');
  _chegouAoFim = true;
  process.exit(0);
})();
