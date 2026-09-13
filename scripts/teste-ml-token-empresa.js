'use strict';
/* Passo 2.3 do plano multiloja (13/09): o token do ML virou código único. Esta peça é a mais
   perigosa de unificar, porque token trocado entre empresas NÃO dá erro — ele fala com a
   conta errada, em silêncio, e o estrago aparece depois como venda alheia no painel.
   Por isso o teste guarda ISOLAMENTO, não mecânica:
     • cada empresa tem o próprio arquivo de token;
     • cada empresa lê as PRÓPRIAS envs de credencial;
     • o estado de renovação em voo é por instância — se fosse compartilhado, uma renovação
       da AMB poderia ser aproveitada como se fosse da Girassol. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarMlTokenManager } = require('../lib/fiscal/ml-token-manager');

assert.throws(() => criarMlTokenManager({}), /falta rotulo/);
assert.throws(() => criarMlTokenManager({ rotulo: 'X' }), /falta /);

const base = (nome) => ({
  rotulo: nome.toUpperCase(), envTokenFile: nome.toUpperCase() + '_ML_TOKEN_FILE',
  arquivoToken: '/tmp/tok-' + nome + '.json', envClientId: nome.toUpperCase() + '_ML_CLIENT_ID',
  envClientSecret: nome.toUpperCase() + '_ML_CLIENT_SECRET', envRedirect: nome.toUpperCase() + '_ML_REDIRECT_URI',
});
const a = criarMlTokenManager(base('umaempresa'));
const b = criarMlTokenManager(base('outraempresa'));
assert.notStrictEqual(a, b, 'cada empresa tem a própria instância');
assert.deepStrictEqual(Object.keys(a).sort(), ['garantirTokenML', 'gerarUrlAutorizacao', 'renovarTokenML', 'renovarUmaVez', 'trocarCodigoPorToken']);

// credencial ausente tem que FALHAR dizendo o nome da env DAQUELA empresa
delete process.env.UMAEMPRESA_ML_CLIENT_ID;
assert.rejects(() => a.trocarCodigoPorToken('x'), /UMAEMPRESA_ML_CLIENT_ID/, 'o erro tem que nomear a env da própria empresa');

// as três fachadas: arquivo de token e credenciais SEPARADOS (o que impede falar com a conta errada)
const ler = (p) => fs.readFileSync(path.join(__dirname, '..', p, 'mlTokenManager.js'), 'utf8');
const cfg = ['ambtotal', 'good', 'girassol'].map(ler);
const campo = (s, c) => (new RegExp(c + ": '([^']+)'").exec(s) || [])[1];

for (const c of ['arquivoToken', 'envClientId', 'envClientSecret', 'rotulo']) {
  const vals = cfg.map(s => campo(s, c));
  assert.ok(vals.every(Boolean), 'toda fachada precisa declarar ' + c + ': ' + vals.join(', '));
  assert.strictEqual(new Set(vals).size, 3, c + ' tem que ser DIFERENTE nas três empresas (senão uma fala com a conta da outra): ' + vals.join(', '));
}

// e nenhuma fachada pode ter voltado a fazer chamada por conta própria
for (const s of cfg) assert.ok(!/await fetch\(/.test(s), 'fachada com fetch próprio — a regra do refresh de uso único tem que ficar na lib');

console.log('OK: token do ML — deps obrigatórias, erro nomeia a env da própria empresa, e arquivo/credencial/rótulo seguem SEPARADOS nas três');
