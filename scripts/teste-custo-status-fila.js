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
assert.ok(/vai_retentar: !!retentar/.test(good),
  'o status não diz se vai tentar de novo sozinho — é a diferença entre esperar e agir');

/* e é LIMPA quando ele entra, senão a tela diria "na fila" com a rodada em pé */
assert.ok(/delete _cst\.esperando_trava;/.test(good),
  'a marca de fila não é limpa ao entrar — o status mentiria durante a rodada');

/* a rota de status devolve a espera e uma frase legível */
assert.ok(/esperando_trava: _cst\.esperando_trava \|\| null/.test(good),
  'a rota de status parou de devolver o motivo da espera');
assert.ok(/leia: _cst\.esperando_trava \?/.test(good),
  'sumiu a frase que explica o estado — o dono não lê JSON pra adivinhar');

/* a frase, exercitada nos três estados que importam */
const frase = (_cst) => _cst.esperando_trava
  ? ('na fila: ' + _cst.esperando_trava.por + ' está com a trava há ' + _cst.esperando_trava.ha_min + ' min' + (_cst.esperando_trava.vai_retentar ? ' — tenta de novo sozinho a cada 3 min' : ''))
  : (_cst.rodando ? 'rodando' : (_cst.inicio ? 'última rodada terminou' : 'nunca rodou neste processo'));

assert.ok(/na fila: custo-diario:girassol/.test(frase({ esperando_trava: { por: 'custo-diario:girassol', ha_min: 15, vai_retentar: true } })),
  'a frase da fila não nomeia quem está com a trava — sem isso não dá pra saber se é normal');
assert.strictEqual(frase({ rodando: true }), 'rodando', 'estado "rodando" perdido');
assert.strictEqual(frase({ rodando: false, inicio: null }), 'nunca rodou neste processo',
  'o estado de "nunca rodou" tem que ser dito com todas as letras — foi ele que o dono leu como bug');
assert.strictEqual(frase({ rodando: false, inicio: '2026-10-02T01:00:00Z' }), 'última rodada terminou',
  'rodada terminada não pode parecer "nunca rodou"');

console.log('OK: status do custo-sync diz quando esta NA FILA, quem segura a trava e se vai retentar');
