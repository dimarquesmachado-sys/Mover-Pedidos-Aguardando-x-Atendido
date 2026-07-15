// ════════════════════════════════════════════════════════════════════════════
//  BACKUP-GITHUB — backup diário do disco /data pro GitHub (repo privado)
// ────────────────────────────────────────────────────────────────────────────
//  Por que existe: TODO o estado do serviço mora no disco /data (tokens Bling/ML
//  das 3 empresas, cache dos checkouts, conferidos, histórico, reenvios, mapas
//  Madeira, ponto...). É um disco ÚNICO no Render. Se corromper/sumir, a
//  reconstrução leva dias (re-autorizar token por token, da China). Este módulo
//  zipa o /data todo dia de madrugada e faz commit num repo PRIVADO separado,
//  com retenção automática (apaga backups além de N dias).
//
//  Escolhemos GitHub porque: já é usado no dia a dia, é grátis, não tem a
//  limitação de cota das contas de serviço do Google Drive, e o histórico de
//  commits já serve de linha do tempo dos backups.
//
//  ENVS (o token NUNCA fica no código — só no Render):
//    BACKUP_GITHUB_TOKEN   → Personal Access Token (fine-grained) com Contents:Read/Write NO REPO DE BACKUP
//    BACKUP_GITHUB_REPO    → "dono/repo" do depósito (default: dimarquesmachado-sys/Backup-Mover-Pedidos)
//    BACKUP_GITHUB_BRANCH  → branch (default: main)
//    BACKUP_APELIDO        → prefixo do arquivo (default: checkout) → checkout-backup-2026-07-15.tar.gz
//    BACKUP_DATA_DIR       → o que zipar (default /data)
//    BACKUP_RETENCAO_DIAS  → quantos manter (default 30)
//    BACKUP_CRON           → horário (default '0 3 * * *' = 03:00 America/Sao_Paulo)
//
//  Rotas (atrás da trava ADMIN_KEY do root — exigem ?k=ADMIN_KEY):
//    GET /backup-github/health   → status (configurado? repo? último backup? tamanho?)
//    GET /backup-github/testar   → confere que o token enxerga o repo (sem gravar nada)
//    GET /backup-github/run      → dispara um backup AGORA
//    GET /backup-github/listar   → lista os backups que estão no repo
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fetch = require('node-fetch');

const DATA_DIR      = process.env.BACKUP_DATA_DIR || '/data';
const RETENCAO_DIAS = Number(process.env.BACKUP_RETENCAO_DIAS || 30);
const CRON_EXPR     = process.env.BACKUP_CRON || '0 3 * * *';
const APELIDO       = (process.env.BACKUP_APELIDO || 'checkout').replace(/[^a-z0-9_-]/gi, '');
const REPO          = process.env.BACKUP_GITHUB_REPO || 'dimarquesmachado-sys/Backup-Mover-Pedidos';
const BRANCH        = process.env.BACKUP_GITHUB_BRANCH || 'main';
const PREFIXO       = APELIDO + '-backup-';         // ex: checkout-backup-2026-07-15.tar.gz
const PASTA_REPO    = 'backups';                     // subpasta dentro do repo
const LIMITE_MB     = 45;                            // API /contents ~ até 50MB; margem de segurança

let ultimo = { em: null, ok: null, arquivo: null, tamanho_mb: null, erro: null, apagados: 0 };

function token() { return process.env.BACKUP_GITHUB_TOKEN || ''; }
function estaConfigurado() { return !!token() && !!REPO; }
const API = 'https://api.github.com';
function headers() {
  return { 'Authorization': 'token ' + token(), 'Accept': 'application/vnd.github+json', 'User-Agent': 'mover-pedidos-backup' };
}

// ── data AAAA-MM-DD no fuso de SP (independe do fuso do servidor) ────────────
function dataDeHoje() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
}

// ── zipa o /data num .tar.gz temporário (exclui descartáveis) ───────────────
function gerarTar() {
  if (!fs.existsSync(DATA_DIR)) throw new Error('diretório ' + DATA_DIR + ' não existe');
  const nome = PREFIXO + dataDeHoje() + '.tar.gz';
  const destino = path.join(os.tmpdir(), nome);
  const pai = path.dirname(DATA_DIR);
  const base = path.basename(DATA_DIR);
  const r = spawnSync('tar', [
    '--exclude=*.tmp', '--exclude=*.log', '--exclude=lost+found',
    '-czf', destino, '-C', pai, base
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('falha no tar: ' + String(r.stderr || r.error || '').slice(0, 300));
  return { destino, nome, tamanho: fs.statSync(destino).size };
}

// ── GitHub API helpers ──────────────────────────────────────────────────────
async function ghGet(url) {
  const r = await fetch(url, { headers: headers() });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}
// PUT /contents cria OU atualiza um arquivo (precisa do sha se já existir)
async function ghPut(caminhoRepo, contentB64, mensagem, sha) {
  const url = `${API}/repos/${REPO}/contents/${caminhoRepo}`;
  const corpo = { message: mensagem, content: contentB64, branch: BRANCH };
  if (sha) corpo.sha = sha;
  const r = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(corpo) });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error('GitHub PUT ' + r.status + ': ' + ((b && b.message) || 'erro') + (b && b.errors ? ' — ' + JSON.stringify(b.errors) : ''));
  return b;
}
async function ghDelete(caminhoRepo, sha, mensagem) {
  const url = `${API}/repos/${REPO}/contents/${caminhoRepo}`;
  const r = await fetch(url, { method: 'DELETE', headers: headers(), body: JSON.stringify({ message: mensagem, sha, branch: BRANCH }) });
  if (!r.ok) { const b = await r.json().catch(() => null); throw new Error('GitHub DELETE ' + r.status + ': ' + ((b && b.message) || 'erro')); }
  return true;
}
// lista a subpasta de backups (retorna [] se a pasta ainda não existe)
async function listarBackups() {
  const { status, body } = await ghGet(`${API}/repos/${REPO}/contents/${PASTA_REPO}?ref=${BRANCH}`);
  if (status === 404) return [];
  if (!Array.isArray(body)) return [];
  return body
    .filter(f => f.type === 'file' && f.name.startsWith(PREFIXO))
    .map(f => ({ name: f.name, sha: f.sha, size: f.size, path: f.path }));
}

// ── apaga os que passaram da retenção (pela DATA no nome do arquivo) ─────────
async function limparAntigos() {
  const arquivos = await listarBackups();
  const corte = new Date(Date.now() - RETENCAO_DIAS * 86400000).toISOString().slice(0, 10);
  let apagados = 0;
  for (const f of arquivos) {
    const m = f.name.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] < corte) {
      try { await ghDelete(f.path, f.sha, 'retenção: remove backup antigo ' + f.name); apagados++; }
      catch (e) { console.log('[BACKUP-GH] não apagou ' + f.name + ': ' + e.message); }
    }
  }
  return apagados;
}

// ── o backup completo ───────────────────────────────────────────────────────
async function rodarBackup(origem) {
  const t0 = Date.now();
  console.log('[BACKUP-GH] iniciando (' + origem + ')...');
  if (!estaConfigurado()) {
    ultimo = { em: new Date().toISOString(), ok: false, erro: 'não configurado — falta BACKUP_GITHUB_TOKEN', apagados: 0, arquivo: null, tamanho_mb: null };
    console.log('[BACKUP-GH] ✗ ' + ultimo.erro);
    return ultimo;
  }
  let tar = null;
  try {
    tar = gerarTar();
    const mb = tar.tamanho / 1048576;
    console.log('[BACKUP-GH] tar: ' + tar.nome + ' (' + mb.toFixed(1) + ' MB)');
    if (mb > LIMITE_MB) throw new Error('backup de ' + mb.toFixed(1) + ' MB passou do limite da API do GitHub (' + LIMITE_MB + ' MB). Reduza o /data (ex: limpar cache antigo) ou migre pra GitHub Releases/storage externo.');
    const b64 = fs.readFileSync(tar.destino).toString('base64');
    const caminhoRepo = PASTA_REPO + '/' + tar.nome;
    // se já existe backup com o mesmo nome (rodou 2x no dia), pega o sha pra sobrescrever
    let sha = null;
    const j = await ghGet(`${API}/repos/${REPO}/contents/${caminhoRepo}?ref=${BRANCH}`);
    if (j.status === 200 && j.body && j.body.sha) sha = j.body.sha;
    await ghPut(caminhoRepo, b64, 'backup ' + APELIDO + ' ' + dataDeHoje() + ' (' + mb.toFixed(1) + ' MB)', sha);
    const apagados = await limparAntigos().catch(() => 0);
    ultimo = { em: new Date().toISOString(), ok: true, arquivo: tar.nome, tamanho_mb: +mb.toFixed(1), erro: null, apagados, duracao_s: +((Date.now() - t0) / 1000).toFixed(1) };
    console.log('[BACKUP-GH] ✓ commit ' + tar.nome + ' · ' + ultimo.tamanho_mb + ' MB · ' + apagados + ' antigo(s) apagado(s) · ' + ultimo.duracao_s + 's');
  } catch (e) {
    const msg = String(e.message || e);
    const auth = /401|403|Bad credentials|Not Found|404/i.test(msg);
    ultimo = { em: new Date().toISOString(), ok: false, arquivo: tar ? tar.nome : null, tamanho_mb: null, apagados: 0,
      erro: auth ? 'GitHub recusou (' + msg + ') — confira: token válido? com Contents:Read/Write? no repo ' + REPO + '? branch ' + BRANCH + ' existe?' : msg };
    console.log('[BACKUP-GH] ✗ ' + ultimo.erro);
  } finally {
    if (tar && fs.existsSync(tar.destino)) { try { fs.unlinkSync(tar.destino); } catch (e) {} }
  }
  return ultimo;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    const method = req.method;
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };

    if (p === '/backup-github' || p === '/backup-github/') {
      json(200, { modulo: 'backup-github', dica: 'use /backup-github/health, /testar, /run, /listar (todas com ?k=ADMIN_KEY)' });
      return true;
    }

    if (method === 'GET' && p === '/backup-github/health') {
      json(200, {
        ok: true, modulo: 'backup-github',
        configurado: estaConfigurado(),
        repo: REPO, branch: BRANCH, apelido: APELIDO,
        data_dir: DATA_DIR, retencao_dias: RETENCAO_DIAS,
        agenda: CRON_EXPR + ' (America/Sao_Paulo)',
        token_presente: !!token(),
        ultimo_backup: ultimo
      });
      return true;
    }

    // testa o token/repo SEM gravar nada
    if (method === 'GET' && p === '/backup-github/testar') {
      if (!token()) { json(200, { ok: false, erro: 'BACKUP_GITHUB_TOKEN não configurado' }); return true; }
      try {
        const r = await ghGet(`${API}/repos/${REPO}`);
        if (r.status === 200) json(200, { ok: true, mensagem: '✅ token OK e enxerga o repo ' + REPO, privado: r.body && r.body.private, branch_padrao: r.body && r.body.default_branch });
        else if (r.status === 404) json(200, { ok: false, erro: '❌ repo ' + REPO + ' não encontrado (nome errado? token sem acesso a ESTE repo?)' });
        else if (r.status === 401) json(200, { ok: false, erro: '❌ token inválido/expirado (401 Bad credentials)' });
        else json(200, { ok: false, erro: '❌ GitHub retornou ' + r.status + ': ' + ((r.body && r.body.message) || '') });
      } catch (e) { json(200, { ok: false, erro: String(e.message || e) }); }
      return true;
    }

    if ((method === 'POST' || method === 'GET') && p === '/backup-github/run') {
      const r = await rodarBackup('manual');
      json(r.ok ? 200 : 500, r);
      return true;
    }

    if (method === 'GET' && p === '/backup-github/listar') {
      if (!estaConfigurado()) { json(200, { ok: false, erro: 'não configurado' }); return true; }
      try {
        const arquivos = await listarBackups();
        json(200, { ok: true, total: arquivos.length, repo: REPO, retencao_dias: RETENCAO_DIAS,
          backups: arquivos.map(f => ({ nome: f.name, tamanho_mb: f.size ? +(f.size / 1048576).toFixed(2) : null })) });
      } catch (e) { json(500, { ok: false, erro: String(e.message || e) }); }
      return true;
    }

    return false;
  };
}

function bootstrap() {
  if (estaConfigurado()) console.log('[BACKUP-GH] configurado ✓ — repo ' + REPO + ' (' + BRANCH + ') · apelido "' + APELIDO + '" · retenção ' + RETENCAO_DIAS + 'd · agenda "' + CRON_EXPR + '"');
  else console.log('[BACKUP-GH] ⚠ NÃO configurado — defina BACKUP_GITHUB_TOKEN. Backup diário inativo até lá.');
}

module.exports = {
  id: 'backup-github',
  nome: 'Backup do /data (GitHub)',
  rotinas: { rodarBackup: () => rodarBackup('cron') },
  routes,
  crons: { rodarBackup: CRON_EXPR },
  bootstrap
};
