'use strict';
/* 23/10 — dois pedidos do Madeira da GOOD com a etiqueta emitida e no mapa ficavam "sem etiqueta": o ciclo só olhava o
   PDF do lote (com token), que dava timeout de 30 s, enquanto a impressão usa o ZPL PÚBLICO do portal. Prova, com a
   peça de produção (lib/checkout/etiqueta-madeira) e um mapa de mentira:
   · ZPL primeiro (o PDF nem é chamado) e cacheado no MESMO arquivo que a impressão usa; volumes = nº de etiquetas;
   · ZPL falhou → PDF de reserva; os dois falharam → motivo "achei o lote, mas não baixou";
   · lote fora do mapa → motivo "a Toolbox ainda não trouxe o lote";
   · NF com o zero da frente (Bling 080809 × Madeira 80809) acha;
   · cache: com o arquivo já baixado, não pergunta nada ao Madeira;
   · empresa sem módulo do Madeira: sem etiqueta e sem motivo (não vende lá);
   · os três ciclos usam a peça e não sobra a cópia antiga. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { etiquetaMadeiraNoCiclo, ARQ_ZPL } = require('../lib/checkout/etiqueta-madeira');

const ZPL2 = '^XA^FDvol1^FS^XZ\n^XA^FDvol2^FS^XZ\n';
function mapa(o) {
  const log = [];
  return { log,
    acharLote: (c) => { log.push(['achar', c]); return (o.lote && o.chaves.includes(String(c))) ? { batch: o.lote } : null; },
    zplPorBatch: async (b) => { log.push(['zpl', b]); return o.zpl; },
    pdfPorBatch: async (b) => { log.push(['pdf', b]); return o.pdf; } };
}
(async () => {
  const novoDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  const PDF2 = Buffer.from(await (async () => { const { PDFDocument } = require('pdf-lib'); const d = await PDFDocument.create(); d.addPage(); d.addPage(); return d.save(); })());

  // ZPL primeiro, cacheado no arquivo da impressão; o PDF nem é chamado
  let dir = novoDir(); let m = mapa({ lote: '304893', chaves: ['10051765'], zpl: ZPL2, pdf: PDF2 });
  let r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10051765' }, nf: { numero: '080809' }, mmEtq: m });
  assert.ok(r.ok && r.via === 'zpl' && r.volumes === 2, 'ZPL primeiro: ' + JSON.stringify(r));
  assert.ok(!m.log.some(l => l[0] === 'pdf'), 'o PDF (com token, que dava timeout) não podia ser chamado com o ZPL bom');
  assert.strictEqual(fs.readFileSync(path.join(dir, ARQ_ZPL), 'utf8'), ZPL2, 'não cacheou no arquivo que a impressão usa');
  // cache: de novo, sem perguntar nada
  m.log.length = 0; r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10051765' }, nf: null, mmEtq: m });
  assert.ok(r.ok && r.via === 'cache-zpl' && m.log.length === 0, 'com o cache, perguntou ao Madeira de novo');

  // ZPL falhou → PDF de reserva (volumes pelas páginas)
  dir = novoDir(); m = mapa({ lote: '304892', chaves: ['10052974'], zpl: null, pdf: PDF2 });
  r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10052974' }, nf: null, mmEtq: m });
  assert.ok(r.ok && r.via === 'pdf' && r.volumes === 2, 'PDF de reserva: ' + JSON.stringify(r));

  // os dois falharam → motivo com o lote
  dir = novoDir(); m = mapa({ lote: '304892', chaves: ['10052974'], zpl: '<html>erro</html>', pdf: null });
  r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10052974' }, nf: null, mmEtq: m });
  assert.ok(!r.ok && /achei o lote 304892/.test(r.motivo), 'motivo do download: ' + JSON.stringify(r));

  // fora do mapa → motivo da Toolbox
  dir = novoDir(); m = mapa({ lote: null, chaves: [] });
  r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '1' }, nf: { numero: '1' }, mmEtq: m });
  assert.ok(!r.ok && /a Toolbox ainda não trouxe o lote/.test(r.motivo), 'motivo do mapa: ' + JSON.stringify(r));

  // NF com o zero da frente: o Bling 080809 × o Madeira 80809
  dir = novoDir(); m = mapa({ lote: '304893', chaves: ['80809'], zpl: ZPL2 });
  r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: 'outro' }, nf: { numero: '080809' }, mmEtq: m });
  assert.ok(r.ok, 'a NF com zero na frente não achou o lote: ' + JSON.stringify(m.log));

  // empresa sem módulo do Madeira
  dir = novoDir(); r = await etiquetaMadeiraNoCiclo({ dir, ped: {}, nf: null, mmEtq: null });
  assert.ok(!r.ok && r.motivo === null, 'sem módulo do Madeira não pode inventar motivo');

  // os três ciclos usam a peça, sem a cópia
  for (const arq of ['good-checkout-offline/ciclo.js', 'girassol-backup-offline/ciclo.js', 'amb-checkout-offline/ciclo.js']) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/require\('\.\.\/lib\/checkout\/etiqueta-madeira'\)\.etiquetaMadeiraNoCiclo\(\{ dir, ped, nf, mmEtq \}\)/.test(s), arq + ': não usa a peça');
    assert.ok(!/pdfPorBatch\(regMM\.batch\)/.test(s), arq + ': sobrou a cópia antiga (só o PDF)');
    assert.ok(/if \(!_mm\.ok && _mm\.motivo\) _motivoEtq = _mm\.motivo;/.test(s), arq + ': o motivo não vai pro card');
  }
  console.log('ok — etiqueta do Madeira no ciclo: ZPL público primeiro (o PDF com token de reserva), NF sem zero, motivo no card — nas três');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
