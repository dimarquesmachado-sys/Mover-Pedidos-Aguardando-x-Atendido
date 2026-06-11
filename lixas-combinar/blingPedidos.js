'use strict';

/**
 * blingPedidos.js — Edita pedidos Bling pra trocar item "A COMBINAR" pelos graos reais
 *
 * Estrategia:
 *   1. GET pedido por numeroLoja (cruzamento ML order_id ↔ Bling)
 *   2. GET detalhe completo do pedido
 *   3. Valida que pode editar (status != 9 atendido / cancelado)
 *   4. Calcula rateio fiscal (regra Diego):
 *      - mult 10 (padrao): qty = pacotes (1 pacote = 10 lixas)
 *      - mult 1 (folhas): qty = lixas avulsas
 *      - preco_unit = valor_total / total_unidades_finais (max 10 decimais)
 *      - se sobrar centavo: desconto/acrescimo no rodape
 *   5. PUT body completo com array itens substituido
 *   6. Mantem cliente, frete, parcelas, observacoes etc
 *
 * Multi-empresa friendly: aceita parametro `loja` ('GIRASSOL'|'GOOD'|'AMB')
 * Por hora so GIRASSOL implementado.
 */

const tokenManager = require('./tokenManager');

const BLING_API = 'https://api.bling.com.br/Api/v3';
const PAUSA_MS = parseInt(process.env.LIXAS_BLING_PAUSA_MS || '500');
const MAX_DECIMAIS = 10;
const MAX_RETRIES_429 = 6;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Faz request HTTP autenticado pra API Bling.
 * Usa fetchComRetry do tokenManager (que ja lida com refresh automatico de token).
 * Adicionalmente faz retry em HTTP 429 com backoff exponencial.
 */
async function fetchBling(method, path, body) {
  const url = `${BLING_API}${path}`;
  const opts = {
    method,
    headers: {}
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  for (let tentativa = 1; tentativa <= MAX_RETRIES_429; tentativa++) {
    await sleep(PAUSA_MS);
    const resp = await tokenManager.fetchComRetry(url, opts);

    // 429 = rate limit - espera e tenta de novo
    if (resp.status === 429) {
      const espera = 1500 * tentativa; // 1.5s, 3s, 4.5s, 6s, 7.5s, 9s
      console.warn(`[blingPedidos] HTTP 429 em ${method} ${path} (tentativa ${tentativa}/${MAX_RETRIES_429}) - aguardando ${espera}ms`);
      if (tentativa === MAX_RETRIES_429) {
        const text = await resp.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }
        return { ok: false, status: 429, data, erro: `Rate limit excedido apos ${MAX_RETRIES_429} tentativas` };
      }
      await sleep(espera);
      continue;
    }

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }

    return { ok: resp.ok, status: resp.status, data };
  }
}

/**
 * Busca pedido Bling pelo numeroLoja (= order_id ML).
 *
 * ⚠️ A API Bling V3 NAO suporta filtrar /pedidos/vendas por numeroLoja
 * (parametro eh ignorado, retorna todos pedidos da pagina).
 *
 * Estrategia: Buscar pedidos por intervalo de DATA (dataInicial/dataFinal)
 * e filtrar em memoria.
 *
 * @param {string} orderId - numero loja ML
 * @param {string} dataInicial - YYYY-MM-DD, opcional
 * @param {string} dataFinal - YYYY-MM-DD, opcional
 * @param {boolean} verbose - se true, retorna info de debug nos warnings
 */
async function buscarPedidoPorOrderId(orderId, dataInicial, dataFinal, verbose) {
  if (!orderId) return { ok: false, erro: 'orderId obrigatorio' };

  // Janela padrao: ultimos 60 dias (cobre maioria dos casos)
  if (!dataFinal) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    dataFinal = d.toISOString().split('T')[0];
  }
  if (!dataInicial) {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    dataInicial = d.toISOString().split('T')[0];
  }

  const orderIdStr = String(orderId);
  const MAX_PAGINAS = 30; // ate 3000 pedidos
  let pagina = 1;
  let totalPedidosVistos = 0;
  const datasVistas = new Set();
  const amostraNumerosLoja = [];

  while (pagina <= MAX_PAGINAS) {
    const params = new URLSearchParams({
      dataInicial: dataInicial,
      dataFinal: dataFinal,
      pagina: String(pagina),
      limite: '100'
    });
    const r = await fetchBling('GET', `/pedidos/vendas?${params}`);
    if (!r.ok) {
      return { ok: false, erro: `Bling HTTP ${r.status} buscando pedidos`, detalhe: r.data };
    }

    const arr = Array.isArray(r.data?.data) ? r.data.data : [];
    if (arr.length === 0) break;

    totalPedidosVistos += arr.length;
    for (const p of arr) {
      if (p.data) datasVistas.add(String(p.data).slice(0,10));
      if (amostraNumerosLoja.length < 10 && p.numeroLoja) {
        amostraNumerosLoja.push(p.numeroLoja);
      }
    }

    const encontrados = arr.filter(p => String(p.numeroLoja || '') === orderIdStr);

    if (encontrados.length >= 1) {
      const escolhido = encontrados.length === 1
        ? encontrados[0]
        : encontrados.sort((a,b) => a.id - b.id)[0];
      const ret = {
        ok: true,
        pedidoId: escolhido.id,
        numero: escolhido.numero,
        numeroLoja: escolhido.numeroLoja,
        situacaoId: escolhido.situacao?.id,
        valorTotal: escolhido.total,
        raw: escolhido
      };
      if (encontrados.length > 1) {
        ret.aviso = `Duplicidade: ${encontrados.length} pedidos`;
        ret.outrosIds = encontrados.slice(1).map(x => x.id);
      }
      return ret;
    }

    if (arr.length < 100) break;
    pagina++;
  }

  // Nao achou - retorna info detalhada pra debug
  return {
    ok: false,
    erro: `Nenhum pedido encontrado com numeroLoja=${orderId} na janela ${dataInicial} a ${dataFinal}`,
    debug: {
      paginas_verificadas: pagina - 1,
      total_pedidos_vistos: totalPedidosVistos,
      datas_vistas_amostra: Array.from(datasVistas).sort().slice(0, 10),
      amostra_numerosLoja: amostraNumerosLoja
    }
  };
}

/**
 * Obtem detalhe completo do pedido (com itens, cliente, frete, parcelas etc).
 */
async function obterPedidoCompleto(pedidoId) {
  const r = await fetchBling('GET', `/pedidos/vendas/${pedidoId}`);
  if (!r.ok) {
    return { ok: false, erro: `Bling HTTP ${r.status} detalhe pedido`, detalhe: r.data };
  }
  return { ok: true, pedido: r.data?.data || r.data };
}

/**
 * Trunca um numero pra max N decimais (sem arredondar pra cima — corta).
 * Usado SOMENTE pro preco unitario (que pode ter ate 10 decimais).
 * Ex: truncarDecimais(0.789, 10) = 0.789
 *     truncarDecimais(11.27142857142857, 10) = 11.2714285714
 */
function truncarDecimais(num, maxDecimais = MAX_DECIMAIS) {
  const fator = Math.pow(10, maxDecimais);
  return Math.trunc(num * fator) / fator;
}

/**
 * Arredonda matematicamente pra 2 decimais (banker's rounding nao - usa Math.round padrao).
 * Usado pro CALCULO DE SUBTOTAIS (evita erros de floating-point).
 * Ex: arredondar2(78.89999999) = 78.9
 */
function arredondar2(num) {
  return Math.round(num * 100) / 100;
}

/**
 * Calcula o rateio fiscal pros itens do pedido.
 *
 * INPUT:
 *   valorTotalPedido: ex 78.90 (R$)
 *   graosEscolhidos: [{grao:"24", quantidade:20}, ...] (em LIXAS)
 *   graosDisponiveis: [{grao:"24", sku:"...", id_bling:..., ...}, ...] (do lixasService)
 *   unidadesPorPacote: 10 (padrao) ou 1 (folhas)
 *
 * OUTPUT:
 *   { ok, linhas:[{idProduto, codigo, descricao, quantidade, valor}], ajuste:{tipo:'desconto'|'acrescimo'|null, valor:N} }
 */
function calcularRateio({ valorTotalPedido, graosEscolhidos, graosDisponiveis, unidadesPorPacote, descricaoBase }) {
  if (!Array.isArray(graosEscolhidos) || graosEscolhidos.length === 0) {
    return { ok: false, erro: 'graosEscolhidos vazio' };
  }
  if (!valorTotalPedido || valorTotalPedido <= 0) {
    return { ok: false, erro: 'valorTotalPedido invalido' };
  }

  const mult = Number(unidadesPorPacote) || 10;

  // 1. Soma total de LIXAS pedidas
  const totalLixas = graosEscolhidos.reduce((s, g) => s + Number(g.quantidade || 0), 0);
  if (totalLixas <= 0) {
    return { ok: false, erro: 'total de lixas pedidas eh zero' };
  }

  // 2. Preco unitario por LIXA (max 10 decimais)
  const precoUnitLixa = truncarDecimais(valorTotalPedido / totalLixas, MAX_DECIMAIS);

  // 3. Preco unitario por PACOTE (= preco por LIXA × mult)
  const precoUnitPacote = truncarDecimais(precoUnitLixa * mult, MAX_DECIMAIS);

  // 4. Monta linhas - mapeia grao → produto Bling
  const linhas = [];
  let somaSubtotais = 0;

  for (const g of graosEscolhidos) {
    const filho = graosDisponiveis.find(x => String(x.grao) === String(g.grao));
    if (!filho) {
      return { ok: false, erro: `Grao ${g.grao} nao encontrado em graosDisponiveis (Bling)` };
    }
    if (!filho.id_bling) {
      return { ok: false, erro: `Grao ${g.grao} sem id_bling cadastrado` };
    }

    const quantidade = Number(g.quantidade) / mult;   // converte LIXAS → PACOTES (ou mantem se mult=1)
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      return { ok: false, erro: `Grao ${g.grao} quantidade invalida: ${g.quantidade}` };
    }
    if (mult > 1 && quantidade !== Math.trunc(quantidade)) {
      return { ok: false, erro: `Grao ${g.grao} quantidade ${g.quantidade} nao eh multiplo de ${mult}` };
    }

    const subtotal = arredondar2(precoUnitPacote * quantidade);
    somaSubtotais = arredondar2(somaSubtotais + subtotal);

    linhas.push({
      produto: { id: Number(filho.id_bling) },
      codigo: filho.sku,
      descricao: descricaoBase ? `${descricaoBase} GRÃO ${g.grao}` : `Lixa grão ${g.grao}`,
      quantidade,
      valor: precoUnitPacote,
      unidade: mult === 1 ? 'UN' : 'KIT'
    });
  }

  // 5. Calcula ajuste se nao bater (usa arredondamento matematico, evita FP bug)
  const diff = arredondar2(valorTotalPedido - somaSubtotais);
  let ajuste = null;
  if (Math.abs(diff) >= 0.01) {
    ajuste = {
      tipo: diff > 0 ? 'acrescimo' : 'desconto',
      valor: Math.abs(diff)
    };
  }

  return {
    ok: true,
    linhas,
    ajuste,
    somaSubtotais,
    valorTotalPedido,
    totalLixas,
    precoUnitLixa,
    precoUnitPacote
  };
}

/**
 * MONTA o body completo pra PUT pedido. Preserva tudo do pedido original
 * (cliente, frete, parcelas, etc) e SUBSTITUI apenas o array itens.
 */
function montarBodyPUT({ pedidoOriginal, rateio, observacaoExtra, outrosItens = null }) {
  // Clona o pedido original e troca apenas o que precisa
  const body = JSON.parse(JSON.stringify(pedidoOriginal));

  // Remove campos somente-leitura que Bling nao aceita no PUT
  delete body.id;

  const linhasGraos = rateio.linhas.map(l => ({
    produto: l.produto,
    codigo: l.codigo,
    descricao: l.descricao,
    unidade: l.unidade,
    quantidade: l.quantidade,
    valor: l.valor
  }));

  if (Array.isArray(outrosItens) && outrosItens.length > 0) {
    // ── MODO CARRINHO ──────────────────────────────────────────────
    // Preserva os demais itens do pedido (intocados) e injeta os graos
    // NO LUGAR da linha A COMBINAR. Ajuste de centavo SOMA ao desconto/
    // outras despesas originais (nao sobrescreve nada do pedido).
    const preservados = outrosItens.map(it => {
      const o = {
        produto: it.produto?.id ? { id: it.produto.id } : undefined,
        codigo: it.codigo,
        descricao: it.descricao,
        unidade: it.unidade,
        quantidade: it.quantidade,
        valor: it.valor
      };
      if (it.descricaoDetalhada) o.descricaoDetalhada = it.descricaoDetalhada;
      if (it.desconto) o.desconto = it.desconto;
      return o;
    });
    body.itens = [...preservados, ...linhasGraos];

    if (rateio.ajuste) {
      if (rateio.ajuste.tipo === 'desconto') {
        const atual = Number(body.desconto?.valor || 0);
        body.desconto = { valor: arredondar2(atual + rateio.ajuste.valor), unidade: 'REAL' };
      } else {
        const atual = Number(body.outrasDespesas || 0);
        body.outrasDespesas = arredondar2(atual + rateio.ajuste.valor);
      }
    }
    // sem ajuste: NAO mexe em desconto/outrasDespesas (mantem o original do pedido)
  } else {
    // ── MODO PADRAO (pedido de 1 item) — comportamento identico ao de sempre ──
    body.itens = linhasGraos;

    if (rateio.ajuste) {
      if (rateio.ajuste.tipo === 'desconto') {
        body.desconto = {
          valor: rateio.ajuste.valor,
          unidade: 'REAL'
        };
      } else {
        // Acrescimo via "outras despesas" ou "outrasDespesas"
        body.outrasDespesas = rateio.ajuste.valor;
      }
    } else {
      // Zera desconto e outras despesas se estavam preenchidos
      body.desconto = { valor: 0, unidade: 'REAL' };
      body.outrasDespesas = 0;
    }
  }

  // Anexa observacao interna marcando edicao automatica
  const obsAtual = body.observacoesInternas || '';
  const stamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const novaObs = `🤖 IA editou em ${stamp}: ${rateio.linhas.length} graos | total ${rateio.totalLixas} lixas | R$${rateio.valorTotalPedido}`;
  body.observacoesInternas = (obsAtual + '\n\n' + novaObs).slice(-1500);

  return body;
}

/**
 * Faz o PUT do pedido editado no Bling.
 */
async function atualizarPedido(pedidoId, body) {
  const r = await fetchBling('PUT', `/pedidos/vendas/${pedidoId}`, body);
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      erro: typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 500),
      raw: r.data
    };
  }
  return { ok: true, raw: r.data };
}

/**
 * Funcao orquestradora: dado order_id ML + lista de graos, edita pedido Bling.
 *
 * INPUT:
 *   orderId: ML order_id (string)
 *   graosEscolhidos: [{grao:"24", quantidade:20}, ...]
 *   graosDisponiveis: [{grao:"24", sku, id_bling, ...}, ...] (do lixasService)
 *   unidadesPorPacote: 10 ou 1
 *   descricaoBase: opcional, usar pra descricao das linhas
 *
 * OUTPUT:
 *   { ok, pedidoId, rateio, raw } ou { ok:false, erro }
 */
async function editarPedidoComGraos({
  orderId, graosEscolhidos, graosDisponiveis,
  unidadesPorPacote, descricaoBase, dryRun,
  dataVenda, // opcional - YYYY-MM-DD da venda ML, usado pra estreitar busca
  skuACombinar // opcional - SKU do anuncio A COMBINAR (melhora deteccao no carrinho)
}) {
  // 1. Busca pedido com janela centrada na data da venda (se conhecida)
  let dataInicial, dataFinal;
  if (dataVenda) {
    const d = new Date(dataVenda);
    const iniD = new Date(d); iniD.setDate(iniD.getDate() - 2);
    const fimD = new Date(d); fimD.setDate(fimD.getDate() + 2);
    dataInicial = iniD.toISOString().split('T')[0];
    dataFinal = fimD.toISOString().split('T')[0];
  }
  const buscar = await buscarPedidoPorOrderId(orderId, dataInicial, dataFinal);
  if (!buscar.ok) return { ok: false, etapa: 'buscar', ...buscar };

  // 2. Detalhe completo
  const detalhe = await obterPedidoCompleto(buscar.pedidoId);
  if (!detalhe.ok) return { ok: false, etapa: 'detalhe', ...detalhe };

  const pedido = detalhe.pedido;
  const totalOriginalPedido = Number(pedido.total);
  const situacaoId = pedido.situacao?.id;

  // ── Deteccao de CARRINHO ────────────────────────────────────────────
  // Pedido com 1 item: comportamento padrao (rateia o total do pedido).
  // Pedido com 2+ itens: acha a UNICA linha A COMBINAR (pelo SKU da venda
  // ou pelo codigo/descricao contendo "A COMBINAR"), rateia SO o valor dela
  // e preserva os demais itens intocados.
  const itensPedido = Array.isArray(pedido.itens) ? pedido.itens : [];
  let outrosItens = null;
  let valorTotalPedido = totalOriginalPedido;
  if (itensPedido.length > 1) {
    const rx = /A-?\s?COMBINAR/i;
    const alvos = itensPedido.filter(it =>
      (skuACombinar && String(it.codigo || '').trim() === String(skuACombinar).trim())
      || rx.test(String(it.codigo || ''))
      || rx.test(String(it.descricao || ''))
    );
    if (alvos.length !== 1) {
      return {
        ok: false,
        etapa: 'carrinho',
        erro: `carrinho: ${alvos.length} linha(s) A COMBINAR no pedido (esperado exatamente 1) — tratar manual`,
        pedidoId: buscar.pedidoId
      };
    }
    const alvo = alvos[0];
    outrosItens = itensPedido.filter(it => it !== alvo);
    valorTotalPedido = arredondar2(Number(alvo.valor) * Number(alvo.quantidade || 1));
    console.log(`[blingPedidos] CARRINHO: rateando so a linha ${alvo.codigo} (R$${valorTotalPedido}) e preservando ${outrosItens.length} item(ns)`);
  }

  // 3. Status info (so loga, nao bloqueia - deixa Bling decidir)
  const STATUS_BLOQUEADOS_ESTRITO = [12]; // 12=Cancelado (sempre bloquear)
  if (STATUS_BLOQUEADOS_ESTRITO.includes(Number(situacaoId))) {
    return {
      ok: false,
      etapa: 'validar_status',
      erro: `Pedido ${buscar.pedidoId} esta cancelado (situacao ${situacaoId}). Nao da pra editar.`,
      situacaoId,
      pedidoId: buscar.pedidoId
    };
  }
  if (Number(situacaoId) === 9) {
    console.log(`[blingPedidos] Pedido ${buscar.pedidoId} esta em status 9 (Atendido). Tentando editar mesmo assim - se Bling rejeitar, sera necessario estornar estoque/contas.`);
  }

  // 4. Calcula rateio
  const rateio = calcularRateio({
    valorTotalPedido,
    graosEscolhidos,
    graosDisponiveis,
    unidadesPorPacote,
    descricaoBase
  });
  if (!rateio.ok) return { ok: false, etapa: 'rateio', ...rateio };

  // 5. Monta body
  const body = montarBodyPUT({
    pedidoOriginal: pedido,
    rateio,
    observacaoExtra: null,
    outrosItens
  });

  // 6. Dry run: nao envia, apenas retorna preview
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      pedidoId: buscar.pedidoId,
      rateio,
      preview_body: body
    };
  }

  // 7. PUT
  const upd = await atualizarPedido(buscar.pedidoId, body);
  if (!upd.ok) return { ok: false, etapa: 'put', pedidoId: buscar.pedidoId, ...upd };

  // 8. VALIDACAO (so no carrinho): o total do pedido NAO pode mudar — tem que
  // continuar batendo com o valor do ML. Se divergir 1 centavo, RESTAURA o
  // pedido original e escala pra humano (nada de NF com total errado).
  if (outrosItens) {
    const conf = await obterPedidoCompleto(buscar.pedidoId);
    const totalNovo = conf.ok ? Number(conf.pedido?.total) : NaN;
    if (!Number.isFinite(totalNovo) || Math.abs(totalNovo - totalOriginalPedido) >= 0.01) {
      const restaura = JSON.parse(JSON.stringify(pedido));
      delete restaura.id;
      const volta = await atualizarPedido(buscar.pedidoId, restaura);
      return {
        ok: false,
        etapa: 'validar_total',
        erro: `carrinho: total divergiu apos edicao (Bling R$${totalNovo} vs original R$${totalOriginalPedido}) — pedido ${volta.ok ? 'RESTAURADO ao estado original' : 'NAO PODE SER RESTAURADO, conferir no Bling!'} — tratar manual`,
        pedidoId: buscar.pedidoId
      };
    }
    console.log(`[blingPedidos] CARRINHO: total validado OK (R$${totalNovo} == R$${totalOriginalPedido})`);
  }

  return {
    ok: true,
    pedidoId: buscar.pedidoId,
    numero: buscar.numero,
    rateio,
    carrinho: !!outrosItens,
    raw: upd.raw
  };
}

/**
 * Emite NF-e a partir de um pedido de venda.
 * Bling endpoint: POST /pedidos/vendas/{idPedidoVenda}/gerar-nfe
 *
 * IMPORTANTE: requer scope adicional no app Bling = "Notas Fiscais Eletronicas".
 * Sem o scope retorna HTTP 403 insufficient_scope.
 *
 * @param {number|string} pedidoId - ID do pedido Bling (NAO orderId)
 * @returns {object} { ok, status, nfeId, numero, serie, chave, raw }
 */
async function gerarNFe(pedidoId) {
  if (!pedidoId) return { ok: false, erro: 'pedidoId obrigatorio' };

  const r = await fetchBling('POST', `/pedidos/vendas/${pedidoId}/gerar-nfe`, {});

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      erro: `Bling HTTP ${r.status} gerando NFe`,
      detalhe: r.data
    };
  }

  // Resposta tipica: { data: { id, numero, serie, chaveAcesso? } }
  const data = r.data?.data || r.data || {};
  return {
    ok: true,
    status: r.status,
    nfeId: data.id,
    numero: data.numero,
    serie: data.serie,
    chave: data.chaveAcesso || data.chave,
    raw: r.data
  };
}

module.exports = {
  buscarPedidoPorOrderId,
  obterPedidoCompleto,
  calcularRateio,
  montarBodyPUT,
  atualizarPedido,
  editarPedidoComGraos,
  gerarNFe,
  truncarDecimais
};
