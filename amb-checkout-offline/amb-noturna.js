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
          coletarDevolucoes, coletarCarteira, VERSAO, validarSessao, ehAdmin, json } = ctx;
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
