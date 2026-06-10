'use strict';

/**
 * Módulo GOOD Import — Mover Pedidos + Corrigir-NFs
 *
 * Expõe a interface padrão usada pelo orquestrador raiz:
 *   - rotinas: { rotinaExpediente, rotinaVirada, rotinaManha, corrigirNFs }
 *   - routes:  função que registra as rotas HTTP da empresa
 *   - crons:   configuração dos crons (timing)
 */

const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ } = require('./nfFluxos');
const { garantirToken, gerarTokenInicial } = require('./tokenManager');
const { gerarTokenInicialNF, garantirTokenNF } = require('./nfTokenManager');
const { garantirTokenML, trocarCodigoPorToken,
        gerarUrlAutorizacao } = require('./mlTokenManager');
const { getPedidoDetalhe } = require('./blingApi');

// ── Crons da GOOD Import ─────────────────────────────────────────────────
const crons = {
  expediente:  '*/3 6-23 * * *',                              // F1 a cada 3 min
  virada:      '10 0 * * *',                                  // F2 às 00:10
  manha:       ['0 6 * * *', '30 6 * * *', '0 7 * * *',       // F2 às 06:00, 06:30, 07:00
                '*/15 6-23 * * *'],                           // F2 a cada 15 min diurno
  corrigirNFs: '*/5 6-23 * * *'                               // Corrigir-NFs a cada 5 min
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
      // Retry manual de UMA NF rejeitada por SEFAZ: POST /good/run/retry-nf/:id
      if (p.startsWith('/good/run/retry-nf/')) {
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
    if (method === 'GET' && p === '/good/debug/retry-sefaz') {
      json(res, 200, getEstadoRetrySEFAZ());
      return true;
    }

    // Robô local: lista NFs em "Consultar situação" (sit=0) pra validar via UI interna
    if (method === 'GET' && p === '/good/robo/nfs-consultar-situacao') {
      try {
        const { getNFsSituacaoConsulta } = require('./nfBlingApi');
        const token = await garantirTokenNF();
        const nfs = await getNFsSituacaoConsulta(token);
        json(res, 200, {
          empresa: 'good',
          total: nfs.length,
          nfs: nfs.map(n => ({ id: n.id, numero: n.numero, dataEmissao: n.dataEmissao }))
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

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
    // Debug SintegraWS: GET /good/debug/sintegra/:cnpj/:uf
    // Debug CNPJá (fonte 2 de IE): GET /good/debug/cnpja/:cnpj/:uf
    if (method === 'GET' && p.startsWith('/good/debug/cnpja/')) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) { json(res, 400, { ok: false, erro: 'Uso: /good/debug/cnpja/:cnpj/:uf' }); return true; }
      try {
        const resp = await fetch(`https://open.cnpja.com/office/${String(cnpj).replace(/\D/g,'')}`, { headers: { 'Accept': 'application/json' } });
        const data = resp.ok ? await resp.json() : null;
        const regs = (data && Array.isArray(data.registrations)) ? data.registrations : [];
        json(res, 200, { cnpj, uf, httpStatus: resp.status, registrations: regs });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith('/good/debug/sintegra/')) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) {
        json(res, 400, { ok: false, erro: 'Uso: /good/debug/sintegra/:cnpj/:uf' });
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
    // Debug CEP (paridade com Girassol): GET /good/debug/cep/:cep
    if (method === 'GET' && p.startsWith('/good/debug/cep/')) {
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

module.exports = {
  id:    'good',
  nome:  'GOOD Import',
  rotinas: {
    rotinaExpediente,
    rotinaVirada,
    rotinaManha,
    corrigirNFs: corrigirNFsPendentes
  },
  routes,
  crons
};
