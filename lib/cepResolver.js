'use strict';

// ──────────────────────────────────────────────────────────────────────
// Resolvedor de CIDADE por CEP — cascata resiliente, COMPARTILHADA.
//
// Usado por Girassol, AMBTotal e GOOD (corrigir-NFs). Substitui a antiga
// cascata "ViaCEP -> BrasilAPI" que ficou cega no datacenter do Render:
//   - ViaCEP  -> connect EHOSTUNREACH  (host bloqueado por IP)
//   - BrasilAPI v2 -> "Premature close" (conexao cortada/throttle)
//
// Estrategia:
//   1. Varias fontes em HOSTS DIFERENTES (se um host esta bloqueado/cortando,
//      outro responde). Tenta uma a uma ate alguma retornar municipio+uf.
//   2. TIMEOUT por fonte (AbortController) — nenhuma fonte trava a fila.
//   3. "Fonte vencedora primeiro": memoriza a ultima fonte que funcionou e
//      comeca por ela nas proximas chamadas (a maioria resolve em 1 fetch).
//   4. Se TODAS falham, cai no mapa manual FALLBACK_POR_CEP (correcoesCidades).
//   5. Aplica as correcoes de NOME (aplicarCorrecaoCidade) no fim.
//
// Contrato (igual ao antigo): getCidadePorCEP(cep) -> { municipio, uf } | null
// ──────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const { aplicarCorrecaoCidade, fallbackPorCEP } = require('./correcoesCidades');

// Fontes em ordem inicial. Hosts diferentes primeiro (BrasilAPI e ViaCEP, que
// estao com problema no datacenter, ficam por ultimo). Cada parse devolve
// { municipio, uf } ou null.
const FONTES = [
  {
    nome: 'opencep',
    url: (cep) => `https://opencep.com/v1/${cep}`,
    parse: (d) => (d && d.localidade && d.uf) ? { municipio: d.localidade, uf: d.uf } : null,
  },
  {
    nome: 'awesomeapi',
    url: (cep) => `https://cep.awesomeapi.com.br/json/${cep}`,
    parse: (d) => (d && d.city && d.state) ? { municipio: d.city, uf: d.state } : null,
  },
  {
    nome: 'postmon',
    url: (cep) => `https://api.postmon.com.br/v1/cep/${cep}`,
    parse: (d) => (d && d.cidade && d.estado) ? { municipio: d.cidade, uf: d.estado } : null,
  },
  {
    nome: 'brasilapi-v1',
    url: (cep) => `https://brasilapi.com.br/api/cep/v1/${cep}`,
    parse: (d) => (d && d.city && d.state) ? { municipio: d.city, uf: d.state } : null,
  },
  {
    nome: 'brasilapi-v2',
    url: (cep) => `https://brasilapi.com.br/api/cep/v2/${cep}`,
    parse: (d) => (d && d.city && d.state) ? { municipio: d.city, uf: d.state } : null,
  },
  {
    nome: 'viacep',
    url: (cep) => `https://viacep.com.br/ws/${cep}/json/`,
    parse: (d) => (d && !d.erro && d.localidade && d.uf) ? { municipio: d.localidade, uf: d.uf } : null,
  },
];

// Indice da ultima fonte que funcionou (acelera as proximas chamadas).
let _fonteVencedora = null;

// fetch com timeout (AbortController). Node >=18 tem AbortController global.
async function _fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mover-Pedidos/1.0 (+corrigir-nfs)' },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a cidade oficial a partir do CEP, tentando varias fontes ate uma
 * responder. Retorna { municipio, uf } (com correcoes de nome aplicadas) ou null.
 *
 * @param {string} cep        CEP em qualquer formato (sera limpo p/ 8 digitos)
 * @param {string} logPrefix  prefixo de log da empresa (ex.: '[GOOD nfBlingApi]')
 */
async function getCidadePorCEP(cep, logPrefix = '[cepResolver]') {
  const cepLimpo = String(cep || '').replace(/\D/g, '');
  if (cepLimpo.length !== 8) return null;

  const TIMEOUT = Number(process.env.CEP_TIMEOUT_MS || 4000);

  // monta a ordem: fonte vencedora primeiro, depois as demais
  const ordem = [];
  if (_fonteVencedora != null && FONTES[_fonteVencedora]) ordem.push(_fonteVencedora);
  for (let i = 0; i < FONTES.length; i++) if (i !== _fonteVencedora) ordem.push(i);

  const tentadas = [];
  for (const idx of ordem) {
    const fonte = FONTES[idx];
    try {
      const data = await _fetchJson(fonte.url(cepLimpo), TIMEOUT);
      const r = data ? fonte.parse(data) : null;
      if (r && r.municipio && r.uf) {
        if (_fonteVencedora !== idx) {
          _fonteVencedora = idx; // memoriza p/ comecar por aqui da proxima vez
          console.log(`${logPrefix} fonte de CEP ativa: ${fonte.nome}`);
        }
        console.log(`${logPrefix} CEP=${cepLimpo} -> ${r.municipio}/${r.uf} (via ${fonte.nome})`);
        return aplicarCorrecaoCidade(r.municipio, r.uf);
      }
      tentadas.push(fonte.nome);
    } catch (e) {
      tentadas.push(`${fonte.nome}!`); // ! = erro/timeout
      // se a fonte vencedora falhou, esquece p/ revalidar na proxima
      if (idx === _fonteVencedora) _fonteVencedora = null;
    }
  }

  // todas as fontes falharam -> fallback manual por CEP
  const fb = fallbackPorCEP(cepLimpo);
  if (fb) {
    console.log(`${logPrefix} CEP=${cepLimpo} -> ${fb.municipio}/${fb.uf} (fallback manual)`);
    return fb;
  }
  console.warn(`${logPrefix} CEP=${cepLimpo} sem cidade — nenhuma fonte respondeu (${tentadas.join(', ')}) e sem fallback manual`);
  return null;
}

module.exports = { getCidadePorCEP, FONTES };
