#!/usr/bin/env node
// ═══ VERIFICADOR DE INTEGRIDADE — Mover-Pedidos ═══════════════════════════════
// Roda a cada push (GitHub Action). Pega os erros clássicos do deploy via colar:
//  1. Sintaxe quebrada em qualquer .js (arquivo colado pela metade)
//  2. Sintaxe quebrada no <script> dos painéis
//  3. Módulo espelhado divergindo dos irmãos (colou o arquivo da empresa errada / versão velha)
//  4. Feature sumindo de uma cópia (assinaturas — colou um painel/index desatualizado)
// Config: .github/espelhos.json  (gerada a partir do estado válido do repo)
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const RAIZ = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, '.github', 'espelhos.json'), 'utf8'));
let erros = 0, avisos = 0;
const falha = m => { console.log('  ✗ ' + m); erros++; };
const ok    = m => console.log('  ✓ ' + m);

// ── 1) node --check em todos os .js ──
console.log('\n═ 1. Sintaxe de todos os .js ═');
function anda(dir, saida) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) anda(p, saida);
    else if (e.name.endsWith('.js')) saida.push(p);
  }
}
const js = []; anda(RAIZ, js);
let ruins = 0;
for (const f of js) {
  const r = cp.spawnSync('node', ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { falha(path.relative(RAIZ, f) + ' — SINTAXE QUEBRADA:\n      ' + String(r.stderr).split('\n')[0]); ruins++; }
}
if (!ruins) ok(js.length + ' arquivos .js com sintaxe válida');

// ── 2) <script> dos painéis ──
console.log('\n═ 2. JavaScript dos painéis ═');
for (const m of cfg.modulos) {
  const p = path.join(RAIZ, m, 'painel.html');
  if (!fs.existsSync(p)) { falha(m + '/painel.html NÃO EXISTE'); continue; }
  const blocos = [...fs.readFileSync(p, 'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  const maior = blocos.sort((a, b) => b.length - a.length)[0] || '';
  const tmp = path.join(os.tmpdir(), 'chk-' + m + '.js');
  fs.writeFileSync(tmp, maior);
  const r = cp.spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  if (r.status !== 0) falha(m + '/painel.html — JS QUEBRADO: ' + String(r.stderr).split('\n')[0]);
  else ok(m + '/painel.html JS válido');
}

// ── 3) espelhos ──
console.log('\n═ 3. Módulos espelhados ═');
function norm(m, f) {
  let s = fs.readFileSync(path.join(RAIZ, m, f), 'utf8');
  for (const [pat, rep] of cfg.tokens) s = s.replace(new RegExp(pat, 'gi'), rep);
  const igs = (cfg.ignorar_linhas || {})[f] || [];
  if (igs.length) s = s.split('\n').map(l => igs.some(p => new RegExp(p, 'i').test(l)) ? '__IGN__' : l).join('\n');
  return s;
}
const [G, O, A] = cfg.modulos;
for (const f of cfg.identicos) {
  try {
    const [a, b, c] = [norm(G, f), norm(O, f), norm(A, f)];
    if (a === b && b === c) ok(f + ' idêntico nas 3 empresas');
    else {
      const quem = a !== b ? (O) : (A);
      falha(f + ' DIVERGIU (' + quem + ' difere) — colou o arquivo certo na pasta certa?');
    }
  } catch (e) { falha(f + ' — ' + e.message); }
}
for (const f of cfg.identicos_gir_good) {
  try {
    if (norm(G, f) === norm(O, f)) ok(f + ' idêntico girassol↔good (amb tem divergência conhecida)');
    else falha(f + ' DIVERGIU entre girassol e good — colou o arquivo certo?');
  } catch (e) { falha(f + ' — ' + e.message); }
}

// ── 4) assinaturas de features ──
console.log('\n═ 4. Paridade de features (assinaturas) ═');
for (const [f, sigs] of Object.entries(cfg.assinaturas || {})) {
  for (const m of cfg.modulos) {
    const p = path.join(RAIZ, m, f);
    if (!fs.existsSync(p)) { falha(m + '/' + f + ' NÃO EXISTE'); continue; }
    const s = fs.readFileSync(p, 'utf8');
    const faltam = sigs.filter(x => !s.includes(x));
    if (faltam.length) falha(m + '/' + f + ' SEM as features: ' + faltam.join(', ') + ' — versão desatualizada colada?');
  }
}
if (!erros) console.log('  ✓ todas as features presentes nas 3 empresas');

// ── 5) identidade: o arquivo colado é da EMPRESA CERTA? ──
// (pega o erro clássico: colar o painel da Girassol na pasta da GOOD — features iguais, rotas erradas)
console.log('\n═ 5. Identidade dos arquivos (empresa certa na pasta certa) ═');
let idErr = 0;
for (const m of cfg.modulos) {
  for (const f of ['painel.html', 'index.js']) {
    const p = path.join(RAIZ, m, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (!s.includes('/' + m + '/')) { falha(m + '/' + f + ' NÃO referencia as rotas do próprio módulo — arquivo de outra empresa colado aqui?'); idErr++; }
    for (const outro of cfg.modulos) {
      if (outro !== m && s.includes('/' + outro + '/')) { falha(m + '/' + f + ' contém rotas de ' + outro + ' — colou o arquivo da empresa ERRADA!'); idErr++; }
    }
  }
}
if (!idErr) console.log('  ✓ cada arquivo está na pasta da sua empresa');

console.log('\n' + (erros ? '✗✗✗ ' + erros + ' PROBLEMA(S) — NÃO deixe assim em produção!' : '✓✓✓ TUDO CERTO — deploy consistente.'));
process.exit(erros ? 1 : 0);
