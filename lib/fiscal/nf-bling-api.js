'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CLIENTE DA API DE NF DO BLING — código único das empresas (13/09/2026).

   Passo 2.2 do plano multiloja. A classificação das diferenças (a receita manda
   fazer isso ANTES de extrair) mostrou o que separava as três cópias de 340 linhas:

     • 54 a 58 linhas de RÓTULO — o prefixo do log e o nome dentro da mensagem de
       erro ("API Bling NF AMB (...)"). Nada de comportamento.
     • 8 linhas de PREFIXO DE ENV (AMB_/GOOD_/GIRASSOL_).
     • 2 valores de CONFIGURAÇÃO real: o nome do intermediador na NF-e (AMBTOTAL,
       GIMPO...) e a pasta do cache de IE, que precisa ser separada por empresa —
       misturar cache de Inscrição Estadual entre CNPJs seria erro fiscal, não de
       organização.

   Nenhuma regra de negócio divergia. As três exportam o mesmo conjunto de dez
   funções, conferido antes de mover.
   ──────────────────────────────────────────────────────────────────────────── */

function criarNfBlingApi(cfg) {
  for (const nome of ['rotulo', 'nfTokenManager', 'envPausa', 'intermediadorCnpj', 'intermediadorNome', 'pastaCacheIE']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/nf-bling-api: falta ' + nome);
  }
  const { rotulo } = cfg;

  // ──────────────────────────────────────────────────────────────────────
  // API Bling NF da AMBTotal (Corrigir-NFs)
  // ──────────────────────────────────────────────────────────────────────

  const fetch = require('node-fetch');
  const _porteiro = require('./porteiro-fiscal').criarPorteiroFiscal(rotulo);   // 13/10: vez no porteiro (operacao)
  const { aplicarCorrecaoCidade, fallbackPorCEP } = require('../correcoesCidades')  /* 13/09: o arquivo saiu de <empresa>/ pra lib/fiscal/, então o caminho relativo encurtou — o boot pegou na hora */;
  const _cepResolver = require('../cepResolver');

  const BLING_API = 'https://api.bling.com.br/Api/v3';
  const PAUSA_MS = parseInt(process.env[cfg.envPausa] || '700');
  const SINTEGRA_TOKEN = process.env.SINTEGRA_TOKEN || '';
  const NF_INTERMEDIADOR_CNPJ = process.env[cfg.envIntermediadorCnpj] || cfg.intermediadorCnpj;
  const NF_INTERMEDIADOR_NOME = process.env[cfg.envIntermediadorNome] || cfg.intermediadorNome;
  // Janela de dias pra trás na busca de NFs a corrigir (padrão 7 dias)
  const NF_JANELA_DIAS = parseInt(process.env.NF_JANELA_DIAS || '7');

  // ── Cache de IE em disco (evita queimar créditos do SintegraWS/CNPJá) ──
  // PROBLEMA que isto resolve: o cron de corrigir-NFs roda a cada 5 min; sem
  // cache, cada ciclo re-consulta a IE do mesmo CNPJ. Uma NF de PJ presa por
  // 1 dia gerava ~288 consultas. Em 1-2/jun isso queimou todos os créditos.
  // Agora: consulta 1x, guarda em disco (inclusive resultado NEGATIVO), e nos
  // próximos ciclos lê do cache. TTL configurável (padrão 7 dias).
  const fs = require('fs');
  const path = require('path');
  const IE_CACHE_TTL_MS = parseInt(process.env.IE_CACHE_TTL_DIAS || '7') * 24 * 60 * 60 * 1000;
  // Resultado NEGATIVO (sem IE) expira mais rápido: empresa nova pode ganhar IE
  // nas bases a qualquer momento (caso Ronin). 24h ainda corta o loop (288/dia -> 1/dia).
  const IE_CACHE_NEG_TTL_MS = parseInt(process.env.IE_CACHE_NEG_HORAS || '24') * 60 * 60 * 1000;
  const IE_CACHE_DIR = process.env.IE_CACHE_DIR || cfg.pastaCacheIE;
  const IE_CACHE_FILE = path.join(IE_CACHE_DIR, 'ie-cache.json');

  function _carregarIECache() {
  try {
    if (fs.existsSync(IE_CACHE_FILE)) return JSON.parse(fs.readFileSync(IE_CACHE_FILE, 'utf8'));
  } catch (e) { console.error(`[${rotulo} nfBlingApi] Erro lendo ie-cache:`, e.message); }
  return {};
  }
  function _salvarIECache(cache) {
  try {
    if (!fs.existsSync(IE_CACHE_DIR)) fs.mkdirSync(IE_CACHE_DIR, { recursive: true });
    require('../escrita-atomica').gravarAtomico(IE_CACHE_FILE, JSON.stringify(cache));   /* 14/10 (6.7) */
  } catch (e) { console.error(`[${rotulo} nfBlingApi] Erro salvando ie-cache:`, e.message); }
  }

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
    const _ficha = await _porteiro.vez();   // 13/10
    let resp;
    try {
      resp = await fetch(url, options);
    } catch (e) {
      ultimoErro = e;
      console.error(`[${rotulo} nfBlingApi] Erro de rede em ${ctx} (tentativa ${t}/${tentativas}):`, e.message);
      if (t === tentativas) throw new Error(`API Bling NF ${rotulo} (${ctx}) erro de rede: ${e.message}`);
      await sleepNF(1000 * t);
      continue;
    }
    if (resp.status >= 200 && resp.status < 300) { _porteiro.ok(_ficha); return resp; }
    if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
    if (resp.status === 429) {
      _porteiro.aviso429(_ficha, resp);
      console.warn(`[${rotulo} nfBlingApi] HTTP 429 em ${ctx} (tentativa ${t}/${tentativas}) — aguardando`);
      if (t === tentativas) throw new Error(`API Bling NF ${rotulo} (${ctx}) HTTP 429 após ${tentativas} tentativas`);
      await sleepNF(2000 * t);
      continue;
    }
    const txt = await resp.text();
    console.error(`[${rotulo} nfBlingApi] HTTP ${resp.status} em ${ctx}:`, txt.slice(0, 300));
    if (t === tentativas) throw new Error(`API Bling NF ${rotulo} (${ctx}) HTTP ${resp.status}`);
    await sleepNF(1000 * t);
  }
  throw new Error(`API Bling NF ${rotulo} (${ctx}) falhou após ${tentativas} tentativas${ultimoErro ? ': ' + ultimoErro.message : ''}`);
  }

  /* 15/10 — CÓDIGOS DE SITUAÇÃO DA NOTA NO BLING (API v3): 1 pendente · 2 cancelada · 4 rejeitada ·
     5 AUTORIZADA · 9 denegada · 10 consulta situação. Este fluxo nasceu achando que 5 era "denegada" e
     2 "autorizada" — o próprio F3 (nfe-ml-fluxo) lista as AUTORIZADAS com situacao=5, e o caso real de
     15/10 confirmou: a série 2 emitida pelo ML voltou com situacao 5. Resultado: a cada 5 min o fluxo
     puxava até 100 notas AUTORIZADAS como candidatas a "correção". Agora: pendente, rejeitada e denegada. */
  // Janela configurável via NF_JANELA_DIAS (padrão 7 dias)
  /* 05/11 (auditoria do Codex no SHA 208fdb7d, achado F08): as duas buscas abaixo pediam SÓ a 1ª página (100 NFs) de
     cada situação e filtravam a data na mão. Com mais de 100 NFs numa situação (pendentes acumuladas, ou a lista vindo da
     mais antiga pra mais nova), as da página 2 em diante — justamente as recentes — nunca eram vistas: a correção não
     corrigia e o robô de consulta não consultava. Agora: o filtro de data vai NO PRÓPRIO BLING (dataEmissaoInicial/Final,
     como a busca das autorizadas do F3) e a busca percorre as páginas até vir uma incompleta, com teto (e aviso no log
     se bater no teto). O filtro de data local continua, por garantia. */
  const MAX_PAGINAS_NF_CORRIGIR = parseInt(process.env.NF_CORRIGIR_MAX_PAGINAS || '10');
  async function _listarNFsDaJanela(token, sit, ctx) {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const ini = new Date(hoje); ini.setDate(ini.getDate() - NF_JANELA_DIAS);
    const fmt = (d) => d.toISOString().split('T')[0];
    const dataLimite = new Date(Date.now() - NF_JANELA_DIAS * 24*60*60*1000);
    const todas = [];
    let truncado = true;
    for (let pag = 1; pag <= MAX_PAGINAS_NF_CORRIGIR; pag++) {
      const url = `${BLING_API}/nfe?situacao=${sit}&dataEmissaoInicial=${fmt(ini)}&dataEmissaoFinal=${fmt(hoje)}&limite=100&pagina=${pag}`;
      const resp = await fetchComRetryNF(url, { headers: { Authorization: `Bearer ${token}` } }, `${ctx} pag=${pag}`);
      const data = await resp.json();
      const lista = (data && data.data) || [];
      for (const nf of lista) {
        const dataEmissao = new Date(nf.dataEmissao || nf.data);
        if (!(dataEmissao < dataLimite)) todas.push(nf);   /* data inválida não descarta (o Bling já filtrou a janela) */
      }
      if (lista.length < 100) { truncado = false; break; }
    }
    if (truncado) console.warn(`[${rotulo} nfBlingApi] ${ctx}: parou no teto de ${MAX_PAGINAS_NF_CORRIGIR} páginas (${todas.length} NFs) -- pode haver NF da janela fora da busca (env NF_CORRIGIR_MAX_PAGINAS)`);
    return todas;
  }

  async function getNFsParaCorrigir(token) {
  const situacoes = [1, 4, 9];
  let todas = [];
  for (const sit of situacoes) {
    todas = todas.concat(await _listarNFsDaJanela(token, sit, `listar NFs situacao=${sit}`));
  }
  console.log(`[${rotulo} nfBlingApi] getNFsParaCorrigir: ${todas.length} NFs nos últimos ${NF_JANELA_DIAS}d`);
  return todas;
  }


  // Lista NFs em "Consultar situação" (situacao=10) na janela -- usada pelo robô local
  // que dispara a consulta de recibo na UI interna do Bling (getEnvelopeSituacao).
  async function getNFsSituacaoConsulta(token) {
  const recentes = await _listarNFsDaJanela(token, 10, 'listar NFs situacao=10 (Consulta situação)');
  console.log(`[${rotulo} nfBlingApi] getNFsSituacaoConsulta: ${recentes.length} NFs em Consulta situação (sit=10) nos últimos ${NF_JANELA_DIAS}d`);
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
  const resp = await _porteiro.chamar(() => fetch(url, {   // 13/10: vez no porteiro
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  }));
  if (resp.status >= 200 && resp.status < 300) {
    console.log(`[${rotulo} nfBlingApi] NF ${idNF} salva`);
    return;
  }
  if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
  const txt = await resp.text();
  console.error(`[${rotulo} nfBlingApi] HTTP ${resp.status} em salvar NF=${idNF}:`, txt.slice(0, 300));
  throw new Error(`API Bling NF ${rotulo} (salvar NF=${idNF}) HTTP ${resp.status}`);
  }

  async function enviarNF(token, idNF) {
  const url = `${BLING_API}/nfe/${idNF}/enviar`;
  const body = '{}';
  const resp = await _porteiro.chamar(() => fetch(url, {   // 13/10: vez no porteiro
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  }));
  if (resp.status >= 200 && resp.status < 300) {
    console.log(`[${rotulo} nfBlingApi] NF ${idNF} enviada para SEFAZ`);
    return;
  }
  if (resp.status === 401) throw Object.assign(new Error('TOKEN_EXPIRADO'), { code: 401 });
  const txt = await resp.text();
  console.error(`[${rotulo} nfBlingApi] HTTP ${resp.status} em enviar NF=${idNF}:`, txt.slice(0, 300));
  throw new Error(`API Bling NF ${rotulo} (enviar NF=${idNF}) HTTP ${resp.status}`);
  }

  /* 12/11 — o REENVIO com a resposta inteira (lib/fiscal/criar-modulo, rota /robo/nf-reenvio-teste). O `enviarNF` acima
     joga fora o que o Bling responde quando dá 2xx e lança nos outros; pro teste "o reenvio destrava uma nota em Consultar
     situação?" é a resposta que interessa. Devolve { status, corpo } e nunca lança por causa do status. Mesma vez no porteiro. */
  async function enviarNFCru(token, idNF) {
    const body = '{}';
    const resp = await _porteiro.chamar(() => fetch(`${BLING_API}/nfe/${idNF}/enviar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body
    }));
    let corpo = ''; try { corpo = await resp.text(); } catch (e) { corpo = ''; }
    console.log(`[${rotulo} nfBlingApi] reenvio (teste) da NF ${idNF}: HTTP ${resp.status}`);
    return { status: resp.status, corpo: String(corpo).slice(0, 2000) };
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
  console.log(`[${rotulo} nfBlingApi] Contato ${idContato} IE="${ie}" contribuinte=${contribuinte}`);
  }

  // CEP -> cidade: cascata resiliente (varias fontes em hosts diversos + timeout +
  // fallback manual), compartilhada em lib/cepResolver.js. Substitui a antiga
  // ViaCEP->BrasilAPI, que ficou cega no datacenter (ViaCEP EHOSTUNREACH, BrasilAPI
  // v2 "Premature close"). Para adicionar/remover fonte: editar lib/cepResolver.js.
  async function getCidadePorCEP(cep) {
  return _cepResolver.getCidadePorCEP(cep, `[${rotulo} nfBlingApi]`);
  }

  // ── IE: fonte 1 = SintegraWS (tempo real, depende da SEFAZ) ──────────
  async function _ieViaSintegra(cnpjLimpo, uf) {
  if (!SINTEGRA_TOKEN) {
    console.log(`[${rotulo} nfBlingApi] SINTEGRA_TOKEN não configurado — pulando SintegraWS`);
    return null;
  }
  try {
    const url = `https://www.sintegraws.com.br/api/v1/execute-api.php?token=${SINTEGRA_TOKEN}&cnpj=${cnpjLimpo}&plugin=ST`;
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[${rotulo} nfBlingApi] SintegraWS HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    console.log(`[${rotulo} nfBlingApi] SintegraWS CNPJ=${cnpjLimpo} UF=${uf}:`, JSON.stringify(data).slice(0, 200));
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
    console.error(`[${rotulo} nfBlingApi] Erro SintegraWS:`, e.message);
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
    if (!resp.ok) { console.log(`[${rotulo} nfBlingApi] CNPJá HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const regs = Array.isArray(data.registrations) ? data.registrations : [];
    if (regs.length === 0) {
      console.log(`[${rotulo} nfBlingApi] CNPJá CNPJ=${cnpjLimpo}: sem registrations (IE)`);
      return null;
    }
    // SÓ aceita IE da UF do destinatário — IE de outra UF gravada no
    // contato causaria rejeição SEFAZ ("IE não vinculada à UF"), pior que nada.
    const reg = regs.find(r => r.state === uf && r.enabled) ||
                regs.find(r => r.state === uf);
    if (!reg) {
      console.log(`[${rotulo} nfBlingApi] CNPJá CNPJ=${cnpjLimpo}: tem IE mas nenhuma na UF ${uf} — não usar`);
      return null;
    }
    if (!reg.number) {
      console.log(`[${rotulo} nfBlingApi] CNPJá CNPJ=${cnpjLimpo} UF=${uf}: registration sem number`);
      return null;
    }
    const ieLimpa = String(reg.number).replace(/\D/g, '');
    console.log(`[${rotulo} nfBlingApi] CNPJá CNPJ=${cnpjLimpo} UF=${uf} -> IE=${ieLimpa} (state=${reg.state} enabled=${reg.enabled})`);
    if (!ieLimpa) return null;
    return { ie: ieLimpa, contribuinte: 1 };
  } catch (e) {
    console.error(`[${rotulo} nfBlingApi] Erro CNPJá:`, e.message);
    return null;
  }
  }

  // Cascata de IE: CNPJá (grátis, base cacheada ~45d) -> SintegraWS (PAGO,
  // tempo real via SEFAZ). Grátis primeiro pra economizar créditos; o Sintegra
  // é o último recurso (e também falha quando a SEFAZ do estado está fora).
  async function getIEPorCNPJ(cnpj, uf) {
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  if (cnpjLimpo.length !== 14) return null;

  const chave = `${cnpjLimpo}|${uf}`;
  const cache = _carregarIECache();
  const hit = cache[chave];
  const ttl = (hit && hit.resultado) ? IE_CACHE_TTL_MS : IE_CACHE_NEG_TTL_MS;
  if (hit && (Date.now() - hit.ts) < ttl) {
    // resultado pode ser objeto {ie,...} ou null (negativo cacheado)
    if (hit.resultado) {
      console.log(`[${rotulo} nfBlingApi] IE do cache: ${chave} -> ${hit.resultado.ie}`);
    } else {
      console.log(`[${rotulo} nfBlingApi] IE do cache: ${chave} -> sem IE (negativo, não reconsulta)`);
    }
    return hit.resultado;
  }

  // Não está no cache (ou expirou): consulta a cascata
  // ORDEM: CNPJá primeiro (GRÁTIS, base cacheada) -> SintegraWS por último (PAGO,
  // tempo real). O Sintegra só é acionado quando a CNPJá não tem a IE da UF.
  let resultado = await _ieViaCNPJa(cnpjLimpo, uf);
  if (!resultado) {
    console.log(`[${rotulo} nfBlingApi] IE não veio da CNPJá — tentando SintegraWS [PAGO] (CNPJ=${cnpjLimpo})`);
    resultado = await _ieViaSintegra(cnpjLimpo, uf);
  }

  // Grava no cache (inclusive negativo, pra não re-consultar e queimar crédito)
  cache[chave] = { ts: Date.now(), resultado: resultado || null };
  _salvarIECache(cache);

  return resultado || null;
  }

  /* 25/10: o intermediador desta empresa (o MESMO que vai na NF) — o importador do ML usa este, nunca um padrão de outra */
  const intermediador = () => ({ cnpj: NF_INTERMEDIADOR_CNPJ, nome: NF_INTERMEDIADOR_NOME });
  return {
    intermediador,
  sleepNF,
  getNFsParaCorrigir, getNFsSituacaoConsulta, getNFDetalhe, salvarNF, enviarNF, enviarNFCru,
  getContato, atualizarIEContato,
  getCidadePorCEP, getIEPorCNPJ
  };

}

module.exports = { criarNfBlingApi };
