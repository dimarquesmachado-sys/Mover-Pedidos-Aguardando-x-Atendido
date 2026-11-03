'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FRETE PREVISTO DO PACOTE DA MAGALU — a regra ÚNICA (03/11/2026).

   Enquanto o pedido da Magalu não liquida, o frete real (a coparticipação) não vem pela API e o histórico grava um frete
   PREVISTO: a média do frete real do banco por SKU (_magalu_frete_sku.json — cada média é a do PACOTE inteiro). Até
   aqui a regra era "o 1º SKU, em ordem alfabética, que tem banco" — num pedido com um item PEQUENO e um GRANDE ela
   pegava o pequeno. Caso real (Girassol, pedido 124275, Magalu LU #1583470110317513): tosquiadeira de 1200 W + kit de
   lâminas; o '9-dentes-reta' vem antes do 'TAF-PRO-220v' na ordem e o previsto saiu R$ 17,95, contra R$ 181,80 de
   coparticipação no repasse da Magalu — a margem do dashboard ficou R$ 163,85 alta.

   A regra nova: entre os SKUs do pacote que têm banco, vale a MAIOR média — o item maior é quem define o frete do
   pacote. Determinística (empate: o primeiro em ordem alfabética) e independente da ordem dos itens. Usada pelos
   QUATRO lugares que decidem o previsto (o leitor do histórico, o provisório da venda do dia, a caça da Magalu e o
   backfill) — assim o mesmo pedido mostra o mesmo frete no dia, no Mês e no Ano. Sem banco nenhum, devolve null
   (quem chama segue pra tabela por dimensão, como antes).

   maiorMediaDoPacote(skus, mediaDe) → { media, sku } | null — mediaDe(sku) devolve a média (> 0) ou null. */
function maiorMediaDoPacote(skus, mediaDe) {
  const lista = Array.from(new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  let melhor = null;
  for (const sku of lista) {
    let m = null;
    try { m = mediaDe(sku); } catch (e) { m = null; }
    m = Number(m);
    if (!(m > 0)) continue;
    if (!melhor || m > melhor.media) melhor = { media: Math.round(m * 100) / 100, sku };
  }
  return melhor;
}

module.exports = { maiorMediaDoPacote };
