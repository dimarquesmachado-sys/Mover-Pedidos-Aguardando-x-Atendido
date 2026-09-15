'use strict';
/* 15/09 — descoberta dos ids da empresa no Bling. Pedido do dono em 26/08, repetido hoje:
   "ao adicionar CNPJ de empresa nova deveria tá sempre buscando e pegando". Hoje esses ids
   são mapeados no DevTools, tela por tela — é a maior fonte de digitação do embarque, e a
   que mais erra: id de FILIAL e id de UNIDADE DE NEGÓCIO são espaços diferentes do Bling, e
   confundir os dois já aconteceu.
   O teste guarda a decisão de desenho que mais importa aqui: a peça NÃO presume saber os
   caminhos da API. Ela tenta candidatos e RELATA o que respondeu — porque chutar um caminho
   e tratar 404 como "não tem nada" seria dizer que a empresa não tem depósito nenhum, e essa
   mentira custa horas de investigação. */
const assert = require('assert');
const { criar, RECURSOS } = require('../lib/checkout/descobrir-ids');

assert.throws(() => criar({}), /falta rotulo/);

/* 1. caminho que responde: devolve os itens resumidos */
const fakeOk = async (c) => {
  if (c === '/depositos') return { status: 200, data: { data: [{ id: 14888917703, descricao: 'Geral' }, { id: 14889038488, descricao: 'DEFEITOS' }] } };
  return { status: 404, data: null };
};
(async () => {
  const d1 = criar({ rotulo: 'TESTE', blingGet: fakeOk });
  const r1 = await d1.descobrir();
  assert.strictEqual(r1.recursos.depositos.ok, true, 'depósitos deveriam ter sido encontrados');
  assert.strictEqual(r1.recursos.depositos.itens.length, 2);
  assert.strictEqual(r1.recursos.depositos.itens[0].nome, 'Geral', 'o nome do depósito é o que o dono reconhece');
  assert.ok(r1.recursos.depositos.itens[0].id, 'sem id não serve pra nada');

  /* 2. caminho que NÃO responde: tem que dizer o que tentou, não fingir vazio */
  assert.strictEqual(r1.recursos.canais_de_venda.ok, false);
  assert.ok(Array.isArray(r1.recursos.canais_de_venda.tentei) && r1.recursos.canais_de_venda.tentei.length >= 1,
    'tem que LISTAR os caminhos tentados — senão o próximo a mexer repete o mesmo chute');
  assert.ok(/permissão/.test(r1.recursos.canais_de_venda.leia || ''),
    'tem que sugerir a causa mais provável (permissão do app), não deixar o dono no escuro');

  /* 3. cada recurso declara PARA QUE serve: lista de id sem propósito não ajuda ninguém */
  for (const [nome, spec] of Object.entries(RECURSOS)) {
    assert.ok(spec.para && spec.para.length > 10, nome + ': falta dizer pra que serve');
    assert.ok(Array.isArray(spec.caminhos) && spec.caminhos.length, nome + ': falta candidato de caminho');
  }

  /* 4. erro de rede num candidato não pode derrubar a descoberta inteira */
  const fakeExplode = async (c) => { if (c === '/depositos') throw new Error('timeout'); return { status: 200, data: { data: [] } }; };
  const r2 = await criar({ rotulo: 'T', blingGet: fakeExplode }).descobrir();
  assert.ok(r2.recursos.depositos, 'o recurso que falhou tem que aparecer no resultado');
  assert.ok(r2.recursos.situacoes, 'a falha de um não pode impedir os outros de serem descobertos');

  console.log('OK: descoberta de ids — resume o que achou, lista o que TENTOU quando não achou, e falha de um recurso não derruba os outros');
})().catch(e => { console.error(e.message); process.exit(1); });
