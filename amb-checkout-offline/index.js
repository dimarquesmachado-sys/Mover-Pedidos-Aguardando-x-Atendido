'use strict';

/* 14/09 (auditoria, P2): a chave passa a ser lida do HEADER primeiro; a query
   continua aceita porque há dezenas de URLs salvas com &k= — cortar de uma vez
   quebraria o trabalho de quem opera pelo navegador. */
const { lerChaveAdmin } = require('../lib/http/chave-admin');
const { souAdmin } = require('../lib/http/admin-da-sessao');

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

/* 01/10 — ESTADO DAS ROTINAS PESADAS, por empresa. Fica AQUI NO TOPO de propósito: `_cst` e
   `_vsy` são usados milhares de linhas adiante, e declarar o require perto deles daria
   "Cannot access '_estadoRotinas' before initialization". O `node --check` não pega ordem de
   inicialização e a bateria também não — só o BOOT REAL acusa. É a razão de ele estar no
   checklist. */
const _estadoRotinas = require('../lib/checkout/estado-rotinas').estadoDe('amb');

/* 25/08 — reaplicarImposto e varrerCancelados saíram daqui: eram BYTE-A-BYTE iguais entre
   AMB e Girassol (só a empresa padrão mudava). Moram em lib/imposto-cancelados.js, com o
   ESTADO por empresa — uma variável só do módulo faria uma trancar a outra.

   ⚠️ A ponte fica AQUI EM CIMA de propósito, e o ctx é montado SOB DEMANDA (getters).
   A rotina noturna monta o contexto dela mais abaixo e passa `varrerCancelados` POR VALOR,
   o que executa no carregamento do módulo — mas quase tudo que a lib precisa (blingGet,
   readJson, supaCfg, CACHE_DIR, garantirSitCancel…) só nasce milhares de linhas adiante.
   Montar o ctx aqui de forma direta daria "Cannot access X before initialization" e o
   serviço nem subiria — foi o que o boot real acusou. Com getters, cada dependência só é
   lida quando a função roda. */
/* 19/10 (Fase 3): o contexto da varredura de cancelados e do reaplicar imposto — que era CÓPIA nesta pasta (igual
   byte a byte à da outra empresa, a menos das envs) — nasce do ligador único lib/checkout/cancelados-empresa, com a
   configuração de lib/checkout/config-empresa. Aqui só as peças do módulo, lidas NA HORA DA CHAMADA (várias só
   nascem milhares de linhas adiante — por isso deps é função). Já com os acertos do Codex #716 (gravação do arquivo
   do dia só com as marcas; espelho nos finalizados). */
const _canc = require('../lib/checkout/cancelados-empresa').criarCanceladosDaEmpresa('amb', {
  deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson, blingGet, garantirToken, garantirSitCancel, supaCfg, path, fetch,
    DEFAULT_ALIQ_BK: typeof DEFAULT_ALIQ_BK !== 'undefined' ? DEFAULT_ALIQ_BK : 0,
    histCache: typeof _histCache !== 'undefined' ? _histCache : null }),
});
const reaplicarImposto = (meses) => _canc.reaplicarImposto(meses);
const varrerCancelados = (dias)  => _canc.varrerCancelados(dias);
const estadoImposto    = () => _canc.estadoImposto();
const estadoCancelados = () => _canc.estadoCancelados();
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const https = require('https');
/* 05/11 (auditoria do Codex no SHA 208fdb7d, achado F05): o token do Bling DA PRÓPRIA EMPRESA (o mesmo que a base dela usa).
   Era o da GOOD -- a varredura de cancelados da AMB checava o token da GOOD antes de consultar o Bling: com o token da
   GOOD vencido (ou a GOOD desligada), a AMB perdia a fase do Bling sem nada errado com o Bling dela. */
const { garantirToken } = require('../ambtotal/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: AMBBKP_QZ_CERT (digital-certificate.txt) e AMBBKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.AMBBKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.AMBBKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

// logo OFICIAL da AMBTOTAL (drone + carrinho, enviado pelo Diego 10/08) — 128px em /icone.png pro favicon, PWA e atalho
const ICONE_B64  = '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';
const VERSAO     = 'amb-checkout-offline v26/08 b92';
/* 15/11 (norte C, rotas-cópia): ícone e manifesto do app pela peça — pra aba, favorito e atalho do celular */
const _rotasPwa = require('../lib/checkout/rotas-pwa').criar({ prefixo: '/amb-checkout-offline', nome: 'Intelig\u00eancia de Vendas \u00b7 AMBTotal', shortName: 'AMBTotal',
  descricao: 'Faturamento, margem, previs\u00e3o de vendas e plano de compra da AMBTotal', iconeB64: ICONE_B64, VERSAO });

// ── SESSÃO DE OPERADOR (cookie assinado HMAC) — protege rotas de dados/ação ──
// 15/11 (norte C): as 21 linhas iguais nas três empresas viraram a peça lib/checkout/sessao-operador (mesmo segredo,
// mesmo cookie, 14 h — o cookie vale nos três painéis, como já valia).
const { SESS_TTL, SESS_COOKIE, assinarSessao, validarSessao } = require('../lib/checkout/sessao-operador');

// ─── Módulos extraídos (Fase 1: base + nf + etiquetas) ───────────────────
const base = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESGATES_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;

/* pedidos sendo reabertos AGORA nesta empresa — trava contra duplo clique e contra duas pessoas
   na mesma tela, já que o caminho tem `await` no Bling. Estado do MÓDULO, não `global`: as três
   empresas rodam no MESMO processo e o `teste-estado-sem-global` proíbe a classe inteira — a
   empresa nova que copiasse o bloco herdaria a chave e travaria o pedido da outra. */

/* ⚠️ Resgate ATENDIDO <- DESPACHADOS (caso 5477): o Bling nao tem a transicao direta, entao desando
   por degraus. Fica FORA da rota porque o MESMO caminho serve ao pedido em limbo e ao que ainda esta
   no historico (Codex #651: a copia so no limbo deixava o historico com o erro original). */
/* 25/10: _degrausResgate, _detalheBling e _moverAtendidoDesandando são a peça única lib/checkout/resgate-atendido
   (eram idênticas nas três empresas) — aqui só o tag desta empresa */
const { _degrausResgate, _detalheBling } = require('../lib/checkout/resgate-atendido');
const { _moverAtendidoDesandando } = require('../lib/checkout/resgate-atendido').criarResgateAtendido({ tag: 'AMBBKP' });
/* `blingWrite` guarda o corpo do erro em `data`/`raw`, nao em `erro`: sem olhar la o popup so mostra o status. */


/* 15/09 — a capacidade "expedicao" e a env de VERIFICADO precisam CONCORDAR. São dois lugares
   diferentes e nada obriga o segundo a acompanhar o primeiro: declarar a capacidade e esquecer
   a env deixa o app de Expedição sem nada pra bipar, e o contrário deixa pedido parado num
   estado sem saída. Os dois são silenciosos — por isso a checagem grita no boot. */
{
  const _exp = require('../lib/checkout/conferir-expedicao').conferir({
    rotulo: 'AMBBKP',
    temExpedicao: require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade('amb', 'expedicao') === true,
    SIT_VERIFICADO,
    /* a Girassol NÃO desestrutura SIT_DESPACHADOS (quem move pra lá é o app de Expedição), e
       o lint pegou a suposição. Lendo do base direto, funciona nas três. */
    SIT_DESPACHADOS: require('./base').SIT_DESPACHADOS || 0,
  });
  if (!_exp.ok) console.error(_exp.aviso);
}
const { parseNF, acharNFporRange, nfDoPedido, serieDaNFdoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = require('./nf');
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
let _bf = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de valores
let _bfd = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de DETALHES (uf + valor por item)
let _skuInfoCache = null;   // cache em memória do sku-info (saldo/preço/custo)
let _mls = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null, erros: {}, amostras: [] };   // pesca de tarifas/frete REAIS do ML

// BACKFILL-NF LOCAL: lê nf-simp.json (cache/arquivo) e preenche vprod_nf nos conferidos sem ele.
// 100% disco, zero API — seguro pra rodar no cron diário e ao abrir o dashboard.
/* 25/10: o backfill das NFs do arquivo local é a peça única lib/checkout/backfill-nf-local (era idêntico nas três) */
const backfillNFLocal = require('../lib/checkout/backfill-nf-local').criarBackfillNFLocal({ ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, path, readJson, writeJson });
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');
const { enviarEmailDocs } = require('./email-docs');
const { listarAtendidos, detalhePedido, sincronizarConferidos, indexarCatalogoCompleto, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus, fullJaDespachado, unsFullEfetivas, UNS_EMISSAO_PROPRIA_CASA } = require('./ciclo');

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
/* 11/09 — fatia 3 da desduplicação: a sessão da Shopee (cookie do painel, que vence e
   precisa sobreviver a deploy) era ~88 linhas iguais nas duas empresas. Só o NOME da env
   muda por empresa — virou parâmetro; o resto é lib/checkout/shopee-sessao.js. */
const _shopeeSessao = require('../lib/checkout/shopee-sessao').criar({
  CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE, TAG: 'AMBBKP',
});
const { shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, shopeeKeepAlive, SHOPEE_CAB, SHOPEE_SESSAO_FILE,
        _shopeeHash, _urlStatus } = _shopeeSessao;



/* ═══ 22/08 — CUSTO: agora vem de lib/custo.js (código único das 3 empresas) ═════════════
   Estas 15 funções estavam escritas 3× (uma por empresa) e a GOOD já tinha ficado sem 5
   delas — o de-para inteiro. Metade dos erros de 21/08 foi "corrigi numa e esqueci da
   outra". Aqui fica só a ponte: o ctx com o que é DESTA empresa; a regra vive num lugar só.
   `skuInfoCache` vai por getter porque a lib limpa o cache de 6h quando o custo muda. */
/* 16/11 (montarCheckout, passo 5): o custo da empresa é a peça lib/checkout/custo-empresa — o contexto do lib/custo, os atalhos de custo
   manual/vigência/de-para/nome e o vendas-ops (recálculo, fornecedores, estados), com o que é DESTA empresa. Os nomes continuam os
   mesmos; o cache do sku-info e o do histórico chegam por função porque nascem mais abaixo neste arquivo. */
const _custoEmp = require('../lib/checkout/custo-empresa').criar({ empresa: 'amb', CACHE_DIR, path, fs, readJson, writeJson, blingGet,
  skuInfoCache: () => (typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null), histCache: () => _histCache });
const { _ctxCusto, lerCustosManuais, gravarCustosManuais, custoManualDe, comCustosManuais, parsearCustosColados, telaCustosManuais,
  lerVigencias, gravarVigencias, registrarCustoVigente, custoVigenteEm, lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku,
  resolverNomeSku, carregarCatalogoDePara, _hojeISO, _ontemISO, _diaAntes, buscarDevolucoesML, varrerFornecedores, reaplicarCusto, estadoReapCusto, estadoVarrerForn } = _custoEmp;

/* 16/11 (norte C, montarCheckout passo 8): a VENDA DO DIA desta empresa — o estado, o canal pelo número, a pesca do ML, o
   frete da Magalu, a fase direta (o serviço da Shopee e o token do ML pela configuração da empresa, lib/checkout/config-empresa),
   a venda do dia e a pesca das tarifas do ML nos conferidos — é a peça lib/checkout/vendas-dia-empresa, a mesma das três.
   Aqui só o que é da AMB, por acessor (lido na hora). O texto que ficava aqui está em docs/HISTORICO-VENDAS-DIA.md. */
const _rotVendas = require('../lib/checkout/vendas-dia-empresa').criar({
  empresa: 'amb',
  versaoCustos: 1,   /* a versão do marcador de custos do ML que ela grava nos conferidos — 1: a marca simples, só relê quem não tem */
  pecas: {
    get CACHE_DIR() { return CACHE_DIR; },
    get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
    get LOJA_MKT() { return LOJA_MKT; },
    get blingGet() { return blingGet; },
    get readJson() { return readJson; },
    get writeJson() { return writeJson; },
    get json() { return json; },
    get nfDoPedido() { return nfDoPedido; },
    get resolverProdutoPorSku() { return resolverProdutoPorSku; },
    get custoEmpresa() { return _custoEmp; },
    get _mls() { return _mls; },
    set _mls(v) { _mls = v; },
  },
});
const { _inferCanal, pescarDadosML, vendasSync, mlSyncFees, magaluFreteSkuLer, magaluFretePrevistoSku } = _rotVendas;


/* 15/11 (norte C): o keep-alive da Shopee é a peça (shopee-sessao.shopeeKeepAlive, com o tag desta empresa) */

const _rotasCatalogo = require('../lib/checkout/rotas-catalogo').criar({
  prefixo: '/amb-checkout-offline', json, blingGet, ehAdmin, skuEanCache, lerIndiceEan, salvarNoIndiceEan,
  getPossiveisGtins, produtoDetalhe, primeiraImagem, locCache, localizacaoDeProduto,
  indexarCatalogoCompleto, getIdxStatus,
});

// ─── Rotas HTTP (namespaced) ────────────────────────────────────────────
// A rotina noturna precisa das funcoes deste arquivo, entao e montada aqui.
// O agendador da RAIZ registra sozinho qualquer chave nova de `crons` que tenha
// uma funcao de mesmo nome em `rotinas` — nao precisa mexer no index da raiz.
/* 06/09 — mapa venda↔pack do faturamento do ML, pra o canário fechar os carrinhos. O billing
   guarda a venda em `o` e o pack em `p`; com isso dá pra saber quais vendas são o mesmo
   pacote. Monta uma vez por rodada e reusa (o arquivo tem ~96 mil tarifas; ler a cada pedido
   seria o mesmo erro de memória do #327). */
/* 11/09 — fatia 4 da desduplicação: packs do ML (carrinho) em lib/checkout/packs-ml.js.
   Eram 29 linhas iguais nas duas empresas; resolvem uma coisa só — quais números de pedido
   são irmãos do mesmo carrinho, pra não cobrar frete duas vezes nem separar em duas caixas. */
const _packsML = require('../lib/checkout/packs-ml').criar({
  /* preguiçoso: MLB_FILE é declarado ADIANTE neste arquivo, e passar o valor aqui dava
     "Cannot access before initialization" no boot — o mesmo tropeço da fatia 2, pego de
     novo pelo boot real do CI e não pela sintaxe. */
  MLB_FILE: (...a) => MLB_FILE(...a),
  readJson,
});
const { _carregarPacks, _irmasDoPack } = _packsML;


/* 23/10 (passo 2): os ADAPTADORES do canário (listar no Bling e nos marketplaces, pacote do ML) eram cópia aqui e na
   Girassol (iguais a menos do token do ML, da chave da Shopee e da conta do TikTok). Agora são a peça única
   lib/checkout/canario-empresa, com o que é da AMB vindo da configuração única. A AMB não tem o importador do ML: o
   conserto só avisa (a faixa aparece no painel pro admin). */
const _canEmp = require('../lib/checkout/canario-empresa').criarCanarioDaEmpresa('amb', {
  deps: () => ({ blingGet, LOJA_MKT, irmasDoPack: _irmasDoPack, CACHE_DIR, pedirAoSync, fetch }),
  /* o backfill DESTA empresa (o do mês e o do ano): o canário espera — os dois brigam pela cota do Bling */
  ocupado: () => { const anoR = false;   /* 15/11: o ano é o plano em disco — a fatia em curso aparece no _backfill */
    return { rodando: !!((_backfill && _backfill.rodando) || anoR), de: _backfill && _backfill.de, ate: _backfill && _backfill.ate, do_ano: !!anoR }; },
});
const _listarNoBlingCanario = (...a) => _canEmp.listarNoBling(...a);
const _listarNoMarketplaceCanario = (...a) => _canEmp.listarNoMarketplace(...a);
const _packDaVendaCanario = (...a) => _canEmp.packDaVenda(...a);
const _ordensDoPackCanario = (...a) => _canEmp.ordensDoPack(...a);
const _canario = _canEmp.estado;   /* o estado do canário é o da peça (o backfill daqui lê `rodando`) */

// Codex (#105): o cache do TikTok só era escrito pela rota admin — envelhecia sozinho e
// levava junto a tarifa real e a hora da venda. A noturna passa a atualizá-lo.
/* 13/09 — fatia 6 da desduplicação: este wrapper era idêntico nas duas empresas, com a
   ÚNICA diferença sendo a chave 'amb'. Foi pra lib/tiktok-financeiro.js com a empresa como
   PARÂMETRO — o caso mais puro da regra da casa, e o que faz empresa nova só precisar
   passar a própria chave em vez de herdar mais uma cópia. */
const coletarFinanceiroTikTok = require('../lib/tiktok-financeiro').criarColetorDaEmpresa('amb', {
  carregarTikTok: () => require('../tiktok-oauth'),
  fs: require('fs'), path: require('path'),
});

async function conferirMarketplaces(dias, canais, opts) {
  /* 23/10 (passo 2): a conferência é a da peça única lib/checkout/canario-empresa (com a trava do backfill daqui) */
  return _canEmp.conferir(dias, canais, opts);
}


// ── COMPLETAR A TARIFA DO TIKTOK SEM BACKFILL (18/08) ───────────────────────────
// Venda recente entra com a tarifa do BLING porque a liquidação do TikTok demora dias.
// Antes, corrigir exigia rodar o backfill do período inteiro (horas, apaga e regrava, já
// custou dado perdido 2×). Isto atualiza SÓ comissao/frete/margem das linhas defasadas.
/* 24/10: a correção da tarifa do TikTok é a peça lib/tiktok-completar (o completador DA empresa) — era cópia aqui */
const completarTarifaTikTok = require('../lib/tiktok-completar').criarCompletadorDaEmpresa('amb', {
  supaReq: (...a) => supaReq(...a),
  aoAtualizar: () => { for (const k of Object.keys(_histCache)) delete _histCache[k]; },
});

const _noturna = criarNoturna({
  /* 14/11: a foto diária da reputação do Mercado Livre (lib/checkout/reputacao-ml) precisa do token do ML DESTA empresa */
  garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
  /* 15/11: a foto diária da saúde da conta na Shopee (lib/checkout/saude-shopee) precisa do pedido à Shopee DESTA empresa */
  pedirAoSync: (...a) => pedirAoSync(...a),
  // 10/08 (Codex P2): o canário PRECISA do contexto — sem ele, rotasCanario(undefined)
  // explodia no destructure, o catch engolia, e a etapa noturna dizia "conferido"
  // sem ter conferido NADA. (A Girassol tem o mesmo defeito — consertar lá também.)
  mlBillingSync, backfillVendas, backfillEstado, mlSyncFees, varrerCancelados,
  /* 14/10: resgate do historico — pedido que nasce hoje com data de venda antiga (boleto/Pix
     tardio) ficava fora da janela de 3 dias pra sempre. A peca descobre os dias e manda o
     backfill de producao rodar cada um. Regra em lib/checkout/backfill-resgate.js */
  resgatarHistorico: (plano) => require('../lib/checkout/backfill-resgate').resgatar({ empresa: 'amb', blingGet, supaReq, backfillVendas, backfillEstado,
    /* Codex #683 (P1): as DUAS fontes de cancelado que o backfill usa, senao cancelado vira 'faltando' pra sempre */
    situacoesCanceladas: async () => (await garantirSitCancel(async p => await blingGet(p))).ids,   /* r5: a funcao exige o getter — sem ele devolvia lista vazia */
    canceladosMkt: () => new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {}))),
    /* Codex #683 r2 (P1): a listagem do resgate segura a MESMA vaga do backfill (_backfill.rodando),
       senao um backfill manual iniciado no meio disputaria a cota. Libera antes de cada dia e no finally */
    /* Codex #683 r3 (P1): as OUTRAS travas de cota tambem valem — canario conferindo o Bling e a
       rodada do ano (que entre um mes e outro deixa _backfill.rodando=false por 2,5s) */
    reservar: (msg) => { if (_backfill.rodando || _canario.rodando || _reparoAtivo || (_cacaMgAmb.estado() && _cacaMgAmb.estado().rodando)) return false;   /* r4: sku-repara tambem */ _backfill.rodando = true; _backfill.fase = 'resgate'; _backfill.msg = msg || 'resgate'; return true; },
    liberar: () => { if (_backfill.rodando && _backfill.fase === 'resgate') { _backfill.rodando = false; _backfill.fase = 'resgate-liberado'; } },
    cacheDir: CACHE_DIR }, plano),
  canarioCron: () => canarioCron({ VERSAO, validarSessao }),
      // AMB: a poda do bucket de expedição roda UMA vez, na noturna da Girassol (bucket é compartilhado)
      podarExpedicao: async () => ({ ok: true, pulado: 'poda do bucket roda na noturna da Girassol' }),
  // 06/08: a Shopee tambem passa a se manter sozinha — devolucoes (por SKU e motivo) e
  // carteira (ads, ajustes, reembolsos), as duas em janelas de 15 dias, guardando no disco.
  coletarDevolucoes: (d) => coletarDevolucoes(d || 45, pedirAoSync),
  conferirMarketplaces,   // 17/08: canário marketplace × Bling também na AMB
  consertarDoCanario: (r) => _canEmp.consertar(r),   // 23/10 (Codex #731): a noturna registra o resultado (o aviso do painel lê o histórico)
  completarTarifaTikTok,   // 18/08: corrige a tarifa das vendas que já liquidaram
  coletarFinanceiroTikTok,   // Codex #123 (P1): sem passar aqui, a etapa de coleta da noturna era PULADA na AMB e o cache nunca se atualizava sozinho
  cacheDir: CACHE_DIR,   /* 27/10: os dias da Shopee sem repasse (lib/checkout/repasse-pendente) */
  coletarAds,   // 14/08: ads da Shopee também se mantém sozinho
  coletarCarteira:   (d) => coletarCarteira(d || 30, pedirAoSync),
  VERSAO, validarSessao, ehAdmin, json
});

/* 30/10 — as ROTAS DE LOTE do checkout (peça única lib/checkout/rotas-lote — eram só da GOOD): etiquetas em MASSA
   (o ZIP da Shopee: cada etiqueta casa com o pedido pela NF de dentro dela), a página de envio e as DANFEs em lote.
   Montada na 1ª chamada, que recebe o `readBody` do handler. Só admin. */
let _rotasLoteAmb = null;
function _rotasLote(readBody) {
  if (!_rotasLoteAmb) _rotasLoteAmb = require('../lib/checkout/rotas-lote').criarRotasLote({
    prefixo: '/amb-checkout-offline', tag: 'AMBBKP', nome: 'AMB', empresaAviso: 'amb',
    CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody, readJson, writeJson, ensureDir, manifest,
    validarSessao, ehAdmin, baixarDanfe,
  });
  return _rotasLoteAmb;
}

/* 31/10 — as ROTAS COMUNS do checkout (peça única lib/checkout/rotas-comuns): montada na 1ª chamada, que recebe o
   `readBody` do handler; da empresa só o prefixo, o nome no log, a chave e as peças dela */
let _rotasComunsAmb = null;
function _rotasComuns(readBody) {
  if (!_rotasComunsAmb) _rotasComunsAmb = require('../lib/checkout/rotas-comuns').criarRotasComuns({
  /* 09/11: o e-mail do código da coleta usa a MESMA conta e o MESMO estoque do e-mail da etiqueta desta empresa */
  emailEmpresa: () => ({ SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST }),
  /* 08/11 (rotas comuns, passo 10b): o que o /config-fiscal usa — as alíquotas, o cache do histórico e a reaplicação DESTA empresa */
  ALIQ_PADRAO: DEFAULT_ALIQ_BK, ALIQ_APURADOS, lerHistCache: () => _histCache, reaplicarImposto: (m) => reaplicarImposto(m),
  /* 08/11 (rotas comuns, passo 9b): o que o /sku-info usa — o cache, o contexto de custo e a busca do produto DESTA empresa */
  _ctxCusto, comCustosManuais: (...a) => comCustosManuais(...a), resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a), lerSkuInfoCache: () => _skuInfoCache, gravarSkuInfoCache: (v) => { _skuInfoCache = v; },
  /* 07/11 (rotas comuns, passo 8): o que o /custo-sync usa — o estado e o motor de custo DESTA empresa */
  _cst, custoSyncTravado: (...a) => custoSyncTravado(...a), custoRetryPendente: () => custoRetryPendente(), travaPesada, _urlStatus, _cstDiario, _diaFechadoDoDisco: (...a) => _diaFechadoDoDisco(...a),
  /* 07/11 (rotas comuns, passo 7): a TELA do dashboard desta empresa (a configuração dela) -- a rota é da peça */
  htmlDashboard: () => require('../lib/checkout/painel/empresas').painelDaEmpresa('ambtotal'),
    prefixo: '/amb-checkout-offline', tag: 'AMBBKP', empresa: 'amb',
    reaplicarCusto,   /* 12/11: o recálculo das vendas ao lançar/apagar custo (rotas comuns) */
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, JANELA_DIAS, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, RESERVAS_FILE, RESGATES_FILE, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, VERSAO, _detalheBling, _diaAntes, _hojeISO, _moverAtendidoDesandando, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, estadoImposto, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, moverSituacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    mmEtiquetas: () => require('../amb-mm-etiquetas'), mlTokenManager: () => require('../ambtotal/mlTokenManager'),
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'), skuReparaNoHistorico: true,
  });
  return _rotasComunsAmb;
}

function routes(readBody) {
  /* 14/11 — AS CINCO PEÇAS DE ROTA DA OPERAÇÃO (contagem de estoque, separação, backfill, NF anexada, conferido) são
     ligadas pela peça lib/checkout/rotas-operacao — a mesma pras três. O prefixo da URL, a pasta, a env do depósito e
     o id da empresa saem da configuração dela (lib/checkout/config-empresa); aqui vão só as peças DESTE arquivo.
     ⚠️ Criado DENTRO do routes porque o `readBody` chega como PARÂMETRO daqui: fora, o boot cai com
     "readBody is not defined" (já aconteceu duas vezes — numa o lint pegou, na outra só o boot). */
  const _rotasOperacao = require('../lib/checkout/rotas-operacao').criar('amb', {
    readBody, tag: base.tag,
    /* 27/10: a TELA da contagem é a peça única (lib/checkout/painel/contagem) com a marca do painel desta empresa */
    marca: require('./painel-marca'),
    json, readJson, writeJson, ensureDir, sleep, PAUSA_MS, VERSAO, CACHE_DIR,
    validarSessao, ehAdmin, lerAdmins, lerChaveAdmin,
    blingGet, blingWrite, lerReservas, locCache, localizacaoDeProduto, salvarLoc, montarSeparacao, montarSeparacaoPorPedido,
    lerIndiceEan, getIdxStatus, produtoDetalhe, detalhePedido, backfillNFLocal,
    mlSyncFees, shopeeKeepAlive, shopeeSessaoLer,
    moverSituacao, arquivarFinalizado, sincronizarConferidos, rodarCiclo,
    RESERVAS_FILE, LOC_LOG_FILE, CONFERIDOS_FILE, MANIFEST_FILE, SHOPEE_ENV_COOKIE, SIT_VERIFICADO, SYNC_ON,
    /* ESTADO VIVO, por REFERÊNCIA e DESTA empresa: o progresso do backfill e da pesca das tarifas do ML (dois backfills
       de empresas diferentes não dividem contador) */
    statusValores: _bf, statusDetalhes: _bfd, statusMlSync: _mls,
    /* só quando o ciclo MOVE o Full pra DESPACHADOS (#701); destino 0 = desligado, o Full segue pro VERIFICADO
       (Codex #702). A opção e o bloco do ciclo mudam JUNTOS. */
    fullJaDespachado,
    FULL_VAI_DESPACHADOS: !!require('./base').SIT_DESPACHADOS,
  });

  // histórico/análise: histCache vai por REFERÊNCIA — o backfill e o /backfill-limpar
  // esvaziam esse mesmo objeto aqui no index e isso tem que valer lá dentro também.
  /* 31/10: o DIAGNÓSTICO (peça única lib/checkout/diagnostico-empresa, como a Girassol) — chamado POR ÚLTIMO no handler */
  const diag = require('./amb-diagnostico').rotasDiagnostico({ VERSAO, validarSessao, supaCfg, readBody });
  const hist = rotasHistorico({ validarSessao, supaCfg, DEFAULT_ALIQ_BK, histCache: _histCache, magaluFretePrevistoSku,
    /* 14/11 — O GATILHO DO CUSTO, que só a GOOD tinha: quando o histórico aberto no dashboard tem produto que vendeu SEM
       custo, a sincronização de custo começa na hora (com a re-tentativa da peça: 3 em 3 min, até 5 rodadas), em vez de
       esperar a manutenção de 6 h. Decisão do dono, com o número na mão: em 01–13/11 as duas vieram com ZERO produto sem
       custo — o gatilho só dispara quando aparece um, então quase não toca na cota do Bling. */
    aoPublicarSkusSemCusto: () => { try { custoSyncTravado(false, true).catch(() => {}); } catch (e) {} } });
  const pesca = rotasPescaria({ validarSessao, supaCfg, supaReq, pescarDadosML });
  const canario = rotasCanario({ VERSAO, validarSessao });
  const limpeza = rotasLimpeza({ validarSessao });
  const shopee = rotasShopee({ validarSessao });


  /* 15/11 — A CABEÇA COMUM DO ROUTES (lib/checkout/cabeca-routes): /api/contexto → /descobrir-ids → PORTÃO DE SESSÃO →
     catálogo → sonda dos cancelados → as cinco peças da operação, na ordem de sempre (o portão ANTES de catálogo,
     cancelados e operação — Codex #480). O que é da empresa (prefixo, pasta, token do ML, conta do TikTok, envs e padrões
     do /descobrir-ids) vem de lib/checkout/config-empresa; aqui só as peças DESTE arquivo. */
  const _cabeca = require('../lib/checkout/cabeca-routes').criar('amb', {
    json, lerChaveAdmin, blingGet, validarSessao, ehAdmin, manifest, lerConferidos: () => readJson(CONFERIDOS_FILE, {}),
    uiBuild: require('./painel-marca').UI_BUILD,   /* 27/10: a versão do painel vem da marca (o painel é a peça única) */
    rotasCatalogo: _rotasCatalogo, rotasOperacao: _rotasOperacao,
  });
  const FOTO_V = 6;   // v6: procura foto em TODOS os cadastros do mesmo SKU (multiloja)   // v5: sem o fallback de SKU-base (mostrava foto de 1 lâmpada no kit de 9)   // v3: busca livre quando o código não acha + foto do componente do kit
  async function _rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === '/amb-checkout-offline/backfill-status')) return false;
    const kD = lerChaveAdmin(req, urlObj);
    const sessD = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
    json(res, 200, { ok: true, status: _backfill,
      plano: _planoAmb.status() });   /* 11/11 (4e): + o plano em fatias; 15/11: o ano É o plano (o `ano` em memória saiu) */
    return true;
  }
  /* 16/11 — A FILA DE PEÇAS DE ROTA É A PEÇA lib/checkout/rotas-empresa (a mesma ordem nas três; a fábrica do painel por
     último, as rotas próprias antes das compartilhadas). Aqui só o que é desta empresa: cada passo com as peças dela.
     Os comentários do `handle` antigo (a história de cada rota e de cada decisão de ordem) estão em docs/HISTORICO-HANDLE-ROTAS.md. */
  const _rotas = require('../lib/checkout/rotas-empresa').criar('amb', {
    cabeca: _cabeca,
    comuns: (req, res, urlObj, method, p) => _rotasComuns(readBody).handle(req, res, p, method, urlObj),
    lote: (req, res, urlObj, method, p) => _rotasLote(readBody).handle(req, res, p, method, urlObj),
    planoAno: (req, res, urlObj, method, p) => _planoAmb.rotaAno(req, res, urlObj, method, p),
    plano: (req, res, urlObj, method, p) => _planoAmb.rota(req, res, urlObj, method, p),
    pwa: (req, res, urlObj, method, p) => _rotasPwa(req, res, p, method),
    canEmp: (req, res, urlObj, method, p) => _canEmp.rotas({ PREFIXO: '/amb-checkout-offline', json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p),
    backfillStatus: _rotaBackfillStatus,
    /* 16/11 (passo 2): semear o cookie e consultar a devolução da Shopee — peça das três (eram as rotas próprias da AMB) */
    shopeeSessao: require('../lib/checkout/rotas-shopee-sessao').criar({ PREFIXO: '/amb-checkout-offline', VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody,
      readJson, writeJson, ensureDir, fetch, sessao: _shopeeSessao, SHOPEE_ENV_COOKIE }),
    proprias: [],
    deParaSku: (req, res, urlObj, method, p) => _rotaDeParaSku(req, res, urlObj, method, p),
    hist: (req, res, urlObj) => hist(req, res, urlObj),
    pesca: (req, res, urlObj) => pesca(req, res, urlObj),
    canario: (req, res, urlObj) => canario(req, res, urlObj),
    limpeza: (req, res, urlObj) => limpeza(req, res, urlObj),
    noturna: (req, res, urlObj) => _noturna.rotas(req, res, urlObj),
    shopee: (req, res, urlObj) => shopee(req, res, urlObj),
    diag: (req, res, urlObj) => diag(req, res, urlObj),
    painel: { montar: () => {
    const _f = require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({
        empresa: 'amb', prefixo: '/amb-checkout-offline',
        nomeEmpresa: 'AMBTotal',
        rotasProprias: ['canario-marketplaces', 'custo-historico', 'custo-sync', 'magalu-cancelados', 'reaplicar-status', 'tiktok-custo-devolucoes',],
        pecas: { /* 11/11 (4d, /etiqueta-diag): a etiqueta, o manifesto e as pastas DESTE checkout */ baixarEtiquetaPDF, MANIFEST_FILE, salvarManifest, ensureDir, /* 10/11 (4d, /buscar-pedido): */ nfDoPedido, /* 09/11 (último grupo na fábrica): a trava do reparo de SKU (acessor — a empresa guarda o valor) */ _reparoAtivo: { get: () => _reparoAtivo, set: (v) => { _reparoAtivo = v; } }, /* 09/11 (grupo cancelados/sync/diagnóstico na fábrica): */ configFreteMagalu: true, _inferCanal, sleep, PAUSA_MS, dataISO, /* 08/11 (grupo do ML, parte 2, na fábrica): o módulo do ML da AMB pro /setup-ml (a cópia fazia o require dentro da rota) */ get mlTokenManager() { return require('../ambtotal/mlTokenManager'); }, /* 08/11 (grupo do ML, parte 1, na fábrica): o token do ML DESTA empresa, na hora (a cópia fazia o require dentro da rota) */ garantirTokenML: (...a) => require('../ambtotal/mlTokenManager').garantirTokenML(...a), /* 08/11 (grupo do backfill na fábrica): */ _canario, json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR,
                 fsx: fs, pathx: path, readBody, estadoRotinas: _estadoRotinas,
                 /* todas as obrigatórias de uma vez: a fábrica confere no BOOT, e descobrir
                    uma por rodada é o padrão que já custou horas hoje */
                 ehAdmin, travaPesada, _urlStatus, LOJA_MKT, CONFERIDOS_FILE, blingGet,
                 custoSyncTravado,
                 /* ⚠️ Codex #622 (P1): ao tirar a cópia do `custos-manuais`, o cache vivo de SKU
                    deixou de chegar à lib. O handler antigo chamava `gravarCustosManuais` com
                    `_ctxCusto`, que expõe `_skuInfoCache` por GETTER; a montagem não passava
                    nada. Efeito: mudar um custo manual limpava só o cache de DISCO, e as
                    entradas já em memória seguiam servindo o custo ANTIGO por até 6h — margem
                    velha no painel, sem nada indicando.
                    Vai por GETTER de propósito: valor fixo capturaria o cache de hoje e perderia
                    a troca de referência que o `/sku-info` faz. */
                 get skuInfoCache() { return typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null; },
                 /* 02/10 — as peças que as rotas da fábrica usam. Sem elas a rota MONTA mas
                    RECUSA, que é pior que não existir. Passar a peça vem ANTES de apagar a
                    cópia — provei isso removendo três de uma vez e vendo duas recusarem. */
                 reaplicarImposto, estadoReapCusto, varrerCancelados, varrerFornecedores,
                 estadoVarrerForn, estadoCancelados,
                 /* passo a peça, mas NÃO removo a cópia de `/canario-marketplaces` neste PR:
                    aquela rota VAI AO MARKETPLACE, e comparar as duas respostas exigiria
                    disparar a conferência duas vezes — gasto de cota da conta, que em dia de
                    galpão tira pedido da bipagem. Remoção dela fica pra uma rodada fora do
                    horário, com o dono avisado. */
                 conferirMarketplaces,
                 /* as 19 que a AMB já tinha e não passava — ver o comentário da montagem */
                 /* 02/10 — mais 4, importadas no TOPO do arquivo e exportadas pelos módulos.
                    Vão diretas: conferi uma a uma que a fábrica as usa como VALOR — getter
                    devolveria a função em vez do dado, erro que quase subi antes.
                    ⚠️ `responderCusto` FICOU DE FORA: ela é declarada na linha 1545, DENTRO do
                    bloco de uma rota, então não existe no ponto da montagem. O eslint do CI
                    pegou ("responderCusto is not defined") e a fábrica deixou de montar — duas
                    rotas da AMB pararam. Tirar do escopo errado é trabalho de outro PR. */
                 SIT_DESPACHADOS, serieDaNFdoPedido, UNS_EMISSAO_PROPRIA_CASA, unsFullEfetivas,
                 /* 02/10 — mais 3. Fui procurar estas na /lib e descobri que NÃO DÁ COMO EU
                    IMAGINAVA: `lib/checkout/base-funcoes`, `produtos` e `historico` não
                    exportam as funções soltas — exportam uma FÁBRICA (`criar`), e as peças
                    saem de dentro dela, com configuração. "Acrescentar o import" não existe
                    nesses casos.
                    Mas as três abaixo a AMB JÁ TEM, de cópias locais (`./produtos`, `./ciclo`,
                    `../ambtotal/mlTokenManager`), declaradas no topo do arquivo — alcançam a
                    montagem. Passo estas; trocar as cópias locais pela lib é outro trabalho. */
                 primeiraImagem, detalhePedido,
                 /* ⚠️ `garantirTokenML` FICOU DE FORA: o require está na linha 521, mas DENTRO
                    da função `_tokenMLCanario` — posição no arquivo não é escopo, e eu me
                    enganei de novo com isso. O teste pegou ("a fábrica NÃO montou"), que é
                    exatamente o que ele passou a cobrar depois do #590. */
                 CUSTO_FILE_DIARIO, FOTO_V, MLB_FILE, _backfill, _histCache, _mgc: _cacaMgAmb.estado(), _mlb, _mlcred, aplicarCreditosFlex, backfillVendas, cacaMagalu, completarTarifaTikTok, custoDiario, mlBillingSync, reaplicarCusto, supaCfg, supaCount, supaReq, vendasSync,
                 /* Codex #587: `_sitCancel` é `let` reatribuído — vai como função, senão o
                    status devolve situacoes_descobertas: null */
                 sitCancel: () => _sitCancel,
                 /* Codex #622: `custos-manuais` passou a ser da fábrica. O cache vivo do sku-info
                    vai por GETTER (a lib de custo o limpa quando o custo muda); sem ele só o
                    disco era limpo e a memória servia o custo antigo por até 6h. */
                 envPrefixo: 'AMBBKP_' },
      });
      console.log('[AMB] rotas compartilhadas do painel montadas');
      return (req, res, urlObj, method, p) => _f(req, res, p, method, urlObj);
    } },
  });
  const handle = _rotas.handle; handle.passos = _rotas.passos;   /* os passos ficam visíveis pro teste de ordem (scripts/teste-rotas-empresa.js) */
  return handle;
}

// roda 1 ciclo logo após o boot do serviço

// ─── Supabase (histórico de vendas) — grava via REST; empresa escolhe as env vars ────────────
/* ═══ 22/08 — SUPABASE: agora vem de lib/supabase.js (código único) ══════════════════════
   supaReq e supaCount eram BYTE-A-BYTE idênticas entre AMB e Girassol; a supaCfg só mudava
   no padrão da empresa, que virou parâmetro. As envs continuam as mesmas:
   SUPABASE_URL_VENDAS_<EMPRESA> / SUPABASE_KEY_VENDAS_<EMPRESA>. */
const _supa = require('../lib/supabase').para('amb');
const supaCfg   = (empresa)                    => _supa.cfg(empresa);
const supaReq   = (empresa, metodo, pq, body)  => _supa.req(empresa, metodo, pq, body);
const supaCount = (empresa, filtro)            => _supa.count(empresa, filtro);

// ─── Busca as DEVOLUÇÕES (type 'returns') recentes do ML + o frete de retorno de cada ──────
// Retorna mapa { order_id(string): {claim_id, stage, aberta, data, frete_retorno, destino, dev_status} }.
// Ignora o ruído (cancel_purchase/mediations/cancel_sale) — só devolução física que gera prejuízo.
// destino 'warehouse' = vai pro ML (frete de retorno cobrado do vendedor); 'seller_address' = volta pro galpão.

// ─── 🛒 CAÇA DA MAGALU — a PEÇA ÚNICA (lib/checkout/magalu-caca, 29/10/2026): era o bloco de ~340 linhas daqui; aqui só
// o que é da AMB (a chave dela nas rotas /magalu/, as alíquotas, o banco de frete por SKU, a trava do reparo e o cache).
const _cacaMgAmb = require('../lib/checkout/magalu-caca').criarCacaMagalu({
  empresa: 'amb', magaluEmpresa: () => process.env.AMBBKP_MAGALU_EMPRESA || 'amb',
  supaReq: (...a) => supaReq(...a), blingGet: (...a) => blingGet(...a), readJson: (...a) => readJson(...a), CACHE_DIR,
  DEFAULT_ALIQ_BK: () => DEFAULT_ALIQ_BK, magaluFreteSkuLer: () => magaluFreteSkuLer(), reparoAtivo: () => _reparoAtivo,
  histCache: () => _histCache,
});
const magaluLinhas = (...a) => _cacaMgAmb.magaluLinhas(...a);
const cacaMagalu = (...a) => _cacaMgAmb.cacaMagalu(...a);
const cacaMagaluCron = () => _cacaMgAmb.cacaMagaluCron();

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
/* 18/09 — QUAIS MESES SÃO APURADOS E QUAIS SÃO ESTIMATIVA. O comentário acima sempre disse
   isso em prosa, mas o código não distinguia: a tabela era uma lista de números iguais, e a
   tela nova da GOOD (que diz "apurada" ao lado de cada mês) chamaria ESTIMATIVA de apurada se
   fosse portada assim. Chamar palpite de dado apurado é a mentira mais cara que esta tela
   poderia contar — o dono confere o DAS por cima de um número que ele acha conferido.
   O ritual dele é mensal: estima o mês, e por volta do dia 20 a contabilidade manda a
   apuração; é aí que o valor certo entra pelo ⚙️. Esta lista é o que separa um do outro. */
const ALIQ_APURADOS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const DEFAULT_ALIQ_BK = { '2026-01':4.0, '2026-02':4.0, '2026-03':4.0, '2026-04':4.0, '2026-05':5.2792, '2026-06':6.0414, '2026-07':8.58, '2026-08':8.82, '2026-09':8.82, '2026-10':8.82, '2026-11':8.82, '2026-12':8.82 };
let _reparoAtivo = false;  // trava do sku-repara — backfill e caça checam antes de começar
const _histCache = {};   // agregados do Supabase por período (10 min)
/* 29/10 (3b-2): objeto ESTÁVEL — o backfill compartilhado o reinicia no lugar; ninguém aqui o troca. 16/11 (montarCheckout,
   passo 9): é o andamento da AMB NO REGISTRO por empresa (lib/checkout/backfill-estado) desde o boot — antes era um objeto
   daqui que só entrava no registro na 1ª rodada (até lá, a vaga e o painel olhavam objetos diferentes) */
const _backfill = require('../lib/checkout/backfill-estado').estado('amb');

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
/* 04/09 — o mapa agora vem de lib/ml-billing-mapa.js, que lê o billing em STREAM e guarda
   um índice pequeno em disco. O jeito antigo dava JSON.parse no _ml_billing.json inteiro —
   96.293 tarifas, 26 MB de heap POR CHAMADA, em 7 pontos do arquivo. Foi isso que estourou
   os 512 MB do Render e derrubou o serviço 5 vezes entre 03 e 04/09 (status 134), inclusive
   com o backfill tendo varrido só 14 pedidos. Agora: 8 MB na primeira montagem, 3 ms nas
   seguintes. Continua síncrono pra quem chama — o await fica aqui dentro. */
async function _mapasBilling() { return _mlBilling.mapasBilling(); }   /* 19/10: a regra mora na peça lib/checkout/ml-billing */
// 1 chamada por venda (o pescarDadosML faz 3-4 e so o sale_fee interessa aqui)
/* 15/11 (norte C): o `_feeMLLeve` que ficava aqui virou a peça lib/checkout/ml-fee-leve (o motor único é quem a usa) */
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
/* _varFor saiu daqui: o estado da varredura mora em lib/vendas-ops.js, por empresa.
   Leia por estadoVarrerForn() — fonte única, sem cópia local que fique parada. */

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


/* 05/09: a noturna precisa saber se há backfill em curso pra ceder — a Girassol ganhou isso
   no #309, a AMB estava sem (mais uma da lista de paridade). */
function backfillEstado() { return Object.assign({}, _backfill); }

/* 16/11 (norte C, montarCheckout passo 9): o BACKFILL da AMB é o motor único (lib/checkout/backfill-motor, rodado por
   backfill-rodar sem empresa padrão) com o CONTEXTO montado pela peça lib/checkout/backfill-empresa — a mesma da GOOD. Aqui
   só o que é da AMB, por acessor (lido a cada rodada), e a alíquota de reserva dela. O contexto que era montado à mão
   (`_ctxBackfillAmb`) está em docs/HISTORICO-BACKFILL-EMPRESA.md. */
const _bfEmp = require('../lib/checkout/backfill-empresa').criar({
  empresa: 'amb',
  aliqReserva: 14.1,   /* a alíquota de reserva DA AMB quando o mês não tem a dela */
  pecas: {
    get blingGet() { return blingGet; },
    get readJson() { return readJson; },
    get CACHE_DIR() { return CACHE_DIR; },
    get DEFAULT_ALIQ_BK() { return DEFAULT_ALIQ_BK; },
    get ehFlex() { return ehFlex; },   /* o classificador Flex da AMB (cache-dir 'amb' + SHOPEE_LOGISTICA_FLEX_EMPRESAS) */
    get LOJA_MKT() { return LOJA_MKT; },
    get escrowEmLote() { return escrowEmLote; },
    get escrowDoPedido() { return escrowDoPedido; },
    get magaluFreteSkuLer() { return magaluFreteSkuLer; },
    get custoEmpresa() { return _custoEmp; },
    get mlBilling() { return _mlBilling; },
    get cacaMagalu() { return _cacaMgAmb; },
    get canario() { return _canario; },
    get reparoAtivo() { return () => _reparoAtivo; },
  },
});
async function backfillVendas(de, ate) { return _bfEmp.backfillVendas(de, ate); }   /* a assinatura de antes (de, ate, empresa): a empresa é sempre a AMB */


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
/* 16/11 (montarCheckout, passo 9): as situações de cancelamento da AMB são as da peça (lib/checkout/situacoes-cancelamento) —
   aqui havia a CÓPIA inteira da função; o env de contorno AMBBKP_SIT_CANCELADO segue valendo (convenção da peça). O objeto
   é o da peça, estável (a fábrica o lê por função). */
const _sitCancel = require('../lib/checkout/situacoes-cancelamento').alvo('amb');
function garantirSitCancel(bg) { return require('../lib/checkout/situacoes-cancelamento').garantirSitCancel(bg, 'amb'); }

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
/* 19/10 (Fase 3): o faturamento do ML e os créditos do Flex são a PEÇA ÚNICA lib/checkout/ml-billing (a GOOD ganhou;
   a Girassol ganhou os créditos do Flex). O estado é o MESMO objeto da peça — nunca trocado — então as rotas daqui
   continuam lendo `_mlb`/`_mlcred` como antes. Aqui só as peças do módulo (deps, lidas na hora da chamada). */
const _mlBilling = require('../lib/checkout/ml-billing').criarMlBillingDaEmpresa('amb', {
  deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson, fetch, path, supaReq }),
});
const _mlb = _mlBilling._mlb;
const MLB_FILE = () => path.join(CACHE_DIR, '_ml_billing.json');

/* 15/09 (PR #444, retomado em 17/09) — a classificação da tarifa do ML era a MESMA nos dois
   módulos, 40 linhas idênticas. O valor dela não é o tamanho: cada regra nasceu de dinheiro
   que apareceu ou sumiu de um card — o caso mais caro foi o ML mandar "Anulación del cargo
   por campaña de publicidad" em ESPANHOL, R$ 849 de estorno de ads na AMB que não apareciam
   em card nenhum. Triplicada, ela dava três chances de alguém consertar num lugar só e o
   dinheiro continuar sumindo nos outros dois. */
/* (19/10: quem usa a classificação agora é a peça lib/checkout/ml-billing — o require mora lá) */


async function mlBillingSync(...a) { return _mlBilling.mlBillingSync(...a); }

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
const _mlcred = _mlBilling._mlcred;
async function aplicarCreditosFlex(...a) { return _mlBilling.aplicarCreditosFlex(...a); }







/* 15/11 (rotas-cópia): o backfill do ANO em memória (`_backfillAno`/`backfillAnoTodo`) saiu — o ano é o plano em disco da peça
   lib/checkout/backfill-plano-empresa (`rotaAno`), como na GOOD; a fatia em curso aparece no `_backfill` de sempre. */

/* 11/11 (plano, Fase 3 4e) — A AMB GANHA O PLANO DE BACKFILL EM FATIAS (a GOOD e a Girassol já tinham). Um período longo
   vira fatias de 10 dias em disco, rodadas uma por vez FORA do horário do galpão, cedendo a vez a outro backfill,
   refazendo a que falha por motivo passageiro e retomando sozinho depois de queda/deploy. A regra mora na peça
   lib/checkout/backfill-plano-empresa; aqui só o que é da AMB: a pasta do cache, como roda uma fatia (o backfill DELA) e
   quando está ocupada. Rota: /amb-checkout-offline/backfill-plano?k=ADMIN_KEY[&acao=criar&de=…&ate=…|parar|retentar]. */
const _planoAmb = require('../lib/checkout/backfill-plano-empresa').criar({
  empresa: 'amb', prefixo: '/amb-checkout-offline', cacheDir: CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin,   /* 15/11: o /backfill-ano aceita chave OU sessão de admin, como antes */
  envPausa: 'AMB_PLANO_PAUSA_MS',
  rodarFatia: ({ de, ate }) => backfillVendas(de, ate),
  /* a trava COMPLETA: o backfill de um período, o do ano (entre um mês e outro) e o canário */
  ocupado: () => !!(_backfill.rodando || _canario.rodando),   /* 15/11: o ano em memória saiu (é o plano) */
});
/* 16/11 (montarCheckout, passo 7): o plano que ficou pela metade é retomado 3 min depois do boot PELO AGENDADOR (lá embaixo,
   `plano: _planoAmb`) — o bootstrap só roda com a AMB ativa */


/* 16/11 (norte C, montarCheckout passo 6): as ROTINAS DE CUSTO desta empresa — o estado e a anotação da falha, o sync de
   custo (e o "travado", com a re-tentativa), o custo diário das 23 h e a fila de recálculo — são a peça
   lib/checkout/rotinas-custo-empresa, a mesma das três. Aqui só o que é da AMB, por acessor (lido na hora).
   A história de cada rotina (13/09 a falha identificada, 14/09 a trava pesada, 09-11/09 o custo diário, 13/11 o
   recálculo) está nas peças lib/checkout/custo-sync, custo-sync-travado, custo-diario e custo-recalculo, e o texto que
   ficava aqui em docs/HISTORICO-ROTINAS-CUSTO.md. */
const _rotCusto = require('../lib/checkout/rotinas-custo-empresa').criar({
  empresa: 'amb',
  pecas: {
    get CACHE_DIR() { return CACHE_DIR; },
    get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
    get _histCache() { return _histCache; },
    get _limparSkuInfo() { return _limparSkuInfo; },
    get blingGet() { return blingGet; },
    get readJson() { return readJson; },
    get writeJson() { return writeJson; },
    get resolverProdutoPorSku() { return resolverProdutoPorSku; },
    get custoEmpresa() { return _custoEmp; },
  },
});
const { _cst, travaPesada, CUSTO_FILE_DIARIO, custoSyncTravado, custoRetryPendente, custoDiario, _cstDiario, _diaFechadoDoDisco } = _rotCusto;


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


// ─── 19/08: SÓ PRODUTO ATIVO + RESOLVER SKU → PRODUTO ───────────────────────────
/* 11/09 — fatia 2 da desduplicação: estas 111 linhas eram byte a byte iguais aqui e na
   outra empresa, e guardam a regra que nasceu de um caso caro do dono (cadastro EXCLUÍDO
   do 10xE14 fazia o custo do kit virar 20,40 em vez de 34,00). Duas cópias de uma regra
   dessas são duas chances de divergir. Agora vive em lib/checkout/produto-ativo.js. */
const _rotaDeParaSku = require('../lib/checkout/rota-depara-sku').criarRotaDeParaSku({
  prefixo: '/amb-checkout-offline', path, CACHE_DIR, json,
  readJson: (...a) => readJson(...a),
  validarSessao: (...a) => validarSessao(...a),
  ehAdmin: (...a) => ehAdmin(...a),
  lerDeParaSku: (...a) => lerDeParaSku(...a),
  gravarDeParaSku: (...a) => gravarDeParaSku(...a),
  resolverDeParaSku: (...a) => resolverDeParaSku(...a),
  sugerirDeParaSku: (...a) => sugerirDeParaSku(...a),
});
const _produtoAtivo = require('../lib/checkout/produto-ativo').criar({
  CACHE_DIR, readJson, writeJson,
  /* o cache do sku-info continua sendo DESTE arquivo (há outro ponto que escreve nele):
     a lib recebe acessores, pra não existirem dois caches divergindo */
  lerSkuInfoCache: () => _skuInfoCache,
  gravarSkuInfoCache: (v) => { _skuInfoCache = v; },
});
const { resolverProdutoPorSku, escolherProdutoAtivo, _prodExcluido, _prodAtivo, _limparSkuInfo } = _produtoAtivo;




/* 13/09 — fatia 7 da desduplicação: o AGENDADOR (as 47 linhas do bootstrap) era igual nas
   duas empresas, com três diferenças — a chave da empresa, o minuto da rodada de custo
   (23h00 aqui, 23h15 na outra, separadas de propósito pra não disputarem cota do Bling) e
   comentários. Virou lib/checkout/agendador.js com isso como parâmetro. Aqui mora o relógio
   da operação, e rotina que deixa de ser agendada não falha: ela simplesmente não acontece,
   em silêncio — por isso o teste novo confere os 12 agendamentos um a um. */
const bootstrap = require('../lib/checkout/agendador').criarAgendador({
  empresa: 'amb',
  minutoCustoDiario: 0,
  plano: _planoAmb,   /* 16/11: o plano do ano retomado no boot e a preparação sozinha */
  mlSyncFees: (...a) => mlSyncFees(...a),
  custoSync: (...a) => custoSyncTravado(...a),   /* tartaruga pós-boot e manutenção de 6h — trava do processo */
  custoDiario: (...a) => custoDiario(...a),
  varrerCancelados: (...a) => varrerCancelados(...a),
  mlBillingSync: (...a) => mlBillingSync(...a),
  vendasSync: (...a) => vendasSync(...a),
  rodarCiclo: (...a) => rodarCiclo(...a),
  getUltimoResumo: () => (typeof getUltimoResumo === 'function' ? getUltimoResumo() : null),
  log: console.log,
  aoIniciar: () => {
    ensureDir(CACHE_DIR);
    console.log(`[AMBBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  },
});


module.exports = {
  id: 'amb-checkout-offline',
  nome: 'AMBTotal Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14), shopeeKeepAlive: () => shopeeKeepAlive(), noturna: () => _noturna.rotinaNoturna('cron'), cacaMagalu: () => cacaMagaluCron(),
             cacaMagaluProvisorios: () => _cacaMgAmb.cacaMagaluProvisorios() },   /* 16/11 (P1-4): de madrugada, refaz as linhas da Magalu com comissão/frete estimados ou ausentes quando o financeiro chegou */
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '30 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */, noturna: '45 3 * * *' , cacaMagalu: '35 * * * *', cacaMagaluProvisorios: '0 3 * * *' },
  bootstrap
};
