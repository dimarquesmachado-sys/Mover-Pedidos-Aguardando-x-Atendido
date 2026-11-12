'use strict';
/* 12/11 — O RECÁLCULO QUE FALTAVA NO "LANÇAR CUSTO" (pedido do dono, caso real: AMB, SKU KC3 — lançou o custo certo desde
   01/09 e as vendas do período continuaram com o custo errado: "achei que já fosse rodar automático").

   Lançar (ou apagar) uma faixa de custo só gravava a faixa. As vendas JÁ GRAVADAS no histórico guardam o custo da hora em
   que entraram, então o dashboard seguia igual até alguém rodar o /reaplicar-custo na mão — que o dono nem sabia existir.

   Esta peça liga as duas pontas: toda mudança de faixa pede o recálculo DAQUELE SKU, da data da faixa até hoje, na hora.
   · Só o SKU mexido (os outros produtos do período não são tocados).
   · Fila por empresa, um de cada vez: apagar e lançar em seguida não se atropelam; pedidos do mesmo SKU se juntam (vale a
     MENOR data — recalcular de mais cedo cobre os dois).
   · A rotina de reaplicar é UMA por empresa: se outra estiver rodando (o reaplicar geral, manual), espera e tenta de novo.
   · Guarda o resultado por SKU pra tela mostrar ("recalculando…" / "N vendas recalculadas").
   Sem Bling aqui: é leitura e gravação no histórico (Supabase) — não gasta cota. */
function criar(cfg) {
  if (!cfg || typeof cfg.reaplicar !== 'function') throw new Error('lib/checkout/custo-recalculo: falta reaplicar');
  if (!cfg.empresa) throw new Error('lib/checkout/custo-recalculo: falta empresa');
  if (typeof cfg.hoje !== 'function') throw new Error('lib/checkout/custo-recalculo: falta hoje');
  const esperaMs = cfg.esperaMs == null ? 5000 : cfg.esperaMs;
  const tentativasMax = cfg.tentativasMax || 120;          /* ~10 min esperando outra reaplicação terminar */
  const fila = new Map();      /* sku → de (a menor pedida) */
  const ultimo = new Map();    /* sku → resultado */
  let rodando = null, laco = null;
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));

  async function rodar() {
    while (fila.size) {
      const [sku, de] = fila.entries().next().value; fila.delete(sku);
      const ate = cfg.hoje();
      rodando = { sku, de, ate, inicio: new Date().toISOString() };
      let r = null, erro = null, tent = 0;
      try {
        for (;;) {
          r = await cfg.reaplicar(de, ate, cfg.empresa, { sku });
          if (!(r && r.ocupado)) break;
          if (++tent >= tentativasMax) break;
          await dorme(esperaMs);
        }
      } catch (e) { erro = String((e && e.message) || e).slice(0, 200); }
      const fim = new Date().toISOString();
      if (erro) ultimo.set(sku, { ok: false, de, ate, msg: erro, fim });
      else if (!r || r.ocupado) ultimo.set(sku, { ok: false, de, ate, msg: 'outra reaplicação de custo estava rodando e não liberou — lance o custo de novo pra recalcular', fim });
      else ultimo.set(sku, { ok: !r.erros && /conclu/i.test(String(r.msg || '')), de, ate, linhas: r.linhas || 0, atualizadas: r.atualizadas || 0, erros: r.erros || 0, msg: r.msg || '', fim });
      rodando = null;
    }
  }
  /** pede o recálculo das vendas do SKU a partir de `de` (AAAA-MM-DD). Volta na hora; roda em fundo. */
  function pedir(sku, de) {
    const s = String(sku || '').trim(), d = String(de || '').slice(0, 10);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return estado(s);
    const ja = fila.get(s);
    if (!ja || d < ja) fila.set(s, d);
    if (!laco) laco = rodar().catch(() => {}).then(() => { laco = null; });
    return estado(s);
  }
  function estado(sku) {
    const s = String(sku || '').trim();
    return { na_fila: fila.has(s) ? fila.get(s) : null, rodando: (rodando && rodando.sku === s) ? { de: rodando.de, ate: rodando.ate, inicio: rodando.inicio } : null, ultimo: ultimo.get(s) || null };
  }
  /** pros testes: espera a fila esvaziar */
  async function terminar() { while (laco) await laco; }
  return { pedir, estado, terminar };
}
module.exports = { criar };
