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

/* 16/09 (P2 do Codex) — NÃO ANUNCIAR ROTA QUE A EMPRESA NÃO TEM. Empresa montada pelo
   contrato não tem pasta de checkout, logo não tem /descobrir-ids própria: mandá-la rodar
   essa rota é mandar o dono a um 404, e ele procura o que não existe em vez de resolver.
   E a fábrica aceitava `NOVA_ME_LOJA_IDS=abc` (só checava presença) — mesmo erro que o
   validar tinha: o valor existe, a empresa monta, e o F1/F3 se recusam a rodar depois. */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'bling-api.js'), 'utf8');
  const msg = /function mensagemCanalFaltando\(\)[\s\S]*?\n  \}/.exec(s)[0];
  assert.ok(/montada pelo contrato/.test(msg),
    'rótulo fora da tabela é empresa da fábrica — a mensagem não pode mandar rodar uma rota que ela não tem');
  assert.ok(!/Rode o \/descobrir-ids do checkout-offline desta empresa/.test(msg));

  const f = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'montar-empresa.js'), 'utf8');
  assert.ok(/\/\^\\d\+\$\//.test(f) || /test\(x\)/.test(f),
    'a fábrica tem que validar o FORMATO dos ids, não só a presença');
  assert.ok(!/descobrir-ids/.test(f) || /não tem rota \/descobrir-ids/.test(f),
    'e não pode anunciar /descobrir-ids pra empresa sem pasta');
}

/* 16/09 (3 P2 do Codex) — os três são o mesmo princípio: NÃO FINGIR QUE ESTÁ TUDO BEM.
   (1) `203296034,abc` virava lista "válida" com um id só — o F1 seguia e ignorava todos os
       pedidos do canal digitado errado, sem erro e sem aviso. Um item ruim invalida a lista;
   (2) a fábrica seguia a mesma regra frouxa pra empresa nova;
   (3) a conferência ainda declarava o canal como "padrão do código", então diria "não existe
       no Render, mas o padrão já cobre" — sendo que o padrão foi REMOVIDO e, sem a env, o F1
       e o F3 se recusam a rodar. Dizer que está tudo bem quando não está é o pior jeito de
       errar numa ferramenta de conferência. */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'bling-api.js'), 'utf8');
  const bloco = /const _itens = [\s\S]*?const ME_LOJA_IDS = [^;]+;/.exec(s);
  assert.ok(bloco, 'não achei o parser da lista de canais');
  const lista = (v) => new Function('_lojaIdsBrutos', bloco[0] + ' return ME_LOJA_IDS;')(v);
  assert.deepStrictEqual(lista('203296034'), [203296034]);
  assert.deepStrictEqual(lista('203296034,206069383'), [203296034, 206069383], 'lista com vírgula é válida — ML normal + Full');
  assert.deepStrictEqual(lista('203296034,abc'), [],
    'um item inválido invalida a LISTA INTEIRA — descartar só o ruim faria a empresa ignorar o canal digitado errado em silêncio');
  assert.deepStrictEqual(lista('abc'), []);

  const f = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'montar-empresa.js'), 'utf8');
  assert.ok(/some\(x => !\/\^\\d\+\$\/\.test\(x\)\)/.test(f),
    'a fábrica tem que seguir a mesma regra: um item ruim invalida a lista');
}

/* (3) a conferência não pode declarar um padrão que não existe mais */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = /padroesEnv: (\{[^}]*\})/.exec(s);
  assert.ok(m, arq + ': não achei padroesEnv');
  assert.ok(!/ME_LOJA_IDS/.test(m[1]),
    arq + ': o canal do ML voltou pros padrões — a conferência diria "o padrão já cobre" quando o padrão não existe mais');
}

console.log('OK: canal do ML — nenhum id herdado como padrão; sem a env o serviço SOBE, mas a decisão do F1 recusa em vez de responder "não é do ML" em silêncio');
