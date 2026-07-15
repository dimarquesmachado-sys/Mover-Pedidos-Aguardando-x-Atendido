// ════════════════════════════════════════════════════════════════════════════
//  BACKUP-DRIVE — backup diário do disco /data pro Google Drive
// ────────────────────────────────────────────────────────────────────────────
//  Por que existe: TODO o estado do serviço mora no disco /data (tokens Bling/ML
//  das 3 empresas, cache dos checkouts, conferidos, histórico, reenvios, mapas
//  Madeira, ponto...). É um disco ÚNICO no Render. Se corromper/sumir, a
//  reconstrução leva dias (re-autorizar token por token, da China). Este módulo
//  zipa o /data todo dia de madrugada e sobe pro Drive, com retenção automática.
//
//  Reusa a MESMA conta de serviço Google do good-drive-imagens (já testada), mas
//  aceita credenciais próprias se quiser separar depois — troca só a env, sem código:
//    BACKUP_GOOGLE_SA_JSON   → SA própria; se vazio, cai no GOODIMG_GOOGLE_SA_JSON
//    BACKUP_DRIVE_FOLDER_ID  → pasta no Drive onde os zips vão (compartilhada c/ a SA)
//    BACKUP_DATA_DIR         → o que zipar (default /data)
//    BACKUP_RETENCAO_DIAS    → quantos manter (default 30)
//    BACKUP_CRON             → horário (default '0 3 * * *' = 03:00 America/Sao_Paulo)
//
//  Rotas (todas atrás da trava ADMIN_KEY do root — precisam de ?k=ADMIN_KEY):
//    GET /backup-drive/health        → status: configurado? último backup? SA? pasta?
//    GET /backup-drive/testar-escrita → sobe um arquivinho fake e apaga: prova que a SA
//                                       consegue escrever (pega o storageQuotaExceeded na hora)
//    GET /backup-drive/run           → dispara um backup AGORA (?k=ADMIN_KEY)
//    GET /backup-drive/listar        → lista os backups que estão no Drive
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { google } = require('googleapis');

const DATA_DIR      = process.env.BACKUP_DATA_DIR || '/data';
const RETENCAO_DIAS = Number(process.env.BACKUP_RETENCAO_DIAS || 30);
const CRON_EXPR     = process.env.BACKUP_CRON || '0 3 * * *';   // 03:00 (timezone do serviço = America/Sao_Paulo)
const PREFIXO       = 'data-backup-';                            // nome dos arquivos: data-backup-2026-07-15.tar.gz

// estado em memória (aparece no /health) — reflete o último backup desde o boot
let ultimo = { em: null, ok: null, arquivo: null, tamanho_mb: null, erro: null, apagados: 0 };

// ── Google Drive (mesmo padrão do good-drive-imagens) ───────────────────────
function saJson() {
  return process.env.BACKUP_GOOGLE_SA_JSON || process.env.GOODIMG_GOOGLE_SA_JSON || '';
}
function folderId() {
  return process.env.BACKUP_DRIVE_FOLDER_ID || '';
}
function estaConfigurado() {
  return !!saJson() && !!folderId();
}
let _drive = null;
function getDrive() {
  if (_drive) return _drive;
  const json = saJson();
  if (!json) throw new Error('conta de serviço não configurada (BACKUP_GOOGLE_SA_JSON ou GOODIMG_GOOGLE_SA_JSON)');
  let credentials;
  try { credentials = JSON.parse(json); }
  catch (e) { throw new Error('JSON da conta de serviço inválido: ' + e.message); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}
function emailDaSA() {
  try { return JSON.parse(saJson()).client_email || null; } catch (e) { return null; }
}

// ── monta o .tar.gz do /data num arquivo temporário ─────────────────────────
function dataDeHoje() {
  // AAAA-MM-DD no fuso America/Sao_Paulo (independe do fuso do servidor)
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return s.slice(0, 10);
}
function gerarTar() {
  if (!fs.existsSync(DATA_DIR)) throw new Error('diretório ' + DATA_DIR + ' não existe');
  const nome = PREFIXO + dataDeHoje() + '.tar.gz';
  const destino = path.join(os.tmpdir(), nome);
  // tar nativo: -C entra no pai e zipa a pasta (caminhos relativos, restauração limpa).
  // Exclui coisas descartáveis pra não inchar o zip.
  const pai = path.dirname(DATA_DIR);
  const base = path.basename(DATA_DIR);
  const r = spawnSync('tar', [
    '--exclude=*.tmp', '--exclude=*.log', '--exclude=lost+found',
    '-czf', destino, '-C', pai, base
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('falha no tar: ' + String(r.stderr || r.error || '').slice(0, 300));
  const tam = fs.statSync(destino).size;
  return { destino, nome, tamanho: tam };
}

// ── sobe um arquivo pro Drive ───────────────────────────────────────────────
async function subir(caminhoLocal, nome, mime) {
  const drive = getDrive();
  const resp = await drive.files.create({
    requestBody: { name: nome, parents: [folderId()] },
    media: { mimeType: mime || 'application/gzip', body: fs.createReadStream(caminhoLocal) },
    fields: 'id, name, size',
    supportsAllDrives: true   // funciona tanto em pasta pessoal compartilhada quanto em Shared Drive
  });
  return resp.data;
}

// ── lista os backups já no Drive (mais novos primeiro) ──────────────────────
async function listarBackups() {
  const drive = getDrive();
  const resp = await drive.files.list({
    q: `'${folderId()}' in parents and trashed = false and name contains '${PREFIXO}'`,
    fields: 'files(id, name, size, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return resp.data.files || [];
}

// ── apaga os que passaram da retenção ───────────────────────────────────────
async function limparAntigos() {
  const drive = getDrive();
  const arquivos = await listarBackups();
  const corte = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  let apagados = 0;
  for (const f of arquivos) {
    if (new Date(f.createdTime).getTime() < corte) {
      try { await drive.files.delete({ fileId: f.id, supportsAllDrives: true }); apagados++; }
      catch (e) { console.log('[BACKUP] não consegui apagar ' + f.name + ': ' + e.message); }
    }
  }
  return apagados;
}

// ── o backup completo: zipa → sobe → limpa → registra ───────────────────────
async function rodarBackup(origem) {
  const t0 = Date.now();
  console.log('[BACKUP] iniciando (' + origem + ')...');
  if (!estaConfigurado()) {
    ultimo = { em: new Date().toISOString(), ok: false, arquivo: null, tamanho_mb: null,
      erro: 'não configurado — faltam BACKUP_DRIVE_FOLDER_ID e/ou a conta de serviço', apagados: 0 };
    console.log('[BACKUP] ✗ ' + ultimo.erro);
    return ultimo;
  }
  let tar = null;
  try {
    tar = gerarTar();
    console.log('[BACKUP] tar gerado: ' + tar.nome + ' (' + (tar.tamanho / 1048576).toFixed(1) + ' MB)');
    await subir(tar.destino, tar.nome);
    const apagados = await limparAntigos().catch(() => 0);
    ultimo = {
      em: new Date().toISOString(), ok: true, arquivo: tar.nome,
      tamanho_mb: +(tar.tamanho / 1048576).toFixed(1), erro: null, apagados,
      duracao_s: +((Date.now() - t0) / 1000).toFixed(1)
    };
    console.log('[BACKUP] ✓ enviado ' + tar.nome + ' · ' + ultimo.tamanho_mb + ' MB · ' + apagados + ' antigo(s) apagado(s) · ' + ultimo.duracao_s + 's');
  } catch (e) {
    const msg = String(e.message || e);
    const cota = /storageQuota|quotaExceeded/i.test(msg);
    ultimo = { em: new Date().toISOString(), ok: false, arquivo: tar ? tar.nome : null, tamanho_mb: null,
      erro: cota ? 'SEM COTA na conta de serviço (storageQuotaExceeded) — a pasta precisa ser um Shared Drive, OU compartilhe uma pasta do seu Drive pessoal com a SA como Editor. Detalhe: ' + msg : msg,
      apagados: 0 };
    console.log('[BACKUP] ✗ ' + ultimo.erro);
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

    // raiz → aponta pro health
    if (p === '/backup-drive' || p === '/backup-drive/') {
      json(200, { modulo: 'backup-drive', dica: 'use /backup-drive/health, /testar-escrita, /run, /listar (todas com ?k=ADMIN_KEY)' });
      return true;
    }

    // status geral — não expõe segredo nenhum
    if (method === 'GET' && p === '/backup-drive/health') {
      json(200, {
        ok: true, modulo: 'backup-drive',
        configurado: estaConfigurado(),
        conta_servico_email: emailDaSA(),               // pra você compartilhar a pasta com ela
        usando_sa_propria: !!process.env.BACKUP_GOOGLE_SA_JSON,
        pasta_drive_id: folderId() || null,
        data_dir: DATA_DIR,
        retencao_dias: RETENCAO_DIAS,
        agenda: CRON_EXPR + ' (America/Sao_Paulo)',
        ultimo_backup: ultimo
      });
      return true;
    }

    // TESTE de escrita — sobe um arquivinho fake e apaga. Descobre o storageQuotaExceeded em 10s.
    if (method === 'GET' && p === '/backup-drive/testar-escrita') {
      if (!estaConfigurado()) { json(200, { ok: false, erro: 'não configurado (BACKUP_DRIVE_FOLDER_ID + conta de serviço)' }); return true; }
      try {
        const tmp = path.join(os.tmpdir(), 'teste-backup.txt');
        fs.writeFileSync(tmp, 'teste de escrita do backup-drive em ' + new Date().toISOString());
        const f = await subir(tmp, 'TESTE-backup-' + Date.now() + '.txt', 'text/plain');
        try { fs.unlinkSync(tmp); } catch (e) {}
        try { await getDrive().files.delete({ fileId: f.id, supportsAllDrives: true }); } catch (e) {}
        json(200, { ok: true, mensagem: '✅ A conta de serviço CONSEGUE escrever na pasta. Backup vai funcionar.', arquivo_teste_id: f.id });
      } catch (e) {
        const msg = String(e.message || e);
        const cota = /storageQuota|quotaExceeded/i.test(msg);
        json(200, { ok: false, cota_zero: cota,
          erro: cota ? '❌ storageQuotaExceeded — a conta de serviço não tem cota. Solução: usar um Shared Drive, ou garantir que a pasta do seu Drive pessoal está compartilhada com a SA como EDITOR.' : '❌ ' + msg });
      }
      return true;
    }

    // dispara backup AGORA
    if ((method === 'POST' || method === 'GET') && p === '/backup-drive/run') {
      const r = await rodarBackup('manual');
      json(r.ok ? 200 : 500, r);
      return true;
    }

    // lista o que está no Drive
    if (method === 'GET' && p === '/backup-drive/listar') {
      if (!estaConfigurado()) { json(200, { ok: false, erro: 'não configurado' }); return true; }
      try {
        const arquivos = await listarBackups();
        json(200, { ok: true, total: arquivos.length, retencao_dias: RETENCAO_DIAS,
          backups: arquivos.map(f => ({ nome: f.name, tamanho_mb: f.size ? +(f.size / 1048576).toFixed(1) : null, criado: f.createdTime })) });
      } catch (e) { json(500, { ok: false, erro: String(e.message || e) }); }
      return true;
    }

    return false; // não é rota deste módulo
  };
}

// bootstrap: avisa no log o estado ao subir
function bootstrap() {
  if (estaConfigurado()) {
    console.log('[BACKUP] configurado ✓ — pasta ' + folderId() + ' · retenção ' + RETENCAO_DIAS + 'd · agenda "' + CRON_EXPR + '"');
  } else {
    console.log('[BACKUP] ⚠ NÃO configurado — defina BACKUP_DRIVE_FOLDER_ID e a conta de serviço. Backup diário inativo até lá.');
  }
}

module.exports = {
  id: 'backup-drive',
  nome: 'Backup do /data (Drive)',
  rotinas: { rodarBackup: () => rodarBackup('cron') },
  routes,
  crons: { rodarBackup: CRON_EXPR },
  bootstrap
};
