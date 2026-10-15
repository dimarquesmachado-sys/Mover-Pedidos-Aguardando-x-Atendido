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

/* o processo NÃO pode sair antes do fim (timer de prazo é unref): se sair, o teste falha em vez de passar calado */
let _chegouAoFim = false;
process.on('beforeExit', () => { if (!_chegouAoFim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
const _vivo = setInterval(() => {}, 1000);
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
  // 5b) Codex #699: confirmado uma vez, continua segurado mesmo se o ML ficar fora depois (cooldown 0 pra rever já)
  process.env.TESTE_NF_COOLDOWN_MIN = '0';
  { let vez = 0; m = montar([nota(4920)], () => (++vez === 1 ? true : null)); await m.api.corrigirNFsPendentes(); await m.api.corrigirNFsPendentes();
    assert.deepStrictEqual(m.enviadas, [], 'um ML fora do ar devolveu o Full confirmado à transmissão');
    // ... e o reenvio MANUAL também recusa (mesma guarda)
    const r = await m.api.retryNFManual(4920);
    assert.ok(r && r.ok === false && /segurada/.test(r.erro), 'o reenvio manual transmitiria a série 1 do Full: ' + JSON.stringify(r));
    assert.deepStrictEqual(m.enviadas, []); }
  // 5c) reenvio manual de Full nunca visto: pergunta e recusa
  { m = montar([nota(4921)], () => true); const r = await m.api.retryNFManual(4921);
    assert.ok(r && r.ok === false && /venda FULL/.test(r.erro)); assert.deepStrictEqual(m.enviadas, []); }
  // 5d) loja que NÃO é do ML com número longo (TikTok) nem pergunta ao ML
  { m = montar([nota(4922, { numeroPedidoLoja: '577012345678901234', loja: { id: 555 } })], () => true); await m.api.corrigirNFsPendentes();
    assert.deepStrictEqual(m.perguntas, [], 'perguntou ao ML por nota de outra loja'); assert.deepStrictEqual(m.enviadas, [4922]); }
  // 5e) nota segurada que saiu da lista sai do aviso
  { const lista = [nota(4923)]; let cand = lista.slice();
    const env = [], api = criarFluxoNF({ envCooldown: 'TESTE_NF_COOLDOWN_MIN', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
      nfBlingApi: { sleepNF: async () => {}, getNFsParaCorrigir: async () => cand.map(n => ({ id: n.id, dataEmissao: new Date(Date.now() - 20 * 60000).toISOString() })),
        getNFDetalhe: async (tk, id) => JSON.parse(JSON.stringify(lista.find(n => n.id === id))), salvarNF: async () => {}, enviarNF: async (tk, id) => { env.push(id); },
        getContato: async () => null, atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null },
      ehVendaFullML: async () => true, lojasML: [203146903] });
    await api.corrigirNFsPendentes(); assert.strictEqual(api.getEstadoRetrySEFAZ().full_seguradas.length, 1);
    cand = []; await api.corrigirNFsPendentes(); assert.strictEqual(api.getEstadoRetrySEFAZ().full_seguradas.length, 0, 'nota que saiu da lista continuou no aviso'); }
  // 6) a peça do "é Full?": prazo e token reaproveitado
  { const { criarClassificadorFullML } = require('../lib/fiscal/classificar-full-ml');
    let tokens = 0;
    const clf = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => { tokens++; return 'tk'; } }, prazoMs: 50,
      mlApi: { getShipmentInfo: async () => 77, getShipmentRaw: async () => ({ httpStatus: 200, data: { logistic: { type: 'fulfillment' } } }) } });
    assert.strictEqual(await clf('2000018992779962'), true); assert.strictEqual(await clf('2000018992779963'), true);
    assert.strictEqual(tokens, 1, 'pediu token ao ML a cada nota');
    const lento = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => 'tk' }, prazoMs: 30, mlApi: { getShipmentInfo: () => new Promise(() => {}), getShipmentRaw: async () => null } });
    await assert.rejects(() => lento('2000018992779962'), /não respondeu/, 'chamada pendurada ao ML não tem prazo');
    const comum = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => 'tk' }, mlApi: { getShipmentInfo: async () => 77, getShipmentRaw: async () => ({ httpStatus: 200, data: { logistic: { type: 'cross_docking' } } }) } });
    assert.strictEqual(await comum('2000018992779962'), false); }
  // 6b) Codex #699 r3: token guardado recusado (401) — pega token novo e tenta de novo, em vez de virar "não sei"
  { const { criarClassificadorFullML } = require('../lib/fiscal/classificar-full-ml');
    let tk = 0, chamadas = 0;
    const clf = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => 'tk' + (++tk) },
      mlApi: { getShipmentInfo: async (token) => { chamadas++; if (token === 'tk1') throw new Error('AMB ML busca pedido X erro 401: invalid token'); return 77; },
               getShipmentRaw: async () => ({ httpStatus: 200, data: { logistic: { type: 'fulfillment' } } }) } });
    assert.strictEqual(await clf('2000018992779962'), true, 'token recusado virou "não sei"'); assert.strictEqual(tk, 2); assert.strictEqual(chamadas, 2);
    let tk2 = 0;
    const clf2 = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => 'k' + (++tk2) },
      mlApi: { getShipmentInfo: async () => 77, getShipmentRaw: async (token) => token === 'k1' ? { httpStatus: 401, data: {} } : { httpStatus: 200, data: { logistic: { type: 'fulfillment' } } } } });
    assert.strictEqual(await clf2('2000018992779962'), true, '401 no envio virou "não sei"'); }
  // 6b2) Codex #699 r4: o prazo CANCELA a chamada (signal abortado) e o 401 do PACK chega como 401 (renova o token)
  { const { criarClassificadorFullML } = require('../lib/fiscal/classificar-full-ml');
    let sinal = null;
    const lento = criarClassificadorFullML({ mlTokenManager: { garantirTokenML: async () => 'tk' }, prazoMs: 30,
      mlApi: { getShipmentInfo: (tk, nl, op) => { sinal = op && op.signal; return new Promise(() => {}); }, getShipmentRaw: async () => null } });
    await assert.rejects(() => lento('2000018992779962'), /não respondeu/);
    assert.ok(sinal && sinal.aborted, 'o prazo não cancelou a chamada pendurada');
    const urlsP = [], resps = { orders: 404, packs: 401 };
    require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
      exports: async (u) => { urlsP.push(String(u)); const st = /\/packs\//.test(u) ? resps.packs : resps.orders; return { ok: st === 200, status: st, json: async () => ({}), text: async () => 'x' }; } };
    delete require.cache[require.resolve('../lib/fiscal/ml-api')];
    const mlApi = require('../lib/fiscal/ml-api').criarMlApi({ rotulo: 'T' });
    await assert.rejects(() => mlApi.getShipmentInfo('tk', '2000012345678901'), /erro 401/, 'o 401 do pack virou o 404 do pedido');
    assert.ok(urlsP.some(u => /\/packs\//.test(u))); }
  // 6c) Codex #699 r3: lista com 100+ candidatas (incompleta) não apaga segurada que caiu fora da 1ª página
  { const base = [nota(4930)]; const muitas = Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i, dataEmissao: new Date().toISOString() }));
    let cand = 'so-ela';
    const api = criarFluxoNF({ envCooldown: 'TESTE_NF_COOLDOWN_MIN', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
      nfBlingApi: { sleepNF: async () => {}, getNFsParaCorrigir: async () => cand === 'so-ela' ? [{ id: 4930, dataEmissao: new Date(Date.now() - 20 * 60000).toISOString() }] : muitas,
        getNFDetalhe: async (tk, id) => id === 4930 ? JSON.parse(JSON.stringify(base[0])) : null, salvarNF: async () => {}, enviarNF: async () => {},
        getContato: async () => null, atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null },
      ehVendaFullML: async () => true, lojasML: [203146903] });
    await api.corrigirNFsPendentes(); cand = 'cem'; await api.corrigirNFsPendentes();
    assert.strictEqual(api.getEstadoRetrySEFAZ().full_seguradas.length, 1, 'lista incompleta apagou a segurada'); }
  // 6d) Codex #699 r3: órfã é reavaliada — ligada a um pedido que NÃO é Full, segue a regra normal e é transmitida
  { const n = nota(4931, { numeroPedidoLoja: '' }); const env = [];
    const api = criarFluxoNF({ envCooldown: 'TESTE_NF_COOLDOWN_MIN', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' },
      nfBlingApi: { sleepNF: async () => {}, getNFsParaCorrigir: async () => [{ id: 4931, dataEmissao: new Date(Date.now() - 20 * 60000).toISOString() }],
        getNFDetalhe: async () => JSON.parse(JSON.stringify(n)), salvarNF: async () => {}, enviarNF: async (tk, id) => { env.push(id); },
        getContato: async () => null, atualizarIEContato: async () => {}, getCidadePorCEP: async () => null, getIEPorCNPJ: async () => null },
      ehVendaFullML: async () => false, lojasML: [203146903] });
    await api.corrigirNFsPendentes(); assert.deepStrictEqual(env, [], 'órfã transmitida');
    n.numeroPedidoLoja = '2000018992779962'; await api.corrigirNFsPendentes();
    assert.deepStrictEqual(env, [4931], 'órfã ligada a pedido não-Full ficou presa pra sempre');
    assert.strictEqual(api.getEstadoRetrySEFAZ().full_seguradas.length, 0); }
  // 7) as três empresas de hoje montam o fluxo pelas FACHADAS (não pelo montar-empresa): a guarda chega por elas
  const fs = require('fs'), path = require('path');
  for (const pasta of ['ambtotal', 'good', 'girassol']) {
    const src = fs.readFileSync(path.join(__dirname, '..', pasta, 'nfFluxos.js'), 'utf8');
    assert.ok(/ehVendaFullML: [\s\S]{0,200}classificar-full-ml'\)\.criarClassificadorFullML\(\{ rotulo: '[a-z]+', mlTokenManager: require\('\.\/mlTokenManager'\) \}\)/.test(src), pasta + ': a fachada não liga o "é Full?"');
    assert.ok(/get lojasML\(\) \{ try \{ const b = require\('\.\/blingApi'\)/.test(src), pasta + ': a fachada não entrega as lojas do ML');
  }
  const me = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'montar-empresa.js'), 'utf8');
  assert.ok(/criarClassificadorFullML\(\{ rotulo, mlTokenManager, mlApi \}\)/.test(me) && /ehVendaFullML,[\s\S]{0,200}lojasML: Array\.isArray\(blingApi\.ME_LOJA_IDS\)/.test(me), 'a fábrica de empresa nova não liga a guarda');
  _chegouAoFim = true; clearInterval(_vivo);
  console.log('ok — Corrigir-NFs não transmite série 1 de venda FULL confirmada pelo ML; o resto segue como sempre');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
