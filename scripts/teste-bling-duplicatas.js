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

  /* e a falha de leitura não pode virar "zero duplicatas" silencioso — `erro` PRECISA vir
     preenchido, porque `pedidos_lidos === 0` sozinho é exatamente o que a regressão original
     também devolvia (Codex #529 P2: a asserção anterior passava sem o `ok:false` ser tratado) */
  const r2 = await procurar(async () => ({ ok: false, status: 401, data: null }), '2026-09-01', '2026-09-30', {});
  assert.ok(r2.erro, 'falha na consulta ao Bling (ok:false) não marcou erro');
  assert.strictEqual(r2.pedidos_lidos, 0, 'falha na consulta ao Bling não deveria ter lido pedido nenhum');

  /* Codex #529 P2: um `ok:true` com corpo vazio/malformado (o wrapper devolve
     `{ok:true, data:null}` quando o 2xx não é JSON válido) não pode cair no mesmo `[]` de
     "página sem pedidos" — senão volta a ser a mesma regressão calada, só que atrás de um
     `ok:true`. */
  const r3 = await procurar(async () => ({ ok: true, status: 200, data: null }), '2026-09-01', '2026-09-30', {});
  assert.ok(r3.erro, 'corpo ok:true malformado (data:null) não marcou erro');
  assert.strictEqual(r3.pedidos_lidos, 0, 'corpo malformado não deveria ter lido pedido nenhum');

  /* período genuinamente sem pedidos: `data.data` é um array VÁLIDO vazio — isso não é erro */
  const r4 = await procurar(async () => ({ ok: true, status: 200, data: { data: [] } }), '2026-09-01', '2026-09-30', {});
  assert.strictEqual(r4.erro, null, 'período sem pedidos nenhum não é uma falha de consulta');
  assert.strictEqual(r4.pedidos_lidos, 0, 'período sem pedidos deveria ler zero pedidos');

  /* Codex #529 P2: /situacoes/modulos/{id} é paginado — uma situação que só aparece na 2ª
     página não pode ficar sem nome em por_situacao */
  const pedidosDuasPaginas = [
    { id: 10, numero: '200', data: '2026-09-05', total: 100, contato: { nome: 'X', numeroDocumento: '1' }, situacao: { id: 150 } },
  ];
  const situacoesPagina1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, nome: 'Situação ' + (i + 1) }));
  const situacoesPagina2 = [{ id: 150, nome: 'Bonificação' }];
  const blingGetPaginado = async (caminho) => {
    if (/\/pedidos\/vendas/.test(caminho)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(caminho) ? pedidosDuasPaginas : [] } };
    if (/\/situacoes\/modulos\/\d+\?pagina=1/.test(caminho)) return { ok: true, status: 200, data: { data: situacoesPagina1 } };
    if (/\/situacoes\/modulos\/\d+\?pagina=2/.test(caminho)) return { ok: true, status: 200, data: { data: situacoesPagina2 } };
    if (/\/situacoes\/modulos$/.test(caminho)) return { ok: true, status: 200, data: { data: [{ id: 1, nome: 'Vendas' }] } };
    return { ok: true, status: 200, data: { data: [] } };
  };
  const r5 = await procurar(blingGetPaginado, '2026-09-01', '2026-09-30', {});
  assert.strictEqual(r5.por_situacao['150'] && r5.por_situacao['150'].nome, 'Bonificação',
    'situação da 2ª página de /situacoes/modulos/{id} ficou sem nome — a paginação não rodou até o fim');

  console.log('OK: duplicatas — le o envelope do Bling (antes devolvia ZERO calado), distingue corpo malformado de vazio legitimo, e pagina os nomes de situacao');
})().catch(e => { console.error(e); process.exit(1); });
