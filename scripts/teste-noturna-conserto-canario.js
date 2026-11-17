'use strict';
/* 26/10 — na madrugada da GIRASSOL o conserto do canário estava ligado ao canário das INTEGRAÇÕES (que não devolve
   resultado): recebia nada, então nunca recolocou no Bling a venda do ML que faltava nem gravou o histórico de onde o
   aviso do painel lê. A AMB passava o resultado CERTO (o da conferência marketplace × Bling). Prova, rodando a NOTURNA
   DE PRODUÇÃO das duas com peças falsas: o conserto recebe EXATAMENTE o resultado da conferência, uma vez. */
const assert = require('assert');

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  try {
    /* 17/11 (montarCheckout, passo 12): as três montam a madrugada pela peça (lib/checkout/noturna-empresa), que liga a
       conferência e o conserto ao canário DA empresa — a madrugada montada pela peça, com o canário de mentira */
    const _FN = require('./_fonte-noturna'), NE = require('../lib/checkout/noturna-empresa');
    for (const emp of ['girassol', 'amb', 'good']) {
      assert.ok(_FN.montagem(emp).includes('    get canario() { return ' + (emp === 'good' ? '_canGood' : '_canEmp') + '; },'), emp + ': a madrugada não usa o canário da empresa');
      const RESULTADO = { ok: true, por_canal: { ml: { verificado: true, no_marketplace: 3, faltando_no_bling: 1 } }, alertas: [], nao_verificados: [] };
      const recebidos = [], pedidos = [];
      const n = NE.criar({ empresa: emp, pecas: _FN.pecasFalsas({
        canario: { conferir: async (...a) => { pedidos.push(a); return RESULTADO; }, consertar: async (r) => { recebidos.push(r); return { tentou: 0 }; } } }) });
      await n.rotinaNoturna();
      assert.strictEqual(recebidos.length, 1, emp + ': o conserto não foi chamado UMA vez na madrugada (' + recebidos.length + ')');
      assert.strictEqual(recebidos[0], RESULTADO, emp + ': o conserto não recebeu o resultado da conferência marketplace × Bling');
      assert.deepStrictEqual(pedidos, [[require('../lib/canario-marketplace').diasDaNoturna(), undefined, undefined]], emp + ': a conferência não foi a da madrugada (os dias da regra, sem canal escolhido)');
    }
  } finally { console.log = _log; console.error = _err; global.setTimeout = _st; }
  console.log('ok — madrugada: o conserto do canário recebe o resultado da conferência marketplace × Bling, nas três (pela peça)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
