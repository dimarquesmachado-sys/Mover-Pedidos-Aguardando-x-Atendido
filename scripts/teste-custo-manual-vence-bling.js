'use strict';
/* 12/11 — O CUSTO LANÇADO À MÃO VALE DA DATA EM DIANTE (pedido do dono, casos KC3 e KC6 da AMB).
   KC6: havia a faixa do Bling "R$ 147,00 desde 16/09"; ele lançou R$ 126,65 desde 01/09 e o custo novo ficou valendo só
   até 15/09 — a faixa mais nova continuava mandando dali em diante. E mesmo apagando-a, a sincronização com o Bling
   (que segue com 147,00) abria outra faixa "Bling" por cima na rodada seguinte.
   Prova:
   1) lib/custo.js — a faixa MANUAL aberta vence o Bling enquanto o custo do Bling não mudar: a sincronização trazendo o
      mesmo número de antes não abre faixa; quando o número do Bling MUDA depois do lançamento, aí abre (a partir do dia);
      sem o número anotado, a 1ª sincronização só o anota; "o Bling ficou sem custo" não fecha a faixa manual; e faixa
      de origem Bling continua se comportando como sempre;
   2) rotas comuns — o lançamento aceita `substituir_seguintes` (e NÃO anota o custo do Bling tirado do cache, que pode
      estar velho — quem anota é a 1ª sincronização depois do lançamento):
      as faixas que começam depois da data saem e o custo lançado vale até hoje; sem a opção, tudo como antes;
   3) a tela pergunta quando há custo mais novo na frente da data e manda a opção. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const custo = require('../lib/custo');

function ctxCom(inicial) {
  let guardado = JSON.parse(JSON.stringify(inicial || {}));
  return { CACHE_DIR: '/x', path, readJson: () => JSON.parse(JSON.stringify(guardado)), writeJson: (f, v) => { guardado = JSON.parse(JSON.stringify(v)); }, ver: () => guardado };
}
const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

/* ── 1) a sincronização × a faixa manual ── */
let c = ctxCom({ KC6: [{ custo: 126.65, de: '2026-09-01', ate: null, origem: 'manual', bling_visto: 147 }] });
assert.strictEqual(custo.registrarCustoVigente(c, 'KC6', 147, 'bling'), null);
assert.deepStrictEqual(c.ver().KC6.map((f) => [f.custo, f.de, f.ate, f.origem]), [[126.65, '2026-09-01', null, 'manual']], 'o Bling com o MESMO número de quando o dono lançou não pode abrir faixa por cima da manual: ' + JSON.stringify(c.ver().KC6));
assert.strictEqual(custo.custoVigenteEm(c, 'KC6', hoje), 126.65, 'o custo vigente hoje segue sendo o lançado');
/* o Bling MUDOU depois (compra nova / cadastro corrigido): aí vale o Bling, a partir do dia */
const r = custo.registrarCustoVigente(c, 'KC6', 130, 'bling');
assert.ok(Array.isArray(r) && c.ver().KC6.length === 2 && c.ver().KC6[1].custo === 130 && c.ver().KC6[1].de === hoje && c.ver().KC6[1].origem === 'bling' && c.ver().KC6[0].ate, 'quando o número do Bling muda depois do lançamento, abre a faixa nova do Bling: ' + JSON.stringify(c.ver().KC6));
/* faixa manual sem o número anotado (lançada antes desta mudança): a 1ª sincronização só anota */
c = ctxCom({ KC3: [{ custo: 73.46, de: '2026-09-01', ate: null, origem: 'manual' }] });
assert.strictEqual(custo.registrarCustoVigente(c, 'KC3', 85.26, 'bling'), null);
assert.ok(c.ver().KC3.length === 1 && c.ver().KC3[0].custo === 73.46 && c.ver().KC3[0].bling_visto === 85.26, 'sem o número anotado, a 1ª sincronização anota e NÃO abre faixa (é o caso das faixas que o dono já lançou): ' + JSON.stringify(c.ver().KC3));
assert.strictEqual(custo.registrarCustoVigente(c, 'KC3', 85.26, 'bling'), null); assert.strictEqual(c.ver().KC3.length, 1);
custo.registrarCustoVigente(c, 'KC3', 90, 'bling'); assert.strictEqual(c.ver().KC3.length, 2, 'e depois, mudando o Bling, abre');
/* Codex #852: a 1ª leitura do Bling IGUAL ao manual também vira a base — manual 100; Bling 100, 120, 120 → na 2ª leitura o
   Bling MUDOU (100 → 120) e a faixa do Bling abre (antes o 120 virava "a base" e o manual ficava pra sempre) */
c = ctxCom({ M1: [{ custo: 100, de: '2026-11-01', ate: null, origem: 'manual' }] });
assert.strictEqual(custo.registrarCustoVigente(c, 'M1', 100, 'bling'), null); assert.strictEqual(c.ver().M1[0].bling_visto, 100, 'a base tem que ser anotada mesmo com o Bling igual ao manual');
custo.registrarCustoVigente(c, 'M1', 120, 'bling');
assert.ok(c.ver().M1.length === 2 && c.ver().M1[1].custo === 120 && c.ver().M1[1].origem === 'bling', 'Bling 100 → 120 depois do lançamento: tinha que abrir a faixa do Bling: ' + JSON.stringify(c.ver().M1));
assert.strictEqual(custo.registrarCustoVigente(c, 'M1', 120, 'bling'), null);
/* o Bling muda PARA o número do manual (o dono acertou o cadastro): nada a abrir, e a base passa a ser esse número —
   se depois o Bling sair dele, é mudança de verdade */
c = ctxCom({ KC6: [{ custo: 126.65, de: '2026-09-01', ate: null, origem: 'manual', bling_visto: 147 }] });
assert.strictEqual(custo.registrarCustoVigente(c, 'KC6', 126.65, 'bling'), null);
assert.ok(c.ver().KC6.length === 1 && c.ver().KC6[0].bling_visto === 126.65);
custo.registrarCustoVigente(c, 'KC6', 147, 'bling');
assert.ok(c.ver().KC6.length === 2 && c.ver().KC6[1].custo === 147, 'o Bling saiu do número do manual (126,65 → 147) depois de ter igualado: é mudança de verdade, abre a faixa');
/* o Bling ficou sem custo: não fecha a faixa manual */
c = ctxCom({ KC6: [{ custo: 126.65, de: '2026-09-01', ate: null, origem: 'manual', bling_visto: 147 }] });
assert.strictEqual(custo.registrarCustoVigente(c, 'KC6', null, 'remocao-bling'), null); assert.strictEqual(c.ver().KC6[0].ate, null, 'custo removido no Bling não fecha o que o dono lançou');
/* faixa de origem Bling: tudo como sempre (o Bling mudou → faixa nova; removido → fecha) */
c = ctxCom({ A1: [{ custo: 10, de: '2026-08-01', ate: null, origem: 'bling' }] });
custo.registrarCustoVigente(c, 'A1', 12, 'bling'); assert.ok(c.ver().A1.length === 2 && c.ver().A1[1].custo === 12);
assert.strictEqual(custo.registrarCustoVigente(c, 'A1', null, 'remocao-bling'), 'faixa-fechada');
/* o dono lançando de novo à mão por cima de uma manual: vale o novo (não é "o Bling") */
c = ctxCom({ KC6: [{ custo: 126.65, de: '2026-09-01', ate: null, origem: 'manual', bling_visto: 147 }] });
custo.registrarCustoVigente(c, 'KC6', 120, 'manual'); assert.ok(c.ver().KC6.some((f) => f.custo === 120));

/* ── 2) as rotas comuns ── */
const rc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
const rota = rc.slice(rc.indexOf("if (p === PREFIXO + '/custo-historico') {"), rc.indexOf("PREFIXO + '/reaplicar-status'"));
assert.ok(/if \(b\.substituir_seguintes === true\) lista = lista\.filter\(f => String\(f\.de\) < de\);/.test(rota), 'com a opção, as faixas que começam DEPOIS da data saem');
assert.ok(rota.indexOf('lista = lista.filter(f => String(f.de) !== de);') < rota.indexOf('b.substituir_seguintes === true') && rota.indexOf('b.substituir_seguintes === true') < rota.indexOf("lista.push({ custo: Math.round(custo * 10000) / 10000, de, ate: null, origem: 'manual'"), 'a faixa lançada entra depois da limpeza');
/* a faixa manual nasce SEM o custo do Bling anotado: o cache do custo pode ter até 7 dias, e um número velho faria a
   sincronização achar que "o Bling mudou" e passar por cima do custo recém-lançado. Quem anota é a 1ª sincronização. */
assert.ok(!/bling_visto/.test(rota), 'o lançamento não pode anotar o custo do Bling tirado do cache (pode estar velho)');
{ const cz = ctxCom({ Z9: [{ custo: 11, de: '2026-11-10', ate: null, origem: 'manual' }] });   /* lançado com o cache dizendo 10, mas o Bling já estava em 12 */
  assert.strictEqual(custo.registrarCustoVigente(cz, 'Z9', 12, 'bling'), null);
  assert.ok(cz.ver().Z9.length === 1 && cz.ver().Z9[0].custo === 11 && cz.ver().Z9[0].bling_visto === 12, 'o custo recém-lançado não pode ser atropelado pelo número que o Bling JÁ tinha (só não tinha sido lido ainda): ' + JSON.stringify(cz.ver().Z9)); }
/* a mesma conta da rota, com as faixas do KC6 de verdade */
const aplicar = (lista, de, custoN, substituir) => { let l = lista.filter((f) => String(f.de) !== de); if (substituir === true) l = l.filter((f) => String(f.de) < de); l.push({ custo: custoN, de, ate: null, origem: 'manual' }); l.sort((a, b) => String(a.de).localeCompare(String(b.de))); for (let i = 0; i < l.length; i++) l[i].ate = (i === l.length - 1) ? null : 'vespera de ' + l[i + 1].de; return l; };
const kc6 = [{ custo: 126.65, de: '2026-09-01', ate: '2026-09-15', origem: 'manual' }, { custo: 147, de: '2026-09-16', ate: null, origem: 'bling' }];
assert.deepStrictEqual(aplicar(kc6, '2026-09-01', 126.65, true).map((f) => [f.custo, f.de, f.ate]), [[126.65, '2026-09-01', null]], 'KC6 com a opção: uma faixa só, de 01/09 até hoje');
assert.strictEqual(aplicar(kc6, '2026-09-01', 126.65, false).length, 2, 'sem a opção: como antes (a faixa de 16/09 continua)');

/* ── 3) a tela ── */
const tela = Object.values(require('../lib/checkout/painel-ferramentas-custo')).find((v) => typeof v === 'function')('/x');
new Function(tela);
/* Codex #852: a trava entra no CLIQUE, antes da consulta do histórico (dois cliques com consultas em voo não gravam fora de ordem) */
assert.ok(/if \(_preparando\) return;\s+_preparando = true; _travaEscrita\(true\);\s+_faixasDe\(sku\)\.then/.test(tela) && /function \(\) \{ _preparando = false; _travaEscrita\(false\); \}\);/.test(tela), 'o "lancar custo" tem que travar a escrita antes de consultar o histórico e soltar se a consulta falhar');
assert.ok(/Ja existe custo lancado DEPOIS de/.test(tela) && /corpo\.substituir_seguintes = true/.test(tela) && /String\(x\.de\)\.slice\(0, 10\) > D/.test(tela) && /'\.\\n\\n' \+/.test(tela), 'a tela pergunta quando há custo mais novo na frente da data e manda a opção (com quebra de linha de verdade no aviso)');
console.log('ok — custo lançado à mão: vale da data em diante (substituindo as faixas mais novas, se o dono quiser) e a sincronização com o Bling não passa por cima enquanto o número do Bling não mudar');
