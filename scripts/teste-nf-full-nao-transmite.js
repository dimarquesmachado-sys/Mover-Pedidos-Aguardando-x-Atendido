'use strict';
/* 15/10 — o Corrigir-NFs transmitia TODA nota pendente com mais de 5 min. Caso da AMB (pedido 5692): o
   Bling gerou uma série 1 pra uma venda FULL do ML, por cima da série 2 que o ML emite — e este fluxo a
   autorizaria. Roda o fluxo DE PRODUÇÃO (lib/fiscal/nf-fluxos.js) com Bling e ML de mentira. */
const assert = require('assert');
const { criarFluxoNF } = require('../lib/fiscal/nf-fluxos');

function montar(nfs, respostaML, lojasML) {
  const enviadas = [], perguntas = [];
  const det = Object.fromEntries(nfs.map(n => [n.id, n]));
  const api = criarFluxoNF({
    envCooldown: 'TESTE_NF_COOLDOWN_MIN',
    nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
    nfBlingApi: {
      sleepNF: async () => {}, getNFsParaCorrigir: async () => nfs.map(n => ({ id: n.id, dataEmissao: new Date(Date.now() - 20 * 60000).toISOString() })),
      getNFDetalhe: async (tk, id) => JSON.parse(JSON.stringify(det[id])),
      salvarNF: async () => {}, enviarNF: async (tk, id) => { enviadas.push(id); }, getContato: async () => null,
      atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null },
    ehVendaFullML: respostaML ? async (nl) => { perguntas.push(nl); return respostaML(nl); } : undefined,
    lojasML: lojasML || [203146903],
  });
  return { api, enviadas, perguntas };
}
const nota = (id, extra) => Object.assign({ id, numero: '00' + id, serie: 1, situacao: 1, numeroPedidoLoja: '2000018992779962', loja: { id: 203146903 },
  contato: { id: 9, numeroDocumento: '66595967120', ie: '', endereco: { endereco: 'Rua X', cep: '', uf: 'DF', municipio: 'Brasília' } } }, extra);

(async () => {
  // 1) série 1 pendente de venda FULL confirmada: NÃO transmite, e fica listada
  let m = montar([nota(4905)], () => true);
  await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [], 'transmitiu a série 1 de venda Full');
  assert.deepStrictEqual(m.perguntas, ['2000018992779962']);
  const est = m.api.getEstadoRetrySEFAZ();
  assert.ok(est.full_seguradas && est.full_seguradas.some(x => x.id === '4905' && x.pedido_ml === '2000018992779962'), 'a nota segurada não aparece no estado');
  // 2) venda NÃO Full: transmite como sempre
  m = montar([nota(4906)], () => false); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [4906], 'deixou de transmitir nota normal');
  // 3) ML fora do ar (não sei): segue como sempre — não para o galpão por palpite
  m = montar([nota(4907)], () => { throw new Error('ML 503'); }); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [4907]);
  m = montar([nota(4908)], () => null); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [4908]);
  // 4) série 2 (a do próprio ML) e pedido que não é do ML: nem pergunta
  m = montar([nota(9768, { serie: 2 }), nota(4909, { numeroPedidoLoja: '', loja: { id: 777 } })], () => true); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.perguntas, [], 'perguntou ao ML sem precisar'); assert.deepStrictEqual(m.enviadas.sort(), [4909, 9768]);
  // 4b) O CASO REAL: série 1 de loja do ML SEM pedido vinculado (órfã) — não transmite, nem pergunta ao ML
  m = montar([nota(4905, { numeroPedidoLoja: '' })], () => false); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [], 'transmitiu a série 1 órfã de loja do ML');
  assert.ok(m.api.getEstadoRetrySEFAZ().full_seguradas.some(x => x.id === '4905' && /sem pedido/.test(x.motivo)));
  // ... mas série 1 sem pedido de loja que NÃO é do ML segue como sempre
  m = montar([nota(4911, { numeroPedidoLoja: '', loja: { id: 777 } })], () => true); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [4911]);
  // 5) empresa sem a pergunta ligada: comportamento de sempre
  m = montar([nota(4910)], null); await m.api.corrigirNFsPendentes();
  assert.deepStrictEqual(m.enviadas, [4910]);
  // 6) as três empresas recebem a pergunta (a montagem é a fábrica fiscal)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'fiscal', 'montar-empresa.js'), 'utf8');
  assert.ok(/criarFluxoNF\(\{[^}]*ehVendaFullML,[\s\S]{0,200}lojasML: Array\.isArray\(blingApi\.ME_LOJA_IDS\)/.test(src), 'a montagem por empresa não liga a pergunta ao ML e as lojas do ML');
  assert.ok(/raw\.data\.logistic && raw\.data\.logistic\.type\) \|\| raw\.data\.logistic_type/.test(src) && /tipo === 'fulfillment'/.test(src));
  console.log('ok — Corrigir-NFs não transmite série 1 de venda FULL confirmada pelo ML; o resto segue como sempre');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
