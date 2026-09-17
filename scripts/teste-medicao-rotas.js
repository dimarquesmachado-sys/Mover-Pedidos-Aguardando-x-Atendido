'use strict';
/* 17/09 — a MEDIÇÃO das rotas estava inflada, e o erro tinha risco junto. A regex casava com
   qualquer menção a `p === '/<empresa>/<rota>'`, e a GOOD tem uma lista de EXCEÇÕES do portão
   de sessão que cita várias rotas por nome. A `/backfill-status`, de 6 linhas, aparecia com 25
   de diferença porque eu capturava aquele bloco — e extrair "aquilo" teria movido a trava
   central de autenticação junto.

   O número de divergentes caiu de 21 para 6 quando a medição passou a contar DECLARAÇÃO em vez
   de menção. Este teste guarda essa distinção extraindo o CORPO de verdade (não só o nome da
   rota) e travando as seis divergentes — que não entram nesta fase de extração e por isso não
   podem sumir do conjunto comum às três, ao contrário das quase-idênticas (Codex, 17/09). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ALVOS = [
  ['amb-checkout-offline/index.js', 'amb-checkout-offline'],
  ['girassol-backup-offline/gbo-app.js', 'girassol-backup-offline'],
  ['good-checkout-offline/index.js', 'good-checkout-offline'],
];

/* as seis divergentes ficam de fora desta fase (viram o próximo ciclo.js) — diferente das
   quase-idênticas, elas não têm extração planejada, então continuam declaradas nas três */
const DIVERGENTES = ['status', 'config-fiscal', 'sku-info', 'etiqueta-anexar', 'custo-sync', 'backfill-status'];

/* declaração = `if (… p === … ) {` abrindo bloco no fim da linha.
   menção em lista de exceções termina com `||` e não abre bloco. */
function reDeclaracao(mod, rota) {
  return new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('${rota}'\)|'/${mod}/${rota}')[^\n]*\{ *$`, 'm');
}

function declaradas(arq, mod) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const out = new Set();
  const re = new RegExp(String.raw`^ *if \([^\n]*p === (?:R\('([\w-]+)'\)|'/` + mod + String.raw`/([\w-]+)')[^\n]*\{ *$`, 'gm');
  let m;
  while ((m = re.exec(s))) out.add(m[1] || m[2]);
  return out;
}

/* extrai o CORPO da rota a partir da linha de DECLARAÇÃO (nunca da primeira menção), contando
   chaves até fechar no mesmo nível — é exatamente o passo que a medição original pulou */
function corpoDaRota(arq, mod, rota) {
  const linhas = fs.readFileSync(path.join(raiz, arq), 'utf8').split('\n');
  const re = reDeclaracao(mod, rota);
  const inicio = linhas.findIndex((l) => re.test(l));
  assert.ok(inicio >= 0, arq + ': declaração de /' + rota + ' não encontrada');
  let prof = 0;
  let fim = -1;
  for (let i = inicio; i < linhas.length && fim < 0; i++) {
    for (const ch of linhas[i]) {
      if (ch === '{') prof++;
      else if (ch === '}') { prof--; if (prof === 0) { fim = i; break; } }
    }
  }
  assert.ok(fim >= 0, arq + ': corpo de /' + rota + ' nunca fecha');
  return linhas.slice(inicio, fim + 1);
}

/* a lista de exceções da GOOD é o que enganava a medição — se ela mudar de forma, a medição
   precisa ser revista junto, e é por isso que o teste a vigia */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');
  assert.ok(/p === '\/good-checkout-offline\/[\w-]+' \|\|/.test(s),
    'a lista de exceções do portão sumiu ou mudou de forma — revisar a medição de rotas junto');
}

/* o corpo real de /backfill-status tem 6 linhas; a medição errada pegava a lista de exceções
   (25 de diferença). Corpo curto e com o sinal do handler real prova que a extração achou o
   bloco certo, não a lista */
{
  const corpo = corpoDaRota('good-checkout-offline/index.js', 'good-checkout-offline', 'backfill-status');
  assert.ok(corpo.length <= 10,
    'corpo de /backfill-status tem ' + corpo.length + ' linhas — a medição provavelmente pegou a lista de exceções do portão, não a rota');
  assert.ok(corpo.some((l) => l.includes('__bfGood')),
    'corpo de /backfill-status não bate com o handler real — a extração pegou o bloco errado');
}

/* as divergentes não entram nesta fase — se sumirem da declaração de alguma das três, ou a
   rota foi perdida ou a medição quebrou. Ao contrário de um piso fixo sobre o total de rotas
   comuns, isto sobrevive à extração planejada das quase-idênticas sem falhar o CI. */
const conjuntos = ALVOS.map(([arq, mod]) => declaradas(arq, mod));
for (const rota of DIVERGENTES) {
  ALVOS.forEach(([arq], i) => {
    assert.ok(conjuntos[i].has(rota),
      arq + ': /' + rota + ' não aparece mais como declaração — rota sumiu ou a medição quebrou');
  });
}

for (let i = 0; i < ALVOS.length; i++) {
  assert.ok(conjuntos[i].size >= 20,
    ALVOS[i][0] + ': só ' + conjuntos[i].size + ' rotas declaradas — a regex de medição provavelmente quebrou');
}

console.log('OK: medição de rotas — conta declaração e não menção, extrai o corpo de verdade e trava as seis divergentes que não saem desta fase');
