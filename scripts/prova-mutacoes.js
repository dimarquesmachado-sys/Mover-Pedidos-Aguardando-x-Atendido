#!/usr/bin/env node
'use strict';
/* 15/11 — PROVA DE MUTAÇÕES VERSIONADA (auditoria geral do Codex de 15/11/2026, P3 nº 1).

   Todo PR deste repo prova os testes por MUTAÇÃO: reintroduz o defeito (ou tira a proteção) e exige que o teste caia. Até
   hoje os roteiros dessas mutações (`mut-*.py`) viviam na pasta de rascunho de quem escrevia o PR — a prova acontecia uma
   vez e sumia; ninguém conseguia repetir, e um refactor podia desarmar a proteção sem que nada avisasse.

   Agora os roteiros são FIXTURES versionadas (scripts/fixtures/mutacoes/*.json) e este script as roda:
     · uma CÓPIA da árvore (node_modules por link), uma mutação por vez, processo separado, arquivo restaurado depois;
     · a mutação tem que estar EXATAMENTE uma vez no arquivo — sumiu ou duplicou = registro desatualizado = ✗ (não "ok");
     · vermelho só conta se for por ASSERÇÃO/FALHOU ou erro de EXECUÇÃO do código mutado (sintaxe quebrada, módulo que
       não carrega ou timeout não provam nada);
     · controle positivo: antes das mutações de um arquivo, os testes dele passam no código correto.
   Saída: ✓ pega / ✗ ESCAPOU / ✗ desatualizada / ✗ não conclusiva, e o resumo. Código 1 se qualquer ✗.

   Uso: node scripts/prova-mutacoes.js [nome-da-fixture] [--so=trecho-do-nome-da-mutação]
   Custa minutos (são centenas de mutações): o lugar dele é o job dedicado (.github/workflows/mutacoes.yml) e a mão de
   quem mexe numa proteção. A bateria (verifica.js) só confere que as fixtures continuam CASANDO com o código
   (scripts/teste-prova-mutacoes.js) — isso é barato e acusa o registro que ficou pra trás. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(RAIZ, 'scripts', 'fixtures', 'mutacoes');
const TIMEOUT_MS = parseInt(process.env.MUTACOES_TIMEOUT_MS || '', 10) > 0 ? parseInt(process.env.MUTACOES_TIMEOUT_MS, 10) : 180000;

function carregar(dir, so) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    if (so && path.basename(f, '.json') !== so) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!d || !Array.isArray(d.mutacoes) || !d.mutacoes.length) throw new Error(f + ': fixture sem `mutacoes`');
    for (const m of d.mutacoes) {
      for (const k of ['nome', 'arquivo', 'de', 'para']) if (typeof m[k] !== 'string' || !m[k].length && k !== 'para') throw new Error(f + ': mutação sem `' + k + '`: ' + JSON.stringify(m).slice(0, 80));
      m.testes = (Array.isArray(m.testes) && m.testes.length ? m.testes : d.testes) || [];
      if (!m.testes.length) throw new Error(f + ': mutação "' + m.nome + '" sem teste que a vigie');
    }
    out.push({ nome: path.basename(f, '.json'), origem: d.origem || '', mutacoes: d.mutacoes });
  }
  return out;
}

/* a mutação casa UMA vez no arquivo? (barato — é o que a bateria confere a cada push) */
function conferirAncoras(raiz, fixtures) {
  const problemas = [];
  for (const fx of fixtures) for (const m of fx.mutacoes) {
    const p = path.join(raiz, m.arquivo);
    if (!fs.existsSync(p)) { problemas.push(fx.nome + ' › ' + m.nome + ': o arquivo ' + m.arquivo + ' não existe'); continue; }
    const n = fs.readFileSync(p, 'utf8').split(m.de).length - 1;
    if (n !== 1) problemas.push(fx.nome + ' › ' + m.nome + ': o trecho ' + (n === 0 ? 'SUMIU de ' : 'aparece ' + n + '× em ') + m.arquivo);
    for (const t of m.testes) if (!fs.existsSync(path.join(raiz, t))) problemas.push(fx.nome + ' › ' + m.nome + ': o teste ' + t + ' não existe');
  }
  return problemas;
}

function rodarTeste(dir, teste) {
  const r = spawnSync(process.execPath, [path.join(dir, teste)], { cwd: dir, encoding: 'utf8', timeout: TIMEOUT_MS, env: Object.assign({}, process.env, { ADMIN_KEY: process.env.ADMIN_KEY || 'prova' }) });
  const saida = String(r.stdout || '') + String(r.stderr || '');
  const travou = r.error && r.error.code === 'ETIMEDOUT';
  /* o que CONTA como detecção: asserção/FALHOU do teste, ou o teste derrubado por um erro de EXECUÇÃO do código mutado
     (TypeError, Error lançado…) — é o teste exercitando o caminho estragado. O que NÃO conta: módulo que não carrega e
     sintaxe quebrada (prova só que a mutação quebrou o arquivo, não que o teste vigia o comportamento). */
  const quebrouCarga = /Cannot find module|SyntaxError|ERR_REQUIRE|ReferenceError: .* is not defined\n\s+at Object\.<anonymous>/.test(saida);
  return { codigo: travou ? null : r.status, travou, saida, porAssercao: /AssertionError|ERR_ASSERTION|FALHOU/.test(saida), porErro: !quebrouCarga && /\w*Error\b/.test(saida) };   /* TypeError, RangeError, Error… */
}

function copiarArvore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutacoes-'));
  for (const item of fs.readdirSync(RAIZ)) {
    if (item === 'node_modules' || item === '.git') continue;
    fs.cpSync(path.join(RAIZ, item), path.join(tmp, item), { recursive: true });
  }
  try { fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(tmp, 'node_modules'), 'dir'); } catch (e) {}
  return tmp;
}

/* roda as mutações numa cópia; devolve o relatório. `opts.rodar` só pra teste (troca o executor) */
function provar(fixtures, opts) {
  const o = opts || {};
  const log = o.log || ((m) => console.log(m));
  const tmp = o.dir || copiarArvore();
  const executar = o.rodar || ((teste) => rodarTeste(tmp, teste));
  const rel = { pegas: 0, escaparam: [], desatualizadas: [], inconclusivas: [], controle: [] };
  try {
    for (const fx of fixtures) {
      log('── ' + fx.nome + (fx.origem ? ' — ' + fx.origem : '') + ' (' + fx.mutacoes.length + ')');
      /* controle positivo: os testes desta fixture passam no código correto */
      const testesFx = Array.from(new Set(fx.mutacoes.flatMap((m) => m.testes)));
      let controleOk = true;
      for (const t of testesFx) { const r = executar(t); if (r.codigo !== 0) { controleOk = false; rel.controle.push(fx.nome + ': ' + t + ' JÁ FALHA no código correto' + (r.travou ? ' (travou)' : '')); log('✗ controle: ' + t + ' falha no código correto — as mutações desta fixture não valem'); } }
      if (!controleOk) continue;
      for (const m of fx.mutacoes) {
        if (o.so && !m.nome.includes(o.so)) continue;
        const p = path.join(tmp, m.arquivo);
        if (!fs.existsSync(p)) { rel.desatualizadas.push(fx.nome + ' › ' + m.nome + ' (arquivo sumiu)'); log('✗ desatualizada: ' + m.nome + ' — ' + m.arquivo + ' não existe'); continue; }
        const original = fs.readFileSync(p, 'utf8');
        const n = original.split(m.de).length - 1;
        if (n !== 1) { rel.desatualizadas.push(fx.nome + ' › ' + m.nome + (n === 0 ? ' (trecho sumiu)' : ' (trecho ' + n + '×)')); log('✗ desatualizada: ' + m.nome + ' — o trecho ' + (n === 0 ? 'sumiu' : 'aparece ' + n + '×')); continue; }
        fs.writeFileSync(p, original.replace(m.de, m.para));
        try {
          let veredito = null;
          if (p.endsWith('.js')) { const c = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' }); if (c.status !== 0) veredito = { tipo: 'inconclusiva', por: 'a mutação não compila' }; }
          if (!veredito) {
            for (const t of m.testes) {
              const r = executar(t);
              if (r.codigo === 0) continue;
              if (r.travou) { veredito = { tipo: 'inconclusiva', por: t + ' travou (timeout)' }; break; }
              if (!r.porAssercao && !r.porErro) { veredito = { tipo: 'inconclusiva', por: t + ' caiu sem asserção nem erro de execução (' + r.saida.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 120) + ')' }; break; }
              veredito = { tipo: 'pegou', por: t + (r.porAssercao ? '' : ' (por erro de execução)') }; break;
            }
          }
          if (!veredito) { rel.escaparam.push(fx.nome + ' › ' + m.nome); log('✗ ESCAPOU: ' + m.nome); }
          else if (veredito.tipo === 'inconclusiva') { rel.inconclusivas.push(fx.nome + ' › ' + m.nome + ': ' + veredito.por); log('✗ não conclusiva: ' + m.nome + ' — ' + veredito.por); }
          else { rel.pegas++; log('✓ pega: ' + m.nome + ' → ' + path.basename(veredito.por)); }
        } finally { fs.writeFileSync(p, original); }
      }
    }
  } finally { if (!o.dir) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} } }
  rel.ok = !rel.escaparam.length && !rel.desatualizadas.length && !rel.inconclusivas.length && !rel.controle.length;
  return rel;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const so = (args.find((a) => a.startsWith('--so=')) || '').slice(5) || null;
  const nome = args.find((a) => !a.startsWith('--')) || null;
  const fixtures = carregar(DIR, nome);
  if (!fixtures.length) { console.error('nenhuma fixture' + (nome ? ' chamada ' + nome : '') + ' em ' + DIR); process.exit(1); }
  const t0 = Date.now();
  const rel = provar(fixtures, { so });
  const total = rel.pegas + rel.escaparam.length + rel.desatualizadas.length + rel.inconclusivas.length;
  console.log('\n' + total + ' mutação(ões) em ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + rel.pegas + ' pega(s)' +
    (rel.escaparam.length ? ', ' + rel.escaparam.length + ' ESCAPARAM (' + rel.escaparam.join('; ').slice(0, 400) + ')' : '') +
    (rel.desatualizadas.length ? ', ' + rel.desatualizadas.length + ' desatualizada(s) (' + rel.desatualizadas.join('; ').slice(0, 400) + ')' : '') +
    (rel.inconclusivas.length ? ', ' + rel.inconclusivas.length + ' não conclusiva(s) (' + rel.inconclusivas.join('; ').slice(0, 400) + ')' : '') +
    (rel.controle.length ? ', controle: ' + rel.controle.join('; ').slice(0, 300) : ''));
  console.log(rel.ok ? '✓ todas as mutações registradas são pegas pelos testes' : '✗✗✗ há proteção que não prova o que promete (ou registro pra revisar)');
  process.exit(rel.ok ? 0 : 1);
}

module.exports = { carregar, conferirAncoras, provar, rodarTeste, DIR };
