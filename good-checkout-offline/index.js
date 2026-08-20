'use strict';

// ════════════════════════════════════════════════════════════════════════
//  GOOD · CHECKOUT OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
// ════════════════════════════════════════════════════════════════════════
//  Módulo do orquestrador unificado (HTTP-native, sem Express).
//  Reaproveita o token Bling da GOOD via ../good/tokenManager.
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
//  ⚠ PRÉ-REQUISITO de scope no app Bling da GOOD (Mover-Pedidos):
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
const https = require('https');
const { garantirToken } = require('../good/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: GOODBKP_QZ_CERT (digital-certificate.txt) e GOODBKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.GOODBKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.GOODBKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

const VERSAO     = 'good-checkout-offline v12/08 b19';

// ── SESSÃO DE OPERADOR (cookie assinado HMAC) — protege rotas de dados/ação ──
// Segredo estável entre restarts. Usa ADMIN_KEY (já configurada no Render) como base.
const SESS_SECRET = process.env.ADMIN_KEY || process.env.SESSION_SECRET || 'bkp-sess-2026';
const SESS_TTL = 14 * 60 * 60 * 1000; // 14h (cobre o turno)
const SESS_COOKIE = 'bkp_sess';
function assinarSessao(nome) {
  const pl = Buffer.from(JSON.stringify({ n: nome, exp: Date.now() + SESS_TTL })).toString('base64url');
  const sig = require('crypto').createHmac('sha256', SESS_SECRET).update(pl).digest('base64url');
  return pl + '.' + sig;
}
function validarSessao(cookieHeader) {
  const m = new RegExp('(?:^|;\\s*)' + SESS_COOKIE + '=([^;]+)').exec(cookieHeader || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const esp = require('crypto').createHmac('sha256', SESS_SECRET).update(parts[0]).digest('base64url');
  if (parts[1] !== esp) return null;
  let pl; try { pl = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (e) { return null; }
  if (!pl.exp || Date.now() > pl.exp) return null;
  return pl.n;
}

// ─── Módulos extraídos (Fase 1: base + nf + etiquetas) ───────────────────
const base = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;
const { parseNF, acharNFporRange, nfDoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = require('./nf');
const { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf } = require('./etiquetas');
// ─── Módulos extraídos (Lote 1: comum/produtos/arquivo/separacao/email-docs) ────────
const { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = require('./comum');
const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = require('./produtos');
const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = require('./arquivo');
let _ultimoCicloAgora = 0;   // trava anti-spam do botão 'Bling agora' (1 disparo/min)
let _bf = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de valores
let _bfd = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de DETALHES (uf + valor por item)
let _skuInfoCache = null;   // cache em memória do sku-info (saldo/preço/custo)
let _mls = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null, erros: {}, amostras: [] };   // pesca de tarifas/frete REAIS do ML

// BACKFILL-NF LOCAL: lê nf-simp.json (cache/arquivo) e preenche vprod_nf nos conferidos sem ele.
// 100% disco, zero API — seguro pra rodar no cron diário e ao abrir o dashboard.
function backfillNFLocal(dias) {
  dias = Math.max(1, Math.min(120, Number(dias || 45)));
  const corte = Date.now() - dias * 86400000;
  const conf2 = readJson(CONFERIDOS_FILE, {});
  let alvo = 0, comSimp = 0, semSimp = 0, ufN = 0;
  for (const [cid, c] of Object.entries(conf2)) {
    if (!c || !c.conferido_em || new Date(c.conferido_em).getTime() < corte) continue;
    if (c.vprod_nf != null && c.numero_loja != null && c.uf != null) continue;
    alvo++;
    let ds = readJson(path.join(CACHE_DIR, String(cid), 'nf-simp.json'), null);
    if (!ds) ds = readJson(path.join(ARQUIVO_DIR, String(cid), 'nf-simp.json'), null);
    if (ds) {
      if (c.numero_loja == null && ds.numeroPedidoLoja) c.numero_loja = String(ds.numeroPedidoLoja);
      // UF/município: dos campos novos do nf-simp, ou garimpado do endereço dos antigos ("..., Cidade - UF, CEP ...")
      if (c.uf == null) {
        let _u = ds.uf || null, _m = ds.municipio || null;
        if (!_u && ds.consumidor && ds.consumidor.endereco) {
          const seg = String(ds.consumidor.endereco).split(',').map(t => t.trim()).reverse().find(t => / - [A-Z]{2}$/.test(t));
          const mm = seg && seg.match(/^(.*) - ([A-Z]{2})$/);
          if (mm) { _m = _m || mm[1]; _u = mm[2]; }
        }
        if (_u) { c.uf = _u; if (_m && c.municipio == null) c.municipio = _m; ufN++; }
      }
      if (Array.isArray(ds.itens) && ds.itens.length) {
        const s2 = ds.itens.reduce((a, i) => a + (Number(i.valorTotal) || 0), 0);
        if (isFinite(s2) && s2 > 0) { if (c.vprod_nf == null) { c.vprod_nf = Math.round(s2 * 100) / 100; comSimp++; } continue; }
      }
    }
    semSimp++;
  }
  if (comSimp || ufN) writeJson(CONFERIDOS_FILE, conf2);
  if (comSimp || semSimp) console.log(`[BACKFILL-NF] ${comSimp} preenchido(s) pela nota, ${semSimp} sem nf-simp no disco (janela ${dias}d)`);
  return { candidatos: alvo, preenchidos_pela_nf: comSimp, uf_preenchidas: ufN, sem_nf_simp_no_disco: semSimp, dias };
}
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');
const { enviarEmailDocs } = require('./email-docs');
const { listarAtendidos, detalhePedido, sincronizarConferidos, indexarCatalogoCompleto, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus } = require('./ciclo');

// ─── Config (env prefixo GOODBKP_, defaults sãos) ───────────────────────
// presença entre PCs: quem está separando cada pedido. Limpa reservas vencidas a cada leitura.
// operadores p/ login (env GOODBKP_OPERADORES = "Nome:senha,Nome:senha"). Vazio = login DESLIGADO.
// quem pode REABRIR/reverter pedido (env GOODBKP_ADMIN = "Diego" ou "Diego,Angelica"). Vazio = sem restrição (todo mundo pode).

// FLEX = entrega por motoboy (etiqueta sempre disponível). Mesma lógica do checkout-expedição.
const FLEX_KEYWORDS = ['mercado envios flex', 'entrega local', 'vapt', 'shopee entrega direta'];

// ─── helpers genéricos ──────────────────────────────────────────────────

// EAN robusto — varre todos os nomes de campo que o Bling usa pro GTIN

// 1ª imagem do produto (lista traz imagemURL; detalhe traz midia.imagens.externas[].link)

// localização (depósito/prateleira) do produto — fica em estoque.localizacao no /produtos/{id}

// busca a localização de um SKU (p/ pedidos antigos sem cache): lista por código → se não vier, detalhe

// ─── estado do módulo ───────────────────────────────────────────────────

// o cron roda só dentro de uma faixa de horas (ex: 6-23). Isso evita o /saude dar alarme falso de madrugada.
// lê a faixa do próprio CRON_EXPR e usa a hora local do servidor (mesma base do cron) — robusto a fuso.


// ─── índice de EAN (cresce sozinho: todo produto resolvido entra aqui) ───

// ─── indexação total do catálogo (roda 1x; deixa todo EAN achável na hora) ───

// GET autenticado no Bling GOOD (token via tokenManager + retry 429)

// escrita no Bling (PATCH/POST/PUT) — mesmo cuidado do blingGet (token + retry 429)

// muda a situação de um pedido de venda (precisa do escopo "Gerenciar situações")

// FASE 3: empurra os pedidos conferidos offline (sincronizado:false) p/ VERIFICADO no Bling




// método mandado pelo Diego: pagina /nfe (sem filtro) e acha a NF com id
// entre pedidoId e pedidoId+2000 (ids sequenciais). /nfe vem desc por id.


// ── NF em LOTE (eficiente p/ o ciclo): pagina /nfe UMA vez até cobrir o
//    menor id de pedido do lote, e casa todos em memória. /nfe vem desc por id.

// EAN: produto por id → produto por SKU. Cacheia por SKU.

// detalhe completo do produto (/produtos/{id}) com cache por ciclo

// {sku, ean, descricao, img} de um produto por id (usa cacheEan por SKU)

// baixa a etiqueta de envio. O Bling devolve um ZIP (com "Etiqueta de envio.txt"
// dentro = o ZPL), mesmo pedindo formato=ZPL. Então: baixa binário → descompacta.

// baixa o DANFE em PDF da NF (via /nfe/{id} → linkPDF). Retorna Buffer ou null.

// ─── DANFE Simplificado: enriquecimento de dados (detalhe da NF + XML) ───

// monta o objeto de dados p/ o gerador, a partir do id da NF (Bling) + nº do pedido

// POST ao Labelary usando o módulo https nativo — lê a resposta binária de forma confiável
// (o node-fetch às vezes corta respostas grandes com "Premature close")

// converte ZPL → PDF via Labelary (com retry — trata rate limit 429 e quedas de conexão). Usado p/ não-ML.

// etiqueta em PDF. 1º tenta o PDF nativo do Bling (vale p/ QUALQUER marketplace — ML, Shopee, Amazon...;
// precisa do Bling no ar). 2º fallback offline: ZPL cacheado em disco → Labelary (não depende do Bling).



// arquiva etiqueta + meta de um pedido FINALIZADO num lugar separado do cache (a etiqueta não dá p/ rebaixar depois; DANFE re-gera pelo nf.id)
// remove do arquivo os finalizados mais velhos que ARQUIVO_DIAS

// envia etiqueta + DANFE de um pedido finalizado pro estoque por email (Parte B)

// limpa do histórico os finalizados JÁ sincronizados com +30 dias (não mexe nos pendentes de sync)

// detecta pedido cacheado com kit incompleto (algum componente sem SKU) → sinal pra re-resolver


// LISTA DE SEPARAÇÃO — agrega os itens de TODOS os pedidos cacheados (não-finalizados),
// explodindo kits em componentes e somando a quantidade por SKU. Tudo do cache → funciona offline.

// 2ª visão: separação POR PEDIDO (cada pedido com seus itens; itens podem repetir entre pedidos — OK, é pra uso raro)

// ─── Adesivo "VOLUME i/N" (ZPL 10x15) — impresso ANTES de cada etiqueta Madeira ──
// Sem ^PW/^LL de propósito: usa a config da impressora (não trunca a etiqueta dos
// Correios que vem depois). Centralizado via ^FB. Layout AJUSTÁVEL após teste real.

// ── SESSÃO SHOPEE QUE SE RENOVA SOZINHA (b13) ───────────────────────────
// O de-para order_sn → id interno só existe no endpoint que a caixa de busca do
// Seller Center usa, e ele exige cookie de sessão. Recapturar isso na mão toda
// vez que vence é chato — então a env var passa a ser só a SEMENTE:
//   1) no primeiro uso ela é copiada pro disco;
//   2) a cada resposta da Shopee a gente aproveita o `set-cookie` que ela devolve
//      e regrava o jar — que é exatamente o que o navegador faz, e é por isso que
//      ele fica logado por meses;
//   3) um cron 2x ao dia faz uma chamada barata só pra manter a sessão quente,
//      mesmo em dia que ninguém clicou em nenhum ↗.
// Se o Diego colar uma semente NOVA na env (porque a sessão morreu de vez), ela
// ganha do disco — detectado por hash da própria env.
const SHOPEE_ENV_COOKIE  = 'GOODBKP_SHOPEE_COOKIE';
const SHOPEE_SESSAO_FILE = path.join(CACHE_DIR, '_shopee-sessao.json');

function _shopeeHash(s) {
  try { return require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
  catch (e) { return 'len' + String(s).length; }
}

function shopeeSessaoLer() {
  const env  = String(process.env[SHOPEE_ENV_COOKIE] || '').trim();
  const j    = readJson(SHOPEE_SESSAO_FILE, null) || {};
  const envH = env ? _shopeeHash(env) : '';
  if (env && j.semente !== envH) {          // semente nova na env → ela manda
    const novo = { cookie: env, semente: envH, origem: 'env', atualizado: new Date().toISOString(), renovacoes: 0 };
    try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
    return novo;
  }
  if (j.cookie) return j;
  if (env) return { cookie: env, semente: envH, origem: 'env', atualizado: null, renovacoes: 0 };
  return { cookie: '', origem: 'nenhum', renovacoes: 0 };
}

// Pega o set-cookie da resposta e funde no jar. Devolve null se nada mudou.
function shopeeSessaoAtualiza(resp) {
  let lista = [];
  try { if (resp && resp.headers && typeof resp.headers.getSetCookie === 'function') lista = resp.headers.getSetCookie() || []; } catch (e) {}
  if (!lista.length) { try { const s = resp && resp.headers && resp.headers.get('set-cookie'); if (s) lista = [s]; } catch (e) {} }
  if (!lista.length) return null;

  const atual = shopeeSessaoLer();
  if (!atual.cookie) return null;

  const mapa = new Map();
  String(atual.cookie).split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) mapa.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });

  let mudou = 0;
  lista.forEach(sc => {
    const par = String(sc).split(';')[0];
    const i = par.indexOf('=');
    if (i <= 0) return;
    const nome = par.slice(0, i).trim();
    const val  = par.slice(i + 1).trim();
    if (!nome) return;
    if (!val || val === 'deleted') { if (mapa.delete(nome)) mudou++; return; }
    if (mapa.get(nome) !== val) { mapa.set(nome, val); mudou++; }
  });
  if (!mudou) return null;

  const cookie = Array.from(mapa.entries()).map(([k, v]) => k + '=' + v).join('; ');
  const novo = { cookie, semente: atual.semente || '', origem: 'renovado', atualizado: new Date().toISOString(), renovacoes: (atual.renovacoes || 0) + 1 };
  try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
  return { mudou, renovacoes: novo.renovacoes };
}

const SHOPEE_CAB = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://seller.shopee.com.br/portal/sale/order',
  'X-Api-Src-List': 'pc',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
};

function shopeeUrlBusca(cookie, termo) {
  const cds = (String(cookie).match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
  return 'https://seller.shopee.com.br/api/v3/order/get_order_list_search_bar_hint'
       + '?SPC_CDS=' + encodeURIComponent(cds)
       + '&SPC_CDS_VER=2&keyword=' + encodeURIComponent(termo)
       + '&category=1&order_list_tab=100&entity_type=1';
}

// Chamada barata só pra Shopee renovar os cookies. Roda no cron 2x ao dia.

// 20/08 (pedido do Diego: "quando vc fizer coisas pra acompanhar status, coloca o URL Completo.
// assim eu vejo na tela e já acompanho. do jeito q tá, não consigo saber o caminho"): quem dispara
// uma rotina longa recebe a mensagem "?status=1 p/ acompanhar" — e não tem como montar o caminho a
// partir dela. A resposta passa a trazer a URL inteira, pronta pra clicar.
function _urlStatus(req, caminho, extra, chave) {
  try {
    const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
    const base = host ? (proto + '://' + host) : '';
    // Codex (P2): quem dispara com ?k=<chave> e sem sessão recebia um link com o texto
    // "SUA_ADMIN_KEY" — que não abre. O link tem que funcionar pra quem o recebeu: se veio com
    // chave, ela volta; se foi por sessão (o cookie acompanha o clique), fica sem chave nenhuma.
    const k = chave ? ('&k=' + encodeURIComponent(chave)) : '';
    return base + caminho + '?status=1' + (extra || '') + k;
  } catch (e) { return caminho + '?status=1'; }
}

async function shopeeKeepAlive() {
  const sess = shopeeSessaoLer();
  if (!sess.cookie) { console.log('[GOODBKP] shopee keep-alive: sem cookie (env ' + SHOPEE_ENV_COOKIE + ' vazia) — nada a fazer'); return { ok: false, motivo: 'sem cookie' }; }
  try {
    const r = await fetch(shopeeUrlBusca(sess.cookie, 'keepalive'), { headers: Object.assign({ 'Cookie': sess.cookie }, SHOPEE_CAB) });
    const t = await r.text();
    const ren = shopeeSessaoAtualiza(r);
    const vivo = (r.status === 200 && /"code"\s*:\s*0/.test(t));
    console.log('[GOODBKP] shopee keep-alive: HTTP ' + r.status + (vivo ? ' ✓ sessão viva' : ' ✗ sessão NÃO respondeu como logada') + (ren ? (' · ' + ren.mudou + ' cookie(s) renovado(s), total ' + ren.renovacoes) : ' · nada a renovar'));
    return { ok: vivo, status: r.status, renovou: ren ? ren.mudou : 0, corpo: t.slice(0, 300) };
  } catch (e) {
    console.log('[GOODBKP] shopee keep-alive falhou: ' + ((e && e.message) || e));
    return { ok: false, erro: String((e && e.message) || e).slice(0, 200) };
  }
}

const lerZipEntradas = buf => {   // lê pelo DIRETÓRIO CENTRAL (o zip vem em modo streaming, tamanhos zerados no header local)
  const zlibA = require('zlib');
  let eocd = -1;
  for (let x = buf.length - 22; x >= 0 && x > buf.length - 66000; x--) { if (buf.readUInt32LE(x) === 0x06054b50) { eocd = x; break; } }
  if (eocd < 0) return [];
  const qtd = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const saida = [];
  for (let k = 0; k < qtd && off + 46 < buf.length; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(off + 10), tamComp = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28), exLen = buf.readUInt16LE(off + 30), cmLen = buf.readUInt16LE(off + 32);
    const nome = buf.slice(off + 46, off + 46 + fnLen).toString('utf8');
    const loc = buf.readUInt32LE(off + 42);
    const lfn = buf.readUInt16LE(loc + 26), lex = buf.readUInt16LE(loc + 28);
    const ini = loc + 30 + lfn + lex;
    const dados = tamComp > 0 ? buf.slice(ini, ini + tamComp) : buf.slice(ini);
    try { saida.push({ nome, conteudo: metodo === 0 ? dados : zlibA.inflateRawSync(dados, { finishFlush: zlibA.constants.Z_SYNC_FLUSH }) }); } catch (e) {}
    off += 46 + fnLen + exLen + cmLen;
  }
  return saida;
};


// ─── DECODIFICADOR DAS ETIQUETAS RASTER DA SHOPEE (b18) ─────────────────────────────
// O ZPL da Shopee é 100% imagem (par ~DG + ^XA^XG por etiqueta, zero ^FD). A identidade
// de cada etiqueta vem dos códigos DENTRO do bitmap: chave da NF-e (CODE128 da DANFE,
// 44 dígitos — o nº da NF são os dígitos 26–34) e tracking BR no QR. Decodificação por
// zxing-wasm, validada 31/31 no lote real de 11/08. Carregamento LAZY (o wasm só sobe
// à primeira chamada; se o pacote faltar no deploy, o erro volta claro na resposta).
let _zx = null;
async function _zxReader() {
  if (_zx) return _zx;
  const { prepareZXingModule, readBarcodes } = require('zxing-wasm/reader');
  // o require.resolve aponta pro build cjs (dist/cjs/reader/…); o .wasm mora em dist/reader/.
  // Procuramos nos candidatos e usamos o primeiro que existir — falha vira erro claro na rota.
  const _base = path.dirname(require.resolve('zxing-wasm/reader'));
  const _cands = [
    path.join(_base, 'zxing_reader.wasm'),
    path.join(_base, '..', '..', 'reader', 'zxing_reader.wasm'),
    path.join(_base, '..', 'reader', 'zxing_reader.wasm')
  ];
  const wasmPath = _cands.find(c => { try { return fs.existsSync(c); } catch (e) { return false; } });
  if (!wasmPath) throw new Error('zxing_reader.wasm não encontrado (candidatos: ' + _cands.join(' | ') + ')');
  const wb = fs.readFileSync(wasmPath);
  prepareZXingModule({ overrides: { wasmBinary: wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength) }, fireImmediately: true });
  _zx = readBarcodes;
  return _zx;
}
async function decodificarZplShopee(txt) {
  const readBarcodes = await _zxReader();
  const zlibD = require('zlib');
  const ms = [...String(txt).matchAll(/~DG[A-Z]:[A-Z0-9_.]+,(\d+),(\d+),:Z64:([A-Za-z0-9+\/=]+)/g)];
  const cortes = ms.map(m => m.index);
  const saida = [];
  for (let k = 0; k < ms.length; k++) {
    const fatia = txt.slice(cortes[k], k + 1 < cortes.length ? cortes[k + 1] : txt.length);
    const item = { zpl: fatia, nf: null, chave: null, tracking: null };
    try {
      const total = Number(ms[k][1]), rb = Number(ms[k][2]);
      const raw = zlibD.inflateSync(Buffer.from(ms[k][3], 'base64'));
      const w = rb * 8, h = Math.floor(total / rb);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < raw.length && i < rb * h; i++) {
        const b = raw[i];
        for (let bit = 0; bit < 8; bit++) { const v = ((b >> (7 - bit)) & 1) ? 0 : 255; const o = (i * 8 + bit) * 4; rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255; }
      }
      const res = await readBarcodes({ data: rgba, width: w, height: h }, { formats: ['Code128', 'QRCode'], tryHarder: true, maxNumberOfSymbols: 8 });
      for (const r of res) {
        const s = String(r.text || '');
        if (!item.chave && /^\d{44}$/.test(s)) { item.chave = s; item.nf = Number(s.slice(25, 34)); }
        if (!item.tracking && /^BR[0-9A-Z]{10,}$/.test(s)) item.tracking = s;
      }
    } catch (e) {}
    saida.push(item);
  }
  return saida;
}

// ─── Rotas HTTP (namespaced) ────────────────────────────────────────────
function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ── GUARDA DE SESSÃO ────────────────────────────────────────────────
    // Rotas públicas (tela de login precisa delas) e as já cobertas pela trava
    // central do index.js (ADMIN_KEY: /run,/setup,/debug,/robo,/forcar) passam.
    // Todo o RESTO (dados de pedido, DANFE, XML, separação, ações) exige sessão.
    {
      const _meu = p.startsWith('/good-checkout-offline'); // guarda só age nas rotas DESTE módulo
      const _pub = (
        p === '/good-checkout-offline' || p === '/good-checkout-offline/' ||
        p === '/good-checkout-offline/painel' || p === '/good-checkout-offline/login' ||
        p === '/good-checkout-offline/operadores' || p === '/good-checkout-offline/health' ||
        p === '/good-checkout-offline/saude' || p.includes('/callback') ||
        p === '/good-checkout-offline/qz-cert' || p === '/good-checkout-offline/qz-sign' ||
        p === '/good-checkout-offline/danfes-lote'   // Codex PR#41: auth própria na rota (302+admin) — o gate devolvia 401 JSON antes do redirect
      );
      const _central = (
        p.includes('/run') || p.includes('/setup') || p.includes('/robo') ||
        p.includes('/forcar') || /debug/i.test(p)
      );
      if (_meu && !_pub && !_central) {
        const _op = validarSessao(req.headers['cookie']);
        if (!_op) { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
        req._op = _op;
      }
    }

    // raiz do módulo → manda pro painel (evita "not found" ao abrir a URL base)
    if (method === 'GET' && (p === '/good-checkout-offline' || p === '/good-checkout-offline/')) {
      res.writeHead(302, { Location: '/good-checkout-offline/painel' });
      res.end();
      return true;
    }

    // ── IR PRO PEDIDO NA SHOPEE (b12) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env GOODBKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    if (method === 'GET' && p === '/good-checkout-offline/ir-shopee') {
      const snIr  = String((urlObj.searchParams && urlObj.searchParams.get('sn')) || '').trim();
      const diagIr = ((urlObj.searchParams && urlObj.searchParams.get('diag')) || '') === '1';
      const buscaIr = 'https://seller.shopee.com.br/portal/sale/order?searchKeyword=' + encodeURIComponent(snIr);
      const vai = destino => { res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store' }); res.end(); };

      if (!snIr) { if (diagIr) { json(res, 400, { ok: false, erro: 'faltou ?sn=' }); } else { vai(buscaIr); } return true; }

      const ARQ_IDS = path.join(CACHE_DIR, '_shopee-ids.json');
      const mapaIr  = readJson(ARQ_IDS, {}) || {};
      if (mapaIr[snIr] && !diagIr) { vai('https://seller.shopee.com.br/portal/sale/order/' + mapaIr[snIr]); return true; }

      const passosIr = [];
      let idIr = mapaIr[snIr] || null;
      if (idIr) passosIr.push({ passo: 'cache', order_id: idIr });

      try {
        const sessIr = shopeeSessaoLer();
        const ckIr   = sessIr.cookie;
        if (!ckIr) {
          passosIr.push({ passo: 'cookie', erro: 'sem cookie: env GOODBKP_SHOPEE_COOKIE vazia e nada gravado no disco' });
        } else {
          const cdsIr = (ckIr.match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
          const urlIr = 'https://seller.shopee.com.br/api/v3/order/get_order_list_search_bar_hint'
                      + '?SPC_CDS=' + encodeURIComponent(cdsIr)
                      + '&SPC_CDS_VER=2'
                      + '&keyword=' + encodeURIComponent(snIr)
                      + '&category=1&order_list_tab=100&entity_type=1';
          const rIr = await fetch(urlIr, {
            headers: {
              'Cookie': ckIr,
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
              'Referer': 'https://seller.shopee.com.br/portal/sale/order',
              'X-Api-Src-List': 'pc',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
            }
          });
          const txtIr = await rIr.text();
          const renIr = shopeeSessaoAtualiza(rIr);   // set-cookie da resposta → a sessão se renova sozinha
          passosIr.push({ passo: 'consulta', status: rIr.status, tem_cds: !!cdsIr, tam_cookie: ckIr.length, origem_cookie: sessIr.origem || null, renovou: renIr ? renIr.mudou : 0, corpo: txtIr.slice(0, 700) });

          let jIr = null; try { jIr = JSON.parse(txtIr); } catch (e) {}
          // o resultado NÃO vem em data.list — vem em data.order_sn_result.list.
          // Varre recursivamente qualquer "list" que tenha order_id, pra não depender do formato.
          const achIr = [];
          (function varre(o, prof) {
            if (!o || typeof o !== 'object' || prof > 6) return;
            if (Array.isArray(o.list)) o.list.forEach(x => { if (x && x.order_id) achIr.push(x); });
            Object.keys(o).forEach(k => { if (o[k] && typeof o[k] === 'object') varre(o[k], prof + 1); });
          })(jIr && jIr.data, 0);

          const alvoIr = achIr.find(x => String(x.order_sn || '').toUpperCase() === snIr.toUpperCase()) || achIr[0];
          if (alvoIr && alvoIr.order_id) {
            idIr = String(alvoIr.order_id);
            mapaIr[snIr] = idIr;
            try { writeJson(ARQ_IDS, mapaIr); } catch (e) {}
            passosIr.push({ passo: 'achou', order_id: idIr, order_sn: alvoIr.order_sn || null });
          } else {
            passosIr.push({ passo: 'nao_achou', candidatos: achIr.length, code: (jIr && (jIr.code != null ? jIr.code : jIr.error)) || null, msg: (jIr && (jIr.user_message || jIr.message)) || null });
          }
        }
      } catch (e) {
        passosIr.push({ passo: 'excecao', erro: String((e && e.message) || e).slice(0, 250) });
      }

      if (diagIr) {
        json(res, 200, { ok: !!idIr, sn: snIr, order_id: idIr, destino: idIr ? ('https://seller.shopee.com.br/portal/sale/order/' + idIr) : buscaIr, ids_em_cache: Object.keys(mapaIr).length, versao: VERSAO, passos: passosIr });
        return true;
      }
      vai(idIr ? ('https://seller.shopee.com.br/portal/sale/order/' + idIr) : buscaIr);
      return true;
    }

    // SAÚDE DA SESSÃO SHOPEE (b13) — admin. Diz se o cookie está vivo, de onde ele
    // veio (env ou renovado sozinho) e quando foi atualizado pela última vez.
    if (method === 'GET' && p === '/good-checkout-offline/shopee-sessao') {
      const opSh = validarSessao(req.headers['cookie']);
      if (!opSh || !ehAdmin(opSh)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const antes = shopeeSessaoLer();
      const teste = await shopeeKeepAlive();
      const dep   = shopeeSessaoLer();
      json(res, 200, {
        ok: !!teste.ok,
        empresa: 'good-checkout-offline',
        env_semente: SHOPEE_ENV_COOKIE,
        tem_cookie: !!antes.cookie,
        tam_cookie: (antes.cookie || '').length,
        origem: dep.origem || null,
        atualizado: dep.atualizado || null,
        renovacoes: dep.renovacoes || 0,
        teste,
        versao: VERSAO
      });
      return true;
    }

    // ADMIN (por sessão): dispara o ciclo AGORA — consulta o Bling sem esperar os 10 min do cron
    if (method === 'POST' && p === '/good-checkout-offline/ciclo-agora') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const agora = Date.now();
      if (agora - _ultimoCicloAgora < 60000) { json(res, 200, { ok: false, erro: '⏳ ciclo já disparado há menos de 1 min — aguarde' }); return true; }
      _ultimoCicloAgora = agora;
      rodarCiclo('painel-admin').catch(() => {});
      json(res, 200, { ok: true, mensagem: 'consultando o Bling agora (~30-60s)' });
      return true;
    }

    // ADMIN: ANEXAR ETIQUETA PDF na mão. Existe pro caso real em que o Bling fica SEM logística
    // no pedido (importou depois do envio já organizado no canal, ou a NF travou a edição) e a
    // etiqueta não vem nem pelo Bling nem pela API do canal. O admin baixa a etiqueta no painel do
    // marketplace, anexa aqui, e o pedido volta a ser processável pelo estoquista — que NÃO precisa
    // (nem deve) ter acesso ao seller center. Body: { id, pdf_base64 }.
    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).
    if (method === 'POST' && p === '/good-checkout-offline/nf-anexar') {
      const opN = validarSessao(req.headers['cookie']);
      if (!opN || !ehAdmin(opN)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let bodyN = {}; try { const _rn = await readBody(req); bodyN = (_rn && typeof _rn === 'object') ? _rn : JSON.parse(_rn || '{}'); } catch (e) {}
      const idN = String(bodyN.id || '').trim();
      const b64N = String(bodyN.pdf_base64 || '').replace(/^data:[^,]*,/, '');
      if (!idN || !b64N) { json(res, 400, { ok: false, erro: 'faltou o id do pedido ou o arquivo' }); return true; }
      let bufN = null; try { bufN = Buffer.from(b64N, 'base64'); } catch (e) {}
      if (!bufN || bufN.length < 100) { json(res, 400, { ok: false, erro: 'arquivo vazio ou inválido' }); return true; }
      const ehPdfN = b => !!(b && b.length > 100 && b.slice(0, 4).toString('utf8') === '%PDF');
      const ehXmlN = b => { if (!b || b.length < 80) return false; const s = b.slice(0, 4000).toString('utf8'); return /<\s*(nfeProc|NFe|infNFe)[\s>]/i.test(s); };
      let pdfN = null, xmlN = null;
      if (ehPdfN(bufN)) pdfN = bufN;
      else if (ehXmlN(bufN)) xmlN = bufN;
      else if (bufN[0] === 0x50 && bufN[1] === 0x4B) {
        try {   // reaproveita a leitura de zip da etiqueta? não: aquela vive dentro do outro if. Aqui é uma leitura simples do diretório central.
          const zl = require('zlib');
          let eo = -1;
          for (let x = bufN.length - 22; x >= 0 && x > bufN.length - 66000; x--) { if (bufN.readUInt32LE(x) === 0x06054b50) { eo = x; break; } }
          if (eo >= 0) {
            const qt = bufN.readUInt16LE(eo + 10); let of = bufN.readUInt32LE(eo + 16);
            for (let k = 0; k < qt && of + 46 < bufN.length; k++) {
              if (bufN.readUInt32LE(of) !== 0x02014b50) break;
              const mt = bufN.readUInt16LE(of + 10), tc = bufN.readUInt32LE(of + 20);
              const fn = bufN.readUInt16LE(of + 28), ex = bufN.readUInt16LE(of + 30), cm = bufN.readUInt16LE(of + 32);
              const lc = bufN.readUInt32LE(of + 42);
              const lf = bufN.readUInt16LE(lc + 26), le = bufN.readUInt16LE(lc + 28);
              const ini = lc + 30 + lf + le;
              const dd = tc > 0 ? bufN.slice(ini, ini + tc) : bufN.slice(ini);
              let conteudo = null;
              try { conteudo = mt === 0 ? dd : zl.inflateRawSync(dd, { finishFlush: zl.constants.Z_SYNC_FLUSH }); } catch (e) {}
              if (conteudo) { if (!pdfN && ehPdfN(conteudo)) pdfN = conteudo; else if (!xmlN && ehXmlN(conteudo)) xmlN = conteudo; }
              of += 46 + fn + ex + cm;
            }
          }
        } catch (e) {}
      }
      if (!pdfN && !xmlN) { json(res, 400, { ok: false, erro: 'não reconheci o arquivo — mande a NF em PDF (DANFE) ou XML' }); return true; }
      const dirN = path.join(CACHE_DIR, String(idN));
      let numeroNF = null, chaveNF = null, emissaoNF = null;
      try {
        ensureDir(dirN);
        // 09/08 (b137, Codex): mata o `nf-simp.json` NA HORA DO ANEXO. A auto-cura do ciclo
        // só apagava quando o ID da NF MUDAVA no Bling — e no caso comum a associação
        // cancelada mantém o mesmo id, então o arquivo da nota velha sobrevivia e a Zebra
        // seguia imprimindo os dados fiscais dela.
        try { fs.unlinkSync(path.join(dirN, 'nf-simp.json')); } catch (e) {}
        // 10/08 (Codex, PR#5): anexo SÓ DE XML também descarta a DANFE anterior — ela é
        // da nota velha (do Bling ou de um anexo passado) e o /danfe//imprimir a serviriam.
        // Vale a última subida: sem PDF novo, melhor SEM danfe (guardas seguram o Bling)
        // do que com a cancelada.
        if (xmlN && !pdfN) { try { fs.unlinkSync(path.join(dirN, 'danfe.pdf')); } catch (e) {} }
        if (pdfN) fs.writeFileSync(path.join(dirN, 'danfe.pdf'), pdfN);
        if (xmlN) {
          fs.writeFileSync(path.join(dirN, 'nf.xml'), xmlN);
          const s = xmlN.toString('utf8');
          const mN = s.match(/<nNF>\s*(\d+)\s*<\/nNF>/i);           if (mN) numeroNF = mN[1];
          const mC = s.match(/(?:<chNFe>\s*|Id="NFe)(\d{44})/i);      if (mC) chaveNF = mC[1];
          const mD = s.match(/<dhEmi>\s*([0-9T:+\-]{19})/i) || s.match(/<dEmi>\s*(\d{4}-\d{2}-\d{2})/i);
          if (mD) emissaoNF = mD[1].replace('T', ' ').slice(0, 19);
        }
      } catch (e) { json(res, 500, { ok: false, erro: 'não consegui salvar o arquivo' }); return true; }
      const aplica = o => {
        if (!o) return o;
        if (pdfN) o.tem_danfe = true;
        if (numeroNF) { o.nf_numero = numeroNF; o.tem_nf = true; }
        if (emissaoNF) o.nf_emissao = emissaoNF;
        if (chaveNF) { o.nf = Object.assign({}, o.nf || {}, { chave: chaveNF, numero: numeroNF || (o.nf && o.nf.numero) }); }
        o.nf_anexada = true;
        return o;
      };
      try { const mm = readJson(MANIFEST_FILE, {}); if (mm[idN]) { aplica(mm[idN]); writeJson(MANIFEST_FILE, mm); } } catch (e) {}
      try { const sn = readJson(path.join(dirN, 'pedido.json'), null); if (sn) writeJson(path.join(dirN, 'pedido.json'), aplica(sn)); } catch (e) {}
      console.log(`[GOODBKP] NF ANEXADA na mão no pedido ${idN} (${pdfN ? 'PDF' : ''}${pdfN && xmlN ? '+' : ''}${xmlN ? 'XML' : ''}${numeroNF ? ', nº ' + numeroNF : ''}) por ${opN}`);
      // ev1 - registra a NF anexada no app DEVOLUCOES (pesquisavel pelo
      // nº da NF e tambem pelo pedido). Fire-and-forget, nunca atrapalha.
      try { require('../lib/avisar-devolucoes')('good', 'nf_anexada', numeroNF || idN, { pedido: idN, chave: chaveNF || '', emissao: emissaoNF || '', quem: (typeof opN === 'string' ? opN : '') || '' }); } catch (e) {}
      json(res, 200, { ok: true, pdf: !!pdfN, xml: !!xmlN, nf_numero: numeroNF, chave: chaveNF, emissao: emissaoNF });
      return true;
    }

    if (method === 'POST' && p === '/good-checkout-offline/etiqueta-anexar') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}
      const idA = String(body.id || '').trim();
      const b64A = String(body.pdf_base64 || '').replace(/^data:[^,]*,/, '');
      if (!idA || !b64A) { json(res, 400, { ok: false, erro: 'faltou o id do pedido ou o arquivo' }); return true; }
      let bufA = null; try { bufA = Buffer.from(b64A, 'base64'); } catch (e) {}
      if (!bufA || bufA.length < 200) { json(res, 400, { ok: false, erro: 'arquivo vazio ou inválido' }); return true; }
      // b16: aceita ZPL, ZIP (com VÁRIOS arquivos dentro) e PDF.
      // O ZIP da Shopee traz thermal_zpl_shipping_label.txt + content_declaration.pdf, e o ZPL
      // começa com um bloco gigante de gráfico (~DGR) — o ^XA só aparece lá pelo byte 14.800.
      // Por isso: procura os marcadores numa janela larga, olha TODAS as entradas do zip e
      // confia no nome do arquivo. ZPL vai pro caminho nativo; PDF vai pro alternativo.
      const _ehZpl = b => { if (!b || b.length < 50) return false; const t = b.slice(0, 30000).toString('latin1'); return t.indexOf('^XA') >= 0 || t.indexOf('~DG') >= 0 || t.indexOf('^FO') >= 0 || t.indexOf('^GF') >= 0; };
      const _ehPdf = b => !!(b && b.length > 100 && b.slice(0, 4).toString('utf8') === '%PDF');
      const _zipEntradas = lerZipEntradas;   // b18: parser movido pro escopo do módulo (a rota de massa usa também)
      let conteudoA = null, formatoA = null;
      if (_ehPdf(bufA)) { conteudoA = bufA; formatoA = 'pdf'; }
      else if (_ehZpl(bufA)) { conteudoA = bufA; formatoA = 'zpl'; }
      else if (bufA[0] === 0x50 && bufA[1] === 0x4B && bufA[2] === 0x03 && bufA[3] === 0x04) {   // ZIP "PK\x03\x04"
        try {
          const ents = _zipEntradas(bufA);
          const zplE = ents.find(e => /zpl/i.test(e.nome) || /\.txt$/i.test(e.nome) || _ehZpl(e.conteudo));   // a etiqueta tem prioridade
          if (zplE) { conteudoA = zplE.conteudo; formatoA = 'zpl'; }
          else { const pdfE = ents.find(e => _ehPdf(e.conteudo)); if (pdfE) { conteudoA = pdfE.conteudo; formatoA = 'pdf'; } }
        } catch (e) {}
      }
      if (!conteudoA) { json(res, 400, { ok: false, erro: 'não reconheci o arquivo — mande a etiqueta em ZPL (.txt), ZIP ou PDF' }); return true; }
      const dirA = path.join(CACHE_DIR, String(idA));
      const alvoA = formatoA === 'pdf' ? path.join(dirA, 'etiqueta.pdf') : path.join(dirA, 'etiqueta.' + String(ETIQ_FORMATO || 'zpl').toLowerCase());
      try {
        ensureDir(dirA);
        // 09/08 (b136, P2 do Codex): GRAVA PRIMEIRO, apaga depois. Antes eu apagava o
        // outro formato e só então escrevia — se a escrita falhasse (disco cheio, I/O),
        // o pedido ficava SEM etiqueta nenhuma, tendo destruído a que funcionava.
        const _outro = formatoA === 'pdf'
          ? path.join(dirA, 'etiqueta.' + String(ETIQ_FORMATO || 'zpl').toLowerCase())
          : path.join(dirA, 'etiqueta.pdf');
        fs.writeFileSync(alvoA, conteudoA);
        if (_outro !== alvoA && fs.existsSync(_outro)) { try { fs.unlinkSync(_outro); console.log(`[GOODBKP] etiqueta anexada substituiu a antiga (${path.basename(_outro)} apagada) no pedido ${idA}`); } catch (e) {} }
      }
      catch (e) { json(res, 500, { ok: false, erro: 'não consegui salvar o arquivo' }); return true; }
      // vale JÁ (sem esperar o próximo ciclo): manifesto + snapshot
      try {
        const manA = readJson(MANIFEST_FILE, {});
        // porte (Codex P1c): carimbo `etiqueta_anexada` — sem ele o ciclo re-baixava
      // o PDF velho do Bling por cima do ZPL que o admin subiu.
      if (manA[idA]) { manA[idA].etiqueta_anexada = true; manA[idA].tem_etiqueta = true; manA[idA].etiqueta_pdf = (formatoA === 'pdf'); manA[idA].etiqueta_formato = (formatoA === 'pdf' ? 'PDF' : ETIQ_FORMATO); writeJson(MANIFEST_FILE, manA); }
      } catch (e) {}
      try {
        const snapA = readJson(path.join(dirA, 'pedido.json'), null);
        if (snapA) { snapA.etiqueta_anexada = true; snapA.tem_etiqueta = true; snapA.etiqueta_pdf = (formatoA === 'pdf'); snapA.etiqueta_formato = (formatoA === 'pdf' ? 'PDF' : ETIQ_FORMATO); writeJson(path.join(dirA, 'pedido.json'), snapA); }
      } catch (e) {}
      console.log(`[GOODBKP] etiqueta ANEXADA na mão no pedido ${idA} (${formatoA.toUpperCase()}, ${conteudoA.length} bytes) por ${opSess}`);
      // ev1 - registra o anexo no app DEVOLUCOES (pesquisavel depois).
      // Fire-and-forget: se o servico estiver fora ou sem envs, nada muda aqui.
      try { require('../lib/avisar-devolucoes')('good', 'etiqueta_anexada', idA, { formato: formatoA, quem: (typeof opSess === 'string' ? opSess : (opSess && (opSess.usuario || opSess.nome || opSess.login))) || '' }); } catch (e) {}
      json(res, 200, { ok: true, formato: formatoA, bytes: conteudoA.length });
      return true;
    }

    // ─── ETIQUETAS EM MASSA (11/08, b17) — o lote da Shopee de uma vez só ─────────────────
    // Caso real que motivou: o token Bling↔Shopee venceu (365d, sem alerta), 31 pedidos do dia
    // ficaram sem etiqueta no checkout, e o Diego baixou o ZPL agregado direto da Shopee. As
    // etiquetas são 100% raster (imagem GRF, sem ^FD nem barcode ZPL) — a identificação vem
    // dos códigos DENTRO da imagem (chave da NF-e no CODE128 da DANFE + tracking BR no QR),
    // decodificados FORA daqui. Esta rota recebe o resultado já identificado:
    //   POST { etiquetas: [{ nf: 77412, tracking: 'BR26…', zpl_base64: '…' }] }
    // e casa cada uma pelo nf_numero do manifesto. Grava IDÊNTICO ao anexo individual
    // (grava-primeiro, carimbos no manifesto + snapshot, ev1 pro Devoluções).
    if (method === 'POST' && p === '/good-checkout-offline/etiquetas-zpl-massa') {
      // sessão de admin, igual à irmã individual (a trava central do módulo já exige login
      // antes de chegar aqui; chave por query não passa pelo gate, então nem oferecemos)
      const opSessM = validarSessao(req.headers['cookie']);
      if (!opSessM || !ehAdmin(opSessM)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let bodyM = {}; try { const _rm = await readBody(req); bodyM = (_rm && typeof _rm === 'object') ? _rm : JSON.parse(_rm || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'body inválido' }); return true; }
      let lista = Array.isArray(bodyM.etiquetas) ? bodyM.etiquetas : [];
      let decodificadas = null, sem_codigo = 0;
      // b18: aceita o ARQUIVO CRU da Shopee (zip ou o .txt do ZPL agregado) — o servidor
      // fatia e decodifica os códigos de dentro do bitmap (chave NF + tracking) sozinho
      if (!lista.length && bodyM.arquivo_base64) {
        let bufU = null; try { bufU = Buffer.from(String(bodyM.arquivo_base64).replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) {}
        if (!bufU || bufU.length < 200) { json(res, 400, { ok: false, erro: 'arquivo vazio ou inválido' }); return true; }
        if (bufU.length > 12 * 1024 * 1024) { json(res, 400, { ok: false, erro: 'arquivo acima de 12MB — divida em partes' }); return true; }
        let txtU = null;
        if (bufU[0] === 0x50 && bufU[1] === 0x4B && bufU[2] === 0x03 && bufU[3] === 0x04) {
          try {
            const entsU = lerZipEntradas(bufU);
            const zplU = entsU.find(e2 => /zpl/i.test(e2.nome) || /\.txt$/i.test(e2.nome) || (e2.conteudo && e2.conteudo.slice(0, 30000).toString('latin1').indexOf('~DG') >= 0));
            if (zplU) txtU = zplU.conteudo.toString('latin1');
          } catch (e) {}
        } else {
          const cab = bufU.slice(0, 30000).toString('latin1');
          if (cab.indexOf('~DG') >= 0 || cab.indexOf('^XA') >= 0) txtU = bufU.toString('latin1');
        }
        if (!txtU) { json(res, 400, { ok: false, erro: 'não reconheci o arquivo — mande o ZIP da Shopee, o .txt do ZPL ou o JSON identificado' }); return true; }
        let itensU = [];
        try { itensU = await decodificarZplShopee(txtU); }
        catch (e) { json(res, 500, { ok: false, erro: 'decodificador indisponível: ' + String(e.message || e).slice(0, 160) }); return true; }
        if (!itensU.length) { json(res, 400, { ok: false, erro: 'nenhuma etiqueta (~DG) encontrada no arquivo' }); return true; }
        if (itensU.length > 120) { json(res, 400, { ok: false, erro: itensU.length + ' etiquetas num arquivo só — divida em arquivos de até 120 (a decodificação roda dentro da requisição)' }); return true; }
        decodificadas = itensU.length;
        lista = [];
        for (const it2 of itensU) {
          if (!it2.nf) { sem_codigo++; continue; }
          lista.push({ nf: it2.nf, tracking: it2.tracking, zpl_base64: Buffer.from(it2.zpl, 'latin1').toString('base64') });
        }
        if (!lista.length) { json(res, 200, { ok: false, erro: 'decodifiquei ' + decodificadas + ' etiqueta(s) mas nenhuma trouxe a chave da NF legível', decodificadas, sem_codigo }); return true; }
      }
      if (!lista.length) { json(res, 400, { ok: false, erro: 'mande { arquivo_base64 } (zip/txt da Shopee) ou { etiquetas: [{ nf, tracking, zpl_base64 }] }' }); return true; }
      if (lista.length > 300) { json(res, 400, { ok: false, erro: 'máximo de 300 etiquetas por chamada' }); return true; }
      const _ehZplM = b => { if (!b || b.length < 50) return false; const s = b.slice(0, 30000).toString('latin1'); return s.indexOf('^XA') >= 0 || s.indexOf('~DG') >= 0; };
      const manM = readJson(MANIFEST_FILE, {});
      // índice nf_numero → id (e tracking → id como reserva, se o snapshot tiver rastreio)
      const porNF = {};
      for (const [idX, mX] of Object.entries(manM)) {
        const nfX = Number(mX && mX.nf_numero);
        if (isFinite(nfX) && nfX > 0 && porNF[nfX] === undefined) porNF[nfX] = idX;
        else if (isFinite(nfX) && nfX > 0 && porNF[nfX] !== undefined) porNF[nfX] = null;   // NF duplicada no manifesto: ambígua, não casa às cegas
      }
      const casadas = [], sem_pedido = [], invalidas = [], ambiguas = [];
      let mudouMan = false;
      const quemM = (typeof opSessM === 'string' ? opSessM : (opSessM && (opSessM.usuario || opSessM.nome || opSessM.login))) || '';
      for (const et of lista) {
        const nfN = Number(et && et.nf);
        let bufM = null; try { bufM = Buffer.from(String((et && et.zpl_base64) || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) {}
        if (!isFinite(nfN) || nfN <= 0 || !bufM || bufM.length < 200 || !_ehZplM(bufM)) { invalidas.push(et && et.nf); continue; }
        const idM = porNF[nfN];
        if (idM === null) { ambiguas.push(nfN); continue; }
        if (!idM) { sem_pedido.push(nfN); continue; }
        const dirM = path.join(CACHE_DIR, String(idM));
        const alvoM = path.join(dirM, 'etiqueta.' + String(ETIQ_FORMATO || 'zpl').toLowerCase());
        try {
          ensureDir(dirM);
          const _outroM = path.join(dirM, 'etiqueta.pdf');
          fs.writeFileSync(alvoM, bufM);   // grava-primeiro (b136): só remove o PDF depois que o ZPL está no disco
          // Codex PR#35: com GOODBKP_ETIQ_FORMATO=PDF os dois caminhos coincidem — sem o guard,
          // apagaríamos o arquivo que acabamos de gravar (a irmã individual sempre teve o guard)
          if (_outroM !== alvoM && fs.existsSync(_outroM)) { try { fs.unlinkSync(_outroM); } catch (e) {} }
        } catch (e) { invalidas.push(nfN); continue; }
        if (manM[idM]) { manM[idM].etiqueta_anexada = true; manM[idM].tem_etiqueta = true; manM[idM].etiqueta_pdf = false; manM[idM].etiqueta_formato = ETIQ_FORMATO; mudouMan = true; }
        try {
          const snapM = readJson(path.join(dirM, 'pedido.json'), null);
          if (snapM) { snapM.etiqueta_anexada = true; snapM.tem_etiqueta = true; snapM.etiqueta_pdf = false; snapM.etiqueta_formato = ETIQ_FORMATO; writeJson(path.join(dirM, 'pedido.json'), snapM); }
        } catch (e) {}
        try { require('../lib/avisar-devolucoes')('good', 'etiqueta_anexada', idM, { formato: 'zpl', quem: quemM, massa: true }); } catch (e) {}
        casadas.push({ nf: nfN, id: idM, numero: (manM[idM] && manM[idM].numero) || null, bytes: bufM.length });
      }
      // Codex PR#35: o ciclo pode salvar um manifesto ANTIGO por cima (ele carrega o dele em
      // memória no começo da rodada). Re-lemos AGORA e carimbamos a cópia fresca — a janela de
      // corrida cai de minutos pra milissegundos; e se ainda assim o ciclo atropelar, o próximo
      // reconstrói do snapshot (que também carimbamos), então o estado se auto-repara.
      if (mudouMan) {
        try {
          const manF = readJson(MANIFEST_FILE, {});
          for (const c of casadas) { if (manF[c.id]) { manF[c.id].etiqueta_anexada = true; manF[c.id].tem_etiqueta = true; manF[c.id].etiqueta_pdf = false; manF[c.id].etiqueta_formato = ETIQ_FORMATO; } }
          writeJson(MANIFEST_FILE, manF);
        } catch (e) {}
      }
      console.log('[GOODBKP] etiquetas em MASSA: ' + casadas.length + ' anexada(s), ' + sem_pedido.length + ' sem pedido, ' + invalidas.length + ' inválida(s) — por ' + quemM);
      json(res, 200, { ok: true, total: lista.length, decodificadas, sem_codigo, anexadas: casadas.length, casadas, sem_pedido, ambiguas, invalidas });
      return true;
    }

    // ── DANFEs em LOTE (12/08, caso das 29 DANFEs trocadas pela Shopee): junta as NFs
    // corretas de N pedidos num PDF único pro galpão imprimir 1 arquivo e colar sobre o
    // rodapé errado das etiquetas. Fonte: danfe.pdf do cache; fallback baixarDanfe com a
    // MESMA guarda do /imprimir (nunca baixa NF velha por cima de nota anexada — PR#5).
    if (method === 'GET' && p === '/good-checkout-offline/danfes-lote') {
      const opSessDL = validarSessao(req.headers['cookie']);
      if (!opSessDL || !ehAdmin(opSessDL)) { res.writeHead(302, { Location: '/good-checkout-offline/' }); res.end(); return true; }
      const idsTodos = String(urlObj.searchParams.get('nfs') || urlObj.searchParams.get('pedidos') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!idsTodos.length) { json(res, 400, { ok: false, erro: 'use ?nfs=77488,77491,… (números das NFs)' }); return true; }
      if (idsTodos.length > 120) { json(res, 400, { ok: false, erro: 'máximo 120 pedidos por lote (recebi ' + idsTodos.length + ') — divida em dois' }); return true; }   // Codex PR#41: nunca cortar em silêncio
      // 12/08 (achado no 1º uso real): o galpão/o Diego digita o NÚMERO da venda (74816), mas a
      // pasta do cache usa a CHAVE do Bling — mesma tradução do /debug-nf-simp: sem pasta, procura
      // o numero (e o numero_loja) no manifesto. Assim a rota aceita os dois formatos.
      // 12/08 (regra do Diego): NF EXATA ou não pega — nada de cascata/adivinhação. Aceita a
      // chave da pasta do cache (uso interno) ou o NÚMERO DA NF; dois pedidos com a mesma NF
      // (não deve existir) não escolhem nenhum — cai em faltando com o motivo.
      const resolveDL = (x) => {
        // Codex PR#42: o manifesto e RELIDO a cada item — o ciclo de fundo pode reassociar a
        // NF de um pedido enquanto o lote roda, e um mapa velho entregaria a NF B sob o rotulo A
        const manDL = manifest();
        const s = String(x).replace(/^0+/, '');   // 077488 e 77488 sao a mesma NF
        try { if (fs.existsSync(path.join(CACHE_DIR, String(x), 'pedido.json')) || fs.existsSync(path.join(CACHE_DIR, String(x), 'danfe.pdf'))) return { id: String(x) }; } catch (e) {}
        // Codex PR#42: '0'/'00' normaliza pra vazio e casaria com todo pedido SEM nf_numero
        if (!s) return { id: null, ambiguo: 'número de NF inválido' };
        const hits = Object.keys(manDL).filter(k2 => {
          const nfk = String((manDL[k2] || {}).nf_numero || '').replace(/^0+/, '');
          return nfk && nfk === s;
        });
        if (hits.length > 1) return { id: null, ambiguo: 'NF ' + s + ' aparece em ' + hits.length + ' pedidos' };
        if (hits.length === 1) {
          // Codex PR#42: NF anexada à mão pelo caminho só-PDF não atualiza o nf_numero do
          // manifesto — o número velho (cancelado) apontaria pra DANFE nova. Sem número
          // verificado, a rota NÃO entrega: o admin imprime esse pelo 📎 NF do card.
          // Codex PR#42: anexo COM XML tem numero confirmado (o /nf-anexar le o nNF e grava
          // no snapshot) — vale. So o anexo SO-PDF fica sem numero verificado e e recusado.
          const snapV = readJson(path.join(CACHE_DIR, String(hits[0]), 'pedido.json'), null);
          if (snapV && snapV.nf_anexada) {
            const numV = String((snapV.nf && snapV.nf.numero) || snapV.nf_numero || '').replace(/^0+/, '');
            if (numV !== s) return { id: null, ambiguo: 'NF anexada sem numero confirmado - imprima pelo botao NF do pedido' };
          }
          return { id: hits[0] };
        }
        return { id: null };
      };
      const ambiguos = [];
      const { PDFDocument } = require('pdf-lib');
      const docs = [], achadas = [], faltando = [];
      // Codex PR#42: resolver TUDO antes do loop deixava a janela dos awaits — outro admin
      // podia trocar a NF de um pedido ainda nao lido e a gente entregaria o PDF novo sob o
      // numero velho. Cada item e resolvido no instante em que vai ser lido.
      for (let iDL = 0; iDL < idsTodos.length; iDL++) {
        const rotuloDL = idsTodos[iDL];
        const rDL = resolveDL(rotuloDL);
        const idL = rDL.id;
        if (!idL) { faltando.push(rotuloDL); if (rDL.ambiguo) ambiguos.push(rotuloDL + ' (' + rDL.ambiguo + ')'); continue; }
        const dirL = path.join(CACHE_DIR, String(idL));
        let nfB = null;
        try { nfB = fs.readFileSync(path.join(dirL, 'danfe.pdf')); } catch (e) {}
        if (!nfB) {
          const snapL = readJson(path.join(dirL, 'pedido.json'), null);
          if (snapL && !snapL.nf_anexada && snapL.nf && snapL.nf.id) {
            const baixado = await baixarDanfe(snapL.nf.id);
            // Codex PR#41 (P1): um admin pode ter ANEXADO a NF corrigida enquanto o download
            // rodava — re-lê o snapshot e o disco DEPOIS do await; anexo novo vence o Bling velho
            const snapL2 = readJson(path.join(dirL, 'pedido.json'), null);
            if (snapL2 && snapL2.nf_anexada) {
              try { nfB = fs.readFileSync(path.join(dirL, 'danfe.pdf')); } catch (e) {}
            } else if (baixado) {
              nfB = baixado;
              try { ensureDir(dirL); fs.writeFileSync(path.join(dirL, 'danfe.pdf'), nfB); } catch (e) {}
            }
          }
        }
        // Codex PR#41: valida o PDF JÁ NA COLETA — truncado/cifrado não vira "achada"
        let docL = null;
        if (nfB) { try { docL = await PDFDocument.load(nfB); } catch (e) { docL = null; } }
        if (docL && docL.getPageCount() > 0) { docs.push([rotuloDL, docL]); achadas.push(rotuloDL); } else faltando.push(rotuloDL);
      }
      if (urlObj.searchParams.get('json')) { json(res, 200, { ok: true, pedidas: idsTodos.length, achadas, faltando, ambiguos }); return true; }
      if (!docs.length) { json(res, 404, { ok: false, erro: 'nenhuma DANFE válida encontrada', faltando, ambiguos }); return true; }
      try {
        const outDL = await PDFDocument.create();
        for (const [idL, srcDL] of docs) {
          try { const pgs = await outDL.copyPages(srcDL, srcDL.getPageIndices()); pgs.forEach(pg => outDL.addPage(pg)); }
          catch (e) { faltando.push(idL); }
        }
        if (!outDL.getPageCount()) { json(res, 422, { ok: false, erro: 'nenhuma página copiada', faltando }); return true; }   // Codex PR#41: nunca 200 com PDF vazio
        const mergedDL = Buffer.from(await outDL.save());
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfes-lote.pdf"', 'X-Faltando': faltando.join(','), 'X-Ambiguos': ambiguos.map(a9 => String(a9).split(' (')[0]).join(',') });   // Codex PR#42: header e Latin-1 — motivo (com acento/emoji) so no ?json=1
        res.end(mergedDL);
      } catch (e) { json(res, 500, { ok: false, erro: 'pdf-lib: ' + String(e.message || e).slice(0, 120), faltando }); }
      return true;
    }

    // ─── página do upload em massa (admin logado) ─────────────────────────────────────────
    if (method === 'GET' && p === '/good-checkout-offline/etiquetas-massa') {
      const opSessP2 = validarSessao(req.headers['cookie']);
      if (!opSessP2 || !ehAdmin(opSessP2)) { res.writeHead(302, { Location: '/good-checkout-offline/' }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Etiquetas em massa · GOOD</title><body style="font-family:system-ui;max-width:680px;margin:32px auto;padding:0 16px">' +
        '<h2>📎 Etiquetas em massa — GOOD</h2>' +
        '<p>Selecione o <b>ZIP baixado da Shopee</b> (ou o .txt do ZPL, ou um JSON já identificado). O servidor lê a <b>chave da NF</b> de dentro de cada etiqueta e anexa no pedido certo.</p>' +
        '<input type="file" id="f" accept=".zip,.txt,.json,application/json,application/zip,text/plain"> <button id="b" style="padding:8px 18px">Enviar</button>' +
        '<pre id="o" style="background:#f5f5f5;padding:12px;white-space:pre-wrap"></pre>' +
        '<script>document.getElementById("b").onclick=async()=>{const f=document.getElementById("f").files[0];const o=document.getElementById("o");if(!f){o.textContent="escolha o arquivo";return}try{const nome=(f.name||"").toLowerCase();if(nome.endsWith(".json")){const dados=JSON.parse(await f.text());const todas=Array.isArray(dados.etiquetas)?dados.etiquetas:[];if(!todas.length){o.textContent="o JSON não tem etiquetas";return}const TAM=60;const agg={total:todas.length,anexadas:0,casadas:[],sem_pedido:[],ambiguas:[],invalidas:[]};for(let i=0;i<todas.length;i+=TAM){o.textContent="enviando "+Math.min(i+TAM,todas.length)+" de "+todas.length+"…";const r=await fetch("/good-checkout-offline/etiquetas-zpl-massa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({etiquetas:todas.slice(i,i+TAM)})});const j=await r.json();if(!j.ok){o.textContent="erro no lote: "+JSON.stringify(j);return}agg.anexadas+=j.anexadas;agg.casadas.push(...j.casadas);agg.sem_pedido.push(...j.sem_pedido);agg.ambiguas.push(...j.ambiguas);agg.invalidas.push(...j.invalidas)}o.textContent=JSON.stringify(agg,null,2);return}o.textContent="enviando e decodificando (uns segundos)…";const buf=await f.arrayBuffer();let b64="";const u8=new Uint8Array(buf);for(let i=0;i<u8.length;i+=32768){b64+=String.fromCharCode.apply(null,u8.subarray(i,i+32768))}b64=btoa(b64);const r=await fetch("/good-checkout-offline/etiquetas-zpl-massa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({arquivo_base64:b64})});const j=await r.json();o.textContent=JSON.stringify(j,null,2)}catch(e){o.textContent="erro: "+e.message}};</script>' +
        '</body></html>');
      return true;
    }

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /good-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.
    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/backfill-valores') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      if (_bf.rodando) { json(res, 200, { ok: true, rodando: true, progresso: _bf.feitos + '/' + _bf.total, ok_ate_agora: _bf.ok, falhas: _bf.falhas, iniciado_em: _bf.iniciado_em }); return true; }
      const dias = Math.max(1, Math.min(120, Number(urlObj.searchParams.get('dias') || 31)));
      const corte = Date.now() - dias * 86400000;
      const confIni = readJson(CONFERIDOS_FILE, {});
      const alvos = Object.keys(confIni).filter(id => {
        const c = confIni[id];
        return c && (c.valor == null) && c.conferido_em && new Date(c.conferido_em).getTime() >= corte;
      });
      if (!alvos.length) { json(res, 200, { ok: true, mensagem: 'nada a preencher — todos os finalizados dos últimos ' + dias + ' dias já têm valor' }); return true; }
      _bf = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString() };
      json(res, 200, { ok: true, iniciado: true, pedidos_sem_valor: alvos.length, dias, mensagem: 'backfill rodando em background (~' + Math.ceil(alvos.length * 0.5 / 60) + ' min) — chame esta URL de novo pra ver o progresso' });
      (async () => {
        const dorme = ms => new Promise(r => setTimeout(r, ms));
        const pendentes = {};
        const salvar = () => {
          if (!Object.keys(pendentes).length) return;
          const c2 = readJson(CONFERIDOS_FILE, {});
          for (const [id, v] of Object.entries(pendentes)) { if (c2[id]) c2[id].valor = v; }
          writeJson(CONFERIDOS_FILE, c2);
          for (const id of Object.keys(pendentes)) delete pendentes[id];
        };
        for (const id of alvos) {
          try {
            const det = await detalhePedido(id);
            if (det && det.total != null && isFinite(Number(det.total))) { pendentes[id] = Number(det.total); _bf.ok++; }
            else _bf.falhas++;
          } catch (e) { _bf.falhas++; }
          _bf.feitos++;
          if (_bf.feitos % 15 === 0) { salvar(); console.log(`[BACKFILL] ${_bf.feitos}/${_bf.total} (ok=${_bf.ok} falhas=${_bf.falhas})`); }
          await dorme(400);
        }
        salvar();
        _bf.rodando = false;
        console.log(`[BACKFILL] ✔ concluído: ${_bf.ok} valor(es) preenchido(s), ${_bf.falhas} falha(s) de ${_bf.total}`);
      })().catch(e => { _bf.rodando = false; console.log('[BACKFILL] ✗ ' + e.message); });
      return true;
    }

    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /good-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31
    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/backfill-detalhes') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      if (_bfd.rodando) { json(res, 200, { ok: true, rodando: true, progresso: _bfd.feitos + '/' + _bfd.total, ok_ate_agora: _bfd.ok, falhas: _bfd.falhas, iniciado_em: _bfd.iniciado_em }); return true; }
      const dias = Math.max(1, Math.min(120, Number(urlObj.searchParams.get('dias') || 31)));
      const corte = Date.now() - dias * 86400000;
      const confIni = readJson(CONFERIDOS_FILE, {});
      const alvos = Object.keys(confIni).filter(id => {
        const c = confIni[id];
        if (!c || !c.conferido_em || new Date(c.conferido_em).getTime() < corte) return false;
        const semItemValor = Array.isArray(c.itens) && c.itens.length && c.itens.some(it => it.valor_total == null);
        return c.uf == null || c.valor == null || semItemValor;
      });
      if (!alvos.length) { json(res, 200, { ok: true, mensagem: 'nada a preencher — últimos ' + dias + ' dias já têm UF e valores por item' }); return true; }
      _bfd = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString() };
      json(res, 200, { ok: true, iniciado: true, pedidos_a_detalhar: alvos.length, dias, mensagem: 'backfill de detalhes rodando (~' + Math.ceil(alvos.length * 0.5 / 60) + ' min) — chame de novo pra ver o progresso' });
      (async () => {
        const dorme = ms => new Promise(r => setTimeout(r, ms));
        const pend = {};
        const salvar = () => {
          if (!Object.keys(pend).length) return;
          const c2 = readJson(CONFERIDOS_FILE, {});
          for (const [id, d] of Object.entries(pend)) {
            if (!c2[id]) continue;
            if (d.valor != null && c2[id].valor == null) c2[id].valor = d.valor;
            if (d.uf) c2[id].uf = d.uf;
            if (d.municipio) c2[id].municipio = d.municipio;
            if (d.taxa_mkt != null && c2[id].taxa_mkt == null) c2[id].taxa_mkt = d.taxa_mkt;
            if (d.venda_dia && !c2[id].venda_dia) c2[id].venda_dia = d.venda_dia;
            if (d.frete_mkt != null && c2[id].frete_mkt == null) c2[id].frete_mkt = d.frete_mkt;
            if (d.porSku && Array.isArray(c2[id].itens)) {
              c2[id].itens.forEach(it => {
                const v = d.porSku[String(it.sku || '').trim()];
                if (v != null && it.valor_total == null) { it.valor_unit = v; it.valor_total = v * Number(it.qtd || 1); }
              });
            }
          }
          writeJson(CONFERIDOS_FILE, c2);
          for (const id of Object.keys(pend)) delete pend[id];
        };
        for (const id of alvos) {
          try {
            const det = await detalhePedido(id);
            if (det) {
              const porSku = {};
              (det.itens || []).forEach(it => { const c = String(it.codigo || (it.produto && it.produto.codigo) || '').trim(); if (c && it.valor != null) porSku[c] = Number(it.valor); });
              pend[id] = {
                valor: (det.total != null ? Number(det.total) : null),
                uf: (det.transporte && det.transporte.etiqueta && det.transporte.etiqueta.uf) || null,
                municipio: (det.transporte && det.transporte.etiqueta && det.transporte.etiqueta.municipio) || null,
                venda_dia: (det.data ? String(det.data).slice(0, 10) : null),
                taxa_mkt: (det.taxas && isFinite(Number(det.taxas.taxaComissao)) && Number(det.taxas.taxaComissao) > 0) ? Math.round(Number(det.taxas.taxaComissao) * 100) / 100 : null,
                frete_mkt: (det.taxas && isFinite(Number(det.taxas.custoFrete)) && Number(det.taxas.custoFrete) > 0) ? Math.round(Number(det.taxas.custoFrete) * 100) / 100 : null,
                porSku
              };
              _bfd.ok++;
            } else _bfd.falhas++;
          } catch (e) { _bfd.falhas++; }
          _bfd.feitos++;
          if (_bfd.feitos % 15 === 0) { salvar(); console.log(`[BACKFILL-DET] ${_bfd.feitos}/${_bfd.total}`); }
          await dorme(400);
        }
        salvar(); _bfd.rodando = false;
        console.log(`[BACKFILL-DET] ✔ concluído: ${_bfd.ok} ok, ${_bfd.falhas} falha(s) de ${_bfd.total}`);
      })().catch(e => { _bfd.rodando = false; console.log('[BACKFILL-DET] ✗ ' + e.message); });
      return true;
    }

    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    if (method === 'POST' && p === '/good-checkout-offline/sku-info') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const skus = Array.isArray(body.skus) ? body.skus.map(x => String(x || '').trim()).filter(Boolean).slice(0, 40) : [];
      if (!skus.length) { json(res, 200, { ok: true, skus: {} }); return true; }
      const CACHE_SKUINFO = path.join(CACHE_DIR, '_skus-info.json');
      if (!_skuInfoCache) _skuInfoCache = readJson(CACHE_SKUINFO, {});
      const TTL = 6 * 3600 * 1000;
      const out = {}; const faltam = [];
      let _ccTop = null;   // cache permanente de custos, carregado sob demanda
      for (const sku of skus) {
        const c = _skuInfoCache[sku];
        if (!body.fresh && c && (Date.now() - (c.ts || 0)) < TTL && (c.custo != null || c.saldo != null)) {
          // OVERLAY: o custo do cache PERMANENTE sobrepõe qualquer null do cache de 6h (era o que segurava o custo na tela)
          if (!_ccTop) _ccTop = readJson(path.join(CACHE_DIR, '_custos.json'), {});
          const k9 = _ccTop[sku];
          out[sku] = (k9 && k9.custo != null && c.custo == null) ? Object.assign({}, c, { custo: k9.custo, preco: (c.preco != null ? c.preco : k9.preco) }) : c;
        } else faltam.push(sku);
      }
      const dorme = ms => new Promise(r => setTimeout(r, ms));
      const bg = async (pth) => { for (let t = 0; t < 3; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme(1100 + t * 500); } return await blingGet(pth); };   // anti-429: re-tenta com pausa crescente
      let resolveFalhas = 0;
      // 0) cache PERMANENTE de custos (_custos.json, populado pelo custo-sync em background)
      const _ccAll = readJson(path.join(CACHE_DIR, '_custos.json'), {});
      const ids = {};
      const aResolver = [];
      for (const sku of faltam) {
        const k2 = _ccAll[sku];
        if (k2 && k2.id && (Date.now() - (k2.ts || 0)) < 7 * 24 * 3600 * 1000) { ids[sku] = { id: k2.id, preco: (k2.preco != null ? k2.preco : null), custo: (k2.custo != null ? k2.custo : null) }; }
        else aResolver.push(sku);
      }
      // 1) resolve SKU → produto — só quem NÃO está no cache permanente
      for (const sku of aResolver) {
        try {
          let prod = null;
          for (const v of [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])]) {
            const r = await bg(`/produtos?codigo=${encodeURIComponent(v)}&limite=1&criterio=5`);
            const it = r.ok && r.data && r.data.data && r.data.data[0];
            if (it && it.id) { const d = await bg(`/produtos/${it.id}`); prod = (d.ok && d.data && d.data.data) || it; break; }
            await dorme(300);
          }
          if (prod && prod.id) {
            const forn = prod.fornecedor || {};
            const cand = [forn.precoCusto, forn.precoCompra, prod.precoCusto, prod.custo].map(Number).filter(v => isFinite(v) && v > 0);
            ids[sku] = { id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: cand.length ? cand[0] : null };
          } else { ids[sku] = null; if (resolveFalhas < 3) console.log('[SKU-INFO] nao resolveu', sku); resolveFalhas++; }
        } catch (e) { ids[sku] = null; if (resolveFalhas < 3) console.log('[SKU-INFO] erro em', sku, String(e.message || e).slice(0, 80)); resolveFalhas++; }
        await dorme(400);
      }
      // 2) SALDO em LOTE — no Bling v3 o saldo vem de /estoques/saldos, não do detalhe do produto
      const saldos = {};
      const todosIds = Object.values(ids).filter(Boolean).map(o => o.id);
      for (let i = 0; i < todosIds.length; i += 40) {
        try {
          const qs = todosIds.slice(i, i + 40).map(pid => 'idsProdutos[]=' + pid).join('&');
          const r = await bg('/estoques/saldos?' + qs);
          const arr = (r.ok && r.data && r.data.data) || [];
          for (const e2 of arr) {
            const pid = e2 && e2.produto && e2.produto.id;
            const sv = e2 && (e2.saldoVirtualTotal != null ? e2.saldoVirtualTotal : e2.saldoFisicoTotal);
            if (pid != null && sv != null && isFinite(Number(sv))) saldos[pid] = Number(sv);
          }
        } catch (e) {}
        await dorme(300);
      }
      // 3) custo: quem ficou sem, tenta o endpoint de fornecedores do produto
      for (const [sku2, o2] of Object.entries(ids)) {
        if (!o2 || o2.custo != null) continue;
        try {
          const r = await bg(`/produtos/fornecedores?idProduto=${o2.id}&limite=5`);
          const arr = (r.ok && r.data && r.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          const cand = pref ? [pref.precoCusto, pref.precoCompra].map(Number).filter(v => isFinite(v) && v > 0) : [];
          if (cand.length) o2.custo = cand[0];
        } catch (e) {}
        await dorme(220);
      }
      for (const sku of faltam) {
        const o2 = ids[sku];
        const info = o2 ? { saldo: (saldos[o2.id] != null ? saldos[o2.id] : null), preco: o2.preco, custo: o2.custo, ts: Date.now() }
                        : { saldo: null, preco: null, custo: null, ts: Date.now() };
        _skuInfoCache[sku] = info; out[sku] = info;
      }
      if (faltam.length) { try { writeJson(CACHE_SKUINFO, _skuInfoCache); } catch (e) {} }
      json(res, 200, { ok: true, skus: out, consultados_agora: faltam.length, resolvidos: Object.keys(ids).filter(k2 => ids[k2]).length, nao_resolvidos: resolveFalhas });
      return true;
    }

    // DASHBOARD — página (dashboard.html do módulo; por ora só a Girassol tem o arquivo)
    if (method === 'GET' && p === '/good-checkout-offline/dashboard') {
      const fdash = path.join(__dirname, 'dashboard.html');
      if (!fs.existsSync(fdash)) { json(res, 404, { ok: false, erro: 'dashboard ainda não habilitado nesta empresa' }); return true; }
      try { const htmlContent = fs.readFileSync(fdash, 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(htmlContent); }
      catch (e) { json(res, 500, { erro: 'dashboard.html: ' + e.message }); }
      return true;
    }

    // DASHBOARD (sessão admin): dispara o backfill-NF local ao abrir o dashboard — mantém os números sempre frescos
    if (method === 'POST' && p === '/good-checkout-offline/backfill-nf-auto') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      json(res, 200, { ok: true, ...backfillNFLocal(45) });
      return true;
    }

    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /good-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)
    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/backfill-nf') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessB && ehAdmin(sessB)))) { json(res, 404, { error: 'not found' }); return true; }
      const r = backfillNFLocal(urlObj.searchParams.get('dias'));
      json(res, 200, { ok: true, ...r,
        mensagem: r.preenchidos_pela_nf ? ('✓ ' + r.preenchidos_pela_nf + ' pedido(s) ganharam produtos/frete EXATOS da nota (leitura local, sem API)') : 'nada novo a preencher' });
      return true;
    }

    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal
    if ((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/config-fiscal') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const CFG_FILE = path.join(CACHE_DIR, '_config-fiscal.json');
      if (method === 'GET') { json(res, 200, { ok: true, config: readJson(CFG_FILE, { aliquotas: {}, taxas: {} }) }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const atual = readJson(CFG_FILE, { aliquotas: {}, taxas: {} });
      if (body.aliquotas && typeof body.aliquotas === 'object') for (const [k2, v2] of Object.entries(body.aliquotas)) { const n2 = Number(v2); if (/^\d{4}-\d{2}$/.test(k2) && isFinite(n2) && n2 >= 0 && n2 <= 40) atual.aliquotas[k2] = n2; else if (v2 === null) delete atual.aliquotas[k2]; }
      if (body.taxas && typeof body.taxas === 'object') for (const [k2, v2] of Object.entries(body.taxas)) { const n2 = Number(v2); if (isFinite(n2) && n2 >= 0 && n2 <= 50) atual.taxas[String(k2).toLowerCase()] = n2; else if (v2 === null) delete atual.taxas[String(k2).toLowerCase()]; }
      if (body.flex && typeof body.flex === 'object') { atual.flex = atual.flex || {}; for (const [k2, v2] of Object.entries(body.flex)) { const n2 = Number(v2); if ((k2 === 'geral' || k2 === 'shopee') && isFinite(n2) && n2 >= 0 && n2 <= 100) atual.flex[k2] = n2; else if (v2 === null) delete atual.flex[k2]; } }
      writeJson(CFG_FILE, atual);
      json(res, 200, { ok: true, config: atual });
      return true;
    }

    // DASHBOARD (sessão admin): TARIFA REAL do Mercado Livre p/ um pedido (sale_fee da API), com cache permanente
    if (method === 'POST' && p === '/good-checkout-offline/ml-fee') {
      const opSess = validarSessao(req.headers['cookie']);
      if (!opSess || !ehAdmin(opSess)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const orderId = String(body.numeroLoja || '').replace(/\D/g, '');
      if (!orderId) { json(res, 200, { ok: false, erro: 'numeroLoja vazio' }); return true; }
      const FEE_FILE = path.join(CACHE_DIR, '_mlfees.json');
      const cacheF = readJson(FEE_FILE, {});
      if (cacheF[orderId] && cacheF[orderId].fee != null) { json(res, 200, { ok: true, fee: cacheF[orderId].fee, itens: cacheF[orderId].itens, fonte: 'cache' }); return true; }
      try {
        const { garantirTokenML } = require('../good/mlTokenManager');
        const tokenML = await garantirTokenML();
        const r = await fetch('https://api.mercadolibre.com/orders/' + orderId, { headers: { Authorization: 'Bearer ' + tokenML } });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d) { json(res, 200, { ok: false, erro: 'ML respondeu ' + r.status + (d && d.message ? ': ' + d.message : '') }); return true; }
        let fee = 0, nIt = 0;
        for (const it of (d.order_items || [])) { const q = Number(it.quantity || 1); const sf = Number(it.sale_fee || 0); if (isFinite(sf)) { fee += sf * q; nIt++; } }
        fee = Math.round(fee * 100) / 100;
        cacheF[orderId] = { fee, itens: nIt, ts: Date.now() };
        writeJson(FEE_FILE, cacheF);
        json(res, 200, { ok: true, fee, itens: nIt, fonte: 'ml' });
      } catch (e) { json(res, 200, { ok: false, erro: 'ML indisponível: ' + String(e.message || e).slice(0, 120) }); }
      return true;
    }

    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /good-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso
    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/ml-sync-fees') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessA = validarSessao(req.headers['cookie']);
      const autorizado = (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessA && ehAdmin(sessA));
      if (!autorizado) { json(res, 404, { error: 'not found' }); return true; }
      const soStatus = (urlObj.searchParams && urlObj.searchParams.get('status')) === '1';
      if (_mls.rodando || soStatus) { json(res, 200, { ok: true, rodando: !!_mls.rodando, progresso: _mls.feitos + '/' + _mls.total, ok_ate_agora: _mls.ok, falhas: _mls.falhas, ultimo_inicio: _mls.iniciado_em, erros: _mls.erros || {}, amostras: _mls.amostras || [] }); return true; }
      const dias = Number(urlObj.searchParams.get('dias') || 14);
      mlSyncFees(dias).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, dias, mensagem: 'pesca ML rodando em background — chame de novo p/ ver o progresso' });
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X da cobertura por mês — onde estão os buracos de valor/UF
    if (method === 'GET' && p === '/good-checkout-offline/debug-cobertura') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessX = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessX && ehAdmin(sessX)))) { json(res, 404, { error: 'not found' }); return true; }
      const confX = readJson(CONFERIDOS_FILE, {});
      const porMes = {}; const exemplos = [];
      for (const [cid, c] of Object.entries(confX)) {
        if (!c || !c.conferido_em) continue;
        const mes = new Date(c.conferido_em).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
        if (!porMes[mes]) porMes[mes] = { pedidos: 0, sem_uf: 0, sem_vprod_nf: 0, unidades: 0, unid_sem_valor: 0 };
        const g = porMes[mes]; g.pedidos++;
        if (c.uf == null) g.sem_uf++;
        if (c.vprod_nf == null) g.sem_vprod_nf++;
        let semV = 0;
        for (const it of (c.itens || [])) { const q = Number(it.qtd || 1); g.unidades += q; if (it.valor_total == null) { g.unid_sem_valor += q; semV += q; } }
        if (semV && exemplos.length < 8) exemplos.push({ id: cid, mes, numero: c.numero, skus: (c.itens || []).filter(i => i.valor_total == null).map(i => i.sku) });
      }
      json(res, 200, { ok: true, por_mes: porMes, exemplos_itens_sem_valor: exemplos });
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X DO PEDIDO CRU do Bling — mostra TODAS as chaves e qualquer campo
    // com cara de data/hora, pra decidirmos com o payload real se o Bling guarda a hora da venda.
    // Uso: /good-checkout-offline/debug-pedido?id=116063  (o nº que aparece na coluna Pedido)
    if (method === 'GET' && p === '/good-checkout-offline/debug-pedido') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessP = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessP && ehAdmin(sessP)))) { json(res, 404, { error: 'not found' }); return true; }
      const idQ = String(urlObj.searchParams.get('id') || '').trim();
      if (!idQ) { json(res, 200, { ok: false, erro: 'passe ?id=NUMERO (nº do pedido) ou ?id=ID_BLING' }); return true; }
      // aceita nº do pedido (procura no conferidos) ou id do Bling direto
      const idClean = idQ.replace(/\D/g, '');   // aceita nº do pedido, nº da venda no marketplace ou id do Bling (limpa sufixos tipo _ML)
      let alvoId = idClean || idQ;
      const confP = readJson(CONFERIDOS_FILE, {});
      for (const [cid, c] of Object.entries(confP)) {
        if (!c) continue;
        if (String(c.numero) === idClean || (c.numero_loja && String(c.numero_loja) === idClean)) { alvoId = cid; break; }
      }
      try {
        const det = await detalhePedido(alvoId);
        if (!det) { json(res, 200, { ok: false, erro: 'pedido não encontrado no Bling (id ' + alvoId + ')' }); return true; }
        const comHora = {};
        const varre = (obj, pref) => {
          for (const [k2, v2] of Object.entries(obj || {})) {
            const cam = pref ? pref + '.' + k2 : k2;
            if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) { varre(v2, cam); continue; }
            const sv = String(v2 == null ? '' : v2);
            if (/data|hora|date|time/i.test(k2) || /\d{4}-\d{2}-\d{2}/.test(sv) || /\d{2}:\d{2}/.test(sv)) comHora[cam] = v2;
          }
        };
        varre(det, '');
        json(res, 200, { ok: true, id_bling: alvoId, numero: det.numero,
          chaves_do_pedido: Object.keys(det),
          todos_os_campos_com_data_ou_hora: comHora,
          veredito_hora: (Object.values(comHora).some(v => /\d{2}:\d{2}/.test(String(v))) ? 'TEM campo com HORA — cola aqui que eu implemento' : 'só DATAS (sem hora) — o Bling não guarda a hora da venda'),
          taxas: det.taxas || null,                       // 💎 se vier taxaComissao/custoFrete: tarifa+frete de TODOS os canais sem app!
          intermediador: det.intermediador || null,
          totais: { totalProdutos: det.totalProdutos, total: det.total, desconto: det.desconto, outrasDespesas: det.outrasDespesas },
          itens_do_bling: (det.itens || []).map(i => ({ codigo: i.codigo || null, codigo_produto: (i.produto && i.produto.codigo) || null, descricao: String(i.descricao || '').slice(0, 60), qtd: i.quantidade, valor: i.valor })),
          itens_do_conferido: ((confP[alvoId] && confP[alvoId].itens) || []).map(i => ({ sku: i.sku, qtd: i.qtd, valor_total: i.valor_total })),
          conferido_campos: (function(){ const c = confP[alvoId] || {}; return { tarifa_ml: c.tarifa_ml != null ? c.tarifa_ml : null, frete_ml: c.frete_ml != null ? c.frete_ml : null, venda_em: c.venda_em || null, taxa_mkt: c.taxa_mkt != null ? c.taxa_mkt : null, frete_mkt: c.frete_mkt != null ? c.frete_mkt : null, vprod_nf: c.vprod_nf != null ? c.vprod_nf : null, numero_loja: c.numero_loja || null, marketplace: c.marketplace || null }; })() });
      } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    // ADMIN (?k= obrigatorio — trava central intercepta rotas 'debug'): RAIO-X DO PRODUTO no Bling.
    // Mostra TODAS as chaves do produto + campos de preco/custo + o que /estoques/saldos e /produtos/fornecedores devolvem.
    // Uso: /good-checkout-offline/debug-sku?sku=KP16&k=SUA_CHAVE
    if (method === 'GET' && p === '/good-checkout-offline/debug-sku') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessP = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessP && ehAdmin(sessP)))) { json(res, 404, { error: 'not found' }); return true; }
      const skuQ = String(urlObj.searchParams.get('sku') || '').trim();
      if (!skuQ) { json(res, 200, { ok: false, erro: 'passe ?sku=CODIGO' }); return true; }
      try {
        const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(skuQ) + '&criterio=5');
        const p0 = rb && rb.ok && rb.data && rb.data.data && rb.data.data[0];   // envelope do blingGet: {ok, data:{data:[...]}}
        if (!p0) { json(res, 200, { ok: false, erro: 'produto nao encontrado por codigo ' + skuQ }); return true; }
        const rd = await blingGet('/produtos/' + p0.id);
        const det = (rd && rd.ok && rd.data && rd.data.data) || {};
        const precos = {};
        const cata = (obj, pref) => { for (const [k2, v2] of Object.entries(obj || {})) { const cam = pref ? pref + '.' + k2 : k2; if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) { cata(v2, cam); continue; } if (/pre[cç]o|custo|cost|price/i.test(k2)) precos[cam] = v2; } };
        cata(det, '');
        let saldos = null, fornecedores = null;
        try { const rs = await blingGet('/estoques/saldos?idsProdutos[]=' + p0.id); saldos = (rs && rs.data && rs.data.data) || (rs && rs.data) || rs; } catch (e) { saldos = { erro: String(e.message || e).slice(0, 120) }; }
        try { const rf = await blingGet('/produtos/fornecedores?idProduto=' + p0.id); fornecedores = (rf && rf.data && rf.data.data) || (rf && rf.data) || rf; } catch (e) { fornecedores = { erro: String(e.message || e).slice(0, 120) }; }
        json(res, 200, { ok: true, sku: skuQ, id_produto: p0.id,
          chaves_do_produto: Object.keys(det),
          todos_os_campos_de_preco_ou_custo: precos,
          saldo_estoques: saldos,
          endpoint_fornecedores: fornecedores,
          veredito: (precos.precoCusto != null && Number(precos.precoCusto) > 0) ? 'precoCusto EXISTE no produto — vou ler daqui' : 'sem precoCusto no detalhe — olhar os outros campos acima' });
      } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.
    if (method === 'GET' && p === '/good-checkout-offline/custo-sync') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: !!_cst.rodando, progresso: _cst.feitos + '/' + _cst.total, ok_ate_agora: _cst.ok, falhas: _cst.falhas, inicio: _cst.inicio }); return true; }
      const skuProbe = urlObj.searchParams.get('sku');
      if (skuProbe) { const ccP = readJson(path.join(CACHE_DIR, '_custos.json'), {}); json(res, 200, { ok: true, sku: skuProbe, no_cache_permanente: ccP[skuProbe] || null, total_no_cache: Object.keys(ccP).length }); return true; }
      if (_cst.rodando) { json(res, 200, { ok: true, ja_rodando: true, progresso: _cst.feitos + '/' + _cst.total }); return true; }
      custoSync(!!urlObj.searchParams.get('fresh')).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, mensagem: 'custo-sync rodando em background (tartaruga anti-429) — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, '/good-checkout-offline/custo-sync', '', k) });
      return true;
    }

    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/run') {
      const forcar = /[?&]force=1\b/.test(urlObj.search || '');
      rodarCiclo(forcar ? 'manual-force' : 'manual', forcar);
      json(res, 200, { mensagem: `Ciclo${forcar ? ' (FORCE — re-cacheia tudo)' : ''} iniciado. Veja /good-checkout-offline/status.`, versao: VERSAO });
      return true;
    }

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou
    if (method === 'POST' && p === '/good-checkout-offline/salvar-localizacao') {
      let body = {};
      try { body = await readBody(req); } catch (e) {}
      const sku = String(body.sku || '').trim();
      const localizacao = String(body.localizacao == null ? '' : body.localizacao).trim();
      const op = String(body.op || '').trim();
      if (!sku || sku === '(sem SKU)') { json(res, 200, { ok: false, erro: 'SKU inválido' }); return true; }
      const busca = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = busca.ok && busca.data && busca.data.data && busca.data.data[0];
      if (!item || !item.id) { json(res, 200, { ok: false, erro: 'produto não encontrado p/ SKU ' + sku }); return true; }
      const patch = await blingWrite('PATCH', `/produtos/${item.id}`, { estoque: { localizacao } });
      if (!patch.ok) { json(res, 200, { ok: false, erro: (patch.data && patch.data.error && (patch.data.error.description || patch.data.error.type)) || ('erro Bling ' + patch.status) }); return true; }
      const locC = locCache();
      const locAntiga = locC[sku] || localizacaoDeProduto(item) || '';
      locC[sku] = localizacao; salvarLoc(locC);
      const log = readJson(LOC_LOG_FILE, []);
      log.push({ op: op || '?', sku, de: locAntiga, para: localizacao, em: new Date().toISOString() });
      if (log.length > 3000) log.splice(0, log.length - 3000);    // mantém os últimos 3000
      writeJson(LOC_LOG_FILE, log);
      console.log(`[GOODBKP] localização ${sku}: "${locAntiga}" → "${localizacao}" por ${op || '?'}`);
      json(res, 200, { ok: true, sku, localizacao, de: locAntiga });
      return true;
    }

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log
    if (method === 'GET' && p === '/good-checkout-offline/localizacoes-log') {
      const log = readJson(LOC_LOG_FILE, []);
      json(res, 200, { ok: true, total: log.length, log: log.slice(-500).reverse() });
      return true;
    }

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)
    if (method === 'GET' && p === '/good-checkout-offline/buscar-produto') {
      const q = String(urlObj.searchParams.get('q') || '').trim();
      if (!q) { json(res, 200, { ok: false, erro: 'busca vazia' }); return true; }
      const dig = q.replace(/\D/g, '');
      const pareceEan = dig.length >= 8 && dig.length <= 14 && /^\d+$/.test(q.replace(/\s/g, ''));
      let prod = null;
      const porSku = async (codigo) => {
        const base = String(codigo || '').trim();
        const variantes = [...new Set([base, base.toUpperCase(), base.toLowerCase()])];
        for (const v of variantes) {                           // ?codigo= do Bling é case-sensitive → tenta as 3 caixas
          const r = await blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (it && it.id) return await produtoDetalhe(it.id);
        }
        return null;
      };
      if (!pareceEan) prod = await porSku(q);                 // SKU é o caminho 100%
      if (!prod && dig.length >= 8) {                          // EAN: cache reverso → API do Bling
        const se = skuEanCache();
        let achou = null;
        for (const sku of Object.keys(se)) { if (String(se[sku]).replace(/\D/g, '') === dig) { achou = sku; break; } }
        if (achou) prod = await porSku(achou);
        if (!prod) {                                           // índice de EAN (cresce sozinho / indexação total) — rápido e confiável
          const hit = lerIndiceEan()[dig];
          if (hit && hit.id) prod = await produtoDetalhe(hit.id);
        }
        if (!prod) {                                           // último recurso: filtro do Bling (lento, pouco confiável)
          for (const campo of ['gtin', 'gtinTributario', 'ean', 'codigoBarras']) {
            const r = await blingGet(`/produtos?${campo}=${encodeURIComponent(q)}&limite=5`);
            const itens = (r.ok && r.data && r.data.data) || [];
            for (const it of itens) {
              if (!it.id) continue;
              const det = await produtoDetalhe(it.id);
              if (det && getPossiveisGtins(det).some(e => String(e).replace(/\D/g, '') === dig)) { prod = det; break; }
            }
            if (prod) break;
          }
        }
      }
      if (!prod && pareceEan) prod = await porSku(q);          // às vezes o código É o número digitado
      if (!prod) { json(res, 200, { ok: false, erro: 'nada encontrado p/ "' + q + '"' }); return true; }
      salvarNoIndiceEan(prod);                                 // alimenta o índice — toda resolução entra no cache
      const est = prod.estoque || {};
      let localizacao = localizacaoDeProduto(prod);            // 1º: Bling (fonte da verdade)
      if (!localizacao) {                                      // 2º: cache local (localização editada pelo painel)
        const lc = locCache(); const sk = prod.codigo || '';
        localizacao = lc[sk] || lc[sk.toUpperCase()] || lc[sk.toLowerCase()] || '';
      }
      json(res, 200, { ok: true, produto: {
        sku: prod.codigo || '',
        nome: prod.nome || '',
        ean: getPossiveisGtins(prod)[0] || '',
        estoque: (est.saldoVirtualTotal != null ? est.saldoVirtualTotal : (est.saldoVirtual != null ? est.saldoVirtual : null)),
        localizacao: localizacao,
        img: primeiraImagem(prod)
      } });
      return true;
    }

    // ─── debug: onde o Bling guarda a localização de um SKU ───
    if (method === 'GET' && p === '/good-checkout-offline/debug-produto') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const q = String(urlObj.searchParams.get('q') || '').trim();
      let prod = null;
      for (const v of [...new Set([q, q.toUpperCase(), q.toLowerCase()])]) {
        const r = await blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
        const it = r.ok && r.data && r.data.data && r.data.data[0];
        if (it && it.id) { prod = await produtoDetalhe(it.id); break; }
      }
      json(res, 200, {
        ok: !!prod,
        sku: prod && prod.codigo,
        estoque: prod && prod.estoque,                 // <- onde deve estar localizacao
        localizacaoRoot: prod && prod.localizacao,     // <- ou aqui
        cacheLocal: locCache()[q] || locCache()[String(q).toUpperCase()] || null
      });
      return true;
    }

    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───
    if (method === 'GET' && p === '/good-checkout-offline/indexar-catalogo') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin pode indexar' }); return true; }
      if (getIdxStatus().rodando) { json(res, 200, { ok: true, started: false, jaRodando: true, status: getIdxStatus() }); return true; }
      indexarCatalogoCompleto();                       // dispara em background (não aguarda)
      json(res, 200, { ok: true, started: true });
      return true;
    }
    if (method === 'GET' && p === '/good-checkout-offline/indexar-status') {
      json(res, 200, { ok: true, status: getIdxStatus() });
      return true;
    }

    // ─── QZ Tray: assinatura (mata o popup "Untrusted") ───
    // serve o certificado público p/ o QZ confiar
    if (method === 'GET' && p === '/good-checkout-offline/qz-cert') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(QZ_CERT || '');
      return true;
    }
    // assina a requisição do QZ com a chave privada (RSA-SHA512)
    if (method === 'GET' && p === '/good-checkout-offline/qz-sign') {
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
    if (method === 'GET' && p === '/good-checkout-offline/painel') {
      try {
        const htmlContent = fs.readFileSync(path.join(__dirname, 'painel.html'), 'utf8');
        html(res, 200, htmlContent);
      } catch (e) { json(res, 500, { erro: 'painel.html: ' + e.message }); }
      return true;
    }

    // lista os pedidos PRONTOS (com etiqueta) + estado de conferido
    if (method === 'GET' && p === '/good-checkout-offline/lista') {
      const man = manifest();
      const conf = readJson(CONFERIDOS_FILE, {});
      const rsv = lerReservas();
      const ids = Object.keys(man);
      // backfill cliente + nº NF p/ busca (lê snapshot só de quem ainda não tem; persiste 1x)
      let mexeu = false;
      for (const i of ids) {
        const m = man[i];
        if (m && (m.cliente === undefined || m.nf_numero === undefined || m.nf_emissao === undefined || m.nf_id === undefined)) {
          const snap = readJson(path.join(CACHE_DIR, String(i), 'pedido.json'), null);
          if (snap) { m.cliente = snap.cliente || ''; m.nf_numero = (snap.nf && snap.nf.numero) || null; m.nf_emissao = (snap.nf && snap.nf.dataEmissao) || null; m.nf_id = (snap.nf && snap.nf.id) || null; m.visto_em = snap.visto_em || snap.cacheado_em || null; m.numero_loja = m.numero_loja || snap.numero_loja || null; }
          else { m.cliente = m.cliente || ''; m.nf_numero = m.nf_numero || null; m.nf_emissao = m.nf_emissao || null; m.nf_id = m.nf_id || null; }
          mexeu = true;
        }
      }
      if (mexeu) salvarManifest(man);
      const prontos = ids
        .filter(i => man[i].tem_etiqueta && !conf[i])                          // SÓ ATENDIDO ainda NÃO finalizado
        .map(i => ({ id: i, ...man[i], reservado_por: (rsv[i] && rsv[i].user) || null, reservado_em: (rsv[i] && rsv[i].em) || null }))
        .sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));        // mais ANTIGOS (menor nº) em cima
      const semEtiq = ids
        .filter(i => !man[i].tem_etiqueta && !conf[i])                         // ATENDIDO mas SEM etiqueta = problema
        .map(i => ({ id: i, numero: man[i].numero, cliente: man[i].cliente || '', nf_numero: man[i].nf_numero || null, marketplace: man[i].marketplace || 'outro', numero_loja: man[i].numero_loja || null, nf_emissao: man[i].nf_emissao || null, visto_em: man[i].visto_em || null, nf_id: man[i].nf_id || null }))   // numero_loja p/ o ↗ do canal; nf_emissao/visto_em p/ a data-hora no card sem etiqueta
        .sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));
      const hoje = new Date().toISOString().slice(0, 10);
      const finalizadosHoje = Object.values(conf).filter(c => c && String(c.conferido_em || '').slice(0, 10) === hoje).length;
      json(res, 200, {
        versao: VERSAO,
        ciclo_rodou_em: (getUltimoResumo() || {}).rodouEm || null,   // p/ o painel mostrar há quanto tempo o Bling foi consultado
        prontos: prontos.length,
        sem_etiqueta: semEtiq.length,
        sem_etiqueta_pedidos: semEtiq,
        finalizados_hoje: finalizadosHoje,
        pedidos: prontos
      });
      return true;
    }

    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos
    if (method === 'GET' && p === '/good-checkout-offline/separacao') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacao(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }
    if (method === 'GET' && p === '/good-checkout-offline/separacao-por-pedido') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacaoPorPedido(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }

    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    if (method === 'GET' && p === '/good-checkout-offline/historico') {
      const conf = readJson(CONFERIDOS_FILE, {});
      const itens = Object.keys(conf).map(id => ({ id, ...conf[id] }))
        .sort((a, b) => String(b.conferido_em || '').localeCompare(String(a.conferido_em || '')));
      const reenvios = readJson(CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json'), {});
      const reenvioDireto = String(process.env.CHECKOUT_REENVIO_DIRETO_EMPRESAS || '').toLowerCase().split(',').map(s => s.trim()).includes('good');
      json(res, 200, { ok: true, total: Object.keys(conf).length, itens, reenvios, reenvio_direto: reenvioDireto });
      return true;
    }

    // DEBUG — mostra onde o Bling guarda a localização de um SKU (confirma o campo)
    // uso: /good-checkout-offline/debug-loc/{SKU}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-loc/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const sku = decodeURIComponent(p.split('/').pop() || '');
      const { ok, data } = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = ok && data && data.data && data.data[0];
      let det = null;
      if (item && item.id) det = await produtoDetalhe(item.id);
      json(res, 200, {
        sku,
        da_lista: { estoque: (item && item.estoque) || null, localizacao_raiz: (item && item.localizacao) || null },
        do_detalhe: { estoque: (det && det.estoque) || null, localizacao_raiz: (det && det.localizacao) || null },
        extraido: localizacaoDeProduto(det || item)
      });
      return true;
    }

    // detalhe do pedido cacheado (itens + EAN + NF)
    if (method === 'GET' && p.startsWith('/good-checkout-offline/pedido/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      if (!ped) { json(res, 404, { erro: 'pedido não cacheado' }); return true; }
      const conf = readJson(CONFERIDOS_FILE, {});
      ped.conferido = conf[id] || null;
      // localização FRESCA: sobrescreve o loc congelado no snapshot pelo cache de localização ATUAL.
      // assim, um produto recém-localizado em OUTRO pedido não volta a pedir localização aqui.
      try {
        const lc = locCache();
        const fresco = (sku, atual) => {
          const s = String(sku || '').trim();
          if (s) {
            if (lc[s] != null) return lc[s];
            if (lc[s.toUpperCase()] != null) return lc[s.toUpperCase()];
            if (lc[s.toLowerCase()] != null) return lc[s.toLowerCase()];
          }
          return atual || '';
        };
        (ped.itens || []).forEach(it => {
          it.loc = fresco(it.sku, it.loc);
          (it.componentes || []).forEach(c => { c.loc = fresco(c.sku, c.loc); });
        });
      } catch (e) {}
      json(res, 200, ped);
      return true;
    }

    // estoque AO VIVO dos itens de um pedido (saldoVirtualTotal do Bling).
    // como a NF já baixou o estoque ANTES do pedido chegar no checkout, esse saldo JÁ está
    // descontado dos pedidos na fila → é o estoque real restante (não desconta de novo).
    // separado da abertura do pedido (a tela chama async) → não trava o checkout offline.
    // Bling fora do ar = saldos nulos → a tela mostra "—".
    if (method === 'GET' && p.startsWith('/good-checkout-offline/estoque-pedido/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      if (!ped) { json(res, 404, { ok: false, erro: 'pedido não cacheado' }); return true; }
      const skus = new Set();
      (ped.itens || []).forEach(it => {
        if (it.sku) skus.add(String(it.sku).trim());
        (it.componentes || []).forEach(c => { if (c.sku) skus.add(String(c.sku).trim()); });
      });
      // EM CHECKOUT: quanto de cada SKU está comprometido na fila agora — reusa a agregação da separação
      // (soma por SKU em todos os pedidos prontos, kits explodidos). É INFO, NÃO desconta do saldo Bling:
      // o saldoVirtual já vem descontado da NF, então subtrair de novo seria conta errada.
      const checkout = {};
      try {
        const sep = montarSeparacao();
        const mapaSep = {};
        (sep.linhas || []).forEach(l => { mapaSep[String(l.sku || '').trim()] = l.qtd; });
        for (const sku of skus) { checkout[sku] = mapaSep[sku] || 0; }
      } catch (e) {}
      const porSku = async (codigo) => {                       // estoque AO VIVO — NÃO usa produtoDetalhe (tem cache do ciclo)
        const base0 = String(codigo || '').trim();
        if (!base0) return null;
        const variantes = [...new Set([base0, base0.toUpperCase(), base0.toLowerCase()])];
        for (const v of variantes) {
          const r = await blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (it && it.id) {
            // se a busca já trouxe o saldo, usa (1 call); senão, pega o detalhe AO VIVO (sem cache) → saldo sempre fresco
            if (it.estoque && (it.estoque.saldoVirtualTotal != null || it.estoque.saldoVirtual != null)) return it;
            const d = await blingGet(`/produtos/${it.id}`);
            return (d.ok && d.data && d.data.data) ? d.data.data : null;
          }
        }
        return null;
      };
      const saldos = {};
      for (const sku of skus) {
        if (!sku) continue;
        try {
          const prod = await porSku(sku);
          const est = (prod && prod.estoque) || {};
          saldos[sku] = (est.saldoVirtualTotal != null ? est.saldoVirtualTotal : (est.saldoVirtual != null ? est.saldoVirtual : null));
        } catch (e) { saldos[sku] = null; }
      }
      json(res, 200, { ok: true, saldos: saldos, checkout: checkout });
      return true;
    }

    // serve o ZPL cacheado (texto puro) p/ o QZ Tray imprimir
    if (method === 'GET' && p.startsWith('/good-checkout-offline/etiqueta/')) {
      const id = p.split('/').filter(Boolean).pop();
      try {
        const zpl = fs.readFileSync(path.join(CACHE_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(zpl);
      } catch (e) { json(res, 404, { erro: 'etiqueta não cacheada' }); }
      return true;
    }

    // serve o DANFE (PDF) — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith('/good-checkout-offline/danfe/')) {
      const id = p.split('/').filter(Boolean).pop();
      const dir = path.join(CACHE_DIR, String(id));
      let pdf = null;
      try { pdf = fs.readFileSync(path.join(dir, 'danfe.pdf')); } catch (e) {}
      if (!pdf) { // não cacheado → gera agora (precisa do Bling online)
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        // porte (Codex): num anexo SÓ DE XML não existe danfe.pdf de propósito — e o
        // `snap.nf.id` continua sendo o da nota VELHA. Sem esta guarda, abrir ou imprimir
        // o pedido baixava a nota CANCELADA do Bling e ainda a gravava no cache.
        const nfId = (snap && snap.nf_anexada) ? null : (snap && snap.nf && snap.nf.id);
        if (nfId) { pdf = await baixarDanfe(nfId); if (pdf) { try { ensureDir(dir); fs.writeFileSync(path.join(dir, 'danfe.pdf'), pdf); } catch (e) {} } }
      }
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe.pdf"' }); res.end(pdf); }
      else json(res, 404, { erro: 'DANFE indisponível (sem cache e Bling não respondeu)' });
      return true;
    }

    // serve a ETIQUETA em PDF — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith('/good-checkout-offline/etiqueta-pdf/')) {
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

    // IMPRESSÃO A4: etiqueta + NF (DANFE) MESCLADAS num PDF só — evita o navegador bloquear a 2ª aba
    if (method === 'GET' && p.startsWith('/good-checkout-offline/imprimir/')) {
      const id = p.split('/').filter(Boolean).pop();
      const dir = path.join(CACHE_DIR, String(id));
      // etiqueta em PDF (ML cacheada; não-ML via Labelary on-demand)
      let etqBuf = null;
      try { etqBuf = fs.readFileSync(path.join(dir, 'etiqueta.pdf')); } catch (e) {}
      if (!etqBuf) { etqBuf = await etiquetaPdf(id, dir); if (etqBuf) { try { ensureDir(dir); fs.writeFileSync(path.join(dir, 'etiqueta.pdf'), etqBuf); } catch (e) {} } }
      // NF (DANFE) em PDF (cacheada ou baixa do Bling)
      let nfBuf = null;
      try { nfBuf = fs.readFileSync(path.join(dir, 'danfe.pdf')); } catch (e) {}
      if (!nfBuf) {
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        // 10/08 (Codex, PR#5): a impressão A4 tinha o MESMO fallback sem guarda que o
        // /danfe — com NF anexada e sem PDF em cache, baixava a nota VELHA do Bling.
        if (snap && !snap.nf_anexada && snap.nf && snap.nf.id) { nfBuf = await baixarDanfe(snap.nf.id); if (nfBuf) { try { fs.writeFileSync(path.join(dir, 'danfe.pdf'), nfBuf); } catch (e) {} } }
      }
      const partes = [etqBuf, nfBuf].filter(Boolean);
      if (!partes.length) { json(res, 404, { erro: 'sem etiqueta nem NF' }); return true; }
      try {
        const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
        const out = await PDFDocument.create();
        // MADEIRA multi-volume: o PDF da etiqueta tem N páginas (1 por caixa). Intercala
        // [etiqueta i][DANFE carimbada "VOLUME i/N"] p/ cada caixa sair autossuficiente e numerada.
        const _snapImp = readJson(path.join(dir, 'pedido.json'), null);
        const _ehMadeira = !!(_snapImp && (_snapImp.etiqueta_mm || _snapImp.marketplace === 'madeira'));
        let _etqDoc = null, _nVol = 1;
        if (etqBuf) { try { _etqDoc = await PDFDocument.load(etqBuf); _nVol = _etqDoc.getPageCount() || 1; } catch (e) {} }

        if (_ehMadeira && _etqDoc && nfBuf && _nVol > 1) {
          const fonte = await out.embedFont(StandardFonts.HelveticaBold);
          const danfeDoc = await PDFDocument.load(nfBuf);
          const danfeIdx = danfeDoc.getPageIndices();
          for (let i = 0; i < _nVol; i++) {
            try { const [pgEtq] = await out.copyPages(_etqDoc, [i]); out.addPage(pgEtq); } catch (e) {}  // etiqueta da caixa i
            try {
              const copias = await out.copyPages(danfeDoc, danfeIdx);                                    // cópia fresca da NF p/ esta caixa
              copias.forEach((pg, k) => {
                out.addPage(pg);
                if (k === 0) {                                                                           // carimba só a 1ª página da DANFE
                  const { width, height } = pg.getSize();
                  const txt = 'VOLUME ' + (i + 1) + '/' + _nVol;
                  const sz = 15, padX = 9, boxH = 23;
                  const tw = fonte.widthOfTextAtSize(txt, sz);
                  const bx = width - tw - padX * 2 - 12, by = height - boxH - 12;
                  pg.drawRectangle({ x: bx, y: by, width: tw + padX * 2, height: boxH, color: rgb(0.05, 0.05, 0.05) });
                  pg.drawText(txt, { x: bx + padX, y: by + 6, size: sz, font: fonte, color: rgb(1, 1, 1) });
                }
              });
            } catch (e) {}
          }
        } else {
          for (const buf of partes) {                                                                   // normal: [etiqueta(s)...][DANFE]
            try {
              const src = await PDFDocument.load(buf);
              const pgs = await out.copyPages(src, src.getPageIndices());
              pgs.forEach(pg => out.addPage(pg));
            } catch (e) { /* pula PDF inválido, segue com os outros */ }
          }
        }
        const merged = Buffer.from(await out.save());
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="etiqueta-nf.pdf"' });
        res.end(merged);
      } catch (e) { // pdf-lib indisponível → fallback: devolve só a etiqueta
        if (etqBuf) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(etqBuf); }
        else json(res, 500, { erro: 'merge falhou: ' + e.message });
      }
      return true;
    }

    // LOGIN: lista os NOMES dos operadores (sem senha) — o painel decide se mostra a tela de login
    if (method === 'GET' && p === '/good-checkout-offline/operadores') {
      const nomes = Object.keys(lerOperadores());
      json(res, 200, { operadores: nomes, login_ativo: nomes.length > 0, admins: lerAdmins() });
      return true;
    }

    // LOGIN: valida nome + senha contra a env GOODBKP_OPERADORES
    if (method === 'POST' && p === '/good-checkout-offline/login') {
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      const senha = String(body.senha || '').trim();
      const ops = lerOperadores();
      if (ops[nome] !== undefined && String(ops[nome]) === senha) {
        res.setHeader('Set-Cookie', SESS_COOKIE + '=' + assinarSessao(nome) + '; Path=/good-checkout-offline; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESS_TTL/1000));
        // LOGIN DISPARA O BLING: se a última consulta foi há mais de 3 min, roda em background — assim
        // ninguém abre a lista com etiqueta velha. Vários logins seguidos = 1 ciclo só (trava de intervalo).
        let _cicloDisparado = false;
        try {
          const _ur = getUltimoResumo() || {};
          const _idade = _ur.rodouEm ? (Date.now() - new Date(_ur.rodouEm).getTime()) : Infinity;
          if (_idade > 3 * 60 * 1000) {
            _cicloDisparado = true;
            console.log('[CICLO-LOGIN] ' + nome + ' entrou \u2014 \u00faltima consulta ao Bling h\u00e1 ' + (isFinite(_idade) ? Math.round(_idade / 60000) + ' min' : 'nunca') + ' \u2192 ciclo em background');
            rodarCiclo('login').catch(() => {});
          }
        } catch (e) {}
        json(res, 200, { ok: true, nome, ciclo_disparado: _cicloDisparado });
      } else {
        json(res, 200, { ok: false, erro: 'nome ou senha inválidos' });
      }
      return true;
    }

    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)
    if (method === 'POST' && p === '/good-checkout-offline/reservar') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const user = String(body.user || '').trim();
      if (!id) { json(res, 400, { erro: 'id obrigatório' }); return true; }
      const r = lerReservas();
      const dono = r[id] && r[id].user;
      if (dono && user && dono !== user && !body.forcar) {   // já tem OUTRO operador nesse pedido
        json(res, 200, { ok: false, reservado_por: dono, em: r[id].em });
        return true;
      }
      r[id] = { user, em: new Date().toISOString() };
      writeJson(RESERVAS_FILE, r);
      json(res, 200, { ok: true });
      return true;
    }

    // LIBERA a reserva (ao voltar pra lista / finalizar)
    if (method === 'POST' && p === '/good-checkout-offline/liberar') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const r = lerReservas();
      if (r[id]) { delete r[id]; writeJson(RESERVAS_FILE, r); }
      json(res, 200, { ok: true });
      return true;
    }

    // REABRIR um pedido finalizado por engano: tira da fila de conferidos → volta pra lista.
    // Aceita o bling_id OU o número visível. Se já tinha ido pra VERIFICADO, devolve pra ATENDIDO no Bling.
    if ((method === 'GET' || method === 'POST') && p.startsWith('/good-checkout-offline/reabrir/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op && method === 'POST') { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
      if (!ehAdmin(op)) { json(res, 200, { ok: false, erro: 'apenas o admin pode reabrir/reverter pedidos', precisa_admin: true }); return true; }
      const arg = decodeURIComponent(p.split('/').pop() || '');
      const conf = readJson(CONFERIDOS_FILE, {});
      const id = conf[arg] ? arg : (Object.keys(conf).find(k => String(conf[k] && conf[k].numero) === String(arg)) || null);
      if (!id) { json(res, 200, { ok: false, erro: 'pedido não está na fila de finalizados', arg }); return true; }
      const eraSync = !!(conf[id] && conf[id].sincronizado);
      delete conf[id];
      writeJson(CONFERIDOS_FILE, conf);
      let revertido = false;
      if (eraSync) { const mv = await moverSituacao(id, SIT_ATENDIDO); revertido = !!(mv && mv.ok); }   // VERIFICADO → volta pra ATENDIDO
      const rsv = lerReservas(); if (rsv[id]) { delete rsv[id]; writeJson(RESERVAS_FILE, rsv); }
      rodarCiclo('reabrir').catch(() => {});   // re-cacheia em background → reaparece na lista se estiver ATENDIDO
      console.log(`[GOODBKP] reaberto ${id} (era sync=${eraSync}, revertido p/ ATENDIDO=${revertido})`);
      json(res, 200, { ok: true, id, removido_da_fila: true, revertido_p_atendido: revertido });
      return true;
    }

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)
    if (method === 'POST' && p === '/good-checkout-offline/conferido') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) { json(res, 400, { erro: 'id obrigatório' }); return true; }
      const snapC = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      const conf = readJson(CONFERIDOS_FILE, {});
      if (conf[id]) {   // JÁ finalizado por alguém → não refaz, não reimprime, não re-sincroniza
        json(res, 200, { ok: false, ja_finalizado: true, por: conf[id].user || '', em: conf[id].conferido_em });
        return true;
      }
      conf[id] = {
        user: body.user || '',
        conferido_em: new Date().toISOString(),
        sincronizado: false,
        numero: snapC ? snapC.numero : (body.numero || null),
        cliente: snapC ? (snapC.cliente || '') : '',
        marketplace: snapC ? (snapC.marketplace || null) : null,
        flex: !!(snapC && snapC.flex),
        servico: snapC ? (snapC.servico || '') : '',
        nf_numero: (snapC && snapC.nf && snapC.nf.numero) || null,
        nf_emissao: (snapC && snapC.nf && snapC.nf.dataEmissao) || null,   // b10: hora da NF gravada na bipagem (pronto pro dia em que o dashboard chegar aqui)
        valor: (snapC && snapC.total != null) ? Number(snapC.total) : null,   // faturamento (total do pedido)
        uf: (snapC && snapC.uf) || null,
        vprod_nf: (function(){ try {   // Σ itens da NOTA (fonte fiscal) → produtos EXATO; frete = valor − vprod_nf
          const ds = readJson(path.join(CACHE_DIR, String(id), 'nf-simp.json'), null);
          if (ds && Array.isArray(ds.itens) && ds.itens.length) { const s2 = ds.itens.reduce((a,i)=>a+(Number(i.valorTotal)||0),0); return isFinite(s2)&&s2>0 ? Math.round(s2*100)/100 : null; }
        } catch (e) {} return null; })(),
        municipio: (snapC && snapC.municipio) || null,
        numero_loja: (snapC && snapC.numero_loja) || null,
        venda_dia: (snapC && snapC.venda_dia) || null,
        taxa_mkt: (snapC && snapC.taxa_mkt) || null,
        frete_mkt: (snapC && snapC.frete_mkt) || null,
        itens: snapC ? (snapC.itens || []).map(it => ({ sku: it.sku || '', descricao: String(it.descricao || '').slice(0, 90), qtd: it.qtd || 1, valor_unit: (it.valor_unit != null ? it.valor_unit : null), valor_total: (it.valor_total != null ? it.valor_total : null) })) : []
      };
      writeJson(CONFERIDOS_FILE, conf);            // grava na fila primeiro — nunca perde
      arquivarFinalizado(id);                       // arquiva etiqueta + meta p/ reimprimir/reenviar depois (Parte A)
      { const rsvF = lerReservas(); if (rsvF[id]) { delete rsvF[id]; writeJson(RESERVAS_FILE, rsvF); } }   // finalizou → solta a reserva

      // ESPELHO EM TEMPO REAL: se o sync tá ligado e o Bling responde, move p/ VERIFICADO já.
      // Se o Bling estiver fora, fica na fila e o cron sincroniza quando ele voltar.
      let sincronizado = false, blingOffline = false;
      if (SYNC_ON) {
        const r = await moverSituacao(id, SIT_VERIFICADO);
        if (r.ok) {
          conf[id].sincronizado = true;
          conf[id].sincronizado_em = new Date().toISOString();
          delete conf[id].sync_erro;
          sincronizado = true;
          console.log(`[GOODBKP] conferido ${id} → ${SIT_VERIFICADO} (espelho na hora) OK`);
        } else {
          conf[id].sync_erro = String(r.status || 'err');
          blingOffline = true;
          console.log(`[GOODBKP] conferido ${id} ficou na fila (bling ${r.status}) — sincroniza depois`);
        }
        writeJson(CONFERIDOS_FILE, conf);
      }
      json(res, 200, { ok: true, id, sincronizado, bling_offline: blingOffline });
      return true;
    }

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.
    if ((method === 'POST' || method === 'GET') && p === '/good-checkout-offline/sincronizar') {
      const r = await sincronizarConferidos();
      json(res, 200, { ok: true, ...r });
      return true;
    }

    // DEBUG — testa mover UM pedido p/ VERIFICADO (ou outro id via ?situacao=). Mostra resposta crua do Bling.
    // uso: /good-checkout-offline/debug-mover/{idDoPedido}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-mover/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').pop();
      const sit = Number(urlObj.searchParams.get('situacao') || SIT_VERIFICADO);
      const r = await moverSituacao(id, sit);
      json(res, 200, { pedido: id, situacao_destino: sit, resultado: r });
      return true;
    }

// ── DIAGNÓSTICO DE ETIQUETA (14/08) ────────────────────────────────────────────
    // Caso real: pedido da AMAZON (Bling 26599886380, NF 077663) ficou "sem etiqueta" no
    // checkout, mas a etiqueta EXISTE e o Diego conseguiu baixá-la pelo Bling. O ciclo já
    // trata Amazon (link ZPL vem nulo → tenta o PDF), e reprocessa todo pedido sem etiqueta
    // a cada rodada — então a suspeita é que a API `/logisticas/etiquetas` não devolve o
    // link, mesmo a tela do Bling imprimindo. Esta rota mostra a RESPOSTA CRUA da API nos
    // dois formatos, pra decidir com dado em vez de suposição. Só leitura.
    // Uso: GET /good-checkout-offline/etiqueta-diag?id=<idBling>&k=ADMIN_KEY
    if (method === 'GET' && p === '/good-checkout-offline/etiqueta-diag') {
      const kE = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sE = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kE === process.env.ADMIN_KEY) || (sE && ehAdmin(sE)))) { json(res, 404, { error: 'not found' }); return true; }
      const idE = String(urlObj.searchParams.get('id') || '').replace(/\D/g, '');
      if (!idE) { json(res, 400, { ok: false, erro: 'use ?id=<id do pedido no Bling>&k=ADMIN_KEY' }); return true; }
      const out = { ok: true, id_bling: idE, formatos: [], pedido: null, leia: 'link null nos dois formatos = o Bling NAO expoe essa etiqueta pela API (caso tipico de logistica do proprio marketplace). Link presente = falha nossa no download.' };
      for (const fmt of ['ZPL', 'PDF']) {
        try {
          const r = await blingGet('/logisticas/etiquetas?formato=' + fmt + '&idsVendas[]=' + idE);
          const item = r && r.ok && r.data && r.data.data && r.data.data[0];
          const linha = { formato: fmt, http_ok: !!(r && r.ok), tem_item: !!item, tem_link: !!(item && item.link) };
          if (item) { linha.campos = Object.keys(item).slice(0, 12); linha.link_comeca_com = String(item.link || '').slice(0, 60) || null; }
          // 14/08 — o Bling DEVOLVE link nos dois formatos (medido no pedido 26599886380 da
          // Amazon), então a etiqueta não chegar ao checkout é problema no DOWNLOAD, não na
          // API. Aqui o arquivo é realmente baixado pra ver o que vem: status, content-type,
          // tamanho e os primeiros bytes. `baixarEtiquetaPDF` só aceita arquivo começando em
          // %PDF — se a Amazon servir PNG/ZIP/outro, ele devolve null em silêncio.
          if (item && item.link) {
            try {
              const rf = await fetch(item.link);
              const buf = Buffer.from(await rf.arrayBuffer());
              linha.download = {
                http: rf.status,
                content_type: (rf.headers && rf.headers.get && rf.headers.get('content-type')) || null,
                bytes: buf.length,
                comeca_com: buf.slice(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
                hex: buf.slice(0, 8).toString('hex'),
                eh_pdf: buf.slice(0, 4).toString('latin1') === '%PDF',
                eh_zpl: buf.slice(0, 400).toString('latin1').indexOf('^XA') >= 0,
                eh_png: buf.slice(1, 4).toString('latin1') === 'PNG',
                eh_zip: buf.slice(0, 2).toString('latin1') === 'PK'
              };
            } catch (e) { linha.download = { erro: String(e.message || e).slice(0, 160) }; }
          }
          if (r && !r.ok) linha.erro = String((r.data && (r.data.error || r.data.message)) || ('HTTP ' + (r.status || '?'))).slice(0, 200);
          out.formatos.push(linha);
        } catch (e) { out.formatos.push({ formato: fmt, erro: String(e.message || e).slice(0, 160) }); }
        await new Promise(r0 => setTimeout(r0, 400));
      }
      // 14/08 — o Bling devolve o link e o arquivo é um ZIP (corrigido no #79), mas a IMPRESSÃO
      // lê `etiqueta.pdf` do cache do pedido: se o ciclo não passou por ele depois do conserto,
      // sai só a NF (foi o que aconteceu com o pedido 26599886380). Aqui mostro o que está no
      // cache e, com &salvar=1, gravo a etiqueta AGORA — sem esperar o próximo ciclo.
      try {
        const dirD = path.join(CACHE_DIR, String(idE));
        const temZpl = fs.existsSync(path.join(dirD, 'etiqueta.zpl'));
        const temPdf = fs.existsSync(path.join(dirD, 'etiqueta.pdf'));
        const snapD = readJson(path.join(dirD, 'pedido.json'), null);
        out.cache = { pasta_existe: fs.existsSync(dirD), etiqueta_zpl: temZpl, etiqueta_pdf: temPdf,
          danfe_pdf: fs.existsSync(path.join(dirD, 'danfe.pdf')),
          manifesto_tem_etiqueta: !!(snapD && snapD.tem_etiqueta) };
        if (urlObj.searchParams.get('salvar') === '1' && !temPdf && !temZpl) {
          const pdfBuf = await baixarEtiquetaPDF(idE);
          if (pdfBuf && pdfBuf.length) {
            ensureDir(dirD);
            fs.writeFileSync(path.join(dirD, 'etiqueta.pdf'), pdfBuf);
            if (snapD) { snapD.tem_etiqueta = true; writeJson(path.join(dirD, 'pedido.json'), snapD); }
            try {
              const man = readJson(MANIFEST_FILE, {});
              if (man[idE]) { man[idE].tem_etiqueta = true; salvarManifest(man); }
            } catch (e) {}
            out.cache.salvo_agora = true; out.cache.bytes = pdfBuf.length;
          } else { out.cache.salvo_agora = false; out.cache.motivo = 'baixarEtiquetaPDF devolveu vazio'; }
        }
      } catch (e) { out.cache = { erro: String(e.message || e).slice(0, 160) }; }
      // contexto do pedido: loja (define o marketplace no ciclo) e se há logística registrada
      try {
        const rp = await blingGet('/pedidos/vendas/' + idE);
        const det = (rp && rp.ok && rp.data && rp.data.data) || null;
        if (det) out.pedido = {
          numero: det.numero || null, loja_id: (det.loja && det.loja.id) || null,
          numero_loja: det.numeroPedidoLoja || det.numeroLoja || null,
          situacao: (det.situacao && det.situacao.id) || null,
          tem_transporte: !!det.transporte,
          transportador: (det.transporte && det.transporte.transportador && det.transporte.transportador.nome) || null,
          rastreio: (det.transporte && det.transporte.volumes && det.transporte.volumes[0] && det.transporte.volumes[0].codigoRastreamento) || null
        };
      } catch (e) { out.pedido = { erro: String(e.message || e).slice(0, 160) }; }
      json(res, 200, out);
      return true;
    }

        if (method === 'GET' && p === '/good-checkout-offline/status') {
      const man = manifest();
      const ids = Object.keys(man);
      const conf = readJson(CONFERIDOS_FILE, {});
      const confIds = Object.keys(conf);
      json(res, 200, {
        versao: VERSAO,
        resumo: getUltimoResumo(),
        cacheDir: CACHE_DIR,
        situacaoAtendido: SIT_ATENDIDO,
        situacaoVerificado: SIT_VERIFICADO,
        formato: ETIQ_FORMATO,
        total: ids.length,
        comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
        semEtiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
        sync: { ...getUltimoSync(), ligado: SYNC_ON, conferidos: confIds.length, pendentes: confIds.filter(i => !conf[i].sincronizado).length },
        pedidos: ids.map(i => ({ id: i, ...man[i] }))
      });
      return true;
    }

    // SAÚDE: para monitor externo (UptimeRobot). 200 = tudo OK · 503 = algo quebrou (dispara o alerta).
    if ((method === 'GET' || method === 'HEAD') && p === '/good-checkout-offline/saude') {
      const agora = Date.now();
      const conf = readJson(CONFERIDOS_FILE, {});
      const pendentes = Object.keys(conf).filter(i => conf[i] && !conf[i].sincronizado);
      const rodouEm = getUltimoResumo().rodouEm ? new Date(getUltimoResumo().rodouEm).getTime() : 0;
      const minDesdeCiclo = rodouEm ? Math.round((agora - rodouEm) / 60000) : null;
      const problemas = [], avisos = [];
      // 1) ciclo parado — só vale DENTRO da janela ativa do cron (evita alarme falso de madrugada)
      if (!rodouEm) avisos.push('ainda não rodou o 1º ciclo (boot recente?)');
      else if (cronDeveriaTerRodado() && minDesdeCiclo > 30) problemas.push('o ciclo não roda há ' + minDesdeCiclo + ' min no horário ativo (esperado ~10 min)');
      // 2) Bling inalcançável no último ciclo (auth ou conexão)
      if (getUltimoResumo().blingOk === false) problemas.push('o último ciclo NÃO conseguiu falar com o Bling (auth/conexão)');
      // 3) sync-back falhando
      if (SYNC_ON && getUltimoSync() && getUltimoSync().falhas > 0) problemas.push('o sync pro Bling falhou em ' + getUltimoSync().falhas + ' pedido(s) no último ciclo');
      // avisos (não derrubam o status, só informam)
      if (!SYNC_ON) avisos.push('GOODBKP_SYNC_ON desligado — finalizados não voltam pro Bling sozinhos');
      if (pendentes.length > 0) avisos.push(pendentes.length + ' finalizado(s) ainda não sincronizado(s)');
      const ok = problemas.length === 0;
      const code = ok ? 200 : 503;
      // UptimeRobot (plano grátis) checa via HEAD — responde só o status, sem corpo. GET segue com o JSON completo.
      if (method === 'HEAD') { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(); return true; }
      json(res, code, {
        ok,
        versao: VERSAO,
        em: new Date().toISOString(),
        ultimo_ciclo: getUltimoResumo().rodouEm,
        min_desde_ciclo: minDesdeCiclo,
        bling_ok: getUltimoResumo().blingOk !== false,
        pedidos_no_cache: Object.keys(manifest()).length,
        sync: { ligado: SYNC_ON, pendentes: pendentes.length, ...(getUltimoSync() || {}) },
        problemas,
        avisos
      });
      return true;
    }

    // BUSCAR PEDIDO por número (ou ID) em QUALQUER status — ao vivo no Bling.
    // Pra achar a NF de um pedido que não passou pelo Checkout Offline.
    if (method === 'GET' && p === '/good-checkout-offline/buscar-pedido') {
      const q = String(urlObj.searchParams.get('q') || '').trim();
      if (!q) { json(res, 400, { ok: false, erro: 'use ?q=NUMERO' }); return true; }
      let ids = [], via = null;
      // 1) tenta filtrar por número — e confiro no código (caso o Bling ignore o filtro, igual no /nfe)
      const r1 = await blingGet(`/pedidos/vendas?numero=${encodeURIComponent(q)}&limite=20`);
      if (r1.ok && r1.data && Array.isArray(r1.data.data)) {
        const match = r1.data.data.filter(p => String(p.numero) === String(q));
        if (match.length) { ids = match.map(p => p.id); via = 'numero'; }
      }
      // 2) fallback: trata q como ID interno do Bling
      if (!ids.length) {
        const r2 = await blingGet(`/pedidos/vendas/${encodeURIComponent(q)}`);
        if (r2.ok && r2.data && r2.data.data && String(r2.data.data.id) === String(q)) { ids = [r2.data.data.id]; via = 'id'; }
      }
      const pedidos = [];
      for (const id of ids.slice(0, 10)) {
        const det = await detalhePedido(id);
        if (!det) continue;
        const nf = await nfDoPedido(id);
        pedidos.push({
          id: det.id,
          numero: det.numero || null,
          data: det.data || null,
          situacao_id: (det.situacao && (det.situacao.id || det.situacao)) || null,
          cliente: (det.contato && det.contato.nome) || '',
          total: det.total || null,
          loja_id: (det.loja && det.loja.id) || null,
          itens: Array.isArray(det.itens) ? det.itens.map(it => ({ descricao: it.descricao || (it.produto && it.produto.nome) || '', sku: it.codigo || (it.produto && it.produto.codigo) || '', qtd: it.quantidade || 0 })) : [],
          nf: nf ? { id: nf.id, numero: nf.numero, chave: nf.chave } : null
        });
        await sleep(PAUSA_MS);
      }
      // também busca NOTAS FISCAIS por número (a NF tem numeração própria, diferente do pedido)
      const notas = [];
      const rnf = await blingGet(`/nfe?numero=${encodeURIComponent(q)}&limite=10`);
      if (rnf.ok && rnf.data && Array.isArray(rnf.data.data)) {
        for (const n of rnf.data.data.filter(x => String(x.numero) === String(q)).slice(0, 10)) {
          notas.push({
            id: n.id,
            numero: n.numero,
            chave: n.chaveAcesso || n.chave || null,
            cliente: (n.contato && n.contato.nome) || '',
            situacao_id: (n.situacao && (n.situacao.id || n.situacao)) || null,
            data: n.dataEmissao || n.data || null,
            valor: n.valorNota || n.valor || null
          });
        }
      }
      json(res, 200, { ok: pedidos.length > 0 || notas.length > 0, via, q, pedidos, notas });
      return true;
    }
    // baixa o DANFE (PDF) de QUALQUER pedido ao vivo (acha a NF na hora) — não precisa estar no cache
    if (method === 'GET' && p.startsWith('/good-checkout-offline/nf-danfe-live/')) {
      const id = p.split('/').filter(Boolean).pop();
      const nf = await nfDoPedido(id);
      const pdf = nf && nf.id ? await baixarDanfe(nf.id) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (pedido sem NF ou Bling não respondeu)', nf: nf || null });
      return true;
    }
    // baixa o DANFE (PDF) direto pelo ID da NOTA (pra resultados de busca por NF)
    if (method === 'GET' && p.startsWith('/good-checkout-offline/danfe-nf/')) {
      const nfId = p.split('/').filter(Boolean).pop();
      const pdf = await baixarDanfe(nfId);
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-nf-${nfId}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (NF sem PDF ou Bling não respondeu)' });
      return true;
    }
    // baixa o XML da NOTA pelo ID
    if (method === 'GET' && p.startsWith('/good-checkout-offline/xml-nf/')) {
      const nfId = p.split('/').filter(Boolean).pop();
      const det = await blingGet(`/nfe/${nfId}`);
      const nf = det.data && det.data.data;
      const xml = nf ? await baixarXmlNF(nf) : '';
      if (xml) { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="nf-${(nf && nf.numero) || nfId}.xml"` }); res.end(xml); }
      else json(res, 404, { ok: false, erro: 'XML indisponível' });
      return true;
    }
    // ARQUIVO: info de um pedido finalizado (existe arquivo? meta)
    // DIAGNÓSTICO de etiqueta — mostra o que o Bling devolve (PDF e ZPL) p/ um pedido + o que tá no cache
    // TESTE de conversão ZPL→PDF (Labelary) — compara o ZPL do cache vs o fresco do Bling
    if (method === 'GET' && p.startsWith('/good-checkout-offline/arq-info/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const etqPath = path.join(ARQUIVO_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
      json(res, 200, { id, arquivado: !!ped, tem_etiqueta: fs.existsSync(etqPath), numero: ped && ped.numero, cliente: ped && ped.cliente, nf: ped && ped.nf });
      return true;
    }
    // ARQUIVO: etiqueta arquivada → PDF (converte ZPL se preciso)
    if (method === 'GET' && p.startsWith('/good-checkout-offline/arq-etiqueta-pdf/')) {
      const id = p.split('/').filter(Boolean).pop();
      let pdf = null;
      try { pdf = await etiquetaPdf(id, path.join(ARQUIVO_DIR, String(id))); } catch (e) {}
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="etiqueta-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'etiqueta não disponível (pedido finalizado antes desse recurso, ou ML postado)' });
      return true;
    }
    // ARQUIVO: DANFE de um pedido arquivado → gera na hora pelo nf.id guardado
    if (method === 'GET' && p.startsWith('/good-checkout-offline/arq-danfe/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const nfId = ped && ped.nf && ped.nf.id;
      const pdf = nfId ? await baixarDanfe(nfId) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (sem nf.id arquivado ou Bling fora)' });
      return true;
    }
    // ENVIAR pro estoque: etiqueta + DANFE por email (Parte B)
    // ── REENVIO DE DOCS: o estoquista SINALIZA (etiqueta rasgou / NF com problema) e o ADMIN decide enviar ──
    // Futuro: env CHECKOUT_REENVIO_DIRETO_EMPRESAS ("girassol,good") → nas empresas listadas o pedido do
    // estoquista já dispara o e-mail direto, sem esperar o admin. Sem a env (padrão) = só sinaliza.
    if (method === 'POST' && p.startsWith('/good-checkout-offline/pedir-reenvio/')) {
      let op = '';
      try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {}
      if (!op) { json(res, 200, { ok: false, erro: 'identifique o operador (faça login no painel)' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const confR = readJson(CONFERIDOS_FILE, {});
      const c = confR[id] || {};
      const direto = String(process.env.CHECKOUT_REENVIO_DIRETO_EMPRESAS || '').toLowerCase().split(',').map(s => s.trim()).includes('good');
      if (direto) {
        const r = await enviarEmailDocs(id, op);
        if (r.ok && confR[id]) {   // flag visível no histórico: quem reenviou e quando
          confR[id].reenvios = (confR[id].reenvios || 0) + 1;
          confR[id].ultimo_reenvio = { por: op, em: new Date().toISOString() };
          writeJson(CONFERIDOS_FILE, confR);
        }
        console.log(`[GOODBKP] 📨 reenvio DIRETO pedido ${c.numero || id} por ${op} → ${r.ok ? 'enviado' : 'FALHA: ' + r.erro}`);
        json(res, 200, { ...r, direto: true });
        return true;
      }
      const REENVIOS_FILE = CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json');
      const ree = readJson(REENVIOS_FILE, {});
      ree[id] = { numero: c.numero || null, cliente: c.cliente || '', por: op, em: new Date().toISOString() };
      writeJson(REENVIOS_FILE, ree);
      console.log(`[GOODBKP] 📨 REENVIO SOLICITADO — pedido ${c.numero || id} por ${op} (admin envia pelo Histórico)`);
      json(res, 200, { ok: true, solicitado: true });
      return true;
    }
    // admin resolve a solicitação: {enviar:true} manda o e-mail e baixa; {enviar:false} só descarta
    if (method === 'POST' && p.startsWith('/good-checkout-offline/reenvio-resolver/')) {
      let op = '', enviar = false;
      try { const b = await readBody(req); op = String(b.op || ''); enviar = !!b.enviar; } catch (e) {}
      if (!ehAdmin(op)) { json(res, 200, { ok: false, erro: 'apenas o admin' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const REENVIOS_FILE = CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json');
      let r = { ok: true, enviado: false };
      if (enviar) { const e = await enviarEmailDocs(id, op); r = { ...e, enviado: !!e.ok }; if (!e.ok) { json(res, 200, r); return true; } }
      if (enviar) { const cE = readJson(CONFERIDOS_FILE, {}); if (cE[id]) { cE[id].reenvios = (cE[id].reenvios || 0) + 1; cE[id].ultimo_reenvio = { por: op, em: new Date().toISOString() }; writeJson(CONFERIDOS_FILE, cE); } }
      const ree = readJson(REENVIOS_FILE, {});
      delete ree[id]; writeJson(REENVIOS_FILE, ree);
      console.log(`[GOODBKP] 📨 reenvio ${id} ${enviar ? 'ENVIADO' : 'descartado'} por ${op}`);
      json(res, 200, r);
      return true;
    }
    if (method === 'POST' && p.startsWith('/good-checkout-offline/enviar-docs/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op) { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
      if (!ehAdmin(op)) { json(res, 200, { ok: false, erro: 'apenas o admin pode enviar documentos', precisa_admin: true }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const r = await enviarEmailDocs(id, op);
      if (r.ok) { const cD = readJson(CONFERIDOS_FILE, {}); if (cD[id]) { cD[id].reenvios = (cD[id].reenvios || 0) + 1; cD[id].ultimo_reenvio = { por: op, em: new Date().toISOString() }; writeJson(CONFERIDOS_FILE, cD); } }
      console.log(`[GOODBKP] enviar-docs ${id} (por ${op}) → ${r.ok ? 'OK (' + r.anexos + ' anexos)' : 'FALHA: ' + r.erro}`);
      json(res, 200, r);
      return true;
    }
    // DEBUG: por que a NF do pedido não veio? mostra a resposta crua do link pedido→nota + campos do pedido
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-nfped/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').filter(Boolean).pop();
      const out = { id };
      const r = await blingGet(`/pedidos/vendas/${id}/nfe`); await sleep(PAUSA_MS);
      out.endpoint_pedido_nfe = { ok: r.ok, status: r.status, data: r.data };
      const det = await detalhePedido(id);
      out.pedido_keys = det ? Object.keys(det) : null;
      out.pedido_situacao = det ? det.situacao : null;
      out.pedido_campos_nf = det ? { notaFiscal: det.notaFiscal, nfe: det.nfe, notasFiscais: det.notasFiscais, idNotaFiscal: det.idNotaFiscal } : null;
      json(res, 200, out);
      return true;
    }
    // DEBUG: mostra a resposta crua do Bling pra entender como buscar pedido (filtro funciona? 116856 é numero ou numeroLoja?)
    // DEBUG 2: testa buscar NF por número e contato por nome (pra saber quais buscas a API permite)

    // BACKUP: baixa um JSON com o estado que NÃO vem do Bling (fila + localizações + índice + log). Só admin.
    if (method === 'GET' && p === '/good-checkout-offline/backup') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin — use ?op=SEUNOME' }); return true; }
      const dump = {
        versao: VERSAO,
        gerado_em: new Date().toISOString(),
        conferidos: readJson(CONFERIDOS_FILE, {}),
        localizacoes: readJson(LOC_FILE, {}),
        indice_ean: readJson(EAN_INDEX_FILE, {}),
        localizacoes_log: readJson(LOC_LOG_FILE, [])
      };
      const nome = 'backup-good-offline-' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + nome + '"' });
      res.end(JSON.stringify(dump, null, 2));
      return true;
    }
    // RESTAURAR (página): cola o JSON do backup e restaura. Só admin (?op=SEUNOME).
    if (method === 'GET' && p === '/good-checkout-offline/restaurar') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { html(res, 200, '<meta charset=utf-8><p style="font-family:Arial;margin:40px">Acesso só pra admin. Use <b>?op=SEUNOME</b> no fim da URL.</p>'); return true; }
      const pg = '<!doctype html><meta charset=utf-8><title>Restaurar backup</title>' +
        '<style>body{font-family:Arial;max-width:720px;margin:40px auto;padding:0 16px;color:#111}textarea{width:100%;height:300px;font-family:monospace;font-size:12px;box-sizing:border-box}button{padding:10px 20px;font-size:15px;font-weight:700;background:#f59e0b;border:0;border-radius:8px;cursor:pointer;margin-top:12px}#r{margin-top:14px;font-weight:700}</style>' +
        '<h2>Restaurar backup — Checkout Offline</h2>' +
        '<p>Cola o conteúdo do arquivo de backup (JSON) e clica em Restaurar. <b style="color:#c00">Isso sobrescreve o estado atual.</b></p>' +
        '<textarea id=j placeholder="cola aqui o JSON do backup"></textarea>' +
        '<button onclick="rest()">Restaurar</button><div id=r></div>' +
        '<script>async function rest(){var el=document.getElementById("r");var o;try{o=JSON.parse(document.getElementById("j").value)}catch(e){el.textContent="JSON inválido: "+e.message;return}o.op=' + JSON.stringify(op) + ';try{var x=await fetch("/good-checkout-offline/restaurar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});x=await x.json();el.textContent=x.ok?("\\u2713 Restaurado: "+x.restaurados.join(", ")):("Falhou: "+(x.erro||"erro"))}catch(e){el.textContent="Erro: "+e.message}}<\/script>';
      html(res, 200, pg);
      return true;
    }
    // RESTAURAR (ação): grava de volta só o que veio no corpo. Só admin.
    if (method === 'POST' && p === '/good-checkout-offline/restaurar') {
      let body = {};
      try { body = await readBody(req); } catch (e) {}
      if (!ehAdmin(String(body.op || ''))) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin' }); return true; }
      const restaurados = [];
      if (body.conferidos && typeof body.conferidos === 'object') { writeJson(CONFERIDOS_FILE, body.conferidos); restaurados.push('fila finalizados (' + Object.keys(body.conferidos).length + ')'); }
      if (body.localizacoes && typeof body.localizacoes === 'object') { writeJson(LOC_FILE, body.localizacoes); restaurados.push('localizações (' + Object.keys(body.localizacoes).length + ')'); }
      if (body.indice_ean && typeof body.indice_ean === 'object') { writeJson(EAN_INDEX_FILE, body.indice_ean); restaurados.push('índice EAN (' + Object.keys(body.indice_ean).length + ')'); }
      if (Array.isArray(body.localizacoes_log)) { writeJson(LOC_LOG_FILE, body.localizacoes_log); restaurados.push('log (' + body.localizacoes_log.length + ')'); }
      json(res, 200, { ok: restaurados.length > 0, restaurados });
      return true;
    }

    // DEBUG: dumpa as respostas cruas do Bling p/ um pedido (diagnóstico NF/etiqueta)
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug/')) {
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
        out.servico = d ? servicoDoPedido(d) : null;       // o campo que o checkout usa pra decidir FLEX
        out.seria_flex = d ? ehFlex(servicoDoPedido(d)) : null;

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
              zpl_inicio: zpl ? zpl.slice(0, 200) : null,
              zpl_marcadores: zpl ? {                        // desempate coleta vs entrega direta
                retirada_pelo_comprador: /RETIRADA\s+PELO\s+COMPRADOR/i.test(zpl),
                coleta: /COLETA/i.test(zpl),
                entrega_direta: /ENTREGA\s+DIRETA/i.test(zpl),
                blocos_grafico_gfa: (zpl.match(/\^GFA/g) || []).length
              } : null
            };
          } catch (e) { out.etiqueta_download = { erro: e.message }; }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG: lista vendas ML recentes (loja 203146903) p/ achar uma pra testar etiqueta
    if (method === 'GET' && p === '/good-checkout-offline/debug-ml') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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

    // DEBUG: dumpa o produto CRU por SKU — vê formato + estrutura/componentes da composição
    // uso: /good-checkout-offline/debug-produto/{SKU}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-produto/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const sku = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const lista = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = lista.data && lista.data.data && lista.data.data[0];
      let raw = null, detStatus = null;
      if (item && item.id) { const r = await blingGet(`/produtos/${item.id}`); detStatus = r.status; raw = (r.data && r.data.data) || null; await sleep(PAUSA_MS); }
      json(res, 200, {
        sku,
        da_lista: item ? { id: item.id, formato: item.formato, idProdutoPai: item.idProdutoPai } : null,
        detalhe_status: detStatus,
        campos_detalhe: raw ? Object.keys(raw) : null,
        formato_detalhe: raw && raw.formato,
        tem_estrutura: !!(raw && raw.estrutura),
        estrutura: (raw && raw.estrutura) || null,
        variacao: (raw && raw.variacao) || null
      });
      return true;
    }

    // DEBUG: dumpa a ESTRUTURA dos produtos de um pedido (variação / composição / kit)
    // uso: /good-checkout-offline/debug-estrutura/{idDoPedido}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-estrutura/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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

    // DEBUG: dumpa o objeto NF + TESTA baixar o DANFE em PDF (linkPDF) de dentro do Render
    if (method === 'GET' && p === '/good-checkout-offline/debug-nf') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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
          out.campos_nf = nf ? Object.keys(nf) : null;
          out.links_e_danfe = nf ? Object.keys(nf).filter(k => /link|danfe|pdf|simpl|etiq|impress/i.test(k)).reduce((o, k) => { o[k] = nf[k]; return o; }, {}) : null;
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

    // DEBUG/PREVIEW: gera o DANFE Simplificado 10x15 de um pedido REAL (pra ver e validar)
    // uso: /good-checkout-offline/debug-nf-simp/{idDoPedido}        → abre o PDF
    //      /good-checkout-offline/debug-nf-simp/{idDoPedido}?json=1 → mostra os dados extraídos
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-nf-simp/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const pedidoId = p.split('/').filter(Boolean).pop();
      let snap = readJson(path.join(CACHE_DIR, String(pedidoId), 'pedido.json'), null);
      if (!snap) {  // talvez seja o NÚMERO do pedido (o que você vê na tela) → procura no manifest
        const man = manifest();
        const achado = Object.keys(man).find(k => String(man[k].numero) === String(pedidoId));
        if (achado) snap = readJson(path.join(CACHE_DIR, String(achado), 'pedido.json'), null);
      }
      if (!snap || !snap.nf || !snap.nf.id) { json(res, 404, { erro: 'pedido sem NF cacheada', pedido: pedidoId }); return true; }
      let dados;
      try { dados = await dadosNFSimp(snap.nf.id, snap.numero); }
      catch (e) { json(res, 502, { erro: 'falha ao montar dados', detalhe: e.message }); return true; }
      if (!dados) { json(res, 502, { erro: 'NF não retornou dados' }); return true; }
      if (/[?&]json=1/.test(urlObj.search || '')) { json(res, 200, dados); return true; }
      try {
        const pdf = await gerarDanfeSimplificado(dados);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe-simplificado.pdf"' });
        res.end(pdf);
      } catch (e) { json(res, 500, { erro: 'falha ao gerar PDF', detalhe: e.message }); }
      return true;
    }

    // PRODUÇÃO: gera/serve o DANFE SIMPLIFICADO (10x15) p/ imprimir na Zebra.
    //   cache-first (nf-simp.json gravado pelo cron → funciona OFFLINE);
    //   se não tiver no cache, busca ao vivo e cacheia.
    // uso: /good-checkout-offline/danfe-simp/{idOuNumero}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/danfe-simp/')) {
      const pedidoId = p.split('/').filter(Boolean).pop();
      let dir = path.join(CACHE_DIR, String(pedidoId));
      let snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap) {  // talvez seja o NÚMERO do pedido (o que aparece na tela)
        const man = manifest();
        const achado = Object.keys(man).find(k => String(man[k].numero) === String(pedidoId));
        if (achado) { dir = path.join(CACHE_DIR, String(achado)); snap = readJson(path.join(dir, 'pedido.json'), null); }
      }
      if (!snap) { json(res, 404, { erro: 'pedido não cacheado', pedido: pedidoId }); return true; }
      const blingId = path.basename(dir);
      // 1) cache de dados (nf-simp.json gravado pelo cron)
      let dados = readJson(path.join(dir, 'nf-simp.json'), null);
      if (!dados) {
        // acha a NF: do snapshot, ou ao vivo (re-cache antigo pode ter perdido o nf.id) → e CURA o snapshot
        let nfId = snap.nf && snap.nf.id;
        if (!nfId) {
          try {
            const nf = await nfDoPedido(blingId);
            if (nf && nf.id) { nfId = nf.id; snap.nf = nf; snap.tem_nf = true; writeJson(path.join(dir, 'pedido.json'), snap); }
          } catch (e) {}
        }
        if (!nfId) { json(res, 404, { erro: 'pedido sem NF', pedido: pedidoId }); return true; }
        try { dados = await dadosNFSimp(nfId, snap.numero); }
        catch (e) { json(res, 502, { erro: 'falha ao montar dados', detalhe: e.message }); return true; }
        if (dados) { try { writeJson(path.join(dir, 'nf-simp.json'), dados); } catch (e) {} }
      }
      if (!dados) { json(res, 502, { erro: 'NF não retornou dados' }); return true; }
      const q = urlObj.search || '';
      // ?zpl=1 → ZPL CRU (o que a Zebra imprime); ?preview=1 → ZPL renderizado p/ PDF via Labelary (ver no note); senão → PDF nativo
      try {
        if (/[?&]zpl=1/.test(q)) {
          const zpl = gerarDanfeSimplificadoZPL(dados);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(zpl);
        } else if (/[?&]preview=1/.test(q)) {
          const zpl = gerarDanfeSimplificadoZPL(dados);
          const pdf = await zplParaPdf(zpl);
          if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe-zpl-preview.pdf"' }); res.end(pdf); }
          else json(res, 502, { erro: 'Labelary nao converteu o ZPL (tente de novo)' });
        } else {
          const pdf = await gerarDanfeSimplificado(dados);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe-simplificado.pdf"' });
          res.end(pdf);
        }
      } catch (e) { json(res, 500, { erro: 'falha ao gerar', detalhe: e.message }); }
      return true;
    }

    // ETIQUETA MADEIRA na ZEBRA (10x15 térmico). Monta, POR VOLUME:
    //   [adesivo VOLUME i/N] + [etiqueta Correios 10x15] + [DANFE-simplificada].
    // O ZPL do Madeira é PÚBLICO (zplPorBatch — sem token/sessão); cacheia em
    // etiqueta-correios.zpl p/ reimpressão. A DANFE-simp reaproveita gerarDanfeSimplificadoZPL.
    // uso: /good-checkout-offline/etiqueta-madeira-zpl/{idOuNumero}   (?nodanfe=1 → só etiqueta+adesivo)
    if (method === 'GET' && p.startsWith('/good-checkout-offline/etiqueta-madeira-zpl/')) {
      const pedidoId = p.split('/').filter(Boolean).pop();
      let dir = path.join(CACHE_DIR, String(pedidoId));
      let snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap) {
        const man = manifest();
        const achado = Object.keys(man).find(k => String(man[k].numero) === String(pedidoId));
        if (achado) { dir = path.join(CACHE_DIR, String(achado)); snap = readJson(path.join(dir, 'pedido.json'), null); }
      }
      if (!snap) { json(res, 404, { erro: 'pedido não cacheado', pedido: pedidoId }); return true; }

      // 1) ZPL do Madeira (etiquetas dos Correios — 1 bloco ^XA..^XZ por volume). Cache → ou baixa (público).
      let zplMM = null;
      const _zplFile = path.join(dir, 'etiqueta-correios.zpl');
      try {
        if (fs.existsSync(_zplFile)) zplMM = fs.readFileSync(_zplFile, 'utf8');
        else {
          const mmEtq = require('../good-mm-etiquetas');
          let regMM = null;
          for (const c of [snap.numero_loja, snap.nf && snap.nf.numero].filter(Boolean)) { regMM = mmEtq.acharLote(c); if (regMM) break; }
          if (regMM && regMM.batch) {
            zplMM = await mmEtq.zplPorBatch(regMM.batch);
            if (zplMM && zplMM.indexOf('^XA') !== -1) { try { fs.writeFileSync(_zplFile, zplMM); } catch (e) {} }
          }
        }
      } catch (e) {}
      if (!zplMM) { json(res, 502, { erro: 'ZPL do Madeira indisponível (lote não está no mapa, ou Portal fora do ar)' }); return true; }
      const blocos = zplMM.match(/\^XA[\s\S]*?\^XZ/g) || [];
      if (!blocos.length) { json(res, 502, { erro: 'ZPL do Madeira sem etiquetas (^XA...^XZ)' }); return true; }
      const N = blocos.length;

      // 2) DANFE-simplificada em ZPL (mesmo padrão da /danfe-simp: cache nf-simp.json → ou ao vivo)
      let danfeZpl = '';
      if (!/[?&]nodanfe=1/.test(urlObj.search || '')) {
        try {
          let dados = readJson(path.join(dir, 'nf-simp.json'), null);
          if (!dados) {
            let nfId = snap.nf && snap.nf.id;
            if (!nfId) {   // re-cache antigo pode ter perdido o nf.id → re-busca e CURA o snapshot (igual /danfe-simp)
              try { const _nf = await nfDoPedido(path.basename(dir)); if (_nf && _nf.id) { nfId = _nf.id; snap.nf = _nf; snap.tem_nf = true; writeJson(path.join(dir, 'pedido.json'), snap); } } catch (e) {}
            }
            if (nfId) { dados = await dadosNFSimp(nfId, snap.numero); if (dados) { try { writeJson(path.join(dir, 'nf-simp.json'), dados); } catch (e) {} } }
          }
          if (dados) danfeZpl = gerarDanfeSimplificadoZPL(dados) || '';
        } catch (e) {}
      }

      // 3) monta: [adesivo i/N] + [Correios i] + [DANFE-simp]  por volume
      const cliente = (snap.cliente || '').slice(0, 28);
      const numero = snap.numero || pedidoId;
      let out = '';
      for (let i = 0; i < N; i++) {
        out += bannerVolumeZpl(i + 1, N, numero, cliente);
        out += blocos[i] + '\n';
        if (danfeZpl) out += danfeZpl + '\n';
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
      return true;
    }

    // ETIQUETA de postagem + tira da DANFE numa etiqueta só (ML / Amazon / Magalu / TikTok)
    // Shopee NÃO usa — já vem fundida nativa pela própria API.
    // ?info=1 → mostra os números da fusão (fator, se cabe) SEM imprimir, p/ diagnóstico.
    // ?pdf=1  → devolve um PDF da etiqueta fundida (imprime em qualquer impressora; testar à distância).
    // uso: /good-checkout-offline/etiqueta-fundida/{idOuNumero}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/etiqueta-fundida/')) {
      const pedidoId = p.split('/').filter(Boolean).pop();
      let dir = path.join(CACHE_DIR, String(pedidoId));
      let snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap) {  // talvez seja o NÚMERO do pedido (o que aparece na tela)
        const man = manifest();
        const achado = Object.keys(man).find(k => String(man[k].numero) === String(pedidoId));
        if (achado) { dir = path.join(CACHE_DIR, String(achado)); snap = readJson(path.join(dir, 'pedido.json'), null); }
      }
      if (!snap) { json(res, 404, { erro: 'pedido não cacheado', pedido: pedidoId }); return true; }
      const blingId = path.basename(dir);
      // 1) etiqueta ZPL do cache (precisa ser ZPL — não funde PDF)
      let zplEtq = null;
      try { zplEtq = fs.readFileSync(path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8'); }
      catch (e) { json(res, 404, { erro: 'etiqueta não cacheada', pedido: pedidoId }); return true; }
      if (!/\^XA/.test(zplEtq)) { json(res, 422, { erro: 'etiqueta não é ZPL', formato: ETIQ_FORMATO }); return true; }
      // 2) dados da NF (igual /danfe-simp: cache nf-simp.json, ou monta ao vivo e cura o snapshot)
      let dados = readJson(path.join(dir, 'nf-simp.json'), null);
      if (!dados) {
        let nfId = snap.nf && snap.nf.id;
        if (!nfId) {
          try {
            const nf = await nfDoPedido(blingId);
            if (nf && nf.id) { nfId = nf.id; snap.nf = nf; snap.tem_nf = true; writeJson(path.join(dir, 'pedido.json'), snap); }
          } catch (e) {}
        }
        if (!nfId) { json(res, 404, { erro: 'pedido sem NF', pedido: pedidoId }); return true; }
        try { dados = await dadosNFSimp(nfId, snap.numero); }
        catch (e) { json(res, 502, { erro: 'falha ao montar dados', detalhe: e.message }); return true; }
        if (dados) { try { writeJson(path.join(dir, 'nf-simp.json'), dados); } catch (e) {} }
      }
      if (!dados) { json(res, 502, { erro: 'NF não retornou dados' }); return true; }
      // 3) funde etiqueta + tira da DANFE → ZPL único pra Zebra
      try {
        const r = fundirEtiquetaComDanfe(zplEtq, dados);
        // raster que enche tudo (sem espaço nem p/ 1 linha) → não fundível; mantém 2 etiquetas
        if (r.modo === 'declinou') {
          if (/[?&]info=1/.test(urlObj.search || '')) { json(res, 200, { pedido: pedidoId, fundivel: false, modo: 'declinou', motivo: r.motivo }); return true; }
          json(res, 409, { erro: 'etiqueta-imagem enche tudo — não fundível', motivo: r.motivo, dica: 'mantenha etiqueta + DANFE em 2 etiquetas' });
          return true;
        }
        if (/[?&]info=1/.test(urlObj.search || '')) {   // diagnóstico, não imprime
          const info = { pedido: pedidoId, fundivel: true, modo: r.modo };
          if (r.modo === 'fusao') { info.encolheu = r.fator < 1; info.fator = Number(r.fator.toFixed(3)); info.conteudo_ate = r.maxY; info.conteudo_escalado = r.novoMaxY; info.fundo_final = r.fundoFinal; info.cabe_10x15 = r.fundoFinal <= 1185; }
          else { info.tipo = 'raster (imagem)'; info.imagem_ate = r.fimImagem; info.espaco_livre = r.livre; info.adicionou = 'linha NF: numero/serie/data/natureza no rodape'; }
          json(res, 200, info);
          return true;
        }
        if (/[?&]pdf=1/.test(urlObj.search || '')) {   // PDF p/ imprimir em qualquer impressora (testar à distância)
          const pdf = await zplParaPdf(r.zpl);
          if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="etiqueta-fundida.pdf"' }); res.end(pdf); }
          else json(res, 502, { erro: 'Labelary não converteu o ZPL (tente de novo)' });
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(r.zpl);
      } catch (e) { json(res, 500, { erro: 'falha ao fundir', detalhe: e.message }); }
      return true;
    }

    // testa o caminho do DANFE p/ UM pedido (id do pedido) e cacheia se der certo
    // uso: /good-checkout-offline/debug-danfe/{idDoPedido}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-danfe/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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
    // uso: /good-checkout-offline/debug-etiqueta-fmt/{idDoPedido}
    if (method === 'GET' && p.startsWith('/good-checkout-offline/debug-etiqueta-fmt/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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
// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
let _cst = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, inicio: null };
async function custoSync(fresh) {
  if (_cst.rodando) return;
  const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');
  const cc = readJson(CUSTO_FILE, {});
  const conf = readJson(CONFERIDOS_FILE, {});
  const todos = new Set();
  for (const c of Object.values(conf)) { for (const it of ((c && c.itens) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }
  const SETE_D = 7 * 24 * 3600 * 1000;
  const alvos = [...todos].filter(sk => { const k = cc[sk]; return fresh || !k || !k.id || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });
  _cst = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, inicio: new Date().toISOString() };
  console.log('[CUSTO] sync iniciando — ' + alvos.length + ' SKU(s) a resolver (tartaruga: ~1,2s/chamada)');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg2 = async (pth) => { for (let t = 0; t < 4; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme(1500 + t * 700); } return await blingGet(pth); };
  let desdeGravei = 0;
  for (const sku of alvos) {
    try {
      let prod = null;
      for (const v of [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])]) {
        const r = await bg2(`/produtos?codigo=${encodeURIComponent(v)}&limite=1&criterio=5`);
        const it = r.ok && r.data && r.data.data && r.data.data[0];
        if (it && it.id) { const d = await bg2(`/produtos/${it.id}`); prod = (d.ok && d.data && d.data.data) || it; break; }
        await dorme(600);
      }
      if (prod && prod.id) {
        const forn = prod.fornecedor || {};
        let cand = [forn.precoCusto, forn.precoCompra, prod.precoCusto, prod.custo].map(Number).filter(v => isFinite(v) && v > 0);
        if (!cand.length) {
          const rf = await bg2(`/produtos/fornecedores?idProduto=${prod.id}&limite=5`);
          const arr = (rf.ok && rf.data && rf.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          if (pref) cand = [pref.precoCusto, pref.precoCompra].map(Number).filter(v => isFinite(v) && v > 0);
        }
        cc[sku] = { id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: cand.length ? Math.round(cand[0] * 10000) / 10000 : null, ts: Date.now() };
        _cst.ok++;
      } else { _cst.falhas++; }
    } catch (e) { _cst.falhas++; }
    _cst.feitos++; desdeGravei++;
    if (desdeGravei >= 10) { desdeGravei = 0; try { writeJson(path.join(CACHE_DIR, '_custos.json'), cc); } catch (e) {} }
    await dorme(1200);
  }
  try { writeJson(path.join(CACHE_DIR, '_custos.json'), cc); } catch (e) {}
  _cst.rodando = false;
  console.log('[CUSTO] sync concluiu — ok=' + _cst.ok + ' falhas=' + _cst.falhas + ' de ' + _cst.total);
}

function bootstrap() {
  // PESCA AUTOMÁTICA PÓS-DEPLOY: todo deploy mata a pesca em andamento; aqui ela renasce sozinha
  // 90s depois do boot (após o ciclo inicial). Com dias=14 só re-checa os recentes — barato e idempotente.
  setTimeout(() => { try { console.log('[ML-FEES] pesca automática pós-deploy iniciando…'); mlSyncFees(14).catch(() => {}); } catch (e) {} }, 90 * 1000);
  setTimeout(() => { try { custoSync(false).catch(() => {}); } catch (e) {} }, 240 * 1000);   // custos: tartaruga pós-boot, só o que falta
  // ETIQUETA PARADA: enquanto existir pedido sem etiqueta, tenta de novo a cada 5 min (o cron normal é 10/10).
  // Em dia limpo (0 sem etiqueta) NADA extra roda — custo zero. Cobre etiqueta que o canal demora a gerar.
  setInterval(() => {
    try {
      const r = getUltimoResumo();
      if (r && r.semEtiqueta > 0) { console.log('[CICLO-EXTRA] ' + r.semEtiqueta + ' pedido(s) sem etiqueta \u2014 rodando ciclo extra'); rodarCiclo('auto-etiqueta').catch(() => {}); }
    } catch (e) {}
  }, 5 * 60 * 1000);

  ensureDir(CACHE_DIR);
  console.log(`[GOODBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  setTimeout(() => rodarCiclo('boot'), 20000);
}

// ═══ PESCA POSTERIOR (ML): busca tarifa REAL (sale_fee) e frete do vendedor nos pedidos ML
// recentes e grava no conferido (tarifa_ml / frete_ml). Roda no cron diário e sob demanda.
// Re-checa os finalizados dos últimos 3 dias mesmo se já têm tarifa (o ML pode ajustar depois).
async function mlSyncFees(dias) {
  dias = Math.max(1, Math.min(60, Number(dias || 14)));
  if (_mls.rodando) return _mls;
  const corte = Date.now() - dias * 86400000;
  const recheck = Date.now() - 3 * 86400000;
  const conf0 = readJson(CONFERIDOS_FILE, {});
  const alvos = Object.entries(conf0).filter(([cid, c]) => {
    if (!c || !c.conferido_em) return false;
    const t = new Date(c.conferido_em).getTime();
    if (t < corte) return false;
    const mk = String(c.marketplace || '').toLowerCase();
    if (mk !== 'ml' && mk !== 'mercadolivre') return false;
    if (!c.numero_loja) return false;
    return c.tarifa_ml == null || c.venda_em == null || t >= recheck;
  }).map(([cid]) => cid);
  if (!alvos.length) { console.log('[ML-FEES] nada a pescar (' + dias + 'd)'); return { ok: true, nada: true }; }
  _mls = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString(), erros: {}, amostras: [] };
  console.log('[ML-FEES] pescando tarifas de ' + alvos.length + ' pedido(s) ML...');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  let tokenML = null;
  try { const { garantirTokenML } = require('../good/mlTokenManager'); tokenML = await garantirTokenML(); }
  catch (e) { _mls.rodando = false; console.log('[ML-FEES] ✗ sem token ML: ' + e.message); return _mls; }
  const pend = {};
  const salvar = () => {
    if (!Object.keys(pend).length) return;
    const c2 = readJson(CONFERIDOS_FILE, {});
    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; }
    writeJson(CONFERIDOS_FILE, c2);
    for (const cid of Object.keys(pend)) delete pend[cid];
  };
  for (const cid of alvos) {
    try {
      const nl = String((conf0[cid] && conf0[cid].numero_loja) || '').replace(/\D/g, '');
      const H = { headers: { Authorization: 'Bearer ' + tokenML } };
      let r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
      let d = await r.json().catch(() => null);
      let ords = null;   // 1 order normal; N orders quando o Bling gravou o PACK id (carrinho)
      if (r.ok && d) ords = [d];
      else if (r.status === 404) {
        // "Order do not exists" com id 2000...: é PACK (carrinho) — abre o pack e pega as orders de dentro
        try {
          const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
          const dp = await rp.json().catch(() => null);
          if (rp.ok && dp && Array.isArray(dp.orders) && dp.orders.length) {
            ords = [];
            for (const oq of dp.orders) {
              try {
                const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H);
                const doo = await ro.json().catch(() => null);
                if (ro.ok && doo) ords.push(doo);
              } catch (e3) {}
              await dorme(150);
            }
            if (!ords.length) ords = null;
          }
        } catch (e2) {}
      }
      if (ords && ords.length) {
        let fee = 0, venda = null, shipId = null;
        for (const od of ords) {
          for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1); const sf = Number(it.sale_fee || 0); if (isFinite(sf)) fee += sf * q; }
          if (!venda && od.date_created) venda = od.date_created;
          if (!shipId && od.shipping && od.shipping.id) shipId = od.shipping.id;
        }
        const reg = { fee: Math.round(fee * 100) / 100, frete: null, venda: venda, _orders: ords.length };
        if (shipId) {
          try {
            const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H);
            const ds = await rs.json().catch(() => null);
            if (rs.ok && ds) {
              const lc = Number(ds.list_cost), cc = Number(ds.cost);
              if (isFinite(lc) && isFinite(cc) && lc >= cc) reg.frete = Math.round((lc - cc) * 100) / 100;
            }
          } catch (e) {}
          await dorme(200);
        }
        pend[cid] = reg; _mls.ok++;
      } else {
        _mls.falhas++;
        const stc = String(r.status), em = (((d && (d.message || d.error)) || '') + (r.status === 404 ? ' [nem order nem pack]' : '')).slice(0, 140);
        _mls.erros[stc] = (_mls.erros[stc] || 0) + 1;
        if (_mls.amostras.length < 3) { _mls.amostras.push({ pedido: cid, numero_loja: nl, status: r.status, msg: em }); }
        if ((_mls.erros[stc] || 0) === 1) console.log('[ML-FEES] falha ' + r.status + ' no pedido ' + cid + ' (venda ' + nl + '): ' + em);
      }
    } catch (e) {
      _mls.falhas++;
      _mls.erros.exc = (_mls.erros.exc || 0) + 1;
      if (_mls.amostras.length < 3) { _mls.amostras.push({ pedido: cid, status: 'exc', msg: String(e.message || e).slice(0, 140) }); }
      if (_mls.erros.exc === 1) console.log('[ML-FEES] exceção no pedido ' + cid + ': ' + (e.message || e));
    }
    _mls.feitos++;
    if (_mls.feitos % 15 === 0) { salvar(); console.log('[ML-FEES] ' + _mls.feitos + '/' + _mls.total); }
    await dorme(350);
  }
  salvar(); _mls.rodando = false;
  console.log('[ML-FEES] ✔ ' + _mls.ok + ' ok, ' + _mls.falhas + ' falha(s) de ' + _mls.total);
  return _mls;
}

module.exports = {
  id: 'good-checkout-offline',
  nome: 'GOOD Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14), shopeeKeepAlive: () => shopeeKeepAlive() },
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '25 5,17 * * *' },
  bootstrap
};
