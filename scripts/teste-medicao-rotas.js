'use strict';
/* 17/09 — a MEDIÇÃO das rotas estava inflada, e o erro tinha risco junto. A regex casava com
   qualquer menção a `p === '/<empresa>/<rota>'`, e a GOOD tem uma lista de EXCEÇÕES do portão
   de sessão que cita várias rotas por nome. A `/backfill-status`, de 6 linhas, aparecia com 25
   de diferença porque eu capturava aquele bloco — e extrair "aquilo" teria movido a trava
   central de autenticação junto.

   O número de divergentes caiu de 21 para 6 quando a medição passou a contar DECLARAÇÃO em vez
   de menção. Este teste guarda essa distinção: sem ela, o próximo a medir repete o número
   inflado e o risco. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ALVOS = [
  ['amb-checkout-offline/index.js', 'amb-checkout-offline'],
  ['girassol-backup-offline/gbo-app.js', 'girassol-backup-offline'],
  ['good-checkout-offline/index.js', 'good-checkout-offline'],
];

/* declaração = `if (… p === … ) {` abrindo bloco no fim da linha.
   menção em lista de exceções termina com `||` e não abre bloco. */
function declaradas(arq, mod) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const out = new Set();
  const re = new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('([\w-]+)'\)|'/` + mod + String.raw`/([\w-]+)')[^\n]*\{ *$`, 'gm');
  let m;
  while ((m = re.exec(s))) out.add(m[1] || m[2]);
  return out;
}

/* a lista de exceções da GOOD é o que enganava a medição — se ela mudar de forma, a medição
   precisa ser revista junto, e é por isso que o teste a vigia */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');
  assert.ok(/p === '\/good-checkout-offline\/[\w-]+' \|\|/.test(s),
    'a lista de exceções do portão sumiu ou mudou de forma — revisar a medição de rotas junto');
}

/* a rota que o erro produzia tem que aparecer como DECLARAÇÃO nas três */
for (const [arq, mod] of ALVOS) {
  const d = declaradas(arq, mod);
  assert.ok(d.has('backfill-status'),
    arq + ': /backfill-status não aparece como declaração — se a medição só a vê na lista de ' +
    'exceções, ela conta a trava de sessão como se fosse o corpo da rota');
  assert.ok(d.size >= 20, arq + ': só ' + d.size + ' rotas declaradas — a regex de medição provavelmente quebrou');
}

/* as três declaram praticamente o mesmo conjunto: divergência grande aqui é sinal de medição
   quebrada, não de rota sumindo */
const conjuntos = ALVOS.map(([arq, mod]) => declaradas(arq, mod));
const comuns = [...conjuntos[0]].filter(r => conjuntos[1].has(r) && conjuntos[2].has(r));
assert.ok(comuns.length >= 20,
  'só ' + comuns.length + ' rotas comuns às três — eram 24; ou rotas sumiram, ou a medição quebrou');

console.log('OK: medição de rotas — conta declaração e não menção, e a lista de exceções da GOOD não é confundida com corpo de rota');
