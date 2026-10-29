/* 04/10 — FALHAR UMA PÁGINA DA LISTA TRAVAVA A TELA DA GOOD.

   Na "Análise de Vendas", quando `/historico-linhas` falhava, o aviso substituía a tabela
   INTEIRA — e com ela os botões "Anterior/Próxima". O usuário ficava sem jeito de tentar de novo
   nem de voltar: só F5. Pior, `PAGINA` já tinha avançado no clique, então o estado apontava pra
   uma página que nunca carregou.

   ⚠️ A AMB E A GIRASSOL JÁ TRATAM ISSO (`_hlUltima`, `repetirHist`) — o comentário lá descreve
   exatamente este defeito, vivido no PR #132. A GOOD era a única que ficava presa: o conserto
   existia no repositório e não tinha sido aplicado aqui.

   Verificação de TELA, no texto da página: o painel da GOOD é HTML com script embutido, sem
   módulo pra importar. Por isso o teste confere a presença das peças que impedem o travamento,
   e a bateria de `onclick-existe` garante que as funções chamadas existem.

   Marcador estável [PAG-TRAVA]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
/* 28/10: a tela velha da GOOD saiu — a GOOD usa a TELA ÚNICA (a mesma da AMB e da Girassol) e entra na conferência abaixo */

/* ── as três empresas, na tela única ─────────────────────── */
for (const [emp, arq, marca] of [
  ['AMB', 'lib/checkout/painel/dashboard.html', '_hlUltima'],
  ['Girassol', 'girassol-backup-offline/dashboard.html', '_hlUltima'],
  ['GOOD', 'good-checkout-offline/dashboard.html', '_hlUltima'],
]) {
  const t = require('./_tela-empresa').lerTela(arq);
  assert.ok(t.includes(marca),
    '[PAG-TRAVA] ' + emp + ' perdeu o registro da consulta tentada (' + marca + ') — era o que ' +
    'permitia repetir a página que falhou');
  assert.ok(/repetirHist/.test(t),
    '[PAG-TRAVA] ' + emp + ' perdeu o botão de repetir a consulta que falhou');
}

console.log('OK: falha de pagina nao trava a tela em nenhuma das tres empresas');
