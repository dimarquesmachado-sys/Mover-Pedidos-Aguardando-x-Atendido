'use strict';
/* 14/10 — resgate do histórico: pedido que nasce hoje com data de venda antiga. Exercita a
   função DE PRODUÇÃO (lib/checkout/backfill-resgate.js) com Bling/Supabase/backfill de mentira,
   e confere que as duas empresas ligaram a peça na noturna. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resgatar, planoDaNoturna } = require('../lib/checkout/backfill-resgate');

function bling(pedidos) {   // lista paginada de 100
  const chamadas = [];
  return { chamadas, blingGet: async (p) => {
    chamadas.push(p);
    const pg = Number(/pagina=(\d+)/.exec(p)[1]);
    return { ok: true, status: 200, data: { data: pedidos.slice((pg - 1) * 100, pg * 100) } };
  } };
}
function supa(existem) {   // `existem` pode ser mutável: o backfill de mentira "grava" nele
  return async (emp, met, q) => {
    assert.strictEqual(met, 'GET'); assert.ok(q.includes('empresa=eq.' + emp));
    const ids = decodeURIComponent(/in\.\(([^)]*)\)/.exec(q)[1]).split(',');
    return { ok: true, status: 200, body: JSON.stringify(ids.filter(i => existem.includes(i)).map(i => ({ numero_pedido: i }))) };
  };
}
(async () => {
  const de = '2026-10-11', ate = '2026-10-14';
  const lista = [
    { numero: 123645, data: '2026-10-10' },   // o caso real: alterado hoje, venda de antes da janela, fora do histórico
    { numero: 123700, data: '2026-10-13' },   // dentro da janela: o backfill normal já cuidou
    { numero: 120000, data: '2026-10-01' },   // antigo alterado, mas JÁ está no histórico
    { numero: 119000, data: '2026-09-28' },   // antigo, fora do histórico
    { numero: 119001, data: '2026-09-28' },   // mesmo dia
    { numero: 118000, data: '' },             // sem data: não dá pra situar
  ];
  // 1) modo alteração: só quem tem data ANTES da janela e não está no histórico; agrupa por dia
  let b = bling(lista), feitos = [];
  const grava = (ex) => async (d1, d2, e) => { feitos.push([d1, d2, e]); for (const p of lista) if (p.data === d1) ex.push(String(p.numero)); return { ok: true, desfecho: 'ok' }; };
  let ex1 = ['120000'];
  let r = await resgatar({ empresa: 'girassol', blingGet: b.blingGet, supaReq: supa(ex1), backfillVendas: grava(ex1) }, { de, ate, por: 'alteracao' });
  assert.ok(r.ok, JSON.stringify(r));
  // Codex #683: alteração é DATA-HORA no contrato do Bling
  assert.ok(b.chamadas[0].includes('dataAlteracaoInicial=' + encodeURIComponent(de + ' 00:00:00') + '&dataAlteracaoFinal=' + encodeURIComponent(ate + ' 23:59:59')), b.chamadas[0]);
  assert.strictEqual(r.candidatos, 4); assert.strictEqual(r.faltando, 3); assert.strictEqual(r.sem_data, 1);
  assert.deepStrictEqual(r.dias.map(d => d.dia), ['2026-09-28', '2026-10-10']);
  assert.deepStrictEqual(feitos, [['2026-09-28', '2026-09-28', 'girassol'], ['2026-10-10', '2026-10-10', 'girassol']]);
  assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-10']); assert.deepStrictEqual(r.adiados, []);
  // 2) modo data: considera todos (o de dentro da janela também), filtro dataInicial
  b = bling(lista); feitos = []; let ex2 = ['120000', '123700'];
  r = await resgatar({ empresa: 'amb', blingGet: b.blingGet, supaReq: supa(ex2), backfillVendas: async (d1, d2, e) => { feitos.push([d1, d2, e]); for (const p of lista) if (p.data === d1) ex2.push(String(p.numero)); return { ok: true, desfecho: 'ok' }; } }, { de: '2026-08-15', ate, por: 'data' });
  assert.ok(b.chamadas[0].includes('dataInicial=2026-08-15&dataFinal=' + ate));
  assert.strictEqual(r.candidatos, 5); assert.strictEqual(r.faltando, 3); assert.deepStrictEqual(feitos.map(x => x[0]), ['2026-09-28', '2026-10-10']); assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-10']);
  // 3) teto de dias: o resto fica adiado; somenteListar não roda nada
  b = bling(lista); feitos = [];
  let ex3 = [];
  r = await resgatar({ empresa: 'girassol', blingGet: b.blingGet, supaReq: supa(ex3), backfillVendas: grava(ex3) }, { de, ate, maxDias: 1 });
  assert.deepStrictEqual(r.resgatados, ['2026-09-28']); assert.deepStrictEqual(r.adiados, ['2026-10-01', '2026-10-10']);
  // Codex #683 (P2): o teto conta TENTATIVAS — falha genérica não ganha dia extra
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: false, desfecho: 'erro', msg: 'x' }; } }, { de, ate, maxDias: 5 });
  assert.deepStrictEqual(feitos, ['2026-09-28', '2026-10-01'], 'duas falhas seguidas param'); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']);
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => { throw new Error('nao era pra rodar'); } }, { de, ate, somenteListar: true });
  assert.strictEqual(r.faltando, 4); assert.deepStrictEqual(r.resgatados, []);
  // 4) backfill abortado (Bling limitado) PARA a rodada e deixa tudo adiado; ocupado idem
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: false, desfecho: 'abortado', transitorio: true, msg: '429' }; } }, { de, ate });
  assert.deepStrictEqual(feitos, ['2026-09-28']); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']); assert.ok(r.ok); assert.ok(/429/.test(r.ultimo_erro));
  b = bling(lista);
  r = await resgatar({ empresa: 'girassol', blingGet: b.blingGet, supaReq: supa([]), backfillVendas: async () => { throw new Error('nao era pra rodar'); }, backfillEstado: () => ({ rodando: true, de: '2026-07-01', ate: '2026-07-31' }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/em curso/.test(r.erro)); assert.strictEqual(b.chamadas.length, 0, 'Codex #683: ocupado = nem encosta no Bling');
  // 4b) AMB: backfill não devolve nada — o resultado está em backfillEstado(); reparo de SKU = adiado
  let estA = {}, exA = [];
  r = await resgatar({ empresa: 'amb', blingGet: bling(lista).blingGet, supaReq: supa(exA), backfillVendas: async (d1) => { estA = { de: d1, ate: d1, rodando: false, fase: d1 === '2026-10-01' ? 'erro' : 'concluido' }; if (d1 !== '2026-10-01') for (const p of lista) if (p.data === d1) exA.push(String(p.numero)); }, backfillEstado: () => estA }, { de, ate });
  assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-10']); assert.deepStrictEqual(r.adiados, ['2026-10-01']); assert.strictEqual(r.ultimo_erro, 'erro');
  estA = {};
  r = await resgatar({ empresa: 'amb', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => ({ adiado: 'reparo de SKU em andamento' }), backfillEstado: () => estA }, { de, ate });
  assert.deepStrictEqual(r.resgatados, []); assert.deepStrictEqual(r.adiados, ['2026-09-28', '2026-10-01', '2026-10-10']); assert.ok(/reparo/.test(r.ultimo_erro));
  // 4c) Codex #683 (P1): cancelado (situação do Bling ou cancelado no marketplace) NÃO é faltando
  const comCanc = lista.concat([{ numero: 117000, data: '2026-09-20', situacao: { id: 12 } }, { numero: 117001, data: '2026-09-21', numeroLoja: 'SHP-CANC' }]);
  feitos = []; let exC = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(comCanc).blingGet, supaReq: supa(exC), backfillVendas: async (d1) => { feitos.push(d1); for (const p of comCanc) if (p.data === d1) exC.push(String(p.numero)); return { ok: true, desfecho: 'ok' }; },
    situacoesCanceladas: async () => [12], canceladosMkt: () => new Set(['SHP-CANC']) }, { de, ate });
  assert.strictEqual(r.cancelados, 2); assert.ok(!feitos.includes('2026-09-20') && !feitos.includes('2026-09-21'), 'dia de cancelado não roda');
  // 4d) Codex #683 (P1): reconferir depois do backfill — ainda faltando após rodada LIMPA vira ignorado
  //     (memo em disco) e não volta à fila; após rodada COM ERROS o dia fica adiado
  const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resg-'));
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true, desfecho: 'ok' }; }, cacheDir: tmp }, { de, ate });
  assert.deepStrictEqual(r.resgatados, ['2026-09-28', '2026-10-01', '2026-10-10']); assert.deepStrictEqual((r.ignorados_agora || []).sort(), ['119000', '119001', '120000', '123645']);
  const memo = JSON.parse(fs.readFileSync(path.join(tmp, '_resgate_ignorados.json'), 'utf8')); assert.ok(memo['123645'] && memo['123645'].dia === '2026-10-10');
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true }; }, cacheDir: tmp }, { de: '2026-08-15', ate, por: 'data' });
  assert.strictEqual(r.ja_ignorados, 4); assert.strictEqual(r.faltando, 1, 'só o 123700 (dentro da janela, nunca ignorado)'); assert.deepStrictEqual(feitos, ['2026-10-13'], 'ignorado não volta à fila no domingo');
  // Codex #683 r2 (P1): no modo ALTERAÇÃO o ignorado é reconferido (foi alterado de novo); e expira em 30 dias
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true }; }, cacheDir: tmp }, { de, ate, por: 'alteracao' });
  assert.strictEqual(r.ja_ignorados, 0); assert.deepStrictEqual(feitos, ['2026-09-28', '2026-10-01', '2026-10-10']);
  const velho = JSON.parse(fs.readFileSync(path.join(tmp, '_resgate_ignorados.json'), 'utf8')); for (const k of Object.keys(velho)) velho[k].quando = '2026-08-01T00:00:00.000Z'; fs.writeFileSync(path.join(tmp, '_resgate_ignorados.json'), JSON.stringify(velho));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => ({ ok: true }), cacheDir: tmp }, { de: '2026-08-15', ate, por: 'data', somenteListar: true });
  assert.strictEqual(r.ja_ignorados, 0, 'ignorado velho expira');
  // Codex #683 r2 (P2): dia adiado pelo teto fica em disco e entra na fila da próxima rodada, na frente
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resg-')); feitos = []; let exT = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa(exT), backfillVendas: grava(exT), cacheDir: tmp2 }, { de, ate, maxDias: 1 });
  assert.deepStrictEqual(r.adiados, ['2026-10-01', '2026-10-10']);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp2, '_resgate_adiados.json'), 'utf8'))).sort(), ['2026-10-01', '2026-10-10']);
  feitos = [];   // próxima noite: o Bling não lista mais nada novo, mas o memo traz os dois dias
  r = await resgatar({ empresa: 'girassol', blingGet: bling([]).blingGet, supaReq: supa(exT), backfillVendas: grava(exT), cacheDir: tmp2 }, { de, ate });
  assert.strictEqual(r.adiados_do_memo, 2); assert.deepStrictEqual(feitos.map(x => x[0]), ['2026-10-01', '2026-10-10']); assert.deepStrictEqual(r.adiados, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp2, '_resgate_adiados.json'), 'utf8')), {}, 'memo zera quando tudo foi resgatado');
  // Codex #683 r4 (P2): fila em disco ANTES do laço (deploy no meio não perde nada) e dia que falhou vai pro FIM
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'resg-')); let viuMemo = null;
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { if (!viuMemo) viuMemo = JSON.parse(fs.readFileSync(path.join(tmp3, '_resgate_adiados.json'), 'utf8')); return { ok: true, desfecho: d1 === '2026-09-28' ? 'com_erros' : 'erro' }; }, cacheDir: tmp3 }, { de, ate });
  assert.deepStrictEqual(Object.keys(viuMemo).sort(), ['2026-09-28', '2026-10-01', '2026-10-10'], 'fila inteira no disco antes do 1º backfill');
  let memo3 = JSON.parse(fs.readFileSync(path.join(tmp3, '_resgate_adiados.json'), 'utf8'));
  assert.strictEqual(memo3['2026-09-28'].falhas, 1); assert.strictEqual(memo3['2026-10-01'].falhas, 1); assert.strictEqual(memo3['2026-10-10'].falhas, 0);
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling([]).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true, desfecho: 'com_erros' }; }, cacheDir: tmp3 }, { de, ate });
  assert.strictEqual(feitos[0], '2026-10-10', 'quem nunca falhou vai na frente');
  // Codex #683 r6 (P2): pedido do memo que ja entrou por outro caminho nao volta pra fila
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'resg-'));
  fs.writeFileSync(path.join(tmp5, '_resgate_adiados.json'), JSON.stringify({ '2026-09-01': { pedidos: ['900001'], falhas: 0 }, '2026-09-02': { pedidos: ['900002'], falhas: 0 } }));
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling([]).blingGet, supaReq: supa(['900001']), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true, desfecho: 'erro' }; }, cacheDir: tmp5 }, { de, ate });
  assert.deepStrictEqual(feitos, ['2026-09-02'], 'dia cujo pedido ja entrou nao roda'); assert.strictEqual(r.adiados_do_memo, 1);
  // Codex #683 r5 (P2): backfill que EXPLODE conta como falha do dia (vai pro fim da fila)
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'resg-'));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => { throw new Error('boom'); }, cacheDir: tmp4 }, { de, ate });
  const memo4 = JSON.parse(fs.readFileSync(path.join(tmp4, '_resgate_adiados.json'), 'utf8'));
  assert.strictEqual(memo4['2026-09-28'].falhas, 1); assert.strictEqual(memo4['2026-10-01'].falhas, 1); assert.ok(/boom/.test(r.ultimo_erro));
  // Codex #683 r5 (P2): as duas empresas passam o getter do Bling pra garantirSitCancel
  for (const f of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) assert.ok(/garantirSitCancel\(async p => await blingGet\(p\)\)\)\.ids/.test(require('./_fonte-noturna').fonteNoturna(f)), f + ' passa o getter');
  // Codex #683 r2 (P1): reserva da vaga durante a listagem, liberada antes de cada backfill de dia
  const trilha = []; let vaga = false;
  r = await resgatar({ empresa: 'girassol', blingGet: async (p) => { trilha.push('bling:' + (vaga ? 'reservado' : 'SEM-RESERVA')); return { ok: true, data: { data: lista.slice(0, 2) } }; }, supaReq: supa([]),
    backfillVendas: async (d1) => { trilha.push('backfill:' + (vaga ? 'VAGA-OCUPADA' : 'livre')); return { ok: true }; },
    reservar: () => { if (vaga) return false; vaga = true; trilha.push('reserva'); return true; }, liberar: () => { if (vaga) { vaga = false; trilha.push('libera'); } } }, { de, ate });
  assert.deepStrictEqual(trilha, ['reserva', 'bling:reservado', 'libera', 'backfill:livre'], trilha.join(','));
  assert.strictEqual(vaga, false, 'finally libera');
  r = await resgatar({ empresa: 'girassol', blingGet: async () => { throw new Error('nao era pra listar'); }, supaReq: supa([]), backfillVendas: async () => ({ ok: true }), reservar: () => false }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/reservar/.test(r.erro));
  feitos = [];
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async (d1) => { feitos.push(d1); return { ok: true, desfecho: 'com_erros' }; } }, { de, ate });
  assert.deepStrictEqual(r.resgatados, []); assert.deepStrictEqual(feitos, ['2026-09-28', '2026-10-01'], 'com erros e ainda faltando: adiado, e para na 2ª'); assert.ok(/seguem faltando/.test(r.ultimo_erro));
  // 5) Bling fora / Supabase fora / lista truncada → ok:false, nada decidido
  r = await resgatar({ empresa: 'girassol', blingGet: async () => ({ ok: false, status: 429 }), supaReq: supa([]), backfillVendas: async () => ({ ok: true }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/429/.test(r.erro));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: async () => ({ ok: false, status: 500 }), backfillVendas: async () => ({ ok: true }) }, { de, ate });
  assert.strictEqual(r.ok, false); assert.ok(/Supabase/.test(r.erro));
  const muitos = Array.from({ length: 250 }, (_, i) => ({ numero: 100000 + i, data: '2026-10-01' }));
  r = await resgatar({ empresa: 'girassol', blingGet: bling(muitos).blingGet, supaReq: supa([]), backfillVendas: async () => ({ ok: true }) }, { de, ate, maxPg: 2 });
  assert.strictEqual(r.ok, false); assert.ok(/TRUNCADA/.test(r.erro));
  // 5b) Codex #683 r7: memo que nao grava (diretorio inexistente) e reportado, nao escondido
  r = await resgatar({ empresa: 'girassol', blingGet: bling(lista).blingGet, supaReq: supa([]), backfillVendas: async () => ({ ok: true, desfecho: 'ok' }), cacheDir: path.join(os.tmpdir(), 'nao-existe-' + Date.now(), 'x') }, { de, ate });
  assert.strictEqual(r.memo_falhou, true); assert.ok(/NAO gravado/.test(r.ultimo_erro), 'avisa que a fila nao persistiu');
  // 6) contexto incompleto / período inválido
  r = await resgatar({ empresa: 'girassol' }, { de, ate }); assert.strictEqual(r.ok, false);
  r = await resgatar({ empresa: 'girassol', blingGet: async () => ({}), supaReq: async () => ({}), backfillVendas: async () => ({}) }, { de: ate, ate: de }); assert.strictEqual(r.ok, false);
  // 7) plano da noturna: alteração 3 dias; domingo (SP) 60 dias por data
  const seg = Date.UTC(2026, 9, 12, 6, 30), dom = Date.UTC(2026, 9, 11, 6, 30);
  let p = planoDaNoturna(seg); assert.strictEqual(p.por, 'alteracao'); assert.strictEqual(p.de, '2026-10-09'); assert.strictEqual(p.ate, '2026-10-12'); assert.strictEqual(p.maxDias, 5);
  p = planoDaNoturna(dom); assert.strictEqual(p.por, 'data'); assert.strictEqual(p.de, '2026-08-12'); assert.strictEqual(p.ate, '2026-10-11');
  p = planoDaNoturna(Date.UTC(2026, 9, 12, 2, 0)); assert.strictEqual(p.por, 'data', 'domingo 23h em SP ainda é domingo');
  assert.strictEqual(p.ate, '2026-10-11', 'Codex #683 r2: o período também é no calendário de SP'); assert.strictEqual(p.de, '2026-08-12');
  // 8) as duas empresas ligaram a peça: ctx e etapa
  for (const f of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) assert.ok(/resgatarHistorico:/.test(require('./_fonte-noturna').fonteNoturna(f)), f + ' passa resgatarHistorico');
  for (const f of ['girassol-backup-offline/noturna.js', 'amb-checkout-offline/amb-noturna.js']) { const s = require('./_fonte-noturna').fonteNoturna(f); assert.ok(/resgate do histórico/.test(s) && /resgatarHistorico\(_plano\)/.test(s), f + ' tem a etapa'); }
  console.log('ok — resgate do histórico: alteração/data, teto, adiados, falhas, plano da noturna, as duas empresas');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
