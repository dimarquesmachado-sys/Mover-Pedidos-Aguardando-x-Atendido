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
const { etiquetaMadeiraNoCiclo, pdfDaEtiquetaMadeira, limparBackoff, ARQ_ZPL, ARQ_PDF } = require('../lib/checkout/etiqueta-madeira');

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

  // backoff: lote que acabou de falhar nos dois caminhos não é tentado de novo na hora (watchdog do ciclo)
  m.log.length = 0; r = await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10052974' }, nf: null, mmEtq: m });
  assert.ok(!r.ok && /achei o lote 304892/.test(r.motivo) && !m.log.some(l => l[0] === 'zpl' || l[0] === 'pdf'), 'sem backoff: baixou de novo logo após falhar');
  limparBackoff(); m.log.length = 0; await etiquetaMadeiraNoCiclo({ dir, ped: { numeroLoja: '10052974' }, nf: null, mmEtq: m });
  assert.ok(m.log.some(l => l[0] === 'zpl'), 'limparBackoff não liberou nova tentativa');
  limparBackoff();

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
    const s = require('./_fonte-ciclo').ler(raiz, arq);   /* 30/10: o ciclo como a empresa o roda (peça única) */
    assert.ok(/require\('\.\.\/lib\/checkout\/etiqueta-madeira'\)\.etiquetaMadeiraNoCiclo\(\{ dir, ped, nf, mmEtq \}\)/.test(s), arq + ': não usa a peça');
    assert.ok(!/pdfPorBatch\(regMM\.batch\)/.test(s), arq + ': sobrou a cópia antiga (só o PDF)');
    assert.ok(/if \(!_mm\.ok && _mm\.motivo\) _motivoEtq = _mm\.motivo;/.test(s), arq + ': o motivo não vai pro card');
  }
  /* Codex #729: a impressão em A4 (/etiqueta-pdf) com a etiqueta só em ZPL — converte com o zplParaPdf do A4 e guarda */
  { const conv = []; const zplParaPdf = async (z) => { conv.push(z); return PDF2; };
    // ZPL que o ciclo guardou → converte, guarda o PDF; o PDF com token nem é chamado
    let d2 = novoDir(); fs.writeFileSync(path.join(d2, ARQ_ZPL), ZPL2);
    let m2 = mapa({ lote: '304893', chaves: ['10051765'], zpl: null, pdf: null });
    let p2 = await pdfDaEtiquetaMadeira({ dir: d2, snap: { marketplace: 'madeira', numero_loja: '10051765', nf: { numero: '080809' } }, mmEtq: m2, zplParaPdf });
    const { PDFDocument } = require('pdf-lib');
    assert.ok(p2 && conv.length === 2 && conv[0] === '^XA^FDvol1^FS^XZ' && conv[1] === '^XA^FDvol2^FS^XZ', 'A4: não converteu cada volume do ZPL do ciclo (Labelary /0/ só traz o 1º)');
    assert.strictEqual((await PDFDocument.load(p2)).getPageCount(), 4, 'A4: o PDF não juntou os volumes (2 volumes × 2 páginas do mock)');
    // um volume falhou na conversão → não guarda PDF incompleto
    { const d3 = novoDir(); fs.writeFileSync(path.join(d3, ARQ_ZPL), ZPL2); let n = 0;
      const p3 = await pdfDaEtiquetaMadeira({ dir: d3, snap: { marketplace: 'madeira', numero_loja: '10051765' }, mmEtq: mapa({ lote: '304893', chaves: ['10051765'], zpl: null, pdf: null }), zplParaPdf: async () => (++n === 1 ? PDF2 : null) });
      assert.ok(p3 === null && !fs.existsSync(path.join(d3, ARQ_PDF)), 'A4: guardou PDF com volume faltando'); }
    assert.ok(fs.existsSync(path.join(d2, ARQ_PDF)) && !m2.log.some(l => l[0] === 'pdf'), 'A4: não guardou o PDF ou chamou o PDF com token');
    // sem nada guardado: ZPL público → converte (e guarda os dois)
    d2 = novoDir(); m2 = mapa({ lote: '304893', chaves: ['80809'], zpl: ZPL2, pdf: null });
    p2 = await pdfDaEtiquetaMadeira({ dir: d2, snap: { marketplace: 'madeira', numero_loja: 'x', nf: { numero: '080809' } }, mmEtq: m2, zplParaPdf });
    assert.ok(p2 && fs.existsSync(path.join(d2, ARQ_ZPL)) && fs.existsSync(path.join(d2, ARQ_PDF)), 'A4: sem cache, não buscou o ZPL público (com a NF sem zero)');
    // ZPL indisponível → PDF com token por último
    d2 = novoDir(); m2 = mapa({ lote: '304893', chaves: ['10051765'], zpl: null, pdf: PDF2 });
    p2 = await pdfDaEtiquetaMadeira({ dir: d2, snap: { marketplace: 'madeira', numero_loja: '10051765' }, mmEtq: m2, zplParaPdf });
    assert.ok(p2 && m2.log.some(l => l[0] === 'pdf'), 'A4: sem ZPL, não tentou o PDF com token');
    // outro canal: não é com ela
    assert.strictEqual(await pdfDaEtiquetaMadeira({ dir: d2, snap: { marketplace: 'ml' }, mmEtq: m2, zplParaPdf }), null);
    const fe = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'etiquetas.js'), 'utf8');
    assert.ok(/require\('\.\/etiqueta-madeira'\)\.pdfDaEtiquetaMadeira\(\{ dir, snap, mmEtq: mmEtiquetas, zplParaPdf \}\)/.test(fe), 'o A4 (/etiqueta-pdf) não usa a peça do Madeira');
    assert.ok(!/mmEtiquetas\.pdfPorBatch\(reg\.batch\)/.test(fe), 'sobrou o A4 dependendo só do PDF com token'); }

  // arquivo: a finalização copia o ZPL do Madeira (o A4 arquivado converte dele)
  for (const arq of ['good-checkout-offline/arquivo.js', 'girassol-backup-offline/arquivo.js', 'amb-checkout-offline/arquivo.js'])
    assert.ok(/etiqueta-correios\.zpl/.test(require('./_fonte-ciclo').ler(raiz, arq)), arq + ': não arquiva o ZPL do Madeira');

  console.log('ok — etiqueta do Madeira no ciclo: ZPL público primeiro (o PDF com token de reserva), NF sem zero, motivo no card — nas três');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
