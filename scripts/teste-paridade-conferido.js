/* 17/09 — a rota `conferido` saiu das três pastas para lib/checkout/rotas-conferido.js (5ª
   fatia do passo 4), então a paridade dos campos passou a ser estrutural: existe UM código
   só. O que este teste guarda agora é o que a unificação NÃO garante sozinha — que o campo
   e a guarda continuem lá, e que nenhuma pasta volte a ter cópia própria. */
'use strict';
/* 16/09 — PORTE DE CAPACIDADE achado ao medir a 5ª fatia do passo 4: a AMB e a Girassol
   gravavam o `nf_id` na conferência do pedido e a GOOD não. O efeito era invisível no
   backend e visível na tela: o link ↗ que abre a NF no Bling nunca aparecia no painel da
   GOOD, porque o front já sabia desenhar (`if(!souAdmin() || !p.nf_id) return ''`)
   e simplesmente nunca recebia o dado. (A GOOD não tem dashboard.html ainda — /good-checkout-offline/dashboard
   responde 404 de propósito; esse consumidor fica pro dia em que ele chegar.)
   Não é diferença de operação — é capacidade que ficou pra trás, e a regra da casa é clara:
   uma tem, agora ambas têm.
   Este teste guarda a PARIDADE DOS CAMPOS gravados na conferência, que é onde a divergência
   entre as três nasce sem ninguém ver. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ARQS = { lib: 'lib/checkout/rotas-conferido.js' };

/* os campos que a conferência grava a partir do snapshot têm que ser os MESMOS nas três.
   16/09 (Codex): a lista é uma CONSTANTE fixa, não derivada de uma das empresas — se
   comparássemos contra o conjunto de uma delas (ex.: a AMB), a própria AMB perdendo um
   campo encolheria a referência e o teste pararia de notar a divergência (referência e
   comparação caindo juntas). Contra uma lista fixa, qualquer uma das três que perder um
   campo — inclusive a que serviria de referência — acusa. */
const CAMPOS_ESPERADOS = ['nf_id', 'nf_numero', 'nf_emissao', 'cliente', 'numero_loja'];
/* `cliente` grava como `cliente: snapC ? (snapC.cliente...` (ternário) enquanto os outros
   gravam como `campo: (snapC && ...)` — a regex precisa aceitar as duas formas, senão
   `cliente` nunca é capturado em nenhuma das três e o teste fica cego pra ele. */
const campos = {};
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  campos[emp] = new Set((s.match(/\b(nf_id|nf_numero|nf_emissao|cliente|numero_loja):\s*(?:\(snapC|snapC\s*\?)/g) || [])
    .map(x => x.split(':')[0].trim()));
}
for (const [emp, set] of Object.entries(campos)) {
  const faltando = CAMPOS_ESPERADOS.filter(c => !set.has(c));
  assert.deepStrictEqual(faltando, [],
    emp + ' não grava ' + faltando.join(', ') + ' na conferência — as outras empresas gravam. ' +
    'Campo que uma empresa grava e outra não vira funcionalidade que só existe numa tela.');
}

/* e o nf_id especificamente: sem ele, o link ↗ pro Bling não aparece. 17/09 (Codex): tem que
   vir com `!snapC.nf_anexada` — sem essa guarda, o campo grava o id da nota CANCELADA quando
   o admin anexa a NF à mão (ciclo.js documenta que `nf.id` não é atualizado nesse fluxo). */
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/nf_id:\s*\(snapC && !snapC\.nf_anexada && snapC\.nf && snapC\.nf\.id\)/.test(s),
    emp + ': não grava o nf_id (com a guarda de nf_anexada) na conferência — o link ↗ que abre a NF no Bling ' +
    'some da tela ou aponta pra nota cancelada');
}

for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(!/nf_id:\s*\(snapC/.test(s),
    arq + ': a gravação do nf_id voltou pra pasta — é por aí que a divergência entre as três retorna');
}

console.log('OK: paridade da conferência — as três gravam os mesmos campos, incluindo o nf_id que dá o link pro Bling');
