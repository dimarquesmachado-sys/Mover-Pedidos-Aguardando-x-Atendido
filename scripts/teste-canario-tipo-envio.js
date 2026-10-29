'use strict';
/* 29/10 — o canário diz QUE TIPO de venda não está chegando ao Bling. Na AMB ele acusou 14 a 17 vendas do ML fora do Bling
   TODO DIA desde 24/10 e mandava reautorizar a integração — mas o resto do ML chegava (o Bling tinha até mais pedidos do ML
   que o ML no período): faltava uma CATEGORIA. Prova, com a biblioteca de produção (lib/canario-marketplace) e listas de
   mentira:
   · todas as que faltam são Full → o diagnóstico diz Full, e o que fazer é a integração do Full (não "reautorizar tudo");
   · tipos misturados → o diagnóstico de sempre, com a contagem por tipo;
   · consulta do tipo falhando → "nao_sei", que NUNCA vira diagnóstico de categoria;
   · o canário da empresa entrega a consulta do tipo (pedido → envio → logistic_type) à biblioteca. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const lib = require('../lib/canario-marketplace');

(async () => {
  const doMl = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
  const noBling = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);   /* faltam A7..A10 (40%) */
  const base = (tipoEnvio) => ({ empresa: 'amb', listarNoBling: async () => ({ ml: noBling }), listarNoMarketplace: async () => doMl.map((id) => ({ id, apelidos: [id] })),
    packDaVenda: async () => ({ pack: null }), ordensDoPack: async () => ({ ordens: [] }), tipoEnvio });
  // 1) todas Full
  const r1 = await lib.conferir(base(async () => ({ tipo: 'fulfillment' })), 2, ['ml'], {});
  const a1 = r1.alertas.find((x) => x.canal === 'ml');
  assert.ok(a1 && a1.tipo_que_falta === 'fulfillment' && /FULL/.test(a1.provavel) && /ML FULL/.test(a1.o_que_fazer), 'todas Full e o diagnóstico não disse: ' + JSON.stringify(a1));
  assert.deepStrictEqual(r1.por_canal.ml.faltando_por_tipo, { fulfillment: 4 }, 'contagem por tipo errada');
  /* Codex #768: o tipo das que faltam não prova que as outras chegam — Bling VAZIO (tudo faltando) e todas Full: fica o
     diagnóstico geral (pode ser a integração inteira), com a contagem por tipo */
  { const vazio = { empresa: 'amb', listarNoBling: async () => ({ ml: new Set() }), listarNoMarketplace: async () => ['B1', 'B2'].map((id) => ({ id, apelidos: [id] })),
      packDaVenda: async () => ({ pack: null }), ordensDoPack: async () => ({ ordens: [] }), tipoEnvio: async () => ({ tipo: 'fulfillment' }) };
    const rv = await lib.conferir(vazio, 2, ['ml'], {});
    const av = rv.alertas.find((x) => x.canal === 'ml');
    assert.ok(av && !av.tipo_que_falta && /reautorizar/.test(av.o_que_fazer) && rv.por_canal.ml.faltando_por_tipo.fulfillment === 2, 'Bling vazio + todas Full: afirmou que o resto chega: ' + JSON.stringify(av)); }
  // 2) misturados
  let i = 0;
  const r2 = await lib.conferir(base(async () => ({ tipo: (i++ % 2) ? 'fulfillment' : 'self_service' })), 2, ['ml'], {});
  const a2 = r2.alertas.find((x) => x.canal === 'ml');
  assert.ok(a2 && !a2.tipo_que_falta && r2.por_canal.ml.faltando_por_tipo.fulfillment === 2 && r2.por_canal.ml.faltando_por_tipo.self_service === 2, 'misturados: o diagnóstico afirmou uma categoria ou perdeu a contagem: ' + JSON.stringify(a2));
  // 3) consulta falhando: "nao_sei" nunca vira categoria
  const r3 = await lib.conferir(base(async () => ({ tipo: null, erro: true })), 2, ['ml'], {});
  const a3 = r3.alertas.find((x) => x.canal === 'ml');
  assert.ok(a3 && !a3.tipo_que_falta && r3.por_canal.ml.faltando_por_tipo.nao_sei === 4, 'falha na consulta virou diagnóstico de categoria: ' + JSON.stringify(a3));
  const r3b = await lib.conferir(base(async (c, id) => (id === 'A10' ? { erro: true } : { tipo: 'fulfillment' })), 2, ['ml'], {});
  assert.ok(!r3b.alertas.find((x) => x.canal === 'ml').tipo_que_falta, 'uma consulta falhada no meio e mesmo assim afirmou "todas Full"');
  // 4) sem a consulta (outra empresa/versão): igual a antes
  const r4 = await lib.conferir(base(undefined), 2, ['ml'], {});
  assert.ok(!r4.por_canal.ml.faltando_por_tipo && !r4.alertas.find((x) => x.canal === 'ml').tipo_que_falta, 'sem a consulta, o canário mudou de comportamento');
  // 5) o canário da empresa entrega a consulta
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'canario-empresa.js'), 'utf8');
  assert.ok(s.includes('tipoEnvio: _tipoEnvioCanario }') && /api\.mercadolibre\.com\/shipments\//.test(s) && /d2\.logistic_type \|\| \(d2\.logistic && d2\.logistic\.type\)/.test(s), 'o canário da empresa não pergunta o tipo de envio ao ML');
  console.log('ok — canário diz o tipo de venda que falta: todas Full → diz Full; misturadas → contagem; falha → não afirma');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
