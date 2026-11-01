'use strict';
/* 30/10 — o CICLO do checkout em peça única (lib/checkout/ciclo-empresa): a AMB. Prova (scripts/_ciclo-origem.js):
   · toda linha de código NOVA no ciclo como a AMB o roda vem do ciclo de antes de outra empresa (com os nomes da AMB) —
     a guarda do despacho desligado (GOOD), o índice do catálogo com foto e nome composto e o log da NF corrigida (Girassol);
   · toda linha que SAIU está na lista revisada (scripts/fixtures/ciclo-amb-trocadas.json);
   · a AMB exporta as mesmas funções de antes; o estado é de cada instância; peça sem configuração recusa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { conferir } = require('./_ciclo-origem');
const r = conferir(raiz, 'amb', 'amb-checkout-offline');
assert.ok(r.novas.length > 0 && r.sumiram.length <= 18, 'a AMB mudou mais do que o previsto: ' + r.sumiram.length + ' linha(s) saíram');   /* 4 da peça + o sincronizar do Codex #774 + as 13 da sincronização dos conferidos sobre a lista atual (01/11, Codex F02) — todas na lista revisada das trocadas */
const txt = require('./_fonte-ciclo').ler(raiz, 'amb-checkout-offline/ciclo.js');
for (const [o, por] of [["const UNS_FULL_CASA = ['2920348', '2920232', '2839148', '3456195'];", 'as unidades Full da casa'], ["SH_URL + '/amb/interno/etiqueta", 'a loja /amb na Shopee'],
  ["_agF3.registrar('amb',", 'a chave fiscal'], ["require('../ambtotal/mlTokenManager')", 'o token do ML dela'], ['const UN_FULL = unsFullEfetivas();', 'o filtro de Full por unidade'],
  ["if (_logiML === 'fulfillment') {", 'a venda Full do ML fora da fila'],
  /* Codex #774: a AMB segue confiando na lista abaixo do limite (a opção 'confirma sempre' é da Girassol) e o sincronizar
     tira o Full só com o despacho configurado (o dela está) */
  ['if (aRemover.length > limiteSeguro || atendidos.length === 0 || fullNoLote > 0) {', 'a reconciliação como era'],
  ['sincronizarConferidos(Number(SIT_DESPACHADOS) ? new Set(', 'o sincronizar com o Full só quando despacha']]) {
  assert.ok(txt.includes(o), 'a AMB perdeu ' + por + ' (' + o + ')');
}
const mod = require(path.join(raiz, 'amb-checkout-offline', 'ciclo.js'));
const exportsAntes = /module\.exports = \{([^}]*)\}/.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-amb-antes.js'), 'utf8'))[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
assert.deepStrictEqual(Object.keys(mod).sort(), exportsAntes.sort(), 'a AMB não exporta as mesmas funções de antes');
const { criarCiclo } = require('../lib/checkout/ciclo-empresa');
const baseFake = require(path.join(raiz, 'amb-checkout-offline', 'base.js'));
const cfg = (env) => ({ base: baseFake, nf: {}, etiquetas: {}, comum: {}, produtos: {}, arquivo: {}, separacao: {}, prefixoEnv: env, empresaFiscal: env.toLowerCase(),
  mlTokenManager: () => ({}), mlApi: () => ({}), unsFullCasa: ['1'], unsEmissaoPropriaCasa: [] });
const c1 = criarCiclo(cfg('XBKP')), c2 = criarCiclo(cfg('YBKP'));
assert.ok(c1.getUltimoResumo !== c2.getUltimoResumo && c1.unsFullEfetivas !== c2.unsFullEfetivas, 'as instâncias dividem as funções/estado');
let erro = null; try { criarCiclo({ base: baseFake }); } catch (e) { erro = e.message; }
assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração da empresa tinha que recusar: ' + erro);
console.log('ok — ciclo da AMB na peça: ' + r.novas.length + ' linha(s) novas, todas de origem conhecida; ' + r.sumiram.length + ' trocadas (lista revisada); mesmas funções; estado por instância');
