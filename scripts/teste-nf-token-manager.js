'use strict';
/* Passo 2.6 (13/09): o token do app fiscal do Bling virou peça única das três. O risco aqui
   não é lógica — as 39 linhas que diferiam eram rótulo e nome de env. O risco é ESTADO:
     • o arquivo de token de cada empresa tem que continuar EXATAMENTE onde está. A Girassol
       guarda em <módulo>/data/nf_tokens.json (relativo ao código) e as outras em
       /data/<empresa>/. Trocar isso na refatoração faz a empresa perder o token e pedir nova
       autorização no Bling no meio do expediente — e ninguém liga o sintoma à refatoração.
     • credenciais e rótulo seguem por empresa, senão uma autentica com o app da outra. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarNfTokenManager } = require('../lib/fiscal/nf-token-manager');

assert.throws(() => criarNfTokenManager({}), /falta rotulo/);
assert.throws(() => criarNfTokenManager({ rotulo: 'X' }), /falta /);

const api = criarNfTokenManager({
  rotulo: 'X', envTokenFile: 'X_NF_TOKEN_FILE', arquivoToken: '/tmp/x-nf.json',
  envId: 'X_ID', envSecret: 'X_SEC', envRedirect: 'X_URI',
});
assert.deepStrictEqual(Object.keys(api).sort(), ['garantirTokenNF', 'gerarTokenInicialNF', 'renovarTokenNF']);

const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p, 'nfTokenManager.js'), 'utf8');
const amb = fonte('ambtotal'), good = fonte('good'), gir = fonte('girassol');

/* o caminho de CADA uma, como estava antes da extração */
assert.ok(/arquivoToken: '\/data\/ambtotal\/nf-tokens\.json'/.test(amb), 'AMB tem que manter /data/ambtotal/nf-tokens.json');
assert.ok(/arquivoToken: '\/data\/good\/nf-tokens\.json'/.test(good), 'GOOD tem que manter /data/good/nf-tokens.json');
assert.ok(/__dirname, 'data', 'nf_tokens\.json'/.test(gir),
  'a Girassol guarda o token RELATIVO ao módulo — trocar por caminho absoluto faz ela perder o token e pedir nova autorização no Bling');

/* credencial e rótulo por empresa */
for (const campo of ['envId', 'envSecret', 'rotulo']) {
  const vals = [amb, good, gir].map(s => (new RegExp(campo + ": '([^']+)'").exec(s) || [])[1]);
  assert.ok(vals.every(Boolean), 'toda fachada declara ' + campo + ': ' + vals.join(', '));
  assert.strictEqual(new Set(vals).size, 3, campo + ' tem que ser diferente nas três: ' + vals.join(', '));
}

/* nenhuma mensagem com empresa fixa no texto — a lição do #411, que aponta pro CNPJ errado */
const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'nf-token-manager.js'), 'utf8');
const presos = lib.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .filter(l => /throw new Error|console\.(log|warn|error)/.test(l))
  .filter(l => /\b(AMB|AMBTOTAL|GOOD|GIMPO|GIRASSOL|MAGAZINEGIRASSOL)\b/.test(l));
assert.deepStrictEqual(presos, [], 'mensagem com empresa fixa no texto: ' + presos.join(' | '));

/* a rota de setup também é por empresa: a mensagem de refresh ausente manda o operador
   configurar — mandar a Girassol pra /amb/setup-nf seria configurar a empresa errada.
   As três rotas foram conferidas contra os index.js. */
{
  const rotas = [amb, good, gir].map(s => (/rotaSetup: '([^']+)'/.exec(s) || [])[1]);
  assert.ok(rotas.every(Boolean), 'toda fachada declara rotaSetup: ' + rotas.join(', '));
  assert.strictEqual(new Set(rotas).size, 3, 'as rotas de setup têm que ser distintas: ' + rotas.join(', '));
}

console.log('OK: token fiscal — caminho do arquivo preservado em cada empresa (inclusive o relativo da Girassol), credenciais e rótulo separados, e nenhuma mensagem com empresa fixa');
