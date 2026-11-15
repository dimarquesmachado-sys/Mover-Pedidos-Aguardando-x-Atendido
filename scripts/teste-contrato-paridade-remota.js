'use strict';
/* Paridade REMOTA do contrato (Codex #353): o teste local só olha a cópia do checkout —
   se um repo mudar o contrato e o outro não, cada lado segue verde sozinho. Este script
   baixa o contrato da MAIN do Devoluções e compara BYTE A BYTE. Sem rede, avisa e sai 0
   (paridade online é online por natureza — o aviso é declarado, nunca silêncio).
   Roda na bateria e no CI que tiver saída pra internet.
   15/11 (auditoria do Codex, P2 nº 14): TRÊS vereditos, cada um com a sua palavra na saída e o seu código de saída —
   VERIFICADO (0), INCONCLUSIVO (2: sem rede, timeout, 5xx/429, corpo cortado — a paridade NÃO foi conferida) e
   DIVERGENTE/AUSENTE (1). Antes o inconclusivo saía 0 como aviso e o verifica somava como ✓: a guarda cega ficava verde. */
const fs = require('fs');
const path = require('path');
const URL_LA = process.env.CONTRATO_REMOTO_URL || 'https://raw.githubusercontent.com/dimarquesmachado-sys/GOOD-Devolucoes-x-Marketplaces-x-NFsBLING/main/contrato-empresas.json';
/* (CONTRATO_REMOTO_URL e CONTRATO_REMOTO_TIMEOUT_MS existem pro teste dos vereditos apontar pra um servidor local) */
const https = URL_LA.startsWith('http://') ? require('http') : require('https');
const TIMEOUT_MS = parseInt(process.env.CONTRATO_REMOTO_TIMEOUT_MS || '', 10) > 0 ? parseInt(process.env.CONTRATO_REMOTO_TIMEOUT_MS, 10) : 10000;
const local = fs.readFileSync(path.join(__dirname, '..', 'contrato-empresas.json'), 'utf8');

let concluiu = false;
process.on('exit', (code) => {
  /* Codex #354 r2: resposta abortada no meio do corpo não dispara 'end' — o processo
     saía 0 SILENCIOSO e o verifica reportava a paridade como ok com saída vazia.
     Qualquer término sem veredito explícito vira aviso audível. */
  if (!concluiu && code === 0) { console.log('INCONCLUSIVO: terminou sem veredito (resposta incompleta?) — paridade NÃO conferida'); process.exitCode = 2; }
});
const req = https.get(URL_LA, { timeout: TIMEOUT_MS }, (res) => {
  res.on('aborted', () => { concluiu = true; console.log('INCONCLUSIVO: conexão abortada no meio do corpo — transitório, paridade NÃO conferida'); process.exit(2); });
  res.on('error', () => { concluiu = true; console.log('INCONCLUSIVO: erro na resposta — transitório, paridade NÃO conferida'); process.exit(2); });
  /* Codex #354: decodificar chunk a chunk quebrava caractere UTF-8 multibyte partido
     na fronteira TLS — setEncoding preserva o estado do decoder entre chunks. */
  res.setEncoding('utf8');
  let corpo = '';
  res.on('data', (c) => { corpo += c; });
  res.on('end', () => {
    /* Codex #354: 404/410 é resposta CONCLUSIVA — a URL configurada não existe mais
       (rename/remoção/visibilidade) e sair 0 desligaria a guarda pra sempre em
       silêncio. Só falha de TRANSPORTE (5xx/429) merece o aviso transitório. */
    if (res.statusCode === 404 || res.statusCode === 410) {
      concluiu = true; console.error('AUSENTE: o contrato remoto NÃO EXISTE na URL configurada (HTTP ' + res.statusCode + ') — repo/caminho mudou? A guarda de paridade não pode ficar cega.');
      process.exit(1);
    }
    if (res.statusCode !== 200) { concluiu = true; console.log('INCONCLUSIVO: HTTP ' + res.statusCode + ' ao buscar o contrato remoto — transitório, paridade NÃO conferida'); process.exit(2); }
    /* Codex #354: checkout Windows com autocrlf materializa CRLF no working tree —
       diferença SÓ de fim de linha não é divergência de contrato; é declarada. */
    const semEol = (t) => t.replace(/\r\n/g, '\n');
    if (corpo === local) { concluiu = true; console.log('VERIFICADO: contrato IDÊNTICO byte a byte à main do Devoluções'); process.exit(0); }
    if (semEol(corpo) === semEol(local)) { concluiu = true; console.log('VERIFICADO: contrato idêntico (difere só em fim de linha — conversão do checkout, não divergência)'); process.exit(0); }
    const n = Math.min(corpo.length, local.length);
    let i = 0; while (i < n && corpo[i] === local[i]) i++;
    concluiu = true; console.error('DIVERGENTE: contrato DIVERGIU da main do Devoluções no byte ' + i + ' (local ' + local.length + 'b, remoto ' + corpo.length + 'b) — sincronize os dois lados');
    process.exit(1);
  });
});
req.on('timeout', () => { req.destroy(); concluiu = true; console.log('INCONCLUSIVO: sem rede/timeout — paridade remota NÃO conferida'); process.exit(2); });
req.on('error', () => { concluiu = true; console.log('INCONCLUSIVO: sem rede — paridade remota NÃO conferida'); process.exit(2); });
