/* 30/09 — RAIO-X DA FATURA DO CARTÃO DO ML.

   O caso: painel da AMB em R$ 6.455,32 num ciclo em que o cartão debitou R$ 5.928,23 —
   R$ 527,09 a mais, com o dado FRESCO (2h), então não é atraso de sincronização. Duas
   categorias batiam byte a byte com a fatura oficial (Publicidade 5.537,84, Minha página
   99,00), o que diz que a COLETA lê certo e o problema é de CLASSIFICAÇÃO.

   Esta lib não corrige nada e não escolhe culpado: ela isola as três hipóteses pra o dono
   comparar com o relatório de Faturamento. O teste trava justamente esse isolamento — se
   alguém "simplificar" e juntar os números, a rota deixa de responder a pergunta. */
const assert = require('assert');
const path = require('path');
const aud = require(path.join(__dirname, '..', 'lib', 'ml-fatura-auditoria'));

/* o ciclo do print, com uma linha de cada suspeita dentro */
const tarifas = {
  t1: { d: '2026-08-20', v: 5537.84, c: 'Publicidade (Ads)', cartao: true },
  t2: { d: '2026-08-22', v: 99.00, c: 'Minha página', cartao: true },
  t3: { d: '2026-09-01', v: 585.77, c: 'Armazenagem Full', cartao: true },
  t4: { d: '2026-09-02', v: 207.98, c: 'Devoluções', cartao: true, o: '2000012345678' },
  t5: { d: '2026-09-03', v: 24.73, c: 'comissao', cartao: true, o: '2000012345679' },
  t6: { d: '2026-09-05', v: -243.43, c: 'cancelamento', cartao: false },
  t7: { d: '2026-09-06', v: -50.00, c: 'estorno' },
  /* outro ciclo: não pode vazar pra conta deste */
  t8: { d: '2026-07-20', v: 999.99, c: 'Publicidade (Ads)', cartao: true },
};

const ciclos = aud.ciclosDisponiveis(tarifas);
assert.ok(ciclos.length >= 2, 'não separou os ciclos');
/* a chave do ciclo vem da `cicloDe` da lib da fatura (formato AAAA-MM-DD do fechamento) —
   lida de lá, não suposta: eu tinha escrito '2026-09' de cabeça e o teste pegou */
assert.strictEqual(ciclos[0].ciclo, '2026-09-01', 'o ciclo mais novo deveria vir primeiro');

const r = aud.abrirCiclo(tarifas, '2026-09-01');

/* o total tem que reproduzir o que o painel mostra — senão a auditoria está olhando outra coisa */
assert.strictEqual(r.total_no_cartao, 6455.32,
  'o total da auditoria não reproduz o do painel — comparar com a fatura do ML não faria sentido');
assert.ok(!r.por_categoria['Publicidade (Ads)'] || r.por_categoria['Publicidade (Ads)'] === 5537.84,
  'a categoria vazou valor de outro ciclo');

/* HIPÓTESE 1: tarifa marcada como cartão mas COM pedido. O ML desconta no repasse o que tem
   venda pra abater — estas são as candidatas a estar no lugar errado. */
assert.strictEqual(r.no_cartao_com_pedido.total, 232.71,
  'perdeu o isolamento das tarifas que têm pedido associado — é a 1a hipótese da divergência');
assert.strictEqual(r.no_cartao_com_pedido.linhas, 2, 'contou errado as linhas com pedido');

/* HIPÓTESE 2: crédito que não foi pro cartão, então não abateu lá */
assert.strictEqual(r.creditos.fora_do_cartao, -243.43,
  'perdeu o isolamento dos créditos fora do cartão — é a 2a hipótese (sem marca NÃO entra aqui)');
assert.strictEqual(r.creditos.sem_marca, -50, 'crédito sem marca sumiu do seu próprio balde');

/* HIPÓTESE 3: registro anterior à migração, que a lib da fatura ignora de propósito */
assert.strictEqual(r.sem_marca.linhas, 1, 'não contou os registros sem a marca do ML');
assert.strictEqual(r.sem_marca.total, -50, 'somou errado os registros sem marca');

/* o ciclo pedido é respeitado: a tarifa de julho não pode entrar */
assert.ok(!r.linhas.some(l => l.data.startsWith('2026-07')),
  'vazou tarifa de outro ciclo pra dentro do ciclo pedido');

/* e as linhas vêm com a marca do ML preservada, que é o que ele vai comparar */
const semPedido = r.linhas.find(l => l.id === 't1');
assert.strictEqual(semPedido.cartao, true, 'a marca do ML se perdeu na linha');
assert.strictEqual(r.linhas.find(l => l.id === 't7').cartao, null,
  'registro sem marca virou false — "não sei" e "não é cartão" são coisas diferentes');

/* ciclo padrão = último FECHADO: em 30/09 o ciclo de out (em andamento) não pode ser o escolhido */
const tEmAndamento = Object.assign({ t9: { d: '2026-09-20', v: 10, c: 'x', cartao: true } }, tarifas);
assert.strictEqual(aud.escolherCiclo(tEmAndamento, null, '2026-09-30').ref, '2026-09-01',
  'o padrão pegou o ciclo em andamento em vez do último fechado');
assert.strictEqual(aud.escolherCiclo(tEmAndamento, '2026-10-01', '2026-09-30').ref, '2026-10-01',
  'não deixou escolher o ciclo em andamento explicitamente');
assert.ok(aud.escolherCiclo(tEmAndamento, '1999-01-01', '2026-09-30').erro, 'ciclo inexistente deveria ser recusado');
assert.ok(aud.escolherCiclo({}, null, '2026-09-30').sem_dado, 'cache vazio deveria ser sem_dado, não zero');

const soAndamento = { a: { d: '2026-09-20', v: 10, c: 'x', cartao: true } };
assert.ok(aud.escolherCiclo(soAndamento, null, '2026-09-30').erro, 'só ciclo em andamento: o padrão deve recusar');
assert.strictEqual(aud.escolherCiclo(soAndamento, '2026-10-01', '2026-09-30').ref, '2026-10-01', 'explícito deve passar');
/* 30/09 — A QUEBRA QUE FECHA O DIAGNÓSTICO, escrita depois do raio-x REAL da AMB:
   `creditos.no_cartao: 0` (nenhum crédito no cartão) contra R$ 3.019,14 de créditos fora.
   Implausível: o Ads é ~73% da fatura do cartão e a fatura do ML lista cancelamentos — o
   estorno de um Ads TEM que abater no cartão.
   Sem esta quebra o dono vê "3.019 fora" e não sabe quanto disso deveria estar dentro. */
{
  const t2 = {
    a: { d: '2026-09-01', v: 4738.79, c: 'ads', cartao: true },
    b: { d: '2026-09-02', v: 406.30, c: 'full', cartao: true },
    /* o classificador real manda o estorno de Ads pra 'credito' (Codex #541), nunca 'ads' */
    c: { d: '2026-09-03', v: -527.09, c: 'credito', cartao: false },
    d: { d: '2026-09-04', v: -2492.05, c: 'envio', cartao: false },
    /* pré-migração (sem marca): destino desconhecido, não é "fora do cartão" */
    e: { d: '2026-09-05', v: -100, c: 'credito', cartao: null },
  };
  const r2c = aud.abrirCiclo(t2, '2026-09-01');

  /* 30/09 — ESTE BLOCO É DO claude[bot], e o assert final MUDOU DE VERDADE no meio do caminho.
     Ele concluiu "cruzamento por categoria de cartão é inviável: o estorno vem como credito", e
     estava CERTO com o dado de então — a categoria de todo crédito é `credito`.
     O que mudou foi o dado: a coleta passou a gravar o ASSUNTO do crédito (`a`), então o
     estorno de Ads volta a ser reconhecível. Aqui as linhas continuam SEM assunto de propósito
     — é o caso do registro antigo, colhido antes da mudança —, e o agrupamento por `credito`
     segue correto pra elas.
     O filtro dele fica: `!== false` exclui o SEM MARCA, que é destino desconhecido e não
     "fora do cartão". */
  assert.deepStrictEqual(r2c.creditos_fora_por_categoria, { credito: -527.09, envio: -2492.05 },
    'só crédito com cartao===false entra; sem marca não pode se misturar');
  assert.strictEqual(r2c.creditos.sem_marca, -100);
  assert.strictEqual(r2c.creditos_fora_de_categoria_de_cartao, 0,
    'sem o assunto gravado, o cruzamento não acha nada — e ZERO é a resposta honesta aqui, ' +
    'não a ausência do campo');
}

/* 30/09 — POR QUE A QUEBRA POR CATEGORIA NÃO BASTAVA, e o conserto real.

   Eu escrevi `creditos_fora_por_categoria` procurando crédito na categoria `ads`. Fui ler o
   categorizador e a regra `credito` vem ANTES de todas: "Anulación del cargo por campaña de
   publicidad" vira `credito` e PERDE o "publicidade". Ou seja: minha quebra devolveria um
   balde só, chamado `credito`, e não responderia nada.

   O conserto NÃO mudou a categoria — `credito` é o que o card de "Tarifas devolvidas" soma, e
   mexer nela quebraria aquele número. O que faltava era o ASSUNTO do crédito, por fora. */
{
  const cat = require(path.join(__dirname, '..', 'lib', 'checkout', 'ml-tarifa-categoria'));

  /* textos REAIS que já apareceram nas faturas das duas empresas */
  assert.strictEqual(cat._mlbCategoria('Anulación del cargo por campaña de publicidad'), 'credito',
    'a categoria do crédito mudou — o card de Tarifas devolvidas soma por ela');
  assert.strictEqual(cat._mlbAssuntoDoCredito('Anulación del cargo por campaña de publicidad'), 'ads',
    'o estorno de Ads não se identifica como Ads — sem isso não dá pra casar a cobrança com o ' +
    'estorno dela, e o estorno some da fatura do cartão');
  assert.strictEqual(cat._mlbAssuntoDoCredito('Cancelamento de tarifa de envio'), 'frete',
    'o estorno de envio precisa se identificar como frete: ele NÃO é do cartão, e confundi-lo ' +
    'com um de cartão acusaria o que está certo');
  assert.strictEqual(cat._mlbAssuntoDoCredito('Cobrança por campanha de publicidade'), null,
    'uma COBRANÇA não é crédito — se ganhar assunto, entra na conta dos estornos');

  /* e a auditoria agrupa pelo assunto, senão devolve um balde `credito` só */
  const tc = {
    a: { d: '2026-09-01', v: 4738.79, c: 'ads', cartao: true },
    b: { d: '2026-09-02', v: -527.09, c: 'credito', a: 'ads', cartao: false },
    c: { d: '2026-09-03', v: -2492.05, c: 'credito', a: 'frete', cartao: false },
  };
  const rc = aud.abrirCiclo(tc, '2026-09-01');
  assert.deepStrictEqual(rc.creditos_fora_por_categoria, { ads: -527.09, frete: -2492.05 },
    'a quebra agrupou pela categoria (tudo `credito`) em vez do assunto — não responde nada');
  assert.strictEqual(rc.creditos_fora_de_categoria_de_cartao, -527.09,
    'o estorno de Ads não foi reconhecido como pertencente ao cartão');
}

console.log('OK: raio-x da fatura reproduz o total do painel e isola as 3 hipoteses da divergencia');
