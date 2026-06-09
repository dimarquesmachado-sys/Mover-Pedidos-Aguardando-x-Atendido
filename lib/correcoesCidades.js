'use strict';

// ──────────────────────────────────────────────────────────────────────
// Mapa COMPARTILHADO de correções manuais de cidade
//
// Usado por TODAS as empresas (Girassol, AMBTotal, GOOD Import) que
// rodam Corrigir-NFs. Adicionar uma cidade/CEP aqui beneficia
// automaticamente as 3 empresas.
//
// Há DOIS mapas:
//
// 1) CORRECOES_CIDADE — corrige por NOME (quando ViaCEP retorna nome
//    que a SEFAZ não aceita, geralmente distritos ou variações de
//    acentuação).
//
// 2) FALLBACK_POR_CEP — usado QUANDO o ViaCEP falha completamente
//    (CEP não cadastrado, ViaCEP fora do ar, etc). Mapeia CEP direto
//    para município/UF oficial IBGE.
//
// Como adicionar:
//
//   Caso 1 (ViaCEP retorna nome errado):
//   - Identifica nome ERRADO retornado pelo ViaCEP + UF
//   - Identifica nome CORRETO oficial IBGE
//   - Adiciona em CORRECOES_CIDADE com variações de acento
//
//   Caso 2 (ViaCEP retorna erro / não acha o CEP):
//   - Pega o CEP (8 dígitos, sem traço)
//   - Identifica município e UF corretos (oficial IBGE)
//   - Adiciona em FALLBACK_POR_CEP
//
// Commit → Render redeploya → próximo ciclo de Corrigir-NFs já usa.
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
  'embu guaçu|SP':        { municipio: 'Embu-Guaçu', uf: 'SP' },
  // Distritos que ViaCEP às vezes retorna como município:
  'ibiajara|ba':                { municipio: 'Rio do Pires', uf: 'BA' },
  'itaipava|es':                { municipio: 'Itapemirim', uf: 'ES' },
  'massangano|pe':              { municipio: 'Petrolina', uf: 'PE' },
};

// Fallback pra CEPs onde o ViaCEP retorna erro/null (distritos pequenos,
// CEPs únicos, etc). Use CEP em 8 dígitos sem traço.
const FALLBACK_POR_CEP = {
  '46560000': { municipio: 'Rio do Pires', uf: 'BA' },  // Ibiajara (distrito)
  '29338000': { municipio: 'Itapemirim', uf: 'ES' },    // Itaipava (distrito)
  '56353700': { municipio: 'Petrolina', uf: 'PE' },     // Massangano (distrito)
};

/**
 * Aplica correção de cidade se houver no mapa de nomes.
 *
 * @param {string} municipio - Nome da cidade retornado pelo ViaCEP
 * @param {string} uf        - UF retornada pelo ViaCEP
 * @returns {{municipio:string, uf:string}} - Versão corrigida (ou original)
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

/**
 * Fallback por CEP quando ViaCEP falha.
 *
 * @param {string} cep - CEP em qualquer formato (será limpo)
 * @returns {{municipio:string, uf:string}|null} - Cidade conhecida ou null se não há fallback
 */
function fallbackPorCEP(cep) {
  const cepLimpo = String(cep || '').replace(/\D/g, '');
  if (cepLimpo.length !== 8) return null;
  if (FALLBACK_POR_CEP[cepLimpo]) {
    console.log(`[correcoesCidades] Fallback CEP=${cepLimpo} -> ${JSON.stringify(FALLBACK_POR_CEP[cepLimpo])}`);
    return FALLBACK_POR_CEP[cepLimpo];
  }
  return null;
}

module.exports = { CORRECOES_CIDADE, FALLBACK_POR_CEP, aplicarCorrecaoCidade, fallbackPorCEP };
