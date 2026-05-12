'use strict';

/**
 * Módulo AMBTotal — Mover Pedidos
 *
 * Expõe a interface padrão usada pelo orquestrador raiz:
 *   - rotinas:  { rotinaExpediente, rotinaVirada, rotinaManha }
 *   - routes:   função que registra as rotas HTTP da empresa
 *   - crons:    configuração dos crons (timing)
 */

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { garantirToken, gerarTokenInicial }            = require('./tokenManager');
const { garantirTokenML, trocarCodigoPorToken,
        gerarUrlAutorizacao }                          = require('./mlTokenManager');
const { getPedidoDetalhe }                             = require('./blingApi');

// ── Crons da AMBTotal ─────────────────────────────────────────────────
const crons = {
  expediente: '*/3 6-23 * * *',                                  // F1 a cada 3 min
  virada:     '10 0 * * *',                                      // F2 às 00:10
  manha:      ['0 6 * * *', '30 6 * * *', '0 7 * * *',           // F2 às 06:00, 06:30, 07:00
               '*/15 6-23 * * *']                                // F2 a cada 15 min diurno
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
 * Registra as rotas HTTP do módulo AMBTotal sob o prefixo /amb
 *
 * @param {http.Server} server      ─ não usado (rotas tratadas no orquestrador)
 * @param {Function}    readBody    ─ helper pra ler body JSON
 * @returns {Function} handler(req, res, urlObj) → true se tratou, false se não
 */
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // Setup OAuth Bling
    if (p === '/amb/setup' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicial(body.auth_code);
        json(res, 200, { ok: true, message: 'AMB: Tokens Bling gerados ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }

    if (p === '/amb/callback' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ AMB: Código não encontrado</h2>'); return true; }
      try {
        await gerarTokenInicial(code);
        html(res, 200, '<h2>✅ AMB: Token Bling obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ AMB Erro: ${e.message}</h2>`); }
      return true;
    }

    // Setup OAuth ML
    if (p === '/amb/setup-ml' && method === 'GET') {
      try {
        const authUrl = gerarUrlAutorizacao();
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (p === '/amb/callback-ml' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ AMB ML: Código não encontrado</h2>'); return true; }
      try {
        await trocarCodigoPorToken(code);
        html(res, 200, '<h2>✅ AMB: Token ML obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ AMB ML Erro: ${e.message}</h2>`); }
      return true;
    }

    // Runs manuais
    if (method === 'POST') {
      if (p === '/amb/run/expedicao') {
        rotinaExpediente().catch(console.error);
        json(res, 202, { queued: 'AMB rotinaExpediente' });
        return true;
      }
      if (p === '/amb/run/virada') {
        rotinaVirada().catch(console.error);
        json(res, 202, { queued: 'AMB rotinaVirada' });
        return true;
      }
      if (p === '/amb/run/manha') {
        rotinaManha().catch(console.error);
        json(res, 202, { queued: 'AMB rotinaManha' });
        return true;
      }
    }

    // Debug
    if (method === 'GET' && p === '/amb/debug/token') {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p === '/amb/debug/token-ml') {
      try {
        const token = await garantirTokenML();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    if (method === 'GET' && p.startsWith('/amb/debug/pedido/')) {
      const idPedido = p.split('/').pop();
      try {
        const token   = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false; // não tratou
  };
}

module.exports = {
  id:   'ambtotal',
  nome: 'AMBTotal',
  rotinas: { rotinaExpediente, rotinaVirada, rotinaManha },
  routes,
  crons
};
