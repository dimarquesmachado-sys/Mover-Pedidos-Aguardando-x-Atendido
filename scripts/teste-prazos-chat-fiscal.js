'use strict';
/* 15/11 — PRAZOS E RESERVA (auditoria geral do Codex de 15/11/2026, P2 nº 3, nº 4 e nº 6).

   P2 nº 3 — chat: a pergunta era RESERVADA no teto do dia, mas a gravação da reserva falhando (disco cheio, só leitura) era
   engolida e a chamada PAGA seguia; um arquivo de uso corrompido zerava a contagem. Agora reserva não gravada ou registro
   ilegível = 503 `nao_cobrado`, sem nenhuma ida ao modelo. Teto cheio continua 200 com a mensagem do limite.
   P2 nº 4 — histórico: a leitura paginada do Supabase não tinha prazo (nem por página nem total) — uma página pendurada
   (conexão aceita e sem resposta, ou corpo que não termina) prendia a consulta e a pergunta do chat. Agora cada página tem
   prazo pelo AbortController (conexão E corpo) e a leitura inteira tem teto; estourou = INCOMPLETA (500, sem cache). E a
   ferramenta do chat tem o próprio prazo: devolve erro ao modelo em vez de ficar presa.
   P2 nº 6 — fiscal: as leituras da correção de NF (lista, detalhe, contato) não tinham prazo — o `corrigirNFs` ficava com a
   trava ligada pra sempre. Agora cada tentativa tem prazo (conexão E corpo), estourar conta como queda de rede (tentada de
   novo) e o estado mostra a rodada atual/última e os prazos estourados.

   Prova com as PEÇAS DE PRODUÇÃO: lib/checkout/chat-analise (rota real), lib/checkout/historico (handler real das três
   empresas, Supabase de mentira que honra o `signal`), lib/fiscal/nf-bling-api + nf-fluxos (Bling de mentira). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const vigia = setTimeout(() => { console.error('FALHOU: o teste travou (promise pendente) — 60s'); process.exit(1); }, 60000);
process.env.HISTORICO_PRAZO_PAGINA_MS = '120';
process.env.HISTORICO_PRAZO_LEITURA_MS = '400';
process.env.NF_PRAZO_LEITURA_MS = '100';
process.env.ADMIN_KEY = 'chave-teste';

/* ── o Supabase/Bling de mentira: honra `signal` (a chamada pendurada é CANCELADA pelo abort, como o node-fetch faz) ── */
const pendurar = (signal) => new Promise((res, rej) => { if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))); });
let roteiro = [];   /* 'pendurado' | 'corpo-pendurado' | 'lento' | array (linhas) | número (HTTP) | objeto */
const chamadas = [];
const fakeFetch = async (url, opts) => {
  chamadas.push({ url: String(url), signal: opts && opts.signal });
  const r = roteiro.length ? roteiro.shift() : [];
  const sig = opts && opts.signal;
  if (r === 'pendurado') return pendurar(sig);
  if (r === 'corpo-pendurado') return { ok: true, status: 200, headers: { get: () => null }, json: () => pendurar(sig), text: () => pendurar(sig) };
  if (r === 'lento') { await new Promise((x) => setTimeout(x, 170)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => '[]' }; }
  if (typeof r === 'number') return { ok: r < 400, status: r, headers: { get: () => null }, json: async () => ({ message: 'erro' }), text: async () => 'erro' };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => r, text: async () => JSON.stringify(r) };
};
const _load = Module._load;
Module._load = function (req) { if (req === 'node-fetch') return fakeFetch; return _load.apply(this, arguments); };

const linha = (i) => ({ numero_pedido: String(1000 + i), numero_loja: 'X' + i, canal: 'ml', data_venda: '2026-10-05', sku: 'SKU' + (i % 7), descricao: 'p', quantidade: 1, valor_produto: 100, valor_nota: 100, custo: 20, comissao: 10, frete_vendedor: 5, imposto: 9, margem: 56, uf: 'SP' });
const esperaMs = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const _log = console.log, _err = console.error, _warn = console.warn; console.log = () => {}; console.error = () => {}; console.warn = () => {};
  let falhou = null;
  try {
    /* ══ P2 nº 4 — a peça de página com prazo ══ */
    const H = require('../lib/checkout/historico');
    assert.strictEqual(H.PRAZO_PAGINA_MS, 120); assert.strictEqual(H.PRAZO_LEITURA_MS, 400);
    roteiro = [[linha(1)]];
    let t0 = Date.now();
    assert.deepStrictEqual(await H._paginaComPrazo(fakeFetch, 'u', { headers: {} }, 0, 1000, t0), [linha(1)], 'página normal tinha que voltar as linhas');
    assert.ok(chamadas.pop().signal && typeof chamadas.length === 'number', 'o fetch tem que receber o `signal` (sem ele o abort não cancela nada)');
    for (const [nome, rot] of [['conexão pendurada', 'pendurado'], ['corpo pendurado', 'corpo-pendurado']]) {
      roteiro = [rot]; t0 = Date.now(); const ini = Date.now();
      await assert.rejects(H._paginaComPrazo(fakeFetch, 'u', { headers: {} }, 2000, 1000, t0), /INCOMPLETA: o Supabase não respondeu a página 3 em/, nome + ': tinha que estourar o prazo da página com a mensagem de INCOMPLETA');
      const gasto = Date.now() - ini; assert.ok(gasto >= 100 && gasto < 1000, nome + ': o prazo tinha que valer (~120 ms), levou ' + gasto + ' ms');
      assert.ok(chamadas[chamadas.length - 1].signal.aborted, nome + ': a chamada pendurada tem que ser CANCELADA (abort), não só abandonada');
    }
    /* o teto da leitura inteira: começou há 500 ms (> 400) → nem pede a página */
    roteiro = [[linha(1)]]; const antesN = chamadas.length;
    await assert.rejects(H._paginaComPrazo(fakeFetch, 'u', {}, 5000, 1000, Date.now() - 500), /INCOMPLETA: passou de 0 s e ainda faltava a página 6|INCOMPLETA: passou de \d+ s e ainda faltava a página 6/, 'o teto da leitura inteira');
    assert.strictEqual(chamadas.length, antesN, 'estourado o teto, não se pede página nenhuma');
    /* o prazo da página encolhe pro que resta do teto: faltam 50 ms do teto → a página lenta (170 ms) estoura em ~50 ms */
    roteiro = ['pendurado']; const i2 = Date.now();
    await assert.rejects(H._paginaComPrazo(fakeFetch, 'u', {}, 0, 1000, Date.now() - 395), /não respondeu a página 1 em 0 s/);
    assert.ok(Date.now() - i2 < 80, 'o prazo da página tinha que encolher pro resto do teto (5 ms), levou ' + (Date.now() - i2));
    /* HTTP ruim e corpo ilegível continuam as falhas de antes */
    roteiro = [503]; await assert.rejects(H._paginaComPrazo(fakeFetch, 'u', {}, 0, 1000, Date.now()), /HTTP 503 na página 1/);

    /* ══ P2 nº 4 — o HANDLER das três empresas: página pendurada → 500 INCOMPLETA, sem cache, e a rota VOLTA (não prende) ══ */
    for (const [pasta, arq] of [['good-checkout-offline', 'historico-good'], ['amb-checkout-offline', 'amb-historico'], ['girassol-backup-offline', 'historico']]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
      const histCache = {}; let resp = null;
      const h = require('../' + pasta + '/' + arq).rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: tmp, json: (res, st, obj) => { resp = { st, obj }; } });
      const chama = async (rota, qs) => { resp = null; const u = new URL('http://x/' + pasta + rota + '?k=chave-teste&' + qs); await h({ method: 'GET', headers: {} }, {}, u); return resp; };
      for (const [nome, rot] of [['1ª página pendurada', ['pendurado']], ['corpo da 2ª pendurado', [Array.from({ length: 1000 }, (_, i) => linha(i)), 'corpo-pendurado']]]) {
        roteiro = rot.slice(); for (const k of Object.keys(histCache)) delete histCache[k];
        const ini = Date.now();
        const r = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13&fresh=1');
        assert.ok(r && r.st === 500 && r.obj.ok === false && /INCOMPLETA/.test(r.obj.erro) && /não respondeu a página/.test(r.obj.erro), pasta + ' longo ' + nome + ': ' + JSON.stringify(r).slice(0, 160));
        assert.ok(Date.now() - ini < 1500, pasta + ' longo ' + nome + ': a rota tinha que voltar no prazo, levou ' + (Date.now() - ini) + ' ms');
        assert.strictEqual(Object.keys(histCache).length, 0, pasta + ' longo ' + nome + ': leitura incompleta foi pro cache');
      }
      roteiro = ['pendurado'];
      const rp = await chama('/previsao-vendas', 'base=90&fresh=1');
      assert.ok(rp && rp.obj.ok === false && /INCOMPLETA/.test(String(rp.obj.erro)), pasta + ' previsão com página pendurada: ' + JSON.stringify(rp).slice(0, 160));
      roteiro = [[linha(1), linha(2)]]; for (const k of Object.keys(histCache)) delete histCache[k];
      const ok = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13&fresh=1');
      assert.ok(ok && ok.obj.ok === true && ok.obj.totais.pedidos === 2, pasta + ' longo completo: ' + JSON.stringify(ok).slice(0, 160));
    }

    /* ══ P2 nº 3 e nº 4 (lado do chat) — a rota real do chat ══ */
    const C = require('../lib/checkout/chat-analise');
    process.env[C.ENV_CHAVE] = 'sk-ant-teste';
    const idasAoModelo = [];
    const fetchModelo = async (url, opts) => { idasAoModelo.push(String(url)); return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => '', json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) }; };
    const novoRes = () => ({ _json: null, _txt: '', writeHead() {}, setHeader() {}, write(x) { this._txt += String(x); return true; }, end() {}, flushHeaders() {}, on() {} });
    const montar = (TMP, extra) => C.criar(Object.assign({ empresa: 'good', caminho: '/x/chat-analise', json: (res, st, o) => { res._json = [st, o]; }, validarSessao: () => null, ehAdmin: () => false, lerChaveAdmin: () => 'chave-teste',
      CACHE_DIR: TMP, readJson: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }, writeJson: (f, o) => { fs.writeFileSync(f, JSON.stringify(o)); return true; },
      consultarHistorico: async () => ({ ok: false, erro: 'x' }), fetch: fetchModelo, batimentoMs: 10, prazoApiMs: 2000 }, extra || {}));
    const perguntar = async (rota, pergunta) => { const res = novoRes(); await rota({ method: 'POST', headers: {}, body: { pergunta } }, res, new URL('http://x/x/chat-analise')); return res; };
    const ARQ = (TMP) => path.join(TMP, '_chat-analise-uso.json');
    /* a) gravação recusada (false) → 503 nao_cobrado, zero idas ao modelo, arquivo intacto */
    { const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')); fs.writeFileSync(ARQ(TMP), JSON.stringify({ '2020-01-01': { perguntas: 1 } }));
      const antes = fs.readFileSync(ARQ(TMP), 'utf8'); idasAoModelo.length = 0;
      const res = await perguntar(montar(TMP, { writeJson: () => false }), 'quanto vendi?');
      assert.ok(res._json && res._json[0] === 503 && res._json[1].ok === false && res._json[1].nao_cobrado === true && /não consegui gravar a reserva/.test(res._json[1].erro), 'gravação recusada: 503 nao_cobrado, veio ' + JSON.stringify(res._json));
      assert.strictEqual(idasAoModelo.length, 0, 'gravação recusada e o modelo foi chamado (a chamada PAGA) — era o P2');
      assert.strictEqual(fs.readFileSync(ARQ(TMP), 'utf8'), antes, 'o registro de uso não pode ter mudado'); }
    /* b) gravação que LANÇA → idem */
    { const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')); idasAoModelo.length = 0;
      const res = await perguntar(montar(TMP, { writeJson: () => { throw new Error('ENOSPC'); } }), 'quanto vendi?');
      assert.ok(res._json && res._json[0] === 503 && res._json[1].nao_cobrado === true, 'gravação lançando: 503 nao_cobrado, veio ' + JSON.stringify(res._json));
      assert.strictEqual(idasAoModelo.length, 0, 'gravação lançando e o modelo foi chamado'); }
    /* c) registro de uso ILEGÍVEL em disco → 503 (não zera a contagem), zero idas */
    { const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')); fs.writeFileSync(ARQ(TMP), '{ lixo'); idasAoModelo.length = 0;
      const res = await perguntar(montar(TMP), 'quanto vendi?');
      assert.ok(res._json && res._json[0] === 503 && /ilegível/.test(res._json[1].erro) && res._json[1].nao_cobrado === true, 'registro ilegível: 503, veio ' + JSON.stringify(res._json));
      assert.strictEqual(idasAoModelo.length, 0, 'registro ilegível e o modelo foi chamado');
      assert.strictEqual(fs.readFileSync(ARQ(TMP), 'utf8'), '{ lixo', 'o registro ilegível não pode ser sobrescrito (é prova do problema)'); }
    /* d) sem registro ainda (1º uso do dia) → reserva gravada e o modelo É chamado; teto cheio → 200 com a mensagem do limite */
    { const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')); idasAoModelo.length = 0;
      const rota = montar(TMP);
      const res = await perguntar(rota, 'quanto vendi?');
      assert.ok(res._json === null && idasAoModelo.length === 1, 'sem registro: a reserva nasce e o modelo é chamado uma vez (' + idasAoModelo.length + ') ' + JSON.stringify(res._json));
      const uso = JSON.parse(fs.readFileSync(ARQ(TMP), 'utf8')); const dia = Object.keys(uso)[0];
      assert.strictEqual(uso[dia].perguntas, 1, 'a reserva tinha que estar gravada');
      process.env.DASHBOARD_CHAT_MAX_DIA = '1'; idasAoModelo.length = 0;
      const r2 = await perguntar(rota, 'de novo');
      assert.ok(r2._json && r2._json[0] === 200 && /limite de 1 perguntas/.test(r2._json[1].erro) && idasAoModelo.length === 0, 'teto cheio: 200 com a mensagem do limite e sem ida ao modelo, veio ' + JSON.stringify(r2._json));
      delete process.env.DASHBOARD_CHAT_MAX_DIA; }
    /* e) P2 nº 4 no chat: a ferramenta devolve erro ao modelo quando a consulta pendura (prazo da consulta), em vez de prender */
    { const ferr = C.criarFerramentas({ hoje: '2026-11-15', consultarHistorico: () => new Promise(() => {}), prazoConsultaMs: 80 });
      const ini = Date.now();
      await assert.rejects(ferr.executar ? ferr.executar('resumo_periodo', { de: '2026-11-01', ate: '2026-11-10' }) : ferr.F.resumo_periodo({ de: '2026-11-01', ate: '2026-11-10' }), /não respondeu em 1 s|não respondeu pra 2026-11-01 a 2026-11-10 \(o histórico não respondeu em 1 s/, 'consulta pendurada: a ferramenta tinha que falhar pelo prazo');
      assert.ok(Date.now() - ini < 1000, 'o prazo da consulta tinha que valer (80 ms), levou ' + (Date.now() - ini)); }

    /* ══ P2 nº 6 — fiscal: leituras com prazo, estado observável ══ */
    const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'));
    const api = require('../lib/fiscal/nf-bling-api').criarNfBlingApi({ rotulo: 'TESTE', nfTokenManager: {}, envPausa: 'X_PAUSA', intermediadorCnpj: '1', intermediadorNome: 'n', pastaCacheIE: tmpF });
    assert.strictEqual(api.PRAZO_LEITURA_NF_MS, 100);
    process.env.X_PAUSA = '0';
    /* lista por situação: 1ª tentativa pendurada (conexão), 2ª com o corpo pendurado, 3ª responde → a leitura termina e os 2 prazos ficam contados */
    chamadas.length = 0;
    roteiro = ['pendurado', 'corpo-pendurado', { data: [{ id: 7, dataEmissao: new Date().toISOString().slice(0, 10) + ' 10:00:00' }] }, { data: [] }, { data: [] }];
    let ini = Date.now();
    const nfs = await api.getNFsParaCorrigir('tok');
    assert.ok(nfs.some((n) => String(n.id) === '7'), 'depois de dois prazos estourados a leitura tinha que terminar com a nota: ' + JSON.stringify(nfs).slice(0, 100));
    assert.strictEqual(api.prazosEstourados(), 2, 'os dois prazos estourados tinham que estar contados: ' + api.prazosEstourados());
    assert.ok(chamadas.slice(0, 2).every((c) => c.signal && c.signal.aborted), 'as chamadas penduradas têm que ter sido CANCELADAS (abort)');
    assert.ok(Date.now() - ini < 5000, 'a leitura com 2 prazos de 100 ms não pode levar ' + (Date.now() - ini) + ' ms');
    /* 4 tentativas penduradas → erro de rede dizendo o prazo (não fica preso) */
    roteiro = ['pendurado', 'pendurado', 'pendurado', 'pendurado']; ini = Date.now();
    await assert.rejects(api.getNFDetalhe('tok', 99), /erro de rede: sem resposta completa em 0 s \(conexão ou corpo\)|erro de rede: sem resposta completa em \d+ s/, 'detalhe com tudo pendurado: erro de rede com o prazo');
    assert.ok(Date.now() - ini < 8000, 'as 4 tentativas penduradas não podem passar de ~7 s, levou ' + (Date.now() - ini));
    assert.strictEqual(api.prazosEstourados(), 6);
    /* a resposta devolvida já vem lida: json() e text() não voltam à rede */
    roteiro = [{ data: { id: 5, situacao: 1 } }]; chamadas.length = 0;
    const det = await api.getNFDetalhe('tok', 5); assert.strictEqual(det && det.id, 5); assert.strictEqual(chamadas.length, 1);

    /* o fluxo: a rodada que cai (lista pendurada em todas as tentativas) fica no estado como erro, a trava solta e a próxima entra */
    const fluxo = require('../lib/fiscal/nf-fluxos').criarFluxoNF({ rotulo: 'TESTE', nfTokenManager: { garantirTokenNF: async () => 'tok', renovarTokenNF: async () => 'tok' }, nfBlingApi: api, envCooldown: 'X_COOL' });
    roteiro = ['pendurado', 'pendurado', 'pendurado', 'pendurado'];
    let estado = fluxo.getEstadoRetrySEFAZ();
    assert.strictEqual(estado.ultima_rodada, null); assert.strictEqual(estado.prazos_de_leitura_estourados, 6); assert.strictEqual(estado.prazo_leitura_ms, 100); assert.strictEqual(estado.rodando, false);
    await assert.rejects(fluxo.corrigirNFsPendentes(), /erro de rede/, 'a rodada com a lista pendurada tinha que cair com erro de rede (não ficar presa)');
    estado = fluxo.getEstadoRetrySEFAZ();
    assert.ok(estado.rodando === false && estado.ultima_rodada && estado.ultima_rodada.desfecho === 'erro' && /erro de rede/.test(estado.ultima_rodada.erro) && estado.ultima_rodada.fim && typeof estado.ultima_rodada.segundos === 'number', 'o estado tinha que mostrar a rodada caída e a trava solta: ' + JSON.stringify(estado.ultima_rodada));
    assert.strictEqual(estado.prazos_de_leitura_estourados, 10);
    /* a próxima rodada ENTRA (a trava soltou) e termina */
    roteiro = [{ data: [] }, { data: [] }, { data: [] }];
    await fluxo.corrigirNFsPendentes();
    estado = fluxo.getEstadoRetrySEFAZ();
    assert.ok(estado.ultima_rodada.desfecho === 'terminou' && estado.ultima_rodada.nfs === 0 && estado.rodando === false, 'a rodada seguinte tinha que entrar e terminar: ' + JSON.stringify(estado.ultima_rodada));
    /* enquanto roda, o estado diz "em andamento" (a rodada presa fica visível) */
    { let soltar; roteiro = []; const antigo = fakeFetch; Module._load = function (req) { if (req === 'node-fetch') return antigo; return _load.apply(this, arguments); };
      const apiLenta = require('../lib/fiscal/nf-bling-api').criarNfBlingApi({ rotulo: 'TESTE2', nfTokenManager: {}, envPausa: 'X_PAUSA', intermediadorCnpj: '1', intermediadorNome: 'n', pastaCacheIE: tmpF });
      const fluxo2 = require('../lib/fiscal/nf-fluxos').criarFluxoNF({ rotulo: 'TESTE2', nfTokenManager: { garantirTokenNF: () => new Promise((r) => { soltar = r; }), renovarTokenNF: async () => 'tok' }, nfBlingApi: apiLenta, envCooldown: 'X_COOL' });
      for (let volta = 1; volta <= 2; volta++) {   /* duas voltas: a 2ª rodada tem que aparecer como NOVA (não a anterior terminada) */
        const p = fluxo2.corrigirNFsPendentes(); await esperaMs(10);
        const e2 = fluxo2.getEstadoRetrySEFAZ();
        assert.ok(e2.rodando === true && e2.ultima_rodada && e2.ultima_rodada.desfecho === 'em andamento' && e2.ultima_rodada.inicio && !e2.ultima_rodada.fim, 'volta ' + volta + ': em andamento tinha que aparecer no estado: ' + JSON.stringify(e2.ultima_rodada));
        roteiro = [{ data: [] }, { data: [] }, { data: [] }]; soltar('tok'); await p;
        assert.strictEqual(fluxo2.getEstadoRetrySEFAZ().ultima_rodada.desfecho, 'terminou');
      } }
  } catch (e) { falhou = e; }
  finally { console.log = _log; console.error = _err; console.warn = _warn; clearTimeout(vigia); }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — prazos e reserva: página do histórico com prazo (conexão e corpo, cancelada pelo abort) e teto da leitura, nas três empresas (500 INCOMPLETA, sem cache); a ferramenta do chat tem prazo; reserva do chat só vale gravada (recusada/lançando/ilegível = 503 sem ida ao modelo); leituras do fiscal com prazo e tentadas de novo, rodada caída e prazos estourados no estado, trava solta');
  process.exit(0);
})();
