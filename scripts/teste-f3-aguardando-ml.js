'use strict';
/* 17/10 — o F3 manda a nota ao ML só em invoice_pending, olha só os últimos dias e desiste em ~3 h. Venda que o ML
   SEGURA (pending/buffered = coleta programada; manufacturing = aguardando estoque) pede a nota semanas depois — a
   nota caía fora da janela e nunca chegava ao ML (etiqueta presa no dia da coleta). Roda o F3 DE PRODUÇÃO com Bling
   e ML de mentira e prova a lista de espera durável. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3ag-'));
process.env.CACHE_DIR = dir;
const ag = require('../lib/fiscal/f3-aguardando-ml');
const { criarFluxoNFeML } = require('../lib/fiscal/nfe-ml-fluxo');

// a peça da lista
assert.strictEqual(ag.mlSegurando('pending', 'buffered'), true);
assert.strictEqual(ag.mlSegurando('pending', 'manufacturing'), true);
assert.strictEqual(ag.mlSegurando('handling', 'manufacturing'), true);
assert.strictEqual(ag.mlSegurando('ready_to_ship', 'ready_to_print'), false);
assert.strictEqual(ag.mlSegurando('handling', 'waiting_for_label_generation'), false);
assert.ok(ag.registrar('teste', 1, { a: 1 }) && ag.ler('teste')['1'].a === 1 && ag.ler('teste')['1'].desde, 'registrar/ler');

function montar(est) {
  const processados = new Set(), enviadas = [];
  const erroML = (st, sub) => Object.assign(new Error(`Shipment 1 status=${st} substatus=${sub} (não é invoice_pending) — NF não pode ser enviada agora`), { mlStatus: st, mlSubstatus: sub });
  const f3 = criarFluxoNFeML({ rotulo: 'TESTE', envMaxNfeMl: 'T_MAX', envNfJanelaDias: 'T_JAN', envF3MaxChecagens: 'T_CHK',
    pecas: {
      tokenManager: { garantirToken: async () => 'tb', renovarToken: async () => 'tb' },
      mlTokenManager: { garantirTokenML: async () => 'tml' },
      blingApi: { ME_LOJA_IDS: [7], mensagemCanalFaltando: () => 'x', enviarNFeParaLojaVirtual: async () => ({}),
        getNFesAutorizadas: async () => est.janela.map(id => ({ id })),
        getNFeDetalhe: async (tk, id) => est.notas[String(id)] ? JSON.parse(JSON.stringify(est.notas[String(id)])) : null,
        jaProcessado: (f, id) => processados.has(String(id)), marcarProcessado: (f, id) => processados.add(String(id)) },
      mlApi: { enviarNFeParaML: async (tk, pedido, nf) => { const e = est.ml[String(pedido)]; if (e && e.erro) throw e.erro; if (e && e.st) throw erroML(e.st, e.sub); enviadas.push(nf.numero); } } } });
  return { f3, processados, enviadas, erroML };
}
const nota = (id, numero, pedido, extra) => Object.assign({ id, numero, numeroPedidoLoja: pedido, xml: 'http://x', loja: { id: 7 }, situacao: 5 }, extra);

(async () => {
  // 1) nota na janela de um envio que o ML está segurando (coleta programada): vai pra lista e sai da janela
  const est = { janela: [101, 102], notas: { '101': nota(101, '129506', '2000019012469390'), '102': nota(102, '129600', '2000019099999999') },
    ml: { '2000019012469390': { st: 'pending', sub: 'buffered' }, '2000019099999999': {} } };
  let m = montar(est);
  await m.f3.rotinaNFeML();
  assert.deepStrictEqual(m.enviadas, ['129600'], 'a nota normal tinha que ir');
  const l1 = ag.ler('teste');
  assert.ok(l1['101'] && l1['101'].substatus === 'buffered' && l1['101'].proxima > Date.now(), 'a nota do envio segurado não entrou na lista de espera');
  assert.ok(m.processados.has('101'), 'a janela continuaria batendo no ML a cada rodada');
  // 2) ainda segurando, antes do horário: não pergunta de novo; depois do horário e ainda segurando: volta em 6 h
  let perguntas = 0; const orig = est.ml['2000019012469390']; est.ml['2000019012469390'] = { get st() { perguntas++; return 'pending'; }, sub: 'buffered' };
  est.janela = [];                      // passou da janela de dias: a nota só existe na lista
  await m.f3.rotinaNFeML(); assert.strictEqual(perguntas, 0, 'perguntou ao ML antes do horário');
  const l2 = ag.ler('teste'); l2['101'].proxima = Date.now() - 1; ag.gravar('teste', l2);
  await m.f3.rotinaNFeML(); assert.ok(perguntas > 0 && ag.ler('teste')['101'].proxima > Date.now(), 'não reagendou o que segue segurado');
  // 3) chegou o dia: o ML pede a nota (invoice_pending) → envia, mesmo fora da janela, e sai da lista
  est.ml['2000019012469390'] = {};
  const l3 = ag.ler('teste'); l3['101'].proxima = Date.now() - 1; ag.gravar('teste', l3);
  await m.f3.rotinaNFeML();
  assert.deepStrictEqual(m.enviadas, ['129600', '129506'], 'no dia da coleta a nota não foi pro ML');
  assert.ok(!ag.ler('teste')['101'], 'a nota enviada continuou na lista');
  // 4) envio terminou/cancelou, nota cancelada no Bling, e erro passageiro
  est.notas['201'] = nota(201, '1', 'P201'); est.notas['202'] = nota(202, '2', 'P202', { situacao: 2 }); est.notas['203'] = nota(203, '3', 'P203');
  est.ml['P201'] = { st: 'cancelled', sub: 'x' }; est.ml['P203'] = { erro: new Error('ECONNRESET socket hang up') };
  ag.gravar('teste', { '201': { desde: new Date().toISOString(), proxima: 0 }, '202': { desde: new Date().toISOString(), proxima: 0 }, '203': { desde: new Date().toISOString(), proxima: 0 } });
  await m.f3.rotinaNFeML();
  const l4 = ag.ler('teste');
  assert.ok(!l4['201'] && !l4['202'], 'envio cancelado / nota cancelada continuaram na lista');
  assert.ok(l4['203'] && l4['203'].proxima > Date.now() && l4['203'].proxima <= Date.now() + 31 * 60000, 'erro passageiro: tinha que tentar de novo em ~30 min');
  // 5) 60 dias na espera: sai da lista (e loga)
  ag.gravar('teste', { '301': { desde: new Date(Date.now() - 61 * 86400000).toISOString(), proxima: 0 } });
  await m.f3.rotinaNFeML(); assert.ok(!ag.ler('teste')['301'], 'passou de 60 dias e continuou na lista');
  console.log('ok — F3: nota de envio que o ML está segurando vai pra lista de espera e é enviada quando o ML pedir, fora da janela');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
