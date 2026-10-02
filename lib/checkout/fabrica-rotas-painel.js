/* ════════════════════════════════════════════════════════════════════════════
   FÁBRICA DE ROTAS DO PAINEL — código ÚNICO, empresa como PARÂMETRO (02/10).

   O dono: "tem q ser multiempresa, pra outro CNPJ ser ligado mais facilmente"; e, olhando o
   painel da GOOD ao lado do da Girassol: "falta botões, cards, um monte de coisa".

   Medido: a GOOD tem 985 linhas de dashboard contra 4.254 da AMB, e 18 rotas do backend não
   existem nela. Mas o achado que decidiu o desenho é outro — essas rotas são IDÊNTICAS entre
   AMB e Girassol: `/completar-detalhes` e `/config-frete-magalu` não diferem em UMA LINHA.
   É o mesmo código escrito duas vezes, que viraria três ao portar e quatro no próximo CNPJ.

   Por isso NÃO copiei o painel da AMB pra GOOD. Esta é a continuação da Fase 2 do
   `docs/plano-multiloja-passos.md`, que fez o mesmo com o módulo fiscal e tirou as pastas de
   ~2.200 para 197 linhas.

   ⚠️ A PRIMEIRA TENTATIVA FALHOU e vale registrar: as rotas carregam 13 dependências do
   arquivo da empresa, e duas eram ESTADO VIVO (`_cst`, `_vsy`). O eslint acusou 37 no-undef e
   eu desfiz. O estado saiu primeiro (lib/checkout/estado-rotinas.js, #556) — é o que tornou
   esta fábrica possível.

   Tudo que é da empresa ENTRA POR INJEÇÃO. Nada de `require` relativo aqui: este arquivo mora
   em lib/ e a peça mora na pasta da empresa — foi esse erro que deixou quatro rotas de debug
   quebradas nas três (#544).
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function criarRotasPainel(cfg) {
  for (const nome of ['empresa', 'prefixo', 'pecas']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/checkout/fabrica-rotas-painel: falta ' + nome);
  }
  const EMPRESA = cfg.empresa;
  const PREFIXO = cfg.prefixo;

  /* obrigatórias: peça faltando derruba no BOOT, não na primeira chamada em produção — a
     lição do `pecas: {}` que passou batido na fábrica fiscal */
  /* 02/10 — O CODEX ESTAVA CERTO E EU ERRADO, e vale registrar porque quase afrouxei a trava.
     Eu tinha encolhido esta lista pra GOOD conseguir montar — ela não tem `vendasSync`,
     `_cstDiario` e companhia. Mas a regra do #568 é melhor: TODA peça que uma rota
     desreferencia SEM GUARDA é obrigatória, senão o estouro só muda de lugar (do boot pra
     primeira chamada, em produção).
     O conserto certo não é afrouxar a lista: é a ROTA conferir antes de usar. As que dependem
     de peça que nem toda empresa tem já fazem isso (`semPeca`), e as duas que faltavam
     (`/magalu-cancelados` e `/tiktok-custo-devolucoes`, que usavam `ehAdmin` solto) passaram a
     fazer. Assim a GOOD monta, e ninguém estoura. */
  for (const p of ['json', 'lerChaveAdmin', 'validarSessao', 'readJson', 'writeJson',
                   'CACHE_DIR', 'fsx', 'pathx',
                   /* Codex #569: usadas direto em rotas SEM guarda (estadoRotinas na própria
                      construção) e que a GOOD já injeta — obrigatórias, não opcionais */
                   'estadoRotinas', 'ehAdmin', 'readBody', 'travaPesada', 'custoSyncTravado',
                   '_urlStatus', 'LOJA_MKT', 'CONFERIDOS_FILE']) {
    if (cfg.pecas[p] == null) throw new Error('lib/checkout/fabrica-rotas-painel (' + EMPRESA + '): falta a peça ' + p);
  }
  const { json, lerChaveAdmin, validarSessao, readJson, writeJson,
          CACHE_DIR, fsx, pathx, blingGet, vendasSync, responderCusto, readBody, ehAdmin,
          travaPesada, estadoRotinas,
          /* 02/10 — as últimas 6 que o eslint acusou depois que o estado saiu (#556). São do
             arquivo da empresa: caminho do conferidos, loja do marketplace, o inferidor de
             canal, o leitor do dia fechado e o estado do custo diário. Todas INJETADAS, nunca
             por require relativo — o erro que deixou 4 rotas de debug quebradas (#544). */
          custoSyncTravado, _urlStatus, _inferCanal, _diaFechadoDoDisco, _cstDiario,
          LOJA_MKT, CONFERIDOS_FILE } = cfg.pecas;
  const path = pathx;   /* o corpo extraído usa `path`; aqui ele chega como `pathx` */
  const DIR = CACHE_DIR;
  const _cst = estadoRotinas.custo;
  const _vsy = estadoRotinas.vendas;
  if (!_cst || !_vsy) throw new Error('lib/checkout/fabrica-rotas-painel (' + EMPRESA + '): estadoRotinas precisa de custo e vendas');
  /* seller do Magalu: injetável; senão o lookup configurável do repo (<EMPRESA>_MAGALU_SELLER),
     nunca um mapa fixo de empresas aqui dentro */
  const sellerEsperado = String(cfg.pecas.sellerMagalu || require('../empresas').sellerMagalu(EMPRESA)).toLowerCase();

  /* opcionais: a GOOD ainda não expõe `vendasSync`/`blingGet` aqui. Em vez de fingir que toda
     empresa tem tudo, a rota recusa EXPLICANDO — assim ela ganha hoje o que dá, e o resto
     entra quando a peça existir, sem mudar nada aqui. É o critério de união do plano:
     capacidade que existe numa empresa é portada, nunca fingida. */
  const PROPRIAS = new Set(cfg.rotasProprias || []);
  const semPeca = (res, peca) => { json(res, 200, { ok: false, empresa: EMPRESA,
    erro: 'esta empresa ainda não expõe `' + peca + '` ao painel' }); return true; };

  return async function rotasPainel(req, res, p, method, urlObj) {
    /* ─── /completar-detalhes ───────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/completar-detalhes')) {
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      if (typeof blingGet !== 'function') return semPeca(res, 'blingGet');
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
            if (!v.marketplace || v.marketplace === 'outro') { const lj3 = String((det.loja && det.loja.id) || ''); v.marketplace = LOJA_MKT[lj3] || (typeof _inferCanal === 'function' ? _inferCanal(v.numero_loja) : (v.marketplace || 'outro')); }
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

    /* ─── /magalu-cancelados ────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/magalu-cancelados')) {
      if (typeof ehAdmin !== 'function') return semPeca(res, 'ehAdmin');
      const kM = lerChaveAdmin(req, urlObj);
      const sM = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kM === process.env.ADMIN_KEY) || (sM && ehAdmin(sM)))) { json(res, 404, { error: 'not found' }); return true; }
      try {
        const cancLib = require('../magalu-cancelados');
        const DIR = process.env.MAGALU_DATA_DIR || '/data/magalu';
        let g = null;
        try { g = JSON.parse(fsx.readFileSync(pathx.join(DIR, 'cancelados-' + EMPRESA + '.json'), 'utf8')); } catch (e) { g = null; }
        /* Codex #304: cache criado por uma coleta que FALHOU tem pedidos {} e ok_em null —
           objeto vazio é truthy e isso passaria como "zero cancelamentos", que é a conclusão
           errada. Sem coleta bem-sucedida, não há número. */
        if (!g || !g.pedidos || !g.ok_em) { json(res, 200, { ok: false, indisponivel: g && !g.ok_em ? 'a coleta de cancelados do Magalu nunca terminou com sucesso' : 'sem coleta de cancelados do Magalu', valor_a_descontar: null }); return true; }
        const de = urlObj.searchParams.get('de') || null, ate = urlObj.searchParams.get('ate') || null;
        /* Codex #304: o token do Magalu alcança pedidos de OUTROS sellers e a coleta pode ter
           rodado sem o filtro — a rota de cruzamento já filtra, esta não filtrava. */
        const doSeller = (v) => { const s = String(v || '').toLowerCase(); return !!s && (s === sellerEsperado || s.includes(sellerEsperado) || sellerEsperado.includes(s)); };
        /* Codex #304 r2: registro SEM seller (cache antigo) fica de fora — pode ser de outro
           seller que o token alcança. É contado pra ficar claro que basta recoletar. */
        const semSeller = Object.values(g.pedidos).filter(x => x && !x.seller).length;
        const doaLoja = Object.values(g.pedidos).filter(x => x && doSeller(x.seller));
        const r = cancLib.totalNoPeriodo(doaLoja, de, ate);
        /* Codex #304: período ANTERIOR ao que foi coletado devolvia total com cara de completo.
           A coleta grava varreu_dias; se o pedido é mais antigo, avisa que é parcial. */
        const cobertoDesde = g.varreu_dias ? new Date(Date.parse(g.ok_em) - g.varreu_dias * 86400000).toISOString().slice(0, 10) : null;
        /* Codex #304 r2: se a COLETA truncou, a cobertura declarada não vale. */
        const parcial = !!g.truncou_paginas || !!(cobertoDesde && de && de < cobertoDesde);
        json(res, 200, Object.assign({ ok: true, coleta_ok_em: g.ok_em || null,
          periodo_parcial: parcial, coberto_desde: cobertoDesde,
          ignorados_sem_seller: semSeller,
          horas_desde_a_coleta: g.ok_em ? Math.round((Date.now() - Date.parse(g.ok_em)) / 3600000) : null }, r));
      } catch (e) {
        /* nunca derruba o dashboard por causa desta linha */
        json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 160), valor_a_descontar: null });
      }
      return true;
    }

    /* ─── /config-frete-magalu ──────────────────────────────────── */

    /* Codex #569: empresa com rota própria de custo-sync (a GOOD tem status mais rico) a mantém —
       `cfg.rotasProprias: ['custo-sync']` faz a fábrica ceder a vez em vez de responder antes. */
    if (method === 'GET' && p === (PREFIXO + '/custo-sync') && !PROPRIAS.has('custo-sync')) {
      const k = lerChaveAdmin(req, urlObj);
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: !!_cst.rodando, progresso: _cst.feitos + '/' + _cst.total, ok_ate_agora: _cst.ok, falhas: _cst.falhas, falhas_detalhe: _cst.falhas_detalhe || [], inicio: _cst.inicio, diario: _cstDiario ? _cstDiario.ultimo : null, diario_dia_fechado: typeof _diaFechadoDoDisco === 'function' ? _diaFechadoDoDisco() : null }); return true; }
      const skuProbe = urlObj.searchParams.get('sku');
      if (skuProbe && urlObj.searchParams.get('raw')) {
        if (typeof blingGet !== 'function') return semPeca(res, 'blingGet');
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
      /* 14/09 — mesma honestidade da rota /custo-diario: com a trava do processo ocupada (a
         outra empresa, ou o custoDiario desta mesma) custoSyncTravado adia sem rodar nada;
         dizer "iniciado: true" aqui seria a mesma mentira que o Codex apontou lá. */
      const _travaOcupadaS = travaPesada.quemEsta();
      if (_travaOcupadaS) { json(res, 409, { ok: false, erro: 'rotina pesada em curso (' + _travaOcupadaS.nome + ', há ' + _travaOcupadaS.ha_min + ' min) — tente de novo em alguns minutos' }); return true; }
      custoSyncTravado(!!urlObj.searchParams.get('fresh')).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, mensagem: 'custo-sync rodando em background (tartaruga anti-429) — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, (PREFIXO + '/custo-sync'), '', k) });
      return true;
    }




    // NÍVEL de desconto do frete Magalu (config do ⚙️). GET lê, POST salva.
    // Valida por SESSÃO admin (igual config-fiscal) — chamada pelo dashboard.
    if (p === (PREFIXO + '/config-frete-magalu')) {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = lerChaveAdmin(req, urlObj);
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      /* Codex #569: só expõe se a empresa CONSOME a config (AMB/Girassol via magalu-frete); senão
         o admin mudaria um nível que nenhum cálculo lê. */
      if (!cfg.pecas.configFreteMagalu) return semPeca(res, 'configFreteMagalu');
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

    /* ─── /tiktok-custo-devolucoes ──────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/tiktok-custo-devolucoes')) {
      if (typeof ehAdmin !== 'function') return semPeca(res, 'ehAdmin');
      if (typeof responderCusto !== 'function') return semPeca(res, 'responderCusto');
      const kT = lerChaveAdmin(req, urlObj);
      const sT = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kT === process.env.ADMIN_KEY) || (sT && ehAdmin(sT)))) { json(res, 404, { error: 'not found' }); return true; }
      /* 30/08 (Codex #291): a montagem inteira vive em lib/tiktok-custo-devolucoes.js —
         a review achou 5 defeitos que existiam nas DUAS cópias desta rota, então ela deixou
         de ser código de módulo. Aqui fica só o guard e a loja. */
      try {
        const resp = typeof responderCusto === 'function' ? responderCusto : require('../tiktok-custo-devolucoes').responderCusto;
        const r = resp({ loja: EMPRESA, de: urlObj.searchParams.get('de'), ate: urlObj.searchParams.get('ate') });
        json(res, r.http, r.corpo);
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 160), custo_total: null });
      }
      return true;
    }

    /* ─── /vendas-sync ──────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/vendas-sync')) {
      const k = lerChaveAdmin(req, urlObj);
      const sessV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || sessV)) { json(res, 404, { error: 'not found' }); return true; }
      if (typeof vendasSync !== 'function') return semPeca(res, 'vendasSync');   /* antes do status: não finge sincronizador ocioso */
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



    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou


    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log


    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)


    // ─── debug: onde o Bling guarda a localização de um SKU ───
    return false;
  };
}

module.exports = { criarRotasPainel };
