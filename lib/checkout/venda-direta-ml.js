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

   O FRETE É DO ENVIO, NÃO DA VENDA (Codex #878, P1). As vendas de um mesmo carrinho dividem UM envio — e a pesca devolve
   o custo do envio INTEIRO pra cada uma: perguntando venda a venda, um envio de R$ 49,35 com duas vendas ia pra base como
   R$ 98,70. Por isso o frete é decidido POR ENVIO (`fretesDoEnvio`), com todas as vendas dele na mão (o motor lê a janela
   inteira antes): pergunta ao ML UMA vez e reparte pelo valor de cada venda. E quando a fatura já cobrou o envio numa das
   vendas, as irmãs ficam com zero (`fatura_no_carrinho`) — o envio já está pago ali; perguntar de novo seria cobrar duas
   vezes. Envio que já foi contado numa janela anterior da mesma rodada também não é contado de novo (`envio_ja_contado`).

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

/* a comissão de UMA venda: a fatura, se já trouxe; senão a tarifa que vem na própria venda; senão não sei (null) */
function comissaoDaVenda(venda, comissaoDaFatura) {
  const cFat = numero(comissaoDaFatura);
  if (cFat != null) return { comissao: cFat, comFonte: 'fatura' };
  const t = tarifaDaVenda(venda);
  return t != null ? { comissao: t, comFonte: 'venda' } : { comissao: null, comFonte: 'nao_sei' };
}

/* o envio da venda — vendas com o MESMO envio dividem um frete só. null = a venda não tem envio */
function chaveDoEnvio(venda) {
  const s = venda && venda.shipping && venda.shipping.id;
  return (s == null || s === '') ? null : String(s);
}

/* O frete das vendas que dividem UM envio (ou de uma venda sozinha).
   g: { vendas: [{ venda, freteDaFatura, valor, diaDaVenda }], pescar(idDaVenda) → registro da pesca | null, hoje?, jaContado? }
   → [{ frete, freFonte }], na mesma ordem das vendas (frete null = não sei).
   O total do grupo nunca passa do custo do envio: a soma das partes fecha no centavo. */
async function fretesDoEnvio(g) {
  const vs = (g && g.vendas) || [];
  if (!vs.length) return [];
  const todas = (frete, freFonte) => vs.map(() => ({ frete, freFonte }));
  /* 1. a fatura já cobrou o envio em alguma venda do grupo: vale a fatura, onde ela pôs; as irmãs não pagam de novo */
  const fat = vs.map((v) => numero(v.freteDaFatura));
  if (fat.some((f) => f != null)) return fat.map((f) => (f != null ? { frete: f, freFonte: 'fatura' } : { frete: 0, freFonte: 'fatura_no_carrinho' }));
  /* 2. este envio já entrou na conta nesta rodada (irmã que caiu em outra janela) */
  if (g.jaContado) return todas(0, 'envio_ja_contado');
  /* 3. venda antiga: a fatura fechou sem cobrar frete */
  if (!recente(vs[0].diaDaVenda, g.hoje)) return todas(0, 'fatura_sem_frete');
  /* 4. sem envio, nada a cobrar */
  if (!chaveDoEnvio(vs[0].venda)) return todas(0, 'sem_envio');
  /* 5. o custo do envio, perguntado UMA vez */
  let reg = null;
  try { reg = await g.pescar(String(vs[0].venda.id)); } catch (e) { reg = null; }
  if (reg && typeof reg.frete === 'number' && Number.isFinite(reg.frete)) {
    const total = Math.round(reg.frete * 100);   /* em centavos: a repartição fecha exata */
    const pesos = vs.map((v) => { const n = Number(v.valor); return Number.isFinite(n) && n > 0 ? n : 0; });
    const soma = pesos.reduce((a, b) => a + b, 0);
    let resto = total;
    return vs.map((v, i) => {
      /* (nunca mais que o que ainda resta: dois arredondamentos pra cima não podem deixar a última parte negativa) */
      const parte = i === vs.length - 1 ? resto : Math.min(resto, Math.round(total * (soma > 0 ? pesos[i] / soma : 1 / vs.length)));
      resto -= parte;
      return { frete: parte / 100, freFonte: 'envio' };
    });
  }
  /* 6. o ML respondeu os custos e o vendedor não paga (Flex, frete do comprador) */
  if (reg && reg.costs_ok === true) return todas(0, 'envio_sem_custo');
  /* 7. o ML não respondeu o envio (ou só metade): não sei */
  return todas(null, 'nao_sei');
}

module.exports = { comissaoDaVenda, fretesDoEnvio, chaveDoEnvio, tarifaDaVenda, recente, DIAS_RECENTE };
