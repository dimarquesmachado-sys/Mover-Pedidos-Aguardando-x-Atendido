'use strict';
/* 16/09 — O ID DE CANAL HERDADO SAIU. Ele decidia quais pedidos o F1 considera do Mercado
   Livre, e o padrão era 206017293 — o canal da AMB. Qualquer empresa sem a env própria
   julgava os pedidos DELA pelo canal de OUTRA, com o pior sintoma possível: nenhum erro, o F1
   só ignorava tudo em silêncio.

   A evidência pra remover veio de produção: /descobrir-ids provou o canal de cada empresa
   contra a própria conta do ML e conferiu contra o Render — as três com a env presente e o
   valor certo. Ninguém dependia do herdado.

   A PROTEÇÃO FICA NO USO, NÃO NO BOOT. Derrubar o boot tinha dois custos: o CI não passa
   essas envs (e corrigir exigiria mudança de workflow, que só o dono aplica), e uma empresa
   sem canal levaria as outras duas junto. O que protege é a função que DECIDE o que é venda
   do ML: sem canal declarado ela recusa, em vez de responder "não é do ML" pra tudo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* nenhum id de canal cravado como PADRÃO, em código de produção */
const IDS_REAIS = ['206017293', '203146903', '203296034'];
for (const arq of ['lib/fiscal/bling-api.js', 'girassol/importarPedido.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const id of IDS_REAIS) {
    assert.ok(!new RegExp("\\|\\|\\s*'" + id + "'").test(codigo),
      arq + ': o id ' + id + ' voltou como padrão — empresa sem env julgaria os pedidos dela pelo canal de outra, sem erro nenhum');
  }
}

/* a decisão do F1 recusa sem canal, em vez de dizer "não é do ML" pra tudo */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'bling-api.js'), 'utf8');
  assert.ok(/function canaisDeclarados\(\)/.test(s), 'falta o guarda que exige o canal na hora de usar');
  assert.ok(/if \(!canais\) throw new Error/.test(s),
    'sem canal declarado, a função NÃO pode responder "não é do ML" — isso faz o F1 ignorar tudo em silêncio, que é o bug do id herdado');
  assert.ok(/descobrir-ids/.test(s), 'a mensagem tem que dizer COMO obter o valor');
  assert.ok(/_EMPRESA_POR_ROTULO/.test(s),
    'a mensagem tem que trazer a ROTA REAL da empresa — "/<empresa>/descobrir-ids" é um molde que ninguém consegue colar');
}

/* o módulo do segundo consumidor carrega sem a env; usar sem ela é que falha */
{
  const s = fs.readFileSync(path.join(raiz, 'girassol', 'importarPedido.js'), 'utf8');
  assert.ok(/function lojaIdObrigatorio\(\)/.test(s), 'falta o guarda no segundo consumidor');
}

/* o guarda do F3 (nfe-ml-fluxo.js) tem o PRÓPRIO throw de canal vazio — ele lê ME_LOJA_IDS
   exportado direto, não passa por canaisDeclarados(). Sem reusar a mesma mensagem do F1, ele
   caía de volta no molde "/descobrir-ids do checkout-offline dela", que não existe como rota
   e não diz a env que falta (achado do Codex nesta rodada). */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'nfe-ml-fluxo.js'), 'utf8');
  assert.ok(/throw new Error\(mensagemCanalFaltando\(\)\)/.test(s),
    'o guarda do F3 tem que reusar mensagemCanalFaltando() do blingApi — senão a rota real e a env somem de novo');
}

console.log('OK: canal do ML — nenhum id herdado como padrão; sem a env o serviço SOBE, mas a decisão do F1 recusa em vez de responder "não é do ML" em silêncio');
