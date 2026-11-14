'use strict';
/* 14/11 — O CHAT DE ANÁLISE PELO CAMINHO DE PRODUÇÃO INTEIRO: servidor HTTP de verdade, TODOS os módulos do serviço na
   ordem em que o index.js os chama, o corpo da pergunta lido do fluxo real e a resposta (SSE) lida por um cliente HTTP
   de verdade. Só o banco e a API da Anthropic são de mentira.

   POR QUE EXISTE: no 1º teste do dono em produção a tela mostrou "NetworkError" (a conexão caiu). Os testes do chat
   provavam as contas, a conversa e a tela — mas com pedido e resposta de MENTIRA (um objeto com `body`), nunca pelo
   servidor real. Este é o que faltava pra separar "o código quebra em produção" de "a conexão caiu no caminho":
   · a pergunta passa por todos os módulos que vêm ANTES do checkout da empresa (nenhum pode engolir o corpo dela);
   · o corpo é lido do fluxo HTTP de verdade, e a resposta sai em pedaços de verdade (cabeçalhos mandados na hora);
   · nas TRÊS empresas;
   · quem pergunta e FECHA a conexão no meio não derruba o serviço — a pergunta seguinte responde;
   · o registro (`?diag=1`) conta o que aconteceu, lido por HTTP;
   · nenhuma exceção solta / promessa rejeitada sem tratamento durante tudo isso (é o que mataria o processo em produção). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const raiz = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-real-'));
const CHAVE = 'chave-servidor-real';
process.env.ADMIN_KEY = CHAVE;
for (const p of ['GIRABKP', 'AMBBKP', 'GOODBKP']) process.env[p + '_CACHE_DIR'] = path.join(TMP, p);
process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tiktok');
process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-servidor-real';
for (const e of ['AMB', 'AMBTOTAL', 'GIRASSOL', 'GOOD']) { process.env['SUPABASE_URL_VENDAS_' + e] = 'https://supa.test'; process.env['SUPABASE_KEY_VENDAS_' + e] = 'k'; }
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;

/* ── as duas pontas de mentira ── */
const rede = { api: 0, banco: 0, outras: [] };
const sse = (evs) => evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
const LINHAS = [1, 2, 3].map((i) => ({ numero_pedido: 'R' + i, numero_loja: 'r' + i, canal: 'ml', data_venda: '2026-11-13', sku: 'ITEM-' + i, descricao: 'Item ' + i, quantidade: 1,
  valor_produto: 100 * i, valor_nota: 100 * i, custo: 40 * i, comissao: 15 * i, frete_vendedor: 0, imposto: 5 * i, margem: 40 * i, uf: 'SP' }));
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) {
    rede.api++;
    const corpo = JSON.parse(opts.body);
    const ultima = corpo.messages[corpo.messages.length - 1];
    const jaConsultou = Array.isArray(ultima.content) && ultima.content.some((b) => b.type === 'tool_result');
    const lenta = /fechar a conex/.test(JSON.stringify(corpo.messages[0]));
    const evs = jaConsultou
      ? [{ type: 'message_start', message: { usage: { input_tokens: 300, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vendeu R$ 600,00 em 3 pedidos.' } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }]
      : [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou olhar. ' } }, { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'resumo_periodo', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"de":"2026-11-13","ate":"2026-11-13"}' } }, { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }, { type: 'message_stop' }];
    const txt = sse(evs);
    /* na pergunta "lenta" a API demora entre os pedaços — dá tempo de o cliente fechar a conexão no meio */
    const corpoFluxo = lenta ? Readable.from((async function* () { yield Buffer.from(txt.slice(0, 260)); await dorme(250); yield Buffer.from(txt.slice(260)); })()) : Readable.from([Buffer.from(txt)]);
    return { ok: true, status: 200, text: async () => '', body: corpoFluxo };
  }
  if (/supa\.test/.test(url)) {
    rede.banco++;
    const m = /vendas_historico.*data_venda=gte\.(\d{4}-\d{2}-\d{2})&data_venda=lte\.(\d{4}-\d{2}-\d{2}).*offset=(\d+)/.exec(url);
    const r = m && m[3] === '0' ? LINHAS.filter((l) => l.data_venda >= m[1] && l.data_venda <= m[2]) : [];
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
  }
  rede.outras.push(url.slice(0, 80));
  return Promise.reject(new Error('rede bloqueada no teste'));
};
fake.default = fake;
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fake };
global.fetch = fake;

const soltas = [];
process.on('unhandledRejection', (e) => { soltas.push('promessa rejeitada sem tratamento: ' + String((e && (e.stack || e.message)) || e).slice(0, 300)); });
process.on('uncaughtException', (e) => { soltas.push('exceção solta: ' + String((e && (e.stack || e.message)) || e).slice(0, 300)); });

/* ── um cliente HTTP de verdade ── */
function pedir(porta, metodo, caminho, corpo, opcoes) {
  opcoes = opcoes || {};
  return new Promise((ok, falha) => {
    const dados = corpo == null ? null : JSON.stringify(corpo);
    const headers = dados == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) };
    const rq = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (rs) => {
      let b = '', pedacos = 0;
      rs.on('data', (c) => { b += c; pedacos++; if (opcoes.fecharNoPrimeiroPedaco) { rq.destroy(); ok({ status: rs.statusCode, tipo: rs.headers['content-type'], corpo: b, pedacos, fechouNoMeio: true }); } });
      rs.on('end', () => ok({ status: rs.statusCode, tipo: rs.headers['content-type'], corpo: b, pedacos }));
      rs.on('error', (e) => { if (!opcoes.fecharNoPrimeiroPedaco) falha(e); });
    });
    rq.on('error', (e) => { if (!opcoes.fecharNoPrimeiroPedaco) falha(e); });
    rq.setTimeout(20000, () => rq.destroy(new Error('PRESO: 20 s sem resposta em ' + metodo + ' ' + caminho)));
    rq.end(dados);
  });
}
const eventos = (txt) => txt.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));

(async () => {
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  let server = null;
  try {
    /* o servidor montado como o index.js monta: todos os módulos, na ordem da configuração, cada um vendo cada pedido */
    const { json, readBody } = require(path.join(raiz, 'lib', 'http'));
    const empresas = require(path.join(raiz, 'config', 'empresas'));
    const handlers = empresas.map((e) => ({ nome: e.nome, id: e.id, handle: e.routes(readBody) }));
    const ordem = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
    assert.ok(/const handlers = empresas\.map\(e => \(\{\s*nome: e\.nome,\s*id: e\.id,\s*handle: e\.routes\(readBody\)\s*\}\)\);/.test(ordem) && /for \(const h of handlers\) \{\s*const tratou = await h\.handle\(req, res, urlObj\);/.test(ordem),
      'o index.js mudou a forma de montar/chamar os módulos — este teste precisa montar igual');
    assert.ok(handlers.length >= 15, 'eram pra ser todos os módulos do serviço: ' + handlers.length);
    server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, 'http://localhost');
      try { for (const h of handlers) { if (await h.handle(req, res, urlObj)) return; } }
      catch (e) { soltas.push('erro no handler: ' + String(e.stack || e.message).slice(0, 300)); return json(res, 500, { error: e.message }); }
      return json(res, 404, { error: 'not found' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const porta = server.address().port;

    const PERGUNTA = 'ONTEM, Faturamento Total R$ 3.490,91 · 32 pedidos, o que pode ter ocasionado essa queda na última sexta-feira 13? E comparado a outras sextas?';
    for (const P of ['/amb-checkout-offline', '/girassol-backup-offline', '/good-checkout-offline']) {
      const antes = { api: rede.api, banco: rede.banco };
      const t0 = Date.now();
      const r = await pedir(porta, 'POST', P + '/chat-analise?k=' + CHAVE, { pergunta: PERGUNTA, historico: [] });
      assert.ok(r.status === 200 && /^text\/event-stream/.test(String(r.tipo)), P + ': a pergunta pelo servidor real respondeu ' + r.status + ' ' + r.tipo + ' — ' + r.corpo.slice(0, 200));
      const ev = eventos(r.corpo);
      assert.deepStrictEqual(ev.map((e) => e.t), ['inicio', 'texto', 'passo', 'texto', 'texto', 'fim'], P + ': o fluxo que chegou no cliente: ' + JSON.stringify(ev.map((e) => e.t)));
      assert.strictEqual(ev.filter((e) => e.t === 'texto').map((e) => e.d).join(''), 'Vou olhar. \n\nVendeu R$ 600,00 em 3 pedidos.');
      assert.deepStrictEqual(ev[2], { t: 'passo', texto: 'Lendo as vendas de 13/11 a 13/11' });
      const fim = ev[ev.length - 1];
      assert.deepStrictEqual([fim.uso.tokens_entrada, fim.uso.tokens_saida, fim.uso.idas_ao_modelo, fim.uso.consultas, fim.hoje.perguntas], [400, 29, 2, 1, 1], P + ': uso errado no fim: ' + JSON.stringify(fim));
      assert.ok(r.pedacos >= 2, P + ': a resposta tinha que chegar em mais de um pedaço (o começo é mandado na hora): ' + r.pedacos);
      assert.deepStrictEqual([rede.api - antes.api, rede.banco - antes.banco > 0], [2, true], P + ': eram 2 idas à API e a consulta ao banco de vendas');
      assert.ok(Date.now() - t0 < 10000, P + ': demorou demais');
      /* o registro, lido por HTTP */
      const d = await pedir(porta, 'GET', P + '/chat-analise?diag=1&k=' + CHAVE);
      const dj = JSON.parse(d.corpo);
      assert.ok(d.status === 200 && dj.ok && dj.ultimas.length === 1 && dj.ultimas[0].estado === 'respondida' && dj.ultimas[0].quem === 'chave de admin' && dj.ultimas[0].passos.length === 6, P + ': o registro não contou a pergunta: ' + d.corpo.slice(0, 300));
      /* e sem credencial o portão segue na frente, também pelo servidor real */
      assert.strictEqual((await pedir(porta, 'POST', P + '/chat-analise', { pergunta: 'oi' })).status, 401);
      assert.strictEqual((await pedir(porta, 'GET', P + '/chat-analise?diag=1')).status, 401);
    }

    /* quem pergunta FECHA a conexão no meio da resposta: o serviço não cai, e a pergunta seguinte responde */
    {
      const P = '/amb-checkout-offline';
      const cortada = await pedir(porta, 'POST', P + '/chat-analise?k=' + CHAVE, { pergunta: 'vou fechar a conexão no meio' }, { fecharNoPrimeiroPedaco: true });
      assert.ok(cortada.fechouNoMeio && cortada.status === 200);
      await dorme(600);   /* o tempo de a API de mentira terminar o fluxo lento e o servidor perceber a conexão fechada */
      const depois = await pedir(porta, 'POST', P + '/chat-analise?k=' + CHAVE, { pergunta: 'e agora, responde?' });
      assert.deepStrictEqual(eventos(depois.corpo).map((e) => e.t).pop(), 'fim', 'depois de um cliente fechar no meio, a pergunta seguinte tinha que responder');
      const dj = JSON.parse((await pedir(porta, 'GET', P + '/chat-analise?diag=1&k=' + CHAVE)).corpo);
      const reg = dj.ultimas.find((x) => /vou fechar a conex/.test(x.pergunta));
      assert.ok(reg && reg.estado === 'cancelada (a tela fechou no meio)' && reg.passos.some((p) => /a conexão com a tela FECHOU/.test(p)), 'o registro tinha que dizer que a tela fechou no meio: ' + JSON.stringify(reg));
    }

    assert.deepStrictEqual(rede.outras, [], 'alguma coisa tentou rede fora do banco e da API de mentira: ' + rede.outras.join(' | '));
    assert.deepStrictEqual(soltas, [], 'exceção solta / promessa rejeitada sem tratamento (em produção isso derruba o serviço): ' + soltas.join(' || '));
  } finally { console.log = _log; console.error = _err; if (server) server.close(); }
  console.log('ok — chat de análise pelo servidor real: a pergunta atravessa todos os módulos, o corpo é lido do fluxo HTTP, a resposta chega em pedaços, nas três; conexão fechada no meio não derruba o serviço; o registro conta tudo; nenhuma exceção solta');
  _chegouAoFim = true;
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
