'use strict';
/* 26/11 — COMPRAS: LANÇAR O PEDIDO DE COMPRA NO BLING A PARTIR DOS ITENS MARCADOS NO PLANO.

   O que se prova:
   A. os fornecedores (lib/checkout/compras-lancar): só os contatos do tipo "Fornecedor", paginados, em ordem; guardados
      10 min (falha 1 min); pedidos juntos dividem a leitura; falha e prazo viram motivo, nunca lista vazia "boa";
   B. a conferência (montar): tudo ou nada — fornecedor da lista, data que existe e não passou, quantidade inteira > 0,
      SKU com cadastro, sem repetição; o corpo é o espelho do que o Bling devolve num pedido; item sem custo vai com 0 e
      é AVISADO;
   C. o envio (lancar): UMA tentativa, sem repetir em rede; criado / recusado (com a validação do Bling) / "não sei";
      a chave da tela impede dois pedidos; recusa clara libera a chave; "não sei" e "criado" a deixam gasta;
   D. as ROTAS na fábrica de verdade, nas três empresas: só admin; o ensaio não escreve no Bling; pedido criado derruba
      a leitura guardada do "a caminho". */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CL = require('../lib/checkout/compras-lancar');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const ok = (lista) => ({ ok: true, status: 200, data: { data: lista } });
const TIPOS = [{ id: 11, descricao: 'Cliente' }, { id: 77, descricao: 'FORNECEDÓR' }, { id: 78, descricao: 'Fornecedor 2' }];
const FORN = [{ id: 502, nome: '  Zeta   Comércio ' }, { id: 501, nome: 'Álfa Import' }, { id: 'x', nome: 'torto' }, null, { id: 503, nome: '' }, { id: 504, nome: 'beta ltda', numeroDocumento: '12345678000199', telefone: '11999990000' }];
const CAD = () => ({ A1: { id: 9001, nome: 'Abajur  de mesa' }, B2: { id: '9002', nome: '' }, C3: { id: 9003, nome: 'Cubo' }, SEMID: { nome: 'x' }, TORTO: { id: 'abc' } });
const CUS = () => ({ A1: { custo: 12.345 }, B2: { custo: '7' }, C3: { custo: null }, D4: { custo: 5 } });

function mundo(op) {
  op = op || {};
  const m = { gets: [], posts: [], agora: Date.parse('2026-11-26T12:00:00Z'), criados: [], emVoo: 0, pico: 0 };
  m.respGet = op.respGet || ((c) => (c === '/contatos/tipos' ? ok(TIPOS) : ok(FORN)));
  m.respPost = op.respPost || (() => ({ ok: true, status: 201, data: { data: { id: 16300001234, numero: 7 } } }));
  m.peca = CL.criar({ agora: () => m.agora, hojeSP: () => '2026-11-26', prazoMs: op.prazoMs,
    blingGet: async (c, n, sinal) => { m.gets.push(c); m.argsGet = [n, !!(sinal && typeof sinal.addEventListener === 'function')]; m.emVoo++; m.pico = Math.max(m.pico, m.emVoo); await new Promise((r) => setImmediate(r)); m.emVoo--; const r = m.respGet(c, sinal); if (r instanceof Error) throw r; return r; },
    blingWrite: async (metodo, c, corpo, opc) => { m.posts.push({ metodo, c, corpo: JSON.parse(JSON.stringify(corpo)), opc: { semRetryDeRede: opc && opc.semRetryDeRede, sinal: !!(opc && opc.signal) } }); const r = m.respPost(corpo, opc); if (r instanceof Error) throw r; return r; },
    cadastro: op.cadastro || CAD, custos: op.custos || CUS, aoCriar: (r) => { m.criados.push(r); if (op.aoCriarEstoura) throw new Error('x'); } });
  return m;
}
const PED = (o) => Object.assign({ fornecedor: '501', data_prevista: '2027-02-28', itens: [{ sku: 'A1', quantidade: 100 }, { sku: 'B2', quantidade: 3 }] }, o || {});

(async () => {
  assert.throws(() => CL.criar({}), /falta blingGet/);
  assert.throws(() => CL.criar({ blingGet() {}, blingWrite() {}, cadastro() {} }), /falta custos/);
  assert.deepStrictEqual([CL.MAX_ITENS, CL.MAX_QTD, CL.PRAZO_MS, CL.POR_PAGINA, CL.MAX_PAGINAS], [300, 1000000, 45000, 100, 5]);

  /* ═══ A. os fornecedores ═══ */
  {
    let m = mundo();
    const [f1, f2] = await Promise.all([m.peca.fornecedores(), m.peca.fornecedores()]);
    assert.deepStrictEqual(m.gets, ['/contatos/tipos', '/contatos?pagina=1&limite=100&idTipoContato=77'], 'os tipos e a lista do tipo Fornecedor (o primeiro que casa, sem acento nem caixa); pedidos juntos = uma leitura');
    assert.deepStrictEqual([m.argsGet, m.pico], [[3, true], 1], 'com o sinal de cancelamento; uma chamada de cada vez');
    assert.strictEqual(f1, f2);
    assert.deepStrictEqual(f1, { ok: true, lista: [{ id: '501', nome: 'Álfa Import' }, { id: '504', nome: 'beta ltda' }, { id: '502', nome: 'Zeta Comércio' }], incompleto: false, lido_em: '2026-11-26T12:00:00.000Z' }, 'id e nome, em ordem alfabética sem acento; sem nome, sem id ou torto fica fora');
    assert.ok(!/12345678000199|11999990000/.test(JSON.stringify(f1)), 'só id e nome saem — documento e telefone não');
    /* guardado 10 min; `forcar` lê de novo */
    m.agora += 10 * 60000 - 1; await m.peca.fornecedores(); assert.strictEqual(m.gets.length, 2, 'dentro de 10 min não relê');
    m.agora += 1; await m.peca.fornecedores(); assert.strictEqual(m.gets.length, 4, 'com 10 min relê');
    await m.peca.fornecedores(true); assert.strictEqual(m.gets.length, 6, 'forçado relê na hora');
    /* paginação: página cheia pede a seguinte; teto de 5 páginas marca incompleto; id repetido não duplica */
    const cheia = (base) => Array.from({ length: 100 }, (_, n) => ({ id: base + n, nome: 'F' + (base + n) }));
    m = mundo({ respGet: (c) => (c === '/contatos/tipos' ? ok(TIPOS) : /pagina=1&/.test(c) ? ok(cheia(1000)) : /pagina=2&/.test(c) ? ok(cheia(1050).slice(0, 60)) : ok([])) });
    let f = await m.peca.fornecedores();
    assert.deepStrictEqual([m.gets.length, f.lista.length, f.incompleto], [3, 110, false], 'duas páginas, 110 fornecedores distintos');
    m = mundo({ respGet: (c) => (c === '/contatos/tipos' ? ok(TIPOS) : ok(cheia(Number(/pagina=(\d+)/.exec(c)[1]) * 1000))) });
    f = await m.peca.fornecedores();
    assert.deepStrictEqual([m.gets.length, f.lista.length, f.incompleto], [6, 500, true], 'cinco páginas cheias: para e avisa que pode haver mais');
    /* falhas: motivo, nunca lista vazia "boa"; guardada só 1 min */
    for (const [resp, motivo] of [
      [(c) => (c === '/contatos/tipos' ? { ok: false, status: 429, limite: true } : ok(FORN)), 'não consegui ler os tipos de contato do Bling — tente de novo'],
      [(c) => (c === '/contatos/tipos' ? ok([{ id: 1, descricao: 'Cliente' }]) : ok(FORN)), 'o Bling desta empresa não tem o tipo de contato "Fornecedor"'],
      [(c) => (c === '/contatos/tipos' ? ok(TIPOS) : { ok: true, status: 200, data: { data: 'torto' } }), 'não consegui ler os fornecedores do Bling — tente de novo'],
      [(c) => (c === '/contatos/tipos' ? ok(TIPOS) : new Error('rede')), 'não consegui ler os fornecedores do Bling — tente de novo'],
      [(c) => (c === '/contatos/tipos' ? ok(TIPOS) : ok([{ id: 9, nome: '' }])), 'nenhum contato do tipo "Fornecedor" no Bling desta empresa — cadastre o fornecedor lá'],
      [(c) => (c === '/contatos/tipos' ? ok(TIPOS) : /pagina=1&/.test(c) ? ok(cheia(1)) : { ok: false, status: 500 }), 'não consegui ler os fornecedores do Bling — tente de novo']]) {
      m = mundo({ respGet: resp });
      f = await m.peca.fornecedores();
      assert.deepStrictEqual([f.ok, f.motivo, 'lista' in f], [false, motivo, false]);
      const n = m.gets.length; m.agora += 59999; await m.peca.fornecedores(); assert.strictEqual(m.gets.length, n, 'falha guardada por 1 min');
      m.agora += 1; await m.peca.fornecedores(); assert.ok(m.gets.length > n, 'depois de 1 min tenta de novo');
    }
    /* prazo: a leitura pendurada é cancelada */
    let sinal = null;
    m = mundo({ prazoMs: 50, respGet: (c, s) => { sinal = s; return ok(TIPOS); } });
    m.peca = CL.criar({ prazoMs: 50, agora: () => m.agora, blingGet: (c, n, s) => { sinal = s; return new Promise(() => {}); }, blingWrite: async () => ({}), cadastro: CAD, custos: CUS });
    f = await m.peca.fornecedores();
    assert.deepStrictEqual([f.ok, f.motivo, sinal.aborted], [false, 'o Bling não respondeu em 0 s — tente de novo', true]);
  }

  /* ═══ B. a conferência ═══ */
  {
    const m = mundo();
    let r = await m.peca.montar(PED());
    assert.deepStrictEqual(r, { ok: true,
      corpo: { data: '2026-11-26', fornecedor: { id: 501 }, itens: [{ produto: { id: 9001 }, descricao: 'Abajur de mesa', quantidade: 100, valor: 12.35 }, { produto: { id: 9002 }, descricao: 'B2', quantidade: 3, valor: 7 }], dataPrevista: '2027-02-28' },
      resumo: { fornecedor: 'Álfa Import', data_prevista: '2027-02-28', itens: 2, unidades: 103, total: 1256, sem_custo: [] } }, JSON.stringify(r));
    assert.strictEqual(m.posts.length, 0, 'conferir não escreve no Bling');
    /* sem data prevista: o campo não vai; item sem custo: valor 0 e avisado */
    r = await m.peca.montar(PED({ data_prevista: '  ', itens: [{ sku: 'C3', quantidade: '5' }, { sku: 'A1', quantidade: 1 }] }));
    assert.deepStrictEqual([r.ok, 'dataPrevista' in r.corpo, r.corpo.itens[0], r.resumo], [true, false, { produto: { id: 9003 }, descricao: 'Cubo', quantidade: 5, valor: 0 },
      { fornecedor: 'Álfa Import', data_prevista: null, itens: 2, unidades: 6, total: 12.35, sem_custo: ['C3'] }]);
    for (const dp of [null, undefined, '']) assert.strictEqual((await m.peca.montar(PED({ data_prevista: dp }))).resumo.data_prevista, null);
    assert.strictEqual((await m.peca.montar(PED({ data_prevista: '2026-11-26' }))).ok, true, 'hoje vale');
    assert.strictEqual((await m.peca.montar(PED({ fornecedor: 504 }))).corpo.fornecedor.id, 504, 'o id pode vir como número');
    /* custo zero, negativo, vazio ou torto = sem custo (nunca um preço inventado) */
    for (const cu of [0, -3, '', 'abc', undefined]) {
      const m2 = mundo({ custos: () => ({ A1: { custo: cu } }) });
      const r2 = await m2.peca.montar(PED({ itens: [{ sku: 'A1', quantidade: 2 }] }));
      assert.deepStrictEqual([r2.corpo.itens[0].valor, r2.resumo.sem_custo, r2.resumo.total], [0, ['A1'], 0], 'custo ' + JSON.stringify(cu));
    }
    /* as recusas — cada uma com o motivo, e SEM corpo */
    const erros = async (p) => { const x = await m.peca.montar(p); assert.ok(x.ok === false && !('corpo' in x), JSON.stringify(x)); return x.erros; };
    assert.deepStrictEqual(await erros(PED({ fornecedor: '' })), ['escolha o fornecedor']);
    for (const fo of [null, undefined, 'abc', '0', -1, {}, '5 ', '501; drop']) assert.deepStrictEqual(await erros(PED({ fornecedor: fo })), ['escolha o fornecedor'], JSON.stringify(fo));
    assert.deepStrictEqual(await erros(PED({ fornecedor: '999' })), ['o fornecedor escolhido não está entre os fornecedores do Bling desta empresa']);
    assert.deepStrictEqual(await erros(PED({ data_prevista: '2027-02-30' })), ['a data prevista não é uma data válida']);
    assert.deepStrictEqual(await erros(PED({ data_prevista: '28/02/2027' })), ['a data prevista não é uma data válida']);
    assert.deepStrictEqual(await erros(PED({ data_prevista: '2026-11-25' })), ['a data prevista já passou']);
    assert.deepStrictEqual(await erros(PED({ itens: [] })), ['nenhum item no pedido']);
    assert.deepStrictEqual(await erros(PED({ itens: 'x' })), ['nenhum item no pedido']);
    for (const q of [0, -1, 1.5, '', null, undefined, 'abc', 1000001, NaN, Infinity]) assert.deepStrictEqual(await erros(PED({ itens: [{ sku: 'A1', quantidade: q }] })), ['a quantidade do SKU "A1" tem de ser um número inteiro maior que zero'], JSON.stringify(q));
    assert.strictEqual((await m.peca.montar(PED({ itens: [{ sku: 'A1', quantidade: 1000000 }] }))).ok, true, 'o teto de quantidade vale');
    assert.deepStrictEqual(await erros(PED({ itens: [{ sku: 'A1', quantidade: 1 }, { sku: 'A1', quantidade: 2 }] })), ['o SKU "A1" aparece mais de uma vez']);
    for (const sk of ['NAOEXISTE', 'SEMID', 'TORTO', 'constructor', '__proto__']) assert.deepStrictEqual(await erros(PED({ itens: [{ sku: sk, quantidade: 1 }] })), ['o SKU "' + sk + '" não tem o cadastro do Bling guardado — recalcule o plano e tente de novo']);
    assert.deepStrictEqual(await erros(PED({ itens: [{ quantidade: 1 }, null, { sku: '', quantidade: 2 }] })), ['há um item sem SKU', 'há um item sem SKU', 'há um item sem SKU']);
    /* vários problemas saem juntos; um item ruim recusa o pedido INTEIRO */
    assert.deepStrictEqual(await erros({ fornecedor: '', data_prevista: 'x', itens: [{ sku: 'A1', quantidade: 5 }, { sku: 'ZZ', quantidade: 1 }] }),
      ['escolha o fornecedor', 'a data prevista não é uma data válida', 'o SKU "ZZ" não tem o cadastro do Bling guardado — recalcule o plano e tente de novo']);
    for (const torto of [null, undefined, 'x', 7]) assert.deepStrictEqual(await erros(torto), ['escolha o fornecedor', 'nenhum item no pedido']);
    /* mais de 300 itens */
    const mG = mundo({ cadastro: () => { const c = {}; for (let n = 0; n < 301; n++) c['S' + n] = { id: 1 + n }; return c; } });
    const muitos = Array.from({ length: 301 }, (_, n) => ({ sku: 'S' + n, quantidade: 1 }));
    assert.deepStrictEqual((await mG.peca.montar(PED({ itens: muitos }))).erros, ['o pedido tem 301 itens — o máximo é 300 por pedido']);
    assert.strictEqual((await mG.peca.montar(PED({ itens: muitos.slice(0, 300) }))).resumo.itens, 300);
    /* sem conseguir ler os fornecedores, não confere (e diz por quê) */
    const mF = mundo({ respGet: () => ({ ok: false, status: 500 }) });
    assert.deepStrictEqual((await mF.peca.montar(PED())).erros, ['não consegui conferir o fornecedor: não consegui ler os tipos de contato do Bling — tente de novo']);
  }

  /* ═══ C. o envio ═══ */
  {
    let m = mundo();
    let r = await m.peca.lancar(PED(), 'chave-0001');
    assert.deepStrictEqual(r, { ok: true, id: '16300001234', numero: 7, resumo: { fornecedor: 'Álfa Import', data_prevista: '2027-02-28', itens: 2, unidades: 103, total: 1256, sem_custo: [] } });
    assert.deepStrictEqual(m.posts, [{ metodo: 'POST', c: '/pedidos/compras', corpo: { data: '2026-11-26', fornecedor: { id: 501 }, itens: [{ produto: { id: 9001 }, descricao: 'Abajur de mesa', quantidade: 100, valor: 12.35 }, { produto: { id: 9002 }, descricao: 'B2', quantidade: 3, valor: 7 }], dataPrevista: '2027-02-28' }, opc: { semRetryDeRede: true, sinal: true } }], 'UM POST, sem repetição em rede, com prazo');
    assert.deepStrictEqual(m.criados.length, 1, 'avisa quem guarda o "a caminho"');
    /* a mesma chave de novo: não cria outro — devolve o de antes */
    r = await m.peca.lancar(PED(), 'chave-0001');
    assert.deepStrictEqual([r.ok, r.repetido, r.anterior.id, m.posts.length], [false, true, '16300001234', 1]);
    /* Codex #990 — OUTRA chave (outra aba, outro computador, página recarregada) com o MESMO pedido: não cria outro;
       diz o que houve com o anterior. A data prevista diferente não faz dele outro pedido; a ordem dos itens também não. */
    m.agora += 7 * 60000;
    for (const igual of [PED(), PED({ data_prevista: '2027-05-05' }), PED({ data_prevista: '' }), PED({ itens: [{ sku: 'B2', quantidade: 3 }, { sku: 'A1', quantidade: 100 }] }), PED({ fornecedor: 501 })]) {
      r = await m.peca.lancar(igual, 'chave-0002');
      assert.deepStrictEqual([r, m.posts.length], [{ ok: false, igual_recente: true, estado: 'criado', numero: 7, ha_minutos: 7 }, 1], JSON.stringify(igual));
    }
    /* pedido DIFERENTE (quantidade, item ou fornecedor) passa normalmente */
    assert.strictEqual((await m.peca.lancar(PED({ itens: [{ sku: 'A1', quantidade: 101 }, { sku: 'B2', quantidade: 3 }] }), 'chave-dif-1')).ok, true);
    assert.strictEqual((await m.peca.lancar(PED({ itens: [{ sku: 'A1', quantidade: 100 }] }), 'chave-dif-2')).ok, true);
    assert.strictEqual((await m.peca.lancar(PED({ fornecedor: '502' }), 'chave-dif-3')).ok, true);
    assert.strictEqual(m.posts.length, 4);
    /* só a confirmação explícita cria outro IGUAL — e `repetir` tem de ser true de verdade */
    for (const rp of ['true', 1, 'sim', null]) { r = await m.peca.lancar(Object.assign(PED(), { repetir: rp }), 'chave-0002'); assert.deepStrictEqual([r.igual_recente, m.posts.length], [true, 4], JSON.stringify(rp)); }
    r = await m.peca.lancar(Object.assign(PED(), { repetir: true }), 'chave-0002');
    assert.deepStrictEqual([r.ok, m.posts.length], [true, 5], 'com a confirmação, cria');
    /* a chave e a lembrança do pedido igual vencem em 6 h */
    m.agora += 6 * 3600000; r = await m.peca.lancar(PED(), 'chave-0001'); assert.deepStrictEqual([r.ok, m.posts.length], [true, 6]);
    /* sem chave boa: nada vai */
    for (const ch of [undefined, null, '', 'curta', 'com espaço aqui', 12345678, 'x'.repeat(81)]) { r = await m.peca.lancar(PED(), ch); assert.deepStrictEqual([r.ok, r.erros, m.posts.length], [false, ['pedido sem a chave de envio — recarregue a tela e tente de novo'], 6], JSON.stringify(ch)); }
    /* o aviso de quem guarda o "a caminho" estourar não estraga o resultado */
    m = mundo({ aoCriarEstoura: true }); r = await m.peca.lancar(PED(), 'chave-0003'); assert.strictEqual(r.ok, true);
    /* número ausente ou torto: o id basta */
    m = mundo({ respPost: () => ({ ok: true, status: 201, data: { data: { id: 55 } } }) }); r = await m.peca.lancar(PED(), 'chave-0004'); assert.deepStrictEqual([r.ok, r.id, r.numero], [true, '55', null]);

    /* não passou na conferência: nada é enviado, e a chave continua valendo */
    m = mundo(); r = await m.peca.lancar(PED({ fornecedor: '999' }), 'chave-0010');
    assert.deepStrictEqual([r, m.posts.length], [{ ok: false, erros: ['o fornecedor escolhido não está entre os fornecedores do Bling desta empresa'] }, 0]);
    r = await m.peca.lancar(PED(), 'chave-0010'); assert.strictEqual(r.ok, true, 'corrigiu e reenviou com a mesma chave');

    /* clique duplo: o segundo, com o primeiro ainda indo, não envia */
    let soltar = null;
    m = mundo({ respPost: () => new Error('nunca') });
    m.peca = CL.criar({ agora: () => m.agora, hojeSP: () => '2026-11-26', blingGet: async (c) => m.respGet(c), cadastro: CAD, custos: CUS,
      blingWrite: (a, b, corpo) => { m.posts.push(corpo); return new Promise((okk) => { soltar = () => okk({ ok: true, status: 201, data: { data: { id: 8, numero: 2 } } }); }); } });
    const p1 = m.peca.lancar(PED(), 'chave-0020');
    for (let i = 0; i < 20; i++) await new Promise((x) => setImmediate(x));
    assert.deepStrictEqual(await m.peca.lancar(PED(), 'chave-0020'), { ok: false, em_andamento: true });
    soltar(); assert.strictEqual((await p1).ok, true); assert.strictEqual(m.posts.length, 1, 'um POST só');

    /* o Bling RECUSOU (4xx): nada criado; a validação do Bling vai pra tela, aparada; a chave volta a valer */
    const recusa = { ok: false, status: 400, data: { error: { type: 'VALIDATION_ERROR', message: 'Não foi possível salvar o pedido', description: 'Os dados   enviados são inválidos', fields: [{ code: 1, msg: 'O campo  valor é obrigatório', element: 'itens[0].valor', namespace: 'PEDIDO' }, { msg: 'x'.repeat(400), namespace: 'N' }, null, 'torto', {}] } } };
    m = mundo({ respPost: () => recusa }); r = await m.peca.lancar(PED(), 'chave-0030');
    assert.deepStrictEqual(r, { ok: false, recusado: true, status: 400, motivo: 'o Bling recusou o pedido (400)', bling: { tipo: 'VALIDATION_ERROR', mensagem: 'Não foi possível salvar o pedido', descricao: 'Os dados enviados são inválidos', campos: [{ campo: 'itens[0].valor', msg: 'O campo valor é obrigatório' }, { campo: 'N', msg: 'x'.repeat(200) }] } });
    assert.strictEqual(m.criados.length, 0);
    m.respPost = () => ({ ok: true, status: 201, data: { data: { id: 9, numero: 3 } } });
    assert.strictEqual((await m.peca.lancar(PED(), 'chave-0030')).ok, true, 'depois da recusa, a mesma chave envia de novo');
    for (const [st, motivo] of [[401, 'token do Bling recusado — tente de novo em instantes'], [403, 'o app desta empresa no Bling não tem a permissão de Pedidos de Compra'], [429, 'limite do Bling — tente de novo daqui a pouco'], [404, 'o Bling recusou o pedido (404)'], [422, 'o Bling recusou o pedido (422)']]) {
      m = mundo({ respPost: () => ({ ok: false, status: st, data: null }) }); r = await m.peca.lancar(PED(), 'chave-00' + st);
      assert.deepStrictEqual(r, { ok: false, recusado: true, status: st, motivo, bling: null });
    }

    /* NÃO SEI se criou: rede, sem resposta, erro do servidor, "ok" sem id, exceção — nunca "recusado", nunca "criado";
       e a chave fica GASTA (reenviar a mesma chave devolve o "não sei", não tenta de novo) */
    const FIM = ' — NÃO SEI se o pedido foi criado. Confira em Pedidos de Compra no Bling antes de tentar de novo.';
    let n = 100;
    for (const [resp, motivo] of [
      [() => ({ ok: false, status: 0, data: null, erro: 'rede: x', ambiguo: true }), 'a conexão com o Bling caiu' + FIM],
      [() => new Error('explodiu'), 'a conexão com o Bling caiu' + FIM],
      [() => null, 'a conexão com o Bling caiu' + FIM],
      [() => ({ ok: false, data: null }), 'a conexão com o Bling caiu' + FIM],
      [() => ({ ok: false, status: 500, data: null }), 'o Bling respondeu erro 500' + FIM],
      [() => ({ ok: false, status: 503, data: { error: { type: 'X' } } }), 'o Bling respondeu erro 503' + FIM],
      [() => ({ ok: true, status: 201, data: null }), 'o Bling respondeu sem o número do pedido' + FIM],
      [() => ({ ok: true, status: 200, data: { data: { id: 'abc' } } }), 'o Bling respondeu sem o número do pedido' + FIM]]) {
      m = mundo({ respPost: resp }); const ch = 'chave-0' + (n++);
      r = await m.peca.lancar(PED(), ch);
      assert.deepStrictEqual(r, { ok: false, ambiguo: true, motivo }, JSON.stringify(r));
      m.respPost = () => ({ ok: true, status: 201, data: { data: { id: 1 } } });
      const de_novo = await m.peca.lancar(PED(), ch);
      assert.deepStrictEqual([de_novo.repetido, de_novo.anterior.ambiguo, m.posts.length, m.criados.length], [true, true, 1, 0], 'a chave do "não sei" não reenvia sozinha');
    }
    /* Codex #990: o "não sei" de uma chave segura o MESMO pedido vindo de outra chave — diz que não se sabe do anterior */
    m = mundo({ respPost: () => ({ ok: false, status: 0, data: null, ambiguo: true }) });
    await m.peca.lancar(PED(), 'chave-ns-1'); m.agora += 3 * 60000;
    m.respPost = () => ({ ok: true, status: 201, data: { data: { id: 5, numero: 9 } } });
    r = await m.peca.lancar(PED(), 'chave-ns-2');
    assert.deepStrictEqual([r, m.posts.length], [{ ok: false, igual_recente: true, estado: 'nao_sei', numero: null, ha_minutos: 3 }, 1]);
    r = await m.peca.lancar(Object.assign(PED(), { repetir: true }), 'chave-ns-2'); assert.deepStrictEqual([r.ok, r.numero, m.posts.length], [true, 9, 2], 'o dono conferiu no Bling e mandou de novo');
    /* recusa clara NÃO segura: nada foi criado, outra chave pode mandar o mesmo */
    m = mundo({ respPost: () => ({ ok: false, status: 400, data: null }) });
    await m.peca.lancar(PED(), 'chave-rc-1'); m.respPost = () => ({ ok: true, status: 201, data: { data: { id: 6, numero: 10 } } });
    assert.strictEqual((await m.peca.lancar(PED(), 'chave-rc-2')).ok, true);
    /* não passou na conferência NÃO segura nada */
    m = mundo(); await m.peca.lancar(PED({ fornecedor: '999' }), 'chave-cf-1'); assert.strictEqual((await m.peca.lancar(PED(), 'chave-cf-2')).ok, true);
    /* com o primeiro AINDA INDO, outra chave com o mesmo pedido não envia — nem com `repetir` */
    { let soltar2 = null; const mm = mundo();
      mm.peca = CL.criar({ agora: () => mm.agora, hojeSP: () => '2026-11-26', blingGet: async (c) => mm.respGet(c), cadastro: CAD, custos: CUS,
        blingWrite: (a, b, corpo) => { mm.posts.push(corpo); return new Promise((okk) => { soltar2 = () => okk({ ok: true, status: 201, data: { data: { id: 8, numero: 2 } } }); }); } });
      const p1 = mm.peca.lancar(PED(), 'chave-ind-1');
      for (let i = 0; i < 20; i++) await new Promise((x) => setImmediate(x));
      assert.deepStrictEqual(await mm.peca.lancar(PED(), 'chave-ind-2'), { ok: false, em_andamento: true });
      assert.deepStrictEqual(await mm.peca.lancar(Object.assign(PED(), { repetir: true }), 'chave-ind-2'), { ok: false, em_andamento: true }, 'nem a confirmação passa por cima de um envio em curso');
      soltar2(); assert.strictEqual((await p1).ok, true);
      assert.deepStrictEqual([(await mm.peca.lancar(PED(), 'chave-ind-2')).igual_recente, mm.posts.length], [true, 1], 'terminou: a outra chave vê o "criado" e não envia'); }
    /* prazo: o envio pendurado é cancelado e vira "não sei" */
    let sinalP = null;
    m = mundo({ prazoMs: 60 });
    m.peca = CL.criar({ prazoMs: 60, agora: () => m.agora, hojeSP: () => '2026-11-26', blingGet: async (c) => m.respGet(c), cadastro: CAD, custos: CUS, blingWrite: (a, b, c, o) => { sinalP = o.signal; return new Promise(() => {}); } });
    r = await m.peca.lancar(PED(), 'chave-0200');
    assert.deepStrictEqual([r, sinalP.aborted], [{ ok: false, ambiguo: true, motivo: 'o Bling não respondeu em 0 s' + FIM }, true]);
    /* muitas chaves: as antigas são esquecidas, a memória não cresce sem fim */
    m = mundo();
    const pedN = (i) => PED({ itens: [{ sku: 'A1', quantidade: i + 1 }] });   /* pedidos diferentes entre si */
    for (let i = 0; i < 205; i++) assert.strictEqual((await m.peca.lancar(pedN(i), 'chave-lote-' + i)).ok, true);
    assert.strictEqual((await m.peca.lancar(pedN(204), 'chave-lote-204')).repetido, true, 'a recente é lembrada');
    assert.strictEqual((await m.peca.lancar(pedN(0), 'chave-lote-0')).ok, true, 'a mais antiga (além do teto de 200) foi esquecida — a chave e a lembrança do pedido igual');
    assert.strictEqual((await m.peca.lancar(pedN(203), 'chave-outra-203')).igual_recente, true, 'e a lembrança recente do pedido igual segue valendo');
  }

  /* ═══ D. as rotas, na fábrica de verdade ═══ */
  process.env.ADMIN_KEY = 'k';
  for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    let resp = null, admin = true, chave = 'k', corpoReq = {};
    const gets = [], posts = [];
    const arquivos = { '_prod_compra.json': CAD(), '_custos.json': CUS() };
    const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => chave, validarSessao: () => (admin ? { usuario: 'diego' } : null), readJson: (a, pad) => { const n = path.basename(a); return n in arquivos ? arquivos[n] : pad; }, writeJson: () => {},
      CACHE_DIR: '/tmp/_compras_lancar_' + empresa, fsx: fs, pathx: path, ehAdmin: () => admin, readBody: async () => corpoReq, estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
      LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: () => null,
      blingGet: async (c) => { gets.push(c); return c === '/contatos/tipos' ? ok(TIPOS) : ok(FORN); },
      blingWrite: async (metodo, c, corpo) => { posts.push([metodo, c, corpo]); return { ok: true, status: 201, data: { data: { id: 4242, numero: 12 } } }; } };
    const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
    const pedir = async (metodo, rota, qs) => { resp = null; const u = new URL('http://h' + prefixo + rota + (qs || '')); const t = await rot({ method: metodo, headers: {} }, {}, prefixo + rota, metodo, u); return [t, resp]; };
    /* os fornecedores */
    let [t, r] = await pedir('GET', '/compras-fornecedores');
    assert.deepStrictEqual([t, r.code, r.body.ok, r.body.empresa, r.body.fornecedores, r.body.incompleto, typeof r.body.lido_em], [true, 200, true, empresa, [{ id: '501', nome: 'Álfa Import' }, { id: '504', nome: 'beta ltda' }, { id: '502', nome: 'Zeta Comércio' }], false, 'string'], empresa + ': ' + JSON.stringify(r));
    const nG = gets.length; await pedir('GET', '/compras-fornecedores'); assert.strictEqual(gets.length, nG, empresa + ': a lista é guardada');
    await pedir('GET', '/compras-fornecedores', '?novo=1'); assert.strictEqual(gets.length, nG + 2, empresa + ': ?novo=1 relê');
    /* o ensaio: confere e resume, sem escrever */
    corpoReq = Object.assign(PED(), { ensaio: true, chave: 'chave-rota-1' });
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.code, r.body, posts.length], [200, { ok: true, ensaio: true, empresa, resumo: { fornecedor: 'Álfa Import', data_prevista: '2027-02-28', itens: 2, unidades: 103, total: 1256, sem_custo: [] } }, 0], empresa + ': ensaio');
    corpoReq = Object.assign(PED({ fornecedor: '999' }), { ensaio: true });
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.body, posts.length], [{ ok: false, ensaio: true, empresa, erros: ['o fornecedor escolhido não está entre os fornecedores do Bling desta empresa'] }, 0]);
    /* `ensaio` só vale como true de verdade — texto "true" não é ensaio, mas sem chave não envia */
    corpoReq = Object.assign(PED(), { ensaio: 'true' });
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.body.ok, r.body.erros, posts.length], [false, ['pedido sem a chave de envio — recarregue a tela e tente de novo'], 0]);
    /* o envio de verdade */
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-1', campo_a_mais: { x: 1 } });
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.code, r.body.ok, r.body.empresa, r.body.id, r.body.numero, posts.length, posts[0][0], posts[0][1], Object.keys(posts[0][2]).sort()], [200, true, empresa, '4242', 12, 1, 'POST', '/pedidos/compras', ['data', 'dataPrevista', 'fornecedor', 'itens']], empresa + ': ' + JSON.stringify(r));
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.body.repetido, posts.length], [true, 1], empresa + ': a mesma chave não cria outro');
    /* outra chave com o MESMO pedido: recusado com o aviso; `repetir` só vale como true de verdade */
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-2' });
    [t, r] = await pedir('POST', '/compras-pedido');
    assert.deepStrictEqual([r.body.ok, r.body.igual_recente, r.body.estado, r.body.numero, r.body.empresa, posts.length], [false, true, 'criado', 12, empresa, 1], empresa + ': ' + JSON.stringify(r.body));
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-2', repetir: 'true' });
    [t, r] = await pedir('POST', '/compras-pedido'); assert.deepStrictEqual([r.body.igual_recente, posts.length], [true, 1]);
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-2', repetir: true });
    [t, r] = await pedir('POST', '/compras-pedido'); assert.deepStrictEqual([r.body.ok, posts.length], [true, 2], empresa + ': com a confirmação, cria');
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-1', campo_a_mais: { x: 1 } });
    /* corpo torto não estoura */
    for (const torto of [null, 'x{', '[]', 7]) { corpoReq = torto; [t, r] = await pedir('POST', '/compras-pedido'); assert.deepStrictEqual([r.code, r.body.ok, posts.length], [200, false, 2], empresa + ': corpo ' + JSON.stringify(torto)); }
    /* só admin: 404, e o Bling nem é chamado */
    chave = 'errada'; admin = false; const nG2 = gets.length;
    corpoReq = Object.assign(PED(), { chave: 'chave-rota-9' });
    for (const [mt, ro] of [['GET', '/compras-fornecedores'], ['POST', '/compras-pedido']]) { [t, r] = await pedir(mt, ro); assert.deepStrictEqual([t, r.code, r.body, gets.length, posts.length], [true, 404, { error: 'not found' }, nG2, 2], empresa + ': ' + ro + ' sem admin'); }
    chave = 'k';
    /* método trocado não é a rota */
    [t, r] = await pedir('POST', '/compras-fornecedores'); assert.ok(!(r && r.body && r.body.fornecedores) && posts.length === 2);
    [t, r] = await pedir('GET', '/compras-pedido'); assert.ok(!(r && r.body && (r.body.id || r.body.fornecedores || 'ok' in r.body)) && posts.length === 2, empresa + ': GET em /compras-pedido não é rota nenhuma daqui');
  }
  /* pedido criado derruba a leitura guardada do "a caminho" (o plano já desconta o pedido novo) */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib/checkout/fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/aoCriar: _caminhoInvalidar/.test(src) && /function _caminhoInvalidar\(\) \{ _caminhoGer\+\+; _caminhoGuardado = null; _caminhoEmVoo = null; \}/.test(src) && /if \(ger === _caminhoGer\) \{ _caminhoGuardado/.test(src) &&/cadastro: \(\) => readJson\(pathx\.join\(CACHE_DIR, '_prod_compra\.json'\), \{\}\)/.test(src) && /custos: \(\) => readJson\(pathx\.join\(CACHE_DIR, '_custos\.json'\), \{\}\)/.test(src), 'os mesmos arquivos do plano; criar derruba o "a caminho" guardado');
  }
  /* Codex #988 — DE VERDADE, na fábrica: pedido criado faz o plano RELER o "a caminho", inclusive quando uma leitura
     antiga (que começou ANTES do pedido e não o enxerga) ainda estava em voo: ela não pode virar o resultado guardado. */
  {
    const fetchDeVerdade = global.fetch;
    const DIA = 86400000, dv = (n) => new Date(Date.now() - n * DIA).toISOString().slice(0, 10);
    const VENDAS = [['A1', 150, 100], ['A1', 60, 10], ['B2', 90, 45]].map(([sku, quantidade, ha], n) => ({ id: (n + 1) * 7, sku, descricao: sku, quantidade, valor_produto: quantidade * 10, margem: quantidade * 2, data_venda: dv(ha) }));
    global.fetch = async (url) => { const u = new URL(url); if (u.searchParams.get('sku')) return { ok: true, status: 200, json: async () => [] }; const depois = Number(String(u.searchParams.get('id')).replace(/^gt\./, '')); return { ok: true, status: 200, json: async () => VENDAS.filter((v) => v.id > depois) }; };
    try {
      for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
        let resp = null, corpoReq = {}, listas = 0, portao = null, pedidoNoBling = false;
        const cacheProd = { A1: { id: 9001, saldo: 0, img: null, nome: 'Abajur', ts: Date.now(), ts_cad: Date.now() }, B2: { id: 9002, saldo: 5, img: null, nome: 'Bola', ts: Date.now(), ts_cad: Date.now() } };
        const lista = () => (pedidoNoBling ? ok([{ id: 1, numero: 1, data: '2026-11-26', dataPrevista: '2027-02-28', situacao: { id: 1, valor: 0 }, fornecedor: { id: 501 } }]) : ok([]));
        const pecas = { json: (res, code, body) => { resp = { code, body }; res.r = resp; }, lerChaveAdmin: () => 'k', validarSessao: () => ({ usuario: 'diego' }), readJson: (arq, pad) => (/_prod_compra\.json$/.test(arq) ? cacheProd : /_custos\.json$/.test(arq) ? CUS() : pad), writeJson: () => {},
          CACHE_DIR: '/tmp/_lancar_caminho_' + empresa, fsx: fs, pathx: path, ehAdmin: () => true, readBody: async () => corpoReq, estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
          LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: (emp) => ({ url: 'https://supa.' + emp + '/', key: 'chave-' + emp }),
          blingGet: async (c) => {
            if (c.startsWith('/pedidos/compras?')) { listas++; const foto = lista(); if (portao) await portao; return foto; }   /* a foto é tirada ANTES da espera: leitura antiga não vê o pedido novo */
            if (c.startsWith('/pedidos/compras/')) return { ok: true, status: 200, data: { data: { id: 1, numero: 1, dataPrevista: '2027-02-28', situacao: { valor: 0 }, itens: [{ quantidade: 40, produto: { id: 9001, codigo: 'A1' } }] } } };
            if (c === '/contatos/tipos') return ok(TIPOS);
            if (c.startsWith('/contatos?')) return ok(FORN);
            return { ok: false, status: 404 }; },
          blingWrite: async () => { pedidoNoBling = true; return { ok: true, status: 201, data: { data: { id: 1, numero: 1 } } }; } };
        const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
        const plano = async () => { const u = new URL('http://h' + prefixo + '/plano-compra?k=k&curva=TODAS'); const res = {}; await rot({ method: 'GET', headers: {} }, res, prefixo + '/plano-compra', 'GET', u); const meu = res.r; assert.ok(meu && meu.code === 200 && meu.body.ok, empresa + ': ' + JSON.stringify(meu).slice(0, 300)); return meu.body; };
        let nPed = 0; const criarPedido = async (ch) => { corpoReq = Object.assign(PED({ itens: [{ sku: 'A1', quantidade: 40 + (nPed++) }] }), { chave: ch }); resp = null; await rot({ method: 'POST', headers: {} }, {}, prefixo + '/compras-pedido', 'POST', new URL('http://h' + prefixo + '/compras-pedido')); assert.ok(resp && resp.body.ok, empresa + ': ' + JSON.stringify(resp)); };
        const aCaminho = (r) => (r.itens.find((i) => i.sku === 'A1') || {}).a_caminho;
        /* 1) o caso simples: leitura guardada (sem pedido) → cria o pedido → o plano seguinte relê e já desconta */
        assert.deepStrictEqual([aCaminho(await plano()), listas], [0, 1], empresa + ': antes do pedido, nada a caminho');
        assert.deepStrictEqual([aCaminho(await plano()), listas], [0, 1], empresa + ': a leitura fica guardada');
        await criarPedido('chave-caminho-1');
        assert.deepStrictEqual([aCaminho(await plano()), listas], [40, 2], empresa + ': criado o pedido, o plano relê e mostra o a caminho');
        /* 2) a leitura em voo: começou antes do pedido (não o vê), o pedido é criado no meio, ela termina depois */
        pedidoNoBling = false; await criarPedido('chave-caminho-2'); pedidoNoBling = false;   /* zera o guardado; o Bling de mentira volta a "sem pedido" */
        let abrir; portao = new Promise((okk) => { abrir = okk; });
        const antigo = plano();                                   /* tira a foto SEM o pedido e fica esperando */
        for (let i = 0; i < 30; i++) await new Promise((x) => setImmediate(x));
        assert.strictEqual(listas, 3, empresa + ': a leitura antiga está em voo');
        portao = null; await criarPedido('chave-caminho-3');      /* o pedido nasce com a leitura antiga ainda em voo */
        const novo = await plano();                               /* pedido de plano DEPOIS do pedido criado: não entra na leitura antiga */
        assert.deepStrictEqual([aCaminho(novo), listas], [40, 4], empresa + ': com uma leitura antiga em voo, o plano novo abre a leitura dele e vê o pedido');
        abrir(); assert.strictEqual(aCaminho(await antigo), 0, empresa + ': quem já esperava a antiga recebe a foto dela');
        assert.deepStrictEqual([aCaminho(await plano()), listas], [40, 4], empresa + ': e a foto antiga NÃO vira o resultado guardado (segue o novo, sem reler)');
        /* 3) a antiga termina DEPOIS e não há leitura nova no meio: o plano seguinte tem de reler, não herdar a antiga */
        pedidoNoBling = false; await criarPedido('chave-caminho-4'); pedidoNoBling = false;
        portao = new Promise((okk) => { abrir = okk; });
        const antigo2 = plano(); for (let i = 0; i < 30; i++) await new Promise((x) => setImmediate(x));
        const nAntes = listas; portao = null; await criarPedido('chave-caminho-5');
        abrir(); assert.strictEqual(aCaminho(await antigo2), 0);
        assert.deepStrictEqual([aCaminho(await plano()), listas], [40, nAntes + 1], empresa + ': a antiga terminou depois do pedido e não foi guardada — o plano seguinte relê');
      }
    } finally { global.fetch = fetchDeVerdade; }
  }
  delete process.env.ADMIN_KEY;
  terminou = true; process.exitCode = 0;
  console.log('ok — Compras, lançar o Pedido de Compra no Bling: fornecedores só do tipo "Fornecedor" (guardados, paginados, falha com motivo); conferência tudo-ou-nada (fornecedor da lista, data, quantidade, cadastro) com o corpo espelhando o pedido do Bling e item sem custo avisado; envio em UMA tentativa — criado, recusado (com a validação do Bling) ou "não sei" (nunca repete sozinho); a chave da tela impede pedido em dobro; rotas só de admin, nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
