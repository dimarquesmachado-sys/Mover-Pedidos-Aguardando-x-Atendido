'use strict';
/* 14/09 — passo 1 da Fase 3: os arquivos ESPELHADOS viram import direto da lib.
   `comum.js` e `produtos.js` eram triplicados com diferença ZERO depois de normalizar a tag.
   O verificador segurava a divergência, mas segurar não é eliminar — as três cópias existiam
   e um conserto precisava ser lembrado três vezes.
   O que o teste guarda agora que o espelho saiu de cena:
     • o contrato das três é o mesmo (foi o que o espelho garantia);
     • cada empresa mantém a PRÓPRIA tag de log — sem ela, a linha do log não diz de qual
       empresa é, e é o primeiro dado que se procura num incidente;
     • o `base` entra por injeção: ele é da pasta da empresa, e um require relativo dentro da
       lib apontaria pro lugar errado (foi o que quebrou no primeiro teste). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EMPRESAS = ['amb-checkout-offline', 'girassol-backup-offline', 'good-checkout-offline'];

for (const arq of ['comum', 'produtos']) {
  const { criar } = require('../lib/checkout/' + arq);
  assert.throws(() => criar({}), /falta tag/, arq + ': tag é obrigatória');
  assert.throws(() => criar({ tag: 'X' }), /falta base/, arq + ': base é obrigatória');

  const base = Object.keys(require('../' + EMPRESAS[0] + '/' + arq + '.js')).sort();
  assert.ok(base.length > 0, arq + ': a fachada não expõe nada');
  for (const emp of EMPRESAS.slice(1)) {
    assert.deepStrictEqual(Object.keys(require('../' + emp + '/' + arq + '.js')).sort(), base,
      emp + '/' + arq + ': contrato diferente das outras — era isso que o espelho garantia');
  }

  /* tag própria por empresa */
  const tags = EMPRESAS.map(emp => {
    const s = fs.readFileSync(path.join(__dirname, '..', emp, arq + '.js'), 'utf8');
    return (/tag: '([^']+)'/.exec(s) || [])[1];
  });
  assert.ok(tags.every(Boolean), arq + ': toda fachada declara tag: ' + tags.join(', '));
  assert.strictEqual(new Set(tags).size, 3, arq + ': as tags têm que ser distintas: ' + tags.join(', '));

  /* a lib não pode voltar a importar da pasta da empresa */
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', arq + '.js'), 'utf8');
  assert.ok(!/require\('\.\/base'\)/.test(lib), arq + ': a lib voltou a importar ./base — aponta pro lugar errado');
}

/* Codex #430: eu tinha "removido" os arquivos do espelho criando uma chave que NENHUM código
   lia — o verifica itera `identicos`, e eles seguiam lá. Chave morta em config é pior que
   nada: dá sensação de proteção configurada. O teste passa a conferir a lista de verdade. */
{
  const esp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'espelhos.json'), 'utf8'));
  for (const arq of ['comum.js', 'produtos.js']) {
    assert.ok(!esp.identicos.includes(arq),
      arq + ' ainda está em `identicos` — o espelho compararia fachadas de 8 linhas em vez do que importa');
  }
  for (const chave of Object.keys(esp)) {
    if (chave.startsWith('ignorar_arquivos')) {
      assert.fail('a chave "' + chave + '" não é lida pelo verifica — config morta finge proteção que não existe');
    }
  }
}

console.log('OK: comum e produtos — uma lib para as três, contrato idêntico, tag por empresa e base injetado');
