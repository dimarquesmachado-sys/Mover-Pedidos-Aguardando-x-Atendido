'use strict';
/* 14/11 — O CHAT DE ANÁLISE NAS TRÊS EMPRESAS, pelo `routes` REAL de cada uma, e A TELA rodando de verdade.

   scripts/teste-chat-analise.js prova as contas e a conversa. Este prova a ligação e a tela:

   1. NAS TRÊS (módulo de produção de cada empresa, `mod.routes(readBody)`, rede bloqueada e contada):
      · o script do botão (`<prefixo>/js/chat-analise.js`) é servido com o prefixo DA EMPRESA, sem login (é só código de
        tela, como as outras peças do painel) — e é JavaScript válido;
      · o dashboard que a empresa serve injeta a peça;
      · a rota do chat fica atrás do portão: sem credencial 401; operador que não é admin 404; admin vê o estado;
      · sem a env da chave, perguntar devolve "falta a variável…" — e NADA sai pra rede.
   2. A TELA (o script de produção rodando num navegador de mentira): o botão abre a conversa; a pergunta vai com o
      histórico; o texto chega em pedaços e é desenhado ESCAPADO (texto do modelo com <script>/<img onerror> não vira
      HTML); o passo da consulta aparece; o rodapé mostra consultas, tokens e custo; erro do servidor vira aviso; a
      resposta que falhou não entra no histórico; sem a chave configurada a caixa fica desligada com o motivo. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ⚠️ teste que fica PRESO num `await` que nunca resolve não trava o Node: a fila de eventos esvazia e o processo sai com
   código 0, sem ter chegado ao fim — verde falso. (Pego provando este teste por mutação: tirar o estouro do prazo da API
   deixava a pergunta pendurada pra sempre e o teste "passava".) Só é verde se chegou ao fim. */
let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const raiz = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tres-'));
const CHAVE = 'chave-teste-chat';
process.env.ADMIN_KEY = CHAVE;
for (const p of ['GIRABKP', 'AMBBKP', 'GOODBKP']) { process.env[p + '_ADMIN'] = 'dono-teste'; process.env[p + '_CACHE_DIR'] = path.join(TMP, p); }
process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tiktok');
delete process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT;

const rede = [];
{
  const recusa = (quem) => (...a) => { rede.push(quem + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); return Promise.reject(new Error('rede bloqueada no teste')); };
  const k = require.resolve('node-fetch');
  const duble = recusa('node-fetch'); duble.default = duble;
  require.cache[k] = { id: k, filename: k, loaded: true, exports: duble };
  global.fetch = recusa('fetch');
  for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = (...a) => { rede.push(m + '.' + f + ' ' + String(a[0] && (a[0].href || a[0].hostname || a[0])).slice(0, 80)); throw new Error('rede bloqueada no teste'); }; }
}

const EMPRESAS = [
  ['girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
  ['amb', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['good', 'good-checkout-offline/index.js', '/good-checkout-offline'],
];
function cookieDe(nome, fonte) {
  const m = /const SESS_COOKIE\s*=\s*'([^']+)'/.exec(fonte);
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + 600000 })).toString('base64url');
  return m[1] + '=' + pl + '.' + crypto.createHmac('sha256', CHAVE).update(pl).digest('base64url');
}
async function pedir(handler, metodo, caminho, { cookie, chave, corpo } = {}) {
  const res = { _s: 0, _b: '', _fim: false, writeHead(s) { this._s = s; }, setHeader() {}, write(x) { this._b += String(x); return true; }, end(b) { this._fim = true; if (b != null) this._b += String(b); } };
  const u = new URL('http://x' + caminho + (chave ? '?k=' + encodeURIComponent(chave) : ''));
  const headers = {}; if (cookie) headers.cookie = cookie;
  const req = { method: metodo, url: u.pathname + u.search, headers };
  if (corpo !== undefined) req.body = corpo;
  const tratou = await handler(req, res, u);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { tratou, status: res._s, corpo: res._b, j };
}

/* ── um navegador de mentira, só com o que o script usa ── */
function navegador(respostas, semEspaco) {
  const porId = {};
  function no(tag) {
    const e = { tag, filhos: [], style: { cssText: '' }, _txt: '', _html: null, ouvintes: {}, disabled: false, value: '',
      appendChild(f) { this.filhos.push(f); f.pai = this; return f; },
      remove() { if (this.pai) this.pai.filhos = this.pai.filhos.filter((x) => x !== this); delete porId[this._id]; },
      addEventListener(n, f) { this.ouvintes[n] = f; }, focus() {},
      get firstChild() { return this.filhos[0] || null; },
      set textContent(v) { this._txt = String(v); this._html = null; if (v === '') this.filhos = []; }, get textContent() { return this._txt; },
      set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
      set id(v) { this._id = v; porId[v] = this; }, get id() { return this._id; },
      scrollTop: 0, scrollHeight: 0 };
    return e;
  }
  const body = no('body');
  if (!semEspaco) { const aqui = no('div'); aqui.id = 'chatAnaliseAqui'; body.appendChild(aqui); }
  const pedidos = [];
  const fetchFalso = (url, opts) => {
    pedidos.push({ url, opts: opts || {} });
    const r = respostas.shift();
    if (!r) return Promise.reject(new Error('sem roteiro'));
    if (r.falha) return Promise.reject(new Error(r.falha));
    const partes = (r.pedacos || []).map((x) => new TextEncoder().encode(x));
    return Promise.resolve({ ok: r.status == null || r.status < 400, status: r.status || 200, headers: { get: () => r.tipo || 'application/json' }, json: () => Promise.resolve(r.json),
      body: { getReader: () => ({ read: () => Promise.resolve(partes.length ? { done: false, value: partes.shift() } : { done: true }) }) } });
  };
  const sandbox = { document: { getElementById: (i) => porId[i] || null, createElement: no, body }, window: { location: { search: '?k=minha%20chave' } }, fetch: fetchFalso, URLSearchParams, TextDecoder, TextEncoder, JSON, String, Number, Promise, encodeURIComponent };
  return { sandbox, body, porId, pedidos, aqui: porId.chatAnaliseAqui };
}
const textoDe = (n) => (n._html != null ? n._html : n._txt) + n.filhos.map(textoDe).join('|');
const esperar = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  try {
    const { scriptDoChatAnalise, SUGESTOES } = require('../lib/checkout/painel-chat-analise');

    /* ═══ 1. nas três, pelo routes real ═══ */
    for (const [emp, arq, P] of EMPRESAS) {
      const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const operador = cookieDe('estoquista-teste', fonte), dono = cookieDe('dono-teste', fonte);
      const antesRede = rede.length;

      const js = await pedir(h, 'GET', P + '/js/chat-analise.js');
      assert.ok(js.tratou === true && js.status === 200, emp + ': o script do chat não é servido sem login (' + js.status + ' ' + js.corpo.slice(0, 80) + ') — quem abre o dashboard pela chave ficaria sem o botão');
      assert.strictEqual(js.corpo, scriptDoChatAnalise(P), emp + ': o script servido não é o da peça com o prefixo dela');
      assert.ok(js.corpo.includes('var BASE = ' + JSON.stringify(P) + ';') && js.corpo.includes("'chatAnaliseBotao'"));
      for (const [, , outro] of EMPRESAS) if (outro !== P) assert.ok(!js.corpo.includes(outro), emp + ': o script veio com o prefixo de outra empresa');
      assert.doesNotThrow(() => new Function(js.corpo), emp + ': o script do chat não é JavaScript válido');

      const dash = await pedir(h, 'GET', P + '/dashboard', { chave: CHAVE });   /* a página do dashboard é só do admin */
      assert.ok(dash.status === 200 && dash.corpo.includes("['caScript', 'chat-analise', '?v=2']") && dash.corpo.includes("el.src = '" + P + "/js/' + par[1] + '.js'"), emp + ': o dashboard que a empresa serve não injeta a peça do chat com o prefixo dela');
      /* o espaço da peça existe e fica FORA do #app (que é redesenhado a cada troca de período) */
      assert.ok(/<div id="app">.*<\/div><\/div>\n(<!--[\s\S]*?-->\n)?<div id="chatAnaliseAqui"><\/div>/.test(dash.corpo), emp + ': o dashboard não tem o espaço do chat fora do #app');

      for (const met of ['GET', 'POST']) {
        const r = await pedir(h, met, P + '/chat-analise', { corpo: { pergunta: 'oi' } });
        assert.ok(r.status === 401 && r.j && /Sess[aã]o necess[aá]ria/.test(r.j.erro || ''), emp + ': ' + met + ' /chat-analise SEM credencial respondeu ' + r.status + ' — a rota ficou na frente do portão');
        const o = await pedir(h, met, P + '/chat-analise', { cookie: operador, corpo: { pergunta: 'oi' } });
        assert.ok(o.tratou === true && o.status === 404 && o.j && o.j.error === 'not found', emp + ': operador que NÃO é admin entrou no chat (' + o.status + ')');
      }
      for (const cred of [{ chave: CHAVE }, { cookie: dono }]) {
        const st = await pedir(h, 'GET', P + '/chat-analise', cred);
        assert.ok(st.status === 200 && st.j && st.j.ok === true && st.j.configurado === false && st.j.env === 'ANTHROPIC_API_KEY_DASHBOARD_CHAT' && st.j.hoje.perguntas === 0, emp + ': o estado do chat não respondeu pro admin: ' + st.status + ' ' + st.corpo.slice(0, 120));
        const p = await pedir(h, 'POST', P + '/chat-analise', Object.assign({ corpo: { pergunta: 'quanto vendi?' } }, cred));
        assert.ok(p.status === 200 && p.j && p.j.ok === false && /falta a variável ANTHROPIC_API_KEY_DASHBOARD_CHAT/.test(p.j.erro), emp + ': sem a env da chave, a pergunta tinha que dizer o que falta: ' + p.corpo.slice(0, 120));
      }
      process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-x';
      assert.strictEqual((await pedir(h, 'GET', P + '/chat-analise', { chave: CHAVE })).j.configurado, true, emp + ': com a env, o estado tinha que dizer "configurado"');
      delete process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT;
      assert.deepStrictEqual(rede.slice(antesRede), [], emp + ': alguma coisa tentou REDE: ' + rede.slice(antesRede).join(' | '));
    }

    /* ═══ 2. a tela ═══ */
    const sseDe = (evs) => evs.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
    const MALICIOSO = 'Caiu **R$ 2.000,00** <img src=x onerror=alert(1)> & <script>x()</script>\n_(aviso do sistema)_ SKU_COM_UNDERLINE_NO_MEIO';
    {
      /* (com um sinal de vida do servidor no meio — linha de comentário do SSE, que a tela tem que ignorar) */
      const fluxo = sseDe([{ t: 'inicio', modelo: 'm' }, { t: 'passo', texto: 'Comparando 26/10–01/11 com 02/11–08/11' }, { t: 'texto', d: MALICIOSO.slice(0, 30) }]) + ': vivo\n\n' + sseDe([{ t: 'texto', d: MALICIOSO.slice(30) },
        { t: 'fim', uso: { tokens_entrada: 10500, tokens_saida: 300, consultas: 2, usd_estimado: 0.024 }, hoje: { perguntas: 3, limite_perguntas: 200 } }]);
      /* o fluxo chega picado no meio de um evento */
      const N = navegador([{ json: { ok: true, configurado: true, env: 'X', hoje: { perguntas: 2, limite_perguntas: 200 } } },
        { tipo: 'text/event-stream; charset=utf-8', pedacos: [fluxo.slice(0, 57), fluxo.slice(57, 203), fluxo.slice(203)] },
        { status: 200, json: { ok: false, erro: 'O limite de 200 perguntas por dia desta loja foi atingido.' } },
        { tipo: 'text/event-stream', pedacos: [sseDe([{ t: 'texto', d: 'segunda resposta' }, { t: 'fim', uso: { consultas: 1, tokens_entrada: 5, tokens_saida: 5, usd_estimado: null } }])] },
        { falha: 'Failed to fetch' }]);
      const script = scriptDoChatAnalise('/amb-checkout-offline');
      const rodar = () => new Function('S', 'with (S) { ' + script + '\n}')(N.sandbox);
      rodar();
      const botao = N.porId.chatAnaliseBotao, painel = N.porId.chatAnalisePainel;
      assert.ok(botao && painel && N.porId.chatAnaliseEstilo && N.aqui.filhos.length === 3 && painel.style.cssText.includes('display:none'), 'o botão, a folha de estilo da posição dele e o painel (fechado) não foram criados no espaço da peça');
      assert.ok(/Perguntar ao Claude/.test(botao.textContent));
      rodar();
      assert.strictEqual(N.aqui.filhos.length, 3, 'injetar a peça de novo (o dashboard redesenha) não pode criar um segundo botão');
      /* tela sem o espaço da peça: não desenha e não estoura */
      const semEsp = navegador([], true);
      new Function('S', 'with (S) { ' + script + '\n}')(semEsp.sandbox);
      assert.ok(!semEsp.porId.chatAnaliseBotao && semEsp.body.filhos.length === 0);

      botao.onclick(); await esperar();
      assert.strictEqual(painel.style.display, 'flex');
      assert.deepStrictEqual([N.pedidos[0].url, N.pedidos[0].opts.method], ['/amb-checkout-offline/chat-analise?k=minha%20chave', undefined], 'ao abrir, a tela pergunta o estado (com a chave da URL do dashboard)');
      const [topo, lista, rodape] = painel.filhos;
      assert.ok(textoDe(lista).includes(SUGESTOES[0]) && textoDe(rodape).includes('Hoje: 2 de 200 perguntas'), 'a abertura não mostrou as sugestões / o uso do dia');
      const caixa = rodape.filhos[0], enviar = rodape.filhos[1].filhos[1];

      /* 1ª pergunta: pelo Enter */
      caixa.value = '  Por que caiu?  ';
      let evitou = false; caixa.ouvintes.keydown({ key: 'Enter', shiftKey: false, preventDefault() { evitou = true; } });
      assert.ok(evitou && enviar.disabled === true, 'Enter tinha que enviar e travar o botão enquanto responde');
      await esperar();
      const p1 = N.pedidos[1];
      assert.deepStrictEqual([p1.url, p1.opts.method, p1.opts.headers['Content-Type'], JSON.parse(p1.opts.body)], ['/amb-checkout-offline/chat-analise?k=minha%20chave', 'POST', 'application/json', { pergunta: 'Por que caiu?', historico: [] }]);
      const bolhas = lista.filhos;
      assert.ok(!N.porId.chatAnaliseSugestoes, 'as sugestões tinham que sumir depois da 1ª pergunta');
      assert.strictEqual(bolhas[bolhas.length - 2].textContent, 'Por que caiu?');
      const [corpo, passo, pe] = bolhas[bolhas.length - 1].filhos;
      assert.strictEqual(corpo.innerHTML, 'Caiu <b>R$ 2.000,00</b> &lt;img src=x onerror=alert(1)&gt; &amp; &lt;script&gt;x()&lt;/script&gt;<br><i>(aviso do sistema)</i> SKU_COM_UNDERLINE_NO_MEIO',
        'o texto do modelo tem que ser desenhado ESCAPADO (só negrito, itálico de aviso e quebra de linha viram formato)');
      assert.ok(!/<img|<script/i.test(corpo.innerHTML), 'HTML do modelo foi parar na tela sem escape');
      assert.strictEqual(passo.style.display, 'none'); assert.ok(/Comparando 26\/10/.test(passo.textContent));
      assert.strictEqual(pe.textContent, '2 consultas · 10.800 tokens · ≈ US$ 0,024');
      assert.ok(textoDe(rodape).includes('Hoje: 3 de 200 perguntas') && enviar.disabled === false && caixa.value === '');

      /* 2ª: o servidor recusa (JSON, não fluxo) → aviso, e NÃO entra no histórico */
      caixa.value = 'mais uma'; enviar.onclick(); await esperar();
      const r2 = lista.filhos[lista.filhos.length - 1].filhos;
      assert.ok(/limite de 200 perguntas/.test(r2[1].textContent) && r2[1].style.color === '#ef4444');
      assert.deepStrictEqual(JSON.parse(N.pedidos[2].opts.body).historico, [{ role: 'user', content: 'Por que caiu?' }, { role: 'assistant', content: MALICIOSO }], 'a 2ª pergunta tinha que levar a 1ª troca como histórico');

      /* 3ª: responde; o histórico leva só as trocas que deram certo; modelo sem preço → rodapé sem dólar */
      caixa.value = 'e agora?'; enviar.onclick(); await esperar();
      assert.deepStrictEqual(JSON.parse(N.pedidos[3].opts.body).historico.map((m) => m.content), ['Por que caiu?', MALICIOSO], 'a pergunta recusada não pode entrar no histórico');
      const r3 = lista.filhos[lista.filhos.length - 1].filhos;
      assert.deepStrictEqual([r3[0].innerHTML, r3[2].textContent], ['segunda resposta', '1 consulta · 10 tokens']);

      /* 4ª: a rede cai */
      caixa.value = 'caiu?'; enviar.onclick(); await esperar();
      /* (14/11, pego no 1º teste em produção: "NetworkError" sozinho não dizia nada ao dono — a mensagem agora explica o que é e o que fazer) */
      assert.ok(/A conexão com o servidor caiu antes de a resposta terminar\. Se o sistema acabou de ser atualizado, espere um minuto e pergunte de novo\. \(Failed to fetch\)/.test(lista.filhos[lista.filhos.length - 1].filhos[1].textContent));
      assert.strictEqual(enviar.disabled, false, 'depois de um erro a tela tem que destravar');

      /* 5ª: o servidor mandou um pedaço de texto e depois ERRO (a resposta foi interrompida): aparece o erro e o gasto, e
         o pedaço NÃO entra no histórico */
      N.sandbox.fetch = (url, opts) => { N.pedidos.push({ url, opts }); const partes = [new TextEncoder().encode(sseDe([{ t: 'texto', d: 'A queda foi de R$' }, { t: 'erro', erro: 'a resposta da API da Anthropic foi interrompida antes do fim', uso: { tokens_entrada: 300, tokens_saida: 1, usd_estimado: 0.0006 }, hoje: { perguntas: 9, limite_perguntas: 200 } }]))];
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: () => Promise.resolve(partes.length ? { done: false, value: partes.shift() } : { done: true }) }) } }); };
      caixa.value = 'vai cortar'; enviar.onclick(); await esperar();
      const r5 = lista.filhos[lista.filhos.length - 1].filhos;
      assert.ok(/interrompida antes do fim/.test(r5[1].textContent) && r5[1].style.color === '#ef4444' && r5[2].textContent === 'gastou 301 tokens antes de falhar · ≈ US$ 0,0006' && textoDe(rodape).includes('Hoje: 9 de 200'), 'o erro no meio da resposta tem que aparecer, com o gasto: ' + r5[1].textContent + ' | ' + r5[2].textContent);
      N.sandbox.fetch = (url, opts) => { N.pedidos.push({ url, opts }); return Promise.reject(new Error('x')); };
      caixa.value = 'depois do corte'; enviar.onclick(); await esperar();
      assert.deepStrictEqual(JSON.parse(N.pedidos[N.pedidos.length - 1].opts.body).historico.map((m) => m.content), ['Por que caiu?', MALICIOSO, 'e agora?', 'segunda resposta'], 'a resposta interrompida entrou no histórico da conversa');

      /* Codex #873 r4 — a conexão com o NOSSO servidor fecha "limpa" depois de um pedaço de texto, sem `fim` e sem `erro`:
         a tela avisa que foi interrompida e NÃO guarda o pedaço no histórico */
      const fluxoDe = (evs) => (url, opts) => { N.pedidos.push({ url, opts }); const partes = [new TextEncoder().encode(sseDe(evs))];
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: () => Promise.resolve(partes.length ? { done: false, value: partes.shift() } : { done: true }) }) } }); };
      N.sandbox.fetch = fluxoDe([{ t: 'inicio', modelo: 'm' }, { t: 'texto', d: 'A queda foi de R$' }]);
      caixa.value = 'cai sem avisar'; enviar.onclick(); await esperar();
      const r6 = lista.filhos[lista.filhos.length - 1].filhos;
      assert.ok(/interrompida antes do fim \(a conexão caiu\)/.test(r6[1].textContent) && r6[1].style.color === '#ef4444' && r6[1].style.display === '' && enviar.disabled === false, 'fluxo que acabou sem o evento de fim tem que avisar: ' + JSON.stringify(r6[1].textContent));
      /* fluxo que termina com `fim` mas sem texto nenhum: avisa que veio vazia (e também não guarda) */
      N.sandbox.fetch = fluxoDe([{ t: 'inicio', modelo: 'm' }, { t: 'fim', uso: {} }]);
      caixa.value = 'vem vazia'; enviar.onclick(); await esperar();
      assert.ok(/veio vazia/.test(lista.filhos[lista.filhos.length - 1].filhos[1].textContent));
      N.sandbox.fetch = (url, opts) => { N.pedidos.push({ url, opts }); return Promise.reject(new Error('x')); };
      caixa.value = 'depois das duas'; enviar.onclick(); await esperar();
      assert.deepStrictEqual(JSON.parse(N.pedidos[N.pedidos.length - 1].opts.body).historico.map((m) => m.content), ['Por que caiu?', MALICIOSO, 'e agora?', 'segunda resposta'], 'pedaço de resposta sem `fim` (ou resposta vazia) entrou no histórico da conversa');

      /* nova conversa: zera o histórico e volta a abertura; fechar devolve o botão */
      topo.filhos[1].onclick();
      assert.ok(textoDe(lista).includes(SUGESTOES[1]) && lista.filhos.length === 2);
      topo.filhos[2].onclick();
      assert.deepStrictEqual([painel.style.display, botao.style.display], ['none', '']);
    }
    /* Codex #873 r2 — conversa LONGA: seis respostas de 12 mil caracteres. O pedido seguinte tem que caber no limite do
       servidor (64 KiB, medido em bytes): cada mensagem guardada tem teto e as trocas mais antigas saem. Sem isso a 7ª
       pergunta era recusada, o histórico grande ficava e a conversa travava até "nova conversa" */
    for (const nCedilhas of [1500, 1600, 1700, 1800, 1900]) {   /* vários tamanhos de pergunta: o corte tem que tirar trocas INTEIRAS em todos */
      const longa = (i) => ('Resposta ' + i + ' com acentuação e cifrão R$ — ').repeat(300).slice(0, 12000);
      const resp = [{ json: { ok: true, configurado: true, env: 'X', hoje: { perguntas: 0, limite_perguntas: 200 } } }];
      for (let i = 1; i <= 6; i++) resp.push({ tipo: 'text/event-stream', pedacos: [sseDe([{ t: 'texto', d: longa(i) }, { t: 'fim', uso: {} }])] });
      resp.push({ status: 200, json: { ok: false, erro: 'falhou por outro motivo' } });
      resp.push({ tipo: 'text/event-stream', pedacos: [sseDe([{ t: 'texto', d: 'curta' }, { t: 'fim', uso: {} }])] });
      const N = navegador(resp);
      new Function('S', 'with (S) { ' + scriptDoChatAnalise('/amb-checkout-offline') + '\n}')(N.sandbox);
      N.porId.chatAnaliseBotao.onclick(); await esperar();
      const rodape = N.porId.chatAnalisePainel.filhos[2], caixa = rodape.filhos[0], enviar = rodape.filhos[1].filhos[1];
      for (let i = 1; i <= 8; i++) { caixa.value = 'pergunta ' + i + ' ' + 'ç'.repeat(nCedilhas); enviar.onclick(); await esperar(); }
      assert.strictEqual(N.pedidos.length, 9, 'eram o estado + 8 perguntas');
      for (const n of [7, 8]) {   /* a 7ª (depois das seis longas) e a 8ª (depois de uma que falhou) */
        const p = N.pedidos[n], corpo = JSON.parse(p.opts.body), tam = Buffer.byteLength(p.opts.body, 'utf8');
        assert.ok(tam <= 40000 && tam < 64 * 1024, 'a ' + n + 'ª pergunta passou do limite do servidor: ' + tam + ' bytes');
        assert.ok(corpo.historico.length >= 2 && corpo.historico.length % 2 === 0 && corpo.historico[0].role === 'user', 'o histórico tem que seguir em trocas inteiras, começando pela pergunta: ' + corpo.historico.map((m) => m.role).join(','));
        assert.ok(corpo.historico.every((m) => m.content.length <= 4000 + 4), 'mensagem do histórico sem teto de tamanho');
        assert.ok(corpo.historico[corpo.historico.length - 1].content.startsWith('Resposta 6 '), 'a troca mais RECENTE tem que ficar (saem as antigas): ' + corpo.historico[corpo.historico.length - 1].content.slice(0, 20));
        assert.ok(!corpo.historico.some((m) => m.content.startsWith('Resposta 1 ')), 'a troca mais antiga devia ter saído');
      }
      /* conversa curta não perde nada (o corte só age quando não cabe) */
      assert.strictEqual(JSON.parse(N.pedidos[2].opts.body).historico.length, 2);
    }
    /* sem a chave configurada: a caixa fica desligada, com o motivo, e nada é enviado */
    {
      const N = navegador([{ json: { ok: true, configurado: false, env: 'ANTHROPIC_API_KEY_DASHBOARD_CHAT' } }]);
      new Function('S', 'with (S) { ' + scriptDoChatAnalise('/good-checkout-offline') + '\n}')(N.sandbox);
      N.porId.chatAnaliseBotao.onclick(); await esperar();
      const [, lista, rodape] = N.porId.chatAnalisePainel.filhos;
      assert.ok(/falta a variável ANTHROPIC_API_KEY_DASHBOARD_CHAT/.test(textoDe(lista)) && rodape.filhos[0].disabled === true);
      rodape.filhos[0].value = 'oi'; rodape.filhos[1].filhos[1].onclick(); await esperar();
      assert.strictEqual(N.pedidos.length, 1, 'com o chat desligado, a pergunta não pode ser enviada');
    }
  } finally { console.log = _log; console.error = _err; }
  console.log('ok — chat de análise nas três: script com o prefixo de cada uma, dashboard injeta, portão na frente, só admin, sem env não sai pra rede; a tela desenha o texto escapado, em pedaços, com passo, uso e histórico certos');
  _chegouAoFim = true;
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
