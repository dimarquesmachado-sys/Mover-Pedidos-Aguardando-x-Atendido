/* 23/09 — RETOMADA DO #331, que ficou 562 commits pra trás.
   A noturna roda às 3:30 e faz o backfill dos últimos 3 dias. Quando o dono está rodando um MÊS
   de histórico à noite — o único horário em que pode, por causa da cota do Bling —, ela assumia
   o estado e matava a rodada dele no meio, SEM AVISO: o status passava a mostrar o período DELA
   como se fosse o dele. Aconteceu em 05/09: julho morreu aos 20 minutos.
   A noturna roda TODA noite; o mês de histórico não. Havendo backfill em curso, a etapa se
   declara PULADA informando o período ocupado, e a noite segue nas outras. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

for (const [emp, arq] of Object.entries({
  girassol: 'girassol-backup-offline/noturna.js',
  amb: 'amb-checkout-offline/amb-noturna.js',
})) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');

  /* exercita a CESSÃO DE PRODUÇÃO, recortada do arquivo — não uma cópia da regra */
  const m = /const _est = \(typeof backfillEstado === 'function'\) \? backfillEstado\(\) : null;[\s\S]*?\n      \}/.exec(s);
  assert.ok(m, emp + ': a noturna não cede — ela mata a rodada de histórico do dono no meio, sem aviso');
  const roda = (fn) => new Function('backfillEstado', 'console', m[0] + '; return null;')(fn, { log() {} });

  const cedeu = roda(() => ({ rodando: true, de: '2026-07-01', ate: '2026-07-31' }));
  assert.ok(cedeu && String(cedeu).startsWith('PULADO'),
    emp + ': a noturna NÃO cede com backfill manual em curso — foi assim que julho morreu aos 20 min');
  assert.ok(String(cedeu).includes('2026-07-01') && String(cedeu).includes('2026-07-31'),
    emp + ': cede sem dizer QUAL período está ocupando — o dono não saberia o que a bloqueou');

  assert.strictEqual(roda(() => ({ rodando: false })), null,
    emp + ': pula mesmo sem backfill rodando — a noturna deixaria de fazer o trabalho dela');
  assert.strictEqual(roda(undefined), null,
    emp + ': quebra quando a função não está disponível — a noite inteira cairia por isso');
}

/* a AMB não tinha `backfillEstado` (a Girassol ganhou no #309) — sem ela, a cessão nunca dispara */
for (const [emp, arq] of Object.entries({
  girassol: 'girassol-backup-offline/gbo-app.js',
  amb: 'amb-checkout-offline/index.js',
})) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/function backfillEstado\(\)/.test(s),
    emp + ': não expõe backfillEstado — a noturna não teria como saber que há rodada em curso');
}

console.log('OK: a noturna cede ao backfill manual nas duas empresas, dizendo qual periodo esta ocupando');
