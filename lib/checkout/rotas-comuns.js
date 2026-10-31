'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS COMUNS DO CHECKOUT — PEÇA ÚNICA (31/10/2026). As rotas que as TRÊS empresas tinham escritas IGUAIS no arquivo
   delas (Fase 3 item 4 do docs/plano-multiloja-passos.md — remedido em 31/10: 49 rotas nas três, 30 idênticas). Passo 1:
   as 30 (as 4 últimas no passo 2, depois de conferida a ordem de quem responde com a fábrica do painel).
   Arquivos (DANFE, etiqueta, XML, impressão, arquivados), sessão (login, operadores, certificado do QZ), reenvio de documentos,
   faturamento do ML, cookies da Shopee, separação. O mesmo código; da empresa só o prefixo, o nome no log e as peças dela.
   criarRotasComuns({ prefixo, tag, empresa, ...peças da empresa }) → { handle(req, res, p, method, urlObj) }
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PECAS = ["ARQUIVO_DIR", "CACHE_DIR", "CONFERIDOS_FILE", "ETIQ_FORMATO", "MLB_FILE", "QZ_CERT", "QZ_PRIVKEY", "SESS_COOKIE", "SESS_TTL", "SHOPEE_ENV_COOKIE", "SHOPEE_SESSAO_FILE", "_diaAntes", "_hojeISO", "_shopeeHash", "assinarSessao", "baixarDanfe", "baixarXmlNF", "blingGet", "custoVigenteEm", "dadosNFSimp", "ehAdmin", "ensureDir", "enviarEmailDocs", "estadoImposto", "etiquetaPdf", "fundirEtiquetaComDanfe", "gerarDanfeSimplificado", "gerarDanfeSimplificadoZPL", "getUltimoResumo", "gravarVigencias", "json", "lerAdmins", "lerChaveAdmin", "lerCustosManuais", "lerOperadores", "lerVigencias", "locCache", "manifest", "montarSeparacao", "nfDoPedido", "readBody", "readJson", "registrarCustoVigente", "resolverNomeSku", "rodarCiclo", "shopeeKeepAlive", "souAdmin", "validarSessao", "writeJson", "zplParaPdf"];

function criarRotasComuns(o) {
  const falta = ['prefixo', 'tag', 'empresa'].concat(PECAS).filter((k) => o == null || typeof o[k] === 'undefined');
  if (falta.length) throw new Error('lib/checkout/rotas-comuns: falta peça da empresa: ' + falta.join(', '));
  const PREFIXO = o.prefixo, TAG = o.tag, EMPRESA = o.empresa;
  const { ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, MLB_FILE, QZ_CERT, QZ_PRIVKEY, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, _diaAntes, _hojeISO, _shopeeHash, assinarSessao, baixarDanfe, baixarXmlNF, blingGet, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, estadoImposto, etiquetaPdf, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, gravarVigencias, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerVigencias, locCache, manifest, montarSeparacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, shopeeKeepAlive, souAdmin, validarSessao, writeJson, zplParaPdf } = o;

  async function handle(req, res, p, method, urlObj) {
    if (method === 'GET' && p === PREFIXO + '/nf-travadas') {
      try {
        const trav = require('../nf-travadas');
        const kT = lerChaveAdmin(req, urlObj);
        const resolver = urlObj.searchParams.get('resolver');
        if (resolver) {
          if (!(process.env.ADMIN_KEY && kT === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
          const ok = trav.resolver(CACHE_DIR, resolver);
          json(res, 200, { ok, msg: ok ? ('NF ' + resolver + ' saiu da lista') : ('NF ' + resolver + ' nao estava na lista') });
          return true;
        }
        const l = trav.lista(CACHE_DIR);
        json(res, 200, { ok: true, total: l.length, travadas: l,
          leia: 'estas NFs o ML recusou por erro permanente e a rotina parou de tentar. Resolva no Bling (cancelar, corrigir, reemitir, subir o XML) e chame ?resolver=<id>&k= pra tirar da lista.' });
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) }); }
      return true;
    }

    if (method === 'GET' && p === PREFIXO + '/duplicatas') {
      const kD = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const de = urlObj.searchParams.get('de') || '', ate = urlObj.searchParams.get('ate') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        json(res, 400, { ok: false, erro: 'use ?de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
      }
      try {
        const dupLib = require('../bling-duplicatas');
        const r = await dupLib.procurar(blingGet, de, ate, { paginas: urlObj.searchParams.get('paginas') });
        json(res, 200, Object.assign({ ok: !r.erro }, r));
      } catch (e) {
        json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) });
      }
      return true;
    }

    if (method === 'POST' && p === PREFIXO + '/shopee-sessao-cookies') {
      const kC = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      let corpo = '';
      await new Promise(r => { req.on('data', c => { corpo += c; if (corpo.length > 262144) req.destroy(); }); req.on('end', r); req.on('error', r); });
      let b = {};
      try { b = JSON.parse(corpo || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'JSON inválido' }); return true; }
      const ck = String(b.cookie || '').replace(/[\r\n]+/g, ' ').trim();
      if (ck.length < 40 || ck.indexOf('=') < 0) { json(res, 400, { ok: false, erro: 'cookie ausente ou curto demais — capture com a extensão logado no Seller Center' }); return true; }
      const envS = String(process.env[SHOPEE_ENV_COOKIE] || '').trim();
      const novoS = { cookie: ck, semente: envS ? _shopeeHash(envS) : '', origem: 'extensao', atualizado: new Date().toISOString(), renovacoes: 0 };
      try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novoS); } catch (e) { json(res, 500, { ok: false, erro: 'não consegui gravar: ' + String(e.message || e) }); return true; }
      let testeS = null;
      try { testeS = await shopeeKeepAlive(); } catch (e) { testeS = { ok: false, motivo: String(e.message || e) }; }
      json(res, 200, { ok: true, gravado: true, tamanho: ck.length, viva: !!(testeS && testeS.ok), teste: testeS });
      return true;
    }

    if (method === 'GET' && p === PREFIXO + '/ml-fatura-cartao') {
      const kF = lerChaveAdmin(req, urlObj);
      const sF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kF === process.env.ADMIN_KEY) || (sF && ehAdmin(sF)))) { json(res, 404, { error: 'not found' }); return true; }
      try {
        const lib = require('../ml-fatura-cartao');
        const b = readJson(MLB_FILE(), { tarifas: {} });
        const ref = urlObj.searchParams.get('ref') || null;
        /* Codex #322 r4: a lib recebe o `atualizado` do cache — é ele que decide se o dado é
           atual, não uma dedução por dentro */
        const r = lib.faturas(b.tarifas, Object.assign({ atualizado: b.atualizado || null }, ref ? { referencia: ref } : { limite: 6 }));
        json(res, 200, Object.assign({ ok: true, atualizado: b.atualizado || null,
          leia: 'a fatura do ML fecha dia 12 e é debitada dia 18; o card mostra o CICLO, não o mês do calendário. sem_marca = tarifas antigas sem o campo debited_from_operation: re-sincronize pra completar' }, r));
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) }); }
      return true;
    }

    if (method === 'GET' && p === PREFIXO + '/ml-billing-resumo') {
      // Codex PR#38 (P1): financeiro é SÓ ADMIN — mesma guarda das rotas irmãs do dashboard
      const sBil = validarSessao(req.headers['cookie']);
      const kBil = lerChaveAdmin(req, urlObj);
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

    // ─── QZ Tray: assinatura (mata o popup "Untrusted") ───
    // serve o certificado público p/ o QZ confiar
    if (method === 'GET' && p === PREFIXO + '/qz-cert') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(QZ_CERT || '');
      return true;
    }

    // assina a requisição do QZ com a chave privada (RSA-SHA512)
    if (method === 'GET' && p === PREFIXO + '/qz-sign') {
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

    // detalhe do pedido cacheado (itens + EAN + NF)
    if (method === 'GET' && p.startsWith(PREFIXO + '/pedido/')) {
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
    if (method === 'GET' && p.startsWith(PREFIXO + '/estoque-pedido/')) {
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
    if (method === 'GET' && p.startsWith(PREFIXO + '/etiqueta/')) {
      const id = p.split('/').filter(Boolean).pop();
      try {
        const zpl = fs.readFileSync(path.join(CACHE_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(zpl);
      } catch (e) { json(res, 404, { erro: 'etiqueta não cacheada' }); }
      return true;
    }

    // serve o DANFE (PDF) — usa o cache; se faltar, gera na hora pelo Bling
    if (method === 'GET' && p.startsWith(PREFIXO + '/danfe/')) {
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
    if (method === 'GET' && p.startsWith(PREFIXO + '/etiqueta-pdf/')) {
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
    if (method === 'GET' && p.startsWith(PREFIXO + '/imprimir/')) {
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
    if (method === 'GET' && p === PREFIXO + '/operadores') {
      const nomes = Object.keys(lerOperadores());
      json(res, 200, { operadores: nomes, login_ativo: nomes.length > 0, admins: lerAdmins() });
      return true;
    }

    // LOGIN: valida nome + senha contra a env AMBBKP_OPERADORES
    if (method === 'POST' && p === PREFIXO + '/login') {
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      const senha = String(body.senha || '').trim();
      const ops = lerOperadores();
      if (ops[nome] !== undefined && String(ops[nome]) === senha) {
        res.setHeader('Set-Cookie', SESS_COOKIE + '=' + assinarSessao(nome) + '; Path=' + PREFIXO + '; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESS_TTL/1000));
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

    // baixa o DANFE (PDF) de QUALQUER pedido ao vivo (acha a NF na hora) — não precisa estar no cache
    if (method === 'GET' && p.startsWith(PREFIXO + '/nf-danfe-live/')) {
      const id = p.split('/').filter(Boolean).pop();
      const nf = await nfDoPedido(id);
      const pdf = nf && nf.id ? await baixarDanfe(nf.id) : null;
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (pedido sem NF ou Bling não respondeu)', nf: nf || null });
      return true;
    }

    // baixa o DANFE (PDF) direto pelo ID da NOTA (pra resultados de busca por NF)
    if (method === 'GET' && p.startsWith(PREFIXO + '/danfe-nf/')) {
      const nfId = p.split('/').filter(Boolean).pop();
      const pdf = await baixarDanfe(nfId);
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-nf-${nfId}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'DANFE indisponível (NF sem PDF ou Bling não respondeu)' });
      return true;
    }

    // baixa o XML da NOTA pelo ID
    if (method === 'GET' && p.startsWith(PREFIXO + '/xml-nf/')) {
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
    if (method === 'GET' && p.startsWith(PREFIXO + '/arq-info/')) {
      const id = p.split('/').filter(Boolean).pop();
      const ped = readJson(path.join(ARQUIVO_DIR, String(id), 'pedido.json'), null);
      const etqPath = path.join(ARQUIVO_DIR, String(id), `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
      json(res, 200, { id, arquivado: !!ped, tem_etiqueta: fs.existsSync(etqPath), numero: ped && ped.numero, cliente: ped && ped.cliente, nf: ped && ped.nf });
      return true;
    }

    // ARQUIVO: etiqueta arquivada → PDF (converte ZPL se preciso)
    if (method === 'GET' && p.startsWith(PREFIXO + '/arq-etiqueta-pdf/')) {
      const id = p.split('/').filter(Boolean).pop();
      let pdf = null;
      try { pdf = await etiquetaPdf(id, path.join(ARQUIVO_DIR, String(id))); } catch (e) {}
      if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="etiqueta-${id}.pdf"` }); res.end(pdf); }
      else json(res, 404, { ok: false, erro: 'etiqueta não disponível (pedido finalizado antes desse recurso, ou ML postado)' });
      return true;
    }

    // ARQUIVO: DANFE de um pedido arquivado → gera na hora pelo nf.id guardado
    if (method === 'GET' && p.startsWith(PREFIXO + '/arq-danfe/')) {
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
    if (method === 'POST' && p.startsWith(PREFIXO + '/pedir-reenvio/')) {
      let op = '';
      try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {}
      if (!op) { json(res, 200, { ok: false, erro: 'identifique o operador (faça login no painel)' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const confR = readJson(CONFERIDOS_FILE, {});
      const c = confR[id] || {};
      const direto = String(process.env.CHECKOUT_REENVIO_DIRETO_EMPRESAS || '').toLowerCase().split(',').map(s => s.trim()).includes(EMPRESA);   /* a chave DA EMPRESA (girassol, amb, good) */
      if (direto) {
        const r = await enviarEmailDocs(id, op);
        if (r.ok && confR[id]) {   // flag visível no histórico: quem reenviou e quando
          confR[id].reenvios = (confR[id].reenvios || 0) + 1;
          confR[id].ultimo_reenvio = { por: op, em: new Date().toISOString() };
          writeJson(CONFERIDOS_FILE, confR);
        }
        console.log(`[${TAG}] 📨 reenvio DIRETO pedido ${c.numero || id} por ${op} → ${r.ok ? 'enviado' : 'FALHA: ' + r.erro}`);
        json(res, 200, { ...r, direto: true });
        return true;
      }
      const REENVIOS_FILE = CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json');
      const ree = readJson(REENVIOS_FILE, {});
      ree[id] = { numero: c.numero || null, cliente: c.cliente || '', por: op, em: new Date().toISOString() };
      writeJson(REENVIOS_FILE, ree);
      console.log(`[${TAG}] 📨 REENVIO SOLICITADO — pedido ${c.numero || id} por ${op} (admin envia pelo Histórico)`);
      json(res, 200, { ok: true, solicitado: true });
      return true;
    }

    // admin resolve a solicitação: {enviar:true} manda o e-mail e baixa; {enviar:false} só descarta
    if (method === 'POST' && p.startsWith(PREFIXO + '/reenvio-resolver/')) {
      let op = '', enviar = false;
      try { const b = await readBody(req); op = String(b.op || ''); enviar = !!b.enviar; } catch (e) {}
        const _quem = String(req._op || '');   /* identidade AUTENTICADA, não o `op` da URL (achado A) */
        if (!souAdmin(req, ehAdmin, validarSessao)) { json(res, 200, { ok: false, erro: 'apenas o admin' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const REENVIOS_FILE = CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json');
      let r = { ok: true, enviado: false };
      if (enviar) { const e = await enviarEmailDocs(id, op); r = { ...e, enviado: !!e.ok }; if (!e.ok) { json(res, 200, r); return true; } }
      if (enviar) { const cE = readJson(CONFERIDOS_FILE, {}); if (cE[id]) { cE[id].reenvios = (cE[id].reenvios || 0) + 1; cE[id].ultimo_reenvio = { por: op, em: new Date().toISOString() }; writeJson(CONFERIDOS_FILE, cE); } }
      const ree = readJson(REENVIOS_FILE, {});
      delete ree[id]; writeJson(REENVIOS_FILE, ree);
      console.log(`[${TAG}] 📨 reenvio ${id} ${enviar ? 'ENVIADO' : 'descartado'} por ${op}`);
      json(res, 200, r);
      return true;
    }

    if (method === 'POST' && p.startsWith(PREFIXO + '/enviar-docs/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op) { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
        const _quem = String(req._op || '');   /* identidade AUTENTICADA, não o `op` da URL (achado A) */
        if (!souAdmin(req, ehAdmin, validarSessao)) { json(res, 200, { ok: false, erro: 'apenas o admin pode enviar documentos' }); return true; }
      const id = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const r = await enviarEmailDocs(id, op);
      if (r.ok) { const cD = readJson(CONFERIDOS_FILE, {}); if (cD[id]) { cD[id].reenvios = (cD[id].reenvios || 0) + 1; cD[id].ultimo_reenvio = { por: op, em: new Date().toISOString() }; writeJson(CONFERIDOS_FILE, cD); } }
      console.log(`[${TAG}] enviar-docs ${id} (por ${op}) → ${r.ok ? 'OK (' + r.anexos + ' anexos)' : 'FALHA: ' + r.erro}`);
      json(res, 200, r);
      return true;
    }

    // PRODUÇÃO: gera/serve o DANFE SIMPLIFICADO (10x15) p/ imprimir na Zebra.
    //   cache-first (nf-simp.json gravado pelo cron → funciona OFFLINE);
    //   se não tiver no cache, busca ao vivo e cacheia.
    // uso: /amb-checkout-offline/danfe-simp/{idOuNumero}
    if (method === 'GET' && p.startsWith(PREFIXO + '/danfe-simp/')) {
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

    // ETIQUETA de postagem + tira da DANFE numa etiqueta só (ML / Amazon / Magalu / TikTok)
    // Shopee NÃO usa — já vem fundida nativa pela própria API.
    // ?info=1 → mostra os números da fusão (fator, se cabe) SEM imprimir, p/ diagnóstico.
    // ?pdf=1  → devolve um PDF da etiqueta fundida (imprime em qualquer impressora; testar à distância).
    // uso: /amb-checkout-offline/etiqueta-fundida/{idOuNumero}
    if (method === 'GET' && p.startsWith(PREFIXO + '/etiqueta-fundida/')) {
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
    /* 31/10 (passo 2 das rotas comuns): as 4 que tinham ficado de fora — a raiz, o histórico de custo, o andamento da
       reaplicação do imposto e o custo das devoluções do TikTok. Conferido antes: a fábrica do painel não atende a raiz nem
       o /reaplicar-status, e o /custo-historico e o /tiktok-custo-devolucoes estão na lista de rotas PRÓPRIAS das três (a
       fábrica pula) — quem respondia era a cópia de cada empresa, e é a mesma coisa que responde agora */
    // raiz do módulo → manda pro painel (evita "not found" ao abrir a URL base)
    if (method === 'GET' && (p === PREFIXO || p === PREFIXO + '/')) {
      res.writeHead(302, { Location: PREFIXO + '/painel' });
      res.end();
      return true;
    }

    if (p === PREFIXO + '/custo-historico') {
      const kH = lerChaveAdmin(req, urlObj);
      const sH = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kH === process.env.ADMIN_KEY) || (sH && ehAdmin(sH)))) { json(res, 404, { error: 'not found' }); return true; }

      if (method === 'GET') {
        const sku = resolverNomeSku(String(urlObj.searchParams.get('sku') || '').trim());
        if (!sku) { json(res, 400, { ok: false, erro: 'informe ?sku=' }); return true; }
        const cc = readJson(path.join(CACHE_DIR, '_custos.json'), {}) || {};
        /* Codex (P2, r2): com histórico em "pm1" e Bling em "PM1", a busca exata devolvia null e o
           card dizia que o produto NÃO tem custo no Bling — sugerindo cadastrar algo que já existe.
           A grafia do histórico manda pra achar o histórico; pra achar o CUSTO, vale qualquer caixa. */
        const _alvoCC = String(sku).toUpperCase();
        const _kCC = cc[sku] ? sku : Object.keys(cc).find(k => String(k).toUpperCase() === _alvoCC);
        const doBling = (_kCC && Number(cc[_kCC].custo) > 0) ? Number(cc[_kCC].custo) : null;
        /* 21/08 (Diego testou o PM1 e viu "sem histórico ainda" num produto que TEM custo):
           eu só anotava quando o sync detectava MUDANÇA, então todo SKU que já estava no
           _custos.json antes da vigência existir ficava com a linha do tempo vazia. Agora, na
           primeira consulta, o custo que o Bling tem hoje abre a primeira faixa — a partir de
           HOJE, porque não dá pra saber desde quando ele vale (o Bling não guarda isso). */
        if (doBling != null && !(lerVigencias()[sku] || []).length) {
          try { registrarCustoVigente(sku, doBling, 'bling'); } catch (e) {}
        }
        const faixas = (lerVigencias()[sku] || []).slice().sort((a, b) => String(a.de).localeCompare(String(b.de)));
        const man = lerCustosManuais()[sku.toUpperCase()];
        json(res, 200, { ok: true, sku, faixas,
          custo_atual_bling: doBling,
          custo_manual: man && Number(man.custo) > 0 ? Number(man.custo) : null,
          vigente_hoje: custoVigenteEm(sku, _hojeISO()),
          leia: faixas.length ? null : (doBling == null
            ? 'este SKU não tem custo no Bling — cadastre lá e rode o custo-sync, ou lance um custo manual aqui'
            : 'sem histórico ainda') });
        return true;
      }

      if (method === 'POST') {
        let corpo = '';
        await new Promise(r => { req.on('data', c => { corpo += c; if (corpo.length > 1e6) req.destroy(); }); req.on('end', r); req.on('error', r); });
        let b = {};
        try { b = JSON.parse(corpo || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'JSON inválido' }); return true; }
        const sku = resolverNomeSku(String(b.sku || '').trim());
        if (!sku) { json(res, 400, { ok: false, erro: 'informe o sku' }); return true; }
        const todas = lerVigencias();
        let lista = Array.isArray(todas[sku]) ? todas[sku] : [];

        if (b.apagar) {
          const de = String(b.apagar).slice(0, 10);
          const antes = lista.length;
          lista = lista.filter(f => String(f.de) !== de);
          /* ao remover uma faixa, a anterior volta a valer até onde a removida ia — senão fica
             um buraco na linha do tempo e a venda daquele período não acha custo nenhum. */
          lista.sort((a, b2) => String(a.de).localeCompare(String(b2.de)));
          for (let i = 0; i < lista.length; i++) lista[i].ate = (i === lista.length - 1) ? null : _diaAntes(lista[i + 1].de);
          todas[sku] = lista; gravarVigencias(todas);
          json(res, 200, { ok: true, removidas: antes - lista.length, faixas: lista });
          return true;
        }

        const custo = Number(String(b.custo == null ? '' : b.custo).toString().replace(/[R$\s]/gi, '').replace(',', '.'));
        const de = /^\d{4}-\d{2}-\d{2}$/.test(String(b.de || '')) ? String(b.de) : _hojeISO();
        if (!isFinite(custo) || custo <= 0) { json(res, 400, { ok: false, erro: 'custo inválido' }); return true; }
        /* Lançar no MEIO da linha do tempo: entra na ordem e as vizinhas se ajustam sozinhas —
           é o caso de "descobri que desde 01/07 o custo era outro". */
        lista = lista.filter(f => String(f.de) !== de);
        lista.push({ custo: Math.round(custo * 10000) / 10000, de, ate: null, origem: 'manual', em: new Date().toISOString() });
        lista.sort((a, b2) => String(a.de).localeCompare(String(b2.de)));
        for (let i = 0; i < lista.length; i++) lista[i].ate = (i === lista.length - 1) ? null : _diaAntes(lista[i + 1].de);
        todas[sku] = lista; gravarVigencias(todas);
        json(res, 200, { ok: true, faixas: lista, vigente_hoje: custoVigenteEm(sku, _hojeISO()) });
        return true;
      }
    }

    if (method === 'GET' && p === PREFIXO + '/reaplicar-status') {
      json(res, 200, { ok: true, status: estadoImposto() }); return true;
    }

    if (method === 'GET' && p === PREFIXO + '/tiktok-custo-devolucoes') {
      const kT = lerChaveAdmin(req, urlObj);
      const sT = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kT === process.env.ADMIN_KEY) || (sT && ehAdmin(sT)))) { json(res, 404, { error: 'not found' }); return true; }
      /* 30/08 (Codex #291): a montagem inteira vive em lib/tiktok-custo-devolucoes.js —
         a review achou 5 defeitos que existiam nas DUAS cópias desta rota, então ela deixou
         de ser código de módulo. Aqui fica só o guard e a loja. */
      try {
        const { responderCusto } = require('../tiktok-custo-devolucoes');
        const r = responderCusto({ loja: EMPRESA, de: urlObj.searchParams.get('de'), ate: urlObj.searchParams.get('ate') });
        json(res, r.http, r.corpo);
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 160), custo_total: null });
      }
      return true;
    }
    return false;
  }

  return { handle };
}

module.exports = { criarRotasComuns, PECAS };
