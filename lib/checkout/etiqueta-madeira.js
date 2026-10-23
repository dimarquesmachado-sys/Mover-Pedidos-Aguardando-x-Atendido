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
  return { ok: false, volumes: 1, via: null,
    motivo: 'achei o lote ' + reg.batch + ' no Madeira, mas a etiqueta não baixou (nem o ZPL nem o PDF) — tento de novo no próximo ciclo' };
}

module.exports = { etiquetaMadeiraNoCiclo, ARQ_ZPL, ARQ_PDF };
