'use strict';

/**
 * blingProdutos.js — Consulta produtos no Bling para o módulo /lixas-combinar
 *
 * Funções principais:
 *   buscarProdutoPorCodigo(codigo)  → retorna o produto que tem aquele SKU
 *   buscarVariacoesDoPai(idPai)     → lista variações filhas com estoque
 *   listarGraosDisponiveisDoPai(codigoPai) → função de alto nível usada pelo serviço
 */

const tokenMgr = require('./tokenManager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

// Pausa entre chamadas (rate limit Bling ~3 req/s por app)
const PAUSA_MS = Number(process.env.LIXAS_BLING_PAUSA_MS || 350);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helpers ──────────────────────────────────────────────────────────

async function blingGet(path) {
  const url = `${BLING_BASE}${path}`;
  const r = await tokenMgr.fetchComRetry(url, { method: 'GET' });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { _raw: txt }; }
  if (!r.ok) {
    throw new Error(`Bling GET ${path} ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// ── Buscas ───────────────────────────────────────────────────────────

/**
 * Busca produto pelo código SKU. Retorna o primeiro match ou null.
 * Endpoint Bling: GET /produtos?codigo={sku}
 */
async function buscarProdutoPorCodigo(codigo) {
  const data = await blingGet(`/produtos?codigo=${encodeURIComponent(codigo)}`);
  const produtos = data?.data || [];
  if (produtos.length === 0) return null;
  // Bling pode retornar vários se o código for parcial — pegar o que bate exato
  const exato = produtos.find(p => (p.codigo || '').toUpperCase() === codigo.toUpperCase());
  return exato || produtos[0];
}

/**
 * Busca detalhes de um produto pelo ID (inclui variações se houver).
 * Endpoint Bling: GET /produtos/{id}
 */
async function buscarProdutoPorId(id) {
  const data = await blingGet(`/produtos/${id}`);
  return data?.data || null;
}

/**
 * Dado um código de produto PAI (ex: "10-lisa-125mm-PAI-X"),
 * retorna a lista de variações filhas COM ESTOQUE.
 *
 * Cada item retornado:
 *   {
 *     id: 16383404639,
 *     codigo: "10-lisa-125mm-24",
 *     nome: "GRÃO:g24",
 *     grao: "24",
 *     estoque: 873,
 *     ean: "7908840119889"
 *   }
 */
async function listarVariacoesComEstoque(codigoPai) {
  // 1. Busca o produto pai
  const pai = await buscarProdutoPorCodigo(codigoPai);
  if (!pai) {
    return { erro: `Produto pai "${codigoPai}" não encontrado no Bling`, variacoes: [] };
  }

  await sleep(PAUSA_MS);

  // 2. Busca os detalhes completos (incluindo variações)
  const detalhe = await buscarProdutoPorId(pai.id);

  // Variações podem vir em detalhe.variacoes ou similar
  const variacoes = detalhe?.variacoes || [];

  if (variacoes.length === 0) {
    return {
      erro: 'Produto pai não tem variacoes (verificar se o ID está correto)',
      pai_id: pai.id,
      pai_codigo: pai.codigo,
      variacoes: []
    };
  }

  // 3. Para cada variação, precisa do estoque atual. Bling pode retornar inline ou em rota separada.
  //    Tentaremos primeiro inline (campo "estoque"). Se vier vazio, fazemos GET no produto da variação.
  const lista = [];
  for (const v of variacoes) {
    // Tentar pegar dados inline primeiro
    let estoque = v.estoque?.saldoVirtualTotal ?? v.estoque?.saldoFisicoTotal ?? null;
    let ean = v.gtin || null;
    let nome = v.nome || v.variacao?.nome || '';
    let codigoV = v.codigo || '';

    // Se faltou estoque inline, busca detalhes da variação por ID
    if (estoque === null && v.id) {
      try {
        await sleep(PAUSA_MS);
        const det = await buscarProdutoPorId(v.id);
        estoque = det?.estoque?.saldoVirtualTotal ?? det?.estoque?.saldoFisicoTotal ?? 0;
        ean = ean || det?.gtin || null;
        codigoV = codigoV || det?.codigo || '';
        nome = nome || det?.nome || '';
      } catch (e) {
        console.error(`[lixas-combinar blingProdutos] Erro detalhe variacao ${v.id}: ${e.message}`);
        estoque = 0;
      }
    }

    // Extrai o grão do nome da variação (ex: "GRÃO:g24" → "24")
    const grao = extrairGrao(nome) || extrairGrao(codigoV);

    lista.push({
      id: v.id,
      codigo: codigoV,
      nome,
      grao,
      estoque: Number(estoque) || 0,
      ean
    });
  }

  // 4. Filtra com estoque > 0 e ordena por grão (numérico)
  const comEstoque = lista
    .filter(v => v.estoque > 0)
    .sort((a, b) => {
      const ga = parseInt(a.grao, 10) || 99999;
      const gb = parseInt(b.grao, 10) || 99999;
      return ga - gb;
    });

  return {
    pai_id: pai.id,
    pai_codigo: pai.codigo,
    pai_nome: pai.nome,
    total_variacoes: variacoes.length,
    com_estoque: comEstoque.length,
    variacoes: comEstoque,
    todas: lista
  };
}

/**
 * Extrai o número do grão de uma string.
 * Exemplos: "GRÃO:g24" → "24"
 *           "10-lisa-125mm-24" → "24"
 *           "GRÃO:g1500" → "1500"
 */
function extrairGrao(str) {
  if (!str) return null;
  // Tenta pegar o último número da string
  const matches = String(str).match(/(\d+)/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

module.exports = {
  buscarProdutoPorCodigo,
  buscarProdutoPorId,
  listarVariacoesComEstoque
};
