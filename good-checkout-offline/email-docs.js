// ════════════════════════════════════════════════════════════════════════
//  good-checkout-offline · módulo email-docs  (extraído do index.js — Lote 1)
// ════════════════════════════════════════════════════════════════════════
'use strict';
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const base  = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;

const { etiquetaPdf, zplParaPdf } = require('./etiquetas');
const { dadosNFSimp, nfDoPedido } = require('./nf');
const { gerarDanfeSimplificado, gerarTiraNF } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// junta etiqueta + DANFE numa ÚNICA página: etiqueta encolhida no topo, DANFE embaixo
async function fundirNumaPagina(etqBuf, danfeBuf) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    const [etq] = await out.embedPdf(etqBuf);
    const [dan] = await out.embedPdf(danfeBuf);
    const ew = etq.width, eh = etq.height, dw = dan.width, dh = dan.height;
    const W = ew, H = eh, GAP = 6;
    const dMaxH = H * 0.42;                            // DANFE ocupa até 42% de baixo
    const dScale = Math.min(W / dw, dMaxH / dh);
    const dW = dw * dScale, dH = dh * dScale;
    const eScale = Math.min(1, (H - dH - GAP) / eh);  // etiqueta encolhe pra caber no resto
    const eW = ew * eScale, eH = eh * eScale;
    const page = out.addPage([W, H]);
    page.drawPage(etq, { x: (W - eW) / 2, y: H - eH, width: eW, height: eH });   // etiqueta no topo
    page.drawPage(dan, { x: (W - dW) / 2, y: 0,       width: dW, height: dH });  // DANFE embaixo
    return Buffer.from(await out.save());
  } catch (e) { return null; }
}

async function enviarEmailDocs(id, quem) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (e) { return { ok: false, erro: 'nodemailer não instalado — atualize o package.json e redeploy' }; }
  if (!EMAIL_USER || !EMAIL_PASS) return { ok: false, erro: 'email não configurado (faltam GOODBKP_EMAIL_USER / GOODBKP_EMAIL_PASS no Render)' };
  // pedido FINALIZADO mora no arquivo; pedido AINDA NA FILA mora no cache ativo (mesma estrutura de pasta).
  // Assim o admin consegue mandar etiqueta+NF por e-mail direto do card, antes mesmo de finalizar.
  const BASE = fs.existsSync(path.join(ARQUIVO_DIR, String(id), 'pedido.json')) ? ARQUIVO_DIR : CACHE_DIR;
  const ped = readJson(path.join(BASE, String(id), 'pedido.json'), null);
  if (!ped) return { ok: false, erro: 'pedido não encontrado (nem no arquivo de finalizados, nem no cache ativo)' };
  const anexos = [];
  let temEtq = false, temDanfe = false;
  const ehShopee = ped.marketplace === 'shopee';   // Shopee: a etiqueta já vem com a DANFE embaixo → não anexa DANFE separado
  // se o snapshot não tem NF (ou veio sem id), busca fresca no Bling — reimpressão é sempre com Bling no ar (Shopee não precisa)
  if (!ehShopee && (!ped.nf || !ped.nf.id)) {
    try { const nf = await nfDoPedido(id); if (nf && nf.id) ped.nf = nf; } catch (e) {}
  }
  // 1º TENTA FUNDIR etiqueta + DANFE num PDF só (mesma fusão da impressão) — não-Shopee, com NF
  let fundiu = false, umaFolha = false;
  if (!ehShopee && ped.nf) {
    try {
      const dir = path.join(BASE, String(id));
      const zplEtq = fs.readFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8');
      if (/\^XA/.test(zplEtq)) {
        let dados = readJson(path.join(dir, 'nf-simp.json'), null);
        const nfId = ped.nf && ped.nf.id;
        if (!dados && nfId) dados = await dadosNFSimp(nfId, ped.numero);
        if (dados) {
          const r = fundirEtiquetaComDanfe(zplEtq, dados);
          // RASTER que perde a chave (ex.: etiqueta Melhor Envio): a tira mínima vem SEM o barcode, e a
          // imagem (diferente do TikTok) NÃO traz a chave da NF → manda etiqueta (pág 1) + DANFE completa COM barcode (pág 2).
          const rasterSemChave = (r.modo === 'linha-raster' || r.modo === 'declinou') && ped.marketplace !== 'tiktok';
          if (rasterSemChave) {
            const etqPdf  = await etiquetaPdf(id, dir);
            const tiraPdf = await gerarTiraNF(dados);   // só a tira compacta (NF + barcode + chave), NÃO a DANFE inteira
            const merged  = (etqPdf && tiraPdf) ? await fundirNumaPagina(etqPdf, tiraPdf) : null;
            if (merged) { anexos.push({ filename: `etiqueta-${ped.numero || id}.pdf`, content: merged }); temEtq = true; temDanfe = true; fundiu = true; umaFolha = true; }
          } else if (r.modo !== 'declinou') {
            const fundPdf = await zplParaPdf(r.zpl);
            if (fundPdf) { anexos.push({ filename: `etiqueta-${ped.numero || id}.pdf`, content: fundPdf }); temEtq = true; temDanfe = true; fundiu = true; }
          }
        }
      }
    } catch (e) {}
  }
  // se NÃO fundiu → jeito antigo: etiqueta PDF + DANFE PDF separados (fallback seguro)
  if (!fundiu) {
    // ETIQUETA em PDF — função canônica (ML: PDF nativo do Bling; não-ML: ZPL cacheado → Labelary)
    try {
      const etqPdf = await etiquetaPdf(id, path.join(BASE, String(id)));
      if (etqPdf) { anexos.push({ filename: `etiqueta-${ped.numero || id}.pdf`, content: etqPdf }); temEtq = true; }
    } catch (e) {}
    // DANFE SIMPLIFICADO (igual ao que imprime no checkout) — Shopee NÃO precisa (já vem embaixo da etiqueta)
    if (!ehShopee) {
      try {
        let dados = readJson(path.join(BASE, String(id), 'nf-simp.json'), null);
        const nfId = ped.nf && ped.nf.id;
        if (!dados && nfId) dados = await dadosNFSimp(nfId, ped.numero);
        const simpPdf = dados ? await gerarDanfeSimplificado(dados) : null;
        if (simpPdf) { anexos.push({ filename: `danfe-simplificado-${(ped.nf && ped.nf.numero) || id}.pdf`, content: simpPdf }); temDanfe = true; }
      } catch (e) {}
    }
  }
  if (!anexos.length) return { ok: false, erro: 'sem documentos pra enviar (etiqueta nem DANFE disponíveis)' };
  try {
    const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
    const mktNome = MKT_NOME[ped.marketplace] || ped.marketplace || '—';
    const oQueVai = umaFolha
      ? 'etiqueta + DANFE numa folha só, com o código da chave'
      : fundiu
        ? 'etiqueta + DANFE numa folha só (1 etiqueta)'
        : (ehShopee && temEtq)
          ? 'etiqueta de postagem (já inclui a DANFE embaixo)'
          : [temEtq ? 'etiqueta' : null, temDanfe ? 'DANFE simplificado' : null].filter(Boolean).join(' + ');
    const corpo = 'Reimpressão solicitada pelo Checkout Offline.\n\n'
      + 'Pedido: ' + (ped.numero || id) + '\n'
      + 'Cliente: ' + (ped.cliente || '—') + '\n'
      + 'Marketplace: ' + mktNome + '\n'
      + (ped.nf ? 'NF: ' + (ped.nf.numero || '') + '\n' : '')
      + '\nSeguem em anexo: ' + oQueVai + ' (pra imprimir e despachar).\n\n'
      + '(solicitado por ' + (quem || 'admin') + ' em ' + new Date().toLocaleString('pt-BR') + ')';
    await transporter.sendMail({
      from: EMAIL_USER,
      to: EMAIL_DEST,
      subject: '📦 Reimprimir pedido ' + (ped.numero || id) + (ped.cliente ? ' — ' + ped.cliente : ''),
      text: corpo,
      attachments: anexos
    });
    return { ok: true, enviado_para: EMAIL_DEST, anexos: anexos.length, etiqueta: temEtq, danfe: temDanfe };
  } catch (e) { return { ok: false, erro: 'falha no envio SMTP: ' + e.message }; }
}

module.exports = { enviarEmailDocs };
