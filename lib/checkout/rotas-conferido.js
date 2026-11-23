'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE CONFERÊNCIA E CICLO — 5ª fatia do passo 4 (17/09/2026).

   As três últimas rotas de corpo idêntico: `conferido` (o estoquista termina o
   pedido e ele é arquivado), `run` e `sincronizar` (disparo manual do ciclo).

   O `conferido` chegou aqui idêntico por um caminho que vale registrar: ao medir
   esta fatia, a diferença entre as empresas era o `nf_id` que só a AMB e a
   Girassol gravavam — o link ↗ pra NF no Bling nunca aparecia na GOOD. Portada a
   capacidade (#488), o Codex achou que ela vinha com um furo junto: sem a guarda
   `!snapC.nf_anexada`, o campo grava o id da nota CANCELADA quando o admin anexa
   a NF à mão. As três ficaram com a guarda, e SÓ ENTÃO o corpo ficou igual.

   ⚠️ Este handler NÃO valida sessão: quem registra faz isso DEPOIS do portão do
   módulo (lição do #480, travada em teste).
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  /* o SIT_VERIFICADO é o destino do pedido conferido, e ele DEPENDE DA EXPEDIÇÃO: com app de
     Expedição vai pra VERIFICADO e o app move pra DESPACHADOS depois; sem ela, vai direto pra
     DESPACHADOS. Por isso entra injetado, nunca lido de env aqui dentro — a lib não pode
     decidir o fluxo físico de uma empresa que ela não conhece.
     (A coerência entre a capacidade declarada e o valor da env é checada no boot por
     lib/checkout/conferir-expedicao.js.) */
  for (const n of ['prefixo', 'tag', 'json', 'readBody', 'readJson', 'writeJson', 'lerReservas',
                   'moverSituacao', 'arquivarFinalizado', 'sincronizarConferidos', 'rodarCiclo',
                   'CONFERIDOS_FILE', 'RESERVAS_FILE', 'CACHE_DIR', 'SIT_VERIFICADO',
                   'SYNC_ON', 'VERSAO']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/rotas-conferido: falta ' + n);
  }
  const { prefixo, tag, json, readBody, readJson, writeJson, lerReservas, moverSituacao,
          arquivarFinalizado, sincronizarConferidos, rodarCiclo,
          CONFERIDOS_FILE, RESERVAS_FILE, CACHE_DIR, SIT_VERIFICADO, SYNC_ON, VERSAO } = cfg;
  /* 23/11 — O "↻ ATUALIZAR" DO PAINEL (o dono: "é meio lerdo o checkout. eu clico em atualizar tb, e nem sempre reflete o
     bling"). Duas coisas faziam o clique não trazer o pedido que acabou de ir pro ATENDIDO:
       · com um ciclo já rodando (o do relógio, de 10 em 10 min), o clique era DESCARTADO ("já em andamento — pulei") — e
         aquele ciclo tirou a foto do ATENDIDO antes do clique, então não traz o pedido novo;
       · o painel recarregava a lista 4 e 8 s depois, antes de qualquer ciclo terminar.
     Agora o pedido de ciclo nunca se perde: se há um rodando, roda OUTRO logo depois; e se chegou outro clique depois do
     começo do ciclo que acabou de rodar, roda mais um. Um laço só por processo (cliques juntos viram um ciclo só) e com
     teto. O painel espera um ciclo que tenha COMEÇADO depois do clique (ciclo_comecou_em na /lista). */
  const _cfgEspera = Number(cfg.esperaEntreTentativasMs) > 0 ? Number(cfg.esperaEntreTentativasMs) : 5000;
  let _ultimoPedidoCiclo = 0, _lacoCiclo = false;
  function pedirCiclo(motivo, forcar, quando) {
    _ultimoPedidoCiclo = Math.max(_ultimoPedidoCiclo, Number(quando) || Date.now());
    if (_lacoCiclo) return false;   /* já há quem rode: ele vê este pedido (o marco subiu) */
    _lacoCiclo = true;
    (async () => {
      try {
        for (let t = 0; t < 60; t++) {
          const inicio = Date.now();
          let r = null;
          try { r = await rodarCiclo(motivo, forcar); } catch (e) { r = null; }
          if (r && r.pulado) { await new Promise((ok) => setTimeout(ok, _cfgEspera)); continue; }   /* outro ciclo rodando: espera e tenta */
          if (_ultimoPedidoCiclo <= inicio) return;   /* nenhum pedido depois do começo deste ciclo: atendido (no mesmo ms ainda é antes da foto, que vem depois) */
        }
      } finally { _lacoCiclo = false; }
    })();
    return true;
  }
  /* opcional (default false): só AMB/GOOD têm o bloco Full→DESPACHADOS no ciclo; a Girassol não — lá o Full
     segue pro VERIFICADO na hora, pra Expedição pegar (Codex #702). */
  const FULL_VAI_DESPACHADOS = cfg.FULL_VAI_DESPACHADOS === true;
  const fullJaDespachado = typeof cfg.fullJaDespachado === 'function' ? cfg.fullJaDespachado : () => false;   // opcional (AMB/GOOD)
  const path = require('path');

  return async function handle(req, res, urlObj, method, validarSessao) {
    const p = urlObj.pathname;

    if (method === 'POST' && p === (prefixo + '/conferido')) {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) { json(res, 400, { erro: 'id obrigatório' }); return true; }
      if (!require('./id-pedido').idPedido(id)) { json(res, 400, { erro: 'id de pedido inválido' }); return true; }   /* 15/11 (Codex P2-1): o id vira caminho (cache, arquivo) — só dígitos */
      const snapC = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      const conf = readJson(CONFERIDOS_FILE, {});
      if (conf[id]) {   // JÁ finalizado por alguém → não refaz, não reimprime, não re-sincroniza
        json(res, 200, { ok: false, ja_finalizado: true, por: conf[id].user || '', em: conf[id].conferido_em });
        return true;
      }
      const { atualizarConferido, novaGeracao } = require('./conferidos-atualizar');
      const geracao = novaGeracao();   /* 15/11 (Codex P1 nº 7): identifica ESTA finalização — reabrir + finalizar de novo gera outra */
      conf[id] = {
        user: body.user || '',
        conferido_em: new Date().toISOString(),
        geracao,
        sincronizado: false,
        numero: snapC ? snapC.numero : (body.numero || null),
        cliente: snapC ? (snapC.cliente || '') : '',
        marketplace: snapC ? (snapC.marketplace || null) : null,
        flex: !!(snapC && snapC.flex),
        servico: snapC ? (snapC.servico || '') : '',
        nf_numero: (snapC && snapC.nf && snapC.nf.numero) || null,
        // 17/09 (Codex, achado no porte da GOOD): sem o `!snapC.nf_anexada` este campo
        // gravaria o id da nota CANCELADA quando o admin anexa a NF à mão — ciclo.js
        // (linha ~1021) documenta que `snap.nf.id` não é atualizado nesse fluxo.
        nf_id: (snapC && !snapC.nf_anexada && snapC.nf && snapC.nf.id) || null,   // ID interno da NF — link direto pro Bling
        nf_emissao: (snapC && snapC.nf && snapC.nf.dataEmissao) || null,   // b11: hora da NF já entra na bipagem (dashboard ordena por ela)
        valor: (snapC && snapC.total != null) ? Number(snapC.total) : null,   // faturamento (total do pedido)
        uf: (snapC && snapC.uf) || null,
        vprod_nf: (function(){ try {   // Σ itens da NOTA (fonte fiscal) → produtos EXATO; frete = valor − vprod_nf
          const ds = readJson(path.join(CACHE_DIR, String(id), 'nf-simp.json'), null);
          if (ds && Array.isArray(ds.itens) && ds.itens.length) { const s2 = ds.itens.reduce((a,i)=>a+(Number(i.valorTotal)||0),0); return isFinite(s2)&&s2>0 ? Math.round(s2*100)/100 : null; }
        } catch (e) {} return null; })(),
        municipio: (snapC && snapC.municipio) || null,
        numero_loja: (snapC && snapC.numero_loja) || null,
        venda_dia: (snapC && snapC.venda_dia) || null,
        taxa_mkt: (snapC && snapC.taxa_mkt) || null,
        frete_mkt: (snapC && snapC.frete_mkt) || null,
        itens: snapC ? (snapC.itens || []).map(it => ({ sku: it.sku || '', descricao: String(it.descricao || '').slice(0, 90), qtd: it.qtd || 1, valor_unit: (it.valor_unit != null ? it.valor_unit : null), valor_total: (it.valor_total != null ? it.valor_total : null) })) : []
      };
      /* 15/11 (auditoria do Codex, P1 nº 6): a gravação na fila é a ÚNICA prova de que o pedido foi finalizado — se ela
         falha (disco cheio, só leitura), NADA mais acontece: nem arquivo, nem reserva solta, nem movimento no Bling, e o
         estoquista recebe erro, não "ok". Antes o `false` do writeJson era ignorado e o pedido seguia pro Bling sem registro. */
      if (writeJson(CONFERIDOS_FILE, conf) === false) {
        console.error(`[${tag}] conferido ${id}: NÃO consegui gravar a fila de finalizados — nada foi feito`);
        json(res, 503, { ok: false, erro: 'não consegui gravar a finalização (disco). Nada foi feito — tente de novo em alguns segundos.', nao_gravado: true });
        return true;
      }
      arquivarFinalizado(id);                       // arquiva etiqueta + meta p/ reimprimir/reenviar depois (Parte A)
      { const rsvF = lerReservas(); if (rsvF[id]) { delete rsvF[id]; writeJson(RESERVAS_FILE, rsvF); } }   // finalizou → solta a reserva

      // ESPELHO EM TEMPO REAL: se o sync tá ligado e o Bling responde, move p/ VERIFICADO já.
      // Se o Bling estiver fora, fica na fila e o cron sincroniza quando ele voltar.
      let sincronizado = false, blingOffline = false;
      /* 16/10 (acerto do #701, apontado pelo Codex): venda Full do ML (full_ml — o ML confirmou fulfillment) tem
         destino DESPACHADOS, e quem move é o ciclo. Finalizar o card dela NÃO a leva pra VERIFICADO: o conferido
         fica registrado e o ciclo o encerra quando move o Full. */
      /* Codex #702: card aberto antes da classificação e finalizado DEPOIS de o ciclo despachar o Full — o cache e o manifesto
         já se foram (snapC nulo), mas o processo lembra do move; sem isso a ação velha do navegador devolveria o pedido pro VERIFICADO */
      const _jaDespachado = FULL_VAI_DESPACHADOS && fullJaDespachado(id);
      const _ehFullML = FULL_VAI_DESPACHADOS && (_jaDespachado || !!(snapC && snapC.full_ml));
      if (_jaDespachado) {
        atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => { e.sincronizado = true; e.sincronizado_em = new Date().toISOString(); e.sync_resolvido = 'full-ml-despachado'; }, geracao);
      }
      if (_ehFullML) console.log(`[${tag}] conferido ${id} é venda FULL do ML — não vai pra ${SIT_VERIFICADO}; o ciclo leva pra DESPACHADOS`);
      if (SYNC_ON && !_ehFullML) {
        const r = await moverSituacao(id, SIT_VERIFICADO);
        /* 01/11 (auditoria Codex F02): depois da espera do Bling, a mudança vai sobre a lista ATUAL e só neste pedido —
           regravar o `conf` lido antes da espera apagava o que outro pedido finalizou no meio.
           15/11 (Codex P1 nº 7): e só nesta GERAÇÃO — se reabriram e finalizaram de novo durante a espera, o resultado
           desta ida não marca a finalização nova. Quando a marca não pega (sumiu/outra geração/disco), fica dito. */
        if (r.ok) {
          const marcou = atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => { e.sincronizado = true; e.sincronizado_em = new Date().toISOString(); delete e.sync_erro; }, geracao);
          sincronizado = marcou;
          if (marcou) console.log(`[${tag}] conferido ${id} → ${SIT_VERIFICADO} (espelho na hora) OK`);
          else console.warn(`[${tag}] conferido ${id} → ${SIT_VERIFICADO} no Bling, mas a fila mudou durante a espera (reaberto/refinalizado) ou não gravou — o ciclo reconcilia`);
        } else {
          atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => { e.sync_erro = String(r.status || 'err'); }, geracao);
          blingOffline = true;
          console.log(`[${tag}] conferido ${id} ficou na fila (bling ${r.status}) — sincroniza depois`);
        }
      }
      json(res, 200, { ok: true, id, sincronizado, bling_offline: blingOffline });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/run')) {
      const forcar = /[?&]force=1\b/.test(urlObj.search || '');
      const pedidoEm = Date.now();
      pedirCiclo(forcar ? 'manual-force' : 'manual', forcar, pedidoEm);
      json(res, 200, { mensagem: `Ciclo${forcar ? ' (FORCE — re-cacheia tudo)' : ''} iniciado. Veja ${prefixo}/status.`, versao: VERSAO, pedido_em: new Date(pedidoEm).toISOString() });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/sincronizar')) {
      const r = await sincronizarConferidos();
      json(res, 200, { ok: true, ...r });
      return true;
    }
    return false;
  };
}

module.exports = { criar };
