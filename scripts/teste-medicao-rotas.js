'use strict';
/* 17/09 — a MEDIÇÃO das rotas estava inflada, e o erro tinha risco junto. A regex casava com
   qualquer menção a `p === '/<empresa>/<rota>'`, e a GOOD tem uma lista de EXCEÇÕES do portão
   de sessão que cita várias rotas por nome. A `/backfill-status`, de 6 linhas, aparecia com 25
   de diferença porque eu capturava aquele bloco — e extrair "aquilo" teria movido a trava
   central de autenticação junto.

   O número de divergentes caiu de 21 para 6 quando a medição passou a contar DECLARAÇÃO em vez
   de menção. Este teste guarda essa distinção extraindo o CORPO de verdade (não só o nome da
   rota) e travando as rotas pesadas — que não entram nesta fase de extração e por isso não
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

/* as rotas pesadas ficam de fora desta fase (viram o próximo ciclo.js) — diferente das
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
  /* o teto separa o corpo da rota (~6-13 linhas) do bloco de exceções (24+). Subiu de 10 pra
     15 em 17/09 porque a própria rota cresceu — ganhou a checagem de sessão e o comentário
     que a explica. O que o teto precisa distinguir continua valendo com folga. */
  assert.ok(corpo.length <= 15,
    'corpo de /backfill-status tem ' + corpo.length + ' linhas — a medição provavelmente pegou a lista de exceções do portão, não a rota');

  /* 17/09 — o tamanho pega o caso de hoje; o CONTEÚDO pega a classe. Um dia a lista de
     exceções pode encolher pra menos de 10 linhas e o teste passaria com o bloco errado.
     O que nunca pode acontecer é o corpo medido conter a trava de sessão. */
  const texto = corpo.join('\n');
  assert.ok(!/Sessão necessária\. Faça login\./.test(texto),
    'o corpo medido contém a TRAVA DE SESSÃO — extrair isso moveria a autenticação do módulo ' +
    'inteiro achando que era uma rota de status');
  assert.ok(!/shopee-sessao-cookies/.test(texto),
    'o corpo medido contém outras rotas — é a lista de exceções, não a declaração');
  /* 17/09 — a marca era `__bfGood`, a variável GLOBAL onde a GOOD guardava o status do
     backfill. Ela saiu (estado de empresa não mora em global — as três rodam no mesmo
     processo e a empresa nova copiaria o nome junto), então a marca passou a ser `_bfGood`,
     o estado do módulo que a substituiu. O que o teste prova continua o mesmo: que o corpo
     medido é o da ROTA e não o da lista de exceções do portão. */
  assert.ok(corpo.some((l) => l.includes('_bfGood')),
    'o corpo medido não cita o status do backfill — provavelmente não é o corpo da rota');
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

/* 17/09 — POR QUE ESTE TESTE NÃO GENERALIZA PARA TODAS AS ROTAS.
   Tentei estender a checagem a todas as rotas comuns e ela acusou três casos seguidos que
   eram LEGÍTIMOS: a /produto-fotos valida sessão dentro dela mesma (com a mesma mensagem), e
   a /ml-trocar-code cita outra rota no próprio corpo. O extrator por indentação é heurístico —
   ele não sabe onde a rota termina quando há blocos aninhados na mesma coluna.
   Um guarda que acusa o certo é pior que guarda nenhum: ensina a ignorar o vermelho. Então
   ele fica no caso PROVADO (a /backfill-status da GOOD, onde o mesmo nome aparece na lista de
   exceções e na declaração), que é exatamente a regressão que aconteceu. */

/* 17/09 — A MEDIÇÃO CAIU DE SEIS PRA TRÊS, e pelo mesmo tipo de erro da vez anterior: o
   script solto que eu usava delimitava o corpo por INDENTAÇÃO. Onde a rota tem bloco aninhado
   fechando na mesma coluna, ele engolia o que vinha depois — na GOOD, a /status (20 linhas)
   aparecia com 59 de diferença porque levava junto a /saude inteira, que as três têm.
   Este teste já conta CHAVES (conserto do Codex), e é por isso que ele não errou junto. O
   assert abaixo mantém a diferença medida honesta: se a /status voltar a "divergir", é o
   medidor que quebrou, não o código. */
{
  const semRotulo = (t) => t.replace(/\b(GIRABKP|GOODBKP|AMBBKP)\b/g, '_T_')
    .replace(/\b(girassol-backup-offline|good-checkout-offline|amb-checkout-offline)\b/g, '_M_')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));

  const ref = semRotulo(corpoDaRota(ALVOS[0][0], ALVOS[0][1], 'status').join('\n'));
  for (let i = 1; i < ALVOS.length; i++) {
    const outro = semRotulo(corpoDaRota(ALVOS[i][0], ALVOS[i][1], 'status').join('\n'));
    assert.ok(Math.abs(outro.length - ref.length) <= 4,
      ALVOS[i][0] + ': a /status mede ' + outro.length + ' linhas contra ' + ref.length +
      ' na AMB — ou ela divergiu de verdade, ou o medidor voltou a engolir a rota seguinte');
  }
}

console.log('OK: medição de rotas — conta declaração e não menção, delimita o corpo por CHAVES (não por indentação) e trava as rotas pesadas que não saem desta fase');
