'use strict';

/* 14/09 (auditoria, P2): a chave passa a ser lida do HEADER primeiro; a query
   continua aceita porque há dezenas de URLs salvas com &k= — cortar de uma vez
   quebraria o trabalho de quem opera pelo navegador. */
const { lerChaveAdmin } = require('../http/chave-admin');
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


const hojeMenos = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

function criarNoturna(ctx) {
  /* 26/10: a MADRUGADA ÚNICA (lib/checkout/noturna-empresa) — a empresa e o prefixo das rotas vêm do contexto */
  const EMP = String((arguments[0] && arguments[0].empresa) || '').trim();
  const PREFIXO = String((arguments[0] && arguments[0].prefixo) || '').trim();
  if (!EMP || !PREFIXO) throw new Error('lib/checkout/noturna-empresa: falta a empresa ou o prefixo das rotas');
  /* Codex #748 (P1): o ESTADO da madrugada (rodando, etapas, resumo) é DE CADA EMPRESA — fora da fábrica, a Girassol e a
     AMB carregam o mesmo módulo e dividiriam a trava: a das 03:45 voltaria na hora se a outra ainda estivesse rodando,
     e o status de uma mostraria a rodada da outra. */
  let _not = {
    rodando: false, inicio: null, fim: null, disparo: null,
    etapas: [], resumo: ''
  };
  const { mlBillingSync, backfillVendas, backfillEstado, mlSyncFees, varrerCancelados, canarioCron, podarExpedicao, resgatarHistorico,
          coletarDevolucoes, coletarCarteira, coletarAds, conferirMarketplaces, consertarDoCanario, coletarFinanceiroTikTok, completarTarifaTikTok, VERSAO, validarSessao, ehAdmin, json } = ctx;
  const dorme = ms => new Promise(r => setTimeout(r, ms));

  async function etapa(nome, fn) {
    const t0 = Date.now();
    const reg = { nome, estado: 'rodando', detalhe: '', ms: 0 };
    _not.etapas.push(reg);
    try {
      const r = await fn();
      // Codex (P2): retorno 'PULADO: ...' virava 'ok' aqui, e o resumo final só olha
      // 'erro' — a noite dizia "tudo concluído" sem ter rodado a etapa. Agora fica
      // como estado próprio, visível no resumo.
      const pulada = typeof r === 'string' && r.startsWith('PULADO:');
      reg.estado = pulada ? 'pulado' : 'ok';
      reg.detalhe = (typeof r === 'string') ? r : (r ? JSON.stringify(r).slice(0, 300) : 'ok');
    } catch (e) {
      reg.estado = 'erro';
      reg.detalhe = String((e && e.message) || e).slice(0, 300);
      console.log('[NOTURNA] ✗ ' + nome + ': ' + reg.detalhe);
    }
    reg.ms = Date.now() - t0;
    const icone = reg.estado === 'ok' ? '✓' : (reg.estado === 'pulado' ? '⏭️' : '✗');
    console.log('[NOTURNA] ' + icone + ' ' + nome + ' (' + Math.round(reg.ms / 1000) + 's) ' + reg.detalhe.slice(0, 120));
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
    /* 26/10: a coleta e a linha do tempo das devoluções do TikTok são a peça única lib/tiktok-devolucoes-rotina (o mesmo
       código que estava aqui e na outra madrugada — e que a GOOD agora também roda); as etapas e os textos são os mesmos */
    try {
      const rotDev = require('../tiktok-devolucoes-rotina');
      await etapa('devoluções do TikTok (' + DIAS_TIKTOK + ' dias)', async () => {
        const r = await rotDev.coletar(EMP, DIAS_TIKTOK);
        if (!r || r.erro) throw new Error('coleta de devoluções falhou' + (r && r.erro ? ': ' + r.erro : ''));
        return rotDev.textoColeta(r);
      });
      await dorme(2000);
      await etapa('linha do tempo das devoluções do TikTok', async () => rotDev.textoLinha(await rotDev.completarLinhaDoTempo(EMP)));
      await dorme(2000);
    } catch (e) {
      console.error('[noturna] devoluções do TikTok não rodaram:', e.message);
    }

    /* 30/08 — CANCELAMENTOS DO MAGALU (o card do dashboard dependia de coleta MANUAL, e
       dado que só existe se alguém lembrar de rodar foi o problema que passamos o dia
       consertando). 120 dias: o estorno do Magalu chega semanas depois da venda, e a data
       que vale é a dele, não a da compra. */
    try {
      const magalu = require('../../magalu-oauth');
      if (typeof magalu.coletarCancelados === 'function') {
        const DIAS_MG = Number(process.env.MAGALU_CANCELADOS_DIAS) || 120;
        await etapa('cancelamentos do Magalu (' + DIAS_MG + ' dias)', async () => {
          const r = await magalu.coletarCancelados(EMP, DIAS_MG);
          if (!r || r.ok === false) throw new Error('coleta falhou' + (r && r.erro ? ': ' + r.erro : ''));
          return r.vistos + ' visto(s) · ' + r.novos + ' novo(s)' + (r.truncou ? ' ⚠️ varredura truncada' : '');
        });
        await dorme(2000);
      }
    } catch (e) {
      console.error('[noturna] cancelamentos do Magalu não rodaram:', e.message);
    }


    // 2. histórico dos últimos 3 dias, já com o billing fresco
    await etapa('backfill dos últimos 3 dias', async () => {
      /* 05/09 — A NOTURNA CEDE. Ela roda às 3:30 e faz o backfill dos últimos 3 dias; quando
         o dono está rodando um MÊS de histórico à noite (o único horário em que pode, por
         causa da cota do Bling), ela assumia o estado e matava a rodada dele no meio. Hoje
         isso aconteceu: julho morreu aos 20 minutos porque a noturna começou. Ela roda todo
         dia — o mês de histórico não. Havendo backfill em curso, esta etapa se declara
         pulada e a noite segue nas outras. */
      const _est = (typeof backfillEstado === 'function') ? backfillEstado() : null;
      if (_est && _est.rodando) {
        console.log('[noturna] backfill de ' + _est.de + ' a ' + _est.ate + ' em curso — pulei os 3 dias pra não atropelar');
        return 'PULADO: backfill manual em curso (' + _est.de + ' a ' + _est.ate + ')';
      }
      const rB = await backfillVendas(hojeMenos(3), hojeMenos(0), EMP);
      // Codex (#105): o retorno era ignorado — se a trava do canário adiasse o backfill, a
      // etapa dizia "concluída" e a única atualização diária do histórico sumia em silêncio.
      if (rB && rB.ok === false) throw new Error('backfill ADIADO: ' + (rB.msg || 'motivo não informado'));
      return 'periodo ' + hojeMenos(3) + ' a ' + hojeMenos(0);
    });
    await dorme(4000);

    /* 14/10 — RESGATE: pedido que nasce hoje com data de venda de 3+ dias atrás (boleto/Pix que
       demorou a aprovar; o Bling copia do ML a data do clique) fica fora da janela acima PARA
       SEMPRE. Caso real: venda ML 2000018908624178, pedido 123645, R$ 6.997,90. Toda noite:
       lista o Bling por data de ALTERAÇÃO dos últimos 3 dias e, dos pedidos com data de venda
       anterior à janela, confere quais não estão no histórico — cada dia desses roda o backfill
       de produção de novo. Domingo: 60 dias por data da venda, pra pegar quem já ficou de fora. */
    if (typeof resgatarHistorico === 'function') {
      const _plano = require('./backfill-resgate').planoDaNoturna();
      /* Codex #683 r6 (P2): no modo alteracao a janela tem que ser a MESMA do backfill acima
         (hojeMenos, UTC) — entre 21h e 0h em SP os dois calendarios divergem e um dia ficaria
         fora dos dois. A varredura de domingo segue no calendario de SP */
      if (_plano.por === 'alteracao') { _plano.de = hojeMenos(3); _plano.ate = hojeMenos(0); }
      await etapa('resgate do histórico (' + _plano.rotulo + ')', async () => {
        const r = await resgatarHistorico(_plano);
        if (!r || r.ok === false) throw new Error('não deu pra resgatar: ' + ((r && r.erro) || 'sem resposta') + (r && r.adiados && r.adiados.length ? ' | adiados: ' + r.adiados.length + ' dia(s)' : ''));
        /* Codex #683 r3 (P2): dia que veio so do memo de adiados nao conta em `faltando` — o
           "nada faltando" so vale se tambem nao sobrou nada adiado */
        const _adi = (r.adiados || []).length;
        if (!r.faltando && !_adi && !(r.resgatados || []).length) return 'nada faltando (' + r.candidatos + ' pedido(s) conferido(s))';
        const txt = r.faltando + ' pedido(s) novo(s)' + (r.adiados_do_memo ? ' + ' + r.adiados_do_memo + ' dia(s) do memo' : '') + ' em ' + (r.dias || []).length + ' dia(s): resgatados ' + ((r.resgatados || []).join(', ') || 'nenhum');
        if (r.adiados && r.adiados.length) throw new Error(txt + ' | ADIADOS ' + r.adiados.join(', ') + (r.ultimo_erro ? ' (' + r.ultimo_erro + ')' : ' (teto da noite)'));
        return txt;
      });
      await dorme(4000);
    }

    // 3. tarifa REAL nos bipados — janela LARGA (o cron antigo só via 14 dias)
    await etapa('pesca de tarifas do ML (60 dias)', async () => {
      const r = await mlSyncFees(60);
      if (r && r.nada) return 'nada a pescar';
      return r ? ((r.ok || 0) + ' pescados de ' + (r.total || 0) + ', ' + (r.falhas || 0) + ' falhas') : 'ok';
    });
    await dorme(4000);

    // 4. venda cancelada sai do histórico
    await etapa('varredura de cancelados (45 dias)', async () => {
      await varrerCancelados(45, EMP);
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
    // 18/08 — corrige a tarifa do TikTok das vendas que JÁ liquidaram. Roda depois do
    // backfill de propósito: o backfill grava a venda nova (com a tarifa do Bling, porque o
    // extrato ainda não existe) e esta etapa volta nas antigas cujo extrato já saiu. Sem
    // isso, a única correção era rodar o backfill do período inteiro de novo.
    if (typeof completarTarifaTikTok === 'function') {
      await etapa('completar tarifa do TikTok (45 dias)', async () => {
        /* Codex #749: a correção lê os ids das linhas do histórico e corrige uma a uma; um backfill da empresa rodando ao
           mesmo tempo TROCA essas linhas (ids novos, correção perdida). Com backfill em curso, pula pro próximo dia — a
           GOOD tinha esse cuidado nas tarefas soltas; agora vale pras três. */
        const _estC = (typeof backfillEstado === 'function') ? backfillEstado() : null;
        if (_estC && _estC.rodando) return 'PULADO: backfill em curso (' + (_estC.de || '?') + ' a ' + (_estC.ate || '?') + ') — a correção mexe no histórico, fica pro próximo dia';
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
      /* 13/10: 3 dias toda noite e 30 no domingo — a regra mora em lib/canario-marketplace.js */
      const _diasCan = require('../canario-marketplace').diasDaNoturna();
      await etapa('canário marketplace × Bling (' + _diasCan + ' dias)', async () => {
        const r = await conferirMarketplaces(_diasCan);
        if (!r || r.ok === false) throw new Error('não deu pra conferir: ' + ((r && r.erro) || 'sem resposta'));
        /* 26/10: o RESULTADO desta conferência vai pro conserto (recoloca no Bling as poucas vendas do ML que faltam e grava
           o histórico de onde o aviso do painel lê) — como a AMB. Antes o conserto estava ligado ao canário das INTEGRAÇÕES,
           que não devolve resultado nenhum: recebia nada, e o conserto da Girassol nunca rodou nem gravou histórico. */
        if (typeof consertarDoCanario === 'function') { try { await consertarDoCanario(r); } catch (e) { console.error('[' + EMP.toUpperCase() + ' canário] conserto:', e.message); } }
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
    /* 27/10 — os dias da Shopee que ficaram SEM REPASSE (o backfill anota; lib/checkout/repasse-pendente): refaz os
       mais antigos, até 3 por noite. Depois do canário das integrações de propósito: a prova da chave é desta noite —
       se a Shopee está recusando a chave, refazer só gastaria cota do Bling. 7 tentativas e o dia sai da lista. */
    /* o CONTEXTO da empresa (o `ctx` da fábrica — aqui dentro `arguments` seria o da rotina, não o da empresa) */
    const _cacheDirN = (ctx && ctx.cacheDir) || null;
    if (_cacheDirN) {
      const _bfDia = (ctx && typeof ctx.backfillDia === 'function') ? ctx.backfillDia : ((d) => backfillVendas(d, d, EMP));
      await etapa('refazer dias da Shopee sem repasse', async () => {
        const rp = require('./repasse-pendente');
        const pend = rp.listar(_cacheDirN);
        if (!pend.length) return 'nenhum dia pendente';
        let prova = null;
        try { prova = JSON.parse(require('fs').readFileSync(require('path').join(_cacheDirN, require('./aviso-chave-shopee').ARQ_PROVA), 'utf8')); } catch (e) { prova = null; }
        if (prova && prova.recusou) return 'PULADO: a Shopee está recusando a chave (' + String(prova.recusou).slice(0, 60) + ') — ' + pend.length + ' dia(s) seguem pendentes';
        const est = (typeof backfillEstado === 'function') ? backfillEstado() : null;
        if (est && est.rodando) return 'PULADO: backfill em curso — ' + pend.length + ' dia(s) seguem pendentes';
        const desisti = [];
        for (const pd of pend) if (Number(pd.tentativas || 0) >= rp.MAX_TENTATIVAS) { rp.desistir(_cacheDirN, pd.dia); desisti.push(pd.dia); }
        if (desisti.length) console.error('[' + EMP.toUpperCase() + ' noturna] repasse da Shopee: desisti de ' + desisti.join(', ') + ' (' + rp.MAX_TENTATIVAS + ' tentativas)');
        const feitos = [];
        let falhas = 0;
        /* Codex #755: a tentativa conta ANTES de rodar (a que aborta também) e a escolha vai por quem foi tentado há mais
           tempo — dias que sempre abortam não travam os outros; e se algum dia não foi refeito, a etapa ACUSA (erro) */
        for (const pd of rp.paraRefazer(_cacheDirN, rp.MAX_POR_NOITE)) {
          rp.marcarTentativa(_cacheDirN, pd.dia);
          let r = null;
          try { r = await _bfDia(pd.dia); } catch (e) { r = { ok: false, msg: e.message }; }
          const ok = !!(r && r.ok !== false && r.desfecho !== 'abortado' && r.desfecho !== 'com_erros' && r.desfecho !== 'erro');
          if (!ok) falhas++;
          feitos.push(pd.dia + ': ' + (ok ? 'refeito' : ('não rodou (' + ((r && (r.msg || r.desfecho)) || 'sem resposta') + ')')));
          await dorme(2000);
        }
        const txt = feitos.join(' · ') + (desisti.length ? ' · desisti de ' + desisti.join(', ') : '') + ' · restam ' + rp.listar(_cacheDirN).length;
        if (falhas) throw new Error(falhas + ' de ' + feitos.length + ' dia(s) não refeito(s) — ' + txt);
        return txt;
      });
    }

    const erros = _not.etapas.filter(e => e.estado === 'erro');
    const pulados = _not.etapas.filter(e => e.estado === 'pulado');
    const partesResumo = [];
    if (erros.length) partesResumo.push(erros.length + ' etapa(s) com erro: ' + erros.map(e => e.nome).join(', '));
    if (pulados.length) partesResumo.push(pulados.length + ' etapa(s) pulada(s): ' + pulados.map(e => e.nome).join(', '));
    _not.resumo = partesResumo.length ? ('⚠️ ' + partesResumo.join(' · ')) : '✅ todas as etapas concluídas';
    _not.rodando = false;
    _not.fim = new Date().toISOString();
    console.log('[NOTURNA] ═══ fim — ' + _not.resumo + ' ═══');
    return _not;
  }

  function rotas(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;
    const k = lerChaveAdmin(req, urlObj);
    const s = validarSessao(req.headers['cookie']);
    const adm = (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));

    if (method === 'GET' && p === PREFIXO + '/noturna-status') {
      if (!adm) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, Object.assign({ ok: true, versao: VERSAO, horario: '03:30 (America/Sao_Paulo)' }, _not));
      return true;
    }

    // dispara na mão a MESMA rotina do cron — serve pra testar sem esperar a madrugada
    if (method === 'GET' && p === PREFIXO + '/rodar-noturna') {
      if (!adm) { json(res, 404, { error: 'not found' }); return true; }
      if (_not.rodando) { json(res, 409, { ok: false, erro: 'já está rodando', status: _not }); return true; }
      rotinaNoturna('manual').catch(e => { _not.rodando = false; console.log('[NOTURNA] ✗ ' + e.message); });
      json(res, 202, { ok: true, msg: 'rotina noturna disparada em segundo plano', status: PREFIXO + '/noturna-status' });
      return true;
    }

    return false;
  }

  return { rotinaNoturna, rotas };
}

module.exports = { criarNoturna };
