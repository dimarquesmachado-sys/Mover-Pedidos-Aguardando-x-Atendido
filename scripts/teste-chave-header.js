'use strict';
/* 14/09 — a chave de admin passa a ser lida do HEADER primeiro (auditoria do Codex, P2).
   O problema não é teórico: ontem o dono viu a própria ADMIN_KEY exposta porque o serviço a
   devolvia no link de acompanhamento. Aquilo foi corrigido, mas a chave continuava VIAJANDO
   na URL — e URL aparece em log de proxy, histórico de navegador, print de tela e em
   qualquer link que alguém cole pedindo ajuda.
   As duas pontas que o teste guarda:
     • header (x-admin-key ou Bearer) tem PRIORIDADE — quem manda header nunca expõe;
     • a query CONTINUA aceita, porque há dezenas de URLs salvas com &k= e cortar de uma vez
       quebraria o trabalho de quem opera pelo navegador. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { lerChaveAdmin, veioPorHeader } = require('../lib/http/chave-admin');

const url = new URL('https://x/rota?k=DAQUERY');

assert.strictEqual(lerChaveAdmin({ headers: {} }, url), 'DAQUERY', 'URL antiga tem que continuar funcionando');
assert.strictEqual(lerChaveAdmin({ headers: { 'x-admin-key': 'DOHEADER' } }, url), 'DOHEADER', 'o header tem que GANHAR da query');
assert.strictEqual(lerChaveAdmin({ headers: { authorization: 'Bearer DOBEARER' } }, url), 'DOBEARER', 'Bearer também vale');
assert.strictEqual(lerChaveAdmin({ headers: {} }, new URL('https://x/rota')), '', 'sem nada, string vazia — nunca undefined');
assert.strictEqual(lerChaveAdmin(null, null), '', 'chamada sem req/url não pode explodir');
assert.strictEqual(lerChaveAdmin({ headers: { 'x-admin-key': '   ' } }, url), 'DAQUERY', 'header em branco não conta como header');

assert.strictEqual(veioPorHeader({ headers: { 'x-admin-key': 'x' } }), true);
assert.strictEqual(veioPorHeader({ headers: {} }), false, 'serve pra medir o uso legado antes de fechar a janela');

/* nenhuma rota pode ter ficado lendo a query DIRETO — senão ela nunca aceitaria header, e a
   migração ficaria pela metade sem ninguém notar. O regex antigo só pegava
   `const k = urlObj.searchParams...` no começo da linha — passava reto por leituras
   envolvidas em String(...) ou parênteses extras (Codex, P2: 3 rotas escaparam assim).
   14/09 (3ª rodada): ampliado pra `.get('k')` puro (sem exigir `searchParams.` colado antes),
   porque magalu-oauth/tiktok-oauth/tiktok-ads leem por um alias `q = urlObj.searchParams` —
   e o tiktok-ads tinha o MESMO furo (admOk() comparava direto com q.get('k')). */
const alvos = [
  'index.js',
  'amb-checkout-offline/index.js',
  'girassol-backup-offline/gbo-app.js',
  'good-checkout-offline/index.js',
  'lib/checkout/rota-depara-sku.js',
  'tiktok-ads/index.js',
];
for (const arq of alvos) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const cruas = s.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(l => /\.get\('k'\)/.test(l));
  assert.deepStrictEqual(cruas, [], arq + ': ainda lê a chave direto da query (não aceitaria header): ' + cruas.join(' | '));
  assert.ok(/lerChaveAdmin/.test(s), arq + ': precisa usar o helper');
}

/* magalu-oauth e tiktok-oauth ecoam ?k= em links de "voltar pro painel" DEPOIS do gate (a
   query segue valendo como compat, então a URL construída é legítima) — não dá pra banir
   todo '.get('k')' sem falso-positivo aqui, mas o GATE em si precisa usar o helper. */
for (const arq of ['magalu-oauth/index.js', 'tiktok-oauth/index.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  assert.ok(/lerChaveAdmin/.test(s), arq + ': precisa usar o helper no gate de admin');
}

console.log('OK: chave de admin — header ganha da query, URL antiga segue valendo, e nenhuma rota dos checkouts/orquestrador lê a query direto');
