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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Faz request HTTP autenticado pra API Bling. Renova token em caso 401.
 */
async function fetchBling(method, path, body) {
  await sleep(PAUSA_MS);

  const url = `${BLING_API}${path}`;
  const fazRequest = async () => {
    const token = await tokenManager.garantirToken();
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  };

  let resp = await fazRequest();
  if (resp.status === 401) {
    console.log(`[blingPedidos] 401 em ${method} ${path}, tentando refresh token`);
    await tokenManager.renovarToken();
    resp = await fazRequest();
  }

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }

  return { ok: resp.ok, status: resp.status, data };
}

/**
 * Busca pedido Bling pelo numeroLoja (= order_id ML).
 * Retorna { ok, pedidoId, raw } ou erro.
 */
async function buscarPedidoPorOrderId(orderId) {
  if (!orderId) return { ok: false, erro: 'orderId obrigatorio' };

  const r = await fetchBling('GET', `/pedidos/vendas?numeroLoja=${encodeURIComponent(orderId)}`);
  if (!r.ok) {
    return { ok: false, erro: `Bling HTTP ${r.status} buscando pedido`, detalhe: r.data };
  }

  const arr = Array.isArray(r.data?.data) ? r.data.data : [];
  if (arr.length === 0) {
    return { ok: false, erro: `Nenhum pedido encontrado com numeroLoja=${orderId}` };
  }

  if (arr.length > 1) {
    console.warn(`[blingPedidos] Mais de 1 pedido pra order_id ${orderId} (${arr.length}) - usando primeiro`);
  }

  return {
    ok: true,
    pedidoId: arr[0].id,
    numero: arr[0].numero,
    situacaoId: arr[0].situacao?.id,
    valorTotal: arr[0].total,
    raw: arr[0]
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
 * Ex: truncarDecimais(0.789, 10) = 0.789
 *     truncarDecimais(11.27142857142857, 10) = 11.2714285714
 */
function truncarDecimais(num, maxDecimais = MAX_DECIMAIS) {
  const fator = Math.pow(10, maxDecimais);
  return Math.trunc(num * fator) / fator;
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

    const subtotal = truncarDecimais(precoUnitPacote * quantidade, 2); // subtotal em 2 dec
    somaSubtotais = truncarDecimais(somaSubtotais + subtotal, 2);

    linhas.push({
      produto: { id: Number(filho.id_bling) },
      codigo: filho.sku,
      descricao: descricaoBase ? `${descricaoBase} GRÃO ${g.grao}` : `Lixa grão ${g.grao}`,
      quantidade,
      valor: precoUnitPacote,
      unidade: mult === 1 ? 'UN' : 'KIT'
    });
  }

  // 5. Calcula ajuste se nao bater
  // Bling vai calcular subtotal_itens = somaSubtotais (com 2 decimais arredondado)
  // Se != valorTotalPedido, lanca desconto OU acrescimo
  const diff = truncarDecimais(valorTotalPedido - somaSubtotais, 2);
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
function montarBodyPUT({ pedidoOriginal, rateio, observacaoExtra }) {
  // Clona o pedido original e troca apenas o que precisa
  const body = JSON.parse(JSON.stringify(pedidoOriginal));

  // Remove campos somente-leitura que Bling nao aceita no PUT
  delete body.id;

  // Substitui itens
  body.itens = rateio.linhas.map(l => ({
    produto: l.produto,
    codigo: l.codigo,
    descricao: l.descricao,
    unidade: l.unidade,
    quantidade: l.quantidade,
    valor: l.valor
  }));

  // Ajuste de desconto/acrescimo (se necessario)
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
  unidadesPorPacote, descricaoBase, dryRun
}) {
  // 1. Busca pedido
  const buscar = await buscarPedidoPorOrderId(orderId);
  if (!buscar.ok) return { ok: false, etapa: 'buscar', ...buscar };

  // 2. Detalhe completo
  const detalhe = await obterPedidoCompleto(buscar.pedidoId);
  if (!detalhe.ok) return { ok: false, etapa: 'detalhe', ...detalhe };

  const pedido = detalhe.pedido;
  const valorTotalPedido = Number(pedido.total);
  const situacaoId = pedido.situacao?.id;

  // 3. Valida status (nao pode estar Atendido=9 nem Cancelado=12)
  const STATUS_BLOQUEADOS = [9, 12]; // 9=Atendido (estoque/contas lancado), 12=Cancelado
  if (STATUS_BLOQUEADOS.includes(Number(situacaoId))) {
    return {
      ok: false,
      etapa: 'validar_status',
      erro: `Pedido ${buscar.pedidoId} esta na situacao ${situacaoId} (bloqueada pra edicao). Estorne estoque/contas no Bling primeiro.`,
      situacaoId,
      pedidoId: buscar.pedidoId
    };
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
    observacaoExtra: null
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

  return {
    ok: true,
    pedidoId: buscar.pedidoId,
    numero: buscar.numero,
    rateio,
    raw: upd.raw
  };
}

module.exports = {
  buscarPedidoPorOrderId,
  obterPedidoCompleto,
  calcularRateio,
  montarBodyPUT,
  atualizarPedido,
  editarPedidoComGraos,
  truncarDecimais
};
