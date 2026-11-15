'use strict';
/* 15/11 — CIFRA DO BACKUP (auditoria do Codex de 15/11/2026, P2 nº 8).

   O backup do /data leva os tokens do Bling e do ML das três empresas, o ponto e os conferidos. Ele vai pra um repo do
   GitHub — privado, mas ainda assim fora da nossa máquina. Aqui o arquivo é cifrado ANTES de subir, com uma senha que só
   está no Render (BACKUP_CHAVE), e decifrado localmente na hora de restaurar (scripts/backup-decifrar.js).

   Formato do .enc:  'MPBK1' (5 bytes) | sal (16) | iv (12) | tag (16) | dados cifrados
   Chave: scrypt(senha, sal) → 32 bytes; AES-256-GCM (o tag detecta arquivo mexido ou senha errada). Tudo em FLUXO: o
   backup completo pode ter centenas de MB e não cabe na memória de um Starter. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const MAGICO = Buffer.from('MPBK1');
const SAL = 16, IV = 12, TAG = 16;
const CABECALHO = MAGICO.length + SAL + IV + TAG;
const MIN_SENHA = 32;

function chaveDe(senha, sal) {
  if (typeof senha !== 'string' || senha.length < MIN_SENHA) throw new Error('BACKUP_CHAVE precisa ter pelo menos ' + MIN_SENHA + ' caracteres');
  return crypto.scryptSync(senha, sal, 32, { N: 16384, r: 8, p: 1 });
}

/* cifra o arquivo em fluxo; devolve { caminho, nome, cifrado: true } do .enc ao lado do original */
async function cifrarArquivo(origem, senha) {
  const sal = crypto.randomBytes(SAL), iv = crypto.randomBytes(IV);
  const chave = chaveDe(senha, sal);   /* valida a senha antes de criar qualquer arquivo */
  const destino = origem + '.enc';
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  /* cabeçalho com a tag ainda zerada; a tag só existe no fim e é escrita de volta na posição dela */
  fs.writeFileSync(destino, Buffer.concat([MAGICO, sal, iv, Buffer.alloc(TAG)]));
  await pipeline(fs.createReadStream(origem), cifra, fs.createWriteStream(destino, { flags: 'a' }));
  const fd = fs.openSync(destino, 'r+');
  try { fs.writeSync(fd, cifra.getAuthTag(), 0, TAG, MAGICO.length + SAL + IV); } finally { fs.closeSync(fd); }
  return { caminho: destino, nome: path.basename(destino), cifrado: true };
}

function lerCabecalho(origem) {
  const fd = fs.openSync(origem, 'r');
  try {
    const b = Buffer.alloc(CABECALHO); const n = fs.readSync(fd, b, 0, CABECALHO, 0);
    if (n < CABECALHO || !b.subarray(0, MAGICO.length).equals(MAGICO)) throw new Error('não é um backup cifrado deste sistema (cabeçalho MPBK1 ausente)');
    let o = MAGICO.length;
    const sal = b.subarray(o, o + SAL); o += SAL;
    const iv = b.subarray(o, o + IV); o += IV;
    const tag = b.subarray(o, o + TAG);
    return { sal, iv, tag };
  } finally { fs.closeSync(fd); }
}

/* decifra em fluxo pra `destino`; senha errada ou arquivo mexido = erro e NADA fica em `destino` (escreve num .parcial e só
   renomeia quando a tag confere) */
async function decifrarArquivo(origem, senha, destino) {
  const { sal, iv, tag } = lerCabecalho(origem);
  const d = crypto.createDecipheriv('aes-256-gcm', chaveDe(senha, sal), iv); d.setAuthTag(tag);
  const parcial = destino + '.parcial';
  try {
    await pipeline(fs.createReadStream(origem, { start: CABECALHO }), d, fs.createWriteStream(parcial));
  } catch (e) {
    try { fs.unlinkSync(parcial); } catch (e2) {}
    throw new Error('não decifrou: senha errada ou arquivo alterado (' + (e.message || e) + ')');
  }
  fs.renameSync(parcial, destino);
  return destino;
}

function ehCifrado(caminho) {
  try { lerCabecalho(caminho); return true; } catch (e) { return false; }
}

module.exports = { cifrarArquivo, decifrarArquivo, ehCifrado, MAGICO, MIN_SENHA, CABECALHO };
