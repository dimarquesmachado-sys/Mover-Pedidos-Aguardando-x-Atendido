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
  // 10) Codex #707: só AUTORIZADA vai; pendente espera (6 h); denegada sai
  { const e10 = { janela: [], notas: { '1001': nota(1001, '1001', 'P1001', { situacao: 1 }), '1002': nota(1002, '1002', 'P1002', { situacao: 9 }) }, ml: { 'P1001': {}, 'P1002': {} } };
    const m10 = montar(e10); ag.gravar('teste', { '1001': { desde: new Date().toISOString(), proxima: 0 }, '1002': { desde: new Date().toISOString(), proxima: 0 } });
    await m10.f3.rotinaNFeML();
    assert.deepStrictEqual(m10.enviadas, [], 'mandou nota que não está autorizada'); const l10 = ag.ler('teste');
    assert.ok(l10['1001'] && l10['1001'].proxima > Date.now() && !l10['1002'], 'pendente tinha que esperar e denegada sair'); }
  // 11) Codex #707: a nota sem o nº do pedido usa o pedido guardado; nota de OUTRO pedido sai sem mandar
  { const e11 = { janela: [], notas: { '1101': nota(1101, '1101', ''), '1102': nota(1102, '1102', 'OUTRO') }, ml: { 'P1101': {}, 'P1102': {} } };
    const m11 = montar(e11); ag.gravar('teste', { '1101': { desde: new Date().toISOString(), proxima: 0, pedido_ml: 'P1101' }, '1102': { desde: new Date().toISOString(), proxima: 0, pedido_ml: 'P1102' } });
    await m11.f3.rotinaNFeML();
    assert.deepStrictEqual(m11.enviadas, ['1101'], 'não usou o pedido guardado (ou mandou a nota de outro pedido)'); assert.ok(!ag.ler('teste')['1102']); }
  // 12) Codex #707: registro feito no MEIO da rodada (o checkout gravou enquanto o F3 esperava o Bling) não some
  { const e12 = { janela: [], notas: {}, ml: { 'P1201': { st: 'pending', sub: 'buffered' } } };
    e12.notas = new Proxy({}, { get: (o, k) => { if (String(k) === '1201') { ag.registrar('teste', 9999, { pedido_ml: 'NOVO' }); return nota(1201, '1201', 'P1201'); } return undefined; } });
    const m12 = montar(e12); ag.gravar('teste', { '1201': { desde: new Date().toISOString(), proxima: 0 } });
    await m12.f3.rotinaNFeML();
    assert.ok(ag.ler('teste')['9999'], 'o registro feito no meio da rodada foi apagado pela gravação do F3'); }
  // 13) Codex #707: enviada pela lista fica como processada (a janela não manda de novo); buffered em ready_to_ship também espera
  { const e13 = { janela: [1301], notas: { '1301': nota(1301, '1301', 'P1301') }, ml: { 'P1301': {} } };
    const m13 = montar(e13); ag.gravar('teste', { '1301': { desde: new Date().toISOString(), proxima: 0 } });
    await m13.f3.rotinaNFeML(); assert.deepStrictEqual(m13.enviadas, ['1301']); assert.ok(m13.processados.has('1301'), 'enviada pela lista e não marcada como processada');
    await m13.f3.rotinaNFeML(); assert.deepStrictEqual(m13.enviadas, ['1301'], 'a janela mandou de novo');
    assert.strictEqual(ag.mlSegurando('ready_to_ship', 'buffered'), true, 'ready_to_ship/buffered tem que esperar na lista'); }
  // 14) Codex #707: pendente SEM XML (ainda não autorizada) espera — não é descartada
  { const e14 = { janela: [], notas: { '1401': nota(1401, '1401', 'P1401', { situacao: 1, xml: null }) }, ml: { 'P1401': {} } };
    const m14 = montar(e14); ag.gravar('teste', { '1401': { desde: new Date().toISOString(), proxima: 0, pedido_ml: 'P1401' } });
    await m14.f3.rotinaNFeML(); assert.ok(ag.ler('teste')['1401'] && ag.ler('teste')['1401'].proxima > Date.now(), 'pendente sem XML foi descartada'); }
  // 15) Codex #707: nota da lista não ocupa vaga do lote da janela (o corte acontece DEPOIS de tirar as da lista)
  { process.env.T_MAX = '1';
    const e15 = { janela: [1502, 1501], notas: { '1501': nota(1501, '1501', 'P1501'), '1502': nota(1502, '1502', 'P1502') }, ml: { 'P1501': {}, 'P1502': {} } };
    ag.gravar('teste', { '1502': { desde: new Date().toISOString(), proxima: Date.now() + 3600000 } });
    const m15 = montar(e15); await m15.f3.rotinaNFeML(); delete process.env.T_MAX;
    assert.deepStrictEqual(m15.enviadas, ['1501'], 'a nota da lista ocupou a única vaga do lote e a normal ficou de fora'); }
  // 16) Codex #707: reenvio manual com o disco sem gravar — a lista não manda de novo neste processo
  { const e16 = { janela: [], notas: { '1601': nota(1601, '1601', 'P1601') }, ml: { 'P1601': {} } };
    const m16 = montar(e16); ag.gravar('teste', { '1601': { desde: new Date().toISOString(), proxima: 0 } });
    const origA = ag.aplicar; ag.aplicar = () => false;
    await m16.f3.enviarNFeUnica(1601); const antes = m16.enviadas.length;
    await m16.f3.rotinaNFeML(); ag.aplicar = origA;
    assert.strictEqual(m16.enviadas.length, antes, 'reenvio manual sem gravar e a lista mandou de novo'); }
  // 17) Codex #707: as travadas vão pro cache DA EMPRESA (é de lá que o checkout lê)
  { const fs2 = require('fs'), p2 = require('path'), fon = fs2.readFileSync(p2.join(__dirname, '..', 'lib', 'fiscal', 'nfe-ml-fluxo.js'), 'utf8');
    assert.ok(/const _CACHE_TRAV = cfg\.dirTravadas \|\| process\.env\.CACHE_DIR \|\| '\/data';/.test(fon), 'o F3 não usa o diretório da empresa pras travadas');
    for (const [pasta, env] of [['ambtotal', 'AMBBKP_CACHE_DIR'], ['good', 'GOODBKP_CACHE_DIR'], ['girassol', 'GIRABKP_CACHE_DIR']]) {
      const fac = fs2.readFileSync(p2.join(__dirname, '..', pasta, 'nfeMlFluxo.js'), 'utf8');
      assert.ok(new RegExp('dirTravadas: process\\.env\\.' + env + ' \\|\\|').test(fac), pasta + ': a fachada não manda as travadas pro cache que o checkout lê');
    } }
  // 18) acerto do #707: erro PERMANENTE do ML com a lista de travadas sem gravar — a nota NÃO sai da lista de espera
  { const trav = require('../lib/nf-travadas'); const origR = trav.registrar;
    trav.registrar = (dir, d) => Object.assign(origR(dir, d), { gravou: false });
    const erroPerm = new Error('ML recusou a NF: wrong_receiver_zipcode — zipcode must be the same');
    const e18 = { janela: [], notas: { '1801': nota(1801, '1801', 'P1801') }, ml: { 'P1801': { erro: erroPerm } } };
    const m18 = montar(e18); ag.gravar('teste', { '1801': { desde: new Date().toISOString(), proxima: 0 } });
    await m18.f3.rotinaNFeML(); trav.registrar = origR;
    assert.ok(trav.classificar(erroPerm.message), 'o teste precisa de um erro que o registro considere permanente');
    assert.ok(ag.ler('teste')['1801'], 'erro permanente sem conseguir gravar a travada e a nota sumiu da lista'); }
  console.log('ok — F3: nota de envio que o ML está segurando vai pra lista de espera e é enviada quando o ML pedir, fora da janela');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

/* 17/10 — a PONTE do checkout (resgate das notas de antes do conserto): nos três ciclos, o pedido "aguardando o ML
   liberar" com nota registra a nota na lista de espera do F3 da empresa certa, só com a consulta ao ML confirmada,
   sem regravar quem já está na lista */
for (const [emp, arq] of [['amb', 'amb-checkout-offline/ciclo.js'], ['good', 'good-checkout-offline/ciclo.js'], ['girassol', 'girassol-backup-offline/ciclo.js']]) {
  const src = require('./_fonte-ciclo').ler(require('path').join(__dirname, '..'), arq);   /* 30/10: o ciclo como a empresa o roda (peça única) */
  const i = src.indexOf('_aguardaDispML = true;'), j = src.indexOf('} else {\n      if (_stOk) _aguardaDispML = false;', i);
  const bloco = src.slice(i, j);
  assert.ok(/if \(_stOk && nf && nf\.id && \(nf\._criterio === 'exato' \|\| nf\._criterio === 'direto'\)\) \{/.test(bloco), emp + ': a ponte não está no bloco do "aguardando o ML liberar" (ou não exige consulta confirmada e nota casada exata/diretamente)');
  /* Codex #707: o vínculo DIRETO do Bling (nfDoPedido passos 1-2) é marcado 'direto'; o palpite por faixa, 'faixa' */
  /* 25/10: o nf.js da empresa virou a peça única lib/checkout/nf-pedido — a busca da NF mora lá */
  const _nf0 = require('fs').readFileSync(require('path').join(__dirname, '..', arq.replace('ciclo.js', 'nf.js')), 'utf8');
  const nfsrc = /lib\/checkout\/nf-pedido/.test(_nf0) ? _nf0 + '\n' + require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'nf-pedido.js'), 'utf8') : _nf0;
  assert.strictEqual((nfsrc.match(/p\._criterio = 'direto'/g) || []).length, 2, emp + ': nfDoPedido não marca os dois vínculos diretos');
  assert.ok(/acharNFporRange\(id\); if \(p && !p\._criterio\) p\._criterio = 'faixa'/.test(nfsrc), emp + ': o palpite por faixa do nfDoPedido não é marcado');
  assert.ok(new RegExp("_agF3\\.ler\\('" + emp + "'\\)\\[String\\(nf\\.id\\)\\]\\) _agF3\\.registrar\\('" + emp + "', nf\\.id,").test(bloco), emp + ': a ponte não registra na lista da empresa certa (ou regrava)');
}
console.log('ok — a ponte do checkout registra as notas de pedidos retidos pelo ML nas três empresas');
