'use strict';
/* 04/11 — NF TRAVADA SAI DO AVISO QUANDO O ML LIBERA A ETIQUETA (por qualquer caminho). O ML só libera a etiqueta depois de
   ACEITAR uma nota do pedido. O #797 tirava a travada só quando a PRÓPRIA rotina F3 mandava a nota nova; no caso real
   (NF 130031 da Girassol) o dono subiu a nota nova à mão no ML — a etiqueta veio, mas o aviso ficaria. Agora o CICLO do
   checkout (lib/checkout/ciclo-empresa, peça única das três), ao ver um pedido do ML COM etiqueta, tira as travadas dele.
   Prova com o CÓDIGO DE PRODUÇÃO do ciclo (o trecho tirado do arquivo da peça, como os outros testes do ciclo fazem):
   · pedido do ML com etiqueta e travada → sai do aviso; a travada de outro pedido fica;
   · sem etiqueta, ou pedido de outro marketplace → nada sai;
   · o trecho fica ANTES do retrato do pedido e usa a MESMA pasta que a tela das travadas lê (CACHE_DIR da empresa). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trav = require('../lib/nf-travadas');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
const i1 = src.indexOf('  let _travCache = { ts: 0, peds: new Set() };');
const f1 = src.indexOf('\n  };\n', i1) + 5;
const i2 = src.indexOf("    /* Codex #798: etiqueta ANEXADA À MÃO pelo admin");
const f2 = src.indexOf('\n    }\n', i2) + 7;
assert.ok(i1 > 0 && i2 > 0, 'não achei o trecho da travada no ciclo');
const iSnap = src.indexOf('    const snapshot = {', i2);
assert.ok(iSnap > i2 && iSnap - f2 < 200, 'a limpeza da travada tem que ficar logo antes do retrato do pedido (a etiqueta já decidida)');
const rotas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
assert.ok(/trav\.lista\(CACHE_DIR\)|trav\.lista\(CACHE_DIR,/.test(rotas) || /lista\(CACHE_DIR\)/.test(rotas), 'a tela das travadas não lê do CACHE_DIR da empresa (o ciclo limparia outra pasta)');

const montar = new Function('o', 'CACHE_DIR', 'LOG', 'require', 'console', 'path', 'readJson', 'dir',
  src.slice(i1, f1) + '\nreturn function (temEtiqueta, etiquetaMM, mkt, ped) {\n' + src.slice(i2, f2) + '\n};');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travetq-'));
const lerArq = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '_nf_travadas.json'), 'utf8')); } catch (e) { return {}; } };
const ERRO = 'NFe receiver zipcode must be the same as the sale (wrong_receiver_zipcode)';
assert.ok(trav.registrar(dir, { nfeId: 9001, numero: 130031, pedidoML: '2000019330050780', erro: ERRO }).gravou);
assert.ok(trav.registrar(dir, { nfeId: 9500, numero: 130500, pedidoML: '2000000000000555', erro: ERRO }).gravou);
const logs = [];
/* o require do trecho resolve a partir da pasta da peça (lib/checkout), como em produção */
const reqPeca = (m) => require(m.startsWith('.') ? path.join(__dirname, '..', 'lib', 'checkout', m) : m);
/* Codex #798 (P1): em produção o `o` NÃO tem CACHE_DIR (vem de o.base) — o teste não pode fornecer um, senão mascara a pasta errada */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const pedDir = path.join(dir, '555'); fs.mkdirSync(pedDir);
const passo = montar({}, dir, 'TESTE', reqPeca, { log: (m) => logs.push(m) }, path, readJson, pedDir);

passo(false, false, 'ml', { numero: 124300, numeroLoja: '2000019330050780' });
assert.ok(lerArq()['9001'], 'sem etiqueta a travada não podia sair');
passo(true, false, 'shopee', { numero: 124300, numeroLoja: '2000019330050780' });
assert.ok(lerArq()['9001'], 'pedido de outro marketplace não podia tirar a travada');
passo(true, false, 'ml', { numero: 124300, numeroLoja: '2000019330050780' });
assert.ok(!lerArq()['9001'], 'o ML liberou a etiqueta e a travada do pedido continuou no aviso');
assert.ok(lerArq()['9500'], 'a travada de OUTRO pedido não podia sair');
assert.ok(logs.some((m) => /liberou a etiqueta/.test(m)), 'faltou o registro no log');
/* Codex #798: etiqueta anexada à mão NÃO prova aceite do ML — a travada fica */
assert.ok(trav.registrar(dir, { nfeId: 9004, numero: 130034, pedidoML: '2000000000000999', erro: ERRO }).gravou);
fs.writeFileSync(path.join(pedDir, 'pedido.json'), JSON.stringify({ etiqueta_anexada: true, tem_etiqueta: true }));
passo(true, false, 'ml', { numero: 1, numeroLoja: '2000000000000999' });
assert.ok(lerArq()['9004'], 'etiqueta anexada à mão não podia tirar a travada (o anexo não confirma aceite do ML)');
fs.unlinkSync(path.join(pedDir, 'pedido.json'));
/* Codex #798: o pedido que JÁ estava no cache com etiqueta (o caso real) não passa pelo cachearPedido — o rodarCiclo faz a
   limpeza pra eles: o trecho de produção, com a lista de atendidos e o manifesto de mentira */
const i3 = src.indexOf('      { const _pend = _travadasPendentes();');
const f3 = src.indexOf('\n        } }\n', i3) + 12;
assert.ok(i3 > 0 && src.slice(src.lastIndexOf('const aProcessar = atendidos.filter', i3), i3).length < 800, 'a limpeza dos já em cache tem que ficar no rodarCiclo, junto da escolha do que reprocessar');
const montarCache = new Function('o', 'CACHE_DIR', 'LOG', 'LOJA_MKT', 'require', 'console',
  src.slice(i1, f1) + '\nreturn function (atendidos, man) {\n' + src.slice(i3, f3) + '\n};');
assert.ok(trav.registrar(dir, { nfeId: 9002, numero: 130032, pedidoML: '2000000000000777', erro: ERRO }).gravou);
assert.ok(trav.registrar(dir, { nfeId: 9003, numero: 130033, pedidoML: '2000000000000888', erro: ERRO }).gravou);
const rodar = montarCache({}, dir, 'TESTE', { 10: 'ml', 20: 'shopee' }, reqPeca, { log: (m) => logs.push(m) });
rodar([
  { id: 1, numero: 1, numeroLoja: '2000000000000777', loja: { id: 10 } },   /* ML, já em cache COM etiqueta -> sai */
  { id: 2, numero: 2, numeroLoja: '2000000000000888', loja: { id: 10 } },   /* ML, em cache SEM etiqueta -> fica */
  { id: 3, numero: 3, numeroLoja: '2000000000000999', loja: { id: 10 } },   /* ML, etiqueta ANEXADA À MÃO -> fica */
], { 1: { tem_etiqueta: true }, 2: { tem_etiqueta: false }, 3: { tem_etiqueta: true, etiqueta_anexada: true } });
assert.ok(lerArq()['9004'], 'rodarCiclo: etiqueta anexada à mão não podia tirar a travada');
assert.ok(!lerArq()['9002'], 'pedido do ML JÁ em cache com etiqueta: a travada continuou no aviso (o caso real)');
assert.ok(lerArq()['9003'], 'pedido em cache SEM etiqueta: a travada não podia sair');
assert.ok(lerArq()['9500'], 'a travada de OUTRO pedido não podia sair');
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — NF travada sai do aviso quando o ML libera a etiqueta do pedido (nota mandada pela rotina ou subida à mão; também os pedidos que já estavam no cache com etiqueta); sem etiqueta ou outro marketplace, fica');
