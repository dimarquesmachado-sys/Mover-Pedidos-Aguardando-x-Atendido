'use strict';
/* 13/11 — A SINCRONIZAÇÃO DE CUSTO "TRAVADA" em peça única (lib/checkout/custo-sync-travado.js; plano multiloja, Fase 3 item 5).
   Girassol e AMB tinham 9 linhas (pega a trava do processo, roda, solta); a GOOD, 49, com a re-tentativa do gatilho do
   histórico. A peça é o corpo da GOOD; chamada sem `retentar`, tem que se comportar como as 9 linhas das outras. Prova:
   1) o CORPO da peça é o que a GOOD tinha — byte a byte, desfeitas as trocas registradas;
   2) as três montam a peça com a empresa e as peças delas; a Girassol e a AMB chamam SEM `retentar` (o gatilho do
      histórico continua só na GOOD — ligar nas outras é decisão do dono, cota do Bling); os corpos antigos saíram;
   3) SEM `retentar`, a peça faz exatamente o que as 9 linhas faziam — as duas rodam lado a lado, com as mesmas peças de
      mentira, e a sequência de chamadas (trava, custo, soltar) tem que ser a mesma, com a trava livre, ocupada e com o
      custo estourando;
   4) COM `retentar` (a GOOD): trava ocupada marca "esperando" e agenda UM retry; sobrou SKU sem custo → refaz em 3 min, até
      5 vezes; depois do teto, de hora em hora só se a sobra for por falha de requisição; não sobrou → zera; o cache do
      histórico é limpo depois da rodada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const pecaSrc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'custo-sync-travado.js'), 'utf8');
const { criar, PECAS } = require('../lib/checkout/custo-sync-travado');

/* 1) o corpo */
const ini = pecaSrc.indexOf('  const travaPesada = G.travaPesada;\n'), fim = pecaSrc.indexOf('  return { custoSyncTravado, custoRetryPendente };');
assert.ok(ini > 0 && fim > ini);
let corpo = pecaSrc.slice(ini + '  const travaPesada = G.travaPesada;\n'.length, fim).split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
const TROCAS = [   /* [na peça, como era na GOOD, quantas vezes] */
  ['travaPesada.tentarEntrar(CHAVE)', "travaPesada.tentarEntrar('custo-sync:good')", 1],
  ['travaPesada.sair(CHAVE)', "travaPesada.sair('custo-sync:good')", 1],
  ['G._cst.esperando_trava', '_cst.esperando_trava', 3],
  ['G._cst.falhas > 0', '_cst.falhas > 0', 1],
  ['const _sobrou = await G.custoSync(fresh);', 'const _sobrou = await custoSync(fresh);', 1],
  ['try { const _hc = G._histCache; for (const _k of Object.keys(_hc)) delete _hc[_k]; } catch (e) {}', 'try { for (const _k of Object.keys(_histCacheGood)) delete _histCacheGood[_k]; } catch (e) {}', 1],
];
for (const [nova, velha, n] of TROCAS) { assert.strictEqual(corpo.split(nova).length - 1, n, 'troca registrada não está na peça (' + n + 'x): ' + nova); corpo = corpo.split(nova).join(velha); }
assert.strictEqual(corpo, fx('custo-sync-travado-good-antes.txt'), 'fora das trocas registradas, o corpo da peça tem que ser o que a GOOD tinha (mover não é reescrever)');

/* 2) as três empresas */
for (const [arq, emp, hist] of [['girassol-backup-offline/gbo-app.js', 'girassol', '_histCache'], ['amb-checkout-offline/index.js', 'amb', '_histCache'], ['good-checkout-offline/index.js', 'good', '_histCacheGood']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("require('../lib/checkout/custo-sync-travado').criar({"); assert.ok(i > 0, arq + ': não monta a peça');
  const bloco = s.slice(i, s.indexOf('});', i));
  assert.ok(new RegExp("empresa: '" + emp + "',").test(bloco) && /\n  travaPesada,\n/.test(bloco) && /custoSync: \(fresh\) => custoSync\(fresh\),/.test(bloco) && /get _cst\(\) \{ return _cst; \}/.test(bloco) && bloco.includes('get _histCache() { return ' + hist + '; }'), arq + ': tem que montar com a empresa, a trava, o custo, o estado e o cache do histórico DELA');
  assert.ok(!s.includes("travaPesada.tentarEntrar('custo-sync:" + emp + "')"), arq + ': sobrou o corpo antigo (a chave da trava agora sai do nome da empresa, na peça)');
  if (emp === 'good') {
    /* na GOOD as duas continuam FUNÇÕES declaradas (o arquivo as usa antes de defini-las) e o gatilho do histórico segue ligado */
    assert.ok(/\nfunction custoRetryPendente\(\) \{ return _custoTravadoPeca\.custoRetryPendente\(\); \}/.test(s) && /\nasync function custoSyncTravado\(fresh, retentar\) \{ return _custoTravadoPeca\.custoSyncTravado\(fresh, retentar\); \}/.test(s), arq + ': as duas têm que ser funções declaradas');
    assert.ok(/aoPublicarSkusSemCusto: \(\) => \{ try \{ custoSyncTravado\(false, true\)\.catch\(\(\) => \{\}\); \} catch \(e\) \{\} \},/.test(s), 'a GOOD tem que seguir disparando com retentar pelo gatilho do histórico');
  } else {
    assert.ok(/\nasync function custoSyncTravado\(fresh\) \{ return _custoTravadoPeca\.custoSyncTravado\(fresh\); \}/.test(s), arq + ': chama a peça SEM retentar');
    assert.ok(!/aoPublicarSkusSemCusto:/.test(s) && /custoRetryPendente: \(\) => null/.test(s), arq + ': o gatilho do histórico e a re-tentativa NÃO foram ligados aqui (é decisão do dono)');
  }
}
assert.strictEqual("'custo-sync:' + String(G.empresa)", (/const CHAVE = ([^;]+);/.exec(pecaSrc) || [])[1], 'a chave da trava tem que ser custo-sync:<empresa> — a mesma de antes em cada uma');

/* peças de mentira comuns */
function mundo(o) {
  o = o || {};
  const chamadas = [], timers = [];
  const cst = { falhas: o.falhas || 0 }, hist = { a: 1, b: 2 };
  let ocupada = !!o.ocupada;
  const travaPesada = { tentarEntrar: (k) => { chamadas.push('entrar:' + k); return ocupada ? { ok: false, ocupadoPor: 'backfill:x', haMin: 7 } : { ok: true }; }, sair: (k) => { chamadas.push('sair:' + k); } };
  const fila = (o.sobras || []).slice();
  const custoSync = async (fresh) => { chamadas.push('custo:' + fresh); if (o.estoura) throw new Error('caiu'); return fila.length ? fila.shift() : 0; };
  return { chamadas, timers, cst, hist, travaPesada, custoSync, ocupar: (v) => { ocupada = v; } };
}
(async () => {
  assert.throws(() => criar({}), /falta empresa/); assert.throws(() => criar({ empresa: 'x' }), /falta _cst/);
  const logAntes = console.log; console.log = () => {};
  const tAntes = global.setTimeout;
  try {
    /* 3) SEM retentar = as 9 linhas da Girassol e da AMB */
    for (const emp of ['girassol', 'amb']) for (const cenario of [{}, { ocupada: true }, { estoura: true }]) {
      const mA = mundo(cenario), mB = mundo(cenario);
      const antiga = vm.runInNewContext('(' + fx('custo-sync-travado-' + emp + '-antes.txt').trim() + ')', { travaPesada: mA.travaPesada, custoSync: mA.custoSync, console: { log() {} } });
      const nova = criar({ empresa: emp, travaPesada: mB.travaPesada, custoSync: mB.custoSync, get _cst() { return mB.cst; }, get _histCache() { return mB.hist; } });
      let eA = null, eB = null;
      try { await antiga(true); } catch (e) { eA = e.message; }
      try { await nova.custoSyncTravado(true); } catch (e) { eB = e.message; }
      assert.deepStrictEqual(mB.chamadas, mA.chamadas, emp + ' ' + JSON.stringify(cenario) + ': a peça sem retentar tem que fazer as MESMAS chamadas das 9 linhas: ' + JSON.stringify([mA.chamadas, mB.chamadas]));
      assert.strictEqual(eB, eA, emp + ': erro do custo tem que propagar igual');
      assert.ok(mB.chamadas[0] === 'entrar:custo-sync:' + emp && nova.custoRetryPendente() === null && !('esperando_trava' in mB.cst), emp + ': sem retentar não há retry nem marca de espera');
    }
    /* 4) COM retentar (a GOOD) */
    const timers = []; global.setTimeout = (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; };
    let m = mundo({ ocupada: true });
    let p = criar({ empresa: 'good', travaPesada: m.travaPesada, custoSync: m.custoSync, get _cst() { return m.cst; }, get _histCache() { return m.hist; } });
    assert.strictEqual(await p.custoSyncTravado(false, true), false);
    assert.ok(m.cst.esperando_trava && m.cst.esperando_trava.vai_retentar === true && m.cst.esperando_trava.por === 'backfill:x' && timers.length === 1 && timers[0].ms === 180000 && p.custoRetryPendente() && p.custoRetryPendente().em_min === 3, 'trava ocupada com retentar: marca que está esperando e agenda o retry de 3 min: ' + JSON.stringify([m.cst, timers.length]));
    await p.custoSyncTravado(false, true); assert.strictEqual(timers.length, 1, 'um retry pendente só');
    m.ocupar(false); timers[0].f(); await new Promise((ok) => setImmediate(ok)); await new Promise((ok) => setImmediate(ok));
    assert.ok(m.chamadas.includes('custo:false') && !('esperando_trava' in m.cst) && p.custoRetryPendente() === null && Object.keys(m.hist).length === 0, 'o retry roda quando a trava libera, tira a marca e limpa o cache do histórico: ' + JSON.stringify([m.chamadas, m.cst]));
    /* sobrou SKU sem custo, sem falha de requisição: refaz de 3 em 3 min até o teto de 5 rodadas — depois para */
    timers.length = 0; m = mundo({ sobras: [3, 3, 3, 3, 3, 3, 3] });
    p = criar({ empresa: 'good', travaPesada: m.travaPesada, custoSync: m.custoSync, get _cst() { return m.cst; }, get _histCache() { return m.hist; } });
    await p.custoSyncTravado(false, true);
    let rodadas = 1;
    while (timers.length && rodadas < 12) { const t = timers.shift(); assert.strictEqual(t.ms, 180000); t.f(); await new Promise((ok) => setImmediate(ok)); await new Promise((ok) => setImmediate(ok)); rodadas++; }
    assert.strictEqual(m.chamadas.filter((c) => c === 'custo:false').length, 5, 'produto sem custo de verdade no Bling não vira loop: 5 rodadas e para (' + m.chamadas.filter((c) => c === 'custo:false').length + ')');
    /* sobra POR FALHA de requisição: depois do teto continua, de hora em hora */
    timers.length = 0; m = mundo({ sobras: [3, 3, 3, 3, 3, 3], falhas: 2 });
    p = criar({ empresa: 'good', travaPesada: m.travaPesada, custoSync: m.custoSync, get _cst() { return m.cst; }, get _histCache() { return m.hist; } });
    await p.custoSyncTravado(false, true); const esperas = [];
    for (let i = 0; i < 5 && timers.length; i++) { const t = timers.shift(); esperas.push(t.ms); t.f(); await new Promise((ok) => setImmediate(ok)); await new Promise((ok) => setImmediate(ok)); }
    assert.deepStrictEqual(esperas, [180000, 180000, 180000, 180000, 3600000], 'com falha de requisição, depois do teto segue tentando de hora em hora: ' + JSON.stringify(esperas));
    /* não sobrou nada: zera — nenhum retry */
    timers.length = 0; m = mundo({ sobras: [0] });
    p = criar({ empresa: 'good', travaPesada: m.travaPesada, custoSync: m.custoSync, get _cst() { return m.cst; }, get _histCache() { return m.hist; } });
    await p.custoSyncTravado(false, true); assert.ok(timers.length === 0 && p.custoRetryPendente() === null);
    /* duas empresas: cada peça tem o SEU contador e o SEU retry */
    timers.length = 0; const m1 = mundo({ ocupada: true }), m2 = mundo({});
    const p1 = criar({ empresa: 'good', travaPesada: m1.travaPesada, custoSync: m1.custoSync, get _cst() { return m1.cst; }, get _histCache() { return m1.hist; } });
    const p2 = criar({ empresa: 'amb', travaPesada: m2.travaPesada, custoSync: m2.custoSync, get _cst() { return m2.cst; }, get _histCache() { return m2.hist; } });
    await p1.custoSyncTravado(false, true);
    assert.ok(p1.custoRetryPendente() && p2.custoRetryPendente() === null, 'o retry de uma empresa não aparece na outra');
  } finally { global.setTimeout = tAntes; console.log = logAntes; }
  console.log('ok — custo "travado" em peça única: o corpo é o da GOOD (byte a byte); sem retentar faz o mesmo que as 9 linhas da Girassol e da AMB; com retentar, o retry e o teto como na GOOD');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
