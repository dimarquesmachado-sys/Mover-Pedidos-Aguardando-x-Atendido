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
          primeiraImagem, FOTO_V, supaReq, supaCfg,
          /* bloco 3 (02/10): o que é da EMPRESA — rotinas e estado dela. Opcionais, com guarda
             na rota, como todo o resto. */
          _mlb, _backfill, varrerCancelados, reaplicarCusto, mlBillingSync,
          reaplicarImposto, dataISO, custoDiario, estadoReapCusto, CUSTO_FILE_DIARIO,
          _rotaDeParaSku, conferirMarketplaces,
          /* Codex #573: os status de ml-billing e varrer-cancelados. `_sitCancel` é `let`
             reatribuído no arquivo da empresa, por isso entra como FUNÇÃO (`sitCancel`). */
          estadoCancelados, sitCancel } = cfg.pecas;

  /* ⚠️ ESTAS VÊM DE lib/custo.js E NÃO SÃO INJETADAS, mas as de leitura/gravação pedem o contexto
     da empresa como 1º argumento. Codex #573: chamá-las cruas tratava o SKU como `ctx` —
     `/custo-historico` dizia "sem SKU" e `/custos-manuais` lia mapa vazio e estourava ao gravar.
     Aqui amarro ao contexto DESTA empresa, igual ao que cada arquivo de empresa faz.
     `skuInfoCache` vai por getter (a lib limpa o cache quando o custo muda) e é opcional. */
  const _custoLib = require('../custo');
  const _ctxCusto = { CACHE_DIR, path: pathx, fs: fsx, readJson, writeJson, blingGet,
                      get skuInfoCache() { return cfg.pecas.skuInfoCache != null ? cfg.pecas.skuInfoCache : null; } };
  const lerVigencias          = ()            => _custoLib.lerVigencias(_ctxCusto);
  const gravarVigencias       = (o)           => _custoLib.gravarVigencias(_ctxCusto, o);
  const custoVigenteEm        = (sku, data)   => _custoLib.custoVigenteEm(_ctxCusto, sku, data);
  const lerCustosManuais      = ()            => _custoLib.lerCustosManuais(_ctxCusto);
  const gravarCustosManuais   = (o)           => _custoLib.gravarCustosManuais(_ctxCusto, o);
  const resolverNomeSku       = (d)           => _custoLib.resolverNomeSku(_ctxCusto, d);
  const registrarCustoVigente = (sku, v, org) => _custoLib.registrarCustoVigente(_ctxCusto, sku, v, org);
  const { _hojeISO, telaCustosManuais, parsearCustosColados, _diaAntes } = _custoLib;   /* não pedem contexto */
  /* nome de exibição (título da tela de custo manual): injetável, senão o id em maiúsculas */
  const NOME_EMPRESA = cfg.nomeEmpresa || String(EMPRESA).toUpperCase();

  /* as envs da empresa: AMBBKP_X na AMB, GOODBKP_X na GOOD, GIRABKP_X na Girassol. Sem
     prefixo configurado, não inventa: devolve vazio e a rota cai no seu próprio padrão. */
  const _env = (nome) => (envPrefixo ? process.env[envPrefixo + nome] : undefined);
  const path = pathx;   /* o corpo extraído usa `path`; aqui ele chega como `pathx` */
  const fs = fsx;       /* idem para `fs` */
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
      /* Codex #571/#573: `vendasSync` e `_inferCanal` NÃO são exigidos aqui — a rota nunca chama o
         primeiro e o segundo já tem `typeof` na linha que o usa. Guardar o que não é
         desreferenciado só desligava a rota inteira na GOOD. */
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
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
    /* ⚠️ SEM GUARDA DE PEÇA AQUI, de propósito. Meu script de guardas usou o marcador `─── X ───`
       como âncora e inseriu neste bloco, que é de OUTRA rota — e o teste do #569 pegou: a GOOD
       tem `/custo-sync` PRÓPRIA, com o status rico que custou várias idas e vindas hoje
       (esperando_trava, retry_pendente, `leia`). Com a guarda, a fábrica respondia antes e esse
       status sumia.
       Quem protege esta rota é o `PROPRIAS` logo abaixo: a empresa que tem a sua fica com ela. */
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
      const { url: uC, key: kkC } = supaCfg(EMPRESA);
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
          /* Codex #571: falha de histórico NÃO é "zero vendas" — este plano dirige compra e
             investimento. Página que falha (1ª ou qualquer outra) derruba a resposta. */
          if (!rq.ok) throw new Error('histórico de vendas indisponível (HTTP ' + rq.status + ', offset ' + off + ')');
          const ln = await rq.json();
          if (!Array.isArray(ln)) throw new Error('histórico de vendas veio em formato inesperado (offset ' + off + ')');
          if (!ln.length) break;
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
        if (off >= 120000) throw new Error('histórico de vendas passou do limite de 120 mil linhas — plano incompleto');
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
        /* Codex #571: saldo DESCONHECIDO (fora do teto de 260 consultas, cache nulo, erro do
           Bling) não é zero — tratar como zero mandava comprar a necessidade inteira e inflava
           o total. Sem saldo não há quantidade a comprar nem investimento: fica null. */
        const saldoSabido = x.saldo != null;
        const saldo = saldoSabido ? x.saldo : 0;
        const precisa = Math.ceil(md * horizonteDias);
        let comprar = saldoSabido ? Math.max(0, precisa - saldo) : null;
        if (saldoSabido && mult > 1 && comprar > 0) comprar = Math.ceil(comprar / mult) * mult;
        const acabaEm = (saldoSabido && md > 0) ? Math.floor(saldo / md) : null;
        const diasSemEstoque = (acabaEm != null) ? Math.max(0, leadDias - acabaEm) : 0;
        const risco = diasSemEstoque * md * Math.max(0, mcUn);
        return {
          sku: x.sku, nome: x.nome || x.desc, img: x.img || null, curva: x.curva,
          un: x.un, un30: x.un30, un_30_60: x.un3060, tendencia: Math.round(tend * 100),
          md: Math.round(md * 1000) / 1000, saldo: saldoSabido ? x.saldo : null, acaba_em: acabaEm,
          precisa, comprar, custo_un: custoUn,
          investir: (custoUn != null && comprar != null) ? Math.round(comprar * custoUn * 100) / 100 : null,
          mc_un: Math.round(mcUn * 100) / 100,
          risco: Math.round(risco * 100) / 100,
          sem_saldo: !saldoSabido, sem_custo: custoUn == null
        };
      }).sort((a, b) => (b.risco - a.risco) || ((b.mc_un * (b.comprar || 0)) - (a.mc_un * (a.comprar || 0))));

      const tot = itens.reduce((a, c) => ({ investir: a.investir + (c.investir || 0), risco: a.risco + c.risco, skus: a.skus + (c.comprar > 0 ? 1 : 0) }), { investir: 0, risco: 0, skus: 0 });
      json(res, 200, { ok: true, lead, cob, seg, base, curva, mult, horizonte_dias: horizonteDias,
        de: deC, ate: ateC, skus: itens.length,
        skus_sem_saldo: itens.filter(i => i.sem_saldo).length,   /* sem saldo não entra em comprar/investir */
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
            const rr = await supaReq(EMPRESA, 'GET', q, null);
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
      /* Codex #571: cobertura declarada = cobertura REAL, por canal (como o TikTok). Sem pedido
         do canal no período não há o que checar e segue verdadeiro; com pedido, só vale se TODOS
         foram verificados (token ok, resposta ok). */
      let mlFalhas = 0, shFalhas = 0;
      // ── ML ──
      const alvoML = noPeriodo.filter(v => v.marketplace === 'ml' || v.marketplace === 'mercadolivre').slice(0, 80);
      if (alvoML.length) {
        let tkS = null; try { tkS = garantirTokenML ? await garantirTokenML() : null; } catch (e) {}
        if (!tkS) mlFalhas = alvoML.length;
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
              if (rS.ok && dS) checados++; else mlFalhas++;
              if (rS.ok && dS && String(dS.status || '').toLowerCase() === 'cancelled') {
                v.situacao = 'Cancelado no Mercado Livre'; v.cancelado_mkt = 1; cancelados.push(v.numero);
              }
            } catch (e) { mlFalhas++; }
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
      if (alvoSH.length && !SHK) shFalhas = alvoSH.length;
      if (alvoSH.length && SHK) {
        for (let i = 0; i < alvoSH.length; i += 20) {
          const fatia = alvoSH.slice(i, i + 20);
          try {
            const rSh = await fetch(SHU + '/' + (_env('SHOPEE_SYNC_LOJA') || EMPRESA) + '/interno/margem-pedidos?k=' + encodeURIComponent(SHK) + '&order_sns=' + encodeURIComponent(fatia.map(v => v.numero_loja).join(',')));
            const dSh = await rSh.json().catch(() => null);
            const lst = (dSh && (dSh.pedidos || dSh.data)) || null;
            if (lst) {
              const porSn2 = Array.isArray(lst) ? Object.fromEntries(lst.map(x => [String(x.order_sn), x])) : lst;
              for (const v of fatia) {
                const pS2 = porSn2[String(v.numero_loja)];
                if (pS2) checados++; else shFalhas++;
                if (pS2 && /cancel/i.test(String(pS2.order_status || ''))) { v.situacao = 'Cancelado na Shopee'; v.cancelado_mkt = 1; cancelados.push(v.numero); }
              }
            } else shFalhas += fatia.length;
          } catch (e) { shFalhas += fatia.length; }
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
        canais_checados: [].concat(mlFalhas === 0 ? ['ml'] : [], shFalhas === 0 ? ['shopee'] : [], tiktokDisponivel ? ['tiktok'] : []),
        sem_cobertura: ['magalu', 'amazon', 'olist'].concat(mlFalhas === 0 ? [] : ['ml'], shFalhas === 0 ? [] : ['shopee'], tiktokDisponivel ? [] : ['tiktok']),
        ml_nao_verificados: mlFalhas, shopee_nao_verificados: shFalhas,
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
            /* Codex #571: sem isto o laço de candidatos abaixo nunca rodava e o SKU recuperado pela
               busca livre ficava com foto null por 12h — o inverso do que o fallback existe pra
               fazer. Acha-se pelo código exato primeiro; senão o 1º resultado. */
            if (it0) cands = [it0].concat(lst.filter(x => x && x !== it0 && String(x.codigo || '').trim().toUpperCase() === sk.toUpperCase()));
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

    /* ═══ BLOCO 3 (02/10) — mais dez rotas ═══
       A medição corrigiu meu número: faltavam 36 rotas na GOOD, não 13. Estas dez saem da AMB
       com o mesmo tratamento do bloco 2 — banco, token e envs parametrizados — e as amarras
       de cada uma foram medidas ANTES de extrair, não descobertas no teste. */
    /* ─── /ml-billing ───────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-billing')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_mlb) return semPeca(res, '_mlb');
      if (!mlBillingSync) return semPeca(res, 'mlBillingSync');
      const kB = lerChaveAdmin(req, urlObj);
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
      json(res, 202, { ok: true, msg: 'puxando o faturamento do ML em background', status: (PREFIXO + '/ml-billing-status') });
      return true;
    }

    /* ─── /ml-billing-status ────────────────────────────────────── */

    /* Codex #573: repetia a condição de `/ml-billing` e nunca era alcançado. O original lê o
       arquivo de tarifas e devolve o progresso — sem chave, como na AMB e na Girassol. */
    if (method === 'GET' && p === (PREFIXO + '/ml-billing-status')) {
      if (!_mlb) return semPeca(res, '_mlb');
      /* o arquivo é o mesmo nas três empresas, dentro da pasta de cache de cada uma */
      const b = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {}, porDia: {} });
      const porCat = {}, comVenda = {};
      for (const t of Object.values(b.tarifas || {})) { porCat[t.c] = Math.round(((porCat[t.c] || 0) + t.v) * 100) / 100;
        if (t.o) comVenda[t.c] = (comVenda[t.c] || 0) + 1; }
      json(res, 200, { ok: true, status: _mlb, tentativas: _mlb.tentativas || [], detalhes: _mlb.detalhes || [], amostra_item: _mlb.amostra_item || null, amostra_venda: _mlb.amostra_venda || null, amostra_periodos: _mlb.amostra_periodos || null, atualizado: b.atualizado || null,
                       tarifas_guardadas: Object.keys(b.tarifas || {}).length, total_por_categoria: porCat, com_numero_de_venda: comVenda,
                       dias_com_dado: Object.keys(b.porDia || {}).length });
      return true;
    }

    /* ─── /raio-x-venda ─────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/raio-x-venda')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kR = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const venda = String(urlObj.searchParams.get('venda') || '').replace(/\D/g, '');
      if (!venda) { json(res, 400, { ok: false, erro: 'use ?venda=2000018258015754&k=SUA_ADMIN_KEY' }); return true; }
      const out = { ok: true, venda, ml: {}, bling: {}, veredito: null };
      try {
        /* Codex #343 r4: garantirTokenML() sonda /users/me e pode renovar, nenhum dos dois com
           timeout — ML que aceita a conexão e não responde deixaria o diagnóstico pendurado
           antes mesmo de começar. Aqui a espera tem limite: sem token em 20s, é indeterminado. */
        const tk = await Promise.race([
          garantirTokenML(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('o ML não respondeu em 20s ao validar o token')), 20000))
        ]);
        const r = await fetch('https://api.mercadolibre.com/orders/' + venda, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) }   /* Codex #343 r2: ML que aceita a conexão e não responde deixaria a rota pendurada */);
        out.ml.orders_status = r.status;
        /* Codex #343: o número pode ser um PACK — o Bling grava ora um, ora outro. Aí /orders
           dá 404 e a rota desistia, perdendo justamente as ordens do pacote, que são o que
           interessa. Se o /orders não achou, tenta como pack. */
        if (!r.ok && r.status === 404) {
          const rp0 = await fetch('https://api.mercadolibre.com/packs/' + venda, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) }   /* Codex #343 r2: ML que aceita a conexão e não responde deixaria a rota pendurada */);
          out.ml.packs_status = rp0.status;
          if (rp0.ok) {
            const dp0 = await rp0.json().catch(() => null);
            out.ml.era_pack = true;
            out.ml.pack_id = String(venda);
            out.ml.ordens_do_pack = (dp0 && Array.isArray(dp0.orders)) ? dp0.orders.map(o => String(o.id)) : null;
            if (out.ml.ordens_do_pack === null) out.ml.pack_incompleto = true;
            /* Codex #343 r2: com o pack aberto eu tinha as ordens mas NÃO a data — e sem data
               a rota caía sempre no INDETERMINADO, ou seja, meu próprio conserto do apontamento
               anterior deixou o caminho do pack inútil. Busca a data numa das ordens. */
            const prim = (out.ml.ordens_do_pack || [])[0];
            if (prim) {
              /* Codex #343 r5: com timeout esta chamada LANÇA, e sem try local a exceção sairia
                 pro catch de fora perdendo as ordens do pack já apuradas. */
              try {
                const ro = await fetch('https://api.mercadolibre.com/orders/' + prim, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
                if (ro.ok) { const dor = await ro.json().catch(() => null); if (dor && dor.date_created) { out.ml.date_created = dor.date_created; out.ml.status = dor.status; } }
              } catch (eOrd) { out.ml.data_erro = String(eOrd.message || eOrd).slice(0, 120); }
            }
          }
        }
        if (r.ok) {
          const d = await r.json().catch(() => null);
          out.ml.id = d && d.id ? String(d.id) : null;
          out.ml.pack_id = d && d.pack_id ? String(d.pack_id) : null;
          out.ml.status = d && d.status;
          out.ml.date_created = d && d.date_created;
          if (out.ml.pack_id) {
            /* Codex #343 r5: o timeout que EU acabei de pôr faz esta chamada LANÇAR quando
               estoura — e a exceção pulava pro catch de fora sem marcar pack_incompleto. Como
               a date_created já tinha sido capturada, a rota seguia e dava veredito definitivo
               sem conhecer as irmãs do carrinho. O try local marca o que não deu pra saber. */
            try {
              const rp = await fetch('https://api.mercadolibre.com/packs/' + out.ml.pack_id, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
              out.ml.packs_status = rp.status;
              const dp = rp.ok ? await rp.json().catch(() => null) : null;
              out.ml.ordens_do_pack = (dp && Array.isArray(dp.orders)) ? dp.orders.map(o => String(o.id)) : null;
            } catch (ePack) {
              out.ml.ordens_do_pack = null;
              out.ml.packs_erro = String(ePack.message || ePack).slice(0, 120);
            }
            /* Codex #343: pack que não abriu (429/5xx/JSON ruim) deixa o conjunto de candidatos
               incompleto — e num carrinho o Bling pode ter gravado o número de uma IRMÃ. Sem
               marcar isso, um 'NÃO achei' sairia sem ter procurado por todos os números. */
            if (out.ml.ordens_do_pack === null) out.ml.pack_incompleto = true;
          }
        } else { out.ml.corpo = String(await r.text().catch(() => '')).slice(0, 200); }
      } catch (e) { out.ml.erro = String(e.message || e).slice(0, 200); }
      /* o que o Bling tem: procura pelo número da venda E pelo pack */
      const candidatos = [venda, out.ml.pack_id].filter(Boolean).concat(out.ml.ordens_do_pack || []);
      out.bling.procurei_por = [...new Set(candidatos)];
      out.bling.achados = [];
      /* 06/09 (2ª versão) — O BLING IGNORA ?numeroLoja. A primeira versão desta rota usava esse
         filtro e o Bling devolveu os 100 pedidos MAIS RECENTES, sem filtrar nada — o veredito
         então dizia "ESTÁ no Bling" porque achava tudo, não porque achava aquilo. Falso
         positivo numa ferramenta de diagnóstico é pior que não ter a ferramenta.
         Agora varremos a janela de datas em volta da venda e comparamos NÓS mesmos, que é o
         que o canário faz — assim o raio-x enxerga exatamente o que ele enxerga. */
      /* Codex #343: sem date_created (token falhou, /orders falhou, JSON ruim) a janela caía
         em HOJE — e uma venda antiga seria declarada ausente depois de varrer a semana errada.
         Sem data do ML, não há veredito. */
      const diaML = String(out.ml.date_created || '').slice(0, 10);
      if (!diaML) {
        out.veredito = 'INDETERMINADO: não consegui a data da venda no ML (' + (out.ml.erro || ('HTTP ' + out.ml.orders_status)) + ') — sem ela eu varreria a janela errada no Bling e o resultado não valeria nada.';
        json(res, 200, out); return true;
      }
      const base = Date.parse(diaML + 'T12:00:00Z');
      const _d = ms => new Date(ms).toISOString().slice(0, 10);
      const deB = _d(base - 3 * 86400000), ateB = _d(base + 3 * 86400000);
      out.bling.janela = { de: deB, ate: ateB, nota: 'o Bling ignora ?numeroLoja — varremos por data e comparamos aqui' };
      const alvo = new Set(out.bling.procurei_por.map(String));
      let vistos = 0;
      for (let pg = 1; pg <= 30; pg++) {
        /* 06/09 (3ª versão) — ESPERAR O 429. A versão anterior desistia na primeira recusa do
           Bling: varreu 100 de ~700 pedidos e mesmo assim afirmou "NÃO achei". Veredito sobre
           14% da janela não prova nada, e ainda por cima aponta o dedo pra integração que pode
           estar perfeita. O resto do sistema já espera nesses casos (o canário e o backfill
           fazem isso); aqui faltava. */
        let rb = null;
        for (let tent = 1; tent <= 5; tent++) {
          /* Codex #343 r3: o blingGet aceita um AbortSignal (3º parâmetro) e eu não estava
             passando — Bling que trava na conexão deixaria a primeira tentativa pendurada pra
             sempre, e as 5 tentativas nunca aconteceriam. Sinal NOVO a cada requisição: um
             sinal compartilhado abortaria as tentativas seguintes junto com a primeira. */
          try { rb = await blingGet('/pedidos/vendas?dataInicial=' + deB + '&dataFinal=' + ateB + '&pagina=' + pg + '&limite=100', 3, AbortSignal.timeout(20000)); }
          catch (e) { rb = null; }
          if (rb && rb.ok) break;
          const st = (rb && rb.status) || 0;
          if (st !== 429 && st !== 0 && st < 500) break;         /* erro real: não insiste */
          if (tent < 5) await new Promise(r2 => setTimeout(r2, tent * 5000));
        }
        if (!rb || !rb.ok) {
          out.bling.erro = 'Bling respondeu ' + ((rb && rb.status) || '?') + ' na página ' + pg + ' mesmo após 5 tentativas';
          out.bling.varredura_completa = false;
          break;
        }
        /* Codex #343 r2: 2xx com JSON inválido ou envelope mudado devolve data:null, e tratar
           isso como "página vazia" transformava falha em varredura completa — o mesmo vício de
           dar veredito sem ter olhado, agora pela quarta porta. */
        if (!rb.data || !Array.isArray(rb.data.data)) {
          out.bling.varredura_completa = false;
          out.bling.erro = 'o Bling respondeu ' + rb.status + ' mas com corpo inesperado na página ' + pg;
          break;
        }
        const arr = rb.data.data;
        if (!arr.length) { out.bling.fim_real = true; break; }
        vistos += arr.length;
        for (const pd of arr) {
          const nl = String(pd.numeroPedidoLoja || pd.numeroLoja || '').trim();
          if (alvo.has(nl)) out.bling.achados.push({ casou_com: nl, id: pd.id, numero: pd.numero, numeroLoja: nl, situacao: pd.situacao && (pd.situacao.id != null ? pd.situacao.id : pd.situacao.valor)   /* Codex #343: a LISTAGEM do Bling manda o id, não o nome em .valor */, data: pd.data });
        }
        if (arr.length < 100) { out.bling.fim_real = true; break; }
        if (pg === 30) { out.bling.varredura_completa = false; out.bling.erro = 'mais de 3.000 pedidos na janela — varredura truncada no teto de páginas'; }
        await new Promise(r2 => setTimeout(r2, 120));
      }
      out.bling.pedidos_varridos = vistos;
      if (out.bling.varredura_completa !== false) out.bling.varredura_completa = true;
      out.veredito = out.bling.achados.length
        ? ('ESTÁ no Bling (pedido ' + out.bling.achados.map(a => a.numero).join(', ') + ') — o Bling gravou pelo número ' + [...new Set(out.bling.achados.map(a => a.casou_com))].join(', '))
        : (out.ml.pack_incompleto
            ? ('INDETERMINADO: o pacote ' + out.ml.pack_id + ' não abriu no ML, então não sei todos os números do carrinho — o Bling pode tê-la gravado por uma das irmãs. Tente de novo em alguns minutos.')
            : out.bling.varredura_completa === false
            ? ('INDETERMINADO: o Bling parou de responder no meio (' + (out.bling.erro || '') + '). Varri só ' + vistos + ' pedidos de ' + deB + ' a ' + ateB + ' — NÃO dá pra dizer que a venda não está lá. Tente de novo em alguns minutos.')
            : ('NÃO achei no Bling entre os ' + vistos + ' pedidos de ' + deB + ' a ' + ateB + ' (varredura completa) — procurei por ' + out.bling.procurei_por.join(', ')));
      json(res, 200, out);
      return true;
    }

    /* 06/09 — O QUE O CANÁRIO ACHOU E O QUE FEZ. O dono perguntou por que a venda que o canário
       encontra não volta pro Bling sozinha; a resposta era que ninguém tinha feito. Agora: pouca
       falta é reimportada automaticamente (com reconferência antes de criar, pra não duplicar),
       e muita falta vira aviso na tela — porque aí é integração caída e só reautorizar no
       navegador resolve. Esta rota alimenta o aviso do checkout e do dashboard. */

    /* ─── /varrer-cancelados ────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/varrer-cancelados')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!varrerCancelados) return semPeca(res, 'varrerCancelados');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const dV = Number((urlObj.searchParams && urlObj.searchParams.get('dias')) || 45);
      varrerCancelados(dV, EMPRESA).catch(e => console.log('[CANCEL] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'varrendo cancelados em background', dias: dV, status: (PREFIXO + '/varrer-cancelados-status') });
      return true;
    }

    /* ─── /varrer-cancelados-status ─────────────────────────────── */

    /* Codex #573: repetia a condição do disparo. O original devolve o estado da varredura. */
    if (method === 'GET' && p === (PREFIXO + '/varrer-cancelados-status')) {
      if (typeof estadoCancelados !== 'function') return semPeca(res, 'estadoCancelados');
      json(res, 200, { ok: true, status: estadoCancelados(), situacoes_descobertas: typeof sitCancel === 'function' ? sitCancel() : null }); return true;
    }

    /* ─── /sku-orfaos ───────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/sku-orfaos')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!_backfill) return semPeca(res, '_backfill');
      if (!dataISO) return semPeca(res, 'dataISO');
      const kO = lerChaveAdmin(req, urlObj);
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
          const q = 'vendas_historico?empresa=eq.' + EMPRESA + '&data_venda=gte.' + deO + '&data_venda=lte.' + ateO +
                    '&id=gt.' + ultimoId + '&select=id,sku,quantidade,valor_produto,canal&order=id.asc&limit=1000';
          const rr = await supaReq(EMPRESA, 'GET', q, null);
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

    /* ─── /reaplicar-custo ──────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/reaplicar-custo')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!reaplicarCusto) return semPeca(res, 'reaplicarCusto');
      if (!estadoReapCusto) return semPeca(res, 'estadoReapCusto');
      /* Codex #573: `_rotaDeParaSku` NÃO é exigida aqui — esta rota nunca a chama. */
      const kC = lerChaveAdmin(req, urlObj);
      const sC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY) || (sC && ehAdmin(sC)))) { json(res, 404, { error: 'not found' }); return true; }
      const _estC = estadoReapCusto();
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, estado: _estC }); return true; }
      if (_estC.rodando) { json(res, 200, { ok: true, ja_rodando: true, estado: _estC }); return true; }
      const deC = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateC = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deC) || !/^\d{4}-\d{2}-\d{2}$/.test(ateC)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (deC > ateC) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
      const _dataOk = t => { const d9 = new Date(t + 'T12:00:00-03:00'); return !isNaN(d9) && d9.toISOString().slice(0, 10) === t; };
      if (!_dataOk(deC) || !_dataOk(ateC)) { json(res, 400, { ok: false, erro: 'data inexistente no calendário' }); return true; }
      const simularC = urlObj.searchParams.get('simular') === '1';
      if (simularC) { const r9 = await reaplicarCusto(deC, ateC, EMPRESA, { simular: true }); json(res, 200, { ok: true, simulacao: true, resultado: r9 }); return true; }
      reaplicarCusto(deC, ateC, EMPRESA, {}).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, de: deC, ate: ateC, mensagem: 'reaplicando custo em background — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, (PREFIXO + '/reaplicar-custo'), '', kC) });
      return true;
    }
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /amb-checkout-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /amb-checkout-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /amb-checkout-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /amb-checkout-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /amb-checkout-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /amb-checkout-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */
    if (p === (PREFIXO + '/custo-historico')) {
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

    /* ═══ 21/08 — DE-PARA MANUAL: rota (o card consome) ═══════════════════════════════════
    GET  /amb-checkout-offline/sku-depara-manual            → lista os pares declarados
    GET  /amb-checkout-offline/sku-depara-manual?sugerir=464 → candidatos no catálogo (só sugestão)
    POST /amb-checkout-offline/sku-depara-manual {de,para}   → declara o par
    POST /amb-checkout-offline/sku-depara-manual {apagar}    → remove
    Pro caso do "464"/"465", que não têm produto_id e o Bling não consegue ligar sozinho. */
    /* 13/09 — fatia 8 da desduplicação: a rota do de-para de SKU (129 linhas) era igual nas
       duas empresas, mudando só o prefixo. Foi pra lib/checkout/rota-depara-sku.js, que
       guarda as travas aprendidas em revisão — apagar remove TODAS as variantes de grafia,
       e declarar um par recusa ciclo. Duas cópias dessas regras eram duas chances de uma
       divergir da outra. */
    /* ⚠️ esta é chamada DIRETO, fora de um bloco `if (method…)` — por isso minha varredura de
       guardas não a enxergou e o teste pegou com `_rotaDeParaSku is not a function`. Empresa que
       não passa a peça simplesmente não tem esta rota, e segue para as próprias. */
    if (_rotaDeParaSku && await _rotaDeParaSku(req, res, urlObj, method, p)) return true;

    if (p === (PREFIXO + '/custos-manuais')) {
      const kM = lerChaveAdmin(req, urlObj);
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
        res.end(telaCustosManuais(NOME_EMPRESA, (PREFIXO + '')));
        return true;
      }
    }

    /* 12/09 — DISPARO MANUAL do custo diário. Antes só existia o relógio (23h, e a janela
       de recuperação até 6h), então não havia como TESTAR a rotina nem recuperar uma noite
       perdida sem esperar o dia seguinte. Dois cuidados: `dia` permite refazer um dia já
       carimbado (senão a rotina recusa na hora, que é o certo no automático), e a chamada
       avisa que vai consumir cota do Bling — a regra da casa é rotina pesada fora do
       horário do galpão. */

    /* ─── /reaplicar-imposto ────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/reaplicar-imposto')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!reaplicarImposto) return semPeca(res, 'reaplicarImposto');
      const kR = lerChaveAdmin(req, urlObj);
      const sR = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY) || (sR && ehAdmin(sR)))) { json(res, 404, { error: 'not found' }); return true; }
      let mm = String((urlObj.searchParams && urlObj.searchParams.get('meses')) || '').trim();
      let lista;
      if (!mm || mm === 'todos') { const cfgT = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
                                   lista = Object.keys(cfgT.aliquotas || {}).filter(x => /^\d{4}-\d{2}$/.test(x)).sort(); }
      else lista = mm.split(',').map(x => x.trim()).filter(x => /^\d{4}-\d{2}$/.test(x));
      if (!lista.length) { json(res, 400, { ok: false, erro: 'informe ?meses=AAAA-MM,AAAA-MM ou ?meses=todos' }); return true; }
      reaplicarImposto(lista, EMPRESA).catch(e => console.log('[FISCAL] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'reaplicando imposto em background', meses: lista, status: (PREFIXO + '/reaplicar-status') });
      return true;
    }





    // STATUS NO MARKETPLACE: pergunta ao ML/Shopee se o pedido foi CANCELADO pelo cliente.
    // O Bling demora (ou não) pra refletir isso; o dashboard precisa mostrar cinza na hora.
    // Uso: /amb-checkout-offline/status-mkt?de=YYYY-MM-DD&ate=YYYY-MM-DD

    /* ─── /custo-diario ─────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/custo-diario')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!custoDiario) return semPeca(res, 'custoDiario');
      if (!CUSTO_FILE_DIARIO) return semPeca(res, 'CUSTO_FILE_DIARIO');
      /* mesma porta da rota vizinha (lida no arquivo, não inventada): chave de admin na
         query OU sessão de admin no cookie; sem isso, 404 — o lint pegou meu chaveOk fantasma. */
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const dia = String(urlObj.searchParams.get('dia') || '').trim();
      /* Codex #387 (P2): com o custo-sync em curso a rotina volta na hora e, FORA da janela
         automática, não há tick que re-tente — dizer 'iniciado' seria mentira. */
      if (_cst.rodando) { json(res, 409, { ok: false, erro: 'custo-sync em curso — tente de novo em alguns minutos (fora das 23h-6h não há tick automático que re-tente)' }); return true; }
      /* 14/09 — Codex P2: com a trava do PROCESSO (14/09), custoDiario() podia estar ocupado
         (a outra empresa, ou a tartaruga/6h desta mesma) e simplesmente devolver sem rodar
         nada — a resposta abaixo dizia "iniciado: true" do mesmo jeito, e fora da janela
         23h-6h nenhum tick automático re-tenta o pedido descartado. Checa a trava ANTES de
         chamar, mesma honestidade do _cst.rodando acima. */
      const _travaOcupadaD = travaPesada.quemEsta();
      if (_travaOcupadaD) { json(res, 409, { ok: false, erro: 'rotina pesada em curso (' + _travaOcupadaD.nome + ', há ' + _travaOcupadaD.ha_min + ' min) — tente de novo em alguns minutos (fora das 23h-6h não há tick automático que re-tente)' }); return true; }
      if (dia && /^\d{4}-\d{2}-\d{2}$/.test(dia)) {
        try {
          const c = readJson(CUSTO_FILE_DIARIO, {});
          if (c._custoDiarioDia === dia) { delete c._custoDiarioDia; fs.writeFileSync(CUSTO_FILE_DIARIO, JSON.stringify(c)); }
        } catch (e) {}
      }
      /* Codex #387 (P1): o dia pedido é IMPOSTO à rotina — antes ela derivava o dela e
         rodava outro dia, enquanto a resposta dizia que tinha refeito o pedido. */
      custoDiario(dia || undefined).catch(() => {});
      json(res, 200, {
        ok: true, iniciado: true,
        dia: dia || '(o padrão da rotina: ontem antes das 23h, hoje a partir das 23h)',
        aviso: 'roda em background e CONSOME COTA do Bling — evite no horário do galpão',
        /* Codex #387 (P2): caminho relativo e SEM chave — o link antigo trazia o host de
           produção fixo e o literal SUA_ADMIN_KEY, que não autentica ninguém. */
        acompanhe: (PREFIXO + '/custo-sync?status=1 (acrescente &k= com a sua chave)'),
      });
      return true;
    }

    /* ─── /canario-marketplaces ─────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/canario-marketplaces')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!conferirMarketplaces) return semPeca(res, 'conferirMarketplaces');
      const kC = lerChaveAdmin(req, urlObj);
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
    return false;
  };
}

module.exports = { criarRotasPainel };
