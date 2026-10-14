'use strict';
// =====================================================================================================
// lib/checkout/troca-periodo-historico.js — TROCA SEGURA DO PERIODO DO HISTORICO (peca das 3 empresas)
//
// 14/10 (parecer do Codex, item 6.3): o backfill APAGAVA o periodo e depois gravava os lotes. DELETE
// recusado ja abortava (#684), mas depois de um DELETE aceito, um lote que falhava deixava o periodo
// SEM as linhas antigas e so com parte das novas (desfecho 'com_erros', ok:true) — e um reinicio no
// meio, idem. A tabela nao tem chave unica por venda (so `id`), entao nada no banco segura isso.
//
// Agora: (1) a versao nova vai pro RASCUNHO, marcada com um lote; lote recusado = limpa o rascunho e
// ABORTA — o historico nem foi tocado; (2) uma funcao do banco (sql/historico-troca-segura.sql) troca o
// periodo INTEIRO numa transacao: confere a quantidade, apaga o antigo, copia o novo, limpa o rascunho.
// Falhou qualquer passo, o Postgres desfaz tudo. (3) Resposta perdida (rede/5xx) e AMBIGUA: confere se o
// rascunho do lote foi consumido (a funcao o apaga ao terminar) antes de dizer sucesso ou falha.
// Sem a tabela/funcao no banco: ABORTA dizendo pra rodar o script — nunca cai no jeito inseguro.
// =====================================================================================================

const RASCUNHO = 'vendas_historico_rascunho';
const SEIS_HORAS = 6 * 60 * 60 * 1000;
const CONFERENCIAS = 60;           // resposta perdida: pergunta ao banco ate 60x ...
const PAUSA_CONFERENCIA = 5000;    // ... com 5 s entre elas (~5 min) enquanto a troca estiver rodando
const ehTransitorio = (st) => st == null || st === 0 || st === 408 || st === 429 || st >= 500;
const curto = (r) => String((r && (r.body || r.erro)) || '').replace(/\s+/g, ' ').slice(0, 160);
const NAO_PREPARADO = 'BANCO NAO PREPARADO: falta a tabela vendas_historico_rascunho ou a funcao trocar_periodo_historico'
  + ' — rode sql/historico-troca-segura.sql no SQL Editor do Supabase. O historico NAO foi tocado.';

// o: { empresa, de, ate, supaReq(empresa, metodo, caminho, corpo), lerLotes(n), esperadas, dorme?, agora? }
// devolve { ok, desfecho: 'ok'|'abortado', msg, gravadas, apagadas?, inseridas?, transitorio?, incerto?, lote }
async function trocarPeriodoHistorico(o) {
  const { empresa, de, ate, supaReq, lerLotes } = o;
  const dorme = o.dorme || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const agora = o.agora || (() => Date.now());
  const enc = encodeURIComponent;
  const lote = [empresa, de, ate, agora(), Math.random().toString(36).slice(2, 8)].join(':');
  let gravadas = 0;
  const limpar = async () => { try { await supaReq(empresa, 'DELETE', RASCUNHO + '?lote=eq.' + enc(lote), null); } catch (e) { /* a proxima rodada limpa */ } };
  const falha = (msg, st, extra) => Object.assign({ ok: false, desfecho: 'abortado', msg, status: st == null ? null : st,
    transitorio: ehTransitorio(st), gravadas, lote }, extra || {});

  // 0) rascunho de rodada ABANDONADA desta empresa (reinicio no meio), com mais de 6 h
  const corte = new Date(agora() - SEIS_HORAS).toISOString();
  const rLimpa = await supaReq(empresa, 'DELETE', RASCUNHO + '?empresa=eq.' + enc(empresa) + '&criado_em=lt.' + enc(corte), null);
  if (rLimpa && rLimpa.status === 404) return falha(NAO_PREPARADO, 404, { nao_preparado: true });

  // 1) a versao nova vai pro rascunho
  for await (const l of lerLotes(200)) {
    const chaves = new Set();
    for (const x of l) for (const k of Object.keys(x)) chaves.add(k);
    const linhas = l.map((x) => { const y = { lote }; for (const k of chaves) y[k] = (k in x) ? x[k] : null; return y; });
    const r = await supaReq(empresa, 'POST', RASCUNHO, linhas);
    if (!r || !r.ok) {
      const st = r ? r.status : null;
      await limpar();
      if (st === 404) return falha(NAO_PREPARADO, 404, { nao_preparado: true });
      return falha('ABORTADO: o rascunho recusou um lote (HTTP ' + (st == null ? '?' : st) + (curto(r) ? ' — ' + curto(r) : '')
        + ') — o historico NAO foi tocado', st);
    }
    gravadas += linhas.length;
    await dorme(120);
  }
  if (gravadas !== o.esperadas) {
    await limpar();
    return falha('ABORTADO: o rascunho ficou com ' + gravadas + ' linha(s), esperadas ' + o.esperadas + ' — o historico NAO foi tocado', null, { transitorio: false });
  }

  // 2) a troca, de uma vez, no banco
  const rpc = await supaReq(empresa, 'POST', 'rpc/trocar_periodo_historico',
    { p_empresa: empresa, p_de: de, p_ate: ate, p_lote: lote, p_esperadas: gravadas });
  if (rpc && rpc.ok) {
    let res = null; try { res = JSON.parse(rpc.body || 'null'); } catch (e) { res = null; }
    return { ok: true, desfecho: 'ok', gravadas, apagadas: res && res.apagadas, inseridas: res && res.inseridas, lote };
  }
  const st = rpc ? rpc.status : null;
  if (st === 404) { await limpar(); return falha(NAO_PREPARADO, 404, { nao_preparado: true }); }
  if (ehTransitorio(st)) {
    // A resposta se perdeu (rede/5xx/timeout). Codex #694: nao adivinhar pelo tempo — perguntar ao banco.
    // troca_historico_status pega a MESMA trava que a troca segura enquanto roda:
    //   rodando           -> espera e pergunta de novo (ate ~5 min);
    //   parada + rascunho 0 -> a troca CONFIRMOU (ok — quem chamou segue pro credito Flex etc.);
    //   parada + rascunho >0 -> a troca NAO aconteceu: limpa o rascunho, historico nao tocado.
    // Sem a funcao de status (script antigo) cai na conferencia pelo rascunho, que nunca diz 'nao tocado'.
    for (let t = 0; t < CONFERENCIAS; t++) {
      if (t > 0) await dorme(PAUSA_CONFERENCIA);
      const s2 = await supaReq(empresa, 'POST', 'rpc/troca_historico_status', { p_lote: lote });
      let e2 = null; try { e2 = (s2 && s2.ok) ? JSON.parse(s2.body || 'null') : null; } catch (e) { e2 = null; }
      if (e2 && typeof e2.rodando === 'boolean') {
        if (e2.rodando) continue;
        // Codex #694: a PROVA e o registro da troca (vendas_historico_trocas, gravado na mesma transacao) —
        // rascunho vazio nao prova nada num periodo sem venda, em que ele ja nasce vazio
        if (e2.confirmada === true) return { ok: true, desfecho: 'ok', gravadas, confirmado_por: 'registro da troca no banco', lote };
        if (e2.confirmada === false) {
          await limpar();
          return falha('ABORTADO: a troca nao respondeu (HTTP ' + (st == null ? '?' : st) + ') e o banco confirmou que ela NAO aconteceu'
            + ' — o historico NAO foi tocado', st);
        }
        // status sem o campo (script antigo): so rascunho CONSUMIDO prova, e so se ele tinha linha
        if (gravadas > 0 && Number(e2.rascunho) === 0) return { ok: true, desfecho: 'ok', gravadas, confirmado_por: 'a troca terminou e consumiu o rascunho', lote };
        continue;
      }
      // sem a funcao de status: so o rascunho consumido prova a troca (e so se ele tinha linha); visivel nao prova nada
      if (gravadas === 0) continue;
      const v = await supaReq(empresa, 'GET', RASCUNHO + '?lote=eq.' + enc(lote) + '&select=lote&limit=1', null);
      let resto = null; try { resto = (v && v.ok) ? JSON.parse(v.body || '[]') : null; } catch (e) { resto = null; }
      if (Array.isArray(resto) && resto.length === 0) return { ok: true, desfecho: 'ok', gravadas, confirmado_por: 'rascunho consumido pela troca', lote };
    }
    return falha('INCERTO: a troca nao respondeu (HTTP ' + (st == null ? '?' : st) + ') e nao terminou em ~5 min. O historico esta INTEIRO,'
      + ' na versao antiga ou na nova (a troca e tudo-ou-nada); refaca o periodo depois (o credito Flex entra junto).', st, { incerto: true });
  }

  await limpar();
  return falha('ABORTADO: o banco recusou a troca (HTTP ' + st + (curto(rpc) ? ' — ' + curto(rpc) : '') + ') — o historico NAO foi tocado', st);
}

module.exports = { trocarPeriodoHistorico, RASCUNHO };
