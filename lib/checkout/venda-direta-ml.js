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
   R$ 98,70. Por isso o frete é decidido POR ENVIO (`fretesDoEnvio`), com TODAS as vendas dele na mão — o motor lê todas as
   janelas da rodada antes de gravar, então as irmãs entram juntas mesmo quando a busca as entrega em páginas ou janelas
   diferentes: pergunta ao ML UMA vez e reparte pelo valor de cada venda. E quando a fatura já cobrou o envio em qualquer
   uma das vendas, vale a fatura ali e as irmãs ficam com zero (`fatura_no_carrinho`) — o envio já está pago; perguntar
   de novo seria cobrar duas vezes. O mesmo vale quando o BLING já importou uma das vendas do envio e ela levou o frete pelo
   caminho do Bling: a irmã direta não paga de novo (`envio_no_bling`).

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
   g: { vendas: [{ venda, freteDaFatura, valor, diaDaVenda }], pescar(idDaVenda) → registro da pesca | null, hoje?,
        freteNoBling? (o frete que uma irmã deste envio, vinda pelo Bling, já levou nesta rodada) }
   → [{ frete, freFonte }], na mesma ordem das vendas (frete null = não sei).
   O total do grupo nunca passa do custo do envio: a soma das partes fecha no centavo. */
async function fretesDoEnvio(g) {
  const vs = (g && g.vendas) || [];
  if (!vs.length) return [];
  const todas = (frete, freFonte) => vs.map(() => ({ frete, freFonte }));
  /* 1. uma irmã deste envio veio pelo BLING e já levou frete nesta rodada: o envio está pago ali (Codex #878, 4º). Vem
        ANTES da fatura: um envio é UMA cobrança — se a linha da fatura está nesta venda e a irmã do Bling já carrega o
        frete do mesmo envio, somar os dois seria cobrar duas vezes */
  if (numero(g.freteNoBling) > 0) return todas(0, 'envio_no_bling');
  /* 2. a fatura já cobrou o envio em alguma venda do grupo: vale a fatura, onde ela pôs; as irmãs não pagam de novo */
  const fat = vs.map((v) => numero(v.freteDaFatura));
  if (fat.some((f) => f != null)) return fat.map((f) => (f != null ? { frete: f, freFonte: 'fatura' } : { frete: 0, freFonte: 'fatura_no_carrinho' }));
  /* 3. venda antiga: a fatura fechou sem cobrar frete */
  if (!vs.some((v) => recente(v.diaDaVenda, g.hoje))) return todas(0, 'fatura_sem_frete');   /* (basta UMA venda recente no envio pra perguntar) */
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

/* O frete de TODAS as vendas diretas da rodada: junta as que dividem o mesmo envio e decide uma vez por envio.
   pendentes: [{ o2 (a venda), oid, pk (o carrinho, se houver), somaML, dv }] — cada uma ganha `.fr = { frete, freFonte }`.
   o: { freteDaFatura(oid) → número | undefined, pescar(idDaVenda), hoje?, freteNoBling?(envio) → número | undefined,
        ml?: { fetch, opts, dorme, noBling?(idDaVenda) } — pra achar as irmãs de FORA da rodada }

   AS IRMÃS DE FORA (Codex #878, 5º). A rodada só enxerga as vendas do período dela: num carrinho com uma venda em cada
   lado da borda (ou com uma que o Bling já tem), a que está dentro levaria o custo INTEIRO do envio — e refazer os dois
   dias separados gravaria o envio duas vezes. Por isso, pra cada carrinho com venda direta, o carrinho é perguntado ao
   ML (`/packs/{id}`) e as irmãs pagas do MESMO envio que não estão na rodada entram na REPARTIÇÃO — só na conta: quem é
   gravada é a venda do período, com a parte dela. A repartição segue sempre a mesma ordem (o número da venda), então a
   parte de cada venda é a mesma em qualquer rodada, junta ou separada.
   Se o ML NÃO responde o carrinho (3 tentativas), a rodada NÃO aborta: segue com as vendas que tem na mão (como era
   antes) e ANOTA o carrinho em `o.carrinhosSemResposta` — o motor mostra a contagem no status. De propósito: a leitura
   de carrinho nunca foi vista em produção nesta conta, e abortar a madrugada inteira por causa dela trocaria um erro
   raro (carrinho na borda do período) por um histórico que não atualiza. */
async function decidirFretes(pendentes, o) {
  const grupos = new Map();
  for (const pd of pendentes) {
    const ce = chaveDoEnvio(pd.o2);
    const chave = ce ? 'envio:' + ce : 'venda:' + pd.oid;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(pd);
  }
  const daRodada = new Set(pendentes.map((pd) => String(pd.oid)));
  const carrinhos = new Map();   /* carrinho → as irmãs de fora, lidas uma vez */
  for (const gr of grupos.values()) {
    const ceG = chaveDoEnvio(gr[0].o2);
    /* as irmãs de fora: só existe "irmã" em carrinho, e só interessa quem divide ESTE envio */
    const membros = gr.slice();
    if (ceG && o.ml) {
      for (const pk of new Set(gr.map((pd) => pd.pk).filter(Boolean))) {
        if (!carrinhos.has(pk)) {
          const lido = await irmasDeFora(o.ml, pk, daRodada);
          if (!lido.ok) (o.carrinhosSemResposta || (o.carrinhosSemResposta = [])).push({ carrinho: String(pk), falha: lido.falha });
          carrinhos.set(pk, lido.ok ? lido.fora : []);
        }
        for (const f of carrinhos.get(pk)) if (chaveDoEnvio(f.o2) === ceG && !membros.some((m) => String(m.oid) === String(f.oid))) membros.push(Object.assign({ dv: gr[0].dv }, f));
      }
    }
    membros.sort((a, b) => (String(a.oid).length - String(b.oid).length) || (String(a.oid) < String(b.oid) ? -1 : String(a.oid) > String(b.oid) ? 1 : 0));
    const frs = await fretesDoEnvio({ vendas: membros.map((pd) => ({ venda: pd.o2, freteDaFatura: o.freteDaFatura(pd.oid), valor: pd.somaML, diaDaVenda: pd.dv })), pescar: o.pescar, hoje: o.hoje,
      freteNoBling: (ceG && typeof o.freteNoBling === 'function') ? o.freteNoBling(ceG) : undefined });
    membros.forEach((pd, i) => { pd.fr = frs[i]; });   /* (a irmã de fora também recebe a parte dela — que não vai pra lugar nenhum: ela não está na lista que o motor grava) */
  }
  return pendentes;
}

/* as vendas PAGAS do carrinho que não estão na rodada: { ok: true, fora: [...] } | { ok: false, falha } — nunca lança */
async function irmasDeFora(ml, carrinho, daRodada) {
  const base = 'https://api.mercadolibre.com';
  const p = await lerComTentativas({ fetch: ml.fetch, url: base + '/packs/' + encodeURIComponent(carrinho), opts: ml.opts, dorme: ml.dorme }, (d) => !!d && Array.isArray(d.orders));
  if (!p.ok) return { ok: false, falha: 'carrinho: ' + p.falha };
  const fora = [];
  for (const x of p.d.orders) {
    const id = String((x && typeof x === 'object') ? (x.id == null ? '' : x.id) : (x == null ? '' : x));
    if (!/^\d+$/.test(id) || daRodada.has(id)) continue;
    /* a que o BLING já tem não entra na repartição: ela leva o frete pelo caminho do Bling (com frete nela, a direta fica
       com zero — `envio_no_bling`; sem frete nela, o custo do envio entra INTEIRO pela direta) */
    if (typeof ml.noBling === 'function' && ml.noBling(id)) continue;
    const v = await lerComTentativas({ fetch: ml.fetch, url: base + '/orders/' + id, opts: ml.opts, dorme: ml.dorme }, (d) => !!d && d.id != null);
    if (!v.ok) return { ok: false, falha: 'venda ' + id + ': ' + v.falha };   /* sem o valor dela não há como repartir: vale como carrinho sem resposta */
    if (String(v.d.status || '') !== 'paid') continue;   /* cancelada não divide o envio */
    const mg = vendaMagra(v.d);
    fora.push({ o2: mg, oid: id, pk: String(carrinho), somaML: mg.order_items.reduce((a, it) => a + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0) });
  }
  return { ok: true, fora };
}

/* A IRMÃ QUE VEIO PELO BLING (Codex #878, 4º). Num carrinho, o Bling pode ter importado UMA das vendas (pelo número dela)
   e a outra ainda só existir no ML. A do Bling leva o frete pelo caminho do Bling; a direta, perguntando o envio, levaria o
   MESMO custo de novo. O motor passa aqui cada venda da lista do ML que o Bling já tem, com o frete que ela levou nesta
   rodada: fica anotado por envio, e a irmã direta desse envio não paga de novo (`envio_no_bling`). Se a do Bling não
   levou frete nenhum, nada muda: o custo do envio entra pela direta. */
function anotarEnvioNoBling(mapa, venda, freteGravado) {
  const ce = chaveDoEnvio(venda), f = numero(freteGravado);
  if (ce && f != null && f > 0) mapa[ce] = Math.round(((mapa[ce] || 0) + f) * 100) / 100;
}

/* o que o motor guarda de cada venda até a hora de gravar: só o que a gravação usa. A rodada do ano junta milhares de
   vendas antes de gravar, e a venda inteira que o ML manda (comprador, pagamentos, etiquetas…) pesa na memória. */
function vendaMagra(v) {
  return { id: v.id, total_amount: v.total_amount,
    order_items: (v.order_items || []).map((x) => ({ quantity: x.quantity, unit_price: x.unit_price, sale_fee: x.sale_fee,
      item: x.item ? { seller_sku: x.item.seller_sku, seller_custom_field: x.item.seller_custom_field, title: x.item.title } : null })),
    shipping: (v.shipping && v.shipping.id != null) ? { id: v.shipping.id } : null };
}

/* UMA PÁGINA DA BUSCA DE VENDAS DO ML, INTEIRA OU NADA (Codex #878, 3º apontamento).
   A troca do período apaga o que havia e regrava o que a rodada juntou: se uma página não foi lida, as vendas diretas dela
   SOMEM da base (na AMB, o Full). Antes a falha passava calada (`if (!r.ok) break`; a exceção só virava `msg_ml`) e a
   troca seguia. Aqui: 3 tentativas, com espera; não deu — a busca caiu, o ML respondeu erro ou a resposta veio ilegível —,
   devolve a falha, e o motor ABORTA a rodada sem trocar nada.
   → { ok: true, d (a resposta, com `results` lista) } | { ok: false, falha } — nunca lança */
const TENTATIVAS_PAGINA = 3;
const paginaDeVendas = (o) => lerComTentativas(o, (d) => !!d && Array.isArray(d.results));
/* a leitura do ML com tentativas: `valida(d)` diz se a resposta serve. { ok: true, d } | { ok: false, falha } — nunca lança */
async function lerComTentativas(o, valida) {
  let falha = '';
  for (let tent = 1; tent <= TENTATIVAS_PAGINA; tent++) {
    let r = null;
    try { r = await o.fetch(o.url, o.opts); } catch (e) { r = null; falha = String((e && e.message) || e).slice(0, 80); }
    if (r && r.ok) {
      let d = null; try { d = await r.json(); } catch (e) { d = null; }
      if (valida(d)) return { ok: true, d };
      falha = 'resposta ilegível';
    } else if (r) falha = 'HTTP ' + r.status;
    if (tent < TENTATIVAS_PAGINA) await o.dorme(1500 * tent);
  }
  return { ok: false, falha };
}

module.exports = { comissaoDaVenda, fretesDoEnvio, decidirFretes, anotarEnvioNoBling, vendaMagra, paginaDeVendas, chaveDoEnvio, tarifaDaVenda, recente, DIAS_RECENTE, TENTATIVAS_PAGINA };
