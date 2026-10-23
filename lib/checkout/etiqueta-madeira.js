'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ETIQUETA DO MADEIRA MADEIRA NO CICLO DO CHECKOUT — peça única (23/10/2026).

   O dono (23/10): dois pedidos do Madeira da GOOD com a etiqueta JÁ emitida no Madeira e no mapa, e o card "sem
   etiqueta". Medido: o ciclo só considerava a etiqueta pelo PDF do lote (envios.madeiramadeira, com o token), e esse
   download dava "timeout (30s)". Só que a IMPRESSÃO do galpão (rota /etiqueta-madeira-zpl) usa o ZPL do lote pelo
   endereço PÚBLICO do portal (sem token, sem sessão) — ou seja, a etiqueta estava disponível o tempo todo; o ciclo é
   que não olhava por esse caminho. E o card não dizia o motivo.

   Agora (as três empresas — o bloco era cópia em cada ciclo):
   · ZPL PRIMEIRO (público; o mesmo arquivo `etiqueta-correios.zpl` que a impressão usa — baixou aqui, a impressão
     reaproveita); o PDF (com token) fica de reserva;
   · o lote é procurado também pela NF SEM o zero da frente (o Bling mostra 080809, o Madeira grava 80809);
   · sem etiqueta, devolve o MOTIVO (vai pro card): "a Toolbox ainda não trouxe o lote" × "achei o lote, mas não baixou".
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const ARQ_ZPL = 'etiqueta-correios.zpl';   /* o MESMO da rota de impressão (/etiqueta-madeira-zpl) */
const ARQ_PDF = 'etiqueta.pdf';
const blocosZpl = (z) => (String(z || '').match(/\^XA[\s\S]*?\^XZ/g) || []).length;

async function paginasPdf(buf) {
  try { const { PDFDocument } = require('pdf-lib'); return (await PDFDocument.load(buf)).getPageCount() || 1; } catch (e) { return 1; }
}

/* converte cada volume do ZPL com o conversor da casa e junta numa só PDF (ordem dos volumes); qualquer falha → null */
async function zplVolumesParaPdf(zpl, zplParaPdf) {
  const blocos = String(zpl || '').match(/\^XA[\s\S]*?\^XZ/g) || [];
  if (!blocos.length) return null;
  if (blocos.length === 1) return await zplParaPdf(blocos[0]);
  const { PDFDocument } = require('pdf-lib');
  const saida = await PDFDocument.create();
  for (const b of blocos) {
    const buf = await zplParaPdf(b);
    if (!buf || !buf.length) return null;
    const doc = await PDFDocument.load(buf);
    for (const pg of await saida.copyPages(doc, doc.getPageIndices())) saida.addPage(pg);
  }
  return Buffer.from(await saida.save());
}

/* Codex #729: backoff por lote — se o ZPL público E o PDF com token acabaram de falhar, não repete na hora (cada tentativa
   custa até ~2 min; uma fila de pedidos assim estouraria o watchdog de 15 min do ciclo) */
const BACKOFF_MS = 10 * 60 * 1000;
const falhouEm = new Map();
function limparBackoff() { falhouEm.clear(); }

/* o: { dir, ped, nf, mmEtq } — mmEtq = o módulo do mapa do Madeira DA EMPRESA (null = a empresa não vende no Madeira)
   devolve { ok, volumes, via: 'cache-zpl'|'cache-pdf'|'zpl'|'pdf'|null, motivo } */
async function etiquetaMadeiraNoCiclo(o) {
  const dir = o.dir, ped = o.ped || {}, nf = o.nf || null, mmEtq = o.mmEtq || null;
  const fZpl = path.join(dir, ARQ_ZPL), fPdf = path.join(dir, ARQ_PDF);
  try {
    if (fs.existsSync(fZpl)) { const z = fs.readFileSync(fZpl, 'utf8'); if (blocosZpl(z)) return { ok: true, volumes: blocosZpl(z), via: 'cache-zpl', motivo: null }; }
    if (fs.existsSync(fPdf)) { const b = fs.readFileSync(fPdf); if (b && b.length) return { ok: true, volumes: await paginasPdf(b), via: 'cache-pdf', motivo: null }; }
  } catch (e) { /* cache ilegível: segue pro download */ }
  if (!mmEtq || typeof mmEtq.acharLote !== 'function') return { ok: false, volumes: 1, via: null, motivo: null };
  const nfNum = nf && nf.numero != null ? String(nf.numero).trim() : '';
  let reg = null;
  for (const c of [ped.numeroLoja, nfNum, nfNum.replace(/^0+/, '')].filter(Boolean)) { reg = mmEtq.acharLote(c); if (reg) break; }
  if (!reg || !reg.batch) {
    return { ok: false, volumes: 1, via: null,
      motivo: 'a Toolbox ainda não trouxe o lote deste pedido do Madeira — abra o painel do Madeira (Etiquetas) no navegador da empresa' };
  }
  const motivoFalha = 'achei o lote ' + reg.batch + ' no Madeira, mas a etiqueta não baixou (nem o ZPL nem o PDF) — tento de novo no próximo ciclo';
  const ult = falhouEm.get(reg.batch);
  if (ult && Date.now() - ult < BACKOFF_MS) return { ok: false, volumes: 1, via: null, motivo: motivoFalha };
  /* 1) ZPL público (o que a impressão usa) */
  if (typeof mmEtq.zplPorBatch === 'function') {
    let z = null; try { z = await mmEtq.zplPorBatch(reg.batch); } catch (e) { z = null; }
    if (z && blocosZpl(z)) { try { fs.writeFileSync(fZpl, z); } catch (e) {} return { ok: true, volumes: blocosZpl(z), via: 'zpl', motivo: null }; }
  }
  /* 2) PDF com token (reserva) */
  if (typeof mmEtq.pdfPorBatch === 'function') {
    let b = null; try { b = await mmEtq.pdfPorBatch(reg.batch); } catch (e) { b = null; }
    if (b && b.length) { try { fs.writeFileSync(fPdf, b); } catch (e) {} return { ok: true, volumes: await paginasPdf(b), via: 'pdf', motivo: null }; }
  }
  falhouEm.set(reg.batch, Date.now());
  return { ok: false, volumes: 1, via: null, motivo: motivoFalha };
}

/* Codex #729: a impressão em A4 (/etiqueta-pdf) também precisa da etiqueta do Madeira quando ela só existe em ZPL (o
   PDF com token dá timeout). Converte o ZPL do ciclo (etiqueta-correios.zpl) — ou o ZPL público, se o ciclo ainda não
   baixou — com o MESMO conversor que o A4 já usa pros outros canais (zplParaPdf, Labelary), e guarda o PDF pra próxima
   vez; o PDF com token fica por último.
   o: { dir, snap, mmEtq, zplParaPdf } — devolve o Buffer do PDF ou null */
async function pdfDaEtiquetaMadeira(o) {
  const dir = o.dir, snap = o.snap || {}, mmEtq = o.mmEtq || null;
  if (!dir || snap.marketplace !== 'madeira') return null;
  let z = null;
  try { z = fs.readFileSync(path.join(dir, ARQ_ZPL), 'utf8'); } catch (e) { z = null; }
  const nfN = snap.nf && snap.nf.numero != null ? String(snap.nf.numero).trim() : '';
  let reg = null;
  if (mmEtq && typeof mmEtq.acharLote === 'function') {
    for (const c of [snap.numero_loja, nfN, nfN.replace(/^0+/, '')].filter(Boolean)) { reg = mmEtq.acharLote(c); if (reg) break; }
  }
  if (!blocosZpl(z) && reg && reg.batch && typeof mmEtq.zplPorBatch === 'function') {
    try { z = await mmEtq.zplPorBatch(reg.batch); } catch (e) { z = null; }
    if (blocosZpl(z)) { try { fs.writeFileSync(path.join(dir, ARQ_ZPL), z); } catch (e) {} }
  }
  if (blocosZpl(z) && typeof o.zplParaPdf === 'function') {
    /* Codex #729: o zplParaPdf (Labelary /0/) devolve SÓ a 1ª etiqueta — converte cada volume (^XA..^XZ) e junta; se um falhar, não guarda PDF incompleto */
    let p = null; try { p = await zplVolumesParaPdf(z, o.zplParaPdf); } catch (e) { p = null; }
    if (p && p.length) { try { fs.writeFileSync(path.join(dir, ARQ_PDF), p); } catch (e) {} return p; }
  }
  if (reg && reg.batch && typeof mmEtq.pdfPorBatch === 'function') {
    try { const b = await mmEtq.pdfPorBatch(reg.batch); if (b && b.length) return b; } catch (e) {}
  }
  return null;
}

module.exports = { etiquetaMadeiraNoCiclo, pdfDaEtiquetaMadeira, zplVolumesParaPdf, limparBackoff, ARQ_ZPL, ARQ_PDF };
