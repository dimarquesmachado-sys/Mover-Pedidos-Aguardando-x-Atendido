'use strict';
// ════════════════════════════════════════════════════════════════════════
//  ROTINA NOTURNA — o dashboard se mantém sozinho (05/08/2026)
// ════════════════════════════════════════════════════════════════════════
//  PEDIDO DO DIEGO, repetido várias vezes: "tem que rodar sem minha ação".
//  Hoje ele dispara na mão: billing, backfill, pescaria, varredura de
//  cancelados, poda do bucket. Cada um desses é uma URL que alguém precisa
//  lembrar de abrir — e o que depende de memória humana falha calado.
//
//  Esta rotina encadeia tudo, uma etapa por vez, com pausa entre elas, e
//  guarda o resultado de cada uma. Se uma falhar, as outras seguem.
//
//  ORDEM (não é arbitrária):
//   1. BILLING do ML      → traz o extrato novo. Vem PRIMEIRO porque é dele
//                           que a cascata do backfill tira comissão e frete.
//   2. BACKFILL 3 dias    → regrava o histórico recente já com o billing fresco
//   3. PESCA 60 dias      → preenche a tarifa REAL nos pedidos bipados. O cron
//                           antigo só olhava 14 dias, então pedido de 15 dias
//                           atrás nunca mais era revisitado — era isso que
//                           deixava a pílula "tarifa real" em 86% no mês anterior
//   4. CANCELADOS         → varre e abate venda cancelada do histórico
//   5. PODA DO BUCKET     → apaga imagem de expedição com mais de 45 dias
//   6. CANÁRIO            → confere se as APIs ainda respondem o que a gente espera
//
//  HORÁRIO: 03:30. Escolhido de propósito — o F2-Virada roda 00:10, o backup
//  do cache e o backfill de NF ficam pelas 4h, e o expediente só volta às 6h.
//  Às 3:30 o token do Bling está livre, que é o que já mordeu a gente antes.
// ════════════════════════════════════════════════════════════════════════

let _not = {
  rodando: false, inicio: null, fim: null, disparo: null,
  etapas: [], resumo: ''
};

const hojeMenos = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

function criarNoturna(ctx) {
  const { mlBillingSync, backfillVendas, mlSyncFees, varrerCancelados, canarioCron, podarExpedicao,
          coletarDevolucoes, coletarCarteira, coletarAds, conferirMarketplaces, coletarFinanceiroTikTok, completarTarifaTikTok, VERSAO, validarSessao, ehAdmin, json } = ctx;
  const dorme = ms => new Promise(r => setTimeout(r, ms));

  async function etapa(nome, fn) {
    const t0 = Date.now();
    const reg = { nome, estado: 'rodando', detalhe: '', ms: 0 };
    _not.etapas.push(reg);
    try {
      const r = await fn();
      reg.estado = 'ok';
      reg.detalhe = (typeof r === 'string') ? r : (r ? JSON.stringify(r).slice(0, 300) : 'ok');
    } catch (e) {
      reg.estado = 'erro';
      reg.detalhe = String((e && e.message) || e).slice(0, 300);
      console.log('[NOTURNA] ✗ ' + nome + ': ' + reg.detalhe);
    }
    reg.ms = Date.now() - t0;
    console.log('[NOTURNA] ' + (reg.estado === 'ok' ? '✓' : '✗') + ' ' + nome + ' (' + Math.round(reg.ms / 1000) + 's) ' + reg.detalhe.slice(0, 120));
    return reg;
  }

  async function rotinaNoturna(disparo) {
    if (_not.rodando) { console.log('[NOTURNA] já está rodando — ignorando'); return _not; }
    _not = { rodando: true, inicio: new Date().toISOString(), fim: null, disparo: disparo || 'cron', etapas: [], resumo: '' };
    console.log('[NOTURNA] ═══ começando (' + _not.disparo + ') ═══');

    // 1. extrato oficial do ML — a fonte da cascata
    await etapa('billing do ML', async () => {
      const r = await mlBillingSync(2);
      return r && (r.linhas != null ? (r.linhas + ' tarifas') : 'ok');
    });
    await dorme(4000);

    // 2. histórico dos últimos 3 dias, já com o billing fresco
    await etapa('backfill dos últimos 3 dias', async () => {
      await backfillVendas(hojeMenos(3), hojeMenos(0), 'amb');
      return 'periodo ' + hojeMenos(3) + ' a ' + hojeMenos(0);
    });
    await dorme(4000);

    // 3. tarifa REAL nos bipados — janela LARGA (o cron antigo só via 14 dias)
    await etapa('pesca de tarifas do ML (60 dias)', async () => {
      const r = await mlSyncFees(60);
      if (r && r.nada) return 'nada a pescar';
      return r ? ((r.ok || 0) + ' pescados de ' + (r.total || 0) + ', ' + (r.falhas || 0) + ' falhas') : 'ok';
    });
    await dorme(4000);

    // 4. venda cancelada sai do histórico
    await etapa('varredura de cancelados (45 dias)', async () => {
      await varrerCancelados(45, 'amb');
      return 'disparada';
    });
    await dorme(4000);

    // 4b. SHOPEE: devoluções e carteira (06/08)
    // A Shopee so aceita janela de 15 dias, entao os coletores varrem em janelas e
    // guardam no disco por chave unica — rodar de novo nao duplica. Devolucoes trazem
    // SKU e motivo; a carteira traz ads, ajustes e reembolsos, que nao passam pelo Bling.
    if (typeof coletarDevolucoes === 'function') {
      await etapa('devoluções da Shopee (45 dias)', async () => {
        const r = await coletarDevolucoes(45);
        return r ? (r.novas + ' novas de ' + r.vistas + ' vistas · ' + r.guardadas + ' no total' + (r.erro ? ' | ' + r.erro : '')) : 'ok';
      });
      await dorme(3000);
    }
    if (typeof coletarCarteira === 'function') {
      await etapa('carteira da Shopee (30 dias)', async () => {
        const r = await coletarCarteira(30);
        return r ? (r.novas + ' novas de ' + r.vistas + ' vistas · ' + r.guardadas + ' no total' + (r.erro ? ' | ' + r.erro : '')) : 'ok';
      });
      await dorme(3000);
    }
    // 14/08 (Codex no PR#70): o card de Ads lia só o arquivo, e nenhuma rotina o atualizava —
    // o número ficaria congelado na última coleta manual enquanto o resto da Shopee seguia
    // fresco. Agora a coleta de ads é etapa da noturna, como devoluções e carteira.
    // 16/08 (Codex #105) — FINANCEIRO DO TIKTOK, ANTES do backfill: o backfill lê este cache
    // para gravar a tarifa real e a hora da venda. Se rodasse depois, o dado novo só entraria
    // no histórico na noite seguinte — e o pedido já teria saído da janela de 3 dias.
    // Sem isto o cache só era atualizado quando
    // alguém abria a URL na mão: pedido novo ficava sem tarifa real E sem hora da venda no
    // painel, e o recurso ia silenciosamente parando de funcionar conforme o cache envelhecia.
    /* 30/08 — JANELA LONGA (o dono cobrou o retrabalho manual): 35 dias não alcança a ação
       tardia do TikTok — mediação e estorno chegam semanas depois da venda. 120 cobre o
       ciclo real; a coleta é por id, então repetir não duplica. */
    const DIAS_TIKTOK = Number(process.env.TIKTOK_FINANCEIRO_DIAS) || 120;
    if (typeof coletarFinanceiroTikTok === 'function') {
      await etapa('financeiro do TikTok (' + DIAS_TIKTOK + ' dias)', async () => {
        const r = await coletarFinanceiroTikTok(DIAS_TIKTOK);
        if (!r || r.ok === false) throw new Error('coleta do TikTok falhou' + (r && r.erro ? ': ' + r.erro : ''));
        return r.pedidos_novos + ' pedido(s) novo(s) · ' + r.guardados + ' no total' +
               (r.nao_fecharam ? ' ⚠️ ' + r.nao_fecharam + ' não fecharam a identidade' : '');
      });
      await dorme(2000);
    }

    /* 30/08 — DEVOLUÇÕES DO TIKTOK, AUTOMÁTICAS (antes era tudo na mão: o dono tinha que
       chamar coletar, depois eventos, 25 por vez, toda vez que quisesse o número). Agora a
       noturna faz as duas coisas: coleta as devoluções da janela e completa a linha do
       tempo (postagem, reembolso, revelia) das que ainda não têm. Sem isso, a linha do
       dashboard envelhece sozinha e volta a exigir trabalho manual. */
    try {
      const tkOauth = require('../tiktok-oauth');
      const devLib = require('../lib/tiktok-financeiro');
      const evLib = require('../lib/tiktok-eventos');
      const fsx = require('fs'), pathx = require('path');
      const CACHE = process.env.TIKTOK_CACHE_DIR || '/data';
      const ctxDev = {
        CACHE_DIR: CACHE, path: pathx,
        readJson: (a, p) => { try { return JSON.parse(fsx.readFileSync(a, 'utf8')); } catch (e) { return p; } },
        writeJson: (a, v) => { try { fsx.mkdirSync(pathx.dirname(a), { recursive: true }); } catch (e) {} fsx.writeFileSync(a, JSON.stringify(v, null, 2)); },
        chamar: tkOauth.chamar,
      };
      await etapa('devoluções do TikTok (' + DIAS_TIKTOK + ' dias)', async () => {
        const r = await devLib.coletarDevolucoesTikTok(ctxDev, 'amb', DIAS_TIKTOK);
        if (!r || r.erro) throw new Error('coleta de devoluções falhou' + (r && r.erro ? ': ' + r.erro : ''));
        return r.vistas + ' vista(s) · ' + r.novas + ' nova(s)';
      });
      await dorme(2000);
      await etapa('linha do tempo das devoluções do TikTok', async () => {
        const arqD = pathx.join(CACHE, '_tiktok_devolucoes_amb.json');
        const g = ctxDev.readJson(arqD, null);
        if (!g || !g.devolucoes) return 'sem cache — nada a fazer';
        /* só as que ainda não têm eventos, e no máximo 40 por noite: cada uma é uma
           chamada à API, e o rate limit já nos mordeu antes. */
        const faltam = Object.values(g.devolucoes).filter(d => d && d.id && !d.eventos).slice(0, 40);
        let ok = 0, revelias = 0;
        for (const d of faltam) {
          try {
            const r = await tkOauth.chamar('/return_refund/202309/returns/' + encodeURIComponent(d.id) + '/records', {}, {}, 'amb');
            const recs = r && r.corpo && r.corpo.data && r.corpo.data.records;
            if (!Array.isArray(recs)) continue;
            d.eventos = evLib.resumirEventos(recs);
            if (d.eventos.perdeu_por_revelia) revelias++;
            ok++;
          } catch (e) { /* uma falhar não derruba a noite */ }
          await new Promise(s2 => setTimeout(s2, 250));
        }
        ctxDev.writeJson(arqD, g);
        const semEventos = Object.values(g.devolucoes).filter(d => d && !d.eventos).length;
        return ok + ' processada(s) · ' + revelias + ' com revelia · ' + semEventos + ' ainda sem linha do tempo';
      });
      await dorme(2000);
    } catch (e) {
      console.error('[noturna] devoluções do TikTok não rodaram:', e.message);
    }

    /* 30/08 — CANCELAMENTOS DO MAGALU (o card do dashboard dependia de coleta MANUAL, e
       dado que só existe se alguém lembrar de rodar foi o problema que passamos o dia
       consertando). 120 dias: o estorno do Magalu chega semanas depois da venda, e a data
       que vale é a dele, não a da compra. */
    try {
      const magalu = require('../magalu-oauth');
      if (typeof magalu.coletarCancelados === 'function') {
        const DIAS_MG = Number(process.env.MAGALU_CANCELADOS_DIAS) || 120;
        await etapa('cancelamentos do Magalu (' + DIAS_MG + ' dias)', async () => {
          const r = await magalu.coletarCancelados('amb', DIAS_MG);
          if (!r || r.ok === false) throw new Error('coleta falhou' + (r && r.erro ? ': ' + r.erro : ''));
          return r.vistos + ' visto(s) · ' + r.novos + ' novo(s)' + (r.truncou ? ' ⚠️ varredura truncada' : '');
        });
        await dorme(2000);
      }
    } catch (e) {
      console.error('[noturna] cancelamentos do Magalu não rodaram:', e.message);
    }

    // 18/08 — corrige a tarifa do TikTok das vendas que JÁ liquidaram. Roda depois do
    // backfill de propósito: o backfill grava a venda nova (com a tarifa do Bling, porque o
    // extrato ainda não existe) e esta etapa volta nas antigas cujo extrato já saiu. Sem
    // isso, a única correção era rodar o backfill do período inteiro de novo.
    if (typeof completarTarifaTikTok === 'function') {
      await etapa('completar tarifa do TikTok (45 dias)', async () => {
        const r = await completarTarifaTikTok(45);
        if (!r || r.ok === false) throw new Error((r && r.erro) || 'falhou');
        if (r.falhas) throw new Error(r.falhas + ' linha(s) não atualizaram (de ' + r.linhas_atualizadas + ')');
        return r.pedidos_corrigidos + ' pedido(s) corrigido(s) · R$ ' + r.tarifa_a_mais_reconhecida.toFixed(2) +
               ' de tarifa reconhecida · ' + r.sem_financeiro_ainda + ' ainda sem extrato';
      });
      await dorme(2000);
    }

    // 16/08 — CANÁRIO MARKETPLACE × BLING. Pedido do Diego depois do token Bling↔Shopee
    // vencer em silêncio e esconder 28 pedidos: "o Bling não é o rei, quem manda é o
    // marketplace". A etapa FALHA quando há venda que não chegou ao Bling — assim o alerta
    // aparece no resumo da noturna em vez de depender de alguém abrir uma URL.
    if (typeof conferirMarketplaces === 'function') {
      await etapa('canário marketplace × Bling (3 dias)', async () => {
        const r = await conferirMarketplaces(3);
        if (!r || r.ok === false) throw new Error('não deu pra conferir: ' + ((r && r.erro) || 'sem resposta'));
        const partes = Object.keys(r.por_canal || {}).map(k => {
          const v = r.por_canal[k] || {};
          if (v.verificado === false) return k + ': não verificado';
          return k + ': ' + (v.faltando_no_bling || 0) + ' de ' + (v.no_marketplace || 0);
        });
        if ((r.alertas || []).length) {
          throw new Error('VENDA FORA DO BLING → ' + r.alertas.map(a => a.canal + ': ' + a.faltando + ' pedido(s)').join(' · ') +
                          ' | reautorize a integração no Bling e rode o backfill do período');
        }
        // Codex (P1): canal NÃO VERIFICADO (erro, credencial ausente, lista truncada) não pode
        // sair como etapa cumprida — a noturna diria "tudo conferido" sem ter conferido.
        if ((r.nao_verificados || []).length) {
          throw new Error('INDETERMINADO — não consegui conferir: ' + r.nao_verificados.join(', ') +
                          ' (o resto: ' + partes.join(' · ') + ')');
        }
        return partes.join(' · ');
      });
      await dorme(2000);
    }

    if (typeof coletarAds === 'function') {
      await etapa('ads da Shopee (35 dias)', async () => {
        const r = await coletarAds(35);
        // Codex: `coletarAds` devolve {ok:false} em vez de lançar, e o `etapa` marcaria a
        // rodada como bem-sucedida — a noturna diria "conferido" com dado velho na tela.
        // Codex (2ª rodada): 35 dias = DUAS janelas, e `ok` fica true se qualquer uma trouxer
        // linhas — a etapa passaria com metade do período velho. Qualquer erro reprova.
        if (!r || r.ok === false || r.erro) throw new Error('coleta de ads incompleta' + (r && r.erro ? ': ' + r.erro : ''));
        return r.dias_novos + ' dia(s) novo(s) de ' + r.dias_vistos + ' vistos' + (r.erro ? ' | ' + r.erro : '');
      });
      await dorme(3000);
    }

    // 5. o bucket de imagens se mantém sozinho
    if (typeof podarExpedicao === 'function') {
      await etapa('poda do bucket de expedição (45 dias)', async () => {
        const r = await podarExpedicao(45, 3000);
        return r ? (r.apagados + ' arquivos, ' + r.mb + ' MB liberados' + (r.erro ? ' | ' + r.erro : '')) : 'ok';
      });
      await dorme(2000);
    }

    // 6. as APIs ainda respondem o que esperamos?
    if (typeof canarioCron === 'function') {
      await etapa('canário das integrações', async () => { await canarioCron(); return 'conferido'; });
    }

    const erros = _not.etapas.filter(e => e.estado === 'erro');
    _not.resumo = erros.length ? ('⚠️ ' + erros.length + ' etapa(s) com erro: ' + erros.map(e => e.nome).join(', ')) : '✅ todas as etapas concluídas';
    _not.rodando = false;
    _not.fim = new Date().toISOString();
    console.log('[NOTURNA] ═══ fim — ' + _not.resumo + ' ═══');
    return _not;
  }

  function rotas(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    const adm = (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));

    if (method === 'GET' && p === '/amb-checkout-offline/noturna-status') {
      if (!adm) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, Object.assign({ ok: true, versao: VERSAO, horario: '03:30 (America/Sao_Paulo)' }, _not));
      return true;
    }

    // dispara na mão a MESMA rotina do cron — serve pra testar sem esperar a madrugada
    if (method === 'GET' && p === '/amb-checkout-offline/rodar-noturna') {
      if (!adm) { json(res, 404, { error: 'not found' }); return true; }
      if (_not.rodando) { json(res, 409, { ok: false, erro: 'já está rodando', status: _not }); return true; }
      rotinaNoturna('manual').catch(e => { _not.rodando = false; console.log('[NOTURNA] ✗ ' + e.message); });
      json(res, 202, { ok: true, msg: 'rotina noturna disparada em segundo plano', status: '/amb-checkout-offline/noturna-status' });
      return true;
    }

    return false;
  }

  return { rotinaNoturna, rotas };
}

module.exports = { criarNoturna };
