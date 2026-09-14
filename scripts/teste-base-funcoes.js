'use strict';
/* 14/09 — passo 2 da Fase 3: as funções do `base.js` viram lib. O arquivo misturava duas
   naturezas opostas — a CONFIGURAÇÃO da empresa (envs, situações do Bling, janelas, pausas,
   que é o que a torna ela mesma) e 91 linhas de função iguais nas três, com exatamente DUAS
   envs diferentes: operadores e admins.
   O teste guarda o que a extração arrisca:
     • os 20 nomes continuam exportados nas três (a primeira tentativa levou as funções e
       deixou os CACHES pra trás — o boot quebrou na hora, que é o desfecho certo);
     • a configuração NÃO subiu junto: SIT_*, janelas e pausas seguem no base de cada uma;
     • cada empresa lê as PRÓPRIAS envs de operadores e admin — trocar isso daria a uma
       empresa a lista de quem pode operar na outra. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EMPRESAS = ['amb-checkout-offline', 'girassol-backup-offline', 'good-checkout-offline'];
const NOMES = ['ensureDir', 'readJson', 'writeJson', 'dataISO', 'json', 'html', 'lerReservas',
  'lerOperadores', 'lerAdmins', 'ehAdmin', 'blingGet', 'blingWrite', 'moverSituacao',
  'manifest', 'salvarManifest', 'skuEanCache', 'locCache', 'salvarLoc', 'salvarSkuEan', 'lerIndiceEan'];

const { criar } = require('../lib/checkout/base-funcoes');
assert.throws(() => criar({}), /falta tag/);
assert.throws(() => criar({ tag: 'X' }), /falta /, 'dependência ausente derruba na criação, não na primeira chamada');

for (const emp of EMPRESAS) {
  const m = require('../' + emp + '/base.js');
  for (const n of NOMES) assert.ok(m[n] !== undefined, emp + ': perdeu ' + n + ' — cache ou função órfã quebra o boot');

  const s = fs.readFileSync(path.join(__dirname, '..', emp, 'base.js'), 'utf8');
  /* a configuração fica: é o que faz a empresa ser ela */
  for (const cfg of ['CACHE_DIR', 'SIT_ATENDIDO', 'JANELA_DIAS', 'PAUSA_MS']) {
    assert.ok(new RegExp('const ' + cfg + '\\s*=').test(s), emp + ': a configuração ' + cfg + ' saiu do base — ela é por empresa');
  }
  assert.ok(/base-funcoes'\)\.criar\(/.test(s), emp + ': o base tem que puxar as funções da lib');
}

/* envs de gente (operadores/admin) por empresa: trocar dá a uma a lista de acesso da outra */
for (const campo of ['envOperadores', 'envAdmin']) {
  const vals = EMPRESAS.map(emp => {
    const s = fs.readFileSync(path.join(__dirname, '..', emp, 'base.js'), 'utf8');
    return (new RegExp(campo + ": '([^']+)'").exec(s) || [])[1];
  });
  assert.ok(vals.every(Boolean), campo + ' tem que ser declarado nas três: ' + vals.join(', '));
  assert.strictEqual(new Set(vals).size, 3, campo + ' precisa ser por empresa — senão uma herda quem opera na outra: ' + vals.join(', '));
}

console.log('OK: base — funções e caches numa lib só, configuração e envs de acesso seguem por empresa');
