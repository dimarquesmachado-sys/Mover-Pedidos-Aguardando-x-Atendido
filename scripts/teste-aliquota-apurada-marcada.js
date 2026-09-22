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
      anos anteriores.

   22/09 (revisão do Codex, 2ª rodada, AMB/Girassol) — os quatro consertos acima abriram três
   frestas novas:
   5) o aviso de pendência (_aliqEstimadas) varre TODOS os anos guardados, mas o formulário só
      desenha os 12 meses do ano corrente — um dezembro pendente de ano anterior virava aviso
      permanente sem checkbox nenhum pra resolver. Ganhou checkbox avulso no próprio aviso.
   6) marcar "0" e "apurada" junto passava pela regra antiga (0 != null), mas o backend trata 0
      como campo vazio e apaga a alíquota — a marca ficava sem valor nenhum por trás. A tela
      agora só aceita a marca com o mesmo intervalo que o backend aceita (0 < x ≤ 40).
   7) "editado" era decidido comparando o texto final com o defaultValue — retypar de propósito
      o MESMO número que a fábrica já mostrava virava null igual a campo nunca tocado. Virou
      dataset.tocado, ligado por oninput. */
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

/* as TRÊS telas têm a caixinha e mostram o que já foi marcado */
for (const [emp, arq] of Object.entries(ARQ_TELA)) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/data-apurada="'\+/.test(html), emp + ': a tela não tem a marcação de apurada por mês');
  assert.ok(/APURADAS\.has\(/.test(html), emp + ': a tela não mostra o que já foi marcado — a marca sumiria a cada abertura');
}

/* GOOD manda a lista pelo caminho antigo: o campo nasce vazio (nunca mostra o valor apurado do
   código dentro do input — ver teste-aliquota-fabrica.js), então "aliquotas[...] != null" já
   basta — n===0 vira null antes de chegar aqui (regra de 18/09, este mesmo arquivo abaixo). */
{
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA.good), 'utf8');
  assert.ok(/apuradas/.test(html) && /checked && aliquotas\[c\.dataset\.apurada\] != null/.test(html),
    'good: a tela não envia a lista, ou marca mês SEM valor salvo — marcar um mês vazio prometeria ' +
    'uma apuração que não existe');
}

/* AMB e Girassol: 22/09 (Codex P2, 2ª rodada) — marcar "0" e apurada junto passava pela regra
   antiga (0 != null), mas o backend trata 0 como campo vazio e apaga a alíquota (mesma regra de
   18/09 que a GOOD já tinha). A marca "apurada" tem que exigir o mesmo intervalo que o backend
   aceita (0 < x ≤ 40) — INCLUSIVE o checkbox "fora do ano": 22/09 (Codex P2, 4ª rodada) — a
   3ª rodada deu campo próprio a essas linhas (antes só tinham a caixinha), e por isso deixaram
   de ser "um valor que já sabemos válido" — o dono pode limpar ou digitar algo fora da faixa
   ali igual a qualquer outro mês, e o bypass antigo deixava a marca entrar sem alíquota
   nenhuma por trás. */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  const m = /const apuradas = (\[\.\.\.document\.querySelectorAll\('\[data-apurada\]'\)\][\s\S]*?\.map\(c => c\.dataset\.apurada\));/.exec(html);
  assert.ok(m, emp + ': não achei a expressão que monta a lista de apurados pro envio');

  /* roda a expressão INTEIRA do arquivo (filter + map), não uma cópia da regra — com um
     document.querySelectorAll fake devolvendo as caixinhas do teste */
  const montarApuradas = new Function('document', 'aliquotas', 'return ' + m[1] + ';');
  const fakeDoc = (checkboxes) => ({ querySelectorAll: () => checkboxes });

  assert.deepStrictEqual(
    montarApuradas(fakeDoc([{ checked: true, dataset: { apurada: '2026-11' } }]), { '2026-11': 0 }), [],
    emp + ': marcar apurada sobre um mês que o backend vai gravar como 0 (= vazio) não pode entrar na lista — ' +
    'a marca ficaria sem alíquota nenhuma por trás');
  assert.deepStrictEqual(
    montarApuradas(fakeDoc([{ checked: true, dataset: { apurada: '2026-11' } }]), { '2026-11': 8.4 }), ['2026-11'],
    emp + ': mês com valor aceito (0 < x ≤ 40) e marcado tem que entrar na lista');
  assert.deepStrictEqual(
    montarApuradas(fakeDoc([{ checked: false, dataset: { apurada: '2026-11' } }]), { '2026-11': 8.4 }), [],
    emp + ': checkbox desmarcada não pode entrar na lista');
  assert.deepStrictEqual(
    montarApuradas(fakeDoc([{ checked: true, dataset: { apurada: '2025-12', foraAno: '1' } }]), {}), [],
    emp + ': o checkbox "fora do ano" SEM valor aceito no campo próprio dele não pode entrar na lista — ' +
    'campo limpo ou fora da faixa apaga a alíquota no backend, e a marca ficaria sem alíquota nenhuma ' +
    'por trás (Codex P2, 4ª rodada)');
  assert.deepStrictEqual(
    montarApuradas(fakeDoc([{ checked: true, dataset: { apurada: '2025-12', foraAno: '1' } }]), { '2025-12': 8.4 }),
    ['2025-12'],
    emp + ': o checkbox "fora do ano" COM valor aceito no campo próprio dele tem que entrar na lista');
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
  /* 22/09 (Codex P2, 3ª rodada) — A LISTA VARRIA SÓ O QUE ESTAVA SALVO. As estimativas que
     vivem só na TABELA DE FÁBRICA nunca apareciam: a Girassol tem 15% de palpite em ago-dez e
     a AMB em jul-dez, e sem sobreposição no painel a lista do dia 20 dizia "nenhuma pendência"
     enquanto vários meses calculavam imposto com chute. A varredura agora é por mês EFETIVO —
     manda o salvo, se houver; senão o de fábrica — e cada origem tem a sua lista de apurados. */
  const m = /window\._aliqEstimadas = \[\.\.\._mesesComValor\][\s\S]*?\}\)\.sort\(\);/.exec(html);
  assert.ok(m, emp + ': não achei o cálculo das pendências');
  assert.ok(/Ainda como <b>estimativa<\/b>/.test(html),
    emp + ': calcula as pendências mas não mostra o aviso na tela');

  const prep = /const _mesesComValor = new Set\(\[[\s\S]*?\]\);[\s\S]*?const _mesCorrente = [^;]*;/.exec(html);
  assert.ok(prep, emp + ': não achei o preparo da varredura');
  const pendentes = (CFG, APURADAS, DEFAULT_ALIQ, hojeSP) =>
    new Function('CFG', 'APURADAS', 'DEFAULT_ALIQ', 'hojeSP',
      'const window = {};\n' + prep[0] + '\n' + m[0] + '\nreturn window._aliqEstimadas;')(CFG, APURADAS, DEFAULT_ALIQ, hojeSP);

  const hoje = () => '2026-09-22';
  const FABRICA = { '2026-07': 8.58, '2026-08': 8.82, '2026-09': 8.82, '2026-10': 8.82 };

  /* o caso que motivou o apontamento: NADA salvo no painel, tudo vindo da fábrica */
  assert.deepStrictEqual(
    pendentes({ aliquotas: {}, apuradosFabrica: [] }, new Set(), FABRICA, hoje),
    ['2026-07', '2026-08'],
    emp + ': estimativa que vive só na tabela de fábrica tem que entrar na lista — é ela que ' +
    'está calculando imposto com palpite');

  /* mês de fábrica JÁ apurado no código não é pendência */
  assert.deepStrictEqual(
    pendentes({ aliquotas: {}, apuradosFabrica: ['2026-07'] }, new Set(), FABRICA, hoje),
    ['2026-08'], emp + ': mês apurado na tabela do código não pode aparecer como pendência');

  /* o salvo VENCE a fábrica: quem decide a pendência é a marca do dono, não a do código */
  assert.deepStrictEqual(
    pendentes({ aliquotas: { '2026-07': 7.5896 }, apuradosFabrica: ['2026-07'] }, new Set(), FABRICA, hoje),
    ['2026-07', '2026-08'],
    emp + ': com valor salvo por cima, quem vale é a marcação DO DONO — a do código é de outro número');

  assert.deepStrictEqual(
    pendentes({ aliquotas: { '2026-07': 7.5896 }, apuradosFabrica: [] }, new Set(['2026-07']), FABRICA, hoje),
    ['2026-08'], emp + ': mês salvo e marcado pelo dono sai da lista');

  /* mês corrente e futuro não são pendência: não há apuração a cobrar de quem não fechou.
     (O teste precisa de uma fábrica SÓ com set/out, senão jul e ago entram pela tabela e o
     caso não isola o que quer provar — errei isso na primeira escrita e o próprio teste
     acusou.) */
  const FUTURO = { '2026-09': 8.82, '2026-10': 8.82 };
  assert.deepStrictEqual(
    pendentes({ aliquotas: { '2026-09': 10, '2026-10': 10 }, apuradosFabrica: [] }, new Set(), FUTURO, hoje),
    [], emp + ': mês em andamento ou futuro não pode ser cobrado — alarme que não se pode atender ensina a ignorar alarme');
}

/* AMB e Girassol: 22/09 (Codex P2, 2ª rodada) — a pendência de um ano que o formulário não
   desenha mais precisa de um jeito de ser resolvida, senão vira aviso permanente. Ganhou
   checkbox avulso, com marca própria (data-fora-ano) pro filtro do salvar reconhecer que aquele
   valor já é sabido válido (Codex #5). */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  assert.ok(/data-fora-ano="1"/.test(html),
    emp + ': a pendência de um mês de ano anterior não tem checkbox — fica presa no aviso pra sempre');
}

/* 22/09 (Codex P2, 3ª rodada) — O MÊS DE ANO ANTERIOR PRECISA DE CAMPO, NÃO SÓ DA CAIXINHA.
   Quando a contabilidade manda a apuração de dezembro em janeiro, o valor quase nunca é igual
   à estimativa que ficou salva. Com só a caixinha, marcar "apurada" fazia o aviso sumir e a
   ESTIMATIVA VELHA seguir calculando — o pior desfecho: o dono acha que resolveu e o número
   continua errado. E a GOOD não tinha linha nenhuma: a pendência simplesmente sumia da tela. */
for (const [emp, arq] of Object.entries(ARQ_TELA)) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/data-fora-ano="1"/.test(html),
    emp + ': não há controle pro mês de ano anterior — a pendência some da tela na virada do ano');
  assert.ok(/data-aliq="'\+mm\+'" data-fora-ano="1"|data-fora-ano="1" value="'\+esc\(aliq\[k\]\)/.test(html),
    emp + ': o mês de ano anterior tem só a caixinha, sem campo de valor — marcar "apurada" faria ' +
    'o aviso sumir com a estimativa velha ainda calculando o imposto');
}

/* e o salvar das TRÊS tem que recusar alíquota fora da faixa ANTES de postar: o servidor
   ignora o valor inválido e mantém o anterior, mas o filtro tirava o mês de `apuradas` — a
   requisição voltava "ok" com a alíquota certa e a marcação apagada, sem nada avisar */
for (const [emp, arq] of Object.entries(ARQ_TELA)) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/nada foi salvo/.test(html),
    emp + ': o salvar não recusa alíquota fora da faixa antes de postar — a marcação some em silêncio');
}

/* AMB e Girassol: a faixa que o BACKEND aceita é 0 ≤ x ≤ 40 (0 é campo LIMPO, regra de 18/09 —
   ver teste-aliquota-fabrica.js e o próprio backend em index.js/gbo-app.js), não 0 < x ≤ 40.
   A primeira versão do bloqueio acima usou `> 0`, e isso barrava o SALVAMENTO INTEIRO (não só o
   mês) sempre que qualquer mês tivesse 0 digitado — mesmo sendo a forma normal de apagar uma
   alíquota salva por este mesmo botão. */
for (const emp of ['amb', 'girassol']) {
  const html = fs.readFileSync(path.join(raiz, ARQ_TELA[emp]), 'utf8');
  const bloco = /const _foraDoIntervalo = Object\.keys\(aliquotas\)\s*\n\s*\.filter\([^;]*;/.exec(html);
  assert.ok(bloco, emp + ': não achei a validação de faixa antes de montar apuradas/postar');

  const foraDoIntervalo = new Function('aliquotas', bloco[0] + '\nreturn _foraDoIntervalo;');

  assert.deepStrictEqual(foraDoIntervalo({ '2026-01': 0, '2026-02': 8.4, '2026-03': null }), [],
    emp + ': 0 é a forma normal de LIMPAR uma alíquota salva (18/09) — não pode bloquear o salvamento inteiro');
  assert.deepStrictEqual(foraDoIntervalo({ '2026-01': 40 }), [],
    emp + ': 40 é o EXTREMO aceito pelo backend — não pode ser tratado como inválido');
  assert.deepStrictEqual(foraDoIntervalo({ '2026-01': 41, '2026-02': -1, '2026-03': 8.4 }), ['2026-01', '2026-02'],
    emp + ': 41 e -1 estão fora da faixa que o backend aceita — têm que bloquear o salvamento');
}

console.log('OK: alíquota apurada — as três guardam e mostram a marcação do dono, o aviso lista só os meses ' +
  'que faltam trocar (com jeito de resolver pendência de ano anterior), a confirmação sobre valor de fábrica ' +
  'salva mesmo retypando o mesmo número, marcar apurada exige o mesmo intervalo que o backend aceita, e a ' +
  'virada de ano não apaga os apurados antigos');
