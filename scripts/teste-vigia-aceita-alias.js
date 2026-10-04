/* 04/10 — A VIGIA DO ML FULL NÃO RECONHECIA A AMB PELO ID CANÔNICO.

   Achado E da auditoria do Codex, e o efeito é a vigia da AMB simplesmente NÃO RODAR:

     · o mapa de managers usa a chave `amb`;
     · o id canônico da empresa é `ambtotal`, e é ele que a lista de ativas devolve;
     · com `ML_FULL_VIGIA_EMPRESAS=ambtotal` → `empresa_desconhecida`;
     · com `ML_FULL_VIGIA_EMPRESAS=amb` (a configuração DOCUMENTADA) → o filtro de ativas
       descartava como "inativa", porque comparava com a lista canônica.

   Ou seja: os dois caminhos falhavam, por nomes diferentes da MESMA empresa. A vigia é o que
   confere toda madrugada se faltou NF do Full — não rodar passa despercebido justamente porque
   o sintoma é ausência de aviso.

   O mesmo tratamento já foi dado ao `SKIP_EMPRESAS` no achado D: alias e canônico apontam pra
   mesma conta.

   Marcador estável [VIGIA-ALIAS]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const mlFull = require(path.join(raiz, 'ml-full.js'));

/* ── os dois nomes da AMB têm que ser aceitos ─────────────────────────────────────── */
{
  const porAlias = mlFull.vigiaDiaria(['amb'])[0];
  const porCanonico = mlFull.vigiaDiaria(['ambtotal'])[0];

  assert.notStrictEqual(porAlias.resultado, 'empresa_desconhecida',
    '[VIGIA-ALIAS] a vigia não reconhece "amb" — e essa é a configuração DOCUMENTADA');

  assert.notStrictEqual(porCanonico.resultado, 'empresa_desconhecida',
    '[VIGIA-ALIAS] a vigia não reconhece "ambtotal" — e é esse o id canônico que a lista de ' +
    'empresas ativas devolve. A vigia da AMB simplesmente NÃO RODA, e o sintoma é ausência de ' +
    'aviso: ninguém percebe.');

  /* ⚠️ e os dois têm que levar ao MESMO lugar: se um iniciar e o outro não, a loja pode rodar
     duas vigias ou nenhuma, dependendo de qual nome o deploy usou */
  assert.strictEqual(porAlias.resultado, porCanonico.resultado,
    '[VIGIA-ALIAS] "amb" e "ambtotal" levam a resultados DIFERENTES (' + porAlias.resultado +
    ' × ' + porCanonico.resultado + ') — é a mesma conta, e o nome usado no deploy não pode ' +
    'mudar o comportamento');
}

/* ── as outras empresas continuam funcionando ─────────────────────────────────────── */
for (const e of ['good', 'girassol']) {
  const r = mlFull.vigiaDiaria([e])[0];
  assert.notStrictEqual(r.resultado, 'empresa_desconhecida',
    '[VIGIA-ALIAS] a vigia deixou de reconhecer "' + e + '"');
}

/* ⚠️ ── e empresa que NÃO EXISTE continua sendo recusada ──────────────────────────────
   Sem isto, "aceitar alias" poderia virar "aceitar qualquer coisa", e um erro de digitação na
   env passaria como empresa válida — a vigia rodaria pra ninguém e ninguém saberia. */
{
  const r = mlFull.vigiaDiaria(['empresa-que-nao-existe'])[0];
  assert.strictEqual(r.resultado, 'empresa_desconhecida',
    '[VIGIA-ALIAS] empresa inexistente foi ACEITA — erro de digitação na env passaria batido');
  assert.strictEqual(r.empresa, 'empresa-que-nao-existe',
    '[VIGIA-ALIAS] a recusa não diz qual nome foi recusado → ' + JSON.stringify(r));
}

console.log('OK: a vigia aceita alias e id canonico da mesma empresa, e recusa nome inexistente');
