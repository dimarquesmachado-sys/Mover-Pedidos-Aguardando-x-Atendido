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
const { garantirToken } = require('../girassol/tokenManager');

const VERSAO     = 'girassol-backup-offline v15/06 b2';
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

async function nfDoPedido(id) {
  const { data } = await blingGet(`/pedidos/vendas/${id}/nfe`);
  let nf = data && data.data;
  if (Array.isArray(nf)) nf = nf[0];
  if (!nf) return null;
  return {
    id: nf.id || null,
    numero: nf.numero || null,
    chave: nf.chaveAcesso || nf.chave || null,
    situacao: (nf.situacao && (nf.situacao.id || nf.situacao)) || null
  };
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

// baixa a etiqueta de envio (link do Bling Logísticas) e devolve o conteúdo
async function baixarEtiqueta(blingId) {
  const { ok, data } = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas=${blingId}`);
  const item = ok && data && data.data && data.data[0];
  const link = item && item.link;
  if (!link) return null;
  try {
    const r = await fetch(link);
    if (!r.ok) return null;
    const body = await r.text(); // ZPL é texto. (Pra PDF: trocar p/ buffer.)
    if (!body || /<html|not\s*found|erro/i.test(body.slice(0, 200))) return null;
    return body;
  } catch (e) { return null; }
}

async function cachearPedido(ped, cacheEan) {
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

  const nf = await nfDoPedido(id); await sleep(PAUSA_MS);

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

    for (const ped of atendidos) {
      const id = ped.id;
      const ja = man[id];
      if (ja && ja.tem_etiqueta) continue; // já completo → pula (sem etiqueta re-tenta)
      try {
        const det = await detalhePedido(id); await sleep(PAUSA_MS);
        if (!det) { erros++; continue; }
        const snap = await cachearPedido(det, cacheEan);
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
        out.nfe_status = nfe.status;
        out.nfe_raw = nfe.data;

        const etq = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas=${id}`);
        out.etiqueta_status = etq.status;
        out.etiqueta_raw = etq.data;

        const link = etq.data && etq.data.data && etq.data.data[0] && etq.data.data[0].link;
        out.etiqueta_link = link || null;
        if (link) {
          try {
            const r = await fetch(link);
            const body = await r.text();
            out.etiqueta_download = {
              status: r.status,
              contentType: r.headers.get('content-type'),
              tamanho: body.length,
              inicio: body.slice(0, 120)
            };
          } catch (e) { out.etiqueta_download = { erro: e.message }; }
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
