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
  const montar = new Function('SIT_DESPACHADOS', 'SIT_ATENDIDO', 'detalhePedido', 'listaOk', 'listaCompleta', 'atendidos', 'man', 'moverSituacao', 'fs', 'path', 'CACHE_DIR', 'sleep', 'PAUSA_MS', 'salvarManifest', 'console',
    'return (async () => {\n' + bloco + '\n})();');
  const rodar = async (o) => {
    const movidos = [], apagados = [], salvo = [];
    const man = JSON.parse(JSON.stringify(o.man));
    await montar(o.sit == null ? 745123 : o.sit, 9, async (id) => { if ((o.detFalha || []).includes(String(id))) throw new Error('429'); return { situacao: { id: (o.sitAgora && o.sitAgora[String(id)]) || 9 } }; },
      o.listaOk !== false, o.completa !== false, o.atendidos, man,
      async (id, sit) => { movidos.push(String(id)); return (o.falha || []).includes(String(id)) ? { ok: false } : { ok: true }; },
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
  // move desligado / lista incompleta / lista falhou: não mexe
  for (const o of [{ sit: 0 }, { completa: false }, { listaOk: false }]) {
    r = await rodar(Object.assign({ man, atendidos: at }, o));
    assert.deepStrictEqual(r.movidos, [], emp + ': mexeu com ' + JSON.stringify(o));
  }
}
console.log('ok — Full do ML vai pra DESPACHADOS no fim do ciclo, só se está no ATENDIDO agora, e a marca só some depois do move (AMB e GOOD)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
