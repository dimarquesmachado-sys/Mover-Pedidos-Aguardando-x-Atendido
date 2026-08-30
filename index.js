'use strict';

// Rede de saída: esta instância NÃO tem rota IPv6 (ENETUNREACH em tudo).
// 1) ipv4first: coloca o IPv4 na frente na resolução de DNS.
// 2) autoSelectFamily(false): desliga o "Happy Eyeballs" do Node, que tentava
//    IPv4 e IPv6 em paralelo — o IPv6 quebrado matava a conexão no meio
//    ("Premature close"). Sem ele, o Node usa só IPv4, que funciona (testado:
//    Supabase 401, BrasilAPI 200, Bling 200 por IPv4). Vale p/ TODO o processo.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) { console.warn('dns ipv4first indisponível:', e.message); }
try { require('net').setDefaultAutoSelectFamily(false); } catch (e) { console.warn('autoSelectFamily indisponível:', e.message); }

const http = require('http');
const cron = require('node-cron');
const { json, readBody } = require('./lib/http');
const empresas = require('./config/empresas');
const magaluOauth = require('./magalu-oauth');   // handler global das rotas /magalu/*
const tiktokOauth = require('./tiktok-oauth');
const tiktokAds = require('./tiktok-ads');     // 18/08: gasto com anúncios vem de OUTRA API (API for Business)   // handler global das rotas /tiktok/* (14/08)

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

  // ── TRAVA CENTRAL DE SEGURANÇA (ampliada 04/07/2026) ────────────────
  // Rotas administrativas que disparam rotinas reais (/run, /robo, /forcar),
  // trocam tokens (/setup*) ou VAZAM credenciais/dados (/debug*). Estavam
  // abertas p/ internet nos módulos fiscais (girassol/amb/good, auth=0) e no
  // auto-mensagens. Agora exigem ?k=ADMIN_KEY. Sem a env, ficam 404 (seguro).
  // NÃO afeta: callbacks OAuth (Bling/ML/Shopee redirecionam pra cá) nem o
  // login/painéis dos módulos com autenticação própria (ponto, estoque, etc).
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const ehCallback = path.includes('/callback'); // OAuth — nunca trancar
  let ehAdmin =
    path.includes('/run/')   || path.endsWith('/run')   ||
    path.includes('/robo/')  ||
    path.includes('/forcar/')||
    path.includes('/setup')  ||
    path.includes('/debug/') || path.includes('/debug-') || path.endsWith('/debug');
  if (ehAdmin && !ehCallback) {
    if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) {
      return json(res, 404, { error: 'not found', path });
    }
  }

  /* Estáticos COMUNS a todos os painéis (28/08): /comum/<arquivo> — hoje a barra de
     navegação (nav.js), peça ÚNICA que cada painel carrega com uma linha de <script>.
     Só serve arquivos existentes dentro de public/comum, sem path traversal. */
  if (path.startsWith('/comum/')) {
    const rel = path.replace('/comum/', '');
    const dirComum = require('path').join(__dirname, 'public', 'comum');
    const full = require('path').join(dirComum, rel);
    const fsx = require('fs');
    if (full.startsWith(dirComum) && fsx.existsSync(full) && fsx.statSync(full).isFile()) {
      const ext = require('path').extname(full).toLowerCase();
      const mime = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      return fsx.createReadStream(full).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }

  /* Canário de tokens Bling (28/08): detalhes exigem ADMIN_KEY; o /alerta é público mas só
     devolve um booleano — a barra de navegação usa pra mostrar o aviso sem expor nada. */
  if (path === '/diagnostico/tokens') {
    const canario = require('./lib/canario-tokens');
    const ADMIN_KEY_D = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY_D || urlObj.searchParams.get('k') !== ADMIN_KEY_D) {
      res.writeHead(404); return res.end('not found');
    }
    if (urlObj.searchParams.get('agora') === '1') {
      return canario.verificarTodos().then(e => json(res, 200, e)).catch(e => json(res, 500, { erro: e.message }));
    }
    return json(res, 200, canario.lerEstado());
  }
  if (path === '/diagnostico/tokens/alerta') {
    const canario = require('./lib/canario-tokens');
    return json(res, 200, { alerta: canario.temAlerta() });
  }

  /* Canário dos MÓDULOS de extensão (29/08): a extensão manda sinal de vida ao montar.
     POST é aberto (a extensão não tem ADMIN_KEY e o dado não é sensível), mas só aceita
     ids conhecidos e tem teto de registros — id estranho é ignorado, não incha nada.
     Detalhes exigem ADMIN_KEY; /alerta é público e devolve só o que a barra precisa. */
  if (path === '/diagnostico/modulos' && method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (path === '/diagnostico/modulos' && method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');   /* sinal vem de páginas de terceiros (Bling, ML, MM) */
    const canario = require('./lib/canario-modulos');
    return readBody(req).then(body => {
      const ok = canario.registrar(body && body.modulo, body && body.empresa, body && body.versao, body && body.fase);
      json(res, ok ? 200 : 400, { ok });
    }).catch(() => json(res, 400, { ok: false }));
  }
  /* Heartbeat da extensão (1x/dia por empresa) — separa extensão removida de módulo não usado. */
  if (path === '/diagnostico/modulos/vivo' && method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (path === '/diagnostico/modulos/vivo' && method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const canario = require('./lib/canario-modulos');
    return readBody(req).then(body => {
      const ok = canario.registrarVivo(body && body.empresa, body && body.versao);
      json(res, ok ? 200 : 400, { ok });
    }).catch(() => json(res, 400, { ok: false }));
  }

  if (path === '/diagnostico/modulos' && method === 'GET') {
    const canario = require('./lib/canario-modulos');
    const ADMIN_KEY_M = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY_M || urlObj.searchParams.get('k') !== ADMIN_KEY_M) { res.writeHead(404); return res.end('not found'); }
    return json(res, 200, canario.estadoCompleto());
  }
  if (path === '/diagnostico/modulos/alerta') {
    const canario = require('./lib/canario-modulos');
    const m = canario.mudos();
    return json(res, 200, { alerta: m.length > 0, mudos: m.map(x => ({ modulo: x.modulo, empresa: x.empresa, dias: x.dias })) });
  }

  // Rota global de health
  if (path === '/health' || path === '/') {
    return json(res, 200, {
      status: 'ok',
      service: 'bling-automacao-unificado',
      time: ts(),
      empresas: empresas.map(e => ({ id: e.id, nome: e.nome }))
    });
  }

  // ── MAGALU OAUTH (handler global /magalu/*) ─────────────────────────
  // Conecta cada empresa à API oficial do Magalu e mantém o refresh_token.
  // Fica ANTES dos handlers de empresa e só trata paths /magalu/*.
  // /magalu/conectar e /magalu/status exigem ADMIN_KEY (?k=); /magalu/callback
  // é OAuth e já passa livre pela trava (path inclui /callback).
  if (path.startsWith('/magalu/')) {
    const precisaAdmin = (path === '/magalu/conectar' || path === '/magalu/status' || path === '/magalu/teste' || path === '/magalu/sonda' || path === '/magalu/valores' || path === '/magalu/financeiro' || path === '/magalu/financeiro-lote' ||
      /* 30/08: cancelamentos/devoluções do Magalu — dado financeiro, mesmo guard das demais */
      path === '/magalu/cancelados' || path === '/magalu/cancelados-coletar' || path === '/magalu/sonda-listagem' ||
      path === '/magalu/cruzar-cancelados' || path === '/magalu/sonda-eventos');   /* as duas: cada PR acrescentou uma */
    if (precisaAdmin) {
      if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) {
        return json(res, 404, { error: 'not found', path });
      }
    }
    try {
      const tratou = await magaluOauth.tratar(req, res, urlObj);
      if (tratou) return;
    } catch (e) {
      console.error('[magalu-oauth] erro:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── TikTok Shop (14/08) ────────────────────────────────────────────────
  // Bloco IRMÃO do magalu (não aninhado — aninhar faria a rota nunca ser alcançada).
  // Só admin: todas as rotas /tiktok/* exigem ?k=ADMIN_KEY, exceto /tiktok/callback,
  // que é o retorno do OAuth e chega sem chave.
  /* 30/08 — EMBARCAR EMPRESA: um comando pra ligar uma empresa nova, em vez de caçar token,
     histórico e coleta um por um. Diagnóstico com ?so_conferir=1 (não mexe em nada) e o
     embarque de verdade sem ele. Rota GLOBAL porque o embarque atravessa vários módulos. */
  /* 30/08 (Codex #307) — COLETA DIÁRIA DE TODAS AS EMPRESAS DA LISTA. As noturnas existem
     só pras empresas que têm checkout (Girassol e AMB); uma empresa nova entraria em
     EMPRESAS, seria embarcada... e depois NUNCA MAIS coletaria — o /embarcar prometia que
     "as coletas diárias já cobrem ela" e não era verdade. Este agendador roda as coletas de
     marketplace de cada empresa da lista, uma vez ao dia, sem depender de checkout. */
  if (path === '/coletas-diarias/estado') {
    if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, global.__coletasDiarias || { nunca_rodou: true });
    return;
  }

  if (path === '/embarcar') {
    if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) { json(res, 404, { error: 'not found' }); return; }
    const emb = require('./lib/embarcar-empresa');
    const empresa = String(urlObj.searchParams.get('empresa') || '').toLowerCase().trim();
    if (!empresa) { json(res, 400, { ok: false, erro: 'informe ?empresa=<girassol|good|amb>' }); return; }
    if (urlObj.searchParams.get('so_conferir') === '1') { json(res, 200, emb.conferir(empresa)); return; }

    /* os passos são as coletas que JÁ existem — nada aqui reimplementa nada */
    /* o ctx do TikTok é o mesmo que a noturna monta — escrito aqui porque eu tinha chamado
       duas funções que NÃO existem (ctxTikTok/lojaTikTok); o node --check não pega isso,
       só quebraria na hora de rodar. */
    const fsE = require('fs'), pathE = require('path');
    const ctxTk = {
      CACHE_DIR: process.env.TIKTOK_CACHE_DIR || '/data', path: pathE,
      readJson: (a, p) => { try { return JSON.parse(fsE.readFileSync(a, 'utf8')); } catch (e) { return p; } },
      writeJson: (a, v) => { try { fsE.mkdirSync(pathE.dirname(a), { recursive: true }); } catch (e) {} fsE.writeFileSync(a, JSON.stringify(v, null, 2)); },
      chamar: require('./tiktok-oauth').chamar,
    };
    /* a loja no TikTok é o próprio nome da empresa (env TIKTOK_LOJAS) */
    const passos = [
      { nome: 'cancelamentos do Magalu', rodar: async (e, d) => {
          const m = require('./magalu-oauth');
          /* Codex #307: passa o seller da empresa — o <EMPRESA>_MAGALU_SELLER que criei não
             tinha efeito nenhum porque ninguém o usava. */
          const r = await m.coletarCancelados(e, d, { seller: require('./lib/empresas').sellerMagalu(e) });
          return { ok: r.ok, erro: r.erro, resumo: r.vistos + ' visto(s), ' + r.novos + ' novo(s)' };
      } },
      { nome: 'financeiro do TikTok', rodar: async (e, d) => {
          const fin = require('./lib/tiktok-financeiro');
          const r = await fin.coletarFinanceiro(ctxTk, e, d, {});
          return { ok: !r.erro, erro: r.erro, resumo: r.pedidos_novos + ' pedido(s) novo(s)' };
      } },
      { nome: 'devoluções do TikTok', rodar: async (e, d) => {
          const fin = require('./lib/tiktok-financeiro');
          const r = await fin.coletarDevolucoesTikTok(ctxTk, e, d);
          return { ok: !r.erro, erro: r.erro, resumo: r.vistas + ' vista(s), ' + r.novas + ' nova(s)' };
      } },
    ];
    /* roda em BACKGROUND: o embarque leva minutos e o navegador desistiria antes */
    const idEmb = Date.now().toString(36);
    if (!global.__embarques) global.__embarques = {};
    global.__embarques[empresa] = { id: idEmb, estado: 'rodando', iniciado: new Date().toISOString() };
    emb.embarcar(empresa, passos, { dias: urlObj.searchParams.get('dias'), forcar: urlObj.searchParams.get('forcar') === '1' })
      .then(r => { global.__embarques[empresa] = Object.assign({ id: idEmb, estado: r.ok ? 'ok' : 'com falhas', terminado: new Date().toISOString() }, r); })
      .catch(e => { global.__embarques[empresa] = { id: idEmb, estado: 'erro', erro: String(e.message || e).slice(0, 160) }; });
    json(res, 202, { ok: true, empresa, em_background: true,
      acompanhe: '/embarcar/status?empresa=' + empresa + '&k=SUA_ADMIN_KEY',
      conferencia: emb.conferir(empresa) });
    return;
  }
  if (path === '/embarcar/status') {
    if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) { json(res, 404, { error: 'not found' }); return; }
    const empresa = String(urlObj.searchParams.get('empresa') || '').toLowerCase().trim();
    const st = (global.__embarques || {})[empresa];
    json(res, 200, st || { ok: false, erro: 'nenhum embarque para ' + empresa + ' neste processo' });
    return;
  }

  if (path.startsWith('/tiktok/')) {
    if (path !== '/tiktok/callback') {
      if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) {
        return json(res, 404, { error: 'not found', path });
      }
    }
    try {
      const tratou = await tiktokOauth.tratar(req, res, urlObj, json);
      if (tratou) return;
    } catch (e) {
      console.error('[tiktok-oauth] erro:', e.message);
      return json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) });
    }
    return json(res, 404, { error: 'not found', path });
  }

  // ── TikTok ADS (18/08) — API for Business, app SEPARADO do Shop ────────────────
  if (path.startsWith('/tiktok-ads/')) {
    if (path !== '/tiktok-ads/callback') {
      if (!ADMIN_KEY || urlObj.searchParams.get('k') !== ADMIN_KEY) {
        return json(res, 404, { error: 'not found', path });
      }
    }
    try {
      const tratou = await tiktokAds.tratar(req, res, urlObj, json);
      if (tratou) return;
    } catch (e) {
      console.error('[tiktok-ads] erro:', e.message);
      return json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) });
    }
    return json(res, 404, { error: 'not found', path });
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
  /* Canário de tokens Bling: 1a checagem 5 min após o boot, depois 1x/dia. Renova de
     verdade — arquivo existir não prova que o Bling ainda aceita o refresh. */
  /* 29/08: renovação automática dos tokens do TikTok — não existia, e por isso as 3 lojas
     venceram sozinhas em datas diferentes (22, 24 e 27/08). */
  /* Codex #307: coletas diárias por EMPRESA (não por checkout) — sem isto, empresa nova
     ficava sem coleta depois do embarque. Roda 10 min após o boot e a cada 24h. */
  try {
    const rodarColetas = async () => {
      const empresas = require('./lib/empresas').lista();
      const feito = { em: new Date().toISOString(), empresas: {} };
      for (const emp of empresas) {
        const r = {};
        try {
          const mag = require('./magalu-oauth');
          const x = await mag.coletarCancelados(emp, Number(process.env.MAGALU_CANCELADOS_DIAS) || 120, { seller: require('./lib/empresas').sellerMagalu(emp) });
          r.magalu = x.ok ? (x.vistos + ' visto(s)') : ('falhou: ' + x.erro);
        } catch (e) { r.magalu = 'erro: ' + String(e.message || e).slice(0, 80); }
        feito.empresas[emp] = r;
        await new Promise(s => setTimeout(s, 1000));
      }
      global.__coletasDiarias = feito;
      console.log('[coletas diarias]', JSON.stringify(feito).slice(0, 200));
    };
    setTimeout(() => rodarColetas().catch(e => console.error('[coletas diarias]', e.message)), 10 * 60000);
    setInterval(() => rodarColetas().catch(e => console.error('[coletas diarias]', e.message)), 24 * 3600000);
    console.log('[coletas diarias] agendadas (boot + 24h)');
  } catch (e) { console.error('[coletas diarias] nao iniciou:', e.message); }

  try { require('./tiktok-oauth').agendarRenovacaoTikTok(); console.log('[tiktok renovacao] agendada (boot + 6h)'); }
  catch (e) { console.error('[tiktok renovacao] nao iniciou:', e.message); }

  try { require('./lib/canario-tokens').iniciar(); console.log('[canario-tokens] agendado'); }
  catch (e) { console.error('[canario-tokens] nao iniciou:', e.message); }

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

// Rede de segurança p/ operacao desassistida: uma promise rejeitada nao tratada
// NAO derruba mais o processo (Node 22 mataria) — so loga e o servico segue de pe.
process.on('unhandledRejection', (e) => { console.error('[server] unhandledRejection (ignorado p/ nao derrubar):', (e && e.message) || e); });
