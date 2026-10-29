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
  // 1) todas Full: no Full o que entra no Bling é a NF, não o pedido — não é falta (o caso da AMB, 29/10)
  const r1 = await lib.conferir(base(async () => ({ tipo: 'fulfillment' })), 2, ['ml'], {});
  assert.ok(!r1.alertas.find((x) => x.canal === 'ml') && r1.por_canal.ml.faltando_no_bling === 0 && r1.por_canal.ml.full_sem_pedido === 4 && r1.por_canal.ml.exemplos_full_sem_pedido.includes('A7'),
    'venda Full (que entra no Bling como NF, sem pedido) virou alarme: ' + JSON.stringify(r1.por_canal.ml));
  /* Flex de verdade faltando (e o resto chegando): o diagnóstico diz a categoria */
  const r1b = await lib.conferir(base(async () => ({ tipo: 'self_service' })), 2, ['ml'], {});
  const a1 = r1b.alertas.find((x) => x.canal === 'ml');
  assert.ok(a1 && a1.tipo_que_falta === 'self_service' && /FLEX/.test(a1.provavel), 'todas Flex e o diagnóstico não disse: ' + JSON.stringify(a1));
  /* Codex #768: o tipo das que faltam não prova que as outras chegam — Bling VAZIO (tudo faltando) e todas Full: fica o
     diagnóstico geral (pode ser a integração inteira), com a contagem por tipo */
  { const vazio = { empresa: 'amb', listarNoBling: async () => ({ ml: new Set() }), listarNoMarketplace: async () => ['B1', 'B2'].map((id) => ({ id, apelidos: [id] })),
      packDaVenda: async () => ({ pack: null }), ordensDoPack: async () => ({ ordens: [] }), tipoEnvio: async () => ({ tipo: 'fulfillment' }) };
    const vz2 = Object.assign({}, vazio, { tipoEnvio: async () => ({ tipo: 'self_service' }) });
    const rv = await lib.conferir(vz2, 2, ['ml'], {});
    const av = rv.alertas.find((x) => x.canal === 'ml');
    assert.ok(av && !av.tipo_que_falta && /reautorizar/.test(av.o_que_fazer) && rv.por_canal.ml.faltando_por_tipo.self_service === 2, 'Bling vazio + todas Flex: afirmou que o resto chega: ' + JSON.stringify(av)); }
  /* Bling VAZIO + 2 Full + 2 Flex: as Full saem, mas não provam que "o resto chega" — fica o diagnóstico geral */
  { let j = 0;
    const vz3 = { empresa: 'amb', listarNoBling: async () => ({ ml: new Set() }), listarNoMarketplace: async () => ['C1', 'C2', 'C3', 'C4'].map((id) => ({ id, apelidos: [id] })),
      packDaVenda: async () => ({ pack: null }), ordensDoPack: async () => ({ ordens: [] }), tipoEnvio: async () => ({ tipo: (j++ < 2) ? 'fulfillment' : 'self_service' }) };
    const r5 = await lib.conferir(vz3, 2, ['ml'], {});
    const a5 = r5.alertas.find((x) => x.canal === 'ml');
    assert.ok(a5 && a5.faltando === 2 && !a5.tipo_que_falta && r5.por_canal.ml.full_sem_pedido === 2, 'as Full (sem pedido) serviram de prova de que o resto chega: ' + JSON.stringify(a5)); }
  // 2) misturados
  let i = 0;
  const r2 = await lib.conferir(base(async () => ({ tipo: (i++ % 2) ? 'fulfillment' : 'self_service' })), 2, ['ml'], {});
  const a2 = r2.alertas.find((x) => x.canal === 'ml');
  /* 2 Full (saem, viram informação) + 2 Flex (faltam de verdade, e o resto chega): diagnóstico do Flex */
  assert.ok(a2 && a2.faltando === 2 && a2.tipo_que_falta === 'self_service' && r2.por_canal.ml.full_sem_pedido === 2 && r2.por_canal.ml.faltando_por_tipo.self_service === 2, 'Full + Flex: separou errado: ' + JSON.stringify({ a2, ml: r2.por_canal.ml }));
  // 3) consulta falhando: "nao_sei" nunca vira categoria
  const r3 = await lib.conferir(base(async () => ({ tipo: null, erro: true })), 2, ['ml'], {});
  const a3 = r3.alertas.find((x) => x.canal === 'ml');
  assert.ok(a3 && !a3.tipo_que_falta && r3.por_canal.ml.faltando_por_tipo.nao_sei === 4, 'falha na consulta virou diagnóstico de categoria: ' + JSON.stringify(a3));
  /* uma consulta falhada no meio: as Full confirmadas saem, a "não sei" CONTINUA faltando (e não vira categoria) */
  const r3b = await lib.conferir(base(async (c, id) => (id === 'A10' ? { erro: true } : { tipo: 'fulfillment' })), 2, ['ml'], {});
  const a3b = r3b.alertas.find((x) => x.canal === 'ml');
  assert.ok(a3b && a3b.faltando === 1 && !a3b.tipo_que_falta && r3b.por_canal.ml.full_sem_pedido === 3, '"não sei" sumiu da lista ou virou categoria: ' + JSON.stringify(r3b.por_canal.ml));
  // 4) sem a consulta (outra empresa/versão): igual a antes
  const r4 = await lib.conferir(base(undefined), 2, ['ml'], {});
  assert.ok(!r4.por_canal.ml.faltando_por_tipo && !r4.alertas.find((x) => x.canal === 'ml').tipo_que_falta, 'sem a consulta, o canário mudou de comportamento');
  // 5) o canário da empresa entrega a consulta
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'canario-empresa.js'), 'utf8');
  assert.ok(s.includes('tipoEnvio: _tipoEnvioCanario }') && /api\.mercadolibre\.com\/shipments\//.test(s) && /d2\.logistic_type \|\| \(d2\.logistic && d2\.logistic\.type\)/.test(s), 'o canário da empresa não pergunta o tipo de envio ao ML');
  console.log('ok — canário: venda Full (NF sem pedido) não é falta; categoria real (Flex) vira diagnóstico; falha → continua faltando, sem afirmar');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
