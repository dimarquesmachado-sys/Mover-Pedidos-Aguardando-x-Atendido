'use strict';
/* Teste da CLASSIFICAÇÃO do canário (lib/canario-marketplace.js) — nasceu dos P1 do #347:
   corte de orçamento e erro de consulta viravam FALTANDO (alerta definitivo falso).
   Invariante: só resposta CONCLUSIVA condena ou absolve; o resto é NAO_CONFIRMADA e
   suja o veredito sem acusar. Exercita a conferir() DE PRODUÇÃO com deps injetadas.
   Rodar: node scripts/teste-canario-classificacao.js */
const assert = require('assert');
const { conferir } = require('../lib/canario-marketplace');

function ctx(idsML, blingSet, packMapa) {
  return {
    empresa: 'teste',
    listarNoBling: async () => ({ ml: new Set(blingSet) }),
    listarNoMarketplace: async (canal) => (canal === 'ml' ? idsML : null),
    packDaVenda: async (canal, venda) => packMapa[venda] !== undefined ? packMapa[venda] : { pack: null },
    ordensDoPack: async () => ({ ordens: [] }),
  };
}

(async () => {
  // 1) erro de consulta ≠ ausência: v2 falhou no lookup → nao_confirmada, NÃO faltando
  let r = await conferir(ctx(['v1', 'v2', 'v3'], ['p1'], {
    v1: { pack: 'p1' },                 // conclusivo: o Bling gravou pelo pacote
    v2: { pack: null, erro: true },     // consulta falhou (429/5xx/timeout)
    v3: { pack: null },                 // conclusivo: sem pack e fora do Bling
  }), 3, ['ml'], {});
  const ml = r.por_canal.ml;
  assert.strictEqual(ml.faltando_no_bling, 1, 'só v3 é faltante confirmada');
  assert.strictEqual(ml.nao_confirmadas, 1, 'v2 fica não confirmada');
  assert.ok(ml.exemplos_nao_confirmadas.includes('v2'));
  assert.ok(!ml.exemplos.includes('v2'), 'v2 NÃO pode aparecer como faltante');

  // 2) orçamento (25 idas) ≠ ausência: os cortados vão pra nao_confirmadas
  const muitos = Array.from({ length: 28 }, (_, i) => 'w' + i);
  r = await conferir(ctx(muitos, [], {}), 3, ['ml'], { todos: 1 });
  assert.strictEqual(r.por_canal.ml.faltando_no_bling, 25, '25 conclusivas dentro do teto');
  assert.strictEqual(r.por_canal.ml.nao_confirmadas, 3, '3 cortadas pelo orçamento ficam sem veredito');

  // 3) SÓ não-confirmadas ⇒ veredito INDETERMINADO (nunca ✅ com pendência aberta)
  r = await conferir(ctx(['x1', 'x2'], [], { x1: { pack: null, erro: true }, x2: null }), 3, ['ml'], {});
  assert.strictEqual(r.por_canal.ml.faltando_no_bling, 0);
  assert.strictEqual(r.por_canal.ml.nao_confirmadas, 2);
  assert.ok(r.veredito.indexOf('INDETERMINADO') >= 0 && /SEM confirma/i.test(r.veredito), 'veredito não pode dar ✅: ' + r.veredito);

  // 4) regressão do caminho feliz: apelido no Bling ⇒ ✅ limpo, sem resíduo
  r = await conferir(ctx(['z1'], ['pz'], { z1: { pack: 'pz' } }), 3, ['ml'], {});
  assert.strictEqual(r.por_canal.ml.faltando_no_bling, 0);
  assert.ok(!r.por_canal.ml.nao_confirmadas, 'sem pendência inventada');
  assert.ok(r.veredito.startsWith('✅'), 'feliz segue ✅: ' + r.veredito);

  console.log('OK: 4 cenários — erro e orçamento nunca viram ausência; ✅ só com tudo confirmado');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
