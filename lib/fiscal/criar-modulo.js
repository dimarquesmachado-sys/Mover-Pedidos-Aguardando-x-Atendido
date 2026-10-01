'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FÁBRICA DE MÓDULO FISCAL — as três empresas (14/09/2026).

   Passo que a auditoria do Codex chama de P1: hoje uma loja nova precisa de pasta
   e `require` manual, então o registro sabe da empresa mas o serviço não monta
   nada pra ela. Esta fábrica é o outro lado — ela produz o módulo inteiro
   (rotinas, rotas e crons) a partir de configuração e das peças injetadas.

   O que era por empresa e virou parâmetro: o prefixo HTTP (/amb, /good, '' na
   Girassol), o rótulo das mensagens e os minutos do cron do F3 — escalonados de
   propósito (0, 2 e 4) pra as três não competirem pela cota do Bling.

   O que continua vindo de fora, por injeção: os fluxos, os gerenciadores de token
   e o cliente do Bling daquela empresa. A fábrica não conhece CNPJ nenhum.

   ⚠️ Ainda NÃO é onboarding declarativo: as peças injetadas vivem na pasta da
   empresa. O passo seguinte é essas peças também nascerem do registro — mas com
   esta fábrica, o que sobra na pasta é fiação, não regra.
   ──────────────────────────────────────────────────────────────────────────── */

const { lerChaveAdmin } = require('../http/chave-admin');

/* Sonda UMA fonte de CEP isolada, espelhando o resolver (lib/cepResolver.js): mesmo prazo
   (CEP_TIMEOUT_MS, padrão 4000), mesmos headers, e parse só com HTTP 2xx — assim o
   diagnóstico e o resultado_final contam a mesma história.
   Codex #543 (auditoria da sonda inteira):
   - UM prazo total; ao estourar, DESTRÓI o request (antes o teto só resolvia a promessa e o
     socket/buffer ficavam vivos);
   - resolve em todo final: end, aborted, close, error da resposta e error do request;
   - decodifica UTF-8 em streaming (setEncoding) — "São João" partido entre chunks não vira �;
   - devolve o payload DECODIFICADO (bruto) e o status, separados do parse: dá pra distinguir
     fonte fora do ar de fonte no ar com payload inesperado;
   - buffer com teto, pra fonte que não para de mandar não crescer sem limite. */
function sondarFonte(f, cep, timeoutMs) {
  return new Promise((ok) => {
    let resolveu = false;
    let req2 = null;
    const MAX = 1024 * 1024;
    const teto = setTimeout(() => fim({ status: null, bruto: null, parsed: null, erro: 'timeout' }), timeoutMs);
    function fim(v) {
      if (resolveu) return;
      resolveu = true; clearTimeout(teto);
      if (req2) req2.destroy();
      ok(v);
    }
    try {
      req2 = require('https').get(f.url(cep), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mover-Pedidos/1.0 (+corrigir-nfs)' },
      }, (r2) => {
        const status = r2.statusCode;
        let b2 = '';
        r2.setEncoding('utf8');
        r2.on('data', (c) => {
          b2 += c;
          if (b2.length > MAX) fim({ status, bruto: null, parsed: null, erro: 'resposta grande demais' });
        });
        r2.on('end', () => {
          let bruto;
          try { bruto = JSON.parse(b2); } catch (e) { return fim({ status, bruto: null, parsed: null, erro: 'resposta não é JSON' }); }
          let parsed = null;
          if (status >= 200 && status < 300) { try { parsed = f.parse(bruto); } catch (e) { parsed = null; } }
          fim({ status, bruto, parsed, erro: null });
        });
        /* fonte que fecha a resposta no meio ("Premature close", caso do BrasilAPI v2).
           'close' depois de 'end' é inofensivo: `fim` resolve uma vez só. */
        r2.on('aborted', () => fim({ status, bruto: null, parsed: null, erro: 'resposta cortada' }));
        r2.on('close', () => fim({ status, bruto: null, parsed: null, erro: 'resposta cortada' }));
        r2.on('error', (e) => fim({ status, bruto: null, parsed: null, erro: String(e.message || e) }));
      });
      req2.on('error', (e) => fim({ status: null, bruto: null, parsed: null, erro: String(e.message || e) }));
    } catch (e) { fim({ status: null, bruto: null, parsed: null, erro: String(e.message || e) }); }
  });
}

function criarModuloFiscal(cfg) {
  for (const nome of ['id', 'nome', 'prefixo', 'rotulo', 'pecas', 'crons']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/criar-modulo: falta ' + nome);
  }
  const { id, nome, prefixo, rotulo, crons } = cfg;
  const {
    rotinaExpediente, rotinaVirada, rotinaManha,
    corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ,
    garantirToken, gerarTokenInicial,
    gerarTokenInicialNF, garantirTokenNF,
    garantirTokenML, trocarCodigoPorToken, gerarUrlAutorizacao,
    getPedidoDetalhe,
    rotinaNFeML, enviarNFeUnica,
  } = cfg.pecas;

  /* o teste pegou o furo: validar só o que EXISTE deixa passar `pecas: {}` — a empresa
     nasceria com rotinas undefined e a falha apareceria no primeiro cron, em produção, de
     madrugada. A lista é explícita pra peça faltando derrubar aqui, no boot. */
  const PECAS_OBRIGATORIAS = [
    'rotinaExpediente', 'rotinaVirada', 'rotinaManha',
    'corrigirNFsPendentes', 'retryNFManual', 'getEstadoRetrySEFAZ',
    'garantirToken', 'gerarTokenInicial',
    'gerarTokenInicialNF', 'garantirTokenNF',
    'garantirTokenML', 'trocarCodigoPorToken', 'gerarUrlAutorizacao',
    'getPedidoDetalhe', 'rotinaNFeML', 'enviarNFeUnica',
  ];
  const faltando = PECAS_OBRIGATORIAS.filter(p => typeof cfg.pecas[p] !== 'function');
  if (faltando.length) {
    throw new Error('lib/fiscal/criar-modulo: ' + id + ' está sem a(s) peça(s): ' + faltando.join(', '));
  }

  function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  }
  function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
  }

  /**
   * Registra as rotas HTTP do módulo AMBTotal sob o prefixo /amb
   */
  function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ─── Setup OAuth Bling (Mover-Pedidos) ─────────────────────────
    if (p === (prefixo + '/setup') && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicial(body.auth_code);
        json(res, 200, { ok: true, message: `${rotulo}: Tokens Bling gerados ✓` });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo}: Código não encontrado</h2>`); return true; }
      try {
        await gerarTokenInicial(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token Bling obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth Bling NF (Corrigir-NFs) ───────────────────────
    if (p === (prefixo + '/setup-nf') && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicialNF(body.auth_code);
        json(res, 200, { ok: true, message: `${rotulo}: Tokens Bling NF gerados ✓` });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback-nf') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo} NF: Código não encontrado</h2>`); return true; }
      try {
        await gerarTokenInicialNF(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token Bling NF obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} NF Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth ML ────────────────────────────────────────────
    if (p === (prefixo + '/setup-ml') && method === 'GET') {
      try {
        const authUrl = gerarUrlAutorizacao();
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback-ml') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo} ML: Código não encontrado</h2>`); return true; }
      try {
        await trocarCodigoPorToken(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token ML obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} ML Erro: ${e.message}</h2>`); }
      return true;
    }

    /* 30/09 — O QUE O RESOLVEDOR DEVOLVE PRA UM CEP, ponta a ponta.
       Nasceu de uma NF da Girassol parada porque o cliente escreveu "Sem Peixe" e o nome
       oficial é "Sem-Peixe" (MG). Acrescentei a correção, a NF continuou parada, e eu não
       tinha como saber POR QUÊ: a sandbox não alcança o ViaCEP, e sem ver o que ele devolve
       pra aquele CEP não dá pra dizer se o problema é a fonte, a correção ou outra coisa.
       Mostra: o que CADA fonte responde, o que a correção de nome faz com isso, e se há
       fallback pro CEP. Só leitura, só admin — e responde num clique no navegador. */
    if (method === 'GET' && p === (prefixo + '/debug/cep')) {
      /* mesmo parser do portão central: x-admin-key, Authorization: Bearer ou ?k= (nessa ordem) */
      const kC = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const cepPedido = String(urlObj.searchParams.get('cep') || '').replace(/\D/g, '');
      if (cepPedido.length !== 8) { json(res, 200, { ok: false, erro: 'informe ?cep= com 8 dígitos' }); return true; }
      (async () => {
        try {
          const { getCidadePorCEP, FONTES } = require('../cepResolver');
          const { aplicarCorrecaoCidade, fallbackPorCEP } = require('../correcoesCidades');

          /* o resultado FINAL, que é o que a NF usa */
          const final = await getCidadePorCEP(cepPedido, '[debug/cep]');

          /* e cada fonte isolada: é isto que diz se o nome vem diferente do esperado */
          const porFonte = [];
          const prazo = Number(process.env.CEP_TIMEOUT_MS || 4000); // o mesmo do resolver
          for (const f of FONTES) {
            try {
              const r = await sondarFonte(f, cepPedido, prazo);
              const m = r.parsed;
              porFonte.push({
                fonte: f.nome || String(f.url(cepPedido)).split('/')[2],
                http: r.status, erro: r.erro,
                bruto: r.bruto,         // o que a fonte devolveu, sem parser
                municipio: m || null,   // o que o resolver extrai disso
                apos_correcao: m && m.municipio ? aplicarCorrecaoCidade(m.municipio, m.uf) : null,
              });
            } catch (e) { porFonte.push({ fonte: '?', erro: String(e.message || e) }); }
          }

          json(res, 200, {
            ok: true, cep: cepPedido,
            resultado_final: final,
            por_fonte: porFonte,
            fallback_por_cep: fallbackPorCEP(cepPedido),
            leia: 'resultado_final e o que a NF usa. Se `municipio` de alguma fonte traz um nome ' +
                  'diferente do oficial e `apos_correcao` NAO corrige, falta a entrada em ' +
                  'CORRECOES_CIDADE. `bruto` e o payload cru e `http` o status: bruto preenchido ' +
                  'com municipio nulo = fonte no ar com formato inesperado; erro preenchido = fonte ' +
                  'fora do ar. Se nenhuma fonte responde, use FALLBACK_POR_CEP.',
          });
        } catch (e) {
          json(res, 200, { ok: false, erro: String(e.message || e) });
        }
      })();
      return true;
    }

    // ─── Runs manuais ──────────────────────────────────────────────
    if (method === 'POST') {
      if (p === (prefixo + '/run/expedicao')) {
        rotinaExpediente().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaExpediente` });
        return true;
      }
      if (p === (prefixo + '/run/virada')) {
        rotinaVirada().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaVirada` });
        return true;
      }
      if (p === (prefixo + '/run/manha')) {
        rotinaManha().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaManha` });
        return true;
      }
      if (p === (prefixo + '/run/corrigir-nfs')) {
        corrigirNFsPendentes().catch(console.error);
        json(res, 202, { queued: `${rotulo} corrigirNFsPendentes` });
        return true;
      }
      if (p === (prefixo + '/run/nfe-ml')) {
        rotinaNFeML().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaNFeML` });
        return true;
      }
      // Envio manual de UMA NF específica: POST /amb/run/nfe-ml/:idNfe
      if (p.startsWith((prefixo + '/run/nfe-ml/'))) {
        const idNfe = p.split('/').pop();
        try {
          const resultado = await enviarNFeUnica(idNfe);
          json(res, 200, resultado);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return true;
      }
      // Retry manual de UMA NF rejeitada por SEFAZ: POST /amb/run/retry-nf/:id
      if (p.startsWith((prefixo + '/run/retry-nf/'))) {
        const idNF = p.split('/').pop();
        if (!idNF || !/^\d+$/.test(idNF)) { json(res, 400, { ok: false, erro: 'ID da NF inválido' }); return true; }
        try {
          const r = await retryNFManual(idNF);
          json(res, r.ok ? 200 : 400, r);
        } catch (e) {
          json(res, 500, { ok: false, erro: e.message });
        }
        return true;
      }
    }

    // ─── Debug ─────────────────────────────────────────────────────
    if (method === 'GET' && p === (prefixo + '/debug/retry-sefaz')) {
      json(res, 200, getEstadoRetrySEFAZ());
      return true;
    }

    // Robô local: lista NFs em "Consultar situação" (sit=0) pra validar via UI interna
    if (method === 'GET' && p === (prefixo + '/robo/nfs-consultar-situacao')) {
      try {
        const { getNFsSituacaoConsulta } = require('./nfBlingApi');
        const token = await garantirTokenNF();
        const nfs = await getNFsSituacaoConsulta(token);
        json(res, 200, {
          empresa: 'ambtotal',
          total: nfs.length,
          nfs: nfs.map(n => ({ id: n.id, numero: n.numero, dataEmissao: n.dataEmissao }))
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p === (prefixo + '/debug/token')) {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/debug/token-nf')) {
      try {
        const token = await garantirTokenNF();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/debug/token-ml')) {
      try {
        const token = await garantirTokenML();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/pedido/'))) {
      const idPedido = p.split('/').pop();
      try {
        const token = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Envio único de NF-e → ML (debug/manual via GET — pode abrir no navegador)
    if (method === 'GET' && p.startsWith((prefixo + '/debug/enviar-nfe/'))) {
      const nfeId = p.split('/').pop();
      try {
        const resultado = await enviarNFeUnica(nfeId);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/nf-corrigir/'))) {
      const idNF = p.split('/').pop();
      try {
        const { getNFDetalhe } = require('./nfBlingApi');
        const token = await garantirTokenNF();
        const detalhe = await getNFDetalhe(token, idNF);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Debug SintegraWS: GET /amb/debug/sintegra/:cnpj/:uf
    // Debug CNPJá (fonte 2 de IE): GET /amb/debug/cnpja/:cnpj/:uf
    if (method === 'GET' && p.startsWith((prefixo + '/debug/cnpja/'))) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) { json(res, 400, { ok: false, erro: 'Uso: /amb/debug/cnpja/:cnpj/:uf' }); return true; }
      try {
        const resp = await fetch(`https://open.cnpja.com/office/${String(cnpj).replace(/\D/g,'')}`, { headers: { 'Accept': 'application/json' } });
        const data = resp.ok ? await resp.json() : null;
        const regs = (data && Array.isArray(data.registrations)) ? data.registrations : [];
        json(res, 200, { cnpj, uf, httpStatus: resp.status, registrations: regs });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/sintegra/'))) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) {
        json(res, 400, { ok: false, erro: 'Uso: /amb/debug/sintegra/:cnpj/:uf' });
        return true;
      }
      try {
        const { getIEPorCNPJ } = require('./nfBlingApi');
        const resultado = await getIEPorCNPJ(cnpj, uf);
        json(res, 200, {
          cnpj, uf, resultado,
          observacao: resultado
            ? `IE encontrada: "${resultado.ie}" (contribuinte=${resultado.contribuinte})`
            : 'IE não encontrada — SintegraWS pode ter falhado ou retornou vazio. Veja os logs do servidor.'
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Debug CEP (paridade com Girassol): GET /amb/debug/cep/:cep
    if (method === 'GET' && p.startsWith((prefixo + '/debug/cep/'))) {
      const cep = p.split('/').pop();
      try {
        const { getCidadePorCEP } = require('./nfBlingApi');
        const resultado = await getCidadePorCEP(cep);
        json(res, 200, {
          cep, resultado,
          observacao: resultado
            ? 'Este é o que seria gravado na NF (municipio + uf)'
            : 'CEP inválido ou nenhuma fonte retornou dados'
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false;
  };
  }


  return { id, nome, rotinas: {
    rotinaExpediente, rotinaVirada, rotinaManha,
    corrigirNFs: corrigirNFsPendentes,
    nfeMl: rotinaNFeML,
  }, routes, crons };
}

module.exports = { criarModuloFiscal };
