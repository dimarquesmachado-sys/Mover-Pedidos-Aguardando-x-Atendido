'use strict';

/**
 * lixasService.js — Lógica de alto nível do módulo /lixas-combinar
 *
 * Função principal:
 *   getGraosDisponiveisPorSkuACombinar(sku)
 *     → recebe SKU A COMBINAR (ex: "A-COMBINAR-100-lisa-125mm")
 *     → consulta catálogo JSON pra descobrir o pai de 10 lixas
 *     → consulta Bling pra ver quais variações têm estoque
 *     → retorna lista de grãos disponíveis
 */

const fs   = require('fs');
const path = require('path');
const blingProdutos = require('./blingProdutos');

const CATALOGO_PATH = path.join(__dirname, 'lixas-catalogo.json');

let _catalogoCache = null;
let _catalogoCacheTs = 0;
const CATALOGO_TTL_MS = 60 * 1000; // 1 min — pra mudanças no JSON refletirem rápido

function carregarCatalogo() {
  const agora = Date.now();
  if (_catalogoCache && (agora - _catalogoCacheTs) < CATALOGO_TTL_MS) {
    return _catalogoCache;
  }
  try {
    const raw = fs.readFileSync(CATALOGO_PATH, 'utf8');
    const json = JSON.parse(raw);
    _catalogoCache = json.catalogo || {};
    _catalogoCacheTs = agora;
    return _catalogoCache;
  } catch (e) {
    console.error('[lixas-combinar lixasService] Erro ao carregar catalogo:', e.message);
    return {};
  }
}

function listarCatalogo() {
  return carregarCatalogo();
}

/**
 * Função principal — dado um SKU A COMBINAR, devolve grãos disponíveis.
 */
async function getGraosDisponiveisPorSkuACombinar(sku) {
  if (!sku) {
    return { ok: false, erro: 'SKU não informado' };
  }

  const catalogo = carregarCatalogo();
  const entry = catalogo[sku];

  if (!entry) {
    return {
      ok: false,
      erro: `SKU "${sku}" não está cadastrado no catalogo lixas-combinar/lixas-catalogo.json`,
      skus_cadastrados: Object.keys(catalogo)
    };
  }

  if (!entry.ativo) {
    return { ok: false, erro: `SKU "${sku}" está marcado como inativo no catalogo` };
  }

  // Buscar variações no Bling
  let resultado;
  try {
    resultado = await blingProdutos.listarVariacoesComEstoque(entry.pai_10_lixas_codigo);
  } catch (e) {
    return { ok: false, erro: `Erro consultando Bling: ${e.message}`, sku, entry };
  }

  if (resultado.erro) {
    return { ok: false, erro: resultado.erro, sku, entry, detalhe: resultado };
  }

  // Monta resposta amigável
  const unidadesPorPacote = Number(entry.unidades_por_pacote) || 10;
  const graos = resultado.variacoes.map(v => ({
    grao: v.grao,
    estoque_pacotes: v.estoque,                       // cada pacote pode ter 1, 10 ou outro N lixas
    estoque_lixas: v.estoque * unidadesPorPacote,     // total de lixas disponíveis
    sku: v.codigo,
    id_bling: v.id,
    ean: v.ean
  }));

  return {
    ok: true,
    sku,
    descricao: entry.descricao,
    lixas_por_kit: entry.lixas_por_kit,
    unidades_por_pacote: unidadesPorPacote,
    pai_10_lixas: entry.pai_10_lixas_codigo,
    total_graos_disponiveis: graos.length,
    graos
  };
}

/**
 * Monta string compacta dos grãos disponíveis (pra usar em mensagem ML — limite 350 chars).
 * Ex: "24, 40, 60, 80, 100, 120, 150"
 */
function formatarGraosCompacto(graos) {
  if (!graos || graos.length === 0) return '(nenhum grão disponível no momento)';
  return graos.map(g => g.grao).join(', ');
}

module.exports = {
  getGraosDisponiveisPorSkuACombinar,
  listarCatalogo,
  formatarGraosCompacto
};
