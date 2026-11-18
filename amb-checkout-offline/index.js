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

const VERSAO     = 'amb-checkout-offline v26/08 b92';
/* 15/11 (norte C, rotas-cópia): ícone e manifesto do app pela peça — pra aba, favorito e atalho do celular. 17/11 (montarCheckout,
   passo 16): montado pelo contrato — o nome, a descrição e o ícone de 128px moram no painel da empresa
   (lib/checkout/painel/empresas, PWA_EMPRESA); empresa sem app no painel recebe null e a fila pula o passo. */
const _rotasPwa = require('../lib/checkout/rotas-pwa').daEmpresa('amb', { VERSAO });

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
// ─── 05/08: API oficial da Shopee (Open Platform v2) — conectar, sondar o escrow ───
const { rotasShopee, escrowDoPedido, contasDoEscrow, escrowEmLote, coletarDevolucoes, coletarCarteira, pedirAoSync } = require('./amb-shopee');
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
  empresa: 'amb', json, blingGet, ehAdmin, skuEanCache, lerIndiceEan, salvarNoIndiceEan,
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

/* 17/11 (norte C, montarCheckout passo 12): a MADRUGADA da empresa é a peça lib/checkout/noturna-empresa — o contexto dela
   (prefixo e token do ML do contrato; o histórico, o canário, os cancelados, o billing, a pesca, a Shopee, o TikTok pelas
   peças da AMB) é montado lá, igual pras três. A montagem à mão que ficava aqui e o embrulho amb-noturna.js estão em
   docs/HISTORICO-NOTURNA-EMPRESA.md. A poda do bucket de expedição roda na madrugada da Girassol (o bucket é um só): a
   etapa aparece aqui dizendo isso, como antes. */
const _noturna = require('../lib/checkout/noturna-empresa').criar({
  empresa: 'amb',
  pecas: {
    get backfill() { return _bfEmp; },
    get canario() { return _canEmp; },
    get cancelados() { return _canc; },
    get mlBilling() { return _mlBilling; },
    get vendasDia() { return _rotVendas; },
    get shopee() { return { pedirAoSync, coletarDevolucoes, coletarCarteira }; },
    get tiktokFinanceiro() { return coletarFinanceiroTikTok; },
    get tiktokCompletar() { return completarTarifaTikTok; },
    get canarioCron() { return canarioCron; },
    podarExpedicao: null,
    CACHE_DIR, readJson, writeJson, VERSAO, validarSessao, ehAdmin, json,
  },
});


/* 31/10 — as ROTAS COMUNS do checkout (peça única lib/checkout/rotas-comuns): montada na 1ª chamada, que recebe o
   `readBody` do handler; da empresa só a empresa e as peças dela (17/11: o prefixo, o nome no log, o token do ML, a Madeira
   e o andamento do imposto saem do contrato) */
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
    empresa: 'amb',   /* 17/11 (montarCheckout, passo 19): o prefixo, a tag, o token do ML, a Madeira e o imposto saem do contrato */
    reaplicarCusto,   /* 12/11: o recálculo das vendas ao lançar/apagar custo (rotas comuns) */
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, JANELA_DIAS, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, RESERVAS_FILE, RESGATES_FILE, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, VERSAO, _detalheBling, _diaAntes, _hojeISO, _moverAtendidoDesandando, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, moverSituacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'),
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
  /* 17/11 (montarCheckout, passo 15): as ROTAS DE LOTE (etiquetas em massa, a página de envio, as DANFEs em lote) pelo
     contrato — o prefixo, a tag, o nome e o id nas Devoluções saem da configuração da empresa; daqui só o `readBody`, o base
     e as NFs desta pasta. O bloco escrito à mão de antes está em docs/HISTORICO-ROTAS-LOTE.md. */
  const _lote = require('../lib/checkout/rotas-lote').daEmpresa('amb', { readBody, base, nf: require('./nf') });
  /* 16/11 — A FILA DE PEÇAS DE ROTA É A PEÇA lib/checkout/rotas-empresa (a mesma ordem nas três; a fábrica do painel por
     último, as rotas próprias antes das compartilhadas). Aqui só o que é desta empresa: cada passo com as peças dela.
     Os comentários do `handle` antigo (a história de cada rota e de cada decisão de ordem) estão em docs/HISTORICO-HANDLE-ROTAS.md. */
  const _rotas = require('../lib/checkout/rotas-empresa').criar('amb', {
    cabeca: _cabeca,
    comuns: (req, res, urlObj, method, p) => _rotasComuns(readBody).handle(req, res, p, method, urlObj),
    lote: (req, res, urlObj, method, p) => _lote.handle(req, res, p, method, urlObj),
    planoAno: (req, res, urlObj, method, p) => _planoAmb.rotaAno(req, res, urlObj, method, p),
    plano: (req, res, urlObj, method, p) => _planoAmb.rota(req, res, urlObj, method, p),
    pwa: _rotasPwa && ((req, res, urlObj, method, p) => _rotasPwa(req, res, p, method)),
    canEmp: (req, res, urlObj, method, p) => _canEmp.rotas({ json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p),
    backfillStatus: _rotaBackfillStatus,
    /* 16/11 (passo 2): semear o cookie e consultar a devolução da Shopee — peça das três (eram as rotas próprias da AMB) */
    shopeeSessao: require('../lib/checkout/rotas-shopee-sessao').criar({ empresa: 'amb', VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody,
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
  empresa: 'amb', cacheDir: CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin,   /* 15/11: o /backfill-ano aceita chave OU sessão de admin, como antes */
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
  empresa: 'amb', path, CACHE_DIR, json,
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
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '30 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */, noturna: require('../lib/checkout/config-empresa').configCheckout('amb').madrugada   /* 17/11: o horário da madrugada é do contrato (o status mostra o mesmo) */, cacaMagalu: '35 * * * *', cacaMagaluProvisorios: '0 3 * * *' },
  bootstrap
};
