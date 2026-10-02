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
          LOJA_MKT, CONFERIDOS_FILE,
          /* bloco 2 (02/10) — AS TRÊS COISAS QUE FAZEM A ROTA SER DA EMPRESA DE VERDADE, e não
             só no nome. Tentei levar estas rotas sem elas e o teste pegou: dentro havia
             `empresa=eq.amb` na consulta ao banco, o token da AMB importado por require direto,
             e envs com prefixo `AMBBKP_`. A GOOD teria mostrado DADOS DA AMB — pior que não ter
             a rota. Agora os três entram por parâmetro. */
          garantirTokenML, envPrefixo,
          primeiraImagem, FOTO_V, supaReq, supaCfg } = cfg.pecas;

  /* as envs da empresa: AMBBKP_X na AMB, GOODBKP_X na GOOD, GIRABKP_X na Girassol. Sem
     prefixo configurado, não inventa: devolve vazio e a rota cai no seu próprio padrão. */
  const _env = (nome) => (envPrefixo ? process.env[envPrefixo + nome] : undefined);
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
      if (!vendasSync) return semPeca(res, 'vendasSync');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_inferCanal) return semPeca(res, '_inferCanal');
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

    /* ═══ BLOCO 2 (02/10) — quatro rotas, com empresa no banco, no token e nas envs ═══ */
    /* ─── /plano-compra ─────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/plano-compra')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!primeiraImagem) return semPeca(res, 'primeiraImagem');
      if (!supaCfg) return semPeca(res, 'supaCfg');
      const kC = lerChaveAdmin(req, urlObj);
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
          const rq = await fetch(uC.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + EMPRESA + '&data_venda=gte.' + deC + '&data_venda=lte.' + ateC +
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

    /* ─── /ml-devolucoes ────────────────────────────────────────── */

    if (method === 'GET' && (p === (PREFIXO + '/ml-devolucoes') || p === (PREFIXO + '/ml-devolucoes-coletar'))) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const mlDevLib = require('../ml-devolucoes');
      const buscarNoHistorico = async (orderIds) => {
        const ids = Array.from(new Set((orderIds || []).map(x => String(x || '').trim()).filter(Boolean)));
        const mapa = {};
        for (let i0 = 0; i0 < ids.length; i0 += 40) {
          const lote = ids.slice(i0, i0 + 40);
          const q = 'vendas_historico?empresa=eq.' + EMPRESA + '&numero_loja=in.(' + lote.map(encodeURIComponent).join(',') + ')' +
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
        try { tkV = garantirTokenML ? await garantirTokenML() : null; }
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

    /* 02/09 — O QUE SOBROU EM 'outros': depois de classificar 4 categorias novas, a AMB ainda
       tem -R$ 450 e a Girassol R$ 4.286 nesse balde. Como o valor da AMB é NEGATIVO, é crédito
       que o ML devolveu e o dashboard não mostra — dinheiro faltando a favor do dono. Esta rota
       lista as descrições que não casaram com nenhuma regra, agrupadas, pra fechar de vez em
       vez de adivinhar. Só lê o cache; não chama a API nem grava nada. */
    /* 02/09 — FATURA DO CARTÃO do ML, pelo ciclo do ML (13→12), com composição. Vem do campo
       debited_from_operation que a coleta passou a gravar; sem re-sincronizar, os registros
       antigos não têm a marca e aparecem em sem_marca. Só lê o cache. */

    /* ─── /status-mkt ───────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/status-mkt')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kS = lerChaveAdmin(req, urlObj);
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
        let tkS = null; try { tkS = garantirTokenML ? await garantirTokenML() : null; } catch (e) {}
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
      const SHU = _env('SHOPEE_SYNC_URL') || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const SHK = _env('SHOPEE_SYNC_KEY') || process.env.SHOPEE_SYNC_KEY || '';
      if (alvoSH.length && SHK) {
        for (let i = 0; i < alvoSH.length; i += 20) {
          const fatia = alvoSH.slice(i, i + 20);
          try {
            const rSh = await fetch(SHU + '/' + (_env('SHOPEE_SYNC_LOJA') || 'amb') + '/interno/margem-pedidos?k=' + encodeURIComponent(SHK) + '&order_sns=' + encodeURIComponent(fatia.map(v => v.numero_loja).join(',')));
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
      /* ═══ 21/08 — TIKTOK ENTRA NA VARREDURA ══════════════════════════════════════════════
         O Diego cobrou a regra: "cancelada não deve nem aparecer lá. tem q bater qtdade igual o
         análise de vendas e em todos períodos". A varredura só olhava ML e Shopee — cancelamento
         de TikTok ficava no histórico e entrava em TODO card (mapa, margem, contagem). É o canal
         de maior volume depois do ML (4.483 pedidos no ano da Girassol), então era o maior risco.
         NÃO gasto chamada de API: a coleta financeira já guarda, por pedido, os tipos de
         transação vistos. Quando o TikTok devolve a tarifa (`tarifa_devolvida > 0`) ou registra
         transação de reembolso, é cancelamento ou devolução — e a venda não deve ser contada.
         Amazon e Olist ficam de fora por não termos API deles; registrado, em vez de fingir
         cobertura. Magalu depende de o serviço dela expor o status — próxima etapa. */
      const alvoTK = noPeriodo.filter(v => String(v.marketplace || '').toLowerCase() === 'tiktok');
      /* Codex (revisão geral): se o cache financeiro do TikTok não abrir, o laço era pulado em
         silêncio e a resposta AINDA dizia que o TikTok foi checado — a mesma família de engano
         que perseguimos o dia todo (afirmar cobertura que não se tem). Sem pedido do canal no
         período, não há o que checar e segue verdadeiro. */
      let tiktokDisponivel = alvoTK.length === 0;
      let tkComRegistro = 0, tkSemRegistro = 0;   // cobertura por PEDIDO, não por arquivo
      if (alvoTK.length) {
        try {
          /* Codex (P1 x2): a coleta do TikTok grava em `/data` (TIKTOK_CACHE_DIR), NÃO no CACHE_DIR
             desta empresa — com o padrão, o arquivo nunca era encontrado e o TikTok era pulado em
             silêncio, enquanto a resposta anunciava que tinha sido checado. E o nome traz a LOJA:
             usar 'amb' na Girassol lia o arquivo da outra empresa (ou nenhum). */
          const fTK = path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_' + EMPRESA + '.json');
          const gTK = readJson(fTK, null);
          const peds = (gTK && gTK.pedidos && typeof gTK.pedidos === 'object') ? gTK.pedidos : null;
          if (peds) {
            /* Codex (P1, r2): abrir o arquivo NÃO é o mesmo que ter o pedido dentro dele. O cache
               nasce dos extratos, então pedido recente ainda não está lá e caía no `continue`
               silencioso — e a resposta seguia dizendo que o TikTok foi checado, justo quando os
               pedidos que faltam são os que mais importam. Cobertura é por PEDIDO, não por arquivo. */
            for (const v of alvoTK) {
              const sn = String(v.numero_loja || '').trim();
              const reg = sn && peds[sn];
              if (!reg) { tkSemRegistro++; continue; }   // sem financeiro ainda: não afirmo nada sobre ele
              tkComRegistro++;
              checados++;
              /* ═══ Codex (P1): DEVOLUÇÃO PARCIAL NÃO É CANCELAMENTO ═══════════════════════════
                 Pedido com 3 itens em que o cliente devolveu 1 registra tarifa devolvida e transação
                 de REFUND igual a uma reversão total. Do jeito que eu tinha feito, a venda INTEIRA
                 sairia do histórico — incluindo o que o cliente ficou. Apagar faturamento real é
                 pior que deixar um cancelado contado, então aqui só passa evidência de reversão
                 TOTAL: o repasse líquido do pedido zerou (ou virou negativo). Devolução parcial
                 deixa repasse positivo e não entra. */
              /* Codex (P1, rodada 2): num reembolso normal a coleta MANTÉM o `repasse` original
                 positivo e acumula o estorno em `ajustes_depois` — então "repasse <= 0" nunca
                 acontecia e nenhum pedido reembolsado era pego. O líquido é a SOMA dos dois.
                 (Isso apareceu no meu próprio teste como `custo_atual_bling: null` e eu não
                 questionei; o valor inesperado ERA o sintoma.) */
              const receita = Number(reg.receita || 0);
              const repBruto = Number(reg.repasse != null ? reg.repasse : NaN);
              const liquido = isFinite(repBruto) ? (repBruto + Number(reg.ajustes_depois || 0)) : NaN;
              const estornou = Number(reg.tarifa_devolvida || 0) > 0;
              const zerou = isFinite(liquido) && receita > 0 && liquido <= 0.01;
              if (estornou && zerou) {
                v.situacao = 'Cancelado no TikTok'; v.cancelado_mkt = 1; cancelados.push(v.numero);
              }
            }
          }
        } catch (e) {}
      }
      /* só posso dizer que o canal foi checado se TODO pedido dele tinha registro financeiro. */
      if (alvoTK.length) tiktokDisponivel = (tkComRegistro > 0 && tkSemRegistro === 0);
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
      json(res, 200, { ok: true, checados, cancelados_agora: cancelados.length, numeros: cancelados.slice(0, 30),
        canais_checados: tiktokDisponivel ? ['ml', 'shopee', 'tiktok'] : ['ml', 'shopee'],
        sem_cobertura: ['magalu', 'amazon', 'olist'].concat(tiktokDisponivel ? [] : ['tiktok']),
        tiktok_pedidos: alvoTK.length, tiktok_com_financeiro: tkComRegistro, tiktok_sem_financeiro: tkSemRegistro,
        aviso_tiktok: tiktokDisponivel ? null
          : (tkComRegistro || tkSemRegistro)
            ? (tkSemRegistro + ' de ' + alvoTK.length + ' pedido(s) do TikTok ainda nao tem financeiro (venda recente) — nao foram verificados')
            : 'cache financeiro do TikTok indisponivel; nenhum pedido TikTok foi verificado' });
      return true;
    }

    // COMPLETAR DETALHES do período que o dashboard está mostrando (SKU/qtd/taxas dos ainda não bipados).
    // Uso: /amb-checkout-offline/completar-detalhes?de=YYYY-MM-DD&ate=YYYY-MM-DD
    // Processa um lote curto e devolve quantos faltam — o dashboard chama em sequência até zerar.

    /* ─── /produto-fotos ────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/produto-fotos')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!primeiraImagem) return semPeca(res, 'primeiraImagem');
      if (!FOTO_V) return semPeca(res, 'FOTO_V');
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
    return false;
  };
}

module.exports = { criarRotasPainel };
