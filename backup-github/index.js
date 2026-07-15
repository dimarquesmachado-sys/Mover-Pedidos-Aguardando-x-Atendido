// ════════════════════════════════════════════════════════════════════════════
//  BACKUP-GITHUB — backup diário do disco /data pro GitHub (repo privado)
//  via GITHUB RELEASES (aguenta até 2GB por arquivo, ao contrário da API de
//  conteúdo que trava em ~50MB).
// ────────────────────────────────────────────────────────────────────────────
//  Por que existe: TODO o estado do serviço mora no disco /data (tokens Bling/ML
//  das 3 empresas, cache dos checkouts, conferidos, histórico, reenvios, mapas
//  Madeira, ponto...). É um disco ÚNICO no Render. Se corromper/sumir, a
//  reconstrução leva dias (re-autorizar token por token, da China).
//
//  DOIS MODOS de backup:
//   • COMPLETO  → zipa o /data inteiro (cache de etiquetas incluso). Pesado, mas
//                 restauração 100%. É o do cron diário (default).
//   • ESSENCIAL → só o que NÃO se regenera sozinho (tokens, conferidos, histórico,
//                 mapas, natureza, respostas). Uns poucos MB. Exclui o cache de
//                 etiquetas/DANFE (que o sistema rebaixa do Bling/ML sozinho).
//                 Use /backup-github/run?tipo=essencial pra um backup levinho.
//
//  ENVS (o token NUNCA fica no código — só no Render):
//    BACKUP_GITHUB_TOKEN   → PAT (fine-grained) com Contents:Read/Write NO REPO DE BACKUP
//    BACKUP_GITHUB_REPO    → "dono/repo" (default: dimarquesmachado-sys/Backup-Mover-Pedidos)
//    BACKUP_GITHUB_BRANCH  → branch alvo das tags (default: main)
//    BACKUP_APELIDO        → prefixo (default: checkout) → checkout-backup-2026-07-15.tar.gz
//    BACKUP_DATA_DIR       → o que zipar (default /data)
//    BACKUP_RETENCAO_DIAS  → quantos manter (default 30)
//    BACKUP_CRON           → horário (default '0 3 * * *' = 03:00 America/Sao_Paulo)
//    BACKUP_TIPO_CRON      → 'completo' (default) ou 'essencial' — o que o cron diário faz
//    BACKUP_EXCLUIR        → padrões extras pra excluir (separados por vírgula)
//
//  Rotas (atrás da trava ADMIN_KEY do root — exigem ?k=ADMIN_KEY):
//    GET /backup-github/health              → status
//    GET /backup-github/testar             → confere token/repo (sem gravar)
//    GET /backup-github/run                → backup COMPLETO agora
//    GET /backup-github/run?tipo=essencial → backup ESSENCIAL agora (levinho)
//    GET /backup-github/listar             → lista os backups (releases) do repo
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
const TIPO_CRON     = (process.env.BACKUP_TIPO_CRON || 'completo').toLowerCase() === 'essencial' ? 'essencial' : 'completo';
const APELIDO       = (process.env.BACKUP_APELIDO || 'checkout').replace(/[^a-z0-9_-]/gi, '');
const REPO          = process.env.BACKUP_GITHUB_REPO || 'dimarquesmachado-sys/Backup-Mover-Pedidos';
const BRANCH        = process.env.BACKUP_GITHUB_BRANCH || 'main';
const PREFIXO       = APELIDO + '-backup-';

// cache que se REGENERA sozinho (etiquetas ZPL/PDF, DANFEs, docs de finalizados).
// No modo ESSENCIAL isso fica de fora — é o que pesa e não precisa de backup.
const EXCLUIR_ESSENCIAL = ['cache-offline', 'arquivo-girassol', 'arquivo-good', 'arquivo-ambtotal'];
const EXCLUIR_EXTRA = (process.env.BACKUP_EXCLUIR || '').split(',').map(s => s.trim()).filter(Boolean);

let ultimo = { em: null, ok: null, tipo: null, arquivo: null, tamanho_mb: null, erro: null, apagados: 0 };

function token() { return process.env.BACKUP_GITHUB_TOKEN || ''; }
function estaConfigurado() { return !!token() && !!REPO; }
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
function headers(extra) {
  return Object.assign({ 'Authorization': 'token ' + token(), 'Accept': 'application/vnd.github+json', 'User-Agent': 'mover-pedidos-backup' }, extra || {});
}
function dataDeHoje() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
}

// ── zipa o /data num .tar.gz temporário ─────────────────────────────────────
function gerarTar(tipo) {
  if (!fs.existsSync(DATA_DIR)) throw new Error('diretório ' + DATA_DIR + ' não existe');
  const nome = APELIDO + '-' + (tipo === 'essencial' ? 'essencial' : 'backup') + '-' + dataDeHoje() + '.tar.gz';
  const destino = path.join(os.tmpdir(), nome);
  const pai = path.dirname(DATA_DIR);
  const base = path.basename(DATA_DIR);
  const args = ['--exclude=*.tmp', '--exclude=*.log', '--exclude=lost+found'];
  if (tipo === 'essencial') for (const e of EXCLUIR_ESSENCIAL) args.push('--exclude=' + base + '/' + e);
  for (const e of EXCLUIR_EXTRA) args.push('--exclude=' + e);
  args.push('-czf', destino, '-C', pai, base);
  const r = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('falha no tar: ' + String(r.stderr || r.error || '').slice(0, 300));
  return { destino, nome, tamanho: fs.statSync(destino).size };
}

// ── GitHub Releases API ─────────────────────────────────────────────────────
async function ghJson(method, url, body) {
  const r = await fetch(url, { method, headers: headers({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
  const b = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, body: b };
}

// cria (ou reusa) uma release com a tag do dia
async function garantirRelease(tag) {
  let r = await ghJson('GET', `${API}/repos/${REPO}/releases/tags/${tag}`);
  if (r.status === 200 && r.body && r.body.id) return r.body;
  r = await ghJson('POST', `${API}/repos/${REPO}/releases`, {
    tag_name: tag, target_commitish: BRANCH, name: 'Backup ' + tag,
    body: 'Backup automático do /data — ' + tag, draft: false, prerelease: false
  });
  if (!r.ok) throw new Error('criar release ' + r.status + ': ' + ((r.body && r.body.message) || '') + (r.body && r.body.errors ? ' — ' + JSON.stringify(r.body.errors) : ''));
  return r.body;
}

// remove um asset (se já existir com o mesmo nome, pra sobrescrever num 2º run no dia)
async function apagarAssetSeExiste(release, nomeAsset) {
  const assets = (release && release.assets) || [];
  for (const a of assets) {
    if (a.name === nomeAsset) {
      await fetch(`${API}/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE', headers: headers() }).catch(() => {});
    }
  }
}

// faz upload binário do arquivo pro release (endpoint uploads.github.com, aguenta arquivos grandes)
async function subirAsset(release, caminhoLocal, nomeAsset) {
  const url = `${UPLOADS}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(nomeAsset)}`;
  const stat = fs.statSync(caminhoLocal);
  const r = await fetch(url, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/gzip', 'Content-Length': String(stat.size) }),
    body: fs.createReadStream(caminhoLocal)
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error('upload asset ' + r.status + ': ' + ((b && b.message) || 'erro'));
  return b;
}

// lista releases de backup (tags que começam com o prefixo do apelido)
async function listarReleases() {
  const r = await ghJson('GET', `${API}/repos/${REPO}/releases?per_page=100`);
  if (!Array.isArray(r.body)) return [];
  return r.body.filter(rel => (rel.tag_name || '').startsWith(PREFIXO));
}

// apaga releases (e suas tags) além da retenção — pela data na tag
async function limparAntigos() {
  const rels = await listarReleases();
  const corte = new Date(Date.now() - RETENCAO_DIAS * 86400000).toISOString().slice(0, 10);
  let apagados = 0;
  for (const rel of rels) {
    const m = (rel.tag_name || '').match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] < corte) {
      try {
        await fetch(`${API}/repos/${REPO}/releases/${rel.id}`, { method: 'DELETE', headers: headers() });
        await fetch(`${API}/repos/${REPO}/git/refs/tags/${rel.tag_name}`, { method: 'DELETE', headers: headers() }).catch(() => {});
        apagados++;
      } catch (e) { console.log('[BACKUP-GH] não apagou release ' + rel.tag_name + ': ' + e.message); }
    }
  }
  return apagados;
}

// ── o backup completo ───────────────────────────────────────────────────────
async function rodarBackup(origem, tipo) {
  tipo = tipo === 'essencial' ? 'essencial' : 'completo';
  const t0 = Date.now();
  console.log('[BACKUP-GH] iniciando ' + tipo + ' (' + origem + ')...');
  if (!estaConfigurado()) {
    ultimo = { em: new Date().toISOString(), ok: false, tipo, erro: 'não configurado — falta BACKUP_GITHUB_TOKEN', apagados: 0, arquivo: null, tamanho_mb: null };
    console.log('[BACKUP-GH] ✗ ' + ultimo.erro);
    return ultimo;
  }
  let tar = null;
  try {
    tar = gerarTar(tipo);
    const mb = tar.tamanho / 1048576;
    console.log('[BACKUP-GH] tar ' + tipo + ': ' + tar.nome + ' (' + mb.toFixed(1) + ' MB)');
    if (mb > 2000) throw new Error('backup de ' + mb.toFixed(0) + ' MB passou de 2GB (limite do GitHub Releases). Use tipo=essencial ou storage externo.');
    const tag = PREFIXO + dataDeHoje() + (tipo === 'essencial' ? '-ess' : '');
    const release = await garantirRelease(tag);
    await apagarAssetSeExiste(release, tar.nome);
    await subirAsset(release, tar.destino, tar.nome);
    const apagados = await limparAntigos().catch(() => 0);
    ultimo = { em: new Date().toISOString(), ok: true, tipo, arquivo: tar.nome, tamanho_mb: +mb.toFixed(1), erro: null, apagados, duracao_s: +((Date.now() - t0) / 1000).toFixed(1) };
    console.log('[BACKUP-GH] ✓ ' + tag + ' · ' + tar.nome + ' · ' + ultimo.tamanho_mb + ' MB · ' + apagados + ' antigo(s) apagado(s) · ' + ultimo.duracao_s + 's');
  } catch (e) {
    const msg = String(e.message || e);
    const auth = /401|403|Bad credentials|Not Found|404/i.test(msg);
    ultimo = { em: new Date().toISOString(), ok: false, tipo, arquivo: tar ? tar.nome : null, tamanho_mb: null, apagados: 0,
      erro: auth ? 'GitHub recusou (' + msg + ') — token válido? Contents:Read/Write? repo ' + REPO + '?' : msg };
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
      json(200, { modulo: 'backup-github', dica: 'use /backup-github/health, /testar, /run (?tipo=essencial), /listar — todas com ?k=ADMIN_KEY' });
      return true;
    }

    if (method === 'GET' && p === '/backup-github/health') {
      json(200, {
        ok: true, modulo: 'backup-github', via: 'GitHub Releases (até 2GB)',
        configurado: estaConfigurado(),
        repo: REPO, branch: BRANCH, apelido: APELIDO,
        data_dir: DATA_DIR, retencao_dias: RETENCAO_DIAS,
        agenda: CRON_EXPR + ' (America/Sao_Paulo) · tipo do cron: ' + TIPO_CRON,
        exclui_no_essencial: EXCLUIR_ESSENCIAL,
        token_presente: !!token(),
        ultimo_backup: ultimo
      });
      return true;
    }

    if (method === 'GET' && p === '/backup-github/testar') {
      if (!token()) { json(200, { ok: false, erro: 'BACKUP_GITHUB_TOKEN não configurado' }); return true; }
      try {
        const r = await ghJson('GET', `${API}/repos/${REPO}`);
        if (r.status === 200) json(200, { ok: true, mensagem: '✅ token OK e enxerga o repo ' + REPO, privado: r.body && r.body.private, branch_padrao: r.body && r.body.default_branch });
        else if (r.status === 404) json(200, { ok: false, erro: '❌ repo ' + REPO + ' não encontrado (nome errado? token sem acesso a ESTE repo?)' });
        else if (r.status === 401) json(200, { ok: false, erro: '❌ token inválido/expirado (401 Bad credentials)' });
        else json(200, { ok: false, erro: '❌ GitHub retornou ' + r.status + ': ' + ((r.body && r.body.message) || '') });
      } catch (e) { json(200, { ok: false, erro: String(e.message || e) }); }
      return true;
    }

    if ((method === 'POST' || method === 'GET') && p === '/backup-github/run') {
      const tipo = (urlObj.searchParams.get('tipo') || '').toLowerCase() === 'essencial' ? 'essencial' : 'completo';
      const r = await rodarBackup('manual', tipo);
      json(r.ok ? 200 : 500, r);
      return true;
    }

    if (method === 'GET' && p === '/backup-github/listar') {
      if (!estaConfigurado()) { json(200, { ok: false, erro: 'não configurado' }); return true; }
      try {
        const rels = await listarReleases();
        const backups = [];
        for (const rel of rels) for (const a of (rel.assets || [])) backups.push({ tag: rel.tag_name, nome: a.name, tamanho_mb: a.size ? +(a.size / 1048576).toFixed(1) : null, criado: a.created_at });
        json(200, { ok: true, total: backups.length, repo: REPO, retencao_dias: RETENCAO_DIAS, backups });
      } catch (e) { json(500, { ok: false, erro: String(e.message || e) }); }
      return true;
    }

    return false;
  };
}

function bootstrap() {
  if (estaConfigurado()) console.log('[BACKUP-GH] configurado ✓ (via Releases) — repo ' + REPO + ' · apelido "' + APELIDO + '" · retenção ' + RETENCAO_DIAS + 'd · cron "' + CRON_EXPR + '" tipo=' + TIPO_CRON);
  else console.log('[BACKUP-GH] ⚠ NÃO configurado — defina BACKUP_GITHUB_TOKEN. Backup diário inativo até lá.');
}

module.exports = {
  id: 'backup-github',
  nome: 'Backup do /data (GitHub)',
  rotinas: { rodarBackup: () => rodarBackup('cron', TIPO_CRON) },
  routes,
  crons: { rodarBackup: CRON_EXPR },
  bootstrap
};
