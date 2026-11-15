'use strict';
/* 14/11 — OS "OLHOS" DO CHAT DE ANÁLISE: anúncios pagos, reputação do Mercado Livre, estoque e expedição
   (lib/checkout/chat-olhos.js, lib/checkout/reputacao-ml.js).

   O dono, depois da 1ª resposta do chat em produção: "ele podia ter analisado… se tinha disponível ainda ou se estoque já
   tava zerado… se tava ativo ads… considerar também a reputação no marketplace… ou tá com atraso na expedição".

   O que se prova (as peças de produção, com arquivos de verdade num diretório temporário e ML/Bling de mentira):
   A. REPUTAÇÃO: a taxa só vira percentual quando a própria resposta do ML confirma a unidade; campo ausente é "não
      informado" (nunca "sem medalha", nunca zero); falha do ML vira motivo, não exceção; a foto do dia grava, a última do
      dia vence, o arquivo não cresce sem fim; "o que mudou" é conta feita em código; sem duas fotos não há comparação.
      (Codex #883) A consulta tem PRAZO pro pedido inteiro — o ML que emudece (no token, na conexão ou no corpo) vira
      motivo, e a conexão é abortada; e "não informou" não é "mudou": só há troca entre duas fotos em que o ML informou.
   B. ADS: o total da Shopee é o da função de produção; dia sem dado é contado como SEM DADO (não zero); a publicidade do
      ML é a do card do dashboard; a fatura que não cobre o período vira aviso; loja sem a fonte responde "não disponível".
   C. ESTOQUE: saldo novo não consulta o Bling; saldo velho consulta — poucas vezes; Bling fora → o saldo antigo, MARCADO;
      item desconhecido → "não tenho", nunca zero. (Codex #883) O Bling que emudece não prende a pergunta: a consulta
      de estoque inteira tem prazo, a conexão é cancelada e o item fica com o saldo guardado (marcado) + o aviso.
   D. EXPEDIÇÃO: a fila usa os mesmos filtros da tela do galpão; as horas entre a nota e a conferência são contadas com o
      fuso certo; conferido sem hora da nota fica fora da conta das horas (e é contado).
   E. PELA ROTA DE VERDADE (o histórico de produção de uma empresa, a API da Anthropic de mentira): as quatro consultas vão
      na lista que o modelo recebe, as regras novas estão no prompt, o modelo pede as quatro e cada uma roda com as peças
      DA EMPRESA; a tela mostra o passo; nada de cliente nem número de pedido sai pra API; sem as peças, o chat continua o
      de antes (7 consultas, prompt de antes).
   F. A SONDA da reputação (`?reputacao=1`): só admin, mostra o cru do ML ao lado do resumo, grava a foto, não gasta
      pergunta nem chama o modelo.
   G. A MADRUGADA tira a foto: a etapa roda pra empresa com token do ML, grava o arquivo, e acusa ERRO se não conseguiu ler
      — inclusive quando o ML emudece: a etapa acusa e a noite SEGUE (as etapas seguintes rodam).
   H. NAS TRÊS EMPRESAS: a fachada do histórico de cada uma entrega ao chat a fila DELA e o token do ML DELA, e a
      madrugada de cada uma recebe o token do ML DELA (nenhuma herda o de outra). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

/* a rede de mentira (antes de qualquer peça carregar o node-fetch): a API da Anthropic, o Supabase e o Mercado Livre */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olhos-rota-'));
process.env.ADMIN_KEY = 'chave-adm'; process.env.GOODBKP_ADMIN = 'dono'; process.env.GOODBKP_CACHE_DIR = TMP; process.env.AMBBKP_CACHE_DIR = path.join(TMP, 'amb'); process.env.GIRABKP_CACHE_DIR = path.join(TMP, 'gira'); process.env.TIKTOK_CACHE_DIR = path.join(TMP, 'tk'); process.env.ANTHROPIC_API_KEY_DASHBOARD_CHAT = 'sk-ant-teste-123';
delete process.env.DASHBOARD_CHAT_MODELO; delete process.env.DASHBOARD_CHAT_MAX_DIA;
const rede = { api: [], roteiro: [], ml: [], mlResposta: null, outras: [] };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url, opts) => {
  url = String(url);
  if (url.startsWith('https://api.anthropic.com/')) { rede.api.push(JSON.parse(opts.body)); const t = rede.roteiro.shift(); if (!t) throw new Error('a API foi chamada mais vezes do que o roteiro previa'); return t; }
  if (url === 'https://api.mercadolibre.com/users/me') { rede.ml.push(opts.headers.Authorization); return rede.mlResposta(); }
  rede.outras.push(url);
  return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
} };

const REP = require('../lib/checkout/reputacao-ml');
const OLHOS = require('../lib/checkout/chat-olhos');
const { comPrazo } = require('../lib/checkout/com-prazo');
const { validarPeriodo } = require('../lib/checkout/chat-analise');

const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const novoDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olhos-'));
const HOJE = '2026-11-14';
const AGORA = Date.parse('2026-11-14T15:00:00.000Z');   /* 12:00 em Brasília */
/* o bloco de reputação como o ML documenta */
const BLOCO = { level_id: '5_green', power_seller_status: 'platinum', transactions: { canceled: 40, completed: 9000, total: 9040, period: 'historic' },
  metrics: { sales: { period: '60 days', completed: 975 }, claims: { period: '60 days', rate: 0.0123, value: 12 },
    delayed_handling_time: { period: '60 days', rate: 0.0308, value: 30 }, cancellations: { period: '60 days', rate: 0, value: 0 } } };
const respML = (corpo, st) => ({ ok: !st || st < 300, status: st || 200, json: async () => corpo });

(async () => {
  /* ═══ A. REPUTAÇÃO ═══ */
  {
    assert.deepStrictEqual([REP.taxaPct(0.0123, 12, 975), REP.taxaPct(1.23, 12, 975), REP.taxaPct(0, 0, 975), REP.taxaPct(0, null, null), REP.taxaPct(0.5, 12, 975), REP.taxaPct(0.0123, null, 975), REP.taxaPct(0.0123, 12, null),
      REP.taxaPct(0.0123, 0, 975), REP.taxaPct(-0.01, 12, 975), REP.taxaPct(null, 12, 975), REP.taxaPct('x', 12, 975), REP.taxaPct(true, 12, 975)],
      [1.23, 1.23, 0, 0, null, null, null, null, null, null, null, null],
      'a taxa vira % quando bate com quantidade ÷ vendas (como fração ou já em percentual); zero é zero; fora disso é "não disponível"');
    const r = REP.resumir(BLOCO);
    assert.deepStrictEqual(r, { nivel_codigo: '5_green', nivel: 'verde (o melhor nível)', medalha_codigo: 'platinum', medalha: 'MercadoLíder Platinum', medalha_informada: true, vendas_concluidas_no_periodo: 975, periodo_das_vendas: '60 days',
      reclamacoes: { quantidade: 12, taxa_pct: 1.23, periodo: '60 days' }, atraso_no_despacho: { quantidade: 30, taxa_pct: 3.08, periodo: '60 days' }, cancelamentos: { quantidade: 0, taxa_pct: 0, periodo: '60 days' },
      desde_sempre: { vendas_concluidas: 9000, vendas_canceladas: 40, total: 9040 } });
    /* o que o ML não mandou é "não informado" — nunca "sem medalha", nunca zero */
    assert.deepStrictEqual([REP.resumir({ level_id: '3_yellow' }).medalha, REP.resumir({ level_id: '3_yellow', power_seller_status: null }).medalha, REP.resumir({ power_seller_status: 'diamante' }).medalha, REP.resumir({ level_id: 'novo_nivel' }).nivel, REP.resumir({ level_id: 'novo_nivel' }).nivel_codigo, REP.resumir({}).nivel_codigo],
      [null, 'sem medalha de MercadoLíder', 'diamante', null, 'novo_nivel', null]);
    /* a medalha tem três estados: tem (o código), NÃO tem (o ML manda `null` de propósito) e NÃO INFORMADA (campo ausente,
       ou com um valor que não é nem código nem `null`) */
    assert.deepStrictEqual([{ power_seller_status: 'gold' }, { power_seller_status: null }, {}, { power_seller_status: '' }, { power_seller_status: 0 }, { power_seller_status: undefined }].map((b) => { const x = REP.resumir(b); return [x.medalha_informada, x.medalha]; }),
      [[true, 'MercadoLíder Gold'], [true, 'sem medalha de MercadoLíder'], [false, null], [false, null], [false, null], [false, null]]);
    assert.deepStrictEqual([REP.resumir({}).reclamacoes, REP.resumir({ metrics: { claims: {} } }).reclamacoes, REP.resumir({}).desde_sempre, REP.resumir({}).vendas_concluidas_no_periodo], [null, { quantidade: null, taxa_pct: null, periodo: null }, null, null]);
    assert.deepStrictEqual([REP.resumir(null), REP.resumir('x'), REP.resumir([])], [null, null, null]);

    /* a consulta nunca lança: cada falha vira um motivo */
    const chamadas = [];
    const ok = await REP.consultar({ garantirTokenML: async () => 'tk', fetch: async (u, o) => { chamadas.push([u, o.headers.Authorization]); return respML({ id: 1, seller_reputation: BLOCO }); } });
    assert.ok(ok.ok && ok.resumo.nivel_codigo === '5_green' && ok.cru === BLOCO);
    assert.deepStrictEqual(chamadas, [['https://api.mercadolibre.com/users/me', 'Bearer tk']]);
    for (const [o, re] of [[{ garantirTokenML: async () => { throw new Error('refresh falhou'); }, fetch: async () => respML({}) }, /acesso ao Mercado Livre não está disponível \(refresh falhou\)/],
      [{ garantirTokenML: async () => null, fetch: async () => respML({}) }, /sem acesso ao Mercado Livre agora/], [{ fetch: async () => respML({}) }, /sem acesso/],
      [{ garantirTokenML: async () => 'tk', fetch: async () => { throw new Error('ECONNRESET'); } }, /não respondeu \(ECONNRESET\)/], [{ garantirTokenML: async () => 'tk', fetch: async () => respML({}, 401) }, /HTTP 401/],
      [{ garantirTokenML: async () => 'tk', fetch: async () => respML({ id: 1 }) }, /sem o bloco de reputação/], [{ garantirTokenML: async () => 'tk', fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) }, /sem o bloco de reputação/]]) {
      const x = await REP.consultar(o);
      assert.ok(x.ok === false && re.test(x.erro), 'falha da consulta sem o motivo esperado: ' + JSON.stringify(x));
    }

    /* as fotos */
    const dir = novoDir(); const cx = { CACHE_DIR: dir, readJson, writeJson };
    assert.deepStrictEqual(REP.historico(Object.assign({ de: '2026-01-01', ate: HOJE }, cx)), []);
    assert.strictEqual(REP.fotografar(Object.assign({ dia: '2026-11-12', resumo: r, em: 'e1' }, cx)), true);
    const pior = REP.resumir(Object.assign({}, BLOCO, { level_id: '3_yellow', power_seller_status: null, metrics: Object.assign({}, BLOCO.metrics, { delayed_handling_time: { period: '60 days', rate: 0.0615, value: 60 } }) }));
    REP.fotografar(Object.assign({ dia: '2026-11-14', resumo: r, em: 'e2' }, cx));
    REP.fotografar(Object.assign({ dia: '2026-11-14', resumo: pior, em: 'e3' }, cx));   /* a última leitura do dia vence */
    assert.deepStrictEqual([REP.fotografar(Object.assign({ dia: 'ontem', resumo: r }, cx)), REP.fotografar(Object.assign({ dia: HOJE, resumo: null }, cx)), REP.fotografar({ dia: HOJE, resumo: r, CACHE_DIR: dir, readJson, writeJson: () => { throw new Error('disco cheio'); } })], [false, false, false]);
    /* (Codex #886) o gravador de PRODUÇÃO não lança quando o disco falha — devolve false: a foto NÃO foi gravada */
    assert.deepStrictEqual([REP.fotografar({ dia: HOJE, resumo: r, CACHE_DIR: dir, readJson, writeJson: () => false }), REP.fotografar({ dia: '2026-11-13', resumo: r, CACHE_DIR: novoDir(), readJson, writeJson: () => true }), REP.fotografar({ dia: '2026-11-13', resumo: r, CACHE_DIR: novoDir(), readJson, writeJson: () => undefined })], [false, true, true]);
    await assert.rejects(REP.fotoDaMadrugada({ CACHE_DIR: dir, readJson, writeJson: () => false, garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }), /li a reputação mas não consegui gravar a foto do dia/);
    const h = REP.historico(Object.assign({ de: '2026-11-01', ate: HOJE }, cx));
    assert.deepStrictEqual(h.map((f) => [f.dia, f.em, f.nivel_codigo, f.atraso_no_despacho]), [['2026-11-12', 'e1', '5_green', { quantidade: 30, taxa_pct: 3.08 }], ['2026-11-14', 'e3', '3_yellow', { quantidade: 60, taxa_pct: 6.15 }]]);
    assert.deepStrictEqual(REP.historico(Object.assign({ de: '2026-11-13', ate: HOJE }, cx)).map((f) => f.dia), ['2026-11-14']);
    /* o que mudou — as contas em código */
    const m = REP.comparar(h);
    assert.deepStrictEqual([m.de, m.ate, m.fotos, m.nivel_mudou, m.medalha_mudou, m.atraso_no_despacho.quantidade_diferenca, m.atraso_no_despacho.taxa_diferenca_em_pontos_percentuais, m.reclamacoes.quantidade_diferenca, m.reclamacoes.taxa_diferenca_em_pontos_percentuais],
      ['2026-11-12', '2026-11-14', 2, true, true, 30, 3.07, 0, 0]);
    assert.deepStrictEqual(m.trocas_de_nivel_ou_medalha, [{ dia: '2026-11-14', o_que: 'nível', de: 'verde (o melhor nível)', para: 'amarelo', foto_anterior: '2026-11-12' }, { dia: '2026-11-14', o_que: 'medalha', de: 'MercadoLíder Platinum', para: 'sem medalha de MercadoLíder', foto_anterior: '2026-11-12' }]);
    assert.deepStrictEqual([h[0].medalha_informada, h[1].medalha_informada, m.fotos_sem_o_nivel, m.fotos_sem_a_medalha], [true, true, 0, 0], 'a foto guarda se a medalha foi informada');
    assert.deepStrictEqual([REP.comparar([]), REP.comparar(h.slice(0, 1)), REP.comparar(null)], [null, null, null], 'com menos de duas fotos não há o que comparar');
    /* (Codex #883) "NÃO INFORMOU" NÃO É "MUDOU" — só há mudança entre duas fotos em que o ML informou o campo */
    {
      const d2 = novoDir(); const c2 = { CACHE_DIR: d2, readJson, writeJson };
      const foto = (dia, bloco) => REP.fotografar(Object.assign({ dia, resumo: REP.resumir(bloco), em: dia }, c2));
      const cmp = (de, ate) => { const x = REP.comparar(REP.historico(Object.assign({ de, ate }, c2))); return [x.nivel_mudou, x.medalha_mudou, x.fotos_sem_o_nivel, x.fotos_sem_a_medalha, x.trocas_de_nivel_ou_medalha.map((t) => [t.dia, t.o_que, t.de, t.para, t.foto_anterior])]; };
      /* o caso do Codex: verde + platinum, e no dia seguinte o ML manda só `metrics` */
      foto('2026-10-01', { level_id: '5_green', power_seller_status: 'platinum' });
      foto('2026-10-02', { metrics: {} });
      assert.deepStrictEqual(cmp('2026-10-01', '2026-10-02'), [null, null, 1, 1, []], 'o ML não mandou o nível nem a medalha e a comparação disse que MUDOU');
      assert.strictEqual(REP.historico(Object.assign({ de: '2026-10-02', ate: '2026-10-02' }, c2))[0].medalha_informada, false);
      /* voltou a informar, IGUAL: não mudou (a foto sem o campo, no meio, é pulada) */
      foto('2026-10-03', { level_id: '5_green', power_seller_status: 'platinum' });
      assert.deepStrictEqual(cmp('2026-10-01', '2026-10-03'), [false, false, 1, 1, []]);
      /* voltou a informar, DIFERENTE: a troca é confirmada no dia em que reapareceu, contra a última foto informada */
      foto('2026-10-04', { level_id: '3_yellow', power_seller_status: null });
      assert.deepStrictEqual(cmp('2026-10-02', '2026-10-04'), [null, null, 1, 1, [['2026-10-04', 'nível', 'verde (o melhor nível)', 'amarelo', '2026-10-03'], ['2026-10-04', 'medalha', 'MercadoLíder Platinum', 'sem medalha de MercadoLíder', '2026-10-03']]],
        'a ponta sem o campo deixa o "mudou?" sem resposta — mas a troca confirmada dentro da janela aparece');
      foto('2026-10-05', { metrics: {} }); foto('2026-10-06', { level_id: '5_green', power_seller_status: null });
      assert.deepStrictEqual(cmp('2026-10-04', '2026-10-06'), [true, false, 1, 1, [['2026-10-06', 'nível', 'amarelo', 'verde (o melhor nível)', '2026-10-04']]], 'com a foto do meio sem o campo, a troca é contra a última INFORMADA');
      /* perder a medalha (o ML manda `null`) É mudança; medalha que some do JSON não é */
      foto('2026-10-07', { level_id: '5_green', power_seller_status: 'gold' }); foto('2026-10-08', { level_id: '5_green' });
      assert.deepStrictEqual([cmp('2026-10-06', '2026-10-07').slice(0, 2), cmp('2026-10-07', '2026-10-08').slice(0, 2)], [[false, true], [false, null]]);
      /* foto sem a marca "medalha_informada" (formato de antes) mas COM o código vale como informada; sem os dois, não */
      assert.deepStrictEqual([REP.comparar([{ dia: 'a', nivel_codigo: '5_green', medalha_codigo: 'gold' }, { dia: 'b', nivel_codigo: '5_green', medalha_codigo: 'platinum' }]).medalha_mudou,
        REP.comparar([{ dia: 'a', nivel_codigo: '5_green', medalha_codigo: 'gold' }, { dia: 'b', nivel_codigo: '5_green', medalha_codigo: null }]).medalha_mudou], [true, null]);
    }

    /* (Codex #883) A CONSULTA TEM PRAZO pro pedido inteiro: o ML que emudece vira motivo, e a conexão é abortada */
    {
      const nunca = () => new Promise(() => {});
      let sinal = null;
      for (const [nome, o] of [['na conexão', { garantirTokenML: async () => 'tk', fetch: (u, op) => { sinal = op.signal; return nunca(); } }],
        ['no corpo da resposta', { garantirTokenML: async () => 'tk', fetch: async (u, op) => { sinal = op.signal; return { ok: true, status: 200, json: nunca }; } }],
        ['no token', { garantirTokenML: nunca, fetch: async () => respML({ seller_reputation: BLOCO }) }]]) {
        sinal = null;
        const t0 = Date.now();
        const x = await REP.consultar(Object.assign({ prazoMs: 40 }, o));
        assert.ok(x.ok === false && /não respondeu no prazo/.test(x.erro) && Date.now() - t0 < 2000, 'o ML emudeceu ' + nome + ' e a consulta não voltou com o motivo: ' + JSON.stringify(x));
        if (nome !== 'no token') assert.strictEqual(sinal && sinal.aborted, true, 'estourou o prazo ' + nome + ' e a conexão não foi abortada');
      }
      /* a etapa da madrugada ACUSA (não fica pendurada) */
      await assert.rejects(REP.fotoDaMadrugada({ CACHE_DIR: novoDir(), readJson, writeJson, garantirTokenML: async () => 'tk', fetch: nunca, prazoMs: 40 }), /não respondeu no prazo/);
      /* respondeu a tempo: o relógio é desligado (o sinal não é abortado depois) */
      sinal = null;
      const bom = await REP.consultar({ prazoMs: 60, garantirTokenML: async () => 'tk', fetch: async (u, op) => { sinal = op.signal; return respML({ seller_reputation: BLOCO }); } });
      await new Promise((r) => setTimeout(r, 130));
      assert.deepStrictEqual([bom.ok, sinal.aborted], [true, false], 'a consulta que deu certo ficou com o relógio do prazo ligado');
      /* sem prazo combinado, vale o da peça (o relógio é pedido com ele) */
      const _st = global.setTimeout; const pedidos = [];
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      try { await REP.consultar({ garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }); } finally { global.setTimeout = _st; }
      assert.ok(pedidos.includes(REP.PRAZO_MS) && REP.PRAZO_MS >= 5000 && REP.PRAZO_MS <= 60000, 'a consulta sem prazo combinado tinha que usar o prazo da peça: ' + pedidos + ' × ' + REP.PRAZO_MS);
    }

    /* (Codex #883) a peça do prazo, sozinha */
    {
      const soltas = []; const ouvir = (e) => soltas.push(String(e && e.message));
      process.on('unhandledRejection', ouvir);
      try {
        assert.strictEqual(await comPrazo(50, async () => 'valor', () => 'estourou'), 'valor');
        await assert.rejects(comPrazo(50, async () => { throw new Error('falhou antes'); }, () => 'estourou'), /falhou antes/);
        await assert.rejects(comPrazo(50, () => { throw new Error('falhou na hora'); }, () => 'estourou'), /falhou na hora/);
        let viu = null;
        assert.strictEqual(await comPrazo(20, (sn) => new Promise((_, rej) => { viu = sn; setTimeout(() => rej(new Error('falhou DEPOIS do prazo')), 60); }), () => 'estourou'), 'estourou');
        assert.strictEqual(viu.aborted, true);
        await new Promise((r) => setTimeout(r, 120));
        assert.deepStrictEqual(soltas, [], 'a falha de quem perdeu a corrida do prazo ficou solta (derrubaria o processo)');
      } finally { process.removeListener('unhandledRejection', ouvir); }
    }

    /* o arquivo não cresce sem fim, e lixo no arquivo não vira foto */
    const muitos = {}; for (let i = 0; i < REP.MAX_FOTOS + 30; i++) { const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10); muitos[d] = { em: 'x', nivel_codigo: '5_green' }; }
    muitos.lixo = { em: 'x' }; muitos['2025-99-99x'] = 1;
    writeJson(path.join(dir, REP.ARQUIVO), { dias: muitos });
    REP.fotografar(Object.assign({ dia: HOJE, resumo: r }, cx));
    const guardados = Object.keys(readJson(path.join(dir, REP.ARQUIVO), {}).dias);
    assert.ok(guardados.length === REP.MAX_FOTOS && guardados.includes(HOJE) && !guardados.includes('2024-01-01') && !guardados.includes('lixo'), 'o arquivo de fotos tinha que ficar com os ' + REP.MAX_FOTOS + ' dias mais novos: ' + guardados.length);

    /* a etapa da madrugada: grava a foto de hoje; se não conseguiu ler, LANÇA (a etapa aparece como erro) */
    const dir2 = novoDir();
    const txt = await REP.fotoDaMadrugada({ CACHE_DIR: dir2, readJson, writeJson, dia: HOJE, garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) });
    assert.ok(/verde \(o melhor nível\)/.test(txt) && /Platinum/.test(txt));
    assert.deepStrictEqual(Object.keys(readJson(path.join(dir2, REP.ARQUIVO), {}).dias), [HOJE]);
    await assert.rejects(() => REP.fotoDaMadrugada({ CACHE_DIR: dir2, readJson, writeJson, dia: HOJE, garantirTokenML: async () => 'tk', fetch: async () => respML({}, 503) }), /HTTP 503/);
    await assert.rejects(() => REP.fotoDaMadrugada({ CACHE_DIR: dir2, readJson, writeJson: () => { throw new Error('disco'); }, dia: HOJE, garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }), /não consegui gravar a foto/);
  }

  const olhosDe = (dir, extra) => OLHOS.criarOlhos(Object.assign({ hoje: HOJE, empresa: 'amb', CACHE_DIR: dir, readJson, writeJson, validarPeriodo, agora: () => AGORA, dorme: async () => {} }, extra)).F;

  /* ═══ B. ADS ═══ */
  {
    const dir = novoDir();
    /* loja sem nada gravado: "não disponível" nos dois, nunca zero */
    let x = await olhosDe(dir).gasto_anuncios({ de: '2026-11-08', ate: '2026-11-14' });
    assert.deepStrictEqual([x.shopee, x.mercado_livre, x.avisos], [{ disponivel: false, motivo: 'esta loja não tem coleta de Ads da Shopee gravada' }, { disponivel: false, motivo: 'esta loja não tem a fatura do Mercado Livre gravada' }, []]);
    const dia = (d, gasto, ped, gmv) => ({ dia: d, gasto, impressoes: 1000, cliques: 20, pedidos_diretos: 1, gmv_direto: 50, roas_direto: 1, pedidos_amplos: ped, gmv_amplo: gmv, roas_amplo: 1, itens_diretos: 1, itens_amplos: 2 });
    writeJson(path.join(dir, '_shopee_ads.json'), { atualizado: '2026-11-14T06:30:00.000Z', dias: { '2026-11-07': dia('2026-11-07', 99, 9, 999), '2026-11-08': dia('2026-11-08', 30.5, 3, 300), '2026-11-10': dia('2026-11-10', 19.5, 2, 200), '2026-11-13': dia('2026-11-13', 10, 0, 0), lixo: { dia: 'lixo', gasto: 5000 } } });
    writeJson(path.join(dir, '_ml_billing.json'), { atualizado: '2026-11-13T07:00:00.000Z', tarifas: { a: { d: '2026-11-09', v: 1, c: 'ads' } },
      porDia: { '2026-10-20': { comissao: 10 }, '2026-11-08': { ads: 41.2, comissao: 300 }, '2026-11-09': { comissao: 250 }, '2026-11-11': { ads: 58.8, credito: -20 }, '2026-11-12': { ads: 'x' } } });
    x = await olhosDe(dir).gasto_anuncios({ de: '2026-11-08', ate: '2026-11-14' });
    const prod = require('../lib/shopee-ads').resumoAds({ path, CACHE_DIR: dir, readJson }, '2026-11-08', '2026-11-14');
    assert.deepStrictEqual(x.shopee.total, { consumo: 60, impressoes: 3000, cliques: 60, taxa_de_clique_pct: 2, pedidos_atribuidos: 5, vendas_atribuidas: 500, retorno_roas: 8.33, custo_sobre_vendas_acos_pct: 12, consumo_por_pedido: 12 });
    assert.deepStrictEqual([x.shopee.total.consumo, x.shopee.total.retorno_roas, x.shopee.total.pedidos_atribuidos], [prod.gasto, prod.roas, prod.pedidos], 'o total da Shopee é o da função de PRODUÇÃO (a régua do painel da Shopee)');
    assert.deepStrictEqual(x.shopee.por_dia, [{ dia: '2026-11-08', consumo: 30.5, impressoes: 1000, cliques: 20, pedidos_atribuidos: 3, vendas_atribuidas: 300 }, { dia: '2026-11-10', consumo: 19.5, impressoes: 1000, cliques: 20, pedidos_atribuidos: 2, vendas_atribuidas: 200 },
      { dia: '2026-11-13', consumo: 10, impressoes: 1000, cliques: 20, pedidos_atribuidos: 0, vendas_atribuidas: 0 }]);
    assert.deepStrictEqual([x.shopee.dias_com_dado, x.shopee.dias_sem_dado, x.shopee.coleta_cobre, x.shopee.coleta_atualizada_em], [3, 4, { de: '2026-11-07', ate: '2026-11-13' }, '2026-11-14T06:30:00.000Z'], 'dia sem linha é dia SEM DADO, contado — e "lixo" não é dia');
    assert.ok(x.avisos.some((a) => /Shopee Ads: 4 dia\(s\).*SEM dado coletado/.test(a)));
    /* Mercado Livre: a publicidade do card do dashboard (porDia.ads), dia a dia; valor ilegível não entra */
    assert.deepStrictEqual([x.mercado_livre.total_publicidade, x.mercado_livre.por_dia, x.mercado_livre.dias_com_lancamento, x.mercado_livre.fatura_cobre, x.mercado_livre.fatura_atualizada_em],
      [100, [{ dia: '2026-11-08', publicidade: 41.2 }, { dia: '2026-11-11', publicidade: 58.8 }], 2, { de: '2026-10-20', ate: '2026-11-12' }, '2026-11-13T07:00:00.000Z']);
    assert.ok(x.avisos.some((a) => /fatura gravada vai só até 2026-11-12 — de 2026-11-13 em diante/.test(a)), 'a fatura que não cobre o fim do período tem que virar aviso: ' + x.avisos.join(' | '));
    assert.ok(!x.avisos.some((a) => /começa em/.test(a)));
    x = await olhosDe(dir).gasto_anuncios({ de: '2026-10-01', ate: '2026-10-31' });
    assert.ok(x.avisos.some((a) => /fatura gravada começa em 2026-10-20/.test(a)) && x.mercado_livre.total_publicidade === 0 && x.mercado_livre.dias_com_lancamento === 0);
    assert.deepStrictEqual([x.shopee.dias_com_dado, x.shopee.dias_sem_dado, x.shopee.total.consumo], [0, 31, 0]);
    /* período que passa de hoje: o futuro não conta como "dia sem dado" */
    x = await olhosDe(dir).gasto_anuncios({ de: '2026-11-13', ate: '2026-11-20' });
    assert.deepStrictEqual([x.shopee.dias_com_dado, x.shopee.dias_sem_dado], [1, 1]);
    /* período longo: por mês */
    x = await olhosDe(dir).gasto_anuncios({ de: '2026-07-01', ate: '2026-11-14' });
    assert.deepStrictEqual([x.shopee.por_dia, x.shopee.por_mes, x.mercado_livre.por_mes], [undefined, [{ mes: '2026-11', consumo: 159, impressoes: 4000, cliques: 80, pedidos_atribuidos: 14, vendas_atribuidas: 1499, dias_com_dado: 4 }], [{ mes: '2026-11', publicidade: 100, dias_com_lancamento: 2 }]]);
    /* a fatura mudou no disco: a leitura seguinte enxerga (o que fica guardado em memória é por versão do arquivo) */
    writeJson(path.join(dir, '_ml_billing.json'), { atualizado: 'novo', porDia: { '2026-11-08': { ads: 7 }, '2026-11-14': { ads: 3.333 } } });
    x = await olhosDe(dir).gasto_anuncios({ de: '2026-11-08', ate: '2026-11-14' });
    assert.deepStrictEqual([x.mercado_livre.total_publicidade, x.mercado_livre.fatura_atualizada_em, x.mercado_livre.por_dia[1]], [10.33, 'novo', { dia: '2026-11-14', publicidade: 3.33 }]);
    await assert.rejects(() => olhosDe(dir).gasto_anuncios({ de: '2026-11-14', ate: '2026-11-01' }), /período inválido/);
  }

  /* ═══ B2. REPUTAÇÃO pela consulta do chat ═══ */
  {
    const dir = novoDir();
    assert.deepStrictEqual(await olhosDe(dir).reputacao_mercado_livre({}), { disponivel: false, motivo: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' });
    REP.fotografar({ CACHE_DIR: dir, readJson, writeJson, dia: '2026-11-01', em: 'e0', resumo: REP.resumir(Object.assign({}, BLOCO, { level_id: '4_light_green' })) });
    let x = await olhosDe(dir, { garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }).reputacao_mercado_livre({});
    assert.deepStrictEqual([x.agora.nivel_codigo, x.historico_guardado_desde, x.janela, x.o_que_mudou_na_janela.nivel_mudou, x.o_que_mudou_na_janela.trocas_de_nivel_ou_medalha, x.avisos],
      ['5_green', '2026-11-01', { de: '2026-10-15', ate: HOJE, fotos: 2 }, true, [{ dia: HOJE, o_que: 'nível', de: 'verde-claro', para: 'verde (o melhor nível)', foto_anterior: '2026-11-01' }], []]);
    assert.ok(/"nivel_mudou" \/ "medalha_mudou" nulo = o ML NÃO INFORMOU/.test(x.leia), 'a consulta tem que dizer ao modelo o que é o "mudou" nulo');
    assert.strictEqual(readJson(path.join(dir, REP.ARQUIVO), {}).dias[HOJE].em, new Date(AGORA).toISOString(), 'consultar pelo chat grava a foto do dia');
    /* (Codex #886) o disco recusa a foto (o gravador de produção devolve false): o chat lê o "agora" e DIZ que não guardou */
    {
      const semDisco = await olhosDe(novoDir(), { writeJson: () => false, garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }).reputacao_mercado_livre({});
      assert.ok(semDisco.agora.nivel_codigo === '5_green' && semDisco.avisos.some((a) => /não consegui guardar a foto de hoje/.test(a)), 'a foto não foi gravada e a consulta não disse: ' + semDisco.avisos.join(' | '));
      assert.ok(!x.avisos.some((a) => /não consegui guardar a foto/.test(a)));
    }
    /* janela curta: só a foto de hoje → sem comparação, e o aviso diz desde quando há histórico */
    x = await olhosDe(dir, { garantirTokenML: async () => 'tk', fetch: async () => respML({ seller_reputation: BLOCO }) }).reputacao_mercado_livre({ dias: 3 });
    assert.ok(x.o_que_mudou_na_janela === null && x.janela.fotos === 1 && /O histórico da reputação começa em 2026-11-01/.test(x.avisos.join(' ')));
    /* o ML fora do ar: sem "agora", com o histórico e o motivo */
    x = await olhosDe(dir, { garantirTokenML: async () => 'tk', fetch: async () => respML({}, 500) }).reputacao_mercado_livre({});
    assert.ok(x.agora === null && x.janela.fotos === 2 && /Não consegui ler a reputação AGORA \(o Mercado Livre respondeu HTTP 500\)/.test(x.avisos[0]));
    const vazio = novoDir();
    x = await olhosDe(vazio, { garantirTokenML: async () => 'tk', fetch: async () => respML({}, 500) }).reputacao_mercado_livre({});
    assert.ok(x.agora === null && x.historico_guardado_desde === null && /Ainda não há nenhuma foto/.test(x.avisos.join(' ')) && !fs.existsSync(path.join(vazio, REP.ARQUIVO)), 'leitura que falhou não grava foto');
  }

  /* ═══ C. ESTOQUE ═══ */
  {
    const dir = novoDir();
    const H = 3600000;
    writeJson(path.join(dir, '_prod_compra.json'), { NOVO: { saldo: 12, nome: 'Item novo', img: 'x', ts: AGORA - 1 * H }, VELHO: { saldo: 4, nome: 'Item velho', ts: AGORA - 30 * H }, ZERADO: { saldo: 0, nome: 'Item zerado', ts: AGORA - 0.5 * H }, SEMSALDO: { saldo: null, ts: AGORA - 1 * H }, semts: { saldo: 9 } });
    const bling = { chamadas: [], saldos: { VELHO: 7, DETALHE: null, SEMSALDO: 3 }, fora: false };
    const blingGet = async (u) => {
      bling.chamadas.push(u);
      if (bling.fora) return { ok: false, status: 503 };
      const m = /^\/produtos\?codigo=([^&]+)&criterio=5&limite=1$/.exec(u);
      if (m) { const sku = decodeURIComponent(m[1]); if (!(sku in bling.saldos)) return { ok: true, data: { data: [] } };
        return { ok: true, data: { data: [{ id: 'id-' + sku, nome: 'Nome ' + sku, estoque: bling.saldos[sku] == null ? {} : { saldoVirtualTotal: bling.saldos[sku] } }] } }; }
      if (u === '/produtos/id-DETALHE') return { ok: true, data: { data: { estoque: { saldoFisicoTotal: 21 } } } };
      return { ok: false, status: 404 };
    };
    const F = () => olhosDe(dir, { blingGet, empresa: 'loja-c' });
    let x = await F().estoque_atual({ skus: ['NOVO', ' novo ', 'ZERADO', 'VELHO', 'DETALHE', 'NAOEXISTE', 'SEMSALDO', 'semts'] });
    const de = (sku) => x.itens.find((i) => i.sku === sku);
    assert.deepStrictEqual([de('NOVO'), de('ZERADO')], [{ sku: 'NOVO', produto: 'Item novo', saldo: 12, fonte: 'Bling, última consulta do Plano de Compra', consultado_em: new Date(AGORA - H).toISOString(), ha_horas: 1 },
      { sku: 'ZERADO', produto: 'Item zerado', saldo: 0, fonte: 'Bling, última consulta do Plano de Compra', consultado_em: new Date(AGORA - 0.5 * H).toISOString(), ha_horas: 0.5 }], 'saldo guardado há pouco é usado como está — e zero é zero');
    assert.deepStrictEqual([de('novo').saldo, de('novo').fonte], [12, 'Bling, última consulta do Plano de Compra'], 'o SKU acha o guardado em qualquer caixa');
    assert.deepStrictEqual([de('VELHO').saldo, de('VELHO').fonte, de('VELHO').ha_horas, de('VELHO').produto, de('VELHO').desatualizado], [7, 'Bling, consultado agora', 0, 'Nome VELHO', undefined], 'saldo guardado há 30 horas é consultado de novo');
    assert.deepStrictEqual([de('DETALHE').saldo, de('SEMSALDO').saldo], [21, 3], 'sem saldo na busca, vale o do detalhe do produto; guardado sem saldo é consultado');
    assert.deepStrictEqual([de('NAOEXISTE'), de('semts').saldo], [{ sku: 'NAOEXISTE', saldo: null, motivo: 'não tenho o saldo deste item (não consegui consultar o Bling agora e não há consulta guardada)' }, null], 'item que o Bling não achou é "não tenho" — nunca zero');
    assert.ok(!bling.chamadas.some((u) => /codigo=(NOVO|novo|ZERADO)&/.test(u)), 'saldo novo não gasta chamada ao Bling: ' + bling.chamadas.join(' '));
    assert.ok(/não responderam com o saldo/.test(x.avisos.join(' ')));
    /* de novo, logo em seguida: o que este chat acabou de consultar não é consultado outra vez */
    bling.chamadas.length = 0;
    x = await F().estoque_atual({ skus: ['VELHO', 'DETALHE'] });
    assert.deepStrictEqual([x.itens.map((i) => [i.saldo, i.fonte]), bling.chamadas.length], [[[7, 'Bling, consultado por este chat'], [21, 'Bling, consultado por este chat']], 0]);
    /* outra loja não herda o saldo consultado por esta */
    const outra = novoDir();
    x = await olhosDe(outra, { blingGet: async () => ({ ok: false }), empresa: 'loja-d' }).estoque_atual({ skus: ['VELHO'] });
    assert.strictEqual(x.itens[0].saldo, null, 'o saldo de uma empresa apareceu na outra');
    /* o Bling fora do ar: o saldo antigo, MARCADO como desatualizado — e não mais que o teto de consultas por pergunta */
    const dirF = novoDir();
    const muitos = {}; for (let i = 1; i <= 8; i++) muitos['S' + i] = { saldo: i, ts: AGORA - 50 * H };
    writeJson(path.join(dirF, '_prod_compra.json'), muitos);
    bling.fora = true; bling.chamadas.length = 0;
    const daPergunta = olhosDe(dirF, { blingGet, empresa: 'loja-e' });   /* os olhos de UMA pergunta */
    x = await daPergunta.estoque_atual({ skus: Object.keys(muitos).concat(['S9', 'S10']) });
    assert.deepStrictEqual([x.itens.length, x.itens.every((i) => i.desatualizado === true && i.ha_horas === 50), bling.chamadas.length], [OLHOS.MAX_SKUS, true, OLHOS.MAX_AO_VIVO], 'no máximo ' + OLHOS.MAX_SKUS + ' itens por consulta');
    assert.ok(/Vieram 10 SKUs; consultei os 8 primeiros/.test(x.avisos.join(' ')) && /desatualizado/.test(x.avisos.join(' ')));
    /* o teto de consultas ao Bling é da PERGUNTA inteira: a 2ª consulta de estoque da mesma pergunta não consulta mais */
    x = await daPergunta.estoque_atual({ skus: ['S1', 'S2', 'NUNCA-VISTO'] });
    assert.deepStrictEqual([bling.chamadas.length, x.itens.map((i) => [i.saldo, i.desatualizado]), /3 item\(ns\) não foram consultados no Bling agora: esta pergunta já fez as 8 consultas/.test(x.avisos.join(' '))], [OLHOS.MAX_AO_VIVO, [[1, true], [2, true], [null, undefined]], true],
      'uma pergunta não pode fazer mais que ' + OLHOS.MAX_AO_VIVO + ' consultas ao vivo no Bling, por mais consultas de estoque que o modelo peça');
    /* outra pergunta (olhos novos) tem o teto dela */
    await olhosDe(dirF, { blingGet, empresa: 'loja-e' }).estoque_atual({ skus: ['S1'] });
    assert.strictEqual(bling.chamadas.length, OLHOS.MAX_AO_VIVO + 1);
    /* (Codex #883) O BLING QUE EMUDECE não prende a pergunta: a consulta de estoque INTEIRA tem prazo */
    {
      const dirP = novoDir();
      writeJson(path.join(dirP, '_prod_compra.json'), { P1: { saldo: 5, nome: 'Guardado', ts: AGORA - 40 * H } });
      const vistos = [];
      const mudo = (u, tent, sinal) => { vistos.push([u, tent, sinal]); return new Promise(() => {}); };
      const t0 = Date.now();
      const y = await olhosDe(dirP, { blingGet: mudo, empresa: 'loja-p', prazoEstoqueMs: 450 }).estoque_atual({ skus: ['P1', 'P2', 'P3'] });
      assert.ok(Date.now() - t0 < 3000, 'o Bling emudeceu e a consulta de estoque ficou pendurada');
      assert.deepStrictEqual([vistos.length, vistos[0][1], vistos[0][2] && vistos[0][2].aborted], [1, 3, true], 'estourado o prazo, a conexão é cancelada e os outros itens NÃO vão ao Bling');
      assert.deepStrictEqual(y.itens.map((i) => [i.sku, i.saldo, i.desatualizado]), [['P1', 5, true], ['P2', null, undefined], ['P3', null, undefined]]);
      assert.ok(/O Bling demorou demais: 3 item\(ns\) ficaram sem a consulta de agora/.test(y.avisos.join(' ')) && !/não responderam com o saldo/.test(y.avisos.join(' ')), 'o aviso do prazo: ' + y.avisos.join(' | '));
      /* quem ficou sem tempo NÃO gastou a vez da pergunta (o teto de consultas ao vivo é do que foi ao Bling) */
      const daP = olhosDe(dirP, { blingGet: mudo, empresa: 'loja-p2', prazoEstoqueMs: 400 });
      await daP.estoque_atual({ skus: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'] });
      vistos.length = 0;
      await daP.estoque_atual({ skus: ['P2'] });
      assert.strictEqual(vistos.length, 1, 'os itens que nem foram ao Bling (sem tempo) gastaram o teto de consultas da pergunta');
      /* com o prazo quase no fim NÃO começa outra ida ao Bling (ela seria cancelada no meio): prazo menor que o mínimo
         de uma ida → nenhuma chamada, e o aviso */
      vistos.length = 0;
      const semIda = await olhosDe(dirP, { blingGet: mudo, empresa: 'loja-p3', prazoEstoqueMs: 200 }).estoque_atual({ skus: ['P1', 'P2'] });
      assert.deepStrictEqual([vistos.length, semIda.itens.map((i) => [i.saldo, i.desatualizado]), /O Bling demorou demais: 2 item\(ns\)/.test(semIda.avisos.join(' '))], [0, [[5, true], [null, undefined]], true], 'com o prazo no fim, a consulta ainda começou uma ida ao Bling');
      /* em dia normal: o Bling recebe o sinal (não abortado) e as 3 tentativas de sempre; sem prazo combinado vale o da peça */
      const _st = global.setTimeout; const pedidos = []; vistos.length = 0;
      global.setTimeout = (fn, ms) => { pedidos.push(ms); return _st(fn, ms); };
      let z;
      try { z = await olhosDe(novoDir(), { blingGet: async (u, tent, sinal) => { vistos.push([u, tent, sinal]); return { ok: true, data: { data: [{ id: 9, nome: 'N', estoque: { saldoVirtualTotal: 2 } }] } }; }, empresa: 'loja-q' }).estoque_atual({ skus: ['Q1'] }); }
      finally { global.setTimeout = _st; }
      assert.deepStrictEqual([z.itens[0].saldo, vistos.length, vistos[0][1], vistos[0][2].aborted, z.avisos], [2, 1, 3, false, []]);
      assert.ok(pedidos.some((ms) => ms > OLHOS.PRAZO_ESTOQUE_MS - 2000 && ms <= OLHOS.PRAZO_ESTOQUE_MS) && OLHOS.PRAZO_ESTOQUE_MS >= 10000 && OLHOS.PRAZO_ESTOQUE_MS <= 90000, 'a consulta de estoque sem prazo combinado tinha que usar o da peça: ' + pedidos);
      /* o detalhe do produto (2ª ida) também leva o sinal */
      vistos.length = 0;
      await OLHOS.saldoNoBling(async (u, tent, sinal) => { vistos.push([u, tent, sinal]); return /codigo=/.test(u) ? { ok: true, data: { data: [{ id: 7, nome: 'N', estoque: {} }] } } : { ok: true, data: { data: { estoque: { saldoFisicoTotal: 1 } } } }; }, 'D1', async () => {}, 'o-sinal');
      assert.deepStrictEqual(vistos.map((v) => [v[0], v[1], v[2]]), [['/produtos?codigo=D1&criterio=5&limite=1', 3, 'o-sinal'], ['/produtos/7', 3, 'o-sinal']]);
      /* abortado entre a busca e o detalhe: não faz a 2ª ida */
      vistos.length = 0;
      const ab = { aborted: false };
      const sd = await OLHOS.saldoNoBling(async (u) => { vistos.push(u); ab.aborted = true; return { ok: true, data: { data: [{ id: 7, nome: 'N', estoque: {} }] } }; }, 'D2', async () => {}, ab);
      assert.deepStrictEqual([sd, vistos.length], [null, 1], 'com o prazo estourado, o detalhe do produto não é mais pedido');
    }
    /* sem o cliente do Bling (loja que não passou a peça): só o guardado */
    x = await olhosDe(dirF, { empresa: 'loja-f' }).estoque_atual({ skus: ['S1'] });
    assert.deepStrictEqual([x.itens[0].saldo, x.itens[0].desatualizado], [1, true]);
    await assert.rejects(() => olhosDe(dirF, {}).estoque_atual({ skus: [] }), /diga os SKUs/);
    await assert.rejects(() => olhosDe(dirF, {}).estoque_atual({}), /diga os SKUs/);
  }

  /* ═══ D. EXPEDIÇÃO ═══ */
  {
    const dir = novoDir();
    const MAN = path.join(dir, 'manifest.json'), CONF = path.join(dir, 'conferidos.json');
    assert.deepStrictEqual(await olhosDe(dir).expedicao_do_galpao({}), { disponivel: false, motivo: 'esta loja não tem a fila do galpão ligada ao dashboard' });
    const ha = (h) => new Date(AGORA - h * 3600000).toISOString();
    writeJson(MAN, { 1: { tem_etiqueta: true, marketplace: 'ml', visto_em: ha(2) }, 2: { tem_etiqueta: true, marketplace: 'shopee', visto_em: ha(30) }, 3: { tem_etiqueta: true, marketplace: 'ml', visto_em: ha(50) },
      4: { tem_etiqueta: true, marketplace: 'ml', visto_em: ha(99) },                    /* já conferido: fora da fila */
      5: { tem_etiqueta: false, visto_em: ha(5) }, 6: { tem_etiqueta: false, full_ml: true, visto_em: ha(80) }, 7: { tem_etiqueta: false, aguardando_disp: true, visto_em: ha(80) },
      8: { tem_etiqueta: true }, 9: null, 10: { tem_etiqueta: true, visto_em: 'lixo' } });
    writeJson(CONF, { 4: { conferido_em: '2026-11-14T13:00:00.000Z', nf_emissao: '2026-11-14 08:00:00' },        /* 10:00 de Brasília − 08:00 = 2 h */
      a: { conferido_em: '2026-11-14T14:00:00.000Z', nf_emissao: '2026-11-13 09:00' },                            /* 11:00 − 09:00 de ontem = 26 h */
      b: { conferido_em: '2026-11-13T02:30:00.000Z', nf_emissao: '2026-11-10 22:30:00' },                         /* 23:30 do dia 12 (Brasília) − 22:30 do dia 10 = 49 h */
      c: { conferido_em: '2026-11-13T18:00:00.000Z', nf_emissao: '' }, d: { conferido_em: '2026-11-13T18:00:00.000Z', nf_emissao: '2026-11-13' },
      e: { conferido_em: '2026-11-13T18:00:00.000Z', nf_emissao: '2026-11-13 19:00:00' },                         /* nota "depois" da conferência: fora da conta */
      velho: { conferido_em: '2026-10-01T12:00:00.000Z', nf_emissao: '2026-10-01 08:00:00' }, semHora: { nf_emissao: '2026-11-14 08:00:00' }, nulo: null });
    const x = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({});
    assert.deepStrictEqual(x.agora.esperando_conferencia, { pedidos: 5, com_hora_de_chegada: 3, o_mais_antigo_espera_ha_horas: 50, esperando_ha_mais_de_24h: 2, esperando_ha_mais_de_48h: 1, por_canal: { ml: 2, shopee: 1, outro: 2 } },
      'a fila é: com etiqueta e ainda não conferido (os mesmos filtros da tela do galpão)');
    assert.deepStrictEqual(x.agora.sem_etiqueta, { pedidos: 1, com_hora_de_chegada: 1, o_mais_antigo_espera_ha_horas: 5, esperando_ha_mais_de_24h: 0, esperando_ha_mais_de_48h: 0 }, 'Full e "aguardando disponibilidade" não são pedido sem etiqueta');
    assert.deepStrictEqual(x.ultimos_dias.por_dia, [
      { dia: '2026-11-12', conferidos: 1, com_hora_da_nota: 1, horas_da_nota_ate_a_conferencia_mediana: 49, levaram_mais_de_24h: 1, levaram_mais_de_48h: 1 },
      { dia: '2026-11-13', conferidos: 3, com_hora_da_nota: 0, horas_da_nota_ate_a_conferencia_mediana: null, levaram_mais_de_24h: 0, levaram_mais_de_48h: 0 },
      { dia: '2026-11-14', conferidos: 2, com_hora_da_nota: 2, horas_da_nota_ate_a_conferencia_mediana: 14, levaram_mais_de_24h: 1, levaram_mais_de_48h: 0 }],
      'o dia é o de BRASÍLIA da conferência, e a hora da nota (sem fuso, de Brasília) é comparada no fuso certo');
    assert.deepStrictEqual([x.ultimos_dias.de, x.ultimos_dias.ate, x.ultimos_dias.conferidos, x.ultimos_dias.dias_com_conferencia, x.ultimos_dias.horas_da_nota_ate_a_conferencia_mediana, x.ultimos_dias.levaram_mais_de_24h, x.ultimos_dias.levaram_mais_de_48h, x.ultimos_dias.conferidos_sem_hora_da_nota],
      ['2026-11-01', HOJE, 6, 3, 26, 2, 1, 3]);
    assert.ok(/3 pedido\(s\) conferido\(s\) no período estão sem a hora da nota/.test(x.avisos.join(' ')));
    const curto = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({ dias: 1 });
    assert.deepStrictEqual([curto.ultimos_dias.de, curto.ultimos_dias.conferidos], [HOJE, 2]);
    const longo = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({ dias: 9999 });
    /* (Codex #886) o arquivo dos conferidos NÃO é histórico: o galpão apaga a conferência sincronizada com mais de 30 dias.
       O teto é 28 dias — dentro dele todo dia está inteiro; pedir mais responde os 28 e DIZ por quê. A conferência de
       01/10 (44 dias atrás, que só "sobrou" no arquivo) não entra. */
    assert.deepStrictEqual([OLHOS.DIAS_EXPEDICAO_MAX, longo.ultimos_dias.de, longo.ultimos_dias.conferidos, longo.ultimos_dias.por_dia.map((d) => d.dia)], [28, '2026-10-18', 6, ['2026-11-12', '2026-11-13', '2026-11-14']],
      'a expedição respondeu além do que o galpão guarda (a conferência antiga que sobrou no arquivo entrou na conta)');
    assert.ok(longo.avisos.some((a) => /Foram pedidos 9999 dias, mas o galpão só guarda as conferências dos últimos 30 dias.*respondi os últimos 28/.test(a)), 'pediu mais dias do que o galpão guarda e a consulta não disse: ' + longo.avisos.join(' | '));
    assert.ok(/cobre no máximo os últimos 28 dias/.test(longo.leia) && !x.avisos.some((a) => /Foram pedidos/.test(a)) && OLHOS.FERRAMENTAS.find((f) => f.name === 'expedicao_do_galpao').input_schema.properties.dias.description.includes('máximo 28'));
    /* no limite: 28 dias responde 28 sem aviso; 29 avisa */
    const d28 = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({ dias: 28 }), d29 = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({ dias: 29 });
    assert.deepStrictEqual([d28.ultimos_dias.de, d28.avisos.some((a) => /Foram pedidos/.test(a)), d29.ultimos_dias.de, d29.avisos.some((a) => /Foram pedidos 29 dias/.test(a))], ['2026-10-18', false, '2026-10-18', true]);
    /* arquivos vazios: fila zerada é fato (os arquivos existem pra esta loja) */
    writeJson(MAN, {}); writeJson(CONF, {});
    const v = await olhosDe(dir, { MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF }).expedicao_do_galpao({});
    assert.deepStrictEqual([v.agora.esperando_conferencia.pedidos, v.agora.esperando_conferencia.o_mais_antigo_espera_ha_horas, v.ultimos_dias.conferidos, v.ultimos_dias.horas_da_nota_ate_a_conferencia_mediana, v.avisos], [0, null, 0, null, []]);
  }

  /* ═══ E. PELA ROTA DE VERDADE ═══ */
  const C = require('../lib/checkout/chat-analise');
  const turno = ({ texto, usos }) => {
    const evs = [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }]; let i = 0;
    if (texto) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: texto } }, { type: 'content_block_stop', index: i }); i++; }
    for (const u of (usos || [])) { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: u.id, name: u.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } }, { type: 'content_block_stop', index: i }); i++; }
    evs.push({ type: 'message_delta', delta: { stop_reason: (usos || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
    const b = Buffer.from(evs.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), 'utf8');
    return { ok: true, status: 200, text: async () => '', body: (async function* () { yield b; })() };
  };
  const novoRes = () => ({ _json: null, _txt: '', writeHead() {}, setHeader() {}, write(x) { this._txt += String(x); return true; }, end(x) { if (x != null) this._txt += String(x); }, on() {} });
  const P = '/good-checkout-offline';
  const MAN = path.join(TMP, 'manifest-teste.json'), CONF = path.join(TMP, 'conferidos-teste.json');
  const blingVisto = [];
  const montar = (extra) => require('../good-checkout-offline/historico-good').rotasHistorico(Object.assign({ validarSessao: (ck) => (ck === 'sess=dono' ? 'dono' : null), supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache: {}, CACHE_DIR: TMP,
    json: (res, st, o) => { res._json = [st, o]; }, MANIFEST_FILE: MAN, CONFERIDOS_FILE: CONF, garantirTokenML: async () => 'tk-da-good',
    blingGet: async (u) => { blingVisto.push(u); return { ok: true, data: { data: [{ id: 1, nome: 'Tosquiadeira', estoque: { saldoVirtualTotal: 0 } }] } }; } }, extra));
  const h = montar();
  const _logE = console.log; console.log = () => {};   /* a rota registra cada pergunta no console */
  const hojeReal = C.hojeSP();
  const menos = (n) => { const d = new Date(hojeReal + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  {
    writeJson(path.join(TMP, '_shopee_ads.json'), { atualizado: 'x', dias: { [menos(2)]: { dia: menos(2), gasto: 40, impressoes: 100, cliques: 4, pedidos_amplos: 2, gmv_amplo: 400 }, [menos(1)]: { dia: menos(1), gasto: 2.5, impressoes: 10, cliques: 1, pedidos_amplos: 0, gmv_amplo: 0 } } });
    writeJson(MAN, { 901: { tem_etiqueta: true, marketplace: 'ml', numero: 778899, cliente: 'FULANO DE TAL DA SILVA', visto_em: new Date(Date.now() - 3 * 3600000).toISOString() } });
    writeJson(CONF, { 902: { conferido_em: new Date().toISOString(), numero: 665544, cliente: 'BELTRANA DE SOUZA', nf_emissao: '' } });
    rede.mlResposta = () => respML({ id: 7, nickname: 'LOJA', seller_reputation: BLOCO });
    rede.roteiro = [turno({ texto: 'Vou olhar.', usos: [{ id: 't1', name: 'gasto_anuncios', input: { de: menos(2), ate: menos(1) } }, { id: 't2', name: 'reputacao_mercado_livre', input: {} },
      { id: 't3', name: 'estoque_atual', input: { skus: ['TOSQ-1'] } }, { id: 't4', name: 'expedicao_do_galpao', input: { dias: 3 } }] }), turno({ texto: 'Pronto.' })];
    const res = novoRes();
    await h({ method: 'POST', headers: { 'x-admin-key': 'chave-adm' }, body: { pergunta: 'por que caiu?' } }, res, new URL('http://x' + P + '/chat-analise'));
    const ev = res._txt.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    assert.ok(ev.some((e) => e.t === 'fim') && !ev.some((e) => e.t === 'erro'), 'a pergunta não chegou ao fim: ' + res._txt.slice(0, 300));
    const p1 = rede.api[0], p2 = rede.api[1];
    assert.deepStrictEqual(p1.tools.map((t) => t.name), C.FERRAMENTAS.map((t) => t.name).concat(['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'anuncios_mercado_livre', 'saude_conta_shopee']), 'as consultas dos olhos têm que ir na lista que o modelo recebe (15/11: são seis — as duas da conta estão em scripts/teste-leitores-da-conta.js)');
    assert.ok(p1.tools.every((t) => t.description && t.input_schema && t.input_schema.type === 'object' && Array.isArray(t.input_schema.required)));
    /* as regras: as duas novas entram, e a lista do que "você não sabe" deixa de dizer estoque e reputação */
    assert.ok(/\n10\. OUTROS OLHOS\./.test(p1.system) && /\n11\. O QUE ESSES DADOS PROVAM\./.test(p1.system) && /COINCIDÊNCIA, não causa/.test(p1.system), 'as regras dos olhos não foram pro prompt');
    const regra2 = /\n2\. [^\n]*/.exec(p1.system)[0], regra5 = /\n5\. [^\n]*/.exec(p1.system)[0];
    assert.ok(/se um anúncio estava ativo ou pausado/.test(regra2) && !/falta de estoque|reputação da conta/.test(regra2), 'a regra 2 ainda diz que o chat não sabe de estoque/reputação: ' + regra2);
    assert.ok(/anúncios, reputação, estoque e expedição/.test(regra5));
    /* cada consulta rodou com as peças DA EMPRESA e o resultado voltou pro modelo */
    const voltou = p2.messages[p2.messages.length - 1].content;
    assert.deepStrictEqual(voltou.map((x) => [x.type, x.tool_use_id, x.is_error]), [['tool_result', 't1', undefined], ['tool_result', 't2', undefined], ['tool_result', 't3', undefined], ['tool_result', 't4', undefined]]);
    const [ads, rep, est, exp] = voltou.map((x) => JSON.parse(x.content));
    assert.deepStrictEqual([ads.shopee.total.consumo, ads.shopee.por_dia.length, ads.mercado_livre.disponivel], [42.5, 2, false]);
    assert.deepStrictEqual([rep.agora.nivel_codigo, rep.agora.atraso_no_despacho, rede.ml], ['5_green', { quantidade: 30, taxa_pct: 3.08, periodo: '60 days' }, ['Bearer tk-da-good']]);
    assert.deepStrictEqual([est.itens[0].sku, est.itens[0].saldo, est.itens[0].fonte, blingVisto], ['TOSQ-1', 0, 'Bling, consultado agora', ['/produtos?codigo=TOSQ-1&criterio=5&limite=1']]);
    assert.deepStrictEqual([exp.agora.esperando_conferencia.pedidos, exp.agora.esperando_conferencia.por_canal, exp.ultimos_dias.conferidos], [1, { ml: 1 }, 1]);
    /* (o dia é o de quando a pergunta rodou: se o teste atravessar a meia-noite, vale o dia seguinte) */
    const fotosE = readJson(path.join(TMP, REP.ARQUIVO), {}).dias;
    const diaDaFoto = Object.keys(fotosE)[0];
    assert.ok(Object.keys(fotosE).length === 1 && [hojeReal, C.hojeSP()].includes(diaDaFoto) && fotosE[diaDaFoto].nivel_codigo === '5_green', 'a consulta da reputação pelo chat grava a foto do dia no cache DA EMPRESA');
    /* a tela mostra cada passo */
    assert.deepStrictEqual(ev.filter((e) => e.t === 'passo').map((e) => e.texto), ['Olhando os anúncios pagos de ' + menos(2).slice(8) + '/' + menos(2).slice(5, 7) + ' a ' + menos(1).slice(8) + '/' + menos(1).slice(5, 7), 'Consultando a reputação no Mercado Livre', 'Consultando o estoque de 1 item(ns)', 'Olhando a expedição do galpão']);
    /* nada de cliente nem de número de pedido sai pra API */
    const tudo = JSON.stringify(rede.api);
    assert.ok(!/FULANO|BELTRANA|778899|665544/.test(tudo), 'nome de cliente ou número de pedido foi pra API');
    assert.strictEqual(ev.find((e) => e.t === 'fim').uso.consultas, 0, 'os olhos não leem a base de vendas');
  }
  /* sem as peças (quem chama o `responder` direto, sem `olhos`): o chat é o de antes — 7 consultas, prompt de antes */
  {
    rede.api.length = 0; rede.roteiro = [turno({ usos: [{ id: 'z', name: 'gasto_anuncios', input: { de: menos(2), ate: menos(1) } }] }), turno({ texto: 'ok' })];
    const enviados = [];
    await C.responder({ fetch: require('node-fetch'), chave: 'k', modelo: 'claude-sonnet-5-5', hoje: HOJE, nomeEmpresa: 'X', pergunta: 'oi', enviar: (e) => enviados.push(e), consultarHistorico: async () => ({ ok: true, totais: {} }) });
    assert.deepStrictEqual([rede.api[0].tools.length, rede.api[0].tools.length === C.FERRAMENTAS.length, /OUTROS OLHOS/.test(rede.api[0].system), /falta de estoque/.test(rede.api[0].system)], [7, true, false, true]);
    const tr = rede.api[1].messages[rede.api[1].messages.length - 1].content[0];
    assert.ok(tr.is_error === true && /consulta desconhecida: gasto_anuncios/.test(tr.content), 'sem os olhos, pedir uma consulta deles tem que voltar como consulta desconhecida');
  }

  /* ═══ F. A SONDA DA REPUTAÇÃO ═══ */
  {
    const u = new URL('http://x' + P + '/chat-analise?reputacao=1');
    const usoAntes = JSON.stringify(readJson(path.join(TMP, '_chat-analise-uso.json'), {}));
    rede.api.length = 0; rede.ml.length = 0;
    let res = novoRes(); await h({ method: 'GET', headers: {} }, res, u);
    assert.deepStrictEqual(res._json, [404, { error: 'not found' }], 'a sonda é só do admin');
    assert.strictEqual(rede.ml.length, 0, 'sem credencial, nada é perguntado ao Mercado Livre');
    fs.unlinkSync(path.join(TMP, REP.ARQUIVO));   /* a foto que a pergunta de cima gravou sai: a sonda tem que gravar a dela */
    res = novoRes(); await h({ method: 'GET', headers: { cookie: 'sess=dono' } }, res, u);
    const j = res._json[1];
    assert.ok(fs.existsSync(path.join(TMP, REP.ARQUIVO)), 'a sonda da reputação tem que gravar a foto do dia');
    assert.deepStrictEqual([res._json[0], j.ok, j.resumo.nivel_codigo, j.como_o_mercado_livre_mandou, j.fotos_guardadas.map((f) => f.dia), rede.ml, j.foto_de_hoje_gravada], [200, true, '5_green', BLOCO, [C.hojeSP()], ['Bearer tk-da-good'], true]);
    assert.deepStrictEqual([rede.api.length, JSON.stringify(readJson(path.join(TMP, '_chat-analise-uso.json'), {}))], [0, usoAntes], 'a sonda não chama o modelo nem gasta pergunta');
    rede.mlResposta = () => respML({}, 401);
    res = novoRes(); await h({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u);
    assert.deepStrictEqual([res._json[1].ok, res._json[1].erro, res._json[1].resumo, res._json[1].fotos_guardadas.length, res._json[1].foto_de_hoje_gravada], [false, 'o Mercado Livre respondeu HTTP 401', null, 1, null]);
    /* loja sem a conta do ML ligada */
    res = novoRes(); await montar({ garantirTokenML: null })({ method: 'GET', headers: { 'x-admin-key': 'chave-adm' } }, res, u);
    assert.deepStrictEqual(res._json[1], { ok: false, erro: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' });
    rede.mlResposta = () => respML({ seller_reputation: BLOCO });
  }
  console.log = _logE;

  /* ═══ G. A MADRUGADA TIRA A FOTO ═══ */
  {
    const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
    const _log = console.log; console.log = () => {};
    const raiz = path.join(__dirname, '..');
    const dubles = { [require.resolve(path.join(raiz, 'tiktok-oauth', 'index.js'))]: { chamar: async () => ({ ok: true, http: 200, corpo: { code: 0, data: {} } }), lerToken: () => null },
      [require.resolve(path.join(raiz, 'magalu-oauth', 'index.js'))]: { coletarCancelados: async () => ({ ok: true, vistos: 0, novos: 0 }) } };
    const salvos = {};
    for (const [k, v] of Object.entries(dubles)) { salvos[k] = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports: v }; }
    try {
      const noite = async (extra) => {
        const dir = novoDir();
        const ctx = Object.assign({ empresa: 'good', prefixo: P, cacheDir: dir, mlBillingSync: async () => ({ linhas: 0 }), backfillVendas: async () => ({ ok: true }), backfillEstado: () => ({ rodando: false }),
          mlSyncFees: async () => ({ ok: 0, total: 0, falhas: 0 }), varrerCancelados: async () => ({ ok: true }), VERSAO: 'v', validarSessao: () => null, ehAdmin: () => false, json: () => {} }, extra);
        const dia = C.hojeSP();
        const r = await require('../lib/checkout/noturna-empresa').criarNoturna(ctx).rotinaNoturna('teste');
        const iFoto = r.etapas.findIndex((e) => e.nome === 'foto da reputação do Mercado Livre');
        return { dir, dia, etapa: r.etapas[iFoto] || null, resumo: r.resumo, depois: iFoto < 0 ? 0 : r.etapas.length - 1 - iFoto };
      };
      const chamadas = [];
      let n = await noite({ garantirTokenML: async () => 'tk-noite', fetch: async (u, o) => { chamadas.push([u, o.headers.Authorization]); return respML({ seller_reputation: BLOCO }); } });
      assert.ok(n.etapa && n.etapa.estado === 'ok' && /verde \(o melhor nível\)/.test(n.etapa.detalhe), 'a madrugada não tirou a foto da reputação: ' + JSON.stringify(n.etapa));
      /* (15/11: a mesma noite também tira a foto dos ANÚNCIOS — lib/checkout/anuncios-ml, provada em scripts/teste-leitores-da-conta.js.
         Ela começa pedindo `/users/me` pra saber de quem é a conta; aqui a resposta não traz o id, e ela para nesse pedido.) */
      assert.deepStrictEqual(chamadas, [['https://api.mercadolibre.com/users/me', 'Bearer tk-noite'], ['https://api.mercadolibre.com/users/me', 'Bearer tk-noite']], 'a foto da reputação faz UMA chamada ao Mercado Livre por noite (a segunda é a da foto dos anúncios, que para nela)');
      const antesN = C.hojeSP();
      const diasN = Object.keys(readJson(path.join(n.dir, REP.ARQUIVO), {}).dias);
      assert.ok(diasN.length === 1 && [antesN, n.dia].includes(diasN[0]), 'a foto vai pro cache DA EMPRESA, no dia de hoje: ' + diasN);
      /* o ML não respondeu: a etapa ACUSA (noite sem foto é dia sem histórico) e nada é gravado */
      n = await noite({ garantirTokenML: async () => 'tk', fetch: async () => respML({}, 503) });
      assert.ok(n.etapa && n.etapa.estado === 'erro' && /HTTP 503/.test(n.etapa.detalhe) && /foto da reputação do Mercado Livre/.test(n.resumo) && !fs.existsSync(path.join(n.dir, REP.ARQUIVO)));
      /* (Codex #883) o ML EMUDECE: a etapa acusa o prazo e a noite SEGUE (aqui o relógio do teste dispara na hora) */
      n = await noite({ garantirTokenML: async () => 'tk', fetch: () => new Promise(() => {}) });
      assert.ok(n.etapa && n.etapa.estado === 'erro' && /não respondeu no prazo/.test(n.etapa.detalhe) && n.resumo, 'o ML emudeceu e a madrugada não seguiu: ' + JSON.stringify(n.etapa));
      assert.ok(n.depois > 0, 'depois da foto da reputação a noite tinha que rodar as etapas seguintes');
      /* empresa sem o token do ML: a etapa nem aparece */
      n = await noite({});
      assert.strictEqual(n.etapa, null);
    } finally { global.setTimeout = _st; console.log = _log; for (const k of Object.keys(dubles)) { if (salvos[k]) require.cache[k] = salvos[k]; else delete require.cache[k]; } }
  }

  /* ═══ H. NAS TRÊS EMPRESAS ═══ */
  {
    const raiz = path.join(__dirname, '..');
    const EMPRESAS = [['amb', 'amb-checkout-offline', 'amb-historico.js', 'ambtotal', 'index.js'], ['girassol', 'girassol-backup-offline', 'historico.js', 'girassol', 'gbo-app.js'], ['good', 'good-checkout-offline', 'historico-good.js', 'good', 'index.js']];
    /* a peça do histórico de mentira: só anota o que a fachada de cada empresa entregou */
    const kHist = require.resolve('../lib/checkout/historico');
    const histDeVerdade = require.cache[kHist];
    let entregue = null;
    require.cache[kHist] = { id: kHist, filename: kHist, loaded: true, exports: { rotasHistorico: (c) => { entregue = c; return async () => false; } } };
    const tokens = {};
    try {
      for (const [emp, pasta, fachada, dirML] of EMPRESAS) {
        const kTok = require.resolve(path.join(raiz, dirML, 'mlTokenManager.js'));
        tokens[kTok] = require.cache[kTok];
        require.cache[kTok] = { id: kTok, filename: kTok, loaded: true, exports: { garantirTokenML: async () => 'token-do-ml-da-' + emp } };
        const kF = require.resolve(path.join(raiz, pasta, fachada)); delete require.cache[kF];
        entregue = null;
        require(kF).rotasHistorico({ validarSessao: () => null });
        const base = require(path.join(raiz, pasta, 'base.js'));
        assert.ok(entregue && entregue.empresa === emp, emp + ': a fachada do histórico não montou a peça com a empresa dela');
        assert.ok(base.MANIFEST_FILE && entregue.MANIFEST_FILE === base.MANIFEST_FILE && entregue.MANIFEST_FILE.startsWith(base.CACHE_DIR), emp + ': a fila do galpão (manifesto) entregue ao chat não é a DESTA empresa: ' + entregue.MANIFEST_FILE);
        assert.strictEqual(entregue.CONFERIDOS_FILE, base.CONFERIDOS_FILE, emp + ': os conferidos entregues não são os desta empresa');
        assert.strictEqual(typeof entregue.garantirTokenML, 'function', emp + ': a fachada não entrega o token do ML ao chat — a reputação ficaria "não disponível"');
        assert.strictEqual(await entregue.garantirTokenML(), 'token-do-ml-da-' + emp, emp + ': o token do ML entregue ao chat não é o DESTA empresa');
        delete require.cache[kF];
      }
    } finally { require.cache[kHist] = histDeVerdade; for (const [k, v] of Object.entries(tokens)) { if (v) require.cache[k] = v; else delete require.cache[k]; } }
    /* a madrugada de cada empresa recebe o token do ML DELA (lido no arquivo que monta a madrugada) */
    for (const [emp, pasta, , dirML, entrada] of EMPRESAS) {
      const fonte = fs.readFileSync(path.join(raiz, pasta, entrada), 'utf8');
      const i0 = fonte.search(/const _noturna(Good)? = (require\('\.\.\/lib\/checkout\/noturna-empresa'\)\.)?criarNoturna\(\{/);
      assert.ok(i0 >= 0, emp + ': não achei onde a madrugada é montada');
      const bloco = fonte.slice(i0, fonte.indexOf('\n});\n', i0));
      const m = /^  garantirTokenML: \(\) => require\('\.\.\/([a-z]+)\/mlTokenManager'\)\.garantirTokenML\(\),$/m.exec(bloco);
      assert.ok(m && m[1] === dirML, emp + ': a madrugada não recebe o token do ML desta empresa (a foto diária da reputação não roda)' + (m ? ' — recebe o de "' + m[1] + '"' : ''));
    }
  }

  /* as descrições que a tela mostra enquanto consulta, e a peça não aceita nascer sem o essencial */
  assert.deepStrictEqual(['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'outra'].map((n) => OLHOS.descrever(n, { de: '2026-11-08', ate: '2026-11-14', skus: ['a', 'b'] })),
    ['Olhando os anúncios pagos de 08/11 a 14/11', 'Consultando a reputação no Mercado Livre', 'Consultando o estoque de 2 item(ns)', 'Olhando a expedição do galpão', null]);
  assert.deepStrictEqual(OLHOS.FERRAMENTAS.map((f) => f.name), ['gasto_anuncios', 'reputacao_mercado_livre', 'estoque_atual', 'expedicao_do_galpao', 'anuncios_mercado_livre', 'saude_conta_shopee']);
  assert.throws(() => OLHOS.criarOlhos({ hoje: HOJE, empresa: 'x', readJson, writeJson, validarPeriodo }), /falta CACHE_DIR/);

  _chegouAoFim = true;
  console.log('ok — os olhos do chat: reputação do ML (taxa só com a unidade confirmada, foto por dia, o que mudou em código), Ads da Shopee e do ML por dia (dia sem dado não é zero), estoque (guardado novo não gasta Bling; velho consulta, com teto; fora do ar vem marcado) e expedição do galpão (fila e horas da nota à conferência, no fuso certo); pela rota de verdade as quatro consultas vão pro modelo e rodam com as peças da empresa, sem dado de cliente; a sonda da reputação é só do admin; a madrugada tira a foto');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
