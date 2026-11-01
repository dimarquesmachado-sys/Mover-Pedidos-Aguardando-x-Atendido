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
      const snapC = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
      const conf = readJson(CONFERIDOS_FILE, {});
      if (conf[id]) {   // JÁ finalizado por alguém → não refaz, não reimprime, não re-sincroniza
        json(res, 200, { ok: false, ja_finalizado: true, por: conf[id].user || '', em: conf[id].conferido_em });
        return true;
      }
      conf[id] = {
        user: body.user || '',
        conferido_em: new Date().toISOString(),
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
      writeJson(CONFERIDOS_FILE, conf);            // grava na fila primeiro — nunca perde
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
        conf[id].sincronizado = true; conf[id].sincronizado_em = new Date().toISOString(); conf[id].sync_resolvido = 'full-ml-despachado';
        writeJson(CONFERIDOS_FILE, conf);
      }
      if (_ehFullML) console.log(`[${tag}] conferido ${id} é venda FULL do ML — não vai pra ${SIT_VERIFICADO}; o ciclo leva pra DESPACHADOS`);
      if (SYNC_ON && !_ehFullML) {
        const r = await moverSituacao(id, SIT_VERIFICADO);
        /* 01/11 (auditoria Codex F02): depois da espera do Bling, a mudança vai sobre a lista ATUAL e só neste pedido —
           regravar o `conf` lido antes da espera apagava o que outro pedido finalizou no meio */
        const { atualizarConferido } = require('./conferidos-atualizar');
        if (r.ok) {
          atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => { e.sincronizado = true; e.sincronizado_em = new Date().toISOString(); delete e.sync_erro; });
          sincronizado = true;
          console.log(`[${tag}] conferido ${id} → ${SIT_VERIFICADO} (espelho na hora) OK`);
        } else {
          atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => { e.sync_erro = String(r.status || 'err'); });
          blingOffline = true;
          console.log(`[${tag}] conferido ${id} ficou na fila (bling ${r.status}) — sincroniza depois`);
        }
      }
      json(res, 200, { ok: true, id, sincronizado, bling_offline: blingOffline });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/run')) {
      const forcar = /[?&]force=1\b/.test(urlObj.search || '');
      rodarCiclo(forcar ? 'manual-force' : 'manual', forcar);
      json(res, 200, { mensagem: `Ciclo${forcar ? ' (FORCE — re-cacheia tudo)' : ''} iniciado. Veja ${prefixo}/status.`, versao: VERSAO });
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
