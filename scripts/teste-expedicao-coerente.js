'use strict';
/* 15/09 — o dono perguntou se dá pra deixar a porta aberta pra a empresa nova ganhar app de
   Expedição no futuro. Dá: declara `expedicao` nas capacidades e troca a env de VERIFICADO.
   O problema é que são DOIS lugares e nada obriga o segundo a acompanhar o primeiro — e os
   dois jeitos de errar são silenciosos:
     · declarou a capacidade e esqueceu a env → o app de Expedição nunca recebe nada pra bipar;
     · não declarou mas mexeu na env → o pedido conferido fica parado num estado sem saída.
   Esta checagem roda no boot e grita. NÃO corrige sozinha, de propósito: qual dos dois lados
   está certo é decisão de operação, e escolher aqui seria decidir pelo dono. */
const assert = require('assert');
const { conferir } = require('../lib/checkout/conferir-expedicao');

/* as três empresas de hoje: coerentes */
assert.strictEqual(conferir({ rotulo: 'GIRA', temExpedicao: true, SIT_VERIFICADO: 24, SIT_DESPACHADOS: 743515 }).ok, true,
  'Girassol: tem Expedição e manda o conferido pra VERIFICADO');
assert.strictEqual(conferir({ rotulo: 'AMB', temExpedicao: false, SIT_VERIFICADO: 745123, SIT_DESPACHADOS: 745123 }).ok, true,
  'AMB: sem Expedição, conferido vai direto pra DESPACHADOS');
assert.strictEqual(conferir({ rotulo: 'GOOD', temExpedicao: false, SIT_VERIFICADO: 749990, SIT_DESPACHADOS: 749990 }).ok, true);

/* os dois esquecimentos possíveis */
const r1 = conferir({ rotulo: 'NOVA', temExpedicao: true, SIT_VERIFICADO: 749990, SIT_DESPACHADOS: 749990 });
assert.strictEqual(r1.ok, false, 'declarou Expedição e deixou a env apontando pro DESPACHADOS');
assert.ok(/nunca recebe nada pra bipar/.test(r1.aviso), 'o aviso tem que dizer a CONSEQUÊNCIA, não só "incoerente"');

const r2 = conferir({ rotulo: 'NOVA', temExpedicao: false, SIT_VERIFICADO: 24, SIT_DESPACHADOS: 749990 });
assert.strictEqual(r2.ok, false, 'sem Expedição mas mandando pra VERIFICADO');
assert.ok(/ficar parado/.test(r2.aviso), 'e aqui a consequência é o pedido sumir da esteira');

/* sem dado pra comparar, não inventa problema */
assert.strictEqual(conferir({ rotulo: 'X', temExpedicao: false, SIT_VERIFICADO: 24, SIT_DESPACHADOS: 0 }).ok, true,
  'DESPACHADOS desligado não vira falso alarme — isso é tratado em outro lugar');
assert.strictEqual(conferir({ rotulo: 'X', temExpedicao: true, SIT_VERIFICADO: 0, SIT_DESPACHADOS: 743515 }).ok, true);

/* e a checagem não pode corrigir sozinha: o retorno não muda valor nenhum */
const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'conferir-expedicao.js'), 'utf8');
assert.ok(!/process\.env\[[^\]]*\]\s*=/.test(fonte), 'a checagem não pode escrever env — qual lado está certo é decisão de operação');

console.log('OK: coerência da Expedição — as três atuais passam, os dois esquecimentos gritam com a consequência, e nada é corrigido sozinho');
