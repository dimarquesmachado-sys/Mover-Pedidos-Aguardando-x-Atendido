'use strict';
/* 26/10 — na madrugada da GIRASSOL o conserto do canário estava ligado ao canário das INTEGRAÇÕES (que não devolve
   resultado): recebia nada, então nunca recolocou no Bling a venda do ML que faltava nem gravou o histórico de onde o
   aviso do painel lê. A AMB passava o resultado CERTO (o da conferência marketplace × Bling). Prova, rodando a NOTURNA
   DE PRODUÇÃO das duas com peças falsas: o conserto recebe EXATAMENTE o resultado da conferência, uma vez. */
const assert = require('assert');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const _log = console.log, _err = console.error; console.log = () => {}; console.error = () => {};
  try {
    for (const [emp, arq] of [['girassol', 'girassol-backup-offline/noturna.js'], ['amb', 'amb-checkout-offline/amb-noturna.js']]) {
      const RESULTADO = { ok: true, por_canal: { ml: { verificado: true, no_marketplace: 3, faltando_no_bling: 1 } }, alertas: [], nao_verificados: [] };
      const recebidos = [];
      const ok = async () => ({ ok: true });
      const ctx = {
        mlBillingSync: ok, backfillVendas: async () => ({ ok: true, desfecho: 'concluido' }), backfillEstado: () => ({ rodando: false }),
        mlSyncFees: ok, varrerCancelados: ok, canarioCron: async () => undefined, podarExpedicao: async () => ({ apagados: 0, mb: 0 }),
        resgatarHistorico: ok, coletarDevolucoes: ok, coletarCarteira: ok, coletarAds: ok,
        conferirMarketplaces: async () => RESULTADO, consertarDoCanario: async (r) => { recebidos.push(r); return { tentou: 0 }; },
        coletarFinanceiroTikTok: ok, completarTarifaTikTok: ok, VERSAO: 't', validarSessao: () => null, ehAdmin: () => false, json: () => {},
      };
      const n = require(path.join(raiz, arq)).criarNoturna(ctx);
      await n.rotinaNoturna();
      assert.strictEqual(recebidos.length, 1, emp + ': o conserto não foi chamado UMA vez na madrugada (' + recebidos.length + ')');
      assert.strictEqual(recebidos[0], RESULTADO, emp + ': o conserto não recebeu o resultado da conferência marketplace × Bling');
    }
  } finally { console.log = _log; console.error = _err; global.setTimeout = _st; }
  console.log('ok — madrugada: o conserto do canário recebe o resultado da conferência marketplace × Bling, na Girassol e na AMB');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
