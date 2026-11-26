'use strict';
/* 26/11 — COMPRAS: A SONDA DOS FORNECEDORES NO BLING (o que a tela de lançar o Pedido de Compra precisa saber antes de
   ser escrita: os tipos de contato, e se a lista de contatos aceita filtro por tipo e busca por texto).

   O que se prova:
   A. a peça (lib/checkout/compras-fornecedores-sonda): as perguntas certas, uma de cada vez; contagens e códigos; o tipo
      de fornecedor achado pelo nome (sem acento nem caixa); a busca só quando veio texto; falha de uma pergunta não
      inventa número; prazo com cancelamento; NENHUM dado de contato na resposta (nem o texto buscado);
   B. a ROTA /compras-sonda?fornecedores=1, na fábrica de verdade, nas três empresas: só admin; sem o parâmetro, a
      sonda de sempre. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sondarFornecedores, PRAZO_MS, LISTA } = require('../lib/checkout/compras-fornecedores-sonda');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const SEGREDO = ['Fulano de Tal', '12345678000199', '11999990000', 'fulano@x.com'];
const contato = (nome) => ({ id: 1, nome, codigo: 'C1', situacao: 'A', numeroDocumento: SEGREDO[1], telefone: SEGREDO[2], celular: SEGREDO[2], email: SEGREDO[3] });
const ok = (lista) => ({ ok: true, status: 200, data: { data: lista } });
const TIPOS = [{ id: 11, descricao: 'Cliente' }, { id: 933846847, descricao: 'FORNECEDÓR <b>x</b>' }, { id: 'abc', descricao: 'torto' }, null, { id: 13, descricao: 'Fornecedor 2' }, { id: 14 }, { id: 15, descricao: 'T'.repeat(90) }];

(async () => {
  assert.deepStrictEqual([PRAZO_MS, LISTA], [30000, '/contatos?pagina=1&limite=100']);
  /* um Bling de mentira: responde por caminho e anota a ordem e quantas estavam em voo ao mesmo tempo */
  const bling = (respostas) => { const b = { caminhos: [], args: [], emVoo: 0, pico: 0 };
    b.get = async (c, n, sinal) => { b.caminhos.push(c); b.args.push([n, !!(sinal && typeof sinal.addEventListener === 'function')]); b.emVoo++; b.pico = Math.max(b.pico, b.emVoo);
      await new Promise((r) => setImmediate(r)); b.emVoo--; const r = respostas(c); if (r instanceof Error) throw r; return r; };
    return b; };
  const padrao = (c) => (c === '/contatos/tipos' ? ok(TIPOS)
    : c === LISTA ? ok(Array.from({ length: 100 }, () => contato(SEGREDO[0])))
    : c.includes('idTipoContato=') ? ok([contato('Shenzhen Fábrica'), contato(SEGREDO[0])])
    : ok([contato('SHENZHEN Fábrica Ltd'), contato('Outro'), null, { nome: null }, contato('a shénzhen b')]));

  /* ── tudo respondeu, com busca ── */
  {
    const b = bling(padrao);
    const v = await sondarFornecedores(b.get, { q: '  Shenzhen ' });
    assert.deepStrictEqual(b.caminhos, ['/contatos/tipos', LISTA, LISTA + '&idTipoContato=933846847', LISTA + '&pesquisa=Shenzhen'], 'as quatro perguntas, nesta ordem');
    assert.deepStrictEqual([b.pico, b.args.every((a) => a[0] === 1 && a[1] === true)], [1, true], 'uma de cada vez; uma tentativa cada; todas com o sinal de cancelamento');
    assert.deepStrictEqual(v, {
      tipos: { status: 200, lista: [{ id: '11', descricao: 'Cliente' }, { id: '933846847', descricao: 'FORNECEDÓR bx/b' }, { id: '13', descricao: 'Fornecedor 2' }, { id: '14', descricao: '' }, { id: '15', descricao: 'T'.repeat(40) }] },
      sem_filtro: { status: 200, n: 100 },
      por_tipo: { status: 200, n: 2, tipo: { id: '933846847', descricao: 'FORNECEDÓR bx/b' } },
      pesquisa: { status: 200, n: 5, com_o_texto: 2 },
      motivo: null });
    const txt = JSON.stringify(v);
    for (const s of SEGREDO.concat(['Shenzhen', 'shenzhen', 'Outro'])) assert.ok(!txt.includes(s), 'nada de contato (nem o texto buscado) na resposta: ' + s);
  }
  /* ── sem texto: não busca; sem tipo de fornecedor: não filtra ── */
  {
    const b = bling((c) => (c === '/contatos/tipos' ? ok([{ id: 1, descricao: 'Cliente' }]) : padrao(c)));
    const v = await sondarFornecedores(b.get, { q: '   ' });
    assert.deepStrictEqual([b.caminhos, v.por_tipo, v.pesquisa, v.sem_filtro], [['/contatos/tipos', LISTA], null, null, { status: 200, n: 100 }]);
    const b2 = bling(padrao); const v2 = await sondarFornecedores(b2.get);
    assert.deepStrictEqual([b2.caminhos.length, v2.pesquisa, v2.por_tipo.n], [3, null, 2], 'sem opções: tipos, lista e filtro por tipo');
  }
  /* ── o texto buscado vai codificado e aparado em 60 ── */
  {
    const b = bling(padrao);
    await sondarFornecedores(b.get, { q: 'a&b=c d' + 'x'.repeat(80) });
    assert.strictEqual(b.caminhos[3], LISTA + '&pesquisa=' + encodeURIComponent('a&b=c d' + 'x'.repeat(53)));
  }
  /* ── falha de uma pergunta não inventa número, e as outras seguem ── */
  {
    const b = bling((c) => (c === '/contatos/tipos' ? { ok: false, status: 429, limite: true } : c === LISTA ? { ok: true, status: 200, data: { data: 'torto' } } : c.includes('pesquisa') ? new Error('rede') : padrao(c)));
    const v = await sondarFornecedores(b.get, { q: 'x' });
    assert.deepStrictEqual(v, { tipos: { status: 429, lista: null }, sem_filtro: { status: 200, n: null }, por_tipo: null, pesquisa: { status: null, n: null, com_o_texto: null }, motivo: null }, 'sem os tipos não há filtro por tipo; resposta torta e erro viram "sem número"');
    const b2 = bling((c) => (c.includes('idTipoContato') ? { ok: false, status: 400, data: { error: { type: 'VALIDATION_ERROR' } } } : c.includes('pesquisa') ? { ok: false, status: 200, data: { data: [contato('x')] } } : padrao(c)));
    const v2 = await sondarFornecedores(b2.get, { q: 'x' });
    assert.deepStrictEqual([v2.por_tipo, v2.pesquisa], [{ status: 400, n: null, tipo: { id: '933846847', descricao: 'FORNECEDÓR bx/b' } }, { status: 200, n: null, com_o_texto: null }], 'filtro recusado sai com o código; "ok:false" não conta mesmo com lista');
    for (const torto of [null, undefined, 'x', 7]) { const v3 = await sondarFornecedores(async () => torto); assert.deepStrictEqual([v3.tipos, v3.sem_filtro, v3.por_tipo], [{ status: null, lista: null }, { status: null, n: null }, null]); }
  }
  /* ── sem acesso ao Bling ── */
  assert.deepStrictEqual(await sondarFornecedores(undefined, { q: 'x' }), { tipos: { status: null, lista: null }, sem_filtro: { status: null, n: null }, por_tipo: null, pesquisa: null, motivo: 'sem acesso ao Bling nesta empresa' });
  /* ── prazo: a pergunta pendurada é cancelada; o que já veio fica; o resto não é perguntado ── */
  {
    let sinal = null; const cam = [];
    const v = await sondarFornecedores((c, n, s) => { cam.push(c); if (c === LISTA) { sinal = s; return new Promise(() => {}); } return Promise.resolve(padrao(c)); }, { q: 'x', prazoMs: 60 });
    assert.deepStrictEqual([cam, sinal.aborted, v.tipos.status, v.sem_filtro, v.por_tipo, v.pesquisa, v.motivo], [['/contatos/tipos', LISTA], true, 200, { status: null, n: null }, null, null, 'o Bling não respondeu em 0 s — o que já tinha vindo está acima; tente de novo']);
    /* respondeu logo: o relógio do prazo é DESLIGADO (senão ele segura o processo e dispara um cancelamento à toa) */
    { const st = global.setTimeout, ct = global.clearTimeout; const vivos = new Set();
      global.setTimeout = (f, ms) => { const t = st(f, ms); if (ms === 5000) vivos.add(t); return t; }; global.clearTimeout = (t) => { vivos.delete(t); return ct(t); };
      try { await sondarFornecedores(async (c) => padrao(c), { prazoMs: 5000 }); assert.strictEqual(vivos.size, 0, 'o relógio do prazo foi desligado'); }
      finally { global.setTimeout = st; global.clearTimeout = ct; vivos.forEach((t) => ct(t)); } }
    const v2 = await sondarFornecedores((c) => new Promise(() => {}), { prazoMs: 40 });
    assert.strictEqual(v2.motivo.indexOf('o Bling não respondeu em'), 0);
  }

  /* ═══ B. a rota, na fábrica de verdade ═══ */
  process.env.ADMIN_KEY = 'k';
  for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    let resp = null, admin = true, chave = 'k';
    const cham = [];
    const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => chave, validarSessao: () => (admin ? { usuario: 'diego' } : null), readJson: (a, pad) => pad, writeJson: () => {},
      CACHE_DIR: '/tmp/_compras_forn_' + empresa, fsx: fs, pathx: path, ehAdmin: () => admin, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
      LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: () => null, blingGet: async (c) => { cham.push(c); return c.startsWith('/pedidos/compras') ? ok([{ id: 1 }]) : padrao(c); } };
    const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
    const pedir = async (qs, metodo) => { resp = null; cham.length = 0; const u = new URL('http://h' + prefixo + '/compras-sonda' + (qs || '')); const t = await rot({ method: metodo || 'GET', headers: {} }, {}, prefixo + '/compras-sonda', metodo || 'GET', u); return [t, resp]; };
    let [t, r] = await pedir('?fornecedores=1&q=Shenzhen');
    assert.deepStrictEqual([t, r.code, r.body.ok, r.body.empresa, r.body.sem_filtro, r.body.por_tipo.n, r.body.pesquisa, cham.length, cham[3]], [true, 200, true, empresa, { status: 200, n: 100 }, 2, { status: 200, n: 5, com_o_texto: 2 }, 4, LISTA + '&pesquisa=Shenzhen'], empresa + ': ' + JSON.stringify(r));
    assert.ok(!SEGREDO.concat(['Shenzhen']).some((s) => JSON.stringify(r.body).includes(s)), empresa + ': a rota não devolve dado de contato');
    [t, r] = await pedir('?fornecedores=1');
    assert.deepStrictEqual([r.body.pesquisa, cham.length], [null, 3], empresa + ': sem q, sem busca');
    /* sem o parâmetro (ou com outro valor): a sonda de sempre */
    for (const qs of ['', '?fornecedores=0', '?fornecedores=sim']) { [t, r] = await pedir(qs); assert.deepStrictEqual([r.body.permissao, cham, 'tipos' in r.body], ['sim', ['/pedidos/compras?pagina=1&limite=1'], false], empresa + ' ' + qs); }
    /* só admin: 404 e o Bling nem é chamado */
    chave = 'errada'; admin = false;
    [t, r] = await pedir('?fornecedores=1&q=x');
    assert.deepStrictEqual([t, r.code, r.body, cham.length], [true, 404, { error: 'not found' }, 0], empresa + ': quem não é admin não vê');
    [t, r] = await pedir('?fornecedores=1', 'POST');
    assert.ok(!(r && r.body && r.body.tipos) && cham.length === 0, empresa + ': POST não sonda');
  }
  delete process.env.ADMIN_KEY;
  terminou = true; process.exitCode = 0;
  console.log('ok — Compras, a sonda dos fornecedores no Bling: os tipos de contato, a 1ª página sem filtro, o filtro pelo tipo "fornecedor" e a busca por texto (só quando pedida), uma pergunta de cada vez; só contagens e códigos saem (nenhum dado de contato, nem o texto buscado); falha não inventa número; prazo com cancelamento; a rota é só de admin, nas três empresas, e sem o parâmetro segue a sonda de sempre');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
