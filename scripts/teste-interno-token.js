'use strict';
/* Teste da rota interna de leitura de token (passo 2 do contrato) — exercita a
   responder() de produção com fábricas injetadas. Matriz: sem env ⇒ desligada;
   chave errada ⇒ 401; alias e canônico ⇒ MESMA resposta; empresa sem a integração
   ⇒ 404 (decisão do Devoluções); integração desconhecida ⇒ 400; não exposta ⇒ 501;
   falha do manager ⇒ 502 sem vazar stack; sucesso ⇒ versao acompanha o token.
   Rodar: node scripts/teste-interno-token.js */
const assert = require('assert');
const it = require('../interno-token');
const { responder, _trocarFabricasParaTeste } = it._interno;

let tokenAtual = 'tk-A';
_trocarFabricasParaTeste({
  ambtotal: { ml: async () => tokenAtual, bling: async () => 'tb-1', bling_nfe: async () => { throw new Error('nfe caiu'); } },
  good: { ml: async () => 'tk-good', bling: async () => 'tb-good', bling_nfe: async () => 'tn-good' },
  girassol: { ml: async () => 'tk-gira', bling: async () => 'tb-gira', bling_nfe: async () => 'tn-gira' },
});

(async () => {
  delete process.env.TOKEN_LEITURA_KEY;
  let r = await responder('/interno/token/amb/ml', 'qualquer');
  assert.strictEqual(r.status, 503, 'sem env a rota nasce DESLIGADA');

  process.env.TOKEN_LEITURA_KEY = 'chave-de-leitura';
  r = await responder('/interno/token/amb/ml', 'errada');
  assert.strictEqual(r.status, 401);

  const rAlias = await responder('/interno/token/amb/ml', 'chave-de-leitura');
  const rCanon = await responder('/interno/token/ambtotal/ml', 'chave-de-leitura');
  assert.strictEqual(rAlias.status, 200);
  assert.strictEqual(rAlias.corpo.empresa, 'ambtotal', 'alias normaliza pro canônico');
  assert.strictEqual(rAlias.corpo.access, rCanon.corpo.access, 'alias e canônico: MESMA resposta');
  assert.strictEqual(rAlias.corpo.versao.length, 10);
  assert.strictEqual(rAlias.corpo.expira_em, null, 'expira_em honesto: managers não expõem o instante ainda');

  const v1 = rAlias.corpo.versao;
  tokenAtual = 'tk-B';
  const r2 = await responder('/interno/token/amb/ml', 'chave-de-leitura');
  assert.notStrictEqual(r2.corpo.versao, v1, 'versao acompanha o token');

  r = await responder('/interno/token/good/tiktok', 'chave-de-leitura');
  assert.strictEqual(r.status, 404, 'GOOD não tem TikTok ⇒ 404, nunca access null');

  r = await responder('/interno/token/good/xpto', 'chave-de-leitura');
  assert.strictEqual(r.status, 400, 'integração desconhecida ⇒ 400 com a lista');
  assert.ok(Array.isArray(r.corpo.conhecidas));

  r = await responder('/interno/token/girassol/tiktok', 'chave-de-leitura');
  assert.strictEqual(r.status, 501, 'tiktok existe no contrato mas ainda não é exposta ⇒ 501 declarado');

  r = await responder('/interno/token/amb/bling_nfe', 'chave-de-leitura');
  assert.strictEqual(r.status, 502, 'falha do manager ⇒ 502');
  assert.ok(!JSON.stringify(r.corpo).includes('at '), 'sem stack vazando');

  r = await responder('/interno/token/good/bling_nfe', 'chave-de-leitura');
  assert.strictEqual(r.status, 200, 'bling_nfe exposta desde o dia 1, como o Devoluções pediu');

  r = await responder('/interno/token/naoexiste/ml', 'chave-de-leitura');
  assert.strictEqual(r.status, 404, 'empresa fora do contrato ⇒ 404');

  // r1: aquisições CONCORRENTES da mesma (empresa, integração) = UMA execução da fábrica
  let execs = 0;
  it._interno._trocarFabricasParaTeste({
    girassol: { ml: async () => { execs++; await new Promise(r => setTimeout(r, 60)); return 'tk-serial'; } },
  });
  const [c1, c2] = await Promise.all([
    responder('/interno/token/girassol/ml', 'chave-de-leitura'),
    responder('/interno/token/girassol/ml', 'chave-de-leitura'),
  ]);
  assert.strictEqual(execs, 1, 'duas leituras concorrentes ⇒ UMA aquisição (a corrida que a rota existe pra matar)');
  assert.ok(c1.corpo.access === 'tk-serial' && c2.corpo.access === 'tk-serial');

  // r1: fábrica pendurada não pendura a resposta — o prazo da rota devolve 502 declarado
  it._interno._trocarFabricasParaTeste({
    girassol: { bling: () => new Promise(() => {}) },
  });
  const antes = Date.now();
  const rP = await responder('/interno/token/girassol/bling', 'chave-de-leitura', 150);
  assert.strictEqual(rP.status, 502);
  assert.ok(/prazo/.test(rP.corpo.erro), 'erro nomeia o prazo: ' + rP.corpo.erro);
  assert.ok(Date.now() - antes < 5000, 'respondeu pelo prazo curto do teste, não pendurou');

  console.log('OK: rota de leitura — matriz completa + aquisição única concorrente + prazo que não pendura');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
