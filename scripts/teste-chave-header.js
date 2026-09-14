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
   migração ficaria pela metade sem ninguém notar */
const alvos = ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js'];
for (const arq of alvos) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const cruas = s.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(l => /const \w+ = \(?urlObj\.searchParams/.test(l) && /get\('k'\)/.test(l));
  assert.deepStrictEqual(cruas, [], arq + ': ainda lê a chave direto da query (não aceitaria header): ' + cruas.join(' | '));
  assert.ok(/lerChaveAdmin/.test(s), arq + ': precisa usar o helper');
}

console.log('OK: chave de admin — header ganha da query, URL antiga segue valendo, e nenhuma rota dos checkouts lê a query direto');
