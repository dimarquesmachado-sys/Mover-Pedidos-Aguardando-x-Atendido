'use strict';
/* 15/09 — o NOME do produto sumia no período longo. O dono viu na tela: em hoje/ontem/7 dias
   o dashboard mostra o nome, mas em "mês anterior", "30 dias" e "ano" aparecia só o SKU, e a
   quantidade sumia quando era 1.
   Eram DOIS problemas no mesmo caminho, e o período curto não tinha nenhum porque vem do
   cache, não do banco:
     · o backend PEDIA `descricao` ao Supabase (está na lista de campos) e a DESCARTAVA ao
       montar o item — pagava a consulta e não entregava o dado;
     · o front da tabela do banco nem tentava mostrar o nome, e escondia o "1×".
   É a mesma história dos links que sumiam aqui em 20/08: a tabela que vem do BANCO foi
   ficando pra trás da tabela que vem do cache, um detalhe de cada vez. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const lib = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');

/* backend: todo item montado a partir do banco leva a descrição junto */
const montagens = lib.match(/itens\.push\(\{[^}]*\}\)/g) || [];
assert.ok(montagens.length >= 2, 'esperava pelo menos duas montagens de item (linhas e longo)');
for (const m of montagens) {
  assert.ok(/descricao/.test(m),
    'item montado sem `descricao`: ' + m + ' — o campo é pedido ao banco e seria descartado, e o front lê i.descricao');
  assert.ok(/qtd/.test(m), 'item montado sem `qtd`');
}

/* e a `descricao` tem que continuar sendo pedida ao banco nas duas rotas */
const campos = lib.match(/const campos = '[^']+'/g) || [];
assert.ok(campos.length >= 2, 'esperava as duas listas de campos');
for (const c of campos) assert.ok(/descricao/.test(c), 'lista de campos sem descricao: ' + c);

/* front: as duas telas mostram nome e quantidade na tabela do banco */
for (const arq of ['amb-checkout-offline/amb-dashboard.html', 'girassol-backup-offline/dashboard.html']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(!/i\.qtd>1\?i\.qtd/.test(s),
    arq + ': a tabela do banco voltou a esconder o "1×" — a do cache sempre mostrou');
  assert.ok(/i\.descricao \|\|/.test(s),
    arq + ': a tabela do banco não mostra o nome do produto, só o SKU');
}

console.log('OK: nome do produto — a descrição vai do banco até a tela, e a quantidade aparece mesmo quando é 1');
