'use strict';
/* 27/11 — A VIGIA DOS PEDIDOS QUE O BLING JÁ CANCELOU COM A NOTA AINDA VALENDO (lib/checkout/cancelados-bling-vigia).
   Caso real (Girassol, ML, 26/11): o ML cancela, o Bling cancela o pedido sozinho, o card some do checkout — e a NF fica
   autorizada sem ninguém ver. O dono: "no bling tao canceladas sim, logo nao tao no checkout. mas aih q mora o perigo,
   as nf foram geradas e tao lá".

   O que se prova (o código de produção):
   A. a varredura: lista os cancelados da janela; o BIPADO sai (é do Devoluções); nota cancelada e pedido sem nota são
      "resolvidos"; nota AUTORIZADA fica como "nota valendo"; falha do Bling é "não sei" (nunca "sem nota");
   B. a memória: resolvido não é lido de novo; "nota valendo" só relê a NOTA; quando ela é cancelada, sai;
   C. o orçamento de leituras: o que não coube fica pra próxima rodada, sem virar veredito;
   D. as falhas: sem a situação "Cancelado", página que não vem, registro ilegível — nada é inventado nem apagado;
   E. os pendentes: cancelar até 24 h, devolução depois; sem prova de bipagem depois de 28 dias; tratado sai. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/checkout/cancelados-bling-vigia');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'canc-bling-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };
const AGORA = Date.parse('2026-11-27T10:00:00-03:00');   /* 13:00Z */

function cena(op) {
  op = op || {};
  const dir = op.dir || pasta(); let t = op.agora || AGORA;
  const cx = { dir, idas: [], conf: op.conf || {}, sit: op.sit === undefined ? { ids: [12, 15], nomes: ['Cancelado', 'Cancelado pelo marketplace'] } : op.sit,
    lista: op.lista || {}, ped: op.ped || {}, nfe: op.nfe || {}, passa: (ms) => { t += ms; } };
  const vig = V.criar(Object.assign({ empresa: 'emp', cacheDir: dir, agora: () => t, lojaMkt: { 201: 'ml', 202: 'tiktok', 203: 'shopee' },
    lerConferidos: () => cx.conf, garantirSitCancel: async (bg) => { assert.strictEqual(typeof bg, 'function'); if (cx.sit === 'ESTOURA') throw new Error('x'); return cx.sit; },
    blingGet: async (c) => {
      cx.idas.push(c);
      const ml = /^\/pedidos\/vendas\?idsSituacoes=(\d+)&dataInicial=([\d-]+)&dataFinal=([\d-]+)&limite=100&pagina=(\d+)$/.exec(c);
      if (ml) { const r = cx.lista[ml[1] + ':' + ml[4]]; if (r === 'ESTOURA') throw new Error('rede'); if (r === 'FALHA') return { ok: false, status: 429, data: null }; return { ok: true, status: 200, data: { data: r || [] } }; }
      const mp = /^\/pedidos\/vendas\/(\d+)$/.exec(c), mn = /^\/nfe\/(\d+)$/.exec(c);
      const d = mp ? cx.ped[mp[1]] : (mn ? cx.nfe[mn[1]] : undefined);
      if (d === 'ESTOURA') throw new Error('rede');
      return d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: mp || mn ? 404 : 400, data: null };
    } }, op.extra || {}));
  cx.vig = vig; cx.reg = () => JSON.parse(fs.readFileSync(path.join(dir, V.ARQ), 'utf8'));
  cx.detalhes = () => cx.idas.filter((c) => !/idsSituacoes/.test(c));
  return cx;
}
const P = (id, extra) => Object.assign({ id, numero: 1000 + id, numeroLoja: 'L' + id, data: '2026-11-26', loja: { id: 201 }, contato: { nome: 'FULANO DE TAL' } }, extra || {});
const NF = (id, extra) => Object.assign({ id, numero: '13' + id, situacao: 5, dataEmissao: '2026-11-26 13:24:00', loja: { id: 201 }, contato: { nome: 'FULANO DE TAL' } }, extra || {});
/* 1 = nota valendo · 2 = nota cancelada · 3 = sem nota · 4 = bipado · 5 = o Bling não devolve o pedido · 6 = não devolve a nota
   7 = nota valendo em outra situação de cancelamento (15) e de outra loja */
const MUNDO = () => ({
  lista: { '12:1': [P(1), P(2), P(3), P(4), P(5), P(6)], '15:1': [P(7, { loja: { id: 202 }, data: '2026-11-25' }), P(1)] },
  ped: { 1: { id: 1, notaFiscal: { id: 901 } }, 2: { id: 2, notaFiscal: { id: 902 } }, 3: { id: 3, notaFiscal: { id: 0 } }, 4: { id: 4, notaFiscal: { id: 904 } }, 6: { id: 6, notaFiscal: { id: 906 } }, 7: { id: 7, notaFiscal: { id: 907 } } },
  nfe: { 901: NF(901), 902: NF(902, { situacao: { valor: 2 } }), 904: NF(904), 907: NF(907, { situacao: { valor: 6 }, dataEmissao: '2026-11-25 09:00:00', loja: { id: 202 } }) },
  conf: { 4: { conferido_em: 'x' } },
});

/* promessa pendurada esvazia o laço de eventos e o node sai com 0 SEM ter chegado ao fim — isso é falha, não sucesso */
let _chegouAoFim = false;
process.on('exit', (cod) => { if (!_chegouAoFim && cod === 0) { console.error('FALHOU: o teste parou no meio (promessa que nunca resolveu)'); process.exitCode = 1; } });

(async () => {
  for (const [k, falta] of [['blingGet', 'blingGet'], ['garantirSitCancel', 'garantirSitCancel'], ['lerConferidos', 'lerConferidos'], ['cacheDir', 'cacheDir'], ['empresa', 'empresa']]) {
    const o = { empresa: 'e', cacheDir: '/x', blingGet() {}, garantirSitCancel() {}, lerConferidos() {} }; delete o[k];
    assert.throws(() => V.criar(o), new RegExp('falta ' + falta), 'sem ' + k);
  }

  /* ═══ A. a varredura ═══ */
  let c = cena(MUNDO());
  let r = await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual(r, { ok: true, dias: 3, cancelados_no_bling: 7, bipados: 1, ja_resolvidos: 0, lidos: 4, nf_valendo: 2, nf_outra: 0, nf_cancelada: 1, sem_nf: 1, nao_sei: 2, ficaram_pra_proxima: 0 });
  assert.deepStrictEqual(c.idas.filter((x) => /idsSituacoes/.test(x)), ['/pedidos/vendas?idsSituacoes=12&dataInicial=2026-11-24&dataFinal=2026-11-28&limite=100&pagina=1', '/pedidos/vendas?idsSituacoes=15&dataInicial=2026-11-24&dataFinal=2026-11-28&limite=100&pagina=1'], 'a janela e as duas situações de cancelamento');
  assert.deepStrictEqual(c.detalhes(), ['/pedidos/vendas/1', '/nfe/901', '/pedidos/vendas/2', '/nfe/902', '/pedidos/vendas/3', '/pedidos/vendas/5', '/pedidos/vendas/6', '/nfe/906', '/pedidos/vendas/7', '/nfe/907'], 'o bipado (4) não é lido; o que aparece nas duas situações (1) é lido uma vez');
  let reg = c.reg();
  assert.deepStrictEqual(Object.fromEntries(Object.keys(reg.pedidos).map((k) => [k, reg.pedidos[k].estado + (reg.pedidos[k].motivo ? ':' + reg.pedidos[k].motivo : '')])),
    { 1: 'nf_valendo', 2: 'nf_cancelada', 3: 'sem_nf', 4: 'bipado', 5: 'nao_sei:pedido_http_404', 6: 'nao_sei:nota_http_404', 7: 'nf_valendo' });
  assert.deepStrictEqual(reg.pedidos[1], { numero: 1001, numero_loja: 'L1', loja_id: '201', data: '2026-11-26', visto_em: new Date(AGORA).toISOString(), marketplace: 'ml', lido_em: new Date(AGORA).toISOString(), estado: 'nf_valendo', nf_id: '901', nf_numero: '13901', nf_emissao: '2026-11-26 13:24:00', nf_situacao: 5, nf_loja_id: '201' });
  assert.deepStrictEqual([reg.pedidos[7].marketplace, reg.pedidos[7].nf_situacao, reg.rodou_em, reg.dias], ['tiktok', 6, new Date(AGORA).toISOString(), 3]);
  assert.ok(!/FULANO|contato/.test(fs.readFileSync(path.join(c.dir, V.ARQ), 'utf8')), 'o registro não guarda dado de gente');
  /* a nota que o Bling devolve tem que ser a que o pedido aponta; e sem situação não é "valendo" */
  c = cena({ lista: { '12:1': [P(1), P(2)] }, ped: { 1: { notaFiscal: { id: 901 } }, 2: { notaFiscal: { id: 902 } } }, nfe: { 901: NF(555), 902: NF(902, { situacao: null }) } });
  await c.vig.varrer({});
  assert.deepStrictEqual([c.reg().pedidos[1].estado + ':' + c.reg().pedidos[1].motivo, c.reg().pedidos[2].estado + ':' + c.reg().pedidos[2].motivo], ['nao_sei:nota_diferente', 'nao_sei:nota_sem_situacao']);
  /* notaFiscal ausente, zero, torta: sem nota (sem ir atrás de nota nenhuma) */
  for (const nfp of [undefined, null, {}, { id: 0 }, { id: '0' }, { id: 'abc' }, { id: -5 }]) { c = cena({ lista: { '12:1': [P(1)] }, ped: { 1: { id: 1, notaFiscal: nfp } } }); await c.vig.varrer({}); assert.deepStrictEqual([c.reg().pedidos[1].estado, c.detalhes()], ['sem_nf', ['/pedidos/vendas/1']], JSON.stringify(nfp)); }
  /* o Bling cai (em vez de responder erro): "não sei", nunca "sem nota" */
  c = cena({ lista: { '12:1': [P(1), P(2)] }, ped: { 1: 'ESTOURA', 2: { notaFiscal: { id: 902 } } }, nfe: { 902: 'ESTOURA' } }); await c.vig.varrer({});
  assert.deepStrictEqual([c.reg().pedidos[1].estado + ':' + c.reg().pedidos[1].motivo, c.reg().pedidos[2].estado + ':' + c.reg().pedidos[2].motivo], ['nao_sei:pedido_http_0', 'nao_sei:nota_http_0']);
  /* id torto na lista é ignorado; a janela respeita 1..180 e o padrão é 3 dias */
  c = cena({ lista: { '12:1': [{ id: 'x' }, { numero: 5 }, null, P(1)] }, ped: { 1: { notaFiscal: { id: 0 } } } }); r = await c.vig.varrer({});
  assert.deepStrictEqual([r.cancelados_no_bling, r.dias, /dataInicial=2026-11-24&/.test(c.idas[0])], [1, 3, true]);
  c = cena({}); r = await c.vig.varrer({ dias: 9999 }); assert.deepStrictEqual([r.dias, /dataInicial=2026-05-31&/.test(c.idas[0])], [180, true]);
  c = cena({}); r = await c.vig.varrer({ dias: -4 }); assert.strictEqual(r.dias, 3);

  /* ═══ B. a memória ═══ */
  c = cena(MUNDO()); await c.vig.varrer({ dias: 3 }); c.idas.length = 0; c.passa(3600e3);
  r = await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual(c.detalhes(), ['/nfe/901', '/pedidos/vendas/5', '/pedidos/vendas/6', '/nfe/906', '/nfe/907'], 'resolvidos (2, 3, 4) não são lidos de novo; a nota valendo só relê a NOTA; o "não sei" é tentado de novo');
  assert.deepStrictEqual([r.ja_resolvidos, r.bipados, r.nf_valendo, r.nao_sei, c.reg().pedidos[1].visto_em], [3, 0, 2, 2, new Date(AGORA + 3600e3).toISOString()]);
  /* a nota foi cancelada no Bling entre uma rodada e outra: sai dos pendentes */
  assert.deepStrictEqual(c.vig.pendentes().pendentes.map((x) => x.pedido_id), ['1', '7']);
  c.nfe[901] = NF(901, { situacao: 2 }); c.idas.length = 0;
  await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([c.reg().pedidos[1].estado, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], ['nf_cancelada', ['7']]);
  /* a nota valendo que o Bling não devolveu nesta rodada CONTINUA valendo (não some do aviso por causa de um 429) */
  delete c.nfe[907]; await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([c.reg().pedidos[7].estado, c.reg().pedidos[7].motivo, c.reg().pedidos[7].nf_numero, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], ['nf_valendo', 'nota_http_404', '13907', ['7']]);
  /* 27/11 — nota em OUTRA situação (pendente 1, rejeitada 4, denegada 9…): não é "valendo" — fica à parte, sem ação, com o
     número da situação; só 5, 6 e 7 pedem cancelar/devolver. E é relida (só a nota) a cada rodada: a pendente pode autorizar. */
  {
    const lista = {}; lista['12:1'] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => P(n));
    const ped = {}, nfe = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) { ped[n] = { notaFiscal: { id: 900 + n } }; nfe[900 + n] = NF(900 + n, { situacao: n }); }
    const d = cena({ lista, ped, nfe, sit: { ids: [12], nomes: ['Cancelado'] } });
    const rr = await d.vig.varrer({ dias: 3, leituras: 100 });
    assert.deepStrictEqual([rr.nf_valendo, rr.nf_outra, rr.nf_cancelada, rr.nao_sei], [3, 7, 1, 0]);
    assert.deepStrictEqual(Object.fromEntries(Object.keys(d.reg().pedidos).map((k) => [k, d.reg().pedidos[k].estado])),
      { 1: 'nf_outra', 2: 'nf_cancelada', 3: 'nf_outra', 4: 'nf_outra', 5: 'nf_valendo', 6: 'nf_valendo', 7: 'nf_valendo', 8: 'nf_outra', 9: 'nf_outra', 10: 'nf_outra', 11: 'nf_outra' });
    const pp = d.vig.pendentes();
    assert.deepStrictEqual([pp.pendentes.map((x) => x.pedido_id), pp.outras.map((x) => [x.pedido_id, x.nf_situacao]), pp.outras[0]], [['5', '6', '7'], [['1', 1], ['3', 3], ['4', 4], ['8', 8], ['9', 9], ['10', 10], ['11', 11]], { pedido_id: '1', numero: 1001, nf_numero: '13901', nf_situacao: 1 }]);
    /* a pendente foi autorizada: relê SÓ a nota e passa a valer; a rejeitada que o Bling não devolveu continua "outra" */
    d.nfe[901] = NF(901, { situacao: 5 }); delete d.nfe[904]; d.idas.length = 0;
    const r2 = await d.vig.varrer({ dias: 3, leituras: 100 });
    assert.deepStrictEqual([d.detalhes(), d.reg().pedidos[1].estado, d.reg().pedidos[4].estado, d.reg().pedidos[4].motivo, r2.nf_valendo, r2.nf_outra, r2.nao_sei, d.vig.pendentes().pendentes.map((x) => x.pedido_id)],
      [[1, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => '/nfe/' + (900 + n)), 'nf_valendo', 'nf_outra', 'nota_http_404', 4, 6, 0, ['1', '5', '6', '7']]);
  }
  /* foi bipado depois (o galpão despachou assim mesmo): sai, vira assunto do Devoluções */
  c.conf[7] = { conferido_em: 'y' }; await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([c.reg().pedidos[7].estado, c.vig.pendentes().pendentes], ['bipado', []]);
  /* tratado (quem trata marca no registro): não é lido de novo nem volta pros pendentes */
  c = cena(MUNDO()); await c.vig.varrer({ dias: 3 });
  { const g = c.reg(); g.pedidos[1].tratado = { em: 'x', como: 'cancelada' }; fs.writeFileSync(path.join(c.dir, V.ARQ), JSON.stringify(g)); }
  c.idas.length = 0; await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([c.detalhes().includes('/nfe/901'), c.reg().pedidos[1].tratado, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], [false, { em: 'x', como: 'cancelada' }, ['7']]);
  /* o registro esquece o que não vê há mais de 150 dias (e só isso) */
  { const g = c.reg(); g.pedidos.velho = { estado: 'nf_cancelada', visto_em: new Date(AGORA - 151 * 864e5).toISOString() }; g.pedidos.quase = { estado: 'nf_cancelada', visto_em: new Date(AGORA - 149 * 864e5).toISOString() }; g.pedidos.torto = { estado: 'sem_nf' }; fs.writeFileSync(path.join(c.dir, V.ARQ), JSON.stringify(g)); }
  await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual(['velho', 'quase', 'torto'].map((k) => k in c.reg().pedidos), [false, true, false]);

  /* ═══ C. o orçamento de leituras ═══ */
  const muitos = { lista: { '12:1': Array.from({ length: 10 }, (_, i) => P(i + 1)) }, ped: {}, nfe: {} };
  for (let i = 1; i <= 10; i++) { muitos.ped[i] = { notaFiscal: { id: 900 + i } }; muitos.nfe[900 + i] = NF(900 + i); }
  c = cena(muitos); r = await c.vig.varrer({ dias: 3, leituras: 6 });
  assert.deepStrictEqual([r.lidos, r.nf_valendo, r.ficaram_pra_proxima, c.detalhes().length, Object.keys(c.reg().pedidos)], [3, 3, 7, 6, ['1', '2', '3']], 'o que não coube não ganha veredito');
  /* Codex #999: as leituras RODAM — quem nunca foi lido passa na frente de reler nota já conhecida; depois, quem foi lido há
     mais tempo. Com 10 notas valendo e 6 leituras por rodada, em 3 rodadas todo mundo foi visto (antes: só os 5 primeiros, pra sempre). */
  c.idas.length = 0; c.passa(60e3); r = await c.vig.varrer({ dias: 3, leituras: 6 });
  assert.deepStrictEqual([c.detalhes(), r.ficaram_pra_proxima, Object.keys(c.reg().pedidos)], [['/pedidos/vendas/4', '/nfe/904', '/pedidos/vendas/5', '/nfe/905', '/pedidos/vendas/6', '/nfe/906'], 7, ['1', '2', '3', '4', '5', '6']], 'o orçamento vale por rodada; os nunca lidos primeiro');
  c.idas.length = 0; c.passa(60e3); r = await c.vig.varrer({ dias: 3, leituras: 6 });
  assert.deepStrictEqual([c.detalhes(), r.ficaram_pra_proxima], [['/pedidos/vendas/7', '/nfe/907', '/pedidos/vendas/8', '/nfe/908', '/pedidos/vendas/9', '/nfe/909'], 7]);
  c.idas.length = 0; c.passa(60e3); r = await c.vig.varrer({ dias: 3, leituras: 6 });
  assert.deepStrictEqual([c.detalhes(), r.ficaram_pra_proxima, Object.keys(c.reg().pedidos).length, c.vig.pendentes().pendentes.length], [['/pedidos/vendas/10', '/nfe/910', '/nfe/901', '/nfe/902', '/nfe/903', '/nfe/904'], 5, 10, 10], 'o último novo (pedido + nota) e, com o que sobra, os lidos há mais tempo');
  c.idas.length = 0; c.passa(60e3); r = await c.vig.varrer({ dias: 3, leituras: 6 });
  assert.deepStrictEqual(c.detalhes(), ['/nfe/905', '/nfe/906', '/nfe/907', '/nfe/908', '/nfe/909', '/nfe/901'], 'a vez segue rodando: ninguém fica sem ser relido');
  /* pedido que não cabe inteiro (pedido + nota) fica pra próxima, sem veredito pela metade */
  c = cena(muitos); r = await c.vig.varrer({ dias: 3, leituras: 3 }); assert.deepStrictEqual([c.detalhes(), r.ficaram_pra_proxima, Object.keys(c.reg().pedidos)], [['/pedidos/vendas/1', '/nfe/901'], 9, ['1']]);
  c = cena(muitos); r = await c.vig.varrer({ dias: 3, leituras: 99999 }); assert.deepStrictEqual([r.nf_valendo, r.ficaram_pra_proxima], [10, 0]);
  c = cena(muitos); r = await c.vig.varrer({ dias: 3 }); assert.strictEqual(r.nf_valendo, 10, 'o padrão (40 leituras) cobre 10 pedidos');

  /* ═══ D. as falhas ═══ */
  for (const sit of [null, { ids: [] }, { ids: ['x', 0, -1] }, 'ESTOURA', {}]) {
    c = cena(Object.assign(MUNDO(), { sit })); fs.writeFileSync(path.join(c.dir, V.ARQ), JSON.stringify({ pedidos: { 1: { estado: 'nf_valendo', nf_id: '901', nf_emissao: '2026-11-26 13:24:00', data: '2026-11-26', visto_em: new Date(AGORA).toISOString() } } }));
    r = await c.vig.varrer({ dias: 3 });
    assert.deepStrictEqual([r.ok, r.etapa, c.idas.length, Object.keys(c.reg().pedidos), c.reg().rodou_em], [false, 'sem_situacao', 0, ['1'], undefined], 'sem a situação "Cancelado": não lista e não mexe no registro — ' + JSON.stringify(sit));
  }
  /* página que não vem: para naquela situação, diz, e o que veio vale */
  for (const ruim of ['FALHA', 'ESTOURA']) {
    c = cena({ lista: { '12:1': Array.from({ length: 100 }, (_, i) => P(i + 1, { notaFiscal: null })), '12:2': ruim, '15:1': [P(500)] }, ped: {} });
    r = await c.vig.varrer({ dias: 3, leituras: 1 });
    assert.deepStrictEqual([r.ok, r.cancelados_no_bling, /não devolveu a página 2 da situação 12/.test(r.lista_incompleta), c.idas.filter((x) => /idsSituacoes/.test(x)).length], [true, 101, true, 3], ruim);
  }
  /* 100 por página: segue pra próxima; menos de 100: para; teto de 20 páginas por situação */
  { const lista = {}; for (let p = 1; p <= 25; p++) lista['12:' + p] = Array.from({ length: 100 }, (_, i) => P(p * 1000 + i)); c = cena({ lista, sit: { ids: [12] } }); r = await c.vig.varrer({ dias: 3, leituras: 1 }); assert.deepStrictEqual([c.idas.filter((x) => /idsSituacoes/.test(x)).length, r.cancelados_no_bling], [20, 2000]); }
  /* registro ilegível: a varredura NÃO grava por cima (e quem lê recebe o erro) */
  c = cena(MUNDO()); fs.writeFileSync(path.join(c.dir, V.ARQ), '{ quebrado');
  await assert.rejects(() => c.vig.varrer({ dias: 3 })); assert.throws(() => c.vig.pendentes()); assert.strictEqual(fs.readFileSync(path.join(c.dir, V.ARQ), 'utf8'), '{ quebrado');
  r = null; fs.writeFileSync(path.join(c.dir, V.ARQ), '[1]'); assert.deepStrictEqual(c.vig.pendentes().pendentes, [], 'registro que não é o objeto esperado vale como vazio');
  assert.strictEqual((await c.vig.varrer({ dias: 3 })).ok, true, 'depois do erro, a trava soltou');
  /* duas ao mesmo tempo: a segunda não roda */
  c = cena(MUNDO()); const p1 = c.vig.varrer({ dias: 3 }); const r2 = await c.vig.varrer({ dias: 3 }); await p1;
  assert.deepStrictEqual([r2.ok, r2.etapa, c.vig.emAndamento()], [false, 'rodando', false]);

  /* ═══ F. Codex #999 ═══ */
  /* o checkout JÁ tratou (devolução feita / nota cancelada pelo admin, registro do rota-cancelados-tratar): não é pendência,
     não é lido — e sai dos pendentes NA HORA, sem esperar a rodada */
  { let trat = new Set(['1']); let cai = false;
    c = cena(Object.assign(MUNDO(), { extra: { lerTratados: () => { if (cai) throw new Error('x'); return trat; } } })); r = await c.vig.varrer({ dias: 3 });
    assert.deepStrictEqual([c.reg().pedidos[1].estado, c.detalhes().includes('/pedidos/vendas/1'), r.ja_resolvidos, r.nf_valendo, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], ['tratado', false, 1, 1, ['7']]);
    c.idas.length = 0; trat = new Set(); await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([c.reg().pedidos[1].estado, c.detalhes().includes('/pedidos/vendas/1')], ['tratado', false], 'tratado é final');
    trat = new Set(['7']); assert.deepStrictEqual(c.vig.pendentes().pendentes, [], 'tratado depois da rodada: some na hora');
    cai = true; assert.deepStrictEqual(c.vig.pendentes().pendentes.map((x) => x.pedido_id), ['7'], 'registro dos tratados ilegível: ninguém é escondido');
    c = cena(Object.assign(MUNDO(), { extra: { lerTratados: () => ['1'] } })); await c.vig.varrer({ dias: 3 }); assert.strictEqual(c.reg().pedidos[1].estado, 'nf_valendo', 'só vale um Set'); }
  /* o que está EM ABERTO no registro é conferido mesmo FORA da janela da listagem: a nota cancelada depois sai do aviso */
  { c = cena({ lista: { '12:1': [P(1)] }, ped: { 1: { notaFiscal: { id: 901 } }, 52: { notaFiscal: { id: 952 } } }, nfe: { 901: NF(901), 950: NF(950, { situacao: 2 }), 951: NF(951), 952: NF(952), 954: NF(954) }, conf: { 54: { conferido_em: 'z' } } });
    const velho = new Date(AGORA - 40 * 864e5).toISOString();
    const V0 = (extra) => Object.assign({ numero: 77, numero_loja: 'LV', loja_id: '202', data: '2026-10-18', visto_em: velho, lido_em: velho }, extra);
    fs.writeFileSync(path.join(c.dir, V.ARQ), JSON.stringify({ pedidos: { 50: V0({ estado: 'nf_valendo', nf_id: '950', nf_numero: '13950', nf_emissao: '2026-10-18 10:00:00' }), 51: V0({ estado: 'nf_outra', nf_id: '951', nf_situacao: 1 }),
      52: V0({ estado: 'nao_sei', motivo: 'pedido_http_429' }), 53: V0({ estado: 'nf_cancelada', nf_id: '953' }), 54: V0({ estado: 'nf_valendo', nf_id: '954' }), 55: V0({ estado: 'nf_valendo', nf_id: '955', nf_numero: '13955' }) } }));
    r = await c.vig.varrer({ dias: 3 }); const g = c.reg().pedidos;
    assert.deepStrictEqual(c.detalhes(), ['/pedidos/vendas/1', '/nfe/901', '/nfe/950', '/nfe/951', '/pedidos/vendas/52', '/nfe/952', '/nfe/955'], 'o novo primeiro; depois os em aberto do registro; o resolvido (53) e o bipado (54) não são lidos');
    assert.deepStrictEqual([g[50].estado, g[51].estado, g[52].estado, g[53].estado, g[54].estado, g[55].estado + ':' + g[55].motivo, g[55].nf_numero], ['nf_cancelada', 'nf_valendo', 'nf_valendo', 'nf_cancelada', 'bipado', 'nf_valendo:nota_http_404', '13955']);
    assert.deepStrictEqual([g[50].visto_em, g[50].lido_em, g[50].numero, g[50].numero_loja, g[50].data, g[50].marketplace, g[1].visto_em], [velho, new Date(AGORA).toISOString(), 77, 'LV', '2026-10-18', 'tiktok', new Date(AGORA).toISOString()], 'fora da lista: os dados do registro ficam, e o "visto" não anda');
    assert.deepStrictEqual([r.cancelados_no_bling, r.nf_cancelada, r.bipados, r.ja_resolvidos], [1, 1, 1, 0]); }
  /* cada ida ao Bling tem PRAZO e é abortada: a chamada pendurada não trava a vigia; a rodada para e o resto fica pra próxima */
  { const sinais = []; const pendura = (re) => ({ prazoMs: 25, blingGet: (cam, tent, signal) => { c.idas.push(cam); sinais.push([cam, tent, signal]); if (re.test(cam)) return new Promise(() => {});
      const ml = /idsSituacoes=(\d+).*pagina=(\d+)$/.exec(cam); if (ml) return Promise.resolve({ ok: true, status: 200, data: { data: c.lista[ml[1] + ':' + ml[2]] || [] } });
      const mp = /^\/pedidos\/vendas\/(\d+)$/.exec(cam), mn = /^\/nfe\/(\d+)$/.exec(cam); const d = mp ? c.ped[mp[1]] : c.nfe[mn[1]]; return Promise.resolve(d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: 404, data: null }); } });
    c = cena(Object.assign({}, muitos, { extra: pendura(/^\/nfe\/902$/) })); r = await c.vig.varrer({ dias: 3 });
    assert.deepStrictEqual([r.ok, r.parou_no_prazo, r.nf_valendo, r.nao_sei, r.ficaram_pra_proxima, c.detalhes(), c.reg().pedidos[2].estado + ':' + c.reg().pedidos[2].motivo, c.vig.emAndamento()],
      [true, true, 1, 1, 8, ['/pedidos/vendas/1', '/nfe/901', '/pedidos/vendas/2', '/nfe/902'], 'nao_sei:nota_prazo', false]);
    assert.deepStrictEqual([sinais.every((x) => x[1] === 3 && x[2] && typeof x[2].aborted === 'boolean'), sinais.find((x) => x[0] === '/nfe/902')[2].aborted, sinais.find((x) => x[0] === '/nfe/901')[2].aborted], [true, true, false], 'a pendurada é ABORTADA; as outras não');
    assert.strictEqual((await c.vig.varrer({ dias: 3, leituras: 2 })).ok, true, 'a trava soltou');
    /* nota já valendo que pendura: continua valendo */
    c = cena(Object.assign({}, muitos, { extra: pendura(/^\/nfe\/901$/) })); fs.writeFileSync(path.join(c.dir, V.ARQ), JSON.stringify({ pedidos: { 1: { estado: 'nf_valendo', nf_id: '901', nf_numero: '13901', visto_em: new Date(AGORA).toISOString(), lido_em: '2026-01-01T00:00:00Z' } } }));
    r = await c.vig.varrer({ dias: 3, leituras: 1 }); assert.deepStrictEqual([c.reg().pedidos[1].estado, c.reg().pedidos[1].motivo, r.parou_no_prazo], ['nf_valendo', 'nota_prazo', true]);
    c = cena(Object.assign({}, muitos, { extra: pendura(/^\/pedidos\/vendas\/1$/) })); r = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([c.reg().pedidos[1].motivo, r.ficaram_pra_proxima, c.detalhes().length], ['pedido_prazo', 9, 1]);
    /* a LISTA pendura: diz, para de listar (não tenta a outra situação) e a rodada termina */
    c = cena(Object.assign(MUNDO(), { extra: pendura(/idsSituacoes=12/) })); r = await c.vig.varrer({ dias: 3 });
    assert.deepStrictEqual([r.ok, /página 1 da situação 12 \(passou do prazo\)/.test(r.lista_incompleta), r.parou_no_prazo, c.idas.length, r.cancelados_no_bling, c.vig.emAndamento()], [true, true, true, 1, 0, false]);
    /* as situações penduram (a leitura passa pelo mesmo prazo): diz que foi o prazo, e não mexe em nada */
    c = cena(Object.assign(MUNDO(), { extra: Object.assign(pendura(/situacoes/), { garantirSitCancel: async (bg) => { const x = await bg('/situacoes/modulos/1'); return x && x.ok ? { ids: [12] } : null; } }) })); r = await c.vig.varrer({ dias: 3 });
    assert.deepStrictEqual([r.ok, r.etapa, /não respondeu no prazo/.test(r.erro), c.vig.emAndamento(), sinais[sinais.length - 1][2].aborted], [false, 'sem_situacao', true, false, true]);
    /* chamada que REJEITA depois do prazo não vira rejeição solta */
    let rej; c = cena(Object.assign(MUNDO(), { extra: { prazoMs: 15, blingGet: (cam) => (/idsSituacoes=12/.test(cam) ? new Promise((_, no) => { rej = no; }) : Promise.resolve({ ok: true, status: 200, data: { data: [] } })) } }));
    let solta = 0; const ouve = () => { solta++; }; process.on('unhandledRejection', ouve);
    r = await c.vig.varrer({ dias: 3 }); rej(new Error('tarde demais')); await new Promise((ok) => setTimeout(ok, 20)); process.removeListener('unhandledRejection', ouve);
    assert.deepStrictEqual([r.ok, solta], [true, 0]); }

  /* ═══ E. os pendentes ═══ */
  c = cena(MUNDO()); await c.vig.varrer({ dias: 3 });
  let pe = c.vig.pendentes();
  assert.deepStrictEqual(pe, { rodou_em: new Date(AGORA).toISOString(), pendentes: [
    { pedido_id: '1', numero: 1001, numero_loja: 'L1', marketplace: 'ml', data: '2026-11-26', nf_numero: '13901', nfe_id: '901', horas_desde_a_emissao: 20.6, acao: 'cancelar', prova_local: true },
    { pedido_id: '7', numero: 1007, numero_loja: 'L7', marketplace: 'tiktok', data: '2026-11-25', nf_numero: '13907', nfe_id: '907', horas_desde_a_emissao: 49, acao: 'devolucao', prova_local: true }], outras: [] });
  /* a fronteira das 24 h, a nota sem data, e a prova de bipagem que acaba aos 28 dias */
  c = cena({ lista: { '12:1': [P(1, { data: '2026-10-30' }), P(2, { data: '2026-10-29' }), P(3, { data: null }), P(4, { data: '2026-11-28' })] },
    ped: { 1: { notaFiscal: { id: 901 } }, 2: { notaFiscal: { id: 902 } }, 3: { notaFiscal: { id: 903 } }, 4: { notaFiscal: { id: 904 } } },
    nfe: { 901: NF(901, { dataEmissao: '2026-11-26 10:00:01' }), 902: NF(902, { dataEmissao: '2026-11-26 10:00:00' }), 903: NF(903, { dataEmissao: null, dataOperacao: null }), 904: NF(904, { dataEmissao: null, dataOperacao: '2026-11-20 10:00:00' }) } });
  await c.vig.varrer({ dias: 60 }); pe = c.vig.pendentes().pendentes;
  assert.deepStrictEqual(pe.map((x) => [x.pedido_id, x.acao, x.horas_desde_a_emissao, x.prova_local]), [['1', 'cancelar', 24, true], ['2', 'devolucao', 24, false], ['3', null, null, false], ['4', 'devolucao', 168, false]],
    '23h59m59 ainda cancela, 24 h cravadas é devolução; sem data não se sabe; 28 dias tem prova, 29 não, sem data do pedido não, data no futuro não');
  /* sem varredura ainda: vazio, sem inventar data */
  c = cena({}); assert.deepStrictEqual(c.vig.pendentes(), { rodou_em: null, pendentes: [], outras: [] });

  _chegouAoFim = true;
  console.log('ok — vigia dos pedidos cancelados no Bling com a nota valendo: o bipado sai, nota cancelada e sem nota são resolvidos e não são lidos de novo, falha é "não sei", orçamento de leituras por rodada, nada é apagado sem resposta; pendentes com cancelar até 24 h / devolução depois e prova de bipagem só até 28 dias');
})().catch((e) => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
