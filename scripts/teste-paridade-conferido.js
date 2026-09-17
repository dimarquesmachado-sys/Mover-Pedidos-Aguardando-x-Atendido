'use strict';
/* 16/09 — PORTE DE CAPACIDADE achado ao medir a 5ª fatia do passo 4: a AMB e a Girassol
   gravavam o `nf_id` na conferência do pedido e a GOOD não. O efeito era invisível no
   backend e visível na tela: o link ↗ que abre a NF no Bling nunca aparecia no painel nem no
   dashboard da GOOD, porque o front já sabia desenhar (`if(!souAdmin() || !p.nf_id) return ''`)
   e simplesmente nunca recebia o dado.
   Não é diferença de operação — é capacidade que ficou pra trás, e a regra da casa é clara:
   uma tem, agora ambas têm.
   Este teste guarda a PARIDADE DOS CAMPOS gravados na conferência, que é onde a divergência
   entre as três nasce sem ninguém ver. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ARQS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};

/* os campos que a conferência grava a partir do snapshot têm que ser os MESMOS nas três */
const campos = {};
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  campos[emp] = new Set((s.match(/\b(nf_id|nf_numero|nf_emissao|cliente|numero_loja):\s*\(snapC/g) || [])
    .map(x => x.split(':')[0].trim()));
}
const referencia = campos.amb;
assert.ok(referencia.size >= 3, 'esperava vários campos vindos do snapshot na AMB');
for (const [emp, set] of Object.entries(campos)) {
  const faltando = [...referencia].filter(c => !set.has(c));
  assert.deepStrictEqual(faltando, [],
    emp + ' não grava ' + faltando.join(', ') + ' na conferência — a AMB grava. ' +
    'Campo que uma empresa grava e outra não vira funcionalidade que só existe numa tela.');
}

/* e o nf_id especificamente: sem ele, o link ↗ pro Bling não aparece */
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/nf_id:\s*\(snapC && snapC\.nf && snapC\.nf\.id\)/.test(s),
    emp + ': não grava o nf_id na conferência — o link ↗ que abre a NF no Bling some da tela dela');
}

console.log('OK: paridade da conferência — as três gravam os mesmos campos, incluindo o nf_id que dá o link pro Bling');
