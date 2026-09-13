'use strict';
/* 13/09 — PORTE da renovação proativa (decisão do dono: "uma tem, agora ambas têm").
   A Girassol guardava QUANDO o token vence e renovava 5 min antes; AMB e GOOD gastavam uma
   chamada de sonda no Bling a CADA operação pra descobrir a mesma coisa. Numa casa onde a
   cota do Bling já deixou a bipagem do galpão sem pedido, isso é chamada economizada o dia
   inteiro — não é elegância.
   O teste guarda as três pontas do porte, porque meia implementação é pior que nenhuma:
   gravar o vencimento, usá-lo, e passar o expires_in em TODA renovação (sem isso o campo
   nunca nasce e a economia não acontece). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const emp of ['ambtotal', 'good', 'girassol']) {
  const s = fs.readFileSync(path.join(__dirname, '..', emp, 'tokenManager.js'), 'utf8');

  assert.ok(/expira_em = Date\.now\(\) \+ \(Number\(expires_in\)/.test(s),
    emp + ': salvarTokens tem que gravar o vencimento');
  assert.ok(/expira_em\b[\s\S]{0,400}MARGEM/.test(s),
    emp + ': tem que existir o caminho rápido que renova antes de vencer');

  /* a ponta que se esquece: se alguma renovação não repassar expires_in, o campo some na
     próxima gravação e a empresa volta a sondar a cada uso, em silêncio. */
  const chamadas = s.match(/salvarTokens\([^)]*\)/g) || [];
  const gravacoes = chamadas.filter(c => /data\.access_token/.test(c));
  assert.ok(gravacoes.length >= 2, emp + ': esperava ao menos 2 gravações de token, achei ' + gravacoes.length);
  for (const c of gravacoes) {
    assert.ok(/expires_in/.test(c), emp + ': renovação sem expires_in — o vencimento não seria guardado: ' + c);
  }
}

console.log('OK: renovação proativa nas TRÊS — vencimento gravado, caminho rápido presente e expires_in repassado em toda renovação');
