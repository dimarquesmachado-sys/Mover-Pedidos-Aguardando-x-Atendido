'use strict';

// ──────────────────────────────────────────────────────────────────────
// Mapa COMPARTILHADO de correções manuais de cidade
//
// Usado por TODAS as empresas (Girassol, AMBTotal, GOOD Import) que
// rodam Corrigir-NFs. Adicionar uma cidade aqui beneficia automaticamente
// as 3 empresas.
//
// Quando usar: quando o ViaCEP retorna um nome que a SEFAZ não aceita
// (geralmente nomes de distritos no lugar do município oficial IBGE,
// ou variações de acentuação/apóstrofo).
//
// Formato:
//   "cidade|uf" em minúsculo  →  { municipio: 'NomeOficial', uf: 'XX' }
//
// Como adicionar uma cidade nova:
//   1. Identifica o nome ERRADO que o ViaCEP retorna + UF
//   2. Identifica o nome CORRETO oficial IBGE
//   3. Adiciona linha aqui (de preferência com variações de acento)
//   4. Faz commit → Render redeploya → próximo ciclo de Corrigir-NFs já usa
// ──────────────────────────────────────────────────────────────────────

const CORRECOES_CIDADE = {
  "sant'ana do livramento|rs":  { municipio: "Sant'Ana do Livramento", uf: 'RS' },
  'santana do livramento|rs':   { municipio: "Sant'Ana do Livramento", uf: 'RS' },
  "santa bárbara d'oeste|sp":   { municipio: "Santa Bárbara D'Oeste", uf: 'SP' },
  'santa bárbara d oeste|sp':   { municipio: "Santa Bárbara D'Oeste", uf: 'SP' },
  'santa barbara d oeste|sp':   { municipio: "Santa Bárbara D'Oeste", uf: 'SP' },
  'santa barbara doeste|sp':    { municipio: "Santa Bárbara D'Oeste", uf: 'SP' },
  'perpétuo socorro|mg':        { municipio: 'Belo Oriente', uf: 'MG' },
  'perpetuo socorro|mg':        { municipio: 'Belo Oriente', uf: 'MG' },
};

/**
 * Aplica correção de cidade se houver no mapa.
 *
 * @param {string} municipio - Nome da cidade retornado pelo ViaCEP
 * @param {string} uf        - UF retornada pelo ViaCEP
 * @returns {{municipio:string, uf:string}} - Versão corrigida (ou original se não houver mapeamento)
 */
function aplicarCorrecaoCidade(municipio, uf) {
  if (!municipio || !uf) return { municipio, uf };
  const chave = `${municipio}|${uf}`.toLowerCase();
  if (CORRECOES_CIDADE[chave]) {
    console.log(`[correcoesCidades] Correção: "${chave}" -> ${JSON.stringify(CORRECOES_CIDADE[chave])}`);
    return CORRECOES_CIDADE[chave];
  }
  return { municipio, uf };
}

module.exports = { CORRECOES_CIDADE, aplicarCorrecaoCidade };
