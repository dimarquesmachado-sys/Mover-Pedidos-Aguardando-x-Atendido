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
          garantirTokenML, mlTokenManager, envPrefixo,
          primeiraImagem, FOTO_V, supaReq, supaCfg,
          /* bloco 3 (02/10): o que é da EMPRESA — rotinas e estado dela. Opcionais, com guarda
             na rota, como todo o resto. */
          _mlb, _backfill, varrerCancelados, reaplicarCusto, mlBillingSync,
          reaplicarImposto, dataISO, custoDiario, estadoReapCusto, CUSTO_FILE_DIARIO,
          _rotaDeParaSku, conferirMarketplaces,
          /* bloco 4 (02/10): estado e rotinas da empresa. Opcionais, com guarda na rota. */
          _mlcred, _mgc, supaCount, estadoVarrerForn, _histCache, SIT_DESPACHADOS, sleep,
          _reparoAtivo, PAUSA_MS, varrerFornecedores, MLB_FILE, unsFullEfetivas,
          serieDaNFdoPedido, detalhePedido,
          UNS_EMISSAO_PROPRIA_CASA, aplicarCreditosFlex, backfillVendas, cacaMagalu,
          completarTarifaTikTok,
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

  /* 02/10 — as rotas de ML moram em lib/checkout/rotas-painel-ml.js (a fábrica passou de 2.700
     linhas e o teto da casa é 3.000). Mesmo contrato: a fatia recebe o MESMO contexto, não
     importa nada da pasta da empresa, e devolve `true` quando tratou. */
  const _rotasML = require('./rotas-painel-ml').criarRotasML({
    EMPRESA, PREFIXO, json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR, fsx, pathx, semPeca, _env, PROPRIAS, MLB_FILE, _mlb, _mlcred, aplicarCreditosFlex, blingGet, ehAdmin, garantirTokenML, mlBillingSync, supaCfg, supaReq, NOME_EMPRESA, mlTokenManager
  });

  return async function rotasPainel(req, res, p, method, urlObj) {
    /* Codex #586: `rotasProprias` vale para TODA rota declarada, não só o custo-sync — a empresa que
       tem a sua fica com ela e a fábrica cede a vez (devolve false) antes de qualquer handler.
       Sem isso a fábrica interceptava rotas da AMB (ex.: plano-compra sem `primeiraImagem`). */
    if (PROPRIAS.size && typeof p === 'string' && p.startsWith(PREFIXO + '/') && PROPRIAS.has(p.slice(PREFIXO.length + 1))) return false;

    /* 02/10 — o Plano de Compra como script compartilhado (lib/checkout/painel-plano-compra).
       A tela de cada empresa abre o espaço `<div id="planoCompraAqui">` e inclui este script;
       a seção vem inteira, com a empresa já embutida. Um arquivo só pras três. */
    /* 02/10 — ferramentas de custo (de-para de SKU + atalho pros custos manuais), mesma forma
       do plano de compra: peça compartilhada, empresa como parâmetro. */
    if (method === 'GET' && p === (PREFIXO + '/js/ferramentas-custo.js')) {
      let _fc;
      try { _fc = require('./painel-ferramentas-custo').scriptDeCusto(PREFIXO); }
      catch (e) { _fc = '/* ferramentas-custo indisponível: ' + String(e.message || e).slice(0, 120) + ' */'; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(_fc);
      return true;
    }

    if (method === 'GET' && p === (PREFIXO + '/js/plano-compra.js')) {
      let corpo;
      try { corpo = require('./painel-plano-compra').scriptDoPlano(PREFIXO); }
      catch (e) { corpo = '/* plano-compra indisponível: ' + String(e.message || e).slice(0, 120) + ' */'; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(corpo);
      return true;
    }

    if (await _rotasML(req, res, p, method, urlObj)) return true;

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
      /* Codex #582 r3 (P1): ZERO É UMA ESCOLHA, não "não informou". O `|| 4` trocava
         `lead=0` por 4 meses em silêncio — a tela mostrava 0 e a conta usava 4, inflando a
         compra sem ninguém ver. Quem tem reposição imediata (produto de pronta-entrega) pedia
         4 meses de estoque a mais. Só valor AUSENTE ou inválido cai no padrão. */
      /* Codex #582 (P2, acerto): LÊ O VALOR CRU. O `par()` já aplica o próprio tratamento, e
         com ele um "0" podia chegar aqui como vazio — o `_n` então devolvia o padrão e o
         conserto do zero não valia. Agora pega o parâmetro direto da URL. */
      const _cru = (nome) => {
        const v = (urlObj && urlObj.searchParams) ? urlObj.searchParams.get(nome) : null;
        return (v == null) ? '' : String(v).trim();
      };
      const _n = (nome, pad) => { const v = _cru(nome); const x = Number(v.replace(',', '.')); return (v !== '' && isFinite(x)) ? x : pad; };
      const lead = Math.min(24, Math.max(0, _n('lead', 4)));           // meses até a mercadoria chegar
      const cob  = Math.min(24, Math.max(0.5, _n('cob', 5)));       // meses de estoque desejados DEPOIS que chegar
      const seg  = Math.min(6, Math.max(0, _n('seg', 0)));          // 29/07: sem colchão separado — a cobertura escolhida já é a decisão
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
      /* Codex #573: `_rotaDeParaSku` NÃO é exigida aqui — esta rota nunca a chama.
         Codex #575: `estadoReapCusto` e `reaplicarCusto` SIM — a GOOD não injeta nenhuma das duas
         e a rota as chama sem checar (TypeError em vez de semPeca). */
      if (!estadoReapCusto) return semPeca(res, 'estadoReapCusto');
      if (!reaplicarCusto) return semPeca(res, 'reaplicarCusto');
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

    /* ═══ BLOCO 4 (02/10) — mais dezenove rotas ═══
       Mesmo tratamento dos blocos 2 e 3. O token apareceu numa TERCEIRA forma aqui
       (`mlTM = require(...)`, guardado em variável) que meus regex não pegavam — por isso a
       varredura de amarras roda ANTES de juntar, e separa código de comentário: `AMBBKP_UN_FULL`
       dentro de uma MENSAGEM de erro é texto que o dono lê, não amarra. */
    /* ─── /backfill ─────────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/backfill')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_backfill) return semPeca(res, '_backfill');
      if (!backfillVendas) return semPeca(res, 'backfillVendas');
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const de = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '2026-01-01').slice(0, 10);
      const ate = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || new Date().toISOString().slice(0, 10)).slice(0, 10);
      if (_backfill.rodando) {
        /* 04/09 — ECO DA PRÓPRIA CHAMADA: o navegador faz duas requisições ao abrir a URL
           (a página e o favicon/retry). A primeira dispara; a segunda chega segundos depois,
           vê o estado já 'rodando' e respondia "já tem um backfill rodando" — mostrando o
           backfill que o próprio usuário acabou de criar. Parecia recusa e confundiu o dono
           várias vezes. Se o período pedido é o MESMO e a rodada começou há poucos segundos,
           é eco: responde 'iniciado'. Só quando é outro período (ou rodada antiga) é recusa
           de verdade. */
        /* Codex (#519): mesmo cuidado que a Girassol recebeu — a empresa faz parte da
           identidade da rodada. Aqui a rota dispara com EMPRESA (ver a chamada logo abaixo). */
        const mesmoPeriodo = _backfill.empresa === EMPRESA && _backfill.de === de && _backfill.ate === ate;
        const segundos = _backfill.inicio ? (Date.now() - Date.parse(_backfill.inicio)) / 1000 : 1e9;
        if (mesmoPeriodo && segundos < 30) {
          json(res, 200, { ok: true, msg: '✅ backfill deste período já foi iniciado (há ' + Math.round(segundos) + 's) — acompanhe em /backfill-status', de, ate, status: _backfill });
          return true;
        }
        json(res, 200, { ok: false,
          msg: mesmoPeriodo
            ? ('já tem um backfill DESTE período rodando desde ' + (_backfill.inicio ? new Date(_backfill.inicio).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(11, 16) : '?') + ' — acompanhe em /backfill-status')
            : ('já tem um backfill rodando (' + _backfill.de + ' a ' + _backfill.ate + ') — espere terminar; acompanhe em /backfill-status'),
          status: _backfill });
        return true;
      }
      backfillVendas(de, ate, EMPRESA);   // NÃO await — roda em background
      json(res, 200, { ok: true, msg: '✅ backfill iniciado em background (só ' + NOME_EMPRESA + '). Acompanhe em /backfill-status. Ele deleta o período antes e regrava, então pode rodar de novo sem duplicar.', de, ate });
      return true;
    }
    // 🌻 ÍCONE E MANIFESTO — pra a aba do navegador, o favorito (Ctrl+D) e principalmente o atalho
    // na tela de início do celular. Servidos pelo servidor (não embutidos) porque o Android só
    // aceita ícone de URL real no "adicionar à tela de início". Cache de 30 dias.

    /* ─── /backfill-conferir ────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/backfill-conferir')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaCount) return semPeca(res, 'supaCount');
      const kD = lerChaveAdmin(req, urlObj);
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
      out.total = await supaCount(EMPRESA, _faixaAno);
      out.total_todos_os_anos = await supaCount(EMPRESA, '');
      // 17/08 — mesma correção já feita na Girassol (#94/#96): a lista de meses era FIXA até
      // julho, então agosto sumia do relatório e parecia buraco no histórico quando não era.
      // Ano vira parâmetro (&ano=), com padrão no corrente; o último dia sai do calendário
      // (fevereiro fixo em 28 perderia 29/02 em ano bissexto).
      // (ano, faixa e mês atual já definidos acima — `&ano=` vale para meses, total e canais)
      for (let mm = 1; mm <= mesC; mm++) {
        const m = anoC + '-' + String(mm).padStart(2, '0');
        const ultimoDoMes = new Date(Date.UTC(anoC, mm, 0)).getUTCDate();
        const fimM = (ehAnoAtual && mm === mesC) ? String(hojeC.getDate()).padStart(2, '0') : String(ultimoDoMes).padStart(2, '0');
        out.por_mes[m] = await supaCount(EMPRESA, 'data_venda=gte.' + m + '-01&data_venda=lte.' + m + '-' + fimM);
      }
      for (const c of ['ml','shopee','tiktok','magalu','amazon','olist','madeira','leroy','outro']) {
        const n = await supaCount(EMPRESA, _faixaAno + '&canal=eq.' + c);   // Codex: canais também no ano escolhido
        if (n) out.por_canal[c] = n;
      }
      json(res, 200, out);
      return true;
    }

    // ADMIN (?k= obrigatorio — trava central intercepta rotas 'debug'): RAIO-X DO PRODUTO no Bling.
    // Mostra TODAS as chaves do produto + campos de preco/custo + o que /estoques/saldos e /produtos/fornecedores devolvem.
    // Uso: /amb-checkout-offline/debug-sku?sku=KP16&k=SUA_CHAVE

    /* ─── /backfill-limpar ──────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/backfill-limpar')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!_backfill) return semPeca(res, '_backfill');
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      if (_backfill.rodando) { json(res, 200, { ok: false, msg: 'tem um backfill rodando — espere terminar (ou reinicie o serviço) antes de limpar' }); return true; }
      const del = await supaReq(EMPRESA, 'DELETE', 'vendas_historico?empresa=eq.' + EMPRESA + '', null);
      json(res, 200, { ok: del.ok, status: del.status, msg: del.ok ? '✅ tabela zerada (empresa amb). Pode rodar o backfill do zero, mês a mês.' : '❌ falhou ao limpar: ' + ((del.body||del.erro||'')+'').slice(0,150) });
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X DO PEDIDO CRU do Bling — mostra TODAS as chaves e qualquer campo
    // com cara de data/hora, pra decidirmos com o payload real se o Bling guarda a hora da venda.
    // Uso: /amb-checkout-offline/debug-pedido?id=116063  (o nº que aparece na coluna Pedido)
    /* ═══ PEDIDOS MOVIDOS PRA DESPACHADOS POR ENGANO ══════════════════════════════════
       Rastro do incidente de 24/08: clonar pedido no Bling COPIA a unidade de negócio, então
       o clone de uma venda Full nascia com unidade Full mesmo saindo da matriz, e o ciclo o
       mandava pra DESPACHADOS. O ciclo olha 5 dias, então há mais afetados que os poucos que
       apareceram na tela.

       ⚠️ SÓ LISTA. NÃO ALTERA NADA. Tinha um modo `gravar=1` que devolvia os pedidos pra
       ATENDIDO em lote, e foi de onde vinham TODOS os riscos apontados na revisão — inclusive
       um P1: se o conferidos.json estivesse ausente ou truncado, readJson devolve {} em
       silêncio, todo pedido pareceria "nunca bipado" e centenas de pedidos legítimos seriam
       devolvidos de uma vez. Tirei o modo inteiro, porque ele não é mais necessário: com o
       PR #195 no ar, mover um pedido pra ATENDIDO na mão AGORA GRUDA — a trava da série
       impede o ciclo de levar de volta. A parte difícil é DESCOBRIR quais são, e é isso que
       esta rota faz.

       Uso: /amb-checkout-offline/despachados-por-engano?k=ADMIN_KEY[&dias=10] */
    /* ═══ SONDA TEMPORÁRIA (25/08): clones de garantia escondidos como Full ══════════════
       Pergunta pontual do dono: "quais NFs de agosto são SÉRIE 1 mas estão na unidade
       AMB - FULL MLivre?" — clones de reposição que nasceram carimbados como Full.
       SÓ LISTA, não altera nada. Remover quando não for mais útil.

       v2 (25/08, noite): a varredura passou pra 2º PLANO. A versão síncrona morria com a
       aba do navegador — quinzena tem ~1.500 pedidos e a leitura de série custa 2-3
       chamadas com pausa anti-429 por pedido Full: 15-30 min que browser nenhum espera, e
       fechar a aba matava tudo. Agora: &acao=iniciar dispara e responde NA HORA;
       &acao=status (o padrão) mostra andamento e, no fim, o resultado. O estado vive em
       memória e morre no restart do serviço — aceitável numa sonda descartável.
       Uso: ?k=ADMIN_KEY&acao=iniciar[&de=2026-08-01&ate=2026-08-15][&un=2839148]
            ?k=ADMIN_KEY               ← consulta o andamento/resultado */

    /* ─── /backfill-teste ───────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/backfill-teste')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!supaCfg) return semPeca(res, 'supaCfg');
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const out = { ok: true };
      const { url } = supaCfg(EMPRESA);
      out.url_configurada = url ? (String(url).slice(0, 30) + '…') : 'FALTANDO';
      const marca = '__TESTE_' + Date.now();
      const ins = await supaReq(EMPRESA, 'POST', 'vendas_historico', [{ empresa: EMPRESA, numero_pedido: marca, canal: 'teste', data_venda: '2026-01-01', sku: 'TESTE-CONEXAO', quantidade: 0, valor_produto: 0 }]);
      out.gravar = { status: ins.status, ok: ins.ok, erro: ins.erro || null, resposta: (ins.body || '').slice(0, 200) };
      if (ins.ok) {
        const del = await supaReq(EMPRESA, 'DELETE', 'vendas_historico?numero_pedido=eq.' + encodeURIComponent(marca), null);
        out.apagar = { status: del.status, ok: del.ok };
        out.resultado = (del.ok) ? '✅ CONEXÃO OK — gravou e apagou o registro de teste. Pode rodar o backfill.' : '⚠️ gravou mas não apagou — confira o DELETE (mas escrita funciona)';
      } else {
        out.resultado = '❌ FALHOU ao gravar. Confira SUPABASE_URL_VENDAS_' + String(EMPRESA).toUpperCase() + ' e SUPABASE_KEY_VENDAS_' + String(EMPRESA).toUpperCase() + ' no Render (a chave TEM que ser a service_role).';
      }
      json(res, 200, out);
      return true;
    }








    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.

    // ─── REAPLICAR CUSTO NO HISTÓRICO (19/08) ───────────────────────────────────
    // ?de=&ate= obrigatórios · &simular=1 mostra o que MUDARIA sem gravar (recomendado antes)
    // ?status=1 acompanha. Só admin.

    /* ─── /bling-cru ────────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/bling-cru')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      const kB = lerChaveAdmin(req, urlObj);
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

    /* ─── /despachados-por-engano ───────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/despachados-por-engano')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!dataISO) return semPeca(res, 'dataISO');
      if (!SIT_DESPACHADOS) return semPeca(res, 'SIT_DESPACHADOS');
      if (!sleep) return semPeca(res, 'sleep');
      if (!PAUSA_MS) return semPeca(res, 'PAUSA_MS');
      if (!unsFullEfetivas) return semPeca(res, 'unsFullEfetivas');
      if (!serieDaNFdoPedido) return semPeca(res, 'serieDaNFdoPedido');
      if (!detalhePedido) return semPeca(res, 'detalhePedido');
      if (!UNS_EMISSAO_PROPRIA_CASA) return semPeca(res, 'UNS_EMISSAO_PROPRIA_CASA');
      const kE = lerChaveAdmin(req, urlObj);
      const sE = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kE === process.env.ADMIN_KEY) || (sE && ehAdmin(sE)))) { json(res, 404, { error: 'not found' }); return true; }
      if (!SIT_DESPACHADOS) { json(res, 200, { ok: false, erro: 'SIT_DESPACHADOS não configurado nesta empresa' }); return true; }

      /* ⚠️ TETO DE 30 DIAS, que é a retenção do conferidos.json (purgarConferidos apaga os
         sincronizados depois disso). Além dessa janela, um pedido bipado DE VERDADE já perdeu
         o carimbo e apareceria como "movido por engano" — e como a resposta manda o admin
         mover cada listado pra ATENDIDO, um falso positivo aqui vira trabalho errado na mão.
         Melhor não listar do que listar errado. */
      /* ⚠️ 28, não 30. A purga do conferidos apaga com timestamp EXATO de 30 dias rolantes,
         mas o dataISO() corta a data pura — então pedir 30 dias faz a consulta pegar o dia da
         borda INTEIRO, e os pedidos da parte da manhã desse dia já perderam a prova de
         bipagem. Eles apareceriam como "engano" e o admin iria mexer neles à toa. Dois dias
         de folga cobrem a diferença com sobra. */
      const RETENCAO_CONF_DIAS = 28;
      const diasPedido = Number(urlObj.searchParams.get('dias')) || 10;
      const diasE = Math.min(RETENCAO_CONF_DIAS, Math.max(1, diasPedido));
      const limitouJanela = diasPedido > RETENCAO_CONF_DIAS;
      /* Codex #220 (P1): a rota tinha CÓPIA PRÓPRIA da leitura de env — com a filial nova
         (3456195) ela divergiria do ciclo: pedido legítimo série 1 do MLivre movido pelo
         ciclo apareceria aqui como "clone movido por engano". Fonte ÚNICA do ciclo.js. */
      const UN_FULL_E = unsFullEfetivas();
      const setFullE = new Set(UN_FULL_E);
      const setEmissaoPropriaE = new Set(UNS_EMISSAO_PROPRIA_CASA.concat(String(_env('UN_FULL_EMISSAO_PROPRIA') || '').split(',').map(x => x.trim()).filter(Boolean)));

      /* ⚠️ FALHA FECHADA nas duas provas de que esta rota depende. Ela não altera nada, mas
         a resposta manda o admin mover cada listado pra ATENDIDO — então listar errado vira
         trabalho errado na mão, e é tão ruim quanto alterar errado.
         1) sem AMBBKP_UN_FULL não existe classificador: nada seria Full e TODO pedido não
            bipado viraria "engano", inclusive os Full de verdade.
         2) readJson devolve {} EM SILÊNCIO se o conferidos.json estiver ausente ou truncado
            (ele é escrito de forma não atômica, então truncado é falha concreta). Aí todo
            pedido pareceria "nunca bipado". Melhor recusar do que listar em cima de prova
            que eu não consegui ler. */
      /* Não basta ter algum texto: id de unidade no Bling é NUMÉRICO. Se a env vier com
         separador errado (ponto e vírgula, espaço) ou com um token não numérico, o split
         produz um Set não vazio que NUNCA casa com nada — e aí Full de verdade que não está
         no conferidos.json seria listado como "movido por engano". */
      const unInvalidos = UN_FULL_E.filter(x => !/^\d+$/.test(x));
      if (!UN_FULL_E.length || unInvalidos.length) {
        json(res, 200, { ok: false,
          erro: !UN_FULL_E.length
            ? 'AMBBKP_UN_FULL vazia — sem ela não dá pra distinguir Full de engano, e a lista sairia toda errada'
            : 'AMBBKP_UN_FULL tem valor que não é id numérico: ' + unInvalidos.join(', ') + ' — separe por vírgula, só números. Como está, nenhum pedido casaria e os Full apareceriam como engano' });
        return true;
      }
      let confE;
      try {
        const cruE = fs.readFileSync(CONFERIDOS_FILE, 'utf8');
        confE = JSON.parse(cruE);
        /* Array TAMBÉM é 'object'. E um array aqui é formato alcançável de verdade — a rota de
           restauração aceita array em body.conferidos com a mesma checagem frouxa. Se passasse,
           toda busca por id daria undefined e TODO pedido viraria "nunca bipado". */
        if (!confE || typeof confE !== 'object' || Array.isArray(confE)) throw new Error('esperava um mapa de pedidos, veio ' + (Array.isArray(confE) ? 'uma lista' : typeof confE));
      } catch (eC) {
        if (eC && eC.code === 'ENOENT') {
          json(res, 200, { ok: false, erro: 'conferidos.json não existe — sem a prova de bipagem todo pedido pareceria não bipado; não vou listar' });
          return true;
        }
        json(res, 200, { ok: false, erro: 'não consegui ler o conferidos.json (' + String(eC.message || eC).slice(0, 80) + ') — sem a prova de bipagem a lista sairia errada' });
        return true;
      }

      /* Toda chamada com prazo. Sem isto, se o Bling aceitar a conexão e parar de responder,
         o await fica pendurado pra sempre e a rota nunca devolve nada — o repo já documenta
         exatamente esse comportamento no listarAtendidos e usa AbortController lá. */
      const comPrazo = async (fn, ms) => {
        const teto = ms || 45000;
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), teto);
        /* DUAS camadas, de propósito. O AbortController CANCELA o fetch da API — é o certo,
           e é o padrão que o listarAtendidos já usa. Mas o blingGet chama garantirToken()
           ANTES, e o gerenciador de token faz fetch próprio, que não recebe este signal: se
           o travamento for lá, abortar não adianta porque a chamada da API nem começou.
           A corrida garante que a rota SEMPRE responde. Ela não cancela o fetch do token
           (a conexão fica pendurada até o SO derrubar), e por isso não substitui o abort —
           some com ele e voltam as conexões penduradas que o PR #183 consertou. Para uma
           rota de diagnóstico chamada de vez em quando, conexão vazando é bem menos ruim que
           requisição que nunca volta. O certo mesmo é passar o prazo pro tokenManager, mas
           ele é compartilhado pelas 3 empresas e por todos os fluxos — fica pra um PR
           próprio, não pra dentro deste. */
        let estouro;
        const relogio = new Promise((_, rej) => { estouro = setTimeout(() => rej(new Error('o Bling não respondeu em ' + Math.round(teto / 1000) + 's (pode ser a etapa do token, que não aceita cancelamento)')), teto + 5000); });
        try { return await Promise.race([fn(ac.signal), relogio]); }
        finally { clearTimeout(tm); clearTimeout(estouro); }
      };

      const hojeE = new Date(); const iniE = new Date(hojeE); iniE.setDate(iniE.getDate() - diasE);
      const suspeitos = [], full = [], bipados = [], naoResolvidos = [];
      let vistos = 0, indeterminados = 0, truncou = false;
      const TETO_PAG = 40;
      try {
        for (let pag = 1; pag <= TETO_PAG; pag++) {
          /* ⚠️ PARÂMETROS CERTOS. O repo já documenta isto em ambtotal/blingApi.js desde 28/07:
             /pedidos/vendas quer dataInicial/dataFinal — com dataEmissaoInicial/Final o Bling
             IGNORA o filtro e devolve TODOS os pedidos daquela situação, de todos os tempos.
             Aqui isso seria grave: o `dias` viraria decoração, a varredura pegaria o histórico
             inteiro, e pedido antigo cuja prova de bipagem já foi purgada apareceria como
             "movido por engano" — mandando o admin mexer em pedido que estava certo.
             (o endpoint /nfe usa dataEmissaoInicial de verdade; o de pedidos, não) */
          const qsE = `idsSituacoes=${SIT_DESPACHADOS}&dataInicial=${dataISO(iniE)}&dataFinal=${dataISO(hojeE)}`;
          const rE = await comPrazo(sig => blingGet(`/pedidos/vendas?${qsE}&pagina=${pag}&limite=100`, 3, sig));
          if (!rE || rE.ok === false) {
            json(res, 200, { ok: false, erro: 'o Bling falhou ao listar (página ' + pag + ') — varredura INCOMPLETA, não use este resultado', parcial: { vistos, encontrados_ate_aqui: suspeitos.length } });
            return true;
          }
          const arrE = (rE.data && rE.data.data) || [];
          if (!arrE.length) break;
          for (const ped of arrE) {
            /* confere a situação AQUI também: o mesmo blingApi.js filtra localmente
               (`bruto.filter(p => p.situacao?.id === statusId)`) porque a API às vezes devolve
               pedido de outra situação. Sem isto, um pedido que nem está em DESPACHADOS
               entraria na lista de "movidos por engano". */
            /* Exige casamento EXATO. Se a listagem vier sem `situacao`, não dá pra afirmar que
               o pedido está em DESPACHADOS — e o blingApi.js já documenta que o Bling às vezes
               ignora o filtro de situação. Deixar passar "porque não veio o campo" colocaria
               pedido de outro status na lista de reversão manual. */
            if (!ped.situacao || String(ped.situacao.id) !== String(SIT_DESPACHADOS)) continue;
            vistos++;
            const idE = String(ped.id);
            let unE = (ped.loja && ped.loja.unidadeNegocio && ped.loja.unidadeNegocio.id) || null;
            let viaDetalhe = false;
            if (unE == null && ped.loja) {
              let det = null;
              try { det = await comPrazo(sig => detalhePedido(idE, sig)); } catch (e) { det = null; }
              await sleep(PAUSA_MS);
              if (!det) { indeterminados++; naoResolvidos.push({ id: idE, numero: ped.numero, motivo: 'o detalhe do pedido não veio do Bling' }); continue; }
              unE = (det.loja && det.loja.unidadeNegocio && det.loja.unidadeNegocio.id) || null;
              viaDetalhe = true;
            }
            const ehPelaUnidade = unE != null && setFullE.has(String(unE));
            const cE = confE[idE];
            const bipadoE = !!(cE && cE.conferido_em);
            const linha = { id: idE, numero: ped.numero, data: ped.data || null,
                            loja: (ped.loja && (ped.loja.nome || ped.loja.id)) || null,
                            un_da_loja: unE, via_detalhe: viaDetalhe || undefined };

            /* A unidade sozinha não basta: o clone de uma venda Full tem unidade Full. Série 1
               = emissão nossa, da matriz. Mesma regra do ciclo (PR #195). Sem isto a rota não
               acharia justamente os pedidos que existe pra achar. */
            let serieE = null;
            if (ehPelaUnidade) {
              try { const nfE = await comPrazo(sig => serieDaNFdoPedido(idE, sig)); serieE = nfE && nfE.serie ? String(nfE.serie) : null; }
              catch (e) { serieE = null; }
              await sleep(PAUSA_MS);
              if (serieE) linha.serie_nf = serieE;
              else { indeterminados++; naoResolvidos.push({ id: idE, numero: ped.numero, motivo: 'unidade é Full mas não consegui descobrir a série da NF' }); continue; }
            }
            /* Codex #220 (P1): série 1 SÓ é clone fora das unidades de emissão própria — no
               MLivre (2839148 e a nova 3456195) série 1 pela matriz é o fluxo NORMAL (#202). */
            const emissaoPropriaE = ehPelaUnidade && setEmissaoPropriaE.has(String(unE || ''));
            if (ehPelaUnidade && (serieE !== '1' || emissaoPropriaE)) { full.push(linha); continue; }   // Full de verdade
            if (bipadoE) { bipados.push(linha); continue; }                        // passou pelo checkout
            if (ehPelaUnidade) linha.motivo = 'unidade Full mas NF série 1 — clone da matriz';
            suspeitos.push(linha);
          }
          /* Página cheia no teto = ainda há pedidos que eu não olhei. Dizer ok:true aqui seria
             afirmar que a varredura foi completa sem ter sido. */
          if (pag === TETO_PAG && arrE.length === 100) truncou = true;
          if (arrE.length < 100) break;
          await sleep(PAUSA_MS);
        }
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 200), parcial: { vistos, suspeitos: suspeitos.length } });
        return true;
      }

      json(res, 200, {
        ok: true,
        modo: 'SÓ LISTA — esta rota não altera nenhum pedido',
        como_corrigir: 'mova cada um pra ATENDIDO no Bling; com a trava da série (PR #195) no ar, ele não volta mais pra DESPACHADOS',
        varredura_completa: !truncou,
        aviso: truncou ? `parei em ${TETO_PAG} páginas e a última veio cheia — há pedidos NÃO examinados; rode com dias menor` : undefined,
        janela_dias: diasE,
        janela_limitada: limitouJanela ? `você pediu ${diasPedido} dias, mas ${RETENCAO_CONF_DIAS} é o limite: além disso a prova de bipagem já foi apagada e pedido bipado apareceria como engano` : undefined,
        situacao_lida: SIT_DESPACHADOS, un_full_configurado: UN_FULL_E,
        resumo: { vistos, movidos_por_engano: suspeitos.length, full_corretos: full.length,
                  bipados_corretos: bipados.length, nao_resolvidos: indeterminados },
        movidos_por_engano: suspeitos,
        nao_resolvidos: naoResolvidos,
        full_corretos: full.slice(0, 30),
        bipados_corretos: bipados.slice(0, 30)
      });
      return true;
    }

    /* ─── /magalu-caca ──────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/magalu-caca')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!_mgc) return semPeca(res, '_mgc');
      if (!_histCache) return semPeca(res, '_histCache');
      if (!cacaMagalu) return semPeca(res, 'cacaMagalu');
      const kM = lerChaveAdmin(req, urlObj);
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
        const del2 = await supaReq(EMPRESA, 'DELETE', 'vendas_historico?empresa=eq.' + EMPRESA + '&canal=eq.magalu&numero_pedido=like.MG-*&data_venda=gte.' + deL2 + '&data_venda=lte.' + ateL2, null);
        try { for (const k9 of Object.keys(_histCache)) delete _histCache[k9]; } catch (e) {}
        json(res, del2.ok ? 200 : 500, { ok: del2.ok, msg: del2.ok ? ('🧹 linhas da caça da Magalu apagadas em ' + deL2 + ' a ' + ateL2 + ' — o que veio do Bling continua intacto. Agora rode a caça de novo.') : ('falhou: status ' + del2.status), status_http: del2.status });
        return true;
      }
      const deM = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateM = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deM) || !/^\d{4}-\d{2}-\d{2}$/.test(ateM)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (_mgc.rodando) { json(res, 200, { ok: true, ja_rodando: true, status: _mgc }); return true; }
      cacaMagalu(deM, ateM, EMPRESA, { refazer: urlObj.searchParams.get('refazer') === '1' }).catch(e => console.log('[CACA-MAGALU] ' + (e.message || e)));
      json(res, 200, { ok: true, msg: '🛒 caça da Magalu iniciada em background (' + deM + ' a ' + ateM + ') — acompanhe em ' + PREFIXO + '/magalu-caca?status=1 (acrescente &k= com a sua chave)', de: deM, ate: ateM });
      return true;
    }

    // 🧮 PLANO DE COMPRA — o motor. Junta ritmo de venda (histórico), saldo e imagem (Bling) e custo
    // (_custos.json) e devolve, por SKU: quanto comprar pra cobrir lead time + cobertura desejada,
    // o quanto isso custa e QUANTO LUCRO ESTÁ EM RISCO se faltar. Ordenado pelo risco, não pelo volume.
    // Uso: /amb-checkout-offline/plano-compra?lead=4&cob=5&seg=0.5&base=180&curva=A

    /* ─── /magalu-debug ─────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/magalu-debug')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      const kG = lerChaveAdmin(req, urlObj);
      const sG = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kG === process.env.ADMIN_KEY) || (sG && ehAdmin(sG)))) { json(res, 404, { error: 'not found' }); return true; }
      const diaG = String(urlObj.searchParams.get('dia') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(diaG)) { json(res, 400, { ok: false, erro: 'use ?dia=AAAA-MM-DD&k=ADMIN_KEY' }); return true; }
      const outG = { dia: diaG, magalu: [], bling: { paginas: 0, pedidos: 0, datas: {}, amostra: [] }, casamento: null, erros: [] };
      /* Codex #575: o casamento usa TODOS os pedidos buscados, não só a amostra de 10 (que é só pra
         exibir). Com mais de 10 no dia, o pedido da Magalu cujo par vinha depois saía "não casa". */
      const chavesB = new Set();
      try {
        // o módulo magalu-oauth roda NO MESMO serviço — a chamada é local (foi o HTTP 404 da 1ª tentativa)
        // mesmos parâmetros que a CAÇA usa (empresa da env AMBBKP_MAGALU_EMPRESA e 40 páginas):
        // com 6 páginas o dia 31/07 voltou VAZIO — a listagem da Magalu vem do mais recente pro
        // mais antigo, então as primeiras 300 eram de agosto e o filtro do dia zerava tudo.
        const urlMg = 'http://127.0.0.1:' + (process.env.PORT || 3000) + '/magalu/pedidos-do-dia?empresa=' + encodeURIComponent(_env('MAGALU_EMPRESA') || EMPRESA) + '&desde=' + diaG + '&ate=' + diaG + '&paginas=40&k=' + encodeURIComponent(process.env.ADMIN_KEY || '');
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
            if (pd.numeroLoja) chavesB.add(String(pd.numeroLoja).trim());
            if (pd.numeroPedidoLoja) chavesB.add(String(pd.numeroPedidoLoja).trim());
            if (outG.bling.amostra.length < 10) outG.bling.amostra.push({ id: pd.id, numero: pd.numero, data: dtB, numeroLoja: pd.numeroLoja || null, numeroPedidoLoja: pd.numeroPedidoLoja || null, loja: lojaB });
          }
          if (lote.length < 100) break;
          await new Promise(r0 => setTimeout(r0, 300));
        }
      } catch (e) { outG.erros.push('bling: ' + String(e.message || e).slice(0, 140)); }
      try {
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

    /* ─── /sku-repara ───────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/sku-repara')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!_backfill) return semPeca(res, '_backfill');
      if (!_mgc) return semPeca(res, '_mgc');
      if (!_histCache) return semPeca(res, '_histCache');
      /* Codex #575: a trava é um `let` booleano da empresa — ocioso é `false`, então testar o VALOR
         tratava "ocioso" como peça ausente, e passar `true` caía no 409. Além disso um boolean
         destructurado é cópia: gravar nele não chega na empresa. Por isso a peça é um ACESSOR
         `{ get(), set(v) }`, e a ausência é testada separadamente do estado. */
      if (!_reparoAtivo || typeof _reparoAtivo.get !== 'function' || typeof _reparoAtivo.set !== 'function') return semPeca(res, '_reparoAtivo');
      const kR = lerChaveAdmin(req, urlObj);
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
      /* Checar `_backfill.rodando` UMA vez não basta: a varredura do catálogo logo abaixo demora,
         e um backfill iniciado no meio apaga e regrava o período com o SKU ANTIGO, desfazendo o
         reparo em silêncio. O reparo levanta a própria trava e os dois lados a respeitam. */
      if (_reparoAtivo.get()) { json(res, 409, { ok: false, erro: 'outro reparo de SKU em andamento — tente depois' }); return true; }
      _reparoAtivo.set(true);
      try {
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
          const q = 'vendas_historico?empresa=eq.' + EMPRESA + '&sku=eq.' + encodeURIComponent(deSku) + '&id=gt.' + ultId + '&select=id&order=id.asc&limit=1000';
          const rr = await supaReq(EMPRESA, 'GET', q, null);
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
      const rp = await supaReq(EMPRESA, 'PATCH', 'vendas_historico?empresa=eq.' + EMPRESA + '&sku=eq.' + encodeURIComponent(deSku), { sku: paraSku, sku_anterior: deSku });
      /* Codex (#185/#186): o PATCH mudou o histórico, mas o _histCache guarda os agregados por até
         30 min — sem limpar, o dashboard segue mostrando o SKU ANTIGO e o reparo parece ter
         falhado. Mesma limpeza que o backfill e a caça já fazem.
         E limpa depois do PATCH que DEU CERTO, não antes do segundo: quando o primeiro falha e
         entra o de reserva, uma consulta do dashboard no meio repovoava o cache com o dado velho,
         e nada mais limpava — os agregados ficavam errados até o TTL vencer. */
      const _limpaHist = () => { try { for (const _k of Object.keys(_histCache)) delete _histCache[_k]; } catch (e) {} };
      if (!rp.ok) {
        // sku_anterior pode não existir como coluna — tenta de novo só com o sku
        const rp2 = await supaReq(EMPRESA, 'PATCH', 'vendas_historico?empresa=eq.' + EMPRESA + '&sku=eq.' + encodeURIComponent(deSku), { sku: paraSku });
        if (!rp2.ok) { _limpaHist(); json(res, 200, { ok: false, erro: 'PATCH falhou: HTTP ' + rp.status + ' / ' + rp2.status, detalhe: String(rp.body || '').slice(0, 200) }); return true; }
        _limpaHist();
        outR.avisos.push('coluna sku_anterior não existe — gravado só o sku novo');
      } else _limpaHist();
      // 4) confere: não pode sobrar linha com o SKU antigo
      let sobrou = 0;
      try {
        const rc2 = await supaReq(EMPRESA, 'GET', 'vendas_historico?empresa=eq.' + EMPRESA + '&sku=eq.' + encodeURIComponent(deSku) + '&select=id&limit=5', null);
        if (rc2.ok) { const a2 = JSON.parse(rc2.body || '[]'); sobrou = Array.isArray(a2) ? a2.length : 0; }
      } catch (e) {}
      outR.atualizadas = outR.linhas - sobrou;
      outR.sobraram_com_sku_antigo = sobrou;
      if (sobrou) outR.avisos.push('ainda sobraram linhas com o SKU antigo — rode de novo');
      json(res, 200, outR);
      return true;
      } finally { _reparoAtivo.set(false); }


    }

    // SKU ÓRFÃO (13/08) — MEDIÇÃO pro caso do rename de SKU no Bling (achado no app de
    // Devoluções: a venda antiga guarda o SKU velho e, depois do rename, ninguém acha o produto;
    // o histórico do dashboard parte em dois no dia do rename). Antes de trocar a chave de
    // agregação por produto_id, esta rota MEDE o tamanho do problema: quantos SKUs do histórico
    // não existem mais no catálogo, e quanto faturamento está preso neles.
    // Uso: GET /amb-checkout-offline/sku-orfaos?de=AAAA-MM-DD&ate=AAAA-MM-DD&k=ADMIN_KEY
    // Só leitura. O catálogo é varrido INTEIRO (o filtro ?codigo= do Bling não é confiável —
    // ora volta vazio pra produto que existe, ora ignora o filtro), montando codigo → id.
    /* ═══ 21/08 — DE-PARA AUTOMÁTICO DE SKU RENOMEADO ═══════════════════════════════════════
    Nasceu do FL-1011-PRETO: renomeado no Bling para 3933398010054, o código antigo deixou de
    existir e as 53 vendas antigas ficaram sem custo. O Diego resolveu à mão pela planilha, mas
    isso vai acontecer de novo a cada rename.
    COMO DESCOBRE: o Bling troca o CÓDIGO e mantém o `id` do produto. O cache de custos guarda
    `{ id, custo }` por SKU — inclusive dos que já foram renomeados. Então: id do SKU velho no
    cache × código que esse mesmo id tem HOJE no catálogo = o par antigo→novo. Funciona
    retroativamente, não só pra renames futuros.
    NÃO altera nada sozinho: devolve os pares e o Diego decide (o `sku-repara`, que já existe,
    é quem troca no histórico). */

    /* ─── /tiktok-completar-tarifa ──────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/tiktok-completar-tarifa')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!completarTarifaTikTok) return semPeca(res, 'completarTarifaTikTok');
      const kT = lerChaveAdmin(req, urlObj);
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
    /* 06/09 — RAIO-X DE UMA VENDA. O canário insistia em acusar a 2000018258015754 mesmo com
       ela no Bling (entregue, NF emitida), e passamos cinco rodadas de conserto no escuro
       porque eu só via o resultado da comparação, nunca os dois lados. Esta rota mostra o que
       o ML responde e o que o Bling tem, lado a lado — pra o próximo caso ser resolvido em
       minutos em vez de rodadas. */

    /* ─── /varrer-fornecedores ──────────────────────────────────── */

    if (method === 'GET' && (p === (PREFIXO + '/varrer-fornecedores') || p === (PREFIXO + '/varrer-fornecedores-status'))) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!estadoVarrerForn) return semPeca(res, 'estadoVarrerForn');
      if (!varrerFornecedores) return semPeca(res, 'varrerFornecedores');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const _estV = estadoVarrerForn();
      if (p.endsWith('-status')) { json(res, 200, { ok: true, status: _estV }); return true; }
      if (_estV.rodando) { json(res, 200, { ok: false, msg: 'já está varrendo — acompanhe em /varrer-fornecedores-status', status: _estV }); return true; }
      const maxV = (urlObj.searchParams && urlObj.searchParams.get('max')) || '1000';
      varrerFornecedores(maxV).catch(e => { estadoVarrerForn().rodando = false; console.log('[FORNECEDORES] ' + e.message); });
      json(res, 202, { ok: true, msg: 'varredura iniciada em segundo plano (só leitura, não altera nada no Bling)', max: Number(maxV), status: (PREFIXO + '/varrer-fornecedores-status') });
      return true;
    }

    // testa se o Bling devolve a ETIQUETA em PDF (vs ZPL) p/ um pedido
    // uso: /amb-checkout-offline/debug-etiqueta-fmt/{idDoPedido}

    /* ─── /varrer-fornecedores-status ───────────────────────────── */

    if (method === 'GET' && (p === (PREFIXO + '/varrer-fornecedores') || p === (PREFIXO + '/varrer-fornecedores-status'))) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!estadoVarrerForn) return semPeca(res, 'estadoVarrerForn');
      if (!varrerFornecedores) return semPeca(res, 'varrerFornecedores');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const _estV = estadoVarrerForn();
      if (p.endsWith('-status')) { json(res, 200, { ok: true, status: _estV }); return true; }
      if (_estV.rodando) { json(res, 200, { ok: false, msg: 'já está varrendo — acompanhe em /varrer-fornecedores-status', status: _estV }); return true; }
      const maxV = (urlObj.searchParams && urlObj.searchParams.get('max')) || '1000';
      varrerFornecedores(maxV).catch(e => { estadoVarrerForn().rodando = false; console.log('[FORNECEDORES] ' + e.message); });
      json(res, 202, { ok: true, msg: 'varredura iniciada em segundo plano (só leitura, não altera nada no Bling)', max: Number(maxV), status: (PREFIXO + '/varrer-fornecedores-status') });
      return true;
    }

    // testa se o Bling devolve a ETIQUETA em PDF (vs ZPL) p/ um pedido
    // uso: /amb-checkout-offline/debug-etiqueta-fmt/{idDoPedido}
    return false;
  };
}

module.exports = { criarRotasPainel };
