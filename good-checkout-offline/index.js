'use strict';

/* 14/09 (auditoria, P2): a chave passa a ser lida do HEADER primeiro; a query
   continua aceita porque há dezenas de URLs salvas com &k= — cortar de uma vez
   quebraria o trabalho de quem opera pelo navegador. */
const { lerChaveAdmin } = require('../lib/http/chave-admin');
const { souAdmin } = require('../lib/http/admin-da-sessao');

// ════════════════════════════════════════════════════════════════════════
//  GOOD · CHECKOUT OFFLINE — FASE 1 (poller) + FASE 2 (bipagem)   (Mover-Pedidos)
// ════════════════════════════════════════════════════════════════════════
//  Módulo do orquestrador unificado (HTTP-native, sem Express).
//  Reaproveita o token Bling da GOOD via ../good/tokenManager.
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
//  ⚠ PRÉ-REQUISITO de scope no app Bling da GOOD (Mover-Pedidos):
//     • Logísticas (leitura)  → necessário p/ /logisticas/etiquetas
//     • Produtos  (leitura)   → necessário p/ resolver EAN por produto
//     Se faltar: o pedido ainda é cacheado, mas vem sem etiqueta / sem EAN.
//     Adiciona os scopes e re-autoriza pelo /setup (cola o auth_code).
// ════════════════════════════════════════════════════════════════════════

const fs    = require('fs');
const path  = require('path');

/* 02/10 — roteador das rotas compartilhadas do painel (lib/checkout/fabrica-rotas-painel, #568).
   Montado no TOPO: as peças abaixo são usadas milhares de linhas adiante, e montar perto do uso
   daria "Cannot access before initialization" — que o `node --check` não pega e só o boot real
   acusa (a lição do #556). */
/* 01/10 — ESTADO DAS ROTINAS PESADAS, por empresa. Fica AQUI NO TOPO de propósito: `_cst` e
   `_vsy` são usados milhares de linhas adiante, e declarar o require perto deles daria
   "Cannot access '_estadoRotinas' before initialization". O `node --check` não pega ordem de
   inicialização e a bateria também não — só o BOOT REAL acusa. É a razão de ele estar no
   checklist. */
const _estadoRotinas = require('../lib/checkout/estado-rotinas').estadoDe('good');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const https = require('https');
const { garantirToken } = require('../good/tokenManager');
const { gerarDanfeSimplificado, gerarDanfeSimplificadoZPL } = require('./danfe-simplificado');
const { fundirEtiquetaComDanfe } = require('./fusao-etiqueta');

// Certificado/chave do QZ Tray p/ assinar as impressões (mata o popup "Untrusted").
// Configure no Render: GOODBKP_QZ_CERT (digital-certificate.txt) e GOODBKP_QZ_PRIVKEY (private-key.pem).
const QZ_CERT    = (process.env.GOODBKP_QZ_CERT    || '').replace(/\\n/g, '\n').replace(/\r/g, '');
const QZ_PRIVKEY = (process.env.GOODBKP_QZ_PRIVKEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');

const VERSAO     = 'good-checkout-offline v26/08 b29';

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
const { _moverAtendidoDesandando } = require('../lib/checkout/resgate-atendido').criarResgateAtendido({ tag: 'GOODBKP' });
/* `blingWrite` guarda o corpo do erro em `data`/`raw`, nao em `erro`: sem olhar la o popup so mostra o status. */


/* 01/10 — o arquivo do billing do ML. A GOOD nunca declarou porque nunca teve as rotas que o
   leem; entrou junto com elas, idêntico ao da Girassol e ao da AMB. Sem isto, as duas rotas
   novas respondiam 500 "MLB_FILE is not defined" — e nem `node --check` nem a bateria pegavam
   isso: só o boot real com curl na rota. */
const MLB_FILE = () => path.join(CACHE_DIR, '_ml_billing.json');

/* 15/09 — a capacidade "expedicao" e a env de VERIFICADO precisam CONCORDAR. São dois lugares
   diferentes e nada obriga o segundo a acompanhar o primeiro: declarar a capacidade e esquecer
   a env deixa o app de Expedição sem nada pra bipar, e o contrário deixa pedido parado num
   estado sem saída. Os dois são silenciosos — por isso a checagem grita no boot. */
{
  const _exp = require('../lib/checkout/conferir-expedicao').conferir({
    rotulo: 'GOODBKP',
    temExpedicao: require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade('good', 'expedicao') === true,
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
const { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = require('./comum');
const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = require('./produtos');
const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = require('./arquivo');
let _bf = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de valores
let _bfd = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null };   // status do backfill de DETALHES (uf + valor por item)
/* 17/09 — o status do backfill de vendas da GOOD morava numa VARIÁVEL GLOBAL do processo
   (`_bfGood`), e as três empresas rodam no MESMO processo. Hoje não há colisão porque
   o nome tem "Good" dentro, mas o padrão é a armadilha: a empresa nova que copiar este bloco
   herda o nome junto, e aí duas empresas passam a escrever no mesmo status — cada uma lendo o
   progresso do backfill da outra, sem erro nenhum. É a mesma classe do id de canal herdado.
   Agora é estado do módulo, como o _bf e o _bfd logo acima. */
let _bfGood = { estado: 'nunca rodou neste processo' };


/* ═══ 15/10 — BACKFILL DO ANO VIRA PLANO AUTOMÁTICO ═══════════════════════════════════════════
   O dono: "já tivemos problemas disso antes. e esse backfill tinha que ser automático". A rodada do
   ano vivia só na memória: deploy no meio = rodada morta, recomeçar de janeiro na mão. Agora o
   /backfill-ano cria um PLANO em disco (fatias de 10 dias, lib/backfill-fatiado.js — o mesmo da
   Girassol) e o motor toca sozinho: só fora do horário do galpão (18h05–7h; se pedir de dia, ele
   espera), como FUNDO no porteiro do Bling, cedendo a vez a outro backfill, refazendo sozinho a fatia
   que falhar e — 3 min depois de cada boot — retomando de onde parou. */
const _fatGood = require('../lib/backfill-fatiado');
/* o que o /backfill-status mostra: o backfill manual, a rotina diária e o plano automático */
function _statusBackfillGood(st) {
  return Object.assign({}, _bfStatusComProgresso(st), { diario: _diarioGoodParaStatus(),
    plano: Object.assign({}, _fatGood.resumo(_fatGood.ler(CACHE_DIR)), { motor: _motorPlanoGood.estado() }) });
}
/* 11/11 (plano, Fase 3 4e): o motor e a rota do plano são os da peça única (lib/checkout/backfill-plano-empresa) — a mesma
   da AMB e da Girassol. A GOOD entrega o que é dela: como roda uma fatia (com o estado `_bfGood`) e quando está ocupada. */
const _planoGood = require('../lib/checkout/backfill-plano-empresa').criar({
  empresa: 'good', prefixo: '/good-checkout-offline', cacheDir: CACHE_DIR, json, lerChaveAdmin,
  envPausa: 'GOOD_PLANO_PAUSA_MS',   /* respiro entre fatias (20 s) */
  /* Codex #696 r2: a fatia em curso aparece no _bfGood (como no runner antigo) — senão a rota manual
     do período passava pela guarda dela e respondia 202 pra um pedido que a trava recusaria */
  rodarFatia: async ({ de, ate }) => {
    _bfGood = { estado: 'rodando', de, ate, pelo_plano: true, iniciado: new Date().toISOString() };
    let x;
    try { x = await require('../lib/checkout/contexto-fundo').emFundo('good',
            () => require('../lib/checkout/backfill-rodar').backfillVendas(de, ate, 'good', _ctxBackfillGood())); }   /* 15/11 (norte C): o motor único, sem passar pela Girassol */
    catch (e) { _bfGood = { estado: 'parou', de, ate, pelo_plano: true, motivo: String(e.message || e) }; throw e; }
    _bfGood = { estado: (x && x.ok !== false && x.desfecho !== 'com_erros') ? 'ok' : 'parou', de, ate, pelo_plano: true, desfecho: x && x.desfecho, erros: x && x.erros, motivo: x ? (x.msg || x.adiado || null) : 'sem resposta' };
    return x;
  },
  ocupado: () => {
    try {
      /* Codex #696 r4: a trava COMPLETA (a rodada do ano da GOOD, o canário dela e o andamento do backfill DELA) */
      return !!((_bfGood && _bfGood.estado === 'rodando') || _canGood.estado.rodando ||   /* 23/10: e o canário da GOOD */
        /* 29/10 (3a): o andamento do backfill é POR EMPRESA — a GOOD olha o DELA; 15/11 (norte C): na peça, não mais no gbo-app */
        require('../lib/checkout/backfill-estado').ocupado('good')); }
    catch (e) { return true; }
  },
  /* Codex #696: a janela tem fronteira em 18h05 (não 18h00) — mesma regra pra quem acorda no boot */
  podeRodarAgora: () => require('../lib/checkout/contexto-fundo').janelaRotinaPesada(),
});
const _motorPlanoGood = _planoGood.motor;

/* ═══ 14/10 — ROTINA DIÁRIA DO HISTÓRICO DA GOOD ════════════════════════════════════════════
   A foto do histórico (14/10) mostrou os dias parando em 30/09: a GOOD não tinha rotina diária —
   Girassol e AMB têm a noturna das 03:30, a GOOD só andava com backfill na mão, e o painel em
   "Hoje"/"Mês" ficava vazio. Agora, todo dia às 05:15 (depois da noturna da Girassol, que usa a
   MESMA trava do backfill, e das rotinas de 04:15/04:40 da própria GOOD): refaz os últimos 3 dias
   e roda o resgate (pedido que nasce hoje com data de venda antiga). A regra mora em
   lib/checkout/diario-historico.js; aqui só o contexto da GOOD. Desliga com GOOD_DIARIO_HISTORICO=0.
   O estado aparece no /backfill-status (campo `diario`) e fica em _diario_historico.json. */
let _diarioGood = { estado: 'nunca rodou neste processo' };
async function rodarDiarioHistoricoGood(origem) {
  if (_diarioGood.estado === 'rodando') return _diarioGood;
  if (String(process.env.GOOD_DIARIO_HISTORICO || '').trim() === '0') {
    _diarioGood = { estado: 'desligado', motivo: 'GOOD_DIARIO_HISTORICO=0', em: new Date().toISOString() };
    try { writeJson(path.join(CACHE_DIR, '_diario_historico.json'), _diarioGood); } catch (e) {}   /* o desligado também sobrevive a reinício */
    return _diarioGood;
  }
  _diarioGood = { estado: 'rodando', origem: origem || 'cron', inicio: new Date().toISOString() };
  try {
    /* 15/11 (norte C): o motor único, o andamento/vaga e as situações de cancelamento vêm das peças — zero require cruzado */
    const _rodar = require('../lib/checkout/backfill-rodar'), _est = require('../lib/checkout/backfill-estado'), _sit = require('../lib/checkout/situacoes-cancelamento');
    const ctx = _ctxBackfillGood();
    const resg = require('../lib/checkout/backfill-resgate');
    const r = await require('../lib/checkout/diario-historico').rodarDiario({
      empresa: 'good',
      /* o backfill do dia aparece no mesmo status do mensal (e segura as rotas do mês/ano) */
      backfillVendas: async (de, ate, emp) => {
        _bfGood = { estado: 'rodando', de, ate, marca: Date.now().toString(36), iniciado: new Date().toISOString(), pelo_diario: true };
        let x;
        try { x = await _rodar.backfillVendas(de, ate, emp, ctx); }
        catch (e) { _bfGood = { estado: 'parou', de, ate, pelo_diario: true, motivo: String(e.message || e) }; throw e; }
        _bfGood = { estado: (x && x.ok !== false) ? 'ok' : 'parou', de, ate, pelo_diario: true,
                    desfecho: x && x.desfecho, motivo: x ? (x.msg || x.adiado || null) : 'sem resposta' };
        return x;
      },
      ocupado: () => !!((_bfGood && _bfGood.estado === 'rodando') || _canGood.estado.rodando ||
                        _est.ocupado('good')),   /* 29/10 (3a): o andamento DA GOOD; 15/11: pela peça */
      resgatar: (plano) => resg.resgatar({
        empresa: 'good', blingGet, supaReq: ctx.supaReq,
        backfillVendas: (d1, d2) => _rodar.backfillVendas(d1, d2, 'good', ctx),
        backfillEstado: () => _est.foto('good'),   /* 29/10 (3a): a vaga e o andamento DA GOOD */
        reservar: (m) => _est.reservarVaga(m, 'good'), liberar: () => _est.liberarVaga('good'),
        /* situações de cancelamento DA GOOD (cache por empresa desde o #686; 15/11: na peça) e o tombstone dela */
        situacoesCanceladas: async () => ((await _sit.garantirSitCancel(async p2 => await blingGet(p2), 'good')) || {}).ids || [],
        canceladosMkt: () => new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {}))),
        cacheDir: CACHE_DIR }, plano),
      planoResgate: (ms) => resg.planoDaNoturna(ms),
    });
    _diarioGood = Object.assign({ estado: r.ok ? 'ok' : 'parou', origem: origem || 'cron' }, r);
  } catch (e) {
    _diarioGood = { estado: 'parou', origem: origem || 'cron', motivo: String(e.message || e), fim: new Date().toISOString() };
  }
  try { writeJson(path.join(CACHE_DIR, '_diario_historico.json'), _diarioGood); } catch (e) {}
  console.log('[DIARIO-GOOD] ' + _diarioGood.estado + ' — ' + JSON.stringify(_diarioGood.backfill || _diarioGood.motivo || {}).slice(0, 200));
  return _diarioGood;
}
function _diarioGoodParaStatus() {
  if (_diarioGood.estado !== 'nunca rodou neste processo') return _diarioGood;
  /* depois de um deploy o estado em memória zera — mostra o da última rodada gravada */
  const salvo = readJson(path.join(CACHE_DIR, '_diario_historico.json'), null);
  return salvo ? Object.assign({ lido_do_disco: true }, salvo) : _diarioGood;
}

/* 01/10 — O PROGRESSO DENTRO DO MÊS. O dono ficou olhando o status repetir o mesmo texto por
   15-20 min sem saber se andava ou tinha travado: o `_bfGood` é uma FOTO tirada ao começar, e
   não se mexe mais até o mês acabar. O gbo já mantém o estado vivo (página, pedidos, gravados,
   fase) e o exporta em `backfillEstado()` — faltava só mostrar.
   Só entra enquanto está rodando, e só se for DESTE backfill: o gbo é compartilhado com a
   Girassol, e exibir o progresso dela aqui seria pior que não mostrar nada. */
function _bfStatusComProgresso(base) {
  const fora = base;   /* 15/11: o `ano` em memória saiu — o ano é o plano em disco, que já aparece no status (campo `plano`) */
  if (base.estado !== 'rodando') return fora;
  try {
    const viv = require('../lib/checkout/backfill-estado').foto('good');   /* 29/10 (3a): o andamento DA GOOD; 15/11: pela peça */
    if (!viv || !viv.rodando || viv.empresa !== 'good' || viv.de !== base.de) return fora;
    return Object.assign({}, fora, { progresso: {
      fase: viv.fase, pagina: viv.pagina, pedidos: viv.pedidos,
      gravados: viv.gravados, erros: viv.erros, msg: viv.msg || undefined } });
  } catch (e) { return fora; }   /* diagnóstico nunca derruba o status */
}

/* 15/11 (rotas-cópia): o backfill do ANO em memória da GOOD (a função do ano, o estado dele, a tabela de último dia e as
   esperas de 15 min) saiu — estava MORTO desde 15/10, quando o /backfill-ano virou o plano em disco (lib/backfill-fatiado +
   lib/checkout/backfill-plano-empresa, que agora tem a rota `rotaAno` das três). O que ele garantia (parar na hora certa,
   refazer o que falhou, esperar a trava) é o motor do plano que garante — e é o que os testes do plano provam. */
let _skuInfoCache = null;   // cache em memória do sku-info (saldo/preço/custo)

/* 17/09 — PORTE: a AMB e a Girassol escolhem o produto ATIVO quando o Bling devolve mais de um
   cadastro pro mesmo SKU; a GOOD pedia `limite=1` e ficava com o PRIMEIRO. Se houver cadastro
   antigo excluído, ela lê o custo dele — e custo errado vira MARGEM ERRADA no dashboard, pior
   que margem ausente porque ninguém desconfia de um número plausível.
   O conserto é de 19/08 e nunca chegou aqui; a lib já existe e já serve as outras duas. */
const _produtoAtivo = require('../lib/checkout/produto-ativo').criar({
  CACHE_DIR, readJson, writeJson,
  lerSkuInfoCache: () => _skuInfoCache,
  gravarSkuInfoCache: (v) => { _skuInfoCache = v; },
});
const { resolverProdutoPorSku } = _produtoAtivo;
let _mls = { rodando: false, feitos: 0, total: 0, ok: 0, falhas: 0, iniciado_em: null, erros: {}, amostras: [] };   // pesca de tarifas/frete REAIS do ML

// BACKFILL-NF LOCAL: lê nf-simp.json (cache/arquivo) e preenche vprod_nf nos conferidos sem ele.
// 100% disco, zero API — seguro pra rodar no cron diário e ao abrir o dashboard.
/* 25/10: o backfill das NFs do arquivo local é a peça única lib/checkout/backfill-nf-local (era idêntico nas três) */
const backfillNFLocal = require('../lib/checkout/backfill-nf-local').criarBackfillNFLocal({ ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, path, readJson, writeJson });
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');
const { enviarEmailDocs } = require('./email-docs');
const { listarAtendidos, detalhePedido, sincronizarConferidos, indexarCatalogoCompleto, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus, fullJaDespachado } = require('./ciclo');

// ─── Config (env prefixo GOODBKP_, defaults sãos) ───────────────────────
// presença entre PCs: quem está separando cada pedido. Limpa reservas vencidas a cada leitura.
// operadores p/ login (env GOODBKP_OPERADORES = "Nome:senha,Nome:senha"). Vazio = login DESLIGADO.
// quem pode REABRIR/reverter pedido (env GOODBKP_ADMIN = "Diego" ou "Diego,Angelica"). Vazio = sem restrição (todo mundo pode).

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

// GET autenticado no Bling GOOD (token via tokenManager + retry 429)

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

// ── SESSÃO SHOPEE QUE SE RENOVA SOZINHA (b13) ───────────────────────────
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
const SHOPEE_ENV_COOKIE  = 'GOODBKP_SHOPEE_COOKIE';
/* 15/11 (norte C, rotinas iguais → peça): a GOOD era a única que ainda tinha a CÓPIA da sessão da Shopee (~88 linhas,
   byte a byte iguais à peça lib/checkout/shopee-sessao que Girassol e AMB usam desde 11/09 — o Codex do #399 tinha
   apontado). Agora é a peça, com o nome da env e o tag desta empresa. */
const _shopeeSessao = require('../lib/checkout/shopee-sessao').criar({
  CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE, TAG: 'GOODBKP',
});
const { shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, shopeeKeepAlive, SHOPEE_CAB, SHOPEE_SESSAO_FILE,
        _shopeeHash, _urlStatus } = _shopeeSessao;


/* ═══ 22/08 — CUSTO: agora vem de lib/custo.js (código único das 3 empresas) ═════════════
   A GOOD tinha 14 das 19 funções — faltava o DE-PARA inteiro (o "464" = "HC-464-220v" e o
   automático por produto_id). Não foi decisão: foi eu escrever 3× em 21/08 e esquecer dela.
   Ao passar pela lib, a GOOD GANHA essas 5 funções junto — não é só remover duplicata.
   `skuInfoCache` vai por getter porque a lib limpa o cache de 6h quando o custo muda. */

/* 14/10 (parecer do Codex, 6.1): o contexto do backfill da GOOD num lugar so (periodo e ano tinham
   duas copias). Alem de Bling/cache/Supabase/aliquotas, leva as dependencias FINANCEIRAS da GOOD —
   custo na data da venda, token do ML, loja->canal, contador do Supabase — e declara SEM (null) as
   que a GOOD ainda nao produz: billing do ML, escrow da Shopee e banco de frete do Magalu. Sem elas o
   backfill fica com o que o Bling da GOOD trouxe, em vez de cair nas fontes da Girassol (era o que
   acontecia: linha empresa='good' com custo/comissao/frete da Girassol). Ligar cada uma = trocar o
   null pela fonte da GOOD quando ela existir. */
function _ctxBackfillGood() {
  const supa = require('../lib/supabase').para('good');
  return {
    blingGet, readJson, CACHE_DIR,
    ehFlex,   /* Codex #770: o classificador Flex da GOOD (SHOPEE_LOGISTICA_FLEX_EMPRESAS=good vale pra ela, não pra Girassol) */
    /* 29/10: a caça de vendas da Magalu DA GOOD entra na reconstrução (sem ela, o backfill apagaria o que a caça recuperou),
       e o backfill não começa com a caça gravando */
    magaluLinhas: (d1, d2, e2, j2) => _cacaMgGood.magaluLinhas(d1, d2, e2, j2),
    cacaMagaluRodando: () => _cacaMgGood.estado().rodando,
    canarioRodando: () => _canGood.estado.rodando,   /* 23/10 (Codex #731): TODO backfill da GOOD (manual, diário, plano, ano) respeita o canário dela */
    reparoAtivo: () => !!_reparoAtivoGood,   /* 16/11: e a trava do sku-repara dela (como a Girassol e a AMB) */
    supaReq: (empresa, metodo, pq, body) => supa.req(empresa, metodo, pq, body),
    supaCount: (empresa, filtro) => supa.count(empresa, filtro),
    DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD,
    custoVigenteEm: (sku, data) => custoVigenteEm(sku, data),   /* 16/11: pela peça do custo (lib/checkout/custo-empresa) */
    garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
    LOJA_MKT,
    /* 19/10 (Codex #720): o faturamento do ML existe na GOOD (lib/checkout/ml-billing) — o backfill usa a comissão e o
       frete oficiais dele, e redistribui os créditos do Flex no período depois da troca */
    mapasBilling: () => _mlBillingGood.mapasBilling(),
    creditosFlex: (de, ate) => _mlBillingGood.aplicarCreditosFlexNaFila(de, ate),
    /* 27/10: o REPASSE REAL da Shopee (escrow) pela peça da GOOD (loja 'good' no serviço) — a venda da Shopee passa a sair
       com a comissão e as taxas do repasse, como na Girassol e na AMB, e não com a estimativa do Bling (lazy: a peça
       nasce mais abaixo neste arquivo) */
    escrowEmLote: (...a) => escrowEmLoteShopeeGood(...a), escrowDoPedido: (...a) => escrowDoPedidoShopeeGood(...a),
    /* 24/10: a previsão do frete da Magalu (média do frete REAL do SKU, banco da GOOD) quando o Bling não traz o frete —
       igual à Girassol e à AMB; o real substitui quando o pedido liquida */
    magaluFreteSkuLer: (...a) => magaluFreteSkuLer(...a),
  };
}
/* 16/11 (montarCheckout, passo 5): o custo da empresa é a peça lib/checkout/custo-empresa — o contexto do lib/custo, os atalhos de custo
   manual/vigência/de-para/nome e o vendas-ops (recálculo, fornecedores, estados), com o que é DESTA empresa; a GOOD ganha o que
   não tinha por aqui (`buscarDevolucoesML`, `resolverNomeSku`/`carregarCatalogoDePara` já eram dela). Os nomes continuam os mesmos. */
const _custoEmp = require('../lib/checkout/custo-empresa').criar({ empresa: 'good', CACHE_DIR, path, fs, readJson, writeJson, blingGet,
  skuInfoCache: () => (typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null), histCache: () => _histCacheGood });
const { _ctxCusto, lerCustosManuais, gravarCustosManuais, custoManualDe, comCustosManuais, parsearCustosColados, telaCustosManuais,
  lerVigencias, gravarVigencias, registrarCustoVigente, custoVigenteEm, lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku,
  resolverNomeSku, carregarCatalogoDePara, _hojeISO, _ontemISO, _diaAntes, buscarDevolucoesML, varrerFornecedores, reaplicarCusto, estadoReapCusto, estadoVarrerForn } = _custoEmp;
/* 10/11 (4d): a rota do de-para manual é a da peça comum (igual à Girassol e à AMB), com o prefixo e as funções DESTA empresa */
const _rotaDeParaSku = require('../lib/checkout/rota-depara-sku').criarRotaDeParaSku({
  prefixo: '/good-checkout-offline', path, CACHE_DIR, json,
  readJson: (...a) => readJson(...a),
  validarSessao: (...a) => validarSessao(...a),
  ehAdmin: (...a) => ehAdmin(...a),
  lerDeParaSku: (...a) => lerDeParaSku(...a),
  gravarDeParaSku: (...a) => gravarDeParaSku(...a),
  resolverDeParaSku: (...a) => resolverDeParaSku(...a),
  sugerirDeParaSku: (...a) => sugerirDeParaSku(...a),
});

/* 15/11 (norte C): o keep-alive da Shopee é a peça (shopee-sessao.shopeeKeepAlive, com o tag desta empresa) */

/* 17/09 — o parser saiu daqui pra lib/checkout/zip-etiquetas.js, que agora serve as três.
   Esta empresa já o tinha no escopo do módulo (a rota de massa reusa) — foi a AMB e a
   Girassol que vieram pro ponto dela, não o contrário. */
const lerZipEntradas = require('../lib/checkout/zip-etiquetas').lerZipEntradas;


/* 30/10: o DECODIFICADOR das etiquetas raster da Shopee virou a peça única lib/checkout/decodificar-zpl-shopee
   (usado pelas rotas de lote, lib/checkout/rotas-lote). As rotas de lote da GOOD saem da peça, montada aqui. */
/* o `readBody` chega como parâmetro do `routes` (ver abaixo) — a peça é montada na 1ª chamada, que recebe ele */
let _rotasLoteGood = null;
function _rotasLote(readBody) {
  if (!_rotasLoteGood) _rotasLoteGood = require('../lib/checkout/rotas-lote').criarRotasLote({
    prefixo: '/good-checkout-offline', tag: 'GOODBKP', nome: 'GOOD', empresaAviso: 'good',
    CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody, readJson, writeJson, ensureDir, manifest,
    validarSessao, ehAdmin, baixarDanfe,
  });
  return _rotasLoteGood;
}

/* 14/09 — HISTÓRICO DA GOOD. Tudo o que faltava já existia: o `base` tem as dependências, o
   backfill já grava no Supabase com empresa='good', e o painel JÁ CHAMAVA
   /good-checkout-offline/historico — a chamada existia e batia numa rota que não existia.
   Agora a rota existe, usando a mesma lib da AMB e da Girassol.

   ⚠️ ALÍQUOTAS: cada empresa tem a PRÓPRIA tabela mensal do Simples (a AMB vai de 4% a 8,82%
   em 2026; a Girassol, de 11,4% a 15%). A da GOOD é dado que o dono precisa informar, e por
   isso a tabela abaixo está VAZIA de propósito: o cálculo cai no padrão de 15% e as alíquotas
   salvas no painel continuam tendo precedência. Chutar alíquota seria inventar imposto —
   número errado é pior que número ausente. */
/* 17/09/2026 — ALÍQUOTAS REAIS DO ANO. O comentário acima explica por que esta tabela ficava
   vazia: chutar alíquota seria inventar imposto. Agora o dado não é chute — são os valores
   APURADOS, informados pelo dono, que disse que "não mudam mais". Era o que a auditoria
   listava como aproximação a confirmar (o padrão de 15% entrava no lugar).

   O que continua valendo: as alíquotas salvas no painel (⚙️) têm PRECEDÊNCIA sobre esta
   tabela — ela é o que o cálculo usa quando o painel não tem valor para o mês.

   ⚠️ Mudar um valor AQUI não reaplica sozinho no histórico já gravado: a reaplicação (#498)
   dispara ao salvar pelo painel. Corrigir por aqui e depois salvar o mesmo mês no ⚙️ é o que
   recalcula as linhas antigas. */
/* 18/09 — a GOOD tem a lista também, pelo mesmo motivo das outras duas: a tabela dela é toda
   apurada HOJE, mas nada impede alguém de acrescentar uma estimativa amanhã, e aí a tela
   passaria a chamá-la de apurada. A lista é o que diz a verdade, não a presença na tabela. */
/* a lista e a tabela andam JUNTAS: o teste reprova se divergirem, porque marcar como apurado
   um mês sem valor é prometer um dado que não está lá. Foi o que ele pegou quando eu adiantei
   agosto aqui antes de o #504 entrar — agora o valor está lá e a lista acompanha. */
const ALIQ_APURADOS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const DEFAULT_ALIQ_BK_GOOD = {
  '2026-01': 11.819396, '2026-02': 12.7287, '2026-03': 13.2889, '2026-04': 14.2829,
  '2026-05': 14.8073,   '2026-06': 15.0707, '2026-07': 15.03,
  '2026-08': 14.9946,   // apurada em 18/09
  /* agosto em diante ainda não apurados — sem valor aqui, o cálculo cai no padrão, e é isso
     que deve acontecer: estimar mês que não fechou é o erro que este bloco evitava. */
};
const _histCacheGood = {};
/* 29/10 — CAÇA DE VENDAS DA MAGALU (peça lib/checkout/magalu-caca; era só da AMB): o que a Magalu vendeu e o Bling da GOOD
   não tem (Magalu Full) entra no histórico DELA. De hora em hora, pela rota /magalu-caca da fábrica e dentro do backfill.
   A chave da GOOD nas rotas /magalu/ é 'good' (GOODBKP_MAGALU_EMPRESA muda, se precisar). A GOOD não tem o reparo de SKU. */
const _supaCacaGood = require('../lib/supabase').para('good');
const _cacaMgGood = require('../lib/checkout/magalu-caca').criarCacaMagalu({
  empresa: 'good', magaluEmpresa: () => process.env.GOODBKP_MAGALU_EMPRESA || 'good',
  supaReq: (e, m, pq, b) => _supaCacaGood.req(e, m, pq, b), blingGet: (...a) => blingGet(...a), readJson: (...a) => readJson(...a), CACHE_DIR,
  DEFAULT_ALIQ_BK: () => DEFAULT_ALIQ_BK_GOOD, magaluFreteSkuLer: () => magaluFreteSkuLer(), reparoAtivo: () => _reparoAtivoGood,   /* 16/11: a trava do sku-repara da GOOD */
  histCache: () => _histCacheGood,
});
const _supaGood = require('../lib/supabase');
const { rotasHistorico } = require('./historico-good');

const _rotasCatalogo = require('../lib/checkout/rotas-catalogo').criar({
  prefixo: '/good-checkout-offline', json, blingGet, ehAdmin, skuEanCache, lerIndiceEan, salvarNoIndiceEan,
  getPossiveisGtins, produtoDetalhe, primeiraImagem, locCache, localizacaoDeProduto,
  indexarCatalogoCompleto, getIdxStatus,
});

// ─── Rotas HTTP (namespaced) ────────────────────────────────────────────
/* 31/10 — as ROTAS COMUNS do checkout (peça única lib/checkout/rotas-comuns): montada na 1ª chamada, que recebe o
   `readBody` do handler; da empresa só o prefixo, o nome no log, a chave e as peças dela */
let _rotasComunsGood = null;
function _rotasComuns(readBody) {
  if (!_rotasComunsGood) _rotasComunsGood = require('../lib/checkout/rotas-comuns').criarRotasComuns({
  /* 09/11: o e-mail do código da coleta usa a MESMA conta e o MESMO estoque do e-mail da etiqueta desta empresa */
  emailEmpresa: () => ({ SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST }),
  /* 08/11 (rotas comuns, passo 10b): o que o /config-fiscal usa — as alíquotas, o cache do histórico e a reaplicação DESTA empresa */
  ALIQ_PADRAO: DEFAULT_ALIQ_BK_GOOD, ALIQ_APURADOS, lerHistCache: () => _histCacheGood, reaplicarImposto: (m) => reaplicarImposto(m),
  /* 08/11 (rotas comuns, passo 9b): o que o /sku-info usa — o cache, o contexto de custo e a busca do produto DESTA empresa */
  _ctxCusto, comCustosManuais: (...a) => comCustosManuais(...a), resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a), lerSkuInfoCache: () => _skuInfoCache, gravarSkuInfoCache: (v) => { _skuInfoCache = v; },
  /* 07/11 (rotas comuns, passo 8): o que o /custo-sync usa — o estado e o motor de custo DESTA empresa */
  _cst, custoSyncTravado: (...a) => custoSyncTravado(...a), custoRetryPendente: () => custoRetryPendente(), travaPesada, _urlStatus, _cstDiario, _diaFechadoDoDisco: (...a) => _diaFechadoDoDisco(...a),
  /* 07/11 (rotas comuns, passo 7): a TELA do dashboard desta empresa (a configuração dela) -- a rota é da peça */
  htmlDashboard: () => require('../lib/checkout/painel/empresas').painelDaEmpresa('good', { defaultAliq: DEFAULT_ALIQ_BK_GOOD }),
    prefixo: '/good-checkout-offline', tag: 'GOODBKP', empresa: 'good',
    reaplicarCusto,   /* 12/11: o recálculo das vendas ao lançar/apagar custo (rotas comuns) */
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, JANELA_DIAS, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, RESERVAS_FILE, RESGATES_FILE, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, VERSAO, _detalheBling, _diaAntes, _hojeISO, _moverAtendidoDesandando, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, moverSituacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    SIT_DESPACHADOS: require('./base').SIT_DESPACHADOS || 0,   /* a GOOD lê do base (não é constante do arquivo dela) */
    mmEtiquetas: () => require('../good-mm-etiquetas'), mlTokenManager: () => require('../good/mlTokenManager'),
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'), skuReparaNoHistorico: false,   /* a GOOD não tem o sku-repara no histórico */
    /* na GOOD o andamento da reaplicação do imposto vem da lib dela (era um const dentro do routes) */
    estadoImposto: () => require('../lib/imposto-cancelados').estadoReaplicarImposto('good'),
  });
  return _rotasComunsGood;
}

/* 08/11 (rotas comuns, passo 10b): a reaplicação do imposto da GOOD no nível do arquivo — era criada a CADA requisição dentro de
   routes(); a peça comum (criada uma vez, na primeira requisição) chama reaplicarImposto depois, e a definição de dentro de
   routes() ficava presa àquela primeira requisição. Só mudou de lugar: as peças do contexto já eram todas do nível do arquivo. */
const _impLibGood = require('../lib/imposto-cancelados');
const _ctxImpGood = {
  readJson,
  get supaCfg()         { return (empresa) => _supaGood.cfg(empresa); },
  get CACHE_DIR()       { return CACHE_DIR; },
  get DEFAULT_ALIQ_BK() { return DEFAULT_ALIQ_BK_GOOD; },
  get histCache()       { return _histCacheGood; },
  get path()            { return path; },
  log: console.log,
};
const reaplicarImposto = (meses) => _impLibGood.reaplicarImposto(_ctxImpGood, meses, 'good');
const estadoImposto = () => _impLibGood.estadoReaplicarImposto('good');

function routes(readBody) {
  /* 14/11 — AS CINCO PEÇAS DE ROTA DA OPERAÇÃO (contagem de estoque, separação, backfill, NF anexada, conferido) são
     ligadas pela peça lib/checkout/rotas-operacao — a mesma pras três. O prefixo da URL, a pasta, a env do depósito e
     o id da empresa saem da configuração dela (lib/checkout/config-empresa); aqui vão só as peças DESTE arquivo.
     ⚠️ Criado DENTRO do routes porque o `readBody` chega como PARÂMETRO daqui: fora, o boot cai com
     "readBody is not defined" (já aconteceu duas vezes — numa o lint pegou, na outra só o boot). */
  const _rotasOperacao = require('../lib/checkout/rotas-operacao').criar('good', {
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
  /* 31/10: o DIAGNÓSTICO (peça única lib/checkout/diagnostico-empresa, como a Girassol) — chamado POR ÚLTIMO no handler */
  const diag = require('./good-diagnostico').rotasDiagnostico({ VERSAO, validarSessao, supaCfg: (empresa) => _supaGood.cfg(empresa), readBody });
  const hist = rotasHistorico({
    validarSessao,
    supaCfg: (empresa) => _supaGood.cfg(empresa),
    DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD,
    histCache: _histCacheGood,
    /* 25/10: a PREVISÃO DO FRETE DA MAGALU na leitura do histórico (fase 2: a tabela por peso/cubagem, quando o SKU ainda
       não tem média de frete real) — a Girassol e a AMB passam desde 26/08; a GOOD não passava, então todo pedido da
       Magalu sem frete gravado aparecia com frete ZERO no Mês/Ano (765 de 765 em 2026). Lazy: a peça é criada mais abaixo. */
    magaluFretePrevistoSku: (...a) => magaluFretePrevistoSku(...a),
    /* Codex #560: o histórico publicou SKU sem custo novo → roda o sync (travado; só pega o que falta) */
    aoPublicarSkusSemCusto: () => { try { custoSyncTravado(false, true).catch(() => {}); } catch (e) {} },
  });

  /* 17/09 — PORTE: a AMB e a Girassol REAPLICAM o imposto nos pedidos já gravados quando a
     alíquota de um mês muda; a GOOD só salvava a alíquota nova. Efeito: corrigir a alíquota de
     um mês passado não mexia em nada do que já estava no histórico — a tela seguia mostrando a
     margem calculada com a alíquota velha, sem erro nenhum.
     A lib existe desde 25/08 e serve as outras duas; a GOOD nunca foi ligada. Ela usa só 6
     peças do contexto (`CACHE_DIR`, `DEFAULT_ALIQ_BK`, `histCache`, `path`, `readJson`,
     `supaCfg`), e a GOOD já tem as seis — não precisa do `garantirSitCancel`, que é do
     varrerCancelados, a função irmã. */
  /* 08/11 (rotas comuns, passo 10b): a reaplicação do imposto (_impLibGood/_ctxImpGood/reaplicarImposto/estadoImposto) subiu pro
     nível do arquivo, logo acima de routes() — é a mesma de sempre, mas a peça comum (criada uma vez) precisa dela fora daqui. */

  /* 15/11 — A CABEÇA COMUM DO ROUTES (lib/checkout/cabeca-routes): /api/contexto → /descobrir-ids → PORTÃO DE SESSÃO →
     catálogo → sonda dos cancelados → as cinco peças da operação, na ordem de sempre (o portão ANTES de catálogo,
     cancelados e operação — Codex #480). O que é da empresa (prefixo, pasta, token do ML, conta do TikTok, envs e padrões
     do /descobrir-ids) vem de lib/checkout/config-empresa; aqui só as peças DESTE arquivo. */
  const _cabeca = require('../lib/checkout/cabeca-routes').criar('good', {
    json, lerChaveAdmin, blingGet, validarSessao, ehAdmin, manifest, lerConferidos: () => readJson(CONFERIDOS_FILE, {}),
    uiBuild: require('./painel-marca').UI_BUILD,   /* 27/10: a versão do painel vem da marca (o painel é a peça única) */
    rotasCatalogo: _rotasCatalogo, rotasOperacao: _rotasOperacao,
  });
  async function _rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === '/good-checkout-offline/backfill-status')) return false;
    /* 17/09 — a AMB e a Girassol aceitam chave OU sessão de admin nesta rota; a GOOD aceitava
       só chave. É a mesma capacidade do #492, ao contrário: lá o admin logado não alcançava
       rotas que só aceitavam sessão; aqui ele não alcança uma que só aceita chave — abrir o
       painel e consultar o backfill não funcionava na GOOD sem colar a chave na URL.
       (O 404 em vez de 403 é proposital e fica: rota de diagnóstico não confirma que existe
       pra quem não tem credencial.) */
    const kS = lerChaveAdmin(req, urlObj);
    const sessS = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && kS === process.env.ADMIN_KEY) || (sessS && ehAdmin(sessS)))) { json(res, 404, { error: 'not found' }); return true; }
    const _stG = _bfGood || { estado: 'nunca rodou neste processo' };   // + o ANO e o progresso VIVO
    /* 14/10: + a rotina diária do histórico (campo `diario`) */
    json(res, 200, _statusBackfillGood(_stG));   /* 15/10: + diário e o plano automático */
    return true;
  }
  /* ═══ 01/10 — PARIDADE DO PAINEL: rotas que a AMB tinha e a GOOD não ═══
     O dono: "o que o painel de dashboard tem pra uma, tem q ter pra outra... os botões, os
     cards, isso tem q ser iguais nelas". Medi antes de copiar: das 18 que eu achava que faltavam, 5 já respondiam pelas libs
     comuns que a GOOD monta — sobraram 11, que entraram por levas (ml-fatura-cartao, tiktok-custo-devolucoes,
     magalu-cancelados… hoje todas pela fábrica do painel e pelas peças). O que ainda é SÓ desta empresa fica abaixo. */
  async function _rotaBackfillVendas(req, res, urlObj, method, p) {
    if (!((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/backfill-vendas')) return false;
    const kB = lerChaveAdmin(req, urlObj);
    if (!(process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
    const de = urlObj.searchParams.get('de') || '';
    const ate = urlObj.searchParams.get('ate') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      json(res, 400, { ok: false, erro: 'use ?de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
    }
    if (de > ate) { json(res, 400, { ok: false, erro: 'de maior que ate' }); return true; }
    try {
      const gbo = require('../lib/checkout/backfill-rodar');   /* 15/11 (norte C): o motor único (era o gbo-app da Girassol) */
      /* 14/10 (parecer do Codex, 6.1): contexto num lugar so — ver _ctxBackfillGood */
      const ctxGood = _ctxBackfillGood();
      /* roda em BACKGROUND: um mês de backfill leva minutos e o navegador desiste antes */
      /* 30/08: guarda o estado pra dar pra acompanhar sem caçar no log do Render — foi a
         primeira coisa que o dono precisou e não existia (o TikTok e o Magalu têm). */
      /* Codex #309 r4: minha detecção de "outro rodando" comparava o período — se alguém
         dispara DUAS vezes o MESMO mês, os períodos batem e o segundo apareceria como
         sucesso. Marco de quem é a rodada, decidido ANTES de disparar, resolve sem
         depender de comparar datas. */
      const jaAtivo = _bfGood && _bfGood.estado === 'rodando';
      if (jaAtivo) {
        json(res, 409, { ok: false, empresa: 'good', de, ate,
          erro: 'já existe um backfill da GOOD em andamento (' + (_bfGood.de || '') + '→' + (_bfGood.ate || '') + ') — aguarde terminar',
          /* Codex #309 r5: sobrou o placeholder aqui quando corrigi o outro — mesmo
             problema, link que não abre, na resposta que o dono mais vai ver (a de
             "já tem um rodando"). */
          acompanhe: '/good-checkout-offline/backfill-status?k=' + encodeURIComponent(kB) });
        return true;
      }
      const marca = Date.now().toString(36);
      _bfGood = { estado: 'rodando', de, ate, marca, iniciado: new Date().toISOString() };
      gbo.backfillVendas(de, ate, 'good', ctxGood)
        .then(r => {
          /* 31/08 — agora a função DIZ o que aconteceu: toda saída dela devolve `desfecho`
             (ok / com_erros / erro / abortado / ja_rodando / adiado). Antes eu inferia isso
             de fora comparando período, lendo fase e marcando rodada — três remendos que
             nasceram do mesmo defeito e cada um deixava um caso passar. */
          const d = r || {};
          const desf = d.desfecho || (d.adiado ? 'adiado' : (d.ok === false ? 'nao_rodou' : 'ok'));
          const MAPA = {
            ok: ['ok', null],
            com_erros: ['concluido_com_erros', 'terminou, mas houve erros em itens — confira antes de seguir'],
            erro: ['falhou', d.msg || 'erro durante o backfill'],
            /* 'abortado' vem de DOIS lugares: 6 falhas seguidas do Bling, e a trava de
               sanidade (dados novos < 60% do guardado). Nos dois casos NADA foi apagado —
               a mensagem original explica qual foi. */
            abortado: ['falhou', d.msg || 'abortado — NADA foi apagado, rode de novo'],
            ja_rodando: ['nao_rodou', d.msg || 'já havia um backfill em andamento'],
            /* Codex #309: o adiamento vem de dois lugares com campos diferentes — o
               reparo de SKU usa `adiado` e o canário usa `msg`. Lendo só um, o operador
               via 'adiado' sem saber o motivo. */
            adiado: ['nao_rodou', d.adiado || d.msg || 'adiado (canário ou reparo de SKU em andamento)'],
            nao_rodou: ['nao_rodou', d.msg || 'recusou iniciar'],
          };
          const [estado, motivo] = MAPA[desf] || ['ok', null];
          _bfGood = {
            estado, motivo, desfecho: desf, de, ate, marca,
            terminado: new Date().toISOString(),
            pedidos: d.pedidos, itens: d.itens, gravados: d.gravados, erros: d.erros, fase: d.fase || null,
          };
          console.log('[GOOD backfill]', desf, JSON.stringify(d).slice(0, 180));
        })
        .catch(e => {
          _bfGood = { estado: 'falhou', de, ate, erro: String(e.message || e).slice(0, 200), terminado: new Date().toISOString() };
          console.error('[GOOD backfill] falhou:', e.message);
        });
      json(res, 202, { ok: true, empresa: 'good', de, ate, em_background: true,
        /* Codex #309 r4: o placeholder não abre; devolve o link com a chave que veio */
        acompanhe: '/good-checkout-offline/backfill-status?k=' + encodeURIComponent(kB),
        nota: 'rode um mês por vez pra não estourar o tempo' });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) });
    }
    return true;
  }
  /* 16/11 — A FILA DE PEÇAS DE ROTA É A PEÇA lib/checkout/rotas-empresa (a mesma ordem nas três; a fábrica do painel por
     último, as rotas próprias antes das compartilhadas). Aqui só o que é desta empresa: cada passo com as peças dela.
     Os comentários do `handle` antigo (a história de cada rota e de cada decisão de ordem) estão em docs/HISTORICO-HANDLE-ROTAS.md. */
  const _rotas = require('../lib/checkout/rotas-empresa').criar('good', {
    cabeca: _cabeca,
    comuns: (req, res, urlObj, method, p) => _rotasComuns(readBody).handle(req, res, p, method, urlObj),
    lote: (req, res, urlObj, method, p) => _rotasLote(readBody).handle(req, res, p, method, urlObj),
    planoAno: (req, res, urlObj, method, p) => _planoGood.rotaAno(req, res, urlObj, method, p),
    plano: (req, res, urlObj, method, p) => _planoGood.rota(req, res, urlObj, method, p),
    canEmp: (req, res, urlObj, method, p) => _canGood.rotas({ PREFIXO: '/good-checkout-offline', json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p),
    backfillStatus: _rotaBackfillStatus,
    /* 16/11 (passo 2): semear o cookie e consultar a devolução da Shopee — peça das três (eram as rotas próprias da AMB) */
    shopeeSessao: require('../lib/checkout/rotas-shopee-sessao').criar({ PREFIXO: '/good-checkout-offline', VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody,
      readJson, writeJson, ensureDir, fetch, sessao: _shopeeSessao, SHOPEE_ENV_COOKIE }),
    proprias: [_rotaBackfillVendas],
    deParaSku: (req, res, urlObj, method, p) => _rotaDeParaSku(req, res, urlObj, method, p),
    hist: (req, res, urlObj) => hist(req, res, urlObj),
    pesca: { montar: () => { const _p = require('./good-pescaria').rotasPescaria({ validarSessao,
      supaCfg: (e) => require('../lib/supabase').cfg(e), supaReq: (e, m, pq, b) => require('../lib/supabase').para('good').req(e, m, pq, b), pescarDadosML }); return (req, res, urlObj) => _p(req, res, urlObj); } },
    canario: (req, res, urlObj) => rotasCanarioIntegracoes({ VERSAO, validarSessao })(req, res, urlObj),
    noturna: (req, res, urlObj) => _noturnaGood.rotas(req, res, urlObj),
    shopee: (req, res, urlObj) => rotasShopeeGood({ validarSessao })(req, res, urlObj),
    diag: (req, res, urlObj) => diag(req, res, urlObj),
    painel: { montar: () => {
    const _f = require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({
        empresa: 'good', prefixo: '/good-checkout-offline',
        basePrevisao: 90, // a GOOD nasceu com 90 dias; a fábrica não conhece empresa (#639)
        rotasProprias: [
          'canario-marketplaces',   /* 23/10: o canário é da peça única (lib/checkout/canario-empresa), montada aqui */
          /* ⚠️ 04/10 — A FÁBRICA ESTAVA RESPONDENDO NO LUGAR DESTAS DUAS. A montagem fica na
             linha ~867 e as rotas próprias da GOOD estão nas ~1059 e ~1076: a fábrica é
             consultada ANTES e vencia, devolvendo "esta empresa ainda não expõe `responderCusto`"
             — enquanto a rota da GOOD, logo abaixo, FUNCIONA e nunca era alcançada.
             Não era falta de peça: era ordem. Quem tem rota própria declara aqui. */
          'tiktok-custo-devolucoes',
          'custo-historico',
          'magalu-cancelados',
          'custo-sync'
        ],   /* Codex #569: a GOOD tem custo-sync próprio (status rico) */
        nomeEmpresa: 'GOOD Import',      /* Codex #573: título da tela de custo manual — era o da AMB */
        /* ⚠️ `readBody` vem como PARÂMETRO de `routes(readBody)`, não é declarado no arquivo
           — o eslint acusou e eu só entendi ao ler a assinatura. Está no escopo aqui dentro. */
        pecas: { /* 11/11 (4d, /etiqueta-diag): a etiqueta, o manifesto e as pastas DESTE checkout */ baixarEtiquetaPDF, MANIFEST_FILE, salvarManifest, ensureDir, /* 10/11 (4d, /custos-manuais pela fábrica): o cache do sku-info DESTA empresa, por getter — mudar um custo manual limpa a
                 memória também, não só o disco (igual à Girassol) */ get skuInfoCache() { return typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null; }, /* 10/11 (4d, /buscar-pedido): */ sleep, PAUSA_MS, nfDoPedido, detalhePedido, /* 10/11 (4d): o arquivo do faturamento ML — a GOOD ganha status/outros/auditoria da fatura */ MLB_FILE, /* 08/11 (grupo do backfill na fábrica): a trava do canário */ get _canario() { return _canGood.estado; }, json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR,
                 fsx: fs, pathx: path, blingGet, readBody, ehAdmin, travaPesada,
                 /* 29/10: a caça de vendas da Magalu da GOOD (a rota /magalu-caca da fábrica) */
                 cacaMagalu: (...a) => _cacaMgGood.cacaMagalu(...a), _mgc: _cacaMgGood.estado(),
                 /* 24/10: a correção da tarifa do TikTok existe na GOOD — /tiktok-completar-tarifa deixa de responder semPeca */
                 completarTarifaTikTok: (...a) => completarTarifaTikTokGood(...a),
                 custoSyncTravado, _urlStatus, LOJA_MKT, CONFERIDOS_FILE,
                 estadoRotinas: _estadoRotinas,
                 /* 14/10: o custo diário da GOOD existe — a rota /custo-diario deixa de responder semPeca */
                 custoDiario, _cstDiario, _diaFechadoDoDisco, CUSTO_FILE_DIARIO,
                 /* 19/10: a venda do dia existe — /vendas-sync e o completar-detalhes deixam de responder semPeca */
                 vendasSync: (...a) => vendasSync(...a), _inferCanal: (...a) => _inferCanal(...a),
                 /* 19/10: a GOOD agora CONSOME a config do frete Magalu — a venda do dia calcula o frete provisório pela
                    lib/checkout/magalu-frete, que lê o nível de desconto em _config-frete-magalu.json. Com a peça, o ⚙️ do
                    painel (o mesmo modelo da AMB) deixa de responder semPeca e o nível escolhido passa a valer. */
                 configFreteMagalu: true,
                 /* 19/10: a varredura de cancelados existe — /varrer-cancelados e o status deixam de responder semPeca */
                 varrerCancelados: (...a) => varrerCancelados(...a), estadoCancelados: () => estadoCancelados(), sitCancel: () => _cancGood.sitCancel(),
                 /* 19/10: faturamento do ML e créditos do Flex — o estado é o MESMO objeto da peça (nunca trocado) */
                 _mlb: _mlBillingGood._mlb, _mlcred: _mlBillingGood._mlcred, mlBillingSync: (...a) => mlBillingSync(...a), aplicarCreditosFlex: (...a) => aplicarCreditosFlex(...a),
                 /* 02/10 — bloco 2: a empresa também no BANCO, no TOKEN e nas ENVS. Sem o
                    prefixo certo aqui, a GOOD leria `AMBBKP_*` e traria config da AMB. */
                 envPrefixo: 'GOODBKP_',
                 /* o `supaGood` do arquivo nasce ~140 linhas ABAIXO e dentro de outra função
                    — o eslint acusou. Aqui monto o meu, da mesma lib e da mesma empresa. */
                 supaReq: (e, m, q, b2) => require('../lib/supabase').para('good').req(e, m, q, b2),
                 /* bloco 3 (02/10): das 12 peças novas, a GOOD tem UMA. As outras 11 são
                    rotinas que ela ainda não possui — `undefined` é o certo: a rota recusa
                    dizendo QUAL falta e passa a funcionar no dia em que existir. Fingir seria
                    pior: o painel mostraria vazio como se fosse zero. */
                 reaplicarImposto: (typeof reaplicarImposto === 'function') ? reaplicarImposto : undefined,
                 /* Codex #571: as peças JÁ existem aqui — token do ML da GOOD, `primeiraImagem` do
                    ./produtos e a config do banco. Sem elas as 4 rotas novas respondiam semPeca. */
                 garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
                 /* Codex #575: o manager INTEIRO (setup-ml e ml-trocar-code usam gerarUrlAutorizacao e
                    trocarCodigoPorToken, além do garantirTokenML). Se o require falhar, fica ausente
                    (a rota responde semPeca) em vez de derrubar a montagem de todas as rotas. */
                 mlTokenManager: (() => { try { return require('../good/mlTokenManager'); } catch (e) { return undefined; } })(),
                 primeiraImagem,
                 /* Codex #573: o cache vivo do sku-info, que a lib de custo limpa quando o custo muda
                    (o mesmo que `_ctxCusto` deste arquivo entrega) */
                 get skuInfoCache() { return typeof _skuInfoCache !== 'undefined' ? _skuInfoCache : null; },
                 FOTO_V: 6,   /* mesmo carimbo de leitura de foto da AMB (v6: todos os cadastros do SKU) */
                 supaCfg: (e) => require('../lib/supabase').para('good').cfg(e),
                 /* 16/11 (paridade do painel, NORTE item C passo 3): o que a Girassol e a AMB entregam e a GOOD não entregava — sete rotas
                    do painel respondiam "esta empresa ainda não expõe X" aqui. Mesmas peças, da GOOD:
                    · o andamento do backfill DA GOOD (lib/checkout/backfill-estado — o mesmo objeto que o motor escreve) e o canário dela;
                    · o cache do histórico dela; a trava do sku-repara (get/set); o disparo manual do backfill (o motor único, em fundo —
                      o mesmo caminho do diário); a contagem no Supabase; o recálculo de custo e a varredura de fornecedores (lib/vendas-ops);
                    · dataISO (o /sku-orfaos). */
                 _backfill: require('../lib/checkout/backfill-estado').estado('good'), _canario: _canGood.estado, _histCache: _histCacheGood,
                 _reparoAtivo: { get: () => _reparoAtivoGood, set: (v) => { _reparoAtivoGood = !!v; } },
                 backfillVendas: (de, ate) => require('../lib/checkout/contexto-fundo').emFundo('good', () => require('../lib/checkout/backfill-rodar').backfillVendas(de, ate, 'good', _ctxBackfillGood())),
                 supaCount: (e, f) => require('../lib/supabase').para('good').count(e, f),
                 reaplicarCusto, estadoReapCusto, varrerFornecedores, estadoVarrerForn, dataISO },
      });
      console.log('[GOOD] rotas compartilhadas do painel montadas');
      return (req, res, urlObj, method, p) => _f(req, res, p, method, urlObj);
    } },
  });
  const handle = _rotas.handle; handle.passos = _rotas.passos;   /* os passos ficam visíveis pro teste de ordem (scripts/teste-rotas-empresa.js) */
  return handle;
}

// roda 1 ciclo logo após o boot do serviço
/* 16/11 (norte C, montarCheckout passo 6): as ROTINAS DE CUSTO desta empresa — o estado e a anotação da falha, o sync de
   custo (e o "travado", com a re-tentativa), o custo diário das 23 h e a fila de recálculo — são a peça
   lib/checkout/rotinas-custo-empresa, a mesma das três. Aqui só o que é da GOOD, por acessor (lido na hora).
   A GOOD declara as três opções do sync de custo que só ela tem (o seletor do produto ativo, o fornecedor estrito e os
   SKUs do histórico pelo arquivo).
   A história de cada rotina (13/09 a falha identificada, 14/09 a trava pesada, 09-11/09 o custo diário, 13/11 o
   recálculo) está nas peças lib/checkout/custo-sync, custo-sync-travado, custo-diario e custo-recalculo, e o texto que
   ficava aqui em docs/HISTORICO-ROTINAS-CUSTO.md. */
const _rotCusto = require('../lib/checkout/rotinas-custo-empresa').criar({
  empresa: 'good',
  /* as três opções do sync de custo que só a GOOD declara (lib/checkout/custo-sync explica cada uma) */
  opcoesCustoSync: { seletor: 'ativo-v1', fornecedorEstrito: true, histSkusDoArquivo: true },
  pecas: {
    get CACHE_DIR() { return CACHE_DIR; },
    get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
    get _histCache() { return _histCacheGood; },
    get _limparSkuInfo() { return _produtoAtivo._limparSkuInfo; },   /* a GOOD não desestrutura o produto ativo (a peça protege a chamada) */
    get blingGet() { return blingGet; },
    get readJson() { return readJson; },
    get writeJson() { return writeJson; },
    get resolverProdutoPorSku() { return resolverProdutoPorSku; },
    get custoEmpresa() { return _custoEmp; },
  },
});
const { _cst, travaPesada, CUSTO_FILE_DIARIO, custoSyncTravado, custoRetryPendente, custoDiario, _cstDiario, _diaFechadoDoDisco } = _rotCusto;

// ─── VENDA DO DIA (19/10) — a MESMA peça da Girassol e da AMB (lib/checkout/vendas-dia.js) ─────────────────────
/* A GOOD não tinha a venda do dia (parecer de 15/10, item 5.2: "/vendas-sync: falta vendasSync"): o painel só via o
   que já tinha sido bipado. Agora a rotina traz TODAS as vendas do dia direto do Bling e dos marketplaces (ML, Shopee,
   Magalu, TikTok) e grava o _vendas_dia.json, como nas outras duas. Aqui fica só o que é da GOOD; as peças em volta
   vêm das mesmas libs que a AMB usa (fase direta, frete Magalu, pesca do ML, devoluções do ML, canal pelo nº). */
const _vsy = _estadoRotinas.vendas;
const _inferCanal = require('../lib/checkout/inferir-canal').inferirCanal;
const { pescarDadosML } = require('../lib/ml-pesca');
let _reparoAtivoGood = false;   /* a trava do sku-repara (o backfill e a caça da GOOD checam antes de começar — eram `() => false`) */
const _faseDireta = require('../lib/checkout/fase-direta').criarFaseDireta({
  empresa: 'good',
  mlTokenManager: () => require('../good/mlTokenManager'),
  shopeeKey: process.env.GOODBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
  shopeeUrlEnv: process.env.GOODBKP_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
  shopeeLoja: process.env.GOODBKP_SHOPEE_SYNC_LOJA || 'good',
  adminKey: process.env.ADMIN_KEY || '',
  porta: process.env.PORT || 3000,
  fetch,
  log: console.log,
});
/* referência preguiçosa (como na AMB): resolverProdutoPorSku é const de outra lib e esta linha pode rodar antes dela */
/* 24/10: + o LEITOR do banco do frete real da Magalu por SKU (o mesmo arquivo que a venda do dia grava) — o backfill da
   GOOD usa pra prever o frete quando o Bling não traz (antes ia zerado e a margem da Magalu saía inflada) */
const { magaluFreteProvisorio, magaluFreteSkuGravar, magaluFreteSkuLer, magaluFretePrevistoSku } = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR, readJson, writeJson, blingGet, resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a),
});
let _vendasDiaGood = null;
async function vendasSync() {
  /* 19/10 (Fase 3): a configuração desta empresa (envs, loja Shopee, Magalu, TikTok, token do ML) vem da peça única
     lib/checkout/config-empresa — aqui só as peças do módulo (deps) */
  if (!_vendasDiaGood) _vendasDiaGood = require('../lib/checkout/vendas-dia').criarVendasSyncDaEmpresa('good', {
    deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet, buscarDevolucoesML, json, magaluFreteProvisorio, magaluFreteSkuGravar, nfDoPedido, path, pescarDadosML, readJson, writeJson }),
    fetch,
  });
  return _vendasDiaGood();
}

// ─── VENDAS CANCELADAS (19/10) — o MESMO ligador das três empresas (lib/checkout/cancelados-empresa) ────────────────
/* A GOOD não varria cancelados: venda cancelada depois de entrar seguia contando como faturamento, imposto e margem no
   painel. Agora usa o mesmo ligador da AMB e da Girassol (contexto pela configuração única; Shopee pela loja dela;
   gravação do arquivo do dia só com as marcas; espelho nos finalizados). Aqui só as peças do módulo da GOOD. */
const _cancGood = require('../lib/checkout/cancelados-empresa').criarCanceladosDaEmpresa('good', {
  deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson, blingGet, garantirToken, path, fetch,
    /* as situações de cancelamento DA GOOD (cache por empresa desde o #686 — o mesmo do histórico diário; 15/11: na peça) */
    garantirSitCancel: (bg) => require('../lib/checkout/situacoes-cancelamento').garantirSitCancel(bg, 'good'),
    supaCfg: (e) => require('../lib/supabase').para('good').cfg(e),
    DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD, histCache: _histCacheGood }),
});
const varrerCancelados = (dias) => _cancGood.varrerCancelados(dias);
const estadoCancelados = () => _cancGood.estadoCancelados();

// ─── FATURAMENTO DO ML + CRÉDITOS DO FLEX (19/10) — a MESMA peça da AMB e da Girassol (lib/checkout/ml-billing) ─────
/* A GOOD não tinha nenhum dos dois: a seção "Financeiro ML" do painel ficava vazia (tarifas de anúncio, Full,
   devoluções — o que fica fora do pedido) e a margem aparecia maior do que é. Aqui só as peças do módulo da GOOD. */
const _mlBillingGood = require('../lib/checkout/ml-billing').criarMlBillingDaEmpresa('good', {
  deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, readJson, writeJson, fetch, path,
    supaReq: (e, m, p, b) => require('../lib/supabase').para('good').req(e, m, p, b) }),
});
const mlBillingSync = (...a) => _mlBillingGood.mlBillingSync(...a);
const aplicarCreditosFlex = (...a) => _mlBillingGood.aplicarCreditosFlex(...a);

// ─── SHOPEE (27/10) — a MESMA peça da Girassol e da AMB (lib/checkout/shopee-empresa) ─────────────────────────────
/* A GOOD não tinha o módulo da Shopee: sem o resumo no painel (repasse, devoluções, carteira, Ads, conciliação) e sem as
   coletas da madrugada. Só a API da Shopee, pelo serviço multi-loja (/good) — nada de cota do Bling. Desde 27/10 (passo
   3) o backfill da GOOD também usa o repasse REAL (escrow) daqui. */
const { rotasShopee: rotasShopeeGood, coletarDevolucoes: coletarDevolucoesShopeeGood, coletarCarteira: coletarCarteiraShopeeGood,
        pedirAoSync: pedirAoSyncShopeeGood, escrowEmLote: escrowEmLoteShopeeGood, escrowDoPedido: escrowDoPedidoShopeeGood } = require('./good-shopee');
const coletarAdsShopeeGood = (dias) => require('../lib/shopee-ads').coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync: pedirAoSyncShopeeGood }, dias);


// ─── MADRUGADA ÚNICA (27/10) — a MESMA rotina da Girassol e da AMB (lib/checkout/noturna-empresa) ───────────────
/* Antes a GOOD tinha tarefas soltas na subida do servidor (uma por PR); agora as mesmas etapas das outras, na mesma ordem,
   ligadas conforme o que ela tem. Sem o módulo da Shopee (devoluções, carteira, Ads), sem o resgate do histórico (vai com
   a unificação do backfill) e sem a poda do bucket (é o mesmo bucket, as outras podam): essas etapas não aparecem. O
   backfill dos últimos dias é a rotina diária da GOOD (respeita GOOD_DIARIO_HISTORICO=0 e as travas dela). */
function _backfillGoodOcupado() {
  let gOc = false;
  try { gOc = !!require('../lib/checkout/backfill-estado').ocupado('good'); } catch (e) {}   /* 29/10 (3a): o DA GOOD; 15/11: pela peça */
  return !!((_bfGood && _bfGood.estado === 'rodando') || (_diarioGood && _diarioGood.estado === 'rodando') || gOc);
}
const _noturnaGood = require('../lib/checkout/noturna-empresa').criarNoturna({
  empresa: 'good', prefixo: '/good-checkout-offline',
  /* 14/11: a foto diária da reputação do Mercado Livre (lib/checkout/reputacao-ml) precisa do token do ML DESTA empresa */
  garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
  /* 15/11: a foto diária da saúde da conta na Shopee (lib/checkout/saude-shopee) precisa do pedido à Shopee DESTA empresa */
  pedirAoSync: (...a) => pedirAoSyncShopeeGood(...a),
  mlBillingSync: (...a) => mlBillingSync(...a),
  backfillVendas: async () => {
    const r = await rodarDiarioHistoricoGood('noturna');
    if (r && r.estado === 'desligado') return { ok: false, msg: 'GOOD_DIARIO_HISTORICO=0 (a rotina diária do histórico está desligada)' };
    /* a rotina devolve estado 'ok' ou 'parou' (com `motivo`), nunca 'erro' e sem `ok`: só 'ok' vale como feito */
    if (!r || r.estado !== 'ok') return Object.assign({}, r || {}, { ok: false, msg: (r && (r.motivo || r.msg)) || ('rotina diária terminou como "' + ((r && r.estado) || 'sem resposta') + '"') });
    return Object.assign({}, r, { ok: true });
  },
  backfillEstado: () => {
    return { rodando: _backfillGoodOcupado(), de: (_bfGood && _bfGood.de) || null, ate: (_bfGood && _bfGood.ate) || null };
  },
  mlSyncFees: (...a) => mlSyncFees(...a),
  varrerCancelados: (dias) => varrerCancelados(dias),
  coletarFinanceiroTikTok: (...a) => coletarFinanceiroTikTokGood(...a),
  /* a correção da tarifa PATCHa linhas do histórico pelo id, e o backfill as substitui: com qualquer backfill da GOOD
     rodando (mês, plano do ano, rotina diária ou a vaga compartilhada) a etapa acusa em vez de correr por cima dele */
  completarTarifaTikTok: async (...a) => {
    if (_backfillGoodOcupado()) return { ok: false, erro: 'backfill da GOOD em curso — a correção da tarifa fica pra próxima madrugada' };
    return completarTarifaTikTokGood(...a);
  },
  conferirMarketplaces: (dias) => _canGood.conferir(dias, [], {}),
  consertarDoCanario: (r) => _canGood.consertar(r),
  canarioCron: () => canarioCronIntegracoes({ VERSAO, validarSessao }),
  /* 27/10: a Shopee da GOOD — as mesmas etapas da AMB (devoluções 45 dias, carteira 30, Ads 35) */
  coletarDevolucoes: (d) => coletarDevolucoesShopeeGood(d || 45, pedirAoSyncShopeeGood),
  coletarCarteira: (d) => coletarCarteiraShopeeGood(d || 30, pedirAoSyncShopeeGood),
  coletarAds: (d) => coletarAdsShopeeGood(d),
  /* 27/10: os dias da Shopee sem repasse — o backfill de UM dia da GOOD, com o estado e a trava dela (como a fatia do plano) */
  cacheDir: CACHE_DIR,
  backfillDia: async (dia) => {
    if (_backfillGoodOcupado()) return { ok: false, msg: 'backfill da GOOD em curso' };
    _bfGood = { estado: 'rodando', de: dia, ate: dia, pelo: 'repasse da Shopee pendente', iniciado: new Date().toISOString() };
    let x;
    try { x = await require('../lib/checkout/contexto-fundo').emFundo('good', () => require('../lib/checkout/backfill-rodar').backfillVendas(dia, dia, 'good', _ctxBackfillGood())); }
    catch (e) { _bfGood = { estado: 'parou', de: dia, ate: dia, motivo: String(e.message || e) }; throw e; }
    _bfGood = { estado: (x && x.ok !== false && x.desfecho !== 'com_erros') ? 'ok' : 'parou', de: dia, ate: dia, desfecho: x && x.desfecho, pelo: 'repasse da Shopee pendente' };
    return x;
  },
  VERSAO, validarSessao, ehAdmin, json,
});

// ─── CANÁRIO DAS INTEGRAÇÕES (26/10) — a MESMA peça da Girassol e da AMB (lib/checkout/canario-integracoes) ─────────
/* O Bling e o ML ainda respondem o que usamos? o faturamento e a venda do dia estão frescos? o disco? o serviço da Shopee
   atende a GOOD com a chave dela? A GOOD não tinha nenhuma dessas conferências. */
const { rotasCanario: rotasCanarioIntegracoes, canarioCron: canarioCronIntegracoes } = require('./good-canario');

// ─── TIKTOK (24/10): a GOOD ganha o que a Girassol e a AMB já tinham — as MESMAS peças, com a chave 'good' ────────
/* O TikTok da GOOD está conectado desde 20/08 e o backfill dela já lia o financeiro (_tiktok_financeiro_good.json), mas
   ninguém COLETAVA esse arquivo toda noite pra ela, nem CORRIGIA a tarifa das vendas que liquidam depois — sem isso a
   venda nova do TikTok entrava com a tarifa que o Bling mostra (menor que a real). */
const coletarFinanceiroTikTokGood = require('../lib/tiktok-financeiro').criarColetorDaEmpresa('good', {
  carregarTikTok: () => require('../tiktok-oauth'),
  fs: require('fs'), path: require('path'),
});
const completarTarifaTikTokGood = require('../lib/tiktok-completar').criarCompletadorDaEmpresa('good', {
  supaReq: (e, m, q, b2) => require('../lib/supabase').para('good').req(e, m, q, b2),
  aoAtualizar: () => { for (const k of Object.keys(_histCacheGood)) delete _histCacheGood[k]; },
});

// ─── CANÁRIO MARKETPLACE × BLING (23/10) — a MESMA peça da Girassol e da AMB (lib/checkout/canario-empresa) ─────────
/* A GOOD não tinha canário: venda do marketplace que não chegava ao Bling (integração caída) só aparecia quando alguém
   notava a falta. Agora: a conferência diária (3 dias, fora do galpão), o conserto (sem importador do ML aqui: só
   avisa) e a faixa no painel pro admin (/canario-estado).
   01/11 (auditoria do Codex, achado F09): a Shopee ficava DE FORA ("sem módulo da Shopee na GOOD") -- mas a GOOD ganhou a
   peça da Shopee em 27/10 (good-shopee, a mesma da Girassol e da AMB) e o canário continuou com pedirAoSync: null. Agora
   ele confere a Shopee da GOOD como confere a das outras duas: venda da Shopee que não chegou ao Bling passa a ser vista. */
const _packsMLGood = require('../lib/checkout/packs-ml').criar({ MLB_FILE: (...a) => MLB_FILE(...a), readJson });
const _canGood = require('../lib/checkout/canario-empresa').criarCanarioDaEmpresa('good', {
  deps: () => ({ blingGet, LOJA_MKT, irmasDoPack: _packsMLGood._irmasDoPack, CACHE_DIR, pedirAoSync: pedirAoSyncShopeeGood, fetch }),
  /* o backfill DA GOOD (o do período, o do plano do ano e a vaga compartilhada): o canário espera */
  ocupado: () => {
    let gOc = false;
    try { gOc = !!require('../lib/checkout/backfill-estado').ocupado('good'); } catch (e) {}   /* 29/10 (3a): o DA GOOD; 15/11: pela peça */
    const r = !!((_bfGood && _bfGood.estado === 'rodando') || (_diarioGood && _diarioGood.estado === 'rodando') || gOc);
    return { rodando: r, de: _bfGood && _bfGood.de, ate: _bfGood && _bfGood.ate, do_ano: !!(_bfGood && _bfGood.pelo_plano) };   /* 15/11: "do ano" = a fatia em curso veio do plano */
  },
});

/* 16/11 (norte C, montarCheckout passo 7): o RELÓGIO da GOOD é o agendador das outras duas (lib/checkout/agendador) — ela
   agendava à mão o mesmo relógio (venda do dia, cancelados, faturamento do ML, pesca das tarifas, custo pós-boot, ciclo
   extra de etiqueta, ciclo de boot, o plano do ano e a preparação sozinha). Nivelada por cima: ganha a manutenção do custo
   de 6 em 6 h, e o custo diário passa a ser o do relógio (23h30 em diante e a recuperação até as 6h, como as outras — eram
   dois crons do orquestrador, 23h30/23h45 e de 20 em 20 min na madrugada). O texto do bootstrap à mão está em
   docs/HISTORICO-AGENDADOR-GOOD.md. */
const bootstrap = require('../lib/checkout/agendador').criarAgendador({
  empresa: 'good',
  minutoCustoDiario: 30,   /* 23h00 a AMB, 23h15 a Girassol, 23h30 a GOOD — não disputam a trava pesada */
  plano: _planoGood,
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
    console.log(`[GOODBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  },
});

// ═══ PESCA POSTERIOR (ML): busca tarifa REAL (sale_fee) e frete do vendedor nos pedidos ML
// recentes e grava no conferido (tarifa_ml / frete_ml). Roda no cron diário e sob demanda.
// Re-checa os finalizados dos últimos 3 dias mesmo se já têm tarifa (o ML pode ajustar depois).
/* 13/11 (plano multiloja, Fase 3 item 5): a pesca das tarifas do ML da GOOD passa a ser a PEÇA ÚNICA
   (lib/checkout/ml-sync-fees.js), a mesma da Girassol e da AMB — saem daqui as 98 linhas da cópia. A cópia era a mesma
   rotina numa versão mais antiga (91 das 97 linhas de código dela existem na peça); entrar na peça é GANHAR o que as outras
   já tinham: os custos novos do ML por envio (o frete do vendedor vindo de /shipments/{id}/costs em vez da conta
   list_cost − cost), a logística do envio (Flex inclusive), o pedido e o pacote do ML gravados no conferido, e o marcador
   de versão (`ml_costs_v3`) que permite repescar tudo quando a regra mudar.
   `versaoCustos: 2` = a lógica atual, a mesma marca da Girassol. Como nenhum conferido da GOOD tem a marca ainda, a 1ª
   rodada depois do deploy repesca os pedidos ML dos últimos 14 dias (só chamadas ao Mercado Livre — nada de Bling). */
const _mlSyncFeesPeca = require('../lib/checkout/ml-sync-fees').criar({
  empresa: 'good',
  versaoCustos: 2,
  garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
  get _mls() { return _mls; },
  set _mls(v) { _mls = v; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get readJson() { return readJson; },
  get writeJson() { return writeJson; },
});
async function mlSyncFees(dias) { return _mlSyncFeesPeca(dias); }

module.exports = {
  id: 'good-checkout-offline',
  nome: 'GOOD Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14),   /* 27/10: 14 dias às 04h40, como a Girassol e a AMB — os 60 dias são da madrugada */ shopeeKeepAlive: () => shopeeKeepAlive(),
             noturna: () => _noturnaGood.rotinaNoturna('cron'),
             cacaMagalu: () => _cacaMgGood.cacaMagaluCron(),   /* 29/10: a caça de vendas da Magalu (era só da AMB) */
             cacaMagaluProvisorios: () => _cacaMgGood.cacaMagaluProvisorios() },   /* 16/11 (P1-4): de madrugada, refaz as linhas da Magalu com comissão/frete estimados ou ausentes quando o financeiro chegou */   /* 27/10: a madrugada única (o backfill dos últimos dias é a rotina diária, dentro dela) */
             /* 16/11 (montarCheckout, passo 7): o custo diário saiu daqui — é o relógio do agendador (23h30 + recuperação até as 6h), como nas outras duas */
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', noturna: '0 4 * * *', cacaMagalu: '45 * * * *' /* 29/10: a caça da Magalu de hora em hora */, cacaMagaluProvisorios: '10 3 * * *', shopeeKeepAlive: '25 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */ },
  bootstrap
};
