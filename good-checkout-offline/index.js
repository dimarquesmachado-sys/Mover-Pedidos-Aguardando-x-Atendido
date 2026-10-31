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
let _rotasPainelGood = async () => false;   /* montado na 1ª requisição (ver abaixo) */
let _rotasPainelMontado = false;
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
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESGATES_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;

/* pedidos sendo reabertos AGORA nesta empresa — trava contra duplo clique e contra duas pessoas
   na mesma tela, já que o caminho tem `await` no Bling. Estado do MÓDULO, não `global`: as três
   empresas rodam no MESMO processo e o `teste-estado-sem-global` proíbe a classe inteira — a
   empresa nova que copiasse o bloco herdaria a chave e travaria o pedido da outra. */
const _reabrindo = new Set();

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

/* 01/10 — O ANO INTEIRO, SOZINHO. O dono: "não dá pra fazer aquele esquema de ir sozinho, mês
   a mês, e se der problema, parar... pra eu não ter q ficar fazendo isso um por um?".
   A AMB e a Girassol já tinham isto (`/backfill-ano`) desde agosto; a GOOD ficou pra trás —
   e é justamente a empresa com o histórico mais incompleto. Portado de lá, com as lições que
   aquele código já carrega:
     · PARA no primeiro mês que aborta ou é adiado, e guarda onde parou e o que falta. Seguir
       em frente deixaria um buraco no meio do ano e o fim diria "concluído";
     · o encerramento vai num `finally`: um erro no meio deixava a trava de pé PRA SEMPRE, e
       com ela presa nenhum backfill novo começava até reiniciar o serviço;
     · respiro entre os meses, porque a cota do Bling é da conta inteira. */
const ULTIMO_DIA_GOOD = { '01':'31','02':'28','03':'31','04':'30','05':'31','06':'30',
                          '07':'31','08':'31','09':'30','10':'31','11':'30','12':'31' };
let _bfGoodAno = { rodando: false };

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
const _motorPlanoGood = _fatGood.criarMotor({
  cacheDir: CACHE_DIR,
  pausaMs: Number(process.env.GOOD_PLANO_PAUSA_MS || 20000),   /* respiro entre fatias (20 s) */
  /* Codex #696 r2: a fatia em curso aparece no _bfGood (como no runner antigo) — senão a rota manual
     do período passava pela guarda dela e respondia 202 pra um pedido que a trava recusaria */
  rodarFatia: async ({ de, ate }) => {
    _bfGood = { estado: 'rodando', de, ate, pelo_plano: true, iniciado: new Date().toISOString() };
    let x;
    try { x = await require('../lib/checkout/contexto-fundo').emFundo('good',
            () => require('../girassol-backup-offline/gbo-app').backfillVendas(de, ate, 'good', _ctxBackfillGood())); }
    catch (e) { _bfGood = { estado: 'parou', de, ate, pelo_plano: true, motivo: String(e.message || e) }; throw e; }
    _bfGood = { estado: (x && x.ok !== false && x.desfecho !== 'com_erros') ? 'ok' : 'parou', de, ate, pelo_plano: true, desfecho: x && x.desfecho, erros: x && x.erros, motivo: x ? (x.msg || x.adiado || null) : 'sem resposta' };
    return x;
  },
  ocupado: () => {
    try { const g = require('../girassol-backup-offline/gbo-app');
      /* Codex #696 r4: a trava COMPLETA (inclui a rodada do ano da Girassol entre um mês e outro, canário e reparo) */
      return !!(_bfGoodAno.rodando || (_bfGood && _bfGood.estado === 'rodando') || _canGood.estado.rodando ||   /* 23/10: e o canário da GOOD */
        /* 29/10 (3a): o andamento do backfill é POR EMPRESA — a GOOD olha o DELA (antes dividia com a Girassol e esperava a dela) */
        (typeof g.backfillOcupado === 'function' ? g.backfillOcupado('good') : (typeof g.backfillEstado === 'function' && (g.backfillEstado('good') || {}).rodando))); }
    catch (e) { return true; }
  },
  /* Codex #696: a janela tem fronteira em 18h05 (não 18h00) — mesma regra pra quem acorda no boot */
  podeRodarAgora: () => require('../lib/checkout/contexto-fundo').janelaRotinaPesada(),
});

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
    const gbo = require('../girassol-backup-offline/gbo-app');
    const ctx = _ctxBackfillGood();
    const resg = require('../lib/checkout/backfill-resgate');
    const r = await require('../lib/checkout/diario-historico').rodarDiario({
      empresa: 'good',
      /* o backfill do dia aparece no mesmo status do mensal (e segura as rotas do mês/ano) */
      backfillVendas: async (de, ate, emp) => {
        _bfGood = { estado: 'rodando', de, ate, marca: Date.now().toString(36), iniciado: new Date().toISOString(), pelo_diario: true };
        let x;
        try { x = await gbo.backfillVendas(de, ate, emp, ctx); }
        catch (e) { _bfGood = { estado: 'parou', de, ate, pelo_diario: true, motivo: String(e.message || e) }; throw e; }
        _bfGood = { estado: (x && x.ok !== false) ? 'ok' : 'parou', de, ate, pelo_diario: true,
                    desfecho: x && x.desfecho, motivo: x ? (x.msg || x.adiado || null) : 'sem resposta' };
        return x;
      },
      ocupado: () => !!(_bfGoodAno.rodando || (_bfGood && _bfGood.estado === 'rodando') || _canGood.estado.rodando ||
                        (typeof gbo.backfillOcupado === 'function' ? gbo.backfillOcupado('good')   /* 29/10 (3a): o andamento DA GOOD */
                          : (typeof gbo.backfillEstado === 'function' && (gbo.backfillEstado('good') || {}).rodando))),
      resgatar: (plano) => resg.resgatar({
        empresa: 'good', blingGet, supaReq: ctx.supaReq,
        backfillVendas: (d1, d2) => gbo.backfillVendas(d1, d2, 'good', ctx),
        backfillEstado: () => gbo.backfillEstado('good'),   /* 29/10 (3a): a vaga e o andamento DA GOOD */
        reservar: (m) => gbo.reservarVagaBackfill(m, 'good'), liberar: () => gbo.liberarVagaBackfill('good'),
        /* situações de cancelamento DA GOOD (cache por empresa desde o #686) e o tombstone dela */
        situacoesCanceladas: async () => ((await gbo.garantirSitCancel(async p2 => await blingGet(p2), 'good')) || {}).ids || [],
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
/* 15 min entre tentativas do MESMO mês: os dois motivos de parada (6 falhas seguidas do Bling,
   e adiamento pelo canário) pedem tempo, não insistência. Repetir rápido foi o que derrubou o
   serviço antes. Env pra poder encurtar em teste. */
/* Codex #548: env não numérica ("15m"), negativa ou enorme virava NaN/timer imediato — NaN
   estourava `RangeError` no toISOString e deixava a trava presa. Só vale número finito, >= 0 e
   até 1h; qualquer outra coisa cai no padrão. */
const _espEnv = Number(process.env.GOOD_ANO_ESPERA_MS);
const ESPERA_RETOMA_MS = (process.env.GOOD_ANO_ESPERA_MS && isFinite(_espEnv) && _espEnv >= 0 && _espEnv <= 3600000)
  ? _espEnv : 15 * 60 * 1000;

const MAX_ESPERAS_TRAVA = 16;

/* 01/10 — O PROGRESSO DENTRO DO MÊS. O dono ficou olhando o status repetir o mesmo texto por
   15-20 min sem saber se andava ou tinha travado: o `_bfGood` é uma FOTO tirada ao começar, e
   não se mexe mais até o mês acabar. O gbo já mantém o estado vivo (página, pedidos, gravados,
   fase) e o exporta em `backfillEstado()` — faltava só mostrar.
   Só entra enquanto está rodando, e só se for DESTE backfill: o gbo é compartilhado com a
   Girassol, e exibir o progresso dela aqui seria pior que não mostrar nada. */
function _bfStatusComProgresso(base) {
  const fora = (_bfGoodAno && (_bfGoodAno.rodando || _bfGoodAno.fim)) ? Object.assign({}, base, { ano: _bfGoodAno }) : base;
  if (base.estado !== 'rodando') return fora;
  try {
    const viv = require('../girassol-backup-offline/gbo-app').backfillEstado('good');   /* 29/10 (3a): o andamento DA GOOD */
    if (!viv || !viv.rodando || viv.empresa !== 'good' || viv.de !== base.de) return fora;
    return Object.assign({}, fora, { progresso: {
      fase: viv.fase, pagina: viv.pagina, pedidos: viv.pedidos,
      gravados: viv.gravados, erros: viv.erros, msg: viv.msg || undefined } });
  } catch (e) { return fora; }   /* diagnóstico nunca derruba o status */
}

async function backfillAnoGood(ateMes, ano, ctxGood, gbo) {
  if (_bfGoodAno.rodando || (_bfGood && _bfGood.estado === 'rodando')) return;
  _bfGoodAno = { rodando: true, mesAtual: null, feitos: [], inicio: new Date().toISOString(), fim: null };
  const meses = Object.keys(ULTIMO_DIA_GOOD).filter(m => m <= ateMes);
  /* fila em vez de `for..of`: a retentativa precisa DEVOLVER o mês pro começo sem perder os
     seguintes, e isso não dá pra fazer iterando o array direto */
  const fila = meses.slice();
  try {
    while (fila.length) {
      const m = fila.shift();
      _bfGoodAno.mesAtual = ano + '-' + m;
      _bfGood = { estado: 'rodando', de: ano+'-'+m+'-01', ate: ano+'-'+m+'-'+ULTIMO_DIA_GOOD[m],
                  marca: Date.now().toString(36), iniciado: new Date().toISOString(), pelo_ano: true };
      const r = await gbo.backfillVendas(ano+'-'+m+'-01', ano+'-'+m+'-'+ULTIMO_DIA_GOOD[m], 'good', ctxGood);
      const d = r || {};
      /* abortado e erro PARAM o ano: seguir em frente deixaria o mês pela metade e o fim
         diria "concluído". O adiamento também para — é o canário ou o reparo de SKU usando
         a cota, e insistir por cima é o que derrubou o serviço antes. */
      if (d.desfecho === 'abortado' || d.desfecho === 'erro' || d.adiado || d.desfecho === 'adiado' || d.desfecho === 'ja_rodando') {
        const motivo = d.msg || d.adiado || ('mês ' + m + ' ' + (d.desfecho || 'adiado'));
        /* Codex #548: SÓ o que melhora com o tempo merece espera e nova tentativa — adiamento
           (canário/reparo de SKU), `ja_rodando` (outro backfill, ex.: o da Girassol às 03:30,
           pegou a trava compartilhada enquanto esperávamos; sem isto o mês era dado como feito
           sem ter rodado) e o aborto marcado `transitorio` (Bling limitado/instável). Aborto de
           segurança (<60% do guardado, spool inválido, disco cheio) e erro inesperado são
           determinísticos: repetir só refaz a varredura cara e queima a cota da conta. */
        const retentavel = !!(d.adiado || d.desfecho === 'adiado' || d.desfecho === 'ja_rodando' || d.transitorio);
        /* 01/10 — ESPERA E TENTA DE NOVO, em vez de só parar. O dono pediu "parar, esperar e
           reiniciar sozinho", e a primeira versão só parava: ele teria que descobrir pelo
           status e disparar de novo, mês por mês — exatamente o trabalho manual que ele queria
           tirar.
           A espera é longa de propósito (15 min) porque os dois motivos de parada pedem tempo,
           não insistência: 6 falhas seguidas do Bling é cota ou instabilidade, e adiamento é o
           canário usando a mesma cota. Repetir rápido é o que derrubou o serviço antes.
           DUAS tentativas e desiste: se o terceiro ataque ao mesmo mês falhar, o problema não
           é passageiro, e ficar tentando a noite toda queima cota sem resolver. */
        /* Codex #548: `ja_rodando` não é falha DO MÊS — a GOOD nem chegou a rodar, quem segura a
           trava compartilhada é outro backfill (o mensal da Girassol leva ~2,5h). Por isso tem
           orçamento próprio de espera (16 × 15 min = 4h) e NÃO gasta as 2 retentativas do mês. */
        if (d.desfecho === 'ja_rodando' && (_bfGoodAno.esperasTrava || 0) < MAX_ESPERAS_TRAVA) {
          _bfGoodAno.esperasTrava = (_bfGoodAno.esperasTrava || 0) + 1;
          _bfGoodAno.esperando = { mes: ano + '-' + m, motivo, trava: _bfGoodAno.esperasTrava,
                                   retoma_em: new Date(Date.now() + ESPERA_RETOMA_MS).toISOString() };
          console.log('[BACKFILL-ANO-GOOD] ' + ano + '-' + m + ' — trava ocupada por outro backfill, espera 15 min (' + _bfGoodAno.esperasTrava + '/' + MAX_ESPERAS_TRAVA + ')');
          await new Promise(ok => setTimeout(ok, ESPERA_RETOMA_MS));
          delete _bfGoodAno.esperando;
          fila.unshift(m);
          continue;
        }
        const jaTentou = (_bfGoodAno.tentativas && _bfGoodAno.tentativas[m]) || 0;
        if (retentavel && jaTentou < 2) {
          _bfGoodAno.tentativas = Object.assign({}, _bfGoodAno.tentativas, { [m]: jaTentou + 1 });
          _bfGoodAno.esperando = { mes: ano + '-' + m, motivo, tentativa: jaTentou + 1,
                                   retoma_em: new Date(Date.now() + ESPERA_RETOMA_MS).toISOString() };
          console.log('[BACKFILL-ANO-GOOD] ' + ano + '-' + m + ' falhou (' + motivo + ') — espera 15 min e tenta de novo (' + (jaTentou + 1) + '/2)');
          await new Promise(ok => setTimeout(ok, ESPERA_RETOMA_MS));
          delete _bfGoodAno.esperando;
          fila.unshift(m);   /* volta pro mesmo mês, sem perder os seguintes */
          continue;
        }
        _bfGoodAno.parou_em = ano + '-' + m;
        _bfGoodAno.motivo = retentavel ? motivo + ' (desisti depois de 3 tentativas)'
                                       : motivo + ' (falha que esperar não resolve — não retentei)';
        _bfGoodAno.faltam = [m].concat(fila);
        _bfGood = { estado: 'parou', de: ano+'-'+m+'-01', motivo: _bfGoodAno.motivo };
        console.log('[BACKFILL-ANO-GOOD] parou de vez em ' + ano + '-' + m + ': ' + motivo);
        break;
      }
      _bfGoodAno.feitos.push({ mes: ano + '-' + m, desfecho: d.desfecho || 'ok',
                               pedidos: d.pedidos, gravados: d.gravados, erros: d.erros });
      _bfGood = { estado: 'ok', de: ano+'-'+m+'-01', pelo_ano: true };
      await new Promise(ok => setTimeout(ok, 2500));   // respiro: a cota é da conta
    }
  } catch (e) {
    _bfGoodAno.motivo = String(e.message || e);
    /* exceção também solta a trava do mês: `_bfGood.estado` ficava 'rodando' e bloqueava
       as rotas do ano e do mês até reiniciar o serviço */
    _bfGood = { estado: 'parou', motivo: _bfGoodAno.motivo };
  } finally {
    /* o `finally` é o ponto: sem ele, um erro deixava a trava presa e nenhum backfill novo
       começava até o serviço reiniciar */
    _bfGoodAno.rodando = false; _bfGoodAno.mesAtual = null; _bfGoodAno.fim = new Date().toISOString();
  }
}
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
const SHOPEE_SESSAO_FILE = path.join(CACHE_DIR, '_shopee-sessao.json');

function _shopeeHash(s) {
  try { return require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
  catch (e) { return 'len' + String(s).length; }
}

function shopeeSessaoLer() {
  const env  = String(process.env[SHOPEE_ENV_COOKIE] || '').trim();
  const j    = readJson(SHOPEE_SESSAO_FILE, null) || {};
  const envH = env ? _shopeeHash(env) : '';
  if (env && j.semente !== envH) {          // semente nova na env → ela manda
    const novo = { cookie: env, semente: envH, origem: 'env', atualizado: new Date().toISOString(), renovacoes: 0 };
    try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
    return novo;
  }
  if (j.cookie) return j;
  if (env) return { cookie: env, semente: envH, origem: 'env', atualizado: null, renovacoes: 0 };
  return { cookie: '', origem: 'nenhum', renovacoes: 0 };
}

// Pega o set-cookie da resposta e funde no jar. Devolve null se nada mudou.
function shopeeSessaoAtualiza(resp) {
  let lista = [];
  try { if (resp && resp.headers && typeof resp.headers.getSetCookie === 'function') lista = resp.headers.getSetCookie() || []; } catch (e) {}
  if (!lista.length) { try { const s = resp && resp.headers && resp.headers.get('set-cookie'); if (s) lista = [s]; } catch (e) {} }
  if (!lista.length) return null;

  const atual = shopeeSessaoLer();
  if (!atual.cookie) return null;

  const mapa = new Map();
  String(atual.cookie).split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) mapa.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });

  let mudou = 0;
  lista.forEach(sc => {
    const par = String(sc).split(';')[0];
    const i = par.indexOf('=');
    if (i <= 0) return;
    const nome = par.slice(0, i).trim();
    const val  = par.slice(i + 1).trim();
    if (!nome) return;
    if (!val || val === 'deleted') { if (mapa.delete(nome)) mudou++; return; }
    if (mapa.get(nome) !== val) { mapa.set(nome, val); mudou++; }
  });
  if (!mudou) return null;

  const cookie = Array.from(mapa.entries()).map(([k, v]) => k + '=' + v).join('; ');
  const novo = { cookie, semente: atual.semente || '', origem: 'renovado', atualizado: new Date().toISOString(), renovacoes: (atual.renovacoes || 0) + 1 };
  try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
  return { mudou, renovacoes: novo.renovacoes };
}

const SHOPEE_CAB = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://seller.shopee.com.br/portal/sale/order',
  'X-Api-Src-List': 'pc',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
};

function shopeeUrlBusca(cookie, termo) {
  const cds = (String(cookie).match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
  return 'https://seller.shopee.com.br/api/v3/order/get_order_list_search_bar_hint'
       + '?SPC_CDS=' + encodeURIComponent(cds)
       + '&SPC_CDS_VER=2&keyword=' + encodeURIComponent(termo)
       + '&category=1&order_list_tab=100&entity_type=1';
}

// Chamada barata só pra Shopee renovar os cookies. Roda no cron 2x ao dia.

// 20/08 (pedido do Diego: "quando vc fizer coisas pra acompanhar status, coloca o URL Completo.
// assim eu vejo na tela e já acompanho. do jeito q tá, não consigo saber o caminho"): quem dispara
// uma rotina longa recebe a mensagem "?status=1 p/ acompanhar" — e não tem como montar o caminho a
// partir dela. A resposta passa a trazer a URL inteira, pronta pra clicar.
function _urlStatus(req, caminho, extra, chave) {
  try {
    const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
    const base = host ? (proto + '://' + host) : '';
    /* 13/09 — A CHAVE NÃO VOLTA MAIS NA RESPOSTA. Uma versão anterior devolvia a chave
       recebida pra o link "funcionar no clique", e o efeito colateral apareceu na prática:
       a ADMIN_KEY passou a sair em toda resposta de disparo e foi parar em print, chat e
       log — o dono notou e teve razão. Conveniência de um clique não paga o vazamento de
       uma credencial que abre TODAS as rotas de admin. O link vai sem chave; quem abriu
       por sessão (cookie) clica e funciona, e quem usa chave acrescenta a sua.
       Codex (P1, PR#399): esta cópia local (GOOD nunca migrou pra lib/checkout/shopee-sessao.js)
       tinha ficado de fora do conserto — a chave voltava só aqui. */
    return base + caminho + '?status=1' + (extra || '');
  } catch (e) { return caminho + '?status=1'; }
}


/* ═══ 22/08 — CUSTO: agora vem de lib/custo.js (código único das 3 empresas) ═════════════
   A GOOD tinha 14 das 19 funções — faltava o DE-PARA inteiro (o "464" = "HC-464-220v" e o
   automático por produto_id). Não foi decisão: foi eu escrever 3× em 21/08 e esquecer dela.
   Ao passar pela lib, a GOOD GANHA essas 5 funções junto — não é só remover duplicata.
   `skuInfoCache` vai por getter porque a lib limpa o cache de 6h quando o custo muda. */
const _custoLib = require('../lib/custo');

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
    supaReq: (empresa, metodo, pq, body) => supa.req(empresa, metodo, pq, body),
    supaCount: (empresa, filtro) => supa.count(empresa, filtro),
    DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD,
    custoVigenteEm: (sku, data) => _custoLib.custoVigenteEm(_ctxCusto, sku, data),
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
/* 14/10 — vigência retroativa da madrugada, como na Girassol: quando o custo diário varre o dia de
   ONTEM (janela de recuperação), a mudança de custo achada vale a partir de ontem, não de hoje */
const _vigenciaDeRef = { valor: null };
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

async function shopeeKeepAlive() {
  const sess = shopeeSessaoLer();
  if (!sess.cookie) { console.log('[GOODBKP] shopee keep-alive: sem cookie (env ' + SHOPEE_ENV_COOKIE + ' vazia) — nada a fazer'); return { ok: false, motivo: 'sem cookie' }; }
  try {
    const r = await fetch(shopeeUrlBusca(sess.cookie, 'keepalive'), { headers: Object.assign({ 'Cookie': sess.cookie }, SHOPEE_CAB) });
    const t = await r.text();
    const ren = shopeeSessaoAtualiza(r);
    const vivo = (r.status === 200 && /"code"\s*:\s*0/.test(t));
    console.log('[GOODBKP] shopee keep-alive: HTTP ' + r.status + (vivo ? ' ✓ sessão viva' : ' ✗ sessão NÃO respondeu como logada') + (ren ? (' · ' + ren.mudou + ' cookie(s) renovado(s), total ' + ren.renovacoes) : ' · nada a renovar'));
    return { ok: vivo, status: r.status, renovou: ren ? ren.mudou : 0, corpo: t.slice(0, 300) };
  } catch (e) {
    console.log('[GOODBKP] shopee keep-alive falhou: ' + ((e && e.message) || e));
    return { ok: false, erro: String((e && e.message) || e).slice(0, 200) };
  }
}

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
  DEFAULT_ALIQ_BK: () => DEFAULT_ALIQ_BK_GOOD, magaluFreteSkuLer: () => magaluFreteSkuLer(), reparoAtivo: () => false,
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
    prefixo: '/good-checkout-offline', tag: 'GOODBKP', empresa: 'good',
    ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, ETIQ_FORMATO, MANIFEST_FILE, MLB_FILE, QZ_CERT, QZ_PRIVKEY, SESS_COOKIE, SESS_TTL, SHOPEE_ENV_COOKIE, SHOPEE_SESSAO_FILE, SYNC_ON, VERSAO, _diaAntes, _hojeISO, _shopeeHash, assinarSessao, backfillNFLocal, baixarDanfe, baixarXmlNF, bannerVolumeZpl, blingGet, carregarCatalogoDePara, cronDeveriaTerRodado, custoVigenteEm, dadosNFSimp, ehAdmin, ensureDir, enviarEmailDocs, etiquetaPdf, fetch, fundirEtiquetaComDanfe, gerarDanfeSimplificado, gerarDanfeSimplificadoZPL, getUltimoResumo, getUltimoSync, gravarVigencias, html, json, lerAdmins, lerChaveAdmin, lerCustosManuais, lerOperadores, lerReservas, lerVigencias, locCache, manifest, montarSeparacao, nfDoPedido, readBody, readJson, registrarCustoVigente, resolverNomeSku, rodarCiclo, salvarManifest, shopeeKeepAlive, shopeeSessaoAtualiza, shopeeSessaoLer, souAdmin, validarSessao, writeJson, zplParaPdf,
    mmEtiquetas: () => require('../good-mm-etiquetas'), mlTokenManager: () => require('../good/mlTokenManager'),
    cicloMod: () => require('./ciclo'), painelMarca: () => require('./painel-marca'), skuReparaNoHistorico: false,   /* a GOOD não tem o sku-repara no histórico */
    /* na GOOD o andamento da reaplicação do imposto vem da lib dela (era um const dentro do routes) */
    estadoImposto: () => require('../lib/imposto-cancelados').estadoReaplicarImposto('good'),
  });
  return _rotasComunsGood;
}

function routes(readBody) {
  /* criado DENTRO do routes porque o `readBody` chega como parâmetro dele — o lint pegou
     que eu tinha posto a criação no topo do arquivo, onde ele não existe. */
  const _rotasSeparacao = require('../lib/checkout/rotas-separacao').criar({
    prefixo: '/good-checkout-offline', tag: base.tag, json, readBody, readJson, writeJson, blingGet, blingWrite, lerReservas,
    locCache, localizacaoDeProduto, salvarLoc, montarSeparacao, montarSeparacaoPorPedido,
    RESERVAS_FILE, LOC_LOG_FILE,
  });
  const _rotasBackfill = require('../lib/checkout/rotas-backfill').criar({
    prefixo: '/good-checkout-offline', json, readJson, writeJson, ehAdmin, lerChaveAdmin,
    detalhePedido, backfillNFLocal,
    /* o `dorme` do corpo original era uma const LOCAL de outra função, não existia aqui —
       o lint pegou. O módulo tem `sleep`, que é a mesma coisa com outro nome. */
    dorme: sleep, CONFERIDOS_FILE,
    statusValores: _bf, statusDetalhes: _bfd,
  });
  /* 27/10 — CONTAGEM DE ESTOQUE: era só da Girassol (a tela); as rotas já eram a peça lib/checkout/rotas-contagem e
     a tela virou peça única — a GOOD ganha, com o depósito DELA (GOODBKP_DEPOSITO_GERAL; sem ele a entrada no Bling
     é RECUSADA em vez de chutar um depósito). */
  const _rotasContagem = require('../lib/checkout/rotas-contagem').criar({
    prefixo: '/good-checkout-offline', json, validarSessao, lerIndiceEan,
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
      pasta: 'good-checkout-offline',
      /* o depósito é POR EMPRESA. O da GOOD é 4956031259; o da Girassol ainda não foi
         levantado — a rota /contagem-depositos lista os ids pra preencher esta env.
         Sem ela, a entrada é RECUSADA em vez de chutar um depósito. */
      envDeposito: 'GOODBKP_DEPOSITO_GERAL',
    },
  });
  const _rotasNfAnexar = require('../lib/checkout/rotas-nf-anexar').criar({
    prefixo: '/good-checkout-offline', empresaId: 'good', json, readBody, readJson, writeJson, ensureDir, ehAdmin,
    lerChaveAdmin, mlSyncFees, shopeeKeepAlive, shopeeSessaoLer, CACHE_DIR, MANIFEST_FILE,
    SHOPEE_ENV_COOKIE, VERSAO, statusMlSync: _mls,
  });
  const _rotasConferido = require('../lib/checkout/rotas-conferido').criar({
    prefixo: '/good-checkout-offline', tag: base.tag, json, readBody, readJson, writeJson, lerReservas, moverSituacao,
    arquivarFinalizado, sincronizarConferidos, rodarCiclo, CONFERIDOS_FILE, RESERVAS_FILE,
    CACHE_DIR, SIT_VERIFICADO, SYNC_ON, VERSAO,
    fullJaDespachado,
    FULL_VAI_DESPACHADOS: !!require('./base').SIT_DESPACHADOS,   // so quando o ciclo MOVE o Full pra DESPACHADOS (#701); destino 0 = desligado, Full segue pro VERIFICADO (Codex #702)
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

  /* 15/09 — /api/contexto: identidade e capacidades desta empresa, pro painel se montar
     sozinho em vez de cada HTML saber de qual empresa ele é (base da Fase 4). Só identidade
     e capacidade: nada de credencial, caminho ou env — isto chega no navegador do galpão. */
  const _ctxApi = require('../lib/checkout/contexto-api').montar({
    empresa: 'good',
    modulo: 'good-checkout-offline',
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
    if (urlObj.pathname === '/good-checkout-offline/descobrir-ids') {
      const _k = lerChaveAdmin(req, urlObj);
      if (!process.env.ADMIN_KEY || _k !== process.env.ADMIN_KEY) { json(res, 403, { ok: false, erro: 'chave inválida' }); return true; }
      try {
        const d = require('../lib/checkout/descobrir-ids').criar({ rotulo: 'GOOD', blingGet , /* o token do ML vem do gerenciador fiscal DESTA empresa — o lint pegou que eu
       supus uma variável `garantirTokenML` solta que não existe aqui. */
      garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(), envNomes: {"atendido": "GOODBKP_SIT_ATENDIDO", "despachados": "GOODBKP_SIT_DESPACHADOS", "verificado": "GOODBKP_SIT_VERIFICADO", "aguardando": "GOOD_SITUACAO_AGUARDANDO", "meLojaIds": "GOOD_ME_LOJA_IDS"}, temExpedicao: require('../lib/empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade('good', 'expedicao') === true , /* 16/09 (P2 do Codex): o padrão do canal do ML foi REMOVIDO do código — declarar
           aqui faria a conferência dizer "não existe no Render, mas o padrão do código já é
           este valor, criar não muda nada", que hoje é o contrário da verdade: sem a env, o
           F1 e o F3 se recusam a rodar. Dizer que está tudo bem quando não está é o pior
           jeito de errar numa ferramenta de conferência. */
        padroesEnv: {"GOODBKP_SIT_ATENDIDO": "9", "GOODBKP_SIT_DESPACHADOS": "0", "GOODBKP_SIT_VERIFICADO": "24", "GOOD_SITUACAO_AGUARDANDO": "745122"}  });
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
      const _meu = p.startsWith('/good-checkout-offline'); // guarda só age nas rotas DESTE módulo
      const _pub = (
        p === '/good-checkout-offline' || p === '/good-checkout-offline/' ||
        p === '/good-checkout-offline/painel' ||
        /* Codex #582 (P2): o `<script src>` do navegador NÃO leva a querystring da página, então
           quem abre o painel por `?k=ADMIN_KEY` (sem cookie de login) tomava 401 aqui e a seção
           do Plano de Compra nem carregava. O script é só INTERFACE — não traz dado nenhum da
           empresa; os números vêm da rota `/plano-compra`, que segue exigindo sessão ou chave. */
        p === '/good-checkout-offline/js/plano-compra.js' ||
        p === '/good-checkout-offline/js/projecao-mes.js' ||
        p === '/good-checkout-offline/js/nf-local.js' ||
        p === '/good-checkout-offline/js/previsao-vendas.js' ||
        p === '/good-checkout-offline/js/ferramentas-custo.js' ||
        p === '/good-checkout-offline/js/devolucoes-ml.js' ||
        p === '/good-checkout-offline/js/manutencao.js' ||
        p === '/good-checkout-offline/js/ml-financeiro.js' ||
        p === '/good-checkout-offline/js/ficha-produto.js' ||
        p === '/good-checkout-offline/js/despesas-shopee.js' ||   /* 28/10: a seção da Shopee (a GOOD ganhou no #751) — script é só interface */
        p === '/good-checkout-offline/nf-travadas' ||   /* 04/09: leitura pro card de NFs travadas */ p === '/good-checkout-offline/login' ||
        p === '/good-checkout-offline/operadores' || p === '/good-checkout-offline/health' ||
        p === '/good-checkout-offline/saude' || p.includes('/callback') ||
        p === '/good-checkout-offline/qz-cert' || p === '/good-checkout-offline/qz-sign' ||
        p === '/good-checkout-offline/danfes-lote' ||
        p === '/good-checkout-offline/duplicatas' ||
        /* 30/08: o backfill tem guard PRÓPRIO por ADMIN_KEY (não é rota de operador), então
           passa pelo gate de sessão como as outras rotas administrativas. */
        p === '/good-checkout-offline/backfill-vendas' ||
        p === '/good-checkout-offline/backfill-status' ||
        p === '/good-checkout-offline/shopee-sessao-cookies' ||  // 27/08: auth própria por ADMIN_KEY (?k= ou X-Admin-Key) — mesma razão do danfes-lote  // Codex PR#41: auth própria na rota (302+admin) — o gate devolvia 401 JSON antes do redirect
        p === '/good-checkout-offline/custos-manuais' ||  // 21/08: idem — valida ADMIN_KEY por conta própria (igual custo-sync); sem isto o gate devolvia 401 antes de a rota rodar
        p === '/good-checkout-offline/custo-historico' ||  // 22/08: mesma coisa — nasceram AGORA, com a lib de custo
        p === '/good-checkout-offline/sku-depara-manual' ||
        p === '/good-checkout-offline/sku-depara'
      );
      const _central = (
        p.includes('/run') || p.includes('/setup') || p.includes('/robo') ||
        p.includes('/forcar') || /debug/i.test(p)
      );
      if (_meu && !_pub && !_central) {
        const _op = validarSessao(req.headers['cookie']);
        if (!_op) {
          // 14/09 (Codex, P2): mesma folga do AMB/Girassol — rotas como backfill-detalhes,
          // backfill-nf, ml-sync-fees, custo-sync e etiqueta-diag validam ADMIN_KEY por conta
          // própria, mas sem isto o gate matava a chamada com 401 antes de a rota avaliar a
          // chave (e chamada por header nunca chegava lá).
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
    if (!_rotasCancMkt) _rotasCancMkt = require('../lib/checkout/rotas-cancelados-mkt').criar({ prefixo: '/good-checkout-offline', empresa: 'good', tiktokConta: 'good',
      manifest, lerConferidos: () => readJson(CONFERIDOS_FILE, {}), json, validarSessao, ehAdmin });
    if (await _rotasCancMkt(req, res, urlObj, method)) return true;
    if (await _rotasContagem(req, res, urlObj, method)) return true;   /* 27/10: a contagem de estoque (a tela e as rotas) */
      /* mesma posição da de catálogo: DEPOIS do portão de sessão (Codex #480). */
      if (await _rotasSeparacao(req, res, urlObj, method)) return true;
      if (await _rotasBackfill(req, res, urlObj, method, validarSessao)) return true;
      if (await _rotasNfAnexar(req, res, urlObj, method, validarSessao)) return true;
      if (await _rotasConferido(req, res, urlObj, method, validarSessao)) return true;


    // ── IR PRO PEDIDO NA SHOPEE (b12) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env GOODBKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    /* 30/08 — BACKFILL DE VENDAS DA GOOD: é o que falta pra ela ter dashboard de margem.
       Reusa a função da Girassol (já testada em produção há meses) injetando o CONTEXTO da
       GOOD: o blingGet dela (token próprio), o cache dela e o supaReq dela. Sem o ctx, a
       função lia os pedidos da GIRASSOL e gravava rotulados como GOOD — o parâmetro empresa
       só mandava no rótulo. Nada aqui reimplementa o backfill. */
    /* 01/09 — CAÇA DUPLICATA: agosto da AMB fecha R$ 259 mil no Bling contra R$ 208 mil no
       Jodda e R$ 207 mil no nosso dashboard. Os dois independentes concordam, então a sobra
       está no Bling — provavelmente venda importada duas vezes. Esta rota procura, do sinal
       mais forte pro mais fraco: mesmo número de venda do marketplace (duplicata quase
       certa), mesmo cliente+valor+data, e mesmo cliente+valor em até 2 dias. */
    /* 04/09 — NFs TRAVADAS: o ML recusa por erro que só mão humana resolve (CEP que o Bling
       importou errado, documento inválido). A F3 parou de retransmitir; aqui o checkout
       mostra quais precisam de intervenção, com o que fazer em cada uma. */
    /* 02/10 — AS ROTAS COMPARTILHADAS, da fábrica (#568). O dono quer a GOOD igual à AMB e à
       Girassol, e o alvo é "embarcar novos CNPJs com o menos de dor possível": estas rotas
       eram IDÊNTICAS entre AMB e Girassol, então vêm de UM código só, com a empresa como
       parâmetro — em vez da terceira cópia.
       Entra ANTES das rotas próprias e devolve `true` quando tratou; `false` deixa seguir.
       As peças que a GOOD ainda não tem (`vendasSync`, `responderCusto`, o custo diário) não
       são fingidas: a rota recusa explicando, e passa a funcionar no dia em que existirem. */
    /* 02/10 — monta na PRIMEIRA chamada, não no topo nem no `bootstrap`. ⚠️ Descobri os dois
       no caminho: as peças são declaradas DEPOIS deste ponto no arquivo (o `custoSyncTravado`
       está ~2.800 linhas abaixo), então montar no topo passaria `undefined`; e o `bootstrap`
       desta pasta NÃO É CHAMADO por ninguém — não está no `module.exports`, é código morto, e
       a montagem lá dentro nunca aconteceria. O boot real provou: a linha de log não saiu.
       Aqui, na primeira requisição, tudo já existe. */
    if (!_rotasPainelMontado) {
      _rotasPainelMontado = true;
      try {
        _rotasPainelGood = require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({
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
            'custos-manuais',
            'magalu-cancelados',
            'custo-sync'
          ],   /* Codex #569: a GOOD tem custo-sync próprio (status rico) */
          nomeEmpresa: 'GOOD Import',      /* Codex #573: título da tela de custo manual — era o da AMB */
          /* ⚠️ `readBody` vem como PARÂMETRO de `routes(readBody)`, não é declarado no arquivo
             — o eslint acusou e eu só entendi ao ler a assinatura. Está no escopo aqui dentro. */
          pecas: { json, lerChaveAdmin, validarSessao, readJson, writeJson, CACHE_DIR,
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
                   supaCfg: (e) => require('../lib/supabase').para('good').cfg(e) },
        });
        console.log('[GOOD] rotas compartilhadas do painel montadas');
      } catch (e) {
        console.error('[GOOD] falha ao montar as rotas compartilhadas:', e.message);
        _rotasPainelGood = async () => false;   /* o painel segue servindo o que já tinha */
      }
    }
    /* 27/10: /pescar-tarifas, /pescar-tarifas-status e /auditoria-ml (só admin) — a pescaria retroativa de tarifas do ML
       da peça única (lib/checkout/pescaria-empresa; a GOOD não tinha). Criada na 1ª chamada: o pescarDadosML nasce mais
       abaixo neste arquivo. Supabase e histórico com a chave da GOOD. */
    if (!_pescaGood) _pescaGood = require('./good-pescaria').rotasPescaria({ validarSessao,
      supaCfg: (e) => require('../lib/supabase').cfg(e), supaReq: (e, m, pq, b) => require('../lib/supabase').para('good').req(e, m, pq, b), pescarDadosML });
    if (await _pescaGood(req, res, urlObj)) return true;
    /* 27/10: /shopee/* — o módulo da Shopee da peça única (status, resumo, devoluções, carteira, Ads, conciliação, tarifa por SKU) */
    if (await rotasShopeeGood({ validarSessao })(req, res, urlObj)) return true;
    /* 27/10: /noturna-status e /rodar-noturna (só admin) — a madrugada única */
    if (await _noturnaGood.rotas(req, res, urlObj)) return true;
    /* 26/10: /saude-integracoes (só admin) — o canário das integrações da peça única */
    if (await rotasCanarioIntegracoes({ VERSAO, validarSessao })(req, res, urlObj)) return true;
    if (await _rotasPainelGood(req, res, p, method, urlObj)) return true;

    /* 31/10 — as ROTAS COMUNS (as que as três empresas tinham escritas iguais aqui: arquivos, DANFE, etiqueta, XML,
       impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML, cookies da Shopee, separação) viraram
       a peça única lib/checkout/rotas-comuns, chamada no lugar da primeira delas */
    if (await _rotasComuns(readBody).handle(req, res, p, method, urlObj)) return true;


    if (method === 'GET' && p === '/good-checkout-offline/backfill-status') {
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

    /* 01/10 — DISPARA O ANO TODO, mês a mês, sozinho. Paridade com a AMB e a Girassol, que
       têm isto desde agosto. Uso: ...backfill-ano?ate=07  (default: até o mês passado) */
    /* 15/10 — o plano do backfill da GOOD, como o da Girassol: ?acao=status (padrão) | parar | retentar */
    /* 23/10: rotas do canário da peça única — /canario-estado (aviso do painel, só admin) e /canario-marketplaces */
    if (await _canGood.rotas({ PREFIXO: '/good-checkout-offline', json, validarSessao, ehAdmin, lerChaveAdmin })(req, res, urlObj, method, p)) return true;

    if (method === 'GET' && p === '/good-checkout-offline/backfill-plano') {
      const kP = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kP === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const acao = urlObj.searchParams.get('acao') || 'status';
      if (acao === 'parar') { const okP = _fatGood.parar(CACHE_DIR); json(res, okP ? 200 : 500, okP ? { ok: true, msg: 'plano parado: a fatia em curso termina e ele não segue' } : { ok: false, erro: 'não consegui gravar a parada (ou não há plano) — o plano NÃO foi parado' }); return true; }
      if (acao === 'retentar') { const n = _fatGood.retentar(CACHE_DIR); if (n < 0) { json(res, 500, { ok: false, erro: 'não consegui gravar o plano — nada voltou pra fila' }); return true; }
        _motorPlanoGood.tocar().catch(() => {}); json(res, 200, { ok: true, msg: n + ' fatia(s) com erro voltaram pra fila' }); return true; }
      json(res, 200, Object.assign({ ok: true }, _fatGood.resumo(_fatGood.ler(CACHE_DIR)), { motor: _motorPlanoGood.estado() }));
      return true;
    }

    if ((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/backfill-ano') {
      const kA = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kA === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      if (_bfGoodAno.rodando || (_bfGood && _bfGood.estado === 'rodando')) {
        json(res, 409, { ok: false, erro: 'já tem backfill rodando — acompanhe no status', ano: _bfGoodAno, mes: _bfGood });
        return true;
      }
      /* 01/10 — BUG MEU, pego em produção: `new Date(new Date().toLocaleString('en-CA', ...))`
         parecia certo mas devolve Invalid Date no Node — o formato sai como
         "2026-10-01, 2:33:12 a.m." e o construtor não lê isso. `getFullYear()` virava NaN,
         `String(NaN)` = "NaN", e a rota recusava a própria chamada sem parâmetro com
         "use &ano=AAAA". O mês padrão virava 12 pelo `|| 12`, o que seria pior: rodaria o ano
         inteiro sem ninguém pedir.
         `formatToParts` entrega os campos JÁ no fuso, sem texto pra parsear no meio. */
      const _p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit' }).formatToParts(new Date());
      const _anoSP = _p.find(x => x.type === 'year').value;
      const _mesSP = Number(_p.find(x => x.type === 'month').value);
      /* default: até o mês PASSADO. O mês corrente ainda recebe vendas, e regravá-lo agora
         deixaria o histórico desatualizado de novo amanhã.
         Codex #549 (P1): ano e mês padrão saem da MESMA conta. Em janeiro o mês passado é
         dezembro DO ANO ANTERIOR, então o ano padrão também recua — antes o ano ficava no
         corrente e o padrão rodava "janeiro a dezembro" de um ano que nem começou.
         Ano passado explícito: o padrão é o ano inteiro (12). Ano corrente explícito: até o
         mês passado (em janeiro não há mês fechado, e pede &ate=). Ano futuro: nada a rodar.
         O que a pessoa digitou (`ano`, `ate`) sempre vale. */
      const _anoNumSP = Number(_anoSP);
      const ano = String(urlObj.searchParams.get('ano') || (_mesSP === 1 ? _anoNumSP - 1 : _anoNumSP));
      const _mesPadrao = Number(ano) < _anoNumSP ? 12 : (Number(ano) === _anoNumSP ? _mesSP - 1 : 0);
      const _ateParam = urlObj.searchParams.get('ate');
      if (!_ateParam && _mesPadrao < 1) { json(res, 400, { ok: false, erro: 'não há mês fechado em ' + ano + ' ainda — informe &ate=MM' }); return true; }
      const ate = String(_ateParam || _mesPadrao).padStart(2, '0');
      if (!/^(0[1-9]|1[0-2])$/.test(ate)) { json(res, 400, { ok: false, erro: 'use &ate=MM (01 a 12)' }); return true; }
      if (!/^\d{4}$/.test(ano)) { json(res, 400, { ok: false, erro: 'use &ano=AAAA' }); return true; }
      try {
        /* 15/10: vira PLANO em disco tocado pelo motor (ver _motorPlanoGood). O fim do período é o
           último dia de `ate` — e nunca depois de hoje. Plano anterior ainda com fatia pendente não é
           sobrescrito sem &refazer=1 (proteção contra clique duplo). */
        const _hojeSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        const _ultDia = new Date(Date.UTC(Number(ano), Number(ate), 0)).toISOString().slice(0, 10);
        const _fimPl = _ultDia > _hojeSP ? _hojeSP : _ultDia;
        /* Codex #696 r2: ano fora da faixa operacional (ex.: 0026 — o Date.UTC trata 0..99 como 19xx) */
        if (Number(ano) < 2020 || Number(ano) > Number(_hojeSP.slice(0, 4)) + 1) { json(res, 400, { ok: false, erro: 'ano fora da faixa: use de 2020 até o ano que vem' }); return true; }
        /* Codex #696: ano futuro (ou mês que ainda não começou) daria plano VAZIO anunciado como aceito */
        if (_fimPl < ano + '-01-01') { json(res, 400, { ok: false, erro: 'período vazio: ' + ano + '-01-01 a ' + _fimPl + ' — nada a refazer ainda' }); return true; }
        const _plAnt = _fatGood.ler(CACHE_DIR);
        if (_plAnt && !_plAnt.parado && _fatGood.proxima(_plAnt) && urlObj.searchParams.get('refazer') !== '1') {
          json(res, 409, { ok: false, erro: 'já existe um plano em andamento — acompanhe no status (ou &refazer=1 pra recomeçar)', plano: _fatGood.resumo(_plAnt) });
          return true;
        }
        const _pl = _fatGood.criar(CACHE_DIR, ano + '-01-01', _fimPl, 10);
        _motorPlanoGood.tocar().catch(() => {});
        const _jan = require('../lib/checkout/contexto-fundo').janelaRotinaPesada();
        json(res, 202, { ok: true, empresa: 'good', ano, de: ano + '-01-01', ate: _fimPl, fatias: _pl.fatias.length, automatico: true,
          comeca: _jan.ok ? 'agora' : 'às 18h05 (galpão em operação agora)',
          acompanhe: '/good-checkout-offline/backfill-status?k=' + encodeURIComponent(kA),
          nota: 'plano em disco: roda sozinho fora do horário do galpão, uma fatia de 10 dias por vez, refaz sozinho a que falhar e retoma de onde parou se o serviço reiniciar.' });
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e) });
      }
      return true;
    }

    /* ═══ 01/10 — PARIDADE DO PAINEL: rotas que a AMB tinha e a GOOD não ═══
       O dono: "o que o painel de dashboard tem pra uma, tem q ter pra outra... os botões, os
       cards, isso tem q ser iguais nelas".
       Medi antes de copiar: das 18 que eu achava que faltavam, 5 já respondiam pelas libs
       comuns que a GOOD monta — sobraram 11 de verdade. Estas quatro são as que dependem só
       de lib multiempresa (ml-fatura-cartao, tiktok-custo-devolucoes, magalu-cancelados), e
       por isso entram sem arrastar nada da AMB junto.
       As outras sete dependem de peças que só existem no arquivo da AMB e vêm em seguida,
       uma leva por vez — não num PR só. */





    if ((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/backfill-vendas') {
      const kB = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const de = urlObj.searchParams.get('de') || '';
      const ate = urlObj.searchParams.get('ate') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        json(res, 400, { ok: false, erro: 'use ?de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
      }
      if (de > ate) { json(res, 400, { ok: false, erro: 'de maior que ate' }); return true; }
      try {
        const gbo = require('../girassol-backup-offline/gbo-app');
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


    // SAÚDE DA SESSÃO SHOPEE (b13) — admin. Diz se o cookie está vivo, de onde ele
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
    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).



    // ─── ETIQUETAS EM MASSA (11/08, b17) — o lote da Shopee de uma vez só ─────────────────
    // Caso real que motivou: o token Bling↔Shopee venceu (365d, sem alerta), 31 pedidos do dia
    // ficaram sem etiqueta no checkout, e o Diego baixou o ZPL agregado direto da Shopee. As
    // etiquetas são 100% raster (imagem GRF, sem ^FD nem barcode ZPL) — a identificação vem
    // dos códigos DENTRO da imagem (chave da NF-e no CODE128 da DANFE + tracking BR no QR),
    // decodificados FORA daqui. Esta rota recebe o resultado já identificado:
    //   POST { etiquetas: [{ nf: 77412, tracking: 'BR26…', zpl_base64: '…' }] }
    // e casa cada uma pelo nf_numero do manifesto. Grava IDÊNTICO ao anexo individual
    // (grava-primeiro, carimbos no manifesto + snapshot, ev1 pro Devoluções).
    /* 30/10 — as ROTAS DE LOTE (etiquetas em massa, a página de envio e as DANFEs em lote) viraram a peça única
       lib/checkout/rotas-lote (eram só daqui; a AMB e a Girassol ganham no passo seguinte) */
    if (await _rotasLote(readBody).handle(req, res, p, method, urlObj)) return true;

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /good-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.


    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /good-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31


    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    if (method === 'POST' && p === '/good-checkout-offline/sku-info') {
      const opSess = validarSessao(req.headers['cookie']);
      /* 17/09 — PORTE: a AMB e a Girassol aceitam CHAVE DE ADMIN ou sessão nestas rotas; a
         GOOD aceitava só sessão. Não é diferença de operação: é capacidade que ficou pra trás,
         e com efeito prático — rotina automática, cron externo e a própria conversa aqui não
         têm sessão de navegador, então essas seis rotas eram inalcançáveis por chave na GOOD
         enquanto as outras duas respondiam. Regra da casa: uma tem, agora ambas têm. */
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
        if (!body.fresh && c && (Date.now() - (c.ts || 0)) < TTL && (c.custo != null || c.saldo != null)) {
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
        if (k2 && k2.id && (Date.now() - (k2.ts || 0)) < 7 * 24 * 3600 * 1000) { ids[sku] = { id: k2.id, preco: (k2.preco != null ? k2.preco : null), custo: (k2.custo != null ? k2.custo : null) }; }
        else aResolver.push(sku);
      }
      // 1) resolve SKU → produto — só quem NÃO está no cache permanente
      for (const sku of aResolver) {
        try {
          let prod = null;
          /* Codex #497 (r4): esta cópia inline (caixa exata/maiúscula/minúscula, reserva do
             inativo, distinção falha×inconclusivo×excluído) levou P1+P2 em três rodadas de review
             — cada correção fechava um buraco desta cópia sem tocar a de custo-sync (nem a da AMB/
             Girassol, que herdaram o mesmo bug ao serem "espelhadas"). resolverProdutoPorSku
             (lib/checkout/produto-ativo.js) já resolve tudo isso num lugar só e é o mesmo código
             que o custo-sync desta e das outras duas empresas usa — usar aqui fecha as cópias de
             uma vez em vez de continuar consertando ponto a ponto. */
          const _res = await resolverProdutoPorSku(sku, bg, 10);
          if (_res.produto && _res.produto.id) {
            const d = await bg(`/produtos/${_res.produto.id}`);
            prod = (d.ok && d.data && d.data.data) || _res.produto;
          }
          if (prod && prod.id) {
            const forn = prod.fornecedor || {};
            const cand = [forn.precoCusto, forn.precoCompra, prod.precoCusto, prod.custo].map(Number).filter(v => isFinite(v) && v > 0);
            ids[sku] = { id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: cand.length ? cand[0] : null };
          } else {
            /* Codex (#186): a AMB e a Girassol caem no _ccAll quando a consulta falha — proteção
               que nasceu em 22/07, quando um 429 do Bling apagou custos conhecidos da tela. A GOOD
               nunca teve. Ficou visível agora: ao parar de inventar carimbo, o destino legado
               virou "velho", cai aqui, e a consulta usa o SKU ANTIGO (que não existe mais no
               Bling) — então o de-para novo gravava custo NULO justamente onde deveria herdar. */
            /* Codex #497 (P1): quando o Bling devolve SÓ cadastros excluídos, resolverProdutoPorSku
               devolve produto nulo e cair aqui RESTAURAVA o custo em cache — que é justamente o
               custo do cadastro excluído, gravado pela lógica antiga. A proteção do #186 existe
               pro caso de FALHA de consulta (429, timeout), não pro caso de "consultei e o que
               existe está apagado". São opostos: numa o dado velho é o melhor que temos, na outra
               ele é exatamente o dado ruim que estamos tentando tirar. `todosExcluidos` já vem
               false quando a lib não teve certeza (busca falhou, página cheia, ou sobrou reserva). */
            const _soExcluidos = !!_res.todosExcluidos;
            const kP = _soExcluidos ? null : _custoLib.custoDeSku(_ccAll, sku);
            if (_soExcluidos) {
              ids[sku] = null;
              if (resolveFalhas < 3) console.log('[SKU-INFO] ' + sku + ': todos os cadastros estão EXCLUÍDOS no Bling — custo em cache DESCARTADO (veio de cadastro apagado)');
            } else if (kP && kP.custo != null) {
              ids[sku] = { id: kP.id || null, preco: (kP.preco != null ? kP.preco : null), custo: kP.custo };
            } else { ids[sku] = null; if (resolveFalhas < 3) console.log('[SKU-INFO] nao resolveu', sku); resolveFalhas++; }
          }
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
        const info = o2 ? { saldo: (saldos[o2.id] != null ? saldos[o2.id] : null), preco: o2.preco, custo: o2.custo, ts: Date.now() }
                        : { saldo: null, preco: null, custo: null, ts: Date.now() };
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

    // DASHBOARD — a TELA ÚNICA (a mesma da Girassol e da AMB, pelo gerador lib/checkout/painel/empresas.js)
    if (method === 'GET' && (p === '/good-checkout-offline/dashboard' || p === '/good-checkout-offline/dashboard-antigo')) {
      /* 29/10: a tela velha da GOOD (dashboard.html, reserva desde a troca de 14/10) SAIU, depois de conferida item a item
         (#761 trouxe pra tela única o que só ela tinha). /dashboard-antigo leva pra tela única (endereço salvo continua
         funcionando); se a geração falhar, erro claro — como na Girassol e na AMB. */
      if (p === '/good-checkout-offline/dashboard-antigo') {
        res.writeHead(302, { Location: '/good-checkout-offline/dashboard' + (urlObj.search || '') }); res.end();
        return true;
      }
      try {
        /* 21/10: a configuração do painel de cada empresa mora num lugar só (lib/checkout/painel/empresas.js) */
        const _htmlNovo = require('../lib/checkout/painel/empresas').painelDaEmpresa('good', { defaultAliq: DEFAULT_ALIQ_BK_GOOD });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(_htmlNovo);
      } catch (e) { json(res, 500, { erro: 'painel: ' + e.message }); }
      return true;
    }


    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /good-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)


    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal
    if ((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/config-fiscal') {
      const opSess = validarSessao(req.headers['cookie']);
      /* 17/09 — PORTE: a AMB e a Girassol aceitam CHAVE DE ADMIN ou sessão nestas rotas; a
         GOOD aceitava só sessão. Não é diferença de operação: é capacidade que ficou pra trás,
         e com efeito prático — rotina automática, cron externo e a própria conversa aqui não
         têm sessão de navegador, então essas seis rotas eram inalcançáveis por chave na GOOD
         enquanto as outras duas respondiam. Regra da casa: uma tem, agora ambas têm. */
      const _kAdm = lerChaveAdmin(req, urlObj);
      const _okAdm = (process.env.ADMIN_KEY && _kAdm === process.env.ADMIN_KEY) || (opSess && ehAdmin(opSess));
      if (!_okAdm) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const CFG_FILE = path.join(CACHE_DIR, '_config-fiscal.json');
      /* 18/09 — a rota devolve TAMBÉM as alíquotas apuradas do código. Sem isso, o ⚙️ mostra
   doze campos vazios e o dono não tem como saber qual alíquota está valendo: vazio ali
   significa "usa a tabela", e a tabela ele não vê. Campo em branco que esconde um valor
   ativo é a mesma armadilha do card sem origem. */
if (method === 'GET') { json(res, 200, { ok: true, apuradas: DEFAULT_ALIQ_BK_GOOD, apurados_meses: ALIQ_APURADOS, config: readJson(CFG_FILE, { aliquotas: {}, taxas: {} }) }); return true; }
      let body = {}; try { const _rb = await readBody(req); body = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}   // tolerante: lib/http passou a devolver objeto ja parseado
      const atual = readJson(CFG_FILE, { aliquotas: {}, taxas: {} });
      const _aliqAntes = Object.assign({}, atual.aliquotas || {});   // p/ saber o que mudou de verdade
      // Codex #506 (P2): igual à AMB e à Girassol — `Number(null)` é 0, que passava no teste
      // `isFinite && >=0` ANTES do teste de null, então o zero enviado pelo dashboard (campo
      // limpo) nunca caía no `delete`: ficava gravado como 0% em vez de apagado.
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
      if (body.flex && typeof body.flex === 'object') { atual.flex = atual.flex || {}; for (const [k2, v2] of Object.entries(body.flex)) { if (['ml', 'shopee', 'outros', 'geral'].indexOf(k2) < 0) continue; if (v2 === null) { delete atual.flex[k2]; continue; }   /* Codex #695 r3: campo limpo APAGA o override (Number(null) virava 0 gravado) */
        const n2 = Number(v2); if (isFinite(n2) && n2 >= 0 && n2 <= 100) atual.flex[k2] = n2; }
        /* Codex #695 r2: as MESMAS chaves da AMB/Girassol (a tela única manda ml/shopee/outros). Quem
           salvou 'outros' passa a mandar nele: o 'geral' antigo sai, pra conta e tela mostrarem o mesmo */
        if (body.flex.outros != null && isFinite(Number(body.flex.outros))) delete atual.flex.geral; }
      writeJson(CFG_FILE, atual);
      /* Codex #498 (P2): a resposta dizia só {ok:true}, sem contar SE algo ia ser reaplicado —
         a AMB e a Girassol respondem `reaplicando` com os meses e têm /reaplicar-status pro
         admin acompanhar; a GOOD respondia igual tenha mudado alíquota ou não, e não tinha como
         saber se a correção rodou, ficou na fila (ver lib/imposto-cancelados.js) ou nem achou
         Supabase configurado. Calculado ANTES da resposta, como na AMB e na Girassol. */
      const _mudou = [...new Set([...Object.keys(_aliqAntes), ...Object.keys(atual.aliquotas || {})])]
        .filter(m => Number(_aliqAntes[m] || 0) !== Number((atual.aliquotas || {})[m] || 0));
      json(res, 200, { ok: true, config: atual, reaplicando: _mudou });

      /* 17/09 — PORTE (a AMB e a Girassol faziam, a GOOD não): salvar a alíquota nova não
         mexia em NADA do que já estava gravado. Corrigir a alíquota de um mês passado deixava
         a tela mostrando a margem calculada com a alíquota velha, sem erro nenhum.
         Duas coisas, na ordem: limpar o cache do histórico (senão o agregado de até 30 min
         atrás continuaria servindo e pareceria que "não pegou") e reaplicar nas linhas do
         Supabase, SÓ nos meses que mudaram de verdade. Roda em background: a resposta já foi,
         e o dashboard acompanha pelo /reaplicar-status. */
      try {
        const _nk = Object.keys(_histCacheGood).length;
        for (const _k of Object.keys(_histCacheGood)) delete _histCacheGood[_k];
        if (_nk) console.log('[FISCAL] config salva — cache do histórico limpo (' + _nk + ')');
      } catch (e) {}
      try {
        if (_mudou.length) {
          console.log('[FISCAL] alíquota mudou em: ' + _mudou.join(', ') + ' — reaplicando no histórico');
          reaplicarImposto(_mudou).catch(e => console.log('[FISCAL] ✗ ' + e.message));
        }
      } catch (e) {}
      return true;
    }



    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /good-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso





    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /good-checkout-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /good-checkout-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /good-checkout-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /good-checkout-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /good-checkout-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /good-checkout-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */

    /* ═══ 21/08 — DE-PARA MANUAL: rota (o card consome) ═══════════════════════════════════
    GET  /good-checkout-offline/sku-depara-manual            → lista os pares declarados
    GET  /good-checkout-offline/sku-depara-manual?sugerir=464 → candidatos no catálogo (só sugestão)
    POST /good-checkout-offline/sku-depara-manual {de,para}   → declara o par
    POST /good-checkout-offline/sku-depara-manual {apagar}    → remove
    Pro caso do "464"/"465", que não têm produto_id e o Bling não consegue ligar sozinho. */
    if (p === '/good-checkout-offline/sku-depara-manual') {
      const kM2 = lerChaveAdmin(req, urlObj);
      const sM2 = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kM2 === process.env.ADMIN_KEY) || (sM2 && ehAdmin(sM2)))) { json(res, 404, { error: 'not found' }); return true; }

      if (method === 'GET') {
        const sug = String(urlObj.searchParams.get('sugerir') || '').trim();
        if (sug) {
          /* candidatos saem do banco de custos (SKUs que existem hoje) — sem varrer o catálogo
             inteiro do Bling, que é lento e já tem rota própria. */
          const cc = readJson(path.join(CACHE_DIR, '_custos.json'), {}) || {};
          /* 21/08 (Codex, revisão geral): o card não tinha como mostrar que o SKU JÁ está ligado —
             o campo vinha preenchido com a sugestão e parecia ligado sem estar, e uma ligação
             errada não tinha como ser desfeita pela tela. Devolvo o vínculo atual junto. */
          const _dpAtual = lerDeParaSku();
          const _kv = Object.keys(_dpAtual).find(k => String(k).toUpperCase() === sug.toUpperCase());
          json(res, 200, { ok: true, de: sug, sugestoes: sugerirDeParaSku(sug, Object.keys(cc)),
            vinculo: _kv ? { de: _kv, para: _dpAtual[_kv].para, em: _dpAtual[_kv].em || null } : null,
            leia: 'sugestao por semelhanca — confira antes de declarar; juntar produtos diferentes mistura as vendas' });
          return true;
        }
        /* 13/09 — DECLARAR O PAR PELO NAVEGADOR. A rota só aceitava POST com JSON, e o dono
           opera pelo navegador (a casa já tem outras rotas em GET por esse mesmo motivo).
           O caso que motivou: FL-1011-PRETO foi renomeado pra 3933398010054 no Bling, e o
           banco de custos seguia procurando o código velho — uma falha por rodada, todo dia,
           no produto que mais vende. Mesmas travas do POST: exige os dois lados, recusa par
           igual e recusa ciclo. (Codex #397 P2: espelhado em AMB/Girassol, faltava aqui.) */
        const deG = String(urlObj.searchParams.get('de') || '').trim();
        const paraG = String(urlObj.searchParams.get('para') || '').trim();
        if (deG || paraG) {
          /* Codex (#397 P2): só um dos dois lados caía direto na listagem — 200 ok:true sem
             gravar nada, e quem digitou errado achava que tinha declarado o par. */
          if (!deG || !paraG) { json(res, 400, { ok: false, erro: 'informe de e para' }); return true; }
          /* Codex (#397 P1): GET que grava é alvo de CSRF — o cookie de sessão é SameSite=Lax,
             que ainda viaja numa navegação top-level (um link/imagem noutro site abriria esta
             URL já logado e reescreveria o par). Navegadores atuais marcam esse caso com
             Sec-Fetch-Site: cross-site; só bloqueio esse caso — digitar a URL ou abrir por um
             link dentro do próprio sistema continua funcionando normalmente. */
          if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            json(res, 403, { ok: false, erro: 'requisicao cross-site bloqueada (protecao contra CSRF) — abra o sistema e declare o par por lá' });
            return true;
          }
          if (deG.toUpperCase() === paraG.toUpperCase()) { json(res, 400, { ok: false, erro: 'de e para sao o mesmo SKU' }); return true; }
          const mG = lerDeParaSku();
          /* ciclo: seguindo a cadeia a partir de `para`, ela não pode voltar em `de` */
          let passo = paraG, voltas = 0;
          while (passo && voltas++ < 20) {
            const kk = Object.keys(mG).find(x => String(x).toUpperCase() === String(passo).toUpperCase());
            if (!kk) break;
            const prox = mG[kk] && mG[kk].para;
            if (prox && String(prox).toUpperCase() === deG.toUpperCase()) { json(res, 400, { ok: false, erro: 'esse par criaria um ciclo (' + deG + ' ↔ ' + paraG + ')' }); return true; }
            passo = prox;
          }
          for (const kk of Object.keys(mG).filter(x => String(x).trim().toUpperCase() === deG.toUpperCase())) delete mG[kk];
          mG[deG] = { para: paraG, em: new Date().toISOString() };
          gravarDeParaSku(mG);
          json(res, 200, { ok: true, ligado: { de: deG, para: paraG }, total: Object.keys(mG).length,
            leia: 'o histórico e o custo passam a resolver ' + deG + ' como ' + paraG + ' — confira que são o MESMO produto, porque juntar produtos diferentes mistura as vendas' });
          return true;
        }
        const m = lerDeParaSku();
        json(res, 200, { ok: true, total: Object.keys(m).length,
          pares: Object.keys(m).sort().map(k => ({ de: k, para: m[k].para, em: m[k].em || null })) });
        return true;
      }

      if (method === 'POST') {
        let corpo = '';
        await new Promise(r => { req.on('data', c => { corpo += c; if (corpo.length > 1e6) req.destroy(); }); req.on('end', r); req.on('error', r); });
        let b = {};
        try { b = JSON.parse(corpo || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'JSON invalido' }); return true; }
        const m = lerDeParaSku();

        if (b.apagar) {
          /* Codex (#185): o resto da rota trata SKU sem diferenciar maiúscula/minúscula, mas o
             apagar só removia a grafia exata e a MAIÚSCULA. Um par gravado como "Pm1" sobrevivia
             a um apagar "pm1" — e a rota ainda respondia ok, então parecia apagado e não estava. */
          /* Codex (#186): apagar SÓ a primeira variante era REGRESSÃO — o save antigo permitia
             "pm1" e "PM1" convivendo, e a versão anterior removia exata + MAIÚSCULA. Com uma
             chave só sobrando, ela voltaria a valer sozinha. Apaga TODAS as variantes. */
          const k = String(b.apagar).trim();
          const kTodas = Object.keys(m).filter(x => String(x).trim().toUpperCase() === k.toUpperCase());
          const tinha = kTodas.length > 0;
          for (const kk of kTodas) delete m[kk];
          gravarDeParaSku(m);
          json(res, 200, { ok: true, apagado: tinha ? k : null, total: Object.keys(m).length });
          return true;
        }

        const de = String(b.de || '').trim();
        const para = String(b.para || '').trim();
        if (!de || !para) { json(res, 400, { ok: false, erro: 'informe de e para' }); return true; }
        if (de.toUpperCase() === para.toUpperCase()) { json(res, 400, { ok: false, erro: 'de e para sao o mesmo SKU' }); return true; }
        /* ciclo: se o destino já aponta de volta pra origem, recusa — senão a resolução ficaria
           dando voltas e o Diego não entenderia por que o custo não aparece. */
        /* Codex (#185): a checagem antiga resolvia o destino PELA ARESTA ANTIGA do próprio `de`,
           e comparava só o resultado final. Com A→B e C→A, mudar A pra apontar pra C fazia
           resolverDeParaSku('C') devolver B — passava, e gravava o ciclo A↔C. Agora percorro a
           cadeia a partir de `para` IGNORANDO a aresta atual de `de`, e recuso se ela passar por
           `de` em qualquer ponto. */
        const _up = s => String(s || '').toUpperCase();
        let _passo = para, _visit = new Set([_up(de)]), _ciclo = false;
        for (let i = 0; i < 50 && _passo; i++) {
          if (_up(_passo) === _up(de)) { _ciclo = true; break; }
          if (_visit.has(_up(_passo))) break;            // ciclo que não envolve `de`: já existia
          _visit.add(_up(_passo));
          const _reg = m[_passo] || m[Object.keys(m).find(k => _up(k) === _up(_passo))];
          _passo = _reg && _reg.para;
        }
        if (_ciclo) {
          json(res, 400, { ok: false, erro: 'isso criaria um ciclo: seguindo ' + para + ' se chega de volta em ' + de }); return true;
        }
        /* Codex (#185): mesmo bug de caixa do apagar, do outro lado. Gravar "Pm1 → A" e depois
           "pm1 → B" deixava as DUAS chaves, e a resolução escolhia uma ou outra conforme a grafia
           que chegasse. Reaproveito a chave que já existe (comparação normalizada). */
        /* Codex (#186): reaproveitar UMA chave não bastava. Com "pm1" e "PM1" legados convivendo
           (o save antigo permitia), atualizar a primeira deixava a outra apontando pro destino
           VELHO — e como a busca dá precedência à chave exata, resolver "PM1" ainda devolvia o
           destino antigo. Mesma correção do apagar, do outro lado: some com todas as variantes e
           deixa UMA, preservando a grafia que já estava gravada. */
        const _vars = Object.keys(m).filter(x => String(x).trim().toUpperCase() === de.toUpperCase());
        const _deReal = _vars[0] || de;
        for (const _v of _vars) delete m[_v];
        m[_deReal] = { para, em: new Date().toISOString() };
        gravarDeParaSku(m);
        json(res, 200, { ok: true, de, para, resolve_para: resolverDeParaSku(de), total: Object.keys(m).length });
        return true;
      }
    }

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

    if (p === '/good-checkout-offline/custos-manuais') {
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
        res.end(telaCustosManuais('GOOD Import', '/good-checkout-offline'));
        return true;
      }
    }

    if (method === 'GET' && p === '/good-checkout-offline/custo-sync') {
      const k = lerChaveAdmin(req, urlObj);
      const sessC = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessC && ehAdmin(sessC)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, { ok: true, rodando: !!_cst.rodando, progresso: _cst.feitos + '/' + _cst.total, ok_ate_agora: _cst.ok, falhas: _cst.falhas, falhas_detalhe: _cst.falhas_detalhe || [], inicio: _cst.inicio,
        /* 02/10: diz que está NA FILA em vez de só "0/0" — foi o que confundiu o dono */
        esperando_trava: _cst.esperando_trava || null,
        /* Codex #566: o retry pendente é rastreado À PARTE da trava — vale também após rodada que terminou
           com SKU sobrando, e mostra o prazo REAL (3 min ou 1h), não um intervalo fixo. */
        retry_pendente: custoRetryPendente(),
        leia: (() => { const _r = custoRetryPendente();
          const _base = _cst.rodando ? 'rodando' : (_cst.inicio ? 'última rodada terminou' : 'nunca rodou neste processo');
          if (!_r) return _base;
          return _base + ' — na fila: tenta de novo sozinho em ~' + _r.em_min + ' min' + (_cst.esperando_trava ? ' (trava com ' + _cst.esperando_trava.por + ' há ' + _cst.esperando_trava.ha_min + ' min)' : ''); })() }); return true; }
      const skuProbe = urlObj.searchParams.get('sku');
      if (skuProbe) { const ccP = readJson(path.join(CACHE_DIR, '_custos.json'), {}); json(res, 200, { ok: true, sku: skuProbe, no_cache_permanente: ccP[skuProbe] || null, total_no_cache: Object.keys(ccP).length }); return true; }
      if (_cst.rodando) { json(res, 200, { ok: true, ja_rodando: true, progresso: _cst.feitos + '/' + _cst.total }); return true; }
      /* 14/09 — trava do processo ocupada (qualquer uma das outras duas empresas, ou a
         tartaruga desta mesma): custoSyncTravado adia sem rodar nada; dizer "iniciado: true"
         aqui seria mentira (mesmo apontamento do Codex no #422 pro AMB/Girassol). */
      const _travaOcupadaS = travaPesada.quemEsta();
      if (_travaOcupadaS) { json(res, 409, { ok: false, erro: 'rotina pesada em curso (' + _travaOcupadaS.nome + ', há ' + _travaOcupadaS.ha_min + ' min) — tente de novo em alguns minutos' }); return true; }
      custoSyncTravado(!!urlObj.searchParams.get('fresh')).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, mensagem: 'custo-sync rodando em background (tartaruga anti-429) — ?status=1 p/ acompanhar', acompanhe: _urlStatus(req, '/good-checkout-offline/custo-sync', '', k) });
      return true;
    }



    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou


    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log


    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)



    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───






    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos



    /* Codex #695 r3: o /historico daqui (sem custo, sem cancelado, sem trava de sessão) saiu — ele
       casava ANTES da delegação `hist` e escondia a rota compartilhada, que entrega o custo pronto
       por item, o cancelado e a camada do estoquista. */










    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)


    // LIBERA a reserva (ao voltar pra lista / finalizar)


    // REABRIR um pedido finalizado por engano: tira da fila de conferidos → volta pra lista.
    // Aceita o bling_id OU o número visível. Se já tinha ido pra VERIFICADO, devolve pra ATENDIDO no Bling.
    if ((method === 'GET' || method === 'POST') && p.startsWith('/good-checkout-offline/reabrir/')) {
      let op = '';
      try { op = (urlObj.searchParams && urlObj.searchParams.get('op')) || ''; } catch (e) {}
      if (!op && method === 'POST') { try { const b = await readBody(req); op = String(b.op || ''); } catch (e) {} }
        /* ⚠️ 04/10 — ESCALADA DE PRIVILÉGIO (auditoria do Codex, achado A, P1). A autorização
           usava o `op` vindo da QUERY/BODY: um estoquista logado passava `?op=<nome de um
           admin>` e virava admin. Os nomes dos admins são públicos em `/operadores`.
           Agora quem decide é a IDENTIDADE AUTENTICADA (`req._op`, posta pela guarda a partir
           da sessão ou da ADMIN_KEY). O `op` da URL segue valendo só pra REGISTRO de quem fez —
           nunca pra decidir permissão. */
        const _quem = String(req._op || '');
        if (!souAdmin(req, ehAdmin, validarSessao)) { json(res, 200, { ok: false, erro: 'apenas o admin pode reabrir/reverter pedidos' }); return true; }
      const arg = decodeURIComponent(p.split('/').pop() || '').trim();
      /* ⚠️ AUDITORIA 06/10: `/reabrir/` sem nada depois chegava aqui com string vazia e ia buscar
         `?numero=` no Bling, varrendo páginas à toa pra terminar em "não encontrei" — cota gasta
         por um caminho que nunca podia dar certo. Recuso de cara. */
      if (!arg) { json(res, 200, { ok: false, erro: 'informe o numero do pedido (ou id:<ID do Bling>)' }); return true; }

      /* ⚠️ AUDITORIA 06/10: DOIS CLIQUES AO MESMO TEMPO. O caminho tem `await` no Bling; sem
         trava, dois pedidos do mesmo número disparam DOIS PATCH e dois ciclos. No galpão isso
         acontece: duas pessoas na mesma tela, ou o duplo clique do próprio botão. */
      if (_reabrindo.has(arg)) {
        json(res, 200, { ok: false, arg, erro: 'ja estou reabrindo este pedido — aguarde alguns segundos' });
        return true;
      }
      _reabrindo.add(arg);
      try {
      const conf = readJson(CONFERIDOS_FILE, {});

/* ⚠️ Codex #645 (P1): o painel de resgate manda `?resgate=1` (ou `?porId=1`). Nesse modo um número
         que casa com uma linha do HISTÓRICO não pode curto-circuitar: o mesmo número pode estar num
         pedido finalizado E num pedido em limbo (número repete entre anos/lojas), e eu reabriria
         e apagaria o pedido errado. Então procuro e desambiguo no Bling primeiro. */
      let _modoResgate = false, _porIdQ = false;
      try {
        _modoResgate = String((urlObj.searchParams && urlObj.searchParams.get('resgate')) || '') === '1';
        _porIdQ = String((urlObj.searchParams && urlObj.searchParams.get('porId')) || '') === '1';
      } catch (e) {}
      _modoResgate = _modoResgate || _porIdQ;
      let id = _modoResgate
        ? ((_porIdQ && conf[arg]) ? arg : null)
        : (conf[arg] ? arg : (Object.keys(conf).find(k => String(conf[k] && conf[k].numero) === String(arg)) || null));

      /* ⚠️ 06/10 — RESGATE DO PEDIDO EM LIMBO (caso real: 5477 da AMBTotal).
         A versão anterior apagava da fila ANTES de confirmar no Bling. Quando o Bling recusava, o
         pedido ficava FORA da fila e ainda DESPACHADO — e aí reabrir respondia "não está na fila
         de finalizados" e não fazia nada. O dono ficava sem saída pelo sistema.
         Agora, não achando na fila, procuro o pedido NO BLING pelo número e, se ele estiver
         numa situação pós-checkout (DESPACHADOS ou VERIFICADO), devolvo pra ATENDIDO. É o mesmo
         efeito que o reabrir teria dado, só que partindo do estado em que o pedido ficou. */
      if (!id) {
        /* ⚠️ Codex #645 (P2): o resgate MOVE pedido no Bling; um GET cross-site (link com cookie
           SameSite=Lax) não pode disparar isso. Só POST — o painel já envia POST. */
        if (method !== 'POST') { json(res, 200, { ok: false, arg, erro: 'o resgate de pedido fora da fila exige POST' }); return true; }
        /* ⚠️ 06/10 — RESGATE DO PEDIDO EM LIMBO (caso real: 5477 da AMBTotal).
           A versão anterior apagava da fila ANTES de confirmar no Bling; quando o Bling recusava,
           o pedido ficava fora da fila e ainda DESPACHADO, e reabrir respondia "não está na fila"
           e não fazia nada — sem saída pelo sistema.
           Aqui procuro o pedido NO BLING e, se estiver em situação pós-checkout, devolvo pra
           ATENDIDO. */
        let achado = null, erroBusca = null;
        try {
          /* ⚠️ Codex #645 (P1, duas vezes): `blingGet` devolve `{ ok, status, data: <corpo> }` e o
             corpo da LISTA é `{ data: [...] }` — ou seja, os pedidos estão em `r.data.data`. Eu
             fazia `r.data.filter(...)`, que estoura num objeto; o try/catch engolia e o resgate
             NUNCA funcionava, dizendo "não está em DESPACHADOS".
             E o Bling IGNORA o filtro `numero` em alguns casos (o `/buscar-pedido` já se protege
             disso logo abaixo), então confiro o número no resultado — sem isso eu moveria um
             pedido QUE NÃO É O DELE. */
          /* ⚠️ Codex #645: o Bling IGNORA o filtro `numero` em alguns casos, então uma página só
             pode não trazer o pedido. Varro algumas páginas e paro assim que achar. */
          /* ⚠️ Codex #645 (P1): parar na PRIMEIRA página com acerto impede detectar o número
             REPETIDO — a duplicata pode estar na página seguinte, e aí `candidatos.length > 1`
             nunca dispara e eu moveria um pedido sem saber que havia outro. Varro todas e ACUMULO. */
          let lista = [], falhaBling = null;
          /* ⚠️ Codex #645 (P2): o ID explícito (`?porId=1`) NÃO passa pela busca por número — o ID
             pode ser igual ao número visível de OUTRA venda, e a lista já preenchida desviaria o
             resgate pro pedido errado. Decido o modo antes de buscar qualquer coisa. */
          let porId = false;
          try { porId = String((urlObj.searchParams && urlObj.searchParams.get('porId')) || '') === '1'; } catch (e) {}
          /* ⚠️ Codex #645 (P2): `blingGet` não tem prazo por padrão; um Bling que aceita a conexão e
             não responde deixaria o resgate (e o fetch do painel) pendurados. Mesmo AbortController
             do `listarAtendidos`: cada consulta tem teto e é cancelada de verdade. */
          const blingTeto = async (caminho) => {
            const ac = new AbortController();
            const tm = setTimeout(() => ac.abort(), 30000);
            try { return await blingGet(caminho, 3, ac.signal); }
            finally { clearTimeout(tm); }
          };
          for (let pag = 1; !porId && pag <= 5; pag++) {
            const r1 = await blingTeto(`/pedidos/vendas?numero=${encodeURIComponent(arg)}&limite=100&pagina=${pag}`);
            /* ⚠️ Codex #645: `blingGet` RESOLVE `{ ok:false }` em vez de estourar quando o Bling
               está fora (token, 429 esgotado, rede). Tratar isso como "lista vazia" vira
               "não encontrei o pedido" — e o dono conclui que o pedido não existe, quando foi o
               Bling que não respondeu. Guardo a falha pra dizer a verdade. */
            if (!r1 || !r1.ok) { falhaBling = 'o Bling nao respondeu (status ' + String((r1 && r1.status) || '?') + ')'; break; }
            const pagina = (r1.data && Array.isArray(r1.data.data)) ? r1.data.data : [];
            if (!pagina.length) break;
            lista = lista.concat(pagina.filter((x) => String(x && x.numero) === String(arg)));
            if (pagina.length < 100) break;   /* última página */
          }
          if (falhaBling) { json(res, 200, { ok: false, arg, erro: falhaBling + ' — tente de novo em alguns minutos.' }); return true; }

          /* ⚠️ Codex #645 (P2): eu mandava "reabra pelo ID do Bling" e nunca tratava ID — a
             instrução não funcionava. Agora, se nada veio por número, tento `arg` como ID. */
          /* ⚠️ Codex #645 (P1): NÃO reinterpreto sozinho um número de pedido como ID do Bling.
             Se o pedido não aparece nas páginas, tratar o mesmo valor como ID pode acertar uma
             VENDA ALHEIA que por acaso tenha aquele id — e eu moveria o pedido de outra pessoa.
             Só busco por ID quando quem chamou pediu explicitamente (`?porId=1`), que é o que a
             mensagem de número repetido instrui a fazer. */
          if (porId && /^\d+$/.test(String(arg))) {
            const r2 = await blingTeto(`/pedidos/vendas/${encodeURIComponent(arg)}`);
            if (!r2 || (!r2.ok && r2.status !== 404)) {
              json(res, 200, { ok: false, arg, erro: 'o Bling nao respondeu (status ' + String((r2 && r2.status) || '?') + ') — tente de novo em alguns minutos.' });
              return true;
            }
            const um = (r2 && r2.ok && r2.data && (r2.data.data || r2.data)) || null;
            if (um && um.id) lista = [um];
          }

          /* ⚠️ Codex #651 (P2): eu tinha posto os DEGRAUS nesta lista pra poder retomar um resgate
             que parou no meio. Só que "Em digitação" é onde nascem os pedidos NORMAIS do Bling —
             com isso, qualquer rascunho virava candidato a resgate, e buscar um número que não
             está no histórico podia mover um pedido que nunca passou pelo checkout.
             Agora o degrau só conta quando EU registrei que parei o pedido ali: a trava fica no
             próprio arquivo de conferidos, e some quando o resgate termina. */
          /* ⚠️ sem arquivo novo: a marca do resgate parado mora no PRÓPRIO `conf` (a fila de
             conferidos), que já é lido e gravado aqui. Eu tinha inventado um `PARADOS_FILE` que
             não existia — a checagem de órfãos pegou. Menos estado espalhado, menos a inventar. */
          /* a marca mora nas RESERVAS, não na fila de conferidos (ver acima) */
          const _parados = readJson(RESGATES_FILE, {});
          const posCheckout = (x) => {
            const sit = String((x && x.situacao && (x.situacao.id != null ? x.situacao.id : x.situacao)) || '');
            const _desp = (require('./base').SIT_DESPACHADOS || 0);
            if ((_desp && sit === String(_desp)) || sit === String(SIT_VERIFICADO)) return true;
            /* degrau: só se houver registro MEU de resgate parado neste pedido, nesta situação */
            const _reg = _parados['_resgate_' + String(x && x.id)];
            return !!(_reg && String(_reg.situacao) === sit);
          };
          const candidatos = lista.filter(posCheckout);

          if (candidatos.length > 1) {
            /* número repete entre anos/lojas: escolher um seria mexer no pedido errado */
            json(res, 200, { ok: false, arg,
              erro: 'achei ' + candidatos.length + ' pedidos com este numero em situacao pos-checkout. ' +
                    'Resgate pelo ID do Bling, digitando id:<ID> no campo de resgate (?porId=1), pra eu nao mexer no pedido errado.',
              candidatos: candidatos.map((x) => x.id) });
            return true;
          }
          if (candidatos.length === 1) achado = candidatos[0];
          else if (lista.length) erroBusca = 'o pedido existe no Bling, mas nao esta em DESPACHADOS, VERIFICADO nem em um degrau de GOODBKP_SIT_DEGRAUS';
        } catch (e) { erroBusca = String((e && e.message) || e); }

        if (!achado) {
          json(res, 200, { ok: false, arg,
            erro: erroBusca || 'pedido nao esta na fila de finalizados e nao encontrei ele no Bling pelo numero nem pelo ID.' });
          return true;
        }

        /* Codex #645: se o pedido escolhido no Bling TAMBÉM está na fila (histórico com o ID dele),
           segue o reabrir normal abaixo (que limpa a fila); senão é limbo de verdade. */
        if (conf[String(achado.id)]) id = String(achado.id);
        if (!id) {
          /* ⚠️ 06/10 — CASO REAL 5477: o Bling RECUSOU o salto direto, com
               "DESPACHADOS - Atendido: Nao ha transicoes definidas para esta entidade" (HTTP 400).
             Nao e erro nosso: o workflow do Bling nao tem essa transicao. O caminho de IDA e
             ATENDIDO -> VERIFICADO -> DESPACHADOS (ciclo.js), entao a VOLTA tem de DESANDAR pelo
             mesmo caminho. Tento o direto primeiro (funciona pra quem esta em VERIFICADO) e so
             desando quando o Bling disser que a transicao nao existe. */
          const _sitAtual = String((achado.situacao && (achado.situacao.id != null ? achado.situacao.id : achado.situacao)) || '');
          const _res = await _moverAtendidoDesandando({ moverSituacao, pedidoId: achado.id, sitAtual: _sitAtual,
            sitAtendido: SIT_ATENDIDO, sitDespachados: (require('./base').SIT_DESPACHADOS || 0), sitVerificado: SIT_VERIFICADO ,
            /* ⚠️ Codex #651: a marca do resgate parado é GRAVADA aqui (e limpa ao concluir). Eu
               lia `_resgate_<id>` em três lugares e NÃO escrevia em nenhum — a mensagem "tente de
               novo a partir daí" nunca ia funcionar. Mora no `conf`, que já é lido e gravado. */
            /* ⚠️ Codex #651: de onde RETOMAR. O `_parados` já foi lido acima pra decidir se o
               pedido é resgatável; aqui digo à escala em que degrau ele parou, pra ela não
               refazer o passo que já foi dado. */
            degrauSalvo: (function () {
              /* lê do arquivo aqui: o `_parados` do bloco de cima é de outro escopo (órfãos pegou) */
              try {
                const _r = readJson(RESGATES_FILE, {})['_resgate_' + String(achado.id)];
                return (_r && _r.situacao != null) ? _r.situacao : null;
              } catch (e) { return null; }
            })(),
            marcarParado: function (passo) {
              /* devolve false quando a gravação falha — a escala avisa o dono */
              try {
                /* ⚠️ Codex #651: a marca NÃO pode morar em CONFERIDOS_FILE. O
                   `sincronizarConferidos` trata TODA chave sem `sincronizado` como id de pedido
                   real e dispara PATCH em `/pedidos/vendas/_resgate_<id>/situacoes/...` —
                   chamada inútil contra o Bling, comendo cota, pra sempre. Vai pro arquivo de
                   reservas, que já é estado por pedido e ninguém varre pro Bling. */
                /* ⚠️ Codex #651: `writeJson` engole a exceção e devolve false (disco cheio,
                   volume só-leitura). Com o try em volta, isso parecia sucesso — e eu mandava
                   "tente de novo a partir daí" sem marca nenhuma gravada: o retry recusaria o
                   pedido. Se a gravação falhar, EU DIGO. */
                const _pp = readJson(RESGATES_FILE, {});
                _pp['_resgate_' + String(achado.id)] = { situacao: passo, em: new Date().toISOString() };
                return writeJson(RESGATES_FILE, _pp) !== false;
              } catch (e) { return false; }
            },
            limparMarca: function () {
              try {
                const _pp = readJson(RESGATES_FILE, {});
                const _k = '_resgate_' + String(achado.id);
                if (_pp[_k]) { delete _pp[_k]; writeJson(RESGATES_FILE, _pp); }
              } catch (e) {}
            } });
          if (_res.resposta) { json(res, 200, _res.resposta); return true; }
          const mv = _res.mv;
          if (!(mv && mv.ok)) {
            json(res, 200, { ok: false, id: achado.id,
              /* ⚠️ 06/10 — "o Bling nao aceitou" NAO basta: o dono fica sem saber o que fazer. O
                 `blingWrite` devolve status, erro e corpo — passo tudo, porque cada caso tem saida
                 diferente: 401 e token vencido; 429 e limite (so esperar); 4xx costuma ser regra do
                 proprio Bling, tipo pedido com nota emitida que nao volta de situacao. */
              erro: 'o Bling recusou devolver este pedido para ATENDIDO'
                    + ((mv && mv.status) ? ' (HTTP ' + mv.status + ')' : '')
                    + ((mv && (mv.erro || mv.error)) ? ': ' + String(mv.erro || mv.error).slice(0, 220) : ''),
              status_bling: (mv && mv.status) || null,
              detalhe: _detalheBling(mv) });
            return true;
          }
          const rsv0 = lerReservas(); if (rsv0[achado.id]) { delete rsv0[achado.id]; writeJson(RESERVAS_FILE, rsv0); }
          /* ⚠️ Codex #645: `rodarCiclo` PULA se já houver ciclo em andamento, e aquele ciclo tirou
             a foto do ATENDIDO antes deste PATCH — o pedido resgatado não entraria no cache e não
             reapareceria. Reagendo uma passada depois, pra não depender da sorte do momento. */
          /* ⚠️ Codex #645 (P2): o segundo ciclo era INCONDICIONAL e repetia a varredura inteira do
             Bling a cada resgate — cota da conta, que a operação paga primeiro. Só reagendo quando
             o ciclo foi PULADO por já haver outro em andamento (que é o caso em que o resgatado
             ficaria de fora do cache). */
          /* ⚠️ Codex #645: uma tentativa só, 90s depois, não basta — um ciclo pode durar vários
             minutos (o watchdog dele é de 15). Se ainda estivesse rodando, o resgatado ficaria fora
             do cache de novo e eu teria dito que reaparece. Insisto até o ciclo aceitar, com teto:
             12 tentativas × 90s (18 min) cobrem os 15 min do watchdog, e nunca roda DOIS ciclos ao mesmo tempo
             porque só reagendo quando o anterior foi PULADO. */
          /* ⚠️ Codex #645 — QUATRO apontamentos seguidos sobre a cadeia de reagendamento que eu
           inventei: uma tentativa só; teto que não cobria o watchdog de 15 min; várias cadeias
           concorrentes quando há vários resgates; e o ciclo que "aceita" mas falha na listagem do
           Bling. Cada conserto abria o seguinte — isso é DESENHO errado, não detalhe.
           Troco por uma coisa só, que não falha calada: peço o ciclo UMA vez e digo a verdade na
           resposta. Se ele estava ocupado, o pedido entra no PRÓXIMO ciclo automático — que roda
           sozinho de qualquer jeito. Prometer "reaparece em segundos" e depender de reagendamento
           era o que criava o buraco. */
        const _ciclo = await rodarCiclo('reabrir-resgate').catch(() => ({ pulado: true }));
        const _entraAgora = !(_ciclo && _ciclo.pulado);

          /* ⚠️ Codex #645 (P2): o ciclo só varre ATENDIDO dentro da JANELA_DIAS (60d por padrão).
             Pedido mais antigo volta pra ATENDIDO no Bling e NÃO reaparece na lista — e eu diria
             que ia reaparecer. Aviso quando for o caso, em vez de prometer o que não acontece. */
          let foraDaJanela = false;
          try {
            const dt = String(achado.data || achado.dataSaida || '').slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
              const dias = Math.floor((Date.now() - new Date(dt + 'T12:00:00').getTime()) / 86400000);
              foraDaJanela = dias > Number(JANELA_DIAS || 60);
            }
          } catch (e) {}

          console.log(`[GOODBKP] RESGATE: ${arg} (bling ${achado.id}) estava fora da fila e pos-checkout -> ATENDIDO`);
          json(res, 200, { ok: true, id: achado.id, resgatado: true, revertido_p_atendido: true,
            fora_da_janela: foraDaJanela,
            mensagem: foraDaJanela
              ? 'devolvido para ATENDIDO no Bling. ATENCAO: o pedido e mais antigo que a janela de ' +
                (JANELA_DIAS || 60) + ' dias que o ciclo varre, entao NAO vai reaparecer sozinho na lista.'
              : 'o pedido estava fora da fila e ainda pos-checkout no Bling; devolvido para ATENDIDO. ' +
                'Ele reaparece na lista assim que o ciclo terminar.' });
          return true;
        }
      }

      const eraSync = !!(conf[id] && conf[id].sincronizado);

      /* ⚠️ 06/10 — MESMA FALHA DA AMB (caso real: pedido 5477 da AMBTotal). Apagava da fila ANTES
         de confirmar no Bling e respondia `ok:true` de qualquer jeito: se a chamada falhasse, o
         pedido sumia do histórico E continuava DESPACHADO. Agora move primeiro. */
      let revertido = false;
      if (eraSync) {
        /* Codex #651: o historico tambem precisa do desandar — senao o pedido que continua na fila recebe so
           o PATCH direto e o mesmo "nao ha transicoes". */
        const _resH = await _moverAtendidoDesandando({ moverSituacao, pedidoId: id, sitAtual: null,
          /* ⚠️ Codex #651: pelo TETO, como as outras leituras desta rota. `blingGet` não tem prazo
           próprio: se o Bling aceita a conexão e nunca responde, isto fica pendurado pra sempre —
           e o pedido fica preso em `_reabrindo`, bloqueando toda tentativa seguinte. */
        lerSituacao: async () => {
          /* ⚠️ Codex #651: COM PRAZO, como as outras leituras desta rota. `blingGet` não tem
             deadline próprio: se o Bling aceita a conexão e nunca responde, isto fica pendurado —
             e o pedido fica preso em `_reabrindo`, bloqueando toda tentativa seguinte.
             O `blingTeto` do bloco de cima é de outro escopo (a checagem de órfãos pegou), então
             o prazo é montado aqui mesmo. */
          const _ac = new AbortController();
          const _tm = setTimeout(() => _ac.abort(), 30000);
          let r;
          try { r = await blingGet('/pedidos/vendas/' + encodeURIComponent(id), 3, _ac.signal); }
          finally { clearTimeout(_tm); }
            const d = r && r.ok && r.data && (r.data.data || r.data); return d && d.situacao ? (d.situacao.id != null ? d.situacao.id : d.situacao) : null; },
          sitAtendido: SIT_ATENDIDO, sitDespachados: (require('./base').SIT_DESPACHADOS || 0), sitVerificado: SIT_VERIFICADO });
        if (_resH.resposta) { json(res, 200, Object.assign({ removido_da_fila: false }, _resH.resposta)); return true; }
        const mv = _resH.mv;
        revertido = !!(mv && mv.ok);
        if (!revertido) {
          console.log('[GOODBKP] reabrir ' + id + ' RECUSADO: o Bling nao aceitou voltar pra ATENDIDO');
          json(res, 200, { ok: false, id, removido_da_fila: false,
            erro: 'o Bling nao aceitou devolver este pedido para ATENDIDO. Ele CONTINUA no historico. ' +
                  'Tente de novo em alguns minutos; se insistir, mude a situacao direto no Bling.',
            detalhe: _detalheBling(mv) });
          return true;
        }
      }
      /* ⚠️ Codex #645: o `conf` foi lido ANTES do await do Bling. Gravar aquele objeto de volta
         descarta o que outro operador finalizou no intervalo — o galpão tem gente bipando ao
         mesmo tempo. Releio a fila e removo só este pedido. */
      const confAtual = readJson(CONFERIDOS_FILE, {});
      delete confAtual[id];
      writeJson(CONFERIDOS_FILE, confAtual);
      const rsv = lerReservas(); if (rsv[id]) { delete rsv[id]; writeJson(RESERVAS_FILE, rsv); }
      rodarCiclo('reabrir').catch(() => {});   // re-cacheia em background → reaparece na lista se estiver ATENDIDO
      console.log(`[GOODBKP] reaberto ${id} (era sync=${eraSync}, revertido p/ ATENDIDO=${revertido})`);
      json(res, 200, { ok: true, id, removido_da_fila: true, revertido_p_atendido: revertido });
      return true;
      } finally { _reabrindo.delete(arg); }
    }

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)


    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.



// ── DIAGNÓSTICO DE ETIQUETA (14/08) ────────────────────────────────────────────
    // Caso real: pedido da AMAZON (Bling 26599886380, NF 077663) ficou "sem etiqueta" no
    // checkout, mas a etiqueta EXISTE e o Diego conseguiu baixá-la pelo Bling. O ciclo já
    // trata Amazon (link ZPL vem nulo → tenta o PDF), e reprocessa todo pedido sem etiqueta
    // a cada rodada — então a suspeita é que a API `/logisticas/etiquetas` não devolve o
    // link, mesmo a tela do Bling imprimindo. Esta rota mostra a RESPOSTA CRUA da API nos
    // dois formatos, pra decidir com dado em vez de suposição. Só leitura.
    // Uso: GET /good-checkout-offline/etiqueta-diag?id=<idBling>&k=ADMIN_KEY
    if (method === 'GET' && p === '/good-checkout-offline/etiqueta-diag') {
      const kE = lerChaveAdmin(req, urlObj);
      const sE = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kE === process.env.ADMIN_KEY) || (sE && ehAdmin(sE)))) { json(res, 404, { error: 'not found' }); return true; }
      const idE = String(urlObj.searchParams.get('id') || '').replace(/\D/g, '');
      if (!idE) { json(res, 400, { ok: false, erro: 'use ?id=<id do pedido no Bling>&k=ADMIN_KEY' }); return true; }
      const out = { ok: true, id_bling: idE, formatos: [], pedido: null, leia: 'link null nos dois formatos = o Bling NAO expoe essa etiqueta pela API (caso tipico de logistica do proprio marketplace). Link presente = falha nossa no download.' };
      for (const fmt of ['ZPL', 'PDF']) {
        try {
          const r = await blingGet('/logisticas/etiquetas?formato=' + fmt + '&idsVendas[]=' + idE);
          const item = r && r.ok && r.data && r.data.data && r.data.data[0];
          const linha = { formato: fmt, http_ok: !!(r && r.ok), tem_item: !!item, tem_link: !!(item && item.link) };
          if (item) { linha.campos = Object.keys(item).slice(0, 12); linha.link_comeca_com = String(item.link || '').slice(0, 60) || null; }
          // 14/08 — o Bling DEVOLVE link nos dois formatos (medido no pedido 26599886380 da
          // Amazon), então a etiqueta não chegar ao checkout é problema no DOWNLOAD, não na
          // API. Aqui o arquivo é realmente baixado pra ver o que vem: status, content-type,
          // tamanho e os primeiros bytes. `baixarEtiquetaPDF` só aceita arquivo começando em
          // %PDF — se a Amazon servir PNG/ZIP/outro, ele devolve null em silêncio.
          if (item && item.link) {
            try {
              const rf = await fetch(item.link);
              const buf = Buffer.from(await rf.arrayBuffer());
              linha.download = {
                http: rf.status,
                content_type: (rf.headers && rf.headers.get && rf.headers.get('content-type')) || null,
                bytes: buf.length,
                comeca_com: buf.slice(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
                hex: buf.slice(0, 8).toString('hex'),
                eh_pdf: buf.slice(0, 4).toString('latin1') === '%PDF',
                eh_zpl: buf.slice(0, 400).toString('latin1').indexOf('^XA') >= 0,
                eh_png: buf.slice(1, 4).toString('latin1') === 'PNG',
                eh_zip: buf.slice(0, 2).toString('latin1') === 'PK'
              };
            } catch (e) { linha.download = { erro: String(e.message || e).slice(0, 160) }; }
          }
          if (r && !r.ok) linha.erro = String((r.data && (r.data.error || r.data.message)) || ('HTTP ' + (r.status || '?'))).slice(0, 200);
          out.formatos.push(linha);
        } catch (e) { out.formatos.push({ formato: fmt, erro: String(e.message || e).slice(0, 160) }); }
        await new Promise(r0 => setTimeout(r0, 400));
      }
      // 14/08 — o Bling devolve o link e o arquivo é um ZIP (corrigido no #79), mas a IMPRESSÃO
      // lê `etiqueta.pdf` do cache do pedido: se o ciclo não passou por ele depois do conserto,
      // sai só a NF (foi o que aconteceu com o pedido 26599886380). Aqui mostro o que está no
      // cache e, com &salvar=1, gravo a etiqueta AGORA — sem esperar o próximo ciclo.
      try {
        const dirD = path.join(CACHE_DIR, String(idE));
        const temZpl = fs.existsSync(path.join(dirD, 'etiqueta.zpl'));
        const temPdf = fs.existsSync(path.join(dirD, 'etiqueta.pdf'));
        const snapD = readJson(path.join(dirD, 'pedido.json'), null);
        out.cache = { pasta_existe: fs.existsSync(dirD), etiqueta_zpl: temZpl, etiqueta_pdf: temPdf,
          danfe_pdf: fs.existsSync(path.join(dirD, 'danfe.pdf')),
          manifesto_tem_etiqueta: !!(snapD && snapD.tem_etiqueta) };
        if (urlObj.searchParams.get('salvar') === '1' && !temPdf && !temZpl) {
          const pdfBuf = await baixarEtiquetaPDF(idE);
          if (pdfBuf && pdfBuf.length) {
            ensureDir(dirD);
            fs.writeFileSync(path.join(dirD, 'etiqueta.pdf'), pdfBuf);
            if (snapD) { snapD.tem_etiqueta = true; writeJson(path.join(dirD, 'pedido.json'), snapD); }
            try {
              const man = readJson(MANIFEST_FILE, {});
              if (man[idE]) { man[idE].tem_etiqueta = true; salvarManifest(man); }
            } catch (e) {}
            out.cache.salvo_agora = true; out.cache.bytes = pdfBuf.length;
          } else { out.cache.salvo_agora = false; out.cache.motivo = 'baixarEtiquetaPDF devolveu vazio'; }
        }
      } catch (e) { out.cache = { erro: String(e.message || e).slice(0, 160) }; }
      // contexto do pedido: loja (define o marketplace no ciclo) e se há logística registrada
      try {
        const rp = await blingGet('/pedidos/vendas/' + idE);
        const det = (rp && rp.ok && rp.data && rp.data.data) || null;
        if (det) out.pedido = {
          numero: det.numero || null, loja_id: (det.loja && det.loja.id) || null,
          numero_loja: det.numeroPedidoLoja || det.numeroLoja || null,
          situacao: (det.situacao && det.situacao.id) || null,
          tem_transporte: !!det.transporte,
          transportador: (det.transporte && det.transporte.transportador && det.transporte.transportador.nome) || null,
          rastreio: (det.transporte && det.transporte.volumes && det.transporte.volumes[0] && det.transporte.volumes[0].codigoRastreamento) || null
        };
      } catch (e) { out.pedido = { erro: String(e.message || e).slice(0, 160) }; }
      json(res, 200, out);
      return true;
    }

        if (method === 'GET' && p === '/good-checkout-offline/status') {
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
    if (method === 'GET' && p === '/good-checkout-offline/buscar-pedido') {
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








    /* 14/09 — histórico da GOOD. A delegação fica no FIM, logo antes do return false, na
       mesma posição que a Girassol usa: nenhuma rota declarada antes (/pedido/, /etiqueta/,
       /imprimir/…) casa com as seis do histórico, então a ordem de casamento não muda. */
    if (await hist(req, res, urlObj)) return true;

    /* 31/10 — DIAGNÓSTICO (peça única) por ÚLTIMO, pra não mudar a ordem de casamento das rotas que já existiam: as de
       raio-X que a GOOD já tinha neste arquivo continuam valendo; daqui vêm as que faltavam */
    if (await diag(req, res, urlObj)) return true;

    return false; // não tratou
  };
}

// roda 1 ciclo logo após o boot do serviço
// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
/* 14/09 — Codex P1 do #422 (AMB/Girassol) vale igual aqui: as três empresas (girassol, amb,
   good — config/empresas.js) sobem no MESMO processo (--max-old-space-size=340, o heap do
   incidente), e a tartaruga pós-boot da GOOD roda no MESMO instante (240s) que a das outras
   duas. Sem a trava, a GOOD ficava de fora da correção — livre pra sobrepor quem quer que
   esteja rodando a rodada pesada da vez, recriando o mesmo 503. custoSyncTravado cobre as
   duas portas desta empresa (tartaruga e disparo manual); a GOOD não tem custo-diário. */
const travaPesada = require('../lib/checkout/trava-pesada');
const _custoComp = require('../lib/custo-composicao');   /* Codex #693: decisão de custo por composição, a mesma da AMB/Girassol */
const _cst = _estadoRotinas.custo;   /* 01/10: estado por empresa, de lib/checkout/estado-rotinas */

/* 17/09 — PORTE: a AMB e a Girassol guardam o MOTIVO de cada falha do sync de custo; a GOOD só
   contava quantas foram. "3 falhas" não diz o que fazer — o SKU e o motivo dizem. Guarda as
   últimas 10, e o ?status=1 mostra. */
function _anotarFalhaCusto(sku, motivo) {
  try {
    if (!Array.isArray(_cst.falhas_detalhe)) _cst.falhas_detalhe = [];
    _cst.falhas_detalhe.unshift({ sku: String(sku || '?'), motivo: String(motivo || '?'), em: new Date().toISOString() });
    if (_cst.falhas_detalhe.length > 10) _cst.falhas_detalhe.length = 10;
  } catch (e) {}
}
async function custoSync(fresh) {
  /* componente resolvido pela API vale pra TODOS os kits desta varredura (igual AMB/Girassol) */
  const _memoComp = new Map();
  if (_cst.rodando) return;
  const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');
  const cc = readJson(CUSTO_FILE, {});
  const conf = readJson(CONFERIDOS_FILE, {});
  const todos = new Set();
  for (const c of Object.values(conf)) { for (const it of ((c && c.itens) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }

  /* 01/10 — O CUSTO-SYNC SÓ OLHAVA OS PEDIDOS CONFERIDOS, e isso explica o caso que o dono
     trouxe: ele abriu o PT-06-PRETO-1xLED no Bling e mostrou o custo lá, R$ 15,81, com a
     frase certa — "tem custo no Bling sim. Vc q não tá pegando direito".

     Estava mesmo. A rodada terminou 209/209 com ZERO falhas e o painel seguiu com 217 SKUs sem
     custo, porque os dois conjuntos são diferentes: `conferidos.json` tem o que passou pelo
     CHECKOUT (recente), e o painel calcula a margem sobre o HISTÓRICO inteiro — jan a set,
     13.327 pedidos que o backfill acabou de trazer. SKU vendido em fevereiro e não bipado
     agora nunca entrava na lista, então nunca era perguntado ao Bling.

     Agora o histórico entra junto. É de lá que vêm as 6.004 unidades sem custo que inflam o
     Lucro Bruto. */
  try {
    const _hs = readJson(path.join(CACHE_DIR, '_hist_skus.json'), null);
    /* Codex #560: SKU antigo coberto pelo de-para não existe mais no Bling — pergunta pelo
       DESTINO; o histórico já herda o custo dele (_comManual). */
    /* Codex #560 (P2, r2): guarda o ORIGINAL TAMBÉM, não só o destino. O `resolverDeParaSku`
       casa sem diferenciar maiúscula de minúscula, mas quem herda o custo no histórico procura
       pela chave COMO ELA ESTÁ no pedido. Se o histórico tem `pm1` e o de-para está gravado
       como `Pm1`, perguntar só pelo destino resolve o custo e o histórico continua sem achar —
       o SKU seguiria aparecendo como sem custo pra sempre, que é o bug que este PR conserta.
       Perguntar pelos dois custa nada: o destino resolve de fato, e o original fica no cache
       com a grafia que o histórico usa. */
    /* Codex #560 (P2, r5): QUANDO O DE-PARA APOSENTA UM SKU, não se pergunta pelo antigo. Eu
       tinha posto os DOIS na fila pra o histórico achar o custo pela grafia dele — mas desde a
       busca que ignora caixa, o `_comManual` já expõe o custo do destino sob a grafia antiga.
       Perguntar pelo código morto só gasta cota: o Bling não acha, vira falha registrada, e a
       falha se repete a cada retry porque não fica cache nenhum. Com muitos SKUs renomeados,
       isso atrasa justamente as buscas que resolvem.
       Só o DESTINO entra. SKU sem de-para continua indo como ele é. */
    if (_hs && Array.isArray(_hs.skus)) for (const sk of _hs.skus) {
      if (!sk) continue;
      const _orig = String(sk).trim();
      const _dest = resolverDeParaSku(_orig);
      todos.add(_dest ? String(_dest).trim() : _orig);
    }
  } catch (e) {}
  const SETE_D = 7 * 24 * 3600 * 1000;
  /* Codex #497 (P1): os SKUs já gravados pela lógica ANTIGA (limite=1) têm id, custo e carimbo
     recente — este filtro os pularia por 7 dias, e o conserto não alcançaria justamente o dado
     errado que ele existe pra corrigir. A marca `sel` diz qual seletor gravou a entrada. */
  const SEL_ATUAL = 'ativo-v1';
  /* Codex #497 (P1, r2): a /sku-info já descarta o custo em cache quando conclui "só cadastro
     excluído", mas este sync — que é quem POPULA `_custos.json` — seguia sem tocar `cc[sku]`
     nesse caso; o custo do produto apagado sobrevivia aqui indefinidamente. Agora vira lápide
     (`apagado_em`), e essa lápide não bate o Bling de novo a cada rodada — só depois de 30 dias
     (o cadastro pode voltar) ou se pedirem `fresh`. */
  const alvos = [...todos].filter(sk => {
    const k = cc[sk];
    if (k && k.apagado_em) { if (!fresh) return false; if ((Date.now() - k.apagado_em) < 30 * 86400000) return false; }
    return fresh || !k || !k.id || k.sel !== SEL_ATUAL || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null;
  });
  /* Codex #693 (P1): fila em ordem de PROFUNDIDADE de dependência — componente (0), kit (1),
     kit-de-kit (2)... — como na AMB/Girassol. Sem isto o kit podia vir antes do componente e
     somar o custo velho dele. Memoizado, teto 6 contra ciclo. */
  const _idxLower = {}; for (const sk0 of Object.keys(cc)) { if (sk0.startsWith('_')) continue; _idxLower[sk0.toLowerCase()] = sk0; const v0i = cc[sk0]; if (v0i && v0i.id) _idxLower['id:' + v0i.id] = sk0; }
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
      let _falhaConsulta = false;   /* custo ausente por 429/erro (preservar) ≠ ausente por decisão (limpar) */
      /* Codex #497 (r4): mesma troca da /sku-info — usa o resolvedor compartilhado
         (resolverProdutoPorSku) em vez da cópia inline, que era a 2ª cópia do mesmo bug. */
      const _res = await resolverProdutoPorSku(sku, bg2, 10);
      if (_res.produto && _res.produto.id) {
        const d = await bg2(`/produtos/${_res.produto.id}`);
        if (!d || !d.ok) _falhaConsulta = true;
        prod = (d && d.ok && d.data && d.data.data) || _res.produto;
      }
      if (prod && prod.id) {
        /* Codex #693 (P1): a decisão de custo é a MESMA da AMB/Girassol (lib/custo-composicao):
           produto com composição → a soma dos componentes manda; fornecedor só de reserva. */
        const _candDosFornecedores = async () => {
          const rf = await bg2(`/produtos/fornecedores?idProduto=${prod.id}&limite=5`);
          if (!rf || !rf.ok) { _falhaConsulta = true; return []; }
          const arr = (rf.data && rf.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          return pref ? [pref.precoCusto, pref.precoCompra].map(Number).filter(v => isFinite(v) && v > 0) : [];
        };
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
        const _custoNovo = _dec.custo != null ? Math.round(_dec.custo * 10000) / 10000 : null;
        /* mapa reverso kit→componentes (código minúsculo, senão 'id:<id>' — a estrutura do Bling
           costuma trazer só o ID): é o que o custo diário usa pra achar os kits a recalcular */
        const _compsSkus = (_custoComp.componentesDe(prod) || [])
          .map(cp => {
            const cod = (cp.produto && cp.produto.codigo) || cp.codigo;
            if (cod) return String(cod).toLowerCase().trim();
            const idc2 = (cp.produto && cp.produto.id) || cp.produto || cp.id || cp.idProduto;
            return idc2 ? ('id:' + idc2) : '';
          }).filter(Boolean);
        /* destinos do custo nulo: (a) FALHA de consulta → preserva o antigo SEM avançar ts (a
           tartaruga re-tenta); (b) resposta CONCLUSIVA sem candidato → grava null com ts novo;
           (c) custo novo → grava. Os comps só são trocados quando a fonte atual TROUXE estrutura. */
        const _antigo = cc[sku];
        const _conclusivo = !_falhaConsulta;
        const _custoFinal = (_custoNovo != null) ? _custoNovo : (_conclusivo ? null : ((_antigo && _antigo.custo != null) ? _antigo.custo : null));
        const _tsFinal = (_custoNovo != null || _conclusivo) ? Date.now() : ((_antigo && _antigo.ts) || 0);
        const _compsFinais = _compsSkus.length ? _compsSkus : ((!_conclusivo && _antigo && _antigo.comps) ? _antigo.comps : null);
        /* 21/08: antes de sobrescrever, anota a linha do tempo — o Bling só guarda o custo
           ATUAL, então esta é a única chance de registrar que até ontem valia outro. */
        if (_custoNovo != null) { try { registrarCustoVigente(sku, _custoNovo, 'bling'); } catch (e) {} }
        else if (_conclusivo && _antigo && _antigo.custo != null) { try { registrarCustoVigente(sku, null, 'remocao-bling'); } catch (e) {} }
        const _idAntes = (cc[sku] && cc[sku].id) || null;
        cc[sku] = Object.assign({ id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: _custoFinal, ts: _tsFinal, sel: SEL_ATUAL }, _compsFinais && _compsFinais.length ? { comps: _compsFinais } : {});
        /* Codex #497 (P2): se o id MUDOU, o sku-info em cache aponta pro cadastro antigo (o
           excluído) e continuaria servindo saldo e preço dele até expirar sozinho. */
        if (_idAntes && _idAntes !== prod.id) {
          try { _produtoAtivo._limparSkuInfo(sku); } catch (e) {}
          console.log('[CUSTO] ' + sku + ': id mudou de ' + _idAntes + ' para ' + prod.id + ' (cadastro ativo) — sku-info invalidado');
        }
        _cst.ok++;
      } else if (_res.todosExcluidos) {
        /* Codex #497 (P1, r2): confirmado — só existe cadastro EXCLUÍDO no Bling pra este SKU, em
           TODAS as variantes, sem nenhuma busca ter falhado. É o "sister cost-sync path" que o
           Codex apontou: a /sku-info já descartava o custo do cadastro apagado, mas quem
           POPULA `_custos.json` seguia sem apagar `cc[sku]` — o valor errado sobrevivia aqui até
           ser sobrescrito por acaso. Vira lápide: sem id/custo, com o carimbo de quando foi
           confirmado, pra não bater o Bling de novo a cada rodada (grace de 30 dias no filtro). */
        const _custoApagado = cc[sku] && cc[sku].custo;
        cc[sku] = { apagado_em: Date.now(), motivo: 'só havia cadastro excluído no Bling' };
        try { _produtoAtivo._limparSkuInfo(sku); } catch (e) {}
        _cst.ok++;
        console.log('[CUSTO] ' + sku + ': só havia cadastro EXCLUÍDO no Bling — custo removido dos DOIS caches (era ' + JSON.stringify(_custoApagado) + ')');
      } else { _cst.falhas++; _anotarFalhaCusto(sku, _res.inconclusivo ? ('busca inconclusiva — ' + _res.motivo) : 'o Bling não devolveu o produto (resposta sem dados)'); }
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
  _cst.rodando = false;
  console.log('[CUSTO] sync concluiu — ok=' + _cst.ok + ' falhas=' + _cst.falhas + ' de ' + _cst.total);
  /* Codex #560 (r4): devolve quantos alvos seguem SEM custo (falha transitória do Bling ou produto
     achado com custo null) — quem disparou o sync pelo histórico precisa saber pra tentar de novo. */
  return alvos.filter(sk => { const k = cc[sk]; return !(k && (k.apagado_em || Number(k.custo) > 0)); }).length;
}

/* ═══ 14/10 — CUSTO DIÁRIO NA GOOD ════════════════════════════════════════════════════════════
   Girassol e AMB têm, desde 10/09, a rotina das 23h que pergunta ao Bling o que mudou de custo no
   dia, recalcula o que depende disso (kits inclusos) e fecha o dia com um carimbo que sobrevive a
   restart — é ela que decide a margem do dia seguinte. A GOOD não tinha (a rota /custo-diario
   respondia "falta custoDiario"). A peça é a MESMA (lib/checkout/custo-diario.js, com teste
   próprio); aqui só as dependências da GOOD. A trava pesada do processo coordena com as outras
   duas empresas (AMB 23h00, Girassol 23h15): adiada, o próximo disparo tenta de novo. */
const CUSTO_FILE_DIARIO = path.join(CACHE_DIR, '_custos.json');   /* o mesmo arquivo que o custoSync monta */
const _custoDiarioMod = require('../lib/checkout/custo-diario').criar({
  empresa: 'good',
  CUSTO_FILE: CUSTO_FILE_DIARIO,
  readJson,
  escrever: (p, o) => require('../lib/escrita-atomica').gravarAtomico(p, JSON.stringify(o)),
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

/* 14/09 — cobre as duas portas que chamam custoSync nesta empresa (tartaruga pós-boot e
   disparo manual) com a trava do processo. Adia sem enfileirar — não é opcional: sem isto,
   a rodada de custo daqui podia sobrepor a rodada pesada de QUALQUER uma das outras duas
   empresas do mesmo processo, recriando o 503 de 13/09. */
let _custoRetentando = false;
let _custoRetryEm = 0;   // prazo real (epoch ms) do retry pendente — o status lê daqui
function custoRetryPendente() {
  if (!_custoRetentando || !_custoRetryEm) return null;
  return { em: new Date(_custoRetryEm).toISOString(), em_min: Math.max(0, Math.ceil((_custoRetryEm - Date.now()) / 60000)) };
}
let _custoTentativas = 0;   // rodadas seguidas disparadas pelo histórico que terminaram com SKU sem custo
const CUSTO_TENTATIVAS_MAX = 5;   // SKU sem custo de verdade no Bling não pode virar loop eterno de 3 em 3 min
/* Codex #560 (P2, r5): aceita a ESPERA como parâmetro. Padrão 3 min (trava ocupada, sobra
   dentro do teto); 1h depois do teto, quando a sobra é por falha de requisição — aí a causa é
   externa e pode durar, então insistir de 3 em 3 min só martela a cota da conta. */
function _agendarRetryCusto(esperaMs) {
  if (_custoRetentando) return;
  _custoRetentando = true;
  const _ms = (Number.isFinite(Number(esperaMs)) && Number(esperaMs) > 0) ? Number(esperaMs) : 3 * 60 * 1000;
  _custoRetryEm = Date.now() + _ms;
  const _t = setTimeout(() => { _custoRetentando = false; _custoRetryEm = 0; try { custoSyncTravado(false, true).catch(() => {}); } catch (e) {} }, _ms);
  if (_t.unref) _t.unref();
}
async function custoSyncTravado(fresh, retentar) {
  const _t = travaPesada.tentarEntrar('custo-sync:good');
  if (!_t.ok) {
    console.log('[CUSTO] sync adiado — outra rotina pesada em curso (' + _t.ocupadoPor + ', há ' + _t.haMin + ' min)');
    /* Codex #560 (r3): quem pediu por SKU novo do histórico não pode ser descartado — a lista já
       foi gravada e nada mais dispara o sync. Um único retry pendente, a cada 3 min, até a trava
       liberar (o custoSync relê a lista inteira ao entrar). */
    /* 02/10 — O STATUS PRECISA DIZER QUE ESTÁ NA FILA. O dono rodou, viu `0/0` com
       `inicio: null`, e leu como "não fez nada" — quando era "estou esperando a trava". Ficamos
       várias idas e vindas nisso, e a informação existia aqui dentro o tempo todo, só não
       chegava na tela. Status que esconde o motivo é tão ruim quanto status errado. */
    /* Codex #566 (P2): SÓ MARCA QUANDO VAI VOLTAR. Sem retry, o pedido morre ali — e deixar
       "na fila" gravado faria o status mentir pra sempre, dizendo que alguém ainda vai tentar
       quando ninguém vai. É o mesmo erro que este PR conserta, do avesso: antes escondia o
       motivo, agora prometeria um retry que não existe.
       Sem retry, NÃO mexe na marca nem no timer: são de quem agendou o retry (Codex #566, r3). */
    if (retentar) {
      _cst.esperando_trava = { por: _t.ocupadoPor, ha_min: _t.haMin, desde: new Date().toISOString(), vai_retentar: true };
      _agendarRetryCusto();
    } else {
      /* não toca em _cst.esperando_trava nem no timer: esse estado é de quem agendou o retry */
      console.log('[CUSTO] pedido avulso descartado (sem retry) — a trava está com ' + _t.ocupadoPor);
    }
    return false;
  }
  delete _cst.esperando_trava;   /* entrou: não está mais na fila */
  try {
    const _sobrou = await custoSync(fresh);
    /* Codex #560 (r4): a lista do histórico já está no disco, então o gatilho por "SKU novo"
       não dispara de novo. Sobrou SKU sem custo → refaz em 3 min, até CUSTO_TENTATIVAS_MAX. */
    /* Codex #560 (P2, r5): O TETO NÃO PODE VIRAR PARADA DEFINITIVA. Se o Bling estiver fora
       durante as 5 tentativas, zerar o contador e não remarcar nada deixa os SKUs sem custo
       até alguém rodar à mão — e nada mais dispara, porque a lista já está no disco.
       Distingo os dois motivos de sobrar SKU:
         · FALHA DE REQUISIÇÃO (rede, 429, 5xx) → passageira: segue tentando, mas em ritmo
           lento (1h) depois do teto, pra não martelar a cota durante uma queda longa;
         · produto achado SEM custo no Bling → não melhora sozinho: para e fica com o dono,
           que vê a lista no painel. */
    if (retentar) {
      if (_sobrou > 0 && ++_custoTentativas < CUSTO_TENTATIVAS_MAX) _agendarRetryCusto();
      else if (_sobrou > 0 && _cst.falhas > 0) _agendarRetryCusto(60 * 60 * 1000);
      else _custoTentativas = 0;
    }
    /* o agregado do histórico cacheado antes do sync traz a contagem/margem velhas */
    try { for (const _k of Object.keys(_histCacheGood)) delete _histCacheGood[_k]; } catch (e) {}

  }
  finally { travaPesada.sair('custo-sync:good'); }
}

// ─── VENDA DO DIA (19/10) — a MESMA peça da Girassol e da AMB (lib/checkout/vendas-dia.js) ─────────────────────
/* A GOOD não tinha a venda do dia (parecer de 15/10, item 5.2: "/vendas-sync: falta vendasSync"): o painel só via o
   que já tinha sido bipado. Agora a rotina traz TODAS as vendas do dia direto do Bling e dos marketplaces (ML, Shopee,
   Magalu, TikTok) e grava o _vendas_dia.json, como nas outras duas. Aqui fica só o que é da GOOD; as peças em volta
   vêm das mesmas libs que a AMB usa (fase direta, frete Magalu, pesca do ML, devoluções do ML, canal pelo nº). */
const _vsy = _estadoRotinas.vendas;
const _inferCanal = require('../lib/checkout/inferir-canal').inferirCanal;
const { pescarDadosML } = require('../lib/ml-pesca');
const { buscarDevolucoesML } = require('../lib/vendas-ops');
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
    /* as situações de cancelamento DA GOOD (cache por empresa no gbo-app desde o #686 — o mesmo do histórico diário) */
    garantirSitCancel: (bg) => require('../girassol-backup-offline/gbo-app').garantirSitCancel(bg, 'good'),
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

let _pescaGood = null;   /* 27/10: a pescaria da GOOD (criada na 1ª chamada da rota) */

// ─── MADRUGADA ÚNICA (27/10) — a MESMA rotina da Girassol e da AMB (lib/checkout/noturna-empresa) ───────────────
/* Antes a GOOD tinha tarefas soltas na subida do servidor (uma por PR); agora as mesmas etapas das outras, na mesma ordem,
   ligadas conforme o que ela tem. Sem o módulo da Shopee (devoluções, carteira, Ads), sem o resgate do histórico (vai com
   a unificação do backfill) e sem a poda do bucket (é o mesmo bucket, as outras podam): essas etapas não aparecem. O
   backfill dos últimos dias é a rotina diária da GOOD (respeita GOOD_DIARIO_HISTORICO=0 e as travas dela). */
function _backfillGoodOcupado() {
  let gOc = false;
  try { const g = require('../girassol-backup-offline/gbo-app'); gOc = typeof g.backfillOcupado === 'function' ? !!g.backfillOcupado('good') : false; } catch (e) {}   /* 29/10 (3a): o DA GOOD */
  return !!((_bfGoodAno && _bfGoodAno.rodando) || (_bfGood && _bfGood.estado === 'rodando') || (_diarioGood && _diarioGood.estado === 'rodando') || gOc);
}
const _noturnaGood = require('../lib/checkout/noturna-empresa').criarNoturna({
  empresa: 'good', prefixo: '/good-checkout-offline',
  mlBillingSync: (...a) => mlBillingSync(...a),
  backfillVendas: async () => {
    const r = await rodarDiarioHistoricoGood('noturna');
    if (r && r.estado === 'desligado') return { ok: false, msg: 'GOOD_DIARIO_HISTORICO=0 (a rotina diária do histórico está desligada)' };
    /* a rotina devolve estado 'ok' ou 'parou' (com `motivo`), nunca 'erro' e sem `ok`: só 'ok' vale como feito */
    if (!r || r.estado !== 'ok') return Object.assign({}, r || {}, { ok: false, msg: (r && (r.motivo || r.msg)) || ('rotina diária terminou como "' + ((r && r.estado) || 'sem resposta') + '"') });
    return Object.assign({}, r, { ok: true });
  },
  backfillEstado: () => {
    return { rodando: _backfillGoodOcupado(), de: (_bfGood && _bfGood.de) || (_bfGoodAno && _bfGoodAno.rodando ? 'ano' : null), ate: (_bfGood && _bfGood.ate) || null };
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
    try { x = await require('../lib/checkout/contexto-fundo').emFundo('good', () => require('../girassol-backup-offline/gbo-app').backfillVendas(dia, dia, 'good', _ctxBackfillGood())); }
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
   avisa) e a faixa no painel pro admin (/canario-estado). Sem módulo da Shopee na GOOD: esse canal fica de fora. */
const _packsMLGood = require('../lib/checkout/packs-ml').criar({ MLB_FILE: (...a) => MLB_FILE(...a), readJson });
const _canGood = require('../lib/checkout/canario-empresa').criarCanarioDaEmpresa('good', {
  deps: () => ({ blingGet, LOJA_MKT, irmasDoPack: _packsMLGood._irmasDoPack, CACHE_DIR, pedirAoSync: null, fetch }),
  /* o backfill DA GOOD (o do período, o do plano do ano e a vaga compartilhada): o canário espera */
  ocupado: () => {
    let gOc = false;
    try { const g = require('../girassol-backup-offline/gbo-app'); gOc = typeof g.backfillOcupado === 'function' ? !!g.backfillOcupado('good') : false; } catch (e) {}   /* 29/10 (3a): o DA GOOD */
    const r = !!((_bfGoodAno && _bfGoodAno.rodando) || (_bfGood && _bfGood.estado === 'rodando') || (_diarioGood && _diarioGood.estado === 'rodando') || gOc);
    return { rodando: r, de: _bfGood && _bfGood.de, ate: _bfGood && _bfGood.ate, do_ano: !!(_bfGoodAno && _bfGoodAno.rodando) };
  },
});

function bootstrap() {
  // 13/10 (Codex #672): o trabalho que a GOOD agenda AQUI (pesca pos-deploy, custos, ciclo de boot, varreduras) e de
  // FUNDO — roda no contexto das rotinas, entao as chamadas ao Bling dele pedem a vez ao porteiro (lib/checkout/base-funcoes)
  const _timers = require('timers'); const { comoFundo } = require('../lib/checkout/contexto-fundo');
  const setTimeout = (fn, ms) => _timers.setTimeout(comoFundo('good-checkout-offline.bootstrap', fn), ms);
  const setInterval = (fn, ms) => _timers.setInterval(comoFundo('good-checkout-offline.bootstrap', fn), ms);
  /* 15/10: 3 min depois do boot, o plano do backfill retoma de onde parou — sem ninguém pedir.
     Codex #696 r2 (P1): fica DEPOIS do setTimeout local acima — antes dele, a chamada caía na zona
     morta do `const setTimeout` e o bootstrap inteiro da GOOD abortava em produção. */
  setTimeout(() => { _motorPlanoGood.tocar().catch(e => console.error('[plano-good] boot:', e.message)); }, 3 * 60000);
  /* 24/10 — A EMPRESA SE PREPARA SOZINHA: histórico do ano vazio (e nenhum plano) → cria o plano do ano, que roda fora
     do galpão. Foi o que faltou na GOOD: o ano só começou quando o dono pediu, uma semana depois de ligada. */
  setTimeout(async () => {
    try {
      const r = await require('../lib/checkout/saude-dados-empresa').prepararSozinha('good', {
        supa: require('../lib/supabase').para('good'),
        inicioVendas: require('../lib/checkout/config-empresa').configCheckout('good').inicioVendas,
        planoExiste: () => !!_fatGood.ler(CACHE_DIR),
        criarPlanoAno: async (de, ate) => { const pl = _fatGood.criar(CACHE_DIR, de, ate, 10); _motorPlanoGood.tocar().catch(() => {}); return { ok: !!pl, fatias: pl && pl.fatias ? pl.fatias.length : 0 }; },
      });
      console.log('[GOOD preparar] ' + r.motivo);
    } catch (e) { console.error('[GOOD preparar]', e.message); }
  }, 4 * 60000);
  /* 19/10: VENDA DO DIA — mesmo ritmo do agendador da AMB e da Girassol: 2,5 min depois do boot e a cada 5 min (a
     rotina tem trava própria: se uma rodada ainda está andando, a próxima não começa outra) */
  setTimeout(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 150 * 1000);
  setInterval(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 5 * 60 * 1000);
  /* 19/10: CANCELADOS — 1x/dia (45 dias pra trás), o diário ANCORADO fora do horário do galpão (o mesmo do agendador
     da AMB e da Girassol; Codex #716: o intervalo nasce do tiro adiado e cada execução confere a janela) */
  require('../lib/checkout/contexto-fundo').agendarDiarioForaDoGalpao(() => varrerCancelados(45), 15 * 60 * 1000, { setTimeout, setInterval });
  /* 27/10: o canário (vendas e integrações), o financeiro e as devoluções do TikTok e os cancelamentos da Magalu, que
     rodavam aqui como tarefas soltas, passaram pra MADRUGADA ÚNICA (lib/checkout/noturna-empresa — a mesma da Girassol e
     da AMB): cron 'noturna' lá embaixo. Ficam aqui os mesmos três diários fora do galpão das outras (pesca, custos,
     cancelados). */
  /* 19/10: FATURAMENTO DO ML — mesmo ritmo do agendador da AMB e da Girassol (25 min depois do boot e 1x/dia, os 3
     últimos períodos; ao fim de cada rodada a peça distribui os créditos do Flex) */
  setTimeout(() => { try { mlBillingSync(3).catch(() => {}); } catch (e) {} }, 25 * 60 * 1000);
  setInterval(() => { try { mlBillingSync(3).catch(() => {}); } catch (e) {} }, 24 * 3600 * 1000);

  // PESCA AUTOMÁTICA PÓS-DEPLOY: todo deploy mata a pesca em andamento; aqui ela renasce sozinha
  // 90s depois do boot (após o ciclo inicial). Com dias=14 só re-checa os recentes — barato e idempotente.
  setTimeout(() => { try { console.log('[ML-FEES] pesca automática pós-deploy iniciando…'); mlSyncFees(14).catch(() => {}); } catch (e) {} }, require('../lib/checkout/contexto-fundo').adiarForaDoGalpao(90 * 1000));   // 13/10: so fora do galpao
  setTimeout(() => { try { custoSyncTravado(false).catch(() => {}); } catch (e) {} }, require('../lib/checkout/contexto-fundo').adiarForaDoGalpao(240 * 1000));   // custos: tartaruga pós-boot, só o que falta — trava do processo (14/09)
  // ETIQUETA PARADA: enquanto existir pedido sem etiqueta, tenta de novo a cada 5 min (o cron normal é 10/10).
  // Em dia limpo (0 sem etiqueta) NADA extra roda — custo zero. Cobre etiqueta que o canal demora a gerar.
  setInterval(() => {
    try {
      const r = getUltimoResumo();
      if (r && r.semEtiqueta > 0) { console.log('[CICLO-EXTRA] ' + r.semEtiqueta + ' pedido(s) sem etiqueta \u2014 rodando ciclo extra'); rodarCiclo('auto-etiqueta').catch(() => {}); }
    } catch (e) {}
  }, 5 * 60 * 1000);

  ensureDir(CACHE_DIR);
  console.log(`[GOODBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  setTimeout(() => rodarCiclo('boot'), 20000);
}

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
    return c.tarifa_ml == null || c.venda_em == null || t >= recheck;
  }).map(([cid]) => cid);
  if (!alvos.length) { console.log('[ML-FEES] nada a pescar (' + dias + 'd)'); return { ok: true, nada: true }; }
  _mls = { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, iniciado_em: new Date().toISOString(), erros: {}, amostras: [] };
  console.log('[ML-FEES] pescando tarifas de ' + alvos.length + ' pedido(s) ML...');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  let tokenML = null;
  try { const { garantirTokenML } = require('../good/mlTokenManager'); tokenML = await garantirTokenML(); }
  catch (e) { _mls.rodando = false; console.log('[ML-FEES] ✗ sem token ML: ' + e.message); return _mls; }
  const pend = {};
  const salvar = () => {
    if (!Object.keys(pend).length) return;
    const c2 = readJson(CONFERIDOS_FILE, {});
    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; }
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
        const reg = { fee: Math.round(fee * 100) / 100, frete: null, venda: venda, _orders: ords.length };
        if (shipId) {
          try {
            const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H);
            const ds = await rs.json().catch(() => null);
            if (rs.ok && ds) {
              const lc = Number(ds.list_cost), cc = Number(ds.cost);
              if (isFinite(lc) && isFinite(cc) && lc >= cc) reg.frete = Math.round((lc - cc) * 100) / 100;
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
  id: 'good-checkout-offline',
  nome: 'GOOD Checkout Offline',
  rotinas: { backupCache: () => rodarCiclo('cron'), backfillNF: () => backfillNFLocal(45), mlSyncFees: () => mlSyncFees(14),   /* 27/10: 14 dias às 04h40, como a Girassol e a AMB — os 60 dias são da madrugada */ shopeeKeepAlive: () => shopeeKeepAlive(),
             noturna: () => _noturnaGood.rotinaNoturna('cron'),
             cacaMagalu: () => _cacaMgGood.cacaMagaluCron(),   /* 29/10: a caça de vendas da Magalu (era só da AMB) */   /* 27/10: a madrugada única (o backfill dos últimos dias é a rotina diária, dentro dela) */
             /* 14/10: custo diário — 23h30/23h45 fecha o dia; de madrugada recupera o de ontem se a trava adiou */
             custoDiario: () => custoDiario(), custoDiarioRecupera: () => custoDiario() },   /* 14/10: o histórico da GOOD anda sozinho todo dia */
  routes,
  crons: { backupCache: CRON_EXPR, backfillNF: '15 4 * * *', mlSyncFees: '40 4 * * *', noturna: '0 4 * * *', custoDiario: '30,45 23 * * *', custoDiarioRecupera: '*/20 0-5 * * *', cacaMagalu: '45 * * * *' /* 29/10: a caça da Magalu de hora em hora */, shopeeKeepAlive: '25 */3 * * *'   /* 27/08: 2x/dia deixava a sessao morrer por desuso; a cada 3h cada toque renova cookies via set-cookie */ },
  bootstrap
};
