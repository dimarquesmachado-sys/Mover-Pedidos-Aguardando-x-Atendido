'use strict';

/* 14/09 (auditoria, P2): a chave passa a ser lida do HEADER primeiro; a query
   continua aceita porque há dezenas de URLs salvas com &k= — cortar de uma vez
   quebraria o trabalho de quem opera pelo navegador. */
const { lerChaveAdmin } = require('../lib/http/chave-admin');
const { souAdmin } = require('../lib/http/admin-da-sessao');
// ⚠️ ESTE ARQUIVO ERA O index.js DESTA PASTA — renomeado em 05/08/2026 a pedido do Diego.
// Motivo: existiam 21 arquivos chamados "index.js" no repositório, e baixar dois deles pra
// mesma pasta de Downloads já causou incidente (arquivo da AMB subiu dentro da Girassol e
// derrubou o serviço). Agora o entry point deste módulo tem nome único: gbo-app.js.
// Quem aponta pra cá é uma linha só: config/empresas.js.
// Depois de confirmar o b118 no /status, o index.js antigo desta pasta pode ser apagado.

// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · BACKUP OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
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

/* 01/10 — ESTADO DAS ROTINAS PESADAS, por empresa. Fica AQUI NO TOPO de propósito: `_cst` e
   `_vsy` são usados milhares de linhas adiante, e declarar o require perto deles daria
   "Cannot access '_estadoRotinas' before initialization". O `node --check` não pega ordem de
   inicialização e a bateria também não — só o BOOT REAL acusa. É a razão de ele estar no
   checklist. */
const _estadoRotinas = require('../lib/checkout/estado-rotinas').estadoDe('girassol');

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
const _canc = require('../lib/checkout/cancelados-empresa').criarCanceladosDaEmpresa('girassol', {
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
   Era o da GOOD -- a varredura de cancelados da Girassol checava o token da GOOD antes de consultar o Bling: com o token da
   GOOD vencido (ou a GOOD desligada), a Girassol perdia a fase do Bling sem nada errado com o Bling dela. */
const { garantirToken } = require('../girassol/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: GIRABKP_QZ_CERT (digital-certificate.txt) e GIRABKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.GIRABKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.GIRABKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

const VERSAO     = 'girassol-backup-offline v25/08 b153';
/* 15/11 (norte C, rotas-cópia): ícone e manifesto do app pela peça — pra aba, favorito e atalho do celular. 17/11 (montarCheckout,
   passo 16): montado pelo contrato — o nome, a descrição e o ícone de 128px moram no painel da empresa
   (lib/checkout/painel/empresas, PWA_EMPRESA); empresa sem app no painel recebe null e a fila pula o passo. */
const _rotasPwa = require('../lib/checkout/rotas-pwa').daEmpresa('girassol', { VERSAO });

// ── SESSÃO DE OPERADOR (cookie assinado HMAC) — protege rotas de dados/ação ──
// 15/11 (norte C): as 21 linhas iguais nas três empresas viraram a peça lib/checkout/sessao-operador (mesmo segredo,
// mesmo cookie, 14 h — o cookie vale nos três painéis, como já valia).
const { SESS_TTL, SESS_COOKIE, assinarSessao, validarSessao } = require('../lib/checkout/sessao-operador');

// ─── Módulos extraídos (Fase 1: base + nf + etiquetas) ───────────────────
const base = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
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
const { _moverAtendidoDesandando } = require('../lib/checkout/resgate-atendido').criarResgateAtendido({ tag: 'GIRABKP' });
/* `blingWrite` guarda o corpo do erro em `data`/`raw`, nao em `erro`: sem olhar la o popup so mostra o status. */


/* 15/09 — a capacidade "expedicao" e a env de VERIFICADO precisam CONCORDAR. São dois lugares
   diferentes e nada obriga o segundo a acompanhar o primeiro: declarar a capacidade e esquecer
   a env deixa o app de Expedição sem nada pra bipar, e o contrário deixa pedido parado num
   estado sem saída. Os dois são silenciosos — por isso a checagem grita no boot. */
{
  const _exp = require('../lib/checkout/conferir-expedicao').conferir({
    rotulo: 'GIRABKP',
    temExpedicao: require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade('girassol', 'expedicao') === true,
    SIT_VERIFICADO,
    /* a Girassol NÃO desestrutura SIT_DESPACHADOS (quem move pra lá é o app de Expedição), e
       o lint pegou a suposição. Lendo do base direto, funciona nas três. */
    SIT_DESPACHADOS: require('./base').SIT_DESPACHADOS || 0,
  });
  if (!_exp.ok) console.error(_exp.aviso);
}
const { parseNF, acharNFporRange, nfDoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = require('./nf');
const { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf } = require('./etiquetas');
// ─── Módulos extraídos (Lote 1: comum/produtos/arquivo/separacao/email-docs) ────────
const { ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = require('./comum');
const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = require('./produtos');
const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = require('./arquivo');
// ─── Lote 2 (03/08): rotas de raio-X/sonda/backup saíram daqui pro diagnostico.js ───
const { rotasDiagnostico } = require('./diagnostico');
// ─── Lote 3 (04/08): histórico e análise (os números do dashboard) foram pro historico.js ───
const { rotasHistorico } = require('./historico');
// ─── 04/08: pescaria retroativa da comissão real do ML no histórico ───
const { rotasPescaria } = require('./pescaria');
// ─── 05/08: canário das integrações (só leitura, avisa quando um contrato de API muda) ───
const { rotasCanario } = require('./canario');
// ─── 05/08: poda do bucket de expedição no Supabase (o que estourou o Free Plan) ───
const { rotasLimpeza, podarExpedicao } = require('./limpeza');
// ─── 05/08: API oficial da Shopee (Open Platform v2) — conectar, sondar o escrow ───
const { rotasShopee, escrowDoPedido, escrowEmLote, coletarDevolucoes, coletarCarteira, pedirAoSync } = require('./gbo-shopee');
const { canarioCron } = require('./canario');
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
const { listarAtendidos, detalhePedido, sincronizarConferidos, indexarCatalogoCompleto, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus, fullJaDespachado } = require('./ciclo');

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

// ── SESSÃO SHOPEE QUE SE RENOVA SOZINHA (b23) ───────────────────────────
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
const SHOPEE_ENV_COOKIE  = 'GIRABKP_SHOPEE_COOKIE';
/* 11/09 — fatia 3 da desduplicação: a sessão da Shopee (cookie do painel, que vence e
   precisa sobreviver a deploy) era ~88 linhas iguais nas duas empresas. Só o NOME da env
   muda por empresa — virou parâmetro; o resto é lib/checkout/shopee-sessao.js. */
const _shopeeSessao = require('../lib/checkout/shopee-sessao').criar({
  CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE, TAG: 'GIRABKP',
});
const { shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, shopeeKeepAlive, SHOPEE_CAB, SHOPEE_SESSAO_FILE,
        _shopeeHash, _urlStatus } = _shopeeSessao;



/* ═══ 22/08 — CUSTO: agora vem de lib/custo.js (código único das 3 empresas) ═════════════
   Estas funções estavam escritas 3× (uma por empresa) e a GOOD já tinha ficado sem 5 delas.
   Aqui fica só a ponte: o ctx com o que é DESTA empresa; a regra vive num lugar só.
   `skuInfoCache` vai por getter porque a lib limpa o cache de 6h quando o custo muda. */
/* 16/11 (montarCheckout, passo 5): o custo da empresa é a peça lib/checkout/custo-empresa — o contexto do lib/custo, os atalhos de custo
   manual/vigência/de-para/nome e o vendas-ops (recálculo, fornecedores, estados), com o que é DESTA empresa. Os nomes continuam os
   mesmos; o cache do sku-info e o do histórico chegam por função porque nascem mais abaixo neste arquivo. */
const _custoEmp = require('../lib/checkout/custo-empresa').criar({ empresa: 'girassol', CACHE_DIR, path, fs, readJson, writeJson, blingGet,
  skuInfoCache: () => (typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null), histCache: () => _histCache });
const { _ctxCusto, lerCustosManuais, gravarCustosManuais, custoManualDe, comCustosManuais, parsearCustosColados, telaCustosManuais,
  lerVigencias, gravarVigencias, registrarCustoVigente, custoVigenteEm, lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku,
  resolverNomeSku, carregarCatalogoDePara, _hojeISO, _ontemISO, _diaAntes, buscarDevolucoesML, varrerFornecedores, reaplicarCusto, estadoReapCusto, estadoVarrerForn } = _custoEmp;

/* 16/11 (norte C, montarCheckout passo 8): a VENDA DO DIA desta empresa — o estado, o canal pelo número, a pesca do ML, o
   frete da Magalu, a fase direta (o serviço da Shopee e o token do ML pela configuração da empresa, lib/checkout/config-empresa),
   a venda do dia e a pesca das tarifas do ML nos conferidos — é a peça lib/checkout/vendas-dia-empresa, a mesma das três.
   Aqui só o que é da Girassol, por acessor (lido na hora). O texto que ficava aqui está em docs/HISTORICO-VENDAS-DIA.md. */
const _rotVendas = require('../lib/checkout/vendas-dia-empresa').criar({
  empresa: 'girassol',
  versaoCustos: 2,   /* a versão do marcador de custos do ML que ela grava nos conferidos — Codex PR#48: v2 = gross_amount; relê quem tem menos */
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
  empresa: 'girassol', json, blingGet, ehAdmin, skuEanCache, lerIndiceEan, salvarNoIndiceEan,
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


/* 21/10 (Fase 3 / lib 100%): os ADAPTADORES do canário (listar no Bling e em cada marketplace, pacote do ML, conserto)
   eram cópia aqui e na AMB (iguais a menos do token do ML, da chave da Shopee e da conta do TikTok; o conserto só
   aqui). Agora são a PEÇA ÚNICA lib/checkout/canario-empresa, nascida deste bloco, com o que é da empresa vindo da
   configuração única. Aqui só as peças do módulo (lidas na hora da chamada) e os nomes que o resto do arquivo usa. */
const _canEmp = require('../lib/checkout/canario-empresa').criarCanarioDaEmpresa('girassol', {
  deps: () => ({ blingGet, LOJA_MKT, irmasDoPack: _irmasDoPack, CACHE_DIR, pedirAoSync, fetch }),
  /* o backfill DESTA empresa (o do mês e o do ano): o canário espera — os dois brigam pela cota do Bling */
  ocupado: () => { const anoR = false;   /* 15/11: o ano é o plano em disco — a fatia em curso aparece no _backfill */
    return { rodando: !!((_backfill && _backfill.rodando) || anoR), de: _backfill && _backfill.de, ate: _backfill && _backfill.ate, do_ano: !!anoR }; },
});
const _listarNoBlingCanario = (...a) => _canEmp.listarNoBling(...a);
const _listarNoMarketplaceCanario = (...a) => _canEmp.listarNoMarketplace(...a);
const _packDaVendaCanario = (...a) => _canEmp.packDaVenda(...a);
const _ordensDoPackCanario = (...a) => _canEmp.ordensDoPack(...a);

const _canario = _canEmp.estado;   /* 23/10: o estado do canário é o da peça (o backfill daqui lê `rodando`) */

// Codex (#105): o cache do TikTok só era escrito pela rota admin — envelhecia sozinho e
// levava junto a tarifa real e a hora da venda. A noturna passa a atualizá-lo.
/* 13/09 — fatia 6 da desduplicação: este wrapper era idêntico nas duas empresas, com a
   ÚNICA diferença sendo a chave 'girassol'. Foi pra lib/tiktok-financeiro.js com a empresa como
   PARÂMETRO — o caso mais puro da regra da casa, e o que faz empresa nova só precisar
   passar a própria chave em vez de herdar mais uma cópia. */
const coletarFinanceiroTikTok = require('../lib/tiktok-financeiro').criarColetorDaEmpresa('girassol', {
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
const completarTarifaTikTok = require('../lib/tiktok-completar').criarCompletadorDaEmpresa('girassol', {
  supaReq: (...a) => supaReq(...a),
  aoAtualizar: () => { for (const k of Object.keys(_histCache)) delete _histCache[k]; },
});

/* 17/11 (norte C, montarCheckout passo 12): a MADRUGADA da empresa é a peça lib/checkout/noturna-empresa — o contexto dela
   (prefixo e token do ML do contrato; o histórico, o canário, os cancelados, o billing, a pesca, a Shopee, o TikTok e a poda
   pelas peças da Girassol) é montado lá, igual pras três. A montagem à mão que ficava aqui e o embrulho noturna.js estão em
   docs/HISTORICO-NOTURNA-EMPRESA.md. A Girassol é quem poda o bucket de expedição (é um só). */
const _noturna = require('../lib/checkout/noturna-empresa').criar({
  empresa: 'girassol',
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
    get podarExpedicao() { return podarExpedicao; },
    CACHE_DIR, readJson, writeJson, VERSAO, validarSessao, ehAdmin, json,
  },
});


/* 31/10 — as ROTAS COMUNS do checkout (peça única lib/checkout/rotas-comuns): montada na 1ª chamada, que recebe o
   `readBody` do handler; da empresa só a empresa e as peças dela (17/11: o prefixo, o nome no log, o token do ML, a Madeira
   e o andamento do imposto saem do contrato) */
let _rotasComunsGir = null;
function _rotasComuns(readBody) {
  if (!_rotasComunsGir) _rotasComunsGir = require('../lib/checkout/rotas-comuns').criarRotasComuns({
  /* 09/11: o e-mail do código da coleta usa a MESMA conta e o MESMO estoque do e-mail da etiqueta desta empresa */
  emailEmpresa: () => ({ SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST }),
  /* 08/11 (rotas comuns, passo 10b): o que o /config-fiscal usa — as alíquotas, o cache do histórico e a reaplicação DESTA empresa */
  ALIQ_PADRAO: DEFAULT_ALIQ_BK, ALIQ_APURADOS, lerHistCache: () => _histCache, reaplicarImposto: (m) => reaplicarImposto(m),
  /* 08/11 (rotas comuns, passo 9b): o que o /sku-info usa — o cache, o contexto de custo e a busca do produto DESTA empresa */
  _ctxCusto, comCustosManuais: (...a) => comCustosManuais(...a), resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a), lerSkuInfoCache: () => _skuInfoCache, gravarSkuInfoCache: (v) => { _skuInfoCache = v; },
  /* 07/11 (rotas comuns, passo 8): o que o /custo-sync usa — o estado e o motor de custo DESTA empresa */
  _cst, custoSyncTravado: (...a) => custoSyncTravado(...a), custoRetryPendente: () => custoRetryPendente(), travaPesada, _urlStatus, _cstDiario, _diaFechadoDoDisco: (...a) => _diaFechadoDoDisco(...a),
  /* 07/11 (rotas comuns, passo 7): a TELA do dashboard desta empresa (a configuração dela) -- a rota é da peça */
  htmlDashboard: () => require('../lib/checkout/painel/empresas').painelDaEmpresa('girassol', { defaultAliq: DEFAULT_ALIQ_BK }),
    empresa: 'girassol',   /* 17/11 (montarCheckout, passo 19): o prefixo, a tag, o token do ML, a Madeira e o imposto saem do contrato */
    reaplicarCusto,   /* 12/11: o recálculo das vendas ao lançar/apagar custo (rotas comuns) */
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, JANELA_DIAS, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, RESERVAS_FILE, RESGATES_FILE, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, VERSAO, _detalheBling, _diaAntes, _hojeISO, _moverAtendidoDesandando, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, moverSituacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    SIT_DESPACHADOS: require('./base').SIT_DESPACHADOS || 0,   /* a Girassol lê do base (não é constante do arquivo dela) */
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'),
  });
  return _rotasComunsGir;
}

function routes(readBody) {
  /* 14/11 — AS CINCO PEÇAS DE ROTA DA OPERAÇÃO (contagem de estoque, separação, backfill, NF anexada, conferido) são
     ligadas pela peça lib/checkout/rotas-operacao — a mesma pras três. O prefixo da URL, a pasta, a env do depósito e
     o id da empresa saem da configuração dela (lib/checkout/config-empresa); aqui vão só as peças DESTE arquivo.
     ⚠️ Criado DENTRO do routes porque o `readBody` chega como PARÂMETRO daqui: fora, o boot cai com
     "readBody is not defined" (já aconteceu duas vezes — numa o lint pegou, na outra só o boot). */
  const _rotasOperacao = require('../lib/checkout/rotas-operacao').criar('girassol', {
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
    /* 30/10 (ciclo 3): o ciclo da Girassol é a peça, que tem o bloco do Full despachado — a opção anda junto, como na AMB
       e na GOOD. Hoje GIRABKP_SIT_DESPACHADOS não está configurado (0): a opção sai false e o Full conferido segue pro
       VERIFICADO (a Expedição), como sempre; se um dia o destino for configurado, o ciclo e o conferido mudam JUNTOS. */
    fullJaDespachado,
    FULL_VAI_DESPACHADOS: !!require('./base').SIT_DESPACHADOS,
  });
  // handler das rotas de diagnóstico (debug-*, sonda-*, diag-*, /backup, /restaurar).
  // Montado UMA vez; a chamada fica no fim do handle, logo antes do return false.
  const diag = rotasDiagnostico({ VERSAO, validarSessao, supaCfg, readBody });
  // histórico/análise: histCache vai por REFERÊNCIA — o backfill e o /backfill-limpar
  // esvaziam esse mesmo objeto aqui no index e isso tem que valer lá dentro também.
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
  const _cabeca = require('../lib/checkout/cabeca-routes').criar('girassol', {
    json, lerChaveAdmin, blingGet, validarSessao, ehAdmin, manifest, lerConferidos: () => readJson(CONFERIDOS_FILE, {}),
    uiBuild: require('./painel-marca').UI_BUILD,   /* 27/10: a versão do painel vem da marca (o painel é a peça única) */
    rotasCatalogo: _rotasCatalogo, rotasOperacao: _rotasOperacao,
  });
  /* 17/11 (montarCheckout, passo 21): o /backfill-status é a peça única (lib/checkout/rota-backfill-status) — a trava (chave
     OU sessão de admin) e o prefixo do contrato; mostra o andamento do registro da empresa e o plano em fatias, como antes.
     O bloco escrito à mão de antes está em docs/HISTORICO-BACKFILL-STATUS.md. */
  const _rotaBackfillStatus = require('../lib/checkout/rota-backfill-status').criar({ empresa: 'girassol', plano: _planoGir, json, lerChaveAdmin, validarSessao, ehAdmin });

  /* 17/11 (montarCheckout, passo 15): as ROTAS DE LOTE (etiquetas em massa, a página de envio, as DANFEs em lote) pelo
     contrato — o prefixo, a tag, o nome e o id nas Devoluções saem da configuração da empresa; daqui só o `readBody`, o base
     e as NFs desta pasta. O bloco escrito à mão de antes está em docs/HISTORICO-ROTAS-LOTE.md. */
  const _lote = require('../lib/checkout/rotas-lote').daEmpresa('girassol', { readBody, base, nf: require('./nf') });
  /* 16/11 — A FILA DE PEÇAS DE ROTA É A PEÇA lib/checkout/rotas-empresa (a mesma ordem nas três; a fábrica do painel por
     último, as rotas próprias antes das compartilhadas). Aqui só o que é desta empresa: cada passo com as peças dela.
     Os comentários do `handle` antigo (a história de cada rota e de cada decisão de ordem) estão em docs/HISTORICO-HANDLE-ROTAS.md. */
  const _rotas = require('../lib/checkout/rotas-empresa').criar('girassol', {
    cabeca: _cabeca,
    comuns: (req, res, urlObj, method, p) => _rotasComuns(readBody).handle(req, res, p, method, urlObj),
    lote: (req, res, urlObj, method, p) => _lote.handle(req, res, p, method, urlObj),
    planoAno: (req, res, urlObj, method, p) => _planoGir.rotaAno(req, res, urlObj, method, p),
    plano: (req, res, urlObj, method, p) => _planoGir.rota(req, res, urlObj, method, p),
    pwa: _rotasPwa && ((req, res, urlObj, method, p) => _rotasPwa(req, res, p, method)),
    canEmp: (req, res, urlObj, method, p) => _canEmp.rotas({ json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p),
    backfillStatus: _rotaBackfillStatus,
    /* 16/11 (passo 2): semear o cookie e consultar a devolução da Shopee — peça das três (eram as rotas próprias da AMB) */
    shopeeSessao: require('../lib/checkout/rotas-shopee-sessao').criar({ empresa: 'girassol', VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody,
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
        empresa: 'girassol',   /* 17/11 (passo 23): o prefixo e o nome ("Magazine Girassol") saem do contrato */
        pecas: { /* 24/11: o EAN de cada SKU que o checkout já conhece (planilha do Plano de Compra) */ skuEanCache, /* 11/11 (4d, /etiqueta-diag): a etiqueta, o manifesto e as pastas DESTE checkout */ baixarEtiquetaPDF, MANIFEST_FILE, salvarManifest, ensureDir, /* 10/11 (4d, /buscar-pedido): */ sleep, PAUSA_MS, nfDoPedido, /* 09/11 (último grupo na fábrica): a trava do reparo de SKU (acessor — a empresa guarda o valor) e o cache do histórico */ _reparoAtivo: { get: () => _reparoAtivo, set: (v) => { _reparoAtivo = v; } }, _histCache, /* 09/11 (grupo cancelados/sync/diagnóstico na fábrica): */ configFreteMagalu: true, completarTarifaTikTok, vendasSync: (...a) => vendasSync(...a), sitCancel: () => _sitCancel, _inferCanal, /* 08/11 (grupo do ML, parte 2, na fábrica): o token e o módulo do ML DESTA empresa, na hora (as cópias faziam o require dentro da rota) */ garantirTokenML: (...a) => require('../girassol/mlTokenManager').garantirTokenML(...a), get mlTokenManager() { return require('../girassol/mlTokenManager'); }, /* 08/11 (grupo do ML, parte 1, na fábrica): */ _mlb, mlBillingSync, MLB_FILE, /* 17/11 (passo 17): os créditos do Flex */ _mlcred, aplicarCreditosFlex, /* 08/11 (grupo dos custos na fábrica): */ custoDiario, CUSTO_FILE_DIARIO, /* 08/11 (grupo do backfill na fábrica): */ supaReq, supaCfg, supaCount, _backfill, backfillVendas, _canario, json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR,
                 /* 19/11: a escrita no Bling, pra etapa que cria a nota nova do conserto da NF */ blingWrite, fsx: fs, pathx: path, readBody, estadoRotinas: _estadoRotinas,
                 /* 29/10: a caça de vendas da Magalu da Girassol (a rota /magalu-caca da fábrica) */
                 cacaMagalu: (...a) => _cacaMgGir.cacaMagalu(...a), _mgc: _cacaMgGir.estado(),
                 /* ⚠️ 05/10 — passado ANTES de precisar. Hoje a Girassol responde `custos-manuais`
                    pela cópia, então não há bug; no dia em que a cópia sair, a fábrica receberia
                    `skuInfoCache` nulo e mudar um custo manual limparia só o cache de DISCO — as
                    entradas em memória seguiriam servindo o custo ANTIGO por até 6h. Foi
                    exatamente o que aconteceu na AMB (#622, P1), e lá só apareceu depois.
                    GETTER, não valor: valor fixo capturaria o cache de hoje e perderia a troca
                    de referência que o `/sku-info` faz ao repovoar. */
                 get skuInfoCache() { return typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null; },
                 /* ⚠️ `travaPesada` e `custoSyncTravado` são declaradas DEPOIS desta função no
                    arquivo (linhas ~5947 e ~6247) e eu as tinha excluído por isso — errado:
                    estão no NÍVEL DO MÓDULO (indentação 0), e o módulo termina de carregar
                    antes da 1ª requisição, que é quando a fábrica monta. O que não alcança é
                    declaração ANINHADA (dentro de função ou de bloco), como `responderCusto` e
                    `garantirTokenML` na AMB. É nível, não posição no arquivo. */
                 travaPesada,
                 dataISO,   /* 16/11 (paridade do painel): o /sku-orfaos respondia "não expõe dataISO" na Girassol — a AMB e a GOOD já entregavam */
                 ehAdmin, _urlStatus, LOJA_MKT, CONFERIDOS_FILE, blingGet, estadoCancelados, reaplicarImposto, estadoReapCusto, varrerCancelados, varrerFornecedores, estadoVarrerForn, primeiraImagem, detalhePedido, reaplicarCusto },
      });
      console.log('[GIRASSOL] rotas compartilhadas do painel montadas');
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
const _supa = require('../lib/supabase').para('girassol');
const supaCfg   = (empresa)                    => _supa.cfg(empresa);
const supaReq   = (empresa, metodo, pq, body)  => _supa.req(empresa, metodo, pq, body);
const supaCount = (empresa, filtro)            => _supa.count(empresa, filtro);

// ─── Busca as DEVOLUÇÕES (type 'returns') recentes do ML + o frete de retorno de cada ──────
// Retorna mapa { order_id(string): {claim_id, stage, aberta, data, frete_retorno, destino, dev_status} }.
// Ignora o ruído (cancel_purchase/mediations/cancel_sale) — só devolução física que gera prejuízo.
// destino 'warehouse' = vai pro ML (frete de retorno cobrado do vendedor); 'seller_address' = volta pro galpão.

// ─── BACKFILL do histórico de vendas pro Supabase ────────────────────────────────────────────
// 19/08 — julho FECHOU em 14,4007% (era 14,1 de estimativa) e agosto fica pré-definido em 15%.
// Os meses seguintes seguem 15% como palpite até cada apuração sair. O ⚙️ sempre tem prioridade.
/* 18/09 — QUAIS MESES SÃO APURADOS E QUAIS SÃO ESTIMATIVA. O comentário acima sempre disse
   isso em prosa, mas o código não distinguia: a tabela era uma lista de números iguais, e a
   tela nova da GOOD (que diz "apurada" ao lado de cada mês) chamaria ESTIMATIVA de apurada se
   fosse portada assim. Chamar palpite de dado apurado é a mentira mais cara que esta tela
   poderia contar — o dono confere o DAS por cima de um número que ele acha conferido.
   O ritual dele é mensal: estima o mês, e por volta do dia 20 a contabilidade manda a
   apuração; é aí que o valor certo entra pelo ⚙️. Esta lista é o que separa um do outro. */
const ALIQ_APURADOS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const DEFAULT_ALIQ_BK = { '2026-01':11.409280, '2026-02':11.3254, '2026-03':12.3402, '2026-04':13.6001, '2026-05':13.9149, '2026-06':14.056, '2026-07':14.4007, '2026-08':14.9454, '2026-09':15, '2026-10':15, '2026-11':15, '2026-12':15 };
// ─── 19/08: destravar o padrão travado no ⚙️ (generalizado em 25/09) ─────────────
// Codex (P2): o ⚙️ preenche cada campo com o valor de fábrica em cinza e o salvamento envia TODOS
// os campos — então quem salvou qualquer configuração alguma vez tem o mês corrigido gravado com
// o PADRÃO ANTIGO, sem nunca ter mexido nele. Como valor salvo vence o padrão, corrigir só a
// constante não teria efeito nenhum para essa pessoa: ela veria o número velho e acharia que
// estava ajustado. 25/09: era função por mês (_destravarJulho) — agosto caiu no MESMO problema
// um mês depois (padrão 15 vigorou de 19/08 a 24/09), então virou parâmetro em vez de copiar a
// função de novo. Troca só o valor exato do padrão antigo e roda uma vez por mês (migracoes).
function _destravarPadraoAntigo(mes, valorAntigo, valorNovo, chaveMigracao) {
  try {
    const f = path.join(CACHE_DIR, '_config-fiscal.json');
    const cfg = readJson(f, null);
    if (!cfg || !cfg.aliquotas) return;
    if (cfg.migracoes && cfg.migracoes[chaveMigracao]) return;
    if (Number(cfg.aliquotas[mes]) === valorAntigo) {
      cfg.aliquotas[mes] = valorNovo;
      console.log('[fiscal] ' + mes + ' estava salvo com o padrão antigo (' + valorAntigo + ') — trocado por ' + valorNovo);
    }
    cfg.migracoes = cfg.migracoes || {};
    cfg.migracoes[chaveMigracao] = new Date().toISOString();
    if (!cfg.taxas || typeof cfg.taxas !== 'object') cfg.taxas = {};   // o POST do ⚙️ assume que existe
    writeJson(f, cfg);
  } catch (e) { console.error('[fiscal] não consegui destravar ' + mes + ' (' + e.message + ') — segue com o salvo'); }
}
_destravarPadraoAntigo('2026-07', 14.1, 14.4007, 'julho-14.4007');
_destravarPadraoAntigo('2026-08', 15, 14.9454, 'agosto-14.9454');
let _reparoAtivo = false;  // trava do sku-repara — backfill e caça checam antes de começar
const _histCache = {};   // agregados do Supabase por período (10 min)
/* 29/10 — CAÇA DE VENDAS DA MAGALU (peça lib/checkout/magalu-caca; era só da AMB): pergunta à Magalu o que ela vendeu e grava
   no histórico o que o Bling não tem (Magalu Full: a NF é da Magalu e o pedido só entra no Bling quando o XML é importado).
   De hora em hora (últimos 3 dias), pela rota /magalu-caca da fábrica e dentro do backfill. A chave da Girassol nas rotas
   /magalu/ é 'girassol' (GIRABKP_MAGALU_EMPRESA muda, se precisar). */
const _cacaMgGir = require('../lib/checkout/magalu-caca').criarCacaMagalu({
  empresa: 'girassol', magaluEmpresa: () => process.env.GIRABKP_MAGALU_EMPRESA || 'girassol',
  supaReq: (...a) => supaReq(...a), blingGet: (...a) => blingGet(...a), readJson: (...a) => readJson(...a), CACHE_DIR,
  DEFAULT_ALIQ_BK: () => DEFAULT_ALIQ_BK, magaluFreteSkuLer: () => magaluFreteSkuLer(), reparoAtivo: () => _reparoAtivo,
  histCache: () => _histCache,
});
/* 29/10 (passo 3a do backfill único): o ANDAMENTO do backfill é POR EMPRESA. Era um só pro servidor inteiro: a GOOD (que
   roda pela função daqui) dividia com a Girassol — o backfill de uma travava o da outra ('ja_rodando'), e a madrugada da
   GOOD esperava a da Girassol. Cada empresa tem o seu objeto, ESTÁVEL (reiniciado no lugar: quem guardou a referência
   segue vendo a rodada), e o da Girassol continua sendo `_backfill` aqui, pra todo o resto do arquivo. */
/* 15/11 (norte C: zero `require` cruzado) — o registro por empresa virou a peça lib/checkout/backfill-estado: a AMB e a GOOD
   leem o andamento DELAS por ela, não mais por este arquivo. A Girassol registra lá o que MAIS segura a vaga dela (canário,
   rodada do ano, reparo de SKU). `_backfill` continua sendo o objeto da Girassol pra todo o resto do arquivo. */
const _ESTADO = require('../lib/checkout/backfill-estado');
const _backfill = _ESTADO.estado('girassol');

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


/* 30/08 — o backfill passa a aceitar um CONTEXTO opcional, pra rodar por outra empresa.
   Medido antes de mexer: o corpo usa 4 coisas do escopo da Girassol — blingGet (lê os
   pedidos), CACHE_DIR e readJson (custos e config fiscal) e supaReq (grava). O parâmetro
   `empresa` já existia, mas só mandava no RÓTULO da linha gravada: o leitor continuava o da
   Girassol, então rodar com empresa=good gravaria pedido da Girassol marcado como GOOD.
   Sem ctx, tudo segue exatamente como era. */
/* 31/08 — CONSERTO DE RAIZ (5 rodadas de review no #309 apontaram para isto): a funcao
   tinha QUATRO saidas e nenhuma dizia o que aconteceu. Tres devolviam undefined — sucesso,
   aborto apos 6 tentativas na mesma pagina, e "ja tem um rodando" — e quem chamasse de fora
   nao tinha como distinguir. Cada tentativa de adivinhar de fora (comparar periodo, ler a
   fase, marcar a rodada) tapava um caso e deixava outro passar. Agora TODA saida devolve o
   estado com um campo `desfecho` explicito. */
/* 05/09 — MOTOR DO PLANO FATIADO: roda uma fatia por vez, cede se houver backfill manual em
   curso, e é chamado no boot pra retomar o que ficou depois de uma queda. */
/* 05/09: estado do backfill, usado pelo motor do plano (abaixo) e pela cessão da noturna */
function backfillEstado(emp) { return _ESTADO.foto(emp); }   /* 29/10 (3a): de qual empresa (sem nada: a Girassol); 15/11: pela peça */

/* 11/11 (plano, Fase 3 4e) — O PLANO EM FATIAS DA GIRASSOL PASSA A SER O DA PEÇA (lib/checkout/backfill-plano-empresa), o
   mesmo motor da GOOD e da AMB. Antes havia aqui um "tocar" próprio (05/09), mais antigo: não esperava o galpão fechar,
   olhava só o backfill de um período como trava e não refazia sozinho a fatia que falhava por motivo passageiro. Ganha
   os três. O arquivo do plano em disco é o MESMO (um plano pela metade continua de onde parou). */
const _planoGir = require('../lib/checkout/backfill-plano-empresa').criar({
  empresa: 'girassol', cacheDir: CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin,   /* 15/11: o /backfill-ano aceita chave OU sessão de admin, como antes */
  envPausa: 'GIRA_PLANO_PAUSA_MS',
  rodarFatia: ({ de, ate }) => backfillVendas(de, ate, 'girassol'),
  /* a trava COMPLETA (período, a rodada do ano entre um mês e outro, canário e reparo) */
  ocupado: () => backfillOcupado('girassol'),
});
/* 16/11 (montarCheckout, passo 7): o plano que ficou pela metade é retomado 3 min depois do boot PELO AGENDADOR (lá embaixo,
   `plano: _planoGir`) — não mais no carregamento do arquivo (o achado F03: o bootstrap só roda com a Girassol ativa) */

/* 16/11 (norte C, montarCheckout passo 10): a Girassol roda o histórico de vendas pelo MESMO caminho da AMB e da GOOD — o
   motor único (lib/checkout/backfill-motor, rodado por backfill-rodar sem empresa padrão) com o contexto montado pela peça
   lib/checkout/backfill-empresa. Antes ela era a "dona" dos padrões do motor (o que valia quando quem chamava não trazia
   contexto); os padrões eram os mesmos que a peça monta (as peças dela e as regras gerais), então o resultado é o mesmo.
   A montagem antiga e a cascata da comissão/Shopee que ficava aqui estão em docs/HISTORICO-BACKFILL-EMPRESA.md. */
const _bfEmp = require('../lib/checkout/backfill-empresa').criar({
  empresa: 'girassol',
  pecas: {
    get blingGet() { return blingGet; },
    get readJson() { return readJson; },
    get CACHE_DIR() { return CACHE_DIR; },
    get DEFAULT_ALIQ_BK() { return DEFAULT_ALIQ_BK; },
    get ehFlex() { return ehFlex; },
    get LOJA_MKT() { return LOJA_MKT; },
    get escrowEmLote() { return escrowEmLote; },
    get escrowDoPedido() { return escrowDoPedido; },
    get magaluFreteSkuLer() { return magaluFreteSkuLer; },
    get custoEmpresa() { return _custoEmp; },
    get mlBilling() { return _mlBilling; },
    get cacaMagalu() { return _cacaMgGir; },
    get canario() { return _canario; },
    get reparoAtivo() { return () => _reparoAtivo; },
  },
});
async function backfillVendas(de, ate) { return _bfEmp.backfillVendas(de, ate); }   /* a assinatura de antes (de, ate, empresa): a empresa é sempre a Girassol */


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
/* 15/11 (norte C): as situações de cancelamento por empresa viraram a peça lib/checkout/situacoes-cancelamento; o objeto da
   Girassol (`_sitCancel`, que a fábrica e o /varrer-cancelados-status leem) é o `alvo('girassol')` dela — a mesma referência */
const _SIT = require('../lib/checkout/situacoes-cancelamento');
const _sitCancel = _SIT.alvo('girassol');

/* 14/10 (parecer do Codex, 6.1) → 15/11: `garantirSitCancel(bg, empresa)` é a peça (cache por empresa; o env
   GIRABKP_SIT_CANCELADO só vale pra Girassol, como antes). Continua exportado daqui pra quem já chamava. */
const garantirSitCancel = _SIT.garantirSitCancel;

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
/* 19/10 (Fase 3): o faturamento do ML é a PEÇA ÚNICA lib/checkout/ml-billing (nasceu da AMB) — a Girassol ganha com ela a
   distribuição dos créditos do Flex, que só a AMB tinha. O estado é o MESMO objeto da peça (nunca trocado). */
const _mlBilling = require('../lib/checkout/ml-billing').criarMlBillingDaEmpresa('girassol', {
  deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson, fetch, path, supaReq }),
});
const _mlb = _mlBilling._mlb;
/* 17/11 (montarCheckout, passo 17): os CRÉDITOS DO FLEX no painel. A Girassol tem a distribuição desde 19/10 (a peça acima) e o
   backfill dela já aplica os créditos, mas a fábrica do painel não recebia o andamento nem o disparo: /ml-creditos-flex e
   /ml-flex-debug respondiam "esta empresa ainda não expõe" — a AMB e a GOOD servem. Os mesmos nomes da AMB. */
const _mlcred = _mlBilling._mlcred;
async function aplicarCreditosFlex(...a) { return _mlBilling.aplicarCreditosFlex(...a); }
const MLB_FILE = () => path.join(CACHE_DIR, '_ml_billing.json');

/* 15/09 (PR #444, retomado em 17/09) — a classificação da tarifa do ML era a MESMA nos dois
   módulos, 40 linhas idênticas. O valor dela não é o tamanho: cada regra nasceu de dinheiro
   que apareceu ou sumiu de um card — o caso mais caro foi o ML mandar "Anulación del cargo
   por campaña de publicidad" em ESPANHOL, R$ 849 de estorno de ads na AMB que não apareciam
   em card nenhum. Triplicada, ela dava três chances de alguém consertar num lugar só e o
   dinheiro continuar sumindo nos outros dois. */
/* (19/10: quem usa a classificação agora é a peça lib/checkout/ml-billing — o require mora lá) */


async function mlBillingSync(...a) { return _mlBilling.mlBillingSync(...a); }








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

/* 15/11 (rotas-cópia): o backfill do ANO em memória (`_backfillAno`/`backfillAnoTodo`) saiu — o ano é o plano em disco da peça
   lib/checkout/backfill-plano-empresa (`rotaAno`), como na GOOD; a fatia em curso aparece no `_backfill` de sempre. */


/* 16/11 (norte C, montarCheckout passo 6): as ROTINAS DE CUSTO desta empresa — o estado e a anotação da falha, o sync de
   custo (e o "travado", com a re-tentativa), o custo diário das 23 h e a fila de recálculo — são a peça
   lib/checkout/rotinas-custo-empresa, a mesma das três. Aqui só o que é da Girassol, por acessor (lido na hora).
   A história de cada rotina (13/09 a falha identificada, 14/09 a trava pesada, 09-11/09 o custo diário, 13/11 o
   recálculo) está nas peças lib/checkout/custo-sync, custo-sync-travado, custo-diario e custo-recalculo, e o texto que
   ficava aqui em docs/HISTORICO-ROTINAS-CUSTO.md. */
const _rotCusto = require('../lib/checkout/rotinas-custo-empresa').criar({
  empresa: 'girassol',
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


// ─── 19/08: SÓ PRODUTO ATIVO + RESOLVER SKU → PRODUTO ───────────────────────────
/* 11/09 — fatia 2 da desduplicação: estas 111 linhas eram byte a byte iguais aqui e na
   outra empresa, e guardam a regra que nasceu de um caso caro do dono (cadastro EXCLUÍDO
   do 10xE14 fazia o custo do kit virar 20,40 em vez de 34,00). Duas cópias de uma regra
   dessas são duas chances de divergir. Agora vive em lib/checkout/produto-ativo.js. */
const _rotaDeParaSku = require('../lib/checkout/rota-depara-sku').criarRotaDeParaSku({
  empresa: 'girassol', path, CACHE_DIR, json,
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
  empresa: 'girassol',
  minutoCustoDiario: 15,
  plano: _planoGir,   /* 16/11: o plano do ano retomado no boot e a preparação sozinha */
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
    console.log(`[GIRABKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  },
});


/* 14/10 — a VAGA do backfill → 15/11 (norte C): é a peça lib/checkout/backfill-estado. O que MAIS segura a vaga da Girassol
   (canário, rodada do ano entre um mês e outro — _backfill.rodando=false na pausa de 2,5 s mas dona da trava —, reparo de
   SKU) entra como trava extra DELA; as outras empresas registram as delas. */
_ESTADO.travaExtra('girassol', () => !!(_canario.rodando || _reparoAtivo));   /* 15/11: o ano em memória saiu (é o plano) */
function reservarVagaBackfill(msg, emp) { return _ESTADO.reservarVaga(msg, emp); }
function backfillOcupado(emp) { return _ESTADO.ocupado(emp); }
function liberarVagaBackfill(emp) { return _ESTADO.liberarVaga(emp); }

module.exports = { backfillVendas,   /* 16/11: o backfill DA GIRASSOL (a AMB e a GOOD rodam o delas pela peça lib/checkout/backfill-empresa) */
  garantirSitCancel, reservarVagaBackfill, liberarVagaBackfill, backfillOcupado,   /* 14/10: rotina diaria da GOOD (situacoes por empresa + vaga do resgate) */
  /* Codex #309 r2: o desfecho REAL está no _backfill.fase (erro / concluido /
     concluido_com_erros) — a função retorna undefined tanto no sucesso quanto ao ABORTAR
     depois de 6 tentativas na mesma página. Quem chama de fora precisa poder ler isso. */
  backfillEstado,
  id: 'girassol-backup-offline',
  nome: 'Girassol Backup Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14), shopeeKeepAlive: () => shopeeKeepAlive(), noturna: () => _noturna.rotinaNoturna('cron'),
             cacaMagalu: () => _cacaMgGir.cacaMagaluCron(),   /* 29/10: a caça de vendas da Magalu (era só da AMB) */
             cacaMagaluProvisorios: () => _cacaMgGir.cacaMagaluProvisorios() },   /* 16/11 (P1-4): de madrugada, refaz as linhas da Magalu com comissão/frete estimados ou ausentes quando o financeiro chegou */
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '20 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */, noturna: require('../lib/checkout/config-empresa').configCheckout('girassol').madrugada   /* 17/11: o horário da madrugada é do contrato (o status mostra o mesmo) */, cacaMagalu: '25 * * * *', cacaMagaluProvisorios: '50 2 * * *' },   /* 29/10: a caça da Magalu de hora em hora (a AMB roda aos :35) */
  bootstrap
};
