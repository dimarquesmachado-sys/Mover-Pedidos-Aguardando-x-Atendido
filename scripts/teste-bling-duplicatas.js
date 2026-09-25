/* 24/09 — RETOMADA DO #314, que ficou 596 commits pra trás.

   O BUG PRINCIPAL era mudo: `procurar` lia `r.data` como se fosse a lista, mas o `blingGet`
   devolve ENVELOPE (`{ok, status, data:{data:[...]}}`). Resultado: a rota varria o período,
   não lia pedido nenhum e respondia ZERO duplicatas — que é exatamente o que ela responderia
   se estivesse tudo certo. O dono leria "nenhuma duplicata" e seguiria em frente.

   E a quebra por SITUAÇÃO veio junto: sem ela não dá pra saber se um valor alto no período é
   venda de verdade ou transferência/devolução, que foi a hipótese dele nos R$ 51 mil. */
const assert = require('assert');
const path = require('path');
const { procurar } = require(path.join(__dirname, '..', 'lib', 'bling-duplicatas'));

/* resposta no formato REAL do blingGet — envelope, não array solto */
const pedidos = [
  { id: 1, numero: '100', data: '2026-09-01', total: 51000, contato: { nome: 'ACME', numeroDocumento: '123' }, situacao: { id: 9 } },
  { id: 2, numero: '101', data: '2026-09-01', total: 51000, contato: { nome: 'ACME', numeroDocumento: '123' }, situacao: { id: 12 } },
  { id: 3, numero: '102', data: '2026-09-02', total: 10, contato: { nome: 'Outro', numeroDocumento: '999' }, situacao: { id: 9 } },
];

(async () => {
  let pag = 0;
  const blingGet = async () => { pag++; return { ok: true, status: 200, data: { data: pag === 1 ? pedidos : [] } }; };
  const r = await procurar(blingGet, '2026-09-01', '2026-09-30', {});

  /* o coração do bug: com a leitura errada isto era 0, e a resposta parecia "está tudo certo" */
  assert.strictEqual(r.pedidos_lidos, 3,
    'a leitura da resposta do Bling voltou a ignorar o envelope — a rota diz "nenhuma duplicata" ' +
    'sem ter lido pedido nenhum, e ninguém descobre');

  assert.strictEqual(r.lista_suspeitas_mesmo_dia.length, 1,
    'não achou a duplicata óbvia (mesmo cliente, mesmo valor, mesmo dia)');
  assert.strictEqual(r.lista_suspeitas_mesmo_dia[0].valor, 51000, 'agrupou o valor errado');
  assert.strictEqual(r.lista_suspeitas_mesmo_dia[0].qtd, 2, 'contou errado os pedidos do grupo');

  /* a quebra por situação: é ela que separa venda de transferência/devolução num valor alto */
  assert.deepStrictEqual(Object.keys(r.por_situacao).sort(), ['12', '9'],
    'a quebra por situação sumiu — sem ela, um valor alto no período não dá pra explicar');
  assert.strictEqual(r.por_situacao['9'].qtd, 2, 'contagem por situação errada');
  assert.strictEqual(r.total_do_periodo, 102010, 'o total do período não bate com os pedidos lidos');

  /* e a falha de leitura não pode virar "zero duplicatas" silencioso */
  const r2 = await procurar(async () => ({ ok: false, status: 401, data: null }), '2026-09-01', '2026-09-30', {});
  assert.ok(r2.erro || r2.pedidos_lidos === 0,
    'falha na consulta ao Bling devolve resultado vazio sem dizer que falhou');

  console.log('OK: duplicatas — le o envelope do Bling (antes devolvia ZERO calado) e quebra por situacao');
})().catch(e => { console.error(e); process.exit(1); });
