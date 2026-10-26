'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   BACKFILL DAS NFs DO ARQUIVO LOCAL — peça única (25/10/2026). Era `backfillNFLocal` em cada empresa: 34 linhas
   IDÊNTICAS nas três. criarBackfillNFLocal(dep) — as pastas e arquivos SÃO da empresa (o base dela).
   ───────────────────────────────────────────────────────────────────────────── */

function criarBackfillNFLocal(dep) {
  const { ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, path, readJson, writeJson } = dep || {};
  if (!CACHE_DIR || !readJson || !writeJson) throw new Error('lib/checkout/backfill-nf-local: faltam as pastas/leitores da empresa');
  function backfillNFLocal(dias) {
    dias = Math.max(1, Math.min(120, Number(dias || 45)));
    const corte = Date.now() - dias * 86400000;
    const conf2 = readJson(CONFERIDOS_FILE, {});
    let alvo = 0, comSimp = 0, semSimp = 0, ufN = 0, mexeu = false;   // semSimp = só quem AINDA está sem vprod_nf; mexeu = qualquer campo gravado (inclusive só numero_loja)
    for (const [cid, c] of Object.entries(conf2)) {
      if (!c || !c.conferido_em || new Date(c.conferido_em).getTime() < corte) continue;
      if (c.vprod_nf != null && c.numero_loja != null && c.uf != null) continue;
      alvo++;
      let ds = readJson(path.join(CACHE_DIR, String(cid), 'nf-simp.json'), null);
      if (!ds) ds = readJson(path.join(ARQUIVO_DIR, String(cid), 'nf-simp.json'), null);
      if (ds) {
        if (c.numero_loja == null && ds.numeroPedidoLoja) { c.numero_loja = String(ds.numeroPedidoLoja); mexeu = true; }
        // UF/município: dos campos novos do nf-simp, ou garimpado do endereço dos antigos ("..., Cidade - UF, CEP ...")
        if (c.uf == null) {
          let _u = ds.uf || null, _m = ds.municipio || null;
          if (!_u && ds.consumidor && ds.consumidor.endereco) {
            const seg = String(ds.consumidor.endereco).split(',').map(t => t.trim()).reverse().find(t => / - [A-Z]{2}$/.test(t));
            const mm = seg && seg.match(/^(.*) - ([A-Z]{2})$/);
            if (mm) { _m = _m || mm[1]; _u = mm[2]; }
          }
          if (_u) { c.uf = _u; if (_m && c.municipio == null) c.municipio = _m; ufN++; mexeu = true; }
        }
        if (Array.isArray(ds.itens) && ds.itens.length) {
          const s2 = ds.itens.reduce((a, i) => a + (Number(i.valorTotal) || 0), 0);
          if (isFinite(s2) && s2 > 0) { if (c.vprod_nf == null) { c.vprod_nf = Math.round(s2 * 100) / 100; comSimp++; mexeu = true; } continue; }
        }
      }
      if (c.vprod_nf == null) semSimp++;
    }
    if (mexeu) writeJson(CONFERIDOS_FILE, conf2);
    if (comSimp || semSimp) console.log(`[BACKFILL-NF] ${comSimp} preenchido(s) pela nota, ${semSimp} sem nf-simp no disco (janela ${dias}d)`);
    return { candidatos: alvo, preenchidos_pela_nf: comSimp, uf_preenchidas: ufN, sem_nf_simp_no_disco: semSimp, sem_vprod_nf: semSimp, dias };
  }
  return backfillNFLocal;
}

module.exports = { criarBackfillNFLocal };
