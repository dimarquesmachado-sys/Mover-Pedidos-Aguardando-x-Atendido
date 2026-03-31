'use strict';

const http  = require('http');
const cron  = require('node-cron');
const { rotinaExpediente, rotinaVirada, rotinaManha, rotinaNFe } = require('./fluxos');
const { gerarTokenInicial } = require('./tokenManager');
const { trocarCodigoPorToken, gerarUrlAutorizacao } = require('./mlTokenManager');

const TZ = process.env.TZ || 'America/Sao_Paulo';

console.log('╔══════════════════════════════════════════╗');
console.log('║  Bling Automação GIRASSOL  v2.0           ║');
console.log('╚══════════════════════════════════════════╝');
console.log('Timezone:', TZ);
console.log('Iniciado:', new Date().toLocaleString('pt-BR', { timeZone: TZ }));

// F1 — a cada 3 min das 06h às 23h59
cron.schedule('*/3 6-23 * * *', () => {
  console.log(`\n[CRON] Expediente ${ts()}`);
  rotinaExpediente().catch(e => console.error('[CRON] Expediente erro:', e.message));
}, { timezone: TZ });

// F2 — virada 00:10
cron.schedule('10 0 * * *', () => {
  console.log(`\n[CRON] Virada ${ts()}`);
  rotinaVirada().catch(e => console.error('[CRON] Virada erro:', e.message));
}, { timezone: TZ });

// F2 — manhã 06:00, 06:30, 07:00
['0 6', '30 6', '0 7'].forEach(h => {
  cron.schedule(`${h} * * *`, () => {
    console.log(`\n[CRON] Manhã ${ts()}`);
    rotinaManha().catch(e => console.error('[CRON] Manhã erro:', e.message));
  }, { timezone: TZ });
});

// F2 — diurno a cada 15 min das 06h às 23h
cron.schedule('*/15 6-23 * * *', () => {
  console.log(`\n[CRON] F2 Diurno ${ts()}`);
  rotinaManha().catch(e => console.error('[CRON] F2 Diurno erro:', e.message));
}, { timezone: TZ });

// F3 — NF-e a cada 30 min das 06h às 23h
cron.schedule('*/30 6-23 * * *', () => {
  console.log(`\n[CRON] NF-e ML ${ts()}`);
  rotinaNFe().catch(e => console.error('[CRON] NF-e erro:', e.message));
}, { timezone: TZ });

function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const urlObj = new URL(url, 'http://localhost');
  const path   = urlObj.pathname;

  if (path === '/health' || path === '/') {
    return json(res, 200, { status: 'ok', service: 'bling-automacao-girassol', time: ts() });
  }

  if (path === '/setup' && method === 'POST') {
    const body = await readBody(req);
    try {
      await gerarTokenInicial(body.auth_code);
      return json(res, 200, { ok: true, message: 'Tokens Bling gerados e salvos ✓' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ─── ML OAuth ────────────────────────────────────────────────────────────────

  // Passo 1: redireciona para autorização do ML
  if (path === '/setup-ml' && method === 'GET') {
    const authUrl = gerarUrlAutorizacao();
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  // Passo 2: ML redireciona de volta aqui com o code
  if (path === '/callback-ml' && method === 'GET') {
    const code = urlObj.searchParams.get('code');
    if (!code) return html(res, 400, '<h2>❌ Código não encontrado na URL</h2>');
    try {
      await trocarCodigoPorToken(code);
      return html(res, 200, '<h2>✅ Token do ML obtido e salvo com sucesso! Pode fechar esta aba.</h2>');
    } catch (e) {
      return html(res, 500, `<h2>❌ Erro: ${e.message}</h2>`);
    }
  }

  // ─── Runs manuais ─────────────────────────────────────────────────────────────

  if (method === 'POST') {
    if (path === '/run/expedicao') { rotinaExpediente().catch(console.error); return json(res, 202, { queued: 'rotinaExpediente' }); }
    if (path === '/run/virada')    { rotinaVirada().catch(console.error);     return json(res, 202, { queued: 'rotinaVirada' }); }
    if (path === '/run/manha')     { rotinaManha().catch(console.error);      return json(res, 202, { queued: 'rotinaManha' }); }
    if (path === '/run/nfe-ml')    { rotinaNFe().catch(console.error);        return json(res, 202, { queued: 'rotinaNFe' }); }
  }

  // ─── Debugs ───────────────────────────────────────────────────────────────────

  if (method === 'GET' && path === '/debug/token') {
    try {
      const { garantirToken } = require('./tokenManager');
      const token = await garantirToken();
      return json(res, 200, { token });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (method === 'GET' && path.startsWith('/debug/pedido/')) {
    const idPedido = path.split('/').pop();
    try {
      const { getPedidoDetalhe } = require('./blingApi');
      const { garantirToken }    = require('./tokenManager');
      const token   = await garantirToken();
      const detalhe = await getPedidoDetalhe(token, idPedido);
      return json(res, 200, detalhe);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (method === 'GET' && path.startsWith('/debug/nfe/')) {
    const idNfe = path.split('/').pop();
    try {
      const { getNFeDetalhe } = require('./blingApi');
      const { garantirToken } = require('./tokenManager');
      const token   = await garantirToken();
      const detalhe = await getNFeDetalhe(token, idNfe);
      return json(res, 200, detalhe);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/copiar-tokens' && method === 'POST') {
    try {
      const fetch  = require('node-fetch');
      const fs     = require('fs');
      const tokens = JSON.parse(fs.readFileSync(process.env.TOKEN_FILE || '/data/tokens.json', 'utf8'));
      const resp   = await fetch('https://girassol-corrigir-nome-cidade-x-cep-x-nfs.onrender.com/setup-token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(tokens)
      });
      const data = await resp.json();
      return json(res, 200, { ok: true, resultado: data });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🌐 HTTP ouvindo na porta ${PORT}`));

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
