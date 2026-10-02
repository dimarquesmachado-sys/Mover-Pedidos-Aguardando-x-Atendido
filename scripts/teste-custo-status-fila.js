/* 02/10 — O STATUS DO CUSTO-SYNC TEM QUE DIZER QUE ESTÁ NA FILA.

   O dono rodou o custo-sync e recebeu `{"progresso":"0/0","inicio":null}`. Leu como "não fez
   nada" — e eu também, nas primeiras vezes. Era "estou esperando a trava, que a Girassol está
   segurando". Gastamos várias idas e vindas nisso, e a informação existia dentro do
   `custoSyncTravado` o tempo todo: só não chegava na tela.

   Status que esconde o motivo é tão ruim quanto status errado — os dois levam a decidir errado,
   e aqui levaram a procurar bug onde não havia. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const good = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');

/* a espera é REGISTRADA quando a trava recusa */
assert.ok(/_cst\.esperando_trava = \{ por: _t\.ocupadoPor/.test(good),
  'o sync voltou a desistir em silêncio — o status mostraria 0/0 e o dono leria "não fez nada"');

/* Codex #566 (P2): SÓ MARCA QUANDO VAI VOLTAR. Sem retry o pedido morre ali, e deixar "na fila"
   gravado faria o status prometer um retry que não existe — o mesmo erro deste PR do avesso. */
assert.ok(/if \(retentar\) \{[\s\S]{0,260}\} else \{[\s\S]{0,160}pedido avulso descartado/.test(good),
  'pedido SEM retry deixou de ser descartado só com log');
/* Codex #566 (r3): e quem NÃO retenta não apaga a marca de outro retry ainda pendente */
assert.ok(!/\} else \{\s*delete _cst\.esperando_trava/.test(good),
  'pedido SEM retry apaga a marca de espera de outro retry pendente');
assert.ok(/vai_retentar: true/.test(good), 'a marca não diz que vai retentar');

/* e é LIMPA quando ele entra, senão a tela diria "na fila" com a rodada em pé */
assert.ok(/delete _cst\.esperando_trava;/.test(good),
  'a marca de fila não é limpa ao entrar — o status mentiria durante a rodada');

/* a rota de status devolve a espera e uma frase legível */
assert.ok(/esperando_trava: _cst\.esperando_trava \|\| null/.test(good),
  'a rota de status parou de devolver o motivo da espera');
assert.ok(/'nunca rodou neste processo'/.test(good) && /'última rodada terminou'/.test(good),
  'sumiu a frase que explica o estado — o dono não lê JSON pra adivinhar');

/* Codex #566 (r2/r4): o retry pendente é rastreado À PARTE da trava, com o prazo REAL (3 min ou 1h) —
   vale também depois de rodada que terminou com SKU sobrando, e não promete intervalo fixo */
assert.ok(/_custoRetryEm = Date\.now\(\) \+ _ms/.test(good) && /_custoRetryEm = 0;/.test(good),
  'o prazo real do retry não é guardado/zerado');
assert.ok(/retry_pendente: custoRetryPendente\(\)/.test(good) && /const _r = custoRetryPendente\(\);/.test(good),
  'o status não lê o retry pendente');
assert.ok(!/a cada 3 min/.test(good.split('\n').filter(l => /leia|na fila:/.test(l)).join('\n')),
  'voltou o "a cada 3 min" fixo na frase do status');

console.log('OK: status do custo-sync diz quando esta NA FILA, com o prazo real do retry, e pedido avulso nao apaga estado alheio');
