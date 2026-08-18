'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  COMPLETAR A TARIFA DO TIKTOK NO HISTÓRICO — sem backfill (18/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  O buraco que isto fecha: a liquidação do TikTok demora dias, então a venda RECENTE
//  entra no histórico com a tarifa do BLING (subestimada: medido 11,6% contra 27,5% reais).
//  Até hoje, a única forma de corrigir era rodar o backfill do período de novo — que apaga
//  e regrava tudo, leva horas e já custou dado perdido duas vezes.
//
//  Aqui é o oposto: NÃO apaga nada. Lê as linhas do TikTok que ainda estão com a tarifa
//  antiga, calcula a nova e faz UPDATE só de `comissao`, `frete_vendedor` e `margem`.
//  Roda em minutos e pode rodar todo dia.
//
//  ⚠️ RATEIO: a tarifa é do PEDIDO e o histórico é por ITEM. O backfill rateia pelo valor
//  da linha; aqui é idêntico, senão pedido com 2 itens ficaria com tarifa dobrada.
//
//  ctx = { empresa, supaReq(empresa, metodo, pathQuery, body), lerFinanceiro() -> {order_sn: reg} }
const _n = v => { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : 0; };

async function completarTarifas(ctx, dias, opts) {
  const nDias = Math.min(400, Math.max(1, Number(dias) || 45));
  const desde = new Date(Date.now() - nDias * 86400000).toISOString().slice(0, 10);
  const seco = !!(opts && opts.simular);
  const pedidos = ctx.lerFinanceiro() || {};
  if (!Object.keys(pedidos).length) {
    return { ok: false, erro: 'o arquivo do financeiro do TikTok está vazio — rode /tiktok/financeiro-coletar antes' };
  }

  // 1) puxa as linhas de TikTok do período
  // Codex (P1): o PATCH precisa mirar UMA linha. `numero_pedido`, `numero_loja` e `data_venda`
  // são IGUAIS em todos os itens do pedido — filtrar por eles atualizaria o pedido inteiro a
  // cada volta e a última alocação sobrescreveria as anteriores, multiplicando a tarifa. Por
  // isso o `id` entra no select e vira a chave do UPDATE.
  const campos = 'id,numero_pedido,numero_loja,data_venda,valor_nota,valor_produto,custo,comissao,frete_vendedor,imposto,margem';
  const linhas = [];
  const TETO = 60000;
  let truncou = false;
  for (let off = 0; off < TETO; off += 1000) {
    const r = await ctx.supaReq(ctx.empresa, 'GET',
      'vendas_historico?empresa=eq.' + encodeURIComponent(ctx.empresa) +
      '&canal=eq.tiktok&data_venda=gte.' + desde +
      '&select=' + campos + '&order=numero_loja&limit=1000&offset=' + off, null);
    if (!r || !r.ok) return { ok: false, erro: 'não consegui ler o histórico: ' + ((r && r.erro) || ('HTTP ' + (r && r.status))) };
    // Codex (P2): corpo ilegível virava "página vazia" e a rotina terminava com ok:true
    // tendo corrigido nada. Agora falha explicitamente.
    let arr = null;
    try { arr = JSON.parse(r.body || '[]'); } catch (e) { return { ok: false, erro: 'resposta do histórico não é JSON válido (offset ' + off + ')' }; }
    if (!Array.isArray(arr)) return { ok: false, erro: 'resposta do histórico não veio como lista (offset ' + off + ')' };
    if (!arr.length) break;
    linhas.push.apply(linhas, arr);
    if (arr.length < 1000) break;
    // Codex (P2): teto atingido com página cheia = lista cortada. Dizer isso é melhor que
    // corrigir um pedaço arbitrário e reportar sucesso.
    if (off + 1000 >= TETO) { truncou = true; }
  }
  if (truncou) return { ok: false, erro: 'mais de ' + TETO + ' linhas de TikTok no período — reduza &dias= e rode em partes' };

  // 2) agrupa por pedido (a tarifa é do pedido; o histórico é por item)
  const porPedido = {};
  for (const l of linhas) {
    const sn = String(l.numero_loja || '').trim();
    if (!sn) continue;
    (porPedido[sn] = porPedido[sn] || []).push(l);
  }

  let semDado = 0, jaOk = 0, atualizados = 0, linhasTocadas = 0, falhas = 0;
  let deltaTarifa = 0;
  const exemplos = [];

  for (const sn of Object.keys(porPedido)) {
    const reg = pedidos[sn];
    if (!reg || !(Number(reg.tarifa) > 0)) { semDado++; continue; }
    const itens = porPedido[sn];
    const tarifaNova = _n(reg.tarifa);
    const tarifaAtual = _n(itens.reduce((s, l) => s + (Number(l.comissao) || 0), 0));
    // frete: líquido negativo = custo da loja; positivo = sobrou (entra como crédito)
    const freteNovo = _n(-(Number(reg.frete_liquido) || 0));
    const freteAtual = _n(itens.reduce((s, l) => s + (Number(l.frete_vendedor) || 0), 0));
    if (Math.abs(tarifaNova - tarifaAtual) < 0.01 && Math.abs(freteNovo - freteAtual) < 0.01) { jaOk++; continue; }

    // Codex (P2): o backfill rateia pela fração do VALOR DO PRODUTO e calcula a margem a
    // partir dele (`it.vt`), não do valor da nota. Usar valor_nota aqui deixaria o histórico
    // corrigido diferente de um backfill novo sempre que houver desconto ou frete embutido.
    const totalProd = itens.reduce((s, l) => s + (Number(l.valor_produto) || 0), 0);
    let sobraT = tarifaNova, sobraF = freteNovo;
    for (let i = 0; i < itens.length; i++) {
      const l = itens[i];
      const ultimo = (i === itens.length - 1);
      const frac = totalProd > 0 ? ((Number(l.valor_produto) || 0) / totalProd) : (1 / itens.length);
      // o ÚLTIMO item leva a sobra do arredondamento — senão a soma das partes não bate com o total
      const comItem = ultimo ? _n(sobraT) : _n(tarifaNova * frac);
      const freItem = ultimo ? _n(sobraF) : _n(freteNovo * frac);
      sobraT = _n(sobraT - comItem); sobraF = _n(sobraF - freItem);
      // Codex (P2): sem custo conhecido, o backfill deixa a margem NULA de propósito. Trocar
      // null por 0 transformaria lucro desconhecido em lucro declarado.
      const temCusto = (l.custo !== null && l.custo !== undefined && l.custo !== '');
      const campos2 = { comissao: comItem, frete_vendedor: freItem };
      if (temCusto) {
        campos2.margem = _n((Number(l.valor_produto) || 0) - Number(l.custo) - comItem - freItem - (Number(l.imposto) || 0));
      }
      if (seco) { linhasTocadas++; continue; }
      if (l.id === null || l.id === undefined) { falhas++; continue; }
      const up = await ctx.supaReq(ctx.empresa, 'PATCH',
        'vendas_historico?id=eq.' + encodeURIComponent(String(l.id)) + '&select=id', campos2);
      // Codex (P2): `ok` só diz que o PostgREST aceitou — PATCH que casa ZERO linhas também
      // volta ok. Com `select=id` e Prefer representation, dá pra exigir a linha de volta.
      let mexeu = false;
      if (up && up.ok) {
        try { const volta = JSON.parse(up.body || '[]'); mexeu = Array.isArray(volta) && volta.length > 0; } catch (e) { mexeu = false; }
      }
      if (mexeu) linhasTocadas++; else falhas++;
    }
    atualizados++;
    deltaTarifa = _n(deltaTarifa + (tarifaNova - tarifaAtual));
    if (exemplos.length < 10) exemplos.push({ pedido: sn, tarifa_antes: tarifaAtual, tarifa_agora: tarifaNova, itens: itens.length });
  }

  return {
    ok: true, empresa: ctx.empresa, dias: nDias, simulacao: seco,
    pedidos_no_historico: Object.keys(porPedido).length,
    ja_estavam_certos: jaOk, sem_financeiro_ainda: semDado,
    pedidos_corrigidos: atualizados, linhas_atualizadas: linhasTocadas, falhas,
    tarifa_a_mais_reconhecida: deltaTarifa, exemplos,
    nota: 'sem_financeiro_ainda = venda recente que o TikTok ainda não liquidou; ela se corrige sozinha quando o extrato sair. Nada é apagado aqui: só UPDATE de comissao, frete_vendedor e margem.'
  };
}

module.exports = { completarTarifas };
