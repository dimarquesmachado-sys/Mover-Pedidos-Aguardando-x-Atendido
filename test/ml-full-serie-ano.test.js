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
ok(/INTERROMPE a serie/.test(sem) && /relance de la/.test(sem) && /sem deploy ate terminar/.test(sem), '  o aviso diz o risco e o que fazer');
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
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
