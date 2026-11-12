'use strict';
/* 12/11 — O TESTE DO REENVIO PELA API numa nota em "Consultar situação" (rota /robo/nf-reenvio-teste, nas três empresas).
   Pergunta do dono: "não consegue automatizar isso num ciclo por API, num cron? Se eu não entrar no Bling, a NF fica
   travada infinita". A API do Bling não tem "consultar situação"; a única ação sobre uma nota já enviada é o reenvio.
   A rota mede o que o reenvio faz: situação antes → resposta do Bling → situação depois. Prova da rota:
   · só reenvia nota em "Consultar situação" (10): nota autorizada, rejeitada etc. NÃO é reenviada;
   · reenvia UMA vez, guarda o HTTP e a resposta do Bling, relê a nota e diz se destravou (5) — ou que continua em 10;
   · id inválido e nota inexistente respondem dizendo o que houve, sem reenviar nada;
   · é rota de admin (a regra central de /robo/), nas três empresas (com o prefixo de cada uma). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');
const { ehRotaCentralAdmin } = require('../lib/http/rotas-protegidas');

const nada = async () => ({});
function modulo(prefixo, notas, reenvios) {
  return criarModuloFiscal({ id: 'teste', nome: 'Teste', prefixo, rotulo: 'TESTE', crons: {},
    pecas: { rotinaExpediente: nada, rotinaVirada: nada, rotinaManha: nada, corrigirNFsPendentes: nada, retryNFManual: nada, getEstadoRetrySEFAZ: () => ({}),
      garantirToken: async () => 't', gerarTokenInicial: nada, gerarTokenInicialNF: nada, garantirTokenNF: async () => 'tnf',
      garantirTokenML: async () => 'tml', trocarCodigoPorToken: nada, gerarUrlAutorizacao: () => 'http://x', getPedidoDetalhe: nada, rotinaNFeML: nada, enviarNFeUnica: nada,
      getNFDetalhe: async (tok, idNF) => { const n = notas[idNF]; if (!n) return null; return { numero: n.numero, situacao: n.fila.length > 1 ? n.fila.shift() : n.fila[0] }; },
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
    /* nota em "Consultar situação" que o reenvio destrava */
    let reenvios = [];
    let m = modulo('', { '27382395982': { numero: '130428', fila: [10, 5] } }, reenvios);
    let r = await chamar(m, '/robo/nf-reenvio-teste?id=27382395982');
    assert.ok(r.tratou && r.st === 200 && r.j.ok === true && r.j.situacao_antes === 10 && r.j.situacao_depois === 5 && r.j.destravou === true && r.j.reenvio.http === 200 && /resposta do Bling/.test(r.j.reenvio.resposta) && r.j.nota.numero === '130428' && /cron no servidor/.test(r.j.leia), JSON.stringify(r.j));
    assert.deepStrictEqual(reenvios, ['27382395982'], 'reenvia UMA vez');
    /* continua em "Consultar situação": diz que não destravou */
    reenvios = []; m = modulo('/amb', { '5555555': { numero: '9', fila: [10, 10] } }, reenvios);
    r = await chamar(m, '/amb/robo/nf-reenvio-teste?id=5555555');
    assert.ok(r.j.ok === true && r.j.destravou === false && r.j.situacao_depois === 10 && /não destravou/.test(r.j.leia) && reenvios.length === 1, JSON.stringify(r.j));
    /* virou outra coisa (ex.: rejeitada): mostra a situação e pede o resultado inteiro */
    reenvios = []; m = modulo('/good', { '7777777': { numero: '1', fila: [10, 4] } }, reenvios);
    r = await chamar(m, '/good/robo/nf-reenvio-teste?id=7777777');
    assert.ok(r.j.destravou === false && r.j.situacao_depois === 4 && /situação mudou para 4/.test(r.j.leia));
    /* nota que NÃO está em "Consultar situação": não reenvia */
    for (const sit of [5, 4, 1, 2]) {
      reenvios = []; m = modulo('', { '8888888': { numero: '2', fila: [sit] } }, reenvios);
      r = await chamar(m, '/robo/nf-reenvio-teste?id=8888888');
      assert.ok(r.j.ok === false && r.j.situacao_antes === sit && reenvios.length === 0, 'nota na situação ' + sit + ' não pode ser reenviada pelo teste: ' + JSON.stringify(r.j));
    }
    reenvios = []; m = modulo('', {}, reenvios);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=abc'); assert.ok(r.st === 400 && reenvios.length === 0);
    r = await chamar(m, '/robo/nf-reenvio-teste'); assert.strictEqual(r.st, 400);
    r = await chamar(m, '/robo/nf-reenvio-teste?id=1234567'); assert.ok(r.st === 404 && reenvios.length === 0);
  } finally { global.setTimeout = tAntes; }
  /* é rota de admin, com o prefixo de cada empresa; e as três entregam as duas peças */
  for (const p of ['/robo/nf-reenvio-teste', '/amb/robo/nf-reenvio-teste', '/good/robo/nf-reenvio-teste']) assert.ok(ehRotaCentralAdmin(p), p + ' tem que exigir a chave de admin');
  for (const emp of ['girassol', 'ambtotal', 'good']) {
    const s = fs.readFileSync(path.join(__dirname, '..', emp, 'index.js'), 'utf8');
    assert.ok(/enviarNFCru: require\('\.\/nfBlingApi'\)\.enviarNFCru,/.test(s) && /getNFDetalhe: require\('\.\/nfBlingApi'\)\.getNFDetalhe,/.test(s), emp + ': não entrega enviarNFCru/getNFDetalhe ao módulo fiscal');
    assert.strictEqual(typeof require('../' + emp + '/nfBlingApi').enviarNFCru, 'function', emp + ': a fachada não exporta enviarNFCru');
  }
  console.log('ok — teste do reenvio pela API: só nota em "Consultar situação", uma vez, com a resposta do Bling e a situação antes/depois — nas três empresas, só admin');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
