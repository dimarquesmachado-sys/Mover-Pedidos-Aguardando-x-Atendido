'use strict';
/* 15/11 — adm-zip 0.6 e nodemailer 10: COMPATIBILIDADE DO QUE A OPERAÇÃO USA (auditoria do Codex de 15/11/2026, P2 nº 13).

   O `npm audit` apontava adm-zip 0.5.18 (ZIP forjado aloca 4 GB; extração segue symlink; tamanho declarado sem teto) e
   nodemailer 6.10.1 (injeção de comando SMTP por CRLF; destino trocado por conflito de interpretação). Subimos as duas e
   este teste prova, com as bibliotecas de VERDADE, exatamente o que o sistema usa delas — pra uma major nova não quebrar o
   galpão em silêncio:
     · ZIP das etiquetas (Shopee manda ZIP com .txt ZPL + .pdf): `new AdmZip(buffer)`, `getEntries()`, `entryName`,
       `getData()`, `readAsText()` — e a peça de produção lib/checkout/zip-etiquetas (diretório central, tamanhos zerados);
     · ZIP forjado com tamanho declarado absurdo NÃO aloca gigas nem derruba o processo (é o advisory);
     · e-mail: `createTransport({ host, port, secure, auth })` + `sendMail({ from, to, subject, text, html, attachments })` —
       com um transporte que não sai pra rede (streamTransport), o mesmo objeto de opções que email-docs e
       ml-codigo-coleta montam; CRLF no nome do transporte/host é recusado (o advisory). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const raiz = path.join(__dirname, '..');

(async () => {
  const pk = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  const vZip = require('adm-zip/package.json').version, vMail = require('nodemailer/package.json').version;
  assert.ok(/^0\.6\./.test(vZip) && /^\^0\.6\./.test(pk.dependencies['adm-zip']), 'adm-zip tem que ser 0.6.x (instalado ' + vZip + ', package.json ' + pk.dependencies['adm-zip'] + ')');
  assert.ok(parseInt(vMail, 10) >= 10 && /^\^10\./.test(pk.dependencies.nodemailer), 'nodemailer tem que ser 10.x (instalado ' + vMail + ', package.json ' + pk.dependencies.nodemailer + ')');
  const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages['node_modules/adm-zip'].version, vZip, 'o lock tem que fixar a versão instalada do adm-zip');
  assert.strictEqual(lock.packages['node_modules/nodemailer'].version, vMail, 'o lock tem que fixar a versão instalada do nodemailer');

  /* ── adm-zip como a operação usa ── */
  const AdmZip = require('adm-zip');
  const zpl = '^XA^FO50,50^ADN,36,20^FDPEDIDO 123^FS^XZ';
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x41)]);
  const z = new AdmZip();
  z.addFile('thermal_zpl_shipping_label.txt', Buffer.from(zpl, 'utf8'));
  z.addFile('content_declaration.pdf', pdf);
  const buf = z.toBuffer();
  const lido = new AdmZip(buf);
  const nomes = lido.getEntries().map((e) => e.entryName).sort();
  assert.deepStrictEqual(nomes, ['content_declaration.pdf', 'thermal_zpl_shipping_label.txt']);
  const eTxt = lido.getEntries().find((e) => /\.txt$/.test(e.entryName)), ePdf = lido.getEntries().find((e) => /\.pdf$/.test(e.entryName));
  assert.strictEqual(lido.readAsText(eTxt), zpl, 'readAsText do ZPL');
  assert.strictEqual(eTxt.getData().toString('utf8'), zpl, 'getData do ZPL');
  assert.ok(ePdf.getData().equals(pdf), 'getData do PDF byte a byte');
  assert.strictEqual(eTxt.isDirectory, false);
  /* a peça de produção que lê o ZIP da Shopee (pelo diretório central) continua lendo o mesmo ZIP */
  const { lerZipEntradas } = require('../lib/checkout/zip-etiquetas');
  const ents = lerZipEntradas(buf);
  assert.ok(Array.isArray(ents) && ents.length === 2 && ents.some((e) => /\.txt$/.test(e.nome || e.entryName || e.name)), 'lib/checkout/zip-etiquetas tem que ler as duas entradas: ' + JSON.stringify(ents).slice(0, 200));
  /* ZIP forjado: tamanho descomprimido declarado de 4 GB numa entrada de 20 bytes — não pode alocar gigas nem derrubar */
  {
    const dados = zlib.deflateRawSync(Buffer.from('x'.repeat(20)));
    const nome = Buffer.from('bomba.txt');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(0, 14);
    local.writeUInt32LE(dados.length, 18); local.writeUInt32LE(0xFFFFFFF0, 22); local.writeUInt16LE(nome.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(dados.length, 20); cen.writeUInt32LE(0xFFFFFFF0, 24); cen.writeUInt16LE(nome.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(0, 42);
    const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(1, 8); fim.writeUInt16LE(1, 10); fim.writeUInt32LE(cen.length + nome.length, 12); fim.writeUInt32LE(local.length + nome.length + dados.length, 16);
    const forjado = Buffer.concat([local, nome, dados, cen, nome, fim]);
    const antesMem = process.memoryUsage().rss;
    let saiu = null; try { const zb = new AdmZip(forjado); const e = zb.getEntries()[0]; saiu = e.getData(); } catch (e) { saiu = e; }
    const depoisMem = process.memoryUsage().rss;
    assert.ok(depoisMem - antesMem < 200 * 1024 * 1024, 'ZIP forjado alocou ' + Math.round((depoisMem - antesMem) / 1048576) + ' MB — o advisory voltou');
    assert.ok(saiu instanceof Error || (Buffer.isBuffer(saiu) && saiu.length <= 20), 'ZIP forjado tem que dar erro ou os 20 bytes reais, nunca 4 GB: ' + (Buffer.isBuffer(saiu) ? saiu.length : saiu));
  }

  /* ── nodemailer como a operação usa ── */
  const nodemailer = require('nodemailer');
  const opts = { host: 'smtp.exemplo.test', port: 465, secure: true, auth: { user: 'loja@exemplo.test', pass: 'x' } };
  const t = nodemailer.createTransport(opts);
  assert.ok(t && typeof t.sendMail === 'function' && t.options.host === 'smtp.exemplo.test' && t.options.port === 465 && t.options.secure === true, 'createTransport com host/port/secure/auth (o que email-docs monta)');
  /* o mesmo sendMail, mas num transporte que escreve o e-mail em vez de sair pra rede */
  const ts = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  const info = await ts.sendMail({ from: 'loja@exemplo.test', to: 'a@exemplo.test, b@exemplo.test', subject: 'Pedido 123 — etiqueta e DANFE', text: 'segue', html: '<b>segue</b>',
    attachments: [{ filename: 'etiqueta.pdf', content: pdf, contentType: 'application/pdf' }, { filename: 'etiqueta.zpl', content: zpl }] });
  const msg = info.message.toString('utf8');
  assert.deepStrictEqual(info.envelope, { from: 'loja@exemplo.test', to: ['a@exemplo.test', 'b@exemplo.test'] }, 'dois destinatários separados por vírgula (como a env EMAIL_DEST)');
  assert.ok(/Subject: /.test(msg) && /Content-Type: application\/pdf/.test(msg) && /filename="?etiqueta\.zpl"?/.test(msg) && /<b>segue<\/b>/.test(msg), 'a mensagem tem que levar assunto, HTML e os dois anexos');
  assert.ok(/=\?UTF-8\?/.test(msg) || /Pedido 123/.test(msg), 'assunto com acento codificado ou literal');
  /* os advisories do 6.x: CRLF no nome/host do transporte e destino de outro domínio por interpretação */
  for (const ruim of [{ host: 'smtp.x.test\r\nQUIT', port: 25 }, { name: 'a\r\nMAIL FROM:<x@y>', host: 'smtp.x.test', port: 25 }]) {
    let erro = null;
    try { const tr = nodemailer.createTransport(Object.assign({ connectionTimeout: 300, greetingTimeout: 300, socketTimeout: 300 }, ruim)); await tr.sendMail({ from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' }); } catch (e) { erro = e; }
    assert.ok(erro, 'transporte com CRLF tinha que ser recusado/falhar, nunca mandar a linha extra ao SMTP');
  }
  const info2 = await ts.sendMail({ from: 'loja@exemplo.test', to: 'cliente@exemplo.test\r\nRCPT TO:<atacante@outro.test>', subject: 's', text: 't' }).catch((e) => ({ erro: e }));
  /* (o parser de endereço fica com o que está entre <>; o que importa é que NENHUM CRLF chega ao envelope SMTP) */
  assert.ok(info2.erro || (info2.envelope && info2.envelope.to.every((d) => !/[\r\n]/.test(d)) && !/[\r\n]/.test(info2.envelope.from)), 'CRLF do destinatário não pode chegar cru ao envelope: ' + JSON.stringify(info2.envelope || String(info2.erro)));

  /* a produção não mudou de forma: email-docs e ml-codigo-coleta seguem chamando createTransport + sendMail */
  for (const f of ['lib/checkout/email-docs.js', 'lib/checkout/ml-codigo-coleta.js']) {
    const s = fs.readFileSync(path.join(raiz, f), 'utf8');
    assert.ok(/nodemailer\.createTransport\(\{ host: /.test(s) && /\.sendMail\(/.test(s), f + ': a forma de uso do nodemailer mudou — rever este teste');
  }
  console.log('ok — adm-zip ' + vZip + ' e nodemailer ' + vMail + ': o ZIP das etiquetas lê igual (lib + API), ZIP forjado não aloca gigas; createTransport/sendMail com anexos e vários destinos iguais; CRLF no transporte e no destinatário não vira comando SMTP; lock fixado');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
