'use strict';
/* 15/10 — os códigos de situação da nota no Bling (API v3): 1 pendente · 2 cancelada · 4 rejeitada ·
   5 AUTORIZADA · 9 denegada · 10 consulta situação. O Corrigir-NFs tratava 5 como "denegada" e 2 como
   "autorizada": puxava notas AUTORIZADAS como candidatas e podia mandar salvar/reenviar nelas. Caso real
   que confirmou: a série 2 emitida pelo ML (AMB, 009768) volta do Bling com situacao 5; e o F3 já lista
   as autorizadas com situacao=5. Roda as funções DE PRODUÇÃO. */
const assert = require('assert');
const urls = [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
  exports: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{"data":[]}' }; } };
const { criarNfBlingApi } = require('../lib/fiscal/nf-bling-api');
const { criarFluxoNF } = require('../lib/fiscal/nf-fluxos');

(async () => {
  // 1) a busca de candidatas pede pendente, rejeitada e denegada — NUNCA autorizada
  const api = criarNfBlingApi({ rotulo: 'T', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' }, envPausa: 'T_NF_PAUSA', envIntermediadorCnpj: 'T_IC', envIntermediadorNome: 'T_IN', intermediadorCnpj: '03007331000141', intermediadorNome: 'T', pastaCacheIE: require('os').tmpdir() });
  await api.getNFsParaCorrigir('t');
  const sits = urls.map(u => (/situacao=(\d+)/.exec(u) || [])[1]).filter(Boolean);
  assert.deepStrictEqual(sits, ['1', '4', '9'], 'situações pedidas: ' + sits.join(','));

  // 2) o fluxo: autorizada (5) e cancelada (2) são puladas; denegada (9) não é salva nem reenviada; pendente (1) é
  const salvas = [], enviadas = [];
  const notas = [5, 2, 9, 1].map(sit => ({ id: 1000 + sit, numero: 'N' + sit, serie: 2, situacao: sit, numeroPedidoLoja: '', loja: { id: 1 },
    contato: { id: 9, numeroDocumento: '66595967120', ie: '', endereco: { endereco: '', cep: '', uf: 'DF', municipio: 'Brasília' } } }));
  const fluxo = criarFluxoNF({ envCooldown: 'T_NF_COOLDOWN',
    nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
    nfBlingApi: { sleepNF: async () => {}, getNFsParaCorrigir: async () => notas.map(n => ({ id: n.id, dataEmissao: new Date(Date.now() - 30 * 60000).toISOString() })),
      getNFDetalhe: async (tk, id) => JSON.parse(JSON.stringify(notas.find(n => n.id === id))),
      salvarNF: async (tk, id) => { salvas.push(id); }, enviarNF: async (tk, id) => { enviadas.push(id); }, getContato: async () => null,
      atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null } });
  await fluxo.corrigirNFsPendentes();
  assert.deepStrictEqual(salvas, [1001], 'salvou nota que não aceita edição: ' + salvas.join(','));
  assert.deepStrictEqual(enviadas, [1001], 'reenviou nota que não podia: ' + enviadas.join(','));

  // 3) o reenvio manual recusa autorizada, cancelada e denegada com o motivo certo
  const um = (sit) => criarFluxoNF({ envCooldown: 'T_NF_COOLDOWN', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
    nfBlingApi: { sleepNF: async () => {}, getNFsParaCorrigir: async () => [], getNFDetalhe: async () => ({ id: 7, situacao: sit }), salvarNF: async () => {},
      enviarNF: async () => { throw new Error('não era pra reenviar'); }, getContato: async () => null, atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null } });
  for (const [sit, re] of [[5, /já autorizada/], [2, /cancelada/], [9, /denegada/]]) {
    const r = await um(sit).retryNFManual(7);
    assert.ok(r && r.ok === false && re.test(r.erro), 'situação ' + sit + ': ' + JSON.stringify(r));
  }
  console.log('ok — Corrigir-NFs usa os códigos do Bling: não puxa nem mexe em nota autorizada (5), cancelada (2) ou denegada (9)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
