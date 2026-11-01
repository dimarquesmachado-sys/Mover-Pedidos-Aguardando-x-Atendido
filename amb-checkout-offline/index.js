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

let _rotasPainelAMB = async () => false;   /* montado na 1ª requisição */
let _rotasPainelAMBMontado = false;
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
const { garantirToken } = require('../good/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: AMBBKP_QZ_CERT (digital-certificate.txt) e AMBBKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.AMBBKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.AMBBKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

// logo OFICIAL da AMBTOTAL (drone + carrinho, enviado pelo Diego 10/08) — 128px em /icone.png pro favicon, PWA e atalho
const ICONE_B64  = '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';
const VERSAO     = 'amb-checkout-offline v26/08 b92';

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
  CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE,
});
const { shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, SHOPEE_CAB, SHOPEE_SESSAO_FILE,
        _shopeeHash, _urlStatus } = _shopeeSessao;



/* ═══ 22/08 — CUSTO: agora vem de lib/custo.js (código único das 3 empresas) ═════════════
   Estas 15 funções estavam escritas 3× (uma por empresa) e a GOOD já tinha ficado sem 5
   delas — o de-para inteiro. Metade dos erros de 21/08 foi "corrigi numa e esqueci da
   outra". Aqui fica só a ponte: o ctx com o que é DESTA empresa; a regra vive num lugar só.
   `skuInfoCache` vai por getter porque a lib limpa o cache de 6h quando o custo muda. */
const _custoLib = require('../lib/custo');
const _custoComp = require('../lib/custo-composicao');

const _ctxCusto = { CACHE_DIR, path, fs, readJson, writeJson, blingGet,
                    get skuInfoCache() { return typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null; } };
const lerCustosManuais       = ()            => _custoLib.lerCustosManuais(_ctxCusto);
const gravarCustosManuais    = (o)           => _custoLib.gravarCustosManuais(_ctxCusto, o);
const custoManualDe          = (sku, b)      => _custoLib.custoManualDe(_ctxCusto, sku, b);
const comCustosManuais       = (m)           => _custoLib.comCustosManuais(_ctxCusto, m);
const parsearCustosColados   = (t)           => _custoLib.parsearCustosColados(t);
const telaCustosManuais      = (nome, mod)   => _custoLib.telaCustosManuais(nome, mod);
const lerVigencias           = ()            => _custoLib.lerVigencias(_ctxCusto);
const gravarVigencias        = (o)           => _custoLib.gravarVigencias(_ctxCusto, o);
const _vigenciaDeRef = { valor: null }; /* a janela de recuperação seta o dia varrido */
const registrarCustoVigente  = (sku, v, org) => _custoLib.registrarCustoVigente(_ctxCusto, sku, v, org, _vigenciaDeRef.valor);
const custoVigenteEm         = (sku, data)   => _custoLib.custoVigenteEm(_ctxCusto, sku, data);
const lerDeParaSku           = ()            => _custoLib.lerDeParaSku(_ctxCusto);
const gravarDeParaSku        = (o)           => _custoLib.gravarDeParaSku(_ctxCusto, o);
const resolverDeParaSku      = (sku)         => _custoLib.resolverDeParaSku(_ctxCusto, sku);
const sugerirDeParaSku       = (v, cods)     => _custoLib.sugerirDeParaSku(_ctxCusto, v, cods);
const resolverNomeSku        = (d)           => _custoLib.resolverNomeSku(_ctxCusto, d);
const carregarCatalogoDePara = ()            => _custoLib.carregarCatalogoDePara(_ctxCusto);
const _hojeISO  = _custoLib._hojeISO;
const _ontemISO = _custoLib._ontemISO;
const _diaAntes = _custoLib._diaAntes;

/* ═══ 22/08 — vindas de lib/vendas-ops.js (código único) ═════════════════════════════════
   buscarDevolucoesML, varrerFornecedores e reaplicarCusto estavam BYTE-A-BYTE idênticas
   entre AMB e Girassol — 223 linhas escritas duas vezes. Parte da redução dos arquivos
   gigantes; foram as primeiras da fila justamente por já serem idênticas. */
const _ops = require('../lib/vendas-ops');
const _ctxOps = { blingGet, CACHE_DIR, path, readJson, custoVigenteEm, empresa: 'amb',
  /* getter de propósito: _histCache é declarado mais abaixo neste arquivo, e o ctx é
     montado aqui no topo. Ler direto daria undefined; o getter só resolve na hora do uso. */
  get histCache() { return _histCache; } };
const buscarDevolucoesML = (tokenML, dorme)          => _ops.buscarDevolucoesML(tokenML, dorme);
const varrerFornecedores = (max)                     => _ops.varrerFornecedores(_ctxOps, max);
const reaplicarCusto     = (de, ate, empresa, opts)  => _ops.reaplicarCusto(_ctxOps, de, ate, empresa, opts);
/* o estado da reaplicação mora na lib, uma fonte só e separada por empresa. A rota de status
   lê por aqui — sem variável global e sem cópia local que possa sair de sincronia. */
const estadoReapCusto = () => _ops.estadoReaplicar('amb');
const estadoVarrerForn = () => _ops.estadoVarrerFornecedores('amb');


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
  ocupado: () => { const anoR = (typeof _backfillAno !== 'undefined') && _backfillAno && _backfillAno.rodando;
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
    reservar: (msg) => { if (_backfill.rodando || _canario.rodando || _backfillAno.rodando || _reparoAtivo || (_cacaMgAmb.estado() && _cacaMgAmb.estado().rodando)) return false;   /* r4: sku-repara tambem */ _backfill.rodando = true; _backfill.fase = 'resgate'; _backfill.msg = msg || 'resgate'; return true; },
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
    prefixo: '/amb-checkout-offline', tag: 'AMBBKP', empresa: 'amb',
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, JANELA_DIAS, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, RESERVAS_FILE, RESGATES_FILE, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, VERSAO, _detalheBling, _diaAntes, _hojeISO, _moverAtendidoDesandando, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, estadoImposto, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, moverSituacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    mmEtiquetas: () => require('../amb-mm-etiquetas'), mlTokenManager: () => require('../ambtotal/mlTokenManager'),
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'), skuReparaNoHistorico: true,
  });
  return _rotasComunsAmb;
}

function routes(readBody) {
  /* criado DENTRO do routes porque o `readBody` chega como parâmetro dele — o lint pegou
     que eu tinha posto a criação no topo do arquivo, onde ele não existe. */
  const _rotasSeparacao = require('../lib/checkout/rotas-separacao').criar({
    prefixo: '/amb-checkout-offline', tag: base.tag, json, readBody, readJson, writeJson, blingGet, blingWrite, lerReservas,
    locCache, localizacaoDeProduto, salvarLoc, montarSeparacao, montarSeparacaoPorPedido,
    RESERVAS_FILE, LOC_LOG_FILE,
  });
  const _rotasBackfill = require('../lib/checkout/rotas-backfill').criar({
    prefixo: '/amb-checkout-offline', json, readJson, writeJson, ehAdmin, lerChaveAdmin,
    detalhePedido, backfillNFLocal,
    /* o `dorme` do corpo original era uma const LOCAL de outra função, não existia aqui —
       o lint pegou. O módulo tem `sleep`, que é a mesma coisa com outro nome. */
    dorme: sleep, CONFERIDOS_FILE,
    statusValores: _bf, statusDetalhes: _bfd,
  });
  /* 27/10 — CONTAGEM DE ESTOQUE: era só da Girassol (a tela); as rotas já eram a peça lib/checkout/rotas-contagem e
     a tela virou peça única — a AMB ganha, com o depósito DELA (AMBBKP_DEPOSITO_GERAL; sem ele a entrada no Bling
     é RECUSADA em vez de chutar um depósito). */
  const _rotasContagem = require('../lib/checkout/rotas-contagem').criar({
    prefixo: '/amb-checkout-offline', json, validarSessao, lerIndiceEan,
    /* pra a busca distinguir "índice vazio" de "catálogo nunca indexado" */
    getIdxStatus,
    CACHE_DIR, readJson, writeJson, readBody, blingGet,
    /* pra /contagem-saldo resolver a localização sob demanda, no foco do card (Codex #522 P2) */
    produtoDetalhe, localizacaoDeProduto, locCache,
    /* 24/09 — pra APLICAR a entrada no estoque do Bling: blingWrite faz o POST, ehAdmin
       decide quem pode (o desenho é o funcionário informar e o dono aprovar).
       Codex #524 (P1): `ehAdmin` sozinho libera todo mundo quando GIRABKP_ADMIN está vazia —
       `lerAdmins` vai junto pra a rota poder EXIGIR admin configurado nesta escrita irreversível,
       em vez de herdar o "vazio = sem restrição" de rotas menos arriscadas. */
    blingWrite, ehAdmin, lerAdmins,
    /* Codex #526 (P2, r4): cada item lançado faz até 3 chamadas ao Bling seguidas (busca,
       cadastro, POST) — sem pausa ENTRE elas, só depois do item inteiro. A conta é limitada a
       ~3 req/s (mesmo PAUSA_MS de 350ms usado no resto desta pasta); espaçar as chamadas de
       dentro de um item evita fabricar os próprios 429 do lote. */
    PAUSA_MS, sleep,
    /* 27/10: a TELA da contagem é a peça única (lib/checkout/painel/contagem) com a marca do painel desta empresa */
    marca: require('./painel-marca'),
    empresa: {
      pasta: 'amb-checkout-offline',
      /* o depósito é POR EMPRESA. O da GOOD é 4956031259; o da Girassol ainda não foi
         levantado — a rota /contagem-depositos lista os ids pra preencher esta env.
         Sem ela, a entrada é RECUSADA em vez de chutar um depósito. */
      envDeposito: 'AMBBKP_DEPOSITO_GERAL',
    },
  });
  const _rotasNfAnexar = require('../lib/checkout/rotas-nf-anexar').criar({
    prefixo: '/amb-checkout-offline', empresaId: 'amb', json, readBody, readJson, writeJson, ensureDir, ehAdmin,
    lerChaveAdmin, mlSyncFees, shopeeKeepAlive, shopeeSessaoLer, CACHE_DIR, MANIFEST_FILE,
    SHOPEE_ENV_COOKIE, VERSAO, statusMlSync: _mls,
  });
  const _rotasConferido = require('../lib/checkout/rotas-conferido').criar({
    prefixo: '/amb-checkout-offline', tag: base.tag, json, readBody, readJson, writeJson, lerReservas, moverSituacao,
    arquivarFinalizado, sincronizarConferidos, rodarCiclo, CONFERIDOS_FILE, RESERVAS_FILE,
    CACHE_DIR, SIT_VERIFICADO, SYNC_ON, VERSAO,
    fullJaDespachado,
    FULL_VAI_DESPACHADOS: !!require('./base').SIT_DESPACHADOS,   // so quando o ciclo MOVE o Full pra DESPACHADOS (#701); destino 0 = desligado, Full segue pro VERIFICADO (Codex #702)
  });

  // histórico/análise: histCache vai por REFERÊNCIA — o backfill e o /backfill-limpar
  // esvaziam esse mesmo objeto aqui no index e isso tem que valer lá dentro também.
  /* 31/10: o DIAGNÓSTICO (peça única lib/checkout/diagnostico-empresa, como a Girassol) — chamado POR ÚLTIMO no handler */
  const diag = require('./amb-diagnostico').rotasDiagnostico({ VERSAO, validarSessao, supaCfg, readBody });
  const hist = rotasHistorico({ validarSessao, supaCfg, DEFAULT_ALIQ_BK, histCache: _histCache, magaluFretePrevistoSku });
  const pesca = rotasPescaria({ validarSessao, supaCfg, supaReq, pescarDadosML });
  const canario = rotasCanario({ VERSAO, validarSessao });
  const limpeza = rotasLimpeza({ validarSessao });
  const shopee = rotasShopee({ validarSessao });


  /* 15/09 — /api/contexto: identidade e capacidades desta empresa, pro painel se montar
     sozinho em vez de cada HTML saber de qual empresa ele é (base da Fase 4). Só identidade
     e capacidade: nada de credencial, caminho ou env — isto chega no navegador do galpão. */
  const _ctxApi = require('../lib/checkout/contexto-api').montar({
    empresa: 'amb',
    modulo: 'amb-checkout-offline',
    json,
    uiBuild: require('./painel-marca').UI_BUILD,   /* 27/10: a versão do painel vem da marca (o painel é a peça única) */
  });
  return async function handle(req, res, urlObj) {
    if (await _ctxApi(req, res, urlObj)) return true;

    /* 15/09 — descoberta dos ids desta empresa NO BLING (canais de venda, depósitos e
       situações). Pedido do dono em 26/08: hoje esses ids são mapeados no DevTools, tela por
       tela, e é a maior fonte de digitação no embarque — e a que mais erra, porque id de
       FILIAL e id de UNIDADE DE NEGÓCIO são espaços diferentes. Com o token que a empresa já
       tem depois do OAuth, dá pra simplesmente perguntar. */
    if (urlObj.pathname === '/amb-checkout-offline/descobrir-ids') {
      const _k = lerChaveAdmin(req, urlObj);
      if (!process.env.ADMIN_KEY || _k !== process.env.ADMIN_KEY) { json(res, 403, { ok: false, erro: 'chave inválida' }); return true; }
      try {
        const d = require('../lib/checkout/descobrir-ids').criar({ rotulo: 'AMB', blingGet , /* o token do ML vem do gerenciador fiscal DESTA empresa — o lint pegou que eu
       supus uma variável `garantirTokenML` solta que não existe aqui. */
      garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(), envNomes: {"atendido": "AMBBKP_SIT_ATENDIDO", "despachados": "AMBBKP_SIT_DESPACHADOS", "verificado": "AMBBKP_SIT_VERIFICADO", "aguardando": "AMB_SITUACAO_AGUARDANDO", "meLojaIds": "AMB_ME_LOJA_IDS"}, temExpedicao: require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade('amb', 'expedicao') === true , /* 16/09 (P2 do Codex): o padrão do canal do ML foi REMOVIDO do código — declarar
           aqui faria a conferência dizer "não existe no Render, mas o padrão do código já é
           este valor, criar não muda nada", que hoje é o contrário da verdade: sem a env, o
           F1 e o F3 se recusam a rodar. Dizer que está tudo bem quando não está é o pior
           jeito de errar numa ferramenta de conferência. */
        padroesEnv: {"AMBBKP_SIT_ATENDIDO": "9", "AMBBKP_SIT_DESPACHADOS": "745123", "AMBBKP_SIT_VERIFICADO": "24", "AMB_SITUACAO_AGUARDANDO": "745122"}  });
        json(res, 200, await d.descobrir());
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); }
      return true;
    }
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
        p === '/amb-checkout-offline/painel' ||
        /* 02/10: os scripts compartilhados do painel são INTERFACE — o `<script src>` não leva
           a querystring da página, e sem isto quem abre por `?k=` tomava 401 (lição do #582).
           Os dados seguem exigindo sessão ou chave, nas rotas deles. */
        p === '/amb-checkout-offline/js/plano-compra.js' ||
        p === '/amb-checkout-offline/js/previsao-vendas.js' ||
        p === '/amb-checkout-offline/js/ferramentas-custo.js' ||
        p === '/amb-checkout-offline/js/devolucoes-ml.js' ||
        p === '/amb-checkout-offline/js/despesas-shopee.js' ||
        p === '/amb-checkout-offline/js/ficha-produto.js' ||
        p === '/amb-checkout-offline/js/manutencao.js' ||
        p === '/amb-checkout-offline/js/ml-financeiro.js' ||
        p === '/amb-checkout-offline/js/nf-local.js' ||
        p === '/amb-checkout-offline/nf-travadas' ||   /* 04/09: leitura pro card de NFs travadas */
        p === '/amb-checkout-offline/duplicatas' ||   /* guard próprio por ADMIN_KEY */ p === '/amb-checkout-offline/login' ||
        p === '/amb-checkout-offline/operadores' || p === '/amb-checkout-offline/health' ||
        p === '/amb-checkout-offline/saude' || require('../lib/http/rotas-protegidas').ehCallbackOAuth(p) ||   /* 01/11 (Codex F01): só caminho que TERMINA em /callback */
        p === '/amb-checkout-offline/qz-cert' || p === '/amb-checkout-offline/qz-sign' ||
        p === '/amb-checkout-offline/danfes-lote' ||   /* 30/10: guard próprio (sessão de admin; sem ela, volta pro painel) — como na GOOD */
        p === '/amb-checkout-offline/shopee-semear' ||   // semear cookie da sessao (auth propria por ?k=)
        p === '/amb-checkout-offline/shopee-devolucao' ||   // devolucao entregue? (auth propria por ?k= ou sessao admin)
        p === '/amb-checkout-offline/dashboard' ||   // Codex PR#38: auth PRÓPRIA na rota (sessão ADMIN ou ?k=) — o gate barrava o ?k= sem cookie
        p === '/amb-checkout-offline/historico' ||   // Codex PR#38 P1/P2: auth própria em camadas (admin completo / operador stripado / anônimo só com k)
        p === '/amb-checkout-offline/ml-fatura-cartao' ||
      p === '/amb-checkout-offline/ml-fatura-auditoria' ||
        p === '/amb-checkout-offline/ml-billing-outros' ||   /* guard próprio por ADMIN_KEY */
        p === '/amb-checkout-offline/ml-billing-resumo'   // Codex PR#38: auth própria (admin)
      );
      /* 01/11 (auditoria Codex F01): a MESMA regra do porteiro central do servidor (lib/http/rotas-protegidas) — antes era
         mais frouxa (qualquer 'debug', '/run'…) e /pedido/debugging/123 escapava dos dois porteiros sem credencial */
      const _central = require('../lib/http/rotas-protegidas').ehRotaCentralAdmin(p);
      if (_meu && !_pub && !_central) {
        const _op = validarSessao(req.headers['cookie']);
        if (!_op) {
          // Codex PR#38 (2ª rodada): a ADMIN_KEY vale como credencial já no gate — o fluxo
          // ?k= do dashboard chama /historico-longo, /previsao-vendas, /plano-compra, /sku-info
          // etc., e todas morriam aqui no 401 antes de a guarda admin própria delas avaliar a
          // chave. Cada rota de dados continua revalidando (chave OU sessão admin) por conta.
          const _kG = lerChaveAdmin(req, urlObj);
          if (process.env.ADMIN_KEY && _kG === process.env.ADMIN_KEY) { req._op = 'admin-key'; req._admKey = true; }
          else { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
        } else { req._op = _op; }
      }
    }

    /* 15/09 — rotas de catálogo (buscar produto + indexação de EAN) vieram pra
       lib/checkout/rotas-catalogo.js: eram idênticas nas três e se apoiam entre si.
       Codex (P1): tem que rodar DEPOIS da guarda de sessão acima — o handler da lib
       não valida sessão sozinho, e antes da guarda ficava aberta pra buscar-produto
       e indexar-status sem cookie nenhum. */
    if (await _rotasCatalogo(req, res, urlObj, method)) return true;
    /* 29/10: SONDA dos pedidos cancelados no marketplace ANTES da postagem (só leitura; TikTok primeiro) — lib/checkout/rotas-cancelados-mkt */
    if (!_rotasCancMkt) _rotasCancMkt = require('../lib/checkout/rotas-cancelados-mkt').criar({ prefixo: '/amb-checkout-offline', empresa: 'ambtotal', tiktokConta: 'amb',
      manifest, lerConferidos: () => readJson(CONFERIDOS_FILE, {}), json, validarSessao, ehAdmin });
    if (await _rotasCancMkt(req, res, urlObj, method)) return true;
    if (await _rotasContagem(req, res, urlObj, method)) return true;   /* 27/10: a contagem de estoque (a tela e as rotas) */
      /* mesma posição da de catálogo: DEPOIS do portão de sessão (Codex #480). */
      if (await _rotasSeparacao(req, res, urlObj, method)) return true;
      if (await _rotasBackfill(req, res, urlObj, method, validarSessao)) return true;
      if (await _rotasNfAnexar(req, res, urlObj, method, validarSessao)) return true;
      if (await _rotasConferido(req, res, urlObj, method, validarSessao)) return true;

    // ── SONDA DE UNIDADE DE NEGÓCIO (temporária, diagnóstico) ───────────
    // Objetivo: descobrir ONDE, no JSON do pedido da API do Bling, aparece a
    // unidade de negócio (Shopee FULL vs Matriz) — se vem na LISTA de pedidos
    // ou só no DETALHE. Sem isso, não dá pra escrever o filtro com segurança.


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
    /* 01/09 — CAÇA DUPLICATA: agosto da AMB fecha R$ 259 mil no Bling contra R$ 208 mil no
       Jodda e R$ 207 mil no nosso dashboard. Os dois independentes concordam, então a sobra
       está no Bling — provavelmente venda importada duas vezes. Esta rota procura, do sinal
       mais forte pro mais fraco: mesmo número de venda do marketplace (duplicata quase
       certa), mesmo cliente+valor+data, e mesmo cliente+valor em até 2 dias. */
    /* 04/09 — NFs TRAVADAS: o ML recusa por erro que só mão humana resolve (CEP que o Bling
       importou errado, documento inválido). A F3 parou de retransmitir; aqui o checkout
       mostra quais precisam de intervenção, com o que fazer em cada uma. */

    /* 23/10 (passo 2): as rotas do canário da peça única — a AMB ganha também o /canario-estado (o aviso no painel) */
    if (await _canEmp.rotas({ PREFIXO: '/amb-checkout-offline', json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p)) return true;

    /* 31/10 — as ROTAS COMUNS (as que as três empresas tinham escritas iguais aqui: arquivos, DANFE, etiqueta, XML,
       impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML, cookies da Shopee, separação) viraram
       a peça única lib/checkout/rotas-comuns, chamada no lugar da primeira delas */
    if (await _rotasComuns(readBody).handle(req, res, p, method, urlObj)) return true;



    // ── SEMEAR SESSÃO SHOPEE (b22) — cola o cURL (ou só o trecho do
    // Cookie:) da chamada que FUNCIONA no seu navegador, e o servidor
    // extrai o cookie e grava no jar. Serve pros cookies HttpOnly
    // (SPC_ST etc.) que a captura manual pra env AMBBKP_SHOPEE_COOKIE
    // nao pega. Guarda: ?k=ADMIN_KEY. POST body {curl:"..."} OU {cookie:"..."}.
    if (method === 'POST' && p === '/amb-checkout-offline/shopee-semear') {
      const kSe = lerChaveAdmin(req, urlObj);
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
      const kSd = lerChaveAdmin(req, urlObj);
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
    /* 27/08 (pedido de 13/08) — RECEBE OS COOKIES DA EXTENSÃO: mata o DevTools. A extensão do
       navegador captura os cookies da sessão LOGADA do Seller Center e manda pra cá; grava no
       _shopee-sessao.json com a SEMENTE da env preservada (assim o cookie novo prevalece sem a
       env 'mandar' de volta — a semente só dispara quando a PRÓPRIA env muda) e testa a sessão
       na hora com o keep-alive, devolvendo se ficou viva. A env do Render vira só a semente de
       emergência. */



    // ADMIN: ANEXAR ETIQUETA PDF na mão. Existe pro caso real em que o Bling fica SEM logística
    // no pedido (importou depois do envio já organizado no canal, ou a NF travou a edição) e a
    // etiqueta não vem nem pelo Bling nem pela API do canal. O admin baixa a etiqueta no painel do
    // marketplace, anexa aqui, e o pedido volta a ser processável pelo estoquista — que NÃO precisa
    // (nem deve) ter acesso ao seller center. Body: { id, pdf_base64 }.
    /* 30/10 — ETIQUETAS EM MASSA, a página de envio e as DANFEs em LOTE (peça única lib/checkout/rotas-lote) */
    if (await _rotasLote(readBody).handle(req, res, p, method, urlObj)) return true;

    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).



    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /amb-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.


    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /amb-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31


    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    if (method === 'POST' && p === '/amb-checkout-offline/sku-info') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = lerChaveAdmin(req, urlObj);
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const skus = Array.isArray(body.skus) ? body.skus.map(x => String(x || '').trim()).filter(Boolean).slice(0, 40) : [];
      if (!skus.length) { json(res, 200, { ok: true, skus: {} }); return true; }
      const CACHE_SKUINFO = path.join(CACHE_DIR, '_skus-info.json');
      if (!_skuInfoCache) _skuInfoCache = readJson(CACHE_SKUINFO, {});
      /* Codex (#186): guarda a versão do custo/de-para agora. Se alguém mudar o mapa enquanto esta
         requisição espera a rede, no fim a gente percebe e NÃO grava — senão o valor velho voltava
         pro cache e era servido por mais 6h, mesmo com a limpeza feita na hora da mudança. */
      const _epoca0 = _custoLib.epocaCusto(_ctxCusto);
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
        const k2 = _custoLib.custoDeSku(_ccAll, sku);
        if (k2 && k2.id && (Date.now() - (k2.ts || 0)) < 7 * 24 * 3600 * 1000) { ids[sku] = { id: k2.id, nome: (k2.nome || null), preco: (k2.preco != null ? k2.preco : null), custo: (k2.custo != null ? k2.custo : null) }; }
        else aResolver.push(sku);
      }
      // 1) resolve SKU → produto — só quem NÃO está no cache permanente
      for (const sku of aResolver) {
        try {
          let prod = null;
          /* Codex #497 (r4): a cópia inline (caixa exata/maiúscula/minúscula + reserva do inativo)
             veio "espelhada" da GOOD e trouxe junto os mesmos dois bugs que a review achou lá:
             um cadastro sem `situacao` na 1ª variante travava o laço como se fosse ATIVO (a
             variante seguinte, com o ativo de verdade, nunca era tentada), e se o detalhe da
             reserva falhasse o produto virava `null` em vez de manter a reserva (perdendo saldo/
             preço/custo que já tínhamos). resolverProdutoPorSku (lib/checkout/produto-ativo.js,
             já usado no custo-sync desta empresa) resolve os dois num lugar só. */
          const _res = await resolverProdutoPorSku(sku, bg, 10);
          if (_res.produto && _res.produto.id) {
            const d = await bg(`/produtos/${_res.produto.id}`);
            prod = (d.ok && d.data && d.data.data) || _res.produto;
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
        if (info.custo == null) { const kP = _custoLib.custoDeSku(_ccAll, sku); if (kP && kP.custo != null) { info.custo = kP.custo; if (info.preco == null && kP.preco != null) info.preco = kP.preco; } }
        const c0 = _skuInfoCache[sku];
        if (info.custo == null && c0 && c0.custo != null) info.custo = c0.custo;   // e o valor antigo do cache de 6h também vale mais que um null novo
        _skuInfoCache[sku] = info; out[sku] = info;
      }
      const _mapaMudou = _custoLib.epocaCusto(_ctxCusto) !== _epoca0;
      if (_mapaMudou) {
        // o de-para/custo mudou no meio: o que resolvemos pode estar velho. Não contamina o cache.
        try { for (const _k of Object.keys(_skuInfoCache)) delete _skuInfoCache[_k]; } catch (e) {}
        try { if (fs.existsSync(CACHE_SKUINFO)) fs.unlinkSync(CACHE_SKUINFO); } catch (e) {}
      } else if (faltam.length) { try { writeJson(CACHE_SKUINFO, _skuInfoCache); } catch (e) {} }
      json(res, 200, { ok: true, skus: out, consultados_agora: faltam.length, resolvidos: Object.keys(ids).filter(k2 => ids[k2]).length, nao_resolvidos: resolveFalhas });
      return true;
    }

    // DASHBOARD — página (amb-dashboard.html do módulo)
    /* 30/08 — CUSTO DE DEVOLUÇÕES DO TIKTOK (mesma lib da Girassol, empresa como parâmetro:
       lib/tiktok-custo-devolucoes.js não é cópia). Linha própria no período, não abatimento
       na venda — quando o custo vem de erro de expedição, abater no SKU culpa o produto. */
    /* 30/08 — CANCELAMENTOS DO MAGALU pro dashboard. Mesma decisão do TikTok: linha própria
       no período, não abatimento na venda. E aqui só entra o que CHEGOU a virar faturamento:
       pedido que o cliente não pagou nunca somou, então descontá-lo inventaria prejuízo —
       na Girassol isso seria R$ 8.549 de perda fictícia. */


    if (method === 'GET' && p === '/amb-checkout-offline/dashboard') {
      // NUNCA estoquista (pedido do Diego, 11/08): a página exige ADMIN — sessão de admin
      // logado OU ?k=ADMIN_KEY. Não-admin volta pro painel, sem alarde (302).
      const sD = validarSessao(req.headers['cookie']);
      const kD = lerChaveAdmin(req, urlObj);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sD && ehAdmin(sD)))) { res.writeHead(302, { Location: '/amb-checkout-offline/painel' }); res.end(); return true; }
      /* 20/10 (tela única): a tela mora na LIB (lib/checkout/painel/dashboard.html) e sai pelo MESMO gerador das
         outras empresas — a AMB sem troca de identidade (o modelo já é a tela dela), só com as capacidades dela */
      try {
        /* 21/10: a configuração do painel de cada empresa mora num lugar só (lib/checkout/painel/empresas.js) */
        const htmlContent = require('../lib/checkout/painel/empresas').painelDaEmpresa('ambtotal');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(htmlContent);
      } catch (e) { json(res, 500, { erro: 'painel: ' + e.message }); }
      return true;
    }


    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /amb-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)


    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal
    if ((method === 'GET' || method === 'POST') && p === '/amb-checkout-offline/config-fiscal') {
      const opSess = validarSessao(req.headers['cookie']);
      // Codex PR#38 (3ª rodada): "apenas admin" aceita TAMBÉM a ADMIN_KEY — mesma credencial
      // que o gate e as rotas irmãs já honram; sem isso o fluxo ?k= recebia 403 aqui e o
      // dashboard carregava config fiscal default em silêncio (números errados).
      const _kAdm = lerChaveAdmin(req, urlObj);
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const CFG_FILE = path.join(CACHE_DIR, '_config-fiscal.json');
      /* 18/09 — a rota devolve TAMBÉM as alíquotas apuradas do código. Sem isso, o ⚙️ mostra
   doze campos vazios e o dono não tem como saber qual alíquota está valendo: vazio ali
   significa "usa a tabela", e a tabela ele não vê. Campo em branco que esconde um valor
   ativo é a mesma armadilha do card sem origem. */
if (method === 'GET') { json(res, 200, { ok: true, apuradas: DEFAULT_ALIQ_BK, apurados_meses: ALIQ_APURADOS, config: readJson(CFG_FILE, { aliquotas: {}, taxas: {} }) }); return true; }
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
      /* 18/09 — QUAL MÊS JÁ FOI APURADO, dito pelo dono. O ritual dele: estima o mês e, por
         volta do dia 20, a contabilidade manda a apuração. Depois de salvo, a tela não
         distinguia uma coisa da outra — agosto apurado e setembro estimado apareciam iguais
         como "salva aqui", e ele não tinha como saber, olhando três empresas, quais ainda
         faltavam trocar.
         A marcação é DELE: ninguém consegue deduzir isso do número. Guardada como lista, não
         como campo dentro da alíquota, pra não mexer no formato que o cálculo já lê. */
      if (Array.isArray(body.apuradas)) {
        const novasApuradas = body.apuradas.filter(m => /^\d{4}-\d{2}$/.test(m));
        // Codex (P2): body.aliquotas sempre traz as 12 chaves do ano que o formulário mostrou
        // (mesmo mês vazio manda null) — dá pra saber qual ano o dono está editando e preservar
        // os apurados de anos anteriores, que o formulário nem carrega nem manda de volta.
        // Sem isto, o primeiro salvamento após a virada do ano apagava as marcações antigas.
        const chavesAno = (body.aliquotas && typeof body.aliquotas === 'object') ? Object.keys(body.aliquotas) : [];
        const anoForm = chavesAno.length ? chavesAno[0].slice(0, 4) : null;
        const apuradasAntigas = Array.isArray(atual.apuradas) ? atual.apuradas : [];
        atual.apuradas = anoForm ? apuradasAntigas.filter(m => m.slice(0, 4) !== anoForm).concat(novasApuradas) : novasApuradas;
      }
      if (body.taxas && typeof body.taxas === 'object') for (const [k2, v2] of Object.entries(body.taxas)) { const n2 = Number(v2); if (isFinite(n2) && n2 >= 0 && n2 <= 50) atual.taxas[String(k2).toLowerCase()] = n2; else if (v2 === null) delete atual.taxas[String(k2).toLowerCase()]; }
      if (body.flex && typeof body.flex === 'object') { atual.flex = atual.flex || {}; for (const [k2, v2] of Object.entries(body.flex)) { if (v2 === null) { delete atual.flex[k2]; continue; } /* Codex #695: campo limpo apaga o override (Number(null) virava 0) */ const n2 = Number(v2); if (['ml', 'shopee', 'outros', 'geral'].indexOf(k2) >= 0 && isFinite(n2) && n2 >= 0 && n2 <= 100) atual.flex[k2] = n2; } }
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


    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /amb-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso



    // LIMPA toda a tabela (empresa amb) — pra recomeçar o backfill do zero. Uso: /amb-checkout-offline/backfill-limpar
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-limpar') {
      const kD = lerChaveAdmin(req, urlObj);
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

    if (method === 'GET' && p === '/amb-checkout-offline/despachados-por-engano') {
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
      const setEmissaoPropriaE = new Set(UNS_EMISSAO_PROPRIA_CASA.concat(String(process.env.AMBBKP_UN_FULL_EMISSAO_PROPRIA || '').split(',').map(x => x.trim()).filter(Boolean)));

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



    // DISPARA o backfill do ANO TODO — roda os meses de janeiro até 'ate' EM SEQUÊNCIA, sozinho. Uso: /amb-checkout-offline/backfill-ano  (ou &ate=07 pra parar em julho)
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-ano') {
      const kD = lerChaveAdmin(req, urlObj);
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
           identidade da rodada. Aqui a rota dispara com 'amb' (ver a chamada logo abaixo). */
        const mesmoPeriodo = _backfill.empresa === 'amb' && _backfill.de === de && _backfill.ate === ate;
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

    // 🛒 CAÇA DA MAGALU — dispara pra um período (?de=&ate=) ou vê o status (?status=1)
    if (method === 'GET' && p === '/amb-checkout-offline/magalu-caca') {
      const kM = lerChaveAdmin(req, urlObj);
      const sM = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kM === process.env.ADMIN_KEY) || (sM && ehAdmin(sM)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, status: _cacaMgAmb.estado() }); return true; }
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
      if (_cacaMgAmb.estado().rodando) { json(res, 200, { ok: true, ja_rodando: true, status: _cacaMgAmb.estado() }); return true; }
      cacaMagalu(deM, ateM, 'amb', { refazer: urlObj.searchParams.get('refazer') === '1' }).catch(e => console.log('[CACA-MAGALU] ' + (e.message || e)));
      json(res, 200, { ok: true, msg: '🛒 caça da Magalu iniciada em background (' + deM + ' a ' + ateM + ') — acompanhe em /amb-checkout-offline/magalu-caca?status=1 (acrescente &k= com a sua chave)', de: deM, ate: ateM });
      return true;
    }

    // 🧮 PLANO DE COMPRA — o motor. Junta ritmo de venda (histórico), saldo e imagem (Bling) e custo
    // (_custos.json) e devolve, por SKU: quanto comprar pra cobrir lead time + cobertura desejada,
    // o quanto isso custa e QUANTO LUCRO ESTÁ EM RISCO se faltar. Ordenado pelo risco, não pelo volume.
    // Uso: /amb-checkout-offline/plano-compra?lead=4&cob=5&seg=0.5&base=180&curva=A
    if (method === 'GET' && p === '/amb-checkout-offline/plano-compra') {
      const kC = lerChaveAdmin(req, urlObj);
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      const par = n => Number((urlObj.searchParams && urlObj.searchParams.get(n)) || '');
      /* Codex #649 (P1): ZERO É ESCOLHA — `par('lead') || 4` trocava lead=0 por 4 meses em silêncio
         (a peça compartilhada manda 0 como valor válido). Só valor ausente/inválido cai no padrão. */
      const _nP = (nome, pad) => { const v = String((urlObj.searchParams && urlObj.searchParams.get(nome)) || '').trim(); const x = Number(v.replace(',', '.')); return (v !== '' && isFinite(x)) ? x : pad; };
      const lead = Math.min(24, Math.max(0, _nP('lead', 4)));          // meses até a mercadoria chegar
      const cob  = Math.min(24, Math.max(0.5, _nP('cob', 5)));         // meses de estoque desejados DEPOIS que chegar
      const seg  = Math.min(6, Math.max(0, _nP('seg', 0)));            // 29/07: sem colchão separado — a cobertura escolhida já é a decisão
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
        /* Codex #649 (P1): saldo DESCONHECIDO não é zero (mesmo contrato da fábrica, #571) — sem saldo
           não há quantidade a comprar nem investimento: ficam null. */
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
          md: Math.round(md * 1000) / 1000, saldo: x.saldo, acaba_em: acabaEm,
          precisa, comprar, custo_un: custoUn,
          investir: (custoUn != null && comprar != null) ? Math.round(comprar * custoUn * 100) / 100 : null,
          mc_un: Math.round(mcUn * 100) / 100,
          risco: Math.round(risco * 100) / 100,
          sem_saldo: x.saldo == null, sem_custo: custoUn == null
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
    if (method === 'GET' && p === '/amb-checkout-offline/ml-billing') {
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
      if (_reparoAtivo) { json(res, 409, { ok: false, erro: 'outro reparo de SKU em andamento — tente depois' }); return true; }
      _reparoAtivo = true;
      try {
      if (_cacaMgAmb.estado() && _cacaMgAmb.estado().rodando) { json(res, 409, { ok: false, erro: 'caça da Magalu rodando — tente depois' }); return true; }
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
      /* Codex (#185/#186): o PATCH mudou o histórico, mas o _histCache guarda os agregados por até
         30 min — sem limpar, o dashboard segue mostrando o SKU ANTIGO e o reparo parece ter
         falhado. Mesma limpeza que o backfill e a caça já fazem.
         E limpa depois do PATCH que DEU CERTO, não antes do segundo: quando o primeiro falha e
         entra o de reserva, uma consulta do dashboard no meio repovoava o cache com o dado velho,
         e nada mais limpava — os agregados ficavam errados até o TTL vencer. */
      const _limpaHist = () => { try { for (const _k of Object.keys(_histCache)) delete _histCache[_k]; } catch (e) {} };
      if (!rp.ok) {
        // sku_anterior pode não existir como coluna — tenta de novo só com o sku
        const rp2 = await supaReq('amb', 'PATCH', 'vendas_historico?empresa=eq.amb&sku=eq.' + encodeURIComponent(deSku), { sku: paraSku });
        if (!rp2.ok) { _limpaHist(); json(res, 200, { ok: false, erro: 'PATCH falhou: HTTP ' + rp.status + ' / ' + rp2.status, detalhe: String(rp.body || '').slice(0, 200) }); return true; }
        _limpaHist();
        outR.avisos.push('coluna sku_anterior não existe — gravado só o sku novo');
      } else _limpaHist();
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
      } finally { _reparoAtivo = false; }


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

    if (method === 'GET' && p === '/amb-checkout-offline/sku-orfaos') {
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
      const kG = lerChaveAdmin(req, urlObj);
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
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const vendaD = String(urlObj.searchParams.get('venda') || '').trim();
      if (!vendaD) { json(res, 400, { ok: false, erro: 'use ?venda=<numero da venda no ML>&k=ADMIN_KEY' }); return true; }
      const outD = { venda: vendaD, order: null, shipment: null, costs: null, pagamentos: null, billing: [], erros: [] };
      try {
        const { garantirTokenML } = require('../ambtotal/mlTokenManager');
        const tk = await garantirTokenML();
        const HD = { headers: { Authorization: 'Bearer ' + tk } }   /* Codex #343 r4: objeto REUSADO em várias requisições — sinal aqui abortaria todas as seguintes junto com a primeira; timeout é por requisição, em quem chama */;

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
      const k = lerChaveAdmin(req, urlObj);
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
      const kA = lerChaveAdmin(req, urlObj);
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
    if (method === 'GET' && p === '/amb-checkout-offline/raio-x-venda') {
      const kR = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const venda = String(urlObj.searchParams.get('venda') || '').replace(/\D/g, '');
      if (!venda) { json(res, 400, { ok: false, erro: 'use ?venda=2000018258015754&k=SUA_ADMIN_KEY' }); return true; }
      const out = { ok: true, venda, ml: {}, bling: {}, veredito: null };
      try {
        const { garantirTokenML } = require('../ambtotal/mlTokenManager');
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
    // ── DEVOLUÇÕES DO ML (14/08) — mesma lib da Girassol, empresa como parâmetro ──────
    // A busca do ML mistura devolução com reclamação e cancelamento; só `returns` conta.
    // SKU/valor vêm do PRÓPRIO pedido no ML (o histórico às vezes guarda o pack, não o order).
    if (method === 'GET' && (p === '/amb-checkout-offline/ml-devolucoes' || p === '/amb-checkout-offline/ml-devolucoes-coletar')) {
      const kV = lerChaveAdmin(req, urlObj);
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

    /* 02/09 — O QUE SOBROU EM 'outros': depois de classificar 4 categorias novas, a AMB ainda
       tem -R$ 450 e a Girassol R$ 4.286 nesse balde. Como o valor da AMB é NEGATIVO, é crédito
       que o ML devolveu e o dashboard não mostra — dinheiro faltando a favor do dono. Esta rota
       lista as descrições que não casaram com nenhuma regra, agrupadas, pra fechar de vez em
       vez de adivinhar. Só lê o cache; não chama a API nem grava nada. */
    /* 02/09 — FATURA DO CARTÃO do ML, pelo ciclo do ML (13→12), com composição. Vem do campo
       debited_from_operation que a coleta passou a gravar; sem re-sincronizar, os registros
       antigos não têm a marca e aparecem em sem_marca. Só lê o cache. */

    /* 30/09 — RAIO-X DA FATURA DO CARTÃO. O painel da AMB mostrou R$ 6.455,32 num ciclo em
       que o cartão debitou R$ 5.928,23, com o dado FRESCO — então não é atraso. Duas
       categorias batiam byte a byte com a fatura oficial, o que aponta CLASSIFICAÇÃO, não
       coleta.
       Esta rota não corrige nada: abre o ciclo linha a linha com a marca que o ML mandou em
       cada tarifa, pra comparar com o relatório de Faturamento. Achar por dedução foi o que
       já custou caro aqui. Só leitura, e só admin. */
    if (method === 'GET' && p === '/amb-checkout-offline/ml-fatura-auditoria') {
      const kA = lerChaveAdmin(req, urlObj);
      const sA = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kA === process.env.ADMIN_KEY) || (sA && ehAdmin(sA)))) { json(res, 404, { error: 'not found' }); return true; }
      try {
        const aud = require('../lib/ml-fatura-auditoria');
        const b = readJson(MLB_FILE(), { tarifas: {} });
        const esc = aud.escolherCiclo(b.tarifas, urlObj.searchParams.get('ciclo'));
        if (esc.erro) { json(res, 200, { ok: false, erro: esc.erro, sem_dado: !!esc.sem_dado, atualizado: b.atualizado || null, ciclos_disponiveis: esc.ciclos }); return true; }
        const ciclos = esc.ciclos;
        const detalhe = urlObj.searchParams.get('linhas') === '1';
        const r = aud.abrirCiclo(b.tarifas, esc.ref);
        if (!detalhe) delete r.linhas;   /* a lista inteira só sob pedido: são milhares */
        json(res, 200, Object.assign({ ok: true, atualizado: b.atualizado || null, ciclos_disponiveis: ciclos }, r, {
          leia: 'compare `por_categoria` com o relatorio de Faturamento do ML. ' +
                '`no_cartao_com_pedido` > 0 sugere tarifa de venda classificada como cartao; ' +
                '`creditos.fora_do_cartao` sugere estorno que nao foi subtraido. ' +
                'Use &linhas=1 para ver linha a linha.',
        }));
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e) });
      }
      return true;
    }

    if (method === 'GET' && p === '/amb-checkout-offline/ml-billing-outros') {
      const kO = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kO === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      try {
        const b = readJson(MLB_FILE(), { tarifas: {} });
        const grupos = {};
        for (const t2 of Object.values(b.tarifas || {})) {
          if (!t2 || t2.c !== 'outros') continue;
          const txt = String(t2.t || '(sem descrição)').trim();
          const g = grupos[txt] || (grupos[txt] = { descricao: txt, qtd: 0, valor: 0, exemplo_dia: t2.d || null });
          g.qtd++; g.valor = Math.round((g.valor + (Number(t2.v) || 0)) * 100) / 100;
        }
        const lista = Object.values(grupos).sort((x, y) => Math.abs(y.valor) - Math.abs(x.valor));
        json(res, 200, { ok: true, empresa: 'amb-checkout-offline',
          linhas_em_outros: lista.reduce((s, g) => s + g.qtd, 0),
          valor_em_outros: Math.round(lista.reduce((s, g) => s + g.valor, 0) * 100) / 100,
          descricoes: lista.slice(0, 60),
          leia: 'cada linha é uma descrição que nenhuma regra de _mlbCategoria reconheceu. Valor negativo = crédito que o ML devolveu e que hoje não aparece em nenhum card.' });
      } catch (e) {
        json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) });
      }
      return true;
    }



    // 02/08 - VENDAS DIRETO DO MERCADO LIVRE (o marketplace e a fonte; o Bling e espelho).
    // Decisao do Diego: se a venda ocorreu no dia, tem que aparecer no dia — mesmo que o ML ainda
    // nao tenha organizado o envio e o Bling nem saiba dela (envio agendado, Fulfillment, etc).
    // ESTE E O PASSO 1: so LE do ML e compara com o que temos. Nao muda nada em producao.
    if (method === 'GET' && p === '/amb-checkout-offline/ml-vendas-do-dia') {
      const kV = lerChaveAdmin(req, urlObj);
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
      const kF = lerChaveAdmin(req, urlObj);
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
    /* 27/08 — CLASSIFICADOR das vendas 'faltando' do /ml-vendas-faltando: consulta o status REAL
       de cada uma na API do ML. Motivo: o billing pode lançar o ESTORNO da comissão noutra
       categoria, então venda CANCELADA fica no mapa com comissão cheia — indistinguível de venda
       perdida sem olhar o status. Separa: cancelada (ok, o histórico exclui de propósito) ×
       carrinho que o billing não mapeou (ok, está no nosso pelo número do pack) × PAGA-E-AUSENTE
       (o buraco real a importar). Máx 250 por chamada (~1min) — rode em fatias se precisar. */
    if (method === 'GET' && p === '/amb-checkout-offline/ml-faltantes-classificar') {
      const kF = lerChaveAdmin(req, urlObj);
      const sF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kF === process.env.ADMIN_KEY) || (sF && ehAdmin(sF)))) { json(res, 404, { error: 'not found' }); return true; }
      const deF = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateF = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!deF || !ateF) { json(res, 400, { ok: false, erro: 'informe ?de=2026-01-01&ate=2026-08-27' }); return true; }
      const maxC = Math.min(250, Math.max(10, parseInt((urlObj.searchParams.get('max') || '150'), 10) || 150));
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
      faltam.sort((a, b2) => b2.comissao_ml - a.comissao_ml);   // os de maior comissão primeiro
      const alvo = faltam.slice(0, maxC);
      let tokenML = null;
      try { const { garantirTokenML } = require('../ambtotal/mlTokenManager'); tokenML = await garantirTokenML(); } catch (e) {}
      if (!tokenML) { json(res, 500, { ok: false, erro: 'sem token do ML' }); return true; }
      const classes = { cancelada: 0, paga_ausente: 0, carrinho_descoberto_agora: 0, outra_situacao: 0, erro_consulta: 0 };
      const amostras = { cancelada: [], paga_ausente: [], carrinho_descoberto_agora: [], outra_situacao: [] };
      let comPagas = 0;
      for (const f of alvo) {
        try {
          const r = await fetch('https://api.mercadolibre.com/orders/' + f.venda, { headers: { Authorization: 'Bearer ' + tokenML } });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) { classes.erro_consulta++; }
          else {
            const st = String(d.status || '');
            const packAgora = d.pack_id ? String(d.pack_id) : null;
            if (st === 'cancelled') { classes.cancelada++; if (amostras.cancelada.length < 6) amostras.cancelada.push({ venda: f.venda, comissao_ml: f.comissao_ml }); }
            else if (packAgora && nosso.has(packAgora)) { classes.carrinho_descoberto_agora++; if (amostras.carrinho_descoberto_agora.length < 6) amostras.carrinho_descoberto_agora.push({ venda: f.venda, pack: packAgora }); }
            else if (st === 'paid') { classes.paga_ausente++; comPagas = Math.round((comPagas + f.comissao_ml) * 100) / 100; if (amostras.paga_ausente.length < 10) amostras.paga_ausente.push({ venda: f.venda, comissao_ml: f.comissao_ml, data: (d.date_created || '').slice(0, 10) }); }
            else { classes.outra_situacao++; if (amostras.outra_situacao.length < 6) amostras.outra_situacao.push({ venda: f.venda, status: st }); }
          }
        } catch (e) { classes.erro_consulta++; }
        await new Promise(r2 => setTimeout(r2, 120));   // gentileza com o rate limit do ML
      }
      json(res, 200, { ok: true, de: deF, ate: ateF, faltantes_total: faltam.length, classificadas: alvo.length,
        classes, comissao_das_pagas_ausentes: comPagas,
        estimativa_faturamento_pagas_ausentes: Math.round(comPagas / 0.125 * 100) / 100,
        amostras,
        leia: 'cancelada e carrinho_descoberto_agora estao OK — PAGA_AUSENTE e o buraco real. Se faltantes_total > classificadas, rode de novo: as ja classificadas nao mudam de lista, entao o retrato por CLASSE e representativo do topo (maior comissao primeiro)' });
      return true;
    }
    // disparo manual: ?meses=2026-07,2026-08  (ou ?meses=todos p/ o ano inteiro)
    if (method === 'GET' && p === '/amb-checkout-offline/reaplicar-imposto') {
      const kR = lerChaveAdmin(req, urlObj);
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
      const kS = lerChaveAdmin(req, urlObj);
      const sessS = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kS === process.env.ADMIN_KEY) || (sessS && ehAdmin(sessS)))) { json(res, 404, { error: 'not found' }); return true; }
      const deS = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '').slice(0, 10);
      const ateS = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deS) || !/^\d{4}-\d{2}-\d{2}$/.test(ateS)) { json(res, 400, { ok: false, erro: 'passe &de=&ate=' }); return true; }
      const FS = path.join(CACHE_DIR, '_vendas_dia.json');
      const atualS = readJson(FS, {});
      /* 14/10 (parecer do Codex, PR #690): mesma regra da fábrica — SEM a base de vendas do dia (ausente
         ou vazia) o filtro abaixo dá zero pedidos e a resposta anunciaria ml/shopee/tiktok como
         CONFERIDOS com checados:0. Base ausente é "não sei": nenhum canal entra em `canais_checados`.
         Período vazio de verdade (base existe, sem pedido no intervalo) segue conferido. */
      if (!atualS || typeof atualS !== 'object' || !Object.keys(atualS).length) {
        let _mtS = null; try { _mtS = fs.statSync(FS).mtime.toISOString(); } catch (e) {}
        json(res, 200, { ok: true, sem_base: true, checados: 0, cancelados_agora: 0, numeros: [], canais_checados: [],
          sem_cobertura: ['ml', 'shopee', 'tiktok', 'magalu', 'amazon', 'olist'],
          aviso_base: 'sem a base de vendas do dia desta empresa' + (_mtS ? ' (arquivo vazio desde ' + _mtS + ')' : '') + ' — nenhum cancelamento foi conferido' });
        return true;
      }
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
          const fTK = path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_amb.json');
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
    if (method === 'GET' && p === '/amb-checkout-offline/completar-detalhes') {
      const kD = lerChaveAdmin(req, urlObj);
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
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, { ok: true, status: _backfill, ano: (_backfillAno.rodando || _backfillAno.fim) ? _backfillAno : undefined });
      return true;
    }

    // TESTE de conexão com o Supabase (histórico) — grava e apaga 1 registro. Confirma antes do backfill.
    // Uso: /amb-checkout-offline/backfill-teste
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-teste') {
      const kD = lerChaveAdmin(req, urlObj);
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
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /amb-checkout-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /amb-checkout-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /amb-checkout-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */

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
    if (await _rotaDeParaSku(req, res, urlObj, method, p)) return true;

    if (method === 'GET' && p === '/amb-checkout-offline/custo-sync') {
      const k = lerChaveAdmin(req, urlObj);
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: !!_cst.rodando, progresso: _cst.feitos + '/' + _cst.total, ok_ate_agora: _cst.ok, falhas: _cst.falhas, falhas_detalhe: _cst.falhas_detalhe || [], inicio: _cst.inicio, diario: _cstDiario.ultimo, diario_dia_fechado: _diaFechadoDoDisco() }); return true; }
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
      /* 14/09 — mesma honestidade da rota /custo-diario: com a trava do processo ocupada (a
         outra empresa, ou o custoDiario desta mesma) custoSyncTravado adia sem rodar nada;
         dizer "iniciado: true" aqui seria a mesma mentira que o Codex apontou lá. */
      const _travaOcupadaS = travaPesada.quemEsta();
      if (_travaOcupadaS) { json(res, 409, { ok: false, erro: 'rotina pesada em curso (' + _travaOcupadaS.nome + ', há ' + _travaOcupadaS.ha_min + ' min) — tente de novo em alguns minutos' }); return true; }
      custoSyncTravado(!!urlObj.searchParams.get('fresh')).catch(() => {});
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
      const _kAdm = lerChaveAdmin(req, urlObj);
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
      const k = lerChaveAdmin(req, urlObj);
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



    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou


    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log


    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)



    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───






    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos



    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    // 11/08: a rota /historico INLINE foi REMOVIDA daqui.
    //   Ela era a herança do checkout (só os pedidos bipados) e, por vir ANTES da
    //   delegação, SOMBREAVA a do módulo amb-historico.js — que devolve `vendas_bling`
    //   (o _vendas_dia.json inteiro: vendas do Bling + as provisórias direto do
    //   marketplace) e traz o bugfix d45 da hora da NF. Sem isso o dashboard só
    //   enxergava, no Hoje/Ontem, o que o estoquista tinha bipado: 4 pedidos onde o
    //   marketplace tinha 50. Agora a rota do módulo assume.











    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)


    // LIBERA a reserva (ao voltar pra lista / finalizar)



    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)


    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.



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
        semEtiqueta: ids.filter(i => !man[i].tem_etiqueta && !man[i].full_ml && !man[i].aguardando_disp).length,   /* Codex #698: Full do ML não é problema de etiqueta */
        sync: { ...getUltimoSync(), ligado: SYNC_ON, conferidos: confIds.length, pendentes: confIds.filter(i => !conf[i].sincronizado).length },
        pedidos: ids.map(i => ({ id: i, ...man[i] }))
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
    // DEBUG: mostra a resposta crua do Bling pra entender como buscar pedido (filtro funciona? 116856 é numero ou numeroLoja?)
    // DEBUG 2: testa buscar NF por número e contato por nome (pra saber quais buscas a API permite)





    // DEBUG: acha pedidos no cache que parecem KIT/composição (p/ inspecionar a estrutura)








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
    // Codex #588: só o DISPARO fica aqui (vai ao Bling, cópia mantida); o `-status` é da fábrica.
    if (method === 'GET' && p === '/amb-checkout-offline/varrer-fornecedores') {
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const _estV = estadoVarrerForn();
      if (_estV.rodando) { json(res, 200, { ok: false, msg: 'já está varrendo — acompanhe em /varrer-fornecedores-status', status: _estV }); return true; }
      const maxV = (urlObj.searchParams && urlObj.searchParams.get('max')) || '1000';
      varrerFornecedores(maxV).catch(e => { estadoVarrerForn().rodando = false; console.log('[FORNECEDORES] ' + e.message); });
      json(res, 202, { ok: true, msg: 'varredura iniciada em segundo plano (só leitura, não altera nada no Bling)', max: Number(maxV), status: p + '-status' });
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
    if (method === 'GET' && p === '/amb-checkout-offline/produto-cru') {
      const kPr = lerChaveAdmin(req, urlObj);
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

    /* ⚠️ 02/10 — A MONTAGEM FICA NO FIM DO HANDLER, DE PROPÓSITO. Ela estava no começo (linha
       ~960) e eu tentei passar peças que a AMB declara nas linhas 2230 e 5587 — MESMA FUNÇÃO,
       declaradas DEPOIS. Resultado no teste: "Cannot access 'FOTO_V' before initialization", e
       DUAS ROTAS da empresa que mais fatura pararam de responder. `node --check` não pega isso.
       Tentei resolver passando getter: errado também, porque a fábrica usa a maioria como VALOR
       (`FOTO_V`, `_mlb`) e chama outras direto (`supaReq(url)`) — getter devolveria a função em
       vez do resultado. A correção certa é montar AQUI, depois de tudo declarado.
       Efeito colateral bom: as rotas próprias da AMB são consultadas ANTES, então a dela vence
       por posição, não só por `rotasProprias`.

       02/10 — A AMB PASSA A USAR A FÁBRICA, mas SEM PERDER NADA: todas as rotas que ela já tem
       entram em `rotasProprias`, então a dela sempre vence. O que a fábrica acrescenta aqui e
       hoje são os SCRIPTS compartilhados do painel (plano de compra, ferramentas de custo) —
       as mesmas peças que a GOOD já usa.
       ⚠️ Nada de apagar cópia neste PR: ligar primeiro, provar que a rota da fábrica responde
       igual, e só então remover a duplicata. Apagar antes de provar é como eu quebraria a
       empresa que mais fatura. */
    if (!_rotasPainelAMBMontado) {
      _rotasPainelAMBMontado = true;
      try {
        _rotasPainelAMB = require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({
          empresa: 'amb', prefixo: '/amb-checkout-offline',
          nomeEmpresa: 'AMBTotal',
          rotasProprias: ['canario-marketplaces', 'backfill', 'backfill-limpar', 'backfill-teste', 'bling-cru', 'completar-detalhes', 'config-frete-magalu', 'custo-historico', 'custo-sync', 'despachados-por-engano', 'magalu-caca', 'magalu-cancelados', 'magalu-debug', 'ml-billing', 'ml-billing-status', 'ml-creditos-flex', 'ml-devolucoes', 'ml-devolucoes-coletar', 'ml-faltantes-classificar', 'ml-flex-debug', 'ml-trocar-code', 'ml-vendas-do-dia', 'ml-vendas-faltando', 'plano-compra', 'raio-x-venda', 'reaplicar-custo', 'reaplicar-imposto', 'reaplicar-status', 'setup-ml', 'sku-orfaos', 'sku-repara', 'status-mkt', 'tiktok-completar-tarifa', 'tiktok-custo-devolucoes', 'varrer-fornecedores', 'vendas-sync'],
          pecas: { json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR,
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
      } catch (e) {
        console.error('[AMB] falha ao montar as rotas compartilhadas:', e.message);
        _rotasPainelAMB = async () => false;
      }
    }
    if (await _rotasPainelAMB(req, res, p, method, urlObj)) return true;

    /* 31/10 — DIAGNÓSTICO (peça única) por ÚLTIMO, pra não mudar a ordem de casamento das rotas que já existiam: as de
       raio-X que a AMB já tinha neste arquivo continuam valendo; daqui vêm as que faltavam */
    if (await diag(req, res, urlObj)) return true;

    return false; // não tratou
  };
}

// roda 1 ciclo logo após o boot do serviço
// ═══ VENDAS-SYNC (background): TODAS as vendas do Bling por data, em QUALQUER situação —
// independe de bipagem. Roda a cada 5 min + boot + botão. Cancelada vem com a situação marcada.
const _vsy = _estadoRotinas.vendas;  /* 01/10: idem */
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
/* 11/09: estas 209 linhas eram idênticas byte a byte aqui e na outra empresa — primeira
   fatia da desduplicação dos checkouts. Foram pra lib/checkout/magalu-frete.js, que não
   conhece empresa: recebe a pasta de cache e o acesso ao Bling por injeção e devolve as
   MESMAS funções, com os mesmos nomes, pra esta troca ser invisível pro resto do arquivo. */
const _magaluFrete = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR, readJson, writeJson, blingGet,
  /* 11/09: referência PREGUIÇOSA de propósito. A fatia 2 transformou resolverProdutoPorSku
     de `function` (içada) em `const` vindo da lib — e esta fábrica roda ANTES dessa linha,
     então passar o valor direto dava "Cannot access before initialization" no boot. O boot
     real do CI pegou isso na hora; sintaxe e lint passavam. */
  resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a),
});
const { magaluNivelColuna, magaluFreteTabela, magaluFreteSkuLer, magaluFreteSkuGravar,
        magaluDimSku, magaluFretePrevistoSku, magaluFreteProvisorio, MAGALU_FRETE_TABELA } = _magaluFrete;

// ─── PESCA os dados REAIS de um pedido direto na API do ML (fonte primária) ──────
// Dado o numero_loja, devolve { fee (comissão real via sale_fee), frete, venda (hora),
// credito, credito_fonte, logistica, pack, order, costs_ok } ou null se o ML não respondeu.
// Trata carrinho (pack), Flex (self_service: frete não é custo, é o motoboy; estorno = líquido)
// e compensações. Reusada pela pesca dos bipados (mlSyncFees) e pela fase ml_real (não-bipados).
/* 01/09: a pesca do ML saiu daqui pra lib/ml-pesca.js — eram TRÊS cópias e já tinham
   divergido (a da AMB tinha o conserto do crédito Flex de 25/08 que faltava aqui). A lib usa
   a versão mais nova; a função só depende dos próprios parâmetros. Dívida nº 3 do doc. */
const { pescarDadosML } = require('../lib/ml-pesca');

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
/* 29/10 (3b-2): objeto ESTÁVEL — o backfill compartilhado o reinicia no lugar (passado no contexto); ninguém aqui o troca */
const _backfill = { rodando:false, empresa:null, de:null, ate:null, pagina:0, pedidos:0, itens:0, gravados:0, erros:0, fase:'parado', inicio:null, fim:null, msg:'' };

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
async function _feeMLLeve(nl, tk) {
  const id = String(nl || '').replace(/\D/g, '');
  if (!id || !tk) return 0;
  const H = { headers: { Authorization: 'Bearer ' + tk } }   /* Codex #343 r4: objeto REUSADO em várias requisições — sinal aqui abortaria todas as seguintes junto com a primeira; timeout é por requisição, em quem chama */;
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

/* 29/10 (passo 3b-2 do backfill único): o backfill da AMB é o COMPARTILHADO (girassol-backup-offline/gbo-app.js, o mesmo
   da Girassol e da GOOD, com o andamento por empresa) — rodando com as fontes DELA no contexto. Era uma cópia de 690
   linhas que tinha divergido: faltavam aqui os desfechos (adiado/ja_rodando/abortado/transitório), a trava de segurança
   dos 60%, a espera longa no 429; e o que só havia aqui (vendas direto do ML com o token da empresa, a reserva da
   alíquota, o diagnóstico da UF, a caça da Magalu) entrou no compartilhado antes (3b-1 e #766). O andamento continua
   sendo o `_backfill` deste arquivo (passado no contexto) — todo o resto da AMB lê o mesmo objeto. */
function _ctxBackfillAmb() {
  return {
    estadoBackfill: _backfill,
    garantirSitCancel: (bg) => garantirSitCancel(bg),   /* o cache e o env AMBBKP_SIT_CANCELADO da AMB */
    ehFlex,   /* o classificador Flex da AMB (cache-dir 'amb' + SHOPEE_LOGISTICA_FLEX_EMPRESAS) */
    blingGet, readJson, CACHE_DIR, supaReq, supaCount,
    DEFAULT_ALIQ_BK, aliqReserva: 14.1,
    custoVigenteEm, mapasBilling: _mapasBilling,
    garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
    escrowEmLote, escrowDoPedido, LOJA_MKT,
    magaluFreteSkuLer: (typeof magaluFreteSkuLer === 'function') ? magaluFreteSkuLer : null,
    creditosFlex: (d1, d2) => _mlBilling.aplicarCreditosFlexNaFila(d1, d2),
    magaluLinhas: (d1, d2, e2, j2) => _cacaMgAmb.magaluLinhas(d1, d2, e2, j2),
    cacaMagaluRodando: () => _cacaMgAmb.estado().rodando,
    canarioRodando: () => !!(typeof _canario !== 'undefined' && _canario && _canario.rodando),
    reparoAtivo: () => !!_reparoAtivo,
  };
}
async function backfillVendas(de, ate) {   /* a assinatura de antes (de, ate, empresa): a empresa aqui é sempre a AMB */
  return require('../girassol-backup-offline/gbo-app').backfillVendas(de, ate, 'amb', _ctxBackfillAmb());
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







let _backfillAno = { rodando:false, mesAtual:null, feitos:[], inicio:null, fim:null };
async function backfillAnoTodo(ateMes){
  if(_backfillAno.rodando || _backfill.rodando) return;
  _backfillAno = { rodando:true, mesAtual:null, feitos:[], inicio:new Date().toISOString(), fim:null };
  const meses = ['01','02','03','04','05','06','07','08','09','10','11','12'].filter(m => m <= ateMes);
  /* 22/08: o encerramento foi pra um `finally`. Antes, um erro no meio do ano deixava
     `_backfillAno.rodando` de pé PRA SEMPRE — e com a flag presa, nenhum backfill novo começava
     até reiniciar o serviço. (A detecção de adiamento por reparo de SKU vem no PR do sku-repara.) */
  try {
    for(const m of meses){
      _backfillAno.mesAtual = '2026-'+m;
      const r = await backfillVendas('2026-'+m+'-01', '2026-'+m+'-'+ULTIMO_DIA[m], 'amb');   // espera cada mês terminar antes do próximo
      /* o adiamento volta como retorno NORMAL: sem olhar, o mês entraria em `feitos` com os
         contadores VELHOS e o ano terminaria "concluído" tendo pulado meses em silêncio. */
      /* Codex #684 (P2): igual ao Girassol — mes que ABORTA (DELETE recusado, trava de sanidade,
         spool) ou da erro PARA o ano; antes entrava em `feitos` e o ano parecia completo. */
      if (r && (r.desfecho === 'abortado' || r.desfecho === 'erro')) {
        _backfillAno.erro = r.msg || ('mês ' + m + ' ' + r.desfecho);
        _backfillAno.parou_em = '2026-' + m;
        _backfillAno.faltam = meses.slice(meses.indexOf(m));
        break;
      }
      if (r && r.adiado) {
        _backfillAno.adiado = r.adiado; _backfillAno.parou_em = '2026-'+m;
        _backfillAno.faltam = meses.slice(meses.indexOf(m));
        console.log('[BACKFILL-ANO] parou em 2026-' + m + ': ' + r.adiado);
        break;
      }
      _backfillAno.feitos.push({ mes:'2026-'+m, pedidos:_backfill.pedidos, itens:_backfill.itens, gravados:_backfill.gravados, erros:_backfill.erros });
      await new Promise(r=>setTimeout(r,2500));
    }
  } finally {
    _backfillAno.rodando = false; _backfillAno.mesAtual = null; _backfillAno.fim = new Date().toISOString();
  }
}

/* 17/10 — A VENDA DO DIA É A PEÇA ÚNICA (lib/checkout/vendas-dia.js), nascida da versão da Girassol. A AMB entrega só
   o que é dela. Ganha as duas melhorias que só a Girassol tinha: a fase direta protegida (uma falha nela não derruba a
   rodada) e a versão do custo real do ML (ML_REAL_V = 2 — registro pescado sem a classificação do envio é repescado). */
let _vendasDiaAmb = null;
async function vendasSync() {
  /* 19/10 (Fase 3): a configuração desta empresa (envs, loja Shopee, Magalu, TikTok, token do ML) vem da peça única
     lib/checkout/config-empresa — aqui só as peças do módulo (deps) */
  if (!_vendasDiaAmb) _vendasDiaAmb = require('../lib/checkout/vendas-dia').criarVendasSyncDaEmpresa('amb', {
    deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet, buscarDevolucoesML, json, magaluFreteProvisorio, magaluFreteSkuGravar, nfDoPedido, path, pescarDadosML, readJson, writeJson }),
    fetch,
  });
  return _vendasDiaAmb();
}

// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
const _cst = _estadoRotinas.custo;   /* 01/10: estado por empresa, de lib/checkout/estado-rotinas */
/* 13/09 — A FALHA AGORA SE IDENTIFICA. Toda rodada do custo-sync fechava com "falhas: 1" e
   nada mais: sem SKU nem motivo, não dava pra saber se era um produto irrelevante ou
   justamente um que decide margem — o dono perguntou por isso mais de uma vez e a resposta
   honesta era "não sei". Guarda as últimas 10, com hora, e o ?status=1 mostra. */
function _anotarFalhaCusto(sku, motivo) {
  try {
    if (!Array.isArray(_cst.falhas_detalhe)) _cst.falhas_detalhe = [];
    _cst.falhas_detalhe.unshift({ sku: String(sku || '?'), motivo: String(motivo || '?'), em: new Date().toISOString() });
    if (_cst.falhas_detalhe.length > 10) _cst.falhas_detalhe.length = 10;
  } catch (e) {}
}

/* ── CUSTO DIÁRIO INCREMENTAL (09/09, v3 pós-Codex) ──────────────────────────────
   Module-level de propósito: a rota ?status=1 vive em função irmã (o Codex pegou o
   ReferenceError da v2). Data em FUSO LOCAL (às 23h de São Paulo o toISOString já
   virou o dia UTC seguinte — o scan olharia um dia vazio). O dia só é dado por
   FEITO ao concluir com êxito (persistido no cache: restart não repete, sync
   concorrente não engole o tick — os dois P1 do agendamento) e página falhada
   deixa o dia ABERTO pro próximo tick re-tentar, nunca parcial silencioso. */
const CUSTO_FILE_DIARIO = path.join(CACHE_DIR, '_custos.json');   /* o mesmo caminho que o custoSync monta local */
/* 14/09 — Codex P1: a trava só protegia quem passava pelo custoDiario. A tartaruga pós-boot
   (240s), a manutenção de 6 em 6h (agendador.js) e o disparo manual do operador chamam
   custoSync DIRETO, sem nunca ver a trava — as duas empresas voltavam a rodar juntas por
   esses caminhos. custoSyncTravado (definida logo após custoSync) cobre essas três portas;
   custoDiario continua chamando o custoSync CRU, porque ele já segura a trava por fora, pelo
   corpo inteiro do seu próprio run — travar de novo aqui dentro seria a rotina brigando com
   ela mesma pela própria trava. */
const travaPesada = require('../lib/checkout/trava-pesada');
/* 11/09 — fatia 5: o CUSTO DIÁRIO (164 linhas idênticas nas duas empresas) foi pra
   lib/checkout/custo-diario.js. Por ser a rotina que decide a margem do dia seguinte, ela
   só saiu daqui COM TESTE ESCRITO ANTES (scripts/teste-custo-diario.js — 6 promessas lidas
   no próprio código). O estado do custo-sync entra por FUNÇÃO (o host recria o objeto a
   cada varredura) e a vigência retroativa da madrugada por acessor. */
const _custoDiarioMod = require('../lib/checkout/custo-diario').criar({
  empresa: 'amb',                                 /* identifica quem segura a trava pesada */
  CUSTO_FILE: CUSTO_FILE_DIARIO,
  readJson,
  escrever: (p, o) => fs.writeFileSync(p, JSON.stringify(o)),
  estadoSync: () => _cst,
  custoSync: (...a) => custoSync(...a),
  blingGet: (...a) => blingGet(...a),
  registrarCustoVigente: (...a) => registrarCustoVigente(...a),
  lerVigenciaDe: () => _vigenciaDeRef.valor,
  gravarVigenciaDe: (v) => { _vigenciaDeRef.valor = v; },
});
const custoDiario = (...a) => _custoDiarioMod.custoDiario(...a);
const _cstDiario = _custoDiarioMod._cstDiario;
const _diaFechadoDoDisco = _custoDiarioMod._diaFechadoDoDisco;


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
const _faseDireta = require('../lib/checkout/fase-direta').criarFaseDireta({
  empresa: 'amb',
  mlTokenManager: () => require('../ambtotal/mlTokenManager'),
  shopeeKey: process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
  shopeeUrlEnv: process.env.AMBBKP_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
  shopeeLoja: process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb',   // Codex P1: a URL do serviço Shopee usa a LOJA configurada, não o nome da empresa
  adminKey: process.env.ADMIN_KEY || '',
  porta: process.env.PORT || 3000,
  fetch,   // Codex P2: o MESMO node-fetch (com suporte a `timeout`) que o resto do arquivo usa
  log: console.log,
});
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


async function custoSync(fresh) {
  /* Codex #367 r2: componente resolvido pela API vale pra TODOS os kits desta varredura —
     sem o memo, cada kit que usa a mesma lâmpada pagaria a consulta de novo. */
  const _memoComp = new Map();
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
  /* 13/09 — O SYNC PASSA A RESPEITAR O DE-PARA. O dono ligou FL-1011-PRETO ao SKU novo
     (3933398010054, renomeado no Bling) e a falha diária CONTINUOU: a varredura montava a
     lista de alvos direto do histórico e perguntava ao Bling pelo código VELHO, sem nunca
     consultar o de-para — a peça existia e não era usada neste caminho. Agora o código
     velho é traduzido antes: some da fila (não gasta consulta nem gera alarme) e, se o
     destino ainda não estiver na lista, ele entra no lugar. */
  const _traduzido = new Map();
  for (const sk of [...todos]) {
    let destino = null;
    try { destino = resolverDeParaSku(sk); } catch (e) { destino = null; }
    if (destino && String(destino).toUpperCase() !== String(sk).toUpperCase()) _traduzido.set(sk, String(destino));
  }
  if (_traduzido.size) {
    for (const [velho, novo] of _traduzido) { todos.delete(velho); todos.add(novo); }
    console.log('[CUSTO] de-para aplicado em ' + _traduzido.size + ' SKU(s): ' + [..._traduzido].map(([v, n]) => v + '→' + n).join(', '));
  }
  const alvos = [...todos].filter(sk => { const k = cc[sk]; if (k && k.apagado_em) { if (!fresh) return false; if ((Date.now() - k.apagado_em) < 30 * 86400000) return false; /* Codex #358: fresh diário revisitando TODA lápide devolvia os apagados ao resolvedor caro toda noite */ } return fresh || !k || !k.id || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });
  /* Codex #358 r2+r3: fila em ordem de PROFUNDIDADE de dependência — componente (0),
     kit (1), kit-de-kit (2)... Empatar todos os kits deixava o kit EXTERNO poder vir
     antes do interno e somar o agregado velho. Memoizado, teto 6 contra ciclo. */
  const _idxLower = {}; for (const sk0 of Object.keys(cc)) { if (sk0.startsWith('_')) continue; _idxLower[sk0.toLowerCase()] = sk0; const v0i = cc[sk0]; if (v0i && v0i.id) _idxLower['id:' + v0i.id] = sk0; /* Codex #358 r4: comps por id também resolvem */ }
  const _prof = {};
  const _profDe = (sk0, nivel) => {
    if (nivel > 6) return 6;
    if (_prof[sk0] != null) return _prof[sk0];
    const v0 = cc[sk0];
    if (!v0 || !Array.isArray(v0.comps) || !v0.comps.length) { _prof[sk0] = 0; return 0; }
    _prof[sk0] = 6; /* sentinela anti-ciclo enquanto calcula */
    let m = 0;
    for (const c0 of v0.comps) { const real = _idxLower[String(c0).toLowerCase()]; if (real) m = Math.max(m, _profDe(real, nivel + 1)); }
    _prof[sk0] = 1 + m;
    return _prof[sk0];
  };
  alvos.sort((x, y) => _profDe(x, 0) - _profDe(y, 0));
  /* muta, não reatribui: `_cst` é const e a referência vive em estadoDe() */
  Object.assign(_cst, { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, inicio: new Date().toISOString(), falhas_detalhe: [] });
  console.log('[CUSTO] sync iniciando — ' + alvos.length + ' SKU(s) a resolver (tartaruga: ~1,2s/chamada)');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg2 = async (pth) => { for (let t = 0; t < 4; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme(1500 + t * 700); } return await blingGet(pth); };
  let desdeGravei = 0;
  for (const sku of alvos) {
    try {
      let prod = null;
      let _falhaConsulta = false; /* Codex #358 r2: distingue custo AUSENTE por decisão (limpar) de custo ausente por 429/erro (preservar) */
      const _res = await resolverProdutoPorSku(sku, bg2, 10);
      if (_res.produto && _res.produto.id) {
        const d = await bg2(`/produtos/${_res.produto.id}`);
        if (!d || !d.ok) _falhaConsulta = true; /* Codex #358 r2: falha ≠ conclusivo */
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
        const _candDosFornecedores = async () => {
          const rf = await bg2(`/produtos/fornecedores?idProduto=${prod.id}&limite=5`);
          if (!rf || !rf.ok) { _falhaConsulta = true; return []; }
          const arr = (rf.ok && rf.data && rf.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          // 27/07: o nome do campo varia na resposta do Bling — aceita todos os candidatos
          let c = [];
          if (pref) c = [pref.precoCusto, pref.precoCompra, pref.preco, pref.custo, pref.valor, pref.valorCusto]
                        .map(Number).filter(v => isFinite(v) && v > 0);
          if (!c.length && arr.length) {
            for (const fx of arr) {
              const vs = Object.keys(fx || {}).filter(k => /pre(c|ç)o|custo|valor/i.test(k)).map(k => Number(fx[k])).filter(v => isFinite(v) && v > 0);
              if (vs.length) { c = [Math.min.apply(null, vs)]; break; }
            }
          }
          return c;
        };
        /* 11/09 — A DECISÃO DE CUSTO MUDOU-SE PARA lib/custo-composicao.js. Por quê: ela
           levou QUATRO PRs pra ficar certa em 10/09 (o endpoint de fornecedores rodando
           antes da composição, o retrato embutido ganhando do banco, o banco consultado só
           por SKU quando a estrutura traz ID, a soma truncada virando custo, o kit aninhado
           pelo fornecedor) e vivia solta aqui dentro, sem como testar sem subir o serviço e
           falar com o Bling. Agora a regra está num lugar só, é a MESMA das duas empresas e
           tem teste (scripts/teste-custo-composicao.js, 11 cenários, incluindo o caso real
           do 2xE14). A rede continua sendo por aqui: a lib não fala com o Bling, recebe as
           consultas por injeção. */
        const _dec = await _custoComp.decidirCustoDoProduto(prod, {
          banco: cc,
          memo: _memoComp,
          consultarProduto: async (id) => {
            const dc = await bg2(`/produtos/${id}`);
            await dorme(420);
            if (!dc || !dc.ok) return { ok: false };
            return { ok: true, produto: (dc.data && dc.data.data) || null };
          },
          consultarFornecedores: async () => {
            const c = await _candDosFornecedores();
            return c.length ? c[0] : null;
          },
        });
        if (_dec.falhaConsulta) _falhaConsulta = true;
        if (_dec.motivo) console.log('[CUSTO] ' + sku + ': ' + _dec.motivo + ' — via ' + _dec.via);
        else console.log('[CUSTO] ' + sku + ': custo ' + (_dec.custo == null ? 'NAO resolvido' : _dec.custo) + ' via ' + _dec.via);
        const cand = _dec.custo != null ? [_dec.custo] : [];
        const _custoNovo = cand.length ? Math.round(cand[0] * 10000) / 10000 : null;
        /* 21/08: antes de sobrescrever, anota a linha do tempo — o Bling só guarda o custo
           ATUAL, então esta é a única chance de registrar que até ontem valia outro. */
        /* Codex #358 r4: este par usava _conclusivo/_antigo ANTES dos const abaixo —
           TDZ ReferenceError no exato caminho da remoção; o registro vem DEPOIS. */
        /* 09/09: grava os CÓDIGOS dos componentes — é o mapa reverso que o custo diário
           incremental usa pra saber quais kits re-buscar quando um unitário muda */
        /* Codex #358 r3: a estrutura do Bling normalmente vem SÓ com o ID do componente
           (prova: ciclo.js resolve por c.produto.id) — mapear só por codigo deixava o
           mapa de dependência VAZIO e o incremental nunca acharia kit nenhum. Guarda
           codigo (minúsculo) quando vier, senão 'id:<id>'; o scan de alterados marca
           pelos dois. */
        const _compsSkus = (((prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens)) || prod.composicao || prod.componentes) || [])
          .map(cp => {
            const cod = (cp.produto && cp.produto.codigo) || cp.codigo;
            if (cod) return String(cod).toLowerCase().trim();
            const idc2 = (cp.produto && cp.produto.id) || cp.produto || cp.id || cp.idProduto;
            return idc2 ? ('id:' + idc2) : '';
          }).filter(Boolean);
        /* Codex #358 r1+r2: três destinos possíveis pro custo nulo — (a) FALHA de consulta
           (429/erro no detalhe ou fornecedores): preserva custo antigo SEM avançar ts, a
           tartaruga re-tenta; (b) resposta CONCLUSIVA sem candidato (custo removido/zerado
           de propósito no Bling): grava null com ts novo — manter o velho esconderia pra
           sempre um produto que ficou sem custo; (c) custo novo: grava. E os comps só são
           substituídos quando a fonte atual TROUXE estrutura — detalhe falhado caía no
           resumo sem composição e apagava o mapa de dependência do kit. */
        const _antigo = cc[sku];
        const _conclusivo = !_falhaConsulta;
        const _custoFinal = (_custoNovo != null) ? _custoNovo : (_conclusivo ? null : ((_antigo && _antigo.custo != null) ? _antigo.custo : null));
        const _tsFinal = (_custoNovo != null || _conclusivo) ? Date.now() : ((_antigo && _antigo.ts) || 0);
        const _compsFinais = _compsSkus.length ? _compsSkus : ((!_conclusivo && _antigo && _antigo.comps) ? _antigo.comps : null);
        cc[sku] = Object.assign({ id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: _custoFinal, ts: _tsFinal }, _compsFinais && _compsFinais.length ? { comps: _compsFinais } : {});
        if (_custoNovo != null) { try { registrarCustoVigente(sku, _custoNovo, 'bling'); } catch (e) {} }
        else if (_conclusivo && _antigo && _antigo.custo != null) { try { registrarCustoVigente(sku, null, 'remocao-bling'); } catch (e) {} }
        _cst.ok++;
      } else { _cst.falhas++; _anotarFalhaCusto(sku, 'o Bling não devolveu o produto (resposta sem dados)'); }
    } catch (e) { _cst.falhas++; _anotarFalhaCusto(sku, String((e && e.message) || e).slice(0, 160)); }
    _cst.feitos++; desdeGravei++;
    if (desdeGravei >= 10) { desdeGravei = 0; try { writeJson(path.join(CACHE_DIR, '_custos.json'), cc); } catch (e) {} }
    /* Codex P1 (trava-pesada): fila grande o bastante (a 1,2s/SKU, ~4.500 SKUs) passa dos 90
       min do teto — sem sinal de vida, o relógio destrancaria uma rodada que ainda está viva,
       exatamente a sobreposição que a trava existe pra evitar. Renovar a cada SKU prova que
       segue em pé. */
    travaPesada.renovar();
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

/* 14/09 — Codex P1: cobre as portas que chamam custoSync DIRETO (tartaruga pós-boot, manutenção
   de 6h, disparo manual) com a trava do processo. Adia sem enfileirar, igual ao custoDiario —
   e não é opcional: sem isto, a rodada de custo daqui podia sobrepor a rodada pesada da OUTRA
   empresa (ou o custoDiario desta mesma), recriando o 503 de 13/09. */
async function custoSyncTravado(fresh) {
  const _t = travaPesada.tentarEntrar('custo-sync:amb');
  if (!_t.ok) {
    console.log('[CUSTO] sync adiado — outra rotina pesada em curso (' + _t.ocupadoPor + ', há ' + _t.haMin + ' min)');
    return;
  }
  try { await custoSync(fresh); }
  finally { travaPesada.sair('custo-sync:amb'); }
}

/* 13/09 — fatia 7 da desduplicação: o AGENDADOR (as 47 linhas do bootstrap) era igual nas
   duas empresas, com três diferenças — a chave da empresa, o minuto da rodada de custo
   (23h00 aqui, 23h15 na outra, separadas de propósito pra não disputarem cota do Bling) e
   comentários. Virou lib/checkout/agendador.js com isso como parâmetro. Aqui mora o relógio
   da operação, e rotina que deixa de ser agendada não falha: ela simplesmente não acontece,
   em silêncio — por isso o teste novo confere os 12 agendamentos um a um. */
const bootstrap = require('../lib/checkout/agendador').criarAgendador({
  empresa: 'amb',
  minutoCustoDiario: 0,
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
    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; if (d.credito != null) c2[cid].credito_ml = d.credito; if (d.credito_fonte) c2[cid].credito_fonte = d.credito_fonte; if (d.logistica) c2[cid].logistica_ml = d.logistica; if (d.pack) c2[cid].ml_pack = d.pack; if (d.order) c2[cid].ml_order = d.order; if (d.costs_ok && d.ship_ok) { c2[cid].ml_costs_v3 = 1; if (d.credito == null && c2[cid].credito_fonte !== 'billing') delete c2[cid].credito_ml;   /* 25/08: 'costs_gross' NÃO é exceção aqui — ele nasce da própria resposta do /costs, então uma leitura FRESCA e COMPLETA (costs_ok E ship_ok) que diz "sem crédito" desmente o valor velho. Protegê-lo seria blindar o dado contra a própria atualização, e o ml_costs_v3 avança logo abaixo: passada a rejanela de 3 dias, o crédito obsoleto pararia de ser reconferido e inflaria a margem pra sempre. Falha ou 429 já são barrados por costs_ok/ship_ok. 'billing' continua exceção: vem do relatório oficial de faturamento, outra fonte. */ /* Codex PR#40: /costs vazio não apaga crédito do billing */ if (d.frete == null) delete c2[cid].frete_ml; } }
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
              reg.ship_ok = true;   /* 25/08: idem — ver o comentário do outro ponto */
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

let _rotasCancMkt = null;   /* 29/10: a sonda dos cancelados antes da postagem (criada na 1ª chamada) */
module.exports = {
  id: 'amb-checkout-offline',
  nome: 'AMBTotal Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14), shopeeKeepAlive: () => shopeeKeepAlive(), noturna: () => _noturna.rotinaNoturna('cron'), cacaMagalu: () => cacaMagaluCron() },
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', shopeeKeepAlive: '30 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */, noturna: '45 3 * * *' , cacaMagalu: '35 * * * *'},
  bootstrap
};
