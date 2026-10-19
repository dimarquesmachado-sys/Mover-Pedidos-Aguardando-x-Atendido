'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   AGENDADOR DO CHECKOUT (fatia 7 da desduplicação, 13/09/2026).

   As 47 linhas do `bootstrap` eram iguais nas duas empresas, com TRÊS diferenças:
   a chave da empresa, o minuto da rodada de custo (23h00 na AMB, 23h15 na
   Girassol — separadas de propósito, pra não competirem pela cota do Bling) e
   comentários. Viraram parâmetros.

   Aqui mora o relógio da operação: pesca de tarifas do ML, custo pós-boot e de
   6 em 6 horas, custo diário na virada das 23h com recuperação até as 6h,
   varredura de cancelados, faturamento do ML, vendas a cada 5 min e o ciclo do
   checkout. Rotina que deixa de ser agendada não falha — ela simplesmente NÃO
   ACONTECE, em silêncio, e alguém só descobre dias depois por um número
   estranho. Por isso os temporizadores entram por injeção: o teste finge o
   relógio e confere, um por um, que todos continuam registrados.
   ──────────────────────────────────────────────────────────────────────────── */

function criarAgendador(cfg) {
  const {
    empresa, minutoCustoDiario,
    mlSyncFees, custoSync, custoDiario, varrerCancelados, mlBillingSync,
    vendasSync, rodarCiclo, getUltimoResumo, log, aoIniciar,
    setTimeout: st, setInterval: si,
  } = cfg || {};

  for (const [nome, v] of Object.entries({ empresa, mlSyncFees, custoSync, custoDiario, varrerCancelados, mlBillingSync, vendasSync, rodarCiclo })) {
    if (v == null) throw new Error('lib/checkout/agendador: falta ' + nome);
  }
  // 13/10 (Codex #672): o trabalho agendado AQUI (pesca pos-deploy, custo, custo diario, cancelados...) e de FUNDO — roda
  // no mesmo contexto das rotinas do index.js, entao pede a vez ao porteiro (lib/checkout/base-funcoes)
  const _emFundo = (fn) => require('./contexto-fundo').comoFundo(String(empresa) + '.agendador', fn);
  const _st = (fn, ms) => (st || setTimeout)(_emFundo(fn), ms);
  const _si = (fn, ms) => (si || setInterval)(_emFundo(fn), ms);
  const _log = log || console.log;
  const minuto = Number.isFinite(Number(minutoCustoDiario)) ? Number(minutoCustoDiario) : 0;

  return function bootstrap() {
    /* o bootstrap antigo criava o CACHE_DIR de forma SÍNCRONA antes de agendar qualquer coisa
       — o servidor HTTP já está aceitando requisições nesse ponto, e writeJson não cria o
       diretório sozinho. Sem isso, um disco novo/limpo (deploy do zero) deixa a primeira
       gravação falhar em silêncio até o ciclo de boot rodar, 20s depois. */
    if (typeof aoIniciar === 'function') aoIniciar();

    /* pesca das tarifas reais do ML: espera o boot assentar */
    _st(() => { try { _log('[ML-FEES] pesca automática pós-deploy iniciando…'); mlSyncFees(14).catch(() => {}); } catch (e) {} }, require('./contexto-fundo').adiarForaDoGalpao(90 * 1000));   // 13/10: so fora do galpao

    /* custos: tartaruga pós-boot (só o que falta) e manutenção de 6 em 6 horas */
    _st(() => { try { custoSync(false).catch(() => {}); } catch (e) {} }, require('./contexto-fundo').adiarForaDoGalpao(240 * 1000));   // 13/10
    _si(() => { try { custoSync(false).catch(() => {}); } catch (e) {} }, 6 * 3600 * 1000);

    /* rodada de custo do DIA: mudança de preço no Bling vale no mesmo dia (o TTL de 7
       dias vira rede de segurança, não relógio). O minuto é por empresa — 23h00 e 23h15
       separam as duas pra não disputarem cota — e a janela até as 6h é a recuperação de
       um dia que ficou pra trás. A trava por dia vive na própria rotina. */
    _si(() => {
      try {
        const ag = new Date();
        if ((ag.getHours() === 23 && ag.getMinutes() >= minuto) || ag.getHours() < 6) custoDiario().catch(() => {});
      } catch (e) {}
    }, 60 * 1000);

    /* cancelados e faturamento do ML: 1x/dia, com o primeiro tiro afastado do boot */
    /* 19/10 (Codex #716): o diário nasce do tiro adiado e cada execução confere a janela (antes o intervalo de 24 h era
       contado do BOOT — deploy ao meio-dia = varredura todo dia ao meio-dia, em pleno galpão) */
    require('./contexto-fundo').agendarDiarioForaDoGalpao(_emFundo(() => varrerCancelados(45, empresa)), 15 * 60 * 1000, { setTimeout: st, setInterval: si });
    _st(() => { mlBillingSync(3).catch(() => {}); }, 25 * 60 * 1000);
    _si(() => { try { mlBillingSync(3).catch(() => {}); } catch (e) {} }, 24 * 3600 * 1000);

    /* vendas do Bling: quase tempo real, é o que alimenta a Análise */
    _st(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 150 * 1000);
    _si(() => { try { vendasSync().catch(() => {}); } catch (e) {} }, 5 * 60 * 1000);

    /* ciclo extra quando sobrou pedido sem etiqueta */
    _si(() => {
      try {
        const r = typeof getUltimoResumo === 'function' ? getUltimoResumo() : null;
        if (r && r.semEtiqueta > 0) { _log('[CICLO-EXTRA] ' + r.semEtiqueta + ' pedido(s) sem etiqueta — rodando ciclo extra'); rodarCiclo('auto-etiqueta').catch(() => {}); }
      } catch (e) {}
    }, 5 * 60 * 1000);

    _st(() => rodarCiclo('boot'), 20000);
  };
}

module.exports = { criarAgendador };
