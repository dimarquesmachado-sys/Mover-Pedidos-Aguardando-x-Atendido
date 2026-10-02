'use strict';
// A serie encadeada do motor ML Full aceita ate UM ANO (era 31 dias). Pedido do
// dono (02/10): "temos como fazer essa puxada da Girassol do ano todo?". O teto
// segurava so a duracao; pedacos, retry e respiro ja aguentam. Serie longa vive
// em memoria: a resposta AVISA que deploy/reinicio no meio interrompe.
const fs = require('fs');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
const sem = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

ok(/const MAX_DIAS_SERIE = 366;/.test(sem), '⚠️ teto da serie: 366 dias');
ok(/\(tAte - tDe\) >= MAX_DIAS_SERIE \* 86400000/.test(sem), '  a validacao usa o teto');
ok(!/>= 31 \* 86400000\) \{/.test(sem), '  o 31 cravado na validacao sumiu');
ok(/no m.ximo ' \+ MAX_DIAS_SERIE \+ ' dias corridos na s.rie \(um ano\)/.test(sem), '  a mensagem de erro diz o teto novo');
ok(/aviso_serie_longa/.test(sem) && /\(tAte - tDe\) >= 31 \* 86400000 \?/.test(sem), '⚠️ serie > 31 dias: a resposta traz aviso_serie_longa (deploy/reinicio interrompe; status mostra onde parou)');
ok(/INTERROMPE a serie/.test(sem) && /como_retomar/.test(sem) && /sem deploy ate terminar/.test(sem), '  o aviso diz o risco e o que fazer (e e VERDADEIRO: o progresso esta em disco)');
ok(/ml-full b5/.test(src), '  versao b5');
// a conta dos pedacos: um ano com passo 2 = 183 pedacos (nao estoura nada)
{
  const DIA = 86400000;
  const tDe = Date.UTC(2026, 0, 1), tAte = Date.UTC(2026, 11, 31);
  const passo = 2; let n = 0;
  for (let t = tDe; t <= tAte; t += passo * DIA) n++;
  ok(n === 183, `  ano inteiro com passo 2 = ${n} pedacos`);
  ok((tAte - tDe) < 366 * DIA, '  01/01 -> 31/12 passa no teto de 366');
  ok(!((Date.UTC(2026, 6, 1) - Date.UTC(2025, 0, 1)) < 366 * DIA), '  ano e meio NAO passa');
}
// Codex #563 (P2): a serie persiste em disco; depois do reinicio o status mostra INTERROMPIDA e como retomar
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-serie-'));
  process.env.ML_FULL_DIR = dir;
  delete require.cache[require.resolve('../ml-full.js')];
  const mf = require('../ml-full.js');
  const I = mf._interno || {};
  ok(typeof I._salvarSerie === 'function' && typeof I._lerSerieDoDisco === 'function', '  _salvarSerie e _lerSerieDoDisco exportados pra teste');
  if (I._salvarSerie) {
    // simula uma serie que estava RODANDO quando o processo morreu, com 2 pedacos feitos
    I._salvarSerie('girassol', { rodando: true, comecou: 'x', terminou: null, pedacos: 183, feitos: 2, passo: 2, teto: 200, respiro_s: 60,
      total_ja_no_bling: 3, total_pendentes_novas: 0, total_nao_conferidas: 0,
      resultados: [{ de: '20260101', ate: '20260102', ok: true }, { de: '20260103', ate: '20260104', ok: true }], erro: null });
    const lido = I._lerSerieDoDisco('girassol');
    ok(lido && lido.interrompida === true && lido.rodando === false, '⚠️ serie "rodando" no disco + memoria vazia = INTERROMPIDA (o processo morreu)');
    ok(lido && lido.ultimo_pedaco_feito === '20260103→20260104', '  ultimo pedaco feito vem do disco');
    ok(lido && /relance a serie de 20260104 em diante/.test(lido.como_retomar), '  como_retomar diz de onde relancar');
    // serie que TERMINOU: nao e interrompida
    I._salvarSerie('amb', { rodando: false, terminou: 'y', pedacos: 2, feitos: 2, resultados: [{ de: 'a', ate: 'b', ok: true }] });
    ok(I._lerSerieDoDisco('amb') && !I._lerSerieDoDisco('amb').interrompida, '  serie terminada no disco NAO e interrompida');
    ok(I._lerSerieDoDisco('good') === null, '  empresa sem arquivo: null');
    // arquivo corrompido: null, nao lanca
    fs.writeFileSync(path.join(dir, 'ml-full-serie-good.json'), '{ quebrado');
    ok(I._lerSerieDoDisco('good') === null, '  arquivo corrompido: null (nunca lanca)');
    // o checkpoint e gravado a cada pedaco e no fim (fonte)
    ok(/_salvarSerie\(empresa, st\);   \/\/ b5: checkpoint por pedaco/.test(src), '  checkpoint a cada pedaco');
    ok(/finally \{ st\.rodando = false; st\.terminou = new Date\(\)\.toISOString\(\); _salvarSerie\(empresa, st\); \}/.test(src), '  e no fim');
    ok(/const st = _serie\[empresa\] \|\| _lerSerieDoDisco\(empresa\) \|\| null;/.test(src), '  o status le do disco quando a memoria esta vazia');
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
