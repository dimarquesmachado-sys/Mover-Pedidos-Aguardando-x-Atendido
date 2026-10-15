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
  const resumo = src.lastIndexOf('ultimoResumo = {');
  assert.ok(ini > cache && ini < resumo, emp + ': o move do Full do ML tem que ficar DEPOIS do cache dos pedidos novos (mesmo ciclo)');
  const corpo = src.slice(src.indexOf('    if (SIT_DESPACHADOS && listaOk && listaCompleta) {', ini), resumo);
  const fim = corpo.lastIndexOf('\n    }') + 6;
  const bloco = corpo.slice(0, fim);
  const montar = new Function('SIT_DESPACHADOS', 'SIT_ATENDIDO', 'detalhePedido', 'listaOk', 'listaCompleta', 'atendidos', 'man', 'blingWrite', 'fs', 'path', 'CACHE_DIR', 'sleep', 'PAUSA_MS', 'salvarManifest', 'console',
    'return (async () => {\n' + bloco + '\n})();');
  const rodar = async (o) => {
    const movidos = [], apagados = [], salvo = [];
    const man = JSON.parse(JSON.stringify(o.man));
    await montar(o.sit == null ? 745123 : o.sit, 9,
      (id, signal) => {
        if ((o.pendura || []).includes(String(id))) return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(new Error('abortado'))); });
        if ((o.detFalha || []).includes(String(id))) return Promise.reject(new Error('429'));
        return Promise.resolve({ situacao: { id: (o.sitAgora && o.sitAgora[String(id)]) || 9 } }); },
      o.listaOk !== false, o.completa !== false, o.atendidos, man,
      async (met, url, body, op) => { const id = (/\/pedidos\/vendas\/(\d+)\/situacoes\//.exec(url) || [])[1]; movidos.push(String(id));
        assert.strictEqual(met, 'PATCH'); assert.ok(op && op.signal, 'PATCH sem prazo'); assert.ok(op.semRetryDeRede, 'PATCH repete em erro de rede');
        return (o.falha || []).includes(String(id)) ? { ok: false } : { ok: true }; },
      { rmSync: (p) => apagados.push(path.basename(p)) }, path, '/cache', async () => {}, 0, () => salvo.push(1), { log: () => {} });
    return { movidos, apagados, man, salvo };
  };
  const man = { '1': { full_ml: true }, '2': { full_ml: true }, '3': { full_ml: true }, '4': { tem_etiqueta: false } };
  const at = [{ id: 1 }, { id: 2 }, { id: 4 }];   // o 3 já saiu do ATENDIDO
  // caminho feliz + o que já saiu do ATENDIDO não é mexido + falha não apaga a marca
  let r = await rodar({ man, atendidos: at, falha: ['2'] });
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
  delete process.env.CHECKOUT_PRAZO_MOVE_FULL_MS;
  // move desligado / lista incompleta / lista falhou: não mexe
  for (const o of [{ sit: 0 }, { completa: false }, { listaOk: false }]) {
    r = await rodar(Object.assign({ man, atendidos: at }, o));
    assert.deepStrictEqual(r.movidos, [], emp + ': mexeu com ' + JSON.stringify(o));
  }
}
_chegouAoFim = true; clearInterval(_vivo);
console.log('ok — Full do ML vai pra DESPACHADOS no fim do ciclo, só se está no ATENDIDO agora, e a marca só some depois do move (AMB e GOOD)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
