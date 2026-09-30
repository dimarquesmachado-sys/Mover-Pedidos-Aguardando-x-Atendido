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
console.log('OK: raio-x da fatura reproduz o total do painel e isola as 3 hipoteses da divergencia');
