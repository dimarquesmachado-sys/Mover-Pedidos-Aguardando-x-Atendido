#!/usr/bin/env node
'use strict';
/* 15/11 — ABRE UM BACKUP CIFRADO (auditoria do Codex de 15/11/2026, P2 nº 8).
   Uso:  BACKUP_CHAVE='a mesma senha do Render' node scripts/backup-decifrar.js checkout-backup-2026-11-15.tar.gz.enc [saida.tar.gz]
   Senha errada ou arquivo alterado → erro e nenhum arquivo de saída. Depois: tar -xzf saida.tar.gz */
const path = require('path');
const { decifrarArquivo } = require('../lib/backup-cifra');
(async () => {
  const [origem, saida] = process.argv.slice(2);
  if (!origem) { console.error('uso: BACKUP_CHAVE=... node scripts/backup-decifrar.js <arquivo.enc> [saida]'); process.exit(2); }
  const senha = process.env.BACKUP_CHAVE || '';
  if (!senha) { console.error('falta BACKUP_CHAVE no ambiente (a mesma senha configurada no Render)'); process.exit(2); }
  const destino = saida || (origem.endsWith('.enc') ? origem.slice(0, -4) : origem + '.tar.gz');
  try { await decifrarArquivo(origem, senha, destino); console.log('✓ decifrado em ' + path.resolve(destino)); }
  catch (e) { console.error('✗ ' + (e.message || e)); process.exit(1); }
})();
