'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   A COMISSÃO E O FRETE DA VENDA QUE SÓ EXISTE NO MERCADO LIVRE (14/11/2026) — peça do motor do histórico.

   "Venda direta do ML" é a que o ML vendeu e o Bling (ainda) não tem: envio agendado, pagamento em análise — e, na AMB, o
   Full inteiro (no Full entra no Bling a NF, não o pedido; essas linhas ficam na base PRA SEMPRE). O motor as acrescenta ao
   histórico (lib/checkout/backfill-motor.js), mas a comissão e o frete delas vinham só da FATURA do ML — e a fatura chega
   aos pedaços, dias depois. Enquanto não chegava, a linha era gravada com comissão 0 e frete 0 e a margem saía CHEIA.

   MEDIDO (AMB, sexta 13/11, as 5 vendas diretas do dia — 4 delas do carrinho CM1, R$ 249,00), base × tela, no CM1:
       comissão  R$ 0,00      × R$ 21,08   (a tarifa de venda que o próprio ML informa)
       frete     R$ 0,00      × R$ 49,35   (o custo do envio)
       margem    R$ 121,51    × R$ 51,08
   Das 5, 4 estavam com comissão zero e 4 com frete zero. Uma tinha a comissão da fatura e não o frete; outra, o frete e
   não a comissão: a fatura estava pela metade.
   Foi com essa margem inflada que o chat de análise disse "a margem não piorou" (37% na base × 26% de verdade).

   A CASCATA (a mesma ideia do caminho do Bling, que já fazia fatura → tarifa da venda → Bling):
     comissão:  1. a fatura do ML, quando já trouxe             (`fatura`)
                2. a tarifa de venda que vem NA PRÓPRIA venda    (`venda`) — `order_items[].sale_fee × quantidade`; de graça:
                   o motor já tem a venda na mão
                3. não sei                                       (`nao_sei`)
     frete:     1. a fatura do ML, quando já trouxe             (`fatura`)
                2. venda ANTIGA sem linha de frete na fatura    (`fatura_sem_frete`) — a fatura fechou sem cobrar frete: 0,
                   como sempre foi (rodada do ano não sai consultando envio de venda velha)
                3. venda RECENTE sem envio                       (`sem_envio`) — nada a cobrar: 0
                4. venda RECENTE com envio: o custo do envio, perguntado ao ML (`envio`) — é a pesca de produção
                   (lib/ml-pesca.js, a que alimenta a tela), não uma conta refeita aqui
                5. o ML respondeu os custos e o vendedor não paga (`envio_sem_custo`) — Flex ou frete do comprador: 0
                6. não sei                                       (`nao_sei`)

   "NÃO SEI" continua gravando ZERO, como era — a base não tem (comprovadamente) como guardar "em branco" nesses dois campos,
   e trocar zero por nulo sem ver a tabela poderia fazer a troca do período ser recusada pelo banco. O que muda é que deixa
   de ser o caso normal, e que a rodada CONTA quantas ficaram assim (`do_marketplace.comissao` / `.frete`).
   ───────────────────────────────────────────────────────────────────────────── */

/* por quantos dias uma venda é "recente": a fatura do ML ainda pode estar pela metade */
const DIAS_RECENTE = 45;

const hojeSP = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const numero = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

/* a tarifa de venda que o ML informa na venda — a mesma conta da tarifa leve do caminho do Bling (`_feeMLLeve`) e da pesca.
   null = a venda não traz (não é zero: o ML sempre cobra tarifa) */
function tarifaDaVenda(venda) {
  let f = 0;
  for (const it of ((venda && venda.order_items) || [])) {
    const q = Number((it && it.quantity) || 1), sf = Number((it && it.sale_fee) || 0);
    if (Number.isFinite(sf) && Number.isFinite(q)) f += sf * q;
  }
  f = Math.round(f * 100) / 100;
  return f > 0 ? f : null;
}

function recente(diaDaVenda, hoje) {
  if (typeof diaDaVenda !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(diaDaVenda)) return true;   /* sem saber o dia, trato como recente: pergunto ao ML */
  return diasEntre(diaDaVenda, hoje || hojeSP()) <= DIAS_RECENTE;
}

/* v: { venda, comissaoDaFatura, freteDaFatura, diaDaVenda, pescar(idDaVenda) → registro da pesca | null, hoje? }
   → { comissao, comFonte, frete, freFonte }   (comissao/frete null = não sei) */
async function comissaoEFrete(v) {
  let comissao = null, comFonte = 'nao_sei';
  const cFat = numero(v.comissaoDaFatura);
  if (cFat != null) { comissao = cFat; comFonte = 'fatura'; }
  else { const t = tarifaDaVenda(v.venda); if (t != null) { comissao = t; comFonte = 'venda'; } }

  let frete = null, freFonte = 'nao_sei';
  const fFat = numero(v.freteDaFatura);
  const envio = v.venda && v.venda.shipping && v.venda.shipping.id;
  if (fFat != null) { frete = fFat; freFonte = 'fatura'; }
  else if (!recente(v.diaDaVenda, v.hoje)) { frete = 0; freFonte = 'fatura_sem_frete'; }
  else if (!envio) { frete = 0; freFonte = 'sem_envio'; }
  else {
    let reg = null;
    try { reg = await v.pescar(String(v.venda.id)); } catch (e) { reg = null; }
    if (reg && typeof reg.frete === 'number' && Number.isFinite(reg.frete)) { frete = Math.round(reg.frete * 100) / 100; freFonte = 'envio'; }
    else if (reg && reg.costs_ok === true) { frete = 0; freFonte = 'envio_sem_custo'; }
    /* senão: o ML não respondeu o envio (ou só metade) — não sei */
  }
  return { comissao, comFonte, frete, freFonte };
}

module.exports = { comissaoEFrete, tarifaDaVenda, recente, DIAS_RECENTE };
