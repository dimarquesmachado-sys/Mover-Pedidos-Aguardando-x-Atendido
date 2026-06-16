'use strict';

// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · CHECKOUT OFFLINE — FASE 1: POLLER DE CACHE   (Mover-Pedidos)
//  girassol-backup-offline v15/06 b1
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
const { garantirToken } = require('../girassol/tokenManager');

const VERSAO     = 'girassol-backup-offline v16/06 b1';
const BLING_BASE = 'https://api.bling.com.br/Api/v3';

// ─── Config (env prefixo GIRABKP_, defaults sãos) ───────────────────────
const CACHE_DIR     = process.env.GIRABKP_CACHE_DIR    || '/data/cache-offline/girassol';
const SIT_ATENDIDO  = Number(process.env.GIRABKP_SIT_ATENDIDO  || 9);              // ATENDIDO
const JANELA_DIAS   = Number(process.env.GIRABKP_JANELA_DIAS   || 5);
const PAUSA_MS      = Number(process.env.GIRABKP_PAUSA_MS      || 350);            // ~3 req/s
const RETENCAO_DIAS = Number(process.env.GIRABKP_RETENCAO_DIAS || 7);
const ETIQ_FORMATO  = (process.env.GIRABKP_ETIQ_FORMATO || 'ZPL').toUpperCase();   // ZPL | PDF
const CRON_EXPR     = process.env.GIRABKP_CRON || '5,15,25,35,45,55 6-23 * * *';   // off do F3

const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SKU_EAN_FILE  = path.join(CACHE_DIR, 'sku-ean.json');
const CONFERIDOS_FILE = path.join(CACHE_DIR, 'conferidos.json');

// loja → marketplace (mesmo mapa do checkout Girassol)
const LOJA_MKT = {
  '203146903': 'ml', '203583169': 'shopee', '203967708': 'amazon',
  '203262016': 'magalu', '205523707': 'tiktok'
};

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

// ─── estado do módulo ───────────────────────────────────────────────────
let rodando = false;
let ultimoResumo = { rodouEm: null, total: 0, comEtiqueta: 0, semEtiqueta: 0, novos: 0, erros: 0 };

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

async function listarAtendidos() {
  const hoje = new Date();
  const ini  = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
  const qs = `idSituacao=${SIT_ATENDIDO}&dataEmissaoInicial=${dataISO(ini)}&dataEmissaoFinal=${dataISO(hoje)}`;
  const out = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const { ok, data } = await blingGet(`/pedidos/vendas?${qs}&pagina=${pagina}&limite=100`);
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    out.push(...lista);
    if (lista.length < 100) break;
    await sleep(PAUSA_MS);
  }
  return out;
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

async function cachearPedido(ped, cacheEan, nfs) {
  const id  = ped.id;
  const dir = path.join(CACHE_DIR, String(id));
  ensureDir(dir);

  const lojaId = String((ped.loja && ped.loja.id) || '');

  const itens = [];
  for (const it of (ped.itens || [])) {
    const sku = it.codigo || (it.produto && it.produto.codigo) || '';
    const ean = await eanDoItem(it.produto && it.produto.id, sku, cacheEan);
    await sleep(PAUSA_MS);
    itens.push({ sku, ean, descricao: it.descricao || '', qtd: Number(it.quantidade || 0) });
  }

  const nf = acharNFnaLista(id, nfs || []);

  const conteudoEtiqueta = await baixarEtiqueta(id); await sleep(PAUSA_MS);
  let temEtiqueta = false;
  if (conteudoEtiqueta) {
    fs.writeFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), conteudoEtiqueta);
    temEtiqueta = true;
  }

  const snapshot = {
    bling_id: id,
    numero: ped.numero || null,
    numero_loja: ped.numeroLoja || null,
    loja_id: lojaId || null,
    marketplace: LOJA_MKT[lojaId] || 'outro',
    situacao_id: (ped.situacao && ped.situacao.id) || SIT_ATENDIDO,
    cliente: (ped.contato && ped.contato.nome) || '',
    nf,
    itens,
    tem_nf: !!nf,
    tem_etiqueta: temEtiqueta,
    etiqueta_formato: temEtiqueta ? ETIQ_FORMATO : null,
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

async function rodarCiclo(motivo = 'cron') {
  if (rodando) { console.log('[GIRABKP] ciclo já em andamento — pulei'); return ultimoResumo; }
  rodando = true;
  const t0 = Date.now();
  let novos = 0, erros = 0;
  try {
    ensureDir(CACHE_DIR);
    console.log(`[GIRABKP] ▶ ciclo (${motivo})`);
    const man      = manifest();
    const cacheEan = skuEanCache();
    const atendidos = await listarAtendidos();
    console.log(`[GIRABKP] ${atendidos.length} pedido(s) ATENDIDO(${SIT_ATENDIDO}) na janela de ${JANELA_DIAS}d`);

    // só (re)processa quem ainda não tem etiqueta cacheada
    const aProcessar = atendidos.filter(ped => {
      const ja = man[ped.id];
      return !(ja && ja.tem_etiqueta);
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
        const snap = await cachearPedido(det, cacheEan, nfs);
        man[id] = {
          numero: snap.numero, marketplace: snap.marketplace,
          tem_nf: snap.tem_nf, tem_etiqueta: snap.tem_etiqueta,
          itens: snap.itens.length, cacheado_em: snap.cacheado_em
        };
        if (!ja) novos++;
        salvarManifest(man);
        salvarSkuEan(cacheEan);
      } catch (e) { erros++; console.error(`[GIRABKP] erro pedido ${id}:`, e.message); }
      await sleep(PAUSA_MS);
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

    if (method === 'POST' && p === '/girassol-backup-offline/run') {
      rodarCiclo('manual');
      json(res, 200, { mensagem: 'Ciclo de cache iniciado. Veja os logs ou /girassol-backup-offline/status.', versao: VERSAO });
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
      const prontos = ids
        .filter(i => man[i].tem_etiqueta)
        .map(i => ({ id: i, ...man[i], conferido: conf[i] || null }))
        .sort((a, b) => Number(b.numero || 0) - Number(a.numero || 0));
      json(res, 200, {
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

    if (method === 'GET' && p === '/girassol-backup-offline/status') {
      const man = manifest();
      const ids = Object.keys(man);
      json(res, 200, {
        versao: VERSAO,
        resumo: ultimoResumo,
        cacheDir: CACHE_DIR,
        situacaoAtendido: SIT_ATENDIDO,
        formato: ETIQ_FORMATO,
        total: ids.length,
        comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
        semEtiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
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
        const ped = await blingGet(`/pedidos/vendas/${id}`);
        const d = ped.data && ped.data.data;
        out.numero = d && d.numero;
        for (const it of ((d && d.itens) || [])) {
          const prodId = it.produto && it.produto.id;
          let prod = null;
          if (prodId) {
            const r = await blingGet(`/produtos/${prodId}`);
            prod = r.data && r.data.data;
            await sleep(PAUSA_MS);
          }
          out.itens.push({
            item_descricao: it.descricao,
            item_codigo: it.codigo,
            item_qtd: it.quantidade,
            produto_id: prodId,
            produto_nome: prod && prod.nome,
            formato: prod && prod.formato,         // S=simples, V=variação (provável)
            tipo: prod && prod.tipo,
            variacao: prod && prod.variacao,        // se for variação, atributos aqui
            gtins: prod ? getPossiveisGtins(prod) : [],
            tem_estrutura: !!(prod && prod.estrutura),
            estrutura: prod && prod.estrutura,      // componentes do kit/composição
            _campos_produto: prod ? Object.keys(prod) : []  // p/ eu ver o que o Bling devolve
          });
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
