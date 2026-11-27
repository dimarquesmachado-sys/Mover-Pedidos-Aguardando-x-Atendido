'use strict';
/* 27/11 — O ÍNDICE DAS NOTAS DE DEVOLUÇÃO (lib/checkout/devolucoes-indice) E O CONFRONTO NA VIGIA DOS CANCELADOS.
   O dono: "Vc não consegue mm confrontar com o Bling?" — a sonda mostrou que o XML da devolução referencia a chave da nota
   de venda (<refNFe>). Então a vigia passa a tirar sozinha do aviso o pedido cuja nota já foi devolvida.

   O que se prova (o código de produção):
   A. o XML: só do host do Bling, por https, sem seguir redirecionamento; só NF-e inteira responde; falha nunca é "sem referência";
   B. o índice: lista as entradas autorizadas (uma situação por vez) do período até amanhã; cada nota é lida UMA vez;
      o que não se deixou ler é tentado de novo (até 5 vezes) e nunca vira "não referencia"; orçamento por rodada;
   C. a consulta: acha a devolução pela chave da venda; arquivo ilegível = não sei;
   D. a vigia: quem tem a nota valendo e a chave conhecida é confrontado; achou a devolução, sai do aviso com o número dela;
      o índice falhando não muda nada; nada de gente é guardado. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../lib/checkout/devolucoes-indice');
const V = require('../lib/checkout/cancelados-bling-vigia');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-indice-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };
let _chegou = false;
process.on('exit', (c) => { if (c === 0 && !_chegou) { console.error('FALHOU: o teste parou no meio'); process.exitCode = 1; } });

const AGORA = Date.parse('2026-11-27T10:00:00-03:00');
const K = (n) => ('3526112754845600014755001000' + String(n).padStart(6, '0') + '1036890923').slice(0, 44).padEnd(44, '0');
const XML = (refs, fin) => '<nfeProc><NFe><infNFe Id="x"><ide>' + (fin === null ? '' : '<finNFe>' + (fin || 4) + '</finNFe>') + refs.map((k) => '<NFref><refNFe>' + k + '</refNFe></NFref>').join('') + '</ide><dest><xNome>FULANO DE TAL</xNome><CPF>11122233344</CPF></dest></infNFe></NFe></nfeProc>';
const LINK = (id) => 'https://www.bling.com.br/relatorios/nfe.xml.php?x=' + id;

(async () => {
  /* ═══ A. o XML ═══ */
  const baixa = (resp) => { const idas = []; const f = async (u, o) => { idas.push([u, o]); if (resp === 'ESTOURA') throw new Error('rede'); return resp; }; f.idas = idas; return f; };
  let b = baixa({ ok: true, status: 200, text: async () => XML([K(1), K(2), K(1)]) });
  assert.deepStrictEqual([await I.refsDoXml(LINK(1), b), b.idas], [{ refs: [K(1), K(2)], finalidade: '4' }, [[LINK(1), { timeout: 15000, redirect: 'manual' }]]], 'as chaves, sem repetir; e sem seguir redirecionamento');
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => XML([]) })), { refs: [], finalidade: '4' }, 'NF-e inteira sem referência: aí sim, vazio');
  for (const [link, motivo] of [['https://evil.example/x', 'link_de_fora'], ['https://bling.com.br.evil.example/x', 'link_de_fora'], ['http://www.bling.com.br/x', 'link_de_fora'], [null, 'link_de_fora'], ['torto', 'link_de_fora'], [{ a: 1 }, 'link_de_fora']]) {
    b = baixa({ ok: true, status: 200, text: async () => XML([K(1)]) }); assert.deepStrictEqual([await I.refsDoXml(link, b), b.idas.length], [{ falhou: motivo }, 0], JSON.stringify(link)); }
  assert.deepStrictEqual(await I.refsDoXml('https://bling.com.br/x', baixa({ ok: true, status: 200, text: async () => XML([K(3)]) })), { refs: [K(3)], finalidade: '4' });
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa('ESTOURA')), { falhou: 'rede' });
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: false, status: 302, text: async () => XML([K(1)]) })), { falhou: 'http_302' }, 'redirecionamento não é lido');
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: false, status: 403, text: async () => '' })), { falhou: 'http_403' });
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa(null)), { falhou: 'http_0' });
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => { throw new Error('x'); } })), { falhou: 'corpo' });
  for (const corpo of ['<html>login</html>', '', '<NFe><infNFe><NFref><refNFe>' + K(1) + '</refNFe>', '<outro><refNFe>' + K(1) + '</refNFe></outro>']) assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => corpo })), { falhou: 'nao_e_nfe' }, corpo.slice(0, 20));

  /* Codex #1003 (P1): nota de entrada que CITA a venda mas não é devolução (finalidade ≠ 4) não referencia ninguém; sem a tag, é falha */
  for (const fin of [1, 2, 3]) assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => XML([K(1)], fin) })), { refs: [], finalidade: String(fin) }, 'finalidade ' + fin);
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => XML([K(1)], null) })), { falhou: 'sem_finalidade' });
  assert.deepStrictEqual(await I.refsDoXml(LINK(1), baixa({ ok: true, status: 200, text: async () => XML([K(1)]).replace('<finNFe>4</finNFe>', '<finNFe> 4 </finNFe>') })), { refs: [K(1)], finalidade: '4' });

  /* ═══ B. o índice ═══ */
  const mundo = (op) => {
    op = op || {};
    const dir = op.dir || pasta(); let t = op.agora || AGORA;
    const cx = { dir, idas: [], baixou: [], listas: op.listas || {}, det: op.det || {}, xml: op.xml || {}, passa: (ms) => { t += ms; } };
    cx.ler = async (c) => { cx.idas.push(c);
      const ml = /^\/nfe\?tipo=0&situacao=(\d)&dataEmissaoInicial=([\d-]+)&dataEmissaoFinal=([\d-]+)&limite=100&pagina=(\d+)$/.exec(c);
      if (ml) { const x = cx.listas[ml[1] + ':' + ml[4]]; if (x === 'ESTOURA') throw new Error('rede'); if (x === 'PRAZO') return { ok: false, status: 0, data: null, prazo: true }; if (x === 'FALHA') return { ok: false, status: 429, data: null }; return { ok: true, status: 200, data: { data: x || [] } }; }
      const mn = /^\/nfe\/(\d+)$/.exec(c); assert.ok(mn, 'ida inesperada: ' + c);
      const d = cx.det[mn[1]]; if (d === 'ESTOURA') throw new Error('rede'); if (d === 'PRAZO') return { ok: false, status: 0, data: null, prazo: true };
      return d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: 404, data: null }; };
    cx.fetch = async (u) => { cx.baixou.push(u); const id = /x=(\d+)$/.exec(u)[1]; const x = cx.xml[id]; if (x === undefined) return { ok: false, status: 404, text: async () => '' }; return { ok: true, status: 200, text: async () => x }; };
    cx.ind = I.criar({ cacheDir: dir, fetch: cx.fetch, agora: () => t });
    cx.ind.devolucaoDe = (k) => cx.ind.devolucoesDe(k)[0] || null;   /* atalho do teste: a primeira candidata */
    cx.arq = () => JSON.parse(fs.readFileSync(path.join(dir, I.ARQ), 'utf8'));
    cx.detalhes = () => cx.idas.filter((c) => /^\/nfe\/\d+$/.test(c));
    return cx;
  };
  const N = (id, extra) => Object.assign({ id, numero: '13' + id, tipo: 0, contato: { nome: 'FULANO DE TAL', numeroDocumento: '11122233344' } }, extra || {});
  const D = (id, extra) => Object.assign({ id, numero: '13' + id, tipo: 0, xml: LINK(id), contato: { nome: 'FULANO DE TAL' } }, extra || {});
  /* 801 devolve a venda K(1); 802 é entrada de compra (sem referência); 803 devolve K(3) e K(4); 804 aparece em duas situações */
  const BASE = () => ({ listas: { '5:1': [N(801), N(802)], '6:1': [N(803), N(804)], '7:1': [N(804)] }, det: { 801: D(801), 802: D(802), 803: D(803), 804: D(804) }, xml: { 801: XML([K(1)]), 802: XML([]), 803: XML([K(3), K(4)]), 804: XML([K(9)]) } });
  let m = mundo(BASE()), r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 50 });
  assert.deepStrictEqual(r, { ok: true, listadas: 4, novas: 4, lidas: 4, com_referencia: 3, sem_ler: 0, ficaram_pra_proxima: 0 });
  assert.deepStrictEqual(m.idas.filter((c) => /^\/nfe\?/.test(c)), [5, 6, 7].map((s) => '/nfe?tipo=0&situacao=' + s + '&dataEmissaoInicial=2026-11-19&dataEmissaoFinal=2026-11-29&limite=100&pagina=1'), 'entradas, uma situação por vez; janela FOLGADA: da VÉSPERA do dia pedido até dois dias à frente (o Bling completa a data sem hora com a hora da consulta)');
  assert.deepStrictEqual([m.detalhes(), m.baixou], [['/nfe/801', '/nfe/802', '/nfe/803', '/nfe/804'], [LINK(801), LINK(802), LINK(803), LINK(804)]], 'cada nota uma vez (a 804, que veio em duas situações, também)');
  assert.deepStrictEqual(m.arq(), { notas: { 801: { numero: '13801', visto_em: new Date(AGORA).toISOString(), refs: [K(1)] }, 802: { numero: '13802', visto_em: new Date(AGORA).toISOString(), refs: [] },
    803: { numero: '13803', visto_em: new Date(AGORA).toISOString(), refs: [K(3), K(4)] }, 804: { numero: '13804', visto_em: new Date(AGORA).toISOString(), refs: [K(9)] } }, atualizado_em: new Date(AGORA).toISOString() });
  assert.ok(!/FULANO|11122233344|relatorios/.test(fs.readFileSync(path.join(m.dir, I.ARQ), 'utf8')), 'nada de gente (nem o link do XML) é guardado');
  /* a rodada seguinte NÃO lê de novo quem já foi lido — nem a nota sem referência */
  m.idas.length = 0; m.baixou.length = 0; m.listas['5:1'].push(N(805)); m.det[805] = D(805); m.xml[805] = XML([K(5)]);
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 50 });
  assert.deepStrictEqual([r.listadas, r.novas, r.lidas, m.detalhes(), m.baixou], [5, 1, 1, ['/nfe/805'], [LINK(805)]]);
  /* Codex #1003 (P1): no índice, a nota que não é devolução fica marcada e NÃO responde por venda nenhuma (e não é relida) */
  { const mm = mundo({ listas: { '5:1': [N(811), N(812)] }, det: { 811: D(811), 812: D(812) }, xml: { 811: XML([K(1)], 1), 812: XML([K(2)]) } }); const rr = await mm.ind.atualizar({ desde: '2026-11-20', ler: mm.ler });
    assert.deepStrictEqual([rr.lidas, rr.com_referencia, mm.arq().notas[811], mm.ind.devolucoesDe(K(1)), mm.ind.devolucoesDe(K(2))], [2, 1, { numero: '13811', visto_em: new Date(AGORA).toISOString(), refs: [], nao_e_devolucao: true }, [], [{ id: '812', numero: '13812' }]]);
    mm.idas.length = 0; await mm.ind.atualizar({ desde: '2026-11-20', ler: mm.ler }); assert.deepStrictEqual(mm.detalhes(), []);
    /* registro antigo que guardasse a referência de uma nota que não é devolução também não responde */
    const g = mm.arq(); g.notas[811].refs = [K(1)]; fs.writeFileSync(path.join(mm.dir, I.ARQ), JSON.stringify(g)); assert.deepStrictEqual(mm.ind.devolucoesDe(K(1)), []); }
  /* Codex #1003: duas devoluções da MESMA venda (uma cancelada e refeita) — a consulta devolve as duas */
  { const mm = mundo({ listas: { '5:1': [N(821), N(822)] }, det: { 821: D(821), 822: D(822) }, xml: { 821: XML([K(7)]), 822: XML([K(7)]) } }); await mm.ind.atualizar({ desde: '2026-11-20', ler: mm.ler });
    assert.deepStrictEqual(mm.ind.devolucoesDe(K(7)), [{ id: '821', numero: '13821' }, { id: '822', numero: '13822' }]); }
  /* C. a consulta */
  assert.deepStrictEqual([m.ind.devolucaoDe(K(1)), m.ind.devolucaoDe(K(4)), m.ind.devolucaoDe(K(5)), m.ind.devolucaoDe(K(77)), m.ind.devolucaoDe(K(1).replace(/(\d{4})/g, '$1 ')), m.ind.devolucaoDe('123'), m.ind.devolucaoDe(null), m.ind.devolucaoDe('')],
    [{ id: '801', numero: '13801' }, { id: '803', numero: '13803' }, { id: '805', numero: '13805' }, null, { id: '801', numero: '13801' }, null, null, null]);
  fs.writeFileSync(path.join(m.dir, I.ARQ), '{ quebrado'); assert.deepStrictEqual([m.ind.devolucaoDe(K(1)), m.ind.devolucoesDe(K(1))], [null, []], 'arquivo ilegível: não sei');
  await assert.rejects(() => m.ind.atualizar({ desde: '2026-11-20', ler: m.ler })); assert.strictEqual(fs.readFileSync(path.join(m.dir, I.ARQ), 'utf8'), '{ quebrado', 'e a atualização não grava por cima do que não leu');
  fs.writeFileSync(path.join(m.dir, I.ARQ), '[1]'); assert.strictEqual(m.ind.devolucaoDe(K(1)), null);
  /* o que não se deixou ler: sem registro de referência, tentado de novo, e NUNCA "não referencia" */
  m = mundo({ listas: { '5:1': [N(801), N(802), N(803), N(804), N(806)] }, det: { 801: D(801), 802: D(802, { xml: 'https://evil.example/x' }), 803: 'ESTOURA', 804: D(999), 806: D(806) }, xml: { 801: '<html>login</html>', 806: XML([K(6)]) } });
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 50 });
  assert.deepStrictEqual([r.lidas, r.sem_ler, r.com_referencia], [1, 4, 1]);
  assert.deepStrictEqual(Object.fromEntries(Object.keys(m.arq().notas).map((k) => [k, m.arq().notas[k].motivo || m.arq().notas[k].refs])), { 801: 'xml_nao_e_nfe', 802: 'xml_link_de_fora', 803: 'detalhe_http_0', 804: 'detalhe_http_200', 806: [K(6)] });
  assert.deepStrictEqual([m.arq().notas[801].tentativas, 'refs' in m.arq().notas[801], m.ind.devolucaoDe(K(1))], [1, false, null]);
  /* a 801 passa a responder na 3ª rodada; as outras desistem depois de 5 tentativas */
  await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 50 }); m.xml[801] = XML([K(1)]); m.idas.length = 0;
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 50 });
  assert.deepStrictEqual([m.detalhes(), m.arq().notas[801], m.arq().notas[802].tentativas, m.ind.devolucaoDe(K(1))], [['/nfe/801', '/nfe/802', '/nfe/803', '/nfe/804'], { numero: '13801', visto_em: new Date(AGORA).toISOString(), refs: [K(1)] }, 3, { id: '801', numero: '13801' }]);
  await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler }); await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler }); m.idas.length = 0;
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler });
  assert.deepStrictEqual([m.arq().notas[802].tentativas, m.detalhes(), r.novas], [I.TENTATIVAS_MAX, [], 0], 'depois de 5 tentativas, deixa de lado');
  /* orçamento por rodada; padrão 20; teto 200 */
  const muitas = () => { const o = { listas: { '5:1': [] }, det: {}, xml: {} }; for (let i = 1; i <= 30; i++) { o.listas['5:1'].push(N(900 + i)); o.det[900 + i] = D(900 + i); o.xml[900 + i] = XML([K(900 + i)]); } return o; };
  m = mundo(muitas()); r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 4 });
  assert.deepStrictEqual([r.lidas, r.ficaram_pra_proxima, m.detalhes().length, Object.keys(m.arq().notas).length], [4, 26, 4, 4]);
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 4 }); assert.deepStrictEqual([r.novas, r.lidas, r.ficaram_pra_proxima, Object.keys(m.arq().notas).length], [26, 4, 22, 8], 'a rodada seguinte continua de onde parou');
  m = mundo(muitas()); r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler }); assert.deepStrictEqual([r.lidas, r.ficaram_pra_proxima], [20, 10]);
  for (const torto of [0, -3, 'x', null]) { m = mundo(muitas()); r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: torto }); assert.strictEqual(r.lidas, 20, 'leituras ' + torto); }
  /* a lista: paginação, falha, prazo */
  { const cheia = (b2) => Array.from({ length: 100 }, (_, i) => N(b2 + i)); const l = {}; for (let p = 1; p <= 8; p++) l['5:' + p] = cheia(p * 1000); m = mundo({ listas: l }); r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler, leituras: 1 });
    assert.deepStrictEqual([r.listadas, m.idas.filter((c) => /situacao=5/.test(c)).length], [500, 5], 'até 5 páginas por situação'); }
  for (const ruim of ['FALHA', 'ESTOURA']) { m = mundo(Object.assign(BASE(), {})); m.listas['5:1'] = ruim; r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler });
    assert.deepStrictEqual([r.ok, /situação 5, página 1/.test(r.lista_incompleta), r.listadas, m.idas.filter((c) => /^\/nfe\?/.test(c)).length], [true, true, 2, 3], ruim + ': diz, e segue pras outras situações'); }
  m = mundo(BASE()); m.listas['5:1'] = 'PRAZO'; r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler });
  assert.deepStrictEqual([r.parou_no_prazo, /passou do prazo/.test(r.lista_incompleta), m.idas.length, r.listadas], [true, true, 1, 0], 'o Bling preso: para tudo');
  m = mundo(BASE()); m.det[801] = 'PRAZO'; r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler });
  assert.deepStrictEqual([r.parou_no_prazo, m.detalhes(), r.ficaram_pra_proxima, m.arq().notas[801].motivo], [true, ['/nfe/801'], 3, 'detalhe_prazo']);
  /* a véspera atravessa a virada de mês e de ano; data impossível não vira consulta */
  m = mundo(BASE()); await m.ind.atualizar({ desde: '2026-11-01', ler: m.ler }); assert.ok(m.idas[0].includes('dataEmissaoInicial=2026-10-31&'));
  m = mundo(Object.assign(BASE(), { agora: Date.parse('2026-12-31T22:00:00-03:00') })); await m.ind.atualizar({ desde: '2026-01-01', ler: m.ler }); assert.ok(m.idas[0].includes('dataEmissaoInicial=2025-12-31&dataEmissaoFinal=2027-01-03&'));
  m = mundo(BASE()); assert.deepStrictEqual([await m.ind.atualizar({ desde: '2026-13-45', ler: m.ler }), m.idas.length], [{ ok: false, etapa: 'parametros' }, 0]);
  /* parâmetros tortos: não faz nada */
  for (const op of [null, {}, { desde: '20/11/2026', ler: async () => null }, { desde: '2026-11-20' }, { desde: '2026-11-20', ler: 'x' }]) { m = mundo(BASE()); assert.deepStrictEqual([await m.ind.atualizar(op), fs.existsSync(path.join(m.dir, I.ARQ))], [{ ok: false, etapa: 'parametros' }, false]); }
  /* nota com id torto na lista é ignorada; o registro esquece o que não vê há mais de 200 dias */
  m = mundo({ listas: { '5:1': [{ id: 'x' }, null, { numero: 1 }, N(801)] }, det: { 801: D(801) }, xml: { 801: XML([K(1)]) } });
  fs.writeFileSync(path.join(m.dir, I.ARQ), JSON.stringify({ notas: { 1: { refs: [K(50)], visto_em: new Date(AGORA - 201 * 864e5).toISOString() }, 2: { refs: [K(51)], visto_em: new Date(AGORA - 199 * 864e5).toISOString() }, 3: { refs: [K(52)] } } }));
  r = await m.ind.atualizar({ desde: '2026-11-20', ler: m.ler }); assert.deepStrictEqual([r.listadas, Object.keys(m.arq().notas)], [1, ['2', '801']]);
  assert.throws(() => I.criar({}), /falta cacheDir/); assert.throws(() => I.criar(null), /falta cacheDir/);

  /* ═══ D. a vigia confronta ═══ */
  const NFV = (id, extra) => Object.assign({ id, numero: '13' + id, situacao: 5, dataEmissao: '2026-11-25 10:00:00', loja: { id: 201 }, chaveAcesso: K(id) }, extra || {});
  const cena = (op) => {
    op = op || {};
    const dir = pasta(); let t = AGORA;
    const cx = { dir, idas: [], pedidos: op.pedidos || [1, 2, 3], nfe: op.nfe || { 901: NFV(901, { dataEmissao: '2026-11-24 09:00:00' }), 902: NFV(902), 903: NFV(903, { chaveAcesso: null }) }, entradas: op.entradas === undefined ? [N(801)] : op.entradas, det: { 801: D(801, { situacao: 5 }) }, xml: { 801: XML([K(901)]) }, passa: (ms) => { t += ms; } };
    const blingGet = async (c) => { cx.idas.push(c);
      if (/^\/pedidos\/vendas\?/.test(c)) return { ok: true, status: 200, data: { data: cx.pedidos.map((n) => ({ id: n, numero: 1000 + n, numeroLoja: 'L' + n, data: '2026-11-25', loja: { id: 201 } })) } };
      const mp = /^\/pedidos\/vendas\/(\d+)$/.exec(c); if (mp) return { ok: true, status: 200, data: { data: { id: Number(mp[1]), notaFiscal: { id: 900 + Number(mp[1]) } } } };
      if (/^\/nfe\?tipo=0&situacao=5/.test(c)) { if (op.listaEstoura) throw new Error('rede'); return { ok: true, status: 200, data: { data: cx.entradas } }; }
      if (/^\/nfe\?/.test(c)) return { ok: true, status: 200, data: { data: [] } };
      const mn = /^\/nfe\/(\d+)$/.exec(c); const d = cx.nfe[mn[1]] || cx.det[mn[1]]; return d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: 404, data: null }; };
    cx.fetch = async (u) => { const id = /x=(\d+)$/.exec(u)[1]; return cx.xml[id] ? { ok: true, status: 200, text: async () => cx.xml[id] } : { ok: false, status: 404, text: async () => '' }; };
    cx.indice = op.semIndice ? undefined : (op.indice || I.criar({ cacheDir: dir, fetch: cx.fetch, agora: () => t }));
    if (cx.indice && cx.indice.devolucoesDe) cx.indice.devolucaoDe = (k) => cx.indice.devolucoesDe(k)[0] || null;
    const bg = op.pendura ? (cam, tn, sg) => (op.pendura.test(cam) ? new Promise(() => {}) : blingGet(cam)) : blingGet;
    cx.vig = V.criar({ empresa: 'emp', cacheDir: dir, agora: () => t, prazoMs: op.pendura ? 25 : undefined, blingGet: bg, lerConferidos: () => ({}), garantirSitCancel: async () => ({ ids: [12] }), lojaMkt: { 201: 'ml' }, indiceDevolucoes: cx.indice });
    cx.reg = () => JSON.parse(fs.readFileSync(path.join(dir, V.ARQ), 'utf8'));
    return cx;
  };
  let c = cena(), rv = await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([rv.devolvidas, rv.nf_valendo, rv.indice_devolucoes.lidas, rv.indice_devolucoes.com_referencia], [1, 2, 1, 1]);
  assert.deepStrictEqual([c.reg().pedidos[1].estado, c.reg().pedidos[1].devolucao_id, c.reg().pedidos[1].devolucao_numero, c.reg().pedidos[1].devolvida_vista_em, c.reg().pedidos[1].nf_chave, c.reg().pedidos[2].estado, c.reg().pedidos[3].estado, c.reg().pedidos[3].nf_chave],
    ['devolvida', '801', '13801', new Date(AGORA).toISOString(), K(901), 'nf_valendo', 'nf_valendo', null]);
  assert.ok(c.idas.includes('/nfe?tipo=0&situacao=5&dataEmissaoInicial=2026-11-23&dataEmissaoFinal=2026-11-29&limite=100&pagina=1'), 'o índice é pedido desde a VÉSPERA da emissão mais antiga entre as notas em aberto com chave');
  let pe = c.vig.pendentes();
  assert.deepStrictEqual([pe.pendentes.map((x) => x.pedido_id), pe.devolvidas], [['2', '3'], [{ pedido_id: '1', numero: 1001, nf_numero: '13901', devolucao_id: '801', devolucao_numero: '13801' }]], 'saiu do aviso, e aparece na lista do que a vigia achou');
  /* devolvida é final: não é lida de novo; e some da lista do "achei" depois de 15 dias */
  c.idas.length = 0; c.passa(3600e3); rv = await c.vig.varrer({ dias: 3 });
  assert.deepStrictEqual([c.idas.includes('/nfe/901'), c.idas.includes('/pedidos/vendas/1'), rv.devolvidas, rv.ja_resolvidos, c.reg().pedidos[1].estado], [false, false, 0, 1, 'devolvida']);
  c.passa(15 * 864e5); assert.deepStrictEqual(c.vig.pendentes().devolvidas, []);
  /* a devolução aparece DEPOIS: na rodada em que entrar no índice, o pedido sai */
  c = cena({ entradas: [] }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], [0, ['1', '2', '3']]);
  c.entradas.push(N(801)); c.passa(1800e3); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, c.vig.pendentes().pendentes.map((x) => x.pedido_id)], [1, ['2', '3']]);
  /* a devolução é conferida NA HORA de dar baixa: cancelada depois (o índice ainda a tem), ilegível ou outra nota = o pedido FICA */
  for (const [agoraDev, rotulo] of [[D(801, { situacao: 2 }), 'cancelada'], [D(801, { situacao: { valor: 4 } }), 'rejeitada'], [null, 'não veio'], [D(555, { situacao: 5 }), 'outra nota'], [D(801, { situacao: null }), 'sem situação']]) {
    c = cena(); await c.indice.atualizar({ desde: '2026-11-20', ler: async (cam) => (/^\/nfe\?tipo=0&situacao=5/.test(cam) ? { ok: true, status: 200, data: { data: [N(801)] } } : (/^\/nfe\?/.test(cam) ? { ok: true, status: 200, data: { data: [] } } : { ok: true, status: 200, data: { data: D(801) } })) });
    assert.deepStrictEqual(c.indice.devolucaoDe(K(901)), { id: '801', numero: '13801' }, 'o índice já conhece a devolução');
    if (agoraDev) c.det[801] = agoraDev; else delete c.det[801];
    rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, rv.devolucao_nao_confirmada, c.reg().pedidos[1].estado, c.vig.pendentes().pendentes.length], [0, 1, 'nf_valendo', 3], rotulo); }
  c = cena(); c.det[801] = D(801, { situacao: { valor: 6 } }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, 'devolucao_nao_confirmada' in rv], [1, false]);
  /* Codex #1003: a 1ª devolução do índice foi cancelada e REFEITA — a vigia confere as candidatas e fica com a que vale */
  c = cena(); c.entradas.push(N(802)); c.det[801] = D(801, { situacao: 2 }); c.det[802] = D(802, { situacao: 6 }); c.xml[802] = XML([K(901)]);
  rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, c.reg().pedidos[1].devolucao_id, c.reg().pedidos[1].devolucao_numero, 'devolucao_nao_confirmada' in rv], [1, '802', '13802', false]);
  /* a nota que confere tem que ser de ENTRADA */
  c = cena(); c.det[801] = D(801, { situacao: 5, tipo: 1 }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, rv.devolucao_nao_confirmada], [0, 1]);
  /* Codex #1003 (P1): nota de entrada que cita a venda mas NÃO é devolução não tira ninguém do aviso */
  c = cena(); c.xml[801] = XML([K(901)], 1); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, c.reg().pedidos[1].estado, c.vig.pendentes().pendentes.length], [0, 'nf_valendo', 3]);
  /* Codex #1003: prazo estourado no ÍNDICE — nenhuma conferência é tentada nessa rodada */
  { const conf = []; c = cena({ indice: { atualizar: async () => ({ ok: true, parou_no_prazo: true }), devolucoesDe: (k) => { conf.push(k); return [{ id: '801', numero: '1' }]; } } });
    rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([conf, rv.parou_no_prazo, rv.devolvidas, c.idas.includes('/nfe/801')], [[], true, 0, false]); }
  /* Codex #1003: prazo estourado numa CONFERÊNCIA — para ali; os outros pedidos ficam pra próxima */
  { const conf = []; c = cena({ pendura: /^\/nfe\/801$/, indice: { atualizar: async () => ({ ok: true }), devolucoesDe: (k) => { conf.push(k); return [{ id: '801', numero: '1' }, { id: '802', numero: '2' }]; } } });
    rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([conf, rv.parou_no_prazo, rv.devolvidas, c.vig.emAndamento()], [[K(901)], true, 0, false], 'uma conferência pendurada: uma só espera'); }
  /* Codex #1003 (2ª rodada): as conferências têm ORÇAMENTO por rodada (10 leituras), rodam entre os pedidos, e a candidata
     vista CANCELADA não é lida de novo */
  { const peds = Array.from({ length: 14 }, (_, i) => i + 1), nfe = {}, det = {};
    for (const n of peds) { nfe[900 + n] = NFV(900 + n); det[800 + n] = D(800 + n, { situacao: 2 }); }
    const lidas = () => c.idas.filter((x) => /^\/nfe\/8\d\d$/.test(x));
    c = cena({ pedidos: peds, nfe, indice: { atualizar: async () => ({ ok: true }), devolucoesDe: (k) => [{ id: String(800 + Number(k.slice(28, 34)) - 900), numero: 'n' }] } });
    Object.assign(c.det, det); delete c.det[801]; c.det[801] = D(801, { situacao: 2 });
    rv = await c.vig.varrer({ dias: 3, leituras: 100 });
    assert.deepStrictEqual([lidas().length, rv.devolucao_nao_confirmada, rv.conferencias_pra_proxima, rv.devolvidas], [10, 10, 4, 0], 'no máximo 10 conferências por rodada; o resto fica pra próxima');
    assert.deepStrictEqual([c.reg().pedidos[1].dev_recusadas, c.reg().pedidos[1].dev_conferido_em, 'dev_conferido_em' in c.reg().pedidos[11]], [['801'], new Date(AGORA).toISOString(), false]);
    /* a rodada seguinte: os 4 que ficaram são conferidos; os 10 já vistos cancelados NÃO são lidos de novo (mesmo com o pedido relido) */
    c.idas.length = 0; c.passa(1800e3); rv = await c.vig.varrer({ dias: 3, leituras: 100 });
    assert.deepStrictEqual([lidas().sort(), rv.conferencias_pra_proxima, c.reg().pedidos[1].dev_recusadas, c.idas.includes('/nfe/901')], [['/nfe/811', '/nfe/812', '/nfe/813', '/nfe/814'], undefined, ['801'], true]);
    c.idas.length = 0; c.passa(1800e3); rv = await c.vig.varrer({ dias: 3, leituras: 100 }); assert.deepStrictEqual([lidas(), rv.devolucao_nao_confirmada], [[], undefined], 'tudo visto cancelado: nenhuma leitura de conferência');
    /* a devolução foi REFEITA (candidata nova): só ela é lida, e dá baixa */
    c.indice.devolucoesDe = (k) => (k === K(901) ? [{ id: '801', numero: 'n' }, { id: '899', numero: '13899' }] : []); c.det[899] = D(899, { situacao: 5 });
    c.idas.length = 0; c.passa(1800e3); rv = await c.vig.varrer({ dias: 3, leituras: 100 });
    assert.deepStrictEqual([c.idas.filter((x) => /^\/nfe\/8/.test(x)), rv.devolvidas, c.reg().pedidos[1].devolucao_numero], [['/nfe/899'], 1, '13899']);
    /* a vez roda: com candidatas que só "não vêm" (falha de leitura não é recusa), quem foi conferido há mais tempo vai primeiro */
    c = cena({ pedidos: peds, nfe, indice: { atualizar: async () => ({ ok: true }), devolucoesDe: (k) => [{ id: String(800 + Number(k.slice(28, 34)) - 900), numero: 'n' }] } }); delete c.det[801];
    await c.vig.varrer({ dias: 3, leituras: 100 }); const primeira = lidas(); c.idas.length = 0; c.passa(1800e3); await c.vig.varrer({ dias: 3, leituras: 100 }); const segunda = lidas();
    assert.deepStrictEqual([primeira.length, segunda.length, segunda.slice(0, 4), segunda.slice(4).every((x) => primeira.includes(x)), 'dev_recusadas' in c.reg().pedidos[1]], [10, 10, ['/nfe/811', '/nfe/812', '/nfe/813', '/nfe/814'], true, false], 'os 4 que ficaram de fora vão primeiro; depois os mais antigos'); }
  /* devolução que referencia OUTRA venda não tira ninguém */
  c = cena(); c.xml[801] = XML([K(555)]); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, c.vig.pendentes().pendentes.length], [0, 3]);
  /* sem o índice (empresa que não o passa): a vigia segue como era */
  c = cena({ semIndice: true }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, 'indice_devolucoes' in rv, c.idas.some((x) => /^\/nfe\?/.test(x))], [0, false, false]);
  /* o índice falhando (lista fora, exceção, resposta torta): nada muda, e a rodada termina */
  c = cena({ listaEstoura: true }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.ok, rv.devolvidas, c.vig.pendentes().pendentes.length, /situação 5/.test(rv.indice_devolucoes.lista_incompleta)], [true, 0, 3, true]);
  c = cena({ indice: { atualizar: async () => { throw new Error('x'); }, devolucoesDe: () => { throw new Error('y'); } } }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.ok, rv.devolvidas, rv.indice_devolucoes, c.vig.pendentes().pendentes.length], [true, 0, { ok: false, etapa: 'erro' }, 3]);
  c = cena({ indice: { atualizar: async () => null, devolucoesDe: () => [{ numero: 'sem id' }, null, { id: 'x;y' }] } }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.devolvidas, rv.indice_devolucoes, rv.devolucao_nao_confirmada, c.idas.some((x) => /undefined|x;y/.test(x))], [0, { ok: false }, undefined, false], 'candidata sem id ou com id torto nem é consultada');
  /* o Bling preso (uma leitura estourou o prazo): a rodada para — e o índice NÃO é consultado nessa rodada */
  c = cena({ pendura: /^\/nfe\/903$/ }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([rv.parou_no_prazo, c.idas.some((x) => /^\/nfe\?/.test(x)), 'indice_devolucoes' in rv, rv.devolvidas], [true, false, false, 0]);
  /* ninguém em aberto com chave: o índice nem é consultado (não gasta cota) */
  c = cena({ pedidos: [3] }); rv = await c.vig.varrer({ dias: 3 }); assert.deepStrictEqual([c.idas.some((x) => /^\/nfe\?/.test(x)), 'indice_devolucoes' in rv], [false, false]);
  /* chave torta na nota de venda não é guardada */
  c = cena({ pedidos: [1], nfe: { 901: NFV(901, { chaveAcesso: '1234' }) } }); await c.vig.varrer({ dias: 3 }); assert.strictEqual(c.reg().pedidos[1].nf_chave, null);
  c = cena({ pedidos: [1], nfe: { 901: NFV(901, { chaveAcesso: K(901).replace(/(\d{4})/g, '$1 ') }) } }); await c.vig.varrer({ dias: 3 }); assert.strictEqual(c.reg().pedidos[1].nf_chave, K(901), 'chave com máscara é guardada só com os dígitos');
  /* a fábrica liga o índice na vigia, na pasta da empresa */
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8').includes("indiceDevolucoes: require('./devolucoes-indice').criar({ cacheDir: CACHE_DIR }),"));
  _chegou = true;
  console.log('ok — índice das devoluções: lê do XML da nota de entrada a nota de venda que ela devolve (só host do Bling, sem redirecionar, só NF-e inteira), cada nota uma vez, falha nunca é "não referencia"; a vigia tira sozinha do aviso o pedido cuja nota já foi devolvida e mostra o número da devolução');
})().catch((e) => { console.error('FALHOU:', (e && e.stack) || e); process.exit(1); });
