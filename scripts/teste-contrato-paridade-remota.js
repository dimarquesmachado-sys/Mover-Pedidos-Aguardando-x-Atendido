'use strict';
/* Paridade REMOTA do contrato (Codex #353): o teste local só olha a cópia do checkout —
   se um repo mudar o contrato e o outro não, cada lado segue verde sozinho. Este script
   baixa o contrato da MAIN do Devoluções e compara BYTE A BYTE. Sem rede, avisa e sai 0
   (paridade online é online por natureza — o aviso é declarado, nunca silêncio).
   Roda na bateria e no CI que tiver saída pra internet. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const URL_LA = 'https://raw.githubusercontent.com/dimarquesmachado-sys/GOOD-Devolucoes-x-Marketplaces-x-NFsBLING/main/contrato-empresas.json';
const local = fs.readFileSync(path.join(__dirname, '..', 'contrato-empresas.json'), 'utf8');

const req = https.get(URL_LA, { timeout: 10000 }, (res) => {
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
      console.error('FALHOU: o contrato remoto NÃO EXISTE na URL configurada (HTTP ' + res.statusCode + ') — repo/caminho mudou? A guarda de paridade não pode ficar cega.');
      process.exit(1);
    }
    if (res.statusCode !== 200) { console.log('AVISO: HTTP ' + res.statusCode + ' ao buscar o contrato remoto — transitório, paridade não conferida (não é falha)'); process.exit(0); }
    /* Codex #354: checkout Windows com autocrlf materializa CRLF no working tree —
       diferença SÓ de fim de linha não é divergência de contrato; é declarada. */
    const semEol = (t) => t.replace(/\r\n/g, '\n');
    if (corpo === local) { console.log('OK: contrato IDÊNTICO byte a byte à main do Devoluções'); process.exit(0); }
    if (semEol(corpo) === semEol(local)) { console.log('OK: contrato idêntico (difere só em fim de linha — conversão do checkout, não divergência)'); process.exit(0); }
    const n = Math.min(corpo.length, local.length);
    let i = 0; while (i < n && corpo[i] === local[i]) i++;
    console.error('FALHOU: contrato DIVERGIU da main do Devoluções no byte ' + i + ' (local ' + local.length + 'b, remoto ' + corpo.length + 'b) — sincronize os dois lados');
    process.exit(1);
  });
});
req.on('timeout', () => { req.destroy(); console.log('AVISO: sem rede/timeout — paridade remota não conferida (não é falha)'); process.exit(0); });
req.on('error', () => { console.log('AVISO: sem rede — paridade remota não conferida (não é falha)'); process.exit(0); });
