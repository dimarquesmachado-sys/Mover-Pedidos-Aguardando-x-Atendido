'use strict';
/* 15/09 — o sistema aprende o emitente sozinho. Veio de atrito REAL: ontem, ao consertar a
   DANFE, eu precisei PEDIR ao dono a razão, o CNPJ, a IE e o endereço da GOOD — e o dado
   estava no XML de toda NF-e autorizada o tempo todo. Numa empresa nova isso significa uma
   coisa a menos pra digitar: basta a primeira nota sair.
   O teste guarda os três cuidados, cada um vindo de um erro que já aconteceu aqui. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { criar } = require('../lib/checkout/emitente-descobrir');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-'));
const arq = path.join(dir, 'emitente-descoberto.json');
const e = criar({ rotulo: 'TESTE', arquivo: arq });

const EMIT = { razao: 'EMPRESA NOVA LTDA', cnpj: '11222333000181', ie: '123456789', endereco: 'Rua X, 1' };

/* 1. aprende do XML */
assert.strictEqual(e.lerDescoberto(), null, 'começa sem saber nada');
assert.deepStrictEqual(e.aprender(EMIT).cnpj, EMIT.cnpj, 'tem que aprender da primeira NF');
assert.strictEqual(e.lerDescoberto().cnpj, EMIT.cnpj, 'e persistir em disco — reinício não pode esquecer');

/* 2. meio emitente não serve: sai impresso incompleto e ninguém desconfia */
const e2 = criar({ rotulo: 'T2', arquivo: path.join(dir, 'b.json') });
assert.strictEqual(e2.aprender({ razao: 'SÓ O NOME' }), null, 'sem CNPJ não pode aprender');
assert.strictEqual(e2.aprender({ cnpj: '11222333000181' }), null, 'sem razão não pode aprender');
assert.strictEqual(e2.aprender(null), null);
assert.strictEqual(e2.lerDescoberto(), null, 'nada foi gravado');

/* 3. o DECLARADO ganha do descoberto: se alguém escreveu à mão, foi por um motivo */
const declarado = { razao: 'DECLARADO LTDA', cnpj: '99888777000166', ie: '9', endereco: 'Rua Y' };
assert.strictEqual(e.vigente(declarado).cnpj, declarado.cnpj, 'adivinhação não ganha de decisão');
assert.strictEqual(e.vigente(null).cnpj, EMIT.cnpj, 'sem declarado, vale o aprendido');
assert.strictEqual(e.vigente({ razao: 'incompleto' }).cnpj, EMIT.cnpj, 'declarado pela metade não conta');

/* 4. CNPJ diferente do gravado NÃO sobrescreve — seria a pasta lendo nota de outra empresa,
   que é exatamente o erro que custou o CNPJ trocado na DANFE */
const outro = { razao: 'OUTRA EMPRESA', cnpj: '55444333000122', ie: '5', endereco: 'Rua Z' };
const mantido = e.aprender(outro);
assert.strictEqual(mantido.cnpj, EMIT.cnpj, 'CNPJ divergente não pode sobrescrever em silêncio');
assert.strictEqual(e.lerDescoberto().cnpj, EMIT.cnpj, 'o disco tem que continuar com o original');

/* 5. aprender de novo o MESMO não reescreve o arquivo à toa */
const antes = fs.statSync(arq).mtimeMs;
e.aprender(EMIT);
assert.strictEqual(fs.statSync(arq).mtimeMs, antes, 'aprender o mesmo dado não deve reescrever');

console.log('OK: emitente aprendido — grava da 1ª NF, recusa dado pela metade, o declarado ganha, e CNPJ divergente não sobrescreve');
