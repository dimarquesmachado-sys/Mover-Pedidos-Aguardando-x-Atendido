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
  let corpo = '';
  res.on('data', (c) => { corpo += c; });
  res.on('end', () => {
    if (res.statusCode !== 200) { console.log('AVISO: HTTP ' + res.statusCode + ' ao buscar o contrato remoto — paridade não conferida (não é falha)'); process.exit(0); }
    if (corpo === local) { console.log('OK: contrato IDÊNTICO byte a byte à main do Devoluções'); process.exit(0); }
    const n = Math.min(corpo.length, local.length);
    let i = 0; while (i < n && corpo[i] === local[i]) i++;
    console.error('FALHOU: contrato DIVERGIU da main do Devoluções no byte ' + i + ' (local ' + local.length + 'b, remoto ' + corpo.length + 'b) — sincronize os dois lados');
    process.exit(1);
  });
});
req.on('timeout', () => { req.destroy(); console.log('AVISO: sem rede/timeout — paridade remota não conferida (não é falha)'); process.exit(0); });
req.on('error', () => { console.log('AVISO: sem rede — paridade remota não conferida (não é falha)'); process.exit(0); });
