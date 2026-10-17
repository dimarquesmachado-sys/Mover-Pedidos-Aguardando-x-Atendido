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
  // 6) Codex #707: a lista não gravou (disco) → a nota NÃO fica como processada (a janela tenta de novo)
  { const orig = ag.registrar; ag.registrar = () => false;
    const e6 = { janela: [601], notas: { '601': nota(601, '601', 'P601') }, ml: { 'P601': { st: 'pending', sub: 'buffered' } } };
    const m6 = montar(e6); await m6.f3.rotinaNFeML(); ag.registrar = orig;
    assert.ok(!m6.processados.has('601'), 'lista não gravou e a nota ficou como processada (sumiria)'); }
  // 7) Codex #707: nota que está na lista (veio do checkout) e ainda na janela — só a lista manda, uma vez
  { const e7 = { janela: [701], notas: { '701': nota(701, '701', 'P701') }, ml: { 'P701': {} } };
    ag.gravar('teste', { '701': { desde: new Date().toISOString(), proxima: 0, origem: 'checkout' } });
    const m7 = montar(e7); await m7.f3.rotinaNFeML();
    assert.deepStrictEqual(m7.enviadas, ['701'], 'a nota da lista foi mandada duas vezes (janela e lista) ou nenhuma'); assert.ok(!ag.ler('teste')['701']); }
  // 8) Codex #707: 404 do Bling (nota não existe mais) sai da lista; outro erro volta em 30 min
  { const e8 = { janela: [], notas: {}, ml: {} };
    const m8 = montar(e8);
    ag.gravar('teste', { '801': { desde: new Date().toISOString(), proxima: 0 } });
    const origDet = e8.notas; e8.notas = new Proxy({}, { get: (o, k) => { throw new Error('API Bling TESTE (detalhe NF=801) HTTP 404'); } });
    await m8.f3.rotinaNFeML(); e8.notas = origDet;
    assert.ok(!ag.ler('teste')['801'], 'nota que não existe mais (404) continuou na lista'); }
  // 9) Codex #707: reenvio MANUAL que deu certo tira a nota da lista
  { const e9 = { janela: [], notas: { '901': nota(901, '901', 'P901') }, ml: { 'P901': {} } };
    const m9 = montar(e9);
    ag.gravar('teste', { '901': { desde: new Date().toISOString(), proxima: Date.now() + 3600000 } });
    const r = await m9.f3.enviarNFeUnica(901);
    assert.ok(r && r.ok, 'reenvio manual falhou no teste'); assert.ok(!ag.ler('teste')['901'], 'reenvio manual deixou a nota na lista (a lista mandaria de novo)'); }
  console.log('ok — F3: nota de envio que o ML está segurando vai pra lista de espera e é enviada quando o ML pedir, fora da janela');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

/* 17/10 — a PONTE do checkout (resgate das notas de antes do conserto): nos três ciclos, o pedido "aguardando o ML
   liberar" com nota registra a nota na lista de espera do F3 da empresa certa, só com a consulta ao ML confirmada,
   sem regravar quem já está na lista */
for (const [emp, arq] of [['amb', 'amb-checkout-offline/ciclo.js'], ['good', 'good-checkout-offline/ciclo.js'], ['girassol', 'girassol-backup-offline/ciclo.js']]) {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', arq), 'utf8');
  const i = src.indexOf('_aguardaDispML = true;'), j = src.indexOf('} else {\n      if (_stOk) _aguardaDispML = false;', i);
  const bloco = src.slice(i, j);
  assert.ok(/if \(_stOk && nf && nf\.id\) \{/.test(bloco), emp + ': a ponte não está no bloco do "aguardando o ML liberar" (ou não exige a consulta confirmada)');
  assert.ok(new RegExp("_agF3\\.ler\\('" + emp + "'\\)\\[String\\(nf\\.id\\)\\]\\) _agF3\\.registrar\\('" + emp + "', nf\\.id,").test(bloco), emp + ': a ponte não registra na lista da empresa certa (ou regrava)');
}
console.log('ok — a ponte do checkout registra as notas de pedidos retidos pelo ML nas três empresas');
