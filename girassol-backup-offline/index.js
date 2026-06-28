'use strict';

// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · BACKUP OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
//  girassol-backup-offline v28/06 b9   (a versão real é a const VERSAO abaixo)
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
const https = require('https');
const { garantirToken } = require('../good/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: GIRABKP_QZ_CERT (digital-certificate.txt) e GIRABKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.GIRABKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.GIRABKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

const VERSAO     = 'girassol-backup-offline v28/06 b9';

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
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');
const { enviarEmailDocs } = require('./email-docs');
const { listarAtendidos, detalhePedido, sincronizarConferidos, indexarCatalogoCompleto, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus } = require('./ciclo');

// ─── Config (env prefixo GIRABKP_, defaults sãos) ───────────────────────
// presença entre PCs: quem está separando cada pedido. Limpa reservas vencidas a cada leitura.
// operadores p/ login (env GIRABKP_OPERADORES = "Nome:senha,Nome:senha"). Vazio = login DESLIGADO.
// quem pode REABRIR/reverter pedido (env GIRABKP_ADMIN = "Diego" ou "Diego,Angelica"). Vazio = sem restrição (todo mundo pode).

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

// GET autenticado no Bling Girassol (token via tokenManager + retry 429)

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

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou
    if (method === 'POST' && p === '/girassol-backup-offline/salvar-localizacao') {
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
      console.log(`[GIRABKP] localização ${sku}: "${locAntiga}" → "${localizacao}" por ${op || '?'}`);
      json(res, 200, { ok: true, sku, localizacao, de: locAntiga });
      return true;
    }

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log
    if (method === 'GET' && p === '/girassol-backup-offline/localizacoes-log') {
      const log = readJson(LOC_LOG_FILE, []);
      json(res, 200, { ok: true, total: log.length, log: log.slice(-500).reverse() });
      return true;
    }

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)
    if (method === 'GET' && p === '/girassol-backup-offline/buscar-produto') {
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
    if (method === 'GET' && p === '/girassol-backup-offline/debug-produto') {
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
    if (method === 'GET' && p === '/girassol-backup-offline/indexar-catalogo') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin pode indexar' }); return true; }
      if (getIdxStatus().rodando) { json(res, 200, { ok: true, started: false, jaRodando: true, status: getIdxStatus() }); return true; }
      indexarCatalogoCompleto();                       // dispara em background (não aguarda)
      json(res, 200, { ok: true, started: true });
      return true;
    }
    if (method === 'GET' && p === '/girassol-backup-offline/indexar-status') {
      json(res, 200, { ok: true, status: getIdxStatus() });
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
      const rsv = lerReservas();
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
        .filter(i => man[i].tem_etiqueta && !conf[i])                          // SÓ ATENDIDO ainda NÃO finalizado
        .map(i => ({ id: i, ...man[i], reservado_por: (rsv[i] && rsv[i].user) || null, reservado_em: (rsv[i] && rsv[i].em) || null }))
        .sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));        // mais ANTIGOS (menor nº) em cima
      const semEtiq = ids
        .filter(i => !man[i].tem_etiqueta && !conf[i])                         // ATENDIDO mas SEM etiqueta = problema
        .map(i => ({ id: i, numero: man[i].numero, cliente: man[i].cliente || '', nf_numero: man[i].nf_numero || null, marketplace: man[i].marketplace || 'outro' }))
        .sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));
      const hoje = new Date().toISOString().slice(0, 10);
      const finalizadosHoje = Object.values(conf).filter(c => c && String(c.conferido_em || '').slice(0, 10) === hoje).length;
      json(res, 200, {
        versao: VERSAO,
        prontos: prontos.length,
        sem_etiqueta: semEtiq.length,
        sem_etiqueta_pedidos: semEtiq,
        finalizados_hoje: finalizadosHoje,
        pedidos: prontos
      });
      return true;
    }

    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos
    if (method === 'GET' && p === '/girassol-backup-offline/separacao') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacao(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }
    if (method === 'GET' && p === '/girassol-backup-offline/separacao-por-pedido') {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacaoPorPedido(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }

    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    if (method === 'GET' && p === '/girassol-backup-offline/historico') {
      const conf = readJson(CONFERIDOS_FILE, {});
      const itens = Object.keys(conf).map(id => ({ id, ...conf[id] }))
        .sort((a, b) => String(b.conferido_em || '').localeCompare(String(a.conferido_em || '')));
      json(res, 200, { ok: true, total: Object.keys(conf).length, itens });
      return true;
    }

    // DEBUG — mostra onde o Bling guarda a localização de um SKU (confirma o campo)
    // uso: /girassol-backup-offline/debug-loc/{SKU}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-loc/')) {
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
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/pedido/')) {
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
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/estoque-pedido/')) {
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

    // IMPRESSÃO A4: etiqueta + NF (DANFE) MESCLADAS num PDF só — evita o navegador bloquear a 2ª aba
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/imprimir/')) {
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
        if (snap && snap.nf && snap.nf.id) { nfBuf = await baixarDanfe(snap.nf.id); if (nfBuf) { try { fs.writeFileSync(path.join(dir, 'danfe.pdf'), nfBuf); } catch (e) {} } }
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
    if (method === 'GET' && p === '/girassol-backup-offline/operadores') {
      const nomes = Object.keys(lerOperadores());
      json(res, 200, { operadores: nomes, login_ativo: nomes.length > 0, admins: lerAdmins() });
      return true;
    }

    // LOGIN: valida nome + senha contra a env GIRABKP_OPERADORES
    if (method === 'POST' && p === '/girassol-backup-offline/login') {
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      const senha = String(body.senha || '').trim();
      const ops = lerOperadores();
      if (ops[nome] !== undefined && String(ops[nome]) === senha) {
        json(res, 200, { ok: true, nome });
      } else {
        json(res, 200, { ok: false, erro: 'nome ou senha inválidos' });
      }
      return true;
    }

    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)
    if (method === 'POST' && p === '/girassol-backup-offline/reservar') {
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
    if (method === 'POST' && p === '/girassol-backup-offline/liberar') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const r = lerReservas();
      if (r[id]) { delete r[id]; writeJson(RESERVAS_FILE, r); }
      json(res, 200, { ok: true });
      return true;
    }

    // REABRIR um pedido finalizado por engano: tira da fila de conferidos → volta pra lista.
    // Aceita o bling_id OU o número visível. Se já tinha ido pra VERIFICADO, devolve pra ATENDIDO no Bling.
    if ((method === 'GET' || method === 'POST') && p.startsWith('/girassol-backup-offline/reabrir/')) {
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
      console.log(`[GIRABKP] reaberto ${id} (era sync=${eraSync}, revertido p/ ATENDIDO=${revertido})`);
      json(res, 200, { ok: true, id, removido_da_fila: true, revertido_p_atendido: revertido });
      return true;
    }

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)
    if (method === 'POST' && p === '/girassol-backup-offline/conferido') {
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
        marketplace: snapC ? (snapC.marketplace || null) : null
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
          console.log(`[GIRABKP] conferido ${id} → ${SIT_VERIFICADO} (espelho na hora) OK`);
        } else {
          conf[id].sync_erro = String(r.status || 'err');
          blingOffline = true;
          console.log(`[GIRABKP] conferido ${id} ficou na fila (bling ${r.status}) — sincroniza depois`);
        }
        writeJson(CONFERIDOS_FILE, conf);
      }
      json(res, 200, { ok: true, id, sincronizado, bling_offline: blingOffline });
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
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
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
    if ((method === 'GET' || method === 'HEAD') && p === '/girassol-backup-offline/saude') {
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
      if (!SYNC_ON) avisos.push('GIRABKP_SYNC_ON desligado — finalizados não voltam pro Bling sozinhos');
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
    if (method === 'GET' && p === '/girassol-backup-offline/buscar-pedido') {
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
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/nf-danfe-live/')) {
      const id = p.split('/').filter(Boolean).pop();
      const nf = await nfDoPedido(id);
      const pdf = nf && nf.id ? await baixarDanfe(nf.id) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (pedido sem NF ou Bling não respondeu)', nf: nf || null });
      return true;
    }
    // baixa o DANFE (PDF) direto pelo ID da NOTA (pra resultados de busca por NF)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/danfe-nf/')) {
      const nfId = p.split('/').filter(Boolean).pop();
      const pdf = await baixarDanfe(nfId);
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-nf-${nfId}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (NF sem PDF ou Bling não respondeu)' });
      return true;
    }
    // baixa o XML da NOTA pelo ID
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/xml-nf/')) {
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
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/arq-info/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const etqPath = path.join(ARQUIVO_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
      json(res, 200, { id, arquivado: !!ped, tem_etiqueta: fs.existsSync(etqPath), numero: ped && ped.numero, cliente: ped && ped.cliente, nf: ped && ped.nf });
      return true;
    }
    // ARQUIVO: etiqueta arquivada → PDF (converte ZPL se preciso)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/arq-etiqueta-pdf/')) {
      const id = p.split('/').filter(Boolean).pop();
      let pdf = null;
      try { pdf = await etiquetaPdf(id, path.join(ARQUIVO_DIR, String(id))); } catch (e) {}
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="etiqueta-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'etiqueta não disponível (pedido finalizado antes desse recurso, ou ML postado)' });
      return true;
    }
    // ARQUIVO: DANFE de um pedido arquivado → gera na hora pelo nf.id guardado
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/arq-danfe/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const nfId = ped && ped.nf && ped.nf.id;
      const pdf = nfId ? await baixarDanfe(nfId) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (sem nf.id arquivado ou Bling fora)' });
      return true;
    }
    // ENVIAR pro estoque: etiqueta + DANFE por email (Parte B)
    if (method === 'POST' && p.startsWith('/girassol-backup-offline/enviar-docs/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op) { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
      if (!ehAdmin(op)) { json(res, 200, { ok: false, erro: 'apenas o admin pode enviar documentos', precisa_admin: true }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const r = await enviarEmailDocs(id, op);
      console.log(`[GIRABKP] enviar-docs ${id} → ${r.ok ? 'OK (' + r.anexos + ' anexos)' : 'FALHA: ' + r.erro}`);
      json(res, 200, r);
      return true;
    }
    // DEBUG: por que a NF do pedido não veio? mostra a resposta crua do link pedido→nota + campos do pedido
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-nfped/')) {
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
    if (method === 'GET' && p === '/girassol-backup-offline/backup') {
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
    if (method === 'GET' && p === '/girassol-backup-offline/restaurar') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { html(res, 200, '<meta charset=utf-8><p style="font-family:Arial;margin:40px">Acesso só pra admin. Use <b>?op=SEUNOME</b> no fim da URL.</p>'); return true; }
      const pg = '<!doctype html><meta charset=utf-8><title>Restaurar backup</title>' +
        '<style>body{font-family:Arial;max-width:720px;margin:40px auto;padding:0 16px;color:#111}textarea{width:100%;height:300px;font-family:monospace;font-size:12px;box-sizing:border-box}button{padding:10px 20px;font-size:15px;font-weight:700;background:#f59e0b;border:0;border-radius:8px;cursor:pointer;margin-top:12px}#r{margin-top:14px;font-weight:700}</style>' +
        '<h2>Restaurar backup — Checkout Offline</h2>' +
        '<p>Cola o conteúdo do arquivo de backup (JSON) e clica em Restaurar. <b style="color:#c00">Isso sobrescreve o estado atual.</b></p>' +
        '<textarea id=j placeholder="cola aqui o JSON do backup"></textarea>' +
        '<button onclick="rest()">Restaurar</button><div id=r></div>' +
        '<script>async function rest(){var el=document.getElementById("r");var o;try{o=JSON.parse(document.getElementById("j").value)}catch(e){el.textContent="JSON inválido: "+e.message;return}o.op=' + JSON.stringify(op) + ';try{var x=await fetch("/girassol-backup-offline/restaurar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});x=await x.json();el.textContent=x.ok?("\\u2713 Restaurado: "+x.restaurados.join(", ")):("Falhou: "+(x.erro||"erro"))}catch(e){el.textContent="Erro: "+e.message}}<\/script>';
      html(res, 200, pg);
      return true;
    }
    // RESTAURAR (ação): grava de volta só o que veio no corpo. Só admin.
    if (method === 'POST' && p === '/girassol-backup-offline/restaurar') {
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
    // uso: /girassol-backup-offline/debug-produto/{SKU}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-produto/')) {
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
    // uso: /girassol-backup-offline/debug-estrutura/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-estrutura/')) {
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
    if (method === 'GET' && p === '/girassol-backup-offline/debug-nf') {
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
    // uso: /girassol-backup-offline/debug-nf-simp/{idDoPedido}        → abre o PDF
    //      /girassol-backup-offline/debug-nf-simp/{idDoPedido}?json=1 → mostra os dados extraídos
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-nf-simp/')) {
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
    // uso: /girassol-backup-offline/danfe-simp/{idOuNumero}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/danfe-simp/')) {
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
    // uso: /girassol-backup-offline/etiqueta-madeira-zpl/{idOuNumero}   (?nodanfe=1 → só etiqueta+adesivo)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/etiqueta-madeira-zpl/')) {
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
    // uso: /girassol-backup-offline/etiqueta-fundida/{idOuNumero}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/etiqueta-fundida/')) {
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
    // uso: /girassol-backup-offline/debug-danfe/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-danfe/')) {
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
    // uso: /girassol-backup-offline/debug-etiqueta-fmt/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-etiqueta-fmt/')) {
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
