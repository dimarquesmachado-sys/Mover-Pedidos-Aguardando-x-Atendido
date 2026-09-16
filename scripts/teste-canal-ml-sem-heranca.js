'use strict';
/* 16/09 — O ID DE CANAL HERDADO SAIU. Ele decidia quais pedidos o F1 considera do Mercado
   Livre, e o padrão era 206017293 — o canal da AMB. Qualquer empresa sem a env própria
   julgava os pedidos DELA pelo canal de OUTRA, e o sintoma era o pior possível: nenhum erro,
   o F1 só ignorava tudo em silêncio.

   Mantive o padrão em 15/09 porque não dava pra ver o Render daqui. A evidência veio de
   produção: /descobrir-ids provou o canal de cada empresa contra a própria conta do ML e
   conferiu contra o Render — as três com a env presente e o valor certo. Ninguém dependia do
   herdado, então ele saiu.

   Este teste impede o padrão de voltar. Um id de conta escrito no código é o tipo de coisa
   que alguém reintroduz "só pra não quebrar" e que volta a cegar a empresa seguinte. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* nenhum id de canal cravado como PADRÃO, em código de produção */
const IDS_REAIS = ['206017293', '203146903', '203296034'];
const arquivos = ['lib/fiscal/bling-api.js', 'girassol/importarPedido.js'];
for (const arq of arquivos) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const id of IDS_REAIS) {
    assert.ok(!new RegExp("\\|\\|\\s*'" + id + "'").test(codigo),
      arq + ': o id ' + id + ' voltou como padrão — empresa sem env julgaria os pedidos dela pelo canal de outra, sem erro nenhum');
  }
}

/* e a ausência tem que FALHAR, não virar silêncio */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'bling-api.js'), 'utf8');
  assert.ok(/throw new Error\([^)]*falta ' \+ cfg\.envMeLojaIds/.test(s),
    'sem a env, tem que derrubar o boot: a alternativa é a empresa subir, responder 200 em tudo e não mover um pedido');
  assert.ok(/descobrir-ids/.test(s),
    'a mensagem tem que dizer COMO obter o valor — a rota já prova o canal contra a conta do ML');
}

console.log('OK: canal do ML — nenhum id herdado como padrão, e a ausência da env derruba o boot em vez de virar silêncio');
