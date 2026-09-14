'use strict';
/* 14/09 — Fase 3, passo 3: o histórico vira código único. Não é só desduplicação: a GOOD não
   tem histórico nenhum, e é por isso que ela não tem dashboard — a peça que falta lá é
   exatamente esta. Medida sem comentários, a diferença real entre as duas cópias era de 17 e
   39 linhas, e as 39 eram a parametrização que a Girassol já tinha feito em 25/08 depois de
   um bug: outra empresa lia o cache, o admin e o cliente Bling DA GIRASSOL.
   Por isso o teste guarda, acima de tudo, o ISOLAMENTO:
     • a lib NÃO pode ter fallback pra módulo local — um `|| base.X` faria toda empresa
       herdar os dados da Girassol em silêncio, que foi o bug de agosto;
     • falta no ctx derruba na hora, com o nome do que falta;
     • cada empresa declara a própria identidade e os próprios caminhos. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rotasHistorico } = require('../lib/checkout/historico');

/* ctx incompleto falha ALTO, dizendo o que falta */
try {
  rotasHistorico({});
  assert.fail('ctx vazio tinha que derrubar');
} catch (e) {
  assert.ok(/falta \w+ no ctx/.test(e.message), 'o erro tem que nomear o que falta: ' + e.message);
}

/* a lib não pode herdar nada de módulo local */
const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');
const semComentario = lib.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
assert.ok(!/\|\|\s*base\./.test(semComentario),
  'a lib tem fallback pra `base` — assim uma empresa herda os dados da Girassol em silêncio (bug de 25/08)');
assert.ok(!/require\('\.\/(nf|ciclo|base)'\)/.test(semComentario),
  'a lib importa da pasta da empresa — dentro de lib/checkout esse caminho aponta pro lugar errado');

/* Codex #436 (P2): PAUSA_MS não pode ser um ternário que resolve pro MESMO lado nos dois
   ramos — foi exatamente esse copiar-colar (`ctx.PAUSA_MS != null ? ctx.PAUSA_MS : ctx.PAUSA_MS`)
   que fazia sleep(undefined) virar timer de 0ms entre as chamadas do /buscar-pedido ao Bling. */
assert.ok(!/(ctx\.PAUSA_MS)\s*(!=\s*null)?\s*\?\s*\1\s*:\s*\1/.test(semComentario),
  'PAUSA_MS não pode ser um ternário tautológico — mesmo valor nos dois ramos (bug do Codex #436 P2)');
assert.ok(/'PAUSA_MS'/.test(lib),
  'a lib tem que exigir PAUSA_MS no ctx — sem isso o ritmo da API vira 0ms em silêncio');

/* Codex #436 (P1): a coluna credito_ml (bônus de envio Flex) só existe no vendas_historico da
   AMB — a extração pra lib única tinha derrubado essa soma em silêncio pra todo mundo. */
assert.ok(/TEM_CREDITO_ML\s*=\s*EMPRESA === 'amb'/.test(lib),
  'a lib tem que restringir o credito_ml à AMB — Girassol/GOOD não têm essa coluna e levariam 400 do PostgREST');
assert.ok(/TEM_CREDITO_ML \? \(Number\(l\.credito_ml\)/.test(lib),
  'o credito_ml (bônus Flex) tem que voltar a somar na margem da AMB (Codex #436 P1)');

/* cada fachada declara a própria identidade */
const fachadas = [['girassol-backup-offline', 'historico.js', 'girassol'], ['amb-checkout-offline', 'amb-historico.js', 'amb']];
const ids = [];
for (const [pasta, arq, empresa] of fachadas) {
  const s = fs.readFileSync(path.join(__dirname, '..', pasta, arq), 'utf8');
  assert.ok(new RegExp("empresa: '" + empresa + "'").test(s), pasta + ': tem que declarar a própria empresa');
  assert.ok(/CACHE_DIR: base\.CACHE_DIR/.test(s), pasta + ': os caminhos vêm do base DESTA pasta');
  assert.ok(/PAUSA_MS: base\.PAUSA_MS/.test(s), pasta + ': o ritmo da API tem que vir do base DESTA pasta (Codex #436 P2)');
  assert.ok(/pecas: \{ nf: require/.test(s), pasta + ': as peças da empresa entram por injeção');
  ids.push(empresa);
  const m = require('../' + pasta + '/' + arq);
  assert.strictEqual(typeof m.rotasHistorico, 'function', pasta + ': precisa expor rotasHistorico');
}
assert.strictEqual(new Set(ids).size, 2, 'as empresas precisam de identidades distintas: ' + ids.join(', '));

console.log('OK: histórico — uma lib para as empresas, sem fallback que herde dados alheios, e cada fachada com a própria identidade');
