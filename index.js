'use strict';


const http  = require('http');
const cron  = require('node-cron');
const { rotinaExpediente, rotinaVirada, rotinaManha } = require('./fluxos');
const { gerarTokenInicial } = require('./tokenManager');

const TZ = process.env.TZ || 'America/Sao_Paulo';

console.log('╔══════════════════════════════════════════╗');
console.log('║  Bling Automação GIRASSOL  v2.0           ║');
console.log('╚══════════════════════════════════════════╝');
console.log('Timezone:', TZ);
console.log('Iniciado:', new Date().toLocaleString('pt-BR', { timeZone: TZ }));

// ════════════════════════════════════════════════════════════════
//  CRON JOBS
//
//  F1 — ATENDIDO → AGUARDANDO
//  Roda a cada 3 minutos das 06h às 23h59
//  Quanto mais rápido, menor o tempo de um pedido sem etiqueta
//  ficar visível na tela dos estoquistas.
//
//  F2 — AGUARDANDO → ATENDIDO
//  00:10 → virada (limpa memória + repesca)
//  06:00 → antes de abrir
//  06:30 → reforço
//  07:00 → abertura
// ════════════════════════════════════════════════════════════════

// A cada 3 minutos, das 06h às 23h59
cron.schedule('*/3 6-23 * * *', () => {
  console.log(`\n[CRON] Expediente ${ts()}`);
  rotinaExpediente().catch(e => console.error('[CRON] Expediente erro:', e.message));
}, { timezone: TZ });

// Virada — 00:10
cron.schedule('10 0 * * *', () => {
  console.log(`\n[CRON] Virada ${ts()}`);
  rotinaVirada().catch(e => console.error('[CRON] Virada erro:', e.message));
}, { timezone: TZ });

// Manhã — 06:00, 06:30, 07:00
['0 6', '30 6', '0 7'].forEach(h => {
  cron.schedule(`${h} * * *`, () => {
    console.log(`\n[CRON] Manhã ${ts()}`);
    rotinaManha().catch(e => console.error('[CRON] Manhã erro:', e.message));
  }, { timezone: TZ });
});

// ════════════════════════════════════════════════════════════════
//  HTTP SERVER
//  Render precisa de uma porta aberta para manter o serviço vivo.
//  Os endpoints /run/* permitem disparo manual e testes.
// ════════════════════════════════════════════════════════════════

function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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

  // ── Health ───────────────────────────────────────────────────
  if (url === '/health' || url === '/') {
    return json(res, 200, {
      status: 'ok',
      service: 'bling-automacao-girassol',
      time: ts()
    });
  }

  // ── Setup: gerar token inicial ───────────────────────────────
  if (url === '/setup' && method === 'POST') {
    const body = await readBody(req);
    try {
      await gerarTokenInicial(body.auth_code);
      return json(res, 200, { ok: true, message: 'Tokens gerados e salvos ✓' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ── Disparos manuais ─────────────────────────────────────────
  if (method === 'POST') {
    if (url === '/run/expedicao') {
      rotinaExpediente().catch(console.error);
      return json(res, 202, { queued: 'rotinaExpediente' });
    }
    if (url === '/run/virada') {
      rotinaVirada().catch(console.error);
      return json(res, 202, { queued: 'rotinaVirada' });
    }
    if (url === '/run/manha') {
      rotinaManha().catch(console.error);
      return json(res, 202, { queued: 'rotinaManha' });
    }
  }
  // ── Debug: token atual ───────────────────────────────────────
  if (method === 'GET' && url === '/debug/token') {
    try {
      const { garantirToken } = require('./tokenManager');
      const token = await garantirToken();
      return json(res, 200, { token });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
// ── Debug: token atual ───────────────────────────────────────
  if (method === 'GET' && url === '/debug/token') {
    try {
      const { garantirToken } = require('./tokenManager');
      const token = await garantirToken();
      return json(res, 200, { token });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── Debug: detalhe de pedido ─────────────────────────────────
  if (method === 'GET' && url.startsWith('/debug/pedido/')) {
    const partes = url.split('/');
    const idPedido = partes[partes.length - 1];
    try {
      const { getPedidoDetalhe } = require('./blingApi');
      const { garantirToken } = require('./tokenManager');
      const token = await garantirToken();
      const detalhe = await getPedidoDetalhe(token, idPedido);
      return json(res, 200, detalhe);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'not found' });   // ← adicionar
});                                           // ← adicionar
  json(res, 404, { error: 'not found' });   // ← adicionar
});                                           // ← adicionar

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🌐 HTTP ouvindo na porta ${PORT}`));

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
