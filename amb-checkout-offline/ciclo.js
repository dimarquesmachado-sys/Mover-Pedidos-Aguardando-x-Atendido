// ════════════════════════════════════════════════════════════════════════
//  amb-checkout-offline · módulo ciclo  (motor de sincronização — Lote 2)
//  Dono do estado: rodando / ultimoResumo / ultimoSync / idxStatus.
//  As rotas leem esse estado pelos getters exportados (getUltimoResumo, etc.).
// ════════════════════════════════════════════════════════════════════════
'use strict';
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const base  = require('./base');
const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE,
  ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;
const { parseNF, acharNFporRange, nfDoPedido, serieDaNFdoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = require('./nf');
const { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf } = require('./etiquetas');
const { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = require('./comum');
const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = require('./produtos');
const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = require('./arquivo');
const { montarSeparacao, montarSeparacaoPorPedido } = require('./separacao');

// ─── estado do ciclo (mutável; lido pelas rotas via getters) ───
let rodando = false;
let rodandoDesde = 0;   // watchdog: se um ciclo pendurar (fetch sem resposta), a flag ficava presa e TODO cron seguinte era pulado em silencio
let ultimoResumo = { rodouEm: null, total: 0, comEtiqueta: 0, semEtiqueta: 0, novos: 0, erros: 0 };
let ultimoSync = { em: null, pendentes: 0, ok: 0, falhas: 0 };
let idxStatus = { rodando: false, feitos: 0, eans: 0, em: null, fim: null, erro: null };
function getUltimoResumo() { return ultimoResumo; }
function getUltimoSync()   { return ultimoSync; }
function getIdxStatus()    { return idxStatus; }

async function indexarCatalogoCompleto() {
  if (idxStatus.rodando) return;
  idxStatus = { rodando: true, feitos: 0, eans: 0, em: new Date().toISOString(), fim: null, erro: null };
  const novo = lerIndiceEan();                       // parte do que já existe
  const PAUSA = Number(process.env.AMBBKP_PAUSA_MS || 700);
  try {
    let pagina = 1;
    while (pagina <= 500) {                           // trava de segurança
      const r = await blingGet(`/produtos?pagina=${pagina}&limite=100`);
      const itens = (r.ok && r.data && r.data.data) || [];
      if (!itens.length) break;
      for (const it of itens) {
        idxStatus.feitos++;
        if (!it.id) continue;
        let eans = getPossiveisGtins(it).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8);
        let nome = it.nome, sku = it.codigo;
        if (!eans.length) {                            // lista não trouxe GTIN → busca no detalhe
          const det = await produtoDetalhe(it.id);
          await sleep(PAUSA);
          if (det) { eans = getPossiveisGtins(det).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8); nome = det.nome || nome; sku = det.codigo || sku; }
        }
        for (const e of eans) { if (!novo[e]) idxStatus.eans++; novo[e] = { sku: sku || '', nome: nome || '', id: it.id }; }
      }
      writeJson(EAN_INDEX_FILE, novo);                 // salva a cada página (resiliente a queda)
      await sleep(PAUSA);
      pagina++;
    }
  } catch (e) { idxStatus.erro = String(e && e.message || e); }
  writeJson(EAN_INDEX_FILE, novo);
  idxStatus.rodando = false;
  idxStatus.fim = new Date().toISOString();
}

async function sincronizarConferidos() {
  const conf = readJson(CONFERIDOS_FILE, {});
  const ids = Object.keys(conf).filter(id => conf[id] && !conf[id].sincronizado);
  let ok = 0, falhas = 0, jaAvancados = 0;
  for (const id of ids) {
    const r = await moverSituacao(id, SIT_VERIFICADO);
    if (r.ok) {
      conf[id].sincronizado = true;
      conf[id].sincronizado_em = new Date().toISOString();
      delete conf[id].sync_erro;
      ok++;
      console.log(`[AMBBKP] sync ${id} → ${SIT_VERIFICADO} OK`);
    } else {
      // Falha ao mover: confere se o pedido JÁ AVANÇOU (saiu de ATENDIDO por outro
      // processo — despachado/faturado). Se não está mais em ATENDIDO, o sync já não
      // é necessário: marca como resolvido em vez de "falha" (evita ruído no /saude).
      let situAtual = null, sumiu = false;
      try {
        const g = await blingGet(`/pedidos/vendas/${id}`);
        const ped = g && g.data && (g.data.data || g.data);
        situAtual = ped && ped.situacao && Number(ped.situacao.id);
        // 28/07: pedido EXCLUÍDO no Bling responde 404. Antes isso caía no "falha" e o sync
        // tentava de novo TODO ciclo, pra sempre — enchendo o log com o mesmo erro.
        if (g && Number(g.status) === 404) sumiu = true;
      } catch (e) {}
      if (!situAtual && Number(r.status) === 404) sumiu = true;
      if (situAtual && situAtual !== SIT_ATENDIDO) {
        conf[id].sincronizado = true;
        conf[id].sincronizado_em = new Date().toISOString();
        conf[id].sync_resolvido = 'ja-avancado:' + situAtual;
        delete conf[id].sync_erro;
        jaAvancados++;
        console.log(`[AMBBKP] sync ${id}: já avançou p/ situacao ${situAtual} (resolvido, sem mover)`);
      } else if (sumiu) {
        // não existe mais no Bling: não há o que sincronizar — encerra e para de tentar
        conf[id].sincronizado = true;
        conf[id].sincronizado_em = new Date().toISOString();
        conf[id].sync_resolvido = 'pedido-excluido-no-bling';
        delete conf[id].sync_erro;
        jaAvancados++;
        console.log(`[AMBBKP] sync ${id}: pedido não existe mais no Bling (excluído) — encerrado, não tenta mais`);
      } else {
        conf[id].sync_erro = String(r.status || 'err');
        falhas++;
        console.log(`[AMBBKP] sync ${id} FALHOU (${r.status}) ${r.raw || ''}`);
      }
    }
    await sleep(PAUSA_MS);
  }
  if (ids.length) writeJson(CONFERIDOS_FILE, conf);
  ultimoSync = { em: new Date().toISOString(), pendentes: ids.length, ok, falhas, jaAvancados };
  return ultimoSync;
}

async function listarAtendidos() {
  const hoje = new Date();
  const ini  = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
  const qs = `idSituacao=${SIT_ATENDIDO}&dataEmissaoInicial=${dataISO(ini)}&dataEmissaoFinal=${dataISO(hoje)}`;
  const out = [];
  let fetchOk = false;
  let completa = false;              // só true se a paginação foi até o fim SEM falhar no meio
  let paginasRefeitas = 0, falhouNaPagina = null;
  for (let pagina = 1; pagina <= 50; pagina++) {
    // 13/08 — uma falha isolada (429/timeout do Bling) fazia a lista voltar INCOMPLETA e a
    // reconciliação era pulada TODA vez. Efeito medido na Girassol: 9 pedidos ML já despachados
    // presos como "sem etiqueta" no painel. Cada página é re-tentada antes de desistir.
    // (22/08: só a Girassol tinha isso — a paridade por feature revelou que AMB e GOOD não.)
    let ok = false, data = null;
    for (let tent = 1; tent <= 4; tent++) {
      // Codex PR#53: o node-fetch v2 usado pelo blingGet NÃO tem timeout por padrão — se o Bling
      // aceita a conexão e não responde, o await ficava pendurado pra sempre: o ciclo travava e
      // a re-tentativa (o motivo deste PR) nunca acontecia. Cada tentativa tem prazo próprio.
      const TETO_MS = 45000;
      // Codex (#183): o Promise.race rejeitava só a ESPERA — o fetch seguia vivo dentro do
      // blingGet, e cada página estourada deixava até 4 conexões penduradas, acumulando a cada
      // ciclo até esgotar recurso. Agora o AbortController cancela a requisição de verdade, e o
      // timer é limpo no sucesso pra não segurar o processo à toa.
      const _ac = new AbortController();
      const _tm = setTimeout(() => _ac.abort(), TETO_MS);
      try {
        ({ ok, data } = await blingGet(`/pedidos/vendas?${qs}&pagina=${pagina}&limite=100`, 3, _ac.signal));
      } catch (e) { ok = false; data = null; console.log('[AMBBKP] página ' + pagina + ' tentativa ' + tent + ': ' + String(e.message || e).slice(0, 80)); }
      finally { clearTimeout(_tm); }
      if (!ok && _ac.signal.aborted) console.log('[AMBBKP] página ' + pagina + ' tentativa ' + tent + ': timeout ' + TETO_MS + 'ms (abortada)');
      if (ok) { if (tent > 1) paginasRefeitas++; break; }
      await new Promise(r => setTimeout(r, 1200 * tent));
    }
    if (pagina === 1) fetchOk = ok;        // marca se o Bling respondeu (p/ não limpar cache offline)
    const lista = (data && data.data) || [];
    // ⚠️ ANTES: um !ok na página 2+ saía do loop e a lista PARCIAL era devolvida como ok=true —
    // a reconciliação então apagava do cache todo pedido que faltou (levando junto etiqueta anexada).
    if (!ok) { falhouNaPagina = pagina; break; }   // falhou 4× → completa fica FALSE
    if (lista.length === 0) { completa = true; break; }
    out.push(...lista);
    if (lista.length < 100) { completa = true; break; }
    await sleep(PAUSA_MS);
  }

  // ── FILTRO FULL ──────────────────────────────────────────────────────
  // Vendas de fulfillment (Shopee Full, Magalu Full…) entram no Bling em
  // situação ATENDIDO mas NÃO passam pelo galpão. A unidade de negócio Full
  // identifica essas vendas.
  //
  // ⚠️ DOIS problemas descobertos na API do Bling (30/07, via sonda):
  //  (1) a unidade vem em pedido.loja.unidadeNegocio.id — NÃO no topo do
  //      pedido. (O HTML da tela chama de idConfUnidadeNegocio, que não
  //      existe no JSON.)
  //  (2) a lista /pedidos/vendas OMITE unidadeNegocio de forma INTERMITENTE
  //      — duas chamadas idênticas, uma traz o campo, a outra não. Por isso,
  //      quando a lista não traz a unidade, buscamos o DETALHE do pedido
  //      (/pedidos/vendas/{id}), que sempre traz.
  //
  // Configurável por env AMBBKP_UN_FULL = "2920348,2920232". VAZIA = não
  // filtra nada (idêntico ao comportamento antigo).
  const UN_FULL = String(process.env.AMBBKP_UN_FULL || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  let ocultosFull = 0;
  let pedidos = out;
  const idsFullVistos = [];   // ids que se confirmaram Full (p/ expurgar do cache antigo)
  let ocultosSemSerie = [];   // Full pela unidade, mas série não descoberta: esconde da fila, NÃO move
  /* ⚠️ 25/08, corrigido À NOITE com o dono: o ML FULL EMITE SÉRIE 1 — POR NÓS.
     A regra de ontem ("série 1 = emissão própria = NÃO é Full") nasceu do padrão da Shopee
     e Magalu Full, onde a NF vem ESPELHADA do marketplace (série ≠1). No ML a premissa é
     FALSA: as 407 notas de agosto da filial Full MLivre são todas série 1, emitidas pela
     matriz — e o ML posta do galpão dele mesmo assim. Resultado da regra antiga: venda Full
     real do ML era "desescondida" e aparecia na fila do estoquista como sem-etiqueta (4
     pedidos em <24h de deploy, e ia crescer um a cada venda).
     Nas unidades listadas aqui, série 1 NÃO derruba o Full — ela é a nota final do pedido,
     e confirma o move. O custo assumido (decisão do dono): clone de garantia de venda ML
     Full volta a ser movido como era antes do incidente — não há como separar pelo número
     da série, já que ambos são série 1. Shopee/Magalu Full seguem com a trava intacta. */
  const UN_EMISSAO_PROPRIA = new Set(String(process.env.AMBBKP_UN_FULL_EMISSAO_PROPRIA || '2839148')
    .split(',').map(s => s.trim()).filter(Boolean));
  const unPorFull = new Map();                                 // id do pedido -> unidade que o classificou
  if (UN_FULL.length) {
    const setFull = new Set(UN_FULL);
    // lê a unidade das duas formas possíveis na lista
    /* ⚠️ 24/08 — SÓ VALE A UNIDADE DA LOJA. A sonda de 30/07 (comentário acima) já tinha
       achado que a unidade do Full vem em `pedido.loja.unidadeNegocio.id`, e NÃO no topo do
       pedido. Mesmo assim havia um segundo caminho lendo o topo — e era por ali que vazava:
       pedido criado À MÃO dentro do Bling não tem loja de marketplace, escapava do caminho
       certo, caía no topo e recebia a unidade PADRÃO da empresa. Se essa unidade estivesse na
       lista do Full, TODO pedido interno virava "Full" e ia parar em DESPACHADOS.
       Caso real na AMB em 24/08: pedidos 26687588614 e 3902 (26687728978), NF série 1 gerada
       automaticamente, mandados pra DESPACHADOS no mesmo minuto, repetidamente a cada ciclo.
       Full é venda de marketplace (Shopee Full, ML Full, Magalu Full); pedido sem loja NUNCA
       é Full. Sem loja com unidade Full → devolve null e o pedido não é tocado. */
    const unDaLista = (p) => (p && p.loja && p.loja.unidadeNegocio && p.loja.unidadeNegocio.id) || null;
    // 1ª passada: decide pelo que a lista trouxe; junta os "sem unidade" p/ checar no detalhe
    const indefinidos = [];
    for (const p of out) {
      const un = unDaLista(p);
      if (un != null) {
        if (setFull.has(String(un))) { ocultosFull++; idsFullVistos.push(String(p.id)); unPorFull.set(String(p.id), String(un)); }
      } else if (p && p.loja) {
        indefinidos.push(p);   // TEM loja mas a lista omitiu a unidade → precisa do detalhe
      } else {
        /* 24/08: sem loja nenhuma = pedido criado à mão no Bling. Nunca é Full, então buscar o
           detalhe não mudaria a classificação — só gastaria uma chamada + PAUSA_MS por pedido,
           a cada 10 min, nos 5 dias da janela. Com muitos pedidos internos isso queima cota
           do Bling e arrasta o ciclo inteiro. */
      }
    }
    // 2ª passada: só os indefinidos → busca o detalhe (que sempre traz a unidade)
    const idsFullSet = new Set(idsFullVistos);
    for (const p of indefinidos) {
      try {
        const det = await detalhePedido(p.id);
        // mesma regra do unDaLista: só a unidade da LOJA vale (ver o porquê logo acima)
        const un = (det && det.loja && det.loja.unidadeNegocio && det.loja.unidadeNegocio.id) || null;
        if (un != null && setFull.has(String(un))) { ocultosFull++; idsFullVistos.push(String(p.id)); unPorFull.set(String(p.id), String(un)); idsFullSet.add(String(p.id)); }
      } catch (e) { /* se o detalhe falhar, não esconde — melhor mostrar que sumir por engano */ }
      await sleep(PAUSA_MS);
    }
    /* ═══ SÉRIE DA NF DECIDE (24/08, revisto) ═════════════════════════════════════════════
       Clonar pedido no Bling COPIA a unidade de negócio. O clone de uma venda Full nasce
       carimbado como Full mesmo saindo do galpão DELES, e o filtro acertava em cima de um
       dado errado. Série 1 = emissão nossa, da matriz → não é Full.

       ⚠️ CORREÇÃO DO QUE FOI AO AR ÀS 20:12 DE 24/08: eu tratava "não consegui descobrir a
       série" como se fosse Full, e o pedido era MOVIDO. O log provou o estrago: o pedido
       26687588614 (NF 003464, série 1) foi protegido às 20:12 e MOVIDO às 20:15 — mesmo
       pedido, 3 minutos depois. A diferença foi um 429 do Bling na consulta da NF (o log
       está cheio deles). Não saber NÃO pode autorizar uma ação destrutiva.

       Agora as duas decisões são separadas, porque o risco de errar é assimétrico:
         · ESCONDER da fila  → na dúvida, ESCONDE (se for Full de verdade, o estoquista não
           pode ir procurar mercadoria que está no galpão do marketplace)
         · MOVER/EXPURGAR    → na dúvida, NÃO MEXE (mover é destrutivo e só se desfaz na mão;
           deixar quieto custa um ciclo de espera até a consulta funcionar)

       E a série descoberta fica GUARDADA por pedido: uma vez que se sabe, um 429 depois não
       desfaz mais a proteção. */
    if (idsFullVistos.length) {
      const SERIE_FILE = path.join(CACHE_DIR, '_serie_nf.json');
      const serieCache = readJson(SERIE_FILE, {});
      const derrubados = [], semResposta = [], venceuEspera = [];
      const _consultaFalhou = new Set();   // Bling não respondeu — diferente de 'não tem NF'
      let mudouCache = false;
      for (const idF of idsFullVistos.slice()) {
        /* O cache tem VALIDADE (30 min) e a regra é simples: VENCIDO NÃO VALE.
           Se a renovação funcionar, usa o valor novo. Se falhar (429), fica DESCONHECIDA —
           que já é o estado seguro: esconde da fila e NÃO move.

           Eu tinha tentado ser esperto aqui, mantendo o valor vencido quando ele era série 1,
           e errei nos dois sentidos (Codex #195):
             · uma série 1 vencida cuja NF foi trocada por uma Full faria o pedido APARECER
               pro estoquista, que iria procurar mercadoria parada no galpão do marketplace;
             · e a linha que anulava o vencido rodava mesmo quando a renovação tinha dado
               certo — um Full confirmado voltava pra "desconhecida" e nunca era movido.
           Vencido = desconhecido resolve os dois, e não perde o objetivo original: um 429
           continua não conseguindo MOVER nada. */
        const chaveS = String(idF);
        const guardado = serieCache[chaveS];
        const valeAinda = guardado && guardado.ts && (Date.now() - Number(guardado.ts)) <= 30 * 60 * 1000;
        let info = valeAinda ? guardado : null;
        if (!valeAinda) {
          let nfF = null;
          try { nfF = await serieDaNFdoPedido(idF); } catch (e) { nfF = { falhou: true }; }
          await sleep(PAUSA_MS);
          if (nfF && nfF.falhou) _consultaFalhou.add(String(idF));   // não foi "sem NF" — foi não perguntei
          if (nfF && nfF.serie) {
            info = { serie: String(nfF.serie), nf: nfF.numero || null, ts: Date.now() };
            serieCache[chaveS] = info; mudouCache = true;
          }
        }
        /* ⚠️ LIMPA O RELÓGIO SEMPRE QUE DESCOBRIU A SÉRIE — inclusive na série 1 (Codex #199).
           Antes a limpeza só acontecia no ramo do Full confirmado. Um clone visto primeiro
           SEM nota e depois identificado como série 1 ficava com o `espera:` antigo gravado;
           passados os 30 min do cache da série, uma consulta que temporariamente não achasse
           a nota leria aquele carimbo como "6h já se passaram" e MOVERIA o clone protegido,
           em vez de começar uma espera nova. */
        /* ⚠️ marcar mudouCache: apagar só na memória não reescreve o _serie_nf.json, e o
           carimbo velho ressuscita no próximo boot — voltando a autorizar o move do clone
           protegido. Só marca quando a chave EXISTIA, pra não gravar o arquivo à toa. */
        if (info && serieCache['espera:' + chaveS]) { delete serieCache['espera:' + chaveS]; mudouCache = true; }
        if (info && String(info.serie) === '1' && !UN_EMISSAO_PROPRIA.has(String(unPorFull.get(String(idF)) || ''))) {
          derrubados.push({ id: idF, nf: info.nf });
          const ix = idsFullVistos.indexOf(idF);
          if (ix >= 0) idsFullVistos.splice(ix, 1);
          ocultosFull--;                                        // sai da contagem: não é Full
        } else if (!info) {
          /* ⚠️ "não sei a série" é CEDO, não é PARA SEMPRE (corrigido 25/08).
             A NF do Full vem ESPELHADA do marketplace e demora a chegar no Bling — nas
             primeiras horas o pedido legitimamente não tem nota. Eu tratei isso como estado
             permanente e o resultado foi 3 Full de verdade (2 Shopee Full + 1 Magalu Full)
             parados em ATENDIDO indefinidamente, ciclo após ciclo.
             Agora a espera tem PRAZO: marco quando comecei a tentar e, passadas 6h sem
             descobrir a série, movo — a unidade continua dizendo Full e já esperei o
             suficiente. O clone de garantia não é afetado: o Bling emite a NF dele ao
             SALVAR, então ele tem série 1 desde o primeiro minuto e cai no ramo de cima. */
          /* ⚠️ O RELÓGIO SÓ CORRE QUANDO O BLING CONFIRMOU QUE NÃO HÁ NOTA (Codex #199).
             `serieDaNFdoPedido` devolve vazio por DOIS motivos diferentes: o pedido não tem
             NF, ou a consulta não foi (429, Bling fora). Contar os dois igual significaria
             que 6h de 429 movem o pedido sem eu NUNCA ter olhado a nota — e se fosse um
             clone de garantia, seria exatamente o estrago que esta trava existe pra impedir.
             Consulta que falhou não avança o relógio: espera e tenta de novo. */
          if (_consultaFalhou.has(String(idF))) {
            semResposta.push(String(idF));                      // não perguntei ainda: espera, sem contar tempo
          } else {
            /* ⚠️ Codex #199 (P1): o relógio conta TEMPO CONFIRMADO, não tempo de parede.
               O desenho anterior guardava só o `desde`: se o marcador nascesse e viessem 6h
               de 429, a PRIMEIRA resposta boa depois da pane encontraria o carimbo velho e
               moveria o pedido na hora — 6h "vencidas" sem NENHUMA confirmação no meio.
               Agora cada resposta "sem NF" soma ao acumulado apenas o intervalo desde a
               confirmação anterior, com teto de 30 min por passo: ciclos normais (10 min)
               somam inteiros; uma pane de horas entre duas confirmações soma no máximo 30
               min. Falha continua sem tocar no marcador (ramo do _consultaFalhou acima).
               Marcador antigo, só com `desde`, recomeça do zero — o lado seguro. */
            const espera = serieCache['espera:' + chaveS];
            const agoraE = Date.now();
            if (!espera || !espera.ult) {
              serieCache['espera:' + chaveS] = { desde: agoraE, ult: agoraE, acum: 0 };
              mudouCache = true;
              semResposta.push(String(idF));                    // 1ª confirmação de "sem NF": começa o relógio
            } else {
              const passo = Math.max(0, Math.min(agoraE - Number(espera.ult), 30 * 60 * 1000));
              espera.acum = Number(espera.acum || 0) + passo;
              espera.ult = agoraE;
              mudouCache = true;
              if (espera.acum < 6 * 60 * 60 * 1000) {
                semResposta.push(String(idF));                  // ainda não somou 6h confirmadas
              } else {
                venceuEspera.push(String(idF));                 // 6h CONFIRMADAS sem nota: MOVE
              }
            }
          }
        }
      }
      if (mudouCache) { try { writeJson(SERIE_FILE, serieCache); } catch (e) {} }
      if (derrubados.length) {
        console.log(`[AMBBKP] série 1 derrubou o Full em ${derrubados.length} pedido(s) (emissão nossa, provável clone de venda Full): ` +
          derrubados.map(d => `pedido ${d.id}/NF ${d.nf}`).join(', '));
      }
      if (venceuEspera.length) {
        console.log(`[AMBBKP] série não veio em 6h — movendo assim mesmo (a unidade diz Full e a NF do marketplace não chegou): ` + venceuEspera.join(', '));
      }
      if (semResposta.length) {
        console.log(`[AMBBKP] série NÃO descoberta em ${semResposta.length} pedido(s) — NÃO vou mover (fica em ATENDIDO até dar pra conferir): ` + semResposta.join(', '));
        // some da lista de move/expurgo, mas segue escondido da fila (risco assimétrico)
        for (const idS of semResposta) {
          const ix = idsFullVistos.indexOf(idS);
          if (ix >= 0) idsFullVistos.splice(ix, 1);
        }
        ocultosSemSerie = semResposta.slice();
      }
    }

    // aplica: esconde da fila os Full confirmados E os que ainda não deu pra conferir
    const idsFullFinal = new Set(idsFullVistos.concat(ocultosSemSerie).map(String));
    pedidos = out.filter(p => !idsFullFinal.has(String(p.id)));
    if (ocultosFull) console.log(`[AMBBKP] filtro Full: ${ocultosFull} pedido(s) ocultado(s) da fila do estoquista (UN ${UN_FULL.join(',')}; ${indefinidos.length} checado(s) por detalhe)`);
  }

  return { ok: fetchOk, completa, pedidos, ocultosFull, idsFullVistos, idsSemSerie: ocultosSemSerie,
           paginas_refeitas: paginasRefeitas, falhou_na_pagina: falhouNaPagina };
}

async function detalhePedido(id, signal) {
  // signal opcional: sem prazo, uma resposta que nunca chega pendura o await pra sempre
  const { data } = await blingGet(`/pedidos/vendas/${id}`, 3, signal);
  return data && data.data;
}

async function cachearPedido(ped, cacheEan, nfs, kitCache, locC, nfCtx) {
  const id  = ped.id;
  const dir = path.join(CACHE_DIR, String(id));
  ensureDir(dir);

  const lojaId = String((ped.loja && ped.loja.id) || '');
  const mkt = LOJA_MKT[lojaId] || 'outro';   // marketplace (usado p/ etiqueta MM e snapshot)

  const itens = [];
  let temKit = false;
  for (const it of (ped.itens || [])) {
    const itemQty = Number(it.quantidade || 0);
    const prodId  = it.produto && it.produto.id;
    const prod    = await produtoDetalhe(prodId); await sleep(PAUSA_MS);
    const sku     = it.codigo || (prod && prod.codigo) || (it.produto && it.produto.codigo) || '';
    const eanItem = prod ? primeiroEan(prod) : await eanDoItem(prodId, sku, cacheEan);
    if (sku && eanItem) cacheEan[sku] = eanItem;
    if (sku && locC) locC[sku] = localizacaoDeProduto(prod);     // localização do produto principal
    const descr   = it.descricao || (prod && prod.nome) || '';
    const imgItem = primeiraImagem(prod);

    const comps = (prod && prod.estrutura && Array.isArray(prod.estrutura.componentes))
      ? prod.estrutura.componentes : [];

    if (comps.length) {
      // KIT / composição → explode nos componentes (com cache por produto-pai)
      temKit = true;
      let base = kitCache && kitCache[prodId];
      if (base && base.some(c => !c.sku)) base = null;   // cache tinha componente vazio (falha anterior) → resolve de novo
      if (!base) {
        base = [];
        let incompleto = false;
        for (const c of comps) {
          const info = await infoProduto(c.produto && c.produto.id, cacheEan);
          if (!info.sku) incompleto = true;
          base.push({ sku: info.sku, ean: info.ean, descricao: info.descricao, img: info.img, loc: info.loc, qtd: Number(c.quantidade || 1) });
        }
        if (kitCache && !incompleto) kitCache[prodId] = base;   // SÓ grava se TODOS resolveram (não fixa falha transitória)
      }
      if (locC) base.forEach(c => { if (c.sku) locC[c.sku] = c.loc || locC[c.sku] || ''; }); // localização dos componentes
      // qtd final = qtd do componente no kit × qtd do kit no pedido
      const componentes = base.map(c => ({ sku: c.sku, ean: c.ean, descricao: c.descricao, img: c.img, qtd: c.qtd * (itemQty || 1) }));
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, valor_unit: (it.valor != null ? Number(it.valor) : null), valor_total: (it.valor != null ? Number(it.valor) * (itemQty || 1) : null), tipo: 'kit', componentes });
    } else {
      const tipo = (prod && prod.variacao && prod.variacao.produtoPai) ? 'variacao' : 'simples';
      itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, valor_unit: (it.valor != null ? Number(it.valor) : null), valor_total: (it.valor != null ? Number(it.valor) * (itemQty || 1) : null), tipo });
    }
  }

  let nf = acharNFnaLista(id, nfs || [], { numeroLoja: ped.numeroLoja, usadasIds: nfCtx && nfCtx.usadasIds, donoPorNumero: nfCtx && nfCtx.donoPorNumero });
  if (nf && nf._ambigua) { console.log(`[NF-CASA] pedido ${id}: faixa ambígua (NF disputada por outro pedido) → usando vínculo direto`); nf = null; }
  if (!nf || !nf.id) { nf = await nfDoPedido(id); await sleep(PAUSA_MS); }   // fora do range do lote (ou ambíguo) → vínculo direto pedido→NF
  if (nf && nf.id && nfCtx) {
    if (nfCtx.usadasIds) nfCtx.usadasIds.add(Number(nf.id));
    if (nfCtx.donoPorNumero && nf.numero != null) nfCtx.donoPorNumero[String(nf.numero)] = String(id);
  }
  // AUTO-CURA: se a NF deste pedido MUDOU vs cache anterior, DANFE/nf-simp antigas são de OUTRA nota → descarta p/ re-baixar as certas
  try {
    const _snapAnt = readJson(path.join(dir, 'pedido.json'), null);
    const _antId = _snapAnt && _snapAnt.nf && _snapAnt.nf.id;
    if (_antId && (!nf || Number(nf.id) !== Number(_antId))) {
      // porte (Codex): NF ANEXADA à mão? preserva o danfe.pdf (é o arquivo que o admin
      // subiu) mas o nf-simp.json morre do mesmo jeito — ele é dado PARSEADO da nota
      // antiga, e a DANFE simplificada e a etiqueta fundida imprimem dele.
      const _anexada = !!(_snapAnt && _snapAnt.nf_anexada);
      for (const fdel of (_anexada ? ['nf-simp.json'] : ['danfe.pdf', 'nf-simp.json'])) { try { fs.unlinkSync(path.join(dir, fdel)); } catch (e) {} }
      console.log(`[NF-CASA] pedido ${id}: NF corrigida (${_antId} → ${(nf && nf.id) || 'nenhuma'}) — DANFE antiga descartada`);
    }
  } catch (e) {}

  const _etqPath = path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
  const _etqPdfPath = path.join(dir, 'etiqueta.pdf');
  let temEtiqueta = fs.existsSync(_etqPath);   // etiqueta ZPL imutável → se já tem, não re-baixa (re-cache leve)
  let etqEhPdf = false;
  if (temEtiqueta) {
    try { if (fs.readFileSync(_etqPath, 'utf8').indexOf('^XA') < 0) etqEhPdf = true; } catch (e) {}   // arquivo salvo não é ZPL → etiqueta PDF
  } else if (fs.existsSync(_etqPdfPath) && mkt !== 'madeira') {
    temEtiqueta = true; etqEhPdf = true;          // já tem só o PDF cacheado (Amazon etc) — Madeira tem bloco próprio abaixo
  } else {
    const conteudoEtiqueta = await baixarEtiqueta(id); await sleep(PAUSA_MS);
    if (conteudoEtiqueta && conteudoEtiqueta.indexOf('^XA') >= 0) {       // ZPL de verdade (ML, Shopee...)
      fs.writeFileSync(_etqPath, conteudoEtiqueta); temEtiqueta = true;
    } else if (conteudoEtiqueta || mkt === 'amazon') {                    // veio não-ZPL, OU é Amazon (cujo link ZPL vem nulo) → etiqueta é PDF
      // captura o PDF nativo do Bling AGORA (ele ainda serve); depois do despacho ele para de servir e o email ficaria sem etiqueta.
      // o "|| mkt==='amazon'" pega o caso da Amazon (sem ZPL); ML/Shopee com falha transitória NÃO caem aqui (ficam p/ o próximo ciclo).
      try { const pdf = await baixarEtiquetaPDF(id); await sleep(PAUSA_MS); if (pdf && pdf.length) { fs.writeFileSync(_etqPdfPath, pdf); temEtiqueta = true; etqEhPdf = true; } } catch (e) {}
    }
  }
  // FALLBACK ML: Bling sem logística cadastrada (ex: pedido que ficou dias travado no ML sem NF —
  // o Bling não registra o envio e o /logisticas/etiquetas dá 404 pra sempre).
  // → baixa a etiqueta ZPL direto do Mercado Livre (shipment_labels) com o token ML da empresa.
  if (!temEtiqueta && mkt === 'ml' && ped.numeroLoja) {
    try {
      const { garantirTokenML } = require('../ambtotal/mlTokenManager');
      const { getShipmentInfo, getShipmentSubstatus } = require('../ambtotal/mlApi');
      const tokenML = await garantirTokenML();
      const shipmentId = await getShipmentInfo(tokenML, ped.numeroLoja);
      const r = await fetch(`https://api.mercadolibre.com/shipment_labels?shipment_ids=${shipmentId}&response_type=zpl2`, { headers: { Authorization: `Bearer ${tokenML}` } });
      if (r.ok) {
        const buf = await r.buffer();
        let zpl = null;
        if (buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) {   // veio ZIP → extrai o .txt/.zpl de dentro
          const AdmZip = require('adm-zip');
          const zip = new AdmZip(buf);
          const ent = zip.getEntries().find(e => /\.(txt|zpl)$/i.test(e.entryName)) || zip.getEntries()[0];
          zpl = ent ? ent.getData().toString('utf8') : null;
        } else if (buf) {
          zpl = buf.toString('utf8');
        }
        if (zpl && zpl.indexOf('^XA') >= 0) {
          fs.writeFileSync(_etqPath, zpl); temEtiqueta = true;
          console.log(`[AMBBKP] etiqueta ${ped.numero} baixada DIRETO do ML (fallback, shipment ${shipmentId})`);
        } else {
          console.log(`[AMBBKP] fallback ML ${ped.numero}: resposta sem ZPL (etiqueta ainda não liberada no ML?)`);
        }
      } else {
        let det400 = ''; try { det400 = (await r.text()).slice(0, 220).replace(/\s+/g, ' '); } catch (e) {}
        let sub400 = ''; try { const st = await getShipmentSubstatus(tokenML, shipmentId); sub400 = `${st.status}/${st.substatus}`; } catch (e) {}
        console.log(`[AMBBKP] fallback ML ${ped.numero}: shipment_labels HTTP ${r.status} shipment=${sub400 || '?'} motivo=${det400}`);
      }
    } catch (e) { console.log(`[AMBBKP] fallback ML ${ped.numero}: ${String(e.message || e).slice(0, 160)}`); }
  }
  // FALLBACK SHOPEE (b15): quando o Bling não trouxe a etiqueta (importou o pedido depois do envio
  // já organizado, ou a NF travou a edição → /logisticas/etiquetas 404 pra sempre), busca a etiqueta
  // DIRETO na API oficial da Shopee, via o serviço shopee-nf-sync que guarda os tokens.
  // Vem em ZPL (a conta imprime térmico) — mesmo formato do Bling, cai no fluxo normal de impressão.
  // Modo &rapido=1: só baixa documento que já existe (~3s), sem create/polling, pra não travar o ciclo.
  // Precisa da env SHOPEE_SYNC_KEY; sem ela o bloco nem tenta.
  // 30/07 — FREIO: sem isso ele repete a MESMA chamada a cada 2 min pra sempre (o caso 2577
  // falhou 18x seguidas com o mesmo erro). Depois de 3 falhas, espera 1 hora antes de tentar de
  // novo naquele pedido. Assim para de gastar chamada (e de somar aos 429) num pedido que não
  // vai resolver sozinho — mas continua tentando de tempos em tempos, caso a Shopee libere.
  const _shKey = 'sh:' + String(ped.numeroLoja || ped.numero);
  const _shSt = _shFalhas.get(_shKey);
  const _shFreado = !!(_shSt && _shSt.n >= 3 && (Date.now() - _shSt.ts) < 3600000);
  if (_shFreado) {
    console.log(`[AMBBKP] fallback Shopee ${ped.numero}: em espera (${_shSt.n} falhas seguidas, pr\u00f3xima tentativa em ${Math.max(0, Math.round((3600000 - (Date.now() - _shSt.ts)) / 60000))} min)`);
  }
  if (!_shFreado && !temEtiqueta && mkt === 'shopee' && ped.numeroLoja && process.env.SHOPEE_SYNC_KEY) {
    try {
      const SH_URL = process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const urlEtq = SH_URL + '/amb/interno/etiqueta?rapido=1&k=' + encodeURIComponent(process.env.SHOPEE_SYNC_KEY) + '&order_sn=' + encodeURIComponent(String(ped.numeroLoja).trim());
      const rSh = await fetch(urlEtq, { timeout: 45000 });
      if (rSh.ok) {
        const bufSh = await rSh.buffer();
        const fmtSh = String(rSh.headers.get('x-etiqueta-formato') || '').toLowerCase();
        const ehZpl = fmtSh === 'zpl' || (bufSh && bufSh.slice(0, 400).toString('utf8').indexOf('^XA') >= 0);
        const ehPdfSh = fmtSh === 'pdf' || (bufSh && bufSh.slice(0, 4).toString('utf8') === '%PDF');
        if (bufSh && bufSh.length > 300 && ehZpl) {
          fs.writeFileSync(_etqPath, bufSh); temEtiqueta = true; _shFalhas.delete(_shKey);   // ZPL no caminho nativo
          console.log(`[AMBBKP] etiqueta ${ped.numero} baixada DIRETO da Shopee em ZPL (${bufSh.length} bytes)`);
        } else if (bufSh && bufSh.length > 300 && ehPdfSh) {
          fs.writeFileSync(_etqPdfPath, bufSh); temEtiqueta = true; etqEhPdf = true; _shFalhas.delete(_shKey);
          console.log(`[AMBBKP] etiqueta ${ped.numero} baixada DIRETO da Shopee em PDF (${bufSh.length} bytes)`);
        } else {
          console.log(`[AMBBKP] fallback Shopee ${ped.numero}: resposta sem etiqueta reconhecível`);
        }
      } else {
        // 30/07: o corte em 200 caracteres escondia justamente o que interessa — a lista
        // "selecionaveis" com os formatos que a Shopee aceita PRA ESTE pedido. Sem ela não dá
        // pra saber qual formato pedir. Agora vai inteiro (até 1200) e, quando dá pra ler o
        // JSON, destacamos o formato aceito numa linha própria.
        let detSh = ''; try { detSh = (await rSh.text()).slice(0, 1200).replace(/\s+/g, ' '); } catch (e) {}
        console.log(`[AMBBKP] fallback Shopee ${ped.numero}: HTTP ${rSh.status} ${detSh}`);
        try {
          const jSh = JSON.parse(detSh);
          const pPar = (jSh && jSh.passos || []).find(x => x && x.passo === 'parameter');
          if (pPar && Array.isArray(pPar.selecionaveis) && pPar.selecionaveis.length) {
            console.log(`[AMBBKP] \ud83d\udd0e Shopee ${ped.numero} (${ped.numeroLoja}): pedimos "${pPar.sugerido}" mas ela S\u00d3 ACEITA [${pPar.selecionaveis.join(', ')}] \u2014 \u00e9 esse o formato que o shopee-nf-sync precisa usar`);
          }
        } catch (e) {}
      }
    } catch (e) { console.log(`[AMBBKP] fallback Shopee ${ped.numero}: ${String(e.message || e).slice(0, 160)}`); }
    if (!temEtiqueta) { const a = _shFalhas.get(_shKey) || { n: 0 }; _shFalhas.set(_shKey, { n: a.n + 1, ts: Date.now() }); }
  }
  // MADEIRA MADEIRA não tem etiqueta no Bling. Se a etiqueta já está no mapa MM
  // (gerada por nós e sincronizada pela extensão), conta o pedido como PRONTO.
  let etiquetaMM = false, volumesMM = 1;
  if (!temEtiqueta && mkt === 'madeira') {
    const _mmPdf = path.join(dir, 'etiqueta.pdf');
    try {
      let bufMM = null;
      if (fs.existsSync(_mmPdf)) { bufMM = fs.readFileSync(_mmPdf); }   // já cacheado → reaproveita (não re-baixa)
      else {
        // Madeira Madeira: a AMBTotal não tem módulo MM (não vende nesse canal). Se um dia tiver,
        // basta criar /amb-mm-etiquetas que o require abaixo passa a achar sozinho.
        let mmEtq = null;
        try { mmEtq = require('../' + path.basename(__dirname).split('-')[0] + '-mm-etiquetas'); } catch (e) { mmEtq = null; }
        if (!mmEtq) { /* sem módulo MM nesta empresa → segue sem etiqueta Madeira */ }
        else {
        let regMM = null;
        for (const c of [ped.numeroLoja, nf && nf.numero].filter(Boolean)) { regMM = mmEtq.acharLote(c); if (regMM) break; }
        if (regMM && regMM.batch) {
          bufMM = await mmEtq.pdfPorBatch(regMM.batch);                 // 1 pedido = TODAS as etiquetas num PDF só
          if (bufMM && bufMM.length) { try { fs.writeFileSync(_mmPdf, bufMM); } catch (e) {} }   // cacheia p/ impressão offline rápida
        }
        }
      }
      if (bufMM && bufMM.length) {
        etiquetaMM = true;
        try { const { PDFDocument } = require('pdf-lib'); volumesMM = (await PDFDocument.load(bufMM)).getPageCount() || 1; } catch (e) {}   // volumes = nº de etiquetas (1 a 5)
      }
    } catch (e) {}
  }

  const _servico = servicoDoPedido(ped);
  const snapshot = {
    bling_id: id,
    numero: ped.numero || null,
    numero_loja: ped.numeroLoja || null,
    loja_id: lojaId || null,
    // 24/08: SÓ a unidade da LOJA (mesma regra do unDaLista). Gravar o topo do pedido aqui
    // fazia a reconciliação (que lê este snapshot) reclassificar pedido interno como Full.
    un_id: String((ped.loja && ped.loja.unidadeNegocio && ped.loja.unidadeNegocio.id) || ''),
    marketplace: mkt,
    servico: _servico,
    flex: ehFlex(_servico),
    situacao_id: (ped.situacao && ped.situacao.id) || SIT_ATENDIDO,
    cliente: (ped.contato && ped.contato.nome) || '',
    total: (ped.total != null ? Number(ped.total) : null),   // valor total do pedido (p/ faturamento no relatório)
    uf: (ped.transporte && ped.transporte.etiqueta && ped.transporte.etiqueta.uf) || null,           // estado do destinatário (dashboard: vendas por UF)
    venda_dia: (ped.data ? String(ped.data).slice(0, 10) : null),   // DATA DA VENDA (Bling, todos os canais) — atribui fim de semana ao dia certo
    taxa_mkt: (ped.taxas && isFinite(Number(ped.taxas.taxaComissao)) && Number(ped.taxas.taxaComissao) > 0) ? Math.round(Number(ped.taxas.taxaComissao) * 100) / 100 : null,   // 💎 comissão que o Bling importa do marketplace (TikTok/Shopee/Magalu…)
    frete_mkt: (ped.taxas && isFinite(Number(ped.taxas.custoFrete)) && Number(ped.taxas.custoFrete) > 0) ? Math.round(Number(ped.taxas.custoFrete) * 100) / 100 : null,        // frete informado pelo canal via Bling
    municipio: (ped.transporte && ped.transporte.etiqueta && ped.transporte.etiqueta.municipio) || null,
    nf,
    itens,
    tem_nf: !!nf,
    tem_danfe: fs.existsSync(path.join(dir, 'danfe.pdf')),   // por existência do arquivo → sobrevive a re-cache
    tem_kit: temKit,
    tem_etiqueta: temEtiqueta || etiquetaMM,
    etiqueta_formato: (etiquetaMM || etqEhPdf) ? 'PDF' : (temEtiqueta ? ETIQ_FORMATO : null),
    etiqueta_mm: etiquetaMM,
    etiqueta_pdf: !!(etiquetaMM || etqEhPdf),   // etiqueta é PDF (Madeira, Amazon...) → impressão/email usam o caminho PDF
    volumes: etiquetaMM ? volumesMM : 1,
    schema: SCHEMA,
    visto_em: (function () { try { const a = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')); return (a && (a.visto_em || a.cacheado_em)) || new Date().toISOString(); } catch (e) { return new Date().toISOString(); } })(),   // 1ª vez que ESTE pedido apareceu pro sistema — sobrevive a re-caches
    cacheado_em: new Date().toISOString()
  };
  // porte (Codex P1a): o snapshot novo NÃO carregava os carimbos de anexo — no ciclo
  // seguinte a guarda não via mais `nf_anexada` e a auto-cura apagava a NF que o admin
  // subiu; num anexo só de XML, o passo da DANFE baixava a nota CANCELADA de volta.
  // Os carimbos são do ADMIN, não do Bling — sobrevivem a qualquer re-cache.
  try {
    const _ant = readJson(path.join(dir, 'pedido.json'), null);
    if (_ant) {
      if (_ant.nf_anexada) {
        snapshot.nf_anexada = true;
        if (_ant.nf_numero && !snapshot.nf_numero) snapshot.nf_numero = _ant.nf_numero;
        if (_ant.nf_emissao && !snapshot.nf_emissao) snapshot.nf_emissao = _ant.nf_emissao;
        // 10/08 (Codex, PR#5): preservar TAMBÉM no objeto CANÔNICO. Lista, detalhe e
        // busca leem snapshot.nf.numero/dataEmissao e tem_nf — restaurar só o top-level
        // fazia esses fluxos voltarem pra nota velha do Bling (ou pra "sem nota").
        snapshot.nf = Object.assign({}, snapshot.nf || {},
          (_ant.nf && _ant.nf.chave) ? { chave: _ant.nf.chave } : {},
          _ant.nf_numero ? { numero: _ant.nf_numero } : {},
          _ant.nf_emissao ? { dataEmissao: _ant.nf_emissao } : {});
        if (_ant.nf_numero || (snapshot.nf && snapshot.nf.numero)) snapshot.tem_nf = true;
        if (fs.existsSync(path.join(dir, 'danfe.pdf'))) snapshot.tem_danfe = true;
      }
      if (_ant.etiqueta_anexada) {
        snapshot.etiqueta_anexada = true;
        snapshot.tem_etiqueta = true;
        if (_ant.etiqueta_pdf != null) snapshot.etiqueta_pdf = _ant.etiqueta_pdf;
        if (_ant.etiqueta_formato) snapshot.etiqueta_formato = _ant.etiqueta_formato;
      }
    }
  } catch (e) {}
  writeJson(path.join(dir, 'pedido.json'), snapshot);
  return snapshot;
}

// 30/07: quantas vezes seguidas a etiqueta da Shopee falhou em cada pedido (freio anti-martelo)
const _shFalhas = new Map();

async function rodarCiclo(motivo = 'cron', forcar = false) {
  if (rodando && rodandoDesde && (Date.now() - rodandoDesde) > 15 * 60 * 1000) {
    console.log('[CICLO] WATCHDOG: ciclo anterior pendurado h\u00e1 ' + Math.round((Date.now() - rodandoDesde) / 60000) + ' min \u2014 destravando e seguindo');
    rodando = false;
  }
  if (rodando) { console.log('[AMBBKP] ciclo já em andamento — pulei'); return ultimoResumo; }
  rodando = true;
  rodandoDesde = Date.now();
  limparProdCache();                       // zera cache de produto por ciclo
  const _kc = readJson(KIT_CACHE_FILE, {});
  const kitCache = (_kc && _kc._schema === SCHEMA && _kc.kits) ? _kc.kits : {}; // invalida se schema mudou
  const t0 = Date.now();
  let novos = 0, erros = 0;
  try {
    ensureDir(CACHE_DIR);
    console.log(`[AMBBKP] ▶ ciclo (${motivo})${forcar ? ' [FORCE]' : ''}`);
    const man      = manifest();
    const cacheEan = skuEanCache();
    const locC     = locCache();
    const { ok: listaOk, completa: listaCompleta, pedidos: atendidos, idsFullVistos, idsSemSerie, paginas_refeitas: pagRef, falhou_na_pagina: pagFalha } = await listarAtendidos();
    console.log(`[AMBBKP] ${atendidos.length} pedido(s) ATENDIDO(${SIT_ATENDIDO}) na janela de ${JANELA_DIAS}d (bling ok=${listaOk})`);

    // EXPURGO FULL: pedidos que a lista do Bling trouxe como Full mas que já
    // estavam no cache (cacheados ANTES do filtro existir) — remove do cache
    // uma vez, pra sumirem da fila do estoquista. Diferente da reconciliação,
    // aqui a remoção é SEGURA e desejada: sabemos que são Full (não é "lista
    // ruim do Bling"). Full não tem etiqueta de vendedor, então nada de valor
    // é perdido.
    if (Array.isArray(idsFullVistos) && idsFullVistos.length) {
      let expurgados = 0;
      for (const id of idsFullVistos) {
        if (man[id]) {
          try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
          delete man[id];
          expurgados++;
        }
      }
      if (expurgados) { salvarManifest(man); console.log(`[AMBBKP] expurgo Full: ${expurgados} pedido(s) Full removido(s) do cache (saíram da fila)`); }

      // MOVE FULL → DESPACHADOS: o Full já foi despachado pela Shopee (a
      // mercadoria saiu do CD dela), então o lugar dele no Bling é DESPACHADOS,
      // não ATENDIDO. Movemos por API, igual o F1 faz com o ML. Isso é
      // COMPLEMENTAR ao filtro: o filtro já tirou da fila do estoquista (o que
      // importa); o move só arruma a situação no Bling, de tempos em tempos.
      // Se o move falhar (429, rede), tudo bem — o filtro continua escondendo
      // e o move é tentado no próximo ciclo. AMBBKP_SIT_DESPACHADOS controla o
      // destino; se ficar 0/vazio, o move é DESLIGADO (só o filtro age).
      if (SIT_DESPACHADOS && Array.isArray(idsFullVistos) && idsFullVistos.length) {
        let movidos = 0, falhas = 0;
        for (const id of idsFullVistos) {
          try {
            const r = await moverSituacao(id, SIT_DESPACHADOS);
            if (r && r.ok !== false) movidos++; else falhas++;
          } catch (e) { falhas++; }
          await sleep(PAUSA_MS);
        }
        /* 24/08: o log dizia só "N movido(s)", sem dizer QUAIS — e foi por isso que levou horas
           pra descobrir se os movidos eram Full de verdade ou pedido interno. Agora lista os ids. */
        console.log(`[AMBBKP] move Full → DESPACHADOS(${SIT_DESPACHADOS}): ${movidos} movido(s)${falhas ? `, ${falhas} falha(s) (retenta no próximo ciclo)` : ''}` +
          (idsFullVistos.length ? ` — pedidos: ${idsFullVistos.join(', ')}` : ''));
      }
    }

    // RECONCILIAÇÃO: remove do cache quem NÃO está mais em ATENDIDO (enviado/processado).
    // Só roda se o Bling respondeu E veio algo — assim, se o Bling cair, o cache offline é preservado.
    if (listaOk && !listaCompleta) {
      console.log('[AMBBKP] ⚠️ lista do Bling veio INCOMPLETA (falhou no meio da paginação) — reconciliação PULADA, cache preservado');
    }
    /* 25/08 (fantasmas imortais): a guarda `atendidos.length > 0` protegia o cache de uma
       lista vazia suspeita — mas na AMB a fila fica LEGITIMAMENTE vazia (todos os pedidos de
       ATENDIDO são Full e somem no filtro), então a reconciliação era PULADA em silêncio em
       TODO ciclo e pasta órfã nunca saía (5 fantasmas com dias de idade, um deles o card
       "sem etiqueta" da Denise). Agora ela roda também com fila vazia DESDE QUE haja cache a
       conferir — e, nesse caso, SÓ pelo caminho da confirmação individual lá embaixo: pedido
       a pedido no Bling, nunca remoção em massa apoiada numa lista vazia. O espírito da
       guarda fica: lista vazia continua não podendo apagar nada sozinha. */
    if (listaOk && listaCompleta && (atendidos.length > 0 || Object.keys(man).length > 0)) {
      const idsAtuais = new Set(atendidos.map(p => String(p.id)));
      // Pedidos que estão em ATENDIDO mas foram OCULTADOS pelo filtro Full
      // (unidade de negócio de fulfillment) não podem contar como "sumiram":
      // eles continuam no Bling, só não aparecem na fila. Se já entraram no
      // cache numa versão anterior, mantemos — nunca removê-los aqui.
      const UN_FULL_REC = String(process.env.AMBBKP_UN_FULL || '').split(',').map(s => s.trim()).filter(Boolean);
      let idsFull = new Set();
      if (UN_FULL_REC.length) {
        try {
          const setF = new Set(UN_FULL_REC);
          for (const id of Object.keys(man)) {
            const snap = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
            /* 24/08: só confia no un_id de snapshot do SCHEMA atual. Os gravados antes traziam
               o fallback do topo do pedido, então um pedido interno apareceria aqui como Full e
               ficaria preso na fila offline até a retenção limpar. Snapshot velho é tratado como
               NÃO-Full, que é o comportamento seguro: ele volta a ser removido normalmente ao
               sair de ATENDIDO. O bump do SCHEMA reescreve esses snapshots sozinho. */
            const un = (snap && snap.schema === SCHEMA && snap.un_id) ? String(snap.un_id) : '';
            if (un && setF.has(un)) idsFull.add(String(id));
          }
        } catch (e) {}
      }
      /* ⚠️ PRESERVAR os de série desconhecida. Eles ficam escondidos da fila (não entram em
         `atendidos`) e foram tirados do idsFullVistos pra NÃO serem movidos — então cairiam
         nas duas peneiras e a reconciliação apagaria o cache deles como se tivessem saído de
         ATENDIDO, levando junto a ETIQUETA ANEXADA. O próprio arquivo avisa em outro ponto
         que é melhor não remover do que apagar etiqueta. */
      const preservar = new Set((idsSemSerie || []).map(String));
      const aRemover = Object.keys(man).filter(id => !idsAtuais.has(String(id)) && !idsFull.has(String(id)) && !preservar.has(String(id)));
      // TRAVA DE SEGURANÇA: sumir com muita coisa de uma vez quase sempre é lista ruim do Bling,
      // não 40% dos pedidos despachados no mesmo minuto. Melhor não remover do que apagar etiqueta anexada.
      const limiteSeguro = Math.max(5, Math.ceil(Object.keys(man).length * 0.4));
      /* fila vazia => confirmação individual OBRIGATÓRIA, qualquer que seja a proporção */
      if (aRemover.length > limiteSeguro || atendidos.length === 0) {
        // 02/08 — ANTES: abortava TUDO e o cache nunca encolhia. Numa empresa de volume menor a
        // remoção normal passa dos 40% com facilidade (AMB: 49 de 71 = 69%), então a trava disparava
        // em TODO ciclo. Pior: pedido preso no cache também nunca mais era reprocessado, porque a
        // fila parte da lista do Bling — por isso os "sem etiqueta" fantasmas nunca resolviam.
        // AGORA: em vez de confiar na proporção, PERGUNTAMOS ao Bling um por um. Só sai do cache
        // quem o Bling confirmar que existe e NÃO está mais em ATENDIDO. Lista ruim do Bling continua
        // sem apagar nada (a consulta individual falha ou devolve ATENDIDO), e limpeza legítima passa.
        console.log(`[AMBBKP] reconciliação: ${aRemover.length} de ${Object.keys(man).length} candidatos a sair — acima do limite (${limiteSeguro}), conferindo um a um no Bling…`);
        /* Codex #205 (P1×2): (a) o detalhePedido daqui não tinha prazo — Bling que aceita a
           conexão e emudece penduraria o ciclo inteiro, e o watchdog de 15 min empilharia
           ciclos por cima; o prazo vence POR FORA, numa corrida, porque o blingGet espera o
           token ANTES de olhar o sinal. (b) resposta com `situacao` OMITIDA caía no rmSync —
           deletar sem confirmação é exatamente o que este ramo não pode fazer, e o repo já
           documenta que o Bling omite situacao de vez em quando. Agora: só deleta com status
           NUMÉRICO e explicitamente ≠ ATENDIDO; omitido/ilegível conta como sem resposta. */
        const prazoDet = (fn, ms) => new Promise((resolva, rejeite) => {
          const ac = new AbortController();
          const tt = setTimeout(() => { ac.abort(); rejeite(new Error('prazo estourado')); }, ms || 20000);
          Promise.resolve().then(() => fn(ac.signal)).then(
            (vv) => { clearTimeout(tt); resolva(vv); },
            (ee) => { clearTimeout(tt); rejeite(ee); }
          );
        });
        let confirmados = 0, mantidos = 0, semResposta = 0;
        for (const id of aRemover) {
          let det = null;
          try { det = await prazoDet(sig => detalhePedido(id, sig)); } catch (e) { det = null; }
          if (!det) { semResposta++; continue; }                                  // Bling não respondeu → preserva
          const sitRaw = det.situacao != null ? (det.situacao.id != null ? det.situacao.id : det.situacao) : null;
          const sit = Number(sitRaw);
          /* Number(null) é 0 — FINITO — então checar só isFinite deixaria a situação OMITIDA
             passar como status 0 ≠ ATENDIDO e cair na remoção: o P1 de volta pela janela.
             O null tem que ser barrado ANTES da conversão. (meu teste pegou) */
          if (sitRaw == null || !Number.isFinite(sit)) { semResposta++; continue; }   // situação omitida/ilegível → NÃO confirmado → preserva
          if (sit === Number(SIT_ATENDIDO)) { mantidos++; continue; }             // ainda ATENDIDO → preserva
          try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
          delete man[id]; confirmados++;
          await new Promise(r => setTimeout(r, PAUSA_MS || 220));
        }
        if (confirmados) salvarManifest(man);
        console.log(`[AMBBKP] reconciliação conferida: ${confirmados} removido(s) · ${mantidos} seguem em ATENDIDO · ${semResposta} sem resposta do Bling (preservados)`);
      } else if (aRemover.length) {
        for (const id of aRemover) {
          try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
          delete man[id];
        }
        salvarManifest(man);
        console.log(`[AMBBKP] reconciliação: ${aRemover.length} pedido(s) saíram do ATENDIDO e foram removidos do cache`);
      }
    }

    // ESPELHO DO BLING: pedido que estava finalizado+sincronizado aqui mas VOLTOU pra ATENDIDO no Bling
    // (alguém reverteu lá) → desfinaliza aqui pra ele reaparecer na lista. Espelha a virada do Bling.
    if (listaOk && atendidos.length > 0) {
      const idsAtend = new Set(atendidos.map(p => String(p.id)));
      const conf = readJson(CONFERIDOS_FILE, {});
      let reabertos = 0;
      for (const id of Object.keys(conf)) {
        if (conf[id] && conf[id].sincronizado && idsAtend.has(String(id))) { delete conf[id]; reabertos++; }
      }
      if (reabertos) { writeJson(CONFERIDOS_FILE, conf); console.log(`[AMBBKP] espelho Bling: ${reabertos} pedido(s) voltaram pra ATENDIDO → desfinalizados (reaparecem na lista)`); }
    }

    // (re)processa quem não tem etiqueta OU está num schema antigo (ganha EAN+kit) OU tem kit incompleto no cache
    const aProcessar = atendidos.filter(ped => {
      if (forcar) return true;
      const ja = man[ped.id];
      if (ja && ja.tem_kit && kitIncompletoNoCache(ped.id)) return true;   // kit com componente vazio → re-resolve sozinho
      return !(ja && ja.tem_etiqueta && ja.schema === SCHEMA);
    });
    console.log(`[AMBBKP] ${aProcessar.length} a (re)processar`);

    // carrega as NFs recentes UMA vez (cobre o menor id do lote) e casa em memória
    let nfs = [];
    if (aProcessar.length) {
      const idMin = Math.min(...aProcessar.map(p => Number(p.id) || Infinity));
      if (Number.isFinite(idMin)) {
        nfs = await carregarNFs(idMin - 5);
        console.log(`[AMBBKP] ${nfs.length} NF(s) recentes carregadas p/ casar`);
      }
    }

    // ordem ASC por id: essencial p/ a exclusividade casar 1º pedido ↔ 1ª NF, 2º ↔ 2ª... (Bling emite em sequência)
    aProcessar.sort((a, b) => Number(a.id) - Number(b.id));
    // contexto anti-duplicidade do casamento NF×pedido (uma NF nunca em dois pedidos)
    const nfCtx = { usadasIds: new Set(), donoPorNumero: {} };
    for (const [mid, mm] of Object.entries(man)) { if (mm && mm.nf_numero != null) nfCtx.donoPorNumero[String(mm.nf_numero)] = String(mid); }

    for (const ped of aProcessar) {
      const id = ped.id;
      const ja = man[id];
      try {
        const det = await detalhePedido(id); await sleep(PAUSA_MS);
        if (!det) { erros++; continue; }
        const snap = await cachearPedido(det, cacheEan, nfs, kitCache, locC, nfCtx);
        man[id] = {
          numero: snap.numero, marketplace: snap.marketplace,
          servico: snap.servico || '', flex: !!snap.flex,
          // 10/08 (Codex, PR#6): com NF ANEXADA o campo do ADMIN ganha do que o Bling
          // ainda mostra — senão cada re-cache republicava o número da nota CANCELADA.
          cliente: snap.cliente || '', nf_numero: (snap.nf_anexada && snap.nf_numero) || (snap.nf && snap.nf.numero) || snap.nf_numero || null,
          tem_nf: snap.tem_nf, tem_kit: snap.tem_kit, tem_etiqueta: snap.tem_etiqueta,
          tem_danfe: !!((ja && ja.tem_danfe) || snap.tem_danfe),
          // 10/08: os CARIMBOS DE ANEXO no manifesto — o 5º ponto de leitura. O snapshot
          // preserva (b136), mas o manifesto era reconstruído com lista fixa de campos e
          // os perdia no re-cache (kit re-resolve toda rodada!) → o painel, que lê DAQUI,
          // deixava de mostrar os selos e voltava a tratar o pedido como não-anexado.
          nf_anexada: !!(snap.nf_anexada || (ja && ja.nf_anexada)),
          etiqueta_anexada: !!(snap.etiqueta_anexada || (ja && ja.etiqueta_anexada)),
          numero_loja: snap.numero_loja || null,
          nf_emissao: (snap.nf_anexada && snap.nf_emissao) || (snap.nf && snap.nf.dataEmissao) || snap.nf_emissao || null,   // data+hora OFICIAL da NF no Bling
          visto_em: snap.visto_em || null,
          itens: snap.itens.length, skus: (snap.itens || []).map(it => it.sku).filter(Boolean),
          // skus_pick = SKUs que o estoquista REALMENTE pega: kit/composição explode nos componentes; item normal usa o próprio SKU
          skus_pick: (snap.itens || []).flatMap(it => (it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.length) ? it.componentes.map(c => c.sku) : [it.sku]).filter(Boolean),
          schema: snap.schema, volumes: snap.volumes || 1, cacheado_em: snap.cacheado_em
        };
        if (!ja) novos++;
        salvarManifest(man);
        salvarSkuEan(cacheEan);
        salvarLoc(locC);
        writeJson(KIT_CACHE_FILE, { _schema: SCHEMA, kits: kitCache });
      } catch (e) { erros++; console.error(`[AMBBKP] erro pedido ${id}:`, e.message); }
      await sleep(PAUSA_MS);
    }

    // passo: baixa o DANFE que falta (TODOS — fica pronto p/ offline rápido)
    let danfesNovos = 0, danfesFalha = 0, danfesSemId = 0, danfesReparo = 0;
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'danfe.pdf'))) {
        // já tem o PDF — garante o flag tem_danfe (re-cache pode ter limpado o campo)
        const s = readJson(path.join(dir, 'pedido.json'), null);
        if (s && !s.tem_danfe) { s.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), s); danfesReparo++; }
        if (man[ped.id] && !man[ped.id].tem_danfe) { man[ped.id].tem_danfe = true; danfesReparo++; }
        continue;
      }
      const snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap || !snap.nf || !snap.nf.id) { danfesSemId++; continue; }
      // porte: NF anexada à mão NUNCA é re-baixada do Bling — o snap.nf.id ainda é o da
      // nota VELHA, então este passo restauraria a cancelada se o danfe.pdf sumisse.
      if (snap && snap.nf_anexada) { continue; }
      const pdf = await baixarDanfe(snap.nf.id); await sleep(PAUSA_MS);
      if (pdf) {
        fs.writeFileSync(path.join(dir, 'danfe.pdf'), pdf);
        snap.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), snap);
        if (man[ped.id]) man[ped.id].tem_danfe = true;
        danfesNovos++;
      } else { danfesFalha++; }
    }
    if (danfesNovos || danfesReparo) salvarManifest(man);
    console.log(`[AMBBKP] DANFE: ${danfesNovos} novos, ${danfesReparo} reparados, ${danfesFalha} falha, ${danfesSemId} sem nf.id`);

    // passo: cacheia os DADOS do DANFE SIMPLIFICADO (p/ imprimir 10x15 na Zebra OFFLINE)
    //        guarda o parsed (nf-simp.json) — o PDF é gerado na hora pela rota /danfe-simp
    let simpNovos = 0, simpFalha = 0, simpSemId = 0, simpCurados = 0;
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'nf-simp.json'))) continue;   // já tem
      const snap = readJson(path.join(dir, 'pedido.json'), null);
      if (!snap) { simpSemId++; continue; }
      // porte (Codex): NF anexada? não regerar o nf-simp daqui — o snap.nf.id ainda é o
      // da nota VELHA e este passo reconstruiria o arquivo com os dados fiscais da
      // CANCELADA. Melhor sem nf-simp (a rota cai no caminho normal) do que com o errado.
      if (snap.nf_anexada) { continue; }
      let nfId = snap.nf && snap.nf.id;
      if (!nfId) {   // re-cache antigo pode ter perdido o nf.id → acha ao vivo e CURA o snapshot
        try {
          const nf = await nfDoPedido(ped.id); await sleep(PAUSA_MS);
          if (nf && nf.id) {
            nfId = nf.id; snap.nf = nf; snap.tem_nf = true;
            writeJson(path.join(dir, 'pedido.json'), snap);
            if (man[ped.id]) { man[ped.id].tem_nf = true; man[ped.id].nf_numero = nf.numero || null; }
            simpCurados++;
          }
        } catch (e) {}
      }
      if (!nfId) { simpSemId++; continue; }
      try {
        const ds = await dadosNFSimp(nfId, snap.numero); await sleep(PAUSA_MS);
        if (ds) { writeJson(path.join(dir, 'nf-simp.json'), ds); simpNovos++; }
        else simpFalha++;
      } catch (e) { simpFalha++; }
    }
    if (simpCurados) salvarManifest(man);
    console.log(`[AMBBKP] DANFE-simp: ${simpNovos} novos, ${simpCurados} curados, ${simpFalha} falha, ${simpSemId} sem nf`);

    // passo: baixa a ETIQUETA em PDF (p/ modo A4 / fallback Zebra) — só de quem já tem ZPL
    let etqPdfNovos = 0;
    const extEtq = ETIQ_FORMATO.toLowerCase();
    for (const ped of atendidos) {
      const dir = path.join(CACHE_DIR, String(ped.id));
      if (fs.existsSync(path.join(dir, 'etiqueta.pdf'))) continue;
      if (!fs.existsSync(path.join(dir, `etiqueta.${extEtq}`))) continue;
      // porte (Codex P1c): ZPL veio de ANEXO do admin? NÃO baixar o PDF do Bling — o PDF
      // de lá é da etiqueta VELHA, e é ele que a impressão A4 e a /imprimir usam.
      try { const _s = readJson(path.join(dir, 'pedido.json'), null); if (_s && _s.etiqueta_anexada) continue; } catch (e) {}
      const pdf = await baixarEtiquetaPDF(ped.id); await sleep(PAUSA_MS);
      if (pdf) { fs.writeFileSync(path.join(dir, 'etiqueta.pdf'), pdf); etqPdfNovos++; }
    }
    if (etqPdfNovos) console.log(`[AMBBKP] ${etqPdfNovos} etiqueta(s) PDF cacheadas`);

    // passo: garante servico + flex no manifest (p/ filtro marketplace/FLEX) — lê detalhe só de quem falta
    let svcNovos = 0;
    for (const ped of atendidos) {
      const m = man[ped.id];
      if (!m || m.servico !== undefined) continue;
      const det = await detalhePedido(ped.id); await sleep(PAUSA_MS);
      const svc = servicoDoPedido(det);
      m.servico = svc; m.flex = ehFlex(svc);
      // aproveita p/ preencher o snapshot também
      const snapPath = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
      const snap = readJson(snapPath, null);
      if (snap) { snap.servico = svc; snap.flex = ehFlex(svc); writeJson(snapPath, snap); }
      svcNovos++;
    }
    if (svcNovos) { salvarManifest(man); console.log(`[AMBBKP] ${svcNovos} servico/flex preenchidos`); }

    // recalcula o flex de quem JÁ tem servico em cache (barato, sem Bling) — pega mudança nas FLEX_KEYWORDS
    let flexFix = 0;
    for (const ped of atendidos) {
      const m = man[ped.id];
      if (!m || m.servico === undefined) continue;
      const nf = ehFlex(m.servico);
      if (m.flex !== nf) {
        m.flex = nf;
        const sp = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
        const sn = readJson(sp, null);
        if (sn) { sn.flex = nf; writeJson(sp, sn); }
        flexFix++;
      }
    }
    if (flexFix) { salvarManifest(man); console.log(`[AMBBKP] ${flexFix} flex recalculado`); }

    // passo: aquece as LOCALIZAÇÕES que faltam (SKUs a separar) — teto por ciclo (mais alto no force)
    if (listaOk) {
      const sepSkus = montarSeparacao(null).linhas
        .map(l => l.sku).filter(s => s && s !== '(sem SKU)' && !(s in locC));
      const tetoLoc = forcar ? 80 : 25;
      let locNovas = 0;
      for (const sku of sepSkus) {
        if (locNovas >= tetoLoc) break;
        locC[sku] = await localizacaoPorSku(sku); await sleep(PAUSA_MS);
        locNovas++;
      }
      if (locNovas) { salvarLoc(locC); console.log(`[AMBBKP] ${locNovas} localização(ões) aquecidas`); }
    }

    // FASE 3: Bling respondeu (listaOk) → drena a fila de conferidos offline p/ VERIFICADO (24)
    // só roda automático se AMBBKP_SYNC_ON=1 (trava de segurança até você testar)
    if (listaOk && SYNC_ON) {
      const sync = await sincronizarConferidos();
      if (sync.pendentes) console.log(`[AMBBKP] sync conferidos→${SIT_VERIFICADO}: ${sync.ok} ok, ${sync.falhas} falha(s) de ${sync.pendentes}`);
    }

    purgar(man);
    purgarArquivo();
    purgarConferidos();
    salvarManifest(man);

    const ids = Object.keys(man);
    ultimoResumo = {
      rodouEm: new Date().toISOString(),
      duracaoSeg: Math.round((Date.now() - t0) / 1000),
      blingOk: listaOk,                            // o Bling respondeu neste ciclo? (p/ o /saude)
      paginasRefeitas: pagRef || 0,                // 22/08: quantas páginas precisaram de re-tentativa
      falhouNaPagina: pagFalha || null,            // se a lista veio incompleta, em qual página parou
      total: ids.length,
      comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
      semEtiqueta: ids.filter(i => !man[i].tem_etiqueta).length,
      novos, erros
    };
    console.log('[AMBBKP] ✔ ciclo:', JSON.stringify(ultimoResumo));
  } catch (e) {
    console.error('[AMBBKP] ciclo falhou:', e.message);
  } finally {
    rodando = false;
  }
  return ultimoResumo;
}

module.exports = { indexarCatalogoCompleto, sincronizarConferidos, listarAtendidos, detalhePedido, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus };
