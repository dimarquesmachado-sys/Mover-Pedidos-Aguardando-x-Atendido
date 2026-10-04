/* 04/10 — A FÁBRICA ESTAVA RESPONDENDO NO LUGAR DE ROTAS PRÓPRIAS DA EMPRESA.

   Achado medindo o painel da GOOD: `/tiktok-custo-devolucoes` e `/magalu-cancelados` devolviam
   "esta empresa ainda não expõe `responderCusto` ao painel" — e eu quase escrevi a peça que
   faltava. Só que a GOOD TEM essas rotas, logo abaixo, FUNCIONANDO.

   A causa era ORDEM, não falta de peça: a fábrica é montada na linha ~867 e consultada ANTES das
   rotas próprias (~1059 e ~1076). Quem tem rota própria precisa declará-la em `rotasProprias`,
   senão a versão compartilhada — mais nova e menos rodada — vence.

   ⚠️ POR QUE ISSO É UMA CLASSE, NÃO UM CASO: toda vez que uma empresa ganha uma rota própria
   depois de já usar a fábrica, o mesmo erro reaparece — e o sintoma ("ainda não expõe") APONTA
   PRO LADO ERRADO, sugerindo peça faltando quando o problema é precedência. Já me custou um PR
   inteiro de peça desnecessária.

   Este teste varre as TRÊS empresas e exige: rota que a empresa tem E a fábrica também trata,
   declarada DEPOIS da montagem, precisa estar em `rotasProprias`.

   Marcador estável [ROTA-ROUBADA]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');

const EMPRESAS = [
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline'],
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
];

const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
const mlf = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-painel-ml.js'), 'utf8');
/* Codex #616: captura o sufixo COMPLETO, com barras e pontos (`/js/plano-compra.js`) — as 6 rotas
   aninhadas da fábrica ficavam fora da checagem. */
const tratadas = new Set([...(fab + mlf).matchAll(/p === \(PREFIXO \+ '(\/[\w.\/-]+)'\)/g)].map((m) => m[1]));
assert.ok(tratadas.size > 10, '[ROTA-ROUBADA] não consegui ler as rotas da fábrica — teste virou decorativo');

let conferidas = 0;

for (const [emp, arq, prefixo] of EMPRESAS) {
  const src = fs.readFileSync(path.join(raiz, arq), 'utf8');

  const iMonta = src.indexOf('criarRotasPainel');
  if (iMonta < 0) continue;                 /* empresa que ainda não usa a fábrica */
  conferidas++;

  const m = src.match(/rotasProprias:\s*\[([^\]]*)\]/);
  assert.ok(m, '[ROTA-ROUBADA] ' + emp + ' monta a fábrica SEM declarar rotasProprias');
  const declaradas = new Set([...m[1].matchAll(/'([\w.\/-]+)'/g)].map((x) => '/' + x[1]));

  for (const rota of tratadas) {
    /* ⚠️ Codex #616: `indexOf` pega a PRIMEIRA ocorrência, que costuma ser a lista da guarda de
       sessão (linha ~783 na GOOD) — e aí o teste concluía "está antes da montagem" e PULAVA a
       rota, sem procurar o handler de verdade lá embaixo. `/custo-historico` e `/custos-manuais`
       provam: aparecem na 783 e têm handler nas 2059 e 2319.
       É o mesmo furo que este teste existe pra impedir, dentro do próprio teste. Agora procuro a
       ocorrência que é HANDLER: precedida de `if (method` na mesma instrução. */
    const ocorrencias = [...src.matchAll(new RegExp("'" + prefixo.replace(/\//g, '\\/') + rota.replace(/[.\/]/g, '\\$&') + "'", 'g'))]
      .map((m) => m.index);
    /* ⚠️ e o handler nem sempre tem `method`: a GOOD declara `if (p === '/…/custo-historico')`
       direto. O que identifica um handler é a comparação do caminho dentro de um `if`, com ou
       sem método — foi por supor a forma com `method` que meu conserto anterior não pegou nada. */
    const iPropria = ocorrencias.find((i) => {
      const antes = src.slice(Math.max(0, i - 160), i);
      return /if \(\s*(\(?method[^\n]*)?p ===\s*$|if \([^\n]*p ===\s*$/.test(antes);
    });
    if (iPropria == null) continue;         /* a empresa não tem HANDLER próprio pra este caminho */

    /* ⚠️ o que importa é a ORDEM: se a rota própria vem DEPOIS da montagem, a fábrica responde
       primeiro e vence — a menos que esteja declarada. */
    if (iPropria < iMonta) continue;

    assert.ok(declaradas.has(rota),
      '[ROTA-ROUBADA] ' + emp + ': a rota ' + rota + ' existe na empresa (linha ' +
      (src.slice(0, iPropria).split('\n').length) + ') mas está DEPOIS da montagem da fábrica e ' +
      'NÃO está em rotasProprias — a fábrica responde no lugar dela. O sintoma é "esta empresa ' +
      'ainda não expõe …", que aponta pro lado errado: parece peça faltando e é precedência.');
  }
}

assert.ok(conferidas > 0,
  '[ROTA-ROUBADA] nenhuma empresa monta a fábrica — o teste não conferiu nada');

console.log('OK: nenhuma rota propria das ' + conferidas + ' empresas e respondida pela fabrica');
