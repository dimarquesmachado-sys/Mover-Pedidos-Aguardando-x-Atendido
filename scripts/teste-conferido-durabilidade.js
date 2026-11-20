'use strict';
/* 15/11 — CONFERIDO: GRAVAÇÃO CONFIRMADA ANTES DO EFEITO EXTERNO, E GERAÇÃO POR FINALIZAÇÃO (auditoria do Codex de
   15/11/2026, P1 nº 6 e nº 7). Funções DE PRODUÇÃO (lib/checkout/rotas-conferido e a sincronização de
   lib/checkout/ciclo-empresa) com disco e Bling de mentira.

   P1 nº 6 — antes, `writeJson` devolvia false (disco cheio / só leitura) e o handler seguia: arquivava, soltava a reserva,
   movia no Bling e respondia ok:true — sem NENHUM registro durável do pedido.
     A. disco recusa a gravação → 503 `nao_gravado`, e NADA acontece depois: zero arquivamento, zero reserva solta, zero
        movimento no Bling, a fila continua como estava.
     B. disco normal → a entrada nasce com `geracao`, e tudo segue como antes.
   P1 nº 7 — a sincronização tirava a lista de ids no começo; um pedido REABERTO durante a espera do Bling ainda era movido
   pra VERIFICADO (sumia da tela do galpão). E um resultado atrasado podia marcar como sincronizada uma finalização NOVA do
   mesmo id.
     C. sync: enquanto o 1 espera o Bling, o 2 é reaberto (sai da fila) → o 2 NÃO é movido; `reabertosNoMeio: 1`.
     D. sync: enquanto o 1 espera, o 1 é reaberto e finalizado DE NOVO (outra geração) → a resposta atrasada não marca a
        finalização nova como sincronizada (ela fica pendente pra próxima rodada).
     E. verificado na hora: durante a espera do Bling, reabrem e finalizam de novo → a marca da ida antiga não pega na nova;
        a resposta diz `sincronizado:false`.
     F. a peça `atualizarConferido` com geração: casa só a mesma; entrada antiga sem geração casa só com geração ausente;
        devolve false quando a gravação falha. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const disco = {};
let recusarEscrita = false;
const readJson = (f, d) => (f in disco ? JSON.parse(JSON.stringify(disco[f])) : d);
const writeJson = (f, o) => { if (recusarEscrita) return false; disco[f] = JSON.parse(JSON.stringify(o)); return true; };

const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-conferido'));
const { atualizarConferido, novaGeracao } = require(path.join(raiz, 'lib', 'checkout', 'conferidos-atualizar'));

/* um handler que fica esperando um Bling que nunca responde (porque seguiu adiante depois de recusar a gravação) deixaria o
   processo sair com código 0 e sem mensagem — o vigia transforma isso em FALHA */
const vigia = setTimeout(() => { console.error('FALHOU: o teste travou — algum caminho ficou esperando o Bling de mentira (seguiu adiante onde devia parar?)'); process.exit(1); }, 30000);
(async () => {
  /* ───────── F. a peça com geração ───────── */
  {
    const F = '/f/c.json'; disco[F] = { 5: { geracao: 'g1' }, 6: { conferido_em: 'velho' } };
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '5', (e) => { e.x = 1; }, 'g2'), false, 'outra geração não marca');
    assert.ok(!disco[F]['5'].x);
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '5', (e) => { e.x = 1; }, 'g1'), true); assert.strictEqual(disco[F]['5'].x, 1);
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '6', (e) => { e.y = 1; }, 'g1'), false, 'entrada antiga sem geração não casa com uma geração');
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '6', (e) => { e.y = 1; }, undefined), true, 'sem geração pedida: comportamento de antes');
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '6', (e) => { e.z = 1; }, null), true, 'geração nula casa com entrada sem geração');
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '9', (e) => { e.y = 1; }), false, 'sumiu: não ressuscita');
    recusarEscrita = true;
    assert.strictEqual(atualizarConferido(readJson, writeJson, F, '5', (e) => { e.w = 1; }, 'g1'), false, 'gravação recusada: false');
    recusarEscrita = false;
    const g1 = novaGeracao(), g2 = novaGeracao(); assert.ok(g1 !== g2 && /^\d{4}-\d\d-\d\dT/.test(g1), 'gerações únicas e datadas');
  }

  /* ───────── A/B/E. o "verificado" ───────── */
  const CONF = '/c/conferidos.json', RSV = '/c/reservas.json';
  disco[CONF] = {}; disco[RSV] = { 1: { por: 'op' }, 2: { por: 'op' } };
  const movidos = [], arquivados = [], respostas = [];
  const pendentes = [];   /* um resolvedor por IDA, na ordem das chamadas */
  const moverSituacao = (id) => { movidos.push(String(id)); return new Promise((ok) => { pendentes.push(ok); }); };
  const h = criar({ prefixo: '/x', tag: 'T', json: (res, code, o) => respostas.push({ code, o }), readBody: async (req) => req._body, readJson, writeJson,
    lerReservas: () => readJson(RSV, {}), moverSituacao, arquivarFinalizado: (id) => arquivados.push(String(id)), sincronizarConferidos: async () => ({}), rodarCiclo: () => {},
    CONFERIDOS_FILE: CONF, RESERVAS_FILE: RSV, CACHE_DIR: '/c', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 'x' });
  const req = (id) => ({ method: 'POST', headers: {}, _body: { id, user: 'op' } });
  const U = new URL('http://x/x/conferido');

  /* A. disco recusa */
  recusarEscrita = true;
  await h(req('1'), {}, U, 'POST', () => 'op');
  recusarEscrita = false;
  assert.deepStrictEqual([respostas[0].code, respostas[0].o.ok, respostas[0].o.nao_gravado], [503, false, true], 'gravação recusada tem que responder 503 nao_gravado: ' + JSON.stringify(respostas[0]));
  assert.deepStrictEqual([movidos, arquivados, Object.keys(disco[CONF]), Object.keys(disco[RSV]).sort()], [[], [], [], ['1', '2']], 'com a gravação recusada NADA pode acontecer: sem Bling, sem arquivo, sem reserva solta, fila intacta');

  /* B. disco normal: geração na entrada, e o fluxo de antes */
  const r1 = h(req('1'), {}, U, 'POST', () => 'op');
  for (let i = 0; i < 20 && pendentes.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(pendentes.length, 1, 'o 1 tinha que estar esperando o Bling');
  assert.ok(disco[CONF]['1'] && /^\d{4}-/.test(disco[CONF]['1'].geracao) && disco[CONF]['1'].sincronizado === false, 'a entrada nasce gravada, com geração, antes do Bling');
  assert.deepStrictEqual([arquivados, Object.keys(disco[RSV])], [['1'], ['2']], 'arquivou e soltou a reserva do 1 depois de gravar');
  const geracaoVelha = disco[CONF]['1'].geracao;

  /* E. durante a espera: reabrem o 1 (sai da fila) e finalizam de novo (geração nova) */
  { const a = readJson(CONF, {}); delete a['1']; writeJson(CONF, a); }
  const r1b = h(req('1'), {}, U, 'POST', () => 'op');
  for (let i = 0; i < 20 && pendentes.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(pendentes.length, 2, 'as duas idas tinham que estar esperando o Bling');
  const geracaoNova = disco[CONF]['1'].geracao;
  assert.ok(geracaoNova && geracaoNova !== geracaoVelha, 'a finalização nova tem OUTRA geração');
  /* a ida VELHA volta do Bling com ok */
  pendentes[0]({ ok: true }); await r1;
  assert.strictEqual(disco[CONF]['1'].sincronizado, false, 'o ok da ida VELHA não pode marcar a finalização NOVA como sincronizada');
  assert.deepStrictEqual([respostas[1].code, respostas[1].o.ok, respostas[1].o.sincronizado], [200, true, false], 'a ida velha responde ok mas sincronizado:false (a fila mudou): ' + JSON.stringify(respostas[1].o));
  /* a ida NOVA volta: marca a entrada nova */
  pendentes[1]({ ok: true }); await r1b;
  assert.ok(disco[CONF]['1'].sincronizado === true && disco[CONF]['1'].geracao === geracaoNova, 'o ok da ida nova marca a nova');
  assert.deepStrictEqual(movidos, ['1', '1'], 'duas idas ao Bling, uma por finalização');

  /* ───────── C/D. a sincronização do ciclo — função DE PRODUÇÃO tirada da peça ───────── */
  const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  const i0 = src.indexOf('  async function sincronizarConferidos(pular) {');
  assert.ok(i0 > 0, 'não achei a sincronização dos conferidos na peça do ciclo');
  const corpo = src.slice(i0, src.indexOf('\n  }\n', i0) + 4);
  const reqLib = (m) => require(m.startsWith('.') ? path.join(raiz, 'lib', 'checkout', m) : m);
  const montar = (CF, mover) => new Function('readJson', 'writeJson', 'CONFERIDOS_FILE', 'MANIFEST_FILE', 'FULL_DESPACHADOS_FILE', '_fullDespachadosNoProcesso', 'moverSituacao', 'blingGet',
    'SIT_VERIFICADO', 'SIT_ATENDIDO', 'SIT_DESPACHADOS', 'LOG', 'sleep', 'PAUSA_MS', 'require', 'console', 'ultimoSync',
    corpo + '\nreturn sincronizarConferidos;')(readJson, writeJson, CF, '/s/m.json', '/s/fd.json', new Set(), mover, async () => ({}), 24, 9, 0, 'T', async () => {}, 0, reqLib, { log: () => {}, warn: () => {} }, null);

  /* C. o 2 é reaberto enquanto o 1 espera o Bling */
  {
    const CF = '/s/c1.json'; disco[CF] = { 1: { geracao: 'a' }, 2: { geracao: 'b' } };
    const movidosS = [];
    const mover = async (id) => {
      movidosS.push(String(id));
      if (String(id) === '1') { const at = readJson(CF, {}); delete at['2']; writeJson(CF, at); }   /* reabrir o 2 durante a espera */
      return { ok: true };
    };
    const res = await montar(CF, mover)();
    assert.deepStrictEqual(movidosS, ['1'], 'o 2, reaberto durante a espera do 1, NÃO pode ir pro Bling — era o P1: o laço movia um pedido que já tinha voltado pra ATENDIDO');
    assert.deepStrictEqual([res.ok, res.reabertosNoMeio, disco[CF]['1'].sincronizado, disco[CF]['2']], [1, 1, true, undefined]);
  }
  /* D. o 1 é reaberto e finalizado DE NOVO enquanto espera o Bling */
  {
    const CF = '/s/c2.json'; disco[CF] = { 1: { geracao: 'a' } };
    const mover = async (id) => { const at = readJson(CF, {}); at['1'] = { geracao: 'NOVA', sincronizado: false }; writeJson(CF, at); return { ok: true }; };
    const res = await montar(CF, mover)();
    assert.deepStrictEqual([disco[CF]['1'].sincronizado, disco[CF]['1'].geracao, res.ok], [false, 'NOVA', 1], 'o ok da geração velha não marca a finalização nova; ela fica pendente pra próxima rodada');
  }
  /* D2. o mesmo, com o Bling FALHANDO: o erro da geração velha não suja a finalização nova */
  {
    const CF = '/s/c2b.json'; disco[CF] = { 1: { geracao: 'a' } };
    const mover = async () => { const at = readJson(CF, {}); at['1'] = { geracao: 'NOVA', sincronizado: false }; writeJson(CF, at); return { ok: false, status: 500 }; };
    const res = await montar(CF, mover)();
    assert.deepStrictEqual([disco[CF]['1'].sync_erro, disco[CF]['1'].geracao, res.falhas], [undefined, 'NOVA', 1], 'o erro do Bling da geração velha não marca a finalização nova');
  }
  /* D3 (Codex #896): entrada ANTIGA (sem geração, de antes desta versão) reaberta e finalizada de novo durante a espera —
     a nova tem geração; o ok velho não pode marcá-la */
  {
    const CF = '/s/c2c.json'; disco[CF] = { 1: { conferido_em: 'velho' } };
    const mover = async () => { const at = readJson(CF, {}); at['1'] = { geracao: 'NOVA', sincronizado: false }; writeJson(CF, at); return { ok: true }; };
    const res = await montar(CF, mover)();
    assert.deepStrictEqual([disco[CF]['1'].sincronizado, disco[CF]['1'].geracao, res.ok], [false, 'NOVA', 1], 'entrada antiga sem geração substituída por uma nova no meio: o ok velho não marca a nova (Codex #896)');
    /* e a peça direto: geração passada como undefined/null exige entrada SEM geração; omitida = sem checagem (o reenvio) */
    const F2 = '/f/c2.json'; disco[F2] = { 5: { geracao: 'g1' } };
    assert.strictEqual(atualizarConferido(readJson, writeJson, F2, '5', (e) => { e.x = 1; }, undefined), false, 'geração undefined PASSADA não casa com entrada que tem geração');
    assert.strictEqual(atualizarConferido(readJson, writeJson, F2, '5', (e) => { e.x = 1; }), true, 'geração OMITIDA: sem checagem (o reenvio de documentos)');
  }
  /* o painel do galpão: a finalização recusada (503 nao_gravado / ok:false) não vira "✓ finalizado" (Codex #896) */
  {
    const tela = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
    const i1 = tela.indexOf('async function confirmarFinalizar()'); const corpoF = tela.slice(i1, tela.indexOf('\n}\n', i1));
    assert.ok(/r\.ok===false && !r\.ja_finalizado/.test(corpoF) && /nao_gravado/.test(corpoF), 'confirmarFinalizar não trata a recusa do servidor');
    assert.ok(corpoF.indexOf('NÃO finalizado') < corpoF.indexOf('pararHeartbeat()') && /return; \}/.test(corpoF.slice(0, corpoF.indexOf('pararHeartbeat()'))), 'a recusa tem que sair ANTES de parar o heartbeat e fechar o pedido');
    /* 20/11: a versão segue subindo a cada mudança do painel — o que este teste garante é que ela passou da que estava no ar antes DESTA mudança (b145/b83/b153), não um número cravado que quebra na mudança seguinte */
    for (const [arq, minimo] of [['amb-checkout-offline/painel-marca.js', 146], ['good-checkout-offline/painel-marca.js', 84], ['girassol-backup-offline/painel-marca.js', 154]]) { const m = fs.readFileSync(path.join(raiz, arq), 'utf8').match(/UI_BUILD: "b(\d+)"/); assert.ok(m && Number(m[1]) >= minimo, arq + ': o painel mudou e o UI_BUILD não subiu'); }
  }
  /* o caminho de antes continua: entradas sem geração (anteriores a esta versão) sincronizam normalmente */
  {
    const CF = '/s/c3.json'; disco[CF] = { 3: { conferido_em: 'velho' } };
    const res = await montar(CF, async () => ({ ok: true }))();
    assert.deepStrictEqual([disco[CF]['3'].sincronizado, res.ok, res.reabertosNoMeio], [true, 1, 0], 'entrada antiga sem geração sincroniza como sempre');
  }
  /* falha do Bling marca o erro na geração vista; "já avançou" idem */
  {
    const CF = '/s/c4.json'; disco[CF] = { 4: { geracao: 'q' } };
    const res = await montar(CF, async () => ({ ok: false, status: 500 }))();
    assert.deepStrictEqual([disco[CF]['4'].sync_erro, res.falhas], ['500', 1]);
  }
  clearTimeout(vigia);
  console.log('ok — conferido: gravação recusada = 503 e nada acontece (sem Bling, sem arquivo, sem reserva); a finalização tem geração; o sync relê a fila antes de cada movimento (pedido reaberto não vai pro Bling) e um resultado atrasado não marca a finalização nova');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
