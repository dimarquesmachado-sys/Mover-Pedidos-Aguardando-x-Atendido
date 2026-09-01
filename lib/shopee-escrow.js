'use strict';

/**
 * lib/shopee-escrow.js — A FÓRMULA do escrow da Shopee, em UM lugar só (29/08).
 *
 * Por que esta lib existe: a fórmula vivia em DUAS cópias byte a byte iguais
 * (girassol-backup-offline/gbo-shopee.js e amb-checkout-offline/amb-shopee.js). Iguais
 * HOJE — porque foram consertadas à mão nas duas, uma de cada vez. O doc de paridade
 * (docs/paridade-empresas.md) põe isto como dívida nº 1 justamente por já ter mordido: o
 * campo shipping_seller_protection_fee_amount existia na AMB e não na Girassol, e o
 * cálculo divergia sem ninguém ver — em dinheiro.
 *
 * O comentário abaixo é o registro de 4 rodadas de investigação com pedidos REAIS; ele
 * vem junto de propósito: é o que explica por que a conta é essa e não outra.
 */

// ── 06/08: A FORMULA, tirada da resposta REAL (pedido 260806K85EPVXY) ─────────
// A sonda mostrou que a conta fecha exatamente assim:
//    produtos 49,90 − comissao 8,98 − servico 5,00 = escrow 35,92  ✓
// O frete NAO entrou: actual_shipping_fee era 26,30, o comprador pagou 6,30 e o
// final_shipping_fee veio -6,30 (negativo = a Shopee bancou, o vendedor nao paga).
// Por isso frete do vendedor = max(0, final_shipping_fee): so conta quando SOBRA
// custo pra loja.
// Os campos "net_" sao os que valem — vem depois de rebate/ajuste. Uso eles com
// os antigos como reserva.
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
function contasDoEscrow(resp) {
  const oi = (resp && resp.response && resp.response.order_income) || null;
  if (!oi) return null;
  const produtos = num(oi.order_discounted_price) || num(oi.cost_of_goods_sold) || num(oi.order_selling_price);
  const comissao = num(oi.net_commission_fee !== undefined ? oi.net_commission_fee : oi.commission_fee);
  const servico  = num(oi.net_service_fee !== undefined ? oi.net_service_fee : oi.service_fee);
  // 06/08 — a conferencia em lote DERRUBOU o credit_card_transaction_fee da formula:
  // no pedido 260805HPJYPYQ2 a sobra deu exatamente -6,66, que era o valor desse campo.
  // Ou seja: ele NAO sai do bolso do vendedor (ja esta embutido/e do comprador). Fica
  // reportado a parte, pra gente ver, mas fora da conta.
  const transacao = 0;
  const transacao_cartao_informada = num(oi.credit_card_transaction_fee);
  const campanha  = num(oi.campaign_fee);
  const processa  = num(oi.seller_order_processing_fee);
  // ── 06/08: campo que só apareceu quando olhei a AMBTOTAL ─────────────────────
  // Pedido 260725KRDBJVMN da AMB: 19,90 − 3,58 (comissão) − 5,10 (serviço) daria
  // 11,22, mas o escrow veio 10,73. Faltavam exatos 0,49 — que estavam em
  // `shipping_seller_protection_fee_amount`, o seguro de envio do vendedor.
  // Na Girassol esse campo vem SEMPRE zero, então não apareceu em 100 pedidos.
  // Foi exatamente por isso que valeu testar na AMB ANTES de portar qualquer coisa.
  const seg = num(oi.shipping_seller_protection_fee_amount);
  // ── 06/08: O CAMPO QUE FALTAVA — seller_product_rebate ──────────────────────
  // A instrumentacao entregou de bandeja: nos 4 pedidos que nao fechavam, o
  // `seller_product_rebate.amount` era EXATAMENTE a sobra (31,97 / 3,74 / 11,98 / 70,83).
  // O que acontece: a Shopee ABATE parte da comissao e do servico (por isso net_* vem
  // baixo, ate 3% em vez de 18%) e cobra a diferenca de volta como rebate — e o rebate
  // sai do bolso do vendedor. A prova aritmetica:
  //   net_commission_fee = commission_fee - rebate.commission_fee_offset
  //   net_service_fee    = service_fee    - rebate.service_fee_offset
  //   rebate.amount      = commission_fee_offset + service_fee_offset
  // Logo net + net + rebate == comissao BRUTA + servico BRUTO. Ex. do 260805JK61BNC8:
  //   20,10 + 19,84 + 31,97 = 71,91 = 39,35 + 32,56  ->  327,90 - 71,91 = 255,99 = escrow
  // Uso net + rebate (e nao os brutos) porque nao depende de `service_fee` vir sempre.
  const reb = (oi.seller_product_rebate && typeof oi.seller_product_rebate === 'object') ? oi.seller_product_rebate : {};
  const rebate = num(reb.amount);
  // 06/08 rodada 4 — o pedido 260804E38AK924 sobrou exatos 0,45, que era o
  // `order_ams_commission_fee`: a COMISSAO DE AFILIADO. E custo do vendedor e tem
  // coluna propria no MercadoTurbo ("Comissao Afiliado", R$ 2.428,50 no ano).
  const afiliado = num(oi.order_ams_commission_fee);
  // ── 27/08 — O CAMPO DA AMB (a instrumentacao entregou de novo): nos 30/30 que sobravam,
  // `ads_escrow_top_up_fee_or_technical_support_fee` era EXATAMENTE a sobra (0,50 / 0,87 /
  // 0,60 / 1,80). E o SHOPEE ADS descontado NO REPASSE (top-up do saldo de Ads pelo escrow)
  // — a AMB paga Ads assim; a Girassol nao, por isso la fecha 100% e o campo vem 0.
  // DECISAO: entra na IDENTIDADE (o escrow fecha) mas FICA FORA da `tarifa` — e custo de
  // PUBLICIDADE, nao de venda: a tarifa vira a comissao gravada no historico, e o CONSUMO
  // das campanhas ja e contado pela frente do painel de Ads ([[shopee-ads]]); somar aqui
  // tambem seria Ads em dobro na visao de custo.
  const adsEscrow = num(oi.ads_escrow_top_up_fee_or_technical_support_fee);
  const tarifa   = Math.round((comissao + servico + rebate + afiliado + seg + campanha + processa) * 100) / 100;
  // ── 06/08, rodada 3: o SINAL do final_shipping_fee ────────────────────────────
  // Eu tratava valor positivo como CUSTO de frete. O pedido 260805JQ6X1DUT provou o
  // contrario: final_shipping_fee +8,00 (e shopee_shipping_rebate 8), e o escrow veio
  // 8,00 MAIOR que produtos-tarifa. Ou seja positivo e CREDITO — subsidio de frete que
  // a Shopee deposita pro vendedor. Somando como custo eu errava em DOBRO: a sobra deu -16.
  // E quando vem NEGATIVO (-6,30, -12,04, -1,44) tambem nao e custo: a conta fecha sem ele,
  // porque quem bancou foi a Shopee ou o comprador.
  // Conclusao: o escrow NUNCA cobra frete desta loja. O frete que sai do bolso e o motoboy
  // do Flex/Entrega Direta, que e pago FORA da Shopee e ja tem valor proprio no ⚙️.
  // ── RODADA 4: a identidade completa do frete ─────────────────────────────────
  // Rodada 3 eu disse "o escrow nao cobra frete". Estava incompleto. Os pedidos
  // 260805H8TR3GJT e 260804EETUMXPS (sobra -8,00) e o 260804DSB9FTBC (sobra +1,23)
  // mostraram as duas pontas que faltavam:
  //   • buyer_paid_shipping_fee = frete que o COMPRADOR pagou e a Shopee REPASSA -> receita
  //   • final_shipping_fee = -(actual_shipping_fee - shopee_shipping_rebate), ou seja o
  //     liquido do frete com o sinal ja invertido: NEGATIVO = custo do vendedor,
  //     POSITIVO = subsidio que sobra pra ele
  // Conferido nos 11 pedidos reais das 4 rodadas — a identidade que fecha em TODOS e:
  //   escrow = produtos + frete_do_comprador - tarifa + final_shipping_fee
  const frete_do_comprador = num(oi.buyer_paid_shipping_fee);
  const fsf = num(oi.final_shipping_fee);
  // ⚠️ ARMADILHA QUE QUASE PASSOU (06/08): gravar `max(0,-final_shipping_fee)` como custo
  // INFLA a margem negativa. No 260806K85EPVXY o comprador pagou 6,30 de frete (receita)
  // e o frete custou 6,30 — se eu lancasse so o custo, tiraria 6,30 do lucro que nao saiu
  // do bolso de ninguem. O que importa pro resultado e o LIQUIDO das duas pontas:
  //   frete_liquido_vendedor = -(buyer_paid_shipping_fee + final_shipping_fee)
  //   positivo = saiu do bolso · negativo = sobrou dinheiro de frete
  // Com ele vale a identidade limpa:  produtos - tarifa - frete_liquido = escrow
  const frete    = Math.round(Math.max(0, -fsf) * 100) / 100;   // bruto, so pra conferencia
  const frete_liquido_vendedor = Math.round(-(frete_do_comprador + fsf) * 100) / 100;
  const credito_frete = Math.round(Math.max(0, fsf) * 100) / 100;
  const escrow   = num(oi.escrow_amount_after_adjustment !== undefined ? oi.escrow_amount_after_adjustment : oi.escrow_amount);
  // se a formula estiver certa, isto tem que dar ~0 em todo pedido
  const sobra = Math.round((produtos + frete_do_comprador - tarifa - adsEscrow + fsf - escrow) * 100) / 100;   // 27/08: ads do escrow na identidade
  return {
    produtos, comissao, servico, rebate, afiliado, seguro_envio: seg, transacao, transacao_cartao_informada, campanha, processa,
    // 06/08: os itens com a tarifa RATEADA por valor. É o que permite responder
    // "quais SKUs entregam mais % pra Shopee" — a pergunta que a AMB levantou, com
    // pedidos de R$ 19,90 pagando 46% de tarifa por causa da taxa fixa de serviço.
    itens: (function(){
      const its = Array.isArray(oi.items) ? oi.items : [];
      /* 01/09 — CANCELAMENTO PARCIAL DA SHOPEE (anúncio da Open Platform, vale a partir de
         28/09, canais Turbo no Brasil): o vendedor pode cancelar ITENS ou QUANTIDADES de um
         pedido por falta de estoque, e o resto segue. Nesse caso `quantity_purchased`
         continua sendo o que o cliente comprou, mas o dinheiro do escrow corresponde só ao
         que sobrou — o rateio da tarifa por SKU sairia errado, e é dele que sai a análise
         de "qual SKU paga mais % pra Shopee", que o dono usa pra decidir preço.
         `active_qty` é o campo novo com a quantidade que de fato seguiu; usamos ele quando
         vier e caímos no comprado quando não vier (pedido antigo ou canal sem a função). */
      const qtdAtiva = (i2) => {
        const a = num(i2.active_qty);
        if (i2.active_qty != null && a >= 0) return a;
        return num(i2.quantity_purchased) || 1;
      };
      /* Codex #312 r2: filtrar só na SAÍDA deixava os cancelados dentro dos DIVISORES — no
         rateio de emergência (preços zerados) a divisão é por its.length, então com 1 ativo
         e 1 cancelado metade da tarifa sumia. Filtro ANTES de qualquer cálculo. */
      const ativos = its.filter(function(i2){ return qtdAtiva(i2) > 0; });
      const somaIt = ativos.reduce((s, i2) => s + (num(i2.discounted_price) || num(i2.selling_price) || num(i2.original_price)) * qtdAtiva(i2), 0);
      /* Codex #312: item TOTALMENTE cancelado (active_qty 0) não vendeu — deixá-lo na lista
         faria o tarifasPorSku() contar um pedido pra esse SKU e ele poderia aparecer entre
         os "piores" com tarifa zero, sujando justamente a análise que o dono usa pra preço.
         Some da lista; o rateio já o ignora porque a quantidade é zero. */
      return ativos.map(function(i2){
        const q2 = qtdAtiva(i2);
        const qComprada = num(i2.quantity_purchased) || 1;
        const cancelada = Math.max(0, qComprada - q2);
        const v2 = Math.round(((num(i2.discounted_price) || num(i2.selling_price) || num(i2.original_price)) * q2) * 100) / 100;
        const parte = somaIt > 0 ? v2 / somaIt : (ativos.length ? 1 / ativos.length : 0);   /* divide entre os ATIVOS */
        return { sku: i2.model_sku || i2.item_sku || null, nome: i2.item_name || null, qtd: q2,
                 /* deixa visível quando houve cancelamento parcial, pra ninguém estranhar a
                    diferença entre o que o cliente comprou e o que entrou na conta */
                 qtd_comprada: qComprada, qtd_cancelada: cancelada || undefined,
                 valor: v2, tarifa: Math.round(tarifa * parte * 100) / 100 };
      });
    })(),
    tarifa, ads_escrow: adsEscrow, frete_do_comprador, frete, frete_liquido_vendedor, credito_frete, escrow, sobra,
    final_shipping_fee: num(oi.final_shipping_fee), shopee_shipping_rebate: num(oi.shopee_shipping_rebate),
    comissao_bruta: num(oi.commission_fee), servico_bruto: num(oi.service_fee),   // confere: bruta+bruto tem que dar a mesma tarifa
    pct_tarifa: produtos > 0 ? Math.round(tarifa / produtos * 1000) / 10 : null,
    pagamento: oi.buyer_payment_method || null,
    frete_real_da_shopee: num(oi.actual_shipping_fee), frete_pago_pelo_comprador: num(oi.buyer_paid_shipping_fee)
  };
}

module.exports = { contasDoEscrow, num };
