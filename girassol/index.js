'use strict';

/**
 * Módulo Girassol — Mover Pedidos + Corrigir-NFs
 *
 * Mantém TODA a lógica atual intocada (arquivos blingApi.js, fluxos.js,
 * mlApi.js, tokenManager.js, mlTokenManager.js, nfBlingApi.js, nfFluxos.js,
 * nfTokenManager.js). Só envelopa em uma interface padrão para o orquestrador.
 *
 * Rotas mantêm os caminhos atuais SEM prefixo (compat com o que já existe
 * em produção). Só AMBTotal e GOOD usam prefixo (/amb, /good).
 */

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { corrigirNFsPendentes }                         = require('./nfFluxos');
const { gerarTokenInicial, garantirToken }             = require('./tokenManager');
const { gerarTokenInicialNF, garantirTokenNF }         = require('./nfTokenManager');
const { trocarCodigoPorToken, gerarUrlAutorizacao }    = require('./mlTokenManager');
const { rotinaNFeML, enviarNFeUnica } = require('./nfeMlFluxo');

// ── Crons do Girassol (offset 0 — escalonado p/ não bater com GOOD/AMB) ──
const crons = {
  // F1 — dia (6-19h) a cada 3 min (minutos 0,3,6...); madrugada (20-5h) a cada 15 min
  expediente:  ['0-59/3 6-19 * * *', '0,15,30,45 20-23,0-5 * * *'],
  // F2 — virada + manhã + diurno a cada 30 min
  virada:      '10 0 * * *',
  manha:       ['0 6 * * *', '30 6 * * *', '0 7 * * *',
                '0,30 8-19 * * *'],
  // Corrigir-NFs — dia 5 min; madrugada 20 min
  corrigirNFs: ['0-59/5 6-19 * * *', '0,20,40 20-23,0-5 * * *'],
  // F3 NF-e → ML — 24h a cada 10 min (minutos 0,10,20...)
  nfeMl:       '0,10,20,30,40,50 * * * *'
};

// ── Helpers HTTP locais ───────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * Registra rotas HTTP do Girassol — SEM prefixo (mantém compat com produção).
 */
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // Setup Bling (Mover-Pedidos)
    if (p === '/setup' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicial(body.auth_code);
        json(res, 200, { ok: true, message: 'Tokens Bling gerados e salvos ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }

    // Setup Bling NF (Corrigir-NFs)
    if (p === '/setup-nf' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicialNF(body.auth_code);
        json(res, 200, { ok: true, message: 'Tokens Bling NF gerados e salvos ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }

    if (p === '/callback-nf' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ Código não encontrado na URL</h2>'); return true; }
      try {
        await gerarTokenInicialNF(code);
        html(res, 200, '<h2>✅ Token do Bling NF obtido e salvo com sucesso! Pode fechar esta aba.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ Erro: ${e.message}</h2>`); }
      return true;
    }

    // Setup ML
    if (p === '/setup-ml' && method === 'GET') {
      const authUrl = gerarUrlAutorizacao();
      res.writeHead(302, { Location: authUrl });
      res.end();
      return true;
    }

    if (p === '/callback-ml' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ Código não encontrado na URL</h2>'); return true; }
      try {
        await trocarCodigoPorToken(code);
        html(res, 200, '<h2>✅ Token do ML obtido e salvo com sucesso! Pode fechar esta aba.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ Erro: ${e.message}</h2>`); }
      return true;
    }

    // Runs manuais
    if (method === 'POST') {
      if (p === '/run/expedicao')    { rotinaExpediente().catch(console.error);     json(res, 202, { queued: 'rotinaExpediente' }); return true; }
      if (p === '/run/virada')       { rotinaVirada().catch(console.error);         json(res, 202, { queued: 'rotinaVirada' });     return true; }
      if (p === '/run/manha')        { rotinaManha().catch(console.error);          json(res, 202, { queued: 'rotinaManha' });      return true; }
      if (p === '/run/corrigir-nfs') { corrigirNFsPendentes().catch(console.error); json(res, 202, { queued: 'corrigirNFsPendentes' }); return true; }
    if (p === '/run/nfe-ml')       { rotinaNFeML().catch(console.error);          json(res, 202, { queued: 'rotinaNFeML' }); return true; }
    }

    // Debug
    if (method === 'GET' && p === '/debug/token') {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p === '/debug/token-nf') {
      try {
        const token = await garantirTokenNF();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p.startsWith('/debug/pedido/')) {
      const idPedido = p.split('/').pop();
      try {
        const { getPedidoDetalhe } = require('./blingApi');
        const token   = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p.startsWith('/debug/nfe/')) {
      const idNfe = p.split('/').pop();
      try {
        const { getNFeDetalhe } = require('./blingApi');
        const token   = await garantirToken();
        const detalhe = await getNFeDetalhe(token, idNfe);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p.startsWith('/debug/nf-corrigir/')) {
      const idNF = p.split('/').pop();
      try {
        const { getNFDetalhe } = require('./nfBlingApi');
        const token   = await garantirTokenNF();
        const detalhe = await getNFDetalhe(token, idNF);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'POST' && p.startsWith('/run/nfe-ml/')) {
      const idNfe = p.split('/').pop();
      try {
        const resultado = await enviarNFeUnica(idNfe);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/debug/cep/')) {
      const cep = p.split('/').pop();
      try {
        const { getCidadePorCEP } = require('./nfBlingApi');
        const resultado = await getCidadePorCEP(cep);
        json(res, 200, {
          cep, resultado,
          observacao: resultado
            ? 'Este é o que seria gravado na NF (municipio + uf)'
            : 'CEP inválido ou ViaCEP não retornou dados'
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false; // não tratou
  };
}

module.exports = {
  id:   'girassol',
  nome: 'Girassol',
  rotinas: {
    rotinaExpediente,
    rotinaVirada,
    rotinaManha,
    corrigirNFs: corrigirNFsPendentes,
    nfeMl: rotinaNFeML
  },
  routes,
  crons
};
