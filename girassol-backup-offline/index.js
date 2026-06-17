'use strict';

// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · CHECKOUT OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
//  girassol-backup-offline v16/06 b26   (a versão real é a const VERSAO abaixo)
// ════════════════════════════════════════════════════════════════════════
//  Módulo do orquestrador unificado (HTTP-native, sem Express).
//  Reaproveita o token Bling da Girassol via ../girassol/tokenManager.
//
//  A cada ciclo (cron backupCache):
//    1) lista pedidos ATENDIDO (situação 9) da janela de emissão;
//    2) pra cada pedido ainda NÃO cacheado por completo:
//         - detalhe (cliente + itens com SKU/qtd);
//         - EAN de cada item (produto, getPossiveisGtins robusto);
//         - NF (nº + chave) via /pedidos/vendas/{id}/nfe;
//         - ETIQUETA (ZPL) via /logisticas/etiquetas → baixa o link p/ /data;
//    3) purga o cache fora da janela de retenção.
//
//  Cache no disco /data do PRÓPRIO serviço Mover-Pedidos. A tela offline
//  (Fase 2) também morará aqui (mesmo serviço = mesmo disco = mesmo cache).
//
//  ⚠ PRÉ-REQUISITO de scope no app Bling da Girassol (Mover-Pedidos):
//     • Logísticas (leitura)  → necessário p/ /logisticas/etiquetas
//     • Produtos  (leitura)   → necessário p/ resolver EAN por produto
//     Se faltar: o pedido ainda é cacheado, mas vem sem etiqueta / sem EAN.
//     Adiciona os scopes e re-autoriza pelo /setup (cola o auth_code).
// ════════════════════════════════════════════════════════════════════════

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { garantirToken } = require('../girassol/tokenManager');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: GIRABKP_QZ_CERT (digital-certificate.txt) e GIRABKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.GIRABKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.GIRABKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

const VERSAO     = 'girassol-backup-offline v16/06 b26';
const BLING_BASE = 'https://api.bling.com.br/Api/v3';

// ─── Config (env prefixo GIRABKP_, defaults sãos) ───────────────────────
const CACHE_DIR     = process.env.GIRABKP_CACHE_DIR    || '/data/cache-offline/girassol';
const SIT_ATENDIDO  = Number(process.env.GIRABKP_SIT_ATENDIDO  || 9);              // ATENDIDO
const SIT_VERIFICADO = Number(process.env.GIRABKP_SIT_VERIFICADO || 24);           // VERIFICADO (destino do sync Fase 3)
const SYNC_ON       = process.env.GIRABKP_SYNC_ON === '1';                          // liga o sync automático no cron (Fase 3)
const JANELA_DIAS   = Number(process.env.GIRABKP_JANELA_DIAS   || 5);
const PAUSA_MS      = Number(process.env.GIRABKP_PAUSA_MS      || 350);            // ~3 req/s
const RETENCAO_DIAS = Number(process.env.GIRABKP_RETENCAO_DIAS || 7);
const ETIQ_FORMATO  = (process.env.GIRABKP_ETIQ_FORMATO || 'ZPL').toUpperCase();   // ZPL | PDF
const CRON_EXPR     = process.env.GIRABKP_CRON || '5,15,25,35,45,55 6-23 * * *';   // off do F3

const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SKU_EAN_FILE  = path.join(CACHE_DIR, 'sku-ean.json');
const CONFERIDOS_FILE = path.join(CACHE_DIR, 'conferidos.json');
const KIT_CACHE_FILE  = path.join(CACHE_DIR, 'kit-estrutura.json');  // kits já resolvidos
const SCHEMA = 3;  // versão do snapshot — bump força re-cache dos pedidos antigos

// loja → marketplace (mesmo mapa do checkout Girassol)
const LOJA_MKT = {
  '203146903': 'ml', '203583169': 'shopee', '203967708': 'amazon',
  '203262016': 'magalu', '205523707': 'tiktok'
};

// FLEX = entrega por motoboy (etiqueta sempre disponível). Mesma lógica do checkout-expedição.
const FLEX_KEYWORDS = ['mercado envios flex', 'entrega local', 'vapt', 'shopee entrega direta'];
function servicoDoPedido(det) {
  if (!det) return '';
  const t = det.transporte || {};
  const vol = (t.volumes && t.volumes[0]) || {};
  return String(vol.servico || t.servico || '').trim();
}
function ehFlex(servico) {
  const s = String(servico || '').toLowerCase();
  return FLEX_KEYWORDS.some(k => s.includes(k));
}

// ─── helpers genéricos ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; } }
function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('[GIRABKP] write', file, e.message); }
}
function dataISO(d) { return d.toISOString().slice(0, 10); }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function html(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }

// EAN robusto — varre todos os nomes de campo que o Bling usa pro GTIN
function getPossiveisGtins(obj) {
  if (!obj) return [];
  const c = [
    obj.gtin, obj.ean, obj.codigoBarras, obj.gtinEan, obj.gtinTributario,
    obj.codigo_barras, obj.codigoDeBarras, obj.codBarras, obj.codigobarras,
    obj.gtinEmbalagem, obj.gtin_embalagem, obj.codigoBarrasTributario,
    obj.eanTributario, obj.gtinEanTributario,
    obj.tributavel && obj.tributavel.gtin, obj.tributavel && obj.tributavel.ean,
    obj.tributacao && obj.tributacao.gtin, obj.tributacao && obj.tributacao.ean,
    obj.tributario && obj.tributario.gtin, obj.tributario && obj.tributario.ean
  ];
  if (obj.tributacao) {
    Object.values(obj.tributacao).forEach(v => { if (typeof v === 'string' && v.length >= 8) c.push(v); });
  }
  return c.filter(Boolean).map(String);
}
function primeiroEan(produto) {
  const g = getPossiveisGtins(produto);
  return g.find(x => /^\d{8,14}$/.test(x)) || g[0] || null;
}

// 1ª imagem do produto (lista traz imagemURL; detalhe traz midia.imagens.externas[].link)
function primeiraImagem(prod) {
  if (!prod) return null;
  if (prod.imagemURL) return prod.imagemURL;
  const ext = prod.midia && prod.midia.imagens && prod.midia.imagens.externas;
  if (ext && ext[0] && ext[0].link) return ext[0].link;
  const url = prod.midia && prod.midia.imagens && prod.midia.imagens.imagensURL;
  if (url && url[0] && (url[0].link || url[0])) return url[0].link || url[0];
  return null;
}

// ─── estado do módulo ───────────────────────────────────────────────────
let rodando = false;
let ultimoResumo = { rodouEm: null, total: 0, comEtiqueta: 0, semEtiqueta: 0, novos: 0, erros: 0 };
let ultimoSync = { em: null, pendentes: 0, ok: 0, falhas: 0 };

const manifest       = () => readJson(MANIFEST_FILE, {});
const salvarManifest = (m) => writeJson(MANIFEST_FILE, m);
const skuEanCache    = () => readJson(SKU_EAN_FILE, {});
const salvarSkuEan   = (m) => writeJson(SKU_EAN_FILE, m);

// GET autenticado no Bling Girassol (token via tokenManager + retry 429)
async function blingGet(pathUrl, tentativas = 3) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  for (let t = 0; t < tentativas; t++) {
    let r;
    try {
      r = await fetch(BLING_BASE + pathUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (e) { await sleep(800); continue; }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  return { ok: false, status: 429, data: null };
}

// escrita no Bling (PATCH/POST/PUT) — mesmo cuidado do blingGet (token + retry 429)
async function blingWrite(method, pathUrl, body) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  for (let t = 0; t < 3; t++) {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
    if (body !== undefined && body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BLING_BASE + pathUrl, opts); }
    catch (e) { await sleep(800); continue; }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data, raw: (txt || '').slice(0, 300) };
  }
  return { ok: false, status: 429, data: null };
}

// muda a situação de um pedido de venda (precisa do escopo "Gerenciar situações")
async function moverSituacao(blingId, idSituacao) {
  return await blingWrite('PATCH', `/pedidos/vendas/${blingId}/situacoes/${idSituacao}`, null);
}

// FASE 3: empurra os pedidos conferidos offline (sincronizado:false) p/ VERIFICADO no Bling
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

function parseNF(nf) {
  if (!nf) return null;
  return {
    id: nf.id || null,
    numero: nf.numero || null,
    chave: nf.chaveAcesso || nf.chave || null,
    situacao: (nf.situacao && (nf.situacao.id || nf.situacao)) || null
  };
}

// método mandado pelo Diego: pagina /nfe (sem filtro) e acha a NF com id
// entre pedidoId e pedidoId+2000 (ids sequenciais). /nfe vem desc por id.
async function acharNFporRange(pedidoId) {
  const pid = Number(pedidoId);
  if (!pid) return null;
  const teto = pid + 2000;
  let melhor = null;
  for (let pagina = 1; pagina <= 12; pagina++) {
    const { ok, data } = await blingGet(`/nfe?limite=100&pagina=${pagina}`);
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    let menorIdPagina = Infinity;
    for (const nf of lista) {
      const nid = Number(nf.id) || 0;
      if (nid && nid < menorIdPagina) menorIdPagina = nid;
      if (nid >= pid && nid <= teto && (!melhor || nid < Number(melhor.id))) melhor = nf;
    }
    if (menorIdPagina < pid) break; // já passou abaixo do pedido → não acha mais
    await sleep(PAUSA_MS);
  }
  return parseNF(melhor);
}

async function nfDoPedido(id) {
  // 1) tenta o endpoint direto (barato)
  const r = await blingGet(`/pedidos/vendas/${id}/nfe`);
  if (r.ok) {
    let nf = r.data && r.data.data;
    if (Array.isArray(nf)) nf = nf[0];
    if (nf) return parseNF(nf);
  }
  // 2) fallback: range de ID no /nfe
  return await acharNFporRange(id);
}

// ── NF em LOTE (eficiente p/ o ciclo): pagina /nfe UMA vez até cobrir o
//    menor id de pedido do lote, e casa todos em memória. /nfe vem desc por id.
async function carregarNFs(idMinimo) {
  const nfs = [];
  for (let pagina = 1; pagina <= 40; pagina++) {
    const { ok, data } = await blingGet(`/nfe?limite=100&pagina=${pagina}`);
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    let menor = Infinity;
    for (const nf of lista) {
      const nid = Number(nf.id) || 0;
      nfs.push(nf);
      if (nid && nid < menor) menor = nid;
    }
    if (menor < idMinimo) break; // já cobriu o lote
    await sleep(PAUSA_MS);
  }
  return nfs;
}
function acharNFnaLista(pedidoId, nfs) {
  const pid = Number(pedidoId);
  if (!pid) return null;
  const teto = pid + 2000;
  let melhor = null;
  for (const nf of nfs) {
    const nid = Number(nf.id) || 0;
    if (nid >= pid && nid <= teto && (!melhor || nid < Number(melhor.id))) melhor = nf;
  }
  return parseNF(melhor);
}

// EAN: produto por id → produto por SKU. Cacheia por SKU.
async function eanDoItem(produtoId, sku, cacheEan) {
  if (sku && Object.prototype.hasOwnProperty.call(cacheEan, sku)) return cacheEan[sku];
  let ean = null;
  try {
    if (produtoId) {
      const { data } = await blingGet(`/produtos/${produtoId}`);
      ean = primeiroEan(data && data.data);
    }
    if (!ean && sku) {
      await sleep(PAUSA_MS);
      const { data } = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      ean = primeiroEan(data && data.data && data.data[0]);
    }
  } catch (e) { /* sem scope Produtos → ean=null */ }
  if (sku) cacheEan[sku] = ean;
  return ean;
}

// detalhe completo do produto (/produtos/{id}) com cache por ciclo
let _prodCache = new Map();
async function produtoDetalhe(id) {
  if (!id) return null;
  if (_prodCache.has(id)) return _prodCache.get(id);
  let prod = null;
  try {
    const r = await blingGet(`/produtos/${id}`);
    prod = (r.ok && r.data && r.data.data) ? r.data.data : null;
  } catch (e) {}
  _prodCache.set(id, prod);
  return prod;
}

// {sku, ean, descricao, img} de um produto por id (usa cacheEan por SKU)
async function infoProduto(id, cacheEan) {
  const prod = await produtoDetalhe(id);
  await sleep(PAUSA_MS);
  const sku = (prod && prod.codigo) || '';
  let ean = prod ? primeiroEan(prod) : null;
  if (sku) { if (ean) cacheEan[sku] = ean; else if (cacheEan[sku]) ean = cacheEan[sku]; }
  return { sku, ean, descricao: (prod && prod.nome) || '', img: primeiraImagem(prod) };
}

// baixa a etiqueta de envio. O Bling devolve um ZIP (com "Etiqueta de envio.txt"
// dentro = o ZPL), mesmo pedindo formato=ZPL. Então: baixa binário → descompacta.
async function baixarEtiqueta(blingId) {
  const { ok, data } = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas[]=${blingId}`);
  const item = ok && data && data.data && data.data[0];
  const link = item && item.link;
  if (!link) return null;
  try {
    const r = await fetch(link);
    if (!r.ok) return null;
    const buf = await r.buffer();
    if (!buf || buf.length < 4) return null;
    // 'PK' (0x50 0x4B) = arquivo ZIP → descompacta e pega o conteúdo
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
      try {
        const zip = new AdmZip(buf);
        const entries = zip.getEntries();
        if (!entries.length) return null;
        const ent = entries.find(e => /\.(txt|zpl)$/i.test(e.entryName)) || entries[0];
        const conteudo = ent.getData().toString('utf8');
        return conteudo || null;
      } catch (e) { return null; }
    }
    // não-zip: assume conteúdo direto (ZPL/texto)
    const txt = buf.toString('utf8');
    if (!txt || /<html|not\s*found/i.test(txt.slice(0, 200))) return null;
    return txt;
  } catch (e) { return null; }
}

// baixa o DANFE em PDF da NF (via /nfe/{id} → linkPDF). Retorna Buffer ou null.
async function baixarDanfe(nfId) {
  if (!nfId) return null;
  try {
    const det = await blingGet(`/nfe/${nfId}`);
    const nf = det.data && det.data.data;
    const link = nf && nf.linkPDF;
    if (!link) return null;
    const resp = await fetch(link, { redirect: 'follow' });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return null; // não veio PDF (bloqueio?)
    return buf;
  } catch (e) { return null; }
}

// baixa a ETIQUETA em PDF (formato=PDF) — p/ modo A4 / fallback se a Zebra morrer
async function baixarEtiquetaPDF(blingId) {
  const { ok, data } = await blingGet(`/logisticas/etiquetas?formato=PDF&idsVendas[]=${blingId}`);
  const item = ok && data && data.data && data.data[0];
  const link = item && item.link;
  if (!link) return null;
  try {
    const r = await fetch(link);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return null;
    return buf;
  } catch (e) { return null; }
}

// converte ZPL → PDF via Labelary (serviço externo). Usado SÓ sob demanda p/ não-ML.
async function zplParaPdf(zpl) {
  if (!zpl || zpl.indexOf('^XA') < 0) return null; // não parece ZPL
  try {
    const r = await fetch('https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/', {
      method: 'POST',
      headers: { 'Accept': 'application/pdf', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: zpl
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return null;
    return buf;
  } catch (e) { return null; }
}

// etiqueta em PDF: ML usa o PDF nativo do Bling; não-ML usa o ZPL cacheado → Labelary
// (não-ML NÃO depende do Bling — funciona mesmo com o Bling fora do ar)
async function etiquetaPdf(blingId, dir) {
  let mkt = null;
  try { mkt = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')).marketplace; } catch (e) {}
  if (mkt === 'ml' || mkt === null) { // ML (ou desconhecido): tenta o PDF do Bling
    const direto = await baixarEtiquetaPDF(blingId);
    if (direto) return direto;
  }
  // não-ML (ou ML sem PDF): ZPL cacheado em disco → Labelary
  let zpl = null;
  if (dir) { try { zpl = fs.readFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8'); } catch (e) {} }
  if (!zpl) { try { zpl = await baixarEtiqueta(blingId); } catch (e) {} }
  if (!zpl) return null;
  return await zplParaPdf(zpl);
}

async function cachearPedido(ped, cacheEan, nfs, kitCache) {
  const id  = ped.id;
  const dir = path.join(CACHE_DIR, String(id));
  ensureDir(dir);

  const lojaId = String((ped.loja && ped.loja.id) || '');

  const itens = [];
  let temKit = false;
  for (const it of (ped.itens || [])) {
    const itemQty = Number(it.quantidade || 0);
    const prodId  = it.produto && it.produto.id;
    const prod    = await produtoDetalhe(prodId); await sleep(PAUSA_MS);
    const sku     = it.codigo || (prod && prod.codigo) || (it.produto && it.produto.codigo) || '';
    const eanItem = prod ? primeiroEan(prod) : await eanDoItem(prodId, sku, cacheEan);
    if (sku && eanItem) cacheEan[sku] = eanItem;
    const descr   = it.descricao || (prod && prod.nome) || '';
    const imgItem = primeiraImagem(prod);

    const comps = (prod && prod.estrutura && Array.isArray(prod.estrutura.componentes))
      ? prod.estrutura.componentes : [];

    if (comps.length) {
      // KIT / composição → explode nos componentes (com cache por produto-pai)
      temKit = true;
      let base = kitCache && kitCache[prodId];
      if (!base) {
        base = [];
        for (const c of comps) {
          const info = await infoProduto(c.produto && c.produto.id, cacheEan);
          base.push({ sku: info.sku, ean: info.ean, descricao: info.descricao, img: info.img, qtd: Number(c.quantidade || 1) });
        }
        if (kitCache) kitCache[prodId] = base;
      }
      // qtd final = qtd do componente no kit × qtd do kit no pedido
      const componentes = base.map(c => ({ sku: c.sku, ean: c.ean, descricao: c.descricao, img: c.img, qtd: c.qtd * (itemQty || 1) }));
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, tipo: 'kit', componentes });
    } else {
      const tipo = (prod && prod.variacao && prod.variacao.produtoPai) ? 'variacao' : 'simples';
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, tipo });
    }
  }

  const nf = acharNFnaLista(id, nfs || []);

  const conteudoEtiqueta = await baixarEtiqueta(id); await sleep(PAUSA_MS);
  let temEtiqueta = false;
  if (conteudoEtiqueta) {
    fs.writeFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), conteudoEtiqueta);
    temEtiqueta = true;
  }

  const _servico = servicoDoPedido(ped);
  const snapshot = {
    bling_id: id,
    numero: ped.numero || null,
    numero_loja: ped.numeroLoja || null,
    loja_id: lojaId || null,
    marketplace: LOJA_MKT[lojaId] || 'outro',
    servico: _servico,
    flex: ehFlex(_servico),
    situacao_id: (ped.situacao && ped.situacao.id) || SIT_ATENDIDO,
    cliente: (ped.contato && ped.contato.nome) || '',
    nf,
    itens,
    tem_nf: !!nf,
    tem_kit: temKit,
    tem_etiqueta: temEtiqueta,
    etiqueta_formato: temEtiqueta ? ETIQ_FORMATO : null,
    schema: SCHEMA,
    cacheado_em: new Date().toISOString()
  };
  writeJson(path.join(dir, 'pedido.json'), snapshot);
  return snapshot;
}

function purgar(man) {
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(man)) {
    const t = Date.parse(man[id].cacheado_em || 0) || 0;
    if (t && t < limite) {
      try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
      delete man[id];
    }
  }
}

async function rodarCiclo(motivo = 'cron', forcar = false) {
  if (rodando) { console.log('[GIRABKP] ciclo já em andamento — pulei'); return ultimoResumo; }
  rodando = true;
  _prodCache = new Map();                       // zera cache de produto por ciclo
  const _kc = readJson(KIT_CACHE_FILE, {});
  const kitCache = (_kc && _kc._schema === SCHEMA && _kc.kits) ? _kc.kits : {}; // invalida se schema mudou
  const t0 = Date.now();
  let novos = 0, erros = 0;
  try {
    ensureDir(CACHE_DIR);
    console.log(`[GIRABKP] ▶ ciclo (${motivo})${forcar ? ' [FORCE]' : ''}`);
    const man      = manifest();
    const cacheEan = skuEanCache();
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

    // (re)processa quem não tem etiqueta OU está num schema antigo (ganha EAN+kit)
    const aProcessar = atendidos.filter(ped => {
      if (forcar) return true;
      const ja = man[ped.id];
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
        const snap = await cachearPedido(det, cacheEan, nfs, kitCache);
        man[id] = {
          numero: snap.numero, marketplace: snap.marketplace,
          servico: snap.servico || '', flex: !!snap.flex,
          cliente: snap.cliente || '', nf_numero: (snap.nf && snap.nf.numero) || null,
          tem_nf: snap.tem_nf, tem_kit: snap.tem_kit, tem_etiqueta: snap.tem_etiqueta,
          tem_danfe: !!(ja && ja.tem_danfe),
          itens: snap.itens.length, schema: snap.schema, cacheado_em: snap.cacheado_em
        };
        if (!ja) novos++;
        salvarManifest(man);
        salvarSkuEan(cacheEan);
        writeJson(KIT_CACHE_FILE, { _schema: SCHEMA, kits: kitCache });
      } catch (e) { erros++; console.error(`[GIRABKP] erro pedido ${id}:`, e.message); }
      await sleep(PAUSA_MS);
    }

    // passo: baixa o DANFE que falta (TODOS — fica pronto p/ offline rápido)
    let danfesNovos = 0, danfesFalha = 0, danfesSemId = 0;
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'danfe.pdf'))) continue;
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
    if (danfesNovos) salvarManifest(man);
    console.log(`[GIRABKP] DANFE: ${danfesNovos} novos, ${danfesFalha} falha, ${danfesSemId} sem nf.id`);

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

    // FASE 3: Bling respondeu (listaOk) → drena a fila de conferidos offline p/ VERIFICADO (24)
    // só roda automático se GIRABKP_SYNC_ON=1 (trava de segurança até você testar)
    if (listaOk && SYNC_ON) {
      const sync = await sincronizarConferidos();
      if (sync.pendentes) console.log(`[GIRABKP] sync conferidos→${SIT_VERIFICADO}: ${sync.ok} ok, ${sync.falhas} falha(s) de ${sync.pendentes}`);
    }

    purgar(man);
    salvarManifest(man);

    const ids = Object.keys(man);
    ultimoResumo = {
      rodouEm: new Date().toISOString(),
      duracaoSeg: Math.round((Date.now() - t0) / 1000),
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

// ─── Rotas HTTP (namespaced) ────────────────────────────────────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // raiz do módulo → manda pro painel (evita "not found" ao abrir a URL base)
    if (method === 'GET' && (p === '/girassol-backup-offline' || p === '/girassol-backup-offline/')) {
      res.writeHead(302, { Location: '/girassol-backup-offline/painel' });
      res.end();
      return true;
    }

    if ((method === 'POST' || method === 'GET') && p === '/girassol-backup-offline/run') {
      const forcar = /[?&]force=1\b/.test(urlObj.search || '');
      rodarCiclo(forcar ? 'manual-force' : 'manual', forcar);
      json(res, 200, { mensagem: `Ciclo${forcar ? ' (FORCE — re-cacheia tudo)' : ''} iniciado. Veja /girassol-backup-offline/status.`, versao: VERSAO });
      return true;
    }

    // ─── QZ Tray: assinatura (mata o popup "Untrusted") ───
    // serve o certificado público p/ o QZ confiar
    if (method === 'GET' && p === '/girassol-backup-offline/qz-cert') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(QZ_CERT || '');
      return true;
    }
    // assina a requisição do QZ com a chave privada (RSA-SHA512)
    if (method === 'GET' && p === '/girassol-backup-offline/qz-sign') {
      let toSign = '';
      try { toSign = (urlObj.searchParams && urlObj.searchParams.get('request')) || ''; } catch (e) {}
      if (!toSign) { const m = /[?&]request=([^&]*)/.exec(urlObj.search || ''); toSign = m ? decodeURIComponent(m[1]) : ''; }
      if (!QZ_PRIVKEY) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(''); return true; }
      try {
        const s = crypto.createSign('RSA-SHA512'); s.update(toSign);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(s.sign(QZ_PRIVKEY, 'base64'));
      } catch (e) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(''); }
      return true;
    }

    // ─── FASE 2: tela de bipagem ───
    // serve a página
    if (method === 'GET' && p === '/girassol-backup-offline/painel') {
      try {
        const htmlContent = fs.readFileSync(path.join(__dirname, 'painel.html'), 'utf8');
        html(res, 200, htmlContent);
      } catch (e) { json(res, 500, { erro: 'painel.html: ' + e.message }); }
      return true;
    }

    // lista os pedidos PRONTOS (com etiqueta) + estado de conferido
    if (method === 'GET' && p === '/girassol-backup-offline/lista') {
      const man = manifest();
      const conf = readJson(CONFERIDOS_FILE, {});
      const ids = Object.keys(man);
      // backfill cliente + nº NF p/ busca (lê snapshot só de quem ainda não tem; persiste 1x)
      let mexeu = false;
      for (const i of ids) {
        const m = man[i];
        if (m && (m.cliente === undefined || m.nf_numero === undefined)) {
          const snap = readJson(path.join(CACHE_DIR, String(i), 'pedido.json'), null);
          if (snap) { m.cliente = snap.cliente || ''; m.nf_numero = (snap.nf && snap.nf.numero) || null; }
          else { m.cliente = m.cliente || ''; m.nf_numero = m.nf_numero || null; }
          mexeu = true;
        }
      }
      if (mexeu) salvarManifest(man);
      const prontos = ids
        .filter(i => man[i].tem_etiqueta)
        .map(i => ({ id: i, ...man[i], conferido: conf[i] || null }))
        .sort((a, b) => Number(b.numero || 0) - Number(a.numero || 0));      json(res, 200, {
        versao: VERSAO,
        prontos: prontos.length,
        sem_etiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
        conferidos: prontos.filter(p2 => p2.conferido).length,
        pedidos: prontos
      });
      return true;
    }

    // detalhe do pedido cacheado (itens + EAN + NF)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/pedido/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      if (!ped) { json(res, 404, { erro: 'pedido não cacheado' }); return true; }
      const conf = readJson(CONFERIDOS_FILE, {});
      ped.conferido = conf[id] || null;
      json(res, 200, ped);
      return true;
    }

    // serve o ZPL cacheado (texto puro) p/ o QZ Tray imprimir
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/etiqueta/')) {
      const id = p.split('/').filter(Boolean).pop();
      try {
        const zpl = fs.readFileSync(path.join(CACHE_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(zpl);
      } catch (e) { json(res, 404, { erro: 'etiqueta não cacheada' }); }
      return true;
    }

    // serve o DANFE (PDF) — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/danfe/')) {
      const id = p.split('/').filter(Boolean).pop();
      const dir = path.join(CACHE_DIR, String(id));
      let pdf = null;
      try { pdf = fs.readFileSync(path.join(dir, 'danfe.pdf')); } catch (e) {}
      if (!pdf) { // não cacheado → gera agora (precisa do Bling online)
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        const nfId = snap && snap.nf && snap.nf.id;
        if (nfId) { pdf = await baixarDanfe(nfId); if (pdf) { try { ensureDir(dir); fs.writeFileSync(path.join(dir, 'danfe.pdf'), pdf); } catch (e) {} } }
      }
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe.pdf"' }); res.end(pdf); }
      else json(res, 404, { erro: 'DANFE indisponível (sem cache e Bling não respondeu)' });
      return true;
    }

    // serve a ETIQUETA em PDF — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/etiqueta-pdf/')) {
      const id = p.split('/').filter(Boolean).pop();
      const dir = path.join(CACHE_DIR, String(id));
      let pdf = null;
      try { pdf = fs.readFileSync(path.join(dir, 'etiqueta.pdf')); } catch (e) {}
      if (!pdf) { // não cacheado → gera agora: PDF do Bling (ML) ou ZPL→PDF via Labelary (não-ML)
        pdf = await etiquetaPdf(id, dir);
        if (pdf) { try { ensureDir(dir); fs.writeFileSync(path.join(dir, 'etiqueta.pdf'), pdf); } catch (e) {} }
      }
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="etiqueta.pdf"' }); res.end(pdf); }
      else json(res, 404, { erro: 'etiqueta PDF indisponível' });
      return true;
    }

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)
    if (method === 'POST' && p === '/girassol-backup-offline/conferido') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) { json(res, 400, { erro: 'id obrigatório' }); return true; }
      const conf = readJson(CONFERIDOS_FILE, {});
      conf[id] = { user: body.user || '', conferido_em: new Date().toISOString(), sincronizado: false };
      writeJson(CONFERIDOS_FILE, conf);
      json(res, 200, { ok: true, id });
      return true;
    }

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.
    if ((method === 'POST' || method === 'GET') && p === '/girassol-backup-offline/sincronizar') {
      const r = await sincronizarConferidos();
      json(res, 200, { ok: true, ...r });
      return true;
    }

    // DEBUG — testa mover UM pedido p/ VERIFICADO (ou outro id via ?situacao=). Mostra resposta crua do Bling.
    // uso: /girassol-backup-offline/debug-mover/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-mover/')) {
      const id = p.split('/').pop();
      const sit = Number(urlObj.searchParams.get('situacao') || SIT_VERIFICADO);
      const r = await moverSituacao(id, sit);
      json(res, 200, { pedido: id, situacao_destino: sit, resultado: r });
      return true;
    }

    if (method === 'GET' && p === '/girassol-backup-offline/status') {
      const man = manifest();
      const ids = Object.keys(man);
      const conf = readJson(CONFERIDOS_FILE, {});
      const confIds = Object.keys(conf);
      json(res, 200, {
        versao: VERSAO,
        resumo: ultimoResumo,
        cacheDir: CACHE_DIR,
        situacaoAtendido: SIT_ATENDIDO,
        situacaoVerificado: SIT_VERIFICADO,
        formato: ETIQ_FORMATO,
        total: ids.length,
        comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
        semEtiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
        sync: { ...ultimoSync, ligado: SYNC_ON, conferidos: confIds.length, pendentes: confIds.filter(i => !conf[i].sincronizado).length },
        pedidos: ids.map(i => ({ id: i, ...man[i] }))
      });
      return true;
    }

    // DEBUG: dumpa as respostas cruas do Bling p/ um pedido (diagnóstico NF/etiqueta)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug/')) {
      const id = p.split('/').filter(Boolean).pop();
      const out = { id, versao: VERSAO };
      try {
        const ped = await blingGet(`/pedidos/vendas/${id}`);
        out.pedido_status = ped.status;
        const d = ped.data && ped.data.data;
        out.pedido = d ? {
          numero: d.numero,
          situacao: d.situacao,
          loja: d.loja,
          numeroLoja: d.numeroLoja,
          contato: d.contato && { nome: d.contato.nome },
          itens: (d.itens || []).map(it => ({ codigo: it.codigo, quantidade: it.quantidade, produto: it.produto }))
        } : ped.data;

        const nfe = await blingGet(`/pedidos/vendas/${id}/nfe`);
        out.nfe_direto_status = nfe.status;
        out.nfe_direto_raw = nfe.data;
        out.nf_por_range = await acharNFporRange(id);

        // testa as 2 formas do parâmetro de etiqueta p/ cravar qual o Bling aceita
        const etqA = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas[]=${id}`);
        out.etiqueta_bracket = { status: etqA.status, raw: etqA.data };
        const etqB = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas%5B%5D=${id}`);
        out.etiqueta_encoded = { status: etqB.status, raw: etqB.data };

        const bom = (etqA.ok && etqA.data) ? etqA : (etqB.ok ? etqB : null);
        const link = bom && bom.data && bom.data.data && bom.data.data[0] && bom.data.data[0].link;
        out.etiqueta_link = link ? link.slice(0, 90) + '...' : null;
        if (link) {
          try {
            const r = await fetch(link);
            const buf = await r.buffer();
            const ehZip = buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B;
            let zpl = null, arquivos = null;
            if (ehZip) {
              const zip = new AdmZip(buf);
              arquivos = zip.getEntries().map(e => e.entryName);
              const ent = zip.getEntries().find(e => /\.(txt|zpl)$/i.test(e.entryName)) || zip.getEntries()[0];
              zpl = ent ? ent.getData().toString('utf8') : null;
            } else {
              zpl = buf.toString('utf8');
            }
            out.etiqueta_download = {
              status: r.status,
              contentType: r.headers.get('content-type'),
              tamanho_zip: buf ? buf.length : 0,
              eh_zip: ehZip,
              arquivos_no_zip: arquivos,
              zpl_tamanho: zpl ? zpl.length : 0,
              zpl_inicio: zpl ? zpl.slice(0, 200) : null
            };
          } catch (e) { out.etiqueta_download = { erro: e.message }; }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG: lista vendas ML recentes (loja 203146903) p/ achar uma pra testar etiqueta
    if (method === 'GET' && p === '/girassol-backup-offline/debug-ml') {
      const { data } = await blingGet(`/pedidos/vendas?idLoja=203146903&limite=20&pagina=1`);
      const lista = (data && data.data) || [];
      json(res, 200, {
        versao: VERSAO,
        total: lista.length,
        pedidos: lista.map(o => ({
          id: o.id,
          numero: o.numero,
          situacao: o.situacao && o.situacao.id,
          data: o.data
        }))
      });
      return true;
    }

    // DEBUG: dumpa a ESTRUTURA dos produtos de um pedido (variação / composição / kit)
    // uso: /girassol-backup-offline/debug-estrutura/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-estrutura/')) {
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO, itens: [] };
      try {
        // probe: o escopo Produtos funciona? (lista 1 produto)
        const probe = await blingGet(`/produtos?limite=1`);
        out.probe_produtos = {
          status: probe.status, ok: probe.ok,
          corpo: probe.data && probe.data.data && probe.data.data[0]
            ? { campos: Object.keys(probe.data.data[0]) }
            : probe.data
        };
        await sleep(PAUSA_MS);

        const ped = await blingGet(`/pedidos/vendas/${id}`);
        const d = ped.data && ped.data.data;
        out.numero = d && d.numero;
        for (const it of ((d && d.itens) || [])) {
          const prodId = it.produto && it.produto.id;
          let status = null, raw = null;
          if (prodId) {
            const r = await blingGet(`/produtos/${prodId}`);
            status = r.status;
            raw = r.data;               // corpo CRU do /produtos/{id}
            await sleep(PAUSA_MS);
          }
          out.itens.push({
            item_descricao: it.descricao,
            item_codigo: it.codigo,
            item_qtd: it.quantidade,
            item_produto: it.produto,   // o que vem dentro do item do pedido
            produto_id: prodId,
            produtos_status: status,    // HTTP status do /produtos/{id}
            produtos_raw: raw           // corpo cru (aqui vejo formato/estrutura/erro)
          });
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG: acha pedidos no cache que parecem KIT/composição (p/ inspecionar a estrutura)
    if (method === 'GET' && p === '/girassol-backup-offline/debug-buscar-kit') {
      const man = manifest();
      const achados = [];
      for (const id of Object.keys(man)) {
        const ped = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
        if (!ped) continue;
        const suspeito = (ped.itens || []).some(it =>
          /kit|combo|conjunto/i.test(it.sku || '') ||
          /kit|combo|conjunto/i.test(it.descricao || '') ||
          (!it.ean && (it.descricao || it.sku))   // sem EAN = provável kit/composição (NF sem GTIN)
        );
        if (suspeito) {
          achados.push({
            id,
            numero: ped.numero,
            cliente: ped.cliente,
            marketplace: ped.marketplace,
            itens: (ped.itens || []).map(i => ({ sku: i.sku, ean: i.ean, qtd: i.qtd, descricao: (i.descricao || '').slice(0, 60) }))
          });
        }
        if (achados.length >= 15) break;
      }
      json(res, 200, {
        versao: VERSAO,
        encontrados: achados.length,
        dica: 'pegue um "id" e abra /girassol-backup-offline/debug-estrutura/{id}',
        pedidos: achados
      });
      return true;
    }

    // DEBUG: dumpa o objeto NF + TESTA baixar o DANFE em PDF (linkPDF) de dentro do Render
    if (method === 'GET' && p === '/girassol-backup-offline/debug-nf') {
      const out = { versao: VERSAO };
      try {
        const r = await blingGet(`/nfe?limite=1`);
        out.lista_status = r.status;
        const nf0 = r.data && r.data.data && r.data.data[0];
        if (nf0 && nf0.id) {
          await sleep(PAUSA_MS);
          const det = await blingGet(`/nfe/${nf0.id}`);
          const nf = det.data && det.data.data;
          out.numero = nf && nf.numero;
          out.tem_linkPDF = !!(nf && nf.linkPDF);
          out.tem_linkDanfe = !!(nf && nf.linkDanfe);
          out.tem_xml = !!(nf && nf.xml);
          if (nf && nf.linkPDF) {
            try {
              const resp = await fetch(nf.linkPDF, { redirect: 'follow' });
              const buf = Buffer.from(await resp.arrayBuffer());
              const head = buf.slice(0, 8).toString('latin1');
              out.download_pdf = {
                status: resp.status,
                content_type: resp.headers.get('content-type'),
                tamanho_bytes: buf.length,
                primeiros_bytes: head,
                eh_pdf: head.startsWith('%PDF'),
                parece_bloqueio: /^<|html|cloudflare/i.test(head)
              };
            } catch (e) { out.download_pdf = { erro: e.message }; }
          }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // testa o caminho do DANFE p/ UM pedido (id do pedido) e cacheia se der certo
    // uso: /girassol-backup-offline/debug-danfe/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-danfe/')) {
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO };
      try {
        const dir = path.join(CACHE_DIR, String(id));
        out.dir_existe = fs.existsSync(dir);
        out.danfe_ja_cacheado = fs.existsSync(path.join(dir, 'danfe.pdf'));
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        out.snapshot_existe = !!snap;
        out.nf_no_snapshot = (snap && snap.nf) || null;
        let nfId = snap && snap.nf && snap.nf.id;
        out.nf_id_snapshot = nfId || null;
        if (!nfId) { // fallback: tenta achar a NF do pedido na hora
          const nf = await nfDoPedido(id); await sleep(PAUSA_MS);
          out.nf_via_fallback = nf;
          nfId = nf && nf.id;
        }
        out.nf_id_usado = nfId || null;
        if (nfId) {
          const det = await blingGet(`/nfe/${nfId}`);
          out.nfe_get_ok = det.ok; out.nfe_get_status = det.status;
          const nf = det.data && det.data.data;
          out.tem_linkPDF = !!(nf && nf.linkPDF);
          if (nf && nf.linkPDF) {
            const resp = await fetch(nf.linkPDF, { redirect: 'follow' });
            const buf = Buffer.from(await resp.arrayBuffer());
            const head = buf.slice(0, 8).toString('latin1');
            out.download = { status: resp.status, tamanho: buf.length, primeiros: head, eh_pdf: head.startsWith('%PDF') };
            if (head.startsWith('%PDF')) {
              fs.writeFileSync(path.join(dir, 'danfe.pdf'), buf);
              if (snap) { snap.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), snap); }
              const man = manifest(); if (man[id]) { man[id].tem_danfe = true; salvarManifest(man); }
              out.salvou = true;
            }
          }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // testa se o Bling devolve a ETIQUETA em PDF (vs ZPL) p/ um pedido
    // uso: /girassol-backup-offline/debug-etiqueta-fmt/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-etiqueta-fmt/')) {
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO };
      try {
        for (const fmt of ['PDF', 'ZPL']) {
          const r = await blingGet(`/logisticas/etiquetas?formato=${fmt}&idsVendas[]=${id}`); await sleep(PAUSA_MS);
          const item = r.data && r.data.data && r.data.data[0];
          const link = item && item.link;
          const info = { api_ok: r.ok, api_status: r.status, tem_link: !!link };
          if (!link && r.data) info.resposta = JSON.stringify(r.data).slice(0, 300);
          if (link) {
            try {
              const resp = await fetch(link); await sleep(PAUSA_MS);
              const buf = Buffer.from(await resp.arrayBuffer());
              const head = buf.slice(0, 8).toString('latin1');
              info.download = {
                status: resp.status,
                content_type: resp.headers.get('content-type'),
                tamanho: buf.length,
                primeiros: head,
                eh_pdf: head.startsWith('%PDF'),
                eh_zip: head.charCodeAt(0) === 0x50 && head.charCodeAt(1) === 0x4B
              };
            } catch (e) { info.download = { erro: e.message }; }
          }
          out[fmt] = info;
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    return false; // não tratou
  };
}

// roda 1 ciclo logo após o boot do serviço
function bootstrap() {
  ensureDir(CACHE_DIR);
  console.log(`[GIRABKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  setTimeout(() => rodarCiclo('boot'), 20000);
}

module.exports = {
  id: 'girassol-backup-offline',
  nome: 'Girassol Backup Offline',
  rotinas: { backupCache: () => rodarCiclo('cron') },
  routes,
  crons: { backupCache: CRON_EXPR },
  bootstrap
};
