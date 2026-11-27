'use strict';
/* 27/11 — SONDA: a API do Bling diz de qual nota uma NF de devolução é? (lib/checkout/sonda-devolucao-nf + a rota
   <prefixo>/cancelados-bling?sonda_devolucao=&da=). O dono: "vc não consegue consultar no bling se a venda já teve a
   devolução NF emitida?" — antes de prometer, ver o dado.

   O que se prova (o código de produção):
   A. acha a nota original dentro da devolução onde quer que esteja (chave, número, id), e diz o CAMINHO;
   B. lê o XML só do host do Bling e tira dele só as chaves referenciadas (<refNFe>);
   C. tenta a lista das notas de entrada do dia e diz se a devolução está nela;
   D. falhas viram "não li" — nunca "não tem";
   E. NUNCA sai valor de campo de gente; só admin; só leitura. */
const assert = require('assert');
const S = require('../lib/checkout/sonda-devolucao-nf');
const R = require('../lib/checkout/rota-cancelados-bling');

const CHAVE = '35261127548456000147550010001310991036890923', OUTRA = '35261127548456000147550010001311761000000001';
const ORIG = () => ({ id: 901, numero: '0131099', tipo: 1, chaveAcesso: CHAVE.replace(/(\d{4})/g, '$1 ').trim(), contato: { nome: 'FULANO DE TAL', numeroDocumento: '11122233344' } });
const DEV = (extra) => Object.assign({ id: 902, numero: '131176', serie: 1, tipo: 0, finalidade: 4, situacao: { valor: 6 }, dataEmissao: '2026-11-26 07:40:00', xml: 'https://www.bling.com.br/relatorios/nfe.xml.php?chaveAcesso=abc',
  contato: { nome: 'FULANO DE TAL', numeroDocumento: '11122233344', endereco: { endereco: 'RUA X' } }, itens: [{ codigo: 'SKU1', descricao: 'PRODUTO' }], documentoReferenciado: { chaveAcesso: CHAVE, numero: '131099' }, observacoes: 'Devolução ref. NF 0131099' }, extra || {});
const XML = '<NFe><infNFe Id="NFe1"><ide><finNFe>4</finNFe><NFref><refNFe>' + CHAVE + '</refNFe></NFref><NFref><refNFe> ' + OUTRA + ' </refNFe></NFref></ide><dest><xNome>FULANO DE TAL</xNome><CPF>11122233344</CPF></dest></infNFe></NFe>';

function mundo(op) {
  op = op || {};
  const cx = { idas: [], baixou: [], orig: op.orig === undefined ? ORIG() : op.orig, dev: op.dev === undefined ? DEV() : op.dev, lista: op.lista === undefined ? [{ id: 900, numero: '1', contato: { nome: 'BELTRANO' } }, { id: 902, numero: '131176', chaveAcesso: OUTRA }] : op.lista, xml: op.xml === undefined ? XML : op.xml };
  cx.idasSit = [];
  cx.blingGet = async (c) => {
    /* a lista por situação (27/11) é anotada à parte: os testes de cima contam as idas da lista sem situação */
    const ms = /^\/nfe\?tipo=0&situacao=(\d)&dataEmissaoInicial=([\d-]+)&dataEmissaoFinal=([\d-]+)&limite=100&pagina=1$/.exec(c);
    if (ms) { cx.idasSit.push(c); const x = (op.porSit || {})[ms[1]]; if (x === 'ESTOURA') throw new Error('rede'); return x === undefined ? { ok: true, status: 200, data: { data: [] } } : (x === null ? { ok: false, status: 500, data: null } : { ok: true, status: 200, data: { data: x } }); }
    cx.idas.push(c); if (op.estoura && op.estoura.test(c)) throw new Error('rede');
    const pg = /pagina=(\d+)$/.exec(c);
    const d = c === '/nfe/901' ? cx.orig : (c === '/nfe/902' ? cx.dev : (/^\/nfe\?/.test(c) ? (op.paginas ? op.paginas[pg[1]] : cx.lista) : null));
    return d == null ? { ok: false, status: 404, data: null } : { ok: true, status: 200, data: { data: d } }; };
  cx.fetch = async (u, o) => { cx.baixou.push([u, o]); if (cx.xml === 'ESTOURA') throw new Error('rede'); if (cx.xml === 403) return { ok: false, status: 403, text: async () => 'negado' };
    if (cx.xml && cx.xml.redireciona) return { ok: false, status: 302, headers: { get: (h) => (h === 'location' ? cx.xml.redireciona : null) }, text: async () => { throw new Error('não era pra ler o corpo'); } };
    return { ok: true, status: 200, text: async () => cx.xml }; };
  cx.rodar = () => S.sondar({ blingGet: cx.blingGet, fetch: cx.fetch, devId: '902', origId: '901' });
  return cx;
}

(async () => {
  /* ═══ A. acha a original dentro da devolução ═══ */
  let m = mundo(), r = await m.rodar();
  assert.deepStrictEqual(r.original, { lida: true, tem_chave: true, numero: '0131099', tipo: 1 });
  assert.deepStrictEqual([r.devolucao.lida, r.devolucao.tipo, r.devolucao.situacao, r.devolucao.finalidade, r.devolucao.numero, r.devolucao.serie, r.devolucao.data_emissao], [true, 0, 6, 4, '131176', '1', '2026-11-26 07:40:00']);
  assert.deepStrictEqual(r.devolucao.a_original_aparece_em, { chave: ['documentoReferenciado.chaveAcesso'], numero: ['documentoReferenciado.numero'], id: [] }, 'a chave e o número, com o caminho; texto livre com o número no meio não conta');
  assert.deepStrictEqual(r.devolucao.campos, ['contato.endereco.endereco', 'contato.nome', 'contato.numeroDocumento', 'dataEmissao', 'documentoReferenciado.chaveAcesso', 'documentoReferenciado.numero', 'finalidade', 'id', 'itens[].codigo', 'itens[].descricao', 'numero', 'observacoes', 'serie', 'situacao.valor', 'tipo', 'xml']);
  assert.deepStrictEqual(m.idas, ['/nfe/901', '/nfe/902', '/nfe?tipo=0&dataEmissaoInicial=2026-11-26&dataEmissaoFinal=2026-11-27&limite=100&pagina=1']);
  /* chave no meio de um texto, com máscara; id da original num campo qualquer; em lista */
  m = mundo({ dev: DEV({ documentoReferenciado: undefined, informacoesAdicionais: 'ref NFe 3526 1127 5484 5600 0147 5500 1000 1310 9910 3689 0923 fim', vinculos: [{ notaOrigem: { id: 901 } }, { notaOrigem: { id: 5 } }] }) }); r = await m.rodar();
  assert.deepStrictEqual(r.devolucao.a_original_aparece_em, { chave: ['informacoesAdicionais'], numero: [], id: ['vinculos[].notaOrigem.id'] });
  /* não aparece em lugar nenhum */
  m = mundo({ dev: DEV({ documentoReferenciado: undefined, observacoes: null }) }); r = await m.rodar(); assert.deepStrictEqual(r.devolucao.a_original_aparece_em, { chave: [], numero: [], id: [] });
  /* original sem chave válida: a busca por chave não casa com nada (e diz que não tem chave) */
  m = mundo({ orig: Object.assign(ORIG(), { chaveAcesso: '123' }), dev: DEV({ observacoes: 'x 123 y' }) }); r = await m.rodar(); assert.deepStrictEqual([r.original.tem_chave, r.devolucao.a_original_aparece_em.chave], [false, []]);
  m = mundo({ orig: Object.assign(ORIG(), { chaveAcesso: null }), dev: DEV({ vazio: '' }) }); r = await m.rodar(); assert.deepStrictEqual([r.original.tem_chave, r.devolucao.a_original_aparece_em.chave, r.xml.referencia_a_original], [false, [], false]);
  /* situação como número puro */
  m = mundo({ dev: DEV({ situacao: 5 }) }); r = await m.rodar(); assert.strictEqual(r.devolucao.situacao, 5);

  /* ═══ B. o XML ═══ */
  m = mundo(); r = await m.rodar();
  assert.deepStrictEqual(r.xml, { tem_link: true, host: 'www.bling.com.br', http: 200, e_nfe: true, finalidade: '4', referencias: [CHAVE, OUTRA], referencia_a_original: true });
  assert.deepStrictEqual(m.baixou, [['https://www.bling.com.br/relatorios/nfe.xml.php?chaveAcesso=abc', { timeout: 15000, redirect: 'manual' }]]);
  m = mundo({ xml: '<NFe><infNFe><NFref><refNFe>' + OUTRA + '</refNFe></NFref></infNFe></NFe>' }); r = await m.rodar(); assert.deepStrictEqual([r.xml.referencias, r.xml.referencia_a_original], [[OUTRA], false]);
  m = mundo({ xml: '<NFe><infNFe versao="4.00"></infNFe></NFe>' }); r = await m.rodar(); assert.deepStrictEqual([r.xml.e_nfe, r.xml.finalidade, r.xml.referencias, r.xml.referencia_a_original], [true, null, [], false], 'XML de NF-e inteiro e sem referência: aí sim é "não referencia" (e sem a tag de finalidade, null)');
  /* Codex #1002: 200 com página de login, corpo vazio, XML pela metade ou outro documento NÃO é "sem referência" */
  for (const corpo of ['<html><body>Login</body></html>', '', '<NFe><infNFe><NFref><refNFe>' + CHAVE + '</refNFe>', '<outro><refNFe>' + CHAVE + '</refNFe></outro>', '<infNFeSupl></infNFeSupl></infNFe>']) {
    m = mundo({ xml: corpo }); r = await m.rodar(); assert.deepStrictEqual(r.xml, { tem_link: true, host: 'www.bling.com.br', http: 200, e_nfe: false }, JSON.stringify(corpo.slice(0, 30))); }
  /* Codex #1002: redirecionamento não é seguido — só diz pra onde ia (o corpo nem é lido) */
  for (const [loc, host] of [['http://127.0.0.1:8080/x', '127.0.0.1:8080'], ['https://s3.amazonaws.com/b/x.xml', 's3.amazonaws.com'], ['/outro/caminho', 'www.bling.com.br'], ['http://[torto', null]]) {
    m = mundo({ xml: { redireciona: loc } }); r = await m.rodar(); assert.deepStrictEqual([r.xml, m.baixou.length], [{ tem_link: true, host: 'www.bling.com.br', http: 302, redireciona_para_host: host }, 1], loc); }
  m = mundo({ xml: 403 }); r = await m.rodar(); assert.deepStrictEqual(r.xml, { tem_link: true, host: 'www.bling.com.br', http: 403 }, 'não leu: não diz que não referencia');
  m = mundo({ xml: 'ESTOURA' }); r = await m.rodar(); assert.deepStrictEqual(r.xml, { tem_link: true, host: 'www.bling.com.br', http: 0 });
  /* link de fora do Bling, http, torto ou ausente: NÃO é baixado */
  for (const [link, esperado] of [['https://evil.example/x.xml', { tem_link: true, host: 'evil.example', lido: false }], ['https://bling.com.br.evil.example/x', { tem_link: true, host: 'bling.com.br.evil.example', lido: false }], ['https://xbling.com.br/x', { tem_link: true, host: 'xbling.com.br', lido: false }],
    ['http://www.bling.com.br/x.xml', { tem_link: false }], [null, { tem_link: false }], [{ url: 'https://www.bling.com.br/x' }, { tem_link: false }]]) {
    m = mundo({ dev: DEV({ xml: link }) }); r = await m.rodar(); assert.deepStrictEqual([r.xml, m.baixou.length], [esperado, 0], JSON.stringify(link)); }
  m = mundo({ dev: DEV({ xml: 'https://bling.com.br/x' }) }); r = await m.rodar(); assert.strictEqual(m.baixou.length, 1, 'o domínio raiz do Bling também vale');

  /* ═══ C. a lista das notas de entrada do dia ═══ */
  m = mundo(); r = await m.rodar();
  assert.deepStrictEqual(r.lista, { tentada: true, veio: true, notas: 2, lista_completa: true, a_devolucao_esta_na_lista: true, campos_do_item: ['contato.nome', 'id', 'numero'], a_original_aparece_no_item: { chave: [], numero: [], id: [] } });
  m = mundo({ lista: [{ id: 5 }] }); r = await m.rodar(); assert.deepStrictEqual([r.lista.a_devolucao_esta_na_lista, r.lista.a_original_aparece_no_item, r.lista.campos_do_item], [false, null, ['id']]);
  m = mundo({ lista: [] }); r = await m.rodar(); assert.deepStrictEqual([r.lista.veio, r.lista.notas, r.lista.campos_do_item], [true, 0, []]);
  m = mundo({ lista: null }); r = await m.rodar(); assert.deepStrictEqual(r.lista, { tentada: true, veio: false, http: 404 });
  /* Codex #1002: mais de 100 notas no dia — segue as páginas; "não está" só quando a lista acabou */
  { const cheia = (b) => Array.from({ length: 100 }, (_, i) => ({ id: b + i }));
    m = mundo({ paginas: { 1: cheia(1000), 2: cheia(2000).concat(), 3: [{ id: 5 }, { id: 902, chaveAcesso: CHAVE }] } }); r = await m.rodar();
    assert.deepStrictEqual([r.lista.notas, r.lista.lista_completa, r.lista.a_devolucao_esta_na_lista, r.lista.a_original_aparece_no_item.chave, m.idas.filter((c) => /^\/nfe\?/.test(c)).map((c) => /pagina=(\d+)/.exec(c)[1])], [202, true, true, ['chaveAcesso'], ['1', '2', '3']]);
    const p2 = cheia(2000); p2[40] = { id: 902 }; m = mundo({ paginas: { 1: cheia(1000), 2: p2, 3: cheia(3000) } }); r = await m.rodar(); assert.deepStrictEqual([r.lista.a_devolucao_esta_na_lista, r.lista.lista_completa, m.idas.filter((c) => /^\/nfe\?/.test(c)).length], [true, false, 2], 'achou: para de paginar');
    m = mundo({ paginas: { 1: cheia(1000), 2: [{ id: 7 }] } }); r = await m.rodar(); assert.deepStrictEqual([r.lista.a_devolucao_esta_na_lista, r.lista.lista_completa, r.lista.notas], [false, true, 101]);
    m = mundo({ paginas: { 1: cheia(1000), 2: cheia(2000), 3: cheia(3000), 4: cheia(4000), 5: cheia(5000), 6: [{ id: 902 }] } }); r = await m.rodar();
    assert.deepStrictEqual([r.lista.a_devolucao_esta_na_lista, r.lista.lista_completa, r.lista.notas, m.idas.filter((c) => /^\/nfe\?/.test(c)).length], [null, false, 500, 5], 'teto de páginas: não achou e a lista não acabou = não sei');
    m = mundo({ paginas: { 1: cheia(1000), 2: null } }); r = await m.rodar(); assert.deepStrictEqual([r.lista.veio, r.lista.a_devolucao_esta_na_lista, r.lista.lista_completa, r.lista.notas], [true, null, false, 100], 'a 2ª página não veio: não sei'); }
  m = mundo({ lista: { x: 1 } }); r = await m.rodar(); assert.strictEqual(r.lista.veio, false);
  m = mundo({ estoura: /^\/nfe\?/ }); r = await m.rodar(); assert.deepStrictEqual(r.lista, { tentada: true, veio: false, http: 0 });
  m = mundo({ dev: DEV({ dataEmissao: null }) }); r = await m.rodar(); assert.deepStrictEqual([r.lista, m.idas.length], [{ tentada: false }, 2]);
  m = mundo({ dev: DEV({ dataEmissao: '2026-12-31 23:00:00' }) }); r = await m.rodar(); assert.ok(m.idas[2].includes('dataEmissaoInicial=2026-12-31&dataEmissaoFinal=2027-01-01'));

  /* 27/11 — a mesma lista, uma situação por vez (é como o índice das devoluções lista): diz em qual a devolução aparece */
  m = mundo({ porSit: { 5: [{ id: 7 }, { id: 902 }], 6: [{ id: 8 }], 7: null } }); r = await m.rodar();
  assert.deepStrictEqual(r.lista_por_situacao, { janela: '2026-11-25 a 2026-11-28', 5: { veio: true, notas: 2, a_devolucao_esta: true }, 6: { veio: true, notas: 1, a_devolucao_esta: false }, 7: { veio: false, http: 500 } });
  assert.deepStrictEqual(m.idasSit, [5, 6, 7].map((x) => '/nfe?tipo=0&situacao=' + x + '&dataEmissaoInicial=2026-11-25&dataEmissaoFinal=2026-11-28&limite=100&pagina=1'), 'janela folgada: véspera → dois dias depois');
  m = mundo({ porSit: { 5: Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i })), 6: 'ESTOURA' } }); r = await m.rodar();
  assert.deepStrictEqual([r.lista_por_situacao[5], r.lista_por_situacao[6], r.lista_por_situacao[7]], [{ veio: true, notas: 100, a_devolucao_esta: null }, { veio: false, http: 0 }, { veio: true, notas: 0, a_devolucao_esta: false }], 'página cheia sem a nota: não sei (pode estar na seguinte)');
  m = mundo({ dev: DEV({ dataEmissao: null }) }); r = await m.rodar(); assert.deepStrictEqual([r.lista_por_situacao, m.idasSit], [undefined, []]);

  /* ═══ D. falhas ═══ */
  m = mundo({ orig: null }); r = await m.rodar(); assert.deepStrictEqual([r, m.idas], [{ original: { lida: false, http: 404 }, devolucao: null, xml: null, lista: null }, ['/nfe/901']]);
  m = mundo({ estoura: /901/ }); r = await m.rodar(); assert.deepStrictEqual(r.original, { lida: false, http: 0 });
  m = mundo({ dev: null }); r = await m.rodar(); assert.deepStrictEqual([r.devolucao, r.xml, r.lista, m.baixou.length], [{ lida: false, http: 404 }, null, null, 0]);
  m = mundo({ orig: 'texto' }); r = await m.rodar(); assert.strictEqual(r.original.lida, false);

  /* ═══ E. sem dado de gente; a rota ═══ */
  m = mundo(); r = await m.rodar();
  assert.ok(!/FULANO|BELTRANO|11122233344|RUA X|SKU1|PRODUTO|abc/.test(JSON.stringify(r)), 'nem nome, nem documento, nem endereço, nem o link do XML saem');
  /* varrer: objeto fundo demais e lista enorme não travam */
  { let fundo = { v: CHAVE }; for (let i = 0; i < 30; i++) fundo = { a: fundo }; assert.deepStrictEqual(S.varrer(fundo, { chave: CHAVE }).achados.chave, []); assert.strictEqual(S.varrer({ l: Array.from({ length: 500 }, (_, i) => ({ n: i })) }, {}).caminhos.join(), 'l[].n');
    const longa = Array.from({ length: 80 }, (_, i) => ({ n: i })); longa[49].x = CHAVE; longa[50].y = CHAVE; assert.deepStrictEqual(S.varrer({ l: longa }, { chave: CHAVE }).achados.chave, ['l[].x'], 'só os 50 primeiros de cada lista são olhados'); }

  const cena = (extra) => {
    const mm = mundo(); const vigia = { varrer: async () => ({ ok: true }), pendentes: () => ({ rodou_em: new Date().toISOString(), pendentes: [], outras: [] }), ler: () => ({ pedidos: {} }), emAndamento: () => false };
    const rota = R.criar(Object.assign({ empresa: 'emp', prefixo: '/emp', vigia, json: (res, st, ob) => { res._s = st; res._o = ob; }, lerChaveAdmin: () => '', validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
      blingGet: mm.blingGet, fetch: mm.fetch, emFundo: (fn) => fn() }, extra || {}));
    mm.pedir = async (qs, ck) => { const u = new URL('http://x/emp/cancelados-bling' + qs); const res = {}; await rota({ method: 'GET', headers: { cookie: ck === undefined ? 'adm' : ck } }, res, u, 'GET', u.pathname); return Object.assign({ _s: res._s }, res._o); };
    return mm;
  };
  m = cena(); r = await m.pedir('?sonda_devolucao=902&da=901');
  assert.deepStrictEqual([r._s, r.ok, r.empresa, r.so_leitura, r.sonda.xml.referencia_a_original, r.sonda.devolucao.a_original_aparece_em.chave], [200, true, 'emp', true, true, ['documentoReferenciado.chaveAcesso']]);
  for (const ck of ['', 'est']) { m = cena(); r = await m.pedir('?sonda_devolucao=902&da=901', ck); assert.deepStrictEqual([r._s, r.error, m.idas.length], [404, 'not found', 0]); }
  for (const qs of ['?sonda_devolucao=902', '?sonda_devolucao=abc&da=901', '?sonda_devolucao=902&da=9;1', '?sonda_devolucao=' + '9'.repeat(21) + '&da=1']) { m = cena(); r = await m.pedir(qs); assert.deepStrictEqual([r._s, r.ok, m.idas.length], [400, false, 0], qs); }
  m = cena({ blingGet: undefined }); r = await m.pedir('?sonda_devolucao=902&da=901'); assert.deepStrictEqual([r.ok, r.etapa], [false, 'sem_peca']);
  /* nada é escrito: o módulo só conhece blingGet e o download do XML */
  assert.ok(!/blingWrite|method\s*:/.test(require('fs').readFileSync(require.resolve('../lib/checkout/sonda-devolucao-nf'), 'utf8')));
  console.log('ok — sonda da NF de devolução: acha a nota original dentro da devolução (com o caminho), lê do XML só as chaves referenciadas e só do host do Bling, tenta a lista de entradas do dia; falha é "não li"; sem dado de gente; só admin');
})().catch((e) => { console.error('FALHOU:', (e && e.stack) || e); process.exit(1); });
