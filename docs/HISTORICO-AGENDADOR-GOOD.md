# Histórico — o bootstrap à mão da GOOD

Em 16/11/2026 (`docs/NORTE-2026-11.md`, item C — `montarCheckout(empresa)`, passo 7) o relógio da GOOD passou a ser o
agendador das outras duas (`lib/checkout/agendador`). Abaixo, o `bootstrap` que ficava em `good-checkout-offline/index.js`,
guardado como estava (a história de cada agendamento; o equivalente está na peça), e as duas rotinas do custo diário que o
orquestrador agendava por cron (`custoDiario: '30,45 23 * * *'`, `custoDiarioRecupera: '*/20 0-5 * * *'`) — hoje o relógio
do agendador chama o custo diário de minuto em minuto a partir das 23h30 e na madrugada até as 6h (a trava por dia vive na
própria rotina).

```js
function bootstrap() {
  // 13/10 (Codex #672): o trabalho que a GOOD agenda AQUI (pesca pos-deploy, custos, ciclo de boot, varreduras) e de
  // FUNDO — roda no contexto das rotinas, entao as chamadas ao Bling dele pedem a vez ao porteiro (lib/checkout/base-funcoes)
  const _timers = require('timers'); const { comoFundo } = require('../lib/checkout/contexto-fundo');
  const setTimeout = (fn, ms) => _timers.setTimeout(comoFundo('good-checkout-offline.bootstrap', fn), ms);
  const setInterval = (fn, ms) => _timers.setInterval(comoFundo('good-checkout-offline.bootstrap', fn), ms);
  /* 15/10: 3 min depois do boot, o plano do backfill retoma de onde parou — sem ninguém pedir.
     Codex #696 r2 (P1): fica DEPOIS do setTimeout local acima — antes dele, a chamada caía na zona
     morta do `const setTimeout` e o bootstrap inteiro da GOOD abortava em produção. */
  setTimeout(() => { return _motorPlanoGood.tocar().catch(e => console.error('[plano-good] boot:', e.message)); }, 3 * 60000);
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
  setTimeout(() => { try { return vendasSync().catch(() => {}); } catch (e) {} }, 150 * 1000);
  setInterval(() => { try { return vendasSync().catch(() => {}); } catch (e) {} }, 5 * 60 * 1000);
  /* 19/10: CANCELADOS — 1x/dia (45 dias pra trás), o diário ANCORADO fora do horário do galpão (o mesmo do agendador
     da AMB e da Girassol; Codex #716: o intervalo nasce do tiro adiado e cada execução confere a janela) */
  require('../lib/checkout/contexto-fundo').agendarDiarioForaDoGalpao(() => varrerCancelados(45), 15 * 60 * 1000, { setTimeout, setInterval });
  /* 27/10: o canário (vendas e integrações), o financeiro e as devoluções do TikTok e os cancelamentos da Magalu, que
     rodavam aqui como tarefas soltas, passaram pra MADRUGADA ÚNICA (lib/checkout/noturna-empresa — a mesma da Girassol e
     da AMB): cron 'noturna' lá embaixo. Ficam aqui os mesmos três diários fora do galpão das outras (pesca, custos,
     cancelados). */
  /* 19/10: FATURAMENTO DO ML — mesmo ritmo do agendador da AMB e da Girassol (25 min depois do boot e 1x/dia, os 3
     últimos períodos; ao fim de cada rodada a peça distribui os créditos do Flex) */
  setTimeout(() => { try { return mlBillingSync(3).catch(() => {}); } catch (e) {} }, 25 * 60 * 1000);
  setInterval(() => { try { return mlBillingSync(3).catch(() => {}); } catch (e) {} }, 24 * 3600 * 1000);

  // PESCA AUTOMÁTICA PÓS-DEPLOY: todo deploy mata a pesca em andamento; aqui ela renasce sozinha
  // 90s depois do boot (após o ciclo inicial). Com dias=14 só re-checa os recentes — barato e idempotente.
  setTimeout(() => { try { console.log('[ML-FEES] pesca automática pós-deploy iniciando…'); return mlSyncFees(14).catch(() => {}); } catch (e) {} }, require('../lib/checkout/contexto-fundo').adiarForaDoGalpao(90 * 1000));   // 13/10: so fora do galpao
  setTimeout(() => { try { return custoSyncTravado(false).catch(() => {}); } catch (e) {} }, require('../lib/checkout/contexto-fundo').adiarForaDoGalpao(240 * 1000));   // custos: tartaruga pós-boot, só o que falta — trava do processo (14/09)
  // ETIQUETA PARADA: enquanto existir pedido sem etiqueta, tenta de novo a cada 5 min (o cron normal é 10/10).
  // Em dia limpo (0 sem etiqueta) NADA extra roda — custo zero. Cobre etiqueta que o canal demora a gerar.
  setInterval(() => {
    try {
      const r = getUltimoResumo();
      if (r && r.semEtiqueta > 0) { console.log('[CICLO-EXTRA] ' + r.semEtiqueta + ' pedido(s) sem etiqueta \u2014 rodando ciclo extra'); return rodarCiclo('auto-etiqueta').catch(() => {}); }
    } catch (e) {}
  }, 5 * 60 * 1000);

  ensureDir(CACHE_DIR);
  console.log(`[GOODBKP] ${VERSAO} ativo — ATENDIDO=${SIT_ATENDIDO}, janela=${JANELA_DIAS}d, cron="${CRON_EXPR}", formato=${ETIQ_FORMATO}`);
  setTimeout(() => rodarCiclo('boot'), 20000);
}
```
