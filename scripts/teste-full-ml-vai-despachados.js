'use strict';
/* 15/10 — ordem do dono: "pedido Full que cai no ATENDIDO sai de lá na hora e vai pra despachados". Executa o bloco
   de PRODUÇÃO (recortado do ciclo da AMB e da GOOD) com Bling de mentira:
   · move pra DESPACHADOS só quem é full_ml E está AGORA no ATENDIDO, com a lista do Bling inteira;
   · apaga cache/marca SÓ do que moveu; falhou → segue marcado (fora da fila) pro próximo ciclo;
   · fica no FIM do ciclo (depois do cache dos pedidos novos) — pega o Full descoberto no próprio ciclo;
   · move desligado (SIT_DESPACHADOS 0) ou lista incompleta → não mexe. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
/* o prazo do move usa timer unref: sem isto o processo sairia antes do fim e o teste "passaria" calado */
let _chegouAoFim = false;
process.on('beforeExit', () => { if (!_chegouAoFim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
const _vivo = setInterval(() => {}, 1000);
(async () => {
for (const [emp, arq] of [['AMB', 'amb-checkout-offline/ciclo.js'], ['GOOD', 'good-checkout-offline/ciclo.js']]) {
  const src = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const ini = src.indexOf('/* 15/10 — ORDEM DO DONO: "pedido Full que cai no ATENDIDO');
  const cache = src.indexOf('const snap = await cachearPedido(');
  const resumo = src.indexOf('// FASE 3: Bling respondeu', ini);
  const sync = src.indexOf('await sincronizarConferidos(', ini);
  assert.ok(ini > cache && resumo > ini, emp + ': o move do Full do ML tem que ficar DEPOIS do cache dos pedidos novos (mesmo ciclo)');
  assert.ok(sync > resumo, emp + ': o move do Full tem que vir ANTES do sincronizarConferidos (Codex #701 r4)');
  const corpo = src.slice(src.indexOf('    if (SIT_DESPACHADOS && listaOk && listaCompleta) {', ini), resumo);
  assert.ok(!/_sitAgora[^\n]*\n[^\n]*\n?\s*await sleep/.test(corpo.slice(corpo.indexOf('const _sitAgora'), corpo.indexOf('blingWrite('))), emp + ': pausa entre a conferência e o PATCH (Codex #701 r4)');
  const fim = corpo.lastIndexOf('\n    }') + 6;
  const bloco = corpo.slice(0, fim);
  const montar = new Function('SIT_DESPACHADOS', 'SIT_ATENDIDO', 'detalhePedido', 'listaOk', 'listaCompleta', 'atendidos', 'man', 'blingWrite', 'fs', 'path', 'CACHE_DIR', 'sleep', 'PAUSA_MS', 'salvarManifest', 'console', 'readJson', 'writeJson', 'CONFERIDOS_FILE', '_fullDespachadosNoProcesso',
    'return (async () => {\n' + bloco + '\n})();');
  const rodar = async (o) => {
    const movidos = [], apagados = [], salvo = [];
    const man = JSON.parse(JSON.stringify(o.man));
    const conf = JSON.parse(JSON.stringify(o.conf || {}));
    await montar(o.sit == null ? 745123 : o.sit, 9,
      (id, signal) => {
        if ((o.pendura || []).includes(String(id))) return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(new Error('abortado'))); });
        if ((o.detFalha || []).includes(String(id))) return Promise.reject(new Error('429'));
        return Promise.resolve({ situacao: { id: (o.sitAgora && o.sitAgora[String(id)]) || 9 } }); },
      o.listaOk !== false, o.completa !== false, o.atendidos, man,
      async (met, url, body, op) => { const id = (/\/pedidos\/vendas\/(\d+)\/situacoes\//.exec(url) || [])[1]; movidos.push(String(id));
        assert.strictEqual(met, 'PATCH'); assert.ok(op && op.signal, 'PATCH sem prazo'); assert.ok(op.semRetryDeRede, 'PATCH repete em erro de rede');
        return (o.falha || []).includes(String(id)) ? { ok: false } : { ok: true }; },
      { rmSync: (p) => apagados.push(path.basename(p)) }, path, '/cache', async () => {}, 0, () => salvo.push(1), { log: () => {} },
      () => JSON.parse(JSON.stringify(conf)), (arq, v) => { for (const k of Object.keys(conf)) delete conf[k]; Object.assign(conf, v); }, '/cache/conferidos.json', new Set());
    return { movidos, apagados, man, salvo, conf };
  };
  const man = { '1': { full_ml: true }, '2': { full_ml: true }, '3': { full_ml: true }, '4': { tem_etiqueta: false } };
  const at = [{ id: 1 }, { id: 2 }, { id: 4 }];   // o 3 já saiu do ATENDIDO
  // caminho feliz + o que já saiu do ATENDIDO não é mexido + falha não apaga a marca
  let r = await rodar({ man, atendidos: at, falha: ['2'], conf: { '1': { conferido_em: 'x' }, '2': { conferido_em: 'y' } } });
  /* Codex #701 r4: o conferido pendente do Full movido é encerrado (o sync não o leva pra VERIFICADO por cima do
     DESPACHADOS); o do que falhou fica como estava */
  assert.ok(r.conf['1'].sincronizado === true && r.conf['1'].sync_resolvido === 'full-ml-despachado', emp + ': conferido do Full movido seguiu pendente (o sync levaria pra VERIFICADO)');
  assert.ok(!r.conf['2'].sincronizado, emp + ': encerrou o conferido de quem não foi movido');
  assert.deepStrictEqual(r.movidos.sort(), ['1', '2'], emp + ': moveu quem não devia (ou não moveu): ' + r.movidos);
  assert.deepStrictEqual(r.apagados, ['1'], emp + ': apagou cache de quem não moveu');
  assert.ok(!r.man['1'] && r.man['2'] && r.man['2'].full_ml && r.man['3'], emp + ': marca apagada antes do move dar certo (ou de quem não estava no ATENDIDO)');
  // Codex #701 r2: mudou de situação depois da lista (cancelado/avançado) ou o Bling não respondeu → não move
  r = await rodar({ man, atendidos: at, sitAgora: { '1': 12 }, detFalha: ['2'] });
  assert.deepStrictEqual(r.movidos, [], emp + ': sobrescreveu pedido que mudou de situação (ou moveu sem conferir): ' + r.movidos);
  assert.ok(r.man['1'] && r.man['1'].full_ml && r.man['2'] && r.man['2'].full_ml, emp + ': apagou a marca sem mover');
  // Codex #701 r3: Bling que aceita e não responde — o prazo aborta, não pendura o ciclo, não move, a marca fica
  process.env.CHECKOUT_PRAZO_MOVE_FULL_MS = '60';
  { const t0 = Date.now();
    r = await Promise.race([rodar({ man, atendidos: at, pendura: ['1', '2'] }), new Promise((_, rej) => setTimeout(() => rej(new Error(emp + ': o move pendurou o ciclo (sem prazo)')), 2000))]);
    assert.ok(Date.now() - t0 < 2000, emp + ': o move pendurou o ciclo'); assert.deepStrictEqual(r.movidos, []); assert.ok(r.man['1'].full_ml && r.man['2'].full_ml); }
  // Codex #701 r4: Bling mudo — estourou o prazo de UMA chamada, o lote para (não gasta o prazo por pedido)
  { const t0 = Date.now(); const manN = {}; const atN = [];
    for (let i = 10; i < 40; i++) { manN[i] = { full_ml: true }; atN.push({ id: i }); }
    r = await rodar({ man: manN, atendidos: atN, pendura: Object.keys(manN) });
    assert.ok(Date.now() - t0 < 500, emp + ': o lote seguiu tentando depois do Bling mudo'); assert.deepStrictEqual(r.movidos, []); }
  delete process.env.CHECKOUT_PRAZO_MOVE_FULL_MS;
  // Codex #701 r4: prazo do lote inteiro — estourado, não começa o próximo
  process.env.CHECKOUT_PRAZO_LOTE_FULL_MS = '-1';
  r = await rodar({ man, atendidos: at }); assert.deepStrictEqual(r.movidos, [], emp + ': ignorou o prazo do lote');
  delete process.env.CHECKOUT_PRAZO_LOTE_FULL_MS;
  // move desligado / lista incompleta / lista falhou: não mexe
  for (const o of [{ sit: 0 }, { completa: false }, { listaOk: false }]) {
    r = await rodar(Object.assign({ man, atendidos: at }, o));
    assert.deepStrictEqual(r.movidos, [], emp + ': mexeu com ' + JSON.stringify(o));
  }
}
/* Codex #701 r5: o sync de conferidos (função DE PRODUÇÃO, recortada) não leva pra VERIFICADO o Full cujo move falhou */
for (const [emp, arq] of [['AMB', 'amb-checkout-offline/ciclo.js'], ['GOOD', 'good-checkout-offline/ciclo.js']]) {
  const src = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const i = src.indexOf('async function sincronizarConferidos(pular) {'); assert.ok(i > 0, emp + ': sync sem o parâmetro de pular');
  const corpo = src.slice(i, src.indexOf('\n}\n', i) + 2);
  assert.ok(/_fullDespachadosNoProcesso\.add\(String\(idF\)\)/.test(src), emp + ': move do Full não lembra o id pro sync (Codex #701 r6)');
  const rodar = async (arg, manifesto, movidosProc) => {
    const conf = { '1': { conferido_em: 'x' }, '7': { conferido_em: 'y' }, '9': { conferido_em: 'z' } }; const movidos = [];
    const fn = new Function('readJson', 'writeJson', 'CONFERIDOS_FILE', 'MANIFEST_FILE', '_fullDespachadosNoProcesso', 'moverSituacao', 'blingGet', 'SIT_VERIFICADO', 'SIT_ATENDIDO', 'console', 'sleep', 'PAUSA_MS', corpo + '\nreturn sincronizarConferidos;')(
      (p) => JSON.parse(JSON.stringify(p === '/m' ? manifesto : conf)), () => {}, '/c', '/m', new Set(movidosProc || []), async (id) => { movidos.push(String(id)); return { ok: true }; }, async () => ({}), 24, 9, { log: () => {} }, async () => {}, 0);
    await fn(arg);
    return movidos;
  };
  assert.deepStrictEqual(await rodar(new Set(['1']), {}), ['7', '9'], emp + ': o sync levou o Full pra VERIFICADO (ou deixou de sincronizar o normal)');
  /* r6: rota manual /sincronizar chama SEM argumento — o Full marcado no manifesto também fica de fora */
  assert.deepStrictEqual(await rodar(undefined, { '1': { full_ml: true } }), ['7', '9'], emp + ': sync manual levou o Full pra VERIFICADO');
  /* r6: DESPACHADOS deu certo mas gravar o conferido falhou — o id movido no processo não é sincronizado */
  assert.deepStrictEqual(await rodar(undefined, {}, ['9']), ['1', '7'], emp + ': sync passou por cima do DESPACHADOS');
  assert.ok(/await sincronizarConferidos\(new Set\(Object\.keys\(man\)\.filter\(i => man\[i\] && man\[i\]\.full_ml\)/.test(src), emp + ': o ciclo não passa os Full pro sync pular');
}
_chegouAoFim = true; clearInterval(_vivo);
console.log('ok — Full do ML vai pra DESPACHADOS no fim do ciclo, só se está no ATENDIDO agora, e a marca só some depois do move (AMB e GOOD)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
