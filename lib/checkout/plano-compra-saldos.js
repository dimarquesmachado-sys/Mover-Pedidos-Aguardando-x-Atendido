'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PLANO DE COMPRA — O SALDO DE CADA PRODUTO, LIDO EM LOTE (25/11/2026).

   O dono: "pegar alguma forma o estoque mais rápido imediato, espelhando do Bling, tem como, consome cota fazendo isso?"
   O plano perguntava o saldo ao Bling PRODUTO A PRODUTO (até 260 chamadas, um a dois minutos) e por isso guardava a
   resposta 12 horas — o saldo da tela podia estar meio dia atrasado.

   O Bling tem a consulta de saldo EM LOTE (`/estoques/saldos?idsProdutos[]=…`, a mesma que a contagem e o painel do
   checkout já usam, 40 produtos por chamada). Ela precisa do ID do produto, que não muda. Então:

     · o CADASTRO (id, nome, imagem) de cada SKU é resolvido uma vez e vale 30 dias;
     · o SALDO é relido em lote a cada cálculo, se o que está guardado tem mais de 5 minutos — 260 produtos = 7 chamadas.

   saldosDoPlano({ alvo, cache, blingGet, primeiraImagem, agora?, dormir? }) → Promise<{ cadastros, lotes, falhas, saldo_lido_em }>
       Preenche `saldo`, `img` e `nome` em cada item de `alvo` e atualiza `cache` (SKU → { id, img, nome, ts_cad, saldo, ts }).
       `ts` é QUANDO O SALDO FOI LIDO. Saldo com mais de 12 h não é usado (fica "sem saldo": número velho demais não é
       número). Lote que falha deixa o saldo anterior valendo (se ainda dentro das 12 h) — nunca vira zero.
       `saldo_lido_em` é a leitura MAIS ANTIGA entre os saldos usados (o que a tela pode afirmar de todos).
       Entrada antiga do cache (sem id, do formato de antes) continua valendo pelas 12 h dela; depois ganha o id.
   ───────────────────────────────────────────────────────────────────────────── */

const SALDO_FRESCO_MS = 5 * 60 * 1000;
const SALDO_MAXIMO_MS = 12 * 3600 * 1000;
const CADASTRO_MS = 30 * 24 * 3600 * 1000;
const POR_LOTE = 40;
const MAX_SKUS = 260;

function saldoDe(estoque) {
  if (!estoque) return null;
  const v = estoque.saldoVirtualTotal != null ? estoque.saldoVirtualTotal : estoque.saldoFisicoTotal;
  return (v != null && v !== '' && isFinite(Number(v))) ? Number(v) : null;
}

async function saldosDoPlano(o) {
  const alvo = (o.alvo || []).slice(0, MAX_SKUS), cache = o.cache, blingGet = o.blingGet;
  const agora = typeof o.agora === 'function' ? o.agora : Date.now;
  const dormir = typeof o.dormir === 'function' ? o.dormir : (ms) => new Promise((r) => setTimeout(r, ms));
  const img1 = typeof o.primeiraImagem === 'function' ? o.primeiraImagem : () => null;
  const idade = (t) => agora() - (Number(t) || 0);
  let cadastros = 0, lotes = 0, falhas = 0;

  /* 1) o cadastro de quem ainda não tem id (ou venceu): uma chamada por SKU, uma vez */
  for (const x of alvo) {
    const c = cache[x.sku];
    const legadoVale = c && c.id == null && idade(c.ts) < SALDO_MAXIMO_MS;         /* formato antigo: vale pelas 12 h dele */
    const cadastroVale = c && c.id != null && idade(c.ts_cad) < CADASTRO_MS;
    if (legadoVale || cadastroVale) continue;
    try {
      const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(x.sku) + '&criterio=5&limite=1');
      /* o Bling não respondeu (limite, rede, erro): NÃO é "produto não existe" — não guarda nada e tenta no próximo cálculo */
      if (!(rb && rb.ok && rb.data && Array.isArray(rb.data.data))) { falhas++; continue; }
      const it0 = rb.data.data[0] || null;
      let saldo = null, img = null, nome = null, id = null, detalheFalhou = false;
      if (it0) {
        id = it0.id != null ? it0.id : null;
        nome = it0.nome || null;
        img = img1(it0);
        saldo = saldoDe(it0.estoque);
        if (img == null && id != null) {
          const dd = await blingGet('/produtos/' + id);
          const det = (dd && dd.ok && dd.data && dd.data.data) || null;
          if (det) { img = img1(det); if (saldo == null) saldo = saldoDe(det.estoque); } else detalheFalhou = true;
        }
      }
      /* o saldo que veio junto do cadastro é RESERVA: no Bling v3 o `estoque` da lista/detalhe é opcional e a fonte dedicada
         é o lote. Fica marcado como "já velho" (vai ser relido no lote logo abaixo) e só é usado se o lote falhar. */
      /* detalhe que FALHOU (≠ "produto sem imagem"): cadastro incompleto, vale só 12 h (não 30 dias) — a imagem é tentada de novo */
      cache[x.sku] = { id, img: img || null, nome: nome || null, ts_cad: detalheFalhou ? agora() - CADASTRO_MS + SALDO_MAXIMO_MS : agora(), saldo, ts: saldo != null ? agora() - SALDO_FRESCO_MS : 0 };
      /* recadastro do MESMO produto: a leitura de saldo que já estava guardada (mais nova que a reserva) não se perde —
         senão um lote que falhe logo depois deixaria o item "sem saldo" tendo um saldo válido de minutos atrás */
      if (id != null && c && c.saldo != null && (c.id == null || String(c.id) === String(id)) && (Number(c.ts) || 0) >= cache[x.sku].ts) {
        cache[x.sku].saldo = c.saldo; cache[x.sku].ts = c.ts;
      }
      if (id == null) cache[x.sku].ts = agora();   /* não achou o produto: "sem saldo" vale as 12 h de sempre, sem perguntar de novo a cada cálculo */
      cadastros++;
      if (cadastros % 15 === 0 && typeof o.guardar === 'function') { try { o.guardar(); } catch (e) {} }
      await dormir(340);
    } catch (e) { falhas++; }
  }

  /* 2) o saldo em lote de quem tem id e está com a leitura velha */
  const pedir = alvo.map((x) => cache[x.sku]).filter((c) => c && c.id != null && idade(c.ts) >= SALDO_FRESCO_MS);
  const porId = new Map(pedir.map((c) => [String(c.id), c]));
  const ids = Array.from(porId.keys());
  for (let i = 0; i < ids.length; i += POR_LOTE) {
    try {
      const r = await blingGet('/estoques/saldos?' + ids.slice(i, i + POR_LOTE).map((id) => 'idsProdutos[]=' + encodeURIComponent(id)).join('&'));
      lotes++;
      const arr = (r && r.ok && r.data && Array.isArray(r.data.data)) ? r.data.data : null;
      if (!arr) { falhas++; }
      else {
        const lidos = new Set();
        for (const e of arr) {
          const k = String(e && e.produto && e.produto.id);
          const c = porId.get(k);
          const s = saldoDe(e);
          if (c && s != null) { c.saldo = s; c.ts = agora(); lidos.add(k); }
        }
        /* o Bling respondeu mas não trouxe (ou trouxe sem número) o saldo de algum pedido: é leitura que falhou — o saldo
           anterior segue valendo (se dentro das 12 h), mas a tela avisa */
        falhas += ids.slice(i, i + POR_LOTE).filter((id) => !lidos.has(id)).length;
      }
    } catch (e) { lotes++; falhas++; }
    if (i + POR_LOTE < ids.length) await dormir(300);
  }

  /* 3) o que cada item leva: saldo só se a leitura tem menos de 12 h */
  let maisAntiga = null;
  for (const x of alvo) {
    const c = cache[x.sku];
    const vale = c && c.saldo != null && isFinite(Number(c.saldo)) && idade(c.ts) < SALDO_MAXIMO_MS;
    x.saldo = vale ? Number(c.saldo) : null;
    x.img = (c && c.img) || null;
    x.nome = (c && c.nome) || x.desc;
    if (vale && (maisAntiga == null || c.ts < maisAntiga)) maisAntiga = c.ts;
  }
  return { cadastros, lotes, falhas, saldo_lido_em: maisAntiga == null ? null : new Date(maisAntiga).toISOString() };
}

module.exports = { saldosDoPlano, saldoDe, SALDO_FRESCO_MS, SALDO_MAXIMO_MS, CADASTRO_MS, POR_LOTE, MAX_SKUS };
