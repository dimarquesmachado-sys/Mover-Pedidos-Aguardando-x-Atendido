// ════════════════════════════════════════════════════════════════════════
//  girassol-backup-offline · módulo ciclo  (motor de sincronização — Lote 2)
//  Dono do estado: rodando / ultimoResumo / ultimoSync / idxStatus.
//  As rotas leem esse estado pelos getters exportados (getUltimoResumo, etc.).
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
const { parseNF, acharNFporRange, nfDoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = require('./nf');
const { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf } = require('./etiquetas');
const { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = require('./comum');
const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = require('./produtos');
const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = require('./arquivo');
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');

// ─── estado do ciclo (mutável; lido pelas rotas via getters) ───
let rodando = false;
let ultimoResumo = { rodouEm: null, total: 0, comEtiqueta: 0, semEtiqueta: 0, novos: 0, erros: 0 };
let ultimoSync = { em: null, pendentes: 0, ok: 0, falhas: 0 };
let idxStatus = { rodando: false, feitos: 0, eans: 0, em: null, fim: null, erro: null };
function getUltimoResumo() { return ultimoResumo; }
function getUltimoSync()   { return ultimoSync; }
function getIdxStatus()    { return idxStatus; }

async function indexarCatalogoCompleto() {
  if (idxStatus.rodando) return;
  idxStatus = { rodando: true, feitos: 0, eans: 0, em: new Date().toISOString(), fim: null, erro: null };
  const novo = lerIndiceEan();                       // parte do que já existe
  const PAUSA = Number(process.env.GIRABKP_PAUSA_MS || 700);
  try {
    let pagina = 1;
    while (pagina <= 500) {                           // trava de segurança
      const r = await blingGet(`/produtos?pagina=${pagina}&limite=100`);
      const itens = (r.ok && r.data && r.data.data) || [];
      if (!itens.length) break;
      for (const it of itens) {
        idxStatus.feitos++;
        if (!it.id) continue;
        let eans = getPossiveisGtins(it).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8);
        let nome = it.nome, sku = it.codigo;
        if (!eans.length) {                            // lista não trouxe GTIN → busca no detalhe
          const det = await produtoDetalhe(it.id);
          await sleep(PAUSA);
          if (det) { eans = getPossiveisGtins(det).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8); nome = det.nome || nome; sku = det.codigo || sku; }
        }
        for (const e of eans) { if (!novo[e]) idxStatus.eans++; novo[e] = { sku: sku || '', nome: nome || '', id: it.id }; }
      }
      writeJson(EAN_INDEX_FILE, novo);                 // salva a cada página (resiliente a queda)
      await sleep(PAUSA);
      pagina++;
    }
  } catch (e) { idxStatus.erro = String(e && e.message || e); }
  writeJson(EAN_INDEX_FILE, novo);
  idxStatus.rodando = false;
  idxStatus.fim = new Date().toISOString();
}

async function sincronizarConferidos() {
  const conf = readJson(CONFERIDOS_FILE, {});
  const ids = Object.keys(conf).filter(id => conf[id] && !conf[id].sincronizado);
  let ok = 0, falhas = 0;
  for (const id of ids) {
    const r = await moverSituacao(id, SIT_VERIFICADO);
    if (r.ok) {
      conf[id].sincronizado = true;
      conf[id].sincronizado_em = new Date().toISOString();
      delete conf[id].sync_erro;
      ok++;
      console.log(`[GIRABKP] sync ${id} → ${SIT_VERIFICADO} OK`);
    } else {
      conf[id].sync_erro = String(r.status || 'err');
      falhas++;
      console.log(`[GIRABKP] sync ${id} FALHOU (${r.status}) ${r.raw || ''}`);
    }
    await sleep(PAUSA_MS);
  }
  if (ids.length) writeJson(CONFERIDOS_FILE, conf);
  ultimoSync = { em: new Date().toISOString(), pendentes: ids.length, ok, falhas };
  return ultimoSync;
}

async function listarAtendidos() {
  const hoje = new Date();
  const ini  = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
  const qs = `idSituacao=${SIT_ATENDIDO}&dataEmissaoInicial=${dataISO(ini)}&dataEmissaoFinal=${dataISO(hoje)}`;
  const out = [];
  let fetchOk = false;
  for (let pagina = 1; pagina <= 50; pagina++) {
    const { ok, data } = await blingGet(`/pedidos/vendas?${qs}&pagina=${pagina}&limite=100`);
    if (pagina === 1) fetchOk = ok;        // marca se o Bling respondeu (p/ não limpar cache offline)
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    out.push(...lista);
    if (lista.length < 100) break;
    await sleep(PAUSA_MS);
  }
  return { ok: fetchOk, pedidos: out };
}

async function detalhePedido(id) {
  const { data } = await blingGet(`/pedidos/vendas/${id}`);
  return data && data.data;
}

async function cachearPedido(ped, cacheEan, nfs, kitCache, locC) {
  const id  = ped.id;
  const dir = path.join(CACHE_DIR, String(id));
  ensureDir(dir);

  const lojaId = String((ped.loja && ped.loja.id) || '');
  const mkt = LOJA_MKT[lojaId] || 'outro';   // marketplace (usado p/ etiqueta MM e snapshot)

  const itens = [];
  let temKit = false;
  for (const it of (ped.itens || [])) {
    const itemQty = Number(it.quantidade || 0);
    const prodId  = it.produto && it.produto.id;
    const prod    = await produtoDetalhe(prodId); await sleep(PAUSA_MS);
    const sku     = it.codigo || (prod && prod.codigo) || (it.produto && it.produto.codigo) || '';
    const eanItem = prod ? primeiroEan(prod) : await eanDoItem(prodId, sku, cacheEan);
    if (sku && eanItem) cacheEan[sku] = eanItem;
    if (sku && locC) locC[sku] = localizacaoDeProduto(prod);     // localização do produto principal
    const descr   = it.descricao || (prod && prod.nome) || '';
    const imgItem = primeiraImagem(prod);

    const comps = (prod && prod.estrutura && Array.isArray(prod.estrutura.componentes))
      ? prod.estrutura.componentes : [];

    if (comps.length) {
      // KIT / composição → explode nos componentes (com cache por produto-pai)
      temKit = true;
      let base = kitCache && kitCache[prodId];
      if (base && base.some(c => !c.sku)) base = null;   // cache tinha componente vazio (falha anterior) → resolve de novo
      if (!base) {
        base = [];
        let incompleto = false;
        for (const c of comps) {
          const info = await infoProduto(c.produto && c.produto.id, cacheEan);
          if (!info.sku) incompleto = true;
          base.push({ sku: info.sku, ean: info.ean, descricao: info.descricao, img: info.img, loc: info.loc, qtd: Number(c.quantidade || 1) });
        }
        if (kitCache && !incompleto) kitCache[prodId] = base;   // SÓ grava se TODOS resolveram (não fixa falha transitória)
      }
      if (locC) base.forEach(c => { if (c.sku) locC[c.sku] = c.loc || locC[c.sku] || ''; }); // localização dos componentes
      // qtd final = qtd do componente no kit × qtd do kit no pedido
      const componentes = base.map(c => ({ sku: c.sku, ean: c.ean, descricao: c.descricao, img: c.img, qtd: c.qtd * (itemQty || 1) }));
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, tipo: 'kit', componentes });
    } else {
      const tipo = (prod && prod.variacao && prod.variacao.produtoPai) ? 'variacao' : 'simples';
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, tipo });
    }
  }

  let nf = acharNFnaLista(id, nfs || []);
  if (!nf || !nf.id) { nf = await nfDoPedido(id); await sleep(PAUSA_MS); }   // fora do range do lote → acha pelo link direto pedido→NF

  const _etqPath = path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
  const _etqPdfPath = path.join(dir, 'etiqueta.pdf');
  let temEtiqueta = fs.existsSync(_etqPath);   // etiqueta ZPL imutável → se já tem, não re-baixa (re-cache leve)
  let etqEhPdf = false;
  if (temEtiqueta) {
    try { if (fs.readFileSync(_etqPath, 'utf8').indexOf('^XA') < 0) etqEhPdf = true; } catch (e) {}   // arquivo salvo não é ZPL → etiqueta PDF
  } else if (fs.existsSync(_etqPdfPath) && mkt !== 'madeira') {
    temEtiqueta = true; etqEhPdf = true;          // já tem só o PDF cacheado (Amazon etc) — Madeira tem bloco próprio abaixo
  } else {
    const conteudoEtiqueta = await baixarEtiqueta(id); await sleep(PAUSA_MS);
    if (conteudoEtiqueta && conteudoEtiqueta.indexOf('^XA') >= 0) {       // ZPL de verdade (ML, Shopee...)
      fs.writeFileSync(_etqPath, conteudoEtiqueta); temEtiqueta = true;
    } else if (conteudoEtiqueta || mkt === 'amazon') {                    // veio não-ZPL, OU é Amazon (cujo link ZPL vem nulo) → etiqueta é PDF
      // captura o PDF nativo do Bling AGORA (ele ainda serve); depois do despacho ele para de servir e o email ficaria sem etiqueta.
      // o "|| mkt==='amazon'" pega o caso da Amazon (sem ZPL); ML/Shopee com falha transitória NÃO caem aqui (ficam p/ o próximo ciclo).
      try { const pdf = await baixarEtiquetaPDF(id); await sleep(PAUSA_MS); if (pdf && pdf.length) { fs.writeFileSync(_etqPdfPath, pdf); temEtiqueta = true; etqEhPdf = true; } } catch (e) {}
    }
  }
  // MADEIRA MADEIRA não tem etiqueta no Bling. Se a etiqueta já está no mapa MM
  // (gerada por nós e sincronizada pela extensão), conta o pedido como PRONTO.
  let etiquetaMM = false, volumesMM = 1;
  if (!temEtiqueta && mkt === 'madeira') {
    const _mmPdf = path.join(dir, 'etiqueta.pdf');
    try {
      let bufMM = null;
      if (fs.existsSync(_mmPdf)) { bufMM = fs.readFileSync(_mmPdf); }   // já cacheado → reaproveita (não re-baixa)
      else {
        const mmEtq = require('../girassol-mm-etiquetas');
        let regMM = null;
        for (const c of [ped.numeroLoja, nf && nf.numero].filter(Boolean)) { regMM = mmEtq.acharLote(c); if (regMM) break; }
        if (regMM && regMM.batch) {
          bufMM = await mmEtq.pdfPorBatch(regMM.batch);                 // 1 pedido = TODAS as etiquetas num PDF só
          if (bufMM && bufMM.length) { try { fs.writeFileSync(_mmPdf, bufMM); } catch (e) {} }   // cacheia p/ impressão offline rápida
        }
      }
      if (bufMM && bufMM.length) {
        etiquetaMM = true;
        try { const { PDFDocument } = require('pdf-lib'); volumesMM = (await PDFDocument.load(bufMM)).getPageCount() || 1; } catch (e) {}   // volumes = nº de etiquetas (1 a 5)
      }
    } catch (e) {}
  }

  const _servico = servicoDoPedido(ped);
  const snapshot = {
    bling_id: id,
    numero: ped.numero || null,
    numero_loja: ped.numeroLoja || null,
    loja_id: lojaId || null,
    marketplace: mkt,
    servico: _servico,
    flex: ehFlex(_servico),
    situacao_id: (ped.situacao && ped.situacao.id) || SIT_ATENDIDO,
    cliente: (ped.contato && ped.contato.nome) || '',
    nf,
    itens,
    tem_nf: !!nf,
    tem_danfe: fs.existsSync(path.join(dir, 'danfe.pdf')),   // por existência do arquivo → sobrevive a re-cache
    tem_kit: temKit,
    tem_etiqueta: temEtiqueta || etiquetaMM,
    etiqueta_formato: (etiquetaMM || etqEhPdf) ? 'PDF' : (temEtiqueta ? ETIQ_FORMATO : null),
    etiqueta_mm: etiquetaMM,
    etiqueta_pdf: !!(etiquetaMM || etqEhPdf),   // etiqueta é PDF (Madeira, Amazon...) → impressão/email usam o caminho PDF
    volumes: etiquetaMM ? volumesMM : 1,
    schema: SCHEMA,
    cacheado_em: new Date().toISOString()
  };
  writeJson(path.join(dir, 'pedido.json'), snapshot);
  return snapshot;
}

async function rodarCiclo(motivo = 'cron', forcar = false) {
  if (rodando) { console.log('[GIRABKP] ciclo já em andamento — pulei'); return ultimoResumo; }
  rodando = true;
  limparProdCache();                       // zera cache de produto por ciclo
  const _kc = readJson(KIT_CACHE_FILE, {});
  const kitCache = (_kc && _kc._schema === SCHEMA && _kc.kits) ? _kc.kits : {}; // invalida se schema mudou
  const t0 = Date.now();
  let novos = 0, erros = 0;
  try {
    ensureDir(CACHE_DIR);
    console.log(`[GIRABKP] ▶ ciclo (${motivo})${forcar ? ' [FORCE]' : ''}`);
    const man      = manifest();
    const cacheEan = skuEanCache();
    const locC     = locCache();
    const { ok: listaOk, pedidos: atendidos } = await listarAtendidos();
    console.log(`[GIRABKP] ${atendidos.length} pedido(s) ATENDIDO(${SIT_ATENDIDO}) na janela de ${JANELA_DIAS}d (bling ok=${listaOk})`);

    // RECONCILIAÇÃO: remove do cache quem NÃO está mais em ATENDIDO (enviado/processado).
    // Só roda se o Bling respondeu E veio algo — assim, se o Bling cair, o cache offline é preservado.
    if (listaOk && atendidos.length > 0) {
      const idsAtuais = new Set(atendidos.map(p => String(p.id)));
      let removidos = 0;
      for (const id of Object.keys(man)) {
        if (!idsAtuais.has(String(id))) {
          try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
          delete man[id];
          removidos++;
        }
      }
      if (removidos) { salvarManifest(man); console.log(`[GIRABKP] reconciliação: ${removidos} pedido(s) saíram do ATENDIDO e foram removidos do cache`); }
    }

    // ESPELHO DO BLING: pedido que estava finalizado+sincronizado aqui mas VOLTOU pra ATENDIDO no Bling
    // (alguém reverteu lá) → desfinaliza aqui pra ele reaparecer na lista. Espelha a virada do Bling.
    if (listaOk && atendidos.length > 0) {
      const idsAtend = new Set(atendidos.map(p => String(p.id)));
      const conf = readJson(CONFERIDOS_FILE, {});
      let reabertos = 0;
      for (const id of Object.keys(conf)) {
        if (conf[id] && conf[id].sincronizado && idsAtend.has(String(id))) { delete conf[id]; reabertos++; }
      }
      if (reabertos) { writeJson(CONFERIDOS_FILE, conf); console.log(`[GIRABKP] espelho Bling: ${reabertos} pedido(s) voltaram pra ATENDIDO → desfinalizados (reaparecem na lista)`); }
    }

    // (re)processa quem não tem etiqueta OU está num schema antigo (ganha EAN+kit) OU tem kit incompleto no cache
    const aProcessar = atendidos.filter(ped => {
      if (forcar) return true;
      const ja = man[ped.id];
      if (ja && ja.tem_kit && kitIncompletoNoCache(ped.id)) return true;   // kit com componente vazio → re-resolve sozinho
      return !(ja && ja.tem_etiqueta && ja.schema === SCHEMA);
    });
    console.log(`[GIRABKP] ${aProcessar.length} a (re)processar`);

    // carrega as NFs recentes UMA vez (cobre o menor id do lote) e casa em memória
    let nfs = [];
    if (aProcessar.length) {
      const idMin = Math.min(...aProcessar.map(p => Number(p.id) || Infinity));
      if (Number.isFinite(idMin)) {
        nfs = await carregarNFs(idMin - 5);
        console.log(`[GIRABKP] ${nfs.length} NF(s) recentes carregadas p/ casar`);
      }
    }

    for (const ped of aProcessar) {
      const id = ped.id;
      const ja = man[id];
      try {
        const det = await detalhePedido(id); await sleep(PAUSA_MS);
        if (!det) { erros++; continue; }
        const snap = await cachearPedido(det, cacheEan, nfs, kitCache, locC);
        man[id] = {
          numero: snap.numero, marketplace: snap.marketplace,
          servico: snap.servico || '', flex: !!snap.flex,
          cliente: snap.cliente || '', nf_numero: (snap.nf && snap.nf.numero) || null,
          tem_nf: snap.tem_nf, tem_kit: snap.tem_kit, tem_etiqueta: snap.tem_etiqueta,
          tem_danfe: !!(ja && ja.tem_danfe),
          itens: snap.itens.length, schema: snap.schema, volumes: snap.volumes || 1, cacheado_em: snap.cacheado_em
        };
        if (!ja) novos++;
        salvarManifest(man);
        salvarSkuEan(cacheEan);
        salvarLoc(locC);
        writeJson(KIT_CACHE_FILE, { _schema: SCHEMA, kits: kitCache });
      } catch (e) { erros++; console.error(`[GIRABKP] erro pedido ${id}:`, e.message); }
      await sleep(PAUSA_MS);
    }

    // passo: baixa o DANFE que falta (TODOS — fica pronto p/ offline rápido)
    let danfesNovos = 0, danfesFalha = 0, danfesSemId = 0, danfesReparo = 0;
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'danfe.pdf'))) {
        // já tem o PDF — garante o flag tem_danfe (re-cache pode ter limpado o campo)
        const s = readJson(path.join(dir, 'pedido.json'), null);
        if (s && !s.tem_danfe) { s.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), s); danfesReparo++; }
        if (man[ped.id] && !man[ped.id].tem_danfe) { man[ped.id].tem_danfe = true; danfesReparo++; }
        continue;
      }
      const snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap || !snap.nf || !snap.nf.id) { danfesSemId++; continue; }
      const pdf = await baixarDanfe(snap.nf.id); await sleep(PAUSA_MS);
      if (pdf) {
        fs.writeFileSync(path.join(dir, 'danfe.pdf'), pdf);
        snap.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), snap);
        if (man[ped.id]) man[ped.id].tem_danfe = true;
        danfesNovos++;
      } else { danfesFalha++; }
    }
    if (danfesNovos || danfesReparo) salvarManifest(man);
    console.log(`[GIRABKP] DANFE: ${danfesNovos} novos, ${danfesReparo} reparados, ${danfesFalha} falha, ${danfesSemId} sem nf.id`);

    // passo: cacheia os DADOS do DANFE SIMPLIFICADO (p/ imprimir 10x15 na Zebra OFFLINE)
    //        guarda o parsed (nf-simp.json) — o PDF é gerado na hora pela rota /danfe-simp
    let simpNovos = 0, simpFalha = 0, simpSemId = 0, simpCurados = 0;
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'nf-simp.json'))) continue;   // já tem
      const snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap) { simpSemId++; continue; }
      let nfId = snap.nf && snap.nf.id;
      if (!nfId) {   // re-cache antigo pode ter perdido o nf.id → acha ao vivo e CURA o snapshot
        try {
          const nf = await nfDoPedido(ped.id); await sleep(PAUSA_MS);
          if (nf && nf.id) {
            nfId = nf.id; snap.nf = nf; snap.tem_nf = true;
            writeJson(path.join(dir, 'pedido.json'), snap);
            if (man[ped.id]) { man[ped.id].tem_nf = true; man[ped.id].nf_numero = nf.numero || null; }
            simpCurados++;
          }
        } catch (e) {}
      }
      if (!nfId) { simpSemId++; continue; }
      try {
        const ds = await dadosNFSimp(nfId, snap.numero); await sleep(PAUSA_MS);
        if (ds) { writeJson(path.join(dir, 'nf-simp.json'), ds); simpNovos++; }
        else simpFalha++;
      } catch (e) { simpFalha++; }
    }
    if (simpCurados) salvarManifest(man);
    console.log(`[GIRABKP] DANFE-simp: ${simpNovos} novos, ${simpCurados} curados, ${simpFalha} falha, ${simpSemId} sem nf`);

    // passo: baixa a ETIQUETA em PDF (p/ modo A4 / fallback Zebra) — só de quem já tem ZPL
    let etqPdfNovos = 0;
    const extEtq = ETIQ_FORMATO.toLowerCase();
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'etiqueta.pdf'))) continue;
      if (!fs.existsSync(path.join(dir, `etiqueta.${extEtq}`))) continue;
      const pdf = await baixarEtiquetaPDF(ped.id); await sleep(PAUSA_MS);
      if (pdf) { fs.writeFileSync(path.join(dir, 'etiqueta.pdf'), pdf); etqPdfNovos++; }
    }
    if (etqPdfNovos) console.log(`[GIRABKP] ${etqPdfNovos} etiqueta(s) PDF cacheadas`);

    // passo: garante servico + flex no manifest (p/ filtro marketplace/FLEX) — lê detalhe só de quem falta
    let svcNovos = 0;
    for (const ped of atendidos) {
      const m = man[ped.id];
      if (!m || m.servico !== undefined) continue;
      const det = await detalhePedido(ped.id); await sleep(PAUSA_MS);
      const svc = servicoDoPedido(det);
      m.servico = svc; m.flex = ehFlex(svc);
      // aproveita p/ preencher o snapshot também
      const snapPath = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
      const snap = readJson(snapPath, null);
      if (snap) { snap.servico = svc; snap.flex = ehFlex(svc); writeJson(snapPath, snap); }
      svcNovos++;
    }
    if (svcNovos) { salvarManifest(man); console.log(`[GIRABKP] ${svcNovos} servico/flex preenchidos`); }

    // recalcula o flex de quem JÁ tem servico em cache (barato, sem Bling) — pega mudança nas FLEX_KEYWORDS
    let flexFix = 0;
    for (const ped of atendidos) {
      const m = man[ped.id];
      if (!m || m.servico === undefined) continue;
      const nf = ehFlex(m.servico);
      if (m.flex !== nf) {
        m.flex = nf;
        const sp = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
        const sn = readJson(sp, null);
        if (sn) { sn.flex = nf; writeJson(sp, sn); }
        flexFix++;
      }
    }
    if (flexFix) { salvarManifest(man); console.log(`[GIRABKP] ${flexFix} flex recalculado`); }

    // passo: aquece as LOCALIZAÇÕES que faltam (SKUs a separar) — teto por ciclo (mais alto no force)
    if (listaOk) {
      const sepSkus = montarSeparacao(null).linhas
        .map(l => l.sku).filter(s => s && s !== '(sem SKU)' && !(s in locC));
      const tetoLoc = forcar ? 80 : 25;
      let locNovas = 0;
      for (const sku of sepSkus) {
        if (locNovas >= tetoLoc) break;
        locC[sku] = await localizacaoPorSku(sku); await sleep(PAUSA_MS);
        locNovas++;
      }
      if (locNovas) { salvarLoc(locC); console.log(`[GIRABKP] ${locNovas} localização(ões) aquecidas`); }
    }

    // FASE 3: Bling respondeu (listaOk) → drena a fila de conferidos offline p/ VERIFICADO (24)
    // só roda automático se GIRABKP_SYNC_ON=1 (trava de segurança até você testar)
    if (listaOk && SYNC_ON) {
      const sync = await sincronizarConferidos();
      if (sync.pendentes) console.log(`[GIRABKP] sync conferidos→${SIT_VERIFICADO}: ${sync.ok} ok, ${sync.falhas} falha(s) de ${sync.pendentes}`);
    }

    purgar(man);
    purgarArquivo();
    purgarConferidos();
    salvarManifest(man);

    const ids = Object.keys(man);
    ultimoResumo = {
      rodouEm: new Date().toISOString(),
      duracaoSeg: Math.round((Date.now() - t0) / 1000),
      blingOk: listaOk,                            // o Bling respondeu neste ciclo? (p/ o /saude)
      total: ids.length,
      comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
      semEtiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
      novos, erros
    };
    console.log('[GIRABKP] ✔ ciclo:', JSON.stringify(ultimoResumo));
  } catch (e) {
    console.error('[GIRABKP] ciclo falhou:', e.message);
  } finally {
    rodando = false;
  }
  return ultimoResumo;
}

module.exports = { indexarCatalogoCompleto, sincronizarConferidos, listarAtendidos, detalhePedido, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus };
