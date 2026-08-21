'use strict';

// ════════════════════════════════════════════════════════════════════════
//  AMBTOTAL · CHECKOUT OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
// ════════════════════════════════════════════════════════════════════════
//  Módulo do orquestrador unificado (HTTP-native, sem Express).
//  Reaproveita o token Bling da AMBTotal via ../ambtotal/tokenManager.
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
//  ⚠ PRÉ-REQUISITO de scope no app Bling da AMBTotal (Mover-Pedidos):
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
// Configure no Render: AMBBKP_QZ_CERT (digital-certificate.txt) e AMBBKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.AMBBKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.AMBBKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

// logo OFICIAL da AMBTOTAL (drone + carrinho, enviado pelo Diego 10/08) — 128px em /icone.png pro favicon, PWA e atalho
const ICONE_B64  = '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';
const VERSAO     = 'amb-checkout-offline v14/08 b73';

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

// ─── Lote 3 (04/08): histórico e análise (os números do dashboard) foram pro historico.js ───
const { rotasHistorico } = require('./amb-historico');
// ─── 04/08: pescaria retroativa da comissão real do ML no histórico ───
const { rotasPescaria } = require('./amb-pescaria');
// ─── 05/08: canário das integrações (só leitura, avisa quando um contrato de API muda) ───
const { rotasCanario } = require('./amb-canario');
// ─── 05/08: poda do bucket de expedição no Supabase (o que estourou o Free Plan) ───
const { rotasLimpeza, podarExpedicao } = require('./amb-limpeza');
// ─── 05/08: rotina noturna — encadeia billing, backfill, pesca, cancelados, poda e canário ───
const { criarNoturna } = require('./amb-noturna');
// ─── 05/08: API oficial da Shopee (Open Platform v2) — conectar, sondar o escrow ───
const { rotasShopee, escrowDoPedido, contasDoEscrow, escrowEmLote, coletarDevolucoes, coletarCarteira, pedirAoSync } = require('./amb-shopee');
// 14/08: ads vem da lib compartilhada; o wrapper injeta o ctx da empresa (mesmo padrão
// dos outros coletores) pra rotina noturna poder chamar sem saber de detalhe nenhum.
const _adsLib = require('../lib/shopee-ads');
const coletarAds = dias => _adsLib.coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync }, dias);
const { canarioCron } = require('./amb-canario');
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

// ─── Config (env prefixo AMBBKP_, defaults sãos) ───────────────────────
// presença entre PCs: quem está separando cada pedido. Limpa reservas vencidas a cada leitura.
// operadores p/ login (env AMBBKP_OPERADORES = "Nome:senha,Nome:senha"). Vazio = login DESLIGADO.
// quem pode REABRIR/reverter pedido (env AMBBKP_ADMIN = "Diego" ou "Diego,Angelica"). Vazio = sem restrição (todo mundo pode).

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

// GET autenticado no Bling AMBTotal (token via tokenManager + retry 429)

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

// ── SESSÃO SHOPEE QUE SE RENOVA SOZINHA (b18) ───────────────────────────
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
const SHOPEE_ENV_COOKIE  = 'AMBBKP_SHOPEE_COOKIE';
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


/* ═══════════ 21/08 — CUSTO MANUAL POR PLANILHA ═══════════════════════════════════════════
   Pedido do Diego: "uma área de subida de sku x custo. eu faço upload e pronto, resolve" —
   como no Jodda e no MercadoTurbo. Nasceu de SKUs que venderam SEM custo no painel: o
   FL-1011-PRETO da AMB (53 un.) foi RENOMEADO no Bling para 3933398010054, então o código
   antigo não existe mais e o custo nunca é achado; na Girassol sobraram 2 casos parecidos.
   REGRA QUE ELE ESCOLHEU: "se o bling passar a ter custo, aí deixa mandar o Bling". Ou seja,
   o manual é PONTE, não substituto — vale enquanto o Bling não sabe, e sai de cena sozinho
   quando o cadastro passa a ter custo. Assim um preço digitado à mão nunca congela um custo
   que voltou a se atualizar sozinho.
   Guardado em _custos-manuais.json (arquivo próprio), pra um custo-sync nunca sobrescrever. */
function lerCustosManuais() {
  try { return readJson(path.join(CACHE_DIR, '_custos-manuais.json'), {}) || {}; } catch (e) { return {}; }
}
function gravarCustosManuais(obj) {
  writeJson(path.join(CACHE_DIR, '_custos-manuais.json'), obj || {});
  /* Codex (P2): sem isto, apagar um custo manual mudava só o arquivo — o cache de 6h de SKU
     continuava servindo o valor antigo e, ao vencer, o fallback o copiava de volta. O custo
     apagado seguiria afetando a margem indefinidamente. Toda gravação derruba os dois caches. */
  try { if (typeof _skuInfoCache === 'object' && _skuInfoCache) { for (const k of Object.keys(_skuInfoCache)) delete _skuInfoCache[k]; } } catch (e) {}
  try { const f = path.join(CACHE_DIR, '_skus-info.json'); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
/* custo POR UNIDADE do SKU, ou null. `doBling` é o que o Bling já sabe: se ele tem custo,
   o manual não entra (regra do Diego). */
function custoManualDe(sku, doBling) {
  if (doBling != null && isFinite(Number(doBling)) && Number(doBling) > 0) return null;
  const r = lerCustosManuais()[String(sku || '').trim().toUpperCase()];
  const v = r && Number(r.custo);
  return (v > 0) ? v : null;
}
/* Sobrepõe o manual num mapa de custos do Bling, sem nunca vencer um custo que o Bling tem.
   Um lugar só: dashboards, histórico e plano de compra chamam esta função — foi a falta disso
   que deixou o plano de compra dizendo "sem custo" enquanto a tela já mostrava o corrigido. */
function comCustosManuais(mapaDoBling) {
  const b = mapaDoBling || {};
  const man = lerCustosManuais();
  const temNoBling = k => { const c = b[k] || b[String(k).toLowerCase()]; return c && Number(c.custo) > 0; };
  for (const K of Object.keys(man)) {
    const v = Number(man[K].custo);
    if (!(v > 0)) continue;
    const nome = man[K].sku || K;
    if (!temNoBling(K) && !temNoBling(nome)) b[nome] = { custo: v, manual: true };
  }
  return b;
}
/* Aceita planilha colada do Excel (SKU<TAB>custo), CSV com ; ou , e linhas soltas.
   ⚠️ O SEPARADOR É DECIDIDO POR LINHA, e a vírgula é a ÚLTIMA opção: em planilha brasileira
   a vírgula é DECIMAL, e tratá-la como separador de coluna transforma "33,82" em 82 — um
   custo errado sem nenhum aviso na tela é pior que custo faltando. Tab e ponto-e-vírgula
   têm prioridade justamente por isso.
   Devolve {itens, ignoradas} pra tela poder mostrar o que entrou e o que não. */

/* Tela do custo manual: colar do Excel ou subir CSV. Sem framework, no mesmo estilo escuro
   dos outros painéis. A lista do que já está gravado vem junto, com botão de apagar. */
function telaCustosManuais(nomeEmpresa, mod) {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Custos manuais · ${nomeEmpresa}</title><style>
*{box-sizing:border-box} body{margin:0;background:#0b1220;color:#e5e7eb;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}
.wrap{max-width:980px;margin:0 auto} h1{font-size:19px;margin:0 0 4px} .dim{color:#94a3b8;font-size:12px}
.card{background:#111a2e;border:1px solid #1f2b45;border-radius:12px;padding:16px;margin:14px 0}
textarea{width:100%;min-height:180px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2b45;border-radius:8px;padding:10px;font:13px ui-monospace,Menlo,Consolas,monospace}
button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer}
button.sec{background:#1f2b45}
table{width:100%;border-collapse:collapse;margin-top:8px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1f2b45;font-size:13px}
th{color:#94a3b8;font-weight:600;font-size:11px;text-transform:uppercase}
.ok{color:#34d399} .warn{color:#fbbf24} .bad{color:#f87171} code{background:#0b1220;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>💰 Custos manuais · ${nomeEmpresa}</h1>
<div class="dim">O custo daqui <b>só vale onde o Bling não tem custo</b> para o SKU. Se o Bling passar a ter, ele volta a mandar — o manual é ponte, não substituto.</div>

<div class="card">
  <div style="margin-bottom:8px"><b>Colar do Excel</b> <span class="dim">— duas colunas: SKU e custo POR UNIDADE. Aceita tab, ponto-e-vírgula, vírgula, R$ e decimal brasileiro.</span></div>
  <textarea id="txt" placeholder="FL-1011-PRETO&#9;33,82&#10;465;12,50&#10;10xE14-5W-3000K-BIV&#9;34,00"></textarea>
  <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button onclick="salvar()">Salvar custos</button>
    <button class="sec" onclick="document.getElementById('arq').click()">Subir CSV</button>
    <input type="file" id="arq" accept=".csv,.txt,.tsv" style="display:none" onchange="lerArq(this)">
    <span id="msg" class="dim"></span>
  </div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <b>Gravados</b>
    <button class="sec" onclick="carregar()">atualizar</button>
  </div>
  <div id="lista" class="dim" style="margin-top:8px">carregando…</div>
</div>

<div class="dim">Dica: no dashboard, o card <b>SKUs que venderam SEM custo</b> tem o botão <i>copiar a lista de SKUs</i> — cole aqui, preencha os custos e salve.</div>

<script>
const MOD='${mod}';
const K=new URLSearchParams(location.search).get('k')||'';
const qs=K?('?k='+encodeURIComponent(K)):'';
function lerArq(el){ const f=el.files&&el.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=()=>{ document.getElementById('txt').value=r.result; msg('arquivo carregado — confira e clique em Salvar','warn'); }; r.readAsText(f,'utf-8'); }
function msg(t,cls){ const m=document.getElementById('msg'); m.textContent=t; m.className=cls||'dim'; }
async function salvar(){
  const texto=document.getElementById('txt').value.trim();
  if(!texto){ msg('cole alguma coisa primeiro','warn'); return; }
  msg('salvando…');
  try{
    const r=await fetch(MOD+'/custos-manuais'+qs,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto})});
    const j=await r.json();
    if(!j.ok){ msg('✗ '+(j.erro||'falhou')+(j.ignoradas&&j.ignoradas.length?(' · ignoradas: '+j.ignoradas.length):''),'bad'); return; }
    msg('✓ '+j.gravados+' custo(s) gravado(s)'+(j.ignoradas&&j.ignoradas.length?(' · '+j.ignoradas.length+' linha(s) ignorada(s)'):''),'ok');
    document.getElementById('txt').value='';
    carregar();
  }catch(e){ msg('✗ '+e.message,'bad'); }
}
async function apagar(sku){
  if(!confirm('Apagar o custo manual de '+sku+'?')) return;
  await fetch(MOD+'/custos-manuais'+qs,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apagar:sku})});
  carregar();
}
async function carregar(){
  const el=document.getElementById('lista');
  try{
    const r=await fetch(MOD+'/custos-manuais'+(qs?qs+'&':'?')+'lista=1');
    const j=await r.json();
    if(!j.ok||!j.total){ el.innerHTML='<span class="dim">nenhum custo manual gravado</span>'; return; }
    /* Codex (P2): o SKU ia para dentro de um onclick com só as aspas escapadas. O navegador
       DECODIFICA entidades HTML antes de rodar o JS, então uma planilha com um SKU forjado
       executaria script na sessão de admin — e planilha vem de fora. Agora o valor viaja em
       data-attribute (que nunca é interpretado como código) e o clique é ligado por listener. */
    el.innerHTML='<table><tr><th>SKU</th><th>Custo/un.</th><th>Quando</th><th></th></tr>'+
      j.itens.map(i=>'<tr><td><code>'+esc(i.sku)+'</code></td><td>R$ '+Number(i.custo).toFixed(2).replace('.',',')+
      '</td><td class="dim">'+(i.em?String(i.em).slice(0,10).split('-').reverse().join('/'):'—')+
      '</td><td><button class="sec del" style="padding:3px 8px;font-size:11px" data-sku="'+esc(i.sku)+'">apagar</button></td></tr>').join('')+
      '</table><div class="dim" style="margin-top:6px">'+j.total+' SKU(s)</div>';
    el.querySelectorAll('button.del').forEach(b=>b.addEventListener('click',()=>apagar(b.getAttribute('data-sku'))));
  }catch(e){ el.innerHTML='<span class="bad">erro: '+e.message+'</span>'; }
}
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
carregar();
</script></div></body></html>`;
}

function parsearCustosColados(txt) {
  const linhas = String(txt || '').split(/\r?\n/);
  const itens = {}; const ignoradas = [];
  const limpa = x => String(x || '').trim().replace(/^["']|["']$/g, '');
  const paraNumero = s => {
    let b = String(s || '').replace(/[R$\s]/gi, '');
    if (!b) return NaN;
    const temVirg = b.indexOf(',') >= 0, temPonto = b.indexOf('.') >= 0;
    if (temVirg && temPonto) b = (b.lastIndexOf(',') > b.lastIndexOf('.'))
        ? b.replace(/\./g, '').replace(',', '.')     // 1.234,56 → 1234.56
        : b.replace(/,/g, '');                       // 1,234.56 → 1234.56
    else if (temVirg) b = b.replace(',', '.');       // 33,82 → 33.82
    return Number(b);
  };
  for (const ln of linhas) {
    let l = ln.trim();
    if (!l) continue;
    /* Codex (P2): CSV com aspas — "FL-1011-PRETO","33.82" — é o que o Excel exporta por PADRÃO,
       e a linha inteira era rejeitada porque o número não terminava a linha (a aspa final
       atrapalhava o casamento). A tela oferece "subir CSV", então o formato mais comum tem que
       passar: tiro as aspas de cada campo antes de decidir o separador. */
    if (l.indexOf('"') >= 0 || l.indexOf("'") >= 0) {
      const campos = l.match(/"[^"]*"|'[^']*'|[^,;\t]+/g);
      if (campos && campos.length >= 2) l = campos.map(c => c.trim().replace(/^["']|["']$/g, '')).join('\t');
    }
    let partes;
    if (l.indexOf('\t') >= 0) partes = l.split('\t');
    else if (l.indexOf(';') >= 0) partes = l.split(';');
    else {
      /* Sem tab nem ';', o valor é o ÚLTIMO CAMPO NUMÉRICO da linha e o SKU é todo o resto.
         Achar isso cortando na última vírgula não funciona: em "R$ 8,90" a última vírgula está
         DENTRO do número, e o corte devolvia custo 90. Então eu casco o número pelo FIM da linha
         — aceitando R$, espaço, milhar e decimal — e o que sobra na frente é o SKU, mesmo que
         tenha vírgulas ("KIT 10x LED, 3000K, 5W"). */
      const m = l.match(/^(.*?)[\s,;]*(?:R\$\s*)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*$/i);
      if (m && m[1] && m[1].trim()) partes = [m[1], m[2]];
      else partes = [l];   // sem número no fim: linha ignorada logo abaixo
    }
    partes = (partes || []).map(limpa).filter(x => x !== '');
    if (partes.length < 2) { ignoradas.push(l.slice(0, 60)); continue; }
    const sku = String(partes[0]).replace(/[\s,;]+$/, '');
    const custo = paraNumero(partes[partes.length - 1]);
    if (!sku || sku.toLowerCase() === 'sku' || !isFinite(custo) || custo <= 0) { ignoradas.push(l.slice(0, 60)); continue; }
    /* Codex (P2): a planilha pode vir 'abc-1' e a venda 'ABC-1'. Guardo a chave normalizada
       (e o sku original pra exibir), e a leitura normaliza igual — senão o custo nunca aplica. */
    itens[sku.toUpperCase()] = { custo: Math.round(custo * 10000) / 10000, sku: sku, em: new Date().toISOString() };
  }
  return { itens, ignoradas };
}

async function shopeeKeepAlive() {
  const sess = shopeeSessaoLer();
  if (!sess.cookie) { console.log('[AMBBKP] shopee keep-alive: sem cookie (env ' + SHOPEE_ENV_COOKIE + ' vazia) — nada a fazer'); return { ok: false, motivo: 'sem cookie' }; }
  try {
    const r = await fetch(shopeeUrlBusca(sess.cookie, 'keepalive'), { headers: Object.assign({ 'Cookie': sess.cookie }, SHOPEE_CAB) });
    const t = await r.text();
    const ren = shopeeSessaoAtualiza(r);
    const vivo = (r.status === 200 && /"code"\s*:\s*0/.test(t));
    console.log('[AMBBKP] shopee keep-alive: HTTP ' + r.status + (vivo ? ' ✓ sessão viva' : ' ✗ sessão NÃO respondeu como logada') + (ren ? (' · ' + ren.mudou + ' cookie(s) renovado(s), total ' + ren.renovacoes) : ' · nada a renovar'));
    return { ok: vivo, status: r.status, renovou: ren ? ren.mudou : 0, corpo: t.slice(0, 300) };
  } catch (e) {
    console.log('[AMBBKP] shopee keep-alive falhou: ' + ((e && e.message) || e));
    return { ok: false, erro: String((e && e.message) || e).slice(0, 200) };
  }
}

// ─── Rotas HTTP (namespaced) ────────────────────────────────────────────
// A rotina noturna precisa das funcoes deste arquivo, entao e montada aqui.
// O agendador da RAIZ registra sozinho qualquer chave nova de `crons` que tenha
// uma funcao de mesmo nome em `rotinas` — nao precisa mexer no index da raiz.
const _listarNoBlingCanario = async (de, ate) => {
  const porCanal = {};
  // Codex (P1): o Bling tem bug conhecido no MESMO DIA — o vendasSync já contorna
  // pedindo um dia a mais. Sem isso, venda de hoje sumiria e seria acusada de falta.
  const ateMais1 = new Date(Date.parse(ate + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const MAX_PG = 200;
  for (let pg = 1; pg <= MAX_PG; pg++) {
    // 16/08 — MEDIDO em produção: rodar o canário JUNTO com o backfill estourou a cota do
    // Bling e voltou HTTP 429 na 2ª página. 429 é fila cheia, não integração quebrada —
    // então espera e tenta de novo. Erro de verdade (401/404) aborta na hora, sem insistir.
    let r = null;
    for (let tent = 1; tent <= 4; tent++) {
      r = await blingGet('/pedidos/vendas?dataInicial=' + de + '&dataFinal=' + ateMais1 + '&pagina=' + pg + '&limite=100');
      if (r && r.ok) break;
      const st429 = (r && r.status) || 0;
      if (st429 !== 429 && st429 !== 0 && st429 < 500) break;
      // Codex: não dormir depois da ÚLTIMA tentativa — eram 16s de espera sem ninguém
      // atrás (o blingGet já tem retry próprio; a soma passava de 1 minuto pra nada).
      if (tent < 4) await new Promise(r2 => setTimeout(r2, tent * 4000));
    }
    // Codex (P2): falha do Bling NÃO pode virar "nenhum pedido" — isso acusaria o
    // marketplace inteiro de sumido quando o problema é a nossa própria consulta.
    // Codex: o blingGet devolve 429 TAMBÉM quando a rede falha (DNS, conexão) — afirmar
    // "cota estourada" mandaria investigar o lado errado. A mensagem passa a citar as duas
    // hipóteses, na ordem provável.
    if (!r || !r.ok) throw new Error('Bling não respondeu na página ' + pg + ' (HTTP ' + ((r && r.status) || '?') + ')' +
      (((r && r.status) === 429) ? ' — cota da API estourada OU Bling inacessível (rede). Se houver backfill rodando, é cota; senão, cheque o Bling.' : ''));
    const arr = (r.data && r.data.data) || [];
    if (!arr.length) break;
    for (const pd of arr) {
      const lid = String((pd.loja && pd.loja.id) || '');
      const canal = LOJA_MKT[lid] || 'outro';
      const nl = String(pd.numeroPedidoLoja || pd.numeroLoja || '').trim();
      if (!nl) continue;
      (porCanal[canal] = porCanal[canal] || new Set()).add(nl);
    }
    if (arr.length < 100) break;
    // Codex (P2): página cheia no teto = lista truncada, e truncada não vale comparar
    if (pg === MAX_PG) throw new Error('mais de ' + (MAX_PG * 100) + ' pedidos no Bling nesse período — reduza &dias=');
    await new Promise(r2 => setTimeout(r2, 150));
  }
  return porCanal;
};

const _listarNoMarketplaceCanario = async (canal, deTs, ateTs) => {
  if (canal === 'shopee') {
    // Codex (#119): o resto da AMB usa AMBBKP_SHOPEE_SYNC_KEY OU a global (ver linhas 2823 e
      // 6492). Exigir só a global marcava a Shopee como "sem fonte" numa conexão que funciona —
      // e canal sem fonte vira INDETERMINADO, ou seja, o canário deixaria de achar pedido sumido.
      if (!process.env.AMBBKP_SHOPEE_SYNC_KEY && !process.env.SHOPEE_SYNC_KEY) return null;
    const ids = [];
    for (let ini = deTs; ini < ateTs; ini += 15 * 86400) {
      const fimJ = Math.min(ini + 15 * 86400 - 1, ateTs);
      let cursor = '';
      const MAX_PG_SH = 60;
      for (let v = 1; v <= MAX_PG_SH; v++) {
        // Codex (P2): pedido não pago ou cancelado NÃO desce pro Bling — cobrá-lo seria
        // alarme falso. Pede o status junto e filtra abaixo.
        const q = 'time_range_field=create_time&time_from=' + ini + '&time_to=' + fimJ + '&page_size=100&response_optional_fields=order_status' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const r = await pedirAoSync('shopee-raw', { caminho: '/api/v2/order/get_order_list', q });
        const cru = r && r.dados && r.dados.resposta;
        const resp = cru && cru.response;
        // Codex (P1): erro do proxy/da Shopee NÃO pode virar lista vazia — vazio seria
        // lido como "o marketplace não vendeu nada", que é o oposto do que aconteceu.
        if (!resp) throw new Error('Shopee não respondeu: ' + String((cru && (cru.error || cru.message)) || (r && r.erro) || 'sem resposta').slice(0, 120));
        // Codex (P1): INVOICE_PENDING é pedido PAGO esperando nota — ele PRECISA estar no
        // Bling justamente pra ser faturado. Excluir escondia a queda de integração no estado
        // mais comum da madrugada, que é exatamente o cenário que este canário existe pra pegar.
        const FORA_SH = ['UNPAID', 'CANCELLED'];
        for (const o of (resp.order_list || [])) {
          if (!o || !o.order_sn) continue;
          if (FORA_SH.indexOf(String(o.order_status || '').toUpperCase()) >= 0) continue;
          ids.push(String(o.order_sn));
        }
        cursor = resp.next_cursor || '';
        if (!resp.more || !cursor) break;
        // Codex (P1): teto atingido com "more" ainda ligado = truncado
        if (v === MAX_PG_SH) return { incompleto: true, motivo: 'Shopee com mais de ' + (MAX_PG_SH * 100) + ' pedidos na janela' };
        await new Promise(r2 => setTimeout(r2, 200));
      }
    }
    return ids;
  }
  if (canal === 'tiktok') {
    let tk = null;
    try { tk = require('../tiktok-oauth'); } catch (e) { return null; }
    if (!tk || typeof tk.chamar !== 'function' || !tk.lerToken || !tk.lerToken('amb')) return null;
    const ids = [];
    let pageToken = '';
    const MAX_PG_TK = 100;
    for (let v = 1; v <= MAX_PG_TK; v++) {
      const r = await tk.chamar('/order/202309/orders/search',
        Object.assign({ page_size: '50' }, pageToken ? { page_token: pageToken } : {}),
        { metodo: 'POST', body: { create_time_ge: deTs, create_time_lt: ateTs } }, 'amb');
      // Codex (P1): erro do TikTok pode vir COM `data` preenchido — aceitar isso lia
      // lista vazia como sucesso. A lib do financeiro exige ok + code 0; aqui idem.
      if (!r || !r.ok || !r.corpo || r.corpo.code !== 0) {
        throw new Error('TikTok não respondeu: ' + String((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http))).slice(0, 120));
      }
      const d = r.corpo.data || {};
      const FORA_TK = ['UNPAID', 'CANCELLED'];
      for (const o of (d.orders || [])) {
        if (!o || !o.id) continue;
        if (FORA_TK.indexOf(String(o.status || '').toUpperCase()) >= 0) continue;
        ids.push(String(o.id));
      }
      pageToken = d.next_page_token || '';
      if (!pageToken) break;
      if (v === MAX_PG_TK) return { incompleto: true, motivo: 'TikTok com mais de ' + (MAX_PG_TK * 50) + ' pedidos no período' };
      await new Promise(r2 => setTimeout(r2, 200));
    }
    return ids;
  }
  return null;   // ML entra quando tiver listagem própria aqui
};

// Codex (P1 do #104): sem isto o canário só existiria se alguém lembrasse de abrir a URL —
// e o objetivo é justamente avisar sozinho. A noturna passa a rodar a conferência.
// Codex (#105): a trava vivia só na ROTA, e a noturna chama esta função direto — se um
// backfill estivesse rodando, a etapa noturna passava por fora e brigava pela cota do Bling.
// Além disso a checagem era de mão única: começado o canário, nada impedia um backfill de
// entrar por cima. Agora o estado é COMPARTILHADO e vale para os dois lados.
// Codex: com booleano, duas execuções sobrepostas (rota + noturna) entravam e a primeira a
// terminar liberava a trava enquanto a outra ainda consultava. Contador resolve.
const _canario = { ativos: 0, desde: null };
Object.defineProperty(_canario, 'rodando', { get() { return this.ativos > 0; } });

// Codex (#105): o cache do TikTok só era escrito pela rota admin — envelhecia sozinho e
// levava junto a tarifa real e a hora da venda. A noturna passa a atualizá-lo.
async function coletarFinanceiroTikTok(dias) {
  const finLib = require('../lib/tiktok-financeiro');
  const fs2 = require('fs'), path2 = require('path');
  let tk = null;
  try { tk = require('../tiktok-oauth'); } catch (e) { return { ok: true, pulado: 'módulo do TikTok indisponível', pedidos_novos: 0, guardados: 0 }; }
  if (!tk || typeof tk.chamar !== 'function' || !tk.lerToken || !tk.lerToken('amb')) {
    return { ok: true, pulado: 'TikTok não conectado nesta empresa', pedidos_novos: 0, guardados: 0 };
  }
  const ctxFin = {
    CACHE_DIR: process.env.TIKTOK_CACHE_DIR || '/data', path: path2,
    readJson: (a, p) => { try { return JSON.parse(fs2.readFileSync(a, 'utf8')); } catch (e) { return p; } },
    writeJson: (a, v) => { try { fs2.mkdirSync(path2.dirname(a), { recursive: true }); } catch (e) {} fs2.writeFileSync(a, JSON.stringify(v, null, 2)); },
    chamar: tk.chamar
  };
  return finLib.coletarFinanceiro(ctxFin, 'amb', dias || 35, {});
}

async function conferirMarketplaces(dias, canais, opts) {
  const anoR = (typeof _backfillAno !== 'undefined') && _backfillAno && _backfillAno.rodando;
  if ((_backfill && _backfill.rodando) || anoR) {
    return { ok: false, erro: 'tem backfill rodando — os dois brigam pela cota do Bling (429). Espere terminar.',
      backfill: { de: _backfill && _backfill.de, ate: _backfill && _backfill.ate, do_ano: !!anoR } };
  }
  const canLib = require('../lib/canario-marketplace');
  _canario.ativos++; _canario.desde = _canario.desde || new Date().toISOString();
  try {
    return await canLib.conferir({ empresa: 'amb', listarNoBling: _listarNoBlingCanario, listarNoMarketplace: _listarNoMarketplaceCanario },
      dias || 3, Array.isArray(canais) ? canais : [], opts || {});
  } finally {
    _canario.ativos = Math.max(0, _canario.ativos - 1);
    if (!_canario.ativos) _canario.desde = null;
  }
}


// ── COMPLETAR A TARIFA DO TIKTOK SEM BACKFILL (18/08) ───────────────────────────
// Venda recente entra com a tarifa do BLING porque a liquidação do TikTok demora dias.
// Antes, corrigir exigia rodar o backfill do período inteiro (horas, apaga e regrava, já
// custou dado perdido 2×). Isto atualiza SÓ comissao/frete/margem das linhas defasadas.
async function completarTarifaTikTok(dias, opts) {
  const compLib = require('../lib/tiktok-completar');
  const fs2 = require('fs'), path2 = require('path');
  const arq = path2.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_amb.json');
  const lerFinanceiro = () => { try { return (JSON.parse(fs2.readFileSync(arq, 'utf8')) || {}).pedidos || {}; } catch (e) { return {}; } };
  const r = await compLib.completarTarifas({ empresa: 'amb', supaReq, lerFinanceiro }, dias, opts || {});
  // Codex (#123): sem limpar o cache do histórico, o painel seguia mostrando a tarifa antiga
  // por até 30 min e a correção parecia não ter funcionado — como já fazem o backfill e a
  // reaplicação de imposto.
  if (r && r.ok && !r.simulacao && r.linhas_atualizadas) {
    try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {}
  }
  return r;
}

const _noturna = criarNoturna({
  // 10/08 (Codex P2): o canário PRECISA do contexto — sem ele, rotasCanario(undefined)
  // explodia no destructure, o catch engolia, e a etapa noturna dizia "conferido"
  // sem ter conferido NADA. (A Girassol tem o mesmo defeito — consertar lá também.)
  mlBillingSync, backfillVendas, mlSyncFees, varrerCancelados,
  canarioCron: () => canarioCron({ VERSAO, validarSessao }),
      // AMB: a poda do bucket de expedição roda UMA vez, na noturna da Girassol (bucket é compartilhado)
      podarExpedicao: async () => ({ ok: true, pulado: 'poda do bucket roda na noturna da Girassol' }),
  // 06/08: a Shopee tambem passa a se manter sozinha — devolucoes (por SKU e motivo) e
  // carteira (ads, ajustes, reembolsos), as duas em janelas de 15 dias, guardando no disco.
  coletarDevolucoes: (d) => coletarDevolucoes(d || 45, pedirAoSync),
  conferirMarketplaces,   // 17/08: canário marketplace × Bling também na AMB
  completarTarifaTikTok,   // 18/08: corrige a tarifa das vendas que já liquidaram
  coletarFinanceiroTikTok,   // Codex #123 (P1): sem passar aqui, a etapa de coleta da noturna era PULADA na AMB e o cache nunca se atualizava sozinho
  coletarAds,   // 14/08: ads da Shopee também se mantém sozinho
  coletarCarteira:   (d) => coletarCarteira(d || 30, pedirAoSync),
  VERSAO, validarSessao, ehAdmin, json
});

function routes(readBody) {

  // histórico/análise: histCache vai por REFERÊNCIA — o backfill e o /backfill-limpar
  // esvaziam esse mesmo objeto aqui no index e isso tem que valer lá dentro também.
  const hist = rotasHistorico({ validarSessao, supaCfg, DEFAULT_ALIQ_BK, histCache: _histCache });
  const pesca = rotasPescaria({ validarSessao, supaCfg, supaReq, pescarDadosML });
  const canario = rotasCanario({ VERSAO, validarSessao });
  const limpeza = rotasLimpeza({ validarSessao });
  const shopee = rotasShopee({ validarSessao });

  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ── GUARDA DE SESSÃO ────────────────────────────────────────────────
    // Rotas públicas (tela de login precisa delas) e as já cobertas pela trava
    // central do index.js (ADMIN_KEY: /run,/setup,/debug,/robo,/forcar) passam.
    // Todo o RESTO (dados de pedido, DANFE, XML, separação, ações) exige sessão.
    {
      const _meu = p.startsWith('/amb-checkout-offline'); // guarda só age nas rotas DESTE módulo
      const _pub = (
        p === '/amb-checkout-offline' || p === '/amb-checkout-offline/' ||
        p === '/amb-checkout-offline/painel' || p === '/amb-checkout-offline/login' ||
        p === '/amb-checkout-offline/operadores' || p === '/amb-checkout-offline/health' ||
        p === '/amb-checkout-offline/saude' || p.includes('/callback') ||
        p === '/amb-checkout-offline/qz-cert' || p === '/amb-checkout-offline/qz-sign' ||
        p === '/amb-checkout-offline/shopee-semear' ||   // semear cookie da sessao (auth propria por ?k=)
        p === '/amb-checkout-offline/shopee-devolucao' ||   // devolucao entregue? (auth propria por ?k= ou sessao admin)
        p === '/amb-checkout-offline/sonda-un' ||   // sonda de unidade de negócio (auth própria por ?k=)
        p === '/amb-checkout-offline/dashboard' ||   // Codex PR#38: auth PRÓPRIA na rota (sessão ADMIN ou ?k=) — o gate barrava o ?k= sem cookie
        p === '/amb-checkout-offline/historico' ||   // Codex PR#38 P1/P2: auth própria em camadas (admin completo / operador stripado / anônimo só com k)
        p === '/amb-checkout-offline/ml-billing-resumo'   // Codex PR#38: auth própria (admin)
      );
      const _central = (
        p.includes('/run') || p.includes('/setup') || p.includes('/robo') ||
        p.includes('/forcar') || /debug/i.test(p)
      );
      if (_meu && !_pub && !_central) {
        const _op = validarSessao(req.headers['cookie']);
        if (!_op) {
          // Codex PR#38 (2ª rodada): a ADMIN_KEY vale como credencial já no gate — o fluxo
          // ?k= do dashboard chama /historico-longo, /previsao-vendas, /plano-compra, /sku-info
          // etc., e todas morriam aqui no 401 antes de a guarda admin própria delas avaliar a
          // chave. Cada rota de dados continua revalidando (chave OU sessão admin) por conta.
          const _kG = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
          if (process.env.ADMIN_KEY && _kG === process.env.ADMIN_KEY) { req._op = 'admin-key'; }
          else { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
        } else { req._op = _op; }
      }
    }

    // ── SONDA DE UNIDADE DE NEGÓCIO (temporária, diagnóstico) ───────────
    // Objetivo: descobrir ONDE, no JSON do pedido da API do Bling, aparece a
    // unidade de negócio (Shopee FULL vs Matriz) — se vem na LISTA de pedidos
    // ou só no DETALHE. Sem isso, não dá pra escrever o filtro com segurança.
    // Uso: /amb-checkout-offline/sonda-un?k=ADMIN_KEY[&id=NUMERO_DO_PEDIDO]
    if (method === 'GET' && p === '/amb-checkout-offline/sonda-un') {
      const k = urlObj.searchParams.get('k') || '';
      if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }

      const out = { ok: true, versao: 'sonda-un v5' };
      out.env_AMBBKP_UN_FULL = process.env.AMBBKP_UN_FULL || '(vazia)';

      // 1) O que o listarAtendidos COM FILTRO devolve agora (é o que o ciclo usa)
      try {
        const r = await listarAtendidos();
        out.listarAtendidos = {
          bling_ok: r.ok,
          completa: r.completa,
          pedidos_apos_filtro: (r.pedidos || []).length,
          ocultosFull: r.ocultosFull || 0,
          idsFullVistos: r.idsFullVistos || [],
          numeros_apos_filtro: (r.pedidos || []).map(p => p.numero)
        };
      } catch (e) { out.listarAtendidos = { erro: String(e.message || e) }; }

      // 2) O que está no CACHE agora (é o que a tela do estoquista mostra)
      try {
        const man = manifest();
        const ids = Object.keys(man);
        out.cache = {
          total_no_cache: ids.length,
          por_numero: ids.map(id => ({ id, numero: man[id] && man[id].numero, un_id: man[id] && man[id].un_id, tem_etiqueta: man[id] && man[id].tem_etiqueta })).sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0))
        };
      } catch (e) { out.cache = { erro: String(e.message || e) }; }

      // 3) Gatilho opcional: /sonda-un?k=...&expurgar=1 roda o ciclo AGORA
      //    (filtro + expurgo) e relê o cache, pra você ver o antes/depois.
      // 4) DUMP CRU: o item exato que o listarAtendidos vê (mesma query,
      //    limite=100). É aqui que descobrimos se unidadeNegocio vem na lista.
      try {
        const hoje = new Date(); const ini = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
        const qs = `idSituacao=${SIT_ATENDIDO}&dataEmissaoInicial=${dataISO(ini)}&dataEmissaoFinal=${dataISO(hoje)}`;
        const r = await blingGet(`/pedidos/vendas?${qs}&pagina=1&limite=100`);
        const arr = (r && r.data && r.data.data) || [];
        // acha um dos 5 Full pelo número, e mostra o item BRUTO inteiro
        const alvos = ['2594', '2590', '2588', '2579', '2577'];
        const full = arr.find(p => alvos.includes(String(p.numero)));
        out.dump_lista_limite100 = {
          total_na_pagina: arr.length,
          numeros_na_pagina: arr.map(p => p.numero),
          achou_full: !!full,
          full_numero: full ? full.numero : null,
          full_keys: full ? Object.keys(full) : null,                    // as chaves REAIS do objeto
          full_json: full ? JSON.stringify(full) : null,                 // o objeto serializado, sem ambiguidade
          full_unidadeNegocio_direto: full ? full.unidadeNegocio : 'sem full'
        };
      } catch (e) { out.dump_lista_limite100 = { erro: String(e.message || e) }; }

      // 5) TESTE DEFINITIVO: o código-fonte REAL da listarAtendidos que está
      //    carregada na memória do processo. Se não tiver "idsFullVistos", o
      //    servidor está rodando uma versão ANTIGA do ciclo.js (módulo em
      //    cache), apesar do arquivo no disco estar certo.
      try {
        const fonte = listarAtendidos.toString();
        out.funcao_em_memoria = {
          tem_filtro_full: fonte.includes('idsFullVistos'),
          tem_AMBBKP_UN_FULL: fonte.includes('AMBBKP_UN_FULL'),
          tamanho_chars: fonte.length,
          // primeiros e últimos trechos pra eu comparar de olho
          inicio: fonte.slice(0, 120),
          fim: fonte.slice(-200)
        };
      } catch (e) { out.funcao_em_memoria = { erro: String(e.message || e) }; }

      // 6) POR QUE FILTRA 0: replica a query e o filtro, pedido a pedido,
      //    mostrando o que o filtro enxerga em cada um.
      try {
        const hoje = new Date(); const ini = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
        const qs = `idSituacao=${SIT_ATENDIDO}&dataEmissaoInicial=${dataISO(ini)}&dataEmissaoFinal=${dataISO(hoje)}`;
        const acc = [];
        for (let pg = 1; pg <= 50; pg++) {
          const r = await blingGet(`/pedidos/vendas?${qs}&pagina=${pg}&limite=100`);
          const lst = (r && r.data && r.data.data) || [];
          if (!r || !r.ok) break;
          acc.push(...lst);
          if (lst.length < 100) break;
        }
        const UN_FULL = String(process.env.AMBBKP_UN_FULL || '').split(',').map(s => s.trim()).filter(Boolean);
        const setFull = new Set(UN_FULL);
        out.replay_filtro = {
          total_paginado: acc.length,
          UN_FULL_lido: UN_FULL,
          por_pedido: acc.map(p => {
            const raw = p.unidadeNegocio && p.unidadeNegocio.id;
            const un = String(raw || '');
            return { numero: p.numero, un_raw: raw ?? null, un_str: un, bate: un && setFull.has(un) };
          })
        };
      } catch (e) { out.replay_filtro = { erro: String(e.message || e) }; }

      if (urlObj.searchParams.get('expurgar') === '1') {
        try {
          await rodarCiclo('sonda-expurgo');
          const man2 = manifest();
          out.apos_expurgo = {
            total_no_cache: Object.keys(man2).length,
            numeros: Object.keys(man2).map(id => man2[id] && man2[id].numero).sort((a, b) => Number(a || 0) - Number(b || 0))
          };
        } catch (e) { out.apos_expurgo = { erro: String(e.message || e) }; }
      } else {
        out.dica = 'Para rodar o ciclo (filtro + expurgo) agora e ver o resultado, acrescente &expurgar=1 nesta mesma URL.';
      }

      json(res, 200, out);
      return true;
    }

    // raiz do módulo → manda pro painel (evita "not found" ao abrir a URL base)
    if (method === 'GET' && (p === '/amb-checkout-offline' || p === '/amb-checkout-offline/')) {
      res.writeHead(302, { Location: '/amb-checkout-offline/painel' });
      res.end();
      return true;
    }

    // ── IR PRO PEDIDO NA SHOPEE (b17) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env AMBBKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    if (method === 'GET' && p === '/amb-checkout-offline/ir-shopee') {
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
          passosIr.push({ passo: 'cookie', erro: 'sem cookie: env AMBBKP_SHOPEE_COOKIE vazia e nada gravado no disco' });
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

    // ── SEMEAR SESSÃO SHOPEE (b22) — cola o cURL (ou só o trecho do
    // Cookie:) da chamada que FUNCIONA no seu navegador, e o servidor
    // extrai o cookie e grava no jar. Serve pros cookies HttpOnly
    // (SPC_ST etc.) que a captura manual pra env AMBBKP_SHOPEE_COOKIE
    // nao pega. Guarda: ?k=ADMIN_KEY. POST body {curl:"..."} OU {cookie:"..."}.
    if (method === 'POST' && p === '/amb-checkout-offline/shopee-semear') {
      const kSe = String((urlObj.searchParams && urlObj.searchParams.get('k')) || '');
      if (!process.env.ADMIN_KEY || kSe !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      let bodySe = {}; try { const _rb = await readBody(req); bodySe = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}
      let bruto = String(bodySe.cookie || bodySe.curl || '').trim();
      if (!bruto) { json(res, 400, { ok: false, erro: 'faltou {cookie:"..."} ou {curl:"..."} no corpo' }); return true; }
      // aceita o cURL inteiro: pega o valor de -H 'Cookie: ...' (aspa simples ou dupla)
      let ck = bruto;
      const mCk = bruto.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i);
      if (mCk) ck = mCk[1];
      ck = ck.replace(/^cookie:\s*/i, '').trim();
      const nomes = [...new Set((ck.match(/(?:^|;\s*)([A-Za-z0-9_]+)=/g) || []).map(x => x.replace(/[;=\s]/g, '')))];
      const temST = /(?:^|;\s*)SPC_ST=/.test(ck);
      if (!temST) { json(res, 400, { ok: false, erro: 'o cookie colado NAO tem SPC_ST — cole o da chamada de return que funciona (com HttpOnly)', nomes }); return true; }
      const novo = { cookie: ck, semente: _shopeeHash(ck), origem: 'semeado', atualizado: new Date().toISOString(), renovacoes: 0 };
      try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) { json(res, 500, { ok: false, erro: 'falhou ao gravar o jar: ' + String(e && e.message || e) }); return true; }
      json(res, 200, { ok: true, gravado: true, tam_cookie: ck.length, tem_SPC_ST: true, cookies: nomes.length, nomes, versao: VERSAO });
      return true;
    }

    // ── DEVOLUÇÃO SHOPEE: entregue? quando? (b20 — fase 2 do bloco ─────
    // vermelho do Devoluções da AMB). Lê o Seller Center com o MESMO
    // cookie/jar do ir-shopee: histórico da logística REVERSA
    // (/api/v1/return/reverse_logistics_tracking_history) — é onde mora
    // o "Pedido devolvido dd/mm hh:mm" da página da solicitação.
    // Aceita ?rid=<id_interno> (o número da URL do portal) OU
    // ?rsn=<numero_da_solicitacao> (tenta resolver o id via detail).
    // Guarda: ?k=ADMIN_KEY OU sessão de admin do checkout. &diag=1 = passos.
    // Entregue é terminal → cache permanente em _shopee-devolucoes.json.
    if (method === 'GET' && p === '/amb-checkout-offline/shopee-devolucao') {
      const kSd = String((urlObj.searchParams && urlObj.searchParams.get('k')) || '');
      const opSd = validarSessao(req.headers['cookie']);
      const podeSd = (process.env.ADMIN_KEY && kSd === process.env.ADMIN_KEY) || (opSd && ehAdmin(opSd));
      if (!podeSd) { json(res, 404, { error: 'not found' }); return true; }

      const ridQ = String((urlObj.searchParams && urlObj.searchParams.get('rid')) || '').trim();
      const rsnQ = String((urlObj.searchParams && urlObj.searchParams.get('rsn')) || '').trim().toUpperCase();
      const diagSd = ((urlObj.searchParams && urlObj.searchParams.get('diag')) || '') === '1';
      if (!ridQ && !rsnQ) { json(res, 400, { ok: false, erro: 'faltou ?rid= (id interno da URL do portal) ou ?rsn= (numero da solicitacao)' }); return true; }

      const ARQ_DEV = path.join(CACHE_DIR, '_shopee-devolucoes.json');
      const mapaSd = readJson(ARQ_DEV, {}) || {};
      const passosSd = [];
      let rid = ridQ || (rsnQ ? (mapaSd['rsn:' + rsnQ] || null) : null);
      if (!ridQ && rid) passosSd.push({ passo: 'cache-rsn', rid });

      const jaSd = rid && mapaSd[rid];
      if (jaSd && jaSd.entregue && !diagSd) { json(res, 200, { ok: true, origem: 'cache', rid, rsn: rsnQ || null, entregue: true, entregue_em: jaSd.entregue_em || null, versao: VERSAO }); return true; }

      try {
        const sessSd = shopeeSessaoLer();
        const ckSd = sessSd.cookie;
        if (!ckSd) {
          passosSd.push({ passo: 'cookie', erro: 'sem cookie: env ' + SHOPEE_ENV_COOKIE + ' vazia e nada gravado no disco' });
        } else {
          const cdsSd = (ckSd.match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
          // b21 - os endpoints de DEVOLUCAO exigem o token anti-CSRF
          // (errcode 2 "token not found" com cookie vivo): o valor do
          // cookie csrftoken repetido no cabecalho X-CSRFToken. Os de
          // pedido (ir-shopee) nunca cobraram; os de return cobram.
          const csrfSd = (ckSd.match(/(?:^|;\s*)csrftoken=([^;]+)/i) || [])[1] || '';
          passosSd.push({ passo: 'preparo', tem_cds: !!cdsSd, tem_csrf: !!csrfSd, tam_cookie: ckSd.length, origem_cookie: sessSd.origem || null });
          const cabSd = {
            'Cookie': ckSd,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://seller.shopee.com.br/portal/sale/return',
            'X-Api-Src-List': 'pc',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
          };
          if (csrfSd) cabSd['X-CSRFToken'] = csrfSd;

          if (!rid && rsnQ) {
            const urlDet = 'https://seller.shopee.com.br/api/v3/return/detail'
              + '?SPC_CDS=' + encodeURIComponent(cdsSd) + '&SPC_CDS_VER=2'
              + '&return_sn=' + encodeURIComponent(rsnQ) + '&language=pt-br';
            const rDet = await fetch(urlDet, { headers: cabSd });
            const tDet = await rDet.text();
            shopeeSessaoAtualiza(rDet);
            let jDet = null; try { jDet = JSON.parse(tDet); } catch (e) {}
            let achouSd = null;
            (function varre(o, prof) {
              if (!o || typeof o !== 'object' || prof > 6 || achouSd) return;
              if (o.return_id != null) { achouSd = String(o.return_id); return; }
              if (o.returnid != null) { achouSd = String(o.returnid); return; }
              Object.keys(o).forEach(k2 => { if (o[k2] && typeof o[k2] === 'object') varre(o[k2], prof + 1); });
            })(jDet, 0);
            passosSd.push({ passo: 'resolver-rsn', status: rDet.status, rid_achado: achouSd, corpo: achouSd ? undefined : tDet.slice(0, 500) });
            if (achouSd) { rid = achouSd; mapaSd['rsn:' + rsnQ] = rid; try { ensureDir(CACHE_DIR); writeJson(ARQ_DEV, mapaSd); } catch (e) {} }
          }

          if (rid) {
            const urlHist = 'https://seller.shopee.com.br/api/v1/return/reverse_logistics_tracking_history/'
              + '?SPC_CDS=' + encodeURIComponent(cdsSd) + '&SPC_CDS_VER=2'
              + '&log_id=1&return_id=' + encodeURIComponent(rid);
            const rH = await fetch(urlHist, { headers: cabSd });
            const tH = await rH.text();
            shopeeSessaoAtualiza(rH);
            let jH = null; try { jH = JSON.parse(tH); } catch (e) {}

            const eventosSd = [];
            (function varre(o, prof) {
              if (!o || prof > 7) return;
              if (Array.isArray(o)) { o.forEach(x => varre(x, prof + 1)); return; }
              if (typeof o !== 'object') return;
              const t2 = o.ctime || o.time || o.timestamp || o.update_time || o.create_time || null;
              const d2 = o.description || o.desc || o.message || o.text || o.status_text || null;
              if (t2 && d2) eventosSd.push({ t: Number(t2), texto: String(d2) });
              Object.keys(o).forEach(k2 => varre(o[k2], prof + 1));
            })(jH, 0);
            eventosSd.sort((a, b) => b.t - a.t);
            const isoSd = t2 => { const n2 = Number(t2); const ms = n2 > 1e12 ? n2 : (n2 > 1e9 ? n2 * 1000 : NaN); const dt = new Date(ms); return isNaN(dt) ? null : dt.toISOString(); };
            const evSd = eventosSd.find(e => /devolvid|entregue|entregad|delivered|delivery.?done/i.test(e.texto)) || null;

            const outSd = { ok: rH.status === 200, http_historico: rH.status, rid, rsn: rsnQ || null,
              entregue: !!evSd, entregue_em: evSd ? isoSd(evSd.t) : null,
              ultimo_evento: eventosSd[0] ? { quando: isoSd(eventosSd[0].t), texto: eventosSd[0].texto.slice(0, 120) } : null,
              eventos: eventosSd.slice(0, 5).map(e => ({ quando: isoSd(e.t), texto: e.texto.slice(0, 120) })),
              origem_cookie: sessSd.origem || null, versao: VERSAO };
            passosSd.push({ passo: 'historico', status: rH.status, eventos: eventosSd.length, corpo: eventosSd.length ? undefined : tH.slice(0, 500) });
            if (outSd.entregue) { mapaSd[rid] = { entregue: true, entregue_em: outSd.entregue_em, ts: Date.now() }; try { ensureDir(CACHE_DIR); writeJson(ARQ_DEV, mapaSd); } catch (e) {} }
            if (diagSd) outSd.passos = passosSd;
            json(res, 200, outSd);
            return true;
          }
        }
      } catch (e) {
        passosSd.push({ passo: 'excecao', erro: String((e && e.message) || e).slice(0, 250) });
      }
      json(res, 200, { ok: false, rid: rid || null, rsn: rsnQ || null, erro: 'nao consegui ler a devolucao — veja os passos', passos: passosSd, versao: VERSAO });
      return true;
    }

    // SAÚDE DA SESSÃO SHOPEE (b18) — admin. Diz se o cookie está vivo, de onde ele
    // veio (env ou renovado sozinho) e quando foi atualizado pela última vez.
    if (method === 'GET' && p === '/amb-checkout-offline/shopee-sessao') {
      const opSh = validarSessao(req.headers['cookie']);
      if (!opSh || !ehAdmin(opSh)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const antes = shopeeSessaoLer();
      const teste = await shopeeKeepAlive();
      const dep   = shopeeSessaoLer();
      json(res, 200, {
        ok: !!teste.ok,
        empresa: 'amb-checkout-offline',
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
    if (method === 'POST' && p === '/amb-checkout-offline/ciclo-agora') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
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
    if (method === 'POST' && p === '/amb-checkout-offline/nf-anexar') {
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
      console.log(`[AMBBKP] NF ANEXADA na mão no pedido ${idN} (${pdfN ? 'PDF' : ''}${pdfN && xmlN ? '+' : ''}${xmlN ? 'XML' : ''}${numeroNF ? ', nº ' + numeroNF : ''}) por ${opN}`);
      // ev1 - registra a NF anexada no app DEVOLUCOES (pesquisavel pelo
      // nº da NF e tambem pelo pedido). Fire-and-forget, nunca atrapalha.
      try { require('../lib/avisar-devolucoes')('amb', 'nf_anexada', numeroNF || idN, { pedido: idN, chave: chaveNF || '', emissao: emissaoNF || '', quem: (typeof opN === 'string' ? opN : '') || '' }); } catch (e) {}
      json(res, 200, { ok: true, pdf: !!pdfN, xml: !!xmlN, nf_numero: numeroNF, chave: chaveNF, emissao: emissaoNF });
      return true;
    }

    if (method === 'POST' && p === '/amb-checkout-offline/etiqueta-anexar') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
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
      const _zipEntradas = buf => {   // lê pelo DIRETÓRIO CENTRAL (o zip vem em modo streaming, tamanhos zerados no header local)
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
        if (_outro !== alvoA && fs.existsSync(_outro)) { try { fs.unlinkSync(_outro); console.log(`[AMBBKP] etiqueta anexada substituiu a antiga (${path.basename(_outro)} apagada) no pedido ${idA}`); } catch (e) {} }
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
      console.log(`[AMBBKP] etiqueta ANEXADA na mão no pedido ${idA} (${formatoA.toUpperCase()}, ${conteudoA.length} bytes) por ${opSess}`);
      // ev1 - registra o anexo no app DEVOLUCOES (pesquisavel depois).
      // Fire-and-forget: se o servico estiver fora ou sem envs, nada muda aqui.
      try { require('../lib/avisar-devolucoes')('amb', 'etiqueta_anexada', idA, { formato: formatoA, quem: (typeof opSess === 'string' ? opSess : (opSess && (opSess.usuario || opSess.nome || opSess.login))) || '' }); } catch (e) {}
      json(res, 200, { ok: true, formato: formatoA, bytes: conteudoA.length });
      return true;
    }

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /amb-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.
    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/backfill-valores') {
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
    // Uso: /amb-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31
    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/backfill-detalhes') {
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
    if (method === 'POST' && p === '/amb-checkout-offline/sku-info') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
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
        // 29/07: se o cache é antigo (gravado antes do nome existir), refaz — senão o título nunca vinha
  if (!body.fresh && c && c.nome !== undefined && (Date.now() - (c.ts || 0)) < TTL && (c.custo != null || c.saldo != null)) {
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
      /* 21/08 — CUSTO MANUAL entra AQUI, atrás do Bling: só preenche o que o _custos.json não
         tem. Regra do Diego: "se o bling passar a ter custo, aí deixa mandar o Bling". */
      const _ccAll = comCustosManuais(readJson(path.join(CACHE_DIR, '_custos.json'), {}));
      const ids = {};
      const aResolver = [];
      for (const sku of faltam) {
        const k2 = _ccAll[sku];
        if (k2 && k2.id && (Date.now() - (k2.ts || 0)) < 7 * 24 * 3600 * 1000) { ids[sku] = { id: k2.id, nome: (k2.nome || null), preco: (k2.preco != null ? k2.preco : null), custo: (k2.custo != null ? k2.custo : null) }; }
        else aResolver.push(sku);
      }
      // 1) resolve SKU → produto — só quem NÃO está no cache permanente
      for (const sku of aResolver) {
        try {
          let prod = null;
          for (const v of [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])]) {
            const r = await bg(`/produtos?codigo=${encodeURIComponent(v)}&limite=10&criterio=5`);
            const it = escolherProdutoAtivo(r.ok && r.data && r.data.data, sku, null, 10);   // 19/08: nunca um cadastro excluído
            if (it && it.id) { const d = await bg(`/produtos/${it.id}`); prod = (d.ok && d.data && d.data.data) || it; break; }
            await new Promise(r0 => setTimeout(r0, 300));
          }
          if (prod && prod.id) {
            const forn = prod.fornecedor || {};
            // 19/08: mesma armadilha do custo-sync — num produto COM COMPOSIÇÃO o
            // `forn.precoCusto` do Bling não é o custo do kit (veio 20,40 num kit de 34,00).
            // Aqui não dá pra somar a composição (seria uma chamada por componente, e esta rota
            // é de resposta rápida), então o kit fica SEM custo por este caminho e quem resolve é
            // o custo-sync, que soma a estrutura. Melhor sem custo do que com custo errado.
            const _cmp = (prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens)) || prod.composicao || prod.componentes || null;
            const cand = (Array.isArray(_cmp) && _cmp.length) ? []
                       : [forn.precoCusto, forn.precoCompra, prod.precoCusto, prod.custo].map(Number).filter(v => isFinite(v) && v > 0);
            // 29/07: +nome. A rota nunca devolvia o NOME do produto, e por isso o dashboard não
            // conseguia preencher o título nos cartões de venda por esse caminho.
            ids[sku] = { id: prod.id, nome: (prod.nome || null), preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: cand.length ? cand[0] : null };
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
        const info = o2 ? { nome: (o2.nome || null), saldo: (saldos[o2.id] != null ? saldos[o2.id] : null), preco: o2.preco, custo: o2.custo, ts: Date.now() }
                        : { saldo: null, preco: null, custo: null, ts: Date.now() };
        // b20: o banco PERMANENTE (_custos.json) é SOBERANO — falha de consulta (429 do Bling) nunca mais
        // apaga um custo conhecido. Foi o que sumiu custos da tela em 22/07 (tempestade do re-cache SCHEMA 5).
        if (info.custo == null) { const kP = _ccAll[sku]; if (kP && kP.custo != null) { info.custo = kP.custo; if (info.preco == null && kP.preco != null) info.preco = kP.preco; } }
        const c0 = _skuInfoCache[sku];
        if (info.custo == null && c0 && c0.custo != null) info.custo = c0.custo;   // e o valor antigo do cache de 6h também vale mais que um null novo
        _skuInfoCache[sku] = info; out[sku] = info;
      }
      if (faltam.length) { try { writeJson(CACHE_SKUINFO, _skuInfoCache); } catch (e) {} }
      json(res, 200, { ok: true, skus: out, consultados_agora: faltam.length, resolvidos: Object.keys(ids).filter(k2 => ids[k2]).length, nao_resolvidos: resolveFalhas });
      return true;
    }

    // DASHBOARD — página (amb-dashboard.html do módulo)
    if (method === 'GET' && p === '/amb-checkout-offline/dashboard') {
      // NUNCA estoquista (pedido do Diego, 11/08): a página exige ADMIN — sessão de admin
      // logado OU ?k=ADMIN_KEY. Não-admin volta pro painel, sem alarde (302).
      const sD = validarSessao(req.headers['cookie']);
      const kD = urlObj.searchParams.get('k') || '';
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sD && ehAdmin(sD)))) { res.writeHead(302, { Location: '/amb-checkout-offline/painel' }); res.end(); return true; }
      const fdash = path.join(__dirname, 'amb-dashboard.html');
      if (!fs.existsSync(fdash)) { json(res, 404, { ok: false, erro: 'dashboard ainda não habilitado nesta empresa' }); return true; }
      try { const htmlContent = fs.readFileSync(fdash, 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(htmlContent); }
      catch (e) { json(res, 500, { erro: 'dashboard.html: ' + e.message }); }
      return true;
    }

    // DASHBOARD (sessão admin): dispara o backfill-NF local ao abrir o dashboard — mantém os números sempre frescos
    if (method === 'POST' && p === '/amb-checkout-offline/backfill-nf-auto') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      json(res, 200, { ok: true, ...backfillNFLocal(45) });
      return true;
    }

    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /amb-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)
    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/backfill-nf') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessB && ehAdmin(sessB)))) { json(res, 404, { error: 'not found' }); return true; }
      const r = backfillNFLocal(urlObj.searchParams.get('dias'));
      json(res, 200, { ok: true, ...r,
        mensagem: r.preenchidos_pela_nf ? ('✓ ' + r.preenchidos_pela_nf + ' pedido(s) ganharam produtos/frete EXATOS da nota (leitura local, sem API)') : 'nada novo a preencher' });
      return true;
    }

    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal
    if ((method === 'GET' || method === 'POST') && p === '/amb-checkout-offline/config-fiscal') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const CFG_FILE = path.join(CACHE_DIR, '_config-fiscal.json');
      if (method === 'GET') { json(res, 200, { ok: true, config: readJson(CFG_FILE, { aliquotas: {}, taxas: {} }) }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const atual = readJson(CFG_FILE, { aliquotas: {}, taxas: {} });
      const _aliqAntes = Object.assign({}, atual.aliquotas || {});   // 01/08: p/ saber o que mudou
      // ⚠️ 19/08 — MESMO BUG DA GIRASSOL: campo em BRANCO chega como `null`, e `Number(null)` é 0,
      // que passa em `isFinite && >=0` ANTES do teste de null — deixar um mês vazio no ⚙️ e salvar
      // gravava **0%**, e alíquota zero salva vence o padrão, zerando o imposto do mês no histórico.
      if (body.aliquotas && typeof body.aliquotas === 'object') for (const [k2, v2] of Object.entries(body.aliquotas)) {
        if (!/^\d{4}-\d{2}$/.test(k2)) continue;
        if (v2 === null || v2 === '' || v2 === undefined) { delete atual.aliquotas[k2]; continue; }
        const n2 = Number(v2);
        if (isFinite(n2) && n2 > 0 && n2 <= 40) atual.aliquotas[k2] = n2;
        else if (isFinite(n2) && n2 === 0) delete atual.aliquotas[k2];   // 0% = campo vazio, não configuração
      }
      if (body.taxas && typeof body.taxas === 'object') for (const [k2, v2] of Object.entries(body.taxas)) { const n2 = Number(v2); if (isFinite(n2) && n2 >= 0 && n2 <= 50) atual.taxas[String(k2).toLowerCase()] = n2; else if (v2 === null) delete atual.taxas[String(k2).toLowerCase()]; }
      if (body.flex && typeof body.flex === 'object') { atual.flex = atual.flex || {}; for (const [k2, v2] of Object.entries(body.flex)) { const n2 = Number(v2); if (['ml', 'shopee', 'outros', 'geral'].indexOf(k2) >= 0 && isFinite(n2) && n2 >= 0 && n2 <= 100) atual.flex[k2] = n2; else if (v2 === null) delete atual.flex[k2]; } }
      // 05/08 (b115): CIÊNCIA da alíquota herdada. Quando um mês não tem alíquota própria
      // (set-dez/26 estão zerados), o dashboard herda a do último mês conhecido pra não
      // calcular imposto ZERO — mas isso é aproximação, e aproximação silenciosa vira erro.
      // Então o painel mostra um aviso no topo e o Diego dá CIÊNCIA aqui, com carimbo de
      // quem e quando. Se o mês de origem mudar, a ciência daquele mês cai e o aviso volta.
      if (body.ciencia_aliq && typeof body.ciencia_aliq === 'object') {
        atual.ciencia_aliq = atual.ciencia_aliq || {};
        for (const [k2, v2] of Object.entries(body.ciencia_aliq)) {
          if (!/^\d{4}-\d{2}$/.test(k2)) continue;
          if (v2 === null) { delete atual.ciencia_aliq[k2]; continue; }
          if (!/^\d{4}-\d{2}$/.test(String(v2))) continue;
          atual.ciencia_aliq[k2] = { de: String(v2), em: new Date().toISOString(), por: (opSess && (opSess.usuario || opSess.nome)) || 'admin' };
        }
      }
      writeJson(CFG_FILE, atual);
      // b42 — BUG QUE FAZIA O ⚙️ DIZER "✗ falhou": a resposta usava `_mudou` ANTES da
      // declaração `let _mudou` que vinha 8 linhas abaixo. Em JS isso é ReferenceError
      // ("Cannot access before initialization"), não undefined — a rota explodia DEPOIS
      // do writeJson: a config ficava SALVA no disco e o navegador recebia erro, e nenhum
      // mês era reaplicado. (Mesmo defeito existe na GIRASSOL — portar o conserto.)
      // Agora: calcula o que mudou, RESPONDE, e só então dispara o resto.
      let _mudou = [];
      try {
        // 19/08 (Codex P2): mês APAGADO nunca era reaplicado — o Supabase seguia com o imposto do
        // valor removido, e quem lê a margem GRAVADA (previsão de vendas) continuava com o número
        // velho. Cobre a união das chaves de antes e de depois, como na Girassol.
        for (const _m of new Set([].concat(Object.keys(_aliqAntes || {}), Object.keys(atual.aliquotas || {}))))
          if (Number(_aliqAntes[_m]) !== Number((atual.aliquotas || {})[_m])) _mudou.push(_m);
        _mudou = _mudou.filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
      } catch (e) {}
      json(res, 200, { ok: true, config: atual, reaplicando: _mudou });
      // 01/08: editou alíquota/taxa → limpa o cache do histórico na hora, senão o Mês/Ano
      // continuaria servindo o agregado de até 30 min atrás e pareceria que "não pegou".
      try { const _nk = Object.keys(_histCache).length;
            for (const _k of Object.keys(_histCache)) delete _histCache[_k];
            if (_nk) console.log('[FISCAL] config salva — cache do histórico limpo (' + _nk + ')'); } catch (e) {}
      // e REAPLICA nas linhas já gravadas do Supabase, só nos meses que mudaram de verdade.
      // Roda em background: a resposta já foi, e o dashboard acompanha pelo /reaplicar-status.
      try {
        if (_mudou.length) { console.log('[FISCAL] alíquota mudou em: ' + _mudou.join(', ') + ' — reaplicando no histórico');
                             reaplicarImposto(_mudou, 'amb').catch(e => console.log('[FISCAL] ✗ ' + e.message)); }
      } catch (e) {}
      return true;
    }

    // DASHBOARD (sessão admin): TARIFA REAL do Mercado Livre p/ um pedido (sale_fee da API), com cache permanente
    if (method === 'POST' && p === '/amb-checkout-offline/ml-fee') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const orderId = String(body.numeroLoja || '').replace(/\D/g, '');
      if (!orderId) { json(res, 200, { ok: false, erro: 'numeroLoja vazio' }); return true; }
      const FEE_FILE = path.join(CACHE_DIR, '_mlfees.json');
      const cacheF = readJson(FEE_FILE, {});
      if (cacheF[orderId] && cacheF[orderId].fee != null) { json(res, 200, { ok: true, fee: cacheF[orderId].fee, itens: cacheF[orderId].itens, fonte: 'cache' }); return true; }
      try {
        const { garantirTokenML } = require('../ambtotal/mlTokenManager');
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
    // Uso: /amb-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso
    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/ml-sync-fees') {
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
    if (method === 'GET' && p === '/amb-checkout-offline/debug-cobertura') {
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

    // LIMPA toda a tabela (empresa amb) — pra recomeçar o backfill do zero. Uso: /amb-checkout-offline/backfill-limpar
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-limpar') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      if (_backfill.rodando) { json(res, 200, { ok: false, msg: 'tem um backfill rodando — espere terminar (ou reinicie o serviço) antes de limpar' }); return true; }
      const del = await supaReq('amb', 'DELETE', 'vendas_historico?empresa=eq.amb', null);
      json(res, 200, { ok: del.ok, status: del.status, msg: del.ok ? '✅ tabela zerada (empresa amb). Pode rodar o backfill do zero, mês a mês.' : '❌ falhou ao limpar: ' + ((del.body||del.erro||'')+'').slice(0,150) });
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X DO PEDIDO CRU do Bling — mostra TODAS as chaves e qualquer campo
    // com cara de data/hora, pra decidirmos com o payload real se o Bling guarda a hora da venda.
    // Uso: /amb-checkout-offline/debug-pedido?id=116063  (o nº que aparece na coluna Pedido)
    if (method === 'GET' && p === '/amb-checkout-offline/debug-pedido') {
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

    // CONFERE o que foi gravado no Supabase — conta registros por MÊS e por CANAL. Uso: /amb-checkout-offline/backfill-conferir
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-conferir') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const out = { ok: true, total: null, por_mes: {}, por_canal: {} };
      // Codex: com `&ano=`, só `por_mes` era filtrado — `total` e `por_canal` somavam TUDO,
      // e o retorno ficava impossível de reconciliar depois da virada de ano. Os três usam
      // esta janela; o acumulado geral continua em `total_todos_os_anos`.
      // ⚠️ tudo declarado AQUI, antes do primeiro uso: `const` lá embaixo seria TDZ — o lint
      // passa e a rota quebra só quando alguém chama. (Havia DUAS variáveis de ano fazendo a
      // mesma coisa depois de um push meu; ficou uma só.)
      const hojeC = new Date();
      const anoC = Number(urlObj.searchParams.get('ano')) || hojeC.getFullYear();
      const ehAnoAtual = (anoC === hojeC.getFullYear());
      const mesC = ehAnoAtual ? (hojeC.getMonth() + 1) : 12;
      const _faixaAno = 'data_venda=gte.' + anoC + '-01-01&data_venda=lte.' + anoC + '-12-31';
      out.ano = anoC;
      out.total = await supaCount('amb', _faixaAno);
      out.total_todos_os_anos = await supaCount('amb', '');
      // 17/08 — mesma correção já feita na Girassol (#94/#96): a lista de meses era FIXA até
      // julho, então agosto sumia do relatório e parecia buraco no histórico quando não era.
      // Ano vira parâmetro (&ano=), com padrão no corrente; o último dia sai do calendário
      // (fevereiro fixo em 28 perderia 29/02 em ano bissexto).
      // (ano, faixa e mês atual já definidos acima — `&ano=` vale para meses, total e canais)
      for (let mm = 1; mm <= mesC; mm++) {
        const m = anoC + '-' + String(mm).padStart(2, '0');
        const ultimoDoMes = new Date(Date.UTC(anoC, mm, 0)).getUTCDate();
        const fimM = (ehAnoAtual && mm === mesC) ? String(hojeC.getDate()).padStart(2, '0') : String(ultimoDoMes).padStart(2, '0');
        out.por_mes[m] = await supaCount('amb', 'data_venda=gte.' + m + '-01&data_venda=lte.' + m + '-' + fimM);
      }
      for (const c of ['ml','shopee','tiktok','magalu','amazon','olist','madeira','leroy','outro']) {
        const n = await supaCount('amb', _faixaAno + '&canal=eq.' + c);   // Codex: canais também no ano escolhido
        if (n) out.por_canal[c] = n;
      }
      json(res, 200, out);
      return true;
    }

    // ADMIN (?k= obrigatorio — trava central intercepta rotas 'debug'): RAIO-X DO PRODUTO no Bling.
    // Mostra TODAS as chaves do produto + campos de preco/custo + o que /estoques/saldos e /produtos/fornecedores devolvem.
    // Uso: /amb-checkout-offline/debug-sku?sku=KP16&k=SUA_CHAVE
    if (method === 'GET' && p === '/amb-checkout-offline/debug-sku') {
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

    // DISPARA o backfill do ANO TODO — roda os meses de janeiro até 'ate' EM SEQUÊNCIA, sozinho. Uso: /amb-checkout-offline/backfill-ano  (ou &ate=07 pra parar em julho)
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-ano') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      if (_backfillAno.rodando || _backfill.rodando) { json(res, 200, { ok: false, msg: 'já tem backfill rodando — acompanhe em /backfill-status', ano: _backfillAno, mes: _backfill }); return true; }
      const ateMes = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '07').padStart(2,'0');   // default: vai até julho (mês atual)
      backfillAnoTodo(ateMes);   // NÃO await — roda em background, mês a mês
      json(res, 200, { ok: true, msg: '✅ backfill do ANO iniciado (janeiro até '+('2026-'+ateMes)+'), rodando os meses EM SEQUÊNCIA sozinho. Acompanhe em /backfill-status. Cada mês ~15-20 min; o ano todo leva ~2h. É idempotente (cada mês limpa e regrava o seu).', ate: '2026-'+ateMes });
      return true;
    }


    // DISPARA o backfill de um período (roda em BACKGROUND). Uso: /amb-checkout-offline/backfill?de=2026-01-01&ate=2026-01-31
    if (method === 'GET' && p === '/amb-checkout-offline/backfill') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      if (_backfill.rodando) { json(res, 200, { ok: false, msg: 'já tem um backfill rodando — acompanhe em /backfill-status', status: _backfill }); return true; }
      const de = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '2026-01-01').slice(0, 10);
      const ate = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || new Date().toISOString().slice(0, 10)).slice(0, 10);
      backfillVendas(de, ate, 'amb');   // NÃO await — roda em background
      json(res, 200, { ok: true, msg: '✅ backfill iniciado em background (só AMBTotal). Acompanhe em /backfill-status. Ele deleta o período antes e regrava, então pode rodar de novo sem duplicar.', de, ate });
      return true;
    }
    // 🌻 ÍCONE E MANIFESTO — pra a aba do navegador, o favorito (Ctrl+D) e principalmente o atalho
    // na tela de início do celular. Servidos pelo servidor (não embutidos) porque o Android só
    // aceita ícone de URL real no "adicionar à tela de início". Cache de 30 dias.
    if (method === 'GET' && p === '/amb-checkout-offline/icone.png') {
      const png = Buffer.from(ICONE_B64, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=2592000' });
      res.end(png); return true;
    }
    if (method === 'GET' && p === '/amb-checkout-offline/manifest.webmanifest') {
      const man = {
        name: 'Intelig\u00eancia de Vendas \u00b7 AMBTotal',
        short_name: 'AMBTotal',
        description: 'Faturamento, margem, previs\u00e3o de vendas e plano de compra da AMBTotal',
        start_url: '/amb-checkout-offline/dashboard',
        scope: '/amb-checkout-offline/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0a0e1a',
        theme_color: '#0a0e1a',
        icons: [
          // ?v= (Codex PR#9): o /icone.png sai com cache de 30 dias — quando o ícone MUDA,
          // navegador e PWA seguravam o antigo até um mês. Versionar a URL fura o cache.
          { src: 'icone.png?v=' + encodeURIComponent(VERSAO), sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: 'icone.png?v=' + encodeURIComponent(VERSAO), sizes: '128x128', type: 'image/png', purpose: 'maskable' }
        ]
      };
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(JSON.stringify(man)); return true;
    }


    // 📸 FOTOS DOS PRODUTOS (TOP Produtos) — lê o cache do plano de compra e, se faltar,
    // busca no Bling um punhado por chamada. Nunca varre tudo de uma vez: o Bling satura
    // e a tela é secundária. O que não vier agora entra no cache e aparece na próxima.
    // FOTO_V: sobe quando a LEITURA da imagem muda (ex.: passar a ler a interna). Cache
    // gravado por versão anterior é ignorado, senão o conserto só apareceria 12h depois.
    const FOTO_V = 6;   // v6: procura foto em TODOS os cadastros do mesmo SKU (multiloja)   // v5: sem o fallback de SKU-base (mostrava foto de 1 lâmpada no kit de 9)   // v3: busca livre quando o código não acha + foto do componente do kit
    if (method === 'GET' && p === '/amb-checkout-offline/produto-fotos') {
      // ?diag=SKU — mostra PASSO A PASSO o que o Bling devolveu pra esse SKU: se a busca
      // achou, qual o id, quais campos de imagem existem e o que o primeiraImagem extraiu.
      // Serve pra parar de supor: o print do Bling mostra foto, então o dado está lá — falta
      // saber em QUAL campo ele vem pros kits.
      if (urlObj.searchParams && urlObj.searchParams.get('diag')) {
        const skD = String(urlObj.searchParams.get('diag') || '').trim();
        const outD = { sku: skD, passos: [] };
        try {
          const r1 = await blingGet('/produtos?codigo=' + encodeURIComponent(skD) + '&criterio=5&limite=10');
          const l1 = (r1.ok && r1.data && r1.data.data) || [];
          // lista TODOS os cadastros com esse código (multiloja duplica) e diz quem tem foto
          for (const c1 of l1.slice(0, 6)) {
            let i2 = primeiraImagem(c1), viaDetalhe = false;
            if (i2 == null && c1.id) {
              const dX = await blingGet('/produtos/' + c1.id);
              const pX = (dX.ok && dX.data && dX.data.data) || null;
              i2 = pX ? primeiraImagem(pX) : null; viaDetalhe = !!i2;
              if (pX && pX.midia && pX.midia.imagens) {
                outD.passos.push({ passo: 'candidato ' + c1.id, codigo: c1.codigo, nome: String(c1.nome || '').slice(0, 60),
                  externas: (pX.midia.imagens.externas || []).length, internas: (pX.midia.imagens.internas || []).length,
                  imagensURL: (pX.midia.imagens.imagensURL || []).length, foto: i2 || null, via_detalhe: viaDetalhe });
                continue;
              }
            }
            outD.passos.push({ passo: 'candidato ' + c1.id, codigo: c1.codigo, nome: String(c1.nome || '').slice(0, 60), foto: i2 || null, via_detalhe: viaDetalhe });
          }
          outD.passos.push({ passo: 'busca por codigo (criterio=5)', http: r1.status, achou: l1.length,
            id: l1[0] && l1[0].id, codigo: l1[0] && l1[0].codigo,
            campos: l1[0] ? Object.keys(l1[0]) : null,
            imagemURL: l1[0] && l1[0].imagemURL || null,
            primeiraImagem: l1[0] ? primeiraImagem(l1[0]) : null });
          if (!l1.length) {
            const r2 = await blingGet('/produtos?pesquisa=' + encodeURIComponent(skD) + '&limite=5');
            const l2 = (r2.ok && r2.data && r2.data.data) || [];
            outD.passos.push({ passo: 'busca livre (pesquisa=)', http: r2.status, achou: l2.length,
              codigos: l2.map(x => x && x.codigo) });
          }
          const mB2 = /^(\d+)\s*x\s*(.+)$/i.exec(skD);
          if (mB2) {
            const sb = mB2[2].trim();
            const rb2 = await blingGet('/produtos?codigo=' + encodeURIComponent(sb) + '&criterio=5&limite=1');
            const ib2 = (rb2.ok && rb2.data && rb2.data.data && rb2.data.data[0]) || null;
            let imb = ib2 ? primeiraImagem(ib2) : null;
            if (ib2 && imb == null) { const db2 = await blingGet('/produtos/' + ib2.id); const dd2 = (db2.ok && db2.data && db2.data.data) || null; if (dd2) imb = primeiraImagem(dd2); }
            outD.passos.push({ passo: 'SKU-BASE do kit', base: sb, achou: !!ib2, primeiraImagem: imb || null });
          }
          const idD = (l1[0] && l1[0].id) || null;
          if (idD) {
            const r3 = await blingGet('/produtos/' + idD);
            const d3 = (r3.ok && r3.data && r3.data.data) || null;
            outD.passos.push({ passo: 'detalhe /produtos/{id}', http: r3.status,
              tem_midia: !!(d3 && d3.midia),
              midia_chaves: d3 && d3.midia ? Object.keys(d3.midia) : null,
              imagens_chaves: d3 && d3.midia && d3.midia.imagens ? Object.keys(d3.midia.imagens) : null,
              midia_crua: d3 ? (d3.midia || null) : null,
              tem_estrutura: !!(d3 && d3.estrutura),
              componentes: d3 && d3.estrutura ? ((d3.estrutura.componentes || d3.estrutura.itens || []).length) : 0,
              primeiraImagem: d3 ? primeiraImagem(d3) : null });
          }
        } catch (e) { outD.erro = String(e.message || e).slice(0, 200); }
        json(res, 200, { ok: true, diagnostico: outD });
        return true;
      }
      const opF = validarSessao(req.headers['cookie']);
      if (!opF) { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
      const skusF = String(urlObj.searchParams.get('skus') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
      const F_PROD_F = path.join(CACHE_DIR, '_prod_compra.json');
      const cacheF = readJson(F_PROD_F, {});
      const fotos = {}, faltando = [];
      for (const sk of skusF) {
        const c = cacheF[sk];
        if (c && c.img) fotos[sk] = c.img;
        // 11/08: só o carimbo da FOTO (`ts_img`) conta. Antes o `ts` do plano de compra
        // (que guarda saldo e podia ter img null) marcava o SKU como "já procurado" e o
        // kit ficava com 📦 pra sempre. Sem ts_img → tenta de novo.
        // 11/08 (2ª rodada): o carimbo `ts_img` de ANTES do conserto do primeiraImagem foi
        // gravado por uma versão que não sabia ler imagem INTERNA do Bling — os kits ficaram
        // marcados como "não tem foto" por 12h e o conserto não apareceria. Só vale o cache
        // gravado pela versão ATUAL (foto_v). Versão nova = tenta de novo, uma vez.
        else if (c && c.ts_img && c.foto_v === FOTO_V && (Date.now() - c.ts_img) < 12 * 3600 * 1000) fotos[sk] = null;
        else faltando.push(sk);
      }
      let buscadas = 0;
      for (const sk of faltando.slice(0, 16)) {
        try {
          // 1) pelo código exato — TODOS os cadastros, não só o primeiro.
          //    11/08: o Bling pode ter MAIS DE UM produto com o mesmo SKU (multiloja). O
          //    diagnóstico achou o id 16638636805 com mídia vazia, enquanto o cadastro que o
          //    Diego abre (16638891054) tem 4 imagens externas. Pegar "o primeiro" era sorteio.
          let rb = await blingGet('/produtos?codigo=' + encodeURIComponent(sk) + '&criterio=5&limite=10');
          let cands = (rb.ok && rb.data && rb.data.data) || [];
          let it0 = cands[0] || null;
          // 2) não achou pelo código? tenta a busca livre (SKU com variação, espaço, caixa diferente)
          if (!it0) {
            rb = await blingGet('/produtos?pesquisa=' + encodeURIComponent(sk) + '&limite=5');
            const lst = (rb.ok && rb.data && rb.data.data) || [];
            it0 = lst.find(x => String(x && x.codigo || '').trim().toUpperCase() === sk.toUpperCase()) || lst[0] || null;
          }
          let img = null, det = null;
          // 2) entre os candidatos, fica com o PRIMEIRO QUE TEM IMAGEM (na lista ou no detalhe)
          for (const c0 of cands.slice(0, 4)) {
            let i1 = primeiraImagem(c0);
            let d1 = null;
            if (i1 == null && c0 && c0.id) {
              const dd = await blingGet('/produtos/' + c0.id);
              d1 = (dd.ok && dd.data && dd.data.data) || null;
              if (d1) i1 = primeiraImagem(d1);
            }
            if (i1) { img = i1; it0 = c0; det = d1 || det; break; }
            if (!det) { it0 = it0 || c0; det = d1; }
            await new Promise(r => setTimeout(r, 240));
          }
          // 3) KIT sem foto própria: usa a foto do 1º COMPONENTE. No Bling o kit costuma
          //    não ter imagem — quem tem é o produto que o compõe (foi o caso dos 10x/7x/6x
          //    no TOP Produtos). Mesmo caminho que o custo do kit já usa (estrutura.componentes).
          if (it0 && img == null && det) {
            const comps = (det.estrutura && (det.estrutura.componentes || det.estrutura.itens)) || det.composicao || det.componentes || null;
            if (Array.isArray(comps) && comps.length) {
              for (const cp of comps.slice(0, 3)) {
                const idc = (cp.produto && cp.produto.id) || cp.idProduto || cp.id || null;
                if (!idc) continue;
                const dc = await blingGet('/produtos/' + idc);
                const pc = (dc.ok && dc.data && dc.data.data) || null;
                const ic = pc ? primeiraImagem(pc) : null;
                if (ic) { img = ic; break; }
                await new Promise(r => setTimeout(r, 260));
              }
            }
          }
          // 4) [REMOVIDO em 11/08] Tentei cair pro SKU-BASE do kit (10xE14… → E14…), mas a
          //    foto do produto base é UMA lâmpada — e o kit de 9 aparecia com a foto de 1.
          //    Imagem errada é pior que imagem nenhuma: quem bate o olho no TOP Produtos
          //    confia no que vê. Sem foto, fica o 📦.
          //    O CAMINHO CERTO é encher a mídia no Bling: o diagnóstico provou que a API
          //    devolve `midia.imagens` VAZIA nesses kits (externas[], internas[], imagensURL[]),
          //    então nem existe imagem pra API entregar. O módulo /amb-drive-imagens envia
          //    URLs de imagem pro Bling (grava em `externas`) — feito isso, a foto aparece aqui
          //    sozinha, e será a foto CERTA do kit.
          fotos[sk] = img || null;
          const antes = cacheF[sk] || {};
          // ⚠️ (Codex PR#22) NÃO tocar no `ts` — ele é o carimbo do SALDO, lido pelo Plano de
          // Compra. Se esta rota (que NÃO consulta estoque) gravasse ts=agora com saldo null,
          // o plano confiaria no cache por 12h, leria saldo ausente como ZERO e mandaria
          // comprar a meta inteira de um produto cheio no estoque. A foto tem carimbo próprio.
          cacheF[sk] = Object.assign({}, antes, {
            img: img || null,
            nome: (it0 && it0.nome) || antes.nome || null,
            ts_img: Date.now(),
            foto_v: FOTO_V
          });
          buscadas++;
          await new Promise(r => setTimeout(r, 320));
        } catch (e) { fotos[sk] = null; }
      }
      if (buscadas) { try { writeJson(F_PROD_F, cacheF); } catch (e) {} }
      const restam = faltando.slice(12);
      json(res, 200, { ok: true, fotos, buscadas_agora: buscadas, faltando: restam });
      return true;
    }

    // 🛒 CAÇA DA MAGALU — dispara pra um período (?de=&ate=) ou vê o status (?status=1)
    if (method === 'GET' && p === '/amb-checkout-offline/magalu-caca') {
      const kM = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sM = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kM === process.env.ADMIN_KEY) || (sM && ehAdmin(sM)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, status: _mgc }); return true; }
      // ?limpar=1 — apaga do histórico SÓ as linhas gravadas por esta caça (numero_pedido
      // começa com 'MG-'). Serve pra desfazer uma gravação errada sem tocar no que veio do
      // Bling. Depois é só rodar a caça de novo.
      if (urlObj.searchParams.get('limpar')) {
        const deL2 = String(urlObj.searchParams.get('de') || '').slice(0, 10);
        const ateL2 = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(deL2) || !/^\d{4}-\d{2}-\d{2}$/.test(ateL2)) { json(res, 400, { ok: false, erro: 'passe &de=&ate=' }); return true; }
        const del2 = await supaReq('amb', 'DELETE', 'vendas_historico?empresa=eq.amb&canal=eq.magalu&numero_pedido=like.MG-*&data_venda=gte.' + deL2 + '&data_venda=lte.' + ateL2, null);
        try { for (const k9 of Object.keys(_histCache)) delete _histCache[k9]; } catch (e) {}
        json(res, del2.ok ? 200 : 500, { ok: del2.ok, msg: del2.ok ? ('🧹 linhas da caça da Magalu apagadas em ' + deL2 + ' a ' + ateL2 + ' — o que veio do Bling continua intacto. Agora rode a caça de novo.') : ('falhou: status ' + del2.status), status_http: del2.status });
        return true;
      }
      const deM = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateM = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deM) || !/^\d{4}-\d{2}-\d{2}$/.test(ateM)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (_mgc.rodando) { json(res, 200, { ok: true, ja_rodando: true, status: _mgc }); return true; }
      cacaMagalu(deM, ateM, 'amb', { refazer: urlObj.searchParams.get('refazer') === '1' }).catch(e => console.log('[CACA-MAGALU] ' + (e.message || e)));
      json(res, 200, { ok: true, msg: '🛒 caça da Magalu iniciada em background (' + deM + ' a ' + ateM + ') — acompanhe em /amb-checkout-offline/magalu-caca?status=1&k=', de: deM, ate: ateM });
      return true;
    }

    // 🧮 PLANO DE COMPRA — o motor. Junta ritmo de venda (histórico), saldo e imagem (Bling) e custo
    // (_custos.json) e devolve, por SKU: quanto comprar pra cobrir lead time + cobertura desejada,
    // o quanto isso custa e QUANTO LUCRO ESTÁ EM RISCO se faltar. Ordenado pelo risco, não pelo volume.
    // Uso: /amb-checkout-offline/plano-compra?lead=4&cob=5&seg=0.5&base=180&curva=A
    if (method === 'GET' && p === '/amb-checkout-offline/plano-compra') {
      const kC = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      const par = n => Number((urlObj.searchParams && urlObj.searchParams.get(n)) || '');
      const lead = Math.min(24, Math.max(0, par('lead') || 4));        // meses até a mercadoria chegar
      const cob  = Math.min(24, Math.max(0.5, par('cob') || 5));       // meses de estoque desejados DEPOIS que chegar
      const seg  = Math.min(6, Math.max(0, par('seg') || 0));          // 29/07: sem colchão separado — a cobertura escolhida já é a decisão
      const base = Math.min(730, Math.max(30, par('base') || 180));    // histórico usado pra medir o ritmo
      const curva = String((urlObj.searchParams && urlObj.searchParams.get('curva')) || 'todas').toUpperCase();
      const mult = Math.max(1, par('mult') || 1);                      // múltiplo de compra (caixa fechada)
      const DIA = 30.4;
      const hojeC = new Date();
      const deC = new Date(hojeC.getTime() - base * 86400000).toISOString().slice(0, 10);
      const ateC = hojeC.toISOString().slice(0, 10);

      // ── 1) ritmo, faturamento e margem por SKU, do histórico ──
      const { url: uC, key: kkC } = supaCfg('amb');
      if (!uC || !kkC) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const HC = { apikey: kkC, Authorization: 'Bearer ' + kkC };
      const corte30 = new Date(hojeC.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const corte60 = new Date(hojeC.getTime() - 60 * 86400000).toISOString().slice(0, 10);
      const acc = {};
      try {
        let off = 0;
        while (off < 120000) {
          const rq = await fetch(uC.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.amb&data_venda=gte.' + deC + '&data_venda=lte.' + ateC +
                    '&select=sku,descricao,quantidade,valor_produto,margem,data_venda&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + off, { headers: HC });
          if (!rq.ok) break;
          const ln = await rq.json().catch(() => []);
          if (!Array.isArray(ln) || !ln.length) break;
          for (const l of ln) {
            const sk = l.sku; if (!sk) continue;
            if (!acc[sk]) acc[sk] = { sku: sk, desc: l.descricao || '', un: 0, fat: 0, mar: 0, un30: 0, un3060: 0 };
            const o = acc[sk], q = Number(l.quantidade) || 0, d = String(l.data_venda || '').slice(0, 10);
            o.un += q; o.fat += Number(l.valor_produto) || 0; o.mar += Number(l.margem) || 0;
            if (d >= corte30) o.un30 += q; else if (d >= corte60) o.un3060 += q;
          }
          if (ln.length < 1000) break;
          off += 1000;
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }

      // ── 2) curva ABC por faturamento do período ──
      const lista = Object.values(acc).filter(x => x.un > 0).sort((a, b) => b.fat - a.fat);
      const fatTotal = lista.reduce((a, c) => a + c.fat, 0) || 1;
      let cum = 0;
      for (const x of lista) { cum += x.fat; const pc = cum / fatTotal; x.curva = pc <= 0.8 ? 'A' : (pc <= 0.95 ? 'B' : 'C'); }

      // ── 3) saldo, custo e imagem (cache próprio, 12h — não martela o Bling) ──
      const F_PROD = path.join(CACHE_DIR, '_prod_compra.json');
      const cacheP = readJson(F_PROD, {});
      const custos = readJson(path.join(CACHE_DIR, '_custos.json'), {});
      const alvo = lista.filter(x => curva === 'TODAS' || x.curva === curva || (curva === 'AB' && (x.curva === 'A' || x.curva === 'B')));
      const VAL = 12 * 3600 * 1000;
      let buscados = 0;
      for (const x of alvo.slice(0, 260)) {
        const c = cacheP[x.sku];
        if (c && (Date.now() - (c.ts || 0)) < VAL) { x.saldo = c.saldo; x.img = c.img; x.nome = c.nome || x.desc; continue; }
        try {
          const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(x.sku) + '&criterio=5&limite=1');
          const it0 = (rb.ok && rb.data && rb.data.data && rb.data.data[0]) || null;
          let saldo = null, img = null, nome = null;
          if (it0) {
            nome = it0.nome || null;
            img = primeiraImagem(it0);
            saldo = (it0.estoque && (it0.estoque.saldoVirtualTotal != null ? it0.estoque.saldoVirtualTotal : it0.estoque.saldoFisicoTotal));
            if (saldo == null || img == null) {
              const dd = await blingGet('/produtos/' + it0.id);
              const det = (dd.ok && dd.data && dd.data.data) || null;
              if (det) {
                if (img == null) img = primeiraImagem(det);
                if (saldo == null && det.estoque) saldo = (det.estoque.saldoVirtualTotal != null ? det.estoque.saldoVirtualTotal : det.estoque.saldoFisicoTotal);
              }
            }
          }
          x.saldo = (saldo != null && isFinite(Number(saldo))) ? Number(saldo) : null;
          x.img = img || null; x.nome = nome || x.desc;
          cacheP[x.sku] = { saldo: x.saldo, img: x.img, nome: x.nome, ts: Date.now() };
          buscados++;
          if (buscados % 15 === 0) { try { writeJson(F_PROD, cacheP); } catch (e) {} }
          await new Promise(r => setTimeout(r, 340));
        } catch (e) { x.saldo = null; x.img = null; x.nome = x.desc; }
      }
      try { writeJson(F_PROD, cacheP); } catch (e) {}

      // ── 4) a conta ──
      const horizonteDias = Math.round((lead + cob + seg) * DIA);
      const leadDias = Math.round(lead * DIA);
      const itens = alvo.map(x => {
        const mdBase = x.un / base;
        // ── 09/08: DUPLA CONTAGEM DA ALTA — corrigido ────────────────────────────
        // O código pegava a mistura 70% recente + 30% média (que JÁ reflete a alta,
        // porque a média recente subiu) e AINDA multiplicava por (1 + tendência/2) —
        // ou seja, contava a mesma subida duas vezes.
        // No KP16 isso dava 26,20/dia, MAIOR que o melhor mês já vendido (24,20/dia).
        // O plano pedia 7.074 un. pra 270 dias, contra 2.346 pela média do período.
        // Agora: um peso só, que cai conforme o horizonte cresce, e teto no melhor mês.
        const mdRec = x.un30 / 30;
        const tend = x.un3060 > 0 ? ((x.un30 - x.un3060) / x.un3060) : (x.un30 > 0 ? 1 : 0);
        const pesoRec = horizonteDias <= 30 ? 0.55 : horizonteDias <= 90 ? 0.40 : horizonteDias <= 180 ? 0.30 : 0.25;
        // O `Math.min(mdRec, ...)` aqui é DE PROPÓSITO e só pega no produto em QUEDA:
        // se o último mês vendeu menos, o plano compra pelo ritmo NOVO, não pela média
        // antiga. Comprar estoque é assimétrico — errar pra menos você repõe, errar pra
        // mais vira dinheiro parado. No produto subindo o min() não muda nada, porque a
        // mistura já fica abaixo do ritmo recente.
        const md = x.un30 > 0
          ? Math.max(0, Math.min(mdRec, mdRec * pesoRec + mdBase * (1 - pesoRec)))
          : Math.max(0, mdBase);
        const custoUn = (custos[x.sku] && custos[x.sku].custo != null) ? Number(custos[x.sku].custo) : null;
        const mcUn = x.un > 0 ? (x.mar / x.un) : 0;
        const saldo = x.saldo != null ? x.saldo : 0;
        const precisa = Math.ceil(md * horizonteDias);
        let comprar = Math.max(0, precisa - saldo);
        if (mult > 1 && comprar > 0) comprar = Math.ceil(comprar / mult) * mult;
        const acabaEm = md > 0 ? Math.floor(saldo / md) : null;
        const diasSemEstoque = (acabaEm != null) ? Math.max(0, leadDias - acabaEm) : 0;
        const risco = diasSemEstoque * md * Math.max(0, mcUn);
        return {
          sku: x.sku, nome: x.nome || x.desc, img: x.img || null, curva: x.curva,
          un: x.un, un30: x.un30, un_30_60: x.un3060, tendencia: Math.round(tend * 100),
          md: Math.round(md * 1000) / 1000, saldo: x.saldo, acaba_em: acabaEm,
          precisa, comprar, custo_un: custoUn,
          investir: custoUn != null ? Math.round(comprar * custoUn * 100) / 100 : null,
          mc_un: Math.round(mcUn * 100) / 100,
          risco: Math.round(risco * 100) / 100,
          sem_saldo: x.saldo == null, sem_custo: custoUn == null
        };
      }).sort((a, b) => (b.risco - a.risco) || (b.mc_un * b.comprar - a.mc_un * a.comprar));

      const tot = itens.reduce((a, c) => ({ investir: a.investir + (c.investir || 0), risco: a.risco + c.risco, skus: a.skus + (c.comprar > 0 ? 1 : 0) }), { investir: 0, risco: 0, skus: 0 });
      json(res, 200, { ok: true, lead, cob, seg, base, curva, mult, horizonte_dias: horizonteDias,
        de: deC, ate: ateC, skus: itens.length,
        totais: { investir: Math.round(tot.investir * 100) / 100, risco: Math.round(tot.risco * 100) / 100, skus_a_comprar: tot.skus },
        itens });
      return true;
    }

    // 01/08 — faturamento do ML (billing oficial): dispara, status e resumo por período
    if (method === 'GET' && p === '/amb-checkout-offline/ml-billing') {
      const kB = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY) || (sB && ehAdmin(sB)))) { json(res, 404, { error: 'not found' }); return true; }
      // 02/08: uma rodada presa bloqueava todas as seguintes (a fun\u00e7\u00e3o volta na hora se j\u00e1 estiver
      // rodando) \u2014 e sem reiniciar o servi\u00e7o n\u00e3o havia sa\u00edda. Com ?forcar=1 a trava \u00e9 solta.
      if ((urlObj.searchParams.get('forcar') || '') === '1' && _mlb.rodando) {
        console.log('[ML-BILLING] trava solta na m\u00e3o (rodada presa desde ' + _mlb.inicio + ')');
        _mlb.rodando = false; _mlb.msg = 'rodada anterior descartada a pedido';
      }
      if (_mlb.rodando) { json(res, 409, { ok: false, erro: 'j\u00e1 existe uma rodada em andamento desde ' + _mlb.inicio + ' \u2014 use &forcar=1 para descartar', status: _mlb }); return true; }
      mlBillingSync(Number(urlObj.searchParams.get('periodos')) || 12).catch(e => console.log('[ML-BILLING] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'puxando o faturamento do ML em background', status: '/amb-checkout-offline/ml-billing-status' });
      return true;
    }
    if (method === 'GET' && p === '/amb-checkout-offline/ml-billing-status') {
      const b = readJson(MLB_FILE(), { tarifas: {}, porDia: {} });
      const porCat = {}, comVenda = {};
      for (const t of Object.values(b.tarifas || {})) { porCat[t.c] = Math.round(((porCat[t.c] || 0) + t.v) * 100) / 100;
        if (t.o) comVenda[t.c] = (comVenda[t.c] || 0) + 1; }
      json(res, 200, { ok: true, status: _mlb, tentativas: _mlb.tentativas || [], detalhes: _mlb.detalhes || [], amostra_item: _mlb.amostra_item || null, amostra_venda: _mlb.amostra_venda || null, amostra_periodos: _mlb.amostra_periodos || null, atualizado: b.atualizado || null,
                       tarifas_guardadas: Object.keys(b.tarifas || {}).length, total_por_categoria: porCat, com_numero_de_venda: comVenda,
                       dias_com_dado: Object.keys(b.porDia || {}).length });
      return true;
    }
    // resumo de um período, pros cards do dashboard
    // DE-PARA DE SKU RENOMEADO (14/08) — conserto cirúrgico do achado do rename. A medição
    // (/sku-orfaos) mostrou 1 órfão na AMB: FL-1011-PRETO (53 un, R$ 5.722,70, em 4 canais),
    // renomeado no Bling para 3933398010054 — o histórico ficou partido em dois produtos.
    // ⚠️ Match EXATO de propósito: existe FL-1011-PRETO-2LAMPS, que é OUTRO produto e não pode
    // ser tocado (aviso do Diego). Nada de LIKE/prefixo aqui.
    // Uso:  GET /amb-checkout-offline/sku-repara?de=SKU_ANTIGO&para=SKU_NOVO&k=ADMIN_KEY
    //       (sem &aplicar=1 é SIMULAÇÃO: diz quantas linhas mudariam, sem gravar)
    if (method === 'GET' && p === '/amb-checkout-offline/sku-repara') {
      const kR = urlObj.searchParams.get('k') || '';
      const sR = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY) || (sR && ehAdmin(sR)))) { json(res, 404, { error: 'not found' }); return true; }
      const deSku = String(urlObj.searchParams.get('de') || '').trim();
      const paraSku = String(urlObj.searchParams.get('para') || '').trim();
      const aplicar = urlObj.searchParams.get('aplicar') === '1';
      if (!deSku || !paraSku) { json(res, 400, { ok: false, erro: 'use ?de=SKU_ANTIGO&para=SKU_NOVO&k=ADMIN_KEY (sem &aplicar=1 simula)' }); return true; }
      if (deSku === paraSku) { json(res, 400, { ok: false, erro: 'de e para são iguais' }); return true; }
      const outR = { ok: true, de: deSku, para: paraSku, simulacao: !aplicar, linhas: 0, atualizadas: 0, avisos: [] };
      // o backfill/caça apagam e regravam o período — não mexer no histórico enquanto isso
      if (_backfill && _backfill.rodando) { json(res, 409, { ok: false, erro: 'backfill rodando — tente depois' }); return true; }
      if (_mgc && _mgc.rodando) { json(res, 409, { ok: false, erro: 'caça da Magalu rodando — tente depois' }); return true; }
      // 1) o SKU de destino TEM que existir no catálogo (senão o de-para cria outro órfão).
      //    Varredura completa: o filtro ?codigo= do Bling não é confiável.
      let achouDestino = false, aindaExisteOrigem = false, completo = false;
      try {
        for (let pg = 1; pg <= 200; pg++) {
          const rc = await blingGet('/produtos?pagina=' + pg + '&limite=100&criterio=2');
          if (!rc || !rc.ok) { json(res, 200, { ok: false, erro: 'catálogo: página ' + pg + ' falhou — de-para abortado' }); return true; }
          const lote = (rc.data && rc.data.data) || [];
          for (const pr of lote) {
            const cd = String(pr.codigo || '').trim();
            if (cd === paraSku) achouDestino = true;
            if (cd === deSku) aindaExisteOrigem = true;
          }
          if (lote.length < 100) { completo = true; break; }
          await new Promise(r0 => setTimeout(r0, 250));
        }
      } catch (e) { json(res, 200, { ok: false, erro: 'catálogo: ' + String(e.message || e).slice(0, 140) }); return true; }
      if (!completo) { json(res, 200, { ok: false, erro: 'catálogo maior que o teto — de-para abortado' }); return true; }
      if (!achouDestino) { json(res, 200, { ok: false, erro: 'o SKU de destino (' + paraSku + ') NÃO existe no catálogo do Bling — de-para abortado' }); return true; }
      if (aindaExisteOrigem) outR.avisos.push('atenção: ' + deSku + ' AINDA existe no catálogo — confirme que o rename é esse mesmo antes de aplicar');
      // 2) quantas linhas do histórico têm exatamente esse SKU (paginação por chave)
      let ultId = 0;
      try {
        for (let volta = 0; volta < 300; volta++) {
          const q = 'vendas_historico?empresa=eq.amb&sku=eq.' + encodeURIComponent(deSku) + '&id=gt.' + ultId + '&select=id&order=id.asc&limit=1000';
          const rr = await supaReq('amb', 'GET', q, null);
          if (!rr.ok) { json(res, 200, { ok: false, erro: 'histórico: HTTP ' + rr.status }); return true; }
          let arr = null; try { arr = JSON.parse(rr.body || 'null'); } catch (e) { arr = null; }
          if (!Array.isArray(arr)) { json(res, 200, { ok: false, erro: 'histórico: resposta ilegível' }); return true; }
          outR.linhas += arr.length;
          for (const l of arr) { const idL = Number(l && l.id) || 0; if (idL > ultId) ultId = idL; }
          if (arr.length < 1000) break;
        }
      } catch (e) { json(res, 200, { ok: false, erro: 'histórico: ' + String(e.message || e).slice(0, 140) }); return true; }
      if (!outR.linhas) { outR.avisos.push('nenhuma linha com esse SKU exato no histórico'); json(res, 200, outR); return true; }
      if (!aplicar) { outR.msg = outR.linhas + ' linha(s) mudariam de ' + deSku + ' para ' + paraSku + '. Repita com &aplicar=1 pra gravar.'; json(res, 200, outR); return true; }
      // 3) aplica — um PATCH só, com filtro EXATO (nada de like/prefixo)
      const rp = await supaReq('amb', 'PATCH', 'vendas_historico?empresa=eq.amb&sku=eq.' + encodeURIComponent(deSku), { sku: paraSku, sku_anterior: deSku });
      if (!rp.ok) {
        // sku_anterior pode não existir como coluna — tenta de novo só com o sku
        const rp2 = await supaReq('amb', 'PATCH', 'vendas_historico?empresa=eq.amb&sku=eq.' + encodeURIComponent(deSku), { sku: paraSku });
        if (!rp2.ok) { json(res, 200, { ok: false, erro: 'PATCH falhou: HTTP ' + rp.status + ' / ' + rp2.status, detalhe: String(rp.body || '').slice(0, 200) }); return true; }
        outR.avisos.push('coluna sku_anterior não existe — gravado só o sku novo');
      }
      // 4) confere: não pode sobrar linha com o SKU antigo
      let sobrou = 0;
      try {
        const rc2 = await supaReq('amb', 'GET', 'vendas_historico?empresa=eq.amb&sku=eq.' + encodeURIComponent(deSku) + '&select=id&limit=5', null);
        if (rc2.ok) { const a2 = JSON.parse(rc2.body || '[]'); sobrou = Array.isArray(a2) ? a2.length : 0; }
      } catch (e) {}
      outR.atualizadas = outR.linhas - sobrou;
      outR.sobraram_com_sku_antigo = sobrou;
      if (sobrou) outR.avisos.push('ainda sobraram linhas com o SKU antigo — rode de novo');
      json(res, 200, outR);
      return true;
    }

    // SKU ÓRFÃO (13/08) — MEDIÇÃO pro caso do rename de SKU no Bling (achado no app de
    // Devoluções: a venda antiga guarda o SKU velho e, depois do rename, ninguém acha o produto;
    // o histórico do dashboard parte em dois no dia do rename). Antes de trocar a chave de
    // agregação por produto_id, esta rota MEDE o tamanho do problema: quantos SKUs do histórico
    // não existem mais no catálogo, e quanto faturamento está preso neles.
    // Uso: GET /amb-checkout-offline/sku-orfaos?de=AAAA-MM-DD&ate=AAAA-MM-DD&k=ADMIN_KEY
    // Só leitura. O catálogo é varrido INTEIRO (o filtro ?codigo= do Bling não é confiável —
    // ora volta vazio pra produto que existe, ora ignora o filtro), montando codigo → id.
    if (method === 'GET' && p === '/amb-checkout-offline/sku-orfaos') {
      const kO = urlObj.searchParams.get('k') || '';
      const sO = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kO === process.env.ADMIN_KEY) || (sO && ehAdmin(sO)))) { json(res, 404, { error: 'not found' }); return true; }
      const hojeO = dataISO(new Date());
      const deO = String(urlObj.searchParams.get('de') || (hojeO.slice(0, 4) + '-01-01')).slice(0, 10);
      const ateO = String(urlObj.searchParams.get('ate') || hojeO).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deO) || !/^\d{4}-\d{2}-\d{2}$/.test(ateO)) { json(res, 400, { ok: false, erro: 'datas em AAAA-MM-DD' }); return true; }
      // Codex PR#62 (P2): data inexistente (2026-02-31) ou período invertido passavam no formato,
      // o banco devolvia vazio e a rota reportava "0 órfãos" — conclusão errada com cara de certa.
      const validaD = s => { const d0 = new Date(s + 'T00:00:00Z'); return !isNaN(d0.getTime()) && d0.toISOString().slice(0, 10) === s; };
      if (!validaD(deO) || !validaD(ateO)) { json(res, 400, { ok: false, erro: 'data inexistente no calendário' }); return true; }
      if (deO > ateO) { json(res, 400, { ok: false, erro: 'período invertido: de (' + deO + ') é depois de ate (' + ateO + ')' }); return true; }
      // Codex PR#62 (P1): o backfill APAGA e regrava o período em lotes de 200. Ler com
      // limit/offset durante isso devolve total misturado (e uma página curta no meio faria a
      // rota jurar que terminou). Enquanto ele roda, a medição não acontece.
      if (_backfill && _backfill.rodando) { json(res, 409, { ok: false, erro: 'backfill do histórico rodando agora (' + (_backfill.de || '?') + ' a ' + (_backfill.ate || '?') + ') — a leitura sairia misturada; tente de novo quando terminar' }); return true; }
      const outO = { ok: true, de: deO, ate: ateO, catalogo: 0, skus_no_historico: 0, orfaos: 0, faturamento_orfao: 0, amostra: [], erros: [] };
      // 1) catálogo completo do Bling → mapa codigo → id (é o produto_id que não muda no rename)
      const porCodigo = {};
      let catalogoCompleto = false;
      const TETO_PG = 200;   // 20 mil produtos; se bater, é medição inválida, não fim de lista
      try {
        for (let pg = 1; pg <= TETO_PG; pg++) {
          const rc = await blingGet('/produtos?pagina=' + pg + '&limite=100&criterio=2');
          // Codex PR#62 (P1): blingGet devolve { ok:false } em vez de lançar — tratar isso como
          // página vazia encerrava o laço em silêncio e TODO SKU das páginas seguintes viraria
          // "órfão". Falhou = aborta a medição.
          if (!rc || !rc.ok) { outO.ok = false; outO.erro = 'catálogo incompleto: a página ' + pg + ' do Bling falhou — medição abortada (sem o catálogo inteiro, SKU existente vira falso órfão)'; json(res, 200, outO); return true; }
          const lote = (rc.data && rc.data.data) || [];
          for (const pr of lote) { const cd = String(pr.codigo || '').trim(); if (cd) porCodigo[cd] = pr.id; }
          outO.catalogo = Object.keys(porCodigo).length;
          if (lote.length < 100) { catalogoCompleto = true; break; }   // página curta = fim de verdade
          await new Promise(r0 => setTimeout(r0, 250));
        }
      } catch (e) { outO.ok = false; outO.erro = 'catálogo: ' + String(e.message || e).slice(0, 140); json(res, 200, outO); return true; }
      // Codex PR#62 (P1): teto batido com página cheia = tem produto que não foi lido
      if (!catalogoCompleto) { outO.ok = false; outO.erro = 'catálogo maior que ' + (TETO_PG * 100) + ' produtos — aumente o teto; medição abortada pra não inventar órfão'; json(res, 200, outO); return true; }
      if (!outO.catalogo) { outO.ok = false; outO.erro = 'catálogo vazio — não dá pra medir órfão sem ele'; json(res, 200, outO); return true; }
      // 2) SKUs do histórico no período, com faturamento e unidades por SKU
      const porSkuO = {};
      let historicoCompleto = false;
      const TETO_LINHAS = 300000;
      let ultimoId = 0;
      try {
        for (let lidas = 0; lidas < TETO_LINHAS; lidas += 1000) {
          // Codex PR#62 (P1, 2 rodadas): OFFSET é frágil aqui — o backfill, a caça da Magalu e a
          // varredura de cancelados APAGAM linhas do histórico, e cada linha apagada desloca os
          // offsets seguintes, fazendo a leitura PULAR registros. Paginar por CHAVE (id > último
          // lido) é imune a isso: nada se desloca, só o que foi apagado deixa de aparecer.
          const q = 'vendas_historico?empresa=eq.amb&data_venda=gte.' + deO + '&data_venda=lte.' + ateO +
                    '&id=gt.' + ultimoId + '&select=id,sku,quantidade,valor_produto,canal&order=id.asc&limit=1000';
          const rr = await supaReq('amb', 'GET', q, null);
          if (!rr.ok) { outO.ok = false; outO.erro = 'histórico incompleto: Supabase HTTP ' + rr.status + ' — medição abortada'; json(res, 200, outO); return true; }
          // Codex PR#62 (P2): corpo inválido com HTTP 200 (resposta truncada) virava array vazio
          // e o laço tratava como fim — resultado parcial com cara de completo. Agora aborta.
          let arr = null;
          try { arr = JSON.parse(rr.body || 'null'); } catch (e) { arr = null; }
          if (!Array.isArray(arr)) { outO.ok = false; outO.erro = 'histórico: resposta do Supabase ilegível (JSON inválido) — medição abortada'; json(res, 200, outO); return true; }
          for (const l of arr) { const idL = Number(l && l.id) || 0; if (idL > ultimoId) ultimoId = idL; }
          for (const l of arr) {
            const sk = String((l && l.sku) || '').trim();
            if (!sk) continue;
            if (!porSkuO[sk]) porSkuO[sk] = { sku: sk, un: 0, fat: 0, canais: {} };
            porSkuO[sk].un += Number(l.quantidade) || 0;
            porSkuO[sk].fat += Number(l.valor_produto) || 0;
            const cn = String(l.canal || '?'); porSkuO[sk].canais[cn] = (porSkuO[sk].canais[cn] || 0) + 1;
          }
          if (arr.length < 1000) { historicoCompleto = true; break; }
        }
      } catch (e) { outO.ok = false; outO.erro = 'histórico: ' + String(e.message || e).slice(0, 140); json(res, 200, outO); return true; }
      // Codex PR#62 (P2): parar no teto com página cheia subestimaria o impacto — que é
      // justamente o que esta rota existe pra medir.
      if (!historicoCompleto) { outO.ok = false; outO.erro = 'período com mais de ' + TETO_LINHAS + ' linhas — reduza o intervalo; medição abortada pra não subestimar o impacto'; json(res, 200, outO); return true; }
      // 3) cruza: SKU do histórico que não existe mais no catálogo = órfão do rename
      // se o backfill entrou DURANTE a leitura, o que foi lido já não é confiável
      if (_backfill && _backfill.rodando) { json(res, 409, { ok: false, erro: 'backfill começou durante a leitura — medição descartada; rode de novo depois' }); return true; }
      const listaO = Object.values(porSkuO);
      outO.skus_no_historico = listaO.length;
      const orfaos = listaO.filter(x => porCodigo[x.sku] === undefined).sort((a, b) => b.fat - a.fat);
      outO.orfaos = orfaos.length;
      outO.faturamento_orfao = Math.round(orfaos.reduce((s, x) => s + x.fat, 0) * 100) / 100;
      outO.amostra = orfaos.slice(0, 30).map(x => ({ sku: x.sku, unidades: x.un, faturamento: Math.round(x.fat * 100) / 100, canais: Object.keys(x.canais).join(',') }));
      json(res, 200, outO);
      return true;
    }

    // MAGALU-DEBUG (13/08) — a caça devolveu sem_no_bling 116/116 DUAS vezes (procurando pelo
    // `code` e depois pelo `id` UUID). Antes de chutar uma terceira chave, esta rota mostra o
    // que CADA LADO tem de verdade num dia: os pedidos da Magalu (code + id) e o que a listagem
    // do Bling devolve (quantos, que datas, e os numeroLoja crus). Só leitura.
    if (method === 'GET' && p === '/amb-checkout-offline/magalu-debug') {
      const kG = urlObj.searchParams.get('k') || '';
      const sG = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kG === process.env.ADMIN_KEY) || (sG && ehAdmin(sG)))) { json(res, 404, { error: 'not found' }); return true; }
      const diaG = String(urlObj.searchParams.get('dia') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(diaG)) { json(res, 400, { ok: false, erro: 'use ?dia=AAAA-MM-DD&k=ADMIN_KEY' }); return true; }
      const outG = { dia: diaG, magalu: [], bling: { paginas: 0, pedidos: 0, datas: {}, amostra: [] }, casamento: null, erros: [] };
      try {
        // o módulo magalu-oauth roda NO MESMO serviço — a chamada é local (foi o HTTP 404 da 1ª tentativa)
        // mesmos parâmetros que a CAÇA usa (empresa da env AMBBKP_MAGALU_EMPRESA e 40 páginas):
        // com 6 páginas o dia 31/07 voltou VAZIO — a listagem da Magalu vem do mais recente pro
        // mais antigo, então as primeiras 300 eram de agosto e o filtro do dia zerava tudo.
        const urlMg = 'http://127.0.0.1:' + (process.env.PORT || 3000) + '/magalu/pedidos-do-dia?empresa=' + encodeURIComponent(process.env.AMBBKP_MAGALU_EMPRESA || 'amb') + '&desde=' + diaG + '&ate=' + diaG + '&paginas=40&k=' + encodeURIComponent(process.env.ADMIN_KEY || '');
        const rMg = await fetch(urlMg, { timeout: 120000 });
        const jMg = rMg.ok ? await rMg.json().catch(() => null) : null;
        if (!jMg) outG.erros.push('magalu: HTTP ' + rMg.status);
        else {
          outG.magalu_total = (jMg.pedidos || []).length;
          outG.magalu = (jMg.pedidos || []).slice(0, 8).map(x => ({ code: x.code, id: x.id || null, purchased_at: x.purchased_at, status: x.status, total: x.total, itens: (x.itens || []).length, skus: (x.itens || []).map(i9 => i9.sku).slice(0, 3) }));
        }
      } catch (e) { outG.erros.push('magalu: ' + String(e.message || e).slice(0, 140)); }
      try {
        for (let pg = 1; pg <= 12; pg++) {
          const rB = await blingGet('/pedidos/vendas?dataInicial=' + diaG + '&dataFinal=' + diaG + '&pagina=' + pg + '&limite=100');
          const lote = (rB && rB.ok && rB.data && rB.data.data) || [];
          outG.bling.paginas = pg;
          outG.bling.pedidos += lote.length;
          for (const pd of lote) {
            const dtB = String(pd.data || pd.dataSaida || '').slice(0, 10) || '?';
            outG.bling.datas[dtB] = (outG.bling.datas[dtB] || 0) + 1;
            const lojaB = String((pd.loja && pd.loja.id) || '?');
            outG.bling.lojas = outG.bling.lojas || {};
            outG.bling.lojas[lojaB] = (outG.bling.lojas[lojaB] || 0) + 1;   // TODAS as lojas do dia (a amostra é só 10)
            if (outG.bling.amostra.length < 10) outG.bling.amostra.push({ id: pd.id, numero: pd.numero, data: dtB, numeroLoja: pd.numeroLoja || null, numeroPedidoLoja: pd.numeroPedidoLoja || null, loja: lojaB });
          }
          if (lote.length < 100) break;
          await new Promise(r0 => setTimeout(r0, 300));
        }
      } catch (e) { outG.erros.push('bling: ' + String(e.message || e).slice(0, 140)); }
      try {
        const chavesB = new Set();
        for (const a of outG.bling.amostra) { if (a.numeroLoja) chavesB.add(String(a.numeroLoja).trim()); if (a.numeroPedidoLoja) chavesB.add(String(a.numeroPedidoLoja).trim()); }
        outG.casamento = outG.magalu.map(m => ({ code: m.code, id: m.id, casa_por_code: chavesB.has(String(m.code)), casa_por_id: chavesB.has(String(m.id || '')) }));
        const lojasB = {};
        for (const a of outG.bling.amostra) { const l = String(a.loja || '?'); lojasB[l] = (lojasB[l] || 0) + 1; }
        outG.bling.lojas_na_amostra = lojasB;   // se nenhuma loja for a da Magalu, o pedido não existe no Bling
      } catch (e) {}
      json(res, 200, outG);
      return true;
    }

    // FLEX-DEBUG (13/08) — o billing NAO tem o bonus de envio: a rodada de 01/08 a 13/08 achou
    // 504 creditos e ZERO bonus (so "Cancelamento de..."). Antes de escolher a fonte definitiva,
    // esta rota mostra, PARA UMA VENDA, o que cada fonte candidata responde de verdade:
    //   1) /shipments/{id}            → logistic_type, base_cost, list_cost/cost
    //   2) /shipments/{id}/costs      → senders[0].cost, compensation, compensations[]
    //   3) /orders/{id}               → payments[] (shipping_cost) e o que houver de credito
    //   4) o que existe no _ml_billing.json daquela venda (por order e por pack)
    // So leitura, nada e gravado.
    if (method === 'GET' && p === '/amb-checkout-offline/ml-flex-debug') {
      const kD = urlObj.searchParams.get('k') || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const vendaD = String(urlObj.searchParams.get('venda') || '').trim();
      if (!vendaD) { json(res, 400, { ok: false, erro: 'use ?venda=<numero da venda no ML>&k=ADMIN_KEY' }); return true; }
      const outD = { venda: vendaD, order: null, shipment: null, costs: null, pagamentos: null, billing: [], erros: [] };
      try {
        const { garantirTokenML } = require('../ambtotal/mlTokenManager');
        const tk = await garantirTokenML();
        const HD = { headers: { Authorization: 'Bearer ' + tk } };

        const ro = await fetch('https://api.mercadolibre.com/orders/' + encodeURIComponent(vendaD), HD);
        // Codex PR#46: corpo de ERRO (401/403/429/404) nao pode virar "order" — a rota existe
        // pra separar "fonte sem dado" de "fonte falhou", entao so o payload de sucesso conta
        let dor = ro.ok ? await ro.json().catch(() => null) : null;
        // Codex PR#46: id que da 404 em /orders e PACK (carrinho) — as vendas deste caso SAO
        // carrinho. Mesma cascata que a pesca ja usa: abre /packs/{id} e pega a 1a order.
        if (!ro.ok && ro.status === 404) {
          try {
            const rp = await fetch('https://api.mercadolibre.com/packs/' + encodeURIComponent(vendaD), HD);
            const dp = await rp.json().catch(() => null);
            const idsPack = rp.ok && dp && Array.isArray(dp.orders) ? dp.orders.map(o => o.id || o) : [];
            if (idsPack.length) {
              outD.resolvido_de_pack = { pack: vendaD, orders: idsPack };
              // Codex PR#46: carrinho pode ter frete/tarifa em QUALQUER das orders — busca todas
              outD.orders_do_pack = [];
              for (const oidP of idsPack) {
                // Codex PR#46: try por order — queda de rede numa nao pode esconder as outras
                let dorP = null;
                try {
                  const roP = await fetch('https://api.mercadolibre.com/orders/' + oidP, HD);
                  dorP = roP.ok ? await roP.json().catch(() => null) : null;
                  if (!dorP) outD.erros.push('orders(' + oidP + '): HTTP ' + roP.status);
                } catch (eP) { outD.erros.push('orders(' + oidP + '): ' + String(eP.message || eP).slice(0, 120)); }
                if (!dorP) { await new Promise(r => setTimeout(r, 150)); continue; }
                outD.orders_do_pack.push({ id: dorP.id, shipping_id: (dorP.shipping && dorP.shipping.id) || null, total: dorP.total_amount, frete_comprador: (dorP.shipping && dorP.shipping.cost) != null ? dorP.shipping.cost : null, pagamentos: (dorP.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) });
                if (!dor) dor = dorP;
                await new Promise(r => setTimeout(r, 150));
              }
              if (!dor) outD.erros.push('nenhuma order do pack respondeu');
            } else outD.erros.push('packs: HTTP ' + rp.status);
          } catch (e3) { outD.erros.push('packs: ' + String(e3.message || e3).slice(0, 120)); }
        } else if (!ro.ok) { outD.erros.push('orders: HTTP ' + ro.status); }
        // Codex PR#46 (5a rodada): se veio uma ORDER de carrinho (payload OK com pack_id), as
        // irmas nunca eram abertas — a compensacao Flex pode estar em qualquer uma delas
        if (dor && dor.pack_id && !outD.resolvido_de_pack) {
          try {
            const rpk = await fetch('https://api.mercadolibre.com/packs/' + encodeURIComponent(dor.pack_id), HD);
            const dpk = rpk.ok ? await rpk.json().catch(() => null) : null;
            const idsIrmas = dpk && Array.isArray(dpk.orders) ? dpk.orders.map(o => o.id || o) : [];
            if (idsIrmas.length) {
              outD.resolvido_de_pack = { pack: String(dor.pack_id), orders: idsIrmas, veio_de: 'order' };
              outD.orders_do_pack = outD.orders_do_pack || [];
              for (const oidI of idsIrmas) {
                if (String(oidI) === String(dor.id)) { outD.orders_do_pack.push({ id: dor.id, shipping_id: (dor.shipping && dor.shipping.id) || null, total: dor.total_amount, frete_comprador: (dor.shipping && dor.shipping.cost) != null ? dor.shipping.cost : null, pagamentos: (dor.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) }); continue; }
                try {
                  const roI = await fetch('https://api.mercadolibre.com/orders/' + oidI, HD);
                  const dorI = roI.ok ? await roI.json().catch(() => null) : null;
                  if (!dorI) { outD.erros.push('orders(' + oidI + '): HTTP ' + roI.status); continue; }
                  outD.orders_do_pack.push({ id: dorI.id, shipping_id: (dorI.shipping && dorI.shipping.id) || null, total: dorI.total_amount, frete_comprador: (dorI.shipping && dorI.shipping.cost) != null ? dorI.shipping.cost : null, pagamentos: (dorI.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) });
                } catch (eI) { outD.erros.push('orders(' + oidI + '): ' + String(eI.message || eI).slice(0, 120)); }
                await new Promise(r => setTimeout(r, 150));
              }
            } else outD.erros.push('packs(' + dor.pack_id + '): HTTP ' + rpk.status);
          } catch (ePk) { outD.erros.push('packs(' + dor.pack_id + '): ' + String(ePk.message || ePk).slice(0, 120)); }
        }
        if (!dor) { outD.erros.push('sem order utilizavel'); }
        else {
          outD.order = { id: dor.id, pack_id: dor.pack_id || null, status: dor.status, total: dor.total_amount, pago: dor.paid_amount, frete_comprador: (dor.shipping && dor.shipping.cost) != null ? dor.shipping.cost : null };
          outD.pagamentos = (dor.payments || []).map(pg => ({ id: pg.id, status: pg.status, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee, tipo: pg.payment_type }));
          // Codex PR#46 (4a rodada): num carrinho o envio pode estar em QUALQUER das orders —
          // junta todos os shipment ids distintos e consulta cada um. E cada fonte tem try
          // proprio: falha de transporte em /shipments nao pode impedir a consulta a /costs,
          // que e justamente a outra candidata que esta rota existe pra comparar.
          const shipIds = [];
          for (const cand of [dor].concat(outD.orders_do_pack ? [] : [])) { const sid = cand && cand.shipping && cand.shipping.id; if (sid && !shipIds.includes(sid)) shipIds.push(sid); }
          for (const oP of (outD.orders_do_pack || [])) { const sid = oP && oP.shipping_id; if (sid && !shipIds.includes(sid)) shipIds.push(sid); }
          if (!shipIds.length) outD.erros.push('nenhuma order tem shipping.id');
          outD.envios = [];
          for (const shipId of shipIds) {
            const linhaE = { shipment_id: shipId, shipment: null, costs: null };
            try {
              const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, HD);
              const ds = rs.ok ? await rs.json().catch(() => null) : null;
              if (ds) { const soD = ds.shipping_option || {}; linhaE.shipment = { logistic: (ds.logistic && ds.logistic.type) || ds.logistic_type || null, status: ds.status, base_cost: ds.base_cost, list_cost: soD.list_cost != null ? soD.list_cost : ds.list_cost, cost: soD.cost != null ? soD.cost : ds.cost }; }
              else outD.erros.push('shipments(' + shipId + '): HTTP ' + rs.status);
            } catch (eS) { outD.erros.push('shipments(' + shipId + '): ' + String(eS.message || eS).slice(0, 120)); }
            try {
              const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', HD);
              const dc = rc.ok ? await rc.json().catch(() => null) : null;
              if (dc) {
                const sd = Array.isArray(dc.senders) ? dc.senders[0] : null;
                linhaE.costs = { gross_amount: dc.gross_amount, receiver_cost: dc.receiver && dc.receiver.cost, sender_cost: sd && sd.cost, compensation: sd && sd.compensation, compensations: (sd && sd.compensations) || [], save: sd && sd.save, discounts: (sd && sd.discounts) || null };
              } else outD.erros.push('costs(' + shipId + '): HTTP ' + rc.status);
            } catch (eC) { outD.erros.push('costs(' + shipId + '): ' + String(eC.message || eC).slice(0, 120)); }
            outD.envios.push(linhaE);
            await new Promise(r => setTimeout(r, 150));
          }
          // compatibilidade: os campos antigos apontam pro 1o envio
          if (outD.envios.length) { outD.shipment = Object.assign({ id: outD.envios[0].shipment_id }, outD.envios[0].shipment || {}); outD.costs = outD.envios[0].costs; }
        }
      } catch (e) { outD.erros.push('ML: ' + String(e.message || e).slice(0, 160)); }

      try {
        const arqD = readJson(path.join(CACHE_DIR, '_ml_billing.json'), null);
        // Codex PR#46: cache ausente/corrompido NAO pode parecer "cache sem linhas" — isso
        // inverteria o diagnostico. Sem tarifas legiveis, e falha de FONTE e vai pros erros.
        if (!arqD || typeof arqD !== 'object' || !arqD.tarifas || typeof arqD.tarifas !== 'object') {
          outD.erros.push('billing: _ml_billing.json ausente ou invalido (fonte indisponivel, nao "sem linhas")');
          outD.billing = null;
          json(res, 200, outD);
          return true;
        }
        // Codex PR#46: no carrinho o credito costuma estar na ORDER, nao no pack — junta todos
        // os ids conhecidos (o pedido pedido, a order resolvida, o pack e as orders do pack)
        const chavesD = new Set([vendaD]);
        if (outD.order && outD.order.id) chavesD.add(String(outD.order.id));
        if (outD.order && outD.order.pack_id) chavesD.add(String(outD.order.pack_id));
        for (const oid2 of ((outD.resolvido_de_pack && outD.resolvido_de_pack.orders) || [])) chavesD.add(String(oid2));
        // Codex PR#46: se a API do ML falhou, o proprio CACHE liga order↔pack (mesmo mapa que o
        // aplicarCreditosFlex monta) — assim o billing continua correto sem depender do ML
        const tarifasD = Object.values(arqD.tarifas || {});
        for (let volta = 0; volta < 2; volta++) {
          for (const tf of tarifasD) {
            if (!tf) continue;
            const o = String(tf.o || ''), pk = String(tf.p || '');
            if (o && pk) { if (chavesD.has(o)) chavesD.add(pk); if (chavesD.has(pk)) chavesD.add(o); }
          }
        }
        outD.chaves_consultadas = [...chavesD];
        for (const tf of tarifasD) {
          if (!tf) continue;
          if (chavesD.has(String(tf.o || '')) || chavesD.has(String(tf.p || ''))) outD.billing.push({ data: tf.d, valor: tf.v, categoria: tf.c, texto: tf.t });
        }
      } catch (e) { outD.erros.push('billing: ' + String(e.message || e).slice(0, 120)); }

      json(res, 200, outD);
      return true;
    }

    // CRÉDITOS FLEX — distribui os bônus de envio do billing no histórico (?de=&ate=; sem período = ano)
    if (method === 'GET' && p === '/amb-checkout-offline/ml-creditos-flex') {
      // guarda no padrão das rotas do dashboard: chave admin OU sessão de admin logado
      // (ehAdmin sozinho NÃO serve — recebe NOME de operador, não chave; sem sessão ele libera)
      const k = urlObj.searchParams.get('k') || '';
      const sessCF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessCF && ehAdmin(sessCF)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, _mlcred); return true; }
      const de = urlObj.searchParams.get('de') || '2026-01-01';
      const ate = urlObj.searchParams.get('ate') || new Date().toISOString().slice(0, 10);
      if (_mlcred.rodando) { json(res, 200, { ok: false, ja_rodando: true, msg: 'uma distribuição já está em andamento (' + (_mlcred.de || '?') + ' a ' + (_mlcred.ate || '?') + ') — acompanhe em ?status=1 e repita depois', de: _mlcred.de, ate: _mlcred.ate }); return true; }
      aplicarCreditosFlex(de, ate).catch(() => {});
      json(res, 200, { ok: true, msg: 'distribuindo créditos Flex de ' + de + ' a ' + ate + ' em background — acompanhe em ?status=1', de, ate });
      return true;
    }

    // ── AUTORIZAÇÃO DO ML PELA AMB (14/08) ────────────────────────────────────────
    // O setup do ML vive no módulo `ambtotal`, que NÃO está respondendo neste serviço
    // (/amb/setup-ml devolve 404 do roteador raiz = nenhum módulo tratou). Como o
    // reconsentimento é obrigatório pra liberar as devoluções (o token atual não ganha o
    // escopo novo sozinho), a autorização passa a existir também aqui, no módulo que está
    // no ar. Usa o MESMO mlTokenManager da AMB — não cria credencial nova.
    //   1) /amb-checkout-offline/setup-ml?k=      → manda pro ML autorizar
    //   2) o ML volta pro redirect cadastrado com ?code=… (se aquele caminho der 404,
    //      basta copiar o code da barra de endereços)
    //   3) /amb-checkout-offline/ml-trocar-code?code=…&k=  → grava o token novo
    if (method === 'GET' && (p === '/amb-checkout-offline/setup-ml' || p === '/amb-checkout-offline/ml-trocar-code')) {
      const kA = urlObj.searchParams.get('k') || '';
      const sA = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kA === process.env.ADMIN_KEY) || (sA && ehAdmin(sA)))) { json(res, 404, { error: 'not found' }); return true; }
      let mlTM = null;
      try { mlTM = require('../ambtotal/mlTokenManager'); }
      catch (e) { json(res, 500, { ok: false, erro: 'mlTokenManager da AMB indisponível: ' + String(e.message || e).slice(0, 160) }); return true; }
      if (p.endsWith('/setup-ml')) {
        try {
          const url = mlTM.gerarUrlAutorizacao();
          if (urlObj.searchParams.get('link') === '1') { json(res, 200, { ok: true, url, leia: 'abra esta URL logado como AMBTotal; depois copie o code do endereço e chame /amb-checkout-offline/ml-trocar-code?code=…&k=' }); return true; }
          res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' }); res.end();
        } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
        return true;
      }
      const code = String(urlObj.searchParams.get('code') || '').trim();
      if (!code) { json(res, 400, { ok: false, erro: 'passe ?code=… (o código que o ML devolveu na URL depois de autorizar)' }); return true; }
      try {
        await mlTM.trocarCodigoPorToken(code);
        json(res, 200, { ok: true, msg: 'token do ML da AMB renovado com o escopo novo. Rode /amb-checkout-offline/ml-devolucoes-coletar?dias=60&k=…' });
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 250) }); }
      return true;
    }

    // ── COMPLETAR TARIFA DO TIKTOK (18/08) ────────────────────────────────────────
    if (method === 'GET' && p === '/amb-checkout-offline/tiktok-completar-tarifa') {
      const kT = urlObj.searchParams.get('k') || '';
      const sT = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kT === process.env.ADMIN_KEY) || (sT && ehAdmin(sT)))) { json(res, 404, { error: 'not found' }); return true; }
      const r = await completarTarifaTikTok(urlObj.searchParams.get('dias'), { simular: urlObj.searchParams.get('simular') === '1' });
      json(res, 200, r);
      return true;
    }

    // ── CANÁRIO MARKETPLACE × BLING na AMB (17/08) ────────────────────────────────
    // Portado da Girassol, onde pegou 38 pedidos da Shopee que não desceram ao Bling depois do
    // token da integração expirar em silêncio. Vem pra cá porque agosto da AMB fechou com 723
    // linhas (~43/dia contra ~54/dia em julho): sem conferir, não dá pra saber se é venda menor
    // ou pedido que não chegou. A lib é a mesma; só as fontes mudam de empresa.
    if (method === 'GET' && p === '/amb-checkout-offline/canario-marketplaces') {
      const kC = urlObj.searchParams.get('k') || '';
      const sC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY) || (sC && ehAdmin(sC)))) { json(res, 404, { error: 'not found' }); return true; }
      const r = await conferirMarketplaces(urlObj.searchParams.get('dias'),
        String(urlObj.searchParams.get('canais') || '').split(',').map(s => s.trim()).filter(Boolean),
        { todos: urlObj.searchParams.get('todos') === '1' });
      json(res, 200, r);
      return true;
    }

    // ── DEVOLUÇÕES DO ML (14/08) — mesma lib da Girassol, empresa como parâmetro ──────
    // A busca do ML mistura devolução com reclamação e cancelamento; só `returns` conta.
    // SKU/valor vêm do PRÓPRIO pedido no ML (o histórico às vezes guarda o pack, não o order).
    if (method === 'GET' && (p === '/amb-checkout-offline/ml-devolucoes' || p === '/amb-checkout-offline/ml-devolucoes-coletar')) {
      const kV = urlObj.searchParams.get('k') || '';
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const mlDevLib = require('../lib/ml-devolucoes');
      const buscarNoHistorico = async (orderIds) => {
        const ids = Array.from(new Set((orderIds || []).map(x => String(x || '').trim()).filter(Boolean)));
        const mapa = {};
        for (let i0 = 0; i0 < ids.length; i0 += 40) {
          const lote = ids.slice(i0, i0 + 40);
          const q = 'vendas_historico?empresa=eq.amb&numero_loja=in.(' + lote.map(encodeURIComponent).join(',') + ')' +
                    '&select=numero_loja,sku,descricao,valor_produto,quantidade&limit=1000';
          try {
            const rr = await supaReq('amb', 'GET', q, null);
            if (!rr.ok) continue;
            const arr = JSON.parse(rr.body || '[]');
            if (!Array.isArray(arr)) continue;
            for (const l of arr) {
              const k = String((l && l.numero_loja) || '');
              if (!k) continue;
              if (!mapa[k]) mapa[k] = { sku: l.sku || null, nome: l.descricao || null, valor: 0 };
              mapa[k].valor = Math.round((mapa[k].valor + (Number(l.valor_produto) || 0)) * 100) / 100;
            }
          } catch (e) {}
        }
        return mapa;
      };
      const ctxDev = { CACHE_DIR, path, readJson, writeJson, buscarNoHistorico };
      if (p.endsWith('-coletar')) {
        let tkV = null;
        try { const { garantirTokenML: _gv } = require('../ambtotal/mlTokenManager'); tkV = await _gv(); }
        catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + String(e.message || e).slice(0, 160) }); return true; }
        const r = await mlDevLib.coletarDevolucoesML(Object.assign({ token: tkV }, ctxDev), urlObj.searchParams.get('dias'), { refazer: urlObj.searchParams.get('refazer') === '1' });
        json(res, 200, r);
        return true;
      }
      const de = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ate = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (de > ate) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
      json(res, 200, Object.assign({ ok: true, de, ate }, await mlDevLib.resumoDevolucoesML(ctxDev, de, ate)));
      return true;
    }

    if (method === 'GET' && p === '/amb-checkout-offline/ml-billing-resumo') {
      // Codex PR#38 (P1): financeiro é SÓ ADMIN — mesma guarda das rotas irmãs do dashboard
      const sBil = validarSessao(req.headers['cookie']);
      const kBil = urlObj.searchParams.get('k') || '';
      if (!((process.env.ADMIN_KEY && kBil === process.env.ADMIN_KEY) || (sBil && ehAdmin(sBil)))) { json(res, 404, { error: 'not found' }); return true; }
      const b = readJson(MLB_FILE(), { porDia: {} });
      const deB = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateB = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      const out = {};
      for (const [dia, cats] of Object.entries(b.porDia || {})) {
        if (deB && dia < deB) continue;
        if (ateB && dia > ateB) continue;
        for (const [c, v] of Object.entries(cats)) out[c] = Math.round(((out[c] || 0) + v) * 100) / 100;
      }
      json(res, 200, { ok: true, de: deB, ate: ateB, categorias: out, atualizado: b.atualizado || null });
      return true;
    }


    // 02/08 - VENDAS DIRETO DO MERCADO LIVRE (o marketplace e a fonte; o Bling e espelho).
    // Decisao do Diego: se a venda ocorreu no dia, tem que aparecer no dia — mesmo que o ML ainda
    // nao tenha organizado o envio e o Bling nem saiba dela (envio agendado, Fulfillment, etc).
    // ESTE E O PASSO 1: so LE do ML e compara com o que temos. Nao muda nada em producao.
    if (method === 'GET' && p === '/amb-checkout-offline/ml-vendas-do-dia') {
      const kV = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const deV  = String(urlObj.searchParams.get('de')  || new Date().toISOString().slice(0,10)).slice(0,10);
      const ateV = String(urlObj.searchParams.get('ate') || deV).slice(0,10);
      const out = { ok: true, de: deV, ate: ateV, passos: [] };

      let tokenML = null;
      try { const { garantirTokenML } = require('../ambtotal/mlTokenManager'); tokenML = await garantirTokenML(); }
      catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + (e.message || e) }); return true; }
      const H = { headers: { Authorization: 'Bearer ' + tokenML } };

      // 1) quem sou eu (seller id)
      let sellerId = null;
      try {
        const rm = await fetch('https://api.mercadolibre.com/users/me', H);
        const bd = await rm.text();
        out.passos.push({ passo: 'users/me', status: rm.status, resposta: bd.slice(0, 200) });
        if (rm.ok) { try { sellerId = JSON.parse(bd).id; } catch (e) {} }
      } catch (e) { out.passos.push({ passo: 'users/me', erro: String(e.message || e).slice(0, 140) }); }
      if (!sellerId) { out.erro = 'nao consegui o seller id'; json(res, 200, out); return true; }
      out.seller = sellerId;

      // 2) vendas do periodo, paginando (mesmo padrao ja usado em auto-mensagens)
      const from = deV + 'T00:00:00.000-03:00', to = ateV + 'T23:59:59.999-03:00';
      const base = 'https://api.mercadolibre.com/orders/search?seller=' + sellerId +
                   '&order.date_created.from=' + encodeURIComponent(from) +
                   '&order.date_created.to=' + encodeURIComponent(to) + '&sort=date_asc&limit=50';
      const vendas = [];
      let total = Infinity;
      for (let off = 0; off < 1000 && off < total; off += 50) {
        const r = await fetch(base + '&offset=' + off, H);
        const bd = await r.text();
        if (off === 0) out.passos.push({ passo: 'orders/search', status: r.status, resposta: bd.slice(0, 260) });
        if (!r.ok) break;
        let d = null; try { d = JSON.parse(bd); } catch (e) { break; }
        const arr = (d && d.results) || [];
        for (const o of arr) {
          const it = (o.order_items || [])[0] || {};
          vendas.push({ order_id: String(o.id), pack_id: o.pack_id ? String(o.pack_id) : null,
            data: String(o.date_created || '').slice(0, 19), status: o.status,
            valor: Number(o.total_amount) || 0,
            sku: (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || null,
            titulo: (it.item && String(it.item.title || '').slice(0, 40)) || null });
        }
        const t = Number(d && d.paging && d.paging.total);
        total = isFinite(t) ? t : vendas.length;
        if (arr.length < 50) break;
        await new Promise(r2 => setTimeout(r2, 300));
      }
      out.vendas_no_ml = vendas.length;
      out.total_informado_pelo_ml = (isFinite(total) ? total : null);
      out.faturamento_ml = Math.round(vendas.reduce((a, v) => a + v.valor, 0) * 100) / 100;
      out.por_status = vendas.reduce((a, v) => { a[v.status] = (a[v.status] || 0) + 1; return a; }, {});

      // 3) o que ja temos no historico
      const nosso = new Set();
      try {
        const cfg = supaCfg('amb');
        if (cfg.url && cfg.key) {
          const HB = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
          const B = cfg.url.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.amb&canal=eq.ml' +
                    '&data_venda=gte.' + deV + '&data_venda=lte.' + ateV;
          for (let o2 = 0; o2 < 20000; o2 += 1000) {
            const rq = await fetch(B + '&select=numero_loja&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + o2, { headers: HB });
            if (!rq.ok) break;
            const ln = await rq.json().catch(() => []);
            if (!Array.isArray(ln) || !ln.length) break;
            for (const l of ln) if (l.numero_loja) nosso.add(String(l.numero_loja).trim());
            if (ln.length < 1000) break;
          }
        }
      } catch (e) { out.erro_supabase = String(e.message || e).slice(0, 140); }
      out.no_nosso_historico = nosso.size;

      const faltam = vendas.filter(v => !nosso.has(v.order_id) && !(v.pack_id && nosso.has(v.pack_id)));
      out.faltando = faltam.length;
      out.valor_faltante = Math.round(faltam.reduce((a, v) => a + v.valor, 0) * 100) / 100;
      out.lista = faltam.slice(0, 60);
      out.veredito = faltam.length
        ? faltam.length + ' venda(s) existem no Mercado Livre e NAO no nosso historico — sao essas que o dashboard nao mostra'
        : 'tudo o que o ML tem no periodo ja esta no nosso historico';
      json(res, 200, out); return true;
    }

    if (method === 'GET' && p === '/amb-checkout-offline/ml-vendas-faltando') {
      const kF = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kF === process.env.ADMIN_KEY) || (sF && ehAdmin(sF)))) { json(res, 404, { error: 'not found' }); return true; }
      const deF = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateF = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!deF || !ateF) { json(res, 400, { ok: false, erro: 'informe ?de=2026-07-01&ate=2026-07-31' }); return true; }

      // 1) vendas que o ML cobrou comiss\u00e3o no per\u00edodo
      const b = readJson(MLB_FILE(), { tarifas: {} });
      // 02/08 \u2014 O MAPA VENDA\u2192PACK VEM DE **TODAS** AS TARIFAS, n\u00e3o s\u00f3 das comiss\u00f5es.
      // O shipping_info (onde mora o pack_id) nem sempre vem na linha da comiss\u00e3o \u2014 na amostra que
      // o ML mandou ele apareceu numa TAXA DE PARCELAMENTO. Filtrar por comiss\u00e3o antes de montar o
      // mapa jogava fora justamente a linha que tinha o pack, e metade da lista vinha com pack:null.
      // O pack \u00e9 propriedade do pedido, ent\u00e3o o mapa ignora data e categoria.
      const packDe = new Map();
      for (const t of Object.values(b.tarifas || {})) if (t.o && t.p) packDe.set(String(t.o), String(t.p));
      const doML = new Map();   // numero da venda -> { comiss\u00e3o somada, pack }
      let semPack = 0;
      for (const t of Object.values(b.tarifas || {})) {
        if (!t.o || !t.d) continue;
        if (t.d < deF || t.d > ateF) continue;
        if (t.c !== 'comissao') continue;
        { const at = doML.get(String(t.o)) || { com: 0, pack: null };
          doML.set(String(t.o), { com: Math.round((at.com + t.v) * 100) / 100, pack: t.p || at.pack || packDe.get(String(t.o)) || null }); }
      }

      // 2) o que temos no hist\u00f3rico
      const { url: uF, key: kSup } = supaCfg('amb');
      const nosso = new Set();
      if (uF && kSup) {
        const HF = { apikey: kSup, Authorization: 'Bearer ' + kSup };
        const BF = uF.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.amb&canal=eq.ml' +
                   '&data_venda=gte.' + deF + '&data_venda=lte.' + ateF;
        for (let off = 0; off < 80000; off += 1000) {
          const rF = await fetch(BF + '&select=numero_loja&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + off, { headers: HF });
          if (!rF.ok) break;
          const ln = await rF.json().catch(() => []);
          if (!Array.isArray(ln) || !ln.length) break;
          for (const l of ln) if (l.numero_loja) nosso.add(String(l.numero_loja).trim());
          if (ln.length < 1000) break;
        }
      }

      // 3) o que o ML tem e n\u00f3s n\u00e3o. Aten\u00e7\u00e3o ao CARRINHO: o Bling junta o pack num pedido s\u00f3,
      // ent\u00e3o uma venda "faltando" pode estar dentro de um pedido nosso com outro n\u00famero.
      // 02/08: s\u00f3 conta como faltando se NEM a venda NEM o carrinho estiverem no nosso hist\u00f3rico
      const faltam = []; let achadasPeloPack = 0;
      for (const [venda, info] of doML.entries()) {
        if (nosso.has(venda)) continue;
        if (info.pack && nosso.has(String(info.pack))) { achadasPeloPack++; continue; }
        if (!info.pack) semPack++;
        faltam.push({ venda, pack: info.pack || null, comissao_ml: info.com });
      }
      faltam.sort((a, b2) => b2.comissao_ml - a.comissao_ml);
      const somaCom = Math.round(faltam.reduce((a, x) => a + x.comissao_ml, 0) * 100) / 100;

      json(res, 200, { ok: true, de: deF, ate: ateF,
        vendas_no_ml: doML.size, vendas_no_nosso_historico: nosso.size, faltando: faltam.length, achadas_pelo_carrinho: achadasPeloPack, faltantes_sem_pack_conhecido: semPack, packs_mapeados: packDe.size,
        comissao_das_faltantes: somaCom,
        estimativa_faturamento_faltante: Math.round(somaCom / 0.125 * 100) / 100,
        aviso: 'venda do ML pode estar dentro de um CARRINHO no nosso lado (o Bling junta o pack num pedido s\u00f3) \u2014 confira algumas no Bling antes de concluir',
        amostra: faltam.slice(0, 40) });
      return true;
    }

    // 01/08 — varredura de cancelados: apaga do histórico quem foi cancelado no Bling
    if (method === 'GET' && p === '/amb-checkout-offline/varrer-cancelados') {
      const kV = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const dV = Number((urlObj.searchParams && urlObj.searchParams.get('dias')) || 45);
      varrerCancelados(dV, 'amb').catch(e => console.log('[CANCEL] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'varrendo cancelados em background', dias: dV, status: '/amb-checkout-offline/varrer-cancelados-status' });
      return true;
    }
    if (method === 'GET' && p === '/amb-checkout-offline/varrer-cancelados-status') {
      json(res, 200, { ok: true, status: _varre, situacoes_descobertas: _sitCancel }); return true;
    }


    // 01/08 — progresso do "reaplicar imposto" (o dashboard mostra no rodapé da seção Impostos)
    if (method === 'GET' && p === '/amb-checkout-offline/reaplicar-status') {
      json(res, 200, { ok: true, status: _reap }); return true;
    }
    // disparo manual: ?meses=2026-07,2026-08  (ou ?meses=todos p/ o ano inteiro)
    if (method === 'GET' && p === '/amb-checkout-offline/reaplicar-imposto') {
      const kR = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sR = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY) || (sR && ehAdmin(sR)))) { json(res, 404, { error: 'not found' }); return true; }
      let mm = String((urlObj.searchParams && urlObj.searchParams.get('meses')) || '').trim();
      let lista;
      if (!mm || mm === 'todos') { const cfgT = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
                                   lista = Object.keys(cfgT.aliquotas || {}).filter(x => /^\d{4}-\d{2}$/.test(x)).sort(); }
      else lista = mm.split(',').map(x => x.trim()).filter(x => /^\d{4}-\d{2}$/.test(x));
      if (!lista.length) { json(res, 400, { ok: false, erro: 'informe ?meses=AAAA-MM,AAAA-MM ou ?meses=todos' }); return true; }
      reaplicarImposto(lista, 'amb').catch(e => console.log('[FISCAL] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'reaplicando imposto em background', meses: lista, status: '/amb-checkout-offline/reaplicar-status' });
      return true;
    }





    // STATUS NO MARKETPLACE: pergunta ao ML/Shopee se o pedido foi CANCELADO pelo cliente.
    // O Bling demora (ou não) pra refletir isso; o dashboard precisa mostrar cinza na hora.
    // Uso: /amb-checkout-offline/status-mkt?de=YYYY-MM-DD&ate=YYYY-MM-DD
    if (method === 'GET' && p === '/amb-checkout-offline/status-mkt') {
      const kS = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessS = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kS === process.env.ADMIN_KEY) || (sessS && ehAdmin(sessS)))) { json(res, 404, { error: 'not found' }); return true; }
      const deS = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '').slice(0, 10);
      const ateS = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deS) || !/^\d{4}-\d{2}-\d{2}$/.test(ateS)) { json(res, 400, { ok: false, erro: 'passe &de=&ate=' }); return true; }
      const FS = path.join(CACHE_DIR, '_vendas_dia.json');
      const atualS = readJson(FS, {});
      const noPeriodo = Object.values(atualS).filter(v => {
        if (!v || v.numero == null || !v.numero_loja) return false;
        if (/cancel/i.test(String(v.situacao || ''))) return false;   // já sabemos que caiu
        const d = String(v.data || '').slice(0, 10);
        return d >= deS && d <= ateS;
      });
      let checados = 0, cancelados = [];
      // ── ML ──
      const alvoML = noPeriodo.filter(v => v.marketplace === 'ml' || v.marketplace === 'mercadolivre').slice(0, 80);
      if (alvoML.length) {
        let tkS = null; try { const { garantirTokenML: _g5 } = require('../ambtotal/mlTokenManager'); tkS = await _g5(); } catch (e) {}
        if (tkS) {
          for (const v of alvoML) {
            try {
              const nlS = String(v.numero_loja).replace(/\D/g, '');
              let rS = await fetch('https://api.mercadolibre.com/orders/' + nlS, { headers: { Authorization: 'Bearer ' + tkS } });
              let dS = await rS.json().catch(() => null);
              if (!rS.ok) {   // pode ser PACK (carrinho): pega o 1º pedido de dentro
                const rp = await fetch('https://api.mercadolibre.com/packs/' + nlS, { headers: { Authorization: 'Bearer ' + tkS } });
                const dp = await rp.json().catch(() => null);
                const o1 = dp && dp.orders && dp.orders[0];
                if (o1) { rS = await fetch('https://api.mercadolibre.com/orders/' + (o1.id || o1), { headers: { Authorization: 'Bearer ' + tkS } }); dS = await rS.json().catch(() => null); }
              }
              checados++;
              if (rS.ok && dS && String(dS.status || '').toLowerCase() === 'cancelled') {
                v.situacao = 'Cancelado no Mercado Livre'; v.cancelado_mkt = 1; cancelados.push(v.numero);
              }
            } catch (e) {}
            await new Promise(r5 => setTimeout(r5, 260));
          }
        }
      }
      // ── SHOPEE (em lote de 20 pela rota interna do shopee-nf-sync) ──
      // 11/08 — ATENÇÃO: existe UM SÓ serviço Shopee, multi-loja (`/amb`, `/girassol`, `/good`).
      // O host tem nome de girassol por ter sido o primeiro, mas atende as três empresas; o repo
      // chama-se ambtotal-shopee-nf-sync-x-bling. Eu tinha apontado a AMB pro nome do REPO —
      // hostname que não existe no Render — e TODA chamada de escrow do ano voltou 404 "Not Found"
      // (era a causa do escrow_sem_resposta em 100% dos pedidos Shopee desde janeiro).
      const alvoSH = noPeriodo.filter(v => v.marketplace === 'shopee').slice(0, 60);
      const SHU = process.env.AMBBKP_SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const SHK = process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '';
      if (alvoSH.length && SHK) {
        for (let i = 0; i < alvoSH.length; i += 20) {
          const fatia = alvoSH.slice(i, i + 20);
          try {
            const rSh = await fetch(SHU + '/' + (process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb') + '/interno/margem-pedidos?k=' + encodeURIComponent(SHK) + '&order_sns=' + encodeURIComponent(fatia.map(v => v.numero_loja).join(',')));
            const dSh = await rSh.json().catch(() => null);
            const lst = (dSh && (dSh.pedidos || dSh.data)) || null;
            if (lst) {
              const porSn2 = Array.isArray(lst) ? Object.fromEntries(lst.map(x => [String(x.order_sn), x])) : lst;
              for (const v of fatia) {
                const pS2 = porSn2[String(v.numero_loja)];
                checados++;
                if (pS2 && /cancel/i.test(String(pS2.order_status || ''))) { v.situacao = 'Cancelado na Shopee'; v.cancelado_mkt = 1; cancelados.push(v.numero); }
              }
            }
          } catch (e) {}
        }
      }
      try { writeJson(FS, atualS); } catch (e) {}
      // marca também nos CONFERIDOS (pedidos já bipados) — é de lá que o dashboard monta a linha
      if (cancelados.length) {
        try {
          const confM = readJson(CONFERIDOS_FILE, {});
          const alvo = new Set(cancelados.map(x => String(x)));
          let mex = 0;
          for (const k of Object.keys(confM)) { const c = confM[k]; if (c && alvo.has(String(c.numero))) { c.cancelado = 1; mex++; } }
          if (mex) writeJson(CONFERIDOS_FILE, confM);
        } catch (e) {}
      }
      json(res, 200, { ok: true, checados, cancelados_agora: cancelados.length, numeros: cancelados.slice(0, 30) });
      return true;
    }

    // COMPLETAR DETALHES do período que o dashboard está mostrando (SKU/qtd/taxas dos ainda não bipados).
    // Uso: /amb-checkout-offline/completar-detalhes?de=YYYY-MM-DD&ate=YYYY-MM-DD
    // Processa um lote curto e devolve quantos faltam — o dashboard chama em sequência até zerar.
    if (method === 'GET' && p === '/amb-checkout-offline/completar-detalhes') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const deD = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '').slice(0, 10);
      const ateD = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deD) || !/^\d{4}-\d{2}-\d{2}$/.test(ateD)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      const FV = path.join(CACHE_DIR, '_vendas_dia.json');
      const atualD = readJson(FV, {});
      const confD = readJson(CONFERIDOS_FILE, {});
      const bipD = new Set(Object.values(confD).map(c => String(c && c.numero)));
      const faltando = Object.values(atualD).filter(v => {
        if (!v || v.det || v.numero == null) return false;
        if (bipD.has(String(v.numero))) return false;
        if (/cancel/i.test(String(v.situacao || ''))) return false;
        const d = String(v.data || '').slice(0, 10);
        return d >= deD && d <= ateD;
      }).sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
      const lote = faltando.slice(0, 40);   // ~18s por chamada — o dashboard repete até zerar
      let feitos = 0;
      // 04/08 CONSERTO: este teto era lido de '_nfHoraOrc', que so existe dentro do vendasSync.
      // Aqui ele nunca foi declarado: todo pedido SEM hora do canal estourava ReferenceError dentro
      // do try, o catch vazio engolia, e o 'v.det = 1; feitos++' logo abaixo nunca rodava — o pedido
      // ficava "faltando" pra sempre e o dashboard repetia a chamada sem nunca zerar.
      let nfHoraNoLote = 0;   // teto de consultas de hora da NF por CHAMADA
      for (const v of lote) {
        try {
          const rd = await blingGet('/pedidos/vendas/' + v.id);
          const det = (rd && rd.ok && rd.data && rd.data.data) || null;
          if (det) {
            if (!v.numero_loja && det.numeroPedidoLoja) v.numero_loja = det.numeroPedidoLoja;
            if (!v.marketplace || v.marketplace === 'outro') { const lj3 = String((det.loja && det.loja.id) || ''); v.marketplace = LOJA_MKT[lj3] || _inferCanal(v.numero_loja); }
            v.it = (det.itens || []).map(i2 => ({ sku: (i2.codigo || (i2.produto && i2.produto.codigo) || '').trim() || null, d: (i2.descricao || (i2.produto && i2.produto.nome) || '').slice(0, 120) || null, qtd: Number(i2.quantidade || 1), vt: Math.round(Number(i2.valor || 0) * Number(i2.quantidade || 1) * 100) / 100 }));   // 28/07: +d = nome do produto, p/ o cartão do celular mostrar o título também nas vendas ainda não bipadas
            const tc2 = det.taxas && Number(det.taxas.taxaComissao); if (isFinite(tc2) && tc2 > 0) v.taxa_mkt = Math.round(tc2 * 100) / 100;
            const cf2 = det.taxas && Number(det.taxas.custoFrete); if (isFinite(cf2) && cf2 > 0) v.frete_mkt = Math.round(cf2 * 100) / 100;
            if (det.situacao && (det.situacao.valor || det.situacao.nome)) v.situacao = det.situacao.valor || det.situacao.nome;
            // 29/07: HORA DA VENDA pros canais que não informam (TikTok, Magalu…). Sem isso o cartão
          // caía pra data, que no filtro HOJE não diz nada. O detalhe do pedido traz o id da NF;
          // com ele pegamos a hora da EMISSÃO. Só fazemos isso quando NÃO há hora do canal, e no
          // máximo algumas por rodada, pra não pesar no limite do Bling.
          if (!v.venda_em && !v.nf_em && nfHoraNoLote < 25) {
            const nfId = (det.notaFiscal && (det.notaFiscal.id || det.notaFiscal)) || null;
            if (nfId) {
              nfHoraNoLote++;
              try {
                const rn = await blingGet('/nfe/' + nfId);
                const nfd = (rn && rn.ok && rn.data && rn.data.data) || null;
                const dEm = nfd && (nfd.dataEmissao || nfd.data_emissao || nfd.dataOperacao);
                if (dEm) v.nf_em = String(dEm).replace(' ', 'T').slice(0, 16);
              } catch (e) {}
            }
          }
          v.det = 1; feitos++;
          }
        } catch (e) {}
        if ((feitos % 10) === 0) { try { writeJson(FV, atualD); } catch (e) {} }
        await new Promise(r4 => setTimeout(r4, 430));
      }
      try { writeJson(FV, atualD); } catch (e) {}
      json(res, 200, { ok: true, feitos, restantes: Math.max(0, faltando.length - feitos) });
      return true;
    }

    // STATUS do backfill em andamento. Uso: /amb-checkout-offline/backfill-status
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-status') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, { ok: true, status: _backfill, ano: (_backfillAno.rodando || _backfillAno.fim) ? _backfillAno : undefined });
      return true;
    }

    // TESTE de conexão com o Supabase (histórico) — grava e apaga 1 registro. Confirma antes do backfill.
    // Uso: /amb-checkout-offline/backfill-teste
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-teste') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const out = { ok: true };
      const { url } = supaCfg('amb');
      out.url_configurada = url ? (String(url).slice(0, 30) + '…') : 'FALTANDO';
      const marca = '__TESTE_' + Date.now();
      const ins = await supaReq('amb', 'POST', 'vendas_historico', [{ empresa: 'amb', numero_pedido: marca, canal: 'teste', data_venda: '2026-01-01', sku: 'TESTE-CONEXAO', quantidade: 0, valor_produto: 0 }]);
      out.gravar = { status: ins.status, ok: ins.ok, erro: ins.erro || null, resposta: (ins.body || '').slice(0, 200) };
      if (ins.ok) {
        const del = await supaReq('amb', 'DELETE', 'vendas_historico?numero_pedido=eq.' + encodeURIComponent(marca), null);
        out.apagar = { status: del.status, ok: del.ok };
        out.resultado = (del.ok) ? '✅ CONEXÃO OK — gravou e apagou o registro de teste. Pode rodar o backfill.' : '⚠️ gravou mas não apagou — confira o DELETE (mas escrita funciona)';
      } else {
        out.resultado = '❌ FALHOU ao gravar. Confira SUPABASE_URL_VENDAS_AMB e SUPABASE_KEY_VENDAS_AMB no Render (a chave TEM que ser a service_role).';
      }
      json(res, 200, out);
      return true;
    }








    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.

    // ─── REAPLICAR CUSTO NO HISTÓRICO (19/08) ───────────────────────────────────
    // ?de=&ate= obrigatórios · &simular=1 mostra o que MUDARIA sem gravar (recomendado antes)
    // ?status=1 acompanha. Só admin.
    if (method === 'GET' && p === '/amb-checkout-offline/reaplicar-custo') {
      const kC = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY) || (sC && ehAdmin(sC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, estado: _reapC }); return true; }
      if (_reapC.rodando) { json(res, 200, { ok: true, ja_rodando: true, estado: _reapC }); return true; }
      const deC = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateC = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deC) || !/^\d{4}-\d{2}-\d{2}$/.test(ateC)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (deC > ateC) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
      const _dataOk = t => { const d9 = new Date(t + 'T12:00:00-03:00'); return !isNaN(d9) && d9.toISOString().slice(0, 10) === t; };
      if (!_dataOk(deC) || !_dataOk(ateC)) { json(res, 400, { ok: false, erro: 'data inexistente no calendário' }); return true; }
      const simularC = urlObj.searchParams.get('simular') === '1';
      if (simularC) { const r9 = await reaplicarCusto(deC, ateC, 'amb', { simular: true }); json(res, 200, { ok: true, simulacao: true, resultado: r9 }); return true; }
      reaplicarCusto(deC, ateC, 'amb', {}).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, de: deC, ate: ateC, mensagem: 'reaplicando custo em background — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, '/amb-checkout-offline/reaplicar-custo', '', kC) });
      return true;
    }
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /amb-checkout-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /amb-checkout-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /amb-checkout-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    if (p === '/amb-checkout-offline/custos-manuais') {
      const kM = urlObj.searchParams.get('k') || '';
      const sM = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kM === process.env.ADMIN_KEY) || (sM && ehAdmin(sM)))) { json(res, 404, { error: 'not found' }); return true; }

      if (method === 'GET' && urlObj.searchParams.get('lista') === '1') {
        const m = lerCustosManuais();
        const itens = Object.keys(m).sort().map(k => ({ sku: k, custo: m[k].custo, em: m[k].em || null }));
        json(res, 200, { ok: true, total: itens.length, itens });
        return true;
      }

      if (method === 'POST') {
        let corpo = '';
        await new Promise(r => { req.on('data', c => { corpo += c; if (corpo.length > 4e6) req.destroy(); }); req.on('end', r); req.on('error', r); });
        let body = {};
        try { body = JSON.parse(corpo || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'JSON inválido' }); return true; }
        const atual = lerCustosManuais();

        if (body.apagar) {                       // apagar um SKU ou todos
          if (body.apagar === '*') { gravarCustosManuais({}); json(res, 200, { ok: true, apagados: Object.keys(atual).length, total: 0 }); return true; }
          const k = String(body.apagar).trim();
          const tinha = !!atual[k];
          delete atual[k];
          gravarCustosManuais(atual);
          json(res, 200, { ok: true, apagado: tinha ? k : null, total: Object.keys(atual).length });
          return true;
        }

        /* Codex (P2): a rota DOCUMENTA {texto} ou {itens}, mas só lia body.texto — quem mandasse
           a forma estruturada recebia "nenhuma linha válida". Agora as duas funcionam. */
        let r;
        if (Array.isArray(body.itens)) {
          const itens = {}; const ignoradas = [];
          for (const it of body.itens) {
            const sku = String((it && it.sku) || '').trim();
            const custo = Number(it && it.custo);
            if (!sku || !isFinite(custo) || custo <= 0) { ignoradas.push(JSON.stringify(it || null).slice(0, 60)); continue; }
            itens[sku.toUpperCase()] = { custo: Math.round(custo * 10000) / 10000, sku, em: new Date().toISOString() };
          }
          r = { itens, ignoradas };
        } else {
          r = parsearCustosColados(body.texto || '');
        }
        const novos = Object.keys(r.itens).length;
        if (!novos) { json(res, 400, { ok: false, erro: 'nenhuma linha válida', ignoradas: r.ignoradas.slice(0, 20) }); return true; }
        /* substitui o que veio e mantém o resto — subir uma planilha parcial não apaga o antigo */
        for (const k of Object.keys(r.itens)) atual[k] = r.itens[k];
        gravarCustosManuais(atual);
        json(res, 200, { ok: true, gravados: novos, ignoradas: r.ignoradas.slice(0, 20), total: Object.keys(atual).length,
                         leia: 'o custo manual só vale onde o Bling não tem custo para o SKU' });
        return true;
      }

      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(telaCustosManuais('AMBTotal', '/amb-checkout-offline'));
        return true;
      }
    }

    if (method === 'GET' && p === '/amb-checkout-offline/custo-sync') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: !!_cst.rodando, progresso: _cst.feitos + '/' + _cst.total, ok_ate_agora: _cst.ok, falhas: _cst.falhas, inicio: _cst.inicio }); return true; }
      const skuProbe = urlObj.searchParams.get('sku');
      if (skuProbe && urlObj.searchParams.get('raw')) {
        // raio-X do que o Bling devolve pra esse SKU (pra entender custo faltando)
        try {
          const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(skuProbe) + '&criterio=5&limite=3');
          const lst = (rb.ok && rb.data && rb.data.data) || [];
          const it0 = lst[0] || null;
          let det = null;
          if (it0 && it0.id) { const dd = await blingGet('/produtos/' + it0.id); det = (dd.ok && dd.data && dd.data.data) || null; }
          const compsRaw = det ? ((det.estrutura && (det.estrutura.componentes || det.estrutura.itens)) || det.composicao || det.componentes || null) : null;
          json(res, 200, { ok: true, sku: skuProbe, achou_na_busca: lst.length, id: it0 && it0.id,
            campos_topo: det ? Object.keys(det) : null,
            precoCusto: det && det.precoCusto, custo: det && det.custo, preco: det && det.preco,
            fornecedor: det && det.fornecedor ? { precoCusto: det.fornecedor.precoCusto, precoCompra: det.fornecedor.precoCompra } : null,
            estrutura_chaves: det && det.estrutura ? Object.keys(det.estrutura) : null,
            componentes_qtd: Array.isArray(compsRaw) ? compsRaw.length : 0,
            componentes_amostra: Array.isArray(compsRaw) ? compsRaw.slice(0, 3) : null,
            fornecedores_crus: await (async () => { try { const rr = await blingGet('/produtos/fornecedores?idProduto=' + (it0 && it0.id) + '&limite=5'); return (rr.ok && rr.data && rr.data.data) || rr.data || null; } catch (e) { return String(e.message || e); } })() });
        } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); }
        return true;
      }
      if (skuProbe) { const ccP = readJson(path.join(CACHE_DIR, '_custos.json'), {}); json(res, 200, { ok: true, sku: skuProbe, no_cache_permanente: ccP[skuProbe] || null, total_no_cache: Object.keys(ccP).length }); return true; }
      if (_cst.rodando) { json(res, 200, { ok: true, ja_rodando: true, progresso: _cst.feitos + '/' + _cst.total }); return true; }
      custoSync(!!urlObj.searchParams.get('fresh')).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, mensagem: 'custo-sync rodando em background (tartaruga anti-429) — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, '/amb-checkout-offline/custo-sync', '', k) });
      return true;
    }




    // NÍVEL de desconto do frete Magalu (config do ⚙️). GET lê, POST salva.
    // Valida por SESSÃO admin (igual config-fiscal) — chamada pelo dashboard.
    if (p === '/amb-checkout-offline/config-frete-magalu') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const CFG = path.join(CACHE_DIR, '_config-frete-magalu.json');
      if (method === 'GET') { json(res, 200, { ok: true, config: readJson(CFG, { nivel_desconto: '50' }) }); return true; }
      if (method === 'POST') {
        let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}
        let nivel = '50'; if (['sem', '25', '50'].includes(body.nivel_desconto)) nivel = body.nivel_desconto;
        writeJson(CFG, { nivel_desconto: nivel, em: new Date().toISOString() });
        json(res, 200, { ok: true, salvo: nivel }); return true;
      }
    }

    // SONDA de dimensões de um produto — pra ver os nomes EXATOS dos campos (largura/altura/
    // profundidade/peso) que o cálculo de frete Magalu vai usar.
    // REMOVIDA por segurança após cumprir o diagnóstico (usava ?k= na query e expunha o
    // produto cru). As dimensões vêm de blingGet('/produtos/{id}').dimensoes, já confirmado.

    if (method === 'GET' && p === '/amb-checkout-offline/vendas-sync') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || sessV)) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: _vsy.rodando, fase: _vsy.fase || null, vendas_na_janela: _vsy.total, atualizado_em: _vsy.atualizado_em, erro: _vsy.erro,
        // b33: as fases direto-do-marketplace precisam APARECER — sem isto o status diz
        // 'fim' sem contar se o ML/Shopee/Magalu trouxeram alguma coisa (ou por que não).
        rodada_em: _vsy.rodada_em || null,
        ml_direto: _vsy.ml_direto || null, shopee_direto: _vsy.shopee_direto || null, mg_direto: _vsy.mg_direto || null,
        provisorias: (() => { try { const a2 = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {}) || {};
          let ml = 0, sh = 0, mg = 0;
          for (const k2 of Object.keys(a2)) { if (k2.startsWith('ml:')) ml++; else if (k2.startsWith('sh:')) sh++; else if (k2.startsWith('mg:')) mg++; }
          return { ml, shopee: sh, magalu: mg, total_no_arquivo: Object.keys(a2).length };
        } catch (e) { return null; } })() }); return true; }
      vendasSync().catch(() => {});
      json(res, 200, { ok: true, iniciado: true });
      return true;
    }

    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/run') {
      const forcar = /[?&]force=1\b/.test(urlObj.search || '');
      rodarCiclo(forcar ? 'manual-force' : 'manual', forcar);
      json(res, 200, { mensagem: `Ciclo${forcar ? ' (FORCE — re-cacheia tudo)' : ''} iniciado. Veja /amb-checkout-offline/status.`, versao: VERSAO });
      return true;
    }

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou
    if (method === 'POST' && p === '/amb-checkout-offline/salvar-localizacao') {
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
      console.log(`[AMBBKP] localização ${sku}: "${locAntiga}" → "${localizacao}" por ${op || '?'}`);
      json(res, 200, { ok: true, sku, localizacao, de: locAntiga });
      return true;
    }

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log
    if (method === 'GET' && p === '/amb-checkout-offline/localizacoes-log') {
      const log = readJson(LOC_LOG_FILE, []);
      json(res, 200, { ok: true, total: log.length, log: log.slice(-500).reverse() });
      return true;
    }

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)
    if (method === 'GET' && p === '/amb-checkout-offline/buscar-produto') {
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
    if (method === 'GET' && p === '/amb-checkout-offline/debug-produto') {
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
    if (method === 'GET' && p === '/amb-checkout-offline/indexar-catalogo') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin pode indexar' }); return true; }
      if (getIdxStatus().rodando) { json(res, 200, { ok: true, started: false, jaRodando: true, status: getIdxStatus() }); return true; }
      indexarCatalogoCompleto();                       // dispara em background (não aguarda)
      json(res, 200, { ok: true, started: true });
      return true;
    }
    if (method === 'GET' && p === '/amb-checkout-offline/indexar-status') {
      json(res, 200, { ok: true, status: getIdxStatus() });
      return true;
    }

    // ─── QZ Tray: assinatura (mata o popup "Untrusted") ───
    // serve o certificado público p/ o QZ confiar
    if (method === 'GET' && p === '/amb-checkout-offline/qz-cert') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(QZ_CERT || '');
      return true;
    }
    // assina a requisição do QZ com a chave privada (RSA-SHA512)
    if (method === 'GET' && p === '/amb-checkout-offline/qz-sign') {
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
    if (method === 'GET' && p === '/amb-checkout-offline/painel') {
      try {
        const htmlContent = fs.readFileSync(path.join(__dirname, 'painel.html'), 'utf8');
        html(res, 200, htmlContent);
      } catch (e) { json(res, 500, { erro: 'painel.html: ' + e.message }); }
      return true;
    }

    // lista os pedidos PRONTOS (com etiqueta) + estado de conferido
    if (method === 'GET' && p === '/amb-checkout-offline/lista') {
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
        .map(i => ({ id: i, numero: man[i].numero, cliente: man[i].cliente || '', nf_numero: man[i].nf_numero || null, nf_emissao: man[i].nf_emissao || null, marketplace: man[i].marketplace || 'outro', numero_loja: man[i].numero_loja || null, visto_em: man[i].visto_em || null, nf_id: man[i].nf_id || null }))   // numero_loja p/ o ↗; visto_em p/ a data-hora; nf_id p/ o link da NF
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
    if (method === 'GET' && p === '/amb-checkout-offline/separacao') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacao(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }
    if (method === 'GET' && p === '/amb-checkout-offline/separacao-por-pedido') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacaoPorPedido(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }

    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    // 11/08: a rota /historico INLINE foi REMOVIDA daqui.
    //   Ela era a herança do checkout (só os pedidos bipados) e, por vir ANTES da
    //   delegação, SOMBREAVA a do módulo amb-historico.js — que devolve `vendas_bling`
    //   (o _vendas_dia.json inteiro: vendas do Bling + as provisórias direto do
    //   marketplace) e traz o bugfix d45 da hora da NF. Sem isso o dashboard só
    //   enxergava, no Hoje/Ontem, o que o estoquista tinha bipado: 4 pedidos onde o
    //   marketplace tinha 50. Agora a rota do módulo assume.


    // DEBUG — mostra onde o Bling guarda a localização de um SKU (confirma o campo)
    // uso: /amb-checkout-offline/debug-loc/{SKU}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-loc/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/pedido/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/estoque-pedido/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/etiqueta/')) {
      const id = p.split('/').filter(Boolean).pop();
      try {
        const zpl = fs.readFileSync(path.join(CACHE_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(zpl);
      } catch (e) { json(res, 404, { erro: 'etiqueta não cacheada' }); }
      return true;
    }

    // serve o DANFE (PDF) — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/danfe/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/etiqueta-pdf/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/imprimir/')) {
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
    if (method === 'GET' && p === '/amb-checkout-offline/operadores') {
      const nomes = Object.keys(lerOperadores());
      json(res, 200, { operadores: nomes, login_ativo: nomes.length > 0, admins: lerAdmins() });
      return true;
    }

    // LOGIN: valida nome + senha contra a env AMBBKP_OPERADORES
    if (method === 'POST' && p === '/amb-checkout-offline/login') {
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      const senha = String(body.senha || '').trim();
      const ops = lerOperadores();
      if (ops[nome] !== undefined && String(ops[nome]) === senha) {
        res.setHeader('Set-Cookie', SESS_COOKIE + '=' + assinarSessao(nome) + '; Path=/amb-checkout-offline; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESS_TTL/1000));
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
    if (method === 'POST' && p === '/amb-checkout-offline/reservar') {
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
    if (method === 'POST' && p === '/amb-checkout-offline/liberar') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const r = lerReservas();
      if (r[id]) { delete r[id]; writeJson(RESERVAS_FILE, r); }
      json(res, 200, { ok: true });
      return true;
    }

    // REABRIR um pedido finalizado por engano: tira da fila de conferidos → volta pra lista.
    // Aceita o bling_id OU o número visível. Se já tinha ido pra VERIFICADO, devolve pra ATENDIDO no Bling.
    if ((method === 'GET' || method === 'POST') && p.startsWith('/amb-checkout-offline/reabrir/')) {
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
      console.log(`[AMBBKP] reaberto ${id} (era sync=${eraSync}, revertido p/ ATENDIDO=${revertido})`);
      json(res, 200, { ok: true, id, removido_da_fila: true, revertido_p_atendido: revertido });
      return true;
    }

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)
    if (method === 'POST' && p === '/amb-checkout-offline/conferido') {
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
        nf_id: (snapC && snapC.nf && snapC.nf.id) || null,   // ID interno da NF — link direto pro Bling
        nf_emissao: (snapC && snapC.nf && snapC.nf.dataEmissao) || null,   // b11: hora da NF já entra na bipagem (dashboard ordena por ela)
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
          console.log(`[AMBBKP] conferido ${id} → ${SIT_VERIFICADO} (espelho na hora) OK`);
        } else {
          conf[id].sync_erro = String(r.status || 'err');
          blingOffline = true;
          console.log(`[AMBBKP] conferido ${id} ficou na fila (bling ${r.status}) — sincroniza depois`);
        }
        writeJson(CONFERIDOS_FILE, conf);
      }
      json(res, 200, { ok: true, id, sincronizado, bling_offline: blingOffline });
      return true;
    }

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.
    if ((method === 'POST' || method === 'GET') && p === '/amb-checkout-offline/sincronizar') {
      const r = await sincronizarConferidos();
      json(res, 200, { ok: true, ...r });
      return true;
    }

    // DEBUG — testa mover UM pedido p/ VERIFICADO (ou outro id via ?situacao=). Mostra resposta crua do Bling.
    // uso: /amb-checkout-offline/debug-mover/{idDoPedido}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-mover/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').pop();
      const sit = Number(urlObj.searchParams.get('situacao') || SIT_VERIFICADO);
      const r = await moverSituacao(id, sit);
      json(res, 200, { pedido: id, situacao_destino: sit, resultado: r });
      return true;
    }

    if (method === 'GET' && p === '/amb-checkout-offline/status') {
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
    if ((method === 'GET' || method === 'HEAD') && p === '/amb-checkout-offline/saude') {
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
      if (!SYNC_ON) avisos.push('AMBBKP_SYNC_ON desligado — finalizados não voltam pro Bling sozinhos');
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
    if (method === 'GET' && p === '/amb-checkout-offline/buscar-pedido') {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/nf-danfe-live/')) {
      const id = p.split('/').filter(Boolean).pop();
      const nf = await nfDoPedido(id);
      const pdf = nf && nf.id ? await baixarDanfe(nf.id) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (pedido sem NF ou Bling não respondeu)', nf: nf || null });
      return true;
    }
    // baixa o DANFE (PDF) direto pelo ID da NOTA (pra resultados de busca por NF)
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/danfe-nf/')) {
      const nfId = p.split('/').filter(Boolean).pop();
      const pdf = await baixarDanfe(nfId);
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-nf-${nfId}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (NF sem PDF ou Bling não respondeu)' });
      return true;
    }
    // baixa o XML da NOTA pelo ID
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/xml-nf/')) {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/arq-info/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const etqPath = path.join(ARQUIVO_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
      json(res, 200, { id, arquivado: !!ped, tem_etiqueta: fs.existsSync(etqPath), numero: ped && ped.numero, cliente: ped && ped.cliente, nf: ped && ped.nf });
      return true;
    }
    // ARQUIVO: etiqueta arquivada → PDF (converte ZPL se preciso)
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/arq-etiqueta-pdf/')) {
      const id = p.split('/').filter(Boolean).pop();
      let pdf = null;
      try { pdf = await etiquetaPdf(id, path.join(ARQUIVO_DIR, String(id))); } catch (e) {}
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="etiqueta-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'etiqueta não disponível (pedido finalizado antes desse recurso, ou ML postado)' });
      return true;
    }
    // ARQUIVO: DANFE de um pedido arquivado → gera na hora pelo nf.id guardado
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/arq-danfe/')) {
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
    if (method === 'POST' && p.startsWith('/amb-checkout-offline/pedir-reenvio/')) {
      let op = '';
      try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {}
      if (!op) { json(res, 200, { ok: false, erro: 'identifique o operador (faça login no painel)' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const confR = readJson(CONFERIDOS_FILE, {});
      const c = confR[id] || {};
      const direto = String(process.env.CHECKOUT_REENVIO_DIRETO_EMPRESAS || '').toLowerCase().split(',').map(s => s.trim()).includes('amb');
      if (direto) {
        const r = await enviarEmailDocs(id, op);
        if (r.ok && confR[id]) {   // flag visível no histórico: quem reenviou e quando
          confR[id].reenvios = (confR[id].reenvios || 0) + 1;
          confR[id].ultimo_reenvio = { por: op, em: new Date().toISOString() };
          writeJson(CONFERIDOS_FILE, confR);
        }
        console.log(`[AMBBKP] 📨 reenvio DIRETO pedido ${c.numero || id} por ${op} → ${r.ok ? 'enviado' : 'FALHA: ' + r.erro}`);
        json(res, 200, { ...r, direto: true });
        return true;
      }
      const REENVIOS_FILE = CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json');
      const ree = readJson(REENVIOS_FILE, {});
      ree[id] = { numero: c.numero || null, cliente: c.cliente || '', por: op, em: new Date().toISOString() };
      writeJson(REENVIOS_FILE, ree);
      console.log(`[AMBBKP] 📨 REENVIO SOLICITADO — pedido ${c.numero || id} por ${op} (admin envia pelo Histórico)`);
      json(res, 200, { ok: true, solicitado: true });
      return true;
    }
    // admin resolve a solicitação: {enviar:true} manda o e-mail e baixa; {enviar:false} só descarta
    if (method === 'POST' && p.startsWith('/amb-checkout-offline/reenvio-resolver/')) {
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
      console.log(`[AMBBKP] 📨 reenvio ${id} ${enviar ? 'ENVIADO' : 'descartado'} por ${op}`);
      json(res, 200, r);
      return true;
    }
    if (method === 'POST' && p.startsWith('/amb-checkout-offline/enviar-docs/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op) { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
      if (!ehAdmin(op)) { json(res, 200, { ok: false, erro: 'apenas o admin pode enviar documentos', precisa_admin: true }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const r = await enviarEmailDocs(id, op);
      if (r.ok) { const cD = readJson(CONFERIDOS_FILE, {}); if (cD[id]) { cD[id].reenvios = (cD[id].reenvios || 0) + 1; cD[id].ultimo_reenvio = { por: op, em: new Date().toISOString() }; writeJson(CONFERIDOS_FILE, cD); } }
      console.log(`[AMBBKP] enviar-docs ${id} (por ${op}) → ${r.ok ? 'OK (' + r.anexos + ' anexos)' : 'FALHA: ' + r.erro}`);
      json(res, 200, r);
      return true;
    }
    // DEBUG: por que a NF do pedido não veio? mostra a resposta crua do link pedido→nota + campos do pedido
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-nfped/')) {
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
    if (method === 'GET' && p === '/amb-checkout-offline/backup') {
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
    if (method === 'GET' && p === '/amb-checkout-offline/restaurar') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { html(res, 200, '<meta charset=utf-8><p style="font-family:Arial;margin:40px">Acesso só pra admin. Use <b>?op=SEUNOME</b> no fim da URL.</p>'); return true; }
      const pg = '<!doctype html><meta charset=utf-8><title>Restaurar backup</title>' +
        '<style>body{font-family:Arial;max-width:720px;margin:40px auto;padding:0 16px;color:#111}textarea{width:100%;height:300px;font-family:monospace;font-size:12px;box-sizing:border-box}button{padding:10px 20px;font-size:15px;font-weight:700;background:#f59e0b;border:0;border-radius:8px;cursor:pointer;margin-top:12px}#r{margin-top:14px;font-weight:700}</style>' +
        '<h2>Restaurar backup — Checkout Offline</h2>' +
        '<p>Cola o conteúdo do arquivo de backup (JSON) e clica em Restaurar. <b style="color:#c00">Isso sobrescreve o estado atual.</b></p>' +
        '<textarea id=j placeholder="cola aqui o JSON do backup"></textarea>' +
        '<button onclick="rest()">Restaurar</button><div id=r></div>' +
        '<script>async function rest(){var el=document.getElementById("r");var o;try{o=JSON.parse(document.getElementById("j").value)}catch(e){el.textContent="JSON inválido: "+e.message;return}o.op=' + JSON.stringify(op) + ';try{var x=await fetch("/amb-checkout-offline/restaurar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});x=await x.json();el.textContent=x.ok?("\\u2713 Restaurado: "+x.restaurados.join(", ")):("Falhou: "+(x.erro||"erro"))}catch(e){el.textContent="Erro: "+e.message}}<\/script>';
      html(res, 200, pg);
      return true;
    }
    // RESTAURAR (ação): grava de volta só o que veio no corpo. Só admin.
    if (method === 'POST' && p === '/amb-checkout-offline/restaurar') {
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
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug/')) {
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
    if (method === 'GET' && p === '/amb-checkout-offline/debug-ml') {
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
    // uso: /amb-checkout-offline/debug-produto/{SKU}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-produto/')) {
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
    // uso: /amb-checkout-offline/debug-estrutura/{idDoPedido}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-estrutura/')) {
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
    if (method === 'GET' && p === '/amb-checkout-offline/debug-nf') {
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
    // uso: /amb-checkout-offline/debug-nf-simp/{idDoPedido}        → abre o PDF
    //      /amb-checkout-offline/debug-nf-simp/{idDoPedido}?json=1 → mostra os dados extraídos
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-nf-simp/')) {
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
    // uso: /amb-checkout-offline/danfe-simp/{idOuNumero}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/danfe-simp/')) {
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
    // uso: /amb-checkout-offline/etiqueta-madeira-zpl/{idOuNumero}   (?nodanfe=1 → só etiqueta+adesivo)
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/etiqueta-madeira-zpl/')) {
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
          const mmEtq = require('../girassol-mm-etiquetas');
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
    // uso: /amb-checkout-offline/etiqueta-fundida/{idOuNumero}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/etiqueta-fundida/')) {
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
    // uso: /amb-checkout-offline/debug-danfe/{idDoPedido}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-danfe/')) {
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


    // ─── HISTÓRICO E ANÁLISE (módulo historico.js). Conferido: nenhum prefixo declarado
    //     acima (/pedido/, /etiqueta/, /imprimir/ …) casa com estas rotas, então delegar
    //     aqui no fim não muda a ordem de casamento.
    if (await hist(req, res, urlObj)) return true;

    // ─── PESCARIA de tarifas retroativas (módulo pescaria.js)
    if (await pesca(req, res, urlObj)) return true;

    // ─── CANÁRIO das integrações (módulo canario.js)
    if (await canario(req, res, urlObj)) return true;

    // ─── PODA do bucket de expedição (módulo limpeza.js)
    if (await limpeza(req, res, urlObj)) return true;

    // ─── ROTINA NOTURNA (módulo noturna.js): /noturna-status e /rodar-noturna
    if (_noturna.rotas(req, res, urlObj)) return true;

    // ─── SHOPEE API oficial (módulo gbo-shopee.js): /shopee/conectar, /callback, /status, /sonda
    if (await shopee(req, res, urlObj)) return true;

    // ─── VARREDURA dos fornecedores (só leitura) ──────────────────────────────
    if (method === 'GET' && (p === '/amb-checkout-offline/varrer-fornecedores' || p === '/amb-checkout-offline/varrer-fornecedores-status')) {
      const kV = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      if (p.endsWith('-status')) { json(res, 200, { ok: true, status: _varFor }); return true; }
      if (_varFor.rodando) { json(res, 200, { ok: false, msg: 'já está varrendo — acompanhe em /varrer-fornecedores-status', status: _varFor }); return true; }
      const maxV = (urlObj.searchParams && urlObj.searchParams.get('max')) || '1000';
      varrerFornecedores(maxV).catch(e => { _varFor.rodando = false; console.log('[FORNECEDORES] ' + e.message); });
      json(res, 202, { ok: true, msg: 'varredura iniciada em segundo plano (só leitura, não altera nada no Bling)', max: Number(maxV), status: '/amb-checkout-offline/varrer-fornecedores-status' });
      return true;
    }

    // testa se o Bling devolve a ETIQUETA em PDF (vs ZPL) p/ um pedido
    // uso: /amb-checkout-offline/debug-etiqueta-fmt/{idDoPedido}
    if (method === 'GET' && p.startsWith('/amb-checkout-offline/debug-etiqueta-fmt/')) {
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

    // ─── SONDA GENÉRICA DO BLING (06/08) — perguntar pra API em vez de supor ──
    // Eu disse "a API do Bling devolve só o fornecedor padrão". Isso foi uma
    // conclusão minha a partir do /produtos/{id}, NÃO uma leitura da documentação —
    // e o Diego cobrou, com razão. O Bling tem um módulo de Produtos-Fornecedores
    // que provavelmente tem endpoint próprio. Em vez de eu chutar o caminho, esta
    // rota deixa PERGUNTAR pra própria API, sem precisar de deploy a cada tentativa.
    // Só GET, só admin, e o caminho tem que começar com / (nada de passagem livre).
    // Uso: /amb-checkout-offline/bling-cru?caminho=/produtos/fornecedores&q=idProduto=16433181895
    if (method === 'GET' && p === '/amb-checkout-offline/bling-cru') {
      const kB = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY) || (sB && ehAdmin(sB)))) { json(res, 404, { error: 'not found' }); return true; }
      const cam = String((urlObj.searchParams && urlObj.searchParams.get('caminho')) || '').trim();
      if (!/^\/[a-zA-Z0-9_\/-]+$/.test(cam)) { json(res, 400, { ok: false, erro: 'passe &caminho=/produtos/... (só GET)' }); return true; }
      const qB = String((urlObj.searchParams && urlObj.searchParams.get('q')) || '').replace(/^[?&]+/, '');
      try {
        const r = await blingGet(cam + (qB ? ('?' + qB) : ''));
        const corpo = (r && r.data) || null;
        let magro2 = corpo;
        try {   // tira as descrições gigantes, que já comeram uma resposta hoje
          magro2 = JSON.parse(JSON.stringify(corpo, (kk, vv) => (kk === 'descricaoCurta' || kk === 'descricaoComplementar' || kk === 'midia') ? undefined : vv));
        } catch (e) {}
        json(res, 200, {
          ok: !!(r && r.ok), caminho: cam, q: qB || null, status: r && r.status,
          resposta: magro2, leia: 'resposta CRUA do Bling. Se este caminho não existir, a própria API diz — melhor que eu supor.'
        });
      } catch (e) { json(res, 500, { ok: false, caminho: cam, erro: String((e && e.message) || e) }); }
      return true;
    }

    // ─── 06/08: SONDA DO PRODUTO NO BLING (só leitura) ────────────────────────
    // Nasceu do 50-AE-8F-180mm-KIT45: o fornecedor KaQi daquele SKU aponta pro
    // código de OUTRO produto (50-lisa-225mm-KIT29, custo 37,26) dentro de um kit
    // de 180mm. Hoje não estraga porque o padrão é outro fornecedor — mas se virar
    // padrão, o custo do kit passa a ser o de um produto diferente, e isso vai
    // direto pro histórico sem ninguém ver.
    // Antes de varrer o catálogo inteiro eu preciso saber se a API do Bling
    // devolve os fornecedores no detalhe do produto. Esta rota mostra o CRU.
    // Uso: /amb-checkout-offline/produto-cru?id=16433181895&k=ADMIN_KEY
    if (method === 'GET' && p === '/amb-checkout-offline/produto-cru') {
      const kPr = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sPr = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kPr === process.env.ADMIN_KEY) || (sPr && ehAdmin(sPr)))) { json(res, 404, { error: 'not found' }); return true; }
      const idP = String((urlObj.searchParams && urlObj.searchParams.get('id')) || '').replace(/\D/g, '');
      if (!idP) { json(res, 400, { ok: false, erro: 'passe &id= (o número que aparece na URL do produto no Bling)' }); return true; }
      try {
        const r = await blingGet('/produtos/' + idP);
        const d = (r && r.data && r.data.data) || null;
        // b125: a descrição do produto é um HTML gigante e comia todo o espaço da
        // resposta — o `fornecedor`, que é o que interessa, ficava depois do corte.
        // Agora as descrições saem antes de serializar.
        const magro = d ? Object.assign({}, d) : null;
        // 11/08: com &midia=1 a mídia FICA (era justamente ela que estava sendo apagada,
        // e é o que preciso ver pra descobrir por que a foto do kit não vem).
        const querMidia = !!(urlObj.searchParams && urlObj.searchParams.get('midia'));
        if (magro) { delete magro.descricaoCurta; delete magro.descricaoComplementar; delete magro.observacoes; if (!querMidia) delete magro.midia; }
        json(res, 200, {
          ok: !!d, id: idP, status: r && r.status,
          tem_fornecedores: !!(d && (d.fornecedores || d.fornecedor)),
          campos_do_topo: d ? Object.keys(d) : null,
          fornecedor: (d && (d.fornecedores || d.fornecedor)) || null,   // o que interessa, já separado
          estrutura: (d && d.estrutura) || null,
          resposta_crua_sem_descricao: magro ? JSON.stringify(magro).slice(0, 6000) : null,
          leia: 'se o campo "fornecedor" vier com o código do fornecedor, dá pra varrer o catálogo inteiro e achar todo SKU cujo código no fornecedor não bate com o próprio SKU.'
        });
      } catch (e) { json(res, 500, { ok: false, erro: String((e && e.message) || e) }); }
      return true;
    }


    return false; // não tratou
  };
}

// roda 1 ciclo logo após o boot do serviço
// ═══ VENDAS-SYNC (background): TODAS as vendas do Bling por data, em QUALQUER situação —
// independe de bipagem. Roda a cada 5 min + boot + botão. Cancelada vem com a situação marcada.
let _vsy = { rodando: false, total: 0, atualizado_em: null, erro: null };
function _inferCanal(nl) {
  const s = String(nl || '');
  if (!s) return 'outro';
  if (s.indexOf('-') >= 0) return 'amazon';
  if (/[a-z]/i.test(s)) return 'shopee';
  if (/^200/.test(s)) return 'ml';
  if (/^585/.test(s)) return 'tiktok';
  if (/^15/.test(s)) return 'magalu';
  return 'outro';
}
// ─── FRETE MAGALU (coparticipação) — tabela + cubagem + banco por SKU ─────────
// A Magalu cobra o frete por FAIXA de peso (o maior entre peso real e cubado),
// com desconto conforme o nível de "Despacho no Prazo" do mês. A API financeira
// só traz o frete REAL quando o pedido liquida; até lá estimamos pela tabela
// (e, se o SKU já vendeu antes, pela média real dele — auto-corretivo).
const MAGALU_FRETE_TABELA = [
  // [pesoMaxKg, semDesconto, desc25 (87-97%), desc50 (>97%)]
  [0.5, 35.90, 26.93, 17.95], [1, 40.80, 30.68, 20.45], [2, 42.90, 32.18, 21.45],
  [5, 50.90, 38.18, 25.45], [9, 77.90, 58.43, 38.95], [13, 98.00, 74.18, 49.45],
  [17, 111.90, 83.93, 55.95], [23, 134.90, 101.18, 67.45], [30, 148.90, 111.68, 74.45],
  [40, 179.90, 134.93, 89.95], [50, 189.90, 142.43, 94.95], [60, 199.90, 149.93, 99.95],
  [70, 209.90, 157.43, 104.95], [80, 219.90, 164.93, 109.95], [90, 229.90, 172.43, 114.95],
  [100, 239.90, 179.93, 119.95], [110, 249.90, 187.43, 124.95], [120, 259.90, 194.93, 129.95],
  [130, 269.90, 202.43, 134.95], [140, 279.90, 209.93, 139.95], [150, 289.90, 217.43, 144.95],
  [160, 299.90, 224.93, 149.95], [170, 309.90, 232.43, 154.95], [180, 319.90, 239.93, 159.95],
  [190, 329.90, 247.43, 164.95], [200, 339.90, 254.93, 169.95]
];
// nível de desconto configurável (default 50% = coluna >97%; salvo em _config-frete-magalu.json).
// Índice na linha da tabela: 1=sem desconto, 2=desc25, 3=desc50.
function magaluNivelColuna() {
  try {
    const cfg = readJson(path.join(CACHE_DIR, '_config-frete-magalu.json'), {});
    const n = cfg.nivel_desconto;   // 'sem' | '25' | '50'
    if (n === 'sem') return 1;
    if (n === '25') return 2;
    return 3;   // default 50%
  } catch (e) { return 3; }
}
// peso cubado + faixa → valor da tabela pela coluna do nível. Retorna null se faltar dimensão.
function magaluFreteTabela(dim, pesoBruto) {
  if (!dim) return null;
  const larg = Number(dim.largura), alt = Number(dim.altura), prof = Number(dim.profundidade);
  if (!(larg > 0 && alt > 0 && prof > 0)) return null;
  // unidadeMedida:1 = cm (o padrão do Bling). Converte pra metros.
  const m3 = (larg / 100) * (alt / 100) * (prof / 100);
  const cubado = m3 * 167;   // fator 167 (leves) — casa com o dado real; pesados (300) raros
  const pReal = Number(pesoBruto) || 0;
  const peso = Math.max(pReal, cubado);   // a Magalu usa o MAIOR
  const col = magaluNivelColuna();
  for (const linha of MAGALU_FRETE_TABELA) {
    if (peso <= linha[0]) return Math.round(linha[col] * 100) / 100;
  }
  return Math.round(MAGALU_FRETE_TABELA[MAGALU_FRETE_TABELA.length - 1][col] * 100) / 100;   // acima de 200kg
}
// banco por SKU: média do frete REAL conforme os pedidos liquidam (fonte auto-corretiva).
function magaluFreteSkuLer() { try { return readJson(path.join(CACHE_DIR, '_magalu_frete_sku.json'), {}); } catch (e) { return {}; } }
function magaluFreteSkuGravar(sku, freteReal) {
  if (!sku || !(freteReal > 0)) return;
  try {
    const F2 = path.join(CACHE_DIR, '_magalu_frete_sku.json');
    const banco = readJson(F2, {});
    const cur = banco[sku] || { soma: 0, n: 0, media: 0 };
    cur.soma = Math.round((cur.soma + freteReal) * 100) / 100; cur.n += 1;
    cur.media = Math.round((cur.soma / cur.n) * 100) / 100;
    cur.ultimo = freteReal; cur.em = new Date().toISOString();
    banco[sku] = cur; writeJson(F2, banco);
  } catch (e) {}
}
// cache das dimensões por SKU (evita re-consultar o Bling toda rodada)
const _dimCache = {};
async function magaluDimSku(sku) {
  if (!sku) return null;
  if (_dimCache[sku] !== undefined) return _dimCache[sku];
  try {
    const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(sku) + '&criterio=5');
    const p0 = rb && rb.ok && rb.data && rb.data.data && rb.data.data[0];
    if (!p0 || !p0.id) { _dimCache[sku] = null; return null; }
    const rd = await blingGet('/produtos/' + p0.id);
    const prod = (rd && rd.ok && rd.data && rd.data.data) || null;
    const out = prod ? { dim: prod.dimensoes, peso: prod.pesoBruto } : null;
    _dimCache[sku] = out; return out;
  } catch (e) { _dimCache[sku] = null; return null; }
}
// frete provisório de um pedido: histórico do SKU (se já vendeu) senão a tabela pela dimensão.
async function magaluFreteProvisorio(v) {
  const it = (v.it || [])[0];   // 1º item define a faixa (a maioria dos pedidos é 1 SKU)
  const sku = it && it.sku;
  if (!sku) return null;
  const banco = magaluFreteSkuLer();
  if (banco[sku] && banco[sku].media > 0) return banco[sku].media;   // histórico real do SKU manda
  const d = await magaluDimSku(sku);
  if (!d) return null;
  return magaluFreteTabela(d.dim, d.peso);
}

// ─── PESCA os dados REAIS de um pedido direto na API do ML (fonte primária) ──────
// Dado o numero_loja, devolve { fee (comissão real via sale_fee), frete, venda (hora),
// credito, credito_fonte, logistica, pack, order, costs_ok } ou null se o ML não respondeu.
// Trata carrinho (pack), Flex (self_service: frete não é custo, é o motoboy; estorno = líquido)
// e compensações. Reusada pela pesca dos bipados (mlSyncFees) e pela fase ml_real (não-bipados).
async function pescarDadosML(nlRaw, tokenML, dorme) {
  const nl = String(nlRaw || '').replace(/\D/g, '');
  if (!nl || !tokenML) return null;
  const H = { headers: { Authorization: 'Bearer ' + tokenML } };
  let r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
  let d = await r.json().catch(() => null);
  let ords = null;
  if (r.ok && d) ords = [d];
  else if (r.status === 404) {   // id 2000... que dá 404 é PACK (carrinho): abre o pack e pega as orders
    try {
      const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
      const dp = await rp.json().catch(() => null);
      if (rp.ok && dp && Array.isArray(dp.orders) && dp.orders.length) {
        ords = [];
        for (const oq of dp.orders) {
          try { const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H); const doo = await ro.json().catch(() => null); if (ro.ok && doo) ords.push(doo); } catch (e3) {}
          await dorme(150);
        }
        if (!ords.length) ords = null;
      }
    } catch (e2) {}
  }
  if (!ords || !ords.length) return null;
  let fee = 0, venda = null, shipId = null;
  for (const od of ords) {
    for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1); const sf = Number(it.sale_fee || 0); if (isFinite(sf)) fee += sf * q; }
    if (!venda && od.date_created) venda = od.date_created;
    if (!shipId && od.shipping && od.shipping.id) shipId = od.shipping.id;
  }
  const _ord0 = (ords[0] && ords[0].id != null) ? String(ords[0].id) : null;
  const _viaPack = !!(_ord0 && _ord0 !== nl);
  const _packId = _viaPack ? nl : ((ords[0] && ords[0].pack_id != null) ? String(ords[0].pack_id) : null);
  const reg = { fee: Math.round(fee * 100) / 100, frete: null, venda: venda, _orders: ords.length, pack: _packId, order: _ord0 };
  if (shipId) {
    let ehFlex = false, baseCost = null;
    try {
      const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H);
      const ds = await rs.json().catch(() => null);
      if (rs.ok && ds) {
        const logi = (ds.logistic && ds.logistic.type) || ds.logistic_type || null;
        if (logi) reg.logistica = logi;
        ehFlex = (logi === 'self_service');
        const bc = Number(ds.base_cost); if (isFinite(bc) && bc > 0) baseCost = bc;
        const so = ds.shipping_option || {};
        const lc = Number(so.list_cost != null ? so.list_cost : ds.list_cost);
        const cc = Number(so.cost != null ? so.cost : ds.cost);
        if (!ehFlex && isFinite(lc) && isFinite(cc) && lc > cc) reg.frete = Math.round((lc - cc) * 100) / 100;
      }
    } catch (e) {}
    await dorme(200);
    try {
      const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', H);
      const dc = await rc.json().catch(() => null);
      if (rc.ok && dc) {
        reg.costs_ok = true;
        const sd0 = Array.isArray(dc.senders) ? dc.senders[0] : null;
        const scost = Number(sd0 && sd0.cost);
        const scOk = isFinite(scost) && scost > 0;
        let cred = 0, fonte = null;
        if (sd0) {
          const c1 = Number(sd0.compensation); if (isFinite(c1) && c1 > 0) { cred += c1; fonte = 'compensation'; }
          for (const cx of (sd0.compensations || [])) { const c2 = Number(cx && cx.amount); if (isFinite(c2) && c2 > 0) { cred += c2; fonte = 'compensation'; } }
        }
        // 13/08 — DIAGNOSTICO REAL (rota ml-flex-debug na venda 2000014472881525, entregue):
        //   compensation: 0 · compensations: [] · sender_cost: 0 · base_cost: 0
        //   gross_amount: 8.90  ← exatamente o "Estorno / Bonus por envio" da tela do ML
        // No Flex (self_service) o ML paga ao vendedor o BRUTO do frete que ele nao cobrou do
        // comprador: o credito e o gross_amount, desde que o vendedor nao tenha pago nada
        // (sender_cost = 0). O billing nao serve pra isso — 504 creditos, zero bonus de envio.
        if (cred === 0 && ehFlex && !scOk) {
          const ga = Number(dc.gross_amount);
          if (isFinite(ga) && ga > 0) { cred = Math.round(ga * 100) / 100; fonte = 'costs_gross'; }
        }
        if (cred === 0 && ehFlex && baseCost != null) { cred = Math.round((baseCost - (scOk ? scost : 0)) * 100) / 100; fonte = 'flex_liquido'; }
        if (cred !== 0) { reg.credito = Math.round(cred * 100) / 100; reg.credito_fonte = fonte; }
        if (!ehFlex && scOk) reg.frete = Math.round(scost * 100) / 100;
      }
    } catch (e) {}
    await dorme(200);
  }
  return reg;
}

// ─── Supabase (histórico de vendas) — grava via REST; empresa escolhe as env vars ────────────
function supaCfg(empresa){
  const E = String(empresa||'amb').toUpperCase();
  return { url: process.env['SUPABASE_URL_VENDAS_'+E], key: process.env['SUPABASE_KEY_VENDAS_'+E] };
}
async function supaReq(empresa, metodo, pathQuery, body){
  const { url, key } = supaCfg(empresa);
  if(!url || !key) return { ok:false, status:0, erro:'faltam SUPABASE_URL_VENDAS_'+String(empresa||'').toUpperCase()+' / SUPABASE_KEY_VENDAS_'+String(empresa||'').toUpperCase() };
  const h = { 'apikey': key, 'Authorization': 'Bearer '+key, 'Content-Type': 'application/json' };
  if(metodo==='POST') h['Prefer']='return=minimal';
  // 18/08 (Codex #123): no PATCH precisamos SABER se alguma linha foi afetada — PATCH que casa
  // zero linhas volta 200 do mesmo jeito. Com representation o corpo traz as linhas mexidas.
  if(metodo==='PATCH') h['Prefer']='return=representation';
  try {
    const r = await fetch(url.replace(/\/+$/,'') + '/rest/v1/' + pathQuery, { method: metodo, headers: h, body: body?JSON.stringify(body):undefined });
    const txt = await r.text().catch(()=> '');
    return { ok: r.ok, status: r.status, body: txt };
  } catch(e){ return { ok:false, status:0, erro:String(e.message||e) }; }
}

async function supaCount(empresa, filtro){
  const { url, key } = supaCfg(empresa);
  if(!url || !key) return null;
  try {
    const r = await fetch(url.replace(/\/+$/,'') + '/rest/v1/vendas_historico?empresa=eq.'+encodeURIComponent(empresa)+(filtro?('&'+filtro):'')+'&select=id', { method:'HEAD', headers:{ 'apikey':key, 'Authorization':'Bearer '+key, 'Prefer':'count=exact', 'Range':'0-0' } });
    const cr = (r.headers.get('content-range')||'').split('/')[1];
    return cr!=null ? Number(cr) : null;
  } catch(e){ return null; }
}

// ─── Busca as DEVOLUÇÕES (type 'returns') recentes do ML + o frete de retorno de cada ──────
// Retorna mapa { order_id(string): {claim_id, stage, aberta, data, frete_retorno, destino, dev_status} }.
// Ignora o ruído (cancel_purchase/mediations/cancel_sale) — só devolução física que gera prejuízo.
// destino 'warehouse' = vai pro ML (frete de retorno cobrado do vendedor); 'seller_address' = volta pro galpão.
async function buscarDevolucoesML(tokenML, dorme) {
  if (!tokenML) return {};
  const H = { headers: { Authorization: 'Bearer ' + tokenML } };
  let sellerId = null;
  try { const rm = await fetch('https://api.mercadolibre.com/users/me', H); const dm = await rm.json().catch(() => null); if (rm.ok && dm && dm.id) sellerId = dm.id; } catch (e) {}
  if (!sellerId) return {};
  const mapa = {};
  for (const st of ['opened', 'closed']) {
    try {
      const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/search?players.user_id=' + sellerId + '&players.role=respondent&status=' + st + '&sort=date_created:desc&limit=50', H);
      const dc = await rc.json().catch(() => null);
      const data = (dc && dc.data) || [];
      for (const c of data) {
        if (!c || c.type !== 'returns' || c.resource !== 'order') continue;   // só devolução de pedido (resource_id = order_id)
        const oid = String(c.resource_id);
        if (mapa[oid]) continue;   // opened vem primeiro, tem prioridade
        mapa[oid] = { claim_id: c.id, stage: c.stage, aberta: (st === 'opened'), data: c.date_created, frete_retorno: null, destino: null, dev_status: null };
      }
    } catch (e) {}
    await dorme(200);
  }
  // pros claims de devolução, busca o custo do frete de retorno + status/destino da devolução
  for (const oid of Object.keys(mapa)) {
    const cid = mapa[oid].claim_id;
    try {
      const rr = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + cid + '/charges/return-cost', H);
      const dr = await rr.json().catch(() => null);
      if (rr.ok && dr && dr.amount != null) mapa[oid].frete_retorno = Number(dr.amount);   // frete de retorno pago pelo vendedor
    } catch (e) {}
    await dorme(150);
    try {
      const rt = await fetch('https://api.mercadolibre.com/post-purchase/v2/claims/' + cid + '/returns', H);
      const dt = await rt.json().catch(() => null);
      if (rt.ok && dt) {
        mapa[oid].dev_status = dt.status;   // label_generated / shipped / ...
        const sh = Array.isArray(dt.shipments) ? dt.shipments[0] : null;
        if (sh && sh.destination) mapa[oid].destino = sh.destination.name;   // warehouse / seller_address
      }
    } catch (e) {}
    await dorme(150);
  }
  return mapa;
}

// ─── 🛒 CAÇA DA MAGALU (11/08) ────────────────────────────────────────────────
// POR QUE EXISTE: em julho o Jodda tinha 235 pedidos Magalu (R$ 37.503) e o nosso
// histórico só 119 (R$ 17.469) — METADE do mês nunca chegou. Causa: no Magalu Full
// quem emite a NF é a Magalu, e o pedido só entra no Bling quando o XML é importado
// à mão. O que não desceu, não existe pro Bling — e some do faturamento.
// O QUE FAZ: pergunta À MAGALU o que ela vendeu no período, compara com o que já
// está no Supabase e grava SÓ o que falta. Não apaga nada: é aditivo, então rodar
// de novo não duplica (a checagem é pelo numero_loja).
let _mgc = { rodando: false, em: null, de: null, ate: null, na_magalu: 0, ja_tinha: 0, inseridos: 0, linhas: 0, removidos_cancelados: 0, erro: null, parcial: false };

// Busca os pedidos da Magalu do período e devolve LINHAS prontas pro vendas_historico.
// Usada em DOIS lugares (Codex PR#25 P1): pela caça horária e pelo backfillVendas — porque
// o backfill apaga o período e reconstrói, e sem isso ele apagaria justamente o que a caça
// recuperou (as vendas que o Bling não tem), recriando o buraco a cada rodada.
async function magaluLinhas(de, ate, empresa, jaTem) {
  const dorme2 = ms => new Promise(r => setTimeout(r, ms));
  const out = { linhas: [], pedidos: 0, na_magalu: 0, parcial: false, erro: null, cancelados: [], suspeitos: [] };
  const ADM = process.env.ADMIN_KEY || '';
  if (!ADM) { out.erro = 'sem ADMIN_KEY'; return out; }
  const PORT_L = process.env.PORT || 3000;
  const base = 'http://127.0.0.1:' + PORT_L + '/magalu/';
  const emp = encodeURIComponent(process.env.AMBBKP_MAGALU_EMPRESA || 'amb');
  const r = await fetch(base + 'pedidos-do-dia?empresa=' + emp + '&k=' + encodeURIComponent(ADM) +
                        '&desde=' + de + '&ate=' + ate + '&paginas=40', { timeout: 120000 });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !Array.isArray(j.pedidos)) { out.erro = 'rota da Magalu: ' + ((j && j.erro) || ('HTTP ' + r.status)); return out; }
  out.parcial = Boolean(j.parcial || j.truncado);
  out.na_magalu = j.pedidos.length;

  const cfgF = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {}, taxas: {} });
  const aliqDe2 = m => { const a = cfgF.aliquotas && cfgF.aliquotas[m];
    if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
    return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[m] != null) ? Number(DEFAULT_ALIQ_BK[m]) : 0; };
  const custos = readJson(path.join(CACHE_DIR, '_custos.json'), {});
  const cUn2 = sk => { const c = custos[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
  const pctMag = Number((cfgF.taxas && cfgF.taxas.magalu) || 0);

  // separa os que interessam: dentro da janela e não cancelados
  const vivos = [];
  for (const p of j.pedidos) {
    const cod = String(p.code || '').trim(); if (!cod) continue;
    const dv = String(p.purchased_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dv) || dv < de || dv > ate) continue;
    // (Codex P1) status é olhado ANTES do jaTem: pedido que cancelou DEPOIS de gravado
    // precisa sair do histórico, senão fica somando faturamento pra sempre.
    if (/cancel/i.test(String(p.status || ''))) { out.cancelados.push(cod); continue; }
    if (jaTem && jaTem.has(cod)) continue;
    // 11/08 GUARDA DE SANIDADE: um pedido acima de R$ 20.000 nesta operação é sinal de
    // formato mudado (foi o caso dos centavos, que jogaram julho pra R$ 1,87 milhão).
    // Melhor deixar a venda de fora e GRITAR do que gravar número absurdo no histórico.
    const totP = Number(p.total) || 0;
    if (totP > 20000) { out.suspeitos.push({ code: cod, total: totP, fonte: p.total_fonte || null }); continue; }
    vivos.push(Object.assign({}, p, { _dv: dv, _cod: cod, _uuid: String(p.id || '').trim() }));   // 13/08: o Bling grava o UUID (id) da Magalu no numeroPedidoLoja, não o code
  }

  // (Codex P1) FRETE de coparticipação: a Magalu cobra e isso é custo do vendedor. Vem da
  // mesma rota /magalu/financeiro-lote que o sync já usa. Sem isto a margem das vendas
  // recuperadas sairia inflada — justo as que este recurso existe pra corrigir.
  const freteDe = {}, comReal = {};
  for (let i0 = 0; i0 < vivos.length; i0 += 50) {
    const lote = vivos.slice(i0, i0 + 50).map(v => v._cod);
    try {
      const rf = await fetch(base + 'financeiro-lote?empresa=' + emp + '&k=' + encodeURIComponent(ADM) +
                             '&dias=180&codes=' + encodeURIComponent(lote.join(',')), { timeout: 90000 });
      const jf = await rf.json().catch(() => null);
      if (jf && jf.ok && jf.pedidos) {
        for (const [cod, fin] of Object.entries(jf.pedidos)) {
          if (!fin) continue;
          if (fin.frete_debito) freteDe[cod] = Math.abs(Number(fin.frete_debito) || 0);
          const tx = Math.abs(Number(fin.comissao) || 0) + Math.abs(Number(fin.mdr) || 0) + Math.abs(Number(fin.tarifa_fixa) || 0);
          if (tx > 0) comReal[cod] = Math.round(tx * 100) / 100;
        }
      }
    } catch (e) {}
    await dorme2(200);
  }

  // ── 13/08 (regra do Diego): "todos os produtos são cadastrados no Bling; só então
  // exportamos pros marketplaces. Se tem venda, tem o SKU cadastrado no Bling."
  // A caça lia os itens da API da MAGALU, que às vezes devolve o pedido sem itens ou sem
  // código — e a linha ia pro histórico com sku:null. Resultado medido em julho/2026: 116
  // unidades e R$ 16.390 sem SKU, portanto SEM custo e SEM margem, subestimando o lucro.
  // Agora, quando falta SKU, os itens vêm do BLING (mesma fonte que a Girassol usa): o
  // pedido é encontrado pelo numeroPedidoLoja dentro do dia da venda, e o item vira
  // codigo/descricao/quantidade/valor do Bling. Sem pedido no Bling, NÃO grava linha
  // fantasma: conta em `sem_no_bling` pra aparecer como pendência.
  const _diaCache = {};
  const _bgM = async (pth) => { for (let t = 0; t < 3; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme2(1200 + t * 600); } return await blingGet(pth); };
  async function itensDoBlingPorNumeroLoja(chaves, diaISO) {
    // 13/08 — MEDIDO: a 1ª rodada devolveu sem_no_bling 116 de 116. Motivo: o pedido da Magalu
    // tem DOIS identificadores — `code` numérico (que vira MG-<code> no histórico) e `id` UUID.
    // O Bling grava o UUID no numeroPedidoLoja (as NFs mostram "Origem MagaluOpenApi (uuid)").
    // Procurávamos pelo code, então nunca casava. Agora tenta as duas chaves, UUID primeiro.
    const lista = (Array.isArray(chaves) ? chaves : [chaves]).map(x => String(x || '').trim()).filter(Boolean);
    if (!lista.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(diaISO || ''))) return null;
    if (!_diaCache[diaISO]) {
      const mapa = {};
      for (let pg = 1; pg <= 12; pg++) {
        const r = await _bgM('/pedidos/vendas?dataInicial=' + diaISO + '&dataFinal=' + diaISO + '&pagina=' + pg + '&limite=100');
        const lote = (r && r.ok && r.data && r.data.data) || [];
        for (const pd of lote) { const nl = String((pd && (pd.numeroLoja || pd.numeroPedidoLoja)) || '').trim(); if (nl && !mapa[nl]) mapa[nl] = pd.id; }
        if (lote.length < 100) break;
        await dorme2(350);
      }
      _diaCache[diaISO] = mapa;
    }
    let idBling = null;
    for (const ch of lista) { if (_diaCache[diaISO][ch]) { idBling = _diaCache[diaISO][ch]; break; } }
    if (!idBling) return null;
    const rd = await _bgM('/pedidos/vendas/' + idBling);
    const det = (rd && rd.ok && rd.data && rd.data.data) || null;
    if (!det || !Array.isArray(det.itens) || !det.itens.length) return null;
    return det.itens.map(i2 => ({
      sku: String((i2.codigo || (i2.produto && i2.produto.codigo) || '')).trim() || null,
      desc: String((i2.descricao || (i2.produto && i2.produto.nome) || '')).slice(0, 120) || null,
      qtd: Number(i2.quantidade) || 1,
      valor: Number(i2.valor) || 0
    })).filter(x => x.sku || x.valor);
  }

  out.enriquecidos_bling = 0; out.sem_no_bling = 0;
  for (const p of vivos) {
    const cod = p._cod, dv = p._dv;
    let its = Array.isArray(p.itens) && p.itens.length ? p.itens : [];
    if (!its.length || its.some(x => !x || !x.sku)) {
      let doBling = null;
      try { doBling = await itensDoBlingPorNumeroLoja([p._uuid, cod], dv); } catch (e) {}
      if (doBling && doBling.length) { its = doBling; out.enriquecidos_bling++; }
      else if (!its.length || its.every(x => !x || !x.sku)) { out.sem_no_bling++; continue; }
    }
    const soma = its.reduce((a, x) => a + (Number(x.valor) || 0) * (Number(x.qtd) || 1), 0);
    const totPed = Number(p.total) || soma;
    const aq = aliqDe2(dv.slice(0, 7));
    const comTot = comReal[cod] != null ? comReal[cod] : (pctMag > 0 ? Math.round(totPed * pctMag / 100 * 100) / 100 : 0);
    /* 20/08 — mesma correção de raiz: quando o financeiro da Magalu ainda não trouxe o frete
       real, grava o PREVISTO (média do frete real por SKU) em vez de zero. O real substitui
       quando o pedido liquida. */
    let freTot = freteDe[cod] != null ? freteDe[cod] : 0;
    if (!(freTot > 0)) {
      const _bf = magaluFreteSkuLer();
      let _sp = 0;
      for (const x of its) { const b = _bf[String(x.sku || '').trim()]; const m = b && Number(b.media); if (m > 0) _sp += m * (Number(x.qtd) || 1); }
      if (_sp > 0) freTot = Math.round(_sp * 100) / 100;
    }
    for (const x of its) {
      const q2 = Number(x.qtd) || 1;
      const vt = Math.round((Number(x.valor) || 0) * q2 * 100) / 100;
      const frac = soma > 0 ? (vt / soma) : (1 / Math.max(1, its.length));
      const vnota = Math.round(totPed * frac * 100) / 100;
      const cu = cUn2(x.sku);
      const custo = cu != null ? Math.round(cu * q2 * 100) / 100 : null;
      const com = Math.round(comTot * frac * 100) / 100;
      const fre = Math.round(freTot * frac * 100) / 100;
      const imp = Math.round(vnota * aq / 100 * 100) / 100;
      const mg = custo != null ? Math.round((vt - custo - com - fre - imp) * 100) / 100 : null;
      out.linhas.push({ empresa, numero_pedido: 'MG-' + cod, numero_loja: cod, canal: 'magalu',
        data_venda: dv, sku: x.sku || null, descricao: (x.desc || null),
        quantidade: q2, valor_produto: vt, valor_nota: vnota, custo,
        comissao: com, frete_vendedor: fre, imposto: imp, margem: mg });
    }
    out.pedidos++;
  }
  return out;
}

async function cacaMagalu(de, ate, empresa, opts) {
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  empresa = empresa || 'amb';
  if (_mgc.rodando) return _mgc;
  _mgc = { rodando: true, em: new Date().toISOString(), de, ate, na_magalu: 0, ja_tinha: 0, inseridos: 0, linhas: 0, removidos_cancelados: 0, erro: null, parcial: false };
  try {
    const jaTem = new Set();
    for (let pg = 0; pg < 20; pg++) {
      const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu' +
                '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
                '&select=numero_loja&limit=1000&offset=' + (pg * 1000);
      const rr = await supaReq(empresa, 'GET', q, null);
      if (!rr.ok) throw new Error('Supabase ' + rr.status);
      let arr = []; try { arr = JSON.parse(rr.body || '[]'); } catch (e) {}
      for (const l of arr) if (l && l.numero_loja) jaTem.add(String(l.numero_loja));
      if (arr.length < 1000) break;
    }
    _mgc.ja_tinha = jaTem.size;

    // ── 13/08 — REFAZER as linhas ruins (?refazer=1). A caça só grava pedido NOVO, então as
    // linhas de julho gravadas SEM SKU (canal magalu, sku nulo) eram puladas por já existirem.
    // Com ?refazer=1: acha no histórico os pedidos magalu SEM SKU do período, tira do jaTem
    // (pra serem reprocessados com os itens do Bling) e APAGA as linhas velhas antes de gravar
    // as novas — senão o pedido ficaria duplicado (a linha ruim + a boa).
    const refazer = Boolean(opts && opts.refazer);
    _mgc.refazendo = refazer; _mgc.refazer_alvos = 0;
    const paraRefazer = new Set();
    if (refazer) {
      for (let pg = 0; pg < 20; pg++) {
        const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu' +
                  '&data_venda=gte.' + de + '&data_venda=lte.' + ate + '&or=(sku.is.null,sku.eq.)' +
                  '&select=numero_loja&limit=1000&offset=' + (pg * 1000);
        const rr = await supaReq(empresa, 'GET', q, null);
        if (!rr.ok) throw new Error('Supabase (refazer) ' + rr.status);
        let arr = []; try { arr = JSON.parse(rr.body || '[]'); } catch (e) {}
        for (const l of arr) if (l && l.numero_loja) { paraRefazer.add(String(l.numero_loja)); jaTem.delete(String(l.numero_loja)); }
        if (arr.length < 1000) break;
      }
      _mgc.refazer_alvos = paraRefazer.size;
    }

    const res2 = await magaluLinhas(de, ate, empresa, jaTem);
    if (res2.erro) throw new Error(res2.erro);
    _mgc.na_magalu = res2.na_magalu; _mgc.parcial = res2.parcial; _mgc.inseridos = res2.pedidos;
    if (res2.suspeitos && res2.suspeitos.length) {
      _mgc.suspeitos = res2.suspeitos.slice(0, 20);
      _mgc.aviso = res2.suspeitos.length + ' pedido(s) com valor absurdo (>R$20k) foram DEIXADOS DE FORA — confira o formato do valor na API';
      console.log('[CACA-MAGALU] ⚠️ ' + _mgc.aviso);
    }

    // (Codex P1) cancelado DEPOIS de gravado: apaga do histórico
    for (const cod of res2.cancelados) {
      // Codex PR#51: alvo de refazer saiu do jaTem, mas se foi CANCELADO na Magalu a receita
      // velha tem que sumir igual — senão o refazer deixaria no histórico o que a rodada
      // normal apagaria.
      if (!jaTem.has(cod) && !paraRefazer.has(cod)) continue;
      const del = await supaReq(empresa, 'DELETE', 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu&numero_loja=eq.' + encodeURIComponent(cod), null);
      if (del.ok) _mgc.removidos_cancelados++;
      await dorme(80);
    }
    // 13/08: mostra no status quantos pedidos tiveram os itens buscados no BLING (regra do
    // Diego: se tem venda, tem SKU no Bling) e quantos ficaram sem pedido no Bling — estes
    // NÃO viram linha, aparecem aqui como pendência pra investigar.
    _mgc.enriquecidos_bling = res2.enriquecidos_bling || 0;
    _mgc.sem_no_bling = res2.sem_no_bling || 0;
    // ── Codex PR#51: TROCA SEGURA, pedido a pedido ────────────────────────────────────
    // Antes: apagava tudo e depois inseria em lote. Se um POST falhasse no meio, o pedido
    // ficava SEM linha nenhuma no histórico (sumia do faturamento); e um DELETE que falhasse
    // em silêncio deixava linha velha + nova (duplicada).
    // Agora, para cada alvo: guarda as linhas antigas → apaga (só segue se o apagar deu certo)
    // → grava as novas → se a gravação falhar, RESTAURA as antigas e conta o erro.
    // E só é elegível o alvo cujas linhas novas têm TODAS o SKU preenchido — pedido que
    // voltaria com item sem SKU fica intocado e é reportado como pendência.
    const porPedido = {};
    for (const l of res2.linhas) { const k = String(l.numero_loja); (porPedido[k] = porPedido[k] || []).push(l); }
    const completas = c => c.length > 0 && c.every(l => String(l.sku || '').trim() !== '');
    _mgc.refazer_apagados = 0; _mgc.refazer_trocados = 0; _mgc.refazer_incompletos = 0; _mgc.refazer_falhas = 0;
    const jaGravados = new Set();

    if (refazer && paraRefazer.size) {
      for (const cod of paraRefazer) {
        const novas = porPedido[String(cod)];
        if (!novas || !novas.length) continue;                       // sem substituto: não mexe
        if (!completas(novas)) { _mgc.refazer_incompletos++; jaGravados.add(String(cod)); continue; }
        const qs = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu&numero_loja=eq.' + encodeURIComponent(cod);
        // Codex PR#51 (2ª rodada): SEM cópia de segurança válida, não apaga. Se o GET falhar
        // ou vier corrompido, a restauração seria impossível e o pedido sumiria do histórico
        // pra sempre — o oposto do que este modo existe pra fazer.
        let antigas = null;
        try { const rOld = await supaReq(empresa, 'GET', qs + '&select=*', null); if (rOld.ok) { const j0 = JSON.parse(rOld.body || 'null'); if (Array.isArray(j0)) antigas = j0; } } catch (e) { antigas = null; }
        if (!antigas || !antigas.length) { _mgc.refazer_sem_backup = (_mgc.refazer_sem_backup || 0) + 1; jaGravados.add(String(cod)); continue; }
        const del = await supaReq(empresa, 'DELETE', qs, null);
        if (!del.ok) {
          // Codex PR#51 (3ª rodada): DELETE com resposta perdida (timeout/socket) volta ok:false
          // mesmo tendo apagado — sair aqui removeria o pedido do histórico pra sempre. Então
          // CONFERE o estado real antes de decidir: se as linhas sumiram, segue a troca; se
          // continuam lá, não apagou mesmo e o pedido fica intocado.
          // Codex PR#51 (4ª rodada): se a conferência TAMBÉM cair, o estado fica desconhecido —
          // e abandonar aí pode ter apagado o pedido pra sempre. Insiste algumas vezes antes de
          // desistir; sem resposta, o pedido entra em `refazer_indefinidos` com o snapshot em
          // memória registrado no log, pra conserto manual (restaurar às cegas duplicaria caso
          // o DELETE não tenha acontecido).
          let aindaTem = null;
          for (let tv = 0; tv < 6 && aindaTem === null; tv++) {
            if (tv) await dorme(1200 + tv * 800);
            try { const rChk = await supaReq(empresa, 'GET', qs + '&select=numero_loja', null); if (rChk.ok) { const j1 = JSON.parse(rChk.body || 'null'); if (Array.isArray(j1)) aindaTem = j1.length; } } catch (e) { aindaTem = null; }
          }
          if (aindaTem === null) {
            (_mgc.refazer_indefinidos = _mgc.refazer_indefinidos || []).push(String(cod));
            console.log('[CACA-MAGALU] ⚠️ estado indefinido no pedido ' + cod + ' — snapshot tinha ' + antigas.length + ' linha(s); conferir no histórico');
            jaGravados.add(String(cod)); continue;
          }
          if (aindaTem > 0) { _mgc.refazer_falhas++; jaGravados.add(String(cod)); continue; }
          _mgc.refazer_delete_ambiguo = (_mgc.refazer_delete_ambiguo || 0) + 1;   // apagou de fato: segue e grava as novas
        }
        _mgc.refazer_apagados++;
        const ins = await supaReq(empresa, 'POST', 'vendas_historico', novas);
        if (!ins.ok) {
          // Codex PR#51 (4ª rodada): o POST pode ter GRAVADO e só a resposta ter se perdido —
          // restaurar às cegas colocaria as linhas velhas AO LADO das novas (receita dobrada e
          // o SKU vazio de volta). Confere o que está no banco antes de decidir.
          let jaEntrou = null;
          for (let tv = 0; tv < 6 && jaEntrou === null; tv++) {
            if (tv) await dorme(1200 + tv * 800);
            try { const rChk2 = await supaReq(empresa, 'GET', qs + '&select=numero_loja', null); if (rChk2.ok) { const j2 = JSON.parse(rChk2.body || 'null'); if (Array.isArray(j2)) jaEntrou = j2.length; } } catch (e) { jaEntrou = null; }
          }
          if (jaEntrou !== null && jaEntrou > 0) { _mgc.linhas += novas.length; _mgc.refazer_trocados++; }   // gravou: nada a restaurar
          else if (jaEntrou === 0) {
            _mgc.refazer_falhas++;
            let voltou = false;
            try { const rb = await supaReq(empresa, 'POST', 'vendas_historico', antigas.map(x => { const y = Object.assign({}, x); delete y.id; return y; })); voltou = Boolean(rb && rb.ok); } catch (e) { voltou = false; }
            if (!voltou) { (_mgc.refazer_perdidos = _mgc.refazer_perdidos || []).push(String(cod)); }
          } else {
            _mgc.refazer_falhas++;
            (_mgc.refazer_indefinidos = _mgc.refazer_indefinidos || []).push(String(cod));
            console.log('[CACA-MAGALU] ⚠️ gravação indefinida no pedido ' + cod + ' — conferir no histórico antes de rodar de novo');
          }
        } else { _mgc.linhas += novas.length; _mgc.refazer_trocados++; }
        jaGravados.add(String(cod));
        await dorme(120);
      }
    }

    const restantes = res2.linhas.filter(l => !jaGravados.has(String(l.numero_loja)));
    for (let i0 = 0; i0 < restantes.length; i0 += 200) {
      const lote = restantes.slice(i0, i0 + 200);
      const ins = await supaReq(empresa, 'POST', 'vendas_historico', lote);
      if (!ins.ok) throw new Error('gravação: status ' + ins.status + ' ' + String(ins.body || '').slice(0, 120));
      _mgc.linhas += lote.length;
      await dorme(120);
    }
    try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {}
    if (_mgc.inseridos || _mgc.removidos_cancelados) console.log('[CACA-MAGALU] +' + _mgc.inseridos + ' pedido(s) / ' + _mgc.linhas + ' linha(s), -' + _mgc.removidos_cancelados + ' cancelado(s) (' + de + ' a ' + ate + ')');
  } catch (e) {
    _mgc.erro = String(e.message || e).slice(0, 200);
    console.log('[CACA-MAGALU] falhou: ' + _mgc.erro);
  }
  _mgc.rodando = false;
  _mgc.fim = new Date().toISOString();
  return _mgc;
}

// roda de hora em hora: pega os últimos 3 dias (cobre o que a Magalu registrar com atraso)
async function cacaMagaluCron() {
  const isoD = dt => dt.toISOString().slice(0, 10);
  const hoje = new Date();
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 3);
  return cacaMagalu(isoD(ini), isoD(hoje), 'amb');
}

// ─── BACKFILL do histórico de vendas pro Supabase ────────────────────────────────────────────
// 10/08 — ALÍQUOTAS REAIS DA AMB, dos DAS pagos (o porte tinha herdado as da Girassol,
// que são 11-14% — quase 3× o real de uma empresa em rampa na 1ª-3ª faixa do Simples):
//   abr: 4,0000% (DAS 07.20.26126.5306325-2 sobre 40.490,43)
//   mai: 5,28% EFETIVA PONDERADA — a receita foi retificada: 134.623,57 a 3,9999%
//        (DAS 07.20.26160.9842958-4) + complemento de 186.578,73 a 6,2021%
//        (DAS 07.20.26204.0881200-1) → 16.956,77 de imposto ÷ 321.202,30 = 5,2792%
//   jun: 6,0414% (DAS 07.20.26195.0275043-6 sobre 167.947,46)
//   jul/ago: ESTIMATIVAS pela curva do RBT12p com maio retificado (jul ~8,58 · ago ~8,82) —
//   confirmar quando os DAS saírem e ajustar no ⚙️ (ou aqui) + reaplicar-imposto.
const DEFAULT_ALIQ_BK = { '2026-01':4.0, '2026-02':4.0, '2026-03':4.0, '2026-04':4.0, '2026-05':5.2792, '2026-06':6.0414, '2026-07':8.58, '2026-08':8.82, '2026-09':8.82, '2026-10':8.82, '2026-11':8.82, '2026-12':8.82 };
const _histCache = {};   // agregados do Supabase por período (10 min)
let _backfill = { rodando:false, empresa:null, de:null, ate:null, pagina:0, pedidos:0, itens:0, gravados:0, erros:0, fase:'parado', inicio:null, fim:null, msg:'' };

// ─── 04/08: CASCATA DA COMISSAO no backfill ──────────────────────────────────────────────────
// O ramo do Bling gravava SO `det.taxas.taxaComissao`. Quando o Bling nao importava a taxa, ia
// ZERO pro Supabase e a margem daquele pedido saia inflada — 2.956 pedidos de jan-jul, ~R$ 117
// mil de comissao que nunca foi descontada. Rodar o backfill de novo NAO resolvia: relia o mesmo
// zero (e pior: o DELETE do periodo apagava o que a pescaria tinha consertado).
// Agora, quando a taxa do Bling vier zero num pedido do ML, a ordem e:
//   1) faturamento oficial do ML (_ml_billing.json) — o que o ML DE FATO debitou
//   2) sale_fee da API de vendas — existe desde o instante da venda
//   3) o que veio do Bling (zero)
// Os outros dois caminhos de escrita (vendasSync e mlSyncFees) ja faziam isso; faltava aqui.
// 05/08: alem da comissao, devolve o FRETE. E o PARCELAMENTO entra na comissao —
// a documentacao do proprio ML descreve as tarifas de uma venda como intermediacao
// (comissao) + processamento do pagamento (Mercado Pago) + parcelamento/antecipacao
// quando aplicavel. Sao os tres custos DA VENDA, entao pertencem ao pedido, nao ao mes.
// Sem isso eram R$ 84.671,54 no ano que a margem simplesmente nao via.
function _mapasBilling() {
  const bill = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {} });
  const com = {}, fre = {};
  const poe = (alvo, chave, v) => { if (!chave) return; const k = String(chave); alvo[k] = Math.round(((alvo[k] || 0) + v) * 100) / 100; };
  for (const x of Object.values(bill.tarifas || {})) {
    if (!x) continue;
    const v = Number(x.v) || 0;
    const alvo = (x.c === 'comissao' || x.c === 'mp' || x.c === 'parcelamento') ? com
               : (x.c === 'frete') ? fre : null;
    if (!alvo) continue;
    poe(alvo, x.o, v);
    // a mesma tarifa e indexada tambem pelo PACK: o numeroPedidoLoja do Bling as vezes e o carrinho
    if (x.p && x.p !== x.o) poe(alvo, x.p, v);
  }
  return { com, fre };
}
// 1 chamada por venda (o pescarDadosML faz 3-4 e so o sale_fee interessa aqui)
async function _feeMLLeve(nl, tk) {
  const id = String(nl || '').replace(/\D/g, '');
  if (!id || !tk) return 0;
  const H = { headers: { Authorization: 'Bearer ' + tk } };
  const soma = ords => { let f = 0; for (const od of ords) for (const it of (od.order_items || [])) { const q = Number(it.quantity || 1), sf = Number(it.sale_fee || 0); if (isFinite(sf)) f += sf * q; } return Math.round(f * 100) / 100; };
  try {
    const r = await fetch('https://api.mercadolibre.com/orders/' + id, H);
    if (r.ok) { const d = await r.json().catch(() => null); return d ? soma([d]) : 0; }
    if (r.status !== 404) return 0;
    const rp = await fetch('https://api.mercadolibre.com/packs/' + id, H);
    if (!rp.ok) return 0;
    const dp = await rp.json().catch(() => null);
    const ords = [];
    for (const oq of ((dp && dp.orders) || [])) {
      const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H);
      if (ro.ok) { const doo = await ro.json().catch(() => null); if (doo) ords.push(doo); }
    }
    return ords.length ? soma(ords) : 0;
  } catch (e) { return 0; }
}
// 06/08: por padrao a cascata da Shopee so entra quando o Bling nao trouxe a taxa
// (mesma regra do ML). Com SHOPEE_ESCROW_TODOS=1 ela passa a valer pra TODO pedido
// de Shopee — o escrow e mais confiavel que a taxa do Bling, mas custa 1 chamada
// por pedido, entao a decisao fica explicita e reversivel por env var.
const SHOPEE_TODOS = String(process.env.SHOPEE_ESCROW_TODOS || '') === '1';

// ════════════════════════════════════════════════════════════════════════
//  VARREDURA DOS FORNECEDORES (06/08) — custo que aponta pro produto errado
//  O 50-AE-8F-180mm-KIT45 tem, no Bling, um fornecedor cujo CÓDIGO é de outro
//  produto (50-lisa-225mm-KIT29, custo 37,26) dentro de um kit de 180mm.
//  A API devolve só o fornecedor PADRÃO — que é justamente o que define o custo.
//  Então a varredura compara, produto a produto, o `codigo` do SKU com o
//  `fornecedor.codigo`. Onde divergir, o custo pode estar vindo de outro item.
//  SÓ LEITURA: não altera nada no Bling.
// ════════════════════════════════════════════════════════════════════════
let _varFor = { rodando: false, fase: 'parado', vistos: 0, sem_fornecedor: 0, divergentes: 0, erros: 0,
                recuperados_por_componente: 0, sem_custo_mesmo: 0, inicio: null, fim: null, lista: [], sem_custo: [] };

// CUSTO PELA COMPOSIÇÃO (ideia do Diego, 06/08): "mesmo sem fornecedor, não dá pra
// pegar de outro lugar? pode ser produto de composição". Dá — num kit o custo é a
// SOMA dos componentes, que é o que o Bling mostra como "Preço Total de Custo".
// Conferido no 50-AE-8F-180mm-KIT45: 5 × 5,086 = 25,43, igual à tela.
// Cache por id porque o mesmo componente aparece em dezenas de kits.
// (Guardada de propósito: hoje a varredura não precisa mais dela, porque os
// vínculos de fornecedor vêm todos de uma vez. Fica aqui pro caso do custo por
// COMPOSIÇÃO virar fallback do dashboard — que era a ideia original do Diego.)
const _custoCompCache = new Map();
async function custoDoProduto(id, dorme) {
  if (_custoCompCache.has(id)) return _custoCompCache.get(id);
  let v = null;
  try {
    const r = await blingGet('/produtos/' + id);
    const d = (r && r.ok && r.data && r.data.data) || null;
    if (d) v = { custo: Number((d.fornecedor && d.fornecedor.precoCusto) || 0) || 0, sku: String(d.codigo || ''), nome: String(d.nome || '').slice(0, 50) };
  } catch (e) {}
  _custoCompCache.set(id, v);
  await dorme(430);
  return v;
}

async function varrerFornecedores(max) {
  if (_varFor.rodando) return _varFor;
  const teto = Math.min(20000, Math.max(1, Number(max) || 5000));
  _varFor = { rodando: true, fase: 'baixando vinculos', vistos: 0, vinculos: 0, sem_fornecedor: 0, divergentes: 0, erros: 0,
              sem_padrao: 0, custo_so_no_secundario: 0, recuperados_por_componente: 0, sem_custo_mesmo: 0,
              inicio: new Date().toISOString(), fim: null, lista: [], sem_custo: [] };
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  try {
    // ── 1) TODOS os vínculos de fornecedor, de uma vez ────────────────────────
    // `/produtos/fornecedores` aceita paginação SEM idProduto — o Diego duvidou da
    // minha afirmação de que a API só dava o padrão, mandou eu conferir, e estava
    // certo. Com isso a varredura deixa de ser 1 chamada por produto.
    const porProduto = new Map();
    for (let pag = 1; pag <= 200; pag++) {
      let lote = null;
      for (let tt = 1; tt <= 3 && !lote; tt++) {
        try { const r = await blingGet('/produtos/fornecedores?pagina=' + pag + '&limite=100'); lote = (r && r.ok && r.data && r.data.data) || null; } catch (e) {}
        if (!lote) await dorme(2500 * tt);
      }
      if (!Array.isArray(lote) || !lote.length) break;
      for (const v of lote) {
        const idp = v && v.produto && v.produto.id;
        if (!idp) continue;
        _varFor.vinculos++;
        if (!porProduto.has(idp)) porProduto.set(idp, []);
        porProduto.get(idp).push({ codigo: String(v.codigo || '').trim(), custo: Number(v.precoCusto || 0) || 0, padrao: !!v.padrao });
      }
      await dorme(430);
    }

    // ── 2) os produtos, pra saber o SKU de cada id ────────────────────────────
    _varFor.fase = 'cruzando com os produtos';
    for (let pag = 1; pag <= 200 && _varFor.vistos < teto; pag++) {
      let lista = null;
      for (let tt = 1; tt <= 3 && !lista; tt++) {
        try { const r = await blingGet('/produtos?pagina=' + pag + '&limite=100&criterio=2'); lista = (r && r.ok && r.data && r.data.data) || null; } catch (e) {}
        if (!lista) await dorme(2500 * tt);
      }
      if (!Array.isArray(lista) || !lista.length) break;
      for (const p0 of lista) {
        if (!p0 || p0.id == null) continue;
        if (_varFor.vistos >= teto) break;
        _varFor.vistos++;
        const sku = String(p0.codigo || '').trim();
        const vins = porProduto.get(p0.id) || [];
        const padrao = vins.find(x => x.padrao) || null;
        const comCusto = vins.filter(x => x.custo > 0);

        // (a) nenhum vínculo: sem custo mesmo por essa via
        if (!vins.length) {
          _varFor.sem_fornecedor++; _varFor.sem_custo_mesmo++;
          if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({ id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60), motivo: 'sem nenhum fornecedor' });
          continue;
        }
        // (b) tem vínculo com custo, mas NENHUM marcado como padrão.
        // Isto importa: o /produtos/{id} só devolve o padrão, então esses produtos
        // apareciam como "sem custo" na varredura antiga — e não estão.
        if (!padrao || padrao.custo <= 0) {
          _varFor.sem_padrao++;
          if (comCusto.length) {
            _varFor.custo_so_no_secundario++;
            if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({
              id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60),
              motivo: padrao ? 'o fornecedor padrão está com custo zero' : 'tem custo, mas nenhum fornecedor está marcado como PADRÃO',
              custo_disponivel: comCusto[0].custo, codigo_desse: comCusto[0].codigo, quantos_fornecedores: vins.length
            });
          } else {
            _varFor.sem_custo_mesmo++;
            if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({ id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60), motivo: 'tem fornecedor, mas todos com custo zero', quantos_fornecedores: vins.length });
          }
        }
        // (c) divergência de código — agora em TODOS os vínculos, não só no padrão
        for (const v of vins) {
          if (!sku || !v.codigo) continue;
          if (sku.toLowerCase() === v.codigo.toLowerCase()) continue;
          _varFor.divergentes++;
          if (_varFor.lista.length < 400) _varFor.lista.push({
            id: p0.id, sku, codigo_no_fornecedor: v.codigo, padrao: v.padrao,
            custo: v.custo, nome: String(p0.nome || '').slice(0, 60)
          });
        }
      }
      await dorme(430);
    }
    _varFor.fase = 'concluido';
  } catch (e) { _varFor.fase = 'erro'; _varFor.msg = String((e && e.message) || e); }
  _varFor.rodando = false; _varFor.fim = new Date().toISOString();
  console.log('[FORNECEDORES] ' + _varFor.vistos + ' produtos · ' + _varFor.vinculos + ' vinculos · ' + _varFor.divergentes + ' divergencias · ' + _varFor.custo_so_no_secundario + ' com custo so no secundario');
  return _varFor;
}

async function backfillVendas(de, ate, empresa){
  // Codex (#119): a trava só impedia o CANÁRIO quando havia backfill rodando. Se o canário
  // começa primeiro e alguém dispara backfill — ou a noturna chama esta função direto —, os
  // dois consultam o Bling juntos e o 429 volta. Exclusão nos DOIS sentidos.
  if (typeof _canario !== 'undefined' && _canario && _canario.rodando) {
    console.log('[BACKFILL] adiado: o canário está conferindo o Bling (desde ' + _canario.desde + ')');
    return { ok: false, msg: 'canário conferindo o Bling agora — backfill adiado' };
  }
  if(_backfill.rodando) return;
  _backfill = { rodando:true, empresa, de, ate, pagina:0, pedidos:0, itens:0, gravados:0, erros:0, fase:'preparando', inicio:new Date().toISOString(), fim:null, msg:'' };
  try { await garantirSitCancel(async p2 => await blingGet(p2)); } catch (e) {}
  const jaNoBling = new Set();   // 02/08: números de venda que o Bling JÁ trouxe — impede duplicar quando o ML entrar depois   // 01/08: IDs de cancelamento p/ o filtro abaixo
  const dorme = ms => new Promise(r=>setTimeout(r,ms));
  try {
    const custos = readJson(path.join(CACHE_DIR,'_custos.json'), {});
    const cfg = readJson(path.join(CACHE_DIR,'_config-fiscal.json'), {aliquotas:{}});
    // cascata da comissao: mapa do faturamento oficial (de graca, ja esta no disco) + token do ML
    const { com: comBill, fre: freBill } = _mapasBilling();
    // 05/08: o token do ML vale ~6h e a rodada do ano leva ~6h — pegar UMA vez no começo
    // fazia o fim da varredura rodar com token vencido e o _feeMLLeve devolver 0 CALADO.
    // Agora renova a cada 2h (o garantirTokenML já cuida do refresh de verdade).
    let tkFee = null, tkFeeEm = 0;
    const tokenFee = async () => {
      if (tkFee && (Date.now() - tkFeeEm) < 2 * 3600 * 1000) return tkFee;
      try { const { garantirTokenML: _gF } = require('../ambtotal/mlTokenManager'); tkFee = await _gF(); tkFeeEm = Date.now(); }
      catch (e) { console.log('[BACKFILL] token do ML indisponível: ' + e.message); }
      return tkFee;
    };
    await tokenFee();
    _backfill.comissao = { bling: 0, billing: 0, sale_fee: 0, zero: 0, billing_no_mapa: Object.keys(comBill).length, token_ml: tkFee ? 'ok' : 'sem token' };
    _backfill.frete = { bling: 0, billing: 0, escrow: 0, zero: 0, billing_no_mapa: Object.keys(freBill).length };
    // ── TIKTOK (16/08): mesma cascata da Girassol, agora na AMB ────────────────────
    // Medido na Girassol: o Bling informava R$ 18.248 de tarifa no ano e a real é R$ 47.831
    // (R$ 29.583 de custo invisível). A conta do TikTok é R$ 2,00 fixo + 12%, e boa parte do
    // que falta é comissão de afiliado (creators), que nunca chega ao Bling.
    // Arquivo populado por /tiktok/financeiro-coletar?loja=amb (a lib é a mesma).
    // Enquanto a AMB não autorizar o TikTok, o arquivo não existe e nada muda: cai no Bling.
    const _tkArqA = require('path').join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_amb.json');
    let _tkPedidosA = {};
    try { _tkPedidosA = (JSON.parse(require('fs').readFileSync(_tkArqA, 'utf8')) || {}).pedidos || {}; } catch (e) { _tkPedidosA = {}; }
    _backfill.tiktok = { pedidos_no_arquivo: Object.keys(_tkPedidosA).length, usados: 0, sem_dado: 0,
      tarifa_que_o_bling_dava: 0, tarifa_somada: 0, frete_liquido_visto: 0 };
    _backfill.shopee = { escrow_fechou: 0, escrow_com_sobra: 0, escrow_sem_resposta: 0, escrow_erro: 0,
                         comissao_somada: 0, comissao_que_o_bling_dava: 0, frete_liquido_visto: 0,
                         modo: SHOPEE_TODOS ? 'todos os pedidos' : 'so quando o Bling nao trouxe taxa' };
    const aliqBk = mes => ((cfg.aliquotas && Number(cfg.aliquotas[mes]) > 0) ? Number(cfg.aliquotas[mes]) : (DEFAULT_ALIQ_BK[mes]!=null?DEFAULT_ALIQ_BK[mes]:14.1));   // 19/08: escapou da minha varredura por ter forma diferente — o backfill das 03:45 gravaria imposto ZERO e margem inflada
    // 10/08 (Codex P1): NADA é apagado antes da coleta terminar. A versão antiga
    // deletava o período aqui e gravava página a página — uma queda do Bling no meio
    // deixava o histórico MEIO VAZIO (e a noturna roda isto sozinha às 03:45).
    // Agora a varredura ACUMULA tudo em memória; o DELETE + gravação só acontecem
    // no final, com a coleta completa em mãos. Falhou no meio? Aborta sem apagar.
    _backfill.fase = 'varrendo';
    let buffer = [];
    const estoque = [];   // a coleta inteira, aguardando a gravação do final
    const flush = async () => {
      if(!buffer.length) return;
      for (const it of buffer) estoque.push(it);
      _backfill.coletados = estoque.length;
      buffer = [];
    };
    let foraDoPeriodo = 0;
    for(let pg=1; pg<=500; pg++){
      _backfill.pagina = pg;
      // 03/08 — A RODADA DA MADRUGADA PAROU NA PÁGINA 48 e "concluiu" como se tivesse acabado:
      // uma falha do Bling (429/instabilidade) devolvia lista vazia e o break entendia como fim.
      // Como o DELETE já tinha apagado o período, 5.813 pedidos sumiram do histórico.
      // AGORA: a MESMA página é tentada até 6x com esperas crescentes; se esgotar, a rodada vira
      // ERRO EXPLÍCITO (fase='erro') em vez de fingir sucesso — aí é só rodar de novo.
      let lista = null;
      for (let tent = 1; tent <= 6; tent++) {
        const r = await blingGet('/pedidos/vendas?dataInicial='+de+'&dataFinal='+ate+'&pagina='+pg+'&limite=100');
        if (r && r.ok) { lista = (r.data && r.data.data) || []; break; }
        const espera = [5, 10, 20, 40, 60, 60][tent - 1] * 1000;
        console.log('[BACKFILL] página ' + pg + ' falhou (HTTP ' + (r && r.status) + ') — tentativa ' + tent + '/6, aguardando ' + (espera/1000) + 's');
        _backfill.msg = 'página ' + pg + ': tentativa ' + tent + '/6 após HTTP ' + (r && r.status);
        await dorme(espera);
      }
      if (lista === null) {
        _backfill.fase = 'erro';
        _backfill.msg = 'a página ' + pg + ' falhou 6 vezes seguidas — rodada ABORTADA e NADA foi apagado: o histórico antigo do período continua inteiro. Rode de novo mais tarde.';
        console.log('[BACKFILL] ✗ abortado na página ' + pg + ' — histórico do período ficou incompleto, rode de novo');
        _backfill.rodando = false; _backfill.fim = new Date().toISOString();
        return;
      }
      if(!lista.length) break;
      // ── b122 (06/08): ESCROW EM LOTE, POR PÁGINA ────────────────────────────────
      // Antes era 1 chamada por pedido de Shopee: no ano dá ~6 mil chamadas e umas 2h a
      // mais na rodada. A LISTAGEM do Bling já traz o numeroLoja, então dá pra pedir o
      // escrow de até 50 de uma vez ANTES do laço e depois só consultar o mapa.
      // Como reconheço a Shopee sem ter o detalhe ainda: o order_sn dela é alfanumérico
      // (260806KAS5H5JM) — ML, TikTok e Magalu são só dígitos, e Amazon tem hífen.
      // Se algum não for Shopee a API não devolve nada e o pedido cai no caminho antigo,
      // de um em um. Nada quebra; no pior caso fica lento como era.
      let escrowPg = {};
      try {
        const snsPg = lista.map(x => String((x && x.numeroLoja) || '').trim())
          .filter(sn => sn && sn.length >= 10 && sn.length <= 20 && /^[0-9A-Za-z]+$/.test(sn) && !/^\d+$/.test(sn));
        for (let i = 0; i < snsPg.length; i += 50) {
          const parte = await escrowEmLote(snsPg.slice(i, i + 50));
          Object.assign(escrowPg, parte || {});
          if (snsPg.length > 50) await dorme(400);
        }
        if (Object.keys(escrowPg).length && _backfill.shopee) {
          _backfill.shopee.pelo_lote = (_backfill.shopee.pelo_lote || 0) + Object.keys(escrowPg).length;
        }
      } catch (e) { console.log('[BACKFILL] escrow em lote falhou nesta página (segue 1-a-1): ' + e.message); }
      for(const p of lista){
        if(!p || p.id==null) continue;
        const dtP = String(p.data||'').slice(0,10);
        // 03/08 — REGISTRA A VENDA AQUI, ANTES de qualquer descarte. O laço pula pedido em 4
        // casos (fora do período, cancelado, sem detalhe, sem itens) e nenhum deles chegava ao
        // jaNoBling. Resultado: pedido CANCELADO no Bling era pulado, o ML ainda o dava como
        // "paid", e a parte do marketplace o trazia de volta — desfazendo a limpeza de cancelados.
        // Agora basta o Bling CONHECER a venda pra que o ML não a acrescente.
        { const nl0 = String((p && p.numeroLoja) || '').trim(); if (nl0) jaNoBling.add(nl0); }
        if(dtP && (dtP < de || dtP > ate)){ foraDoPeriodo++; continue; }   // TRAVA: só o período pedido (caso o filtro do Bling falhe)
        // 01/08 — CONSERTADO: o teste antigo era /cancel/i em situacao.valor, mas o Bling manda
        // valor NUMÉRICO (0/1) e não manda nome na listagem — nunca dava true, e cancelado entrava
        // no histórico somando faturamento e lucro. Agora compara com os IDs descobertos no Bling.
        if (_sitCancel.ids.length && _sitCancel.ids.indexOf(Number(p.situacao && p.situacao.id)) >= 0) { _backfill.cancelados = (_backfill.cancelados||0) + 1; continue; }
        _backfill.pedidos++;
        // ── 05/08: RETRY NO DETALHE (o buraco que faltava) ────────────────────────────
        // A LISTAGEM já era tentada 6x desde o b104, mas o DETALHE de cada pedido era uma
        // tentativa só: um 429 ou 504 do Bling e o pedido era PULADO CALADO (erros++ e segue),
        // ficando de fora do histórico numa rodada que termina "concluido". Numa varredura do
        // ano são ~20 mil detalhes a 2,3 req/s durante 6h — dava pra perder dezenas assim.
        // (Foi o que produziu o `erros: 1` da rodada de 10/02.)
        let det=null;
        for (let td = 1; td <= 4; td++) {
          try { const rd = await blingGet('/pedidos/vendas/'+p.id); det = (rd&&rd.ok&&rd.data&&rd.data.data)||null; } catch(e){}
          if (det) break;
          const espD = [3, 8, 20, 40][td - 1] * 1000;
          console.log('[BACKFILL] detalhe do pedido ' + p.id + ' falhou — tentativa ' + td + '/4, aguardando ' + (espD/1000) + 's');
          _backfill.msg = 'detalhe do pedido ' + p.id + ': tentativa ' + td + '/4';
          await dorme(espD);
        }
        await dorme(430);   // rate limit do Bling (~2,3 req/s)
        if(!det){
          _backfill.erros++;
          if (!_backfill.sem_detalhe) _backfill.sem_detalhe = [];
          if (_backfill.sem_detalhe.length < 30) _backfill.sem_detalhe.push(p.id);   // quais pedidos ficaram de fora
          console.log('[BACKFILL] ✗ pedido ' + p.id + ' ficou SEM DETALHE depois de 4 tentativas — fora do histórico');
          continue;
        }
        const itens = (det.itens||[]).map(i=>({ sku:((i.codigo||(i.produto&&i.produto.codigo)||'')+'').trim()||null, desc:((i.descricao||(i.produto&&i.produto.nome)||'')+'').slice(0,180), qtd:Number(i.quantidade||1), vt: Math.round(Number(i.valor||0)*Number(i.quantidade||1)*100)/100 }));
        if(!itens.length) continue;
        const somaProd = itens.reduce((s,i)=>s+i.vt,0) || 1;
        // 01/08 — pedido com det.total ZERADO no Bling (visto no 100705, Shopee 28/02: a NF existe
        // e vale 29,90, mas o total do PEDIDO veio 0). Como o imposto é % sobre esse total, ele saía
        // zero e o pedido aparecia eternamente como "sem alíquota". Nesses casos usamos a soma dos
        // ITENS, que é o valor real da venda. Re-rodar o backfill não resolvia: relia o mesmo zero.
        let total = Number(det.total)||0;
        if (!(total > 0)) {
          const somaItens = itens.reduce((s2,i2)=>s2+(Number(i2.vt)||0),0);
          if (somaItens > 0) { total = Math.round(somaItens*100)/100;
            console.log('[BACKFILL] pedido '+(det.numero||det.id)+': total do Bling veio 0 — usando a soma dos itens ('+total+')'); }
        }
        let comissao = Number((det.taxas&&det.taxas.taxaComissao)||0);
        let frete = Number((det.taxas&&det.taxas.custoFrete)||0);
        const dataV = (String(det.dataEmissao||det.data||p.data||'').slice(0,10)) || null;
        const imposto = total * aliqBk((dataV||'').slice(0,7))/100;
        const ljId = String((det.loja&&det.loja.id)||(p.loja&&p.loja.id)||'');
        const nl = det.numeroPedidoLoja || p.numeroLoja || null;
        const ehOlist = (ljId === '203301094') || /^ORD/i.test(String(nl||''));   // OLIST: loja fixa no Bling + nº começa com "ORD"
        const canal = ehOlist ? 'olist' : (LOJA_MKT[ljId] || _inferCanal(nl));
        // 17/08 — mesma gravação da Girassol: a UF alimenta o card "Vendas por Estado", que
        // até aqui lia só o cache do checkout (~6 dias) e distorcia Mês/Ano.
        // 17/08 — INSTRUMENTAÇÃO: a UF continua chegando vazia no histórico mesmo com o
        // caminho confirmado pela sonda (det.transporte.etiqueta.uf = "SP"). Em vez de seguir
        // deduzindo, o status passa a mostrar quantos pedidos tiveram UF, quantos não, e o
        // ESQUELETO do transporte do primeiro que falhou — aí o motivo aparece de uma vez.
        if (!_backfill.uf) _backfill.uf = { com: 0, sem: 0, exemplo_sem: null };
        const ufPed = (function(){
          // 17/08 — MEDIDO: `transporte.etiqueta.uf` só existe depois que a etiqueta é gerada,
          // e o backfill varre TODOS os pedidos (inclusive os de hoje, ainda sem etiqueta) —
          // por isso os 26 pedidos do primeiro teste vieram sem estado. O endereço de entrega
          // e o do cliente já estão no mesmo detalhe: servem de reserva, nessa ordem.
          const t = det.transporte || {};
          const cand = (t.etiqueta && t.etiqueta.uf)
            || (t.endereco && t.endereco.uf)
            || (det.contato && det.contato.endereco && (det.contato.endereco.uf || det.contato.endereco.estado))
            || (det.cliente && det.cliente.uf) || '';
          // duas letras não bastam: "Brasil" viraria "BR". Só passa sigla de estado de verdade.
          const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
          const s = String(cand || '').trim().toUpperCase().slice(0, 2);
          const achou = UFS.indexOf(s) >= 0 ? s : null;
          if (achou) _backfill.uf.com++;
          else {
            _backfill.uf.sem++;
            if (!_backfill.uf.exemplo_sem) {
              _backfill.uf.exemplo_sem = {
                pedido: det.numero || det.id || null,
                tem_transporte: !!det.transporte,
                chaves_transporte: det.transporte ? Object.keys(det.transporte) : null,
                tem_etiqueta: !!(det.transporte && det.transporte.etiqueta),
                chaves_etiqueta: (det.transporte && det.transporte.etiqueta) ? Object.keys(det.transporte.etiqueta) : null,
                valor_bruto: String((t.etiqueta && t.etiqueta.uf) || '') || null
              };
            }
          }
          return achou;
        })();
        // ── CASCATA (04/08): billing → sale_fee → o zero do Bling ──────────────────────
        let comFonte = (comissao > 0) ? 'bling' : 'zero';
        let freteShopee = null;
        if ((!comissao || comissao <= 0) && canal === 'ml' && nl) {
          const cB = Number(comBill[String(nl).trim()] || 0);
          if (cB > 0) { comissao = cB; comFonte = 'billing'; }
          else {
            const tkAgora = await tokenFee();
            const f = tkAgora ? await _feeMLLeve(nl, tkAgora) : 0;
            if (f > 0) { comissao = f; comFonte = 'sale_fee'; await dorme(120); }
          }
        }
        // ── CASCATA DA SHOPEE (06/08) — a identidade validada em 100 de 100 pedidos ────
        // Ao contrario do ML, aqui NAO existe billing de periodo: o escrow ja vem por
        // pedido e fechado. A conta, conferida ao centavo:
        //   tarifa = net_commission_fee + net_service_fee + seller_product_rebate
        //          + order_ams_commission_fee (afiliado) + campaign_fee + processamento
        //   frete do vendedor = max(0, -final_shipping_fee)   (negativo = custo dele)
        // O escrow vem do servico que e dono do token (nao duplicamos credencial).
        let shopFonte = null;
        // ── CASCATA DO TIKTOK — o marketplace manda (mesma lógica da Girassol) ────────
        let freteTiktokA = null;   // null = canal não é TikTok / sem dado do pedido
        if (canal === 'tiktok' && nl) {
          const tkA = _tkPedidosA[String(nl).trim()];
          if (tkA && Number(tkA.tarifa) > 0) {
            _backfill.tiktok.tarifa_que_o_bling_dava = Math.round((_backfill.tiktok.tarifa_que_o_bling_dava + Number(comissao || 0)) * 100) / 100;
            _backfill.tiktok.tarifa_somada = Math.round((_backfill.tiktok.tarifa_somada + Number(tkA.tarifa)) * 100) / 100;
            _backfill.tiktok.frete_liquido_visto = Math.round((_backfill.tiktok.frete_liquido_visto + Number(tkA.frete_liquido || 0)) * 100) / 100;
            _backfill.tiktok.usados++;
            comissao = Number(tkA.tarifa);
            comFonte = 'tiktok';
            // Codex (P2): frete líquido POSITIVO é dinheiro que sobrou pra loja (subsídio maior
            // que o custo). Zerar jogava esse crédito fora e subestimava a margem. A Shopee já
            // grava o líquido podendo ficar negativo — aqui igual: crédito entra como frete
            // negativo, que a margem soma de volta.
            const fLiqA = Number(tkA.frete_liquido || 0);
            freteTiktokA = Math.round(-fLiqA * 100) / 100;
          } else { _backfill.tiktok.sem_dado++; }
        }
        if (canal === 'shopee' && nl && (SHOPEE_TODOS || !comissao || comissao <= 0)) {
          try {
            let cEsc = escrowPg[String(nl).trim()] || null;   // já veio no lote da página?
            if (!cEsc) {
              const rEsc = await escrowDoPedido(nl);
              cEsc = (rEsc && rEsc.ok && rEsc.dados) ? contasDoEscrow(rEsc.dados.resposta) : null;
            }
            if (cEsc && cEsc.tarifa > 0) {
              // quanto o escrow acrescenta em cima do que o Bling dava — a medida do buraco
              _backfill.shopee.comissao_que_o_bling_dava = Math.round((_backfill.shopee.comissao_que_o_bling_dava + Number(comissao || 0)) * 100) / 100;
              _backfill.shopee.comissao_somada = Math.round((_backfill.shopee.comissao_somada + cEsc.tarifa) * 100) / 100;
              comissao = cEsc.tarifa;
              comFonte = 'escrow';
              shopFonte = (Math.abs(cEsc.sobra) <= 0.02) ? 'escrow_fechou' : 'escrow_com_sobra';
              // ── 09/08: AS DUAS PONTAS DO FRETE DA SHOPEE, finalmente ────────────────
              // No b120 eu deixei o frete de fora de proposito, porque sobrescrever com o
              // liquido do escrow fazia o pedido FLEX perder o motoboy. A regra que faltava:
              //   frete do vendedor = MOTOBOY (so no flex, vem da config) + LIQUIDO do escrow
              // O liquido ja vem com o sinal certo do `contasDoEscrow`: positivo = saiu do
              // bolso, negativo = sobrou dinheiro de frete pra loja (subsidio da Shopee).
              // Caso real que provou a regra — 260805JQ6X1DUT: motoboy 9,00 e liquido -8,00.
              // O certo e 1,00. Antes do b120 dava -8,00 (errado) e no b120 ficou 9,00 (tambem
              // errado, ignorava o subsidio). Agora fecha.
              // Nunca fica negativo: se o subsidio for maior que o motoboy, o frete e ZERO e
              // o que sobrou ja esta na receita do pedido (o escrow paga isso por dentro).
              const _liqSh = Number(cEsc.frete_liquido_vendedor || 0) || 0;
              _backfill.shopee.frete_liquido_visto = Math.round(((_backfill.shopee.frete_liquido_visto || 0) + _liqSh) * 100) / 100;
              let _motoboy = 0;
              try {
                if (ehFlex(servicoDoPedido(det))) {
                  const _cfgSh = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), {});
                  const _fx = (_cfgSh && _cfgSh.flex) || {};
                  // P1 do Codex (09/08): eu caía pra ZERO quando a config nunca foi salva,
                  // mas o dashboard usa DEFAULT_FLEX = { ml:12, shopee:9, outros:9 }. Na Girassol
                  // não mordia (a config existe — o contador mostrou 8.442 de motoboy no ano),
                  // mas MORDERIA no porte pra AMB e GOOD, que nascem com config vazia: todo
                  // pedido Flex entraria com motoboy 0 e margem inflada. Agora o padrão é o mesmo.
                  const _v = (_fx.shopee != null) ? Number(_fx.shopee)
                           : ((_fx.geral != null) ? Number(_fx.geral) : 9);   // 9 = DEFAULT_FLEX.shopee
                  if (isFinite(_v) && _v > 0) _motoboy = _v;
                }
              } catch (e) {}
              // P2 do Codex (09/08): o `Math.max(0, ...)` jogava fora o que sobrava quando o
              // subsídio da Shopee era MAIOR que o motoboy. Eu tinha escrito que "o excedente já
              // está na receita" — ESTAVA ERRADO: a margem parte do valor dos PRODUTOS, e o frete
              // do comprador não entra em lugar nenhum. Medido no ano: R$ 224 descartados
              // (motoboy 8.442 − líquido 7.529 = 912,86 algébrico, mas gravou 1.136,86).
              // Agora o frete pode ficar NEGATIVO — é um crédito, e o dashboard subtrai frete da
              // margem, então crédito aumenta a margem, que é o certo. Conferido que nenhum ponto
              // do índice nem do dashboard assume frete >= 0.
              freteShopee = Math.round((_motoboy + _liqSh) * 100) / 100;
              if (_backfill.shopee) {
                _backfill.shopee.frete_motoboy_somado = Math.round(((_backfill.shopee.frete_motoboy_somado || 0) + _motoboy) * 100) / 100;
                _backfill.shopee.frete_gravado = Math.round(((_backfill.shopee.frete_gravado || 0) + freteShopee) * 100) / 100;
              }
            } else shopFonte = 'escrow_sem_resposta';
          } catch (e) { shopFonte = 'escrow_erro'; }
          if (_backfill.shopee) _backfill.shopee[shopFonte] = (_backfill.shopee[shopFonte] || 0) + 1;
          if (!escrowPg[String(nl).trim()]) await dorme(160);   // só espera quando foi de um em um
        }
        if (_backfill.comissao) _backfill.comissao[comFonte] = (_backfill.comissao[comFonte] || 0) + 1;
        // ── CASCATA DO FRETE (05/08): mesmo remedio, mesmo buraco ──────────────────────
        // A auditoria mostrou o tamanho: o ML debitou R$ 235.065,95 de frete em jan-jul e o
        // nosso historico tinha R$ 167.768,75 — em JANEIRO eram R$ 501,78 contra R$ 19.040,27.
        // O billing tem o frete por numero de venda; o Bling so as vezes traz.
        // (FLEX nao entra por aqui: o ML nao cobra frete nesses, quem paga o motoboy e a loja.)
        // o frete que o escrow apurou manda no da Shopee — e o liquido real do pedido
        if (freteShopee != null) { frete = freteShopee; }
        // TikTok entra ANTES do Bling na escolha do frete (dado do próprio marketplace)
        if (freteTiktokA != null) frete = freteTiktokA;
        let freFonte = (freteTiktokA != null) ? 'tiktok' : (freteShopee != null) ? 'escrow' : ((frete > 0) ? 'bling' : 'zero');
        if ((!frete || frete <= 0) && canal === 'ml' && nl) {
          const fB = Number(freBill[String(nl).trim()] || 0);
          if (fB > 0) { frete = fB; freFonte = 'billing'; }
        }
        if (_backfill.frete) _backfill.frete[freFonte] = (_backfill.frete[freFonte] || 0) + 1;
        if(ehOlist && (!comissao || comissao<=0)) comissao = Math.round(somaProd * 22 / 100 * 100)/100;   // OLIST cobrava ~22% (do Jodda) — o Bling não guarda a taxa dela
        if(ehOlist && (!frete || frete<=0)) frete = 12;   // OLIST: motoboy R$12/pedido (Diego) — o Bling não tem o frete de envio dela
        /* ═══ 20/08 — CORREÇÃO DE RAIZ: o frete PREVISTO também vai pro banco ═══════════════
           O Diego achou 106 pedidos Magalu da AMB com frete "—" no Mês e a margem inflada. A
           exibição já foi corrigida (o histórico completa na leitura), mas quem lê a margem CRUA
           do Supabase — /previsao-vendas e /plano-compra — continuava sem o frete. A raiz é esta:
           o backfill gravava 0 quando o Bling não tinha o frete, em vez de usar o previsto que o
           cache já usa. Regra dele: "tem que ser a mais próxima do real, e chegando os fechamentos
           por API, tem que ser a real real" — então o previsto entra agora e o real substitui
           quando o pedido liquida (o banco por SKU é a média do frete REAL, auto-corretiva). */
        if ((!frete || frete <= 0) && canal === 'magalu') {
          const _bancoFr = (typeof magaluFreteSkuLer === 'function') ? magaluFreteSkuLer() : {};
          let _somaPrev = 0;
          for (const it of itens) {
            const b = _bancoFr[String(it.sku || '').trim()];
            const m = b && Number(b.media);
            if (m > 0) _somaPrev += m * (Number(it.qtd) || 1);
          }
          if (_somaPrev > 0) { frete = Math.round(_somaPrev * 100) / 100; freFonte = 'previsto'; }
        }
        const numPed = String(det.numero!=null?det.numero:(p.numero!=null?p.numero:p.id));
        for(const it of itens){
          const frac = it.vt/somaProd;
          const cU = (custos[it.sku] && custos[it.sku].custo!=null) ? Number(custos[it.sku].custo) : null;
          const custoItem = cU!=null ? Math.round(cU*it.qtd*100)/100 : null;
          const comItem = Math.round(comissao*frac*100)/100;
          const freteItem = Math.round(frete*frac*100)/100;
          const impItem = Math.round(imposto*frac*100)/100;
          const margem = custoItem!=null ? Math.round((it.vt - custoItem - comItem - freteItem - impItem)*100)/100 : null;
          if (nl) jaNoBling.add(String(nl).trim());   // 02/08: marca que o Bling já tem esta venda
        buffer.push({ empresa, numero_pedido:numPed, numero_loja:nl, canal, data_venda:dataV, sku:it.sku, descricao:it.desc, quantidade:it.qtd, valor_produto:it.vt, valor_nota:Math.round(total*frac*100)/100, custo:custoItem, comissao:comItem, frete_vendedor:freteItem, imposto:impItem, margem, uf: ufPed });
          _backfill.itens++;
        }
        if(buffer.length >= 200) await flush();
      }
      if(lista.length < 100) break;
      await dorme(300);
    }
    await flush();

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 02/08 - O MARKETPLACE E A FONTE. Decisao do Diego: "se a venda ocorreu no dia, tem que
    // aparecer no dia". O Bling e ESPELHO — ele nao inventa valor, so replica o que o canal
    // manda — e demora a receber venda de envio agendado, Fulfillment ou pagamento em analise.
    // Entao, DEPOIS de varrer o Bling, perguntamos ao ML quais vendas existem no periodo e
    // acrescentamos as que o Bling ainda nao tem.
    // POR QUE AQUI DENTRO e nao numa rotina separada: o backfill APAGA o periodo antes de
    // regravar. Rotina de fora seria apagada na proxima rodada, ou geraria DUAS linhas pra
    // mesma venda (uma do ML, outra do Bling) e o faturamento dobraria. Escritor unico resolve.
    // Quando o Bling receber a venda, ela passa a vir da varredura normal e esta parte a ignora.
    try {
      if (empresa === 'amb') {
        const { garantirTokenML } = require('../ambtotal/mlTokenManager');
        const tk = await garantirTokenML();
        const HML = { headers: { Authorization: 'Bearer ' + tk } };
        const rme = await fetch('https://api.mercadolibre.com/users/me', HML);
        const me = rme.ok ? await rme.json().catch(() => null) : null;
        const seller = me && me.id;
        if (seller) {
          const cfgF = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
          const aliqDe = m => { const a = cfgF.aliquotas && cfgF.aliquotas[m];
            if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
            return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[m] != null) ? Number(DEFAULT_ALIQ_BK[m]) : 0; };
          const custos = readJson(path.join(CACHE_DIR, '_custos.json'), {});
          const cUn = sk => { const c = custos[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
          // comissao REAL do faturamento do ML, quando ja existir pra essa venda
          const bill = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {} });
          const comDe = {}, freDe = {};
          for (const t of Object.values(bill.tarifas || {})) {
            if (!t.o) continue;
            if (t.c === 'comissao' || t.c === 'mp' || t.c === 'parcelamento') comDe[t.o] = Math.round(((comDe[t.o] || 0) + t.v) * 100) / 100;   // 05/08: parcelamento e custo DA VENDA (doc do ML), entra junto
            if (t.c === 'frete') freDe[t.o] = Math.round(((freDe[t.o] || 0) + t.v) * 100) / 100;
          }
          // 03/08 \u2014 o /orders/search do ML tem TETO de 1.000 resultados (offset+limit). Junho teve
          // mais de 2.000 vendas, entao varrer o mes inteiro de uma vez PERDERIA o excedente em
          // silencio. Solucao: quebrar o periodo em JANELAS DE 5 DIAS e varrer cada uma.
          const diasJan = [];
          { const d1 = new Date(de + 'T12:00:00'), d2 = new Date(ate + 'T12:00:00');
            for (let c = new Date(d1); c <= d2; c.setDate(c.getDate() + 5)) {
              const ini = new Date(c), fim = new Date(c); fim.setDate(fim.getDate() + 4);
              if (fim > d2) fim.setTime(d2.getTime());
              diasJan.push([ini.toISOString().slice(0,10), fim.toISOString().slice(0,10)]);
            } }
          let addLinhas = 0, addVendas = 0, janelasCheias = 0;
          for (const [jDe, jAte] of diasJan) {
          const base = 'https://api.mercadolibre.com/orders/search?seller=' + seller +
                       '&order.date_created.from=' + encodeURIComponent(jDe + 'T00:00:00.000-03:00') +
                       '&order.date_created.to=' + encodeURIComponent(jAte + 'T23:59:59.999-03:00') +
                       '&sort=date_asc&limit=50';
          let totalML = Infinity;
          for (let off = 0; off < 1000 && off < totalML; off += 50) {
            const r = await fetch(base + '&offset=' + off, HML);
            if (!r.ok) break;
            const d = await r.json().catch(() => null);
            const arr = (d && d.results) || [];
            for (const o2 of arr) {
              if (String(o2.status || '') !== 'paid') continue;                 // cancelada nao entra
              const oid = String(o2.id), pk = o2.pack_id ? String(o2.pack_id) : null;
              if (jaNoBling.has(oid) || (pk && jaNoBling.has(pk))) continue;     // o Bling ja tem
              const dv = String(o2.date_created || '').slice(0, 10);
              if (dv < de || dv > ate) continue;
              const itens2 = o2.order_items || [];
              const somaML = itens2.reduce((a, x) => a + (Number(x.unit_price) || 0) * (Number(x.quantity) || 1), 0);
              const totOrd = Number(o2.total_amount) || somaML;
              const aq = aliqDe(dv.slice(0, 7));
              const comTot = comDe[oid] != null ? comDe[oid] : null;
              const freTot = freDe[oid] != null ? freDe[oid] : 0;
              for (const x of itens2) {
                const q2 = Number(x.quantity) || 1;
                const vt = Math.round((Number(x.unit_price) || 0) * q2 * 100) / 100;
                const frac2 = somaML > 0 ? (vt / somaML) : (1 / Math.max(1, itens2.length));
                const sku2 = (x.item && (x.item.seller_sku || x.item.seller_custom_field)) || null;
                const cu2 = cUn(sku2);
                const custo2 = cu2 != null ? Math.round(cu2 * q2 * 100) / 100 : null;
                const vnota2 = Math.round(totOrd * frac2 * 100) / 100;
                const imp2 = Math.round(vnota2 * aq / 100 * 100) / 100;
                const com2 = comTot != null ? Math.round(comTot * frac2 * 100) / 100 : 0;
                const fre2 = Math.round(freTot * frac2 * 100) / 100;
                const mg2 = custo2 != null ? Math.round((vt - custo2 - com2 - fre2 - imp2) * 100) / 100 : null;
                buffer.push({ empresa, numero_pedido: 'ML-' + oid, numero_loja: (pk || oid), canal: 'ml',
                  data_venda: dv, sku: sku2, descricao: (x.item && String(x.item.title || '').slice(0, 120)) || null,
                  quantidade: q2, valor_produto: vt, valor_nota: vnota2, custo: custo2,
                  comissao: com2, frete_vendedor: fre2, imposto: imp2, margem: mg2 });
                addLinhas++; _backfill.itens++;
              }
              addVendas++;
              if (buffer.length >= 200) await flush();
            }
            const tt = Number(d && d.paging && d.paging.total);
            totalML = isFinite(tt) ? tt : 0;
            if (totalML > 1000) janelasCheias++;   // avisa se ainda assim estourou o teto
            if (arr.length < 50) break;
            await dorme(300);
          }
          await flush();
          await dorme(250);
          }
          _backfill.do_marketplace = { vendas: addVendas, linhas: addLinhas, janelas: diasJan.length };
          _backfill.do_marketplace.magalu_incluida = true;
          if (janelasCheias) _backfill.do_marketplace.aviso = janelasCheias + ' janela(s) passaram de 1.000 vendas \u2014 pode ter ficado venda de fora';
          if (addVendas) console.log('[BACKFILL] + ' + addVendas + ' venda(s) vieram DIRETO do Mercado Livre (o Bling ainda nao tinha)');
        }
      }
    } catch (e) { _backfill.msg_ml = String(e.message || e).slice(0, 160); console.log('[BACKFILL] ML: ' + (e.message || e)); }

    // 11/08 (Codex PR#25 P1): a MAGALU também entra na reconstrução. O backfill apaga o
    // período e regrava do zero — se a caça horária fosse o único escritor das vendas que
    // o Bling não tem, um backfill de julho apagaria tudo que ela recuperou e o buraco
    // voltaria. Aqui é o MESMO escritor: as linhas da Magalu entram no `estoque` antes da
    // gravação final, junto com Bling e ML.
    try {
      if (empresa === 'amb') {
        const jaBl = new Set();
        for (const l of estoque) if (l && l.canal === 'magalu' && l.numero_loja) jaBl.add(String(l.numero_loja));
        const resMg = await magaluLinhas(de, ate, empresa, jaBl);
        if (resMg.erro) { _backfill.msg_magalu = resMg.erro; }
        else {
          for (const l of resMg.linhas) { estoque.push(l); _backfill.itens++; }
          _backfill.do_magalu = { vendas: resMg.pedidos, linhas: resMg.linhas.length, parcial: resMg.parcial, na_magalu: resMg.na_magalu };
          if (resMg.pedidos) console.log('[BACKFILL] + ' + resMg.pedidos + ' venda(s) vieram DIRETO da Magalu (o Bling ainda nao tinha)');
        }
      }
    } catch (e) { _backfill.msg_magalu = String(e.message || e).slice(0, 160); console.log('[BACKFILL] Magalu: ' + (e.message || e)); }

    // coleta completa — só AGORA o período antigo dá lugar ao novo
    _backfill.fase = 'gravando';
    await supaReq(empresa, 'DELETE', 'vendas_historico?empresa=eq.'+encodeURIComponent(empresa)+'&data_venda=gte.'+de+'&data_venda=lte.'+ate, null);
    for (let i0 = 0; i0 < estoque.length; i0 += 200) {
      const lote = estoque.slice(i0, i0 + 200);
      // 17/08 — PGRST102 "All object keys must match": o Supabase RECUSA o lote inteiro quando
      // os objetos não têm o MESMO conjunto de chaves. Aconteceu de verdade nesta madrugada: a
      // venda trazida direto do marketplace não tinha `uf` e a do Bling tinha → 112 de 312
      // linhas perdidas numa rodada que ainda assim reportou "concluido". Normalizar aqui é o
      // conserto certo: qualquer campo novo, em qualquer origem, deixa de derrubar o lote.
      const _chaves = new Set();
      for (const _o of lote) for (const _k of Object.keys(_o)) _chaves.add(_k);
      for (const _o of lote) for (const _k of _chaves) if (!(_k in _o)) _o[_k] = null;
      const ins = await supaReq(empresa,'POST','vendas_historico', lote);
      if(ins.ok) _backfill.gravados += lote.length;
      else { _backfill.erros += lote.length; _backfill.msg = 'erro Supabase status '+ins.status+' '+((ins.body||ins.erro||'')+'').slice(0,140); }
      await dorme(120);
    }
    _backfill.fora = foraDoPeriodo;
    // 17/08: rodada com linha perdida NÃO é "concluido" — antes o status dizia concluído com
    // 112 erros no meio e o histórico ficava incompleto sem ninguém perceber.
    _backfill.fase = _backfill.erros ? 'concluido_com_erros' : 'concluido';
    // Codex PR#33: a reconstrução apaga+reinsere sem credito_ml — redistribui os bônus do período
    try { aplicarCreditosFlex(de, ate).catch(() => {}); } catch (e9) {}
  } catch(e){ _backfill.fase='erro'; _backfill.msg = String(e.message||e); }
  _backfill.rodando = false; _backfill.fim = new Date().toISOString();
}

const ULTIMO_DIA = { '01':'31','02':'28','03':'31','04':'30','05':'31','06':'30','07':'31','08':'31','09':'30','10':'31','11':'30','12':'31' };

// ══════════════════════════════════════════════════════════════════════════════════════════
// 01/08 — REAPLICAR IMPOSTO nas linhas já gravadas do histórico.
// Quando o Diego edita a alíquota de um mês, o dashboard já mostra certo (o Mês/Ano recalcula
// na leitura). Mas o valor GRAVADO no Supabase continua velho, e quem lê por outro caminho
// (Plano de Compra, previsão) enxerga o antigo. Esta rotina acerta o gravado.
// NÃO usa o Bling: imposto = valor_nota × alíquota, e a margem acompanha a diferença. Por isso
// leva segundos, e não os ~25 min de um backfill de mês inteiro.
// ══════════════════════════════════════════════════════════════════════════════════════════
// 01/08 — CANCELADOS: descobrir e varrer.
// Achado grave: o filtro do backfill testava /cancel/i em `situacao.valor`, mas o Bling manda
// valor NUMÉRICO (0/1) e não manda `nome` na listagem — o teste NUNCA dava true. Resultado:
// venda cancelada entrava no histórico e somava em faturamento/lucro do Mês/Ano.
// Aqui: (1) descobrimos os IDs de situação "cancelado" no próprio Bling, (2) o backfill passa a
// usar esses IDs, (3) uma varredura diária apaga do Supabase o que foi cancelado depois.
let _sitCancel = { ids: [], nomes: [], ts: 0, erro: null };

async function garantirSitCancel(bg) {
  if (_sitCancel.ids.length && (Date.now() - _sitCancel.ts) < 12 * 3600 * 1000) return _sitCancel;
  try {
    const rm = await bg('/situacoes/modulos');
    const mods = (rm.ok && rm.data && rm.data.data) || [];
    const modVenda = mods.find(m => /venda/i.test(String(m.nome || m.descricao || ''))) || mods[0];
    if (modVenda && modVenda.id) {
      const rs = await bg('/situacoes/modulos/' + modVenda.id);
      const sits = (rs.ok && rs.data && rs.data.data) || [];
      const canc = sits.filter(x => /cancel/i.test(String(x.nome || x.descricao || '')));
      if (canc.length) {
        _sitCancel = { ids: canc.map(x => Number(x.id)).filter(Boolean), nomes: canc.map(x => x.nome), ts: Date.now(), erro: null };
        console.log('[CANCEL] situações de cancelamento no Bling: ' + _sitCancel.nomes.join(', ') + ' (ids ' + _sitCancel.ids.join(',') + ')');
        return _sitCancel;
      }
      _sitCancel.erro = 'nenhuma situação com "cancel" no nome (módulo ' + (modVenda.nome || modVenda.id) + ')';
    } else _sitCancel.erro = 'não achei o módulo de vendas';
  } catch (e) { _sitCancel.erro = String(e.message || e); }
  // fallback: permite fixar na mão por env, se um dia a descoberta falhar
  if (!_sitCancel.ids.length && process.env.AMBBKP_SIT_CANCELADO) {
    _sitCancel.ids = String(process.env.AMBBKP_SIT_CANCELADO).split(',').map(x => Number(x.trim())).filter(Boolean);
    _sitCancel.nomes = ['(definido em AMBBKP_SIT_CANCELADO)'];
  }
  _sitCancel.ts = Date.now();
  if (_sitCancel.erro) console.log('[CANCEL] ⚠️ ' + _sitCancel.erro);
  return _sitCancel;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// 01/08 — FATURAMENTO DO MERCADO LIVRE (API oficial de billing).
// É a MESMA fonte dos relatórios que o Diego baixa à mão em Faturamento → Relatórios, só que
// automática. Traz o que o ML de fato debitou: comissão de venda, custo do Mercado Pago, frete,
// PUBLICIDADE, armazenagem FULL, devoluções e cancelamentos (crédito).
//   períodos:  GET /billing/integration/monthly/periods?group=ML      (key = 1º dia do mês)
//   detalhe:   GET /billing/integration/periods/key/{KEY}/group/ML/details?document_type=BILL
//              paginado por from_id → last_id (a doc pede: nada de paralelo, e cachear)
// O ciclo do ML fecha dia 15, então cada "período" cruza dois meses do calendário — por isso
// guardamos por DATA da tarifa, não pelo nome do período.
let _mlb = { rodando:false, periodos:[], periodoAtual:null, linhas:0, gravadas:0, erros:0, inicio:null, fim:null, msg:'' };
const MLB_FILE = () => path.join(CACHE_DIR, '_ml_billing.json');

function _mlbCategoria(det) {
  const t = String(det || '').toLowerCase();
  if (/cancelamento|bonifica/.test(t))            return 'credito';
  if (/publicidade|product ads/.test(t))          return 'ads';
  if (/armazenamento|full/.test(t))               return 'full';
  if (/devolu/.test(t))                           return 'devolucao';
  if (/envio|frete/.test(t))                      return 'frete';
  if (/vender no mercado livre/.test(t))          return 'comissao';
  if (/cobrar no mercado pago|recebimento/.test(t)) return 'mp';
  if (/parcelamento/.test(t))                     return 'parcelamento';
  return 'outros';
}

async function mlBillingSync(maxPeriodos) {
  if (_mlb.rodando) return _mlb;
  maxPeriodos = Math.min(12, Math.max(1, Number(maxPeriodos) || 12));
  let tokenML = null;
  try { const { garantirTokenML } = require('../ambtotal/mlTokenManager'); tokenML = await garantirTokenML(); }
  catch (e) { _mlb.msg = 'sem token ML: ' + e.message; console.log('[ML-BILLING] \u2717 ' + _mlb.msg); return _mlb; }
  const H = { headers: { Authorization: 'Bearer ' + tokenML } };
  const dorme = ms => new Promise(r => setTimeout(r, ms));   // 02/08: faltava aqui — quebrava antes da 2ª tentativa
  _mlb = { rodando:true, periodos:[], periodoAtual:null, linhas:0, gravadas:0, erros:0, inicio:new Date().toISOString(), fim:null, msg:'' };

  const base = readJson(MLB_FILE(), { tarifas: {}, porDia: {}, atualizado: null });
  base.tarifas = base.tarifas || {}; base.porDia = base.porDia || {};
  try {
    // 02/08: a 1\u00aa tentativa levou 422 (o ML recusou os par\u00e2metros). Em vez de morrer, testamos as
    // variantes documentadas e GUARDAMOS a resposta de cada uma \u2014 assim o erro aparece no status.
    // 02/08: o ML respondeu "Missing required parameter <document_type>" — ele é OBRIGATÓRIO,
    // ao contrário do que a doc dava a entender. Agora vai em todas as variantes.
    const tentativas = [
      'https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=BILL&offset=0&limit=' + maxPeriodos,
      'https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=BILL',
      'https://api.mercadolibre.com/billing/integration/monthly/periods?document_type=BILL&group=ML&limit=' + maxPeriodos,
      'https://api.mercadolibre.com/billing/monthly/periods?group=ML&document_type=BILL'
    ];
    let dp = null;
    _mlb.tentativas = [];
    for (const u of tentativas) {
      let st = 0, corpo = '';
      try {
        const rp = await fetch(u, H);
        st = rp.status;
        // 02/08 — BUG MEU: eu cortava em 400 chars ANTES de fazer o parse, e o JSON chegava picado
        // (a API respondeu 200 e mesmo assim eu dizia "nenhuma variante respondeu"). Agora guardo o
        // corpo INTEIRO pra interpretar e só corto na hora de mostrar no diagnóstico.
        const inteiro = await rp.text().catch(() => '');
        corpo = inteiro.slice(0, 400);
        if (rp.ok) { try { dp = JSON.parse(inteiro); } catch (e) { dp = null; corpo = 'JSON inv\u00e1lido: ' + inteiro.slice(0, 300); } }
      } catch (e) { corpo = String(e.message || e).slice(0, 200); }
      _mlb.tentativas.push({ url: u.replace('https://api.mercadolibre.com', ''), status: st, resposta: corpo });
      console.log('[ML-BILLING] ' + st + ' \u2190 ' + u.replace('https://api.mercadolibre.com', '') + (st !== 200 ? (' :: ' + corpo.slice(0, 180)) : ''));
      if (dp) break;
      await dorme(600);
    }
    if (!dp) throw new Error('nenhuma variante do endpoint de per\u00edodos respondeu \u2014 veja "tentativas" no status');
    const periodos = (dp.results || dp.periods || dp.data || (Array.isArray(dp) ? dp : []))
      .map(x => (typeof x === 'string' ? x : (x.key || x.period_key || x.period || x.date_key || null)))
      .filter(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x));
    if (!periodos.length) { _mlb.amostra_periodos = JSON.stringify(dp).slice(0, 500); }
    _mlb.periodos = periodos.slice();
    console.log('[ML-BILLING] ' + periodos.length + ' per\u00edodo(s): ' + periodos.join(', '));

    for (const key of periodos) {
      _mlb.periodoAtual = key;
      // 02/08: BILL e CREDIT_NOTE devolveram exatamente o MESMO conjunto (mesmo total, mesmo
      // last_id) \u2014 pedir os dois s\u00f3 gastava metade da cota de 5/min \u00e0 toa.
      for (const docType of ['BILL']) {
        let fromId = 0;
        for (let p = 0; p < 60; p++) {
          const u = 'https://api.mercadolibre.com/billing/integration/periods/key/' + key + '/group/ML/details' +
                    '?document_type=' + docType + '&limit=1000&from_id=' + fromId;
          const r = await fetch(u, H);
          // 02/08: eu engolia o 404 em sil\u00eancio \u2014 dava "0 linhas, 0 erros" e parecia travado.
          // Agora a 1\u00aa resposta de cada per\u00edodo fica guardada no status, com url, c\u00f3digo e corpo.
          const bruto = await r.text().catch(() => '');
          if (p === 0) {
            _mlb.detalhes = _mlb.detalhes || [];
            if (_mlb.detalhes.length < 4) _mlb.detalhes.push({ url: u.replace('https://api.mercadolibre.com',''), status: r.status, resposta: bruto.slice(0, 500) });
          }
          if (r.status === 429) {   // 02/08: estourou o teto \u2014 espera e repete a MESMA p\u00e1gina
            console.log('[ML-BILLING] 429 no ' + key + ' \u2014 aguardando 65s');
            _mlb.msg = 'aguardando limite do ML (' + key + ')';
            await dorme(65000); p--; continue;
          }
          if (!r.ok) { _mlb.erros++; console.log('[ML-BILLING] detalhe ' + r.status + ' \u2190 ' + u.replace('https://api.mercadolibre.com','') + ' :: ' + bruto.slice(0,200)); break; }
          let d = null; try { d = JSON.parse(bruto); } catch (e) { d = null; }
          if (!d) { _mlb.erros++; break; }
          const its = (d && (d.results || d.details || d.data)) || [];
          if (!its.length) break;
          // 02/08 \u2014 EXTRATOR ADAPTATIVO. A API leu 3.850 linhas mas gravou 0: os nomes dos campos
          // n\u00e3o eram os que eu supus. Em vez de chutar de novo, procuramos por PADR\u00c3O de nome, e
          // guardamos uma amostra crua do 1\u00ba item pra conferir. Nada se perde por falta de id: se
          // n\u00e3o houver, criamos um a partir do per\u00edodo + posi\u00e7\u00e3o.
          if (!_mlb.amostra_item && its[0]) _mlb.amostra_item = JSON.stringify(its[0]).slice(0, 900);
          // 02/08 \u2014 FORMATO REAL (visto na amostra): os campos vivem ANINHADOS.
          //   charge_info: { detail_id, transaction_detail, detail_amount, detail_type, detail_sub_type, creation_date_time }
          //   sales_info / shipping_info / items_info: dados da venda e do envio (null em tarifa de per\u00edodo)
          // O extrator antigo s\u00f3 olhava o n\u00edvel de cima \u2014 por isso gravou 9.248 linhas com valor 0.
          for (const it of its) {
            const ci = it.charge_info || {}, si = it.sales_info || {}, sh = it.shipping_info || {};
            const idT = String(ci.detail_id || ci.charge_id || '');
            if (!idT) continue;
            let val = Number(ci.detail_amount != null ? ci.detail_amount : ci.charge_amount) || 0;
            const txt = String(ci.transaction_detail || ci.detail_sub_type || '');
            const tipo = String(ci.detail_type || '').toUpperCase();
            // bonifica\u00e7\u00e3o/cancelamento entra NEGATIVO (\u00e9 tarifa que o ML devolveu)
            if (tipo && tipo !== 'CHARGE') val = -Math.abs(val);
            else if (/cancelamento|bonifica/i.test(txt)) val = -Math.abs(val);
            const dia = String(si.sale_date_time || si.date_created || ci.creation_date_time || '').slice(0, 10);
            // 02/08 \u2014 o n\u00famero da venda n\u00e3o estava sendo guardado (a rota de ca\u00e7a deu 0). Eu tinha
            // chutado os nomes dentro de sales_info sem nunca ter visto um. Agora: procura em
            // QUALQUER n\u00edvel um campo cujo nome lembre venda/pedido e cujo valor seja um id longo.
            let ord = String(si.order_id || si.sale_id || si.pack_id || sh.shipment_id || '') || null;
            if (!ord) {
              const cacar = (obj, prof) => {
                if (!obj || typeof obj !== 'object' || prof > 3) return null;
                for (const [k, v] of Object.entries(obj)) {
                  if (v == null) continue;
                  if (typeof v === 'object') { const r = cacar(v, prof + 1); if (r) return r; continue; }
                  const sv = String(v);
                  if (/order|sale|venta|venda|pack|operation/i.test(k) && /^\d{8,}$/.test(sv)) return sv;
                }
                return null;
              };
              ord = cacar(it, 0);
            }
            // guarda uma amostra de item COM venda \u2014 a primeira que peguei era tarifa de per\u00edodo,
            // com sales_info nulo, e por isso eu n\u00e3o enxergava os nomes reais
            if (!_mlb.amostra_venda && (it.sales_info || ord)) _mlb.amostra_venda = JSON.stringify(it).slice(0, 1100);
            // 02/08 \u2014 guarda tamb\u00e9m o PACK. O ML manda order_id e pack_id DIFERENTES pra mesma
            // venda; quando \u00e9 carrinho, o Bling grava o PACK em numero_loja. Sem os dois, o ca\u00e7ador
            // acusou 5.012 faltando quando o buraco real \u00e9 de ~635.
            const pk = String((sh && (sh.pack_id || sh.packId)) || '') || null;
            base.tarifas[idT] = { d: dia, v: Math.round(val * 100) / 100, c: _mlbCategoria(txt), o: ord, p: (pk && pk !== ord ? pk : null), t: txt.slice(0, 60) };
            _mlb.gravadas++;
          }
          _mlb.linhas += its.length;
          const last = d.last_id || (its[its.length - 1] && (its[its.length - 1].detail_id || its[its.length - 1].id));
          if (!last || String(last) === String(fromId)) break;
          fromId = last;
          // 02/08: o ML respondeu "Rate limit exceeded: 5 requests per minute" neste endpoint.
          // 13s entre p\u00e1ginas mant\u00e9m folga dentro do teto.
          await dorme(13000);
        }
      }
      // 02/08: grava A CADA PER\u00cdODO. Antes s\u00f3 no fim \u2014 um deploy no meio de 50 min perdia tudo.
      try { const pd0 = {}; for (const t of Object.values(base.tarifas)) { if (!t.d) continue;
              if (!pd0[t.d]) pd0[t.d] = {}; pd0[t.d][t.c] = Math.round(((pd0[t.d][t.c] || 0) + t.v) * 100) / 100; }
            base.porDia = pd0; base.atualizado = new Date().toISOString(); writeJson(MLB_FILE(), base);
            console.log('[ML-BILLING] ' + key + ' gravado (' + Object.keys(base.tarifas).length + ' tarifas)'); } catch (e) {}
      await dorme(13000);
    }
    // resumo por DIA e categoria — é isso que os cards vão ler
    const porDia = {};
    for (const t of Object.values(base.tarifas)) {
      if (!t.d) continue;
      if (!porDia[t.d]) porDia[t.d] = {};
      porDia[t.d][t.c] = Math.round(((porDia[t.d][t.c] || 0) + t.v) * 100) / 100;
    }
    base.porDia = porDia; base.atualizado = new Date().toISOString();
    writeJson(MLB_FILE(), base);
    _mlb.msg = 'conclu\u00eddo';
  } catch (e) { _mlb.msg = 'erro: ' + (e.message || e); _mlb.erros++; console.log('[ML-BILLING] \u2717 ' + e.message); }
  _mlb.rodando = false; _mlb.fim = new Date().toISOString(); _mlb.periodoAtual = null;
  console.log('[ML-BILLING] fim \u2014 ' + _mlb.gravadas + ' tarifa(s) de ' + _mlb.linhas + ' lidas | erros ' + _mlb.erros);
  // créditos de envio Flex recém-baixados → distribui no histórico (45 dias; o ano roda pela rota)
  try { const hj9 = new Date(), d45 = new Date(Date.now() - 45 * 86400000); const iso9 = x => x.toISOString().slice(0, 10); aplicarCreditosFlex(iso9(d45), iso9(hj9)).catch(() => {}); } catch (e) {}
  return _mlb;
}

// ─── CRÉDITOS DE ENVIO DO ML (bônus Flex) → vendas_historico.credito_ml ──────────────────
// 11/08 — auditoria de 2 vendas contra o extrato do ML provou: o ML PAGA o envio Flex
// (bônus/compensação) e a margem ignorava o crédito — toda venda Flex saía R$ 9-11 pior.
// O dado JÁ ESTÁ BAIXADO: o billing diário grava os créditos com o nº da venda em o/p.
// Esta função só DISTRIBUI. Zero chamadas novas ao ML. Regras (as 4 vieram do Codex no PR #33):
//   1. SÓ bônus de ENVIO entra: a categoria 'credito' também carrega estorno de tarifa e
//      cancelamento — o filtro é pelo TEXTO (bonifica + envio/flex). O que tem venda mas não
//      casa no texto vai contado em ignorados_por_texto, pra calibrarmos com o dado real.
//   2. Carrinho: o crédito às vezes só traz o order id e o Bling grava o PACK em numero_loja —
//      um 1º passe monta o mapa order→pack com TODAS as tarifas (igual ao ml-vendas-faltando).
//   3. A janela de/ate só SELECIONA quais vendas reprocessar; a soma gravada é SEMPRE o total
//      do billing daquela venda — senão a rodada diária de 45d sobrescreveria o ano com parcial.
//   4. Grava na PRIMEIRA linha do pedido (nunca soma em dobro em pedido multi-linha). Idempotente.
let _mlcred = { rodando:false, de:null, ate:null, no_billing:0, bonus_envio:0, sem_venda:0, ignorados_por_texto:{}, pedidos:0, gravados:0, ja_iguais:0, sem_linha_no_historico:0, erros:0, ultima_falha:null, amostra:null, inicio:null, fim:null };
function _ehBonusEnvio(tf) {
  if (!tf || tf.c !== 'credito') return false;
  const tx = String(tf.t || '');
  return /bonifica/i.test(tx) && /(envio|env[ií]o|flex)/i.test(tx);
}
async function aplicarCreditosFlex(de, ate) {
  if (_mlcred.rodando) return _mlcred;
  _mlcred = { rodando:true, de:de||null, ate:ate||null, no_billing:0, bonus_envio:0, sem_venda:0, ignorados_por_texto:{}, pedidos:0, gravados:0, ja_iguais:0, sem_linha_no_historico:0, erros:0, ultima_falha:null, amostra:null, inicio:new Date().toISOString(), fim:null };
  try {
    const arq = readJson(path.join(CACHE_DIR, '_ml_billing.json'), null);
    const tarifas = Object.values((arq && arq.tarifas) || {});
    // passe 0: mapa order→pack com TODAS as tarifas (o pack nem sempre vem no próprio crédito)
    const mapaPack = {};
    for (const tf of tarifas) { if (tf && tf.o && tf.p) mapaPack[String(tf.o)] = String(tf.p); }
    const chavesDe = (tf) => {
      const ks = new Set();
      if (tf.o) { ks.add(String(tf.o)); const pk = mapaPack[String(tf.o)]; if (pk) ks.add(pk); }
      if (tf.p) ks.add(String(tf.p));
      return [...ks];
    };
    // passe 1: seleciona as vendas AFETADAS (bônus com data dentro da janela pedida)
    const afetadas = new Set();
    for (const tf of tarifas) {
      if (!tf || tf.c !== 'credito') continue;
      _mlcred.no_billing++;
      if (!_ehBonusEnvio(tf)) {
        const ch0 = chavesDe(tf);
        if (ch0.length) { const k0 = String(tf.t || '(sem texto)').slice(0, 60); _mlcred.ignorados_por_texto[k0] = (_mlcred.ignorados_por_texto[k0] || 0) + 1; }
        continue;
      }
      _mlcred.bonus_envio++;
      const dia = String(tf.d || '');
      if (de && dia && dia < de) continue;
      if (ate && dia && dia > ate) continue;
      const ch = chavesDe(tf);
      if (!ch.length) { _mlcred.sem_venda++; continue; }
      if (!_mlcred.amostra) _mlcred.amostra = { venda: ch[0], valor: Math.abs(Number(tf.v) || 0), texto: tf.t || null, dia: dia };
      for (const c of ch) afetadas.add(c);
    }
    // passe 2: pra cada venda afetada, soma TODOS os bônus dela no billing (sem janela) — regra 3
    const somaPorChave = {};
    for (const tf of tarifas) {
      if (!_ehBonusEnvio(tf)) continue;
      const val = Math.abs(Number(tf.v) || 0);
      if (!(val > 0)) continue;
      const ch = chavesDe(tf).filter(c => afetadas.has(c));
      if (!ch.length) continue;
      // o mesmo crédito indexado em order E pack conta UMA vez por venda: registra o objeto
      for (const c of ch) { (somaPorChave[c] = somaPorChave[c] || new Set()).add(tf); }
    }
    // b56 (venda 3235, 12/08): o /costs do ML às vezes responde SEM a compensação nos primeiros
    // dias (a rodada das 04:40 re-pescou, veio vazio, e o costs_ok até APAGOU o crédito) — mas o
    // BILLING já tem o bônus. Só que esta função gravava SÓ no Supabase, e o card do DIA lê o
    // arquivo LOCAL. Agora o crédito do billing carimba TAMBÉM conferidos.json e _vendas_dia.json.
    const confL = readJson(CONFERIDOS_FILE, {});
    const idxConf = {};
    for (const [cidL, cL] of Object.entries(confL)) {
      for (const chL of [cL && cL.ml_order, cL && cL.ml_pack, cL && cL.numero_loja]) { if (chL && idxConf[String(chL)] === undefined) idxConf[String(chL)] = cidL; }
    }
    // Codex PR#40: num carrinho, somaPorChave tem o PACK (total) e as orders (parciais), e os
    // dois aliases apontam pro MESMO conferido — resolver por REGISTRO, com o pack canônico
    // vencendo (parcial nunca sobrescreve total). credPorNL alimenta o _vendas_dia no fim.
    const credPorCid = {};   // cid → { cred, ehPack }
    const credPorNL = {};    // numero_loja → cred (pro merge tardio do _vendas_dia)
    let mudouConf = false;
    _mlcred.carimbados_local = 0;
    for (const nl of Object.keys(somaPorChave)) {
      let cred = 0; for (const tf of somaPorChave[nl]) cred += Math.abs(Number(tf.v) || 0);
      cred = Math.round(cred * 100) / 100;
      if (!(cred > 0)) continue;
      _mlcred.pedidos++;
      credPorNL[String(nl)] = Math.max(credPorNL[String(nl)] || 0, cred);
      const cidL2 = idxConf[String(nl)];
      if (cidL2 && confL[cidL2]) {
        const ehPack = String(confL[cidL2].ml_pack || '') === String(nl);
        const atual = credPorCid[cidL2];
        if (!atual || (ehPack && !atual.ehPack) || (ehPack === !!atual.ehPack && cred > atual.cred)) credPorCid[cidL2] = { cred, ehPack };
      }
      try {
        const rG = await supaReq('amb', 'GET', 'vendas_historico?empresa=eq.amb&canal=eq.ml&numero_loja=eq.' + encodeURIComponent(nl) + '&select=id,credito_ml&order=id.asc&limit=1', null);
        let lin = null;
        try { const arr = JSON.parse(rG.body || '[]'); lin = Array.isArray(arr) ? arr[0] : null; } catch (e) {}
        if (!rG.ok) { _mlcred.erros++; _mlcred.ultima_falha = 'GET ' + nl + ' status ' + rG.status + ' ' + String(rG.body || rG.erro || '').slice(0, 160); continue; }
        if (!lin) { _mlcred.sem_linha_no_historico++; continue; }
        if (lin.credito_ml != null && Math.abs(Number(lin.credito_ml) - cred) < 0.005) { _mlcred.ja_iguais++; continue; }
        const rP = await supaReq('amb', 'PATCH', 'vendas_historico?id=eq.' + encodeURIComponent(lin.id), { credito_ml: cred });
        if (rP.ok) _mlcred.gravados++;
        else { _mlcred.erros++; _mlcred.ultima_falha = 'PATCH ' + nl + ' status ' + rP.status + ' ' + String(rP.body || rP.erro || '').slice(0, 200); }
      } catch (e) { _mlcred.erros++; _mlcred.ultima_falha = String(e.message || e).slice(0, 160); }
      await new Promise(r5 => setTimeout(r5, 90));
    }
    for (const [cidC, rC] of Object.entries(credPorCid)) {
      // Codex PR#40 2ª leva: a FONTE atualiza mesmo com o valor igual — sem o carimbo 'billing',
      // a guarda do salvar não protege este crédito e o próximo /costs vazio o apagaria
      if (confL[cidC] && (Math.abs(Number(confL[cidC].credito_ml || 0) - rC.cred) >= 0.005 || confL[cidC].credito_fonte !== 'billing')) {
        confL[cidC].credito_ml = rC.cred; confL[cidC].credito_fonte = 'billing'; mudouConf = true; _mlcred.carimbados_local++;
      }
    }
    if (mudouConf) {
      try {
        // re-read anti-corrida (mesmo padrão da rota de massa): o bipe pode ter mexido no arquivo
        const confF = readJson(CONFERIDOS_FILE, {});
        let algum = false;
        // Codex PR#40 2ª leva: só os ids RECALCULADOS nesta rodada — varrer o confL inteiro
        // re-imporia snapshots billing velhos por cima do que outro writer gravou no meio
        for (const [cidF, rF] of Object.entries(credPorCid)) {
          if (confF[cidF] && (Math.abs(Number(confF[cidF].credito_ml || 0) - rF.cred) >= 0.005 || confF[cidF].credito_fonte !== 'billing')) { confF[cidF].credito_ml = rF.cred; confF[cidF].credito_fonte = 'billing'; algum = true; }
        }
        if (algum) writeJson(CONFERIDOS_FILE, confF);
      } catch (e) {}
    }
    // Codex PR#40 (P1): o vendasSync de 5min reescreve _vendas_dia no meio da rodada — re-lê
    // AGORA e mescla SÓ os créditos calculados, nunca o snapshot inteiro de minutos atrás
    try {
      const vdPathL = path.join(CACHE_DIR, '_vendas_dia.json');
      const vdF = readJson(vdPathL, {});
      let mudouVdF = false;
      for (const vF of Object.values(vdF)) {
        const cF = credPorNL[String((vF && vF.numero_loja) || '')];
        if (cF && Math.abs(Number(vF.credito_ml || 0) - cF) >= 0.005) { vF.credito_ml = cF; mudouVdF = true; }
      }
      if (mudouVdF) writeJson(vdPathL, vdF);
    } catch (e) {}
  } catch (e) { _mlcred.erros++; _mlcred.ultima_falha = String(e.message || e).slice(0, 160); }
  _mlcred.rodando = false; _mlcred.fim = new Date().toISOString();
  console.log('[ML-CREDITOS] fim — ' + _mlcred.gravados + ' gravado(s) de ' + _mlcred.pedidos + ' venda(s) com bônus | ignorados (outros créditos): ' + Object.values(_mlcred.ignorados_por_texto).reduce((a, b) => a + b, 0) + ' | erros: ' + _mlcred.erros);
  return _mlcred;
}

let _varre = { rodando:false, dias:0, encontrados:0, apagados:0, erros:0, inicio:null, fim:null, situacoes:[], msg:'' };

async function varrerCancelados(dias, empresa) {
  if (_varre.rodando) return _varre;
  empresa = empresa || 'amb';
  dias = Math.min(400, Math.max(1, Number(dias) || 45));
  const token = await garantirToken();
  // 04/08 CONSERTO: 'dorme' nunca existiu neste escopo (o base exporta 'sleep'). Toda vez que uma
  // pagina do Bling voltava CHEIA (100 itens) o await abaixo estourava ReferenceError, caia no catch
  // la embaixo e a varredura morria calada com encontrados=0 — parecia "nao tem cancelado nenhum".
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg = async pth => { for (let t = 0; t < 4; t++) { const r = await blingGet(pth); if (r.ok || r.status === 404) return r; await dorme(1400 + t * 600); } return await blingGet(pth); };
  const sc = await garantirSitCancel(bg);
  _varre = { rodando:true, dias, encontrados:0, apagados:0, erros:0, inicio:new Date().toISOString(), fim:null,
             situacoes: sc.nomes.slice(), msg: sc.ids.length ? '' : ('sem IDs de cancelamento: ' + (sc.erro || '?')) };
  if (!sc.ids.length) { _varre.rodando = false; _varre.fim = new Date().toISOString(); return _varre; }

  const hoje = new Date();
  const ate = hoje.toISOString().slice(0, 10);
  const de = new Date(hoje.getTime() - dias * 86400000).toISOString().slice(0, 10);
  const nums = new Set();
  try {
    for (const sid of sc.ids) {
      for (let pag = 1; pag <= 60; pag++) {
        const r = await bg('/pedidos/vendas?idsSituacoes=' + sid + '&dataInicial=' + de + '&dataFinal=' + ate + '&limite=100&pagina=' + pag);
        const lista = (r.ok && r.data && r.data.data) || [];
        if (!lista.length) break;
        for (const p of lista) { const n = String(p.numero || '').trim(); if (n) nums.add(n); }
        if (lista.length < 100) break;
        await dorme(420);
      }
    }
    _varre.encontrados = nums.size;
    console.log('[CANCEL] ' + nums.size + ' pedido(s) cancelado(s) no Bling nos últimos ' + dias + ' dias');

    if (nums.size) {
      const { url, key } = supaCfg(empresa);
      if (url && key) {
        const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'count=exact' };
        const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
        const arr = Array.from(nums);
        for (let i = 0; i < arr.length; i += 80) {
          const lote = arr.slice(i, i + 80).map(x => '"' + x + '"').join(',');
          try {
            const rd = await fetch(base + '?empresa=eq.' + empresa + '&numero_pedido=in.(' + encodeURIComponent(lote) + ')', { method: 'DELETE', headers: H });
            if (rd.ok) { const cr = rd.headers.get('content-range') || ''; const n2 = Number((cr.split('/')[0] || '').split('-').pop()) ; _varre.apagados += (isFinite(n2) ? n2 + 1 : 0) || 0; }
            else _varre.erros++;
          } catch (e) { _varre.erros++; }
        }
      }
      try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {}
    }
    _varre.msg = 'concluído';
  } catch (e) { _varre.msg = 'erro: ' + (e.message || e); _varre.erros++; }
  _varre.rodando = false; _varre.fim = new Date().toISOString();
  console.log('[CANCEL] varredura concluída — ' + _varre.encontrados + ' cancelado(s), linhas removidas do histórico | erros: ' + _varre.erros);
  return _varre;
}

let _reap = { rodando:false, meses:[], mesAtual:null, linhas:0, atualizadas:0, erros:0, inicio:null, fim:null, msg:'' };

async function reaplicarImposto(meses, empresa){
  if (_reap.rodando) return _reap;
  empresa = empresa || 'amb';
  const { url, key } = supaCfg(empresa);
  if (!url || !key) { _reap.msg = 'Supabase não configurado'; return _reap; }
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
  const cfg = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
  const aliqDe = m => { const a = cfg.aliquotas && cfg.aliquotas[m];
    if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
    return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[m] != null) ? Number(DEFAULT_ALIQ_BK[m]) : null; };

  _reap = { rodando:true, meses:meses.slice(), mesAtual:null, linhas:0, atualizadas:0, erros:0,
            inicio:new Date().toISOString(), fim:null, msg:'' };
  console.log('[FISCAL] reaplicando imposto em: ' + meses.join(', '));
  try {
    for (const mes of meses) {
      _reap.mesAtual = mes;
      const aq = aliqDe(mes);
      if (aq == null) { console.log('[FISCAL] ' + mes + ': sem alíquota — pulando'); continue; }
      const ini = mes + '-01';
      const d2 = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0);
      const fim = mes + '-' + String(d2.getDate()).padStart(2,'0');
      let off = 0;
      while (off < 200000) {
        const rq = await fetch(base + '?empresa=eq.' + empresa + '&data_venda=gte.' + ini + '&data_venda=lte.' + fim +
          '&select=id,valor_nota,imposto,margem&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=500&offset=' + off, { headers: H });
        if (!rq.ok) { _reap.erros++; break; }
        const ln = await rq.json().catch(() => []);
        if (!Array.isArray(ln) || !ln.length) break;
        _reap.linhas += ln.length;
        const mudar = [];
        for (const l of ln) {
          const vn = Number(l.valor_nota) || 0, im0 = Number(l.imposto) || 0;
          if (!(vn > 0)) continue;
          const novo = Math.round(vn * aq / 100 * 100) / 100;
          if (Math.abs(novo - im0) <= 0.005) continue;
          const mg = (l.margem == null) ? null : Math.round((Number(l.margem) - (novo - im0)) * 100) / 100;
          mudar.push({ id: l.id, imposto: novo, margem: mg });
        }
        // grava em paralelo, de 8 em 8 (PATCH por linha; o Supabase aguenta bem)
        for (let i = 0; i < mudar.length; i += 8) {
          const lote = mudar.slice(i, i + 8);
          await Promise.all(lote.map(async x => {
            try {
              const corpo = (x.margem == null) ? { imposto: x.imposto } : { imposto: x.imposto, margem: x.margem };
              const rp = await fetch(base + '?id=eq.' + x.id, { method: 'PATCH', headers: H, body: JSON.stringify(corpo) });
              if (rp.ok) _reap.atualizadas++; else _reap.erros++;
            } catch (e) { _reap.erros++; }
          }));
        }
        if (ln.length < 500) break;
        off += 500;
      }
      console.log('[FISCAL] ' + mes + ' (alíquota ' + aq + '%): ' + _reap.atualizadas + ' linha(s) atualizadas até agora');
    }
    // o agregado do Mês/Ano tem que refletir na hora
    try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {}
    _reap.msg = 'concluído';
  } catch (e) { _reap.msg = 'erro: ' + (e.message || e); _reap.erros++; }
  _reap.rodando = false; _reap.fim = new Date().toISOString(); _reap.mesAtual = null;
  console.log('[FISCAL] reaplicar imposto CONCLUÍDO — ' + _reap.atualizadas + ' linha(s) de ' + _reap.linhas + ' | erros: ' + _reap.erros);
  return _reap;
}

let _backfillAno = { rodando:false, mesAtual:null, feitos:[], inicio:null, fim:null };
async function backfillAnoTodo(ateMes){
  if(_backfillAno.rodando || _backfill.rodando) return;
  _backfillAno = { rodando:true, mesAtual:null, feitos:[], inicio:new Date().toISOString(), fim:null };
  const meses = ['01','02','03','04','05','06','07','08','09','10','11','12'].filter(m => m <= ateMes);
  for(const m of meses){
    _backfillAno.mesAtual = '2026-'+m;
    await backfillVendas('2026-'+m+'-01', '2026-'+m+'-'+ULTIMO_DIA[m], 'amb');   // espera cada mês terminar antes do próximo
    _backfillAno.feitos.push({ mes:'2026-'+m, pedidos:_backfill.pedidos, itens:_backfill.itens, gravados:_backfill.gravados, erros:_backfill.erros });
    await new Promise(r=>setTimeout(r,2500));
  }
  _backfillAno.rodando = false; _backfillAno.mesAtual = null; _backfillAno.fim = new Date().toISOString();
}

async function vendasSync() {
  let _nfHoraOrc = 0;   // teto de consultas de hora da NF por rodada
  if (_vsy.rodando) return;
  // b35 (Codex PR#13): os resultados por marketplace são DESTA rodada — zerar aqui,
    // senão o status mostra o número da rodada anterior enquanto a atual ainda nem
    // chegou na fase (ou pulou por falta de chave/token), fingindo um dado que não é.
    _vsy.ml_direto = null; _vsy.shopee_direto = null; _vsy.mg_direto = null;
    _vsy.rodada_em = new Date().toISOString();
    _vsy.rodando = true; _vsy.erro = null; _vsy.fase = 'listagem';
  try {
    const isoD = dt => dt.toISOString().slice(0, 10);
    const hoje = new Date();
    const ini = new Date(hoje); ini.setDate(ini.getDate() - 3);
    const fim = new Date(hoje); fim.setDate(fim.getDate() + 1);   // janela [hoje-3, hoje+1] — evita o bug do mesmo-dia do Bling
    const F = path.join(CACHE_DIR, '_vendas_dia.json');
    const MAG_EMPRESA = process.env.AMBBKP_MAGALU_EMPRESA || 'amb';   // qual empresa Magalu este serviço consulta (girassol/good/amb)
    const atual = readJson(F, {});
    let paginas = 0;
    for (let pg = 1; pg <= 20; pg++) {
      // 28/07: idem — antes o vendasSync trazia os mais recentes de QUALQUER data e só não quebrava
      // por causa do limite de páginas + filtro no frontend. Agora a janela vale de verdade.
      const r = await blingGet('/pedidos/vendas?dataInicial=' + isoD(ini) + '&dataFinal=' + isoD(fim) + '&pagina=' + pg + '&limite=100');
      const lista = (r && r.ok && r.data && r.data.data) || [];
      if (!lista.length) break;
      paginas++;
      for (const p of lista) {
        if (!p || p.id == null) continue;
        const nl = p.numeroPedidoLoja || p.numeroLoja || null;   // a LISTAGEM do Bling manda numeroLoja (o detalhe manda numeroPedidoLoja)
        const ljId = String((p.loja && p.loja.id) || '');
        // 🐛 27/07 — BUG GRAVE CORRIGIDO: aqui o registro era SUBSTITUÍDO inteiro a cada rodada (5 min),
        // apagando tudo que as fases seguintes tinham enriquecido: itens (it), flag det, tarifa/frete REAIS
        // do ML, hora da venda, dados da Shopee e a marca de cancelado no marketplace. Resultado: a cada
        // rodada quase tudo voltava à estaca zero e só ~120 pedidos eram reconstruídos — por isso os
        // pedidos ficavam eternamente sem detalhe/margem e o "cancelado" sumia sozinho.
        // Agora MESCLA: a listagem só atualiza os campos que ela realmente conhece.
        const _ant = atual[String(p.id)] || {};
        const _sitBling = (p.situacao && (p.situacao.valor || p.situacao.nome)) || null;
        atual[String(p.id)] = Object.assign({}, _ant, {
          id: p.id, numero: p.numero != null ? p.numero : null,
          numero_loja: nl || _ant.numero_loja || null,
          marketplace: LOJA_MKT[ljId] || _ant.marketplace || _inferCanal(nl),   // canal OFICIAL pela loja do Bling; formato do nº é só fallback
          data: (p.data || '').slice(0, 10) || _ant.data || null,
          total: (p.total != null && isFinite(Number(p.total))) ? Number(p.total) : (_ant.total != null ? _ant.total : null),
          cliente: (p.contato && p.contato.nome) || _ant.cliente || '',
          // se já sabemos que o MARKETPLACE cancelou, não deixa a situação do Bling apagar isso
          situacao: (_ant.cancelado_mkt && !/cancel/i.test(String(_sitBling || ''))) ? (_ant.situacao || _sitBling) : _sitBling,
          situacao_id: (p.situacao && p.situacao.id) || null,
          loja_id: (p.loja && p.loja.id) || null,
          atualizado_em: new Date().toISOString()
        });
        // b30/b31: o Bling FINALMENTE importou este pedido? A entrada provisória que
        // veio DIRETO do marketplace ('ml:'/'sh:'/'mg:' + id) cede o lugar — sem duplicata.
        if (nl) { delete atual['ml:' + String(nl)]; delete atual['sh:' + String(nl)]; delete atual['mg:' + String(nl)]; }
      }
      if (lista.length < 100) break;
      await new Promise(r2 => setTimeout(r2, 450));
    }
    writeJson(F, atual);   // b12: grava JÁ após a fase 1 — o 🔄 do dashboard espera 6s e recarrega; antes, o arquivo só era gravado no fim da rodada (~1 min) e o botão sempre mostrava a rodada anterior
    // ─── b30: VENDAS DO DIA DIRETO DO MERCADO LIVRE ─────────────────────────────
    // Princípio do Diego (02/08, cobrado de novo em 10/08): "a API tem que ser com o
    // marketplace; o Bling é só conferência depois". A AMB é Full nos três canais e o
    // Bling dela só vê a venda quando o XML desce — o dia vivia magro no dashboard
    // (10/08: 35 pedidos nos marketplaces × 4 no Bling). Esta fase pergunta AO ML
    // "o que você vendeu hoje?" e põe na tela na hora, como provisória; quando o
    // Bling importar o pedido, a listagem acima apaga a provisória (dedup pelo
    // order_id) e a venda segue o fluxo normal de NF/margem.
    _vsy.fase = 'ml_direto';
    try {
      let _tkD = null;
      try { const { garantirTokenML: _g3 } = require('../ambtotal/mlTokenManager'); _tkD = await _g3(); } catch (e) {}
      if (_tkD) {
        const HD = { headers: { Authorization: 'Bearer ' + _tkD } };
        let sellerD = null;
        try { const rm = await fetch('https://api.mercadolibre.com/users/me', HD); if (rm.ok) sellerD = (await rm.json()).id; } catch (e) {}
        if (sellerD) {
          // Codex #11 (pack): RECONCILIAÇÃO antes de criar — se o Bling já tem o pedido
          // (pelo order_id OU pelo pack_id do carrinho, que é o que o Bling grava em
          // numeroLoja), a provisória morre aqui. Cobre qualquer ordem de chegada.
          const blingSet = new Set();
          for (const [k5, v5] of Object.entries(atual)) {
            if (v5 && v5.numero_loja && !String(k5).startsWith('ml:')) blingSet.add(String(v5.numero_loja));
          }
          for (const [k5, v5] of Object.entries(atual)) {
            if (!String(k5).startsWith('ml:') || !v5) continue;
            if (blingSet.has(String(v5.numero_loja || '')) || (v5.pack_id && blingSet.has(String(v5.pack_id)))) delete atual[k5];
          }
          const jaTem = new Set();
          for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTem.add(String(v.numero_loja)); }
          // b34 (Codex PR#12, vale pros 3 canais): a janela da consulta tem que cobrir a
          // RETENÇÃO do arquivo (6 dias), não só ontem+hoje. Provisória vive até 6 dias;
          // se a consulta só olha 36h, um cancelamento no 3º dia nunca é visto e a venda
          // morta segue somando no dashboard até a poda.
          const dIni = new Date(hoje); dIni.setDate(dIni.getDate() - 6);
          const fromD = isoD(dIni) + 'T00:00:00.000-03:00', toD = isoD(fim) + 'T23:59:59.999-03:00';
          const baseD = 'https://api.mercadolibre.com/orders/search?seller=' + sellerD +
                        '&order.date_created.from=' + encodeURIComponent(fromD) +
                        '&order.date_created.to=' + encodeURIComponent(toD) + '&sort=date_desc&limit=50';
          let novosML = 0, totalD = Infinity;
          const vistos = new Set();   // ids que ESTA varredura viu (pro passo dirigido lá embaixo)
          // b38 (Codex PR#14): com 6 dias de janela e sort=date_desc, o teto de 300 podia
          // deixar as provisórias mais VELHAS fora da varredura — justo as que precisam de
          // reconciliação. Teto sobe pra 1.000 e, ainda assim, quem não for visto passa
          // pelo passo dirigido (consulta 1 a 1) logo abaixo.
          for (let off = 0; off < 1000 && off < totalD; off += 50) {
            const r3 = await fetch(baseD + '&offset=' + off, HD);
            if (!r3.ok) break;
            let d3 = null; try { d3 = await r3.json(); } catch (e) { break; }
            const arr3 = (d3 && d3.results) || [];
            if (d3 && d3.paging && isFinite(Number(d3.paging.total))) totalD = Number(d3.paging.total);
            for (const o3 of arr3) {
              if (!o3 || o3.id == null) continue;
              const oid = String(o3.id);
              const st3 = String(o3.status || '');
              // Codex #11 (cancelada depois): se o ML cancelou e a provisória existe, ela morre
              if (/cancell/i.test(st3)) { if (atual['ml:' + oid]) { delete atual['ml:' + oid]; } continue; }
              // Codex #11 (só pagas): mesmo critério do ingest histórico deste arquivo
              if (st3 !== 'paid') continue;
              vistos.add(oid);
              if (jaTem.has(oid)) continue;
              if (o3.pack_id && jaTem.has(String(o3.pack_id))) continue;   // carrinho: o Bling conhece pelo pack
              // Codex #11 (schema): itens no formato do cache — {sku, d, qtd, vt}
              const its = (o3.order_items || []).map(oi => ({
                sku: (String((oi.item && (oi.item.seller_sku || oi.item.seller_custom_field)) || '').trim()) || null,
                d: String((oi.item && oi.item.title) || '').slice(0, 120) || null,
                qtd: Number(oi.quantity || 1),
                vt: Math.round(Number(oi.unit_price || 0) * Number(oi.quantity || 1) * 100) / 100
              }));
              atual['ml:' + oid] = {
                id: 'ml:' + oid, sem_bling: true, det: true,
                numero: null, numero_loja: oid, pack_id: (o3.pack_id != null ? String(o3.pack_id) : null),
                marketplace: 'mercadolivre',
                data: String(o3.date_created || '').slice(0, 10),
                venda_em: (o3.date_created || null),
                total: Number(o3.paid_amount != null ? o3.paid_amount : (o3.total_amount || 0)),
                cliente: (o3.buyer && (o3.buyer.nickname || '')) || '',
                it: its.length ? its : undefined,
                situacao: 'DIRETO DO ML (Bling ainda não importou)',
                atualizado_em: new Date().toISOString()
              };
              jaTem.add(oid); novosML++;
            }
            if (arr3.length < 50) break;
            await new Promise(r4 => setTimeout(r4, 350));
          }
          // passo dirigido: provisória que a varredura não alcançou é conferida uma a uma
          let conferidas = 0, mortas = 0;
          // b41 (Codex PR#17): com teto de 40 e ordem fixa, as MESMAS 40 eram reconferidas
          // toda rodada e as provisórias do fim da fila nunca chegavam a ser checadas —
          // um cancelamento lá atrás só sumiria na poda. Agora há RODÍZIO: cada entrada
          // carimba quando foi conferida (`_conf_em`) e a fila é ordenada pela mais
          // ANTIGA primeiro (quem nunca foi conferida vem na frente).
          const fila9 = Object.entries(atual)
            .filter(([k9, v9]) => String(k9).startsWith('ml:') && v9 && String(v9.numero_loja || '').trim() && !vistos.has(String(v9.numero_loja).trim()))
            .sort((x, y) => String((x[1] && x[1]._conf_em) || '').localeCompare(String((y[1] && y[1]._conf_em) || '')));
          for (const [k9, v9] of fila9) {
            const oid9 = String(v9.numero_loja || '').trim();
            if (conferidas >= 40) break;                       // teto por rodada; o resto entra na próxima, pelo rodízio
            conferidas++;
            v9._conf_em = new Date().toISOString();            // carimbo do rodízio
            try {
              const r9 = await fetch('https://api.mercadolibre.com/orders/' + encodeURIComponent(oid9), HD);
              if (!r9.ok) continue;                            // sumiu/sem permissão: não mexe
              const o9 = await r9.json();
              const st9 = String((o9 && o9.status) || '');
              if (/cancell/i.test(st9) || (st9 && st9 !== 'paid')) { delete atual[k9]; mortas++; }
            } catch (e) {}
            await new Promise(r10 => setTimeout(r10, 200));
          }
          if (conferidas || mortas) writeJson(F, atual);   // grava os carimbos do rodízio, mesmo sem remoção
          _vsy.ml_direto = { novos: novosML, conferidas_1a1: conferidas, removidas: mortas, em: new Date().toISOString() };
          if (novosML) { writeJson(F, atual); console.log('[VENDAS-SYNC] ml_direto: +' + novosML + ' venda(s) que o Bling ainda nao tem'); }
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase ml_direto falhou: ' + String(e.message || e).slice(0, 120)); }
    // ─── b31: VENDAS DO DIA DIRETO DA SHOPEE ────────────────────────────────────
    // Mesmo princípio da fase acima. O serviço shopee-nf-sync (dono do token) ganhou
    // a rota /:loja/interno/pedidos-do-dia — lista por create_time e devolve valor,
    // comprador e itens. Provisórias 'sh:<order_sn>'; o Bling apaga ao importar.
    _vsy.fase = 'shopee_direto';
    try {
      const SH_URLd = process.env.AMBBKP_SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const SH_KEYd = process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '';
      if (SH_KEYd) {
        const jaTemS = new Set();
        for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTemS.add(String(v.numero_loja)); }
        const rSd = await fetch(SH_URLd + '/' + (process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb') + '/interno/pedidos-do-dia?horas=168&k=' + encodeURIComponent(SH_KEYd), { timeout: 90000 });   // b38: 168h = teto novo do serviço, cobre a retenção de 6 dias (Codex PR#14)
        if (!rSd.ok) {
          const corpoSd = await rSd.text().catch(() => '');
          _vsy.shopee_direto = { erro: 'HTTP ' + rSd.status + ' — ' + corpoSd.slice(0, 120), http: rSd.status, corpo: corpoSd.slice(0, 200), url: SH_URLd, detalhado: true, em: new Date().toISOString() };
          throw new Error('servico Shopee respondeu HTTP ' + rSd.status);
        }
        const jSd = await rSd.json().catch(() => null);
        if (jSd && jSd.ok && Array.isArray(jSd.pedidos)) {
          let novosS = 0;
          for (const pSd of jSd.pedidos) {
            if (!pSd || !pSd.order_sn) continue;
            const osn = String(pSd.order_sn);
            // b32 (mesmos 2 do Codex na fase ML): status ANTES do jaTem — cancelou
            // depois de entrar? a provisória morre. E UNPAID não é venda ainda.
            const stSd = String(pSd.order_status || '').toUpperCase();
            if (/CANCEL/.test(stSd)) { if (atual['sh:' + osn]) { delete atual['sh:' + osn]; } continue; }
            if (stSd === 'UNPAID') continue;
            if (jaTemS.has(osn)) continue;
            atual['sh:' + osn] = {
              id: 'sh:' + osn, sem_bling: true, det: true,
              numero: null, numero_loja: osn, marketplace: 'shopee',
              data: pSd.create_time ? new Date(Number(pSd.create_time) * 1000).toISOString().slice(0, 10) : null,
              hora_venda: pSd.create_time ? new Date(Number(pSd.create_time) * 1000).toISOString() : null,
              venda_em: pSd.create_time ? new Date(Number(pSd.create_time) * 1000).toISOString() : null,
              total: Number(pSd.total || 0),
              cliente: pSd.buyer || '',
              it: (Array.isArray(pSd.itens) && pSd.itens.length) ? pSd.itens.map(x => ({ sku: x.sku, quantidade: x.qtd, valor: x.valor })) : undefined,
              situacao: 'DIRETO DA SHOPEE (Bling ainda não importou)',
              atualizado_em: new Date().toISOString()
            };
            jaTemS.add(osn); novosS++;
          }
          _vsy.shopee_direto = { novos: novosS, listados: jSd.listados || jSd.pedidos.length, em: new Date().toISOString() };
          if (novosS) { writeJson(F, atual); console.log('[VENDAS-SYNC] shopee_direto: +' + novosS + ' venda(s) que o Bling ainda nao tem'); }
        } else if (jSd && jSd.erro) {
          _vsy.shopee_direto = { erro: String(jSd.erro).slice(0, 120), em: new Date().toISOString() };
        }
      }
    } catch (e) {
      // 11/08: falha da Shopee não pode virar SILÊNCIO — o status mostrava null e a
      // investigação ficava cega. O "Not Found" cru do Render (hostname inexistente)
      // quebrava no .json() e caía aqui sem deixar rastro.
      // b39 (Codex PR#16): se o bloco acima já guardou o diagnóstico RICO (status HTTP +
      // corpo da resposta + URL), este catch NÃO pode sobrescrever com a mensagem genérica
      // — o corpo é justamente o que identifica o hostname errado.
      if (!(_vsy.shopee_direto && _vsy.shopee_direto.detalhado)) {
        _vsy.shopee_direto = { erro: String(e.message || e).slice(0, 160), url: (process.env.AMBBKP_SHOPEE_SYNC_URL || 'default no codigo'), em: new Date().toISOString() };
      }
      console.log('[VENDAS-SYNC] fase shopee_direto falhou: ' + String(e.message || e).slice(0, 120));
    }
    // ─── b31: VENDAS DO DIA DIRETO DA MAGALU ────────────────────────────────────
    // Via a rota local /magalu/pedidos-do-dia (módulo magalu-oauth, dono do token).
    // O campo do TOTAL é defensivo (estrutura não 100% mapeada) — se vier 0, a venda
    // aparece mesmo assim e o Bling completa o valor quando importar.
    _vsy.fase = 'mg_direto';
    try {
      const ADMd = process.env.ADMIN_KEY || '';
      const PORTd = process.env.PORT || 3000;
      if (ADMd) {
        const jaTemM = new Set();
        for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTemM.add(String(v.numero_loja)); }
        const rMd = await fetch('http://127.0.0.1:' + PORTd + '/magalu/pedidos-do-dia?empresa=' + MAG_EMPRESA + '&k=' + encodeURIComponent(ADMd) + '&desde=' + isoD(new Date(hoje.getTime() - 6 * 86400000)), { timeout: 90000 });   // b34: cobre a retenção de 6 dias
        const jMd = await rMd.json().catch(() => null);
        if (jMd && jMd.ok && Array.isArray(jMd.pedidos)) {
          let novosM2 = 0;
          for (const pMd of jMd.pedidos) {
            if (!pMd || !pMd.code) continue;
            const cod = String(pMd.code);
            const stMd = String(pMd.status || '').toLowerCase();
            if (/cancel/.test(stMd)) { if (atual['mg:' + cod]) { delete atual['mg:' + cod]; } continue; }
            if (jaTemM.has(cod)) continue;
            atual['mg:' + cod] = {
              id: 'mg:' + cod, sem_bling: true, det: true,
              numero: null, numero_loja: cod, marketplace: 'magalu',
              data: String(pMd.purchased_at || '').slice(0, 10) || null,
              hora_venda: pMd.purchased_at || null,
              total: Number(pMd.total || 0),
              cliente: pMd.cliente || '',
              situacao: 'DIRETO DA MAGALU (Bling ainda não importou)',
              atualizado_em: new Date().toISOString()
            };
            jaTemM.add(cod); novosM2++;
          }
          _vsy.mg_direto = { novos: novosM2, listados: jMd.total_listado || jMd.pedidos.length, em: new Date().toISOString() };
          if (novosM2) { writeJson(F, atual); console.log('[VENDAS-SYNC] mg_direto: +' + novosM2 + ' venda(s) que o Bling ainda nao tem'); }
        } else if (jMd && jMd.erro) {
          _vsy.mg_direto = { erro: String(jMd.erro).slice(0, 120), em: new Date().toISOString() };
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase mg_direto falhou: ' + String(e.message || e).slice(0, 120)); }
    _vsy.fase = 'detalhes';
    // b21: esta fase virou a PRIMEIRA depois da listagem — é ela que dá MARGEM às vendas ainda não bipadas
    // (itens → custo/R$ produtos; taxas → tarifa). Estava por último atrás de NF/Shopee e pedido novo ficava
    // sem margem nenhuma até o fim da rodada (ou pra sempre, se a rodada não terminasse).
    // fase 2: DETALHE dos ainda não-bipados (itens → custo/R$ produtos; taxas → tarifa/frete) — margem antes da bipagem
    try {
      const confS = readJson(CONFERIDOS_FILE, {});
      const bipN = new Set(Object.values(confS).map(c => String(c && c.numero)));
      let _tkV=null; try{ const {garantirTokenML:_g2}=require('../ambtotal/mlTokenManager'); _tkV=await _g2(); }catch(e){}   // hora real do ML nas não-bipadas
      const alvosDet = Object.values(atual)
        .filter(v => v && !v.det && v.numero != null && !bipN.has(String(v.numero)) && !/cancel/i.test(String(v.situacao || '')))
        .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || Number(b.numero || 0) - Number(a.numero || 0))   // b30: mais RECENTES primeiro. Com 800+ vendas na janela, os recentes (que o Diego abre pra ver) ficavam no FIM da fila de inserção e nunca ganhavam detalhe/margem — agora entram primeiro.
        .slice(0, 120);   // b30: 90→120 por rodada pra drenar o volume mais rápido
      let _detN = 0;
      for (const v of alvosDet) {
        const rd = await blingGet('/pedidos/vendas/' + v.id);
        const det = (rd && rd.ok && rd.data && rd.data.data) || null;
        if (det) {
          if (!v.numero_loja && det.numeroPedidoLoja) v.numero_loja = det.numeroPedidoLoja;   // detalhe traz numeroPedidoLoja
          if (!v.marketplace || v.marketplace === 'outro') { const lj2 = String((det.loja && det.loja.id) || ''); v.marketplace = LOJA_MKT[lj2] || _inferCanal(v.numero_loja); }
          v.it = (det.itens || []).map(i2 => ({ sku: (i2.codigo || (i2.produto && i2.produto.codigo) || '').trim() || null, d: (i2.descricao || (i2.produto && i2.produto.nome) || '').slice(0, 120) || null, qtd: Number(i2.quantidade || 1), vt: Math.round(Number(i2.valor || 0) * Number(i2.quantidade || 1) * 100) / 100 }));   // 28/07: +d = nome do produto, p/ o cartão do celular mostrar o título também nas vendas ainda não bipadas
          const tc = det.taxas && Number(det.taxas.taxaComissao); if (isFinite(tc) && tc > 0) v.taxa_mkt = Math.round(tc * 100) / 100;
          const cf = det.taxas && Number(det.taxas.custoFrete); if (isFinite(cf) && cf > 0) v.frete_mkt = Math.round(cf * 100) / 100;
          if (det.situacao && (det.situacao.valor || det.situacao.nome)) v.situacao = det.situacao.valor || det.situacao.nome;
          v.det = 1;
          if (_tkV && v.marketplace === 'ml' && v.numero_loja && !v.venda_em) {
            try {
              const nlm = String(v.numero_loja).replace(/\D/g, '');
              let rml = await fetch('https://api.mercadolibre.com/orders/' + nlm, { headers: { Authorization: 'Bearer ' + _tkV } });
              let dml = await rml.json().catch(() => null);
              if (!rml.ok) { rml = await fetch('https://api.mercadolibre.com/packs/' + nlm, { headers: { Authorization: 'Bearer ' + _tkV } }); const dp3 = await rml.json().catch(() => null); const o1 = dp3 && dp3.orders && dp3.orders[0]; if (rml.ok && o1) { rml = await fetch('https://api.mercadolibre.com/orders/' + (o1.id || o1), { headers: { Authorization: 'Bearer ' + _tkV } }); dml = await rml.json().catch(() => null); } }
              if (rml.ok && dml && dml.date_created) v.venda_em = dml.date_created;
            } catch (e) {}
          }
        }
        await new Promise(r3 => setTimeout(r3, 450));
        // b52: grava PARCIAL a cada 20 — antes só gravava no fim do lote, e qualquer deploy/reinício
        // no meio jogava fora o trabalho da rodada inteira (pedido ficava sem itens = sem unidade/custo).
        if ((++_detN % 20) === 0) { try { writeJson(F, atual); } catch (e) {} }
      }
      writeJson(F, atual);   // itens/taxas no disco JÁ — o dashboard enxerga a margem na hora
    } catch (e) {}
    _vsy.fase = 'ml_real';
    // fase ML REAL (b31): pros pedidos ML NÃO-bipados, pesca comissão + frete REAIS direto da API
    // do ML (fonte primária, mais confiável que o taxaComissao/custoFrete que o Bling importa).
    // A fase detalhes acima já deu SKU/custo/tarifa-do-Bling; esta SOBREPÕE com o dado real do ML.
    // Recentes primeiro, lote limitado (rate limit do ML). Quando o pedido é bipado, a mlSyncFees assume.
    try {
      const confR = readJson(CONFERIDOS_FILE, {});
      const bipR = new Set(Object.values(confR).map(c => String(c && c.numero)));
      let tkR = null;
      try { const { garantirTokenML: _g3 } = require('../ambtotal/mlTokenManager'); tkR = await _g3(); } catch (e) {}
      if (tkR) {
        const dormeR = ms => new Promise(r4 => setTimeout(r4, ms));
        const alvosR = Object.values(atual)
          .filter(v => v && (v.marketplace === 'ml' || v.marketplace === 'mercadolivre') && v.numero_loja && !v.ml_real && !bipR.has(String(v.numero)) && !/cancel/i.test(String(v.situacao || '')))
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || Number(b.numero || 0) - Number(a.numero || 0))   // recentes primeiro
          .slice(0, 40);   // lote por rodada — o ML tem rate limit; 40 × ~3 chamadas cada
        let _mlN = 0;
        for (const v of alvosR) {
          try {
            const reg = await pescarDadosML(v.numero_loja, tkR, dormeR);
            if (reg) {
              if (reg.fee != null && reg.fee > 0) v.tarifa_ml = reg.fee;   // comissão REAL do ML (sobrepõe a do Bling)
              if (reg.frete != null) v.frete_ml = reg.frete;               // frete REAL do ML
              if (reg.venda) v.venda_em = reg.venda;                       // hora real da venda
              if (reg.credito != null) v.credito_ml = reg.credito;         // estorno/compensação
              if (reg.credito_fonte) v.credito_fonte = reg.credito_fonte;
              if (reg.logistica) v.logistica_ml = reg.logistica;
              if (reg.order) v.ml_order = reg.order;
              if (reg.pack) v.ml_pack = reg.pack;
              v.ml_real = 1;   // pescado — não repesca até bipar (aí a mlSyncFees assume)
            }
          } catch (e) {}
          await dormeR(350);
          if ((++_mlN % 10) === 0) { try { writeJson(F, atual); } catch (e) {} }   // 27/07: grava parcial — deploy no meio não joga a pesca fora
        }
        writeJson(F, atual);   // dado real do ML no disco — o dashboard já mostra "REAL"
      }
    } catch (e) {}
    _vsy.fase = 'devolucoes';
    // fase DEVOLUÇÕES (b39): busca as devoluções (type 'returns') recentes do ML e marca os pedidos
    // com o frete de retorno + status/destino. Roda leve (só as ~50 recentes de cada status, filtradas
    // por type returns). O prejuízo = perde a venda (reembolso) + frete de ida (já capturado) + este frete de retorno.
    try {
      let tkC = null;
      try { const { garantirTokenML: _g6 } = require('../ambtotal/mlTokenManager'); tkC = await _g6(); } catch (e) {}
      if (tkC) {
        const dormeC = ms => new Promise(r5 => setTimeout(r5, ms));
        const devs = await buscarDevolucoesML(tkC, dormeC);
        if (devs && Object.keys(devs).length) {
          for (const v of Object.values(atual)) {
            if (!v || (v.marketplace !== 'ml' && v.marketplace !== 'mercadolivre')) continue;
            const d = devs[String(v.numero_loja || '')] || devs[String(v.ml_order || '')] || devs[String(v.ml_pack || '')] || null;
            if (d) {
              v.devolucao = 1;
              v.dev_claim_id = d.claim_id;
              v.dev_frete_retorno = d.frete_retorno;   // frete de retorno pago pelo vendedor (0 quando volta pro galpão)
              v.dev_destino = d.destino;                // warehouse (foi pro ML) / seller_address (voltou pro galpão)
              v.dev_status = d.dev_status;              // label_generated / shipped / ...
              v.dev_aberta = d.aberta ? 1 : 0;          // ainda em aberto (disputa/claim) vs já fechada
              v.dev_data = d.data;
            }
          }
          writeJson(F, atual);   // devoluções marcadas no disco
        }
      }
    } catch (e) {}
    _vsy.fase = 'nf_emissao';
    // fase NF (rodava por último e NUNCA gravava: o processo morria no meio da rodada e o salvamento era só no fim —
    // b14: roda logo após a listagem e salva a cada 8, então mesmo rodada interrompida deixa progresso no disco)
    try {
      const confN = readJson(CONFERIDOS_FILE, {});
      const corteN = Date.now() - 4 * 86400000;
      const alvosN = Object.entries(confN)
        .filter(([idN, cN]) => cN && (cN.nf_emissao == null || cN.nf_emissao === '') && cN.nf_numero && cN.conferido_em && Date.parse(cN.conferido_em) >= corteN)   // b16: '' (sentinela antiga) volta pra fila
        .sort((a, b) => String(b[1].conferido_em || '').localeCompare(String(a[1].conferido_em || '')))   // mais NOVO primeiro
        .slice(0, 30);
      const pendN = {};
      const salvarN = () => {
        if (!Object.keys(pendN).length) return;
        const c9 = readJson(CONFERIDOS_FILE, {});   // relê antes de gravar — não atropela bipagem no meio
        let n9 = 0;
        let _pnf_ = 0;
        for (const [k9, v9] of Object.entries(pendN)) { if (c9[k9] && (c9[k9].nf_emissao == null || c9[k9].nf_emissao === '')) { c9[k9].nf_emissao = v9; if (v9) n9++; } }
        writeJson(CONFERIDOS_FILE, c9);
        for (const k9 of Object.keys(pendN)) delete pendN[k9];
        if (n9) console.log('[VENDAS-SYNC] nf_emissao preenchida em ' + n9 + ' conferido(s)');
      };
      let cN2 = 0;
      for (const [idN] of alvosN) {
        // b16: a pasta do pedido SAI do cache quando ele finaliza (raio-X provou: snapshot_existe=false),
        // então a fonte é o Bling PELO PEDIDO — nfDoPedido tenta /pedidos/vendas/{id}/nfe e cai pro detalhe se precisar.
        const snN = readJson(path.join(CACHE_DIR, String(idN), 'pedido.json'), null);
        let dtN = (snN && snN.nf && snN.nf.dataEmissao) || null;   // se o snapshot ainda viver e já tiver, aproveita de graça
        if (!dtN) {
          try {
            const nfO = await nfDoPedido(idN);
            if (nfO && nfO.dataEmissao) dtN = nfO.dataEmissao;
            else if (nfO && nfO.id) {   // NF achada mas a resposta veio sem a data → detalhe /nfe/{id}
              await new Promise(r4a => setTimeout(r4a, 450));
              const rN = await blingGet('/nfe/' + nfO.id);
              const dN = rN && rN.ok && rN.data && rN.data.data;
              if (dN && dN.dataEmissao) dtN = dN.dataEmissao;
            }
          } catch (e) {}
        }
        if (dtN) {
          pendN[idN] = dtN;
          if (snN && snN.nf) { snN.nf.dataEmissao = dtN; try { writeJson(path.join(CACHE_DIR, String(idN), 'pedido.json'), snN); } catch (e) {} }
        }
        cN2++; if (cN2 % 8 === 0) salvarN();
        await new Promise(r4 => setTimeout(r4, 450));
      }
      salvarN();
    } catch (e) { console.log('[VENDAS-SYNC] fase nf_emissao falhou: ' + String(e.message || e).slice(0, 120)); }
    _vsy.fase = 'shopee';
    // fase SHOPEE (b17): hora REAL da venda (create_time) + comissão REAL (escrow) direto do app da Shopee,
    // via a rota interna do serviço shopee-nf-sync (que guarda os tokens). Batch de até 20 order_sns por rodada.
    // Precisa da env SHOPEE_SYNC_KEY no Render DESTE serviço (mesma chave que abriu o teste C); URL opcional em SHOPEE_SYNC_URL.
    try {
      const SH_URL = process.env.AMBBKP_SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const SH_KEY = process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '';
      if (SH_KEY) {
        const candS = Object.values(atual)
          // b121 (06/08): `!v.tarifa_shopee_v2` entra na fila pra REPROCESSAR quem já tem
          // tarifa gravada pela fórmula antiga (net+net). Sem isso os pedidos antigos ficariam
          // com o valor subestimado pra sempre, porque o filtro só pegava tarifa_ml == null.
          .filter(v => v && v.marketplace === 'shopee' && v.numero_loja && (v.venda_em == null || v.tarifa_ml == null || !v.tarifa_shopee_v2 || v.frete_recebido == null || v.renda_canal == null))   // b18/b19: frete_recebido e renda_canal também entram na fila (backfill)
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
          .slice(0, 20);
        if (candS.length) {
          const rS = await fetch(SH_URL + '/' + (process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb') + '/interno/margem-pedidos?k=' + encodeURIComponent(SH_KEY) + '&order_sns=' + encodeURIComponent(candS.map(v => v.numero_loja).join(',')), { timeout: 90000 });
          const jS = await rS.json().catch(() => null);
          if (jS && jS.ok && Array.isArray(jS.pedidos)) {
            const porSn = {}; jS.pedidos.forEach(pS => { if (pS && pS.order_sn) porSn[pS.order_sn] = pS; });
            let nS = 0;
            for (const v of candS) {
              const pS = porSn[v.numero_loja]; if (!pS) continue;
              if (pS.create_time && v.venda_em == null) { v.venda_em = new Date(Number(pS.create_time) * 1000).toISOString(); nS++; }
              const es = pS.escrow || null;
              // ── b121 (06/08): A FÓRMULA CERTA DA SHOPEE ────────────────────────────
              // Estava net_commission + net_service — e SÓ. Faltavam o REBATE e o AFILIADO.
              // Era daqui que vinha a diferença que a gente mediu: no dia 05/08 a tela
              // mostrava R$ 592,63 de comissão de Shopee e o valor real era R$ 675,80.
              // O `net_*` vem DEPOIS do abatimento e a Shopee cobra a diferença de volta como
              // `seller_product_rebate` — que sai do bolso do vendedor. Prova aritmética:
              //   net_commission = commission − rebate.commission_fee_offset
              //   net_service    = service    − rebate.service_fee_offset
              //   rebate.amount  = os dois offsets somados
              // Logo net + net + rebate == comissão BRUTA + serviço BRUTO.
              // Fórmula conferida em 100 de 100 pedidos, sobra ZERO em todos.
              if (es && (v.tarifa_ml == null || !v.tarifa_shopee_v2)) {
                const nS2 = x => { const n = Number(x); return isFinite(n) ? n : 0; };
                const com = nS2(es.net_commission_fee != null ? es.net_commission_fee : es.commission_fee);
                const srv = nS2(es.net_service_fee != null ? es.net_service_fee : es.service_fee);
                const rbt = nS2(es.seller_product_rebate && es.seller_product_rebate.amount);
                const afi = nS2(es.order_ams_commission_fee);     // comissão de afiliado — custo do vendedor
                const cam = nS2(es.campaign_fee);
                const prc = nS2(es.seller_order_processing_fee);
                // b123 (06/08): seguro de envio do vendedor. Só apareceu quando olhei a AMB —
                // na Girassol vem sempre zero. Fica aqui porque quando o dashboard for pra
                // AMBTotal a conta já nasce certa.
                const seg = nS2(es.shipping_seller_protection_fee_amount);
                const tS = Math.round((com + srv + rbt + afi + seg + cam + prc) * 100) / 100;
                if (tS > 0) { v.tarifa_ml = tS; v.tarifa_shopee_v2 = 1; }   // o dashboard exibe pela mesma via da tarifa REAL do ML
              }
              if (es && v.frete_recebido == null) {
                const frB = Number(es.buyer_paid_shipping_fee) || 0;   // b18: frete que o COMPRADOR pagou (extrato: "Subtotal estimado do frete") — crédito na M.C.
                v.frete_recebido = frB > 0 ? Math.round(frB * 100) / 100 : 0;   // 0 = confirmado sem frete do comprador (sai da fila)
              }
              if (es && v.renda_canal == null) {
                // b19: a RENDA OFICIAL do pedido (o que a Shopee deposita) — já liquida taxas, moedas Shopee,
                // cupons (dela e teus) e frete do comprador. É a âncora da M.C. no dashboard (caso das 170 moedas = R$ 1,70 que a Shopee banca).
                const ra = Number(es.escrow_amount_after_adjustment != null ? es.escrow_amount_after_adjustment : es.escrow_amount);
                if (isFinite(ra) && ra > 0) v.renda_canal = Math.round(ra * 100) / 100;
              }
            }
            if (nS) console.log('[VENDAS-SYNC] shopee: hora/comissão real em ' + nS + ' venda(s)');
            writeJson(F, atual);
          }
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase shopee falhou: ' + String(e.message || e).slice(0, 120)); }
    _vsy.fase = 'magalu';
    // fase MAGALU: valores REAIS da API de Análise Financeira (comissão serviço+tech, MDR,
    // tarifa fixa, coparticipação de frete, devolução) via a rota /magalu/financeiro-lote
    // no MESMO serviço. A Magalu manda PRÉVIA (comissão) e substitui pelo REAL (com frete)
    // quando o pedido é entregue/liquidado — igual o Jodda. Por isso re-consultamos os
    // provisórios até o frete aparecer (v.mag_fin='real'). Usa a ADMIN_KEY do próprio serviço.
    try {
      const ADM = process.env.ADMIN_KEY || '';
      const PORT = process.env.PORT || 3000;
      if (ADM) {
        // candidatos: pedidos magalu sem financeiro ainda (mag_fin ausente) OU provisórios
        // (mag_fin='prov' — comissão veio mas falta frete). Os 'real' saem da fila.
        const candM = Object.values(atual)
          .filter(v => v && v.marketplace === 'magalu' && v.numero_loja && v.mag_fin !== 'real')
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
          .slice(0, 30);
        if (candM.length) {
          const codes = candM.map(v => String(v.numero_loja)).join(',');
          const urlM = 'http://127.0.0.1:' + PORT + '/magalu/financeiro-lote?empresa=' + MAG_EMPRESA +
            '&k=' + encodeURIComponent(ADM) + '&dias=45&codes=' + encodeURIComponent(codes);
          const rM = await fetch(urlM, { timeout: 90000 });
          const jM = await rM.json().catch(() => null);
          if (jM && jM.ok && jM.pedidos) {
            let nM = 0;
            for (const v of candM) {
              const fin = jM.pedidos[String(v.numero_loja)];
              if (!fin) {
                /* ═══ 20/08 — PEDIDO QUE A API DA MAGALU AINDA NÃO CONHECE ═══════════════════
                   O Diego: "sim, tem q botar o frete previsto, senão eu vou olhar e ficar
                   enganado". Ele estava certo: sem o registro financeiro, este pedido ficava SEM
                   frete nenhum e a margem aparecia inflada — justamente nas vendas mais recentes,
                   que são as que ele olha pra decidir preço. A TARIFA real depende da API mesmo e
                   continua esperando, mas o FRETE previsto NÃO: sai do banco por SKU (média do
                   frete real, auto-corretiva) ou da tabela por dimensão. Então entra agora, e o
                   real substitui quando o pedido aparece. */
                if (v.mag_frete_copart == null) {
                  const estSemApi = await magaluFreteProvisorio(v);
                  if (estSemApi != null) {
                    v.mag_frete_copart = Math.round(estSemApi * 100) / 100;
                    v.mag_frete_fonte = 'prov';
                  }
                }
                continue;   // segue na fila: a tarifa real ainda vai chegar
              }
              const liquidado = !!(fin.frete_debito && fin.frete_debito !== 0);
              // taxa base (sempre real): comissão(serviço+tech+frete-comissão) + MDR + tarifa fixa
              const taxaBase = Math.abs(fin.comissao) + Math.abs(fin.mdr) + Math.abs(fin.tarifa_fixa);
              let freteCopart, freteFonte;
              if (liquidado) {
                // LIQUIDADO: frete REAL da API + alimenta o banco por SKU (aprende pro futuro)
                freteCopart = Math.abs(fin.frete_debito); freteFonte = 'real';
                const it0 = (v.it || [])[0];
                if (it0 && it0.sku) magaluFreteSkuGravar(it0.sku, freteCopart);
              } else {
                // PROVISÓRIO: estima o frete (histórico do SKU, senão tabela pela dimensão)
                const est = await magaluFreteProvisorio(v);
                freteCopart = est != null ? est : 0; freteFonte = est != null ? 'prov' : 'sem';
              }
              // TARIFA = só a comissão da Magalu (serviço+tech+comissão-frete) + MDR + tarifa fixa.
              // O frete de coparticipação vai SEPARADO em mag_frete_copart (coluna FRETE VEND.),
              // pra não misturar comissão e frete na mesma coluna.
              const taxaBaseR = Math.round(taxaBase * 100) / 100;
              if (taxaBaseR > 0) { v.tarifa_ml = taxaBaseR; nM++; }
              v.mag_frete_copart = Math.round(freteCopart * 100) / 100;   // frete: exibido na coluna FRETE VEND.
              v.mag_frete_fonte = freteFonte;   // 'real' | 'prov' | 'sem'
              // devolução: estorno da venda (REFUND) quando houver
              if (fin.tem_devolucao) { v.mag_refund = Math.abs(fin.refund); v.devolvido = true; }
              // saldo líquido oficial da Magalu (a âncora, tipo renda_canal da Shopee) — só quando liquidado
              if (liquidado && isFinite(fin.saldo_liquido)) v.renda_canal = fin.saldo_liquido;
              // estável só quando o frete real apareceu (liquidado). Senão fica 'prov' e re-consulta.
              v.mag_fin = liquidado ? 'real' : 'prov';
            }
            if (nM) console.log('[VENDAS-SYNC] magalu: financeiro real em ' + nM + ' venda(s)');
            writeJson(F, atual);
          }
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase magalu falhou: ' + String(e.message || e).slice(0, 120)); }
    // poda: fora da janela de 6 dias sai do arquivo (o histórico de verdade vive nos conferidos)
    const corte = new Date(hoje); corte.setDate(corte.getDate() - 6);
    const corteS = isoD(corte);
    for (const [k, v] of Object.entries(atual)) { if (!v || !v.data || v.data < corteS) delete atual[k]; }
    writeJson(F, atual);
    _vsy.total = Object.keys(atual).length; _vsy.atualizado_em = new Date().toISOString(); _vsy.fase = 'fim';
    console.log('[VENDAS-SYNC] ok — ' + _vsy.total + ' venda(s) na janela (' + paginas + ' página(s))');
  } catch (e) { _vsy.erro = String(e.message || e).slice(0, 140); console.log('[VENDAS-SYNC] falhou: ' + _vsy.erro); }
  _vsy.rodando = false;
}

// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
let _cst = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, inicio: null };

// ─── REAPLICAR CUSTO NO HISTÓRICO (19/08) ────────────────────────────────────────
// Irmã do reaplicarImposto, e nasceu do mesmo tipo de problema: o custo do KIT estava
// errado no banco (o Bling devolve, no bloco `fornecedor` de um produto com composição,
// um número que não é o custo dele — 20,40 num kit de 34,00). Corrigir o `_custos.json`
// arruma Hoje/Ontem, mas NÃO arruma o histórico: a leitura só REPÕE custo quando ele está
// vazio; quando está ERRADO, o errado permanece. Sem isto, Mês e Ano seguem com a margem
// inflada, e as rotas que leem a margem gravada (previsão, plano de compra) também.
//
// Regra: para cada linha, custo_certo = custo_do_SKU × quantidade. Se difere do gravado,
// grava o novo custo e move a margem na mesma medida — exatamente como o imposto faz.
// Linha cujo SKU não está no banco de custos é DEIXADA COMO ESTÁ (não apaga o que existe).
let _reapC = { rodando:false, de:null, ate:null, linhas:0, atualizadas:0, sem_custo:0, erros:0, inicio:null, fim:null, msg:'', maiores:[] };
async function reaplicarCusto(de, ate, empresa, opts){
  if (_reapC.rodando) return _reapC;
  empresa = empresa || 'girassol';
  const simular = !!(opts && opts.simular);
  const { url, key } = supaCfg(empresa);
  if (!url || !key) { _reapC.msg = 'Supabase não configurado'; return _reapC; }
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
  const cc = readJson(path.join(CACHE_DIR, '_custos.json'), {});
  const custoDe = sk => { const c = cc[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo)) && Number(c.custo) > 0) ? Number(c.custo) : null; };

  _reapC = { rodando:true, de, ate, empresa, simulacao:simular, linhas:0, atualizadas:0, sem_custo:0, erros:0,
             linhas_ganhando_custo:0, custo_que_entra:0, linhas_com_custo_corrigido:0, efeito_real_na_margem:0,
             inicio:new Date().toISOString(), fim:null, msg:'', maiores:[] };
  const _porSku = {};
  console.log('[CUSTO-REAP] ' + (simular ? 'SIMULANDO' : 'reaplicando') + ' custo de ' + de + ' a ' + ate + ' (' + empresa + ')');
  let dif_total = 0;
  try {
    let off = 0;
    while (off < 300000) {
      const rq = await fetch(base + '?empresa=eq.' + empresa + '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
        '&select=id,sku,quantidade,custo,margem,numero_pedido&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=500&offset=' + off, { headers: H });
      if (!rq.ok) { _reapC.erros++; break; }
      const ln = await rq.json().catch(() => []);
      if (!Array.isArray(ln) || !ln.length) break;
      _reapC.linhas += ln.length;
      const mudar = [];
      for (const l of ln) {
        const cu = custoDe(l.sku);
        if (cu == null) { _reapC.sem_custo++; continue; }        // sem custo conhecido: não mexe
        const q = Number(l.quantidade) || 0;
        if (!(q > 0)) continue;
        const novo = Math.round(cu * q * 100) / 100;
        const c0 = (l.custo == null) ? null : Number(l.custo);
        if (c0 != null && Math.abs(novo - c0) <= 0.005) continue;  // já está certo
        // margem acompanha: custo maior derruba margem na mesma medida
        const mg = (l.margem == null || c0 == null) ? null : Math.round((Number(l.margem) - (novo - c0)) * 100) / 100;
        // 19/08 — DOIS CASOS DIFERENTES, que eu vinha somando no mesmo balde e enganavam o Diego:
        //   (a) custo ERA nulo → a linha ganha custo, mas a margem NÃO muda (não há de onde tirar)
        //   (b) custo estava ERRADO → a margem cai exatamente o que o custo sobe
        // O "efeito na margem" só pode contar (b), senão promete um impacto que não acontece.
        const _dif = novo - (c0 || 0);
        dif_total += _dif;
        if (c0 == null) { _reapC.linhas_ganhando_custo++; _reapC.custo_que_entra += _dif; }
        else { _reapC.linhas_com_custo_corrigido++; _reapC.efeito_real_na_margem -= _dif; }
        // agrupado por SKU: 20 linhas idênticas do mesmo produto não dizem nada; o que importa é
        // QUAIS produtos mudam e quanto no total
        const _g = _porSku[l.sku] || (_porSku[l.sku] = { sku: l.sku, linhas: 0, custo_antes: c0, custo_agora: novo, diferenca_total: 0, muda_margem: c0 != null });
        _g.linhas++; _g.diferenca_total = Math.round((_g.diferenca_total + _dif) * 100) / 100;
        mudar.push({ id: l.id, custo: novo, margem: mg });
      }
      if (!simular) {
        for (let i = 0; i < mudar.length; i += 8) {
          const lote = mudar.slice(i, i + 8);
          await Promise.all(lote.map(async x => {
            try {
              const corpo = (x.margem == null) ? { custo: x.custo } : { custo: x.custo, margem: x.margem };
              const rp = await fetch(base + '?id=eq.' + x.id, { method: 'PATCH', headers: H, body: JSON.stringify(corpo) });
              if (rp.ok) _reapC.atualizadas++; else _reapC.erros++;
            } catch (e) { _reapC.erros++; }
          }));
        }
      } else { _reapC.atualizadas += mudar.length; }
      if (ln.length < 500) break;
      off += 500;
    }
    _reapC.diferenca_total_de_custo = Math.round(dif_total * 100) / 100;
    _reapC.custo_que_entra = Math.round(_reapC.custo_que_entra * 100) / 100;
    _reapC.efeito_real_na_margem = Math.round(_reapC.efeito_real_na_margem * 100) / 100;
    // o campo antigo somava os dois casos e superestimava o impacto — fica só como referência crua
    _reapC.efeito_na_margem_BRUTO_nao_use = Math.round(-dif_total * 100) / 100;
    _reapC.leia = 'efeito_real_na_margem é o que a margem MUDA de fato; custo_que_entra são linhas que estavam sem custo e ganham um (a margem delas fica como está)';
    _reapC.por_sku = Object.values(_porSku).sort((a, b) => Math.abs(b.diferenca_total) - Math.abs(a.diferenca_total)).slice(0, 40);
    _reapC.skus_afetados = Object.keys(_porSku).length;
    delete _reapC.maiores;   // substituído pelo agrupamento por SKU
    if (!simular) { try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {} }
    _reapC.msg = simular ? 'simulação concluída — NADA foi gravado' : 'concluído';
  } catch (e) { _reapC.msg = 'erro: ' + (e.message || e); _reapC.erros++; }
  _reapC.rodando = false; _reapC.fim = new Date().toISOString();
  console.log('[CUSTO-REAP] fim — ' + _reapC.atualizadas + ' de ' + _reapC.linhas + ' linha(s) | sem custo: ' + _reapC.sem_custo + ' | erros: ' + _reapC.erros);
  return _reapC;
}


// ─── 19/08: SÓ PRODUTO ATIVO ────────────────────────────────────────────────────
// Caso real trazido pelo Diego: o SKU 10xE14-5W-3000K-BIV tinha DOIS cadastros no Bling —
// o ativo (kit de 10, R$ 99,90) e um EXCLUÍDO (composição de 6, R$ 81,00). A busca por
// código devolve os dois, a gente pegava o PRIMEIRO sem olhar a situação, e o custo do kit
// virou 6 × 3,40 = R$ 20,40 em vez de 10 × 3,40 = R$ 34,00. Margem inflada em R$ 13,60 por
// venda, com o número saindo de um cadastro que ele já tinha apagado.
// Regra: cadastro excluído NUNCA é usado. Entre os que sobram, o ativo tem preferência.
// Se sobrar mais de um ativo, devolve o primeiro E avisa no log — ambiguidade real merece
// registro, não escolha silenciosa.
function _prodExcluido(p) {
  const s = String((p && (p.situacao || p.situacaoProduto)) || '').trim().toUpperCase();
  return s === 'E' || s.startsWith('EXCL');
}
function _prodAtivo(p) {
  const s = String((p && (p.situacao || p.situacaoProduto)) || '').trim().toUpperCase();
  return s === 'A' || s.startsWith('ATIV');
}
// `info` (opcional) volta preenchido: {todos_excluidos:true} quando a busca ACHOU cadastros mas
// todos estavam excluídos. Codex (P1): sem essa distinção, quem chama não sabe diferenciar
// "o Bling não respondeu" de "o produto foi apagado" — e no segundo caso o custo velho precisa
// ser JOGADO FORA do cache, senão o ?fresh=1 regrava o número do cadastro deletado.
// `limitePedido`: quantos cabiam na resposta. Codex (P2): com mais de 10 cadastros duplicados, o
// ativo pode estar FORA da página — concluir "todos excluídos" ali e apagar o custo destruiria um
// dado bom. Página cheia = conclusão inconclusiva, e nada é apagado.

// ─── RESOLVER SKU → PRODUTO (reescrito 19/08, 4ª rodada do Codex no PR#143) ──────
// Eu vinha empilhando guarda em cima de guarda e cada rodada achava um buraco novo, porque o
// problema tem MAIS ESTADOS do que eu estava enxergando: três variantes de caixa do SKU, cada
// busca podendo falhar, cada página podendo vir cheia (logo, incompleta), e o produto podendo
// estar ativo, inativo, excluído ou ausente. Agora tudo isso é decidido num lugar só, com os
// estados explícitos, e quem chama recebe um veredito pronto.
//
// Devolve { produto, ativo, todosExcluidos, inconclusivo, motivo }:
//   · produto        — o cadastro escolhido (ativo tem prioridade absoluta), ou null
//   · todosExcluidos — TODOS os cadastros encontrados estão excluídos, e vimos todos
//   · inconclusivo   — alguma busca falhou OU alguma página veio cheia: NÃO dá pra concluir
//                      que o produto sumiu, então nada pode ser apagado
// limpa o cache de 6h do sku-info para um SKU (usado quando o produto some E quando ele é
// re-resolvido: nos dois casos o valor guardado ali pode ser do cadastro errado)
function _limparSkuInfo(sku) {
  try {
    const f = path.join(CACHE_DIR, '_skus-info.json');
    if (!_skuInfoCache) _skuInfoCache = readJson(f, {});
    if (_skuInfoCache[sku]) { delete _skuInfoCache[sku]; writeJson(f, _skuInfoCache); }
  } catch (e) { console.log('[CUSTO] ' + sku + ': não consegui limpar o cache de sku-info (' + e.message + ')'); }
}
async function resolverProdutoPorSku(sku, buscar, limite) {
  const lim = limite || 10;
  const variantes = [...new Set([sku, String(sku).toUpperCase(), String(sku).toLowerCase()])];
  let ativo = null, reserva = null, achouAlgum = false, algumVivo = false;
  let inconclusivo = false, motivo = '';
  for (const v of variantes) {
    const r = await buscar(`/produtos?codigo=${encodeURIComponent(v)}&limite=${lim}&criterio=5`);
    if (!r || !r.ok) {   // Codex (P2, 4ª rodada): variante que falhou (429, timeout) pode ser
      inconclusivo = true;    // justamente a que tinha o cadastro ativo — nunca concluir sem ela
      motivo = motivo || 'uma das buscas falhou (' + v + ')';
      continue;
    }
    const arr = ((r.data && r.data.data) || []).filter(Boolean);
    if (arr.length) achouAlgum = true;
    if (arr.length >= lim) {   // página cheia = pode haver mais adiante
      inconclusivo = true;
      motivo = motivo || 'página cheia (' + arr.length + ' resultados para ' + v + '): pode haver cadastro fora dela';
    }
    for (const p of arr) {
      if (_prodExcluido(p)) continue;
      algumVivo = true;
      if (_prodAtivo(p)) { if (!ativo) ativo = p; }
      else if (!reserva) reserva = p;   // inativo ou sem status: só serve se nenhuma variante der ativo
    }
    if (ativo) break;   // ativo encontrado vence na hora; sem ele, continua procurando nas outras
  }
  // Codex (P2, 4ª rodada): a reserva (cadastro sem status ou inativo) só pode ser aceita DEPOIS de
  // tentar todas as variantes — antes, a primeira variante devolvia a reserva e abortava o laço,
  // deixando o ativo de outra variante para trás.
  const produto = ativo || reserva || null;
  return {
    produto, ativo: !!ativo,
    todosExcluidos: !produto && achouAlgum && !algumVivo && !inconclusivo,
    inconclusivo, motivo
  };
}

function escolherProdutoAtivo(lista, sku, info, limitePedido) {
  const arr = (Array.isArray(lista) ? lista : []).filter(Boolean);
  if (!arr.length) return null;
  const vivos = arr.filter(p => !_prodExcluido(p));
  if (!vivos.length) {
    const paginaCheia = limitePedido && arr.length >= limitePedido;
    // Codex (P2, 3ª rodada): o mesmo `info` atravessa as três variantes de caixa do SKU, e a flag
    // era PEGAJOSA — uma variante com página curta marcava "todos excluídos" e a seguinte, com
    // página cheia (logo, inconclusiva), não conseguia desmarcar. Agora o inconclusivo é registrado
    // à parte e VENCE: basta uma variante inconclusiva para nada ser apagado.
    if (info) {
      if (paginaCheia) info.inconclusivo = true;
      else info.todos_excluidos = true;
    }
    if (paginaCheia) console.log('[PRODUTO] ' + (sku || '?') + ': ' + arr.length + ' cadastros na página e todos excluídos, MAS a página veio cheia — pode haver ativo adiante; não concluo nada (e não apago custo)');
    console.log('[PRODUTO] ' + (sku || '?') + ': todos os ' + arr.length + ' cadastros estão EXCLUÍDOS no Bling — ignorando (melhor sem dado do que com dado de cadastro apagado)');
    return null;
  }
  const ativos = vivos.filter(_prodAtivo);
  const escolha = ativos.length ? ativos : vivos;
  if (escolha.length > 1) {
    console.log('[PRODUTO] ⚠ ' + (sku || '?') + ': ' + escolha.length + ' cadastros ATIVOS com o mesmo código (ids ' + escolha.map(p => p.id).join(', ') + ') — usando o primeiro, mas isso é duplicidade no Bling e merece conferência');
  }
  if (arr.length !== vivos.length) {
    console.log('[PRODUTO] ' + (sku || '?') + ': ' + (arr.length - vivos.length) + ' cadastro(s) excluído(s) descartado(s)');
  }
  return escolha[0];
}

async function custoSync(fresh) {
  if (_cst.rodando) return;
  const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');
  const cc = readJson(CUSTO_FILE, {});
  const conf = readJson(CONFERIDOS_FILE, {});
  const todos = new Set();
  for (const c of Object.values(conf)) { for (const it of ((c && c.itens) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }
  // 27/07: pega também os SKUs das vendas AINDA NÃO BIPADAS (_vendas_dia.json). Antes a fila saía só dos
  // conferidos — SKU que só aparecia em pedido não bipado nunca ganhava custo, e a margem saía inflada.
  try {
    const vd = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
    for (const v of Object.values(vd)) { for (const it of ((v && v.it) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }
  } catch (e) {}
  // 28/07: e também os SKUs do HISTÓRICO (Supabase). O cache local só guarda ~6 dias de vendas,
  // então SKU que vendeu no começo do mês mas não vendeu essa semana nunca entrava na fila do
  // custo — e aparecia como "sem custo" no dashboard mesmo tendo preço cadastrado no Bling.
  try {
    const { url: uH, key: kH } = supaCfg('amb');
    if (uH && kH) {
      const desde = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      let offH = 0, lidos = 0;
      while (offH < 120000) {
        const rh = await fetch(uH.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.amb&data_venda=gte.' + desde +
        // 01/08 — SEM 'order' o Postgres NÃO garante a mesma ordem entre as páginas, e paginar
        // com offset PULA linhas. Um SKU que aparece em UMA única linha (kit vendido 1x) some da
        // fila e nunca ganha custo — foi o caso do 90-lisa-125mm-KIT62, vendido só em 01/05.
                   '&select=sku&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + offH, { headers: { apikey: kH, Authorization: 'Bearer ' + kH } });
        if (!rh.ok) break;
        const ln = await rh.json().catch(() => []);
        if (!Array.isArray(ln) || !ln.length) break;
        for (const l of ln) { if (l && l.sku) todos.add(String(l.sku)); }
        lidos += ln.length;
        if (ln.length < 1000) break;
        offH += 1000;
      }
      if (lidos) console.log('[CUSTO] +SKUs do histórico: ' + lidos + ' linhas lidas, fila agora com ' + todos.size + ' SKU(s)');
    }
  } catch (e) {}
  const SETE_D = 7 * 24 * 3600 * 1000;
  // Codex (P2, 4ª rodada): SKU confirmadamente apagado no Bling continua no histórico de vendas
  // pra sempre. Sem marca, o predicado abaixo (`!k`) o reelegia a cada rodada: três buscas por
  // variante de caixa, nada encontrado, nada apagado — e de novo seis horas depois, para sempre.
  // Conforme SKUs deletados se acumulam, isso queima cota da API e atrasa o custo dos produtos
  // vivos. A LÁPIDE registra "conferido, não existe mais" e a rodada normal pula; o ?fresh=1 do
  // operador ignora a lápide e reconfere (produto pode ser restaurado no Bling).
  const alvos = [...todos].filter(sk => { const k = cc[sk]; if (!fresh && k && k.apagado_em) return false; return fresh || !k || !k.id || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });
  _cst = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, inicio: new Date().toISOString() };
  console.log('[CUSTO] sync iniciando — ' + alvos.length + ' SKU(s) a resolver (tartaruga: ~1,2s/chamada)');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg2 = async (pth) => { for (let t = 0; t < 4; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme(1500 + t * 700); } return await blingGet(pth); };
  let desdeGravei = 0;
  for (const sku of alvos) {
    try {
      let prod = null;
      const _res = await resolverProdutoPorSku(sku, bg2, 10);
      if (_res.produto && _res.produto.id) {
        const d = await bg2(`/produtos/${_res.produto.id}`);
        prod = (d.ok && d.data && d.data.data) || _res.produto;
      }
      if (_res.inconclusivo) console.log('[CUSTO] ' + sku + ': resultado inconclusivo — ' + _res.motivo + ' (nada será apagado)');
      // Codex (P2, 4ª rodada): resolver o cadastro ATIVO não bastava — o cache de 6h do sku-info
      // podia estar com o custo/nome do cadastro EXCLUÍDO, e a sobreposição do permanente só cobre
      // custo NULO. Ou seja, o ?fresh=1 corrigia o banco e a tela seguia mostrando o valor velho.
      // Resolveu com sucesso: o cache secundário daquele SKU é invalidado para ser refeito.
      if (prod && prod.id) _limparSkuInfo(sku);
      // Codex (P1, PR#143): produto APAGADO no Bling — sem isto, o custo velho continuava no
      // cache e o próprio ?fresh=1 o regravava, ou seja, a correção não corrigia nada. Achou
      // cadastros e todos excluídos = o custo daquele SKU deixa de existir aqui também.
      // (busca vazia NÃO limpa: pode ser instabilidade do Bling, e apagar seria pior)
      // Codex (P1, 3ª rodada): eu tranquei TODA a limpeza atrás de `cc[sku]`. Se o custo tinha
      // entrado só pelo sku-info (sem passar pelo custo-sync), nada era limpo e o valor do produto
      // deletado voltava por lá. Só a remoção do permanente pode depender de ele existir.
      if (!prod && _res.todosExcluidos) {
        const _era = cc[sku] && cc[sku].custo;   // ler ANTES de apagar (senão o log sai 'undefined')
        if (cc[sku]) { delete cc[sku]; desdeGravei++; }
        // lápide: sem custo e sem id, só a marca de que já foi conferido e não existe mais
        cc[sku] = { apagado_em: Date.now(), motivo: 'só havia cadastro excluído no Bling' };
        // Codex (P1, 2ª rodada): existe um SEGUNDO cache (o do sku-info, em memória e em
        // _skus-info.json) que também guarda custo — e ele RESTAURA o valor antigo quando o novo
        // vem nulo. Apagar só o permanente deixava o custo do produto deletado voltar por ali,
        // com carimbo novo, indefinidamente. Os dois têm que cair juntos.
        _limparSkuInfo(sku);
        console.log('[CUSTO] ' + sku + ': só havia cadastro EXCLUÍDO no Bling — custo removido dos DOIS caches (era ' + JSON.stringify(_era) + ')');
      }
      if (prod && prod.id) {
        const forn = prod.fornecedor || {};
        // ⚠️ 19/08 — KIT: A COMPOSIÇÃO MANDA, NÃO O CAMPO DO FORNECEDOR.
        // Caso real (AMB, 10xE14-5W-3000K-BIV): a tela do Bling mostra fornecedor 34,00 e
        // "Preço Total de Custo" 34,00 (10 × 3,40), mas a API devolve no bloco `fornecedor` do
        // KIT: precoCusto **20,40** e precoCompra **3,40** — dois números que não são o custo do
        // kit (o 3,40 é o do COMPONENTE). Como `forn.precoCusto` era o primeiro candidato, o
        // dashboard gravava 20,40 e a margem do kit saía inflada em quase R$ 14 por venda.
        // O próprio Bling calcula o custo de um produto com composição SOMANDO os componentes —
        // é o que a tela mostra. Fazemos igual: havendo estrutura, ela decide; os campos do
        // fornecedor viram apenas reserva para quando a composição não fechar.
        const _comps0 = (prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens))
                     || prod.composicao || prod.componentes || null;
        const _temComposicao = Array.isArray(_comps0) && _comps0.length > 0;
        let cand = _temComposicao ? [] :
                   [forn.precoCusto, forn.precoCompra, forn.preco, forn.custo, prod.precoCusto, prod.custo, prod.precoCompra].map(Number).filter(v => isFinite(v) && v > 0);
        if (!cand.length) {
          const rf = await bg2(`/produtos/fornecedores?idProduto=${prod.id}&limite=5`);
          const arr = (rf.ok && rf.data && rf.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          // 27/07: o nome do campo varia na resposta do Bling — aceita todos os candidatos
          if (pref) cand = [pref.precoCusto, pref.precoCompra, pref.preco, pref.custo, pref.valor, pref.valorCusto]
                            .map(Number).filter(v => isFinite(v) && v > 0);
          if (!cand.length && arr.length) {
            for (const fx of arr) {
              const vs = Object.keys(fx || {}).filter(k => /pre(c|ç)o|custo|valor/i.test(k)).map(k => Number(fx[k])).filter(v => isFinite(v) && v > 0);
              if (vs.length) { cand = [Math.min.apply(null, vs)]; break; }
            }
          }
        }
        // KIT / produto COM COMPOSIÇÃO (27/07): o Bling não preenche o custo do kit em si —
        // ele mostra "Preço Total de Custo" somando os componentes. Fazemos o mesmo.
        if (!cand.length) {
          const comps = (prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens))
                     || prod.composicao || prod.componentes || null;
          if (Array.isArray(comps) && comps.length) {
            let soma = 0, completo = true;
            for (const cp of comps.slice(0, 30)) {
              const idc = (cp.produto && cp.produto.id) || cp.idProduto || cp.id || null;
              const qc = Number(cp.quantidade != null ? cp.quantidade : (cp.qtd != null ? cp.qtd : 1)) || 1;
              let cu = null;

              // 31/07 — ANTES: uma chamada ao Bling POR COMPONENTE, e se qualquer uma falhasse
              // (429, que hoje é constante) o kit INTEIRO era descartado. Um kit de 5 componentes
              // precisava de 5 chamadas seguidas dando certo. Agora tentamos duas fontes de graça
              // antes de gastar chamada:

              // 1) o próprio objeto do componente já costuma trazer o custo (a tela do Bling
              //    mostra "Preço custo" por componente, então o dado existe na estrutura)
              {
                const cs0 = [cp.precoCusto, cp.custo, cp.valorCusto,
                             (cp.produto && cp.produto.precoCusto), (cp.produto && cp.produto.custo)]
                            .map(Number).filter(v => isFinite(v) && v > 0);
                if (cs0.length) cu = cs0[0];
              }
              // 2) o nosso banco permanente — componente de kit quase sempre é um SKU que já
              //    sincronizamos (ex.: 10-lisa-125mm-80). Custo zero de chamada.
              if (cu == null) {
                const skuC = String((cp.produto && cp.produto.codigo) || cp.codigo || '').trim();
                if (skuC && cc[skuC] && cc[skuC].custo != null && Number(cc[skuC].custo) > 0) cu = Number(cc[skuC].custo);
              }
              // 3) só agora vale gastar uma chamada
              if (cu == null) {
                if (!idc) { completo = false; break; }
                const dc = await bg2(`/produtos/${idc}`);
                const pc = (dc.ok && dc.data && dc.data.data) || null;
                if (pc) {
                  const f2 = pc.fornecedor || {};
                  const cs = [f2.precoCusto, f2.precoCompra, pc.precoCusto, pc.custo].map(Number).filter(v => isFinite(v) && v > 0);
                  if (cs.length) cu = cs[0];
                }
                await dorme(420);
              }
              if (cu == null) {
                completo = false;
                console.log('[CUSTO] ' + sku + ': componente ' + String((cp.produto && cp.produto.codigo) || cp.codigo || idc) + ' sem custo \u2014 kit fica sem custo');
                break;
              }
              soma += cu * qc;
            }
            if (completo && soma > 0) { cand = [Math.round(soma * 10000) / 10000]; console.log('[CUSTO] ' + sku + ': custo somado da COMPOSIÇÃO = ' + cand[0]); }
          }
        }
        // a composição não fechou (componente sem custo): aí sim vale o que o fornecedor traz —
        // é aproximação, mas melhor que deixar o kit sem custo nenhum.
        if (!cand.length && _temComposicao) {
          cand = [forn.precoCusto, forn.precoCompra, forn.preco, forn.custo, prod.precoCusto, prod.custo, prod.precoCompra]
                 .map(Number).filter(v => isFinite(v) && v > 0);
          if (cand.length) console.log('[CUSTO] ' + sku + ': composição incompleta — usando campo do fornecedor (' + cand[0] + ') como reserva');
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
  // 01/08: o /historico-longo guarda o agregado por 30 min. Sem limpar aqui, o dashboard continuava
  // mostrando "sem custo" DEPOIS do sync terminar — o custo já estava resolvido, mas a tela servia
  // a foto antiga. Foi exatamente o que aconteceu no filtro Ano.
  try {
    const nk = Object.keys(_histCache).length;
    for (const k2 of Object.keys(_histCache)) delete _histCache[k2];
    if (nk) console.log('[CUSTO] cache do histórico limpo (' + nk + ') — o dashboard recalcula com os custos novos');
  } catch (e) {}
  _cst.rodando = false;
  console.log('[CUSTO] sync concluiu — ok=' + _cst.ok + ' falhas=' + _cst.falhas + ' de ' + _cst.total);
}

function bootstrap() {
  // PESCA AUTOMÁTICA PÓS-DEPLOY: todo deploy mata a pesca em andamento; aqui ela renasce sozinha
  // 90s depois do boot (após o ciclo inicial). Com dias=14 só re-checa os recentes — barato e idempotente.
  setTimeout(() => { try { console.log('[ML-FEES] pesca automática pós-deploy iniciando…'); mlSyncFees(14).catch(() => {}); } catch (e) {} }, 90 * 1000);
  setTimeout(() => { try { custoSync(false).catch(() => {}); } catch (e) {} }, 240 * 1000);   // custos: tartaruga pós-boot, só o que falta
  setInterval(() => { try { custoSync(false).catch(() => {}); } catch (e) {} }, 6 * 3600 * 1000);
// 01/08 — CANCELADOS TODO DIA. Diego: "pedido cancelado tem que atualizar sempre, os outros
// sistemas abatem". O ao-vivo (Hoje/7 dias) já marca em tempo real; o que faltava era o
// HISTÓRICO — pedido cancelado DEPOIS do backfill ficava lá somando pra sempre.
// Varre os últimos 45 dias, que cobre folgado a janela em que um cancelamento ainda aparece.
// Custa pouco: consulta o Bling FILTRANDO pela situação cancelada (poucas páginas), não varre tudo.
setTimeout(() => { varrerCancelados(45, 'amb').catch(() => {}); }, 15 * 60 * 1000);
setTimeout(() => { mlBillingSync(3).catch(() => {}); }, 25 * 60 * 1000);   // 01/08: faturamento ML, 1x/dia (a doc do ML pede cache e baixa frequência)
setInterval(() => { try { mlBillingSync(3).catch(() => {}); } catch (e) {} }, 24 * 3600 * 1000);
setInterval(() => { try { varrerCancelados(45, 'amb').catch(() => {}); } catch (e) {} }, 24 * 3600 * 1000);   // b20: o banco de custos se mantém completo SOZINHO (a cada 6h, só faltantes/vencidos)
  setTimeout(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 150 * 1000);
  setInterval(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 5 * 60 * 1000);   // vendas do Bling: análise quase em tempo real
  // ETIQUETA PARADA: enquanto existir pedido sem etiqueta, tenta de novo a cada 5 min (o cron normal é 10/10).
  // Em dia limpo (0 sem etiqueta) NADA extra roda — custo zero. Cobre etiqueta que o canal demora a gerar.
  setInterval(() => {
    try {
      const r = getUltimoResumo();
      if (r && r.semEtiqueta > 0) { console.log('[CICLO-EXTRA] ' + r.semEtiqueta + ' pedido(s) sem etiqueta \u2014 rodando ciclo extra'); rodarCiclo('auto-etiqueta').catch(() => {}); }
    } catch (e) {}
  }, 5 * 60 * 1000);

  ensureDir(CACHE_DIR);
  console.log(`[AMBBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
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
    return c.tarifa_ml == null || c.venda_em == null || !c.ml_costs_v3 || c.ml_order == null || t >= recheck;   // ml_order==null: ainda sem o par pack/order — uma passada preenche   // !ml_costs_v2 = ainda nao passou pelo /costs (frete real + estorno) — vale uma passada
  }).map(([cid]) => cid);
  if (!alvos.length) { console.log('[ML-FEES] nada a pescar (' + dias + 'd)'); return { ok: true, nada: true }; }
  _mls = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString(), erros: {}, amostras: [] };
  console.log('[ML-FEES] pescando tarifas de ' + alvos.length + ' pedido(s) ML...');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  let tokenML = null;
  try { const { garantirTokenML } = require('../ambtotal/mlTokenManager'); tokenML = await garantirTokenML(); }
  catch (e) { _mls.rodando = false; console.log('[ML-FEES] ✗ sem token ML: ' + e.message); return _mls; }
  const pend = {};
  const salvar = () => {
    if (!Object.keys(pend).length) return;
    const c2 = readJson(CONFERIDOS_FILE, {});
    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; if (d.credito != null) c2[cid].credito_ml = d.credito; if (d.credito_fonte) c2[cid].credito_fonte = d.credito_fonte; if (d.logistica) c2[cid].logistica_ml = d.logistica; if (d.pack) c2[cid].ml_pack = d.pack; if (d.order) c2[cid].ml_order = d.order; if (d.costs_ok) { c2[cid].ml_costs_v3 = 1; if (d.credito == null && c2[cid].credito_fonte !== 'billing' && c2[cid].credito_fonte !== 'costs_gross') delete c2[cid].credito_ml; /* Codex PR#40: /costs vazio não apaga crédito do billing */ if (d.frete == null) delete c2[cid].frete_ml; } }
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
        // PAR de números do ML: toda venda tem order_id; carrinho tem também pack_id (e a tela/NF do ML usam o pack).
        // Se o /orders respondeu direto, nl era a ORDER e o pack vem no payload; se caímos no /packs, nl era o PACK.
        const _ord0 = (ords[0] && ords[0].id != null) ? String(ords[0].id) : null;
        const _viaPack = !!(_ord0 && _ord0 !== nl);
        const _packId = _viaPack ? nl : ((ords[0] && ords[0].pack_id != null) ? String(ords[0].pack_id) : null);
        const reg = { fee: Math.round(fee * 100) / 100, frete: null, venda: venda, _orders: ords.length, pack: _packId, order: _ord0 };
        if (shipId) {
          let ehFlex = false, baseCost = null;
          try {
            const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H);
            const ds = await rs.json().catch(() => null);
            if (rs.ok && ds) {
              const logi = (ds.logistic && ds.logistic.type) || ds.logistic_type || null;
              if (logi) reg.logistica = logi;
              ehFlex = (logi === 'self_service');   // self_service = Mercado Envios FLEX (quem entrega e o vendedor)
              const bc = Number(ds.base_cost);
              if (isFinite(bc) && bc > 0) baseCost = bc;   // bonificacao que o ML paga pela entrega Flex
              const so = ds.shipping_option || {};
              const lc = Number(so.list_cost != null ? so.list_cost : ds.list_cost);
              const cc = Number(so.cost != null ? so.cost : ds.cost);
              // SO grava frete quando o vendedor realmente paga algo. Gravar 0 fazia o painel achar que
              // "0 e o valor real" e ignorar o custo configurado do FLEX (o motoboy) -> margem inflada.
              if (!ehFlex && isFinite(lc) && isFinite(cc) && lc > cc) reg.frete = Math.round((lc - cc) * 100) / 100;
            }
          } catch (e) {}
          await dorme(200);
          // /shipments/{id}/costs + base_cost = o ESTORNO exatamente como o ML mostra na tela da venda.
          //  - senders[0].cost .... frete que o ML COBRA do vendedor
          //  - base_cost .......... bonificacao que o ML PAGA pela entrega Flex
          //  - FLEX: o ML nao mostra as duas pontas, mostra o LIQUIDO (base_cost - cost). Conferido:
          //      116454 -> 11,00 - 0,00 = 11,00   |   116462 -> 11,00 - 9,90 = 1,10
          //    Por isso, no Flex, o frete cobrado NAO entra como custo separado (ja esta liquido aqui);
          //    o custo real do Flex e o motoboy, configurado no painel por canal.
          try {
            const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', H);
            const dc = await rc.json().catch(() => null);
            if (rc.ok && dc) {
              reg.costs_ok = true;
              const sd0 = Array.isArray(dc.senders) ? dc.senders[0] : null;
              const scost = Number(sd0 && sd0.cost);
              const scOk = isFinite(scost) && scost > 0;
              let cred = 0, fonte = null;
              if (sd0) {   // compensacoes explicitas (avaria, dimensao errada...) vem primeiro
                const c1 = Number(sd0.compensation);
                if (isFinite(c1) && c1 > 0) { cred += c1; fonte = 'compensation'; }
                for (const cx of (sd0.compensations || [])) { const c2 = Number(cx && cx.amount); if (isFinite(c2) && c2 > 0) { cred += c2; fonte = 'compensation'; } }
              }
              // 13/08 — MEDIDO com a rota ml-flex-debug (venda 2000014472881525, entregue):
              // compensation 0 · compensations [] · sender_cost 0 · base_cost 0 · gross_amount 8,90
              // = o "Estorno / Bonus por envio" da tela. Quando o ML nao manda base_cost, o bruto
              // do frete E a bonificacao do Flex (o vendedor nao pagou nada: sender_cost 0).
              if (cred === 0 && ehFlex && !scOk) {
                const ga = Number(dc.gross_amount);
                if (isFinite(ga) && ga > 0) { cred = Math.round(ga * 100) / 100; fonte = 'costs_gross'; }
              }
              if (cred === 0 && ehFlex && baseCost != null) {
                cred = Math.round((baseCost - (scOk ? scost : 0)) * 100) / 100;   // LIQUIDO, igual a tela do ML
                fonte = 'flex_liquido';
              }
              if (cred !== 0) { reg.credito = Math.round(cred * 100) / 100; reg.credito_fonte = fonte; }
              if (!ehFlex && scOk) reg.frete = Math.round(scost * 100) / 100;   // fora do Flex o frete e custo de verdade
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
  id: 'amb-checkout-offline',
  nome: 'AMBTotal Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14), shopeeKeepAlive: () => shopeeKeepAlive(), noturna: () => _noturna.rotinaNoturna('cron'), cacaMagalu: () => cacaMagaluCron() },
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '30 5,17 * * *', noturna: '45 3 * * *' , cacaMagalu: '35 * * * *'},
  bootstrap
};
