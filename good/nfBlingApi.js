'use strict';

// ──────────────────────────────────────────────────────────────────────
// API Bling NF da GOOD Import (Corrigir-NFs)
// ──────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const { aplicarCorrecaoCidade, fallbackPorCEP } = require('../lib/correcoesCidades');

const BLING_API = 'https://api.bling.com.br/Api/v3';
const PAUSA_MS = parseInt(process.env.GOOD_NF_PAUSA_MS || '700');
const SINTEGRA_TOKEN = process.env.SINTEGRA_TOKEN || '';
const NF_INTERMEDIADOR_CNPJ = process.env.GOOD_NF_INTERMEDIADOR_CNPJ || '03007331000141';
const NF_INTERMEDIADOR_NOME = process.env.GOOD_NF_INTERMEDIADOR_NOME || 'GIMPO';
// Janela de dias pra trás na busca de NFs a corrigir (padrão 7 dias)
const NF_JANELA_DIAS = parseInt(process.env.NF_JANELA_DIAS || '7');

let _ultimaReqNF = 0;
function sleepNF(ms) { return new Promise(r => setTimeout(r, ms)); }

async function esperarSlotNF(minMs) {
  const agora = Date.now();
  const espera = Math.max(0, _ultimaReqNF + minMs - agora);
  if (espera > 0) await sleepNF(espera);
  _ultimaReqNF = Date.now();
}

async function fetchComRetryNF(url, options, ctx, tentativas = 4) {
  let ultimoErro = null;
  for (let t = 1; t <= tentativas; t++) {
    await esperarSlotNF(options.method === 'GET' || !options.method ? 300 : PAUSA_MS);
    let resp;
    try {
      resp = await fetch(url, options);
    } catch (e) {
      ultimoErro = e;
      console.error(`[GOOD nfBlingApi] Erro de rede em ${ctx} (tentativa ${t}/${tentativas}):`, e.message);
      if (t === tentativas) throw new Error(`API Bling NF GOOD (${ctx}) erro de rede: ${e.message}`);
      await sleepNF(1000 * t);
      continue;
    }
    if (resp.status >= 200 && resp.status < 300) return resp;
    if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
    if (resp.status === 429) {
      console.warn(`[GOOD nfBlingApi] HTTP 429 em ${ctx} (tentativa ${t}/${tentativas}) — aguardando`);
      if (t === tentativas) throw new Error(`API Bling NF GOOD (${ctx}) HTTP 429 após ${tentativas} tentativas`);
      await sleepNF(2000 * t);
      continue;
    }
    const txt = await resp.text();
    console.error(`[GOOD nfBlingApi] HTTP ${resp.status} em ${ctx}:`, txt.slice(0, 300));
    if (t === tentativas) throw new Error(`API Bling NF GOOD (${ctx}) HTTP ${resp.status}`);
    await sleepNF(1000 * t);
  }
  throw new Error(`API Bling NF GOOD (${ctx}) falhou após ${tentativas} tentativas${ultimoErro ? ': ' + ultimoErro.message : ''}`);
}

// Listar NFs candidatas a corrigir (situacoes 1=pendente, 4=rejeitada, 5=denegada)
// Janela configurável via NF_JANELA_DIAS (padrão 7 dias)
async function getNFsParaCorrigir(token) {
  const situacoes = [1, 4, 5];
  const dataLimite = new Date(Date.now() - NF_JANELA_DIAS * 24*60*60*1000);
  let todas = [];
  for (const sit of situacoes) {
    const url = `${BLING_API}/nfe?situacao=${sit}&limite=100&pagina=1`;
    const resp = await fetchComRetryNF(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      `listar NFs situacao=${sit}`
    );
    const data = await resp.json();
    const recentes = (data.data || []).filter(nf => {
      const dataEmissao = new Date(nf.dataEmissao || nf.data);
      return dataEmissao >= dataLimite;
    });
    todas = todas.concat(recentes);
  }
  console.log(`[GOOD nfBlingApi] getNFsParaCorrigir: ${todas.length} NFs nos últimos ${NF_JANELA_DIAS}d`);
  return todas;
}


// Lista NFs em "Consultar situação" (situacao=0) na janela — usada pelo robô local
// que dispara a consulta de recibo na UI interna do Bling (getEnvelopeSituacao).
async function getNFsSituacaoConsulta(token) {
  const dataLimite = new Date(Date.now() - NF_JANELA_DIAS * 24*60*60*1000);
  const url = `${BLING_API}/nfe?situacao=0&limite=100&pagina=1`;
  const resp = await fetchComRetryNF(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    'listar NFs situacao=0'
  );
  const data = await resp.json();
  const recentes = (data.data || []).filter(nf => {
    const dataEmissao = new Date(nf.dataEmissao || nf.data);
    return dataEmissao >= dataLimite;
  });
  console.log(`[GOOD nfBlingApi] getNFsSituacaoConsulta: ${recentes.length} NFs sit=0 nos últimos ${NF_JANELA_DIAS}d`);
  return recentes;
}

async function getNFDetalhe(token, idNF) {
  const url = `${BLING_API}/nfe/${idNF}`;
  const resp = await fetchComRetryNF(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    `detalhe NF=${idNF}`
  );
  const data = await resp.json();
  return data.data || null;
}

async function salvarNF(token, idNF, detalhe) {
  const payload = {
    ...detalhe,
    intermediador: {
      cnpj: NF_INTERMEDIADOR_CNPJ,
      nomeUsuario: NF_INTERMEDIADOR_NOME
    },
    parcelas: []
  };
  const url = `${BLING_API}/nfe/${idNF}`;
  const body = JSON.stringify(payload);
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  if (resp.status >= 200 && resp.status < 300) {
    console.log(`[GOOD nfBlingApi] NF ${idNF} salva`);
    return;
  }
  if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
  const txt = await resp.text();
  console.error(`[GOOD nfBlingApi] HTTP ${resp.status} em salvar NF=${idNF}:`, txt.slice(0, 300));
  throw new Error(`API Bling NF GOOD (salvar NF=${idNF}) HTTP ${resp.status}`);
}

async function enviarNF(token, idNF) {
  const url = `${BLING_API}/nfe/${idNF}/enviar`;
  const body = '{}';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  if (resp.status >= 200 && resp.status < 300) {
    console.log(`[GOOD nfBlingApi] NF ${idNF} enviada para SEFAZ`);
    return;
  }
  if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
  const txt = await resp.text();
  console.error(`[GOOD nfBlingApi] HTTP ${resp.status} em enviar NF=${idNF}:`, txt.slice(0, 300));
  throw new Error(`API Bling NF GOOD (enviar NF=${idNF}) HTTP ${resp.status}`);
}

async function getContato(token, idContato) {
  const url = `${BLING_API}/contatos/${idContato}`;
  const resp = await fetchComRetryNF(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    `buscar contato=${idContato}`
  );
  const data = await resp.json();
  return data.data || null;
}

async function atualizarIEContato(token, idContato, contatoCompleto, ie, contribuinte) {
  const url = `${BLING_API}/contatos/${idContato}`;
  const payload = { ...contatoCompleto, ie, contribuinte };
  await fetchComRetryNF(
    url,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    },
    `atualizar IE contato=${idContato}`
  );
  console.log(`[GOOD nfBlingApi] Contato ${idContato} IE="${ie}" contribuinte=${contribuinte}`);
}

// Consulta BrasilAPI (2ª fonte) — retorna município oficial IBGE
async function getCidadeBrasilAPI(cepLimpo) {
  try {
    const resp = await fetch(`https://brasilapi.com.br/api/cep/v2/${cepLimpo}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const municipio = data.city || null;
    const uf = data.state || null;
    if (!municipio || !uf) return null;
    console.log(`[GOOD nfBlingApi] BrasilAPI CEP=${cepLimpo} -> ${municipio}/${uf}`);
    return aplicarCorrecaoCidade(municipio, uf);
  } catch (e) {
    console.error('[GOOD nfBlingApi] Erro BrasilAPI:', e.message);
    return null;
  }
}

// Retorna { municipio, uf } com correções aplicadas (usa mapa compartilhado)
// Ordem: ViaCEP -> BrasilAPI -> mapa manual FALLBACK_POR_CEP
async function getCidadePorCEP(cep) {
  const cepLimpo = String(cep).replace(/\D/g, '');
  if (cepLimpo.length !== 8) return null;
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
    if (!resp.ok) {
      return (await getCidadeBrasilAPI(cepLimpo)) || fallbackPorCEP(cepLimpo);
    }
    const data = await resp.json();
    if (data.erro) {
      return (await getCidadeBrasilAPI(cepLimpo)) || fallbackPorCEP(cepLimpo);
    }
    const municipio = data.localidade || null;
    const uf = data.uf || null;
    if (!municipio || !uf) {
      return (await getCidadeBrasilAPI(cepLimpo)) || fallbackPorCEP(cepLimpo);
    }
    return aplicarCorrecaoCidade(municipio, uf);
  } catch (e) {
    console.error('[GOOD nfBlingApi] Erro ao buscar CEP:', e.message);
    return (await getCidadeBrasilAPI(cepLimpo)) || fallbackPorCEP(cepLimpo);
  }
}

// ── IE: fonte 1 = SintegraWS (tempo real, depende da SEFAZ) ──────────
async function _ieViaSintegra(cnpjLimpo, uf) {
  if (!SINTEGRA_TOKEN) {
    console.log('[GOOD nfBlingApi] SINTEGRA_TOKEN não configurado — pulando SintegraWS');
    return null;
  }
  try {
    const url = `https://www.sintegraws.com.br/api/v1/execute-api.php?token=${SINTEGRA_TOKEN}&cnpj=${cnpjLimpo}&plugin=ST`;
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[GOOD nfBlingApi] SintegraWS HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    console.log(`[GOOD nfBlingApi] SintegraWS CNPJ=${cnpjLimpo} UF=${uf}:`, JSON.stringify(data).slice(0, 200));
    if (data && data.inscricoes_estaduais) {
      const ieEstado = data.inscricoes_estaduais.find(i => i.uf === uf);
      if (ieEstado && ieEstado.inscricao_estadual && ieEstado.inscricao_estadual !== 'ISENTO') {
        return { ie: ieEstado.inscricao_estadual, contribuinte: 1 };
      }
      if (ieEstado && ieEstado.inscricao_estadual === 'ISENTO') {
        return { ie: 'ISENTO', contribuinte: 2 };
      }
    }
    if (data && data.inscricao_estadual) {
      if (data.inscricao_estadual === 'ISENTO') return { ie: 'ISENTO', contribuinte: 2 };
      return { ie: data.inscricao_estadual, contribuinte: 1 };
    }
    return null;
  } catch (e) {
    console.error('[GOOD nfBlingApi] Erro SintegraWS:', e.message);
    return null;
  }
}

// ── IE: fonte 2 = CNPJá (base cacheada ~45d, NÃO depende da SEFAZ no ato) ──
// Endpoint público: https://open.cnpja.com/office/{cnpj}
// IE vem em registrations[]: { state: 'SP', number: '...', enabled: bool }
async function _ieViaCNPJa(cnpjLimpo, uf) {
  try {
    const resp = await fetch(`https://open.cnpja.com/office/${cnpjLimpo}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) { console.log(`[GOOD nfBlingApi] CNPJá HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const regs = Array.isArray(data.registrations) ? data.registrations : [];
    if (regs.length === 0) {
      console.log(`[GOOD nfBlingApi] CNPJá CNPJ=${cnpjLimpo}: sem registrations (IE)`);
      return null;
    }
    // Prioriza a IE da UF do destinatário; senão, primeira habilitada
    let reg = regs.find(r => r.state === uf && r.enabled) ||
              regs.find(r => r.state === uf) ||
              regs.find(r => r.enabled) ||
              regs[0];
    if (!reg || !reg.number) {
      console.log(`[GOOD nfBlingApi] CNPJá CNPJ=${cnpjLimpo} UF=${uf}: registration sem number`);
      return null;
    }
    const ieLimpa = String(reg.number).replace(/\D/g, '');
    console.log(`[GOOD nfBlingApi] CNPJá CNPJ=${cnpjLimpo} UF=${uf} -> IE=${ieLimpa} (state=${reg.state} enabled=${reg.enabled})`);
    if (!ieLimpa) return null;
    return { ie: ieLimpa, contribuinte: 1 };
  } catch (e) {
    console.error('[GOOD nfBlingApi] Erro CNPJá:', e.message);
    return null;
  }
}

// Cascata de IE: SintegraWS (tempo real) -> CNPJá (base cacheada).
// A CNPJá é o backup que salva quando a SEFAZ do estado está fora do ar
// (caso em que o SintegraWS falha por timeout).
async function getIEPorCNPJ(cnpj, uf) {
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  if (cnpjLimpo.length !== 14) return null;

  const viaSintegra = await _ieViaSintegra(cnpjLimpo, uf);
  if (viaSintegra) return viaSintegra;

  console.log(`[GOOD nfBlingApi] IE não veio do SintegraWS — tentando CNPJá (CNPJ=${cnpjLimpo})`);
  const viaCNPJa = await _ieViaCNPJa(cnpjLimpo, uf);
  if (viaCNPJa) return viaCNPJa;

  return null;
}

module.exports = {
  sleepNF,
  getNFsParaCorrigir, getNFsSituacaoConsulta, getNFDetalhe, salvarNF, enviarNF,
  getContato, atualizarIEContato,
  getCidadePorCEP, getIEPorCNPJ
};
