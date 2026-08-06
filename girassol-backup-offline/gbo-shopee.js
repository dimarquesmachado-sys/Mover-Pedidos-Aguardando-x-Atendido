'use strict';
// ════════════════════════════════════════════════════════════════════════
//  SHOPEE · FINANCEIRO POR PEDIDO — 05/08/2026 (v2)
// ════════════════════════════════════════════════════════════════════════
//  MUDANÇA DE ROTA, e o motivo importa:
//  A primeira versão deste arquivo falava DIRETO com a API da Shopee, com
//  partner_id/partner_key próprios. Ao tentar autorizar, o console mostrou que
//  o app JÁ TEM dono: o serviço `girassol-shopee-sync-organizar-envio`
//  (repo ambtotal-shopee-nf-sync-x-bling), que guarda tokens por loja em
//  data/<loja>/tokens-shopee.json e é quem organiza envio e coleta.
//
//  ⚠️ O PERIGO QUE ISSO EVITOU: o refresh_token da Shopee ROTACIONA a cada
//  renovação. Dois serviços renovando o mesmo par se invalidam — e quem cairia
//  seria a etiqueta/coleta da Shopee, operação crítica de todo dia.
//
//  Então: UM DONO SÓ do token (aquele serviço) e este módulo é só CLIENTE.
//  Nenhuma credencial da Shopee mora aqui. Também não precisa mexer no
//  Redirect URL Domain do console — ele continua apontando pro dono.
//
//  ENV: SHOPEE_SYNC_KEY (a mesma que o checkout já usa pra pedir etiqueta) e,
//  opcional, SHOPEE_SYNC_URL (padrão: o serviço de sempre).
//
//  Ainda NÃO interpreta o escrow — devolve cru de propósito. No ML eu errei o
//  formato cinco vezes por supor a estrutura antes de olhar uma amostra.
// ════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const path = require('path');

const base = require('./base');
const { json, ehAdmin, CONFERIDOS_FILE, CACHE_DIR, readJson, writeJson } = base;

const ARQ_DEV = () => path.join(CACHE_DIR, '_shopee_devolucoes.json');
const ARQ_CAR = () => path.join(CACHE_DIR, '_shopee_carteira.json');

const SYNC_URL = (process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com').replace(/\/+$/, '');
const SYNC_KEY = String(process.env.SHOPEE_SYNC_KEY || '').trim();
const LOJA = process.env.SHOPEE_SYNC_LOJA || 'girassol';

// Busca o escrow de um pedido no serviço que é dono do token.
// Devolve SEMPRE o cru junto: se o formato mudar, a gente vê na hora.
async function escrowDoPedido(orderSn) {
  if (!SYNC_KEY) return { ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste serviço' };
  const url = SYNC_URL + '/' + LOJA + '/interno/escrow/' + encodeURIComponent(String(orderSn).trim()) +
    '?k=' + encodeURIComponent(SYNC_KEY);
  try {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok && d && d.ok !== false, status: r.status, dados: d, cru: txt.slice(0, 4000) };
  } catch (e) {
    return { ok: false, erro: String((e && e.message) || e) };
  }
}

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
  const tarifa   = Math.round((comissao + servico + rebate + afiliado + campanha + processa) * 100) / 100;
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
  const sobra = Math.round((produtos + frete_do_comprador - tarifa + fsf - escrow) * 100) / 100;
  return {
    produtos, comissao, servico, rebate, afiliado, transacao, transacao_cartao_informada, campanha, processa,
    tarifa, frete_do_comprador, frete, frete_liquido_vendedor, credito_frete, escrow, sobra,
    final_shipping_fee: num(oi.final_shipping_fee), shopee_shipping_rebate: num(oi.shopee_shipping_rebate),
    comissao_bruta: num(oi.commission_fee), servico_bruto: num(oi.service_fee),   // confere: bruta+bruto tem que dar a mesma tarifa
    pct_tarifa: produtos > 0 ? Math.round(tarifa / produtos * 1000) / 10 : null,
    pagamento: oi.buyer_payment_method || null,
    frete_real_da_shopee: num(oi.actual_shipping_fee), frete_pago_pelo_comprador: num(oi.buyer_paid_shipping_fee)
  };
}

// ── 06/08: cliente das rotas financeiras do servico dono do token ─────────────
// Uma funcao so, generica: monta a URL /:loja/interno/<o-que>?<params>&k=CHAVE.
// Devolve SEMPRE o cru — nao interpreto nada antes de olhar uma amostra real.
async function pedirAoSync(oQue, params) {
  if (!SYNC_KEY) return { ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste servico' };
  const q = new URLSearchParams(Object.assign({}, params || {}, { k: SYNC_KEY }));
  const url = SYNC_URL + '/' + LOJA + '/interno/' + oQue + '?' + q.toString();
  try {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok && d && d.ok !== false, status: r.status, dados: d, cru: txt.slice(0, 6000),
             via: SYNC_URL + '/' + LOJA + '/interno/' + oQue };
  } catch (e) { return { ok: false, erro: String((e && e.message) || e) }; }
}

// ════════════════════════════════════════════════════════════════════════
//  COLETORES (06/08) — devoluções e carteira, guardados no disco
// ════════════════════════════════════════════════════════════════════════
//  A Shopee só aceita JANELA DE 15 DIAS nestes endpoints (ela mesma disse:
//  "The period between create_time_from and created_time_of must not more than
//  15 days"). Então quem quer 45 dias pede TRÊS janelas — é o que estes
//  coletores fazem, guardando tudo por chave única pra não duplicar quando
//  rodarem de novo.
//  O arquivo no disco é a fonte que o dashboard vai ler depois, do mesmo jeito
//  que o _ml_billing.json é pro Mercado Livre.
const _num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const _dorme = ms => new Promise(r => setTimeout(r, ms));

async function coletarDevolucoes(dias, pedirAoSync) {
  const total = Math.min(180, Math.max(1, Number(dias) || 45));
  const agora = Math.floor(Date.now() / 1000);
  const arq = readJson(ARQ_DEV(), { devolucoes: {}, atualizado: null });
  arq.devolucoes = arq.devolucoes || {};
  let novas = 0, vistas = 0, janelas = 0, erro = null;
  for (let fim = agora; fim > agora - total * 86400; fim -= 15 * 86400) {
    const ini = Math.max(agora - total * 86400, fim - 15 * 86400 + 60);
    janelas++;
    for (let pag = 0; pag < 20; pag++) {
      const r = await pedirAoSync('devolucoes', { de: String(ini), ate: String(fim), page: String(pag), size: '50' });
      const resp = r && r.dados && r.dados.resposta && r.dados.resposta.response;
      if (!resp) { erro = erro || ('janela ' + ini + '-' + fim + ' pagina ' + pag + ': sem resposta'); break; }
      const lista = resp['return'] || [];
      for (const d of lista) {
        if (!d || !d.return_sn) continue;
        vistas++;
        if (!arq.devolucoes[d.return_sn]) novas++;
        arq.devolucoes[d.return_sn] = {
          return_sn: d.return_sn, order_sn: d.order_sn || null,
          refund_amount: _num(d.refund_amount), antes_do_desconto: _num(d.amount_before_discount),
          status: d.status || null, motivo: d.reason || null, motivo_texto: d.text_reason || null,
          criado_em: d.create_time || null, atualizado_em: d.update_time || null,
          precisa_logistica: !!d.needs_logistics, tipo: d.return_refund_type || null,
          itens: (d.item || []).map(it => ({
            sku: it.variation_sku || it.item_sku || null, nome: it.name || null,
            qtd: _num(it.amount), preco: _num(it.item_price), devolvido: _num(it.refund_amount)
          }))
        };
      }
      if (!resp.more) break;
      await _dorme(300);
    }
    await _dorme(300);
  }
  arq.atualizado = new Date().toISOString();
  writeJson(ARQ_DEV(), arq);
  return { janelas, vistas, novas, guardadas: Object.keys(arq.devolucoes).length, erro };
}

async function coletarCarteira(dias, pedirAoSync) {
  const total = Math.min(180, Math.max(1, Number(dias) || 30));
  const agora = Math.floor(Date.now() / 1000);
  const arq = readJson(ARQ_CAR(), { transacoes: {}, atualizado: null });
  arq.transacoes = arq.transacoes || {};
  let novas = 0, vistas = 0, janelas = 0, erro = null;
  for (let fim = agora; fim > agora - total * 86400; fim -= 15 * 86400) {
    const ini = Math.max(agora - total * 86400, fim - 15 * 86400 + 60);
    janelas++;
    for (let pag = 1; pag <= 40; pag++) {
      const r = await pedirAoSync('carteira', { de: String(ini), ate: String(fim), page: String(pag), size: '100' });
      const resp = r && r.dados && r.dados.resposta && r.dados.resposta.response;
      const lista = (resp && resp.transaction_list) || [];
      if (!resp) { erro = erro || ('janela ' + ini + '-' + fim + ' pagina ' + pag + ': sem resposta'); break; }
      for (const x of lista) {
        if (!x || x.transaction_id == null) continue;
        vistas++;
        const id = String(x.transaction_id);
        if (!arq.transacoes[id]) novas++;
        arq.transacoes[id] = {
          id, tipo: x.transaction_type || null, valor: _num(x.amount),
          entra_ou_sai: x.money_flow || null, quando: x.create_time || null,
          order_sn: x.order_sn || null, refund_sn: x.refund_sn || null,
          descricao: x.description || null, aba: x.transaction_tab_type || null,
          taxa: _num(x.transaction_fee), saldo_depois: _num(x.current_balance), status: x.status || null
        };
      }
      if (!lista.length) break;
      await _dorme(300);
    }
    await _dorme(300);
  }
  arq.atualizado = new Date().toISOString();
  writeJson(ARQ_CAR(), arq);
  return { janelas, vistas, novas, guardadas: Object.keys(arq.transacoes).length, erro };
}

// Lê o que já está no disco e devolve pronto pro dashboard: devoluções por SKU e
// as despesas da carteira separadas do que é renda de pedido.
function resumoShopee(de, ate) {
  const ini = Date.parse(de + 'T00:00:00Z') / 1000, fim = Date.parse(ate + 'T23:59:59Z') / 1000;
  const dev = readJson(ARQ_DEV(), { devolucoes: {} }).devolucoes || {};
  const car = readJson(ARQ_CAR(), { transacoes: {} }).transacoes || {};
  const porSku = {}, porMotivo = {};
  let devTotal = 0, devQtd = 0;
  for (const d of Object.values(dev)) {
    const q = Number(d.criado_em || 0);
    if (!(q >= ini && q <= fim)) continue;
    devQtd++; devTotal += _num(d.refund_amount);
    porMotivo[d.motivo || 'sem motivo'] = (porMotivo[d.motivo || 'sem motivo'] || 0) + 1;
    for (const it of (d.itens || [])) {
      const s = it.sku || 'sem sku';
      porSku[s] = porSku[s] || { sku: s, qtd: 0, valor: 0, nome: it.nome || null };
      porSku[s].qtd += it.qtd || 1;
      porSku[s].valor = Math.round((porSku[s].valor + _num(it.devolvido)) * 100) / 100;
    }
  }
  // ── CORRIGIDO 06/08, na 1a coleta de verdade ────────────────────────────────
  // Eu filtrava renda com /ESCROW|ORDER_INCOME/i — e esse regex ENGOLIU dois custos
  // reais, porque o nome deles também tem "ESCROW":
  //   ADJUSTMENT_FOR_RR_AFTER_ESCROW_VERIFIED  −1.455,22 em 30 dias (ajuste por
  //       devolução depois do escrow já verificado — é O CUSTO DA DEVOLUÇÃO)
  //   ESCROW_VERIFIED_MINUS                       −29,48
  // Com o filtro velho o "sai do bolso" deu R$ 16,34; o certo era R$ 1.501,04.
  // Agora a regra é explícita e pelo SINAL, não por parecença de nome:
  //   renda  = ESCROW_VERIFIED_ADD (e ORDER_INCOME) — já está na margem por pedido
  //   saque  = WITHDRAWAL_* — tirar dinheiro da carteira não é custo
  //   custo  = todo o resto com valor NEGATIVO, somado em módulo
  const ehRenda = t2 => /^(ESCROW_VERIFIED_ADD|ORDER_INCOME)/i.test(t2);
  const ehSaque = t2 => /^WITHDRAWAL/i.test(t2);
  const porTipo = {}; let saiDoBolso = 0; const custoPorTipo = {};
  for (const x of Object.values(car)) {
    const q = Number(x.quando || 0);
    if (!(q >= ini && q <= fim)) continue;
    const t2 = x.tipo || 'sem tipo';
    const v = _num(x.valor);
    porTipo[t2] = Math.round(((porTipo[t2] || 0) + v) * 100) / 100;
    if (ehRenda(t2) || ehSaque(t2)) continue;
    if (v < 0 || x.entra_ou_sai === 'MONEY_OUT') {
      const custo = Math.abs(v);
      saiDoBolso = Math.round((saiDoBolso + custo) * 100) / 100;
      custoPorTipo[t2] = Math.round(((custoPorTipo[t2] || 0) + custo) * 100) / 100;
    }
  }
  return {
    devolucoes: {
      quantidade: devQtd, valor_devolvido: Math.round(devTotal * 100) / 100,
      por_motivo: porMotivo,
      por_sku: Object.values(porSku).sort((a, b) => b.valor - a.valor).slice(0, 50)
    },
    carteira: { por_tipo: porTipo, custo_por_tipo: custoPorTipo, sai_do_bolso: saiDoBolso },
    atualizado: {
      devolucoes: readJson(ARQ_DEV(), {}).atualizado || null,
      carteira: readJson(ARQ_CAR(), {}).atualizado || null
    }
  };
}

function rotasShopee(ctx) {
  const { validarSessao } = ctx;

  function admOk(req, urlObj) {
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  return async function handleShopee(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;
    const q = urlObj.searchParams;

    // ── estado da ligação com o serviço dono do token ──────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/status') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let saude = null;
      try {
        const r = await fetch(SYNC_URL + '/health');
        saude = r.ok ? 'respondendo' : ('HTTP ' + r.status);
      } catch (e) { saude = 'sem resposta: ' + String((e && e.message) || e); }
      json(res, 200, {
        ok: true,
        quem_tem_o_token: SYNC_URL + ' (loja "' + LOJA + '")',
        chave_interna: SYNC_KEY ? 'configurada (SHOPEE_SYNC_KEY)' : 'FALTANDO — crie SHOPEE_SYNC_KEY neste serviço',
        servico: saude,
        nota: 'as credenciais da Shopee NÃO ficam aqui: quem guarda partner_key e tokens é o serviço acima. Isso evita dois donos do mesmo refresh_token.'
      });
      return true;
    }

    // ── SONDA: o escrow de um pedido, CRU ──────────────────────────────────
    // Sem &pedido=, pega sozinho a venda de Shopee mais recente do cache.
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/sonda') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let sn = String(q.get('pedido') || '').trim();
      let veioDe = 'parâmetro';
      if (!sn) {
        const conf = readJson(CONFERIDOS_FILE, {});
        const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
        const cand = linhas
          .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
          .sort((a, b) => String(b.conferido_em || b.cacheado_em || '').localeCompare(String(a.conferido_em || a.cacheado_em || '')));
        if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache — passe &pedido=ORDER_SN' }); return true; }
        sn = String(cand[0].numero_loja); veioDe = 'cache dos bipados';
      }
      const r = await escrowDoPedido(sn);
      json(res, 200, {
        ok: !!r.ok, pedido: sn, de_onde_veio_o_pedido: veioDe,
        via: SYNC_URL + '/' + LOJA + '/interno/escrow/' + sn,
        erro: r.erro || null, status_http: r.status || null,
        resposta_crua: r.cru || null,
        leia: 'ainda NÃO interpreto nada — é a resposta como a Shopee mandou, repassada pelo serviço que tem o token. Com ela na mão eu escrevo o parser sem chutar formato.'
      });
      return true;
    }

    // ── CONFERIR EM LOTE: a fórmula bate em quantos pedidos? ───────────────
    // Só leitura. Roda a conta em N pedidos de Shopee do cache e mostra onde
    // NÃO fecha. É o passo antes de gravar qualquer coisa no histórico.
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/conferir') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const max = Math.min(200, Math.max(1, parseInt(q.get('max') || '20', 10) || 20));
      const conf = readJson(CONFERIDOS_FILE, {});
      const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
      const cand = linhas
        .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
        .sort((a2, b2) => String(b2.conferido_em || b2.cacheado_em || '').localeCompare(String(a2.conferido_em || a2.cacheado_em || '')))
        .slice(0, max);
      if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache' }); return true; }
      const fecharam = [], nao_fecharam = [], falhas = [];
      let somaTarifa = 0, somaProdutos = 0;
      for (const c of cand) {
        const sn = String(c.numero_loja);
        const r = await escrowDoPedido(sn);
        const contas = r.ok && r.dados ? contasDoEscrow(r.dados.resposta) : null;
        // 06/08: pros que NAO fecharem, guardo os campos do order_income que NAO sao zero.
        // Sem isso eu ficaria adivinhando qual campo falta — e adivinhar formato de API ja
        // me custou cinco tentativas erradas no Mercado Livre.
        const cruNaoZero = (() => {
          try {
            const oi = r.dados.resposta.response.order_income;
            const o = {};
            for (const [k2, v2] of Object.entries(oi)) {
              if (k2 === 'items' || k2 === 'net_commission_fee_info_list' || k2 === 'net_service_fee_info_list') continue;
              if (typeof v2 === 'object' && v2 !== null) { const s2 = JSON.stringify(v2); if (s2 !== '{}' && !/^\{("?[a-z_]+"?:0,?)+\}$/.test(s2)) o[k2] = v2; continue; }
              if (v2 !== 0 && v2 !== '' && v2 !== null && v2 !== 'N/A') o[k2] = v2;
            }
            return o;
          } catch (e) { return null; }
        })();
        if (!contas) { falhas.push({ pedido: sn, status: r.status || null, erro: r.erro || (r.dados && r.dados.erro) || 'sem order_income' }); }
        else {
          somaTarifa += contas.tarifa; somaProdutos += contas.produtos;
          const reg = Object.assign({ pedido: sn, pedido_bling: c.numero || null }, contas);
          if (Math.abs(contas.sobra) <= 0.02) fecharam.push(reg);
          else nao_fecharam.push(Object.assign(reg, { campos_nao_zero_do_escrow: cruNaoZero }));
        }
        await new Promise(r2 => setTimeout(r2, 350));
      }
      json(res, 200, {
        ok: true, so_leitura: true, conferidos: cand.length,
        fecharam: fecharam.length, nao_fecharam: nao_fecharam.length, falhas: falhas.length,
        taxa_media_pct: somaProdutos > 0 ? Math.round(somaTarifa / somaProdutos * 1000) / 10 : null,
        formula: 'tarifa = net_comissao + net_servico + seller_product_rebate + campanha + processamento (equivale a comissao BRUTA + servico BRUTO) · credito_frete = max(0, final_shipping_fee) e SOMA (e subsidio, nao custo) · o escrow nao cobra frete desta loja · a taxa de cartao NAO entra · confere a identidade produtos + frete_do_comprador − tarifa + final_shipping_fee = escrow',
        exemplos_que_fecharam: fecharam.slice(0, 3),
        os_que_nao_fecharam: nao_fecharam.slice(0, 4),   // com o cru junto, 4 ja e bastante texto
        falhas_detalhe: falhas.slice(0, 5)
      });
      return true;
    }

    // ── SONDAS DO FINANCEIRO COMPLETO (06/08) ──────────────────────────────
    // Tudo só leitura e tudo CRU. A ordem é sempre a mesma que deu certo no
    // escrow: sondar → olhar o JSON real → só então escrever o parser.
    //   /shopee/carteira?dias=7    → ads, ajustes, reembolsos, saques (= billing do ML)
    //   /shopee/devolucoes?dias=30 → devolução e o custo dela
    //   /shopee/liberado?dias=15   → o que a Shopee liberou (tela "Minha Renda")
    //   /shopee/lote?pedidos=a,b   → escrow de até 50 pedidos numa chamada só
    const SONDAS = {
      '/girassol-backup-offline/shopee/carteira':   { rota: 'carteira',         padrao: { dias: '7' } },
      '/girassol-backup-offline/shopee/devolucoes': { rota: 'devolucoes',       padrao: { dias: '30' } },
      '/girassol-backup-offline/shopee/liberado':   { rota: 'escrow-liberado',  padrao: { dias: '15' } }
    };
    if (method === 'GET' && SONDAS[p]) {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const s = SONDAS[p];
      const par = Object.assign({}, s.padrao);
      for (const c of ['dias', 'de', 'ate', 'page', 'size']) { const v = q.get(c); if (v) par[c] = v; }
      const r = await pedirAoSync(s.rota, par);
      json(res, 200, {
        ok: !!r.ok, sonda: s.rota, parametros: par, via: r.via || null,
        erro: r.erro || null, status_http: r.status || null, resposta_crua: r.cru || null,
        leia: 'resposta CRUA da Shopee, repassada pelo serviço que tem o token. Ainda não interpreto nada — com a amostra na mão eu escrevo o parser sem chutar formato.'
      });
      return true;
    }

    // escrow de vários pedidos numa chamada só (até 50)
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/lote') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      let sns = String(q.get('pedidos') || '').split(',').map(x => x.trim()).filter(Boolean);
      let veioDe = 'parâmetro';
      if (!sns.length) {
        const conf = readJson(CONFERIDOS_FILE, {});
        const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
        sns = linhas
          .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
          .sort((a2, b2) => String(b2.conferido_em || b2.cacheado_em || '').localeCompare(String(a2.conferido_em || a2.cacheado_em || '')))
          .slice(0, Math.min(50, Math.max(1, parseInt(q.get('max') || '5', 10) || 5)))
          .map(h => String(h.numero_loja));
        veioDe = 'cache dos bipados';
        if (!sns.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee no cache — passe &pedidos=A,B,C' }); return true; }
      }
      const r = await pedirAoSync('escrow-lote', { sns: sns.join(',') });
      json(res, 200, {
        ok: !!r.ok, pedidos: sns.length, de_onde_vieram: veioDe, via: r.via || null,
        erro: r.erro || null, status_http: r.status || null, resposta_crua: r.cru || null,
        leia: 'se este lote devolver os mesmos campos do get_escrow_detail, trocamos a busca 1-a-1 por esta: 50 pedidos por chamada em vez de 1.'
      });
      return true;
    }

    // ── COLETAR e guardar no disco (roda sozinho pela noturna, ou aqui na mão) ──
    if (method === 'GET' && (p === '/girassol-backup-offline/shopee/coletar-devolucoes' || p === '/girassol-backup-offline/shopee/coletar-carteira')) {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const ehDev = p.endsWith('devolucoes');
      const dias = Math.min(180, Math.max(1, parseInt(q.get('dias') || (ehDev ? '45' : '30'), 10) || 45));
      const r = ehDev ? await coletarDevolucoes(dias, pedirAoSync) : await coletarCarteira(dias, pedirAoSync);
      json(res, 200, Object.assign({ ok: !r.erro, coletor: ehDev ? 'devolucoes' : 'carteira', dias }, r,
        { nota: 'a Shopee só aceita janela de 15 dias, então isto varre em janelas e guarda no disco por chave única (rodar de novo não duplica)' }));
      return true;
    }

    // ── RESUMO pronto pro dashboard: devoluções por SKU + despesas da carteira ──
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/resumo') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const de = String(q.get('de') || '').slice(0, 10), ate = String(q.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
      }
      json(res, 200, Object.assign({ ok: true, de, ate }, resumoShopee(de, ate)));
      return true;
    }

    return false;   // não é rota da Shopee
  };
}

// escrow de VÁRIOS pedidos numa chamada (até 50). O formato do lote é diferente
// do individual — response[].escrow_detail.order_income — e é aqui que isso é tratado.
async function escrowEmLote(orderSns) {
  const sns = (orderSns || []).map(s => String(s).trim()).filter(Boolean).slice(0, 50);
  if (!sns.length) return {};
  const r = await pedirAoSync('escrow-lote', { sns: sns.join(',') });
  const lista = (r && r.dados && r.dados.resposta && r.dados.resposta.response) || [];
  const saida = {};
  for (const item of lista) {
    const det = (item && item.escrow_detail) || item;
    const sn = det && det.order_sn;
    if (!sn || !det.order_income) continue;
    saida[String(sn)] = contasDoEscrow({ response: { order_income: det.order_income } });
  }
  return saida;
}

module.exports = { rotasShopee, escrowDoPedido, contasDoEscrow, escrowEmLote, coletarDevolucoes, coletarCarteira, resumoShopee, pedirAoSync };
