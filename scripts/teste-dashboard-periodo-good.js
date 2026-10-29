'use strict';
/* 28/10 — o PERÍODO LIVRE e os AVISOS DO SERVIDOR na tela única (as três empresas). Este teste conferia a tela VELHA da
   GOOD (guardada como reserva desde a troca de 14/10, e que saiu agora). A auditoria antes de apagar mostrou que a tela
   única NÃO tinha três coisas que a velha tinha (Codex #551 e #564) — e elas vieram pra tela única, pras três:
   · de/até INVERTIDOS no período livre trocam de verdade (na busca, no estado e nos campos) — antes viravam busca vazia;
   · o servidor lê no máximo 60.000 linhas do período (das mais antigas pras mais novas) e AVISA o corte — a tela agora
     mostra (sem isso, os totais omitiam as vendas mais recentes em silêncio);
   · imposto recalculado e margem reconstruída na leitura viram aviso (o número muda e a tela diz por quê).
   E o que a velha conferia e a única já tinha: o período livre com as duas datas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./_tela-empresa');

for (const emp of ['girassol', 'ambtotal', 'good']) {
  const html = T.telaDaEmpresa(emp);
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.ok(/\['custom','Período…'\]/.test(js), emp + ': sumiu o período livre da lista de períodos');
  assert.ok(/type="date" id="pDe"/.test(js) && /type="date" id="pAte"/.test(js), emp + ': o período livre perdeu os campos de data');
  assert.ok(/else \{ de = pDe; ate = pAte; if\(de > ate\)\{ const t = de; de = ate; ate = t; \} \}/.test(js), emp + ': datas invertidas no período livre não são trocadas na busca');
  assert.ok(/if\(p === 'custom' && pDe && pAte && pDe > pAte\)\{ const t = pDe; pDe = pAte; pAte = t;/.test(js), emp + ': datas invertidas não são trocadas no estado (os campos seguiriam invertidos)');
  assert.ok(/if\(d\.truncado\) _av\.push\(/.test(js), emp + ': o aviso de período cortado (60.000 linhas) não chega na tela');
  assert.ok(/Number\(_t\.impostos_recalculados\)>0/.test(js) && /Number\(_t\.margens_reconstruidas\)>0/.test(js), emp + ': os avisos de imposto recalculado / margem reconstruída não chegam na tela');
  /* o aviso entra DEPOIS de o histórico ser aceito (HIST = d) e no lugar dos avisos do histórico */
  const iH = js.indexOf("HIST = d; _histFalhou = null; if(el) el.innerHTML='';"), iA = js.indexOf('if(d.truncado) _av.push(');
  assert.ok(iH > 0 && iA > iH && iA - iH < 1500, emp + ': o aviso não está logo depois do histórico aceito');
}
const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');
assert.ok(/truncado: offset >= 60000/.test(srv), 'o servidor não sinaliza o corte de 60.000 linhas');
console.log('OK: período livre e avisos do servidor na tela única das três (datas invertidas trocam; corte de 60.000 avisa)');
