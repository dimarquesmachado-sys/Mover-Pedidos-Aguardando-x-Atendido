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

  /* 2. recurso que não achou nada tem que EXPLICAR, não fingir vazio. Os canais mudaram de
     estratégia (agora vêm dos pedidos), então quem guarda o "diga o que tentou" aqui são as
     situações, que ainda usam caminhos candidatos. */
  assert.strictEqual(r1.recursos.situacoes.ok, false);
  assert.ok(Array.isArray(r1.recursos.situacoes.tentei) && r1.recursos.situacoes.tentei.length >= 1,
    'tem que LISTAR os caminhos tentados — senão o próximo a mexer repete o mesmo chute');
  assert.ok(/permissão/.test(r1.recursos.situacoes.leia || ''),
    'tem que sugerir a causa mais provável (permissão do app), não deixar o dono no escuro');
  assert.strictEqual(r1.recursos.canais_de_venda.ok, false, 'sem pedidos, não há canal a descobrir');
  assert.ok(/pedido/.test(r1.recursos.canais_de_venda.leia || ''),
    'tem que dizer que depende de pedidos recentes — o dono precisa saber POR QUE veio vazio');

  /* 3. AJUSTES COM DADO REAL (15/09, retorno da AMB):
     · /situacoes/modulos devolve os MÓDULOS, não as situações — precisa do 2º passo pelo id
       do módulo de Pedidos de Venda;
     · /canais-de-venda e /lojas deram 404 nos dois, então os canais são derivados dos
       PEDIDOS, que trazem `loja: {id, nome}` num endpoint que sabemos que funciona. */
  const fakeCompleto = async (c) => {
    if (c === '/situacoes/modulos') return { status: 200, data: { data: [{ id: 98310, nome: 'Pedidos de Venda' }, { id: 849, nome: 'Ordens de Produção' }] } };
    if (c === '/situacoes/modulos/98310') return { status: 200, data: { data: [{ id: 9, nome: 'Atendido' }, { id: 6, nome: 'Em aberto' }] } };
    /* o falso precisa PAGINAR como o Bling real: devolver a mesma página sempre fazia a
       contagem triplicar, e eu quase "consertei" o código por causa do meu próprio falso. */
    const mp = /^\/pedidos\/vendas\?pagina=(\d+)/.exec(c);
    if (mp) {
      if (mp[1] !== '1') return { status: 200, data: { data: [] } };
      return { status: 200, data: { data: [
        { id: 1, loja: { id: 206017293, nome: 'Mercado Livre' } },
        { id: 2, loja: { id: 206017368, nome: 'Shopee' } },
        { id: 3, loja: { id: 206017293, nome: 'Mercado Livre' } },
      ] } };
    }
    return { status: 404, data: null };
  };
  const r3 = await criar({ rotulo: 'T', blingGet: fakeCompleto }).descobrir();

  assert.strictEqual(r3.recursos.situacoes.ok, true, 'as situações têm que vir do 2º passo');
  assert.strictEqual(r3.recursos.situacoes.modulo.id, 98310, 'tem que seguir o módulo de Pedidos de Venda');
  assert.ok(r3.recursos.situacoes.itens.some(i => /atendido/i.test(i.nome || '')), 'faltou a situação Atendido');

  assert.strictEqual(r3.recursos.canais_de_venda.ok, true, 'os canais têm que sair dos pedidos');
  const ml = r3.recursos.canais_de_venda.itens[0];
  assert.strictEqual(ml.id, 206017293, 'o canal mais frequente vem primeiro — é o que o dono procura');
  assert.strictEqual(ml.pedidos, 2, 'tem que contar quantos pedidos vieram de cada canal');
  assert.ok(/Mercado Livre/.test(ml.nome), 'sem o NOME o dono não sabe qual id é o do ML');

  /* módulo ausente não pode virar "sem situações" em silêncio */
  const semModulo = async (c) => (c === '/situacoes/modulos' ? { status: 200, data: { data: [{ id: 1, nome: 'Outra coisa' }] } } : { status: 404, data: null });
  const r4 = await criar({ rotulo: 'T', blingGet: semModulo }).descobrir();
  assert.strictEqual(r4.recursos.situacoes.ok, false);
  assert.ok(/não achei o módulo/.test(r4.recursos.situacoes.erro), 'tem que dizer que não achou o módulo, e listar os que achou');

  /* 4. cada recurso declara PARA QUE serve: lista de id sem propósito não ajuda ninguém */
  for (const [nome, spec] of Object.entries(RECURSOS)) {
    assert.ok(spec.para && spec.para.length > 10, nome + ': falta dizer pra que serve');
    assert.ok(Array.isArray(spec.caminhos), nome + ': caminhos tem que ser lista (vazia quando o recurso é derivado)');
    assert.ok(spec.caminhos.length || spec.derivar, nome + ': sem caminho e sem forma de derivar, o recurso não descobre nada');
  }

  /* 5. CRUZAMENTO E SUGESTÃO (15/09, do retorno real): os pedidos trazem loja.id mas NÃO o
     nome — e uma lista de números não diz ao dono qual é o do ML. Os DEPÓSITOS nomeiam os
     canais ("Shopee 206017368 (Fulfillment)"), então o cruzamento dá nome sem pedir nada.
     E a sugestão de envs é o passo que tira a digitação: em vez de ler ids e descobrir qual
     é qual, ele recebe as linhas prontas pra colar no Render. */
  const fakeReal = async (c) => {
    if (c === '/depositos') return { status: 200, data: { data: [
      { id: 1, descricao: 'Geral' }, { id: 2, descricao: 'Shopee 206017368 (Fulfillment)' }, { id: 3, descricao: 'Magalu 206018666 (Fulfillment)' }] } };
    if (c === '/situacoes/modulos') return { status: 200, data: { data: [{ id: 98310, nome: 'Pedidos de Venda' }] } };
    if (c === '/situacoes/modulos/98310') return { status: 200, data: { data: [
      { id: 9, nome: 'Atendido' }, { id: 24, nome: 'Verificado' }, { id: 745122, nome: 'AGUARDANDO' }, { id: 745123, nome: 'DESPACHADOS' }] } };
    const mp = /pagina=(\d+)/.exec(c);
    if (mp) return mp[1] === '1' ? { status: 200, data: { data: [
      { loja: { id: 206017293 } }, { loja: { id: 206017293 } }, { loja: { id: 206017368 } }, { loja: { id: 206018666 } }] } } : { status: 200, data: { data: [] } };
    return { status: 404, data: null };
  };
  const r5 = await criar({ rotulo: 'AMB', blingGet: fakeReal, prefixoEnv: 'AMBBKP_' }).descobrir();

  const porId = Object.fromEntries(r5.recursos.canais_de_venda.itens.map(c => [c.id, c.nome]));
  assert.strictEqual(porId[206017368], 'Shopee', 'o depósito nomeia o canal da Shopee');
  assert.strictEqual(porId[206018666], 'Magalu', 'o depósito nomeia o canal da Magalu');

  const env = r5.sugestao.colar_no_render;
  assert.strictEqual(env.AMBBKP_SITUACAO_ATENDIDO, '9', 'a situação é casada pelo NOME, não por posição');
  assert.strictEqual(env.AMBBKP_SITUACAO_AGUARDANDO, '745122');
  assert.strictEqual(env.AMBBKP_SITUACAO_DESPACHADOS, '745123');
  assert.strictEqual(env.AMBBKP_ME_LOJA_IDS, '206017293',
    'o ML é o canal mais usado que NÃO foi nomeado como outro marketplace');
  assert.ok(/confirme/i.test(r5.sugestao.confira),
    'a sugestão do ML é PALPITE e tem que se declarar como tal — colar id errado faz o F1 ignorar todos os pedidos');

  /* situação que não existe naquele Bling tem que aparecer como não encontrada, nunca
     casada com a errada por aproximação */
  const semDespachados = async (c) => (c === '/situacoes/modulos/98310'
    ? { status: 200, data: { data: [{ id: 9, nome: 'Atendido' }] } } : fakeReal(c));
  const r6 = await criar({ rotulo: 'X', blingGet: semDespachados, prefixoEnv: 'X_' }).descobrir();
  assert.ok(r6.sugestao.nao_encontrei.includes('SITUACAO_DESPACHADOS'),
    'situação ausente tem que ser DECLARADA, não adivinhada por aproximação de nome');
  assert.strictEqual(r6.sugestao.colar_no_render.X_SITUACAO_DESPACHADOS, undefined);

  /* 6. IDENTIDADE NO ML (15/09): o /users/me já é chamado 8 a 10 vezes espalhadas por
     empresa, e a GOOD não chamava nenhuma — ela não sabia o próprio seller id. No embarque
     esse é o dado que confirma que o token autorizado é da CONTA CERTA; o erro caro aqui não
     é errar o id, é autorizar a conta de outra empresa e descobrir depois. */
  const semToken = await criar({ rotulo: 'X', blingGet: fakeReal, prefixoEnv: 'X_' }).descobrir();
  assert.strictEqual(semToken.recursos.mercado_livre.ok, false, 'sem token, não inventa identidade');
  assert.ok(/token do ML/.test(semToken.recursos.mercado_livre.leia || ''), 'tem que dizer POR QUE não descobriu');
  assert.ok(semToken.recursos.depositos.ok, 'a ausência do token do ML não pode derrubar o resto');

  const tokenQuebrado = await criar({
    rotulo: 'X', blingGet: fakeReal, prefixoEnv: 'X_',
    garantirTokenML: async () => { throw new Error('token expirado'); },
  }).descobrir();
  assert.strictEqual(tokenQuebrado.recursos.mercado_livre.ok, false);
  assert.ok(/token expirado/.test(tokenQuebrado.recursos.mercado_livre.erro || ''), 'tem que repassar o motivo real');
  assert.ok(tokenQuebrado.recursos.situacoes.ok, 'token quebrado não derruba a descoberta do Bling');

  /* 7. PROVA vs PALPITE (15/09): sobrava um canal sem nome (133 pedidos na AMB) e a sugestão
     pedia "confirme que é mesmo o do ML". Dá pra confirmar sozinho — pega um numeroLoja
     daquele canal e pergunta ao ML se o pedido é nosso. O teste guarda a distinção, que é o
     ponto: prova e palpite não podem sair com a mesma cara pra quem lê. */
  const comPedidoML = async (c) => {
    const mp = /pagina=(\d+)/.exec(c);
    if (mp) return mp[1] === '1' ? { status: 200, data: { data: [
      { loja: { id: 206017293 }, numeroLoja: '2000012345678901' },
      { loja: { id: 206017368 }, numeroLoja: '250915ABCDEF' }] } } : { status: 200, data: { data: [] } };
    return fakeReal(c);
  };
  const globalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/users\/me/.test(url)) return { ok: true, json: async () => ({ id: 3148025116, nickname: 'AMBTOTAL' }) };
    if (/orders\/2000012345678901/.test(url)) return { ok: true, json: async () => ({ seller: { id: 3148025116 } }) };
    return { ok: false, status: 404 };
  };
  const r7 = await criar({ rotulo: 'AMB', blingGet: comPedidoML, prefixoEnv: 'A_', garantirTokenML: async () => 'tok' }).descobrir();
  const canalML = r7.recursos.canais_de_venda.itens.find(c => c.id === 206017293);
  assert.strictEqual(canalML.nome, 'Mercado Livre', 'o canal tem que ser PROVADO pelo pedido, não adivinhado');
  assert.ok(/PROVADO/.test(canalML.obs || ''), 'a prova tem que ficar registrada no item');
  assert.strictEqual(r7.sugestao.colar_no_render.A_ME_LOJA_IDS, '206017293');
  assert.ok(/PROVADO/.test(r7.sugestao.confira), 'provado não pode sair com o texto de "confirme antes de colar"');
  assert.ok(!r7.recursos.canais_de_venda.itens.some(c => '_amostra' in c), 'a amostra é ruído interno, não vai pro retorno');

  /* sem conseguir provar, a ajuda continua — mas declarada como palpite */
  global.fetch = async (url) => (/users\/me/.test(url)
    ? { ok: true, json: async () => ({ id: 3148025116 }) } : { ok: false, status: 403 });
  const r8 = await criar({ rotulo: 'AMB', blingGet: comPedidoML, prefixoEnv: 'A_', garantirTokenML: async () => 'tok' }).descobrir();
  assert.ok(r8.sugestao.colar_no_render.A_ME_LOJA_IDS, 'perder a prova não pode significar perder a sugestão');
  assert.ok(/PALPITE/.test(r8.sugestao.confira), 'sem prova, tem que se declarar palpite');
  global.fetch = globalFetch;

  /* 8. IDENTIFICAR PELO FORMATO (15/09): na AMB sobrou um canal sem nome e sem depósito
     (206027680, 13 pedidos). Cada marketplace numera os pedidos de um jeito próprio e
     estável, e isso identifica o canal. Vem marcado como "deduzido do formato" — diferente
     do "PROVADO" do ML, porque a origem de cada afirmação tem que continuar visível. */
  const comFormatos = async (c) => {
    if (c === '/depositos') return { status: 200, data: { data: [{ id: 2, descricao: 'Shopee 206017368 (Fulfillment)' }] } };
    const mp = /pagina=(\d+)/.exec(c);
    if (mp) return mp[1] === '1' ? { status: 200, data: { data: [
      { loja: { id: 206017293 }, numeroLoja: '2000012345678901' },
      { loja: { id: 206017368 }, numeroLoja: '250915ABCDEF12' },
      { loja: { id: 206027680 }, numeroLoja: 'LU-4455667788' },
      { loja: { id: 777 }, numeroLoja: 'FORMATO-DESCONHECIDO' }] } } : { status: 200, data: { data: [] } };
    return { status: 404, data: null };
  };
  const r9 = await criar({ rotulo: 'T', blingGet: comFormatos }).descobrir();
  const por = Object.fromEntries(r9.recursos.canais_de_venda.itens.map(c => [c.id, c]));

  assert.ok(/Magalu/.test(por[206027680].nome), 'LU-... é Magalu — era o canal que sobrava sem identificação');
  assert.ok(/formato/.test(por[206027680].obs), 'tem que dizer que foi deduzido do FORMATO, não afirmar como prova');
  assert.strictEqual(por[206017368].nome, 'Shopee', 'o depósito tem precedência sobre o formato — é informação, não dedução');
  assert.ok(/depósito/.test(por[206017368].obs));

  /* o que não reconhece não pode calar: sem o exemplo, o dono não tem como identificar */
  assert.strictEqual(por[777].nome, null, 'formato desconhecido não pode virar palpite');
  assert.strictEqual(por[777].exemplo_pedido, 'FORMATO-DESCONHECIDO',
    'tem que mostrar o número de exemplo — é com ele que o dono reconhece o canal no Bling');
  assert.ok(/não identifiquei/.test(por[777].leia || ''));

  /* 9. A AMOSTRA VEM DO DETALHE (15/09): o retorno real mostrou a prova falhando com "não
     consegui provar pelo ML", e a causa era simples — a LISTA de pedidos do Bling nem sempre
     traz `numeroLoja`. O próprio F1 já sabia disso: ele faz `pDetalhe?.numeroLoja ||
     p?.numeroLoja`. Sem amostra, nem a prova nem a dedução por formato funcionam.
     Custo importa aqui: é UMA chamada de detalhe por CANAL desconhecido, não por pedido. */
  let detalhes = 0;
  const listaSemNumero = async (c) => {
    if (c === '/depositos') return { status: 200, data: { data: [] } };
    if (c === '/situacoes/modulos') return { status: 404, data: null };
    const md = /\/pedidos\/vendas\/(\d+)$/.exec(c);
    if (md) { detalhes++; return { status: 200, data: { data: { id: Number(md[1]), numeroLoja: md[1] === '1' ? '2000012345678901' : 'LU-99887766' } } }; }
    const mp = /pagina=(\d+)/.exec(c);
    if (mp) return mp[1] === '1' ? { status: 200, data: { data: [
      { id: 1, loja: { id: 111 } }, { id: 2, loja: { id: 222 } }, { id: 3, loja: { id: 111 } }] } } : { status: 200, data: { data: [] } };
    return { status: 404, data: null };
  };
  const r10 = await criar({ rotulo: 'T', blingGet: listaSemNumero }).descobrir();
  const c10 = Object.fromEntries(r10.recursos.canais_de_venda.itens.map(c => [c.id, c]));
  assert.ok(/Mercado Livre/.test(c10[111].nome || ''), 'sem a busca do detalhe, este canal ficaria sem nome');
  assert.ok(/Magalu/.test(c10[222].nome || ''));
  assert.strictEqual(detalhes, 2, 'UMA chamada de detalhe por canal (não por pedido): esperava 2, veio ' + detalhes);
  assert.ok(!r10.recursos.canais_de_venda.itens.some(c => '_idPedido' in c), 'o id usado na busca é ruído interno');

  /* 10. erro de rede num candidato não pode derrubar a descoberta inteira */
  const fakeExplode = async (c) => { if (c === '/depositos') throw new Error('timeout'); return { status: 200, data: { data: [] } }; };
  const r2 = await criar({ rotulo: 'T', blingGet: fakeExplode }).descobrir();
  assert.ok(r2.recursos.depositos, 'o recurso que falhou tem que aparecer no resultado');
  assert.ok(r2.recursos.situacoes, 'a falha de um não pode impedir os outros de serem descobertos');

  console.log('OK: descoberta de ids — resume o que achou, lista o que TENTOU quando não achou, e falha de um recurso não derruba os outros');
})().catch(e => { console.error(e.message); process.exit(1); });
