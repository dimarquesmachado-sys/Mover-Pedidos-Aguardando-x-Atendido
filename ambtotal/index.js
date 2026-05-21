'use strict';

/**
 * Módulo AMBTotal — Mover Pedidos + Corrigir-NFs + NF-e → ML
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

// ── Crons da AMBTotal (offset 2 — escalonado p/ não bater com Girassol/GOOD) ──
const crons = {
  // F1 — dia (6-19h) a cada 3 min (minutos 2,5,8...); madrugada (20-5h) a cada 15 min
  expediente:  ['2-59/3 6-19 * * *', '10,25,40,55 20-23,0-5 * * *'],
  // F2 — virada + manhã + diurno a cada 30 min
  virada:      '14 0 * * *',
  manha:       ['4 6 * * *', '34 6 * * *', '4 7 * * *',
                '20,50 8-19 * * *'],
  // Corrigir-NFs — dia 5 min; madrugada 20 min
  corrigirNFs: ['2-59/5 6-19 * * *', '10,30,50 20-23,0-5 * * *'],
  // F3 NF-e → ML — 24h a cada 10 min (minutos 6,16,26...)
  nfeMl:       '6,16,26,36,46,56 * * * *'
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
 */
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ─── Setup OAuth Bling (Mover-Pedidos) ─────────────────────────
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

    // ─── Setup OAuth Bling NF (Corrigir-NFs) ───────────────────────
    if (p === '/amb/setup-nf' && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicialNF(body.auth_code);
        json(res, 200, { ok: true, message: 'AMB: Tokens Bling NF gerados ✓' });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === '/amb/callback-nf' && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, '<h2>❌ AMB NF: Código não encontrado</h2>'); return true; }
      try {
        await gerarTokenInicialNF(code);
        html(res, 200, '<h2>✅ AMB: Token Bling NF obtido. Pode fechar.</h2>');
      } catch (e) { html(res, 500, `<h2>❌ AMB NF Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth ML ────────────────────────────────────────────
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

    // ─── Runs manuais ──────────────────────────────────────────────
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
      if (p === '/amb/run/corrigir-nfs') {
        corrigirNFsPendentes().catch(console.error);
        json(res, 202, { queued: 'AMB corrigirNFsPendentes' });
        return true;
      }
      if (p === '/amb/run/nfe-ml') {
        rotinaNFeML().catch(console.error);
        json(res, 202, { queued: 'AMB rotinaNFeML' });
        return true;
      }
      // Envio manual de UMA NF específica: POST /amb/run/nfe-ml/:idNfe
      if (p.startsWith('/amb/run/nfe-ml/')) {
        const idNfe = p.split('/').pop();
        try {
          const resultado = await enviarNFeUnica(idNfe);
          json(res, 200, resultado);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return true;
      }
    }

    // ─── Debug ─────────────────────────────────────────────────────
    if (method === 'GET' && p === '/amb/debug/token') {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === '/amb/debug/token-nf') {
      try {
        const token = await garantirTokenNF();
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
        const token = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/amb/debug/nfe/')) {
      const idNfe = p.split('/').pop();
      try {
        const { getNFeDetalhe } = require('./blingApi');
        const token = await garantirToken();
        const detalhe = await getNFeDetalhe(token, idNfe);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/amb/debug/nf-corrigir/')) {
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
  id:   'ambtotal',
  nome: 'AMBTotal',
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
