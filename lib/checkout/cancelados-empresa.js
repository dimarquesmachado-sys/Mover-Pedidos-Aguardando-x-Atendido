'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   VARREDURA DE CANCELADOS POR EMPRESA (19/10/2026) — ligador único (Fase 3 do plano multiloja).

   A regra da varredura já era peça única (lib/imposto-cancelados); o que ficava em CÓPIA era o contexto de cada empresa
   (o `_ctxImp` da AMB e o da Girassol, iguais byte a byte a menos das envs — e a GOOD não tinha nenhum). Agora o
   contexto nasce aqui, com a configuração de lib/checkout/config-empresa; a pasta entrega só as peças do módulo dela
   (deps, lidas NA HORA DA CHAMADA — muita coisa só nasce milhares de linhas depois no arquivo da empresa).

   Já com os pontos que o Codex achou ao ligar a GOOD (#716) — que valiam pras três:
   · a gravação do arquivo do dia (_vendas_dia.json) NÃO grava mais o retrato inteiro lido no começo: relê o arquivo e
     aplica SÓ as marcas de cancelamento (a venda do dia de 5 em 5 min pode ter gravado no meio — e o retrato velho
     apagaria o que ela trouxe). A venda do dia, do lado dela, preserva as marcas que achar no disco (vendas-dia.js);
   · o cancelamento vai também pros FINALIZADOS (conferidos.json, por número do pedido na loja), como a venda do dia já
     faz quando a Shopee cancela direto — senão a venda que já saiu do arquivo do dia seguia ativa no histórico.
   ───────────────────────────────────────────────────────────────────────────── */

const MARCAS = ['cancelado_mkt', 'situacao', 'escrow_final'];

function criarCanceladosDaEmpresa(empresa, extra) {
  const c = require('./config-empresa').configCheckout(empresa);
  const x = extra || {};
  if (typeof x.deps !== 'function') throw new Error('lib/checkout/cancelados-empresa: falta deps (as peças do módulo da empresa)');
  const D = () => x.deps();
  const lib = require('../imposto-cancelados');
  let _sitCancel = null;   /* o que a descoberta das situações achou (aparece no /varrer-cancelados-status) */
  const arqDia = () => D().path.join(D().CACHE_DIR, '_vendas_dia.json');

  const ctx = {
    canceladosNoMarketplace: async (dias) => {
      const url = c.ler(c.cancelados.shopeeUrl);
      const key = c.ler(c.cancelados.shopeeKey);
      if (!key) return [];
      const loja = c.ler(c.cancelados.shopeeLoja);
      const r = await D().fetch(url + '/' + loja + '/interno/cancelados?dias=' + Math.min(400, Number(dias) || 30) + '&k=' + encodeURIComponent(key), { timeout: 60000 });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) throw new Error((j && j.erro) || ('HTTP ' + r.status));
      return j.order_sns || [];
    },
    /* o mapa é por ARRAY (Codex #391): o Bling pode ter mais de um pedido com o mesmo numero_loja */
    indicePorNumeroLoja: () => {
      const idx = {};
      try {
        const at = D().readJson(arqDia(), {});
        for (const v of Object.values(at)) { const nl = v && String(v.numero_loja || '').trim(); if (nl) (idx[nl] = idx[nl] || []).push(v); }
        idx.__arquivo = at;
      } catch (e) {}
      return idx;
    },
    /* Codex #716: relê e aplica SÓ as marcas — nunca o retrato inteiro */
    gravarIndice: (mapa) => {
      try {
        if (!mapa || !mapa.__arquivo) return;
        const disco = D().readJson(arqDia(), {});
        let mexeu = 0;
        for (const [k, v] of Object.entries(mapa.__arquivo)) {
          if (!v || !v.cancelado_mkt) continue;
          const d = disco[k];
          if (!d) continue;   /* a venda do dia podou no meio: não ressuscita a linha */
          for (const m of MARCAS) if (v[m] !== undefined && d[m] !== v[m]) { d[m] = v[m]; mexeu++; }
        }
        if (mexeu) D().writeJson(arqDia(), disco);
      } catch (e) {}
    },
    /* tombstone por numero_loja (Codex #391) + espelho nos FINALIZADOS (Codex #716) */
    marcarCanceladoMkt: (numeroLoja) => {
      const sn = String(numeroLoja || '').trim(); if (!sn) return;
      try {
        const arq = D().path.join(D().CACHE_DIR, '_cancelados_shopee.json');
        const at = D().readJson(arq, {});
        at[sn] = new Date().toISOString();
        D().writeJson(arq, at);
      } catch (e) {}
      try {
        const F = D().CONFERIDOS_FILE;
        if (!F) return;
        const conf = D().readJson(F, {});
        let mexeu = 0;
        for (const k of Object.keys(conf)) { const cf = conf[k]; if (cf && String(cf.numero_loja || '').trim() === sn && !cf.cancelado) { cf.cancelado = 1; mexeu++; } }
        if (mexeu) D().writeJson(F, conf);
      } catch (e) {}
    },
    garantirSitCancel: async (bg) => { const r = await D().garantirSitCancel(bg); _sitCancel = r || _sitCancel; return r; },
    get blingGet()        { return D().blingGet; },
    get readJson()        { return D().readJson; },
    get garantirToken()   { return D().garantirToken; },
    get supaCfg()         { return D().supaCfg; },
    get CACHE_DIR()       { return D().CACHE_DIR; },
    get DEFAULT_ALIQ_BK() { const v = D().DEFAULT_ALIQ_BK; return v != null ? v : 0; },
    get histCache()       { return D().histCache || null; },
    get path()            { return D().path; },
    log: (...a) => console.log(...a),
  };

  return {
    ctx,
    empresa: c.loja,
    varrerCancelados: (dias) => lib.varrerCancelados(ctx, dias, c.loja),
    reaplicarImposto: (meses) => lib.reaplicarImposto(ctx, meses, c.loja),
    estadoCancelados: () => lib.estadoVarrerCancelados(c.loja),
    estadoImposto: () => lib.estadoReaplicarImposto(c.loja),
    sitCancel: () => _sitCancel,
  };
}

module.exports = { criarCanceladosDaEmpresa, MARCAS };
