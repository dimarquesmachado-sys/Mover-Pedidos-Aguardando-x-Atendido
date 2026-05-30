'use strict';

const http = require('http');
const cron = require('node-cron');
const { json, readBody } = require('./lib/http');
const empresas = require('./config/empresas');

const TZ = process.env.TZ || 'America/Sao_Paulo';

// ── Boot log ──────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║  Bling Automação UNIFICADO v3.0           ║');
console.log('║  Multi-empresa / Multi-funcionalidade     ║');
console.log('╚══════════════════════════════════════════╝');
console.log('Timezone:', TZ);
console.log('Iniciado:', new Date().toLocaleString('pt-BR', { timeZone: TZ }));
console.log('Empresas ativas:', empresas.map(e => e.nome).join(', ') || '(nenhuma)');

function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ });
}

// ── Agendar crons de cada empresa ────────────────────────────────────
function agendarCron(empresa, expr, label, fn) {
  if (!expr) return;
  cron.schedule(expr, () => {
    console.log(`\n[${empresa.nome}] [CRON ${label}] ${ts()}`);
    Promise.resolve()
      .then(() => fn())
      .catch(e => console.error(`[${empresa.nome}] [${label}] erro:`, e.message));
  }, { timezone: TZ });
  console.log(`  [${empresa.nome}] cron ${label}: ${expr}`);
}

// Aceita string OU array de expressões cron. Agenda todas.
function agendarCrons(empresa, expr, label, fn) {
  if (!expr || !fn) return;
  const arr = Array.isArray(expr) ? expr : [expr];
  arr.forEach((e, i) => agendarCron(empresa, e, arr.length > 1 ? `${label}-${i+1}` : label, fn));
}

console.log('\n── Agendando crons ──');
for (const emp of empresas) {
  const { crons: c, rotinas: r } = emp;

  // F1 — Expediente
  if (c.expediente && r.rotinaExpediente) {
    agendarCrons(emp, c.expediente, 'F1', r.rotinaExpediente);
  }

  // F2 — Virada
  if (c.virada && r.rotinaVirada) {
    agendarCrons(emp, c.virada, 'F2-Virada', r.rotinaVirada);
  }

  // F2 — Manhã / diurno
  if (c.manha && r.rotinaManha) {
    agendarCrons(emp, c.manha, 'F2-Manha', r.rotinaManha);
  }

  // Corrigir-NFs
  if (c.corrigirNFs && r.corrigirNFs) {
    agendarCrons(emp, c.corrigirNFs, 'CorrigirNFs', r.corrigirNFs);
  }

  // F3 — NF-e → Mercado Livre (envio dos dados fiscais)
  if (c.nfeMl && r.nfeMl) {
    agendarCrons(emp, c.nfeMl, 'F3-NFeML', r.nfeMl);
  }

  // ════════════════════════════════════════════════════════════════
  // Crons CUSTOMIZADOS — pega qualquer chave de c que NAO seja uma
  // das hardcoded acima, e tenta achar a rotina com mesmo nome em r.
  // Permite modulos novos (auto-mensagens, lixas-combinar, etc) usar
  // crons sem precisar editar este arquivo.
  // ════════════════════════════════════════════════════════════════
  const cronsConhecidos = new Set([
    'expediente', 'virada', 'manha', 'corrigirNFs', 'nfeMl'
  ]);
  if (c) {
    for (const chaveCron of Object.keys(c)) {
      if (cronsConhecidos.has(chaveCron)) continue;
      const fn = r?.[chaveCron];
      if (fn && c[chaveCron]) {
        agendarCrons(emp, c[chaveCron], chaveCron, fn);
      }
    }
  }
}

// ── HTTP server ──────────────────────────────────────────────────────
// Carrega handlers de cada empresa
const handlers = empresas.map(e => ({
  nome: e.nome,
  id: e.id,
  handle: e.routes(readBody)
}));

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const urlObj = new URL(url, 'http://localhost');
  const path = urlObj.pathname;

  // Rota global de health
  if (path === '/health' || path === '/') {
    return json(res, 200, {
      status: 'ok',
      service: 'bling-automacao-unificado',
      time: ts(),
      empresas: empresas.map(e => ({ id: e.id, nome: e.nome }))
    });
  }

  // Tenta cada handler de empresa
  try {
    for (const h of handlers) {
      const tratou = await h.handle(req, res, urlObj);
      if (tratou) return;
    }
  } catch (e) {
    console.error('[server] Erro no handler:', e.message);
    return json(res, 500, { error: e.message });
  }

  // Nenhum handler tratou
  return json(res, 404, { error: 'not found', path });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 HTTP ouvindo na porta ${PORT}\n`);
  // Bootstrap de módulos que precisam (ex: fragil carrega índice de produtos)
  for (const e of empresas) {
    if (typeof e.bootstrap === 'function') {
      try {
        e.bootstrap();
        console.log(`[${e.nome}] bootstrap disparado`);
      } catch (err) {
        console.error(`[${e.nome}] erro no bootstrap:`, err.message);
      }
    }
  }
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
