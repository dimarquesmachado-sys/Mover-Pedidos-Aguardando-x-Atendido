'use strict';
/* 14/11 — AS CONVERSAS GUARDADAS DO CHAT DE ANÁLISE (lib/checkout/chat-conversas.js).

   Pedido do dono: voltar numa conversa do chat — revisitar, com título, renomear e apagar.

   O que se prova (a peça de produção, com arquivo de verdade num diretório temporário):
   · a 1ª troca cria a conversa (o título é a pergunta, numa linha, com teto); as seguintes entram na MESMA conversa;
   · a lista vem da mais recente pra mais antiga, sem o texto; abrir devolve as trocas na ordem;
   · renomear e apagar; renomear não muda a ordem da lista;
   · os limites: conversas demais (a mais antiga sai), trocas demais (as mais antigas saem), texto grande (cortado);
   · o ID que vem de fora só passa no formato exato da peça (`__proto__`, caminho de arquivo e lixo não passam), e ID
     desconhecido vira conversa NOVA (nunca grava por cima de outra);
   · troca sem pergunta ou sem resposta não é guardada; arquivo estragado não derruba a peça.
   B. PELA ROTA DE VERDADE (o histórico de produção de uma empresa, a API da Anthropic de mentira): a resposta que termina é
      guardada pelo SERVIDOR e o `fim` devolve o id; a pergunta seguinte, com o id, entra na mesma conversa; pergunta que
      dá erro não é guardada; disco que falha não derruba a resposta; listar, abrir, renomear e apagar são só do admin e
      não gastam pergunta (funcionam até com o chat desligado); o estado traz o gasto do MÊS.
   C. A TELA (o script de produção num documento de mentira): a pergunta leva o id da conversa; "conversas" lista; abrir
      redesenha as trocas (texto escapado) e a próxima pergunta leva o histórico e o id; renomear e apagar chamam o
      servidor; "nova conversa" larga o id; o rodapé mostra o gasto de hoje e do mês. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim'); process.exitCode = 1; } });

/* a rede de mentira (antes de qualquer peça carregar o node-fetch): a API da Anthropic e o Supabase */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-rota-'));
process.env.ADMIN_KEY = 'chave-adm'; process.env.GOODBKP_ADMIN = 'dono'; process.env.GOODBKP_CACHE_DIR = TMP; process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;
const rede = { api: [], roteiro: [] };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com/')) { rede.api.push(JSON.parse(opts.body)); let t = rede.roteiro.shift(); if (!t) throw new Error('a API foi chamada mais vezes do que o roteiro previa'); if (typeof t === 'function') t = t(); if (t instanceof Error) throw t; return t; }
  return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
} };

const CV = require('../lib/checkout/chat-conversas');
const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const novo = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')); let t = Date.parse('2026-11-14T15:00:00.000Z'); const c = CV.criar({ CACHE_DIR: dir, readJson, writeJson, agora: () => t }); return { dir, c, passa: (min) => { t += min * 60000; } }; };

{
  const { dir, c, passa } = novo();
  assert.deepStrictEqual([c.listar(), c.abrir('c12345678-90abcd')], [[], null]);
  /* a 1ª troca cria a conversa; o título é a pergunta, numa linha só */
  const a = c.registrar(null, { pergunta: '  Por que caiu\n\no faturamento\tda semana passada?  ', resposta: 'Caiu R$ 2.000,00.', usd_estimado: 0.0553 });
  assert.ok(a && a.nova === true && CV.idValido(a.id) && a.titulo === 'Por que caiu o faturamento da semana passada?', JSON.stringify(a));
  passa(5);
  const a2 = c.registrar(a.id, { pergunta: 'E por canal?', resposta: 'Quase tudo no Mercado Livre.', usd_estimado: 0.02 });
  assert.deepStrictEqual(a2, { id: a.id, titulo: a.titulo, nova: false }, 'a 2ª troca entra na MESMA conversa, sem mudar o título');
  passa(5);
  const b = c.registrar(undefined, { pergunta: 'Qual item mais vendeu?', resposta: 'O ITEM-1.' });
  assert.ok(b.nova && b.id !== a.id);
  /* a lista: da mais recente pra mais antiga, sem o texto, com o custo somado (ou nulo, se nenhuma troca tem custo) */
  assert.deepStrictEqual(c.listar(), [{ id: b.id, titulo: 'Qual item mais vendeu?', criada_em: '2026-11-14T15:10:00.000Z', atualizada_em: '2026-11-14T15:10:00.000Z', trocas: 1, usd_estimado: null },
    { id: a.id, titulo: a.titulo, criada_em: '2026-11-14T15:00:00.000Z', atualizada_em: '2026-11-14T15:05:00.000Z', trocas: 2, usd_estimado: 0.0753 }]);
  /* abrir: as trocas na ordem, com o texto */
  const ab = c.abrir(a.id);
  assert.deepStrictEqual([ab.id, ab.titulo, ab.trocas], [a.id, a.titulo, [{ em: '2026-11-14T15:00:00.000Z', pergunta: 'Por que caiu\n\no faturamento\tda semana passada?', resposta: 'Caiu R$ 2.000,00.', usd_estimado: 0.0553 },
    { em: '2026-11-14T15:05:00.000Z', pergunta: 'E por canal?', resposta: 'Quase tudo no Mercado Livre.', usd_estimado: 0.02 }]]);
  /* conversar de novo na mais antiga a leva pro topo; renomear NÃO mexe na ordem */
  passa(5);
  c.registrar(a.id, { pergunta: 'E a margem?', resposta: 'Provisória.' });
  assert.deepStrictEqual(c.listar().map((x) => x.id), [a.id, b.id]);
  assert.deepStrictEqual([c.renomear(b.id, '  Itens\nmais   vendidos  '), c.listar().map((x) => [x.id, x.titulo])], [true, [[a.id, a.titulo], [b.id, 'Itens mais vendidos']]]);
  assert.deepStrictEqual([c.renomear(b.id, '   '), c.renomear(b.id, null), c.renomear('c00000000-zzzzzz', 'x'), c.renomear('../etc', 'x'), c.listar()[1].titulo], [false, false, false, false, 'Itens mais vendidos'], 'título vazio ou conversa que não existe não renomeia');
  assert.strictEqual(c.listar().find((x) => x.id === a.id).titulo, a.titulo);
  const longo = 'x'.repeat(300);
  assert.ok(c.renomear(b.id, longo) && c.listar()[1].titulo.length === CV.MAX_TITULO && c.listar()[1].titulo.endsWith('…'), 'o título tem teto');
  /* apagar */
  assert.deepStrictEqual([c.apagar(b.id), c.apagar(b.id), c.apagar('c00000000-zzzzzz'), c.listar().map((x) => x.id), c.abrir(b.id)], [true, false, false, [a.id], null]);
  /* o que não é troca não é guardado */
  for (const t of [null, {}, { pergunta: 'oi' }, { resposta: 'oi' }, { pergunta: '   ', resposta: 'x' }, { pergunta: 'x', resposta: '\n' }]) assert.strictEqual(c.registrar(a.id, t), null);
  assert.strictEqual(c.abrir(a.id).trocas.length, 3);
  /* ID que vem de fora: só o formato exato da peça. O que não passa (ou não existe) vira conversa NOVA — nunca grava por cima */
  assert.deepStrictEqual(['__proto__', 'constructor', '../../etc/passwd', 'c', 'C12345678-90abcd', 'c1234 5678-90abcd', 'c12345678-90abcdcdef', 'c12345678-90abc', 'c12345678-90ABCD', 'c12345678-90abcd'.repeat(3), '', null, undefined, 12345678901, {}, ['c12345678-90abcd']].map(CV.idValido), new Array(16).fill(false));
  assert.deepStrictEqual([CV.idValido(a.id), CV.idValido('c12345678-90abcd')], [true, true]);
  for (const ruim of ['__proto__', '../x', 'c00000000-zzzzzz', 12345]) {
    const r = c.registrar(ruim, { pergunta: 'p ' + ruim, resposta: 'r' });
    assert.ok(r && r.nova === true && CV.idValido(r.id) && r.id !== ruim, 'ID ruim/desconhecido tinha que abrir conversa nova: ' + ruim);
    assert.strictEqual(c.abrir(ruim), null);
    c.apagar(r.id);
  }
  assert.strictEqual(c.abrir(a.id).trocas.length, 3, 'a conversa que já existia não foi tocada');
  assert.deepStrictEqual(Object.keys({}).length, 0);
  /* o arquivo é o da empresa, no formato esperado */
  const noDisco = readJson(path.join(dir, CV.ARQUIVO), null);
  assert.ok(noDisco && Array.isArray(noDisco.conversas) && noDisco.conversas.length === 1 && noDisco.conversas[0].id === a.id);
}
/* os limites */
{
  const { c, passa } = novo();
  const ids = [];
  for (let i = 0; i < CV.MAX_CONVERSAS + 5; i++) { ids.push(c.registrar(null, { pergunta: 'pergunta ' + i, resposta: 'r' }).id); passa(1); }
  const l = c.listar();
  assert.deepStrictEqual([l.length, l[0].titulo, l[l.length - 1].titulo, c.abrir(ids[0]), new Set(ids).size], [CV.MAX_CONVERSAS, 'pergunta ' + (CV.MAX_CONVERSAS + 4), 'pergunta 5', null, CV.MAX_CONVERSAS + 5], 'passou do teto de conversas: as mais ANTIGAS saem');
  const id = l[0].id;
  for (let i = 0; i < CV.MAX_TROCAS + 3; i++) c.registrar(id, { pergunta: 'p' + i, resposta: 'r' + i });
  const ab = c.abrir(id);
  assert.deepStrictEqual([ab.trocas.length, ab.trocas[0].pergunta, ab.trocas[ab.trocas.length - 1].pergunta], [CV.MAX_TROCAS, 'p3', 'p' + (CV.MAX_TROCAS + 2)], 'passou do teto de trocas: as mais antigas saem');
  c.registrar(id, { pergunta: 'q'.repeat(CV.MAX_TEXTO + 50), resposta: 'w'.repeat(CV.MAX_TEXTO + 50) });
  const ult = c.abrir(id).trocas.slice(-1)[0];
  assert.ok(ult.pergunta.length === CV.MAX_TEXTO + 4 && ult.pergunta.endsWith(' […]') && ult.resposta.length === CV.MAX_TEXTO + 4, 'texto grande é cortado');
}
/* arquivo estragado, e falha de disco */
{
  const { dir, c } = novo();
  for (const lixo of ['isto não é json', JSON.stringify({ conversas: 'x' }), JSON.stringify([1, 2]), JSON.stringify({ conversas: [null, 5, { id: '__proto__', trocas: [] }, { id: 'c12345678-90abcd' }, { id: 'c12345678-90abcd', trocas: [{ pergunta: 'a', resposta: 'b' }] }] })]) {
    fs.writeFileSync(path.join(dir, CV.ARQUIVO), lixo);
    assert.ok(Array.isArray(c.listar()));
  }
  assert.deepStrictEqual(c.listar().map((x) => [x.id, x.trocas]), [['c12345678-90abcd', 1]], 'do arquivo estragado só sobra a conversa bem formada');
  const quebrado = CV.criar({ CACHE_DIR: dir, readJson, writeJson: () => { throw new Error('disco cheio'); } });
  assert.throws(() => quebrado.registrar(null, { pergunta: 'p', resposta: 'r' }), /disco cheio/, 'falha de disco tem que aparecer pra quem chama (ele decide o que fazer)');
  assert.throws(() => CV.criar({ readJson, writeJson }), /falta CACHE_DIR/);
}
(async () => {
  /* ═══ B. PELA ROTA DE VERDADE ═══ */
  const C = require('../lib/checkout/chat-analise');
  const turno = (texto) => {
    const evs = [{ type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: texto } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } }, { type: 'message_stop' }];
    const b = Buffer.from(evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), 'utf8');
    return { ok: true, status: 200, text: async () => '', body: (async function* () { yield b; })() };
  };
  const novoRes = () => ({ _json: null, _txt: '', writeHead() {}, setHeader() {}, write(x) { this._txt += String(x); return true; }, end(x) { if (x != null) this._txt += String(x); }, on() {} });
  const P = '/good-checkout-offline';
  const discoQuebrado = { ligado: false };
  const escrever = (f, o) => { if (discoQuebrado.ligado && f.endsWith(CV.ARQUIVO)) throw new Error('disco cheio'); fs.writeFileSync(f, JSON.stringify(o)); };
  const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: (ck) => (ck === 'sess=dono' ? 'dono' : ck === 'sess=operador' ? 'operador' : null), supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: TMP,
    json: (res, st, o) => { res._json = [st, o]; }, writeJson: escrever, garantirTokenML: null, MANIFEST_FILE: null });
  const ADM = { 'x-admin-key': 'chave-adm' };
  const pedir = async (metodo, consulta, corpo, headers) => { const res = novoRes(); await h({ method: metodo, headers: headers || ADM, body: corpo }, res, new URL('http://x' + P + '/chat-analise' + (consulta || ''))); return res; };
  const perguntar = async (corpo, roteiro) => { rede.roteiro = roteiro; const res = await pedir('POST', '', corpo); return res._txt.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); };
  const _log = console.log; console.log = () => {};
  try {
    assert.deepStrictEqual((await pedir('GET', '?conversas=1'))._json, [200, { ok: true, conversas: [] }]);
    /* a 1ª resposta cria a conversa — quem guarda é o servidor, e o `fim` devolve o id */
    let ev = await perguntar({ pergunta: 'Por que caiu o faturamento?' }, [turno('Caiu **R$ 2.000,00**.')]);
    const fim1 = ev.find((e) => e.t === 'fim');
    assert.ok(fim1 && fim1.conversa && fim1.conversa.nova === true && CV.idValido(fim1.conversa.id) && fim1.conversa.titulo === 'Por que caiu o faturamento?', 'o fim da resposta não trouxe a conversa guardada: ' + JSON.stringify(fim1));
    const id = fim1.conversa.id;
    /* a 2ª, com o id, entra na MESMA conversa */
    ev = await perguntar({ pergunta: 'E por canal?', conversa: id, historico: [{ role: 'user', content: 'Por que caiu o faturamento?' }, { role: 'assistant', content: 'Caiu **R$ 2.000,00**.' }] }, [turno('Quase tudo no Mercado Livre.')]);
    assert.deepStrictEqual(ev.find((e) => e.t === 'fim').conversa, { id, titulo: 'Por que caiu o faturamento?', nova: false });
    /* id que não existe (ou lixo) abre conversa NOVA — nunca grava por cima */
    ev = await perguntar({ pergunta: 'Outra coisa', conversa: '../../etc/passwd' }, [turno('Resposta.')]);
    const id2 = ev.find((e) => e.t === 'fim').conversa.id;
    assert.ok(CV.idValido(id2) && id2 !== id && ev.find((e) => e.t === 'fim').conversa.nova === true);
    /* a lista (mais recente primeiro, sem o texto, com o custo) e a conversa inteira */
    let l = (await pedir('GET', '?conversas=1'))._json[1].conversas;
    assert.deepStrictEqual(l.map((c) => [c.id, c.titulo, c.trocas, c.usd_estimado]), [[id2, 'Outra coisa', 1, 0.003], [id, 'Por que caiu o faturamento?', 2, 0.006]]);
    assert.ok(!JSON.stringify(l).includes('Mercado Livre'), 'a lista não leva o texto das conversas');
    const ab = (await pedir('GET', '?conversa=' + id))._json[1];
    assert.deepStrictEqual([ab.ok, ab.conversa.trocas.map((t) => [t.pergunta, t.resposta, t.usd_estimado])], [true, [['Por que caiu o faturamento?', 'Caiu **R$ 2.000,00**.', 0.003], ['E por canal?', 'Quase tudo no Mercado Livre.', 0.003]]]);
    assert.deepStrictEqual((await pedir('GET', '?conversa=__proto__'))._json[1], { ok: false, erro: 'essa conversa não existe mais' });
    /* pergunta que dá ERRO não é guardada; o `fim` nem chega */
    ev = await perguntar({ pergunta: 'vai falhar', conversa: id }, [new Error('ECONNRESET')]);
    assert.ok(ev.some((e) => e.t === 'erro') && !ev.some((e) => e.t === 'fim'));
    assert.strictEqual((await pedir('GET', '?conversa=' + id))._json[1].conversa.trocas.length, 2, 'a pergunta que falhou foi guardada');
    /* quem perguntou FECHOU a tela no meio (entre a consulta e a resposta final): o pedaço que saiu não é guardado */
    {
      const evs = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou olhar o calendário.' } }, { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'calendario_comercial', input: {} } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ de: '2026-11-01', ate: '2026-11-30' }) } }, { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
      const b = Buffer.from(evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), 'utf8');
      const res = novoRes(); let fechar = null; res.on = (n, f) => { if (n === 'close') fechar = f; };
      rede.roteiro = [() => { fechar(); return { ok: true, status: 200, text: async () => '', body: (async function* () { yield b; })() }; }];
      await h({ method: 'POST', headers: ADM, body: { pergunta: 'a tela vai fechar', conversa: id } }, res, new URL('http://x' + P + '/chat-analise'));
      const reg = (await pedir('GET', '?diag=1'))._json[1].ultimas[0];
      assert.ok(/cancelada/.test(reg.estado), 'o teste supõe uma pergunta cancelada no meio: ' + reg.estado);
      assert.deepStrictEqual([(await pedir('GET', '?conversa=' + id))._json[1].conversa.trocas.length, (await pedir('GET', '?conversas=1'))._json[1].conversas.length], [2, 2], 'a pergunta cancelada no meio foi guardada como se tivesse sido respondida');
    }
    /* o disco que falha não derruba a resposta: ela chega inteira, sem o id */
    discoQuebrado.ligado = true;
    ev = await perguntar({ pergunta: 'com o disco cheio', conversa: id }, [turno('Resposta com o disco cheio.')]);
    discoQuebrado.ligado = false;
    const fimD = ev.find((e) => e.t === 'fim');
    assert.ok(fimD && fimD.conversa === null && ev.filter((e) => e.t === 'texto').map((e) => e.d).join('') === 'Resposta com o disco cheio.', 'com o disco falhando, a resposta tinha que chegar do mesmo jeito (sem a conversa): ' + JSON.stringify(ev));
    assert.ok(/não consegui guardar a conversa: disco cheio/.test(JSON.stringify((await pedir('GET', '?diag=1'))._json[1].ultimas[0].passos)), 'a falha ao guardar tem que ficar no registro da pergunta');
    /* renomear e apagar: só admin, não gastam pergunta, e devolvem a lista */
    const usoAntes = JSON.stringify(JSON.parse(fs.readFileSync(path.join(TMP, '_chat-analise-uso.json'), 'utf8')));
    rede.api.length = 0;
    let r = (await pedir('POST', '', { acao: 'renomear', id, titulo: '  Queda da\nsemana  ' }))._json[1];
    assert.deepStrictEqual([r.ok, r.conversas.map((c) => c.titulo)], [true, ['Outra coisa', 'Queda da semana']]);
    assert.deepStrictEqual([(await pedir('POST', '', { acao: 'renomear', id, titulo: '   ' }))._json[1].ok, (await pedir('POST', '', { acao: 'renomear', id: 'c00000000-zzzzzz', titulo: 'x' }))._json[1].ok, (await pedir('POST', '', { acao: 'explodir', id }))._json[0]], [false, false, 400]);
    r = (await pedir('POST', '', { acao: 'apagar', id: id2 }))._json[1];
    assert.deepStrictEqual([r.ok, r.conversas.map((c) => c.id), (await pedir('POST', '', { acao: 'apagar', id: id2 }))._json[1].ok], [true, [id], false]);
    /* o que NÃO deu (já não existia / título vazio) devolve a lista como está no disco — a tela mostra a verdade */
    assert.deepStrictEqual([(await pedir('POST', '', { acao: 'apagar', id: id2 }))._json[1].conversas.map((c) => c.id), (await pedir('POST', '', { acao: 'renomear', id, titulo: ' ' }))._json[1].conversas.map((c) => c.id)], [[id], [id]], 'apagar/renomear que não deu tinha que devolver a lista de verdade');
    assert.deepStrictEqual([rede.api.length, JSON.stringify(JSON.parse(fs.readFileSync(path.join(TMP, '_chat-analise-uso.json'), 'utf8')))], [0, usoAntes], 'renomear/apagar não chamam o modelo nem gastam pergunta');
    /* quem não é admin não lista, não abre, não renomeia e não apaga */
    for (const cab of [{}, { cookie: 'sess=operador' }]) {
      for (const [m, q, c] of [['GET', '?conversas=1'], ['GET', '?conversa=' + id], ['POST', '', { acao: 'renomear', id, titulo: 'invadi' }], ['POST', '', { acao: 'apagar', id }]]) {
        assert.deepStrictEqual((await pedir(m, q, c, cab))._json, [404, { error: 'not found' }], 'rota das conversas aberta pra quem não é admin: ' + m + ' ' + q);
      }
    }
    assert.strictEqual((await pedir('GET', '?conversas=1'))._json[1].conversas[0].titulo, 'Queda da semana');
    /* com o chat DESLIGADO (sem a chave da API) dá pra ler e arrumar as conversas — só perguntar é que não */
    delete process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT;
    assert.strictEqual((await pedir('GET', '?conversas=1'))._json[1].conversas.length, 1);
    assert.strictEqual((await pedir('POST', '', { acao: 'renomear', id, titulo: 'Sem a chave' }))._json[1].ok, true);
    assert.ok(/falta a variável ANTHROPIC_API_KEY_DASHBOARD_CHAT/.test((await pedir('POST', '', { pergunta: 'oi' }))._json[1].erro));
    process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
    /* o estado traz o gasto do MÊS: a soma dos dias do mês que o contador guarda (dia de outro mês fica de fora) */
    const hoje = C.hojeSP(), mes = hoje.slice(0, 7);
    const uso = JSON.parse(fs.readFileSync(path.join(TMP, '_chat-analise-uso.json'), 'utf8'));
    const outroDia = mes + (hoje.slice(8) === '01' ? '-02' : '-01');
    uso[outroDia] = { perguntas: 10, tokens_entrada: 5000, tokens_saida: 500, usd_estimado: 1.5 }; uso['2001-01-15'] = { perguntas: 99, tokens_entrada: 9, tokens_saida: 9, usd_estimado: 99 }; uso.lixo = { usd_estimado: 50 };
    fs.writeFileSync(path.join(TMP, '_chat-analise-uso.json'), JSON.stringify(uso));
    const st = (await pedir('GET', ''))._json[1];
    assert.deepStrictEqual([st.mes.mes, st.mes.dias_com_uso, st.mes.perguntas, st.mes.usd_estimado, st.mes.tokens_entrada], [mes, 2, st.hoje.perguntas + 10, Math.round((st.hoje.usd_estimado + 1.5) * 10000) / 10000, st.hoje.tokens_entrada + 5000]);
    ev = await perguntar({ pergunta: 'mais uma', conversa: id }, [turno('ok')]);
    assert.strictEqual(ev.find((e) => e.t === 'fim').mes.usd_estimado, Math.round((st.mes.usd_estimado + 0.003) * 10000) / 10000, 'o fim da resposta traz o gasto do mês já com esta pergunta');
  } finally { console.log = _log; }

  /* ═══ C. A TELA ═══ */
  {
    const { scriptDoChatAnalise } = require('../lib/checkout/painel-chat-analise');
    const porId = {}; const pedidos = []; let respostas = [];
    const no = (tag) => ({ tag, style: { cssText: '', display: '' }, filhos: [], _txt: '', _html: null, attrs: {}, pai: null, ouvintes: {}, value: '', disabled: false,
      appendChild(f) { if (f.pai) f.pai.filhos = f.pai.filhos.filter((x) => x !== f); this.filhos.push(f); f.pai = this; return f; },
      insertBefore(f) { return this.appendChild(f); }, remove() { if (this.pai) this.pai.filhos = this.pai.filhos.filter((x) => x !== this); },
      get parentNode() { return this.pai; }, get firstChild() { return this.filhos[0] || null; }, setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(n, f) { this.ouvintes[n] = f; }, focus() {},
      set textContent(v) { this._txt = String(v); this._html = null; if (v === '') this.filhos = []; }, get textContent() { return this._txt; },
      set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
      set id(v) { this._id = v; porId[v] = this; }, get id() { return this._id; }, scrollTop: 0, scrollHeight: 0 });
    const aqui = no('div'); aqui.id = 'chatAnaliseAqui';
    const sse = (evs) => evs.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
    const fetchFalso = (url, opts) => {
      pedidos.push({ url, opts: opts || {} });
      const r = respostas.shift(); if (!r) return Promise.reject(new Error('sem roteiro'));
      const partes = r.fluxo ? [new TextEncoder().encode(r.fluxo)] : [];
      return Promise.resolve({ ok: !r.status || r.status < 400, status: r.status || 200, headers: { get: () => (r.fluxo ? 'text/event-stream' : 'application/json') }, json: () => Promise.resolve(r.json),
        body: { getReader: () => ({ read: () => Promise.resolve(partes.length ? { done: false, value: partes.shift() } : { done: true }) }) } });
    };
    new Function('document', 'window', 'fetch', 'setTimeout', scriptDoChatAnalise('/amb-checkout-offline'))({ getElementById: (i) => porId[i] || null, createElement: no }, { location: { search: '?k=minha%20chave' } }, fetchFalso, () => {});
    const esperar = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
    const textoDe = (n) => (n._html != null ? n._html : n._txt) + n.filhos.map(textoDe).join('|');
    const painel = porId.chatAnalisePainel, [topo, lista, rodape] = painel.filhos, caixa = rodape.filhos[0], enviar = rodape.filhos[1].filhos[1];
    const btConversas = porId.chatAnaliseConversas, btNova = topo.filhos[2];
    const corpoDe = (i) => JSON.parse(pedidos[i].opts.body);
    /* abre: o rodapé mostra hoje e o mês */
    respostas = [{ json: { ok: true, configurado: true, hoje: { perguntas: 4, limite_perguntas: 200, usd_estimado: 0.2104 }, mes: { usd_estimado: 1.7104 } } }];
    porId.chatAnaliseBotao.onclick(); await esperar();
    assert.ok(/Hoje: 4 de 200 perguntas · ≈ US\$ 0,2104 · mês ≈ US\$ 1,7104\. Enter envia\./.test(textoDe(rodape)), 'o rodapé não mostra o gasto de hoje e do mês: ' + textoDe(rodape));
    /* a 1ª pergunta vai sem conversa; o fim devolve o id e a 2ª pergunta leva ele */
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'Resposta um.' }, { t: 'fim', uso: {}, hoje: { perguntas: 5, limite_perguntas: 200, usd_estimado: 0.3 }, mes: { usd_estimado: 1.8 }, conversa: { id: 'cmhz5k9qq-p1p1p1', titulo: 'p1', nova: true } }]) },
      { fluxo: sse([{ t: 'texto', d: 'Resposta dois.' }, { t: 'fim', uso: {}, conversa: { id: 'cmhz5k9qq-p1p1p1', titulo: 'p1', nova: false } }]) }];
    caixa.value = 'pergunta um'; enviar.onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(1).pergunta, 'conversa' in corpoDe(1)], ['pergunta um', false], 'a 1ª pergunta de uma conversa nova não leva id');
    assert.ok(/Hoje: 5 de 200 perguntas · ≈ US\$ 0,30 · mês ≈ US\$ 1,80\./.test(textoDe(rodape)), textoDe(rodape));
    caixa.value = 'pergunta dois'; enviar.onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(2).conversa, corpoDe(2).historico.length], ['cmhz5k9qq-p1p1p1', 2], 'a pergunta seguinte tem que levar o id da conversa que o servidor devolveu');
    /* "conversas": a lista, com o título como TEXTO (nada de HTML) */
    const LISTA = [{ id: 'cmhz1k2ab-a1b2c3', titulo: 'Queda <img src=x onerror=alert(1)>', atualizada_em: '2026-11-14T15:00:00.000Z', trocas: 2, usd_estimado: 0.0863 }, { id: 'cmhz0aaaa-zzzzzz', titulo: 'Margem de outubro', atualizada_em: '2026-11-11T15:00:00.000Z', trocas: 1, usd_estimado: null }];
    respostas = [{ json: { ok: true, conversas: LISTA } }];
    btConversas.onclick(); await esperar();
    assert.strictEqual(pedidos[3].url, '/amb-checkout-offline/chat-analise?k=minha%20chave&conversas=1');
    const linhas = lista.filhos.slice(1);
    assert.deepStrictEqual([linhas.length, linhas[0].filhos[0].filhos[0].textContent, linhas[0].filhos[0].filhos[0].innerHTML, linhas.map((x) => x.filhos.slice(1).map((b) => b.textContent))], [2, 'Queda <img src=x onerror=alert(1)>', null, [['renomear', 'apagar'], ['renomear', 'apagar']]], 'a lista de conversas não foi desenhada (ou o título virou HTML)');
    assert.ok(/2 perguntas · ≈ US\$ 0,0863/.test(linhas[0].filhos[0].filhos[1].textContent) && /1 pergunta$/.test(linhas[1].filhos[0].filhos[1].textContent));
    /* renomear: campo na própria linha, e o servidor é quem grava */
    linhas[1].filhos[1].onclick();
    const campo = lista.filhos[2].filhos[0];
    assert.deepStrictEqual([campo.tag, campo.value, lista.filhos[2].filhos.slice(1).map((b) => b.textContent)], ['input', 'Margem de outubro', ['salvar', 'cancelar']]);
    campo.value = 'Margem — outubro';
    respostas = [{ json: { ok: true, conversas: [LISTA[0], Object.assign({}, LISTA[1], { titulo: 'Margem — outubro' })] } }];
    lista.filhos[2].filhos[1].onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(4), pedidos[4].opts.method, lista.filhos[2].filhos[0].filhos[0].textContent], [{ acao: 'renomear', id: 'cmhz0aaaa-zzzzzz', titulo: 'Margem — outubro' }, 'POST', 'Margem — outubro']);
    /* apagar: pede confirmação NA LINHA (sem janela do navegador); cancelar não chama o servidor */
    lista.filhos[2].filhos[2].onclick();
    assert.deepStrictEqual([lista.filhos[2].filhos[0].textContent, lista.filhos[2].filhos.slice(1).map((b) => b.textContent), pedidos.length], ['Apagar esta conversa?', ['apagar', 'cancelar'], 5]);
    lista.filhos[2].filhos[2].onclick();
    assert.deepStrictEqual([pedidos.length, lista.filhos.length], [5, 3], 'cancelar o apagar tinha que só redesenhar a lista');
    lista.filhos[2].filhos[2].onclick();
    respostas = [{ json: { ok: true, conversas: [LISTA[0]] } }];
    lista.filhos[2].filhos[1].onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(5), lista.filhos.length], [{ acao: 'apagar', id: 'cmhz0aaaa-zzzzzz' }, 2]);
    /* abrir: as trocas redesenhadas (o texto ESCAPADO) e a próxima pergunta leva o histórico e o id */
    respostas = [{ json: { ok: true, conversa: { id: 'cmhz1k2ab-a1b2c3', titulo: 'Queda', trocas: [{ pergunta: 'p <b>1</b>', resposta: 'r **1** <script>x()</script>' }, { pergunta: 'p2', resposta: 'r2' }] } } }];
    lista.filhos[1].filhos[0].onclick(); await esperar();
    assert.strictEqual(pedidos[6].url, '/amb-checkout-offline/chat-analise?k=minha%20chave&conversa=cmhz1k2ab-a1b2c3');
    assert.deepStrictEqual(lista.filhos.slice(1).map((b) => [b.textContent, b.innerHTML]), [['p <b>1</b>', null], ['', 'r <b>1</b> &lt;script&gt;x()&lt;/script&gt;'], ['p2', null], ['', 'r2']], 'a conversa aberta não foi redesenhada com o texto escapado');
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'r3' }, { t: 'fim', uso: {}, conversa: { id: 'cmhz1k2ab-a1b2c3', titulo: 'Queda', nova: false } }]) }];
    caixa.value = 'p3'; enviar.onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(7).conversa, corpoDe(7).historico.map((m) => m.content)], ['cmhz1k2ab-a1b2c3', ['p <b>1</b>', 'r **1** <script>x()</script>', 'p2', 'r2']], 'a pergunta feita na conversa ABERTA tinha que entrar nela (o id dela, não o da conversa de antes) e levar o histórico dela');
    assert.deepStrictEqual([lista.filhos.length, lista.filhos[5].textContent], [7, 'p3'], 'a conversa aberta tinha que continuar na tela, com a pergunta nova embaixo: ' + textoDe(lista));
    /* "nova conversa" larga o id e o histórico */
    btNova.onclick();
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'nova' }, { t: 'fim', uso: {}, conversa: { id: 'cmhz9zzzz-000000', titulo: 'x', nova: true } }]) }];
    caixa.value = 'começando outra'; enviar.onclick(); await esperar();
    assert.deepStrictEqual(['conversa' in corpoDe(8), corpoDe(8).historico], [false, []], '"nova conversa" tinha que largar a conversa anterior');
    /* abrir a LISTA é sair da conversa que estava na tela: perguntar dali começa conversa NOVA, e a lista sai da tela
       (o que o chat recebe de contexto é o que está na tela) */
    respostas = [{ json: { ok: true, conversas: [{ id: 'cmhz9zzzz-000000', titulo: 'x', atualizada_em: null, trocas: 1, usd_estimado: null }] } }];
    btConversas.onclick(); await esperar();
    assert.ok(/Conversas guardadas desta loja/.test(textoDe(lista)) && lista.filhos.length === 2);
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'ok' }, { t: 'fim', uso: {}, conversa: { id: 'cmhzb1111-222222', titulo: 'da lista', nova: true } }]) }];
    caixa.value = 'perguntei com a lista na tela'; enviar.onclick(); await esperar();
    assert.deepStrictEqual(['conversa' in corpoDe(10), corpoDe(10).historico], [false, []], 'perguntar com a LISTA na tela continuou a conversa de antes (que nem está mais na tela)');
    assert.deepStrictEqual([lista.filhos.length, lista.filhos[0].textContent, /Conversas guardadas/.test(textoDe(lista))], [2, 'perguntei com a lista na tela', false], 'a lista das conversas ficou na tela junto com a pergunta nova: ' + textoDe(lista));
    /* …e a conversa nova segue normal: a pergunta seguinte leva o id dela */
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'ok2' }, { t: 'fim', uso: {}, conversa: { id: 'cmhzb1111-222222', titulo: 'da lista', nova: false } }]) }];
    caixa.value = 'mais uma'; enviar.onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(11).conversa, corpoDe(11).historico.length, lista.filhos.length], ['cmhzb1111-222222', 2, 4]);
    /* apagar a última: a lista fica vazia, com o aviso */
    respostas = [{ json: { ok: true, conversas: [{ id: 'cmhzb1111-222222', titulo: 'da lista', atualizada_em: null, trocas: 2, usd_estimado: null }] } }];
    btConversas.onclick(); await esperar();
    lista.filhos[1].filhos[2].onclick();
    respostas = [{ json: { ok: true, conversas: [] } }];
    lista.filhos[1].filhos[1].onclick(); await esperar();
    assert.deepStrictEqual([corpoDe(13), /Nenhuma conversa guardada ainda/.test(textoDe(lista))], [{ acao: 'apagar', id: 'cmhzb1111-222222' }, true]);
    /* NÃO APAGOU: a tela diz, e a conversa continua na lista (nunca some da tela o que não foi apagado) */
    {
      const UMA = [{ id: 'cmhzc3333-444444', titulo: 'fica aqui', atualizada_em: null, trocas: 1, usd_estimado: null }];
      const apagarA1a = async (resp) => { lista.filhos[1].filhos[2].onclick(); respostas = [resp]; lista.filhos[1].filhos[1].onclick(); await esperar(); };
      respostas = [{ json: { ok: true, conversas: UMA } }];
      btConversas.onclick(); await esperar();
      /* o disco falhou (o servidor responde sem lista): fica a lista que a tela tinha, com o motivo */
      await apagarA1a({ json: { ok: false, erro: 'não consegui gravar: disco cheio' } });
      assert.deepStrictEqual([lista.filhos.length, lista.filhos[1].filhos[0].filhos[0].textContent, lista.filhos[2].textContent], [3, 'fica aqui', 'não consegui gravar: disco cheio'], 'o apagar falhou e a conversa sumiu da tela (ou a tela não disse por quê): ' + textoDe(lista));
      /* o servidor nem respondeu direito (HTTP 500) */
      await apagarA1a({ status: 500, json: null });
      assert.deepStrictEqual([lista.filhos.length, lista.filhos[1].filhos[0].filhos[0].textContent, lista.filhos[2].textContent], [3, 'fica aqui', 'Não consegui apagar.'], 'o servidor não respondeu o apagar e a conversa sumiu da tela: ' + textoDe(lista));
      /* renomear que não deu: idem (a lista de antes, com o motivo) */
      lista.filhos[1].filhos[1].onclick(); lista.filhos[1].filhos[0].value = 'outro nome';
      respostas = [{ status: 500, json: null }];
      const nAntes = pedidos.length; let segurou = 0;
      lista.filhos[1].filhos[0].ouvintes.keydown({ key: 'a', preventDefault() { segurou++; } });
      assert.deepStrictEqual([pedidos.length, segurou], [nAntes, 0], 'digitar no campo do título não é salvar');
      lista.filhos[1].filhos[0].ouvintes.keydown({ key: 'Enter', preventDefault() { segurou++; } }); await esperar();   /* Enter no campo salva */
      assert.deepStrictEqual([corpoDe(nAntes), segurou], [{ acao: 'renomear', id: 'cmhzc3333-444444', titulo: 'outro nome' }, 1], 'Enter no campo do título tinha que salvar');
      assert.deepStrictEqual([lista.filhos.length, lista.filhos[1].filhos[0].filhos[0].textContent, lista.filhos[2].textContent], [3, 'fica aqui', 'Não consegui renomear.']);
      /* a conversa já não existia (apagada noutra aba): o servidor manda a lista de verdade, e é ela que a tela mostra */
      await apagarA1a({ json: { ok: false, erro: 'essa conversa já não existia', conversas: [{ id: 'cmhzd5555-666666', titulo: 'a que sobrou', atualizada_em: null, trocas: 3, usd_estimado: null }] } });
      assert.deepStrictEqual([lista.filhos.length, lista.filhos[1].filhos[0].filhos[0].textContent, lista.filhos[2].textContent], [3, 'a que sobrou', 'essa conversa já não existia']);
    }
    /* o servidor não respondeu a lista: avisa (não deixa a tela vazia) */
    respostas = [{ json: null }];
    btConversas.onclick(); await esperar();
    assert.ok(/Não consegui carregar as conversas guardadas/.test(textoDe(lista)));
    /* da lista pra "nova conversa": a abertura fica na tela e a pergunta entra embaixo dela (a lista não é mais a tela) */
    btNova.onclick();
    respostas = [{ fluxo: sse([{ t: 'texto', d: 'oi' }, { t: 'fim', uso: {} }]) }];
    caixa.value = 'depois da lista'; enviar.onclick(); await esperar();
    assert.deepStrictEqual([lista.filhos.length, /^Oi! Pergunte sobre as vendas/.test(lista.filhos[0].textContent), lista.filhos[1].textContent], [3, true, 'depois da lista'], 'depois de "nova conversa" a tela não é mais a lista: ' + textoDe(lista));
    /* ── RESPOSTA QUE CHEGA TARDE não mexe na tela que já é outra ──
       (a rede demora: o dono clica e, antes de a resposta chegar, já fez outra coisa) */
    {
      const UMA = [{ id: 'cmhze7777-888888', titulo: 'guardada', atualizada_em: null, trocas: 1, usd_estimado: null }];
      const fluxo = (t) => ({ fluxo: sse([{ t: 'texto', d: t }, { t: 'fim', uso: {} }]) });
      const tela = () => lista.filhos.map((b) => b.textContent || (b._html != null ? b._html : ''));
      const soAConversa = (pergunta, resp, oQue) => assert.deepStrictEqual([lista.filhos.length, lista.filhos[0].textContent, /Conversas guardadas|guardada/.test(textoDe(lista))], [2, pergunta, false], oQue + ' chegou depois e passou por cima da pergunta em andamento: ' + textoDe(lista));
      /* 1. pediu a LISTA e perguntou antes de ela chegar */
      respostas = [{ json: { ok: true, conversas: UMA } }, fluxo('r-pressa')];
      btConversas.onclick(); caixa.value = 'com pressa'; enviar.onclick(); await esperar();
      soAConversa('com pressa', 'r-pressa', 'a lista');
      assert.strictEqual('conversa' in corpoDe(pedidos.length - 1), false);
      /* 2. mandou APAGAR e perguntou antes de a resposta chegar */
      respostas = [{ json: { ok: true, conversas: UMA } }]; btConversas.onclick(); await esperar();
      lista.filhos[1].filhos[2].onclick();
      respostas = [{ json: { ok: true, conversas: [] } }, fluxo('r2')];
      lista.filhos[1].filhos[1].onclick(); caixa.value = 'depois do apagar'; enviar.onclick(); await esperar();
      soAConversa('depois do apagar', 'r2', 'a resposta do apagar');
      /* 3. mandou RENOMEAR e perguntou antes de a resposta chegar */
      respostas = [{ json: { ok: true, conversas: UMA } }]; btConversas.onclick(); await esperar();
      lista.filhos[1].filhos[1].onclick();
      respostas = [{ json: { ok: true, conversas: UMA } }, fluxo('r3')];
      lista.filhos[1].filhos[1].onclick(); caixa.value = 'depois do renomear'; enviar.onclick(); await esperar();
      soAConversa('depois do renomear', 'r3', 'a resposta do renomear');
      /* 4. mandou ABRIR uma conversa e clicou "nova conversa" antes de ela chegar: fica a abertura, e a pergunta seguinte
            NÃO entra na conversa que chegou tarde */
      respostas = [{ json: { ok: true, conversas: UMA } }]; btConversas.onclick(); await esperar();
      respostas = [{ json: { ok: true, conversa: { id: 'cmhze7777-888888', titulo: 'guardada', trocas: [{ pergunta: 'velha', resposta: 'velha' }] } } }];
      lista.filhos[1].filhos[0].onclick(); btNova.onclick(); await esperar();
      assert.deepStrictEqual([lista.filhos.length, /^Oi! Pergunte/.test(lista.filhos[0].textContent), /velha/.test(textoDe(lista))], [2, true, false], 'a conversa que chegou tarde passou por cima da "nova conversa": ' + tela().join(' | '));
      respostas = [fluxo('r4')];
      caixa.value = 'nova de verdade'; enviar.onclick(); await esperar();
      assert.deepStrictEqual(['conversa' in corpoDe(pedidos.length - 1), corpoDe(pedidos.length - 1).historico], [false, []], 'a pergunta entrou na conversa que chegou tarde');
    }
  }

  _chegouAoFim = true;
  console.log('ok — conversas do chat: a troca terminada é guardada pelo servidor (título pela 1ª pergunta), lista leve da mais recente pra mais antiga, abrir/renomear/apagar só do admin e sem gastar pergunta, tetos, ID de fora só no formato da peça; a tela leva o id, lista, abre, renomeia e apaga; e o rodapé mostra o gasto de hoje e do mês');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
