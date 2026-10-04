/* 04/10 — A VIGIA DO ML FULL DA AMB NUNCA RODAVA: alias × id canônico.

   Achado E da auditoria, e o efeito é a vigia não existir pra AMB:
     · o mapa de managers usa a chave `amb`;
     · a lista de empresas ativas devolve o id canônico `ambtotal`;
     · o agendador (`index.js`) filtra as pedidas contra as ativas ANTES de chamar a vigia.
   Com `ML_FULL_VIGIA_EMPRESAS=ambtotal` a empresa era classificada como inativa; com `amb`,
   passava pelo filtro mas o nome não batia no mapa. Os dois caminhos falhavam.

   ⚠️ DUAS CORREÇÕES DE ROTA MINHAS, as duas apontadas pelo Codex no #618:

   1. EU NORMALIZEI NO LUGAR ERRADO. A primeira versão resolvia o alias dentro de `vigiaDiaria`
      — tarde demais: o agendador já tinha descartado a empresa antes de chegar lá. O certo é
      `vigiaSelecionar`, que é por onde o agendador passa; agora ela devolve a CHAVE DO MAPA, e
      isso serve aos dois caminhos e a QUALQUER alias (`gimpo`, `gira`), não só `ambtotal`.

   2. MEU TESTE CHAMAVA `vigiaDiaria` DE VERDADE — e ela não é consulta: grava checkpoint em
      disco e DISPARA a rotina de fundo que fala com ML e Bling. No CI isso criava arquivo no
      repositório e podia ir à rede. Pior: a primeira chamada deixava a série "rodando", então a
      segunda respondia `ja_ha_serie_em_andamento` e a comparação SEMPRE falhava — era isso o
      vermelho do CI que eu disse não reproduzir. Reproduzia; só não no meu ambiente, que tinha
      estado de execuções anteriores.

   Por isso aqui o teste exercita `vigiaSelecionar`, que é PURA: resolve nomes e não toca em
   disco, rede nem estado.

   Marcador estável [VIGIA-ALIAS]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const mlFull = require(path.join(raiz, 'ml-full.js'));

/* as ativas vêm em id CANÔNICO, como `config/empresas` devolve */
const ATIVAS = ['ambtotal', 'good', 'girassol'];

/* ── todo nome válido da mesma empresa precisa resolver pra MESMA chave ───────────── */
{
  const porAlias = mlFull.vigiaSelecionar(['amb'], ATIVAS);
  const porCanonico = mlFull.vigiaSelecionar(['ambtotal'], ATIVAS);

  assert.strictEqual(porCanonico.fora.length, 0,
    '[VIGIA-ALIAS] `ML_FULL_VIGIA_EMPRESAS=ambtotal` foi classificado como INATIVO — é o id ' +
    'canônico que a lista de ativas devolve, e com ele a vigia da AMB nunca é agendada');
  assert.strictEqual(porAlias.fora.length, 0,
    '[VIGIA-ALIAS] `ML_FULL_VIGIA_EMPRESAS=amb` (a configuração DOCUMENTADA) foi classificado ' +
    'como INATIVO');

  assert.deepStrictEqual(porAlias.ativas, porCanonico.ativas,
    '[VIGIA-ALIAS] "amb" e "ambtotal" resolvem pra chaves DIFERENTES (' +
    JSON.stringify(porAlias.ativas) + ' × ' + JSON.stringify(porCanonico.ativas) +
    ') — é a mesma conta, e o nome usado no deploy não pode mudar o comportamento');
}

/* ⚠️ ── e vale pra QUALQUER alias do registro, não só o da AMB ─────────────────────── */
{
  for (const [alias, esperado] of [['gimpo', 'good'], ['gira', 'girassol'], ['amb', 'amb']]) {
    const r = mlFull.vigiaSelecionar([alias], ATIVAS);
    assert.strictEqual(r.fora.length, 0,
      '[VIGIA-ALIAS] o alias "' + alias + '" foi tido como inativo');
    assert.deepStrictEqual(r.ativas, [esperado],
      '[VIGIA-ALIAS] o alias "' + alias + '" resolveu pra ' + JSON.stringify(r.ativas) +
      ' em vez de ["' + esperado + '"] — a chave entregue precisa ser a do mapa de managers, ' +
      'senão a vigia responde `empresa_desconhecida` e não roda');
  }
}

/* ⚠️ ── nome inexistente continua RECUSADO ────────────────────────────────────────────
   Sem isto, "aceitar alias" viraria "aceitar qualquer coisa", e um erro de digitação na env
   passaria como empresa válida: a vigia rodaria pra ninguém e ninguém saberia. */
{
  const r = mlFull.vigiaSelecionar(['empresa-que-nao-existe'], ATIVAS);
  assert.deepStrictEqual(r.ativas, [],
    '[VIGIA-ALIAS] empresa inexistente foi ACEITA como ativa — erro de digitação na env passaria batido');
  assert.deepStrictEqual(r.fora, ['empresa-que-nao-existe'],
    '[VIGIA-ALIAS] a recusa não diz qual nome foi recusado → ' + JSON.stringify(r));
}

/* ── empresa DESLIGADA no deploy continua fora (achado D) ─────────────────────────── */
{
  const r = mlFull.vigiaSelecionar(['amb', 'good'], ['good']);   /* a AMB saiu das ativas */
  assert.deepStrictEqual(r.ativas, ['good'],
    '[VIGIA-ALIAS] a vigia agendaria uma empresa que o deploy DESLIGOU → ' + JSON.stringify(r.ativas));
  assert.deepStrictEqual(r.fora, ['amb'], '[VIGIA-ALIAS] a empresa desligada não foi reportada como fora');
}

console.log('OK: alias e id canonico resolvem pra mesma chave; inexistente e desligada ficam fora');
