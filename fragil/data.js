'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = process.env.FRAGIL_DATA_DIR || '/data/fragil';
const DATA_FILE     = path.join(DATA_DIR, 'skus.json');          // legado (lista unica, pre multi-empresa)
const USUARIOS_FILE = path.join(DATA_DIR, 'usuarios.json');

// 28/08: o Fragil virou POR EMPRESA (pedido do dono): lista, login e auditoria separados.
const EMPRESAS = ['girassol', 'good', 'ambtotal'];

function arquivoEmpresa(emp)   { return path.join(DATA_DIR, 'skus-' + emp + '.json'); }
function arquivoAuditoria(emp) { return path.join(DATA_DIR, 'auditoria-' + emp + '.jsonl'); }

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
    console.warn('[fragil/data] Erro ao criar dir:', e.message);
  }
}

// ── SKUs frageis ──────────────────────────────────────────────────────

function dadosPadrao() {
  return {
    config: {
      tempoMinimoSegundos: 2,
      mensagemPadrao: 'Atenção. Produto frágil. Embalar com plástico bolha e reforçar a caixa.',
      repetirVoz: false,
      velocidadeVoz: 1.2,
      nomeVoz: ''
    },
    skus: {},
    atualizadoEm: null,
    atualizadoPor: null
  };
}

function lerArquivo(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const padrao = dadosPadrao();
    return {
      config: { ...padrao.config, ...(obj.config || {}) },
      skus: obj.skus || {},
      atualizadoEm: obj.atualizadoEm || null,
      atualizadoPor: obj.atualizadoPor || null
    };
  } catch (e) {
    console.error('[fragil/data] Erro lendo', fp, ':', e.message);
    return null;
  }
}

/* MIGRACAO LAZY: na primeira leitura de uma empresa sem arquivo proprio, o skus.json legado
   (lista unica que rodava pras 3) e COPIADO pra ela — as 3 herdam a lista atual e o dono
   remove em cada painel o que nao for daquela empresa. O legado NAO e apagado (fica de
   backup e de fonte pra proxima empresa que migrar). */
function lerDados(empresa) {
  if (empresa && EMPRESAS.includes(empresa)) {
    const fp = arquivoEmpresa(empresa);
    /* Codex #240: migrar SO quando o arquivo NAO EXISTE. lerArquivo devolve null tambem pra
       arquivo presente mas ilegivel (parse quebrado, leitura interrompida) — nesse caso
       sobrescrever com o legado APAGARIA a lista da empresa; devolve padrao SEM regravar
       e deixa o arquivo no disco pra recuperacao manual. */
    if (!fs.existsSync(fp)) {
      const legado = lerArquivo(DATA_FILE);
      const dados = legado || dadosPadrao();
      try {
        fs.writeFileSync(fp, JSON.stringify(dados, null, 2), 'utf8');
        console.log('[fragil/data] migracao: ' + empresa + ' herdou ' + Object.keys(dados.skus).length + ' SKU(s) do legado');
      } catch (e) { console.error('[fragil/data] migracao falhou (' + empresa + '):', e.message); }
      return dados;
    }
    const dados = lerArquivo(fp);
    if (!dados) {
      console.error('[fragil/data] ' + fp + ' existe mas esta ilegivel — devolvendo padrao SEM sobrescrever (recupere o arquivo no disco).');
      return dadosPadrao();
    }
    return dados;
  }
  /* COMPAT (extensao antiga, sem ?empresa): a UNIAO das 3 — o alerta continua tocando pra
     qualquer SKU fragil. Codex #240 r2 (P1): empresa AINDA NAO migrada entra pela lista
     LEGADA — senao, assim que a primeira empresa migrasse e enxugasse sua lista, os SKUs
     das outras sumiriam da uniao e o alerta antigo silenciaria pra elas. */
  const uniao = dadosPadrao();
  const legado = lerArquivo(DATA_FILE);
  let temConfig = false;
  for (const emp of EMPRESAS) {
    const d2 = lerArquivo(arquivoEmpresa(emp)) || legado;
    if (!d2) continue;
    Object.assign(uniao.skus, d2.skus);
    if (!temConfig) { uniao.config = d2.config; temConfig = true; }
    if (d2.atualizadoEm && (!uniao.atualizadoEm || d2.atualizadoEm > uniao.atualizadoEm)) {
      uniao.atualizadoEm = d2.atualizadoEm; uniao.atualizadoPor = d2.atualizadoPor;
    }
  }
  return uniao;
}

function salvarDados(dados, usuario, empresa) {
  dados.atualizadoEm = new Date().toISOString();
  dados.atualizadoPor = usuario || null;
  const fp = (empresa && EMPRESAS.includes(empresa)) ? arquivoEmpresa(empresa) : DATA_FILE;
  fs.writeFileSync(fp, JSON.stringify(dados, null, 2), 'utf8');
  return dados;
}

// ── Auditoria (quem mudou o que, por empresa) ─────────────────────────
// Uma linha JSON por evento: {ts, usuario, acao, sku?, antes?, depois?, campo?}

function registrarAuditoria(empresa, entradas) {
  if (!empresa || !EMPRESAS.includes(empresa) || !entradas.length) return;
  try {
    const linhas = entradas.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(arquivoAuditoria(empresa), linhas, 'utf8');
  } catch (e) { console.error('[fragil/auditoria] falhou (' + empresa + '):', e.message); }
}

function lerAuditoria(empresa, limite) {
  if (!empresa || !EMPRESAS.includes(empresa)) return [];
  try {
    const fp = arquivoAuditoria(empresa);
    if (!fs.existsSync(fp)) return [];
    /* Codex #240: o jsonl e append-only e cresce pra sempre — ler o arquivo INTEIRO a cada
       consulta viraria custo crescente. Le so o rabo (ate 512 KB), mais que o bastante pros
       ate 2000 eventos que a rota devolve. */
    const st = fs.statSync(fp);
    const n0 = Math.max(1, Math.min(2000, parseInt(limite, 10) || 200));
    /* Codex #240 r2: janela proporcional ao pedido — evento de edicao carrega antes+depois
       (config de ate 500 chars dos dois lados ~1,5 KB); 2 KB por evento cobre com folga. */
    const TAIL = Math.max(512 * 1024, n0 * 2048);
    let bruto;
    if (st.size <= TAIL) {
      bruto = fs.readFileSync(fp, 'utf8');
    } else {
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(TAIL);
        fs.readSync(fd, buf, 0, TAIL, st.size - TAIL);
        bruto = buf.toString('utf8');
        const i = bruto.indexOf('\n');                 // descarta a linha cortada no inicio
        bruto = i >= 0 ? bruto.slice(i + 1) : bruto;
      } finally { fs.closeSync(fd); }
    }
    const linhas = bruto.trim().split('\n').filter(Boolean);
    const n = Math.max(1, Math.min(2000, parseInt(limite, 10) || 200));
    return linhas.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (e) {
    console.error('[fragil/auditoria] leitura falhou:', e.message);
    return [];
  }
}

// ── Usuarios (legado em disco — mantido só por compat de import) ──────

function lerUsuarios() {
  try {
    if (!fs.existsSync(USUARIOS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USUARIOS_FILE, 'utf8')) || [];
  } catch (e) {
    console.error('[fragil/data] Erro lendo usuarios:', e.message);
    return [];
  }
}

function salvarUsuarios(lista) {
  fs.writeFileSync(USUARIOS_FILE, JSON.stringify(lista, null, 2), 'utf8');
}

module.exports = {
  DATA_DIR, DATA_FILE, USUARIOS_FILE, EMPRESAS,
  dadosPadrao, lerDados, salvarDados,
  registrarAuditoria, lerAuditoria,
  lerUsuarios, salvarUsuarios
};
