'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.FRAGIL_DATA_DIR || '/data/fragil';
const DATA_FILE    = path.join(DATA_DIR, 'skus.json');
const USUARIOS_FILE = path.join(DATA_DIR, 'usuarios.json');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
    console.warn('[fragil/data] Erro ao criar dir:', e.message);
  }
}

// ── SKUs frágeis ──────────────────────────────────────────────────────

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

function lerDados() {
  try {
    if (!fs.existsSync(DATA_FILE)) return dadosPadrao();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const padrao = dadosPadrao();
    return {
      config: { ...padrao.config, ...(obj.config || {}) },
      skus: obj.skus || {},
      atualizadoEm: obj.atualizadoEm || null,
      atualizadoPor: obj.atualizadoPor || null
    };
  } catch (e) {
    console.error('[fragil/data] Erro lendo skus:', e.message);
    return dadosPadrao();
  }
}

function salvarDados(dados, usuario) {
  dados.atualizadoEm = new Date().toISOString();
  dados.atualizadoPor = usuario || null;
  fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2), 'utf8');
  return dados;
}

// ── Usuários ──────────────────────────────────────────────────────────

function lerUsuarios() {
  try {
    if (!fs.existsSync(USUARIOS_FILE)) return [];
    const raw = fs.readFileSync(USUARIOS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('[fragil/data] Erro lendo usuarios:', e.message);
    return [];
  }
}

function salvarUsuarios(lista) {
  fs.writeFileSync(USUARIOS_FILE, JSON.stringify(lista, null, 2), 'utf8');
}

module.exports = {
  DATA_DIR, DATA_FILE, USUARIOS_FILE,
  dadosPadrao, lerDados, salvarDados,
  lerUsuarios, salvarUsuarios
};
