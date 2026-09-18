'use strict';
/* 18/09 — MARCAR QUAL MÊS JÁ FOI APURADO, e isso só o dono sabe.

   O ritual dele é mensal: estima a alíquota do mês e, por volta do dia 20, a contabilidade
   manda a apuração — aí ele troca o valor. Hoje ele salvou 8,40952% em agosto da AMB (apurado)
   e 10% em set-dez (estimativa dele, deliberada).

   Depois de salvos, os dois ficavam IDÊNTICOS na tela: "salva aqui" nos dois. Olhando três
   empresas, ele não tinha como saber quais meses ainda faltavam trocar — precisava lembrar de
   cor.

   Isso NÃO dá pra deduzir do número: 10% pode ser palpite numa empresa e apuração em outra. A
   marcação é dele, e o sistema só precisa guardar e mostrar.

   18/09 (revisão do Codex): quatro apontamentos, nas TRÊS telas —
   1) CFG perdia `apuradas` no boot e no pós-salvar (AMB/Girassol): recarregar a tela ou salvar
      de novo apagava a marcação que o servidor tinha guardado.
   2) o aviso de pendência (_aliqEstimadas) só aparecia dentro do `if` de mês herdado — em ano
      com os 12 meses de fábrica preenchidos, nunca aparecia; na Girassol nem tinha sido inserido
      no HTML.
   3) marcar "apurada" sobre um valor de fábrica intocado (a apuração bateu com o que a tabela já
      mostrava) virava null e a marca não tinha o que salvar.
   4) o servidor SUBSTITUÍA a lista inteira de apurados pela do formulário, que só cobre os 12
      meses do ano corrente — o primeiro salvamento após a virada do ano apagava os apurados de
      anos anteriores. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ARQ_SERVIDOR = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};
const ARQ_TELA = {
  amb: 'amb-checkout-offline/amb-dashboard.html',
  girassol: 'girassol-backup-offline/dashboard.html',
  good: 'good-checkout-offline/dashboard.html',
};

/* as TRÊS gravam a marcação, só aceitam mês no formato certo, e PRESERVAM os apurados de anos
   que o formulário não cobre (Codex #4) */
for (const [emp, arq] of Object.entries(ARQ_SERVIDOR)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const bloco = /if \(Array\.isArray\(body\.apuradas\)\) \{[\s\S]*?\n {6}\}/.exec(s);
  assert.ok(bloco, emp + ': /config-fiscal não grava quais meses o dono marcou como apurados');
  assert.ok(/body\.apuradas\.filter\(m => \/\^\\d\{4\}-\\d\{2\}\$\/\.test\(m\)\)/.test(bloco[0]),
    emp + ': não filtra o formato do mês (YYYY-MM) antes de gravar');

  const aplicar = new Function('body', 'atualApuradas',
    'const atual = { apuradas: atualApuradas };\n' + bloco[0] + '\nreturn atual.apuradas;');

  /* virada de ano: formulário só manda os 12 meses de 2026, mas 2025-11/2025-12 já apurados
     não podem sumir — o dono não vê mais esses campos pra remarcar. */
  const chaves2026 = {};
  for (let m = 1; m <= 12; m++) chaves2026['2026-' + String(m).padStart(2, '0')] = m === 1 ? 10 : null;
  const preservado = aplicar({ apuradas: ['2026-01'], aliquotas: chaves2026 }, ['2025-11', '2025-12']);
  assert.deepStrictEqual(new Set(preservado), new Set(['2025-11', '2025-12', '2026-01']),
    emp + ': salvar no ano novo apagou os meses apurados do ano anterior');

  /* dentro do MESMO ano, desmarcar continua funcionando: o formulário manda de volta só o que
     está checado, e isso tem que substituir o que estava marcado antes naquele ano */
  const substituido = aplicar({ apuradas: ['2026-01'], aliquotas: chaves2026 }, ['2026-01', '2026-02']);
  assert.deepStrictEqual(new Set(substituido), new Set(['2026-01']),
    emp + ': desmarcar apurada no mesmo ano não está removendo o mês desmarcado');
}

/* as TRÊS telas têm a caixinha, mandam a lista, e só marcam mês que TEM valor salvo */
for (const [emp, arq] of Object.entries(ARQ_TELA)) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/data-apurada="'\+/.test(html), emp + ': a tela não tem a marcação de apurada por mês');
  assert.ok(/APURADAS\.has\(/.test(html), emp + ': a tela não mostra o que já foi marcado — a marca sumiria a cada abertura');
  assert.ok(/apuradas/.test(html) && /checked && aliquotas\[c\.dataset\.apurada\] != null/.test(html),
    emp + ': a tela não envia a lista, ou marca mês SEM valor salvo — marcar um mês vazio prometeria ' +
    'uma apuração que não existe');
}

/* AMB e Girassol CACHEIAM a config num objeto CFG global — se ele perder `apuradas` no boot ou
   no pós-salvar, a marca do servidor desaparece da tela (Codex #1) */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  assert.ok(/CFG = \{[\s\S]*?apuradas: dc\.config\.apuradas\|\|\[\][\s\S]*?\};/.test(html),
    emp + ': o boot recarrega CFG sem trazer os meses apurados — some ao dar F5');
  assert.ok(/CFG=\{[\s\S]*?apuradas:d\.config\.apuradas\|\|\[\][\s\S]*?\};/.test(html),
    emp + ': o CFG pós-salvar não traz os meses apurados — o próximo salvamento apaga a marca');
}

/* AMB e Girassol: confirmar a apuração de um mês que já mostrava o valor de fábrica intocado
   também precisa virar config — senão a marca "apurada" não tem valor pra salvar (Codex #3) */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  assert.ok(/confirmaApurada/.test(html),
    emp + ': marcar apurada sobre o valor de fábrica intocado não confirma o valor (vira null e some da lista)');
}

/* a regra do aviso de pendência, exercitada com o caso real da AMB de hoje — e agora nas DUAS
   telas que a calculam (Codex #2: a Girassol calculava mas nunca mostrava) */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  const m = /window\._aliqEstimadas = Object\.keys\(CFG\.aliquotas \|\| \{\}\)\s*\n\s*\.filter\([^;]*;/.exec(html);
  assert.ok(m, emp + ': não achei o cálculo das pendências');
  assert.ok(/Ainda como <b>estimativa<\/b>/.test(html),
    emp + ': calcula as pendências mas não mostra o aviso na tela');

  const pendentes = new Function('CFG', 'APURADAS', 'const window = {};\n' + m[0] + '\nreturn window._aliqEstimadas;');
  const CFG = { aliquotas: { '2026-07': 7.5896, '2026-08': 8.40952, '2026-09': 10, '2026-10': 10 } };

  assert.deepStrictEqual(pendentes(CFG, new Set()), ['2026-07', '2026-08', '2026-09', '2026-10'],
    emp + ': sem nada marcado, TODOS os meses salvos são pendência');
  assert.deepStrictEqual(pendentes(CFG, new Set(['2026-07', '2026-08'])), ['2026-09', '2026-10'],
    emp + ': marcados jul e ago, sobram set e out — que é a lista que o dono precisa no dia 20');

  /* mês SEM valor salvo não é pendência: não há o que trocar nele */
  assert.deepStrictEqual(pendentes({ aliquotas: { '2026-11': 0 } }, new Set()), [],
    emp + ': mês sem alíquota salva não pode virar pendência — zero não é valor');
}

console.log('OK: alíquota apurada — as três guardam e mostram a marcação do dono, o aviso lista só os meses ' +
  'que faltam trocar, a confirmação sobre valor de fábrica salva, e a virada de ano não apaga os apurados antigos');
