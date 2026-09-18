'use strict';
/* 18/09 — MARCAR QUAL MÊS JÁ FOI APURADO, e isso só o dono sabe.

   O ritual dele é mensal: estima a alíquota do mês e, por volta do dia 20, a contabilidade
   manda a apuração — aí ele troca o valor. Hoje ele salvou 8,40952% em agosto da AMB (apurado)
   e 10% em set-dez (estimativa dele, deliberada).

   Depois de salvos, os dois ficavam IDÊNTICOS na tela: "salva aqui" nos dois. Olhando três
   empresas, ele não tinha como saber quais meses ainda faltavam trocar — precisava lembrar de
   cor.

   Isso NÃO dá pra deduzir do número: 10% pode ser palpite numa empresa e apuração em outra. A
   marcação é dele, e o sistema só precisa guardar e mostrar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* as TRÊS gravam a marcação, e só aceitam mês no formato certo */
for (const [emp, arq] of Object.entries({
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
})) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = /if \(Array\.isArray\(body\.apuradas\)\) \{\s*\n\s*atual\.apuradas = body\.apuradas\.filter\(m => \/\^\\d\{4\}-\\d\{2\}\$\/\.test\(m\)\);/.exec(s);
  assert.ok(m, emp + ': /config-fiscal não grava quais meses o dono marcou como apurados');
}

/* as TRÊS telas têm a caixinha e mandam a lista */
for (const [emp, arq] of Object.entries({
  amb: 'amb-checkout-offline/amb-dashboard.html',
  girassol: 'girassol-backup-offline/dashboard.html',
  good: 'good-checkout-offline/dashboard.html',
})) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/data-apurada="'\+/.test(html), emp + ': a tela não tem a marcação de apurada por mês');
  assert.ok(/APURADAS\.has\(/.test(html), emp + ': a tela não mostra o que já foi marcado — a marca sumiria a cada abertura');
  assert.ok(/apuradas/.test(html) && /checked && aliquotas\[c\.dataset\.apurada\] != null/.test(html),
    emp + ': a tela não envia a lista, ou marca mês SEM valor salvo — marcar um mês vazio prometeria ' +
    'uma apuração que não existe');
}

/* a regra do aviso, exercitada com o caso real da AMB de hoje */
{
  const html = fs.readFileSync(path.join(raiz, 'amb-checkout-offline/amb-dashboard.html'), 'utf8');
  const m = /window\._aliqEstimadas = Object\.keys\(CFG\.aliquotas \|\| \{\}\)\s*\n\s*\.filter\([^;]*;/.exec(html);
  assert.ok(m, 'não achei o cálculo das pendências');

  const pendentes = new Function('CFG', 'APURADAS', 'const window = {};\n' + m[0] + '\nreturn window._aliqEstimadas;');
  const CFG = { aliquotas: { '2026-07': 7.5896, '2026-08': 8.40952, '2026-09': 10, '2026-10': 10 } };

  assert.deepStrictEqual(pendentes(CFG, new Set()), ['2026-07', '2026-08', '2026-09', '2026-10'],
    'sem nada marcado, TODOS os meses salvos são pendência');
  assert.deepStrictEqual(pendentes(CFG, new Set(['2026-07', '2026-08'])), ['2026-09', '2026-10'],
    'marcados jul e ago, sobram set e out — que é a lista que o dono precisa no dia 20');

  /* mês SEM valor salvo não é pendência: não há o que trocar nele */
  assert.deepStrictEqual(pendentes({ aliquotas: { '2026-11': 0 } }, new Set()), [],
    'mês sem alíquota salva não pode virar pendência — zero não é valor');
}

console.log('OK: alíquota apurada — as três guardam e mostram a marcação do dono, e o aviso lista só os meses que faltam trocar');
