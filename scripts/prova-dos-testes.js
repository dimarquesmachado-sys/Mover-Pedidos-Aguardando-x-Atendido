#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════════════════
   PROVA DOS TESTES — "o teste pega o bug que ele promete pegar?"

   POR QUE EXISTE. Em 04/10 escrevi, no mesmo dia, TRÊS testes que ficavam verdes sem
   proteger nada:
     · uma asserção que NUNCA podia falhar (`!a || b`, com os dois lados sempre verdadeiros);
     · uma que contava chaves `{}` pra inferir escopo e acusava código CORRETO (contava chave
       dentro de string e de comentário);
     · um filtro que descartava justamente a linha que deveria vigiar.
   Nos três eu tratei VERDE como prova. Verde só diz que a verificação não encontrou violação
   — não diz que ela conseguiria encontrar.

   O QUE ESTA FERRAMENTA GARANTE, e o que não garante: ela demonstra que AQUELE teste, NESTA
   versão, detecta AQUELE defeito reintroduzido. Não garante que detectaria outras formas do
   mesmo bug no futuro.

   CUIDADOS QUE A FERRAMENTA TOMA (cada um corresponde a uma forma de se enganar):
     1. CONTROLE POSITIVO: o teste tem que passar no código correto. Teste que falha sempre
        "detectaria" qualquer mutação e não valeria nada.
     2. NÃO ACEITA QUALQUER VERMELHO: erro de sintaxe, módulo quebrado ou timeout NÃO contam
        como detecção — isso provaria só que eu quebrei a execução. A mutação precisa derrubar
        uma ASSERÇÃO (procura `AssertionError`/`ERR_ASSERTION` na saída).
     3. MUTAÇÃO EM CÓPIA: nada é alterado no diretório de trabalho; a árvore inteira é copiada
        pra uma pasta temporária e a mutação acontece lá.
     4. PROCESSO SEPARADO por mutação: cache de módulo e estado global não vazam entre casos.
     5. PONTO DE MUTAÇÃO SUMIU = FALHA, não "ok". Se o trecho não existe mais (ou aparece mais
        de uma vez), o registro está desatualizado e precisa de atenção — silenciar isso seria
        recriar o problema original.
   ════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

/* Cada registro: o teste, o arquivo que ele vigia, e o DEFEITO REAL que já aconteceu.
   `de` tem que casar EXATAMENTE uma vez no arquivo. */
/* Codex #595 (P2): o teste de localização vigia TRÊS painéis; mutar só o da Girassol deixaria
   AMB e GOOD sem prova (se o caso deles saísse de `TELAS`, tudo seguia verde). Um registro por
   painel, e `espera` leva o NOME da empresa — a asserção que cai tem que ser a DAQUELE painel. */
const PAINEIS_LOC = [
  ['Girassol', 'girassol-backup-offline/painel.html'],
  ['AMB', 'amb-checkout-offline/painel.html'],
  ['GOOD', 'good-checkout-offline/painel.html'],
];

const REGISTROS = [
  ...PAINEIS_LOC.map(([emp, arquivo]) => ({
    teste: 'scripts/teste-loc-mostra-motivo.js',
    arquivo,
    defeito: emp + ': a tela volta a engolir o motivo da falha (o estoquista fica sem saber se adianta repetir)',
    espera: emp + ': salvarLocForce voltou a engolir o motivo',
    de: "const motivo = (r && r.erro) ? r.erro : (_erro || 'não consegui falar com o servidor');",
    para: "const motivo = 'erro';",
  })),
  {
    teste: 'scripts/teste-ferramentas-custo-lib.js',
    arquivo: 'lib/checkout/painel-ferramentas-custo.js',
    defeito: 'tratar a LISTA de pares como mapa (a tabela mostraria índices no lugar dos SKUs)',
    espera: 'faltam os pares na tabela',
    de: 'var pares = Array.isArray(d.pares) ? d.pares : [];',
    para: 'var pares = Object.keys(d.pares || {});',
  },
  {
    teste: 'scripts/teste-amb-copia-removida.js',
    arquivo: 'amb-checkout-offline/index.js',
    defeito: 'rota removida volta a ser declarada como própria (a fábrica cede a vez pra ninguém)',
    espera: 'cede a vez',
    de: 'rotasProprias: [',
    para: "rotasProprias: ['varrer-cancelados-status', ",
  },
];

function rodar(teste, dir) {
  const r = spawnSync(process.execPath, [path.join(dir, teste)], {
    cwd: dir, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { ADMIN_KEY: process.env.ADMIN_KEY || 'prova' }),
  });
  const saida = String(r.stdout || '') + String(r.stderr || '');
  return { codigo: r.status, saida, porAssercao: /AssertionError|ERR_ASSERTION/.test(saida) };
}

function copiarArvore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prova-'));
  /* copia só o necessário; node_modules vai por link pra não custar minutos */
  for (const item of fs.readdirSync(RAIZ)) {
    if (item === 'node_modules' || item === '.git') continue;
    fs.cpSync(path.join(RAIZ, item), path.join(tmp, item), { recursive: true });
  }
  try { fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(tmp, 'node_modules'), 'dir'); }
  catch (e) { /* sem node_modules: os testes que não precisam seguem */ }
  return tmp;
}

(function principal() {
  const alvo = process.argv[2];                 /* opcional: rodar um teste só */
  const registros = alvo ? REGISTROS.filter((r) => r.teste.includes(alvo)) : REGISTROS;
  if (!registros.length) { console.error('nenhum registro casou com ' + alvo); process.exit(1); }

  let falhas = 0;
  for (const reg of registros) {
    const nome = path.basename(reg.teste);

    /* ── CONTROLE POSITIVO: verde no código correto ─────────────────────────────────── */
    const bom = rodar(reg.teste, RAIZ);
    if (bom.codigo !== 0) {
      console.log('✗ ' + nome + ' — JÁ FALHA no código correto; a prova não vale nada assim');
      falhas++;
      continue;
    }

    /* ── MUTAÇÃO em cópia, processo separado ────────────────────────────────────────── */
    const tmp = copiarArvore();
    try {
      const alvoArq = path.join(tmp, reg.arquivo);
      const texto = fs.readFileSync(alvoArq, 'utf8');
      const quantas = texto.split(reg.de).length - 1;
      if (quantas !== 1) {
        console.log('✗ ' + nome + ' — o ponto de mutação ' +
          (quantas === 0 ? 'SUMIU' : 'aparece ' + quantas + '×') + ': o registro está ' +
          'desatualizado e precisa ser revisto (não é "ok")');
        falhas++;
        continue;
      }
      fs.writeFileSync(alvoArq, texto.replace(reg.de, reg.para));

      const mau = rodar(reg.teste, tmp);
      if (mau.codigo === 0) {
        console.log('✗ ' + nome + ' — NÃO PEGA: ' + reg.defeito);
        falhas++;
      } else if (!mau.porAssercao) {
        /* vermelho por sintaxe/módulo/timeout não é detecção */
        console.log('✗ ' + nome + ' — ficou vermelho, mas NÃO por asserção (' +
          mau.saida.trim().split('\n').pop().slice(0, 70) + '); isso prova só que eu quebrei ' +
          'a execução');
        falhas++;
      } else if (reg.espera && mau.saida.indexOf(reg.espera) < 0) {
        /* ⚠️ VERMELHO PELA ASSERÇÃO ERRADA. Medido aqui: ao quebrar a sintaxe de propósito, o
           teste caiu — mas pela asserção que confere se o script COMPILA, não pela que protege
           o defeito registrado. Contar isso como "pega" seria falsa segurança: o bug de verdade
           (lista tratada como mapa) poderia voltar sem ninguém ver. Por isso cada registro diz
           QUAL asserção tem que cair. */
        console.log('✗ ' + nome + ' — caiu pela asserção ERRADA: esperava "' + reg.espera +
          '" e não veio. Pegou outra coisa, não o defeito registrado');
        falhas++;
      } else {
        console.log('✓ ' + nome + ' — pega: ' + reg.defeito);
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('');
  if (falhas) {
    console.log('✗✗✗ ' + falhas + ' teste(s) não provam o que prometem — verde deles não é prova');
    process.exit(1);
  }
  console.log('✓ todos os testes registrados FALHAM quando o bug volta');
  process.exit(0);
})();
