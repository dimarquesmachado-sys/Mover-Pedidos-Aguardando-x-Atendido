'use strict';

/**
 * Módulo Girassol — Mover Pedidos + Corrigir-NFs + F3 NF-e → ML
 */

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ } = require('./nfFluxos');
const { gerarTokenInicial, garantirToken } = require('./tokenManager');
const { gerarTokenInicialNF, garantirTokenNF } = require('./nfTokenManager');
const { trocarCodigoPorToken, gerarUrlAutorizacao, garantirTokenML } = require('./mlTokenManager');
const { rotinaNFeML, enviarNFeUnica } = require('./nfeMlFluxo');

// ── Crons do Girassol ─────────────────────────────────────────────────
const crons = {
  expediente:  '*/3 6-23 * * *',                              // F1 a cada 3 min
  virada:      '10 0 * * *',                                  // F2 às 00:10
  manha:       ['0 6 * * *', '30 6 * * *', '0 7 * * *',       // F2 às 06:00, 06:30, 07:00
                '*/15 6-23 * * *'],                           // F2 a cada 15 min diurno
  corrigirNFs: '*/5 6-23 * * *',                              // Corrigir-NFs a cada 5 min
  nfeMl:       '0,10,20,30,40,50 6-23 * * *'                  // F3 NF-e→ML a cada 10 min
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
      if (p === '/run/expedicao')    { rotinaExpediente().catch(console.error); json(res, 202, { queued: 'rotinaExpediente' }); return true; }
      if (p === '/run/virada')       { rotinaVirada().catch(console.error);     json(res, 202, { queued: 'rotinaVirada' }); return true; }
      if (p === '/run/manha')        { rotinaManha().catch(console.error);      json(res, 202, { queued: 'rotinaManha' }); return true; }
      if (p === '/run/corrigir-nfs') { corrigirNFsPendentes().catch(console.error); json(res, 202, { queued: 'corrigirNFsPendentes' }); return true; }
      if (p === '/run/nfe-ml')       { rotinaNFeML().catch(console.error);      json(res, 202, { queued: 'rotinaNFeML' }); return true; }

      // Envio manual de UMA NF específica: POST /run/nfe-ml/:idNfe
      if (p.startsWith('/run/nfe-ml/')) {
        const idNfe = p.split('/').pop();
        try {
          const resultado = await enviarNFeUnica(idNfe);
          json(res, 200, resultado);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return true;
      }

      // Retry manual de UMA NF rejeitada por SEFAZ: POST /run/retry-nf/:id
      if (p.startsWith('/run/retry-nf/')) {
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

    // Debug — estado do retry SEFAZ em memória
    if (method === 'GET' && p === '/debug/retry-sefaz') {
      json(res, 200, getEstadoRetrySEFAZ());
      return true;
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
    if (method === 'GET' && p === '/debug/token-ml') {
      try {
        const token = await garantirTokenML();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/debug/pedido/')) {
      const idPedido = p.split('/').pop();
      try {
        const { getPedidoDetalhe } = require('./blingApi');
        const token = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/debug/nfe/')) {
      const idNfe = p.split('/').pop();
      try {
        const { getNFeDetalhe } = require('./blingApi');
        const token = await garantirToken();
        const detalhe = await getNFeDetalhe(token, idNfe);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Envio único de NF-e → ML (debug/manual via GET)
    if (method === 'GET' && p.startsWith('/debug/enviar-nfe/')) {
      const nfeId = p.split('/').pop();
      try {
        const resultado = await enviarNFeUnica(nfeId);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/debug/nf-corrigir/')) {
      const idNF = p.split('/').pop();
      try {
        const { getNFDetalhe } = require('./nfBlingApi');
        const token = await garantirTokenNF();
        const detalhe = await getNFDetalhe(token, idNF);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Debug SintegraWS: GET /debug/sintegra/:cnpj/:uf
    if (method === 'GET' && p.startsWith('/debug/sintegra/')) {
      const partes = p.split('/');
      const cnpj = partes[3];
      const uf = partes[4];
      if (!cnpj || !uf) {
        json(res, 400, { ok: false, erro: 'Uso: /debug/sintegra/:cnpj/:uf' });
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
    // DEBUG TEMPORÁRIO: shipment cru do ML (use o shipment_id que aparece no log)
    if (method === 'GET' && p.startsWith('/debug/shipment/')) {
      const idShipment = p.split('/').pop();
      try {
        const { getShipmentRaw } = require('./mlApi');
        const token = await garantirTokenML();
        const resultado = await getShipmentRaw(token, idShipment);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // DEBUG TEMPORÁRIO: shipment cru do ML a partir do número do pedido ML (numeroLoja)
    if (method === 'GET' && p.startsWith('/debug/shipment-pedido/')) {
      const numeroML = p.split('/').pop();
      try {
        const { getShipmentInfo, getShipmentRaw } = require('./mlApi');
        const token = await garantirTokenML();
        const shipmentId = await getShipmentInfo(token, numeroML);
        const resultado = await getShipmentRaw(token, shipmentId);
        json(res, 200, { numeroML, shipmentId, ...resultado });
      } catch (e) { json(res, 500, { error: e.message }); }
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

    // TESTE — importar pedido do ML via API (dry-run por padrão; ?confirmar=1 cria)
    if (method === 'GET' && p.startsWith('/debug/teste-importar/')) {
      const numeroML = p.split('/').pop();
      const confirmar = urlObj.searchParams.get('confirmar') === '1';
      try {
        const { testarImportarPedido } = require('./importarPedido');
        const resultado = await testarImportarPedido(numeroML, confirmar);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false; // não tratou
  };
}

module.exports = {
  id: 'girassol',
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
