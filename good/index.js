'use strict';

/**
 * Módulo GOOD Import — Mover Pedidos + Corrigir-NFs + NF-e → ML
 *
 * Expõe a interface padrão usada pelo orquestrador raiz:
 *  - rotinas: { rotinaExpediente, rotinaVirada, rotinaManha, corrigirNFs, nfeMl }
 *  - routes: função que registra as rotas HTTP da empresa
 *  - crons: configuração dos crons (timing)
 */

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { corrigirNFsPendentes } = require('./nfFluxos');
const { garantirToken, gerarTokenInicial } = require('./tokenManager');
const { gerarTokenInicialNF, garantirTokenNF } = require('./nfTokenManager');
const { garantirTokenML, trocarCodigoPorToken,
        gerarUrlAutorizacao } = require('./mlTokenManager');
const { getPedidoDetalhe } = require('./blingApi');
const { rotinaNFeML, enviarNFeUnica } = require('./nfeMlFluxo');

// ── Crons da GOOD Import (offset 1 — escalonado p/ não bater com Girassol/AMB) ──
const crons = {
  // F1 — dia (6-19h) a cada 3 min (minutos 1,4,7...); madrugada (20-5h) a cada 15 min
  expediente:  ['1-59/3 6-19 * * *', '5,20,35,50 20-23,0-5 * * *'],
  // F2 — virada + manhã + diurno a cada 30 min
  virada:      '12 0 * * *',
  manha:       ['2 6 * * *', '32 6 * * *', '2 7 * * *',
                '10,40 8-19 * * *'],
  // Corrigir-NFs — dia 5 min; madrugada 20 min
  corrigirNFs: ['1-59/5 6-19 * * *', '5,25,45 20-23,0-5 * * *'],
  // F3 NF-e → ML — 24h a cada 10 min (minutos 3,13,23...)
  nfeMl:       '3,13,23,33,43,53 * * * *'
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
 * Registra as rotas HTTP do módulo GOOD Import sob o prefixo /good
 */
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ─── Setup OAuth Bling (Mover-Pedidos) ─────────────────────────
    if (p === '/good/setup' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicial(body.auth_code);
        json(res, 200, { ok: true, message: 'GOOD: Tokens Bling gerados ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === '/good/callback' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ GOOD: Código não encontrado</h2>'); return true; }
      try {
        await gerarTokenInicial(code);
        html(res, 200, '<h2>✅ GOOD: Token Bling obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ GOOD Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth Bling NF (Corrigir-NFs) ───────────────────────
    if (p === '/good/setup-nf' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicialNF(body.auth_code);
        json(res, 200, { ok: true, message: 'GOOD: Tokens Bling NF gerados ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === '/good/callback-nf' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ GOOD NF: Código não encontrado</h2>'); return true; }
      try {
        await gerarTokenInicialNF(code);
        html(res, 200, '<h2>✅ GOOD: Token Bling NF obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ GOOD NF Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth ML ────────────────────────────────────────────
    if (p === '/good/setup-ml' && method === 'GET') {
      try {
        const authUrl = gerarUrlAutorizacao();
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (p === '/good/callback-ml' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ GOOD ML: Código não encontrado</h2>'); return true; }
      try {
        await trocarCodigoPorToken(code);
        html(res, 200, '<h2>✅ GOOD: Token ML obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ GOOD ML Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Runs manuais ──────────────────────────────────────────────
    if (method === 'POST') {
      if (p === '/good/run/expedicao') {
        rotinaExpediente().catch(console.error);
        json(res, 202, { queued: 'GOOD rotinaExpediente' });
        return true;
      }
      if (p === '/good/run/virada') {
        rotinaVirada().catch(console.error);
        json(res, 202, { queued: 'GOOD rotinaVirada' });
        return true;
      }
      if (p === '/good/run/manha') {
        rotinaManha().catch(console.error);
        json(res, 202, { queued: 'GOOD rotinaManha' });
        return true;
      }
      if (p === '/good/run/corrigir-nfs') {
        corrigirNFsPendentes().catch(console.error);
        json(res, 202, { queued: 'GOOD corrigirNFsPendentes' });
        return true;
      }
      if (p === '/good/run/nfe-ml') {
        rotinaNFeML().catch(console.error);
        json(res, 202, { queued: 'GOOD rotinaNFeML' });
        return true;
      }
      // Envio manual de UMA NF específica: POST /good/run/nfe-ml/:idNfe
      if (p.startsWith('/good/run/nfe-ml/')) {
        const idNfe = p.split('/').pop();
        try {
          const resultado = await enviarNFeUnica(idNfe);
          json(res, 200, resultado);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return true;
      }
    }

    // ─── Debug ─────────────────────────────────────────────────────
    if (method === 'GET' && p === '/good/debug/token') {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === '/good/debug/token-nf') {
      try {
        const token = await garantirTokenNF();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === '/good/debug/token-ml') {
      try {
        const token = await garantirTokenML();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/good/debug/pedido/')) {
      const idPedido = p.split('/').pop();
      try {
        const token = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/good/debug/nfe/')) {
      const idNfe = p.split('/').pop();
      try {
        const { getNFeDetalhe } = require('./blingApi');
        const token = await garantirToken();
        const detalhe = await getNFeDetalhe(token, idNfe);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/good/debug/nf-corrigir/')) {
      const idNF = p.split('/').pop();
      try {
        const { getNFDetalhe } = require('./nfBlingApi');
        const token = await garantirTokenNF();
        const detalhe = await getNFDetalhe(token, idNF);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false;
  };
}

module.exports = {
  id:   'good',
  nome: 'GOOD Import',
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
