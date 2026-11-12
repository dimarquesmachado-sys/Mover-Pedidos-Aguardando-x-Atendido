'use strict';
/* 12/11 — O TESTE DO REENVIO PELA API numa nota em "Consultar situação" (rota /robo/nf-reenvio-teste, nas três empresas).
   Pergunta do dono: "não consegue automatizar isso num ciclo por API, num cron? Se eu não entrar no Bling, a NF fica
   travada infinita". A API do Bling não tem "consultar situação"; a única ação sobre uma nota já enviada é o reenvio.
   A rota mede o que o reenvio faz: situação antes → resposta do Bling → situação depois. Prova da rota:
   · só reenvia nota que está na LISTA de "Consultar situação" do Bling (o filtro situacao=10) — NÃO pelo código do detalhe,
     que pra esse estado é outro (0): em 12/11 a rota recusou as duas notas travadas por conferir o detalhe contra 10;
   · reenvia UMA vez, guarda o HTTP e a resposta do Bling, relê a nota e diz se destravou (5) — ou que continua em 10;
   · id inválido e nota inexistente respondem dizendo o que houve, sem reenviar nada;
   · é rota de admin (a regra central de /robo/), nas três empresas (com o prefixo de cada uma). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');
const { ehRotaCentralAdmin } = require('../lib/http/rotas-protegidas');

const nada = async () => ({});
/* O BLING DE MENTIRA, como o de verdade (medido em junho e de novo em 12/11 com as notas 130428 e 130431 da Girassol):
   a nota em "Consultar situação" aparece na LISTA com o filtro situacao=10, mas no DETALHE o código dela é OUTRO (0).
   Cada nota: { numero, travada: [antes, depois], detalhe: [antes, depois] }. */
const consultas = [];
function modulo(prefixo, notas, reenvios) {
  const fase = (idNF) => (reenvios.indexOf(idNF) === -1 ? 0 : 1);
  return criarModuloFiscal({ id: 'teste', nome: 'Teste', prefixo, rotulo: 'TESTE', crons: {},
    pecas: { rotinaExpediente: nada, rotinaVirada: nada, rotinaManha: nada, corrigirNFsPendentes: nada, retryNFManual: nada, getEstadoRetrySEFAZ: () => ({}),
      garantirToken: async () => 't', gerarTokenInicial: nada, gerarTokenInicialNF: nada, garantirTokenNF: async () => 'tnf',
      garantirTokenML: async () => 'tml', trocarCodigoPorToken: nada, gerarUrlAutorizacao: () => 'http://x', getPedidoDetalhe: nada, rotinaNFeML: nada, enviarNFeUnica: nada,
      getNFDetalhe: async (tok, idNF) => { const n = notas[idNF]; if (!n) return null; return { numero: n.numero, situacao: n.detalhe[fase(idNF)], dataEmissao: n.emissao === undefined ? '2026-11-11 21:35:03' : n.emissao }; },
      /* a conferência pelo DIA DE EMISSÃO da nota: true / false / null (não deu pra saber) — e registra com que data foi chamada */
      nfEstaEmConsulta: async (tok, idNF, dataEmissao) => { consultas.push([idNF, dataEmissao]); const n = notas[idNF]; if (!dataEmissao) return null; const v = n.travada[fase(idNF)]; return v === 'nao_sei' ? null : !!v; },
      enviarNFCru: async (tok, idNF) => { reenvios.push(idNF); return { status: 200, corpo: '{"data":{"xml":"...","mensagem":"resposta do Bling"}}' }; } } });
}
async function chamar(mod, caminho) {
  const u = new URL('http://x' + caminho); let st = 0, corpo = '';
  const res = { writeHead: (c) => { st = c; }, end: (b) => { corpo = String(b || ''); }, setHeader: () => {} };
  const tratou = await mod.routes(async () => ({}))({ method: 'GET', headers: {}, url: caminho }, res, u);
  return { tratou, st, j: corpo ? JSON.parse(corpo) : null };
}

(async () => {
  const tAntes = global.setTimeout; global.setTimeout = (f, ms) => tAntes(f, ms >= 1000 ? 1 : ms);   /* a espera da rota não segura o teste */
  try {
    /* O CASO REAL (12/11): nota TRAVADA — na lista, com código 0 no detalhe. A rota tem que REENVIAR (antes ela conferia o
       detalhe contra 10 e respondia "não está em Consultar situação" justamente pras notas travadas) */
    let reenvios = [];
    let m = modulo('', { '27382395982': { numero: '130428', travada: [true, false], detalhe: [0, 5] } }, reenvios);
    let r = await chamar(m, '/robo/nf-reenvio-teste?id=27382395982');
    assert.ok(r.tratou && r.st === 200 && r.j.ok === true && r.j.estava_em_consultar_situacao === true && r.j.situacao_no_detalhe_antes === 0 && r.j.continua_em_consultar_situacao === false && r.j.situacao_no_detalhe_depois === 5 && r.j.destravou === true && r.j.reenvio.http === 200 && /resposta do Bling/.test(r.j.reenvio.resposta) && r.j.nota.numero === '130428' && /cron no servidor/.test(r.j.leia), 'a nota travada (na lista, detalhe 0) tinha que ser reenviada e o resultado medido pela LISTA: ' + JSON.stringify(r.j));
    assert.deepStrictEqual(reenvios, ['27382395982'], 'reenvia UMA vez');
    assert.ok(consultas.length === 2 && consultas.every((c) => c[0] === '27382395982' && c[1] === '2026-11-11 21:35:03'), 'a conferência (antes e depois) é pelo dia de emissão DA NOTA — vale pra nota de qualquer idade: ' + JSON.stringify(consultas));
    /* continua na lista depois do reenvio: não destravou */
    reenvios = []; m = modulo('/amb', { '5555555': { numero: '9', travada: [true, true], detalhe: [0, 0] } }, reenvios);
    r = await chamar(m, '/amb/robo/nf-reenvio-teste?id=5555555');
    assert.ok(r.j.ok === true && r.j.destravou === false && r.j.continua_em_consultar_situacao === true && /CONTINUA/.test(r.j.leia) && reenvios.length === 1, JSON.stringify(r.j));
    /* saiu da lista mas o detalhe não é 5 (ex.: rejeitada): diz que saiu e mostra o código, sem chamar de autorizada */
    reenvios = []; m = modulo('/good', { '7777777': { numero: '1', travada: [true, false], detalhe: [0, 4] } }, reenvios);
    r = await chamar(m, '/good/robo/nf-reenvio-teste?id=7777777');
    assert.ok(r.j.continua_em_consultar_situacao === false && r.j.situacao_no_detalhe_depois === 4 && /agora: 4/.test(r.j.leia) && /confira no Bling/.test(r.j.leia), JSON.stringify(r.j));
    /* nota que NÃO está na lista de "Consultar situação": não reenvia — qualquer que seja o código do detalhe (inclusive 0 e 10) */
    for (const sit of [5, 4, 1, 2, 0, 10]) {
      reenvios = []; m = modulo('', { '8888888': { numero: '2', travada: [false, false], detalhe: [sit, sit] } }, reenvios);
      r = await chamar(m, '/robo/nf-reenvio-teste?id=8888888');
      assert.ok(r.j.ok === false && r.j.situacao_no_detalhe === sit && reenvios.length === 0 && /não aparece agora na lista/.test(r.j.erro), 'nota fora da lista (detalhe ' + sit + ') não pode ser reenviada pelo teste: ' + JSON.stringify(r.j));
    }
    /* Codex #854: "não deu pra saber" NÃO é "não está" nem "está": sem a data de emissão, ou com a busca do dia sem terminar,
       nada é reenviado e a resposta diz isso */
    reenvios = []; m = modulo('', { '9999999': { numero: '3', travada: [true, true], detalhe: [0, 0], emissao: null } }, reenvios);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=9999999');
    assert.ok(r.j.ok === false && reenvios.length === 0 && /não consegui confirmar/.test(r.j.erro), 'sem a data de emissão não dá pra conferir: nada reenviado: ' + JSON.stringify(r.j));
    reenvios = []; m = modulo('', { '9999998': { numero: '4', travada: ['nao_sei', 'nao_sei'], detalhe: [0, 0] } }, reenvios);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=9999998');
    assert.ok(r.j.ok === false && reenvios.length === 0 && /não consegui confirmar/.test(r.j.erro));
    /* depois do reenvio a conferência não respondeu: não afirma que destravou */
    reenvios = []; m = modulo('', { '9999997': { numero: '5', travada: [true, 'nao_sei'], detalhe: [0, 0] } }, reenvios);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=9999997');
    assert.ok(r.j.ok === true && reenvios.length === 1 && r.j.continua_em_consultar_situacao === null && r.j.destravou === false && /não consegui reler/.test(r.j.leia), JSON.stringify(r.j));
    reenvios = []; m = modulo('', {}, reenvios);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=abc'); assert.ok(r.st === 400 && reenvios.length === 0);
    r = await chamar(m, '/robo/nf-reenvio-teste'); assert.strictEqual(r.st, 400);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=1234567'); assert.ok(r.st === 404 && reenvios.length === 0);
  } finally { global.setTimeout = tAntes; }
  /* é rota de admin, com o prefixo de cada empresa; e as três entregam as duas peças */
  for (const p of ['/robo/nf-reenvio-teste', '/amb/robo/nf-reenvio-teste', '/good/robo/nf-reenvio-teste']) assert.ok(ehRotaCentralAdmin(p), p + ' tem que exigir a chave de admin');
  for (const emp of ['girassol', 'ambtotal', 'good']) {
    const s = fs.readFileSync(path.join(__dirname, '..', emp, 'index.js'), 'utf8');
    assert.ok(/enviarNFCru: require\('\.\/nfBlingApi'\)\.enviarNFCru,/.test(s) && /nfEstaEmConsulta: require\('\.\/nfBlingApi'\)\.nfEstaEmConsulta,/.test(s) && /getNFDetalhe: require\('\.\/nfBlingApi'\)\.getNFDetalhe,/.test(s), emp + ': não entrega enviarNFCru/nfEstaEmConsulta/getNFDetalhe ao módulo fiscal');
    assert.strictEqual(typeof require('../' + emp + '/nfBlingApi').nfEstaEmConsulta, 'function', emp + ': a fachada não exporta nfEstaEmConsulta');
    assert.strictEqual(typeof require('../' + emp + '/nfBlingApi').enviarNFCru, 'function', emp + ': a fachada não exporta enviarNFCru');
  }
  console.log('ok — teste do reenvio pela API: só nota em "Consultar situação", uma vez, com a resposta do Bling e a situação antes/depois — nas três empresas, só admin');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
