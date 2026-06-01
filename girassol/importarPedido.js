'use strict';
// ──────────────────────────────────────────────────────────────────────
// TESTE — importar pedido do ML criando o pedido de venda via API v3.
//
// Objetivo do teste: descobrir se CRIAR o pedido com `numeroLoja` faz o
// Bling marcar o pedido como "Já importado" no staging (sem duplicar).
//
// Rota (sem prefixo, padrão Girassol):
//   GET /debug/teste-importar/:numeroML              → DRY-RUN (só mostra, NÃO cria)
//   GET /debug/teste-importar/:numeroML?confirmar=1  → cria de verdade
//
// Em DRY-RUN: faz só LEITURAS (ML + busca produto/contato no Bling) e
// devolve o payload que SERIA enviado. Não grava nada.
// Com confirmar=1: cria contato (se não existir) e cria o pedido.
// ──────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const { garantirToken }   = require('./tokenManager');
const { garantirTokenML } = require('./mlTokenManager');

const BLING_API = 'https://api.bling.com.br/Api/v3';
const ML_API    = 'https://api.mercadolibre.com';

const LOJA_ID            = parseInt((process.env.ME_LOJA_IDS || '203146903').split(',')[0]);
const INTERMEDIADOR_CNPJ = process.env.NF_INTERMEDIADOR_CNPJ || '03007331000141';
const INTERMEDIADOR_NOME = process.env.NF_INTERMEDIADOR_NOME || 'MAGAZINEGIRASSOL';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── helpers de fetch ──────────────────────────────────────────────────
async function mlGet(mlToken, path, extraHeaders = {}) {
  const resp = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${mlToken}`, ...extraHeaders }
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function blingGet(token, path) {
  const resp = await fetch(`${BLING_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// ── ML: order (+ pack) ────────────────────────────────────────────────
async function buscarOrder(mlToken, numeroML) {
  const { status, data } = await mlGet(mlToken, `/orders/${numeroML}`);
  if (status !== 200) {
    throw new Error(`ML /orders/${numeroML} HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// Junta os itens de todas as orders do pack (se for pack)
async function coletarItensML(mlToken, order) {
  const orders = [order];
  if (order.pack_id) {
    const { status, data } = await mlGet(mlToken, `/packs/${order.pack_id}`);
    if (status === 200 && Array.isArray(data.orders)) {
      const outros = data.orders
        .map(o => String(o.id))
        .filter(id => id && id !== String(order.id));
      for (const id of outros) {
        try { orders.push(await buscarOrder(mlToken, id)); } catch (e) { /* ignora */ }
        await sleep(300);
      }
    }
  }
  const itens = [];
  for (const o of orders) {
    for (const oi of (o.order_items || [])) {
      itens.push({
        sku:        oi.item?.seller_sku || oi.item?.seller_custom_field || null,
        mlb:        oi.item?.id || null,
        titulo:     oi.item?.title || '',
        quantidade: oi.quantity || 1,
        valor:      oi.unit_price || 0
      });
    }
  }
  return { itens, ordersIds: orders.map(o => String(o.id)), ehPack: !!order.pack_id };
}

// ── ML: cobrança (nome + CPF) ─────────────────────────────────────────
async function buscarBilling(mlToken, numeroML) {
  const { status, data } = await mlGet(mlToken, `/orders/${numeroML}/billing_info`, { 'x-version': '2' });
  if (status !== 200) return { cpf: null, nome: null, raw: { status, data } };
  const bi = data?.buyer?.billing_info || data?.billing_info || data || {};
  const ids = bi.identification || bi.doc || {};
  const cpf = (bi.doc_number || ids.number || '').toString().replace(/\D/g, '') || null;
  const nome = [bi.first_name || bi.name, bi.last_name].filter(Boolean).join(' ').trim() || null;
  return { cpf, nome, raw: bi };
}

// ── ML: endereço de entrega (do shipment) ─────────────────────────────
async function buscarEndereco(mlToken, shipmentId) {
  if (!shipmentId) return null;
  const { status, data } = await mlGet(mlToken, `/shipments/${shipmentId}`, { 'x-format-new': 'true' });
  if (status !== 200) return null;
  const r = data?.receiver_address || {};
  return {
    nome:        data?.receiver_name || r.receiver_name || '',
    endereco:    r.street_name || r.address_line || '',
    numero:      r.street_number || r.number || 'SN',
    complemento: r.comment || '',
    bairro:      r.neighborhood?.name || r.neighborhood || '',
    municipio:   r.city?.name || r.city || '',
    uf:          r.state?.id?.replace?.('BR-', '') || r.state?.name || '',
    cep:         (r.zip_code || '').toString().replace(/\D/g, '')
  };
}

// ── Bling: produto por SKU ────────────────────────────────────────────
async function buscarProdutoPorSku(token, sku) {
  if (!sku) return null;
  const { status, data } = await blingGet(token, `/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
  if (status !== 200) return null;
  const p = (data.data || [])[0];
  return p ? { id: p.id, unidade: p.unidade || 'UN', nome: p.nome } : null;
}

// ── Bling: achar contato (read) ───────────────────────────────────────
async function acharContato(token, cpf, nome) {
  const termo = cpf || nome;
  if (!termo) return null;
  const { status, data } = await blingGet(token, `/contatos?pesquisa=${encodeURIComponent(termo)}&limite=1`);
  if (status !== 200) return null;
  const c = (data.data || [])[0];
  return c ? { id: c.id, nome: c.nome } : null;
}

// ── Bling: criar contato (write) ──────────────────────────────────────
async function criarContato(token, { nome, cpf }) {
  const payload = { nome: nome || 'Cliente Mercado Livre', tipo: 'F' };
  if (cpf) payload.numeroDocumento = cpf;
  const resp = await fetch(`${BLING_API}/contatos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Bling criar contato HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }
  return { id: data?.data?.id, criado: true };
}

// ── Bling: criar pedido (write) ───────────────────────────────────────
async function criarPedido(token, payload) {
  const resp = await fetch(`${BLING_API}/pedidos/vendas`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Bling POST /pedidos/vendas HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data?.data || data;
}

// ── Fluxo principal ───────────────────────────────────────────────────
async function testarImportarPedido(numeroML, confirmar = false) {
  const log = [];
  const blingToken = await garantirToken();
  const mlToken    = await garantirTokenML();

  // 1) ML: order + itens (trata pack) + cobrança + endereço
  const order = await buscarOrder(mlToken, numeroML);
  const { itens: itensML, ordersIds, ehPack } = await coletarItensML(mlToken, order);
  log.push(`ML order ${numeroML} | pack=${ehPack} | orders=${ordersIds.join(',')} | itens=${itensML.length}`);

  const billing  = await buscarBilling(mlToken, numeroML);
  const shipId   = order?.shipping?.id || null;
  const endereco = await buscarEndereco(mlToken, shipId);
  const nomeCliente = billing.nome || endereco?.nome || order?.buyer?.nickname || 'Cliente Mercado Livre';

  // 2) Bling: mapeia cada item por SKU → produto.id (free-text se não achar)
  const itensBling = [];
  const mapeamento = [];
  for (const it of itensML) {
    const prod = await buscarProdutoPorSku(blingToken, it.sku);
    if (prod) {
      itensBling.push({
        codigo: it.sku, descricao: it.titulo, unidade: prod.unidade,
        quantidade: it.quantidade, valor: it.valor, produto: { id: prod.id }
      });
      mapeamento.push({ sku: it.sku, mlb: it.mlb, produtoId: prod.id, ok: true });
    } else {
      itensBling.push({
        descricao: it.titulo || `Item ML ${it.mlb || ''}`, unidade: 'UN',
        quantidade: it.quantidade, valor: it.valor
      });
      mapeamento.push({ sku: it.sku, mlb: it.mlb, produtoId: null, ok: false });
    }
  }

  // 3) contato — só LÊ no dry-run; cria no confirmar
  let contato = await acharContato(blingToken, billing.cpf, nomeCliente);
  let contatoStatus;
  if (contato) {
    contatoStatus = `encontrado id=${contato.id} (${contato.nome})`;
  } else if (confirmar) {
    contato = await criarContato(blingToken, { nome: nomeCliente, cpf: billing.cpf });
    contatoStatus = `CRIADO id=${contato.id}`;
  } else {
    contatoStatus = `NÃO existe — seria criado: { nome:"${nomeCliente}", cpf:"${billing.cpf || '—'}" }`;
  }

  // 4) monta o payload do pedido
  const dataPedido = (order.date_created || new Date().toISOString()).split('T')[0];
  const payload = {
    numeroLoja: String(numeroML),
    data: dataPedido,
    loja: { id: LOJA_ID },
    contato: contato ? { id: contato.id } : undefined,
    itens: itensBling,
    intermediador: { cnpj: INTERMEDIADOR_CNPJ, nomeUsuario: INTERMEDIADOR_NOME },
    observacoes: `[TESTE API] Nº Pedido na Loja: ${numeroML}` + (ehPack ? ` | pack: ${ordersIds.join(',')}` : '')
  };
  if (endereco) {
    payload.transporte = {
      fretePorConta: 0, frete: 0,
      etiqueta: {
        nome: endereco.nome || nomeCliente, endereco: endereco.endereco,
        numero: endereco.numero, complemento: endereco.complemento,
        bairro: endereco.bairro, municipio: endereco.municipio,
        uf: endereco.uf, cep: endereco.cep
      }
    };
  }

  // 5) DRY-RUN x criar
  if (!confirmar) {
    return {
      modo: 'DRY-RUN (nada foi gravado)',
      numeroML, ehPack, ordersIds,
      contato: contatoStatus,
      mapeamentoItens: mapeamento,
      cobrancaML: { nome: billing.nome, cpf: billing.cpf },
      payloadQueSeriaEnviado: payload,
      log,
      proximo: `Se o mapeamento estiver certo, rode com ?confirmar=1 para criar`
    };
  }

  if (!payload.contato) throw new Error('Sem contato.id — não dá pra criar o pedido');
  const criado = await criarPedido(blingToken, payload);
  return {
    modo: 'CRIADO',
    numeroML,
    pedidoCriado: { id: criado.id, numero: criado.numero, numeroLoja: criado.numeroLoja },
    contato: contatoStatus,
    mapeamentoItens: mapeamento,
    log,
    proximo: `Agora abra o vendas.lojas.virtuais.php e veja se o pedido ${numeroML} virou "Já importado" ou continuou idImportado=0`
  };
}

module.exports = { testarImportarPedido };
