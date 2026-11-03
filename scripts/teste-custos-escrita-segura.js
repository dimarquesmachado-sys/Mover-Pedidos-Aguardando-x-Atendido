'use strict';
/* 01/11 — O ARQUIVO DE CUSTOS COM GRAVAÇÃO SEGURA NAS TRÊS (auditoria do Codex no SHA 208fdb7d, achado F11). A GOOD já
   gravava o _custos.json da rotina do custo diário com a escrita atômica (temporário + troca); a AMB e a Girassol passavam
   `fs.writeFileSync` direto — que TRUNCA o arquivo antes de escrever: uma falha no meio (disco cheio, deploy) deixava o
   arquivo de custos ilegível (o Codex simulou ENOSPC depois de escrita parcial). E a rota do custo diário (?dia=) tinha o
   mesmo writeFileSync, na Girassol e na fábrica do painel. Prova:
   · DE VERDADE: a escrita que as três passam pra peça do custo diário, com o disco "enchendo" no meio da gravação — o
     arquivo ANTERIOR continua inteiro e legível (com o writeFileSync direto, ficava truncado);
   · nenhuma gravação direta do arquivo de custos sobrou nas três empresas nem na lib. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) a escrita que cada empresa entrega à peça do custo diário */
const ESC = /escrever: \(p, o\) => ([^\n]+),\n/;
const escritaDe = {};
for (const [emp, arq] of [['amb', 'amb-checkout-offline/index.js'], ['girassol', 'girassol-backup-offline/gbo-app.js'], ['good', 'good-checkout-offline/index.js']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("require('../lib/checkout/custo-diario').criar({");
  assert.ok(i > 0, emp + ': não achei a montagem da peça do custo diário');
  const m = ESC.exec(s.slice(i, i + 1500));
  assert.ok(m, emp + ': não achei a escrita que a empresa entrega à peça');
  escritaDe[emp] = m[1];
}
/* 2) roda cada escrita com um disco que "enche" no meio: o writeSync escreve metade e falha (ENOSPC) */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custos-'));
const ANTES = JSON.stringify({ SKU1: { custo: 10 }, SKU2: { custo: 20 }, _custoDiarioDia: '2026-10-31' });
const _w = fs.writeSync, _wf = fs.writeFileSync;
for (const [emp, expr] of Object.entries(escritaDe)) {
  const arq = path.join(dir, emp + '-_custos.json');
  _wf(arq, ANTES);
  const escrever = new Function('require', 'fs', 'JSON', 'return (p, o) => ' + expr + ';')(require, fs, JSON);
  /* falha no meio: escreve só metade do conteúdo e estoura ENOSPC (tanto pelo writeSync quanto pelo writeFileSync) */
  fs.writeSync = function (fd, buf, ...r) { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); _w.call(fs, fd, b.subarray(0, Math.floor(b.length / 2))); const e = new Error('ENOSPC: sem espaço'); e.code = 'ENOSPC'; throw e; };
  fs.writeFileSync = function (p, conteudo) { const b = Buffer.from(String(conteudo)); _wf.call(fs, p, b.subarray(0, Math.floor(b.length / 2))); const e = new Error('ENOSPC: sem espaço'); e.code = 'ENOSPC'; throw e; };
  let caiu = null;
  try { escrever(arq, { SKU1: { custo: 11 }, SKU2: { custo: 21 }, SKU3: { custo: 30 }, _custoDiarioDia: '2026-11-01' }); } catch (e) { caiu = e.code || e.message; }
  fs.writeSync = _w; fs.writeFileSync = _wf;
  assert.ok(caiu, emp + ': a falha de gravação tinha que subir (quem chama decide)');
  let lido = null; try { lido = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { lido = null; }
  assert.ok(lido && lido.SKU1 && lido.SKU1.custo === 10 && lido._custoDiarioDia === '2026-10-31', emp + ': o arquivo de custos ficou ILEGÍVEL/truncado depois de uma falha no meio da gravação');
}
fs.rmSync(dir, { recursive: true, force: true });
/* 3) nenhuma gravação direta do arquivo de custos sobrou */
const sobra = [];
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js', 'lib/checkout/fabrica-rotas-painel.js', 'lib/checkout/custo-diario.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  for (const l of s.split('\n')) if (/fs\.writeFileSync\([^,]*(CUSTO|_custos)/.test(l)) sobra.push(arq + ': ' + l.trim().slice(0, 100));
}
assert.deepStrictEqual(sobra, [], 'sobrou gravação direta (não segura) do arquivo de custos:\n  ' + sobra.join('\n  '));
console.log('ok — arquivo de custos com gravação segura nas três: falha no meio deixa o anterior inteiro; nenhuma gravação direta sobrou');
