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

// 14/08 — ADS vem da lib COMPARTILHADA (lib/shopee-ads.js): a mesma lógica serve
// girassol/amb/good, então descoberta nova entra uma vez só, não três.
const adsLib = require('../lib/shopee-ads');
const concLib = require('../lib/shopee-conciliar');   // paridade com a AMB: conciliação carteira × escrow
const ARQ_DEV = () => path.join(CACHE_DIR, '_shopee_devolucoes.json');
const ARQ_CAR = () => path.join(CACHE_DIR, '_shopee_carteira.json');

const SYNC_URL = (process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com').replace(/\/+$/, '');
const SYNC_KEY = String(process.env.SHOPEE_SYNC_KEY || '').trim();
const LOJA = process.env.SHOPEE_SYNC_LOJA || 'girassol';

// Busca o escrow de um pedido no serviço que é dono do token.
// Devolve SEMPRE o cru junto: se o formato mudar, a gente vê na hora.
async function escrowDoPedido(orderSn, loja) {
  if (!SYNC_KEY) return { ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste serviço' };
  const alvoP = (loja && /^(amb|girassol|good)$/.test(String(loja))) ? String(loja) : LOJA;
  const url = SYNC_URL + '/' + alvoP + '/interno/escrow/' + encodeURIComponent(String(orderSn).trim()) +
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

// ── 29/08: A FÓRMULA saiu daqui pra lib/shopee-escrow.js ─────────────────────
// Eram DUAS cópias (esta e a da outra empresa), iguais só porque foram consertadas à mão
// uma de cada vez. Dívida nº 1 do docs/paridade-empresas.md, e já custou dinheiro quando
// divergiram. O registro das 4 rodadas de investigação com pedidos reais foi junto pra lib.
const { contasDoEscrow, num } = require('../lib/shopee-escrow');

// ── 06/08: cliente das rotas financeiras do servico dono do token ─────────────
// Uma funcao so, generica: monta a URL /:loja/interno/<o-que>?<params>&k=CHAVE.
// Devolve SEMPRE o cru — nao interpreto nada antes de olhar uma amostra real.
async function pedirAoSync(oQue, params, loja) {
  if (!SYNC_KEY) return { ok: false, erro: 'falta a env SHOPEE_SYNC_KEY neste servico' };
  // 06/08: o `loja` opcional deixa OLHAR a AMBTotal e a GOOD daqui, sem subir nada la.
  // O servico dono do token ja atende as tres pelo :loja da URL. Serve pra ver, por
  // exemplo, o fbs_fee do Shopee Full da AMB — que na Girassol vem sempre ZERO.
  const alvo = (loja && /^(amb|girassol|good)$/.test(String(loja))) ? String(loja) : LOJA;
  const q = new URLSearchParams(Object.assign({}, params || {}, { k: SYNC_KEY }));
  const url = SYNC_URL + '/' + alvo + '/interno/' + oQue + '?' + q.toString();
  try {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok && d && d.ok !== false, status: r.status, dados: d, cru: txt.slice(0, 6000),
             via: SYNC_URL + '/' + alvo + '/interno/' + oQue };
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
          // 14/08 — campos novos anunciados pela Shopee (vigentes a partir de 17/08/2026):
          // `is_partial_quantity_return` = o comprador devolveu só PARTE das unidades (comprou 3,
          // devolveu 1) · `is_refund_amount_adjusted` = o reembolso saiu MENOR que o máximo
          // reembolsável. Sem isso, toda devolução parecia total — e o card de devoluções por
          // SKU superestimava a quantidade que realmente voltou.
          devolucao_parcial: d.is_partial_quantity_return === true,
          reembolso_ajustado: d.is_refund_amount_adjusted === true,
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
  // 14/08 (Codex): `atualizado` era gravado mesmo com falha, e a conciliação passou a
  // tratá-lo como prova de cobertura. `ok_em` só avança quando a coleta terminou SEM erro.
  if (!erro) arq.ok_em = arq.atualizado;
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
  // Codex PR#76 (3ª rodada): a alocação do custo tem que ser feita ANTES do recorte de
  // período e olhando TODAS as devoluções do pedido — senão dois relatórios de 1 dia dão,
  // cada um, o débito inteiro (o total do mês deixa de ser a soma dos dias). E quando a
  // devolução é única no pedido, ela leva o débito com refund_sn MAIS o que veio sem.
  const custoDaDevolucao = {};
  // 14/08 (correção do Diego): `refund_amount` é o PREÇO devolvido ao comprador, NÃO o custo
  // da loja — parte a Shopee banca. O que sai do bolso são os lançamentos da carteira
  // (ADJUSTMENT_FOR_RR_* e afins), e eles trazem `order_sn`: dá pra casar pedido a pedido.
  // Medido no período 01/07→14/08 da Girassol: R$ 5.249,08 devolvidos × R$ 1.598,66 debitados.
  // Codex PR#76: o débito da devolução costuma cair em DIA DIFERENTE da abertura dela — se
  // eu só olhasse a janela do relatório, o custo apareceria zerado (e no filtro de 1 dia a
  // coluna sumiria). Indexo a carteira INTEIRA por pedido e por devolução; o recorte de
  // período continua sendo feito pelas devoluções.
  const custoPorPedido = {}, custoPorDevolucao = {};
  for (const x of Object.values(car)) {
    const t1 = String(x.tipo || '').toUpperCase();
    // Codex PR#76 (2ª rodada): como o índice passou a varrer a carteira INTEIRA (o débito da
    // devolução cai em outro dia), aceitar "qualquer negativo do pedido" faria um relatório de
    // UM dia absorver ajuste de meses atrás que nada tem a ver com devolução (ex.:
    // ESCROW_VERIFIED_MINUS, que é correção de repasse). Só entram tipos de DEVOLUÇÃO.
    if (!/RETURN|REFUND|_RR|ADJUSTMENT_FOR_RR/.test(t1)) continue;
    const v1 = _num(x.valor);
    if (v1 >= 0) continue;
    const sn1 = String(x.order_sn || '').trim();
    const rsn = String(x.refund_sn || '').trim();
    // Codex PR#76 (2ª rodada): o total do pedido é usado como FALLBACK; se parte dos débitos
    // já tem refund_sn, o fallback tem que contar SÓ o que sobrou — senão A + (A+B).
    // Codex PR#76: a carteira guarda `refund_sn` — quando existe, o débito é daquela devolução
    // específica. Sem isso, duas devoluções parciais do MESMO pedido recebiam cada uma o
    // débito inteiro e o total saía DOBRADO.
    if (rsn) custoPorDevolucao[rsn] = Math.round(((custoPorDevolucao[rsn] || 0) + Math.abs(v1)) * 100) / 100;
    if (!sn1) continue;
    if (rsn) continue;   // já contabilizado na devolução específica
    custoPorPedido[sn1] = Math.round(((custoPorPedido[sn1] || 0) + Math.abs(v1)) * 100) / 100;
  }
  let devTotal = 0, devQtd = 0, devParciais = 0, devAjustadas = 0, devCanceladas = 0;
  const porStatus = {};
  const maiores = [];
  let devCustoReal = 0;
  (function alocarCusto() {
    const porPedidoTodas = {};
    for (const d0 of Object.values(dev)) {
      const sn0 = String(d0.order_sn || ''); if (!sn0) continue;
      (porPedidoTodas[sn0] = porPedidoTodas[sn0] || []).push(d0);
    }
    for (const sn0 of Object.keys(porPedidoTodas)) {
      const lista0 = porPedidoTodas[sn0];
      const semTag = custoPorPedido[sn0] || 0;              // débitos do pedido sem refund_sn
      const comTag = lista0.filter(d0 => custoPorDevolucao[String(d0.return_sn || '')] != null);
      for (const d0 of lista0) {
        const r0 = String(d0.return_sn || '');
        custoDaDevolucao[r0] = custoPorDevolucao[r0] || 0;
      }
      if (!semTag) continue;
      if (lista0.length === 1) {                            // devolução única: leva tudo do pedido
        const r0 = String(lista0[0].return_sn || '');
        custoDaDevolucao[r0] = Math.round(((custoDaDevolucao[r0] || 0) + semTag) * 100) / 100;
      } else {
        // várias devoluções e débito sem identificação: rateia entre as que NÃO têm débito próprio
        const alvos = lista0.filter(d0 => !(custoPorDevolucao[String(d0.return_sn || '')] > 0));
        const destino = alvos.length ? alvos : lista0;
        const parte = Math.round((semTag / destino.length) * 100) / 100;
        for (const d0 of destino) {
          const r0 = String(d0.return_sn || '');
          custoDaDevolucao[r0] = Math.round(((custoDaDevolucao[r0] || 0) + parte) * 100) / 100;
        }
      }
    }
  })();
  for (const d of Object.values(dev)) {
    const q = Number(d.criado_em || 0);
    if (!(q >= ini && q <= fim)) continue;
    // 14/08 — MEDIDO na sonda crua: existe devolução com `status: CANCELLED` (o comprador
    // abriu, a Shopee cancelou) e ela entrava no total como se o dinheiro tivesse voltado.
    // Ex.: 26080106RK0AP6R, R$ 47,87, NOT_RECEIPT, CANCELLED — custo ZERO pra loja.
    // Agora só conta o que está de fato aceito/em andamento; canceladas ficam à parte.
    const st9 = String(d.status || '').toUpperCase();
    porStatus[st9 || 'SEM STATUS'] = (porStatus[st9 || 'SEM STATUS'] || 0) + 1;
    if (st9 === 'CANCELLED') { devCanceladas++; continue; }
    devQtd++; devTotal += _num(d.refund_amount);
    if (d.devolucao_parcial) devParciais++;
    if (d.reembolso_ajustado) devAjustadas++;
    porMotivo[d.motivo || 'sem motivo'] = (porMotivo[d.motivo || 'sem motivo'] || 0) + 1;
    maiores.push({ valor: _num(d.refund_amount), custo_real: 0, sku: ((d.itens || [])[0] || {}).sku || null,
      motivo: d.motivo || null, texto: (d.motivo_texto || '').slice(0, 180) || null,
      status: st9 || null, order_sn: d.order_sn || null, parcial: !!d.devolucao_parcial });
    const custoReal = custoDaDevolucao[String(d.return_sn || '')] || 0;
    devCustoReal = Math.round((devCustoReal + custoReal) * 100) / 100;
    // o item de `maiores` foi empilhado logo acima, antes de sabermos o custo: preenche agora
    if (maiores.length) maiores[maiores.length - 1].custo_real = custoReal;
    const somaItens = (d.itens || []).reduce((s2, i2) => s2 + _num(i2.devolvido), 0) || 1;
    for (const it of (d.itens || [])) {
      const s = it.sku || 'sem sku';
      porSku[s] = porSku[s] || { sku: s, qtd: 0, valor: 0, custo_real: 0, nome: it.nome || null };
      porSku[s].qtd += it.qtd || 1;
      porSku[s].valor = Math.round((porSku[s].valor + _num(it.devolvido)) * 100) / 100;
      // o custo é do PEDIDO; rateia entre os itens devolvidos pelo valor de cada um
      porSku[s].custo_real = Math.round((porSku[s].custo_real + custoReal * (_num(it.devolvido) / somaItens)) * 100) / 100;
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
  const ads = adsLib.resumoAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync }, de, ate);
  /* 27/08 (aprovado pelo Diego) — ADS PAGO NO REPASSE: o top-up do saldo de Ads descontado no
     escrow de cada pedido (campo ads_escrow, gravado pelo vendas-sync). Na Girassol vem 0 hoje
     (ela não paga Ads nessa modalidade) — o campo existe pela paridade e acende sozinho se a
     modalidade for ligada. NÃO entra no sai_do_bolso nem na margem (o renda_canal já vem líquido
     dele). Janela: soma o cache de vendas (~60 dias). */
  let adsRepasse = 0, adsRepassePed = 0;
  try {
    const vd3 = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {}) || {};
    for (const v3 of Object.values(vd3)) {
      if (!v3 || v3.marketplace !== 'shopee') continue;
      const d3 = String(v3.data || '').slice(0, 10);
      if (!d3 || d3 < de || d3 > ate) continue;
      const a3 = Number(v3.ads_escrow);
      if (isFinite(a3) && a3 > 0) { adsRepasse = Math.round((adsRepasse + a3) * 100) / 100; adsRepassePed++; }
    }
  } catch (e3) {}
  return {
    ads,
    devolucoes: {
      quantidade: devQtd, valor_devolvido: Math.round(devTotal * 100) / 100,
      // a partir de 17/08 a Shopee informa isto; antes disso vem zero por falta do campo
      quantidade_parcial: devParciais, quantidade_com_reembolso_ajustado: devAjustadas,
      canceladas_fora_da_conta: devCanceladas, por_status: porStatus,
      // ★ o que REALMENTE saiu do bolso (casado com a carteira pelo número do pedido).
      // `valor_devolvido` é o preço reembolsado ao comprador — parte a Shopee banca.
      custo_real_na_carteira: devCustoReal,
      nota_custo: 'valor_devolvido = preço reembolsado ao comprador · custo_real_na_carteira = o que a Shopee debitou de você (casado por pedido)',
      por_motivo: porMotivo,
      // Codex PR#76: ordenar pelo PREÇO escondia o SKU que realmente custa (a Shopee banca
      // parte dos caros). Ordena pelo CUSTO REAL; empate/zero cai pro preço.
      por_sku: Object.values(porSku).sort((a, b) => (b.custo_real - a.custo_real) || (b.valor - a.valor)).slice(0, 50),
      // 14/08 — o motivo OFICIAL engana: a sonda mostrou uma devolução marcada como
      // CHANGE_MIND cujo texto era "o tamanho é pequeno, não serve para a máquina que tenho"
      // (incompatibilidade, que se resolve no anúncio). As maiores com o que o comprador
      // escreveu, pra decidir olhando o caso e não a etiqueta.
      maiores: maiores.sort((a, b) => b.valor - a.valor).slice(0, 15)
    },
    carteira: { por_tipo: porTipo, custo_por_tipo: custoPorTipo, sai_do_bolso: saiDoBolso,
      ads_pago_no_repasse: adsRepasse, ads_pago_no_repasse_pedidos: adsRepassePed,
      nota_ads_repasse: 'top-up de Shopee Ads descontado no escrow (por pedido, via vendas-sync) — desembolso fora da carteira; NAO somado no sai_do_bolso nem na margem (o renda_canal ja vem liquido dele)' },
    atualizado: {
      devolucoes: readJson(ARQ_DEV(), {}).atualizado || null,
      carteira: readJson(ARQ_CAR(), {}).atualizado || null
    }
  };
}

// ════════════════════════════════════════════════════════════════════════
//  TARIFA POR SKU (06/08) — a pergunta que a AMB levantou
//  Na AMB a taxa média deu 34,5%, mas o que assusta é o caso a caso: um pedido
//  de R$ 19,90 paga R$ 9,17 de tarifa (46%). Não é comissão alta — é a taxa FIXA
//  de serviço, que em ticket baixo esmaga a margem.
//  Isto lista, por SKU, quanto do preço vai embora em tarifa. Serve pras três
//  lojas (&loja=amb|girassol|good). SÓ LEITURA.
async function tarifasPorSku(loja, dias, max) {
  const d = Math.min(15, Math.max(1, Number(dias) || 15));
  const teto = Math.min(300, Math.max(1, Number(max) || 100));
  const rl = await pedirAoSync('escrow-liberado', { dias: String(d), size: '50' }, loja);
  const lst = (rl && rl.dados && rl.dados.resposta && rl.dados.resposta.response && rl.dados.resposta.response.escrow_list) || [];
  const sns = lst.slice(0, teto).map(x => String((x && x.order_sn) || '')).filter(Boolean);
  if (!sns.length) return { erro: 'a loja não devolveu pedidos liberados nesse período' };
  const porSku = {};
  let pedidos = 0, somaProd = 0, somaTar = 0, semItens = 0;
  for (let i = 0; i < sns.length; i += 50) {
    const mapa = await escrowEmLote(sns.slice(i, i + 50), loja);
    for (const [sn, c] of Object.entries(mapa)) {
      if (!c) continue;
      pedidos++; somaProd += c.produtos; somaTar += c.tarifa;
      if (!c.itens || !c.itens.length) { semItens++; continue; }
      for (const it of c.itens) {
        const s = it.sku || 'sem sku';
        porSku[s] = porSku[s] || { sku: s, nome: it.nome, pedidos: 0, unidades: 0, faturamento: 0, tarifa: 0 };
        porSku[s].pedidos++; porSku[s].unidades += it.qtd;
        porSku[s].faturamento = Math.round((porSku[s].faturamento + it.valor) * 100) / 100;
        porSku[s].tarifa = Math.round((porSku[s].tarifa + it.tarifa) * 100) / 100;
      }
      void sn;
    }
    if (sns.length > 50) await _dorme(400);
  }
  const linhas = Object.values(porSku).map(function(x){
    const pct = x.faturamento > 0 ? Math.round(x.tarifa / x.faturamento * 1000) / 10 : null;
    return Object.assign(x, {
      pct_tarifa: pct,
      preco_medio: Math.round(x.faturamento / (x.unidades || 1) * 100) / 100,
      sobra_apos_tarifa: Math.round((x.faturamento - x.tarifa) * 100) / 100,
      sobra_por_unidade: Math.round((x.faturamento - x.tarifa) / (x.unidades || 1) * 100) / 100
    });
  }).sort((a2, b2) => (b2.pct_tarifa || 0) - (a2.pct_tarifa || 0));
  return {
    pedidos, sem_itens: semItens,
    faturamento: Math.round(somaProd * 100) / 100,
    tarifa: Math.round(somaTar * 100) / 100,
    pct_medio: somaProd > 0 ? Math.round(somaTar / somaProd * 1000) / 10 : null,
    piores: linhas.slice(0, 25),
    melhores: linhas.slice(-10).reverse()
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
      const lojaC = q.get('loja');
      let cand = [];
      if (lojaC && lojaC !== LOJA) {
        // 06/08: conferir a fórmula em OUTRA loja (a AMB). Os pedidos vêm da própria
        // loja, pela lista de escrow liberado — o cache de bipados daqui só tem pedido
        // da Girassol, e a Shopee recusa com "does not belong to you".
        const rl = await pedirAoSync('escrow-liberado', { dias: '15', size: '50' }, lojaC);
        const lst = (rl && rl.dados && rl.dados.resposta && rl.dados.resposta.response && rl.dados.resposta.response.escrow_list) || [];
        cand = lst.slice(0, max).map(x => ({ numero_loja: String((x && x.order_sn) || ''), numero: null })).filter(x => x.numero_loja);
      } else {
        const conf = readJson(CONFERIDOS_FILE, {});
        const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
        cand = linhas
          .filter(h => h && /shopee/i.test(String(h.marketplace || h.canal || '')) && String(h.numero_loja || '').length > 6)
          .sort((a2, b2) => String(b2.conferido_em || b2.cacheado_em || '').localeCompare(String(a2.conferido_em || a2.cacheado_em || '')))
          .slice(0, max);
      }
      if (!cand.length) { json(res, 404, { ok: false, erro: 'sem venda de Shopee pra conferir' + (lojaC ? ' na loja ' + lojaC : '') }); return true; }
      const fecharam = [], nao_fecharam = [], falhas = [];
      let somaTarifa = 0, somaProdutos = 0;
      for (const c of cand) {
        const sn = String(c.numero_loja);
        const r = await escrowDoPedido(sn, lojaC);
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
        formula: 'tarifa = net_comissao + net_servico + seller_product_rebate + campanha + processamento (equivale a comissao BRUTA + servico BRUTO) · ads_escrow (top-up de Shopee Ads no repasse, tipico da AMB) entra na identidade mas FORA da tarifa · credito_frete = max(0, final_shipping_fee) e SOMA (e subsidio, nao custo) · o escrow nao cobra frete desta loja · a taxa de cartao NAO entra · confere a identidade produtos + frete_do_comprador − tarifa − ads_escrow + final_shipping_fee = escrow',
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
      const r = await pedirAoSync(s.rota, par, q.get('loja'));
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
      const lojaPed = q.get('loja');
      // ── 06/08, conserto na hora: com &loja=amb eu buscava os order_sn no cache dos
      // bipados da GIRASSOL — e a Shopee respondeu certo: "order_not_found ... does not
      // belong to you". Pedido da Girassol não é da AMB, óbvio. Quando a loja é OUTRA,
      // os pedidos têm que vir da própria loja: uso a lista de escrow liberado dela.
      if (!sns.length && lojaPed && lojaPed !== LOJA) {
        const rl = await pedirAoSync('escrow-liberado', { dias: '15', size: '50' }, lojaPed);
        const lista = (rl && rl.dados && rl.dados.resposta && rl.dados.resposta.response && rl.dados.resposta.response.escrow_list) || [];
        sns = lista.map(x => String((x && x.order_sn) || '')).filter(Boolean)
                   .slice(0, Math.min(50, Math.max(1, parseInt(q.get('max') || '5', 10) || 5)));
        veioDe = 'lista de escrow liberado da loja ' + lojaPed;
        if (!sns.length) { json(res, 404, { ok: false, erro: 'a loja ' + lojaPed + ' não devolveu pedidos liberados nos últimos 15 dias — passe &pedidos=A,B,C' }); return true; }
      }
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
      const r = await pedirAoSync('escrow-lote', { sns: sns.join(',') }, q.get('loja'));
      json(res, 200, {
        ok: !!r.ok, pedidos: sns.length, de_onde_vieram: veioDe, via: r.via || null,
        erro: r.erro || null, status_http: r.status || null, resposta_crua: r.cru || null,
        leia: 'se este lote devolver os mesmos campos do get_escrow_detail, trocamos a busca 1-a-1 por esta: 50 pedidos por chamada em vez de 1.'
      });
      return true;
    }

    // ── SONDA GENÉRICA: qualquer endpoint da Shopee, e de qualquer loja ────────
    // Nasceu pra duas perguntas que ficaram abertas:
    //   ADS   → /shopee/api?caminho=/api/v2/ads/get_total_balance
    //           (o domínio de anúncios exige permissão especial; em vez de eu supor
    //            se está liberado, quem responde é a própria Shopee)
    //   AMB   → &loja=amb em qualquer sonda, pra ver o financeiro da AMBTotal —
    //           inclusive o fbs_fee do Shopee Full, que na Girassol vem sempre zero
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/api') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const caminho = String(q.get('caminho') || '').trim();
      if (!caminho) { json(res, 400, { ok: false, erro: 'passe &caminho=/api/v2/...' }); return true; }
      const r = await pedirAoSync('shopee-raw', { caminho, q: String(q.get('q') || '') }, q.get('loja'));
      json(res, 200, {
        ok: !!r.ok, caminho, loja: q.get('loja') || LOJA, via: r.via || null,
        erro: r.erro || null, status_http: r.status || null, resposta_crua: r.cru || null,
        leia: 'resposta CRUA. Se vier erro de permissão, é a Shopee dizendo que o domínio não está liberado pro app — resolve no console, não no código.'
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

    // ── QUAIS SKUs ENTREGAM MAIS % PRA SHOPEE ──────────────────────────────
    if (method === 'GET' && p === '/girassol-backup-offline/shopee/tarifa-por-sku') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const lojaT = q.get('loja') || LOJA;
      const r = await tarifasPorSku(lojaT, q.get('dias') || '15', q.get('max') || '100');
      json(res, 200, Object.assign({ ok: !r.erro, loja: lojaT, dias: Number(q.get('dias') || 15) }, r, {
        leia: 'pct_tarifa = quanto do preço do SKU vai embora só em tarifa da Shopee (comissão + serviço + rebate + afiliado + seguro). sobra_por_unidade = o que resta ANTES de custo, imposto e frete. "piores" = maior % primeiro.'
      }));
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

    // 14/08 — conciliação carteira × escrow ("a Shopee me pagou o que devia?")
    if (p === '/girassol-backup-offline/shopee/conciliar') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const de = String(q.get('de') || '').slice(0, 10), ate = String(q.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (de > ate) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
      // Codex PR#71: 2026-02-30 passa no formato e o Date normaliza pra 02/03 — conciliaria
      // outro dia devolvendo o período que o usuário pediu. Data tem que existir no calendário.
      const dataReal = s0 => { const d0 = new Date(s0 + 'T00:00:00Z'); return !isNaN(d0.getTime()) && d0.toISOString().slice(0, 10) === s0; };
      if (!dataReal(de) || !dataReal(ate)) { json(res, 400, { ok: false, erro: 'data inexistente no calendário' }); return true; }
      // Codex PR#71: `&loja=` redirecionaria só o ESCROW pra outra empresa, enquanto a carteira
      // continuaria sendo a local — compararia pedidos de empresas diferentes e daria resultado
      // sem sentido. A conciliação é sempre da própria empresa deste módulo.
      if (q.get('loja')) { json(res, 400, { ok: false, erro: 'conciliação é sempre da própria empresa (a carteira é local) — remova &loja=' }); return true; }
      const r = await concLib.conciliar({ readJson, ARQ_CAR, escrowEmLote }, de, ate, q.get('max'));
      json(res, 200, r);
      return true;
    }

    // 14/08 — coleta o gasto de Shopee Ads (não passa pela carteira; é o relatório de anúncios)
    if (p === '/girassol-backup-offline/shopee/coletar-ads') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const dias = Math.min(365, Math.max(1, Number(q.get('dias')) || 30));
      const r = await adsLib.coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync }, dias, q.get('loja') || undefined);
      json(res, 200, Object.assign({ ok: true }, r));
      return true;
    }

    return false;   // não é rota da Shopee
  };
}

// escrow de VÁRIOS pedidos numa chamada (até 50). O formato do lote é diferente
// do individual — response[].escrow_detail.order_income — e é aqui que isso é tratado.
async function escrowEmLote(orderSns, loja) {
  const sns = (orderSns || []).map(s => String(s).trim()).filter(Boolean).slice(0, 50);
  if (!sns.length) return {};
  const r = await pedirAoSync('escrow-lote', { sns: sns.join(',') }, loja);
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

module.exports = { rotasShopee, escrowDoPedido, contasDoEscrow, escrowEmLote, coletarDevolucoes, coletarCarteira, resumoShopee, tarifasPorSku, pedirAoSync };
