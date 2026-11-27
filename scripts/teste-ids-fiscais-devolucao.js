'use strict';
/* 27/11 — OS IDS FISCAIS DA DEVOLUÇÃO SAEM DO CHECKOUT (lib/checkout/ids-fiscais-devolucao).
   Pedido do dono: "pq logando no checkout não serve? faça com q não precise ter q logar lá no devoluções" e "não é
   melhor deixar o mm nome no devoluções e no mover-pedidos?".

   O que se prova: os nomes são os do Devoluções (<PREFIXO>ID_EMPRESA_CONTROL e <PREFIXO>ID_NATUREZA_DEVOLUCAO_ENTRADA, com
   GIRASSOL_, GOOD_, AMB_); só vale o PAR completo e com cara de id (a lista NATUREZAS_DEVOLUCAO_IDS, com vírgula, não
   passa); nada tem padrão no código; uma empresa não lê a variável da outra; empresa nova segue a convenção. */
const assert = require('assert');
const { idsFiscaisDevolucao, prefixoDe } = require('../lib/checkout/ids-fiscais-devolucao');

const ENV = { GIRASSOL_ID_EMPRESA_CONTROL: '933846821', GIRASSOL_ID_NATUREZA_DEVOLUCAO_ENTRADA: '1044537822', GOOD_ID_EMPRESA_CONTROL: ' 4956030980 ', GOOD_ID_NATUREZA_DEVOLUCAO_ENTRADA: '5776118802',
  AMB_ID_EMPRESA_CONTROL: '14901993834', AMB_ID_NATUREZA_DEVOLUCAO_ENTRADA: '15110128838', AMB_NATUREZAS_DEVOLUCAO_IDS: '15110882041,15110128838' };
assert.deepStrictEqual(idsFiscaisDevolucao('girassol', ENV), { idNaturezaOperacao: '1044537822', idEmpresaControl: '933846821' });
assert.deepStrictEqual(idsFiscaisDevolucao('good', ENV), { idNaturezaOperacao: '5776118802', idEmpresaControl: '4956030980' }, 'espaço em volta é aparado');
for (const e of ['amb', 'ambtotal', 'AMB', ' Amb ']) assert.deepStrictEqual(idsFiscaisDevolucao(e, ENV), { idNaturezaOperacao: '15110128838', idEmpresaControl: '14901993834' }, e);
assert.deepStrictEqual([prefixoDe('girassol'), prefixoDe('good'), prefixoDe('amb'), prefixoDe('ambtotal'), prefixoDe('novaloja'), prefixoDe('loja2')], ['GIRASSOL_', 'GOOD_', 'AMB_', 'AMB_', 'NOVALOJA_', 'LOJA2_']);
assert.deepStrictEqual(idsFiscaisDevolucao('novaloja', { NOVALOJA_ID_EMPRESA_CONTROL: '11112222', NOVALOJA_ID_NATUREZA_DEVOLUCAO_ENTRADA: '33334444' }), { idNaturezaOperacao: '33334444', idEmpresaControl: '11112222' }, 'empresa nova: só as duas variáveis');
/* sem padrão no código: nada configurado = null, nas três */
for (const e of ['girassol', 'good', 'amb']) assert.strictEqual(idsFiscaisDevolucao(e, {}), null, e + ': sem variável não inventa número');
for (const e of ['girassol', 'good', 'amb']) { const pf = { girassol: 'GIRASSOL_', good: 'GOOD_', amb: 'AMB_' }[e]; assert.strictEqual(idsFiscaisDevolucao(e, { [pf + 'ID_NATUREZA_DEVOLUCAO_ENTRADA']: '5776118802' }), null, e + ': só a natureza — o id da empresa não tem padrão no código'); assert.strictEqual(idsFiscaisDevolucao(e, { [pf + 'ID_EMPRESA_CONTROL']: '4956030980' }), null, e + ': só a empresa — a natureza não tem padrão no código'); }
/* só o par completo */
for (const falta of ['GIRASSOL_ID_EMPRESA_CONTROL', 'GIRASSOL_ID_NATUREZA_DEVOLUCAO_ENTRADA']) { const env = Object.assign({}, ENV); delete env[falta]; assert.strictEqual(idsFiscaisDevolucao('girassol', env), null, 'sem ' + falta); }
/* número torto — inclusive a LISTA com vírgula (o engano fácil: copiar NATUREZAS_DEVOLUCAO_IDS) */
for (const ruim of ['15110882041,15110128838', '1511 0128', 'abc', '12a45', '', '   ', '123', '1'.repeat(21), '-15110128838', '1.5e10']) {
  assert.strictEqual(idsFiscaisDevolucao('amb', Object.assign({}, ENV, { AMB_ID_NATUREZA_DEVOLUCAO_ENTRADA: ruim })), null, 'natureza torta: ' + JSON.stringify(ruim));
  assert.strictEqual(idsFiscaisDevolucao('amb', Object.assign({}, ENV, { AMB_ID_EMPRESA_CONTROL: ruim })), null, 'empresa torta: ' + JSON.stringify(ruim));
}
/* a lista de reconhecimento NÃO serve de natureza de emissão */
{ const env = Object.assign({}, ENV); delete env.AMB_ID_NATUREZA_DEVOLUCAO_ENTRADA; assert.strictEqual(idsFiscaisDevolucao('amb', env), null, 'NATUREZAS_DEVOLUCAO_IDS não é lida'); }
/* uma empresa não lê a da outra */
assert.strictEqual(idsFiscaisDevolucao('girassol', { GOOD_ID_EMPRESA_CONTROL: '4956030980', GOOD_ID_NATUREZA_DEVOLUCAO_ENTRADA: '5776118802', AMB_ID_EMPRESA_CONTROL: '14901993834', AMB_ID_NATUREZA_DEVOLUCAO_ENTRADA: '15110128838' }), null);
/* empresa torta não vira nome de variável */
for (const e of ['', null, undefined, '../x', 'a b', '1abc', 'x', 'x'.repeat(40), {}]) { const pf = String(e || '').trim().toUpperCase() + '_'; assert.strictEqual(idsFiscaisDevolucao(e, { _ID_EMPRESA_CONTROL: '11112222', _ID_NATUREZA_DEVOLUCAO_ENTRADA: '33334444', [pf + 'ID_EMPRESA_CONTROL']: '11112222', [pf + 'ID_NATUREZA_DEVOLUCAO_ENTRADA']: '33334444' }), null, 'empresa ' + JSON.stringify(e)); }
/* sem env passado, lê o do processo */
const antes = [process.env.GOOD_ID_EMPRESA_CONTROL, process.env.GOOD_ID_NATUREZA_DEVOLUCAO_ENTRADA];
try { process.env.GOOD_ID_EMPRESA_CONTROL = '4956030980'; process.env.GOOD_ID_NATUREZA_DEVOLUCAO_ENTRADA = '5776118802'; assert.deepStrictEqual(idsFiscaisDevolucao('good'), { idNaturezaOperacao: '5776118802', idEmpresaControl: '4956030980' }); }
finally { for (const [k, v] of [['GOOD_ID_EMPRESA_CONTROL', antes[0]], ['GOOD_ID_NATUREZA_DEVOLUCAO_ENTRADA', antes[1]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
console.log('ok — ids fiscais da devolução no checkout: os mesmos nomes do Devoluções (GIRASSOL_/GOOD_/AMB_ + ID_EMPRESA_CONTROL e ID_NATUREZA_DEVOLUCAO_ENTRADA); só o par completo e com cara de id; a lista com vírgula não passa; sem padrão no código');
